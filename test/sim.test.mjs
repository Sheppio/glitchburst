/**
 * Headless tests for the engine-agnostic half of the game.
 * These import the compiled sim/ and net/ modules directly — no DOM, no Phaser.
 */
import { reporter } from './rig.mjs';
import { HordeEngine } from '../dist/sim/HordeEngine.js';
import {
  encodeHorde, decodeHorde, encodeEvents, decodeEvents,
  encodePlayer, decodePlayer, encodeField, decodeField, sanitizeName,
  encodeHeartbeat, decodeHeartbeat, encodePlayerStats, decodePlayerStats,
} from '../dist/net/codec.js';
import { HORDE, PLAYER, TURN_RATE_RAD_PER_SEC } from '../dist/config.js';
import { PlayerProgress, PROGRESSION, UPGRADES, UPGRADE_ORDER } from '../dist/sim/progression.js';
import { approachAngle, hashUnit } from '../dist/util.js';
import { ALL_KINDS, ENEMY_DEFS } from '../dist/sim/enemyTypes.js';
import {
  baseLevelForWave, clampLevel, LEVEL_COLOURS, LEVELS, levelHealthScale,
  levelRewardScale, MAX_LEVEL, rollLevel,
} from '../dist/sim/enemyLevels.js';
import { pickTarget, targetScore, TARGETING } from '../dist/sim/targeting.js';
import { autopilotMove, AUTOPILOT } from '../dist/sim/autopilot.js';
import { CLASSES, CLASS_ORDER, classDps, weaponRange } from '../dist/sim/classes.js';
import { Pool } from '../dist/render/pool.js';
import { fadeOut } from '../dist/render/lerp.js';
import { orderSquad } from '../dist/render/squadOrder.js';
import { classIconSvg } from '../dist/ui/classIcon.js';
import {
  COLOUR_ORDER, DEFAULT_COLOUR, PALETTE, colourOf, isColourId, resolveColours,
} from '../dist/sim/palette.js';
import { edgeMarker } from '../dist/render/edgeMarkers.js';
import {
  accuracy, EMPTY_PLAYER_STATS, formatDuration, summaryRows, sumPlayerStats,
} from '../dist/sim/stats.js';
import { CHANNEL_REFERENCE, channelGain, volumeCurve } from '../dist/audio/volume.js';
import { DEFAULT_SETTINGS, RANGES } from '../dist/input/settings.js';

const { check, finish } = reporter('GLITCHBURST — simulation & codec');

/** Assert inside a loop without emitting a line per iteration. */
let onceFailures = 0;
const check_once = (ok, label) => {
  if (!ok && onceFailures++ === 0) check(label, false);
};

const targets = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, x: 1200 + i * 60, y: 800, priority: 1, alive: true }));

/** Run the engine for `seconds` at a fixed 60Hz step. */
const run = (engine, seconds, t = targets(1)) => {
  const dt = 1 / 60;
  const events = [];
  for (let i = 0; i < seconds * 60; i++) events.push(...engine.step(dt, t).events);
  return events;
};

/* ------------------------------------------------------------------ codec */

{
  const enemies = Array.from({ length: 100 }, (_, i) => ({
    id: `e${i.toString(36)}`, kind: i % 3, x: 1234.7 + i, y: 987.2 + i, hp: 40 + i,
    maxHp: 100, vx: 0, vy: 0, speed: 100, cooldown: 0, stun: 0, targetId: null,
  }));

  const wire = encodeHorde(enemies);
  const back = decodeHorde(wire);
  const json = JSON.stringify(enemies.map((e) => ({ id: e.id, x: Math.round(e.x), y: Math.round(e.y), k: e.kind, hp: e.hp })));

  check('horde round-trips 100 enemies', back.length === 100);
  check('ids, kinds and health survive the wire',
    back[7].id === enemies[7].id && back[7].kind === enemies[7].kind && back[7].hp === enemies[7].hp);
  check('positions round to whole pixels',
    back[0].x === Math.round(enemies[0].x) && back[0].y === Math.round(enemies[0].y));
  check('batched payload stays small at the 100-enemy cap', wire.length < 2048,
    `${wire.length}B vs ${json.length}B as JSON (${Math.round((1 - wire.length / json.length) * 100)}% smaller)`);
  check('20Hz bandwidth is broker-friendly', (wire.length * 20) / 1024 < 40,
    `${((wire.length * 20) / 1024).toFixed(1)} KB/s`);

  const truncated = wire.slice(0, Math.floor(wire.length * 0.6));
  check('a truncated payload decodes without throwing', decodeHorde(truncated).length > 0);
  check('empty payload decodes to nothing', decodeHorde('').length === 0);
}

{
  const events = [
    { t: 'death', id: 'e9', x: 100.4, y: 200.6, kind: 2 },
    { t: 'shot', id: 'p1', x: 50, y: 60, vx: 120, vy: -80, damage: 9 },
    { t: 'wave', n: 4, size: 18 },
  ];
  const back = decodeEvents(encodeEvents(events));
  check('event batch round-trips all three kinds', back.length === 3);
  check('death coordinates survive', back[0].x === 100 && back[0].y === 201);
  check('projectile velocity survives', back[1].vx === 120 && back[1].vy === -80);
  check('wave payload survives', back[2].n === 4 && back[2].size === 18);
}

{
  const state = { id: 'abc', name: 'NEO', cls: 'glitcher', x: 640.6, y: 480.2, angle: 1.5707, hp: 73, maxHp: 90, flags: 3, lastSeen: 0 };
  const back = decodePlayer('abc', encodePlayer(state));
  check('player state round-trips', back.name === 'NEO' && back.cls === 'glitcher' && back.hp === 73 && back.flags === 3);
  check('aim angle keeps centi-radian precision', Math.abs(back.angle - state.angle) < 0.01,
    `${state.angle} → ${back.angle}`);
  check('commas in a callsign cannot corrupt the record',
    decodePlayer('x', encodePlayer({ ...state, name: 'AB,CD' })).cls === 'glitcher',
    `sanitized to "${sanitizeName('AB,CD')}"`);
}

{
  // The heartbeat carries the room score and the run state, which is what
  // keeps two clients agreeing after a dropped event — and what pulls a late
  // joiner straight into a match already underway.
  const full = { enemyCount: 42, wave: 9, paused: true, score: 1234, running: true, kills: 77, seconds: 305 };
  const beat = decodeHeartbeat(encodeHeartbeat('host1', 7, full));
  check('heartbeat round-trips the room score',
    beat.hostId === 'host1' && beat.score === 1234 && beat.wave === 9 && beat.enemyCount === 42 && beat.paused);
  check('heartbeat round-trips the run state and summary',
    beat.running === true && beat.kills === 77 && beat.seconds === 305);

  // The tail fields are optional on the wire. Absent must not read as zero or
  // false: zero is a legitimate score and adopting it every beat would wipe the
  // board, and a missing run flag read as "lobby" would strand everyone outside
  // a live match.
  const legacy = decodeHeartbeat(['host1', '7', '42', '9', '1'].join(','));
  check('a heartbeat without a score reports null, not zero', legacy.score === null,
    `got ${JSON.stringify(legacy.score)}`);
  check('a heartbeat without a run flag reports null, not false', legacy.running === null);
  check('a zero score is still reported as zero',
    decodeHeartbeat(encodeHeartbeat('h', 1, { ...full, score: 0 })).score === 0);
  check('a lobby heartbeat reports running false, not null',
    decodeHeartbeat(encodeHeartbeat('h', 1, { ...full, running: false })).running === false);
  check('a malformed heartbeat is rejected', decodeHeartbeat('nonsense') === null);
}

{
  const field = { id: 'f1', owner: 'p1', kind: 'heal', x: 300, y: 400, radius: 150, ttl: 8 };
  const back = decodeField(encodeField(field));
  check('ability field round-trips', back.kind === 'heal' && back.radius === 150 && Math.abs(back.ttl - 8) < 0.1);
  check('an unknown field kind is rejected', decodeField('a,b,bogus,1,2,3,4') === null);
}

/* ------------------------------------------------------------------ horde */

{
  const engine = new HordeEngine();
  run(engine, 200, targets(4));
  check('enemy cap is never exceeded', engine.enemyCount <= HORDE.maxEnemies,
    `${engine.enemyCount} live after 200s with 4 players`);
}

{
  const solo = new HordeEngine();
  const squad = new HordeEngine();
  // Long enough for wave 1 to finish streaming in on both, and short enough
  // that wave 2 has not started on either. Counting the field a second after
  // the wave lands would now measure the drip rate, not the wave size.
  run(solo, 15, targets(1));
  run(squad, 15, targets(4));
  check('a four-player squad faces a bigger wave than a solo player',
    squad.enemyCount > solo.enemyCount * 1.8,
    `solo ${solo.enemyCount} → squad ${squad.enemyCount} (${(squad.enemyCount / solo.enemyCount).toFixed(2)}x)`);
  check('squad size is tracked from live targets', solo.squadSize === 1 && squad.squadSize === 4);

  const soloHp = [...solo.enemies.values()][0].maxHp;
  const squadHp = [...squad.enemies.values()].find((e) => e.kind === [...solo.enemies.values()][0].kind)?.maxHp ?? 0;
  check('enemies are tougher for a full squad', squadHp > soloHp,
    `${soloHp} HP solo → ${squadHp} HP at four`);
}

