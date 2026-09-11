/**
 * Autopilot: movement for a client playing itself.
 *
 * Paired with auto-aim and auto-fire this makes a client fully autonomous,
 * which is what it exists for — testing the multiplayer half of the game needs
 * bodies in the room, and a second tab that stands still is a poor stand-in for
 * a player. A parked client never moves out of a spawn ring, never collects a
 * chip, never earns a power-up and never exercises the reboot path, so exactly
 * the wire traffic worth testing is the traffic it does not generate.
 *
 * Deliberately not clever. This is not an AI opponent; it is a warm body that
 * stays alive long enough to be useful — and, because a run that never upgrades
 * stalls out around wave ten whoever is driving, one that *banks its economy*:
 *
 *   too close    → back off, biased toward loot when the way out allows it
 *   out of range → close the distance, so waves actually get cleared
 *   always       → go and collect, as long as the trip does not cost more
 *                  safety than the bot has already accepted
 *
 * Engine-agnostic and pure: no Phaser, no DOM, no state between calls. The
 * renderer supplies what it can see and gets a direction back.
 */

export interface AutopilotPoint {
  x: number;
  y: number;
}

/** Something on the floor worth walking to. */
export interface AutopilotPickup extends AutopilotPoint {
  /**
   * Seconds before it despawns, when it despawns at all.
   *
   * Supplied so the bot can decline a trip it cannot finish: chips live 26
   * seconds and power-ups 45, and a sprint across the arena for something that
   * evaporates on the way is worse than not going — it spends the time *and*
   * gives up the ground.
   */
  ttl?: number;
}

export interface AutopilotView {
  x: number;
  y: number;
  /** Everything hostile that is currently on screen. */
  enemies: readonly AutopilotPoint[];
  /** Loose chips worth walking to. */
  chips: readonly AutopilotPickup[];
  /** Dropped upgrades. The single most valuable thing on the floor. */
  powerUps?: readonly AutopilotPickup[];
  /** Effective weapon reach, so the bot knows when it is out of the fight. */
  weaponRange: number;
  /** Current top speed, px/s. Used only to judge whether loot is reachable. */
  moveSpeed?: number;
  world: { width: number; height: number };
}

export const AUTOPILOT = {
  /** Anything nearer than this is a threat to be backed away from. */
  comfortRadius: 240,
  /** Enemies beyond this contribute nothing to the retreat vector. */
  dangerRadius: 460,
  /** Headings considered when looking for a way out of a pocket. */
  escapeSamples: 16,
  /**
   * How far ahead an escape heading is judged.
   *
   * Roughly half a second of running. Short enough that the choice is about the
   * pocket the bot is in rather than the far side of the arena, long enough
   * that a heading which only looks good for two frames scores badly.
   */
  escapeLookahead: 150,
  /**
   * How much a heading may be favoured for running toward loot while escaping.
   *
   * Small on purpose, and scaled down further by how safe that loot is. It
   * breaks ties between comparable ways out; it can never talk the bot into
   * running through the swarm, because clearance is the dominant term and a
   * heading into a crowd scores near zero however much treasure lies past it.
   */
  escapeLootBias: 0.35,
  /**
   * Close in when the nearest enemy is beyond this fraction of weapon range.
   *
   * Below 1 so the bot settles *inside* its own range rather than oscillating
   * across the boundary, which on a short-ranged class reads as a twitch.
   */
  engageFraction: 0.75,
  /** How far the bot will detour for a chip. */
  chipRadius: 640,
  /**
   * How far it will go for a power-up: most of the arena.
   *
   * An upgrade is worth a journey in a way a single chip is not. It is also the
   * only pickup with no magnet, so the trip has to end on top of it.
   */
  powerUpRadius: 1600,
  /**
   * Chips latch on and fly to you from this far out, so the walk ends here
   * rather than at the chip. Slightly under the real magnet radius, to arrive
   * with the latch already made rather than exactly on its boundary.
   */
  magnetReach: 165,
  /** Power-ups have no magnet; this is the pickup radius, minus a margin. */
  powerUpReach: 30,
  /**
   * What an upgrade is worth in chips.
   *
   * Set just above the going rate — a power-up costs eight chips and rises from
   * there — so a dropped upgrade outbids any realistic pile of loose chips at
   * the same distance, which is the correct answer: the pile is still there
   * afterwards, and the upgrade will not be.
   */
  powerUpValue: 10,
  /** Chips this close to a candidate chip make it worth more. */
  clusterRadius: 220,
  /** How much each neighbour adds. Four together are worth about two and a half. */
  clusterValue: 0.5,
  /**
   * Distance offset in the value-per-distance score, in pixels.
   *
   * Stops a chip underfoot scoring infinitely, and sets the scale at which
   * distance starts to matter: with loot at arm's length and loot a screen
   * away, the near one is preferred by roughly the ratio you would expect.
   */
  lootPatience: 300,
  /** Candidates whose path is actually checked for safety, best-scoring first. */
  safetyChecks: 6,
  /** Points sampled along a trip when judging what it runs past. */
  pathSamples: 4,
  /** Fraction of a pickup's remaining life the trip may consume. */
  ttlMargin: 0.7,
  /** Start steering away from a wall this far out. */
  wallMargin: 300,
  /** Relative pull of a chip against the other steering terms. */
  chipWeight: 0.75,
  /** Relative pull of a power-up. Above the engage term, so it wins the frame. */
  powerUpWeight: 1.6,
  /** Relative push of a wall. High: cornering itself is how a bot dies. */
  wallWeight: 1.5,
} as const;

