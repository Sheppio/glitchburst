/**
 * Two live clients in one room, sharing a loopback broker across tabs.
 * Exercises host election, batched broadcast, peer unpacking, mid-game join
 * and host failover — the parts of the architecture that only exist when more
 * than one client is present.
 */
import { buildRig, launch, reporter, startRunAsHost, startServer, waitForRun } from './rig.mjs';
import { ENEMY_DEFS } from '../dist/sim/enemyTypes.js';
import { killScore } from '../dist/sim/enemyLevels.js';

await buildRig();
const { server, url } = await startServer();
const browser = await launch({ uncapped: false });
// One context so both tabs are same-origin and share the BroadcastChannel.
const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });

const { check, finish } = reporter('GLITCHBURST — multiplayer');

const errors = [];
const openClient = async (target) => {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(target, { waitUntil: 'networkidle' });
  // Background tabs get their rAF throttled, which stalls Playwright's
  // actionability polling. Drive whichever tab is in front.
  await page.bringToFront();
  return page;
};

/**
 * Neither test client ever moves, so a wave will corner and kill it. A downed
 * player is deliberately excluded from AI targeting and from difficulty
 * scaling, which would make the squad-size assertion below measure survival
 * rather than squad counting. Keep both upright; a real player would be dodging.
 */
const keepAlive = (page) => page.evaluate(() => {
  const scene = window.glitchburst.game.scene.getScene('game');
  window.__keepAlive = setInterval(() => { scene.me.hp = scene.me.maxHp; }, 100);
});

const score = (page) => page.evaluate(() => window.glitchburst.game.scene.getScene('game').score);

const state = (page) => page.evaluate(() => {
  const scene = window.glitchburst.game?.scene.getScene('game');
  return {
    isHost: window.glitchburst.room?.isHost ?? null,
    hostId: window.glitchburst.room?.hostId ?? null,
    playerId: window.glitchburst.playerId,
    squad: window.glitchburst.room?.squadSize ?? 0,
    runsSimulation: Boolean(scene?.horde),
    engineSquad: scene?.horde?.squadSize ?? null,
    enemiesOnScreen: scene?.enemies.size ?? 0,
    wave: scene?.horde?.waveNumber ?? scene?.lastWave ?? 0,
    hordePublished: window.__published.filter((m) => m.topic.endsWith('/horde/positions')).length,
  };
});

/* ---------------------------------------------------------- client A: host */

const a = await openClient(url);
await a.click('#btn-create');
const code = (await a.textContent('#room-code-label')).trim();
await a.fill('#input-callsign', 'ALPHA');
await a.click('.class-card[data-cls="overclocker"]');
await a.click('#btn-deploy');
await startRunAsHost(a);
await a.waitForFunction(() => window.glitchburst.room?.isHost === true, null, { timeout: 6000 });
await keepAlive(a);

check('first client to join becomes host', (await state(a)).isHost, `room ${code}`);

// Let waves build so the second client joins mid-game, not at a clean start.
await a.waitForFunction(() => {
  const s = window.glitchburst.game.scene.getScene('game');
  return s?.horde?.enemies.size >= 8;
}, null, { timeout: 20000 });

const beforeJoin = await state(a);
check('host is simulating a live horde before anyone else joins',
  beforeJoin.runsSimulation && beforeJoin.enemiesOnScreen >= 8,
  `${beforeJoin.enemiesOnScreen} enemies, wave ${beforeJoin.wave}`);

/* ------------------------------------------------- client B: mid-game join */

const b = await openClient(`${url}?room=${code}`);
check('a shared link prefills the room code', (await b.inputValue('#input-room')) === code, code);

await b.click('#btn-join');
await b.fill('#input-callsign', 'BRAVO');
await b.click('.class-card[data-cls="encoder"]');
await b.click('#btn-deploy');
// B never presses anything: the host's heartbeat says the room is playing, and
// that alone walks the late joiner into the match already underway.
await waitForRun(b);
check('a late joiner is pulled into a run already in progress', true);
await keepAlive(b);
await b.waitForTimeout(2500);