{
  const engine = new HordeEngine();
  run(engine, 5, targets(1));
  const victim = [...engine.enemies.values()][0];
  engine.reportDamage(victim.id, victim.hp + 50, 'shooter-1');
  const result = engine.step(1 / 60, targets(1));
  check('reported damage kills and credits the attacker',
    result.kills.length === 1 && result.kills[0].attacker === 'shooter-1' && result.kills[0].score > 0);
  check('a death event is emitted for the room',
    result.events.some((e) => e.t === 'death' && e.id === victim.id));
  check('damage for an unknown enemy is ignored',
    (engine.reportDamage('nope', 999, 'x'), engine.step(1 / 60, targets(1)).kills.length === 0));
}

{
  const engine = new HordeEngine();
  run(engine, 5, targets(1));
  const bug = [...engine.enemies.values()].find((e) => e.kind === 0);
  const before = Math.hypot(bug.x - 1200, bug.y - 800);
  run(engine, 2, targets(1));
  const after = Math.hypot(bug.x - 1200, bug.y - 800);
  check('enemies steer toward the nearest player', after < before, `${before.toFixed(0)}px → ${after.toFixed(0)}px`);
}

{
  const engine = new HordeEngine();
  const player = { id: 'p0', x: 1200, y: 800, priority: 1, alive: true };
  const decoy = { id: 'decoy', x: 1900, y: 800, priority: 6, alive: true };
  run(engine, 5, [player]);
  const bug = [...engine.enemies.values()].find((e) => e.kind === 0);
  run(engine, 2, [player, decoy]);
  check('a decoy out-prioritises a real player', bug.targetId === 'decoy',
    `targeting ${bug.targetId}`);
  check('a decoy does not inflate difficulty', engine.squadSize === 1);
}

{
  const engine = new HordeEngine();
  run(engine, 5, targets(1));
  const before = [...engine.enemies.values()].map((e) => ({ id: e.id, x: e.x, y: e.y, kind: e.kind, hp: e.hp }));
  const promoted = new HordeEngine();
  promoted.adopt(before, 3);
  check('a promoted peer adopts the whole horde', promoted.enemyCount === before.length,
    `${before.length} enemies carried over at wave 3`);
  check('adopted ids are preserved so damage reports still land',
    promoted.enemies.has(before[0].id));
  const next = promoted.step(1 / 60, targets(1));
  check('the adopted horde keeps simulating', next.events.length >= 0 && promoted.enemyCount === before.length);
}

{
  const engine = new HordeEngine();
  run(engine, 5, targets(1));
  const bug = [...engine.enemies.values()][0];
  const before = { x: bug.x, y: bug.y };
  engine.applyShockwave(bug.x, bug.y, 300, 1.5, 600);
  check('shockwave stuns nearby malware', bug.stun > 0, `${bug.stun.toFixed(2)}s stun`);
  engine.step(1 / 60, targets(1));
  check('shockwave imparts knockback',
    Math.hypot(bug.x - before.x, bug.y - before.y) > 0.5);
}

/* ----------------------------------------------------------- progression */

{
  const p = new PlayerProgress();
  let earned = 0;
  for (let i = 0; i < PROGRESSION.chipsPerPowerUp - 1; i++) earned += p.addChip() ? 1 : 0;
  check('a partial set earns nothing', earned === 0 && p.chips === PROGRESSION.chipsPerPowerUp - 1);

  check('completing a set earns a power-up', p.addChip() === true);
  check('the counter rolls over rather than resetting', p.chips === 0);
  check('total chips are tracked across sets', p.totalChips === PROGRESSION.chipsPerPowerUp);
}

{
  const p = new PlayerProgress();
  check('multipliers start neutral',
    p.damageMultiplier === 1 && p.speedMultiplier === 1 && p.fireIntervalMultiplier === 1);

  p.grant('damage');
  check('a damage stack raises weapon damage',
    Math.abs(p.damageMultiplier - (1 + UPGRADES.damage.step)) < 1e-9,
    `x${p.damageMultiplier.toFixed(2)}`);

  p.grant('speed');
  check('a speed stack raises movement speed', p.speedMultiplier > 1, `x${p.speedMultiplier.toFixed(2)}`);

  p.grant('firerate');
  check('a fire-rate stack shortens the fire interval', p.fireIntervalMultiplier < 1,
    `x${p.fireIntervalMultiplier.toFixed(3)} interval`);
}

{
  const p = new PlayerProgress();
  for (let i = 0; i < UPGRADES.speed.maxStacks; i++) p.grant('speed');
  check('stacks cap out', p.grant('speed') === false && p.stacks.speed === UPGRADES.speed.maxStacks,
    `capped at ${UPGRADES.speed.maxStacks}`);
  check('a maxed upgrade is never rolled again',
    Array.from({ length: 200 }, () => p.rollUpgrade()).every((id) => id !== 'speed'));
}

{
  // Exactly one upgrade is endless. That is the whole answer to "I reach fully
  // optimised too soon": there is no such state to reach any more.
  //
  // Two upgrades carry an infinite *stack* count; only one of them is actually
  // unbounded. Heap Expansion is bounded by the health ceiling instead, because
  // the classes do not start level and a stack cap would mean something
  // different to each of them — so `isMaxed` is the honest question, not the
  // number in the table.
  const p = new PlayerProgress();
  const endless = UPGRADE_ORDER.filter((id) => {
    const fresh = new PlayerProgress();
    for (let i = 0; i < 500; i++) fresh.grant(id);
    return !fresh.isMaxed(id);
  });
  check('damage is the endless upgrade', endless.length === 1 && endless[0] === 'damage',
    endless.length ? `endless: ${endless.join(', ')}` : 'every upgrade is capped');

  // Drive from the table, not a hand-written list, or adding an upgrade
  // silently stops this testing what it claims to.
  for (const id of UPGRADE_ORDER) {
    const cap = UPGRADES[id].maxStacks;
    for (let i = 0; i < (Number.isFinite(cap) ? cap : 400); i++) p.grant(id);
  }
  check('every bounded upgrade still stops', UPGRADE_ORDER.every((id) =>
    id === 'damage' ? p.grant(id) === true : p.grant(id) === false),
    UPGRADE_ORDER.filter((id) => id !== 'damage' && !p.isMaxed(id)).join(', ') || 'all bounded');
  check('a maxed-out player still has something to roll', p.rollUpgrade() === 'damage',
    'only damage remains, forever');
  check('damage keeps stacking well past every other cap', p.stacks.damage > 400,
    `${p.stacks.damage} damage stacks and counting`);
}

{
  /* ----------------------------------------------- heap expansion (max hp) */

  const step = UPGRADES.vitality.step;
  const glass = new PlayerProgress(90);     // Glitcher
  const tank = new PlayerProgress(190);     // Fireman

  check('a fresh player has exactly their class maximum',
    glass.maxHealth === 90 && tank.maxHealth === 190);

  glass.grant('vitality');
  check('one stack adds a flat amount, not a percentage',
    glass.maxHealth === 90 + step, `${glass.maxHealth} hp`);

  // The ceiling is on the stat, not the stack count — which is the whole point
  // of expressing it that way, since the two classes start a hundred apart.
  for (let i = 0; i < 40; i++) glass.grant('vitality');
  for (let i = 0; i < 40; i++) tank.grant('vitality');
  check('neither class can climb past the ceiling',
    glass.maxHealth === PROGRESSION.healthCeiling && tank.maxHealth === PROGRESSION.healthCeiling,
    `glitcher ${glass.maxHealth}, fireman ${tank.maxHealth}, ceiling ${PROGRESSION.healthCeiling}`);
  check('the ceiling is 256', PROGRESSION.healthCeiling === 256);

  // The upgrade is worth most to whoever needs it most: the glass cannon gets
  // a run-defining number of stacks, the tank a handful.
  check('the low-health class has far more to gain',
    glass.stacks.vitality > tank.stacks.vitality * 2,
    `${glass.stacks.vitality} stacks vs ${tank.stacks.vitality}`);

  check('a player at the ceiling is maxed', glass.isMaxed('vitality') && tank.isMaxed('vitality'));
  check('and is never offered it again',
    Array.from({ length: 200 }, () => glass.rollUpgrade()).every((id) => id !== 'vitality'));

  // The stack that crosses the ceiling is allowed and simply gives what is
  // left. Refusing it would be a power-up that fires its sound and does
  // nothing, which reads as a bug.
  const edge = new PlayerProgress(PROGRESSION.healthCeiling - 3);
  check('the last stack is partial rather than refused',
    edge.grant('vitality') === true && edge.maxHealth === PROGRESSION.healthCeiling,
    `${edge.maxHealth} hp from a ${step} point stack with 3 to spare`);
  check('and there is nothing after it', edge.grant('vitality') === false);

  check('a class at the ceiling is offered nothing at all',
    new PlayerProgress(PROGRESSION.healthCeiling).isMaxed('vitality'));
}

{
  // Weighting should broaden a build rather than pile onto one line.
  const p = new PlayerProgress();
  for (let i = 0; i < 6; i++) p.grant('damage');
  const rolls = Array.from({ length: 3000 }, () => p.rollUpgrade());
  const dmg = rolls.filter((r) => r === 'damage').length;
  check('rolls favour upgrades the player lacks', dmg / rolls.length < 0.2,
    `${((dmg / rolls.length) * 100).toFixed(1)}% rolled damage after 6 damage stacks`);
}