const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(ax - bx, ay - by);

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

interface LootTarget {
  x: number;
  y: number;
  /** Unit direction from the player. */
  dx: number;
  dy: number;
  /** How hard to steer at it. */
  weight: number;
  /** 0..1, how little the trip costs in safety. Scales both pull and bias. */
  safety: number;
  /** Value per distance, before safety. */
  score: number;
}

/**
 * The closest any enemy comes to a straight walk to `(tx, ty)`.
 *
 * Sampled rather than solved: point-to-segment is exact but says nothing about
 * *where* along the segment the squeeze happens, and sampling is what makes the
 * near-player end of the path neutral. The bot is already standing next to
 * whatever is nearest, so the first sample reports roughly what it has already
 * accepted — which is precisely the yardstick the caller compares against.
 */
function pathClearance(view: AutopilotView, tx: number, ty: number): number {
  if (view.enemies.length === 0) return Infinity;

  let worst = Infinity;
  for (let i = 1; i <= AUTOPILOT.pathSamples; i++) {
    const t = i / AUTOPILOT.pathSamples;
    const px = view.x + (tx - view.x) * t;
    const py = view.y + (ty - view.y) * t;
    for (const enemy of view.enemies) {
      const d = dist(px, py, enemy.x, enemy.y);
      if (d < worst) worst = d;
    }
  }
  return worst;
}

/**
 * Where to go shopping, or null when nothing is worth the walk.
 *
 * Chooses a single target rather than summing pulls, for the same reason the
 * escape band does: chips scattered on opposite sides cancel, and a bot steered
 * by the average of its options walks between them and collects neither.
 *
 * Scoring is value over distance, where value counts a chip's neighbours — a
 * cluster is one trip for several chips — and distance is the walk that
 * actually remains after the magnet takes over. Safety then multiplies it, and
 * the rule there is deliberately relative: a detour is acceptable when it does
 * not bring the bot closer to a hostile than it is *already* standing. That
 * replaces the flat "no looting while threatened" gate, which was both too
 * strict (a chip at your feet in a safe direction was refused) and too blunt (a
 * chip fifty pixels behind a drone was fine as long as the drone was 241 away).
 */