const bState = await state(b);
const aState = await state(a);

check('second client does not claim host', bState.isHost === false);
check('both clients agree on who the host is',
  bState.hostId === aState.playerId && aState.hostId === aState.playerId);
check('peer runs no simulation of its own', bState.runsSimulation === false);

check('peer spawns the whole in-flight horde from one snapshot',
  bState.enemiesOnScreen >= 8,
  `${bState.enemiesOnScreen} enemies materialised on join, host has ${aState.enemiesOnScreen}`);

check('peer horde matches the host within a couple of enemies',
  Math.abs(bState.enemiesOnScreen - aState.enemiesOnScreen) <= 3,
  `host ${aState.enemiesOnScreen} vs peer ${bState.enemiesOnScreen}`);

check('peer publishes no horde snapshots', bState.hordePublished === 0);

/* ------------------------------------------------------------- scoring */

{
  // The score is the squad's, and a co-op HUD with one SCORE readout showing
  // two different numbers reads as a bug whichever number is "right". Both
  // clients must land on the same total.
  await b.bringToFront();
  const before = { peer: await score(b), host: await score(a) };

  const killed = await b.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    const target = [...scene.enemies.keys()][0];
    const view = scene.enemies.get(target);
    if (!view) return { ok: false, why: 'no enemy to shoot' };
    const shot = { kind: view.kind, level: view.level };
    // The real attacker-authority path: report damage, host applies it, host
    // broadcasts the death back to the room.
    scene.reportDamage(target, 99999);
    for (let i = 0; i < 180 && scene.enemies.has(target); i++) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { ok: !scene.enemies.has(target), why: 'enemy survived the report', shot };
  });

  const worth = killed.shot ? killScore(ENEMY_DEFS[killed.shot.kind].score, killed.shot.level) : 0;
  await b.waitForFunction((p) => window.glitchburst.game.scene.getScene('game').score > p, before.peer,
    { timeout: 6000 }).catch(() => {});

  const peerGain = (await score(b)) - before.peer;
  check('a peer scores the kills it makes', killed.ok && peerGain >= worth,
    killed.ok ? `peer ${before.peer} → ${before.peer + peerGain} for a kill worth ${worth}` : killed.why);

  // The host did not fire a shot, but the kill is the squad's, so its total
  // moves by the same amount.
  await a.bringToFront();
  await a.waitForFunction((p) => window.glitchburst.game.scene.getScene('game').score > p, before.host,
    { timeout: 6000 }).catch(() => {});
  const hostGain = (await score(a)) - before.host;
  check('the squad total counts a kill on both clients', hostGain === peerGain && hostGain >= worth,
    `host +${hostGain}, peer +${peerGain} for a kill worth ${worth}`);
}

{
  // A dropped death event would otherwise leave a peer permanently behind:
  // the horde snapshot is complete state and self-corrects, but a score built
  // only from events does not. The host's total rides the heartbeat, so this
  // heals within a beat.
  await b.bringToFront();
  await b.evaluate(() => {
    // Simulate the drop by corrupting the peer's tally directly.
    window.glitchburst.game.scene.getScene('game').score = 1;
  });

  const healed = await b
    .waitForFunction(() => window.glitchburst.game.scene.getScene('game').score !== 1, null, { timeout: 6000 })
    .then(() => true)
    .catch(() => false);

  const [peerScore, hostScore] = [await score(b), await score(a)];
  check('a peer that misses a death event is repaired by the heartbeat',
    healed && peerScore === hostScore,
    `peer forced to 1, recovered to ${peerScore} against the host's ${hostScore}`);
}

/* ---------------------------------------------------------- run summary */