{
  // Power-ups must get dearer, or the whole build resolves while the waves are
  // still small and the rest of the run has no progression in it.
  const p = new PlayerProgress();
  const first = p.chipsNeeded;
  for (let i = 0; i < 200; i++) p.addChip();
  const later = p.chipsNeeded;
  check('power-ups cost more as they accumulate', later > first,
    `${first} chips for the first, ${later} for the ${p.powerUpsTaken + 1}th`);

  // The price is a simple count the player can follow, with no ceiling: the
  // stack caps bound it naturally, and a ceiling would flatten the last third
  // of the curve back into the plateau this was meant to remove.
  const seq = new PlayerProgress();
  const costs = [];
  for (let n = 0; n < 12; n++) {
    costs.push(seq.chipsNeeded);
    const price = seq.chipsNeeded;
    for (let i = 0; i < price; i++) seq.addChip();
  }
  const steps = costs.slice(1).map((c, i) => c - costs[i]);
  check('each power-up costs exactly one chip more than the last',
    steps.every((d) => d === 1) && costs[0] === PROGRESSION.chipsPerPowerUp,
    costs.slice(0, 6).join(', ') + ' ...');

  // Damage no longer has a ceiling, so "maxed" is measured at the point the
  // capped upgrades run out — which is where the run stops gaining anything
  // except damage, and therefore where the endless half has to take over.
  const atCaps =
    (1 + UPGRADES.damage.step * 20) * (1 + UPGRADES.firerate.step * UPGRADES.firerate.maxStacks);
  check('a well-invested player is strong but not absurd', atCaps > 3 && atCaps < 6,
    `x${atCaps.toFixed(1)} dps at 20 damage stacks and maxed fire rate`);
}

{
  const p = new PlayerProgress();
  check('self repair starts at nothing', p.bonusRegenPerSec === 0);
  p.grant('regen');
  p.grant('regen');
  check('self repair stacks additively',
    Math.abs(p.bonusRegenPerSec - UPGRADES.regen.step * 2) < 1e-9,
    `+${p.bonusRegenPerSec.toFixed(1)} hp/s from two stacks`);
  check('every upgrade is reachable from the order table',
    UPGRADE_ORDER.length === Object.keys(UPGRADES).length,
    UPGRADE_ORDER.join(', '));
}

/* ------------------------------------------------------------ drop rolls */

{
  check('the drop roll is deterministic for an id',
    hashUnit('e42') === hashUnit('e42') && hashUnit('e42') !== hashUnit('e43'));

  const values = Array.from({ length: 4000 }, (_, i) => hashUnit(`e${i.toString(36)}`));
  check('drop rolls stay in range', values.every((v) => v >= 0 && v < 1));

  // A biased hash would make a "22% chance" fire far more or less often than
  // stated, and every client would agree on the wrong answer.
  const tankRate = values.filter((v) => v < ENEMY_DEFS[2].powerUpChance).length / values.length;
  check('tank power-up rate matches its stated chance',
    Math.abs(tankRate - ENEMY_DEFS[2].powerUpChance) < 0.03,
    `${(tankRate * 100).toFixed(1)}% vs ${ENEMY_DEFS[2].powerUpChance * 100}% stated`);

  const bugRate = values.filter((v) => v < ENEMY_DEFS[0].powerUpChance).length;
  check('glitch bugs never drop power-ups', bugRate === 0);

  check('bigger enemies drop more of everything',
    ENEMY_DEFS[2].chipDrop > ENEMY_DEFS[1].chipDrop &&
    ENEMY_DEFS[1].chipDrop > ENEMY_DEFS[0].chipDrop &&
    ENEMY_DEFS[2].powerUpChance > ENEMY_DEFS[1].powerUpChance,
    `chips ${ENEMY_DEFS[0].chipDrop}/${ENEMY_DEFS[1].chipDrop}/${ENEMY_DEFS[2].chipDrop}`);
}

/* ------------------------------------------------------------ bullet fade */

{
  check('a fresh round is fully opaque', fadeOut(0.3, 0.3) === 1);
  check('a round stays opaque through most of its life', fadeOut(0.15, 0.3) === 1);
  check('a round thins out near the end of its range', fadeOut(0.05, 0.3) < 0.6 && fadeOut(0.05, 0.3) > 0,
    `alpha ${fadeOut(0.05, 0.3).toFixed(2)} with a sixth of its life left`);
  check('an expired round is invisible rather than negative', fadeOut(0, 0.3) === 0 && fadeOut(-1, 0.3) === 0);
  check('the fade is monotonic', [0.3, 0.2, 0.1, 0.05, 0.02, 0]
    .map((l) => fadeOut(l, 0.3))
    .every((v, i, a) => i === 0 || v <= a[i - 1]));
  check('a zero lifetime cannot divide by zero', fadeOut(1, 0) === 1);
}

/* --------------------------------------------------------- edge markers */

{
  // A 1000x600 window onto the arena, its top-left at (1000, 800).
  const view = { x: 1000, y: 800, width: 1000, height: 600 };
  const margin = 24;
  const deg = (rad) => Math.round((rad * 180) / Math.PI);

  check('anything on screen needs no marker',
    edgeMarker({ x: 1500, y: 1100 }, view, margin) === null);
  check('the very edge of the view still counts as on screen',
    edgeMarker({ x: 2000, y: 1400 }, view, margin) === null);

  const right = edgeMarker({ x: 4000, y: 1100 }, view, margin);
  check('something due right is marked on the right edge, pointing right',
    right !== null && deg(right.angle) === 0 && Math.round(right.x) === view.width - margin,
    right ? `at x=${Math.round(right.x)} of ${view.width}, ${deg(right.angle)} degrees` : 'no marker');
  check('and vertically centred when it is level with you', Math.round(right.y) === view.height / 2);

  const up = edgeMarker({ x: 1500, y: -400 }, view, margin);
  check('something straight up is marked on the top edge',
    deg(up.angle) === -90 && Math.round(up.y) === margin);

  // The inset is the whole point: on the edge itself the arrow is half clipped
  // by the viewport, which reads as a rendering fault rather than a pointer.
  // Measured from the centre of the *view*, world (1500, 1100) — not from the
  // origin, so a true diagonal is centre plus an equal offset on both axes.
  const corner = edgeMarker({ x: 1500 + 4000, y: 1100 + 4000 }, view, margin);
  check('a marker never leaves the inset rectangle',
    corner.x <= view.width - margin + 0.01 && corner.y <= view.height - margin + 0.01 &&
    corner.x >= margin - 0.01 && corner.y >= margin - 0.01,
    `(${Math.round(corner.x)}, ${Math.round(corner.y)}) inside a ${margin}px inset`);
  check('a corner target points diagonally', deg(corner.angle) === 45);

  // The ray leaves through the nearer axis, so a target far along one axis and
  // slightly off the other pins to the edge it actually crosses.
  const shallow = edgeMarker({ x: 6000, y: 1250 }, view, margin);
  check('the marker sits on the edge the sight line actually crosses',
    Math.round(shallow.x) === view.width - margin && shallow.y > view.height / 2,
    `(${Math.round(shallow.x)}, ${Math.round(shallow.y)})`);

  check('distance comes back for anything that wants to fade with range',
    right.distance > 0 && up.distance > 0);

  // Degenerate input must not produce a NaN position — it would put a sprite
  // somewhere undrawable and silently lose the marker.
  const odd = [
    edgeMarker({ x: 1500, y: 1100 }, { x: 1000, y: 800, width: 0, height: 0 }, margin),
    edgeMarker({ x: 5000, y: 1100 }, { x: 1000, y: 800, width: 10, height: 10 }, 99),
  ];
  check('a degenerate view cannot produce a NaN marker',
    odd.every((m) => m === null || (Number.isFinite(m.x) && Number.isFinite(m.y))));
}

/* ---------------------------------------------------------- run summary */

{
  const a = { shots: 120, chips: 40, powerUps: 3, reboots: 1 };
  const b = { shots: 80, chips: 25, powerUps: 2, reboots: 4 };

  const total = sumPlayerStats([a, b]);
  check('per-player contributions add up into a group total',
    total.shots === 200 && total.chips === 65 && total.powerUps === 5 && total.reboots === 5);
  check('an empty room totals zero', sumPlayerStats([]).shots === EMPTY_PLAYER_STATS.shots);
  check('one player is their own total', sumPlayerStats([a]).chips === 40);

  check('hit rate is kills over rounds fired', accuracy(30, 120) === 25);
  check('no shots is not a divide by zero', accuracy(5, 0) === 0);
  // Kills come from the host and shots are summed across clients, so a late
  // stats publish can briefly make kills the larger number. A card claiming
  // 140% reads as broken even though nothing is wrong.
  check('hit rate cannot exceed 100%', accuracy(200, 10) === 100);

  check('a run is timed in minutes and seconds', formatDuration(185) === '3:05');
  check('under a minute still shows minutes', formatDuration(7) === '0:07');
  check('a negative clock cannot print', formatDuration(-5) === '0:00');

  const rows = summaryRows(
    { kills: 412, wave: 11, seconds: 754, score: 9876 },
    { shots: 2000, chips: 300, powerUps: 12, reboots: 6 },
  );
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  check('the debrief reports the group, not the player',
    byLabel['Rounds fired'] === '2,000' && byLabel['Malware purged'] === '412');
  check('the debrief shows the run length', byLabel['Uptime'] === '12:34');
  check('every row has a value', rows.length > 5 && rows.every((r) => r.label && r.value !== ''),
    `${rows.length} rows`);

  // The summary crosses the wire per player; it has to survive the trip.
  const wire = decodePlayerStats(encodePlayerStats(a));
  check('per-player stats round-trip', JSON.stringify(wire) === JSON.stringify(a));
  check('a malformed stats payload is rejected', decodePlayerStats('1,2') === null);
}