function chooseLoot(view: AutopilotView, nearest: number): LootTarget | null {
  interface Candidate {
    x: number;
    y: number;
    travel: number;
    score: number;
    weight: number;
  }

  const candidates: Candidate[] = [];

  const consider = (
    pickup: AutopilotPickup,
    value: number,
    reach: number,
    radius: number,
    weight: number,
  ): void => {
    const d = dist(view.x, view.y, pickup.x, pickup.y);
    if (d > radius) return;

    const travel = d - reach;
    // Already inside the magnet, or standing on it. It is coming regardless, so
    // steering at it only pins the bot in place while it flies in.
    if (travel <= 0) return;

    // Can the trip even be finished? Only asked when both halves are known;
    // without a speed the bot has no way to judge and simply goes.
    if (pickup.ttl !== undefined && view.moveSpeed && view.moveSpeed > 0) {
      if (travel / view.moveSpeed > pickup.ttl * AUTOPILOT.ttlMargin) return;
    }

    candidates.push({
      x: pickup.x,
      y: pickup.y,
      travel,
      score: value / (travel + AUTOPILOT.lootPatience),
      weight,
    });
  };

  for (const powerUp of view.powerUps ?? []) {
    consider(
      powerUp,
      AUTOPILOT.powerUpValue,
      AUTOPILOT.powerUpReach,
      AUTOPILOT.powerUpRadius,
      AUTOPILOT.powerUpWeight,
    );
  }

  for (const chip of view.chips) {
    // A cluster is one trip for several chips, so it is worth more than the
    // nearest single chip even from further away. Quadratic in the number of
    // loose chips, which the spawner caps, so the worst case is bounded and
    // small — and most chips fail the radius test below before ever reaching it.
    let value = 1;
    if (dist(view.x, view.y, chip.x, chip.y) <= AUTOPILOT.chipRadius) {
      for (const other of view.chips) {
        if (other === chip) continue;
        if (dist(chip.x, chip.y, other.x, other.y) <= AUTOPILOT.clusterRadius) {
          value += AUTOPILOT.clusterValue;
        }
      }
    }
    consider(chip, value, AUTOPILOT.magnetReach, AUTOPILOT.chipRadius, AUTOPILOT.chipWeight);
  }

  if (candidates.length === 0) return null;

  // Safety is the expensive term — it walks every enemy several times over — so
  // it is only paid for the handful of candidates that could win on value.
  candidates.sort((a, b) => b.score - a.score);

  const tolerated = Math.min(nearest, AUTOPILOT.comfortRadius);
  let best: LootTarget | null = null;
  let bestScore = 0;

  for (const candidate of candidates.slice(0, AUTOPILOT.safetyChecks)) {
    const clearance = pathClearance(view, candidate.x, candidate.y);
    const safety = clearance >= tolerated ? 1 : (clearance / tolerated) ** 2;
    const scored = candidate.score * safety;
    if (scored <= bestScore) continue;

    const d = dist(view.x, view.y, candidate.x, candidate.y);
    if (d <= 0) continue;

    bestScore = scored;
    best = {
      x: candidate.x,
      y: candidate.y,
      dx: (candidate.x - view.x) / d,
      dy: (candidate.y - view.y) / d,
      weight: candidate.weight,
      safety,
      score: candidate.score,
    };
  }

  return best;
}

/**
 * The least-bad direction out of a pocket.
 *
 * Each candidate heading is projected a short distance and scored by how far
 * the resulting point is from the nearest enemy. The score is scaled by how far
 * the step actually got after clamping to the arena, which is what stops the
 * bot choosing a heading straight into a wall: pressed against an edge, that
 * step travels almost nowhere and scores accordingly, so an open direction
 * along the wall wins instead.
 *
 * Loot tilts the choice but never makes it. Most of the time several ways out
 * are about as good as each other, and taking the one that also happens to run
 * over a chip is free progression — which is the difference between a bot that
 * survives a run and one that gets anywhere in it.
 */
function escapeHeading(view: AutopilotView, loot: LootTarget | null): AutopilotPoint {
  const { width, height } = view.world;
  let best: AutopilotPoint = { x: 0, y: 0 };
  let bestScore = -Infinity;

  const bias = loot ? AUTOPILOT.escapeLootBias * loot.safety : 0;

  for (let n = 0; n < AUTOPILOT.escapeSamples; n++) {
    const angle = (Math.PI * 2 * n) / AUTOPILOT.escapeSamples;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    const px = clamp(view.x + dx * AUTOPILOT.escapeLookahead, 30, width - 30);
    const py = clamp(view.y + dy * AUTOPILOT.escapeLookahead, 30, height - 30);

    let clearance = Infinity;
    for (const enemy of view.enemies) {
      const d = dist(px, py, enemy.x, enemy.y);
      if (d < clearance) clearance = d;
    }

    const travelled = dist(view.x, view.y, px, py) / AUTOPILOT.escapeLookahead;
    const towardLoot = loot ? Math.max(0, dx * loot.dx + dy * loot.dy) : 0;
    const score = clearance * travelled * (1 + bias * towardLoot);
    if (score > bestScore) {
      bestScore = score;
      best = { x: dx, y: dy };
    }
  }

  return best;
}

/**
 * One frame of movement, as a normalised vector.
 *
 * Returns a zero vector only when there is genuinely nothing to do, which the
 * caller is free to treat as "stand still".
 */