{
  // Rounds fired is the stat only each client knows about itself, so it is the
  // one that proves aggregation rather than broadcast.
  // Published explicitly rather than left to the once-a-second tick. A page
  // that is not in front stops running its update loop altogether, so the tick
  // never comes — and this test used to pass or fail on whether the browser
  // had frozen the other tab yet.
  await a.bringToFront();
  await a.evaluate(() => {
    const scene = window.glitchburst.game.scene.getScene('game');
    scene.shotsFired = 700;
    scene.publishStatsNow();
  });
  await b.bringToFront();
  await b.evaluate(() => {
    const scene = window.glitchburst.game.scene.getScene('game');
    scene.shotsFired = 300;
    scene.publishStatsNow();
  });

  // Published once a second, so both clients need a moment to hear each other.
  const summed = await b
    .waitForFunction(
      () => {
        const s = window.glitchburst.game.scene.getScene('game');
        return [...s.playerStats.values()].reduce((t, p) => t + p.shots, 0) >= 1000;
      },
      null,
      { timeout: 8000 },
    )
    .then(() => true)
    .catch(() => false);

  const onPeer = await b.evaluate(() => {
    const s = window.glitchburst.game.scene.getScene('game');
    return [...s.playerStats.values()].reduce((t, p) => t + p.shots, 0);
  });

  check('the debrief totals the squad, not the player', summed && onPeer >= 1000,
    `peer sees ${onPeer} rounds fired across the room, having fired 300 itself`);
}

/* --------------------------------------------------------- edge markers */

{
  // The arena is far bigger than the camera, so most of the time your squad is
  // somewhere you cannot see. Without a pointer the only way to regroup is to
  // guess a direction and run.
  await a.bringToFront();
  const out = await a.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    const remote = [...scene.remotes.values()][0];
    if (!remote) return { why: 'no teammate' };

    // Put the teammate far off screen, down and to the right. The camera
    // follows with a lerp, so it is snapped rather than waited on — otherwise
    // the teammate is still in shot when the markers are read and the test
    // measures the camera's easing instead of the marker.
    // Held for the duration rather than set once. The teammate broadcasts its
    // real position fifteen times a second and the camera eases toward this
    // client's own, so a set-and-wait measures whatever the network and the
    // lerp happened to leave behind — which is how this came to fail about one
    // run in five.
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    for (let i = 0; i < 24; i++) {
      remote.state.x = 2300;
      remote.state.y = 1500;
      scene.me.x = 300;
      scene.me.y = 300;
      scene.cameras.main.centerOn(300, 300);
      await frame();
    }

    const shown = scene.markers.items.filter((m) => m.sprite.visible);
    const view = scene.cameras.main.worldView;
    return {
      count: shown.length,
      // Pointing down-right, which is where the teammate actually is.
      angles: shown.map((m) => Math.round((m.sprite.rotation * 180) / Math.PI)),
      // And pinned inside the viewport, not drawn at the teammate's position.
      inside: shown.every(
        (m) => m.sprite.x >= 0 && m.sprite.x <= view.width && m.sprite.y >= 0 && m.sprite.y <= view.height,
      ),
      pinned: shown.every((m) => m.sprite.scrollFactorX === 0),
    };
  });

  check('an off-screen teammate gets an arrow at the screen edge',
    out.count >= 1 && out.inside && out.pinned && out.angles.some((d) => d > 0 && d < 90),
    out.why ?? `${out.count} marker(s) at ${out.angles.join(', ')} degrees, pinned to the viewport`);
}

/* -------------------------------------------------------- interpolation */

const drift = await b.evaluate(async () => {
  const scene = window.glitchburst.game.scene.getScene('game');
  const id = [...scene.enemies.keys()][0];
  const samples = [];
  for (let i = 0; i < 8; i++) {
    const v = scene.enemies.get(id);
    if (v) samples.push({ x: v.sprite.x, y: v.sprite.y, tx: v.tx, ty: v.ty });
    await new Promise((r) => requestAnimationFrame(r));
  }
  const moved = samples.filter((s, i) => i > 0 && (s.x !== samples[i - 1].x || s.y !== samples[i - 1].y)).length;
  const gap = Math.hypot(samples.at(-1).x - samples.at(-1).tx, samples.at(-1).y - samples.at(-1).ty);
  return { frames: samples.length, moved, gap: +gap.toFixed(1) };
});
check('peer sprites glide between 20Hz snapshots rather than teleporting',
  drift.moved >= drift.frames - 2,
  `moved on ${drift.moved}/${drift.frames - 1} frames, ${drift.gap}px behind target`);