/* ----------------------------------------------------------- squad order */

{
  // Ids are time-prefixed, so id order *is* join order — the same property the
  // host election relies on.
  const roster = [
    { id: '0m3', isSelf: false, isHost: false },
    { id: '0m1', isSelf: false, isHost: true },
    { id: '0m4', isSelf: true, isHost: false },
    { id: '0m2', isSelf: false, isHost: false },
  ];
  const ids = orderSquad(roster).map((m) => m.id);
  check('you are always at the top', ids[0] === '0m4');
  check('the host comes next', ids[1] === '0m1');
  check('everyone else follows in join order', ids.slice(2).join() === '0m2,0m3', ids.join(' → '));

  const hosting = orderSquad([
    { id: '0m2', isSelf: false, isHost: false },
    { id: '0m1', isSelf: true, isHost: true },
  ]).map((m) => m.id);
  check('hosting yourself does not leave a gap at the top', hosting.join() === '0m1,0m2');

  check('a solo roster is untouched', orderSquad([{ id: 'x', isSelf: true, isHost: true }]).length === 1);
  check('an empty roster is fine', orderSquad([]).length === 0);

  // Every client sorts the same roster into the same order, which is the point:
  // two players comparing screens should see the same list.
  const shuffled = [...roster].reverse();
  check('the order does not depend on the order it was built in',
    orderSquad(shuffled).map((m) => m.id).join() === ids.join());

  const original = [...roster];
  orderSquad(roster);
  check('the caller\'s array is left alone', roster.map((m) => m.id).join() === original.map((m) => m.id).join());
}

/* --------------------------------------------------------- player colours */

{
  // Colour says *who*, not what program — two people running the same class
  // used to be two identical circles in a swarm of a hundred enemies. Which
  // means no two players in a room can wear the same one, and there is no
  // server to arbitrate that.
  const ids = (m) => COLOUR_ORDER.filter((c) => Object.values(m).includes(c));

  const clear = resolveColours([
    { id: 'a', colour: 'cyan' },
    { id: 'b', colour: 'amber' },
    { id: 'c', colour: 'jade' },
  ]);
  check('nobody is moved when nobody clashes',
    clear.a === 'cyan' && clear.b === 'amber' && clear.c === 'jade');

  // Seniority: ids are time-prefixed, so the earliest joiner keeps what they
  // asked for. Nobody's colour changes under them because somebody walked in.
  const clash = resolveColours([
    { id: 'aaa', colour: 'magenta' },
    { id: 'bbb', colour: 'magenta' },
  ]);
  check('the earlier player keeps the colour', clash.aaa === 'magenta');
  check('and the later one is moved to the next free entry', clash.bbb === 'lime',
    `moved to ${clash.bbb}`);

  // Determinism is the whole point: every client computes this alone, from the
  // same presence list, and has to arrive at the same answer.
  const forwards = resolveColours([
    { id: 'a', colour: 'violet' }, { id: 'b', colour: 'violet' }, { id: 'c', colour: 'violet' },
  ]);
  const backwards = resolveColours([
    { id: 'c', colour: 'violet' }, { id: 'b', colour: 'violet' }, { id: 'a', colour: 'violet' },
  ]);
  check('the answer does not depend on the order claims arrived in',
    JSON.stringify(forwards) === JSON.stringify(backwards),
    `${JSON.stringify(forwards)} vs ${JSON.stringify(backwards)}`);
  check('a three-way pile-up still ends with three different colours',
    new Set(Object.values(forwards)).size === 3, Object.values(forwards).join(', '));

  // Wrapping: a clash at the end of the palette comes round to the front.
  const wrapped = resolveColours([
    { id: 'a', colour: 'jade' }, { id: 'b', colour: 'jade' },
  ]);
  check('a clash on the last colour wraps to the first',
    wrapped.b === COLOUR_ORDER[0], `wrapped to ${wrapped.b}`);

  // A full room. Four players, eight colours, always somewhere to go.
  const full = resolveColours(['a', 'b', 'c', 'd'].map((id) => ({ id, colour: 'cyan' })));
  check('a full squad all asking for the same colour gets four different ones',
    new Set(Object.values(full)).size === 4, Object.values(full).join(', '));

  // An older build, or a corrupted field. Never an undefined colour.
  const junk = resolveColours([{ id: 'a', colour: 'chartreuse' }, { id: 'b', colour: '' }]);
  check('an unknown colour reads as the default, and still does not clash',
    junk.a === DEFAULT_COLOUR && junk.b !== DEFAULT_COLOUR && ids(junk).length === 2,
    `${junk.a}, ${junk.b}`);

  check('every palette entry is a colour the game can resolve',
    PALETTE.every((c) => colourOf(c.id) === c && isColourId(c.id)));
  check('and colourOf never returns nothing',
    colourOf('nonsense').id === DEFAULT_COLOUR);
  check('the palette outnumbers the room', PALETTE.length > HORDE.maxPlayers,
    `${PALETTE.length} colours for ${HORDE.maxPlayers} players`);
}

/* ------------------------------------------------------------ class icons */

{
  // The in-game chassis is the same drawing for every class — only the colour
  // and radius differ — so a roster of four programs needs marks of its own.
  const svgs = CLASS_ORDER.map((id) => classIconSvg(id));

  check('every class has a glyph', svgs.every((s) => s.startsWith('<svg') && s.includes('</svg>')));
  check('no two classes share a glyph', new Set(svgs).size === CLASS_ORDER.length,
    `${new Set(svgs).size} distinct marks for ${CLASS_ORDER.length} classes`);
  // The row already names the class in text beside the glyph; announcing both
  // reads the same thing twice.
  check('glyphs are decorative', svgs.every((s) => s.includes('aria-hidden="true"')));
  // Colour lives on the row, which paints its border from the same value. A
  // second copy baked into the markup is the copy that goes stale.
  check('glyphs inherit their colour rather than carrying one',
    svgs.every((s) => s.includes('stroke="currentColor"') && !s.includes('#')));
}

/* ------------------------------------------------------------- autopilot */

{
  const world = { width: 2400, height: 1600 };
  const drive = (over) =>
    autopilotMove({ x: 1200, y: 800, enemies: [], chips: [], weaponRange: 600, world, ...over });

  const unit = (v) => Math.abs(Math.hypot(v.x, v.y) - 1) < 1e-6;
  const towards = (v, tx, ty, from = { x: 1200, y: 800 }) =>
    v.x * (tx - from.x) + v.y * (ty - from.y) > 0;

  // Backing off is the whole survival strategy.
  const crowded = drive({ enemies: [{ x: 1260, y: 800 }] });
  check('the bot backs away from something on top of it',
    unit(crowded) && crowded.x < -0.5, `heading (${crowded.x.toFixed(2)}, ${crowded.y.toFixed(2)})`);

  // Summed, not nearest-only: fleeing the closest of a crowd walks into the
  // rest of it, which at the enemy cap is most of them.
  const pincered = drive({ enemies: [{ x: 1300, y: 800 }, { x: 1290, y: 830 }, { x: 1295, y: 770 }] });
  check('a crowd is escaped as a crowd, not one enemy at a time',
    pincered.x < -0.7, `heading (${pincered.x.toFixed(2)}, ${pincered.y.toFixed(2)})`);

  // ...but it has to actually fight, or the wave never clears and the room
  // under test never advances.
  const distant = drive({ enemies: [{ x: 2000, y: 800 }] });
  check('the bot closes in when the fight is out of range',
    towards(distant, 2000, 800), `heading (${distant.x.toFixed(2)}, ${distant.y.toFixed(2)})`);

  const inRange = drive({ enemies: [{ x: 1200 + 600 * 0.5, y: 800 }] });
  check('an enemy already inside weapon range is not chased',
    !towards(inRange, 1900, 800));

  // Chips are the progression path; a bot that ignores them never earns a
  // power-up and never exercises that half of the game.
  const loot = drive({ chips: [{ x: 1200, y: 1100 }] });
  check('the bot goes and collects chips', towards(loot, 1200, 1100) && unit(loot));

  const lootUnderFire = drive({ enemies: [{ x: 1240, y: 800 }], chips: [{ x: 1400, y: 800 }] });
  check('but not while something is on top of it', lootUnderFire.x < 0,
    'retreat wins over the chip behind the enemy');

  // Cornering itself is how a retreating bot dies.
  const corner = autopilotMove({
    x: 80, y: 80, enemies: [{ x: 300, y: 300 }], chips: [], weaponRange: 600, world,
  });
  check('the bot steers off the walls rather than cornering itself',
    corner.x > 0 || corner.y > 0, `heading (${corner.x.toFixed(2)}, ${corner.y.toFixed(2)})`);

  // Idle behaviour: an empty arena between waves.
  const idle = autopilotMove({ x: 200, y: 200, enemies: [], chips: [], weaponRange: 600, world });
  check('with nothing to do it drifts to the middle',
    towards(idle, 1200, 800, { x: 200, y: 200 }) && unit(idle));
  const middle = autopilotMove({ x: 1200, y: 800, enemies: [], chips: [], weaponRange: 600, world });
  check('and stops once it gets there', middle.x === 0 && middle.y === 0);

  // Every branch must produce a usable vector — a NaN here would propagate
  // straight into the player position, which this codebase has done before.
  const hostile = [
    { enemies: [{ x: 1200, y: 800 }], chips: [{ x: 1200, y: 800 }] },
    { enemies: [], chips: [{ x: 1200, y: 800 }] },
    { enemies: [{ x: 1200, y: 800 }] },
    { x: 0, y: 0, enemies: [{ x: 0, y: 0 }] },
    { weaponRange: 0, enemies: [{ x: 1500, y: 800 }] },
  ];
  check('no input produces a NaN heading',
    hostile.every((o) => {
      const v = drive(o);
      return Number.isFinite(v.x) && Number.isFinite(v.y) && Math.hypot(v.x, v.y) <= 1.0001;
    }));
}

