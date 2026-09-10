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
import { approachAngle } from '../dist/util.js';

const { check, finish } = reporter('GLITCHBURST — simulation & codec');

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