/* ------------------------------------------------------ squad & difficulty */

await a.bringToFront();
await a.waitForTimeout(1500);
const aSquad = await state(a);
check('host counts a squad of two', aSquad.squad === 2 && aSquad.engineSquad === 2,
  `room ${aSquad.squad}, engine ${aSquad.engineSquad}`);
check('HUD reports squad size', (await a.textContent('#hud-players')).trim() === '2/4');

/* ------------------------------------------------------------- identity */

// The staging area lets a player rename themselves and switch program between
// runs. That is only worth anything if the rest of the squad sees it: the
// roster everyone reads is built from presence, so the edit has to go back out
// on presence rather than waiting for the next join.
await a.bringToFront();
const beforeIdentity = await b.evaluate(() => {
  const peer = [...window.glitchburst.room.peers.values()][0];
  return { name: peer?.name, cls: peer?.cls };
});
await a.evaluate(() => window.glitchburst.room.setIdentity('RENAMED', 'glitcher'));
const sawIdentity = await b
  .waitForFunction(
    () => [...window.glitchburst.room.peers.values()][0]?.name === 'RENAMED',
    null, { timeout: 4000 },
  )
  .then(() => true)
  .catch(() => false);
const afterIdentity = await b.evaluate(() => {
  const peer = [...window.glitchburst.room.peers.values()][0];
  return { name: peer?.name, cls: peer?.cls };
});
check('a lobby rename reaches the rest of the squad',
  sawIdentity && afterIdentity.name === 'RENAMED' && beforeIdentity.name !== 'RENAMED',
  `${beforeIdentity.name} → ${afterIdentity.name}`);
check('and so does a change of program', afterIdentity.cls === 'glitcher',
  `${beforeIdentity.cls} → ${afterIdentity.cls}`);

// Two clients asking for the same colour, with no server to arbitrate. Every
// client runs the same resolver over the same presence list; the earlier id
// keeps its choice and the later one moves, and both must reach that answer
// alone. Two identical chassis in a swarm of a hundred is the bug this avoids.
await a.evaluate(() => window.glitchburst.room.setIdentity('RENAMED', 'glitcher', 'violet'));
await b.evaluate(() => {
  const room = window.glitchburst.room;
  room.setIdentity('BRAVO', room.peers.values().next().value?.cls ?? 'overclocker', 'violet');
});
const settled = await b
  .waitForFunction(
    () => [...window.glitchburst.room.peers.values()][0]?.colour === 'violet',
    null, { timeout: 4000 },
  )
  .then(() => true)
  .catch(() => false);

// B has to be in front to publish: a backgrounded page runs no update loop, so
// its player packets — the thing that re-skins its sprite on A — stop entirely.
// That is also the production failure this whole section exists for.
await b.bringToFront();
await b.waitForTimeout(500);
await a.bringToFront();
await a.waitForTimeout(500);

const ids = await a.evaluate(() => ({
  me: window.glitchburst.room.playerId,
  peer: [...window.glitchburst.room.peers.values()][0]?.id,
}));
const onA = await a.evaluate(() => window.glitchburst.room.resolvedColours());
const onB = await b.evaluate(() => window.glitchburst.room.resolvedColours());
const senior = ids.me < ids.peer ? ids.me : ids.peer;

check('a colour clash is resolved without either client asking the other',
  settled && onA[ids.me] !== onA[ids.peer],
  `${onA[ids.me]} and ${onA[ids.peer]}`);