{
  /* ------------------------------------------------ autopilot: shopping */
  //
  // Surviving is not the same as getting anywhere. A bot that kites beautifully
  // and never banks a chip reaches the same wave every run, because damage is
  // the only thing that clears a wave faster than the next one arrives.

  const world = { width: 2400, height: 1600 };
  const drive = (over) =>
    autopilotMove({ x: 1200, y: 800, enemies: [], chips: [], weaponRange: 600, world, ...over });
  const towards = (v, tx, ty) => v.x * (tx - 1200) + v.y * (ty - 800) > 0;

  // An upgrade on the floor is worth more than any realistic pile of chips: it
  // is a permanent multiplier, it costs eight chips and rising to buy, and
  // unlike the chips it will not be there in a minute.
  const upgrade = drive({
    chips: [{ x: 900, y: 800 }, { x: 860, y: 840 }, { x: 880, y: 760 }],
    powerUps: [{ x: 1800, y: 800 }],
  });
  check('a dropped upgrade outbids a nearer pile of chips', towards(upgrade, 1800, 800),
    `heading (${upgrade.x.toFixed(2)}, ${upgrade.y.toFixed(2)})`);

  // One trip, several chips. The nearest chip is the wrong target when three
  // more are sitting together slightly further out.
  const cluster = drive({
    chips: [
      { x: 1200, y: 500 },
      { x: 1500, y: 800 }, { x: 1560, y: 860 }, { x: 1620, y: 790 }, { x: 1580, y: 730 },
    ],
  });
  check('a cluster is preferred to a closer lone chip', cluster.x > 0.5,
    `heading (${cluster.x.toFixed(2)}, ${cluster.y.toFixed(2)})`);

  // The magnet does the last 175px, so a chip inside it is already yours.
  // Steering at one pins the bot in place while it flies in.
  const latched = drive({ chips: [{ x: 1300, y: 800 }] });
  check('a chip already inside the magnet is not chased',
    latched.x === 0 && latched.y === 0, `heading (${latched.x}, ${latched.y})`);

  // Chips live 26 seconds and power-ups 45. A sprint that ends after the thing
  // has evaporated spends the time and gives up the ground for nothing.
  const doomed = drive({ chips: [{ x: 1200, y: 1400, ttl: 1.5 }], moveSpeed: 290 });
  check('loot that cannot be reached before it expires is left alone',
    doomed.x === 0 && doomed.y === 0, '1.5s of life against a 1.5s walk');
  const reachable = drive({ chips: [{ x: 1200, y: 1400, ttl: 20 }], moveSpeed: 290 });
  check('...but the same chip with time on it is collected', towards(reachable, 1200, 1400));

  // What makes a trip safe is the ground it crosses, not how far away the
  // threat happens to be. The old rule only asked the second question — with a
  // drone 300px off, a chip directly behind it was taken like any other, and
  // the bot walked through the drone to get it. The pair below is the same
  // threat at the same range and the same chip at the same distance; only the
  // path differs.
  const across = drive({ enemies: [{ x: 1500, y: 800 }], chips: [{ x: 1200, y: 1300, ttl: 20 }] });
  check('a chip reached over clear ground is collected', across.y > 0.5,
    `heading (${across.x.toFixed(2)}, ${across.y.toFixed(2)})`);
  const through = drive({ enemies: [{ x: 1500, y: 800 }], chips: [{ x: 1700, y: 800, ttl: 20 }] });
  check('a chip on the far side of the threat is left', through.x < 0,
    `heading (${through.x.toFixed(2)}, ${through.y.toFixed(2)})`);

  // Escaping and collecting are not always in conflict: most of the time
  // several ways out are about as good as each other.
  const flee = { enemies: [{ x: 1200, y: 700 }], chips: [{ x: 800, y: 820, ttl: 20 }] };
  const biased = drive(flee);
  check('a way out that runs over a chip is preferred to one that does not',
    biased.x < -0.5, `heading (${biased.x.toFixed(2)}, ${biased.y.toFixed(2)})`);

  // ...but the bias can never buy a heading into the swarm.
  const walled = drive({
    enemies: [{ x: 1340, y: 800 }, { x: 1380, y: 870 }, { x: 1360, y: 730 }],
    chips: [{ x: 1700, y: 800, ttl: 20 }],
  });
  check('loot never talks the bot through a crowd', walled.x < 0,
    `heading (${walled.x.toFixed(2)}, ${walled.y.toFixed(2)})`);

  check('no loot input produces a NaN heading',
    [
      { chips: [{ x: 1200, y: 800 }], powerUps: [{ x: 1200, y: 800 }] },
      { chips: [{ x: 1200, y: 800, ttl: 0 }], moveSpeed: 0 },
      { powerUps: [{ x: 1200, y: 800, ttl: -1 }], moveSpeed: 290 },
      { chips: [{ x: 0, y: 0, ttl: 20 }], enemies: [{ x: 0, y: 0 }], moveSpeed: 290 },
    ].every((o) => {
      const v = drive(o);
      return Number.isFinite(v.x) && Number.isFinite(v.y) && Math.hypot(v.x, v.y) <= 1.0001;
    }));
}

{
  // Does it actually shop? Scatter loot across a live horde and count what gets
  // banked. The policy that only collected while completely unthreatened took
  // 12 of 40 chips and left both upgrades on the floor to expire; the trip has
  // to be worth taking under pressure, or in a real run it is never taken.
  const realRandom = Math.random;
  let seed = 0x1f37b19d;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const engine = new HordeEngine();
  const world = { width: 2400, height: 1600 };
  let me = { x: 1200, y: 800 };
  const speed = 290;
  const dt = 1 / 60;
  let contacts = 0;

  const chips = Array.from({ length: 40 }, () => ({
    x: 200 + Math.random() * 2000, y: 150 + Math.random() * 1300, ttl: 26, taken: false,
  }));
  const powerUps = [
    { x: 400, y: 400, ttl: 45, taken: false },
    { x: 2000, y: 1200, ttl: 45, taken: false },
  ];
  const live = (all) => all.filter((p) => !p.taken && p.ttl > 0);

  for (let i = 0; i < 60 * 60; i++) {
    const enemies = [...engine.enemies.values()].map((e) => ({ x: e.x, y: e.y }));
    const move = autopilotMove({
      x: me.x, y: me.y, enemies,
      chips: live(chips), powerUps: live(powerUps),
      weaponRange: 600, moveSpeed: speed, world,
    });
    me = {
      x: Math.max(24, Math.min(world.width - 24, me.x + move.x * speed * dt)),
      y: Math.max(24, Math.min(world.height - 24, me.y + move.y * speed * dt)),
    };
    engine.step(dt, [{ id: 'bot', x: me.x, y: me.y, priority: 1, alive: true }]);

    // Chips are magnetic; upgrades have to be walked onto.
    for (const chip of chips) {
      chip.ttl -= dt;
      if (!chip.taken && Math.hypot(chip.x - me.x, chip.y - me.y) < PROGRESSION.magnetRadius) chip.taken = true;
    }
    for (const powerUp of powerUps) {
      powerUp.ttl -= dt;
      if (!powerUp.taken && Math.hypot(powerUp.x - me.x, powerUp.y - me.y) < PROGRESSION.powerUpPickupRadius) {
        powerUp.taken = true;
      }
    }

    for (const e of engine.enemies.values()) {
      if (Math.hypot(e.x - me.x, e.y - me.y) < 40) { contacts++; break; }
    }
  }

  Math.random = realRandom;

  const banked = chips.filter((c) => c.taken).length;
  const upgrades = powerUps.filter((p) => p.taken).length;
  const share = contacts / (60 * 60);

  check('the bot banks the loot it walks past', banked >= 28,
    `${banked} of 40 chips in 60s`);
  check('and does not leave upgrades on the floor to expire', upgrades === 2,
    `${upgrades} of 2 taken`);
  // The whole point of the safety term: shopping must not cost survival.
  check('shopping does not get it eaten', share < 0.2,
    `${(share * 100).toFixed(0)}% of 60s spent in contact range while looting`);
}

