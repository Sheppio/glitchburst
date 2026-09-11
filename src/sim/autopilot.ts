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
 * stays alive long enough to be useful. Three bands of behaviour, chosen by
 * how close the nearest hostile is:
 *
 *   too close   → back off, summed repulsion from everything nearby
 *   out of range→ close the distance, so waves actually get cleared
 *   in between  → go and collect chips
 *
 * Engine-agnostic and pure: no Phaser, no DOM, no state between calls. The
 * renderer supplies what it can see and gets a direction back.
 */

export interface AutopilotPoint {
  x: number;
  y: number;
}

export interface AutopilotView {
  x: number;
  y: number;
  /** Everything hostile that is currently on screen. */
  enemies: readonly AutopilotPoint[];
  /** Loose chips worth walking to. */
  chips: readonly AutopilotPoint[];
  /** Effective weapon reach, so the bot knows when it is out of the fight. */
  weaponRange: number;
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
   * Close in when the nearest enemy is beyond this fraction of weapon range.
   *
   * Below 1 so the bot settles *inside* its own range rather than oscillating
   * across the boundary, which on a short-ranged class reads as a twitch.
   */
  engageFraction: 0.75,
  /** How far the bot will detour for a chip. */
  chipRadius: 640,
  /** Start steering away from a wall this far out. */
  wallMargin: 300,
  /** Relative pull of a chip against the other steering terms. */
  chipWeight: 0.75,
  /** Relative push of a wall. High: cornering itself is how a bot dies. */
  wallWeight: 1.5,
} as const;

const dist = (ax: number, ay: number, bx: number, by: number): number =>
  Math.hypot(ax - bx, ay - by);

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * The least-bad direction out of a pocket.
 *
 * Each candidate heading is projected a short distance and scored by how far
 * the resulting point is from the nearest enemy. The score is scaled by how far
 * the step actually got after clamping to the arena, which is what stops the
 * bot choosing a heading straight into a wall: pressed against an edge, that
 * step travels almost nowhere and scores accordingly, so an open direction
 * along the wall wins instead.
 */
function escapeHeading(view: AutopilotView): AutopilotPoint {
  const { width, height } = view.world;
  let best: AutopilotPoint = { x: 0, y: 0 };
  let bestScore = -Infinity;

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
    const score = clearance * travelled;
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
    return escapeHeading(view);
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

  // --- collect chips ----------------------------------------------------
  //
  // Only worth doing when not being chased: progression is the point, but not
  // at the cost of walking into the thing that is about to kill you.
  if (nearest > AUTOPILOT.comfortRadius) {
    let chip: AutopilotPoint | null = null;
    let chipD: number = AUTOPILOT.chipRadius;
    for (const candidate of view.chips) {
      const d = dist(view.x, view.y, candidate.x, candidate.y);
      if (d < chipD) {
        chipD = d;
        chip = candidate;
      }
    }
    if (chip && chipD > 0) {
      vx += ((chip.x - view.x) / chipD) * AUTOPILOT.chipWeight;
      vy += ((chip.y - view.y) / chipD) * AUTOPILOT.chipWeight;
    }
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