check('both clients reach the same answer alone',
  JSON.stringify(onA) === JSON.stringify(onB),
  `A says ${JSON.stringify(onA)}, B says ${JSON.stringify(onB)}`);
check('the earlier player keeps what they asked for', onA[senior] === 'violet',
  `${senior === ids.me ? 'A' : 'B'} joined first and kept violet`);

// ...and the resolved colour is what actually gets drawn, on the client that
// did *not* choose it.
await a
  .waitForFunction(
    (peerId) => {
      const scene = window.glitchburst.game.scene.getScene('game');
      const remote = scene.remotes.get(peerId);
      const settledColour = window.glitchburst.room.resolvedColours()[peerId];
      return Boolean(remote) && remote.swatch === settledColour;
    },
    ids.peer, { timeout: 5000 },
  )
  .catch(() => {});
const drawn = await a.evaluate((peerId) => {
  const scene = window.glitchburst.game.scene.getScene('game');
  const remote = scene.remotes.get(peerId);
  return remote ? { swatch: remote.swatch, texture: remote.sprite.texture.key } : null;
}, ids.peer);
check('a teammate is drawn in their settled colour, not their claim',
  Boolean(drawn) && drawn.swatch === onA[ids.peer] && drawn.texture.endsWith(`-${onA[ids.peer]}`),
  drawn ? `${drawn.texture} for a resolved ${onA[ids.peer]}` : 'no remote sprite');

/* ------------------------------------------------------ waking up stale */

// The trigger behind the reported split: a tab that is not in front has its
// update loop frozen and its timers throttled. It wakes to a roster it last
// heard from a minute ago, and the naive response — drop them all — shrinks the
// squad, changes the reboot rules and promotes it to host of a room that
// already has one.
{
  await b.bringToFront();
  const before = await b.evaluate(() => window.glitchburst.room.peers.size);

  const after = await b.evaluate(() => {
    const room = window.glitchburst.room;
    // Exactly the state a tab wakes up in: nothing heard from for a minute,
    // because nothing was listening for a minute.
    const stale = performance.now() - 60000;
    for (const peer of room.peers.values()) peer.lastSeen = stale;
    room.lastHostBeat = stale;
    room.lastTickAt = stale;

    // The tick is driven directly rather than waited for. Presence from the
    // other client lands every second and would refresh the staleness out from
    // under the test — and one tick is all it takes to get this wrong.
    room.tick();
    return { peers: room.peers.size, isHost: room.isHost };
  });

  check('a client that was frozen does not drop the room on waking',
    before > 0 && after.peers === before,
    `${before} peers before a 60s freeze, ${after.peers} after`);
  check('and does not promote itself over a host that never went away',
    after.isHost === false, after.isHost ? 'woke up believing it was host' : 'still a peer');
}

/* --------------------------------------------------------- split brain */