{
  // The bot has to survive a real horde, not just point the right way. Run the
  // engine with an autopilot-driven player and check it is not simply eaten.
  //
  // Seeded, because the engine rolls spawn angles, speeds, kinds and levels off
  // `Math.random`: the same policy measured 14% on one run and 32% on the next,
  // which makes any bound either flaky or so loose it proves nothing.
  //
  // Eight seeds were sampled before choosing one; they ranged 5% to 14%. This
  // is the *worst* of them, deliberately — pinning the test to the kindest
  // horde it could find would be marking its own homework.
  const realRandom = Math.random;
  let seed = 0x5bf03635;
  Math.random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const engine = new HordeEngine();
  const world = { width: 2400, height: 1600 };
  let me = { x: 1200, y: 800 };
  const speed = 290;
  const dt = 1 / 60;
  let contacts = 0;

  for (let i = 0; i < 90 * 60; i++) {
    const enemies = [...engine.enemies.values()].map((e) => ({ x: e.x, y: e.y }));
    const move = autopilotMove({ x: me.x, y: me.y, enemies, chips: [], weaponRange: 600, world });
    me = {
      x: Math.max(24, Math.min(world.width - 24, me.x + move.x * speed * dt)),
      y: Math.max(24, Math.min(world.height - 24, me.y + move.y * speed * dt)),
    };
    engine.step(dt, [{ id: 'bot', x: me.x, y: me.y, priority: 1, alive: true }]);

    // Count frames spent in contact range — the bot cannot kill anything in
    // this harness, so being touched sometimes is expected; living inside the
    // swarm is not.
    for (const e of engine.enemies.values()) {
      if (Math.hypot(e.x - me.x, e.y - me.y) < 40) { contacts++; break; }
    }
  }

  Math.random = realRandom;

  const share = contacts / (90 * 60);
  // Summed repulsion scored around 50% here, because it cancels out under
  // encirclement. The escape-sampling policy is what brought it down.
  check('an unarmed bot kites a live horde rather than standing in it',
    share < 0.2, `${(share * 100).toFixed(0)}% of 90s spent in contact range with no weapon`);
  check('the bot stays inside the arena',
    me.x > 0 && me.x < world.width && me.y > 0 && me.y < world.height,
    `ended at (${me.x.toFixed(0)}, ${me.y.toFixed(0)}) against ${engine.enemyCount} live`);
}

/* --------------------------------------------------------- enemy levels */

{
  check('there is one colour per level', LEVEL_COLOURS.length === MAX_LEVEL);
  check('every level colour is distinct', new Set(LEVEL_COLOURS).size === MAX_LEVEL);

  check('level 1 is the baseline', levelHealthScale(1) === 1);
  check('health climbs with level',
    Array.from({ length: MAX_LEVEL }, (_, i) => levelHealthScale(i + 1))
      .every((v, i, a) => i === 0 || v > a[i - 1]));
  check('the top level is a real wall but not a brick one',
    levelHealthScale(MAX_LEVEL) > 4 && levelHealthScale(MAX_LEVEL) < 8,
    `x${levelHealthScale(MAX_LEVEL).toFixed(1)} health at level ${MAX_LEVEL}`);

  // Rewards have to climb with health or the economy inverts exactly as the
  // game speeds up — but sub-linearly, so fodder stays worth shooting.
  check('reward climbs with level', levelRewardScale(MAX_LEVEL) > levelRewardScale(1));
  check('reward climbs slower than health',
    levelRewardScale(MAX_LEVEL) < levelHealthScale(MAX_LEVEL),
    `x${levelRewardScale(MAX_LEVEL).toFixed(1)} reward against x${levelHealthScale(MAX_LEVEL).toFixed(1)} health`);

  check('wave 1 spawns level 1', baseLevelForWave(1) === 1);
  check('levels advance with waves', baseLevelForWave(1 + LEVELS.wavesPerLevel) === 2);
  check('levels stop at the top', baseLevelForWave(500) === MAX_LEVEL);
  check('the top level arrives late enough to be an arc',
    baseLevelForWave(20) < MAX_LEVEL && baseLevelForWave(30) === MAX_LEVEL,
    `level ${MAX_LEVEL} from wave ${(MAX_LEVEL - 1) * LEVELS.wavesPerLevel + 1}`);

  // Out-of-range input must never reach a health multiplier or a colour index.
  check('levels are clamped, never trusted',
    clampLevel(0) === 1 && clampLevel(99) === MAX_LEVEL && clampLevel(Number.NaN) === 1 &&
    clampLevel(-3) === 1);

  // Deterministic rolls: the spread is a design knob, not something a test
  // should be at the mercy of.
  check('a roll with no spread is the wave base', rollLevel(9, () => 1) === baseLevelForWave(9));
  check('the low half of the spread rolls down', rollLevel(9, () => 0) === baseLevelForWave(9) - 1);
  check('the high half of the spread rolls up',
    rollLevel(9, () => LEVELS.spreadChance * 0.9) === baseLevelForWave(9) + 1);
  check('a spread below level 1 still clamps', rollLevel(1, () => 0) === 1);

  const spread = Array.from({ length: 4000 }, () => rollLevel(9));
  const offBase = spread.filter((l) => l !== baseLevelForWave(9)).length / spread.length;
  check('most of a wave is the expected threat', offBase > 0.1 && offBase < 0.35,
    `${(offBase * 100).toFixed(0)}% of spawns are off the wave's base level`);
  check('no roll ever leaves the legal range', spread.every((l) => l >= 1 && l <= MAX_LEVEL));
}

{
  // Levels have to survive the wire, or a peer draws the wrong pip and a
  // promoted host adopts a horde at the wrong difficulty.
  const levelled = Array.from({ length: 100 }, (_, i) => ({
    id: `e${i.toString(36)}`, kind: i % 6, level: (i % MAX_LEVEL) + 1,
    x: 1200 + i, y: 900 + i, hp: 50 + i, maxHp: 100, vx: 0, vy: 0, speed: 100,
    cooldown: 0, stun: 0, targetId: null,
  }));
  const back = decodeHorde(encodeHorde(levelled));
  check('kind and level both survive the packed field',
    back.every((e, i) => e.kind === levelled[i].kind && e.level === levelled[i].level));

  // Packing them into one field is what keeps this inside the bandwidth budget
  // a separate level field would have blown.
  const wire = encodeHorde(levelled);
  check('levels cost the snapshot almost nothing', wire.length < 2048,
    `${wire.length}B at the cap, ${((wire.length * 20) / 1024).toFixed(1)} KB/s at 20Hz`);

  const top = decodeHorde(encodeHorde(levelled.map((e) => ({ ...e, level: MAX_LEVEL }))));
  check('a full field of top-level enemies still fits', top.every((e) => e.level === MAX_LEVEL));

  const deaths = decodeEvents(encodeEvents([{ t: 'death', id: 'e9', x: 10, y: 20, kind: 2, level: 5 }]));
  check('a death event carries the level that pays the chips',
    deaths[0].level === 5 && deaths[0].kind === 2);
}

{
  // The engine has to put levels on spawns and scale health by them, or the
  // pip is decoration.
  const engine = new HordeEngine();
  run(engine, 14);
  const live = [...engine.enemies.values()];
  check('every spawned enemy carries a legal level',
    live.length > 0 && live.every((e) => e.level >= 1 && e.level <= MAX_LEVEL),
    `${live.length} live, levels ${[...new Set(live.map((e) => e.level))].sort().join('/')}`);
  check('health tracks the level it was spawned at',
    live.every((e) => {
      const base = ENEMY_DEFS[e.kind].hp;
      return e.maxHp >= Math.floor(base * levelHealthScale(e.level) * 0.5);
    }));

  const late = new HordeEngine();
  run(late, 120);
  const lateLevels = [...late.enemies.values()].map((e) => e.level);
  check('a long run is fighting higher levels than a short one',
    lateLevels.length > 0 && Math.max(...lateLevels) > Math.max(...live.map((e) => e.level)),
    `wave ${late.waveNumber}: levels up to ${Math.max(...lateLevels)}`);
}

/* ---------------------------------------------------------- audio volume */

{
  check('a full slider is the channel reference level',
    channelGain(1, CHANNEL_REFERENCE.sfx) === CHANNEL_REFERENCE.sfx);
  check('a zero slider is silence', channelGain(0, CHANNEL_REFERENCE.music) === 0);
  check('music sits under the effects at equal slider positions',
    channelGain(1, CHANNEL_REFERENCE.music) < channelGain(1, CHANNEL_REFERENCE.sfx),
    `music ${CHANNEL_REFERENCE.music} vs sfx ${CHANNEL_REFERENCE.sfx}`);

  // A linear slider spends its bottom quarter going silent-to-loud, so the
  // curve has to put the half-way point well below half gain or the top half
  // of the track does nothing audible.
  const halfDb = 20 * Math.log10(volumeCurve(0.5));
  check('half travel lands around -12 dB, not -6', halfDb < -10 && halfDb > -14,
    `${halfDb.toFixed(1)} dB at 50%`);

  check('the curve is monotonic across the track',
    Array.from({ length: 21 }, (_, i) => volumeCurve(i / 20))
      .every((v, i, a) => i === 0 || v > a[i - 1]));

  check('out-of-range positions cannot produce a negative or runaway gain',
    volumeCurve(-5) === 0 && volumeCurve(9) === 1 && volumeCurve(Number.NaN) >= 0);

  // The store clamps stored values to these bounds and the UI builds its range
  // inputs from the same table, so a mismatch here is a slider that can set a
  // value the store will immediately overwrite.
  check('every numeric setting declares a range that contains its default',
    Object.entries(RANGES).every(([key, { min, max }]) => {
      const value = DEFAULT_SETTINGS[key];
      return typeof value === 'number' && value >= min && value <= max;
    }),
    Object.keys(RANGES).join(', '));

  check('both audio channels default to full', DEFAULT_SETTINGS.sfxVolume === 1 && DEFAULT_SETTINGS.musicVolume === 1);
}

