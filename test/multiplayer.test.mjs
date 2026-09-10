/**
 * Two live clients in one room, sharing a loopback broker across tabs.
 * Exercises host election, batched broadcast, peer unpacking, mid-game join
 * and host failover — the parts of the architecture that only exist when more
 * than one client is present.
 */
import { buildRig, launch, reporter, startServer } from './rig.mjs';

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
await a.waitForSelector('#screen-hud:not([hidden])');
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
await b.waitForSelector('#screen-hud:not([hidden])');
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
    remote: scene.remoteBullets.filter((x) => x.active).length,
    own: scene.bullets.filter((x) => x.active).length,
  };
});
check("a peer sees the host's bullets", seen.remote > 0,
  `${seen.remote} remote rounds on screen`);
check('and does not confuse them for its own', seen.own === 0);

check('remote bullets are inert (attacker authority)', await b.evaluate(() => {
  const scene = window.glitchburst.game.scene.getScene('game');
  return scene.remoteBullets.every((x) => x.damage === 0);
}), 'zero damage, never collide');

check('shots are batched, not one message per pellet', await a.evaluate(() => {
  const shots = window.__published.filter((m) => m.topic.endsWith('/shots'));
  if (!shots.length) return false;
  // Every message is a batch of "x,y,angle;" records for a whole publish tick.
  return shots.every((m) => /^(-?\d+,-?\d+,-?\d+;)+$/.test(m.payload));
}), `${await a.evaluate(() => window.__published.filter((m) => m.topic.endsWith('/shots')).length)} shot batches`);

await a.evaluate(() => window.glitchburst.settings.set('autoFire', false));

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