// A room that quietly becomes two rooms is the worst failure this architecture
// has, because nothing about it looks broken: both halves keep playing, on
// their own wave, and only the wave number gives it away. Reported from a
// four-client session — two clients hit System Failure seconds apart while the
// other two carried on, on different waves.
//
// Force the state directly rather than trying to reproduce the stall that
// caused it: make the higher-id client believe it is host while the lower-id
// one still is, and check the room converges on one of them again.
{
  const ids = await a.evaluate(() => ({
    me: window.glitchburst.room.playerId,
    peer: [...window.glitchburst.room.peers.values()][0]?.id,
  }));
  const junior = ids.me < ids.peer ? b : a;
  const senior = junior === a ? b : a;

  // Heartbeats are the channel that normally heals this, so silence them: what
  // is under test is whether presence alone is enough.
  await junior.evaluate(() => {
    const room = window.glitchburst.room;
    room.__realOnHeartbeat = room.onHeartbeat;
    room.onHeartbeat = () => {};
    room._isHost = true;
    room._hostId = room.playerId;
    room.events.emit('hostChange', { hostId: room.playerId, isHost: true, reason: 'election' });
  });

  const both = await junior.evaluate(() => window.glitchburst.room.isHost);
  const healed = await junior
    .waitForFunction(() => window.glitchburst.room.isHost === false, null, { timeout: 6000 })
    .then(() => true)
    .catch(() => false);

  await junior.evaluate(() => {
    const room = window.glitchburst.room;
    if (room.__realOnHeartbeat) room.onHeartbeat = room.__realOnHeartbeat;
  });
  await junior.waitForTimeout(600);

  const after = {
    junior: await junior.evaluate(() => ({
      isHost: window.glitchburst.room.isHost,
      hostId: window.glitchburst.room.hostId,
      simulating: window.glitchburst.game.scene.getScene('game').horde !== null,
    })),
    senior: await senior.evaluate(() => ({
      isHost: window.glitchburst.room.isHost,
      simulating: window.glitchburst.game.scene.getScene('game').horde !== null,
    })),
  };

  check('a split brain heals over presence, with no heartbeat at all', both && healed,
    healed ? 'the higher id stood down inside six seconds' : 'both clients still claim authority');
  check('and exactly one client is left simulating',
    after.senior.isHost && !after.junior.isHost &&
    after.senior.simulating && !after.junior.simulating,
    `senior ${after.senior.isHost ? 'host' : 'peer'}/${after.senior.simulating ? 'sim' : 'idle'}, ` +
    `junior ${after.junior.isHost ? 'host' : 'peer'}/${after.junior.simulating ? 'sim' : 'idle'}`);
}

/* --------------------------------------------------------- seeing the squad */

// Make the host fire, and confirm the peer actually renders those rounds.
await a.bringToFront();
await a.evaluate(() => {
  window.glitchburst.settings.set('autoFire', true);
  window.glitchburst.settings.set('autoAim', true);
});
await a.waitForTimeout(1500);

const seen = await b.evaluate(() => {
  const scene = window.glitchburst.game.scene.getScene('game');
  return {
    remote: scene.remoteBullets.items.filter((x) => x.active).length,
    own: scene.bullets.items.filter((x) => x.active).length,
  };
});
check("a peer sees the host's bullets", seen.remote > 0,
  `${seen.remote} remote rounds on screen`);
check('and does not confuse them for its own', seen.own === 0);

check('remote bullets are inert (attacker authority)', await b.evaluate(() => {
  const scene = window.glitchburst.game.scene.getScene('game');
  return scene.remoteBullets.items.every((x) => x.damage === 0);
}), 'zero damage, never collide');

check('shots are batched, not one message per pellet', await a.evaluate(() => {
  const shots = window.__published.filter((m) => m.topic.endsWith('/shots'));
  if (!shots.length) return false;
  // Every message is a batch of "x,y,angle;" records for a whole publish tick.
  return shots.every((m) => /^(-?\d+,-?\d+,-?\d+;)+$/.test(m.payload));
}), `${await a.evaluate(() => window.__published.filter((m) => m.topic.endsWith('/shots')).length)} shot batches`);

await a.evaluate(() => window.glitchburst.settings.set('autoFire', false));

/* ---------------------------------------------------------------- lives */

// A squad ignores the solo reboot pool entirely: you come back for as long as
// somebody is still standing, and a wipe is what ends the run.
await b.bringToFront();
const revived = await b.evaluate(async () => {
  const scene = window.glitchburst.game.scene.getScene('game');
  clearInterval(window.__keepAlive);
  // Well past the three reboots a solo player would be allowed.
  scene.deaths = 9;
  scene.downedFor = 0;
  scene.me.hp = scene.me.maxHp;
  scene.takeDamage(99999);
  return { gameOver: scene.gameOver, waiting: Math.round(scene.downedFor), deaths: scene.deaths };
});
check('a squad member reboots past the solo limit while a mate stands',
  revived.gameOver === false && revived.waiting > 0,
  `death ${revived.deaths}, rebooting in ${revived.waiting}s`);