/* ----------------------------------------------------------------- pool */

{
  let created = 0;
  const pool = new Pool(() => ({ active: false, id: created++ }));

  const a = pool.acquire();
  a.active = true;
  const b = pool.acquire();
  b.active = true;
  check('a pool creates slots on demand', pool.size === 2 && a !== b);

  a.active = false;
  const reused = pool.acquire();
  check('a freed slot is reused rather than allocated', reused === a && pool.size === 2);

  reused.active = true;
  pool.acquire().active = true;
  check('the pool grows only when everything is live', pool.size === 3);

  check('an active slot is never handed out twice', new Set(pool.items.map((i) => i.id)).size === pool.size);
  check('countActive counts only live slots', pool.countActive() === 3);

  pool.items[1].active = false;
  check('countActive tracks releases', pool.countActive() === 2);

  // The rotating cursor must not miss a free slot that sits behind it.
  const behind = pool.items[0];
  behind.active = false;
  for (let i = 0; i < 50; i++) {
    const got = pool.acquire();
    check_once(got.active === false, 'acquire never returns a live slot');
    got.active = true;
    got.active = false;
  }
  check('the rotating cursor still finds slots behind it', pool.size === 3,
    `pool stayed at ${pool.size} across 50 acquisitions`);
}

/* ------------------------------------------------------------- class dps */

{
  const quoted = CLASS_ORDER.map((id) => `${CLASSES[id].short ?? id}:${Math.round(classDps(CLASSES[id]))}`);
  check('every class has a distinct DPS', new Set(CLASS_ORDER.map((id) => Math.round(classDps(CLASSES[id])))).size === 4,
    quoted.join(' '));

  // The Fireman's paper dps counts all seven pellets, which only lands at
  // point-blank. The quoted figure must be the discounted one, or the card
  // would tell the player it out-damages everything.
  const fireman = CLASSES.fireman;
  const paper = (fireman.weapon.damage * fireman.weapon.pellets) / fireman.weapon.fireIntervalSec;
  check('a spread weapon is quoted below its paper dps', classDps(fireman) < paper,
    `${Math.round(classDps(fireman))} quoted vs ${Math.round(paper)} on paper`);

  check('the DPS class leader is the dedicated DPS class',
    classDps(CLASSES.overclocker) === Math.max(...CLASS_ORDER.map((id) => classDps(CLASSES[id]))),
    `Overclocker ${Math.round(classDps(CLASSES.overclocker))}`);

  check('the shotgun is quoted as the shortest ranged',
    weaponRange(fireman) === Math.min(...CLASS_ORDER.map((id) => weaponRange(CLASSES[id]))),
    `${Math.round(weaponRange(fireman))}px vs Overclocker ${Math.round(weaponRange(CLASSES.overclocker))}px`);

  check('every quoted stat is a finite positive number',
    CLASS_ORDER.every((id) => classDps(CLASSES[id]) > 0 && weaponRange(CLASSES[id]) > 0));
}

/* --------------------------------------------------------- enemy rosters */

{
  // Nothing may appear before its debut wave, and every debut must actually
  // happen — a kind that is unlocked but never rostered is content nobody sees.
  const engine = new HordeEngine();
  const t = targets(1);
  const dt = 1 / 30;
  const firstSeen = new Map();
  const rosterSizes = [];
  let debutsHonoured = true;

  for (let i = 0; i < 30 * 60 * 20 && engine.waveNumber < 16; i++) {
    const result = engine.step(dt, t);
    for (const ev of result.events) {
      if (ev.t !== 'wave') continue;
      rosterSizes.push(engine.roster.length);
      for (const kind of engine.roster) {
        if (!firstSeen.has(kind)) firstSeen.set(kind, ev.n);
        if (ev.n < ENEMY_DEFS[kind].minWave) debutsHonoured = false;
      }
      // A kind unlocking this wave must be in this wave's roster.
      for (const kind of ALL_KINDS) {
        if (ENEMY_DEFS[kind].minWave === ev.n && !engine.roster.includes(kind)) debutsHonoured = false;
      }
    }
    for (const e of [...engine.enemies.values()]) {
      if (Math.random() < 0.02) engine.reportDamage(e.id, 99999, 'p');
    }
  }

  check('no kind appears before its debut wave', debutsHonoured,
    [...firstSeen].map(([k, w]) => `${ENEMY_DEFS[k].name.split(' ')[0]}@${w}`).join(' '));
  check('wave one is only Glitch Bugs', firstSeen.get(0) === 1 && (firstSeen.get(2) ?? 99) > 1);
  check('a wave draws from a subset, not everything',
    Math.max(...rosterSizes) <= 3,
    `${Math.min(...rosterSizes)}-${Math.max(...rosterSizes)} kinds per wave, of ${ALL_KINDS.length}`);
  check('later kinds do eventually arrive', firstSeen.size >= 5,
    `${firstSeen.size} of ${ALL_KINDS.length} kinds rostered by wave 16`);
}

{
  // A Spore Node bursting is the point of it; killing one must leave two bugs.
  const engine = new HordeEngine();
  const t = targets(1);
  for (let i = 0; i < 60 * 60; i++) engine.step(1 / 60, t);
  const spore = engine.spawnAt(4, 1000, 800);
  const before = engine.enemyCount;
  engine.reportDamage(spore.id, 99999, 'p');
  engine.step(1 / 60, t);
  const bugs = [...engine.enemies.values()].filter((e) => e.kind === 0).length;
  check('a spore node splits on death', engine.enemyCount === before + 1 && bugs > 0,
    `${before} -> ${engine.enemyCount} after the node burst into two`);
}

{
  // Splitting must respect the cap, or one wave of nodes doubles the horde.
  const engine = new HordeEngine();
  const t = targets(4);
  for (let i = 0; i < 60 * 400; i++) engine.step(1 / 60, t);
  for (const e of [...engine.enemies.values()].slice(0, 20)) engine.reportDamage(e.id, 99999, 'p');
  engine.step(1 / 60, t);
  check('splitting cannot exceed the enemy cap', engine.enemyCount <= HORDE.maxEnemies,
    `${engine.enemyCount} live`);
}

/* ---------------------------------------------------------- wave pacing */

{
  // Bigger waves must be given more time, or the dps needed to keep up grows
  // quadratically against a fixed timer and outruns any possible player.
  const engine = new HordeEngine();
  const t = targets(1);
  const dt = 1 / 60;
  const stamps = [];
  let clock = 0;
  for (let i = 0; i < 60 * 150; i++) {
    const result = engine.step(dt, t);
    clock += dt;
    for (const ev of result.events) if (ev.t === 'wave') stamps.push(clock);
  }
  const gaps = stamps.slice(1).map((v, i) => v - stamps[i]);
  check('each wave is given longer than the last', gaps[1] > gaps[0] && gaps[2] > gaps[1],
    gaps.slice(0, 3).map((g) => `${g.toFixed(1)}s`).join(' -> '));
  check('the first window is well over the old fixed 14s', gaps[0] > 14,
    `${gaps[0].toFixed(1)}s for a wave of ${HORDE.baseWaveSize + HORDE.waveGrowth}`);
}

{
  // A wave arrives as a stream, not as a block. This is the whole point: thirty
  // enemies appearing in one frame closes the ring around the player with
  // nothing to react to.
  const engine = new HordeEngine();
  const size = HORDE.baseWaveSize + HORDE.waveGrowth;
  const window = HORDE.waveBaseIntervalSec + size * HORDE.wavePerEnemySec;

  run(engine, HORDE.firstWaveDelaySec + 0.05, targets(1));
  const onLanding = engine.enemyCount;

  const samples = [onLanding];
  const step = 0.5;
  let elapsed = 0;
  while (engine.enemyCount < size && elapsed < window) {
    run(engine, step, targets(1));
    elapsed += step;
    samples.push(engine.enemyCount);
  }

  check('the wave does not land as a block', onLanding <= 2,
    `${onLanding} of ${size} present the moment the banner fires`);
  check('the rest arrive over time', engine.enemyCount === size,
    `${samples.join(' → ')}`);
  check('arrivals only ever go up', samples.every((v, i, a) => i === 0 || v >= a[i - 1]));
  check('the stream spans roughly the configured fraction of the window',
    elapsed > window * HORDE.waveSpawnFraction * 0.7 && elapsed < window * HORDE.waveSpawnFraction * 1.4,
    `${elapsed.toFixed(1)}s to land ${size}, against a ${(window * HORDE.waveSpawnFraction).toFixed(1)}s target`);
  check('a streamed wave still fits well inside its own window', elapsed < window * 0.6,
    `${elapsed.toFixed(1)}s of a ${window.toFixed(1)}s window spent arriving`);
}

