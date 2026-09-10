/**
 * Headless tests for the engine-agnostic half of the game.
 * These import the compiled sim/ and net/ modules directly — no DOM, no Phaser.
 */
import { reporter } from './rig.mjs';
import { HordeEngine } from '../dist/sim/HordeEngine.js';
import {
  encodeHorde, decodeHorde, encodeEvents, decodeEvents,
  encodePlayer, decodePlayer, encodeField, decodeField, sanitizeName,
} from '../dist/net/codec.js';
import { HORDE, PLAYER, TURN_RATE_RAD_PER_SEC } from '../dist/config.js';
import { PlayerProgress, PROGRESSION, UPGRADES } from '../dist/sim/progression.js';
import { approachAngle, hashUnit } from '../dist/util.js';
import { ENEMY_DEFS } from '../dist/sim/enemyTypes.js';
import { pickTarget, targetScore, TARGETING } from '../dist/sim/targeting.js';
import { CLASSES, CLASS_ORDER, classDps, weaponRange } from '../dist/sim/classes.js';
import { Pool } from '../dist/render/pool.js';

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
  run(solo, 5, targets(1));
  run(squad, 5, targets(4));
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
  const p = new PlayerProgress();
  for (const id of ['damage', 'speed', 'firerate']) {
    for (let i = 0; i < UPGRADES[id].maxStacks; i++) p.grant(id);
  }
  check('a fully upgraded player rolls nothing', p.rollUpgrade() === null);
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
  // Clearing the field pulls the next wave forward, so skill buys tempo.
  const engine = new HordeEngine();
  run(engine, 5, targets(1));
  const waveAfterFirst = engine.waveNumber;
  const size = engine.enemyCount;
  engine.enemies.clear();

  run(engine, 1, targets(1));
  check('a cleared field does not skip the minimum gap', engine.waveNumber === waveAfterFirst,
    `still wave ${engine.waveNumber} after 1s`);

  run(engine, 5, targets(1));
  check('clearing the field pulls the next wave forward', engine.waveNumber > waveAfterFirst,
    `wave ${engine.waveNumber} arrived early, ~6s into a ${(HORDE.waveBaseIntervalSec + size * HORDE.wavePerEnemySec).toFixed(0)}s window`);
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