check('the reboot delay is capped', revived.waiting <= 20, `${revived.waiting}s`);

check('reboots are not counted in a squad', (await state(b)).isHost === false &&
  (await b.evaluate(() => window.glitchburst.game.scene.getScene('game').rebootsLeft())) === null);

// ...and the solo pool must not be applied retroactively when the room shrinks.
//
// This is the other half of the reported four-client failure. A squad run has
// no death limit at all, so a long one racks deaths up freely; measure that
// total against three the instant the roster drops to one and the run ends on
// the spot. That is what the players saw — System Failure seconds apart, on
// clients that had simply lost sight of each other for a moment.
const shrunk = await b.evaluate(async () => {
  const scene = window.glitchburst.game.scene.getScene('game');
  const room = window.glitchburst.room;
  const frame = () => new Promise((r) => requestAnimationFrame(r));

  scene.gameOver = false;
  scene.downedFor = 0;
  scene.deaths = 9;
  scene.me.hp = scene.me.maxHp;
  await frame();

  // The room shrinks to one, exactly as a moment of presence silence used to
  // make it. Pinned rather than emptied: presence from the other client lands
  // every second and would repopulate the roster mid-measurement.
  Object.defineProperty(room, 'squadSize', { value: 1, configurable: true });
  await frame();
  await frame();

  const squadSize = room.squadSize;
  const left = scene.rebootsLeft();
  scene.me.hp = 1;
  scene.takeDamage(99999);
  const out = { squadSize, left, gameOver: scene.gameOver, deaths: scene.deaths };

  delete room.squadSize;
  scene.gameOver = false;
  scene.downedFor = 0;
  scene.deaths = 0;
  scene.soloFromDeaths = 0;
  scene.me.hp = scene.me.maxHp;
  await frame();
  window.__keepAlive = setInterval(() => { scene.me.hp = scene.me.maxHp; }, 100);
  return out;
});

check('a squad run that shrinks to one is not billed for its co-op deaths',
  shrunk.squadSize === 1 && shrunk.gameOver === false,
  shrunk.gameOver
    ? `ended the run on death ${shrunk.deaths} the moment the roster emptied`
    : `alone on death ${shrunk.deaths}, still ${shrunk.left} reboots in hand`);

// Now down the rest of the squad, and the next death is terminal.
await a.bringToFront();
await a.evaluate(() => {
  const scene = window.glitchburst.game.scene.getScene('game');
  clearInterval(window.__keepAlive);
  scene.downedFor = 0;
  scene.me.hp = scene.me.maxHp;
  scene.takeDamage(99999);
});
await b.bringToFront();
// A is backgrounded now, and a background tab's rAF is throttled to about 1Hz —
// so its downed state goes out on the next slow publish, not the next frame.
await b.waitForFunction(
  () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    return [...scene.remotes.values()].every((r) => (r.state.flags & 4) !== 0);
  },
  null,
  { timeout: 8000 },
).catch(() => {});

const wiped = await b.evaluate(async () => {
  const scene = window.glitchburst.game.scene.getScene('game');
  scene.gameOver = false;
  scene.downedFor = 0;
  scene.me.hp = scene.me.maxHp;
  const mates = scene.squadmatesAlive();
  scene.takeDamage(99999);
  // The veil is painted by the HUD on the next frame, not by takeDamage.
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));
  return {
    gameOver: scene.gameOver,
    veiled: !document.getElementById('over-veil').hidden,
    mates,
  };
});
check('a wipe ends the run', wiped.gameOver && wiped.veiled,
  `${wiped.mates} squadmates standing, failure screen ${wiped.veiled ? 'shown' : 'MISSING'}`);