{
  // Clearing the field pulls the next wave forward, so skill buys tempo — but
  // only once the wave has actually all arrived.
  const engine = new HordeEngine();
  run(engine, 15, targets(1));
  const waveAfterFirst = engine.waveNumber;
  const size = engine.enemyCount;
  engine.enemies.clear();

  run(engine, 0.5, targets(1));
  check('clearing a fully arrived wave pulls the next one forward', engine.waveNumber > waveAfterFirst,
    `wave ${engine.waveNumber} arrived early into a ${(HORDE.waveBaseIntervalSec + size * HORDE.wavePerEnemySec).toFixed(0)}s window`);
}

{
  // The counterpart, and the reason the guard exists: an empty field while the
  // wave is still streaming means you killed the first arrivals, not that you
  // cleared it. Treating that as a clear would drop the next wave on top of
  // the rest of this one — the exact pile-on the streaming is meant to end.
  // Derived from the config rather than hardcoded, so retuning the pacing
  // retunes the test instead of breaking it.
  const size = HORDE.baseWaveSize + HORDE.waveGrowth;
  const window = HORDE.waveBaseIntervalSec + size * HORDE.wavePerEnemySec;
  const streamEnds = HORDE.firstWaveDelaySec + window * HORDE.waveSpawnFraction;
  const stopAt = streamEnds - 0.8;
  const oldWouldAdvanceAt = HORDE.firstWaveDelaySec + HORDE.waveMinIntervalSec;

  // The test only means anything if it runs past the point the old code would
  // have advanced. If the pacing is ever retuned so the stream is shorter than
  // the minimum gap, this says so instead of passing vacuously.
  check('the streaming window outlasts the minimum gap, so this test bites',
    stopAt > oldWouldAdvanceAt,
    `clearing until ${stopAt.toFixed(1)}s, past the ${oldWouldAdvanceAt.toFixed(1)}s the old early-clear needed`);

  const engine = new HordeEngine();
  run(engine, 5, targets(1));
  const wave = engine.waveNumber;
  const arrivedSoFar = engine.enemyCount;

  for (let i = 0; i < (stopAt - 5) * 60; i++) {
    engine.step(1 / 60, targets(1));
    engine.enemies.clear();
  }
  check('killing the leading edge of a wave does not summon the next one',
    engine.waveNumber === wave,
    `still wave ${engine.waveNumber} after clearing continuously (${arrivedSoFar} of ${size} had landed at 5s)`);
}

{
  // The tempo floor, tested as the invariant it actually is: no matter how
  // fast the field is cleared, waves never stack up back to back.
  const engine = new HordeEngine();
  const stamps = [];
  let t = 0;
  for (let i = 0; i < 150 * 60; i++) {
    const { events } = engine.step(1 / 60, targets(1));
    t += 1 / 60;
    for (const e of events) if (e.t === 'wave') stamps.push(t);
    engine.enemies.clear();
  }
  const gaps = stamps.slice(1).map((v, i) => v - stamps[i]);
  check('waves never come closer together than the minimum gap',
    gaps.length > 3 && gaps.every((g) => g >= HORDE.waveMinIntervalSec - 0.05),
    `${gaps.length} waves, tightest gap ${Math.min(...gaps).toFixed(1)}s against a ${HORDE.waveMinIntervalSec}s floor`);
}

{
  // A wave trimmed by the enemy cap must not be granted time for enemies that
  // were never spawned.
  const engine = new HordeEngine();
  run(engine, 400, targets(4));
  check('the cap holds under sustained pressure', engine.enemyCount <= HORDE.maxEnemies,
    `${engine.enemyCount} live at wave ${engine.waveNumber}`);
  check('waves keep coming even while the field is full', engine.waveNumber > 8,
    `reached wave ${engine.waveNumber}`);
}

/* -------------------------------------------------------------- auto-aim */

const aimCtx = (over = {}) => ({
  fromX: 0, fromY: 0, facing: 0,
  turnRate: 25, dps: 100, bulletSpeed: 1000,
  weaponRange: 700, maxRange: 620, currentTargetId: null,
  ...over,
});

{
  // The headline behaviour: a nearly dead enemy further away beats a healthy
  // one that is closer, because finishing it is genuinely faster.
  const dying = { id: 'dying', x: 300, y: 0, hp: 3 };
  const healthy = { id: 'healthy', x: 90, y: 0, hp: 260 };
  const pick = pickTarget([healthy, dying], aimCtx());
  check('a nearly dead enemy outranks a closer healthy one', pick.id === 'dying',
    `chose ${pick.id}`);

  // ...but not at any distance. Push it far enough and the close one wins.
  const distant = { id: 'dying', x: 600, y: 0, hp: 3 };
  const near = pickTarget([healthy, distant], aimCtx({ weaponRange: 200, bulletSpeed: 400 }));
  check('but distance still wins once the shot is wasted', near.id === 'healthy',
    `chose ${near.id} when the dying one is out of weapon range`);
}

{
  // Equal health: pure distance, as before.
  const a = { id: 'a', x: 100, y: 0, hp: 50 };
  const b = { id: 'b', x: 200, y: 0, hp: 50 };
  check('with equal health it still picks the nearest', pickTarget([b, a], aimCtx()).id === 'a');
}

{
  // Stickiness: a marginally better rival must not steal the lock.
  const held = { id: 'held', x: 100, y: 0, hp: 40 };
  const rival = { id: 'rival', x: 96, y: 0, hp: 39 };
  const ctx = aimCtx({ currentTargetId: 'held' });
  check('a marginally better rival does not steal the lock',
    pickTarget([held, rival], ctx).id === 'held');

  // ...but a decisively better one does.
  const finisher = { id: 'finisher', x: 110, y: 0, hp: 1 };
  check('a decisively better target takes it immediately',
    pickTarget([held, finisher], ctx).id === 'finisher');
}

{
  // Turning cost is real now that the chassis has a turn rate: something
  // directly behind is more expensive than the same target in front.
  const front = { id: 'front', x: 200, y: 0, hp: 60 };
  const behind = { id: 'behind', x: -200, y: 0, hp: 60 };
  const ctx = aimCtx();
  check('a target behind you costs more to acquire',
    targetScore(behind, ctx) > targetScore(front, ctx),
    `${targetScore(behind, ctx).toFixed(3)}s vs ${targetScore(front, ctx).toFixed(3)}s`);
}

{
  check('nothing beyond acquisition range is considered',
    pickTarget([{ id: 'far', x: 5000, y: 0, hp: 1 }], aimCtx()) === null);
  check('an empty field yields no target', pickTarget([], aimCtx()) === null);
  check('a zero-dps weapon cannot divide by zero',
    Number.isFinite(targetScore({ id: 'x', x: 10, y: 0, hp: 10 }, aimCtx({ dps: 0 }))));
  check('the sticky discount is applied to the held target only',
    Math.abs(
      targetScore({ id: 'k', x: 100, y: 0, hp: 50 }, aimCtx({ currentTargetId: 'k' })) -
      targetScore({ id: 'k', x: 100, y: 0, hp: 50 }, aimCtx()) * TARGETING.stickyDiscount,
    ) < 1e-9);
}

/* ------------------------------------------------------------ turn rate */

{
  const step = TURN_RATE_RAD_PER_SEC / 60; // one frame at 60fps
  check('turn rate is expressed in RPM and converted once',
    Math.abs(TURN_RATE_RAD_PER_SEC - (PLAYER.turnRateRpm * Math.PI * 2) / 60) < 1e-9,
    `${PLAYER.turnRateRpm} RPM = ${TURN_RATE_RAD_PER_SEC.toFixed(1)} rad/s`);

  check('a small turn completes in one step', approachAngle(0, step / 2, step) === step / 2);

  // Exactly opposite is the ambiguous case — both directions are equally
  // short — so assert the step size, not its sign.
  check('a large turn is rate limited',
    Math.abs(Math.abs(approachAngle(0, Math.PI, step)) - step) < 1e-9);

  // Turning must take the short way round: +170 to -170 degrees is 20 degrees
  // onward through 180, not 340 back the other way. Use a step smaller than
  // that gap, or the turn simply completes and proves nothing.
  const from = (170 * Math.PI) / 180;
  const to = (-170 * Math.PI) / 180;
  const slow = (5 * Math.PI) / 180;
  const stepped = approachAngle(from, to, slow);
  check('turns take the shorter arc', stepped > from && stepped < Math.PI,
    `${((stepped * 180) / Math.PI).toFixed(0)} degrees, onward through 180`);
  check('a turn shorter than one step snaps to the target',
    approachAngle(from, to, step) === to, 'no overshoot');

  let angle = 0;
  let frames = 0;
  while (Math.abs(angle - Math.PI) > 1e-6 && frames < 600) {
    angle = approachAngle(angle, Math.PI, step);
    frames++;
  }
  check('a 180-degree turn takes a playable time', frames / 60 < 0.35,
    `${(frames / 60 * 1000).toFixed(0)}ms at ${PLAYER.turnRateRpm} RPM`);
}

finish();