export function autopilotMove(view: AutopilotView): AutopilotPoint {
  let nearest = Infinity;
  for (const enemy of view.enemies) {
    const d = dist(view.x, view.y, enemy.x, enemy.y);
    if (d < nearest) nearest = d;
  }

  const loot = chooseLoot(view, nearest);

  // --- under real pressure: find a way out ------------------------------
  //
  // Summing repulsion vectors is the obvious approach and it fails exactly when
  // it matters. Surrounded, the pushes cancel — the bot is shoved equally from
  // every side, the sum collapses to nothing, and it stands still in the middle
  // of the swarm and dies. Measured: half of a 90-second run spent in contact
  // range.
  //
  // So when it is actually threatened the bot stops averaging and starts
  // choosing: sample headings, look ahead along each, take the one that ends up
  // furthest from everything. That walks out through the gap in an encirclement
  // rather than pressing into the middle of it.
  if (view.enemies.length > 0 && nearest < AUTOPILOT.comfortRadius) {
    return escapeHeading(view, loot);
  }

  let vx = 0;
  let vy = 0;

  // --- mild pressure: drift off anything closing in ----------------------
  for (const enemy of view.enemies) {
    const d = dist(view.x, view.y, enemy.x, enemy.y);
    if (d >= AUTOPILOT.dangerRadius || d <= 0) continue;

    // Squared falloff, so a near enemy dominates a distant one instead of
    // being averaged away by the crowd behind it.
    const push = (1 - d / AUTOPILOT.dangerRadius) ** 2;
    vx += ((view.x - enemy.x) / d) * push;
    vy += ((view.y - enemy.y) / d) * push;
  }

  // --- close the distance when out of the fight -------------------------
  //
  // Without this the bot retreats forever, the wave never clears and the room
  // under test never advances — which is the one thing it was added to do.
  const engageAt = view.weaponRange * AUTOPILOT.engageFraction;
  if (view.enemies.length > 0 && nearest > engageAt) {
    let closest: AutopilotPoint | null = null;
    let closestD = Infinity;
    for (const enemy of view.enemies) {
      const d = dist(view.x, view.y, enemy.x, enemy.y);
      if (d < closestD) {
        closestD = d;
        closest = enemy;
      }
    }
    if (closest && closestD > 0) {
      vx += (closest.x - view.x) / closestD;
      vy += (closest.y - view.y) / closestD;
    }
  }

  // --- go shopping -------------------------------------------------------
  //
  // Progression is not a luxury the bot indulges once it feels safe: the chips
  // buy the damage that clears the wave that stops it being chased. Weighted
  // above the engage term for a power-up, because an upgrade on the floor is a
  // strictly better use of the next two seconds than closing on a drone.
  if (loot) {
    vx += loot.dx * loot.weight * loot.safety;
    vy += loot.dy * loot.weight * loot.safety;
  }

  // --- stay off the walls ------------------------------------------------
  //
  // The classic way a retreating bot dies: it backs into a corner, where the
  // horde has it against two walls and the retreat vector has nowhere to go.
  // Weighted above everything else so it turns before it is trapped.
  const { width, height } = view.world;
  if (view.x < AUTOPILOT.wallMargin) vx += (1 - view.x / AUTOPILOT.wallMargin) * AUTOPILOT.wallWeight;
  if (view.x > width - AUTOPILOT.wallMargin) {
    vx -= (1 - (width - view.x) / AUTOPILOT.wallMargin) * AUTOPILOT.wallWeight;
  }
  if (view.y < AUTOPILOT.wallMargin) vy += (1 - view.y / AUTOPILOT.wallMargin) * AUTOPILOT.wallWeight;
  if (view.y > height - AUTOPILOT.wallMargin) {
    vy -= (1 - (height - view.y) / AUTOPILOT.wallMargin) * AUTOPILOT.wallWeight;
  }

  // --- nothing to do: drift to the middle --------------------------------
  //
  // An empty arena between waves. Drifting to the centre is the best place to
  // be standing when the next one spawns around whoever is nearest.
  const magnitude = Math.hypot(vx, vy);
  if (magnitude < 0.02) {
    const cx = width / 2 - view.x;
    const cy = height / 2 - view.y;
    const d = Math.hypot(cx, cy);
    return d > 60 ? { x: cx / d, y: cy / d } : { x: 0, y: 0 };
  }

  return { x: vx / magnitude, y: vy / magnitude };
}