// A is still sitting in a long reboot. Under the old rule — which only asked
// "can I reboot?" at the instant of death — it would serve that reboot out,
// come back alive, and only discover the wipe the next time it died. That was
// the fifteen-second gap between one client's SYSTEM FAILURE and the other's.
await a.bringToFront();
const together = await a
  .waitForFunction(() => window.glitchburst.game.scene.getScene('game').gameOver, null, { timeout: 6000 })
  .then(() => true)
  .catch(() => false);

const aState2 = await a.evaluate(() => {
  const scene = window.glitchburst.game.scene.getScene('game');
  return { gameOver: scene.gameOver, waiting: scene.downedFor, veiled: !document.getElementById('over-veil').hidden };
});
check('both clients end the run, not just the one that died last',
  together && aState2.gameOver,
  aState2.gameOver
    ? `the rebooting client noticed the wipe instead of serving out its reboot`
    : `still rebooting in ${Math.round(aState2.waiting)}s with the squad wiped`);

// Restore both clients for the tests that follow.
for (const page of [a, b]) {
  await page.bringToFront();
  await page.evaluate(() => {
    const scene = window.glitchburst.game.scene.getScene('game');
    scene.gameOver = false;
    scene.deaths = 0;
    scene.downedFor = 0;
    scene.me.hp = scene.me.maxHp;
    // A finished run stops the host tick for good — in play the next run is a
    // brand new scene. These tests resurrect the run in place, so the tick has
    // to be restarted by hand or everything after this measures a dead horde.
    if (scene.horde) scene.startHostLoop();
    window.glitchburst.room.running = true;
    window.__keepAlive = setInterval(() => { scene.me.hp = scene.me.maxHp; }, 100);
  });
}
await b.waitForTimeout(400);

/* ---------------------------------------------------------------- pause */

const peerPositions = () => b.evaluate(() => {
  const scene = window.glitchburst.game.scene.getScene('game');
  return [...scene.enemies.values()].map((v) => `${Math.round(v.tx)},${Math.round(v.ty)}`).join('|');
});

await a.bringToFront();
await a.click('#btn-pause');
await b.bringToFront();
await b.waitForTimeout(900);

check('host pause reaches the peer', await b.isVisible('#pause-veil'));
check('peer gets no resume control', !(await b.isVisible('#btn-resume')));
check('peer has no pause button at all', !(await b.isVisible('#btn-pause')));

const frozenBefore = await peerPositions();
await b.waitForTimeout(900);
check('the horde is frozen on the peer, not just veiled',
  frozenBefore === (await peerPositions()) && frozenBefore.length > 0);

await a.bringToFront();
await a.click('#btn-pause');
await b.bringToFront();
await b.waitForTimeout(700);
const movingBefore = await peerPositions();
await b.waitForTimeout(700);
check('host resume restarts the peer too',
  !(await b.isVisible('#pause-veil')) && movingBefore !== (await peerPositions()));

/* ------------------------------------------------------------- failover */

const hordeBefore = (await state(b)).hordePublished;
await b.bringToFront();
await a.close(); // ungraceful: fires the Last Will, exactly like a dropped tab

await b.waitForFunction(() => window.glitchburst.room?.isHost === true, null, { timeout: 8000 });
await b.waitForTimeout(1200);
const afterFailover = await state(b);

check('surviving peer is elected host', afterFailover.isHost === true);
check('promoted peer starts running the simulation', afterFailover.runsSimulation === true);
check('promoted peer adopts the horde instead of wiping it',
  afterFailover.enemiesOnScreen >= 5,
  `${afterFailover.enemiesOnScreen} enemies carried through the handover`);
check('promoted peer begins broadcasting',
  afterFailover.hordePublished > hordeBefore,
  `${afterFailover.hordePublished - hordeBefore} snapshots since promotion`);
check('difficulty relaxes back to solo', afterFailover.engineSquad === 1,
  `engine squad ${afterFailover.engineSquad}`);

check('no uncaught errors across both clients', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');

await b.screenshot({ path: 'test/rig/peer-view.png', animations: 'disabled', timeout: 15000 });
await browser.close();
server.close();
finish();
