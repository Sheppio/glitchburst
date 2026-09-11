/**
 * Android touch pass.
 *
 * The front end is a DOM overlay and the on-screen sticks are a full-screen
 * fixed layer, so their stacking order decides whether the menu is usable at
 * all. This suite taps through the whole flow on an emulated phone with a
 * touchscreen and no mouse — the exact configuration where a stray overlay
 * silently swallows every tap while still looking perfectly fine.
 */
import { devices } from 'playwright';
import { buildRig, launch, reporter, startServer } from './rig.mjs';

await buildRig();
const { server, url } = await startServer(8101);
const browser = await launch();

const phone = devices['Pixel 7'] ?? devices['Pixel 5'];
const ctx = await browser.newContext({ ...phone, hasTouch: true, isMobile: true });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(url, { waitUntil: 'networkidle' });

const { check, finish } = reporter('GLITCHBURST — Android touch');

check('device reports a coarse pointer', await page.evaluate(() => matchMedia('(pointer: coarse)').matches));

check('assists default on for touch', await page.evaluate(() => {
  const s = window.glitchburst.settings.current;
  return s.autoAim && s.autoFire && s.forceTouchControls;
}), 'auto-aim + auto-fire + on-screen sticks');

// The regression this suite exists for: the stick overlay must not be on
// screen before a match, and nothing may cover the menu buttons.
check('no overlay covers the menu', await page.evaluate(() => {
  const layer = document.querySelector('.touch-layer');
  return !layer || layer.hidden;
}), 'touch layer hidden on the front end');

check('the topmost element at the Create button is the button', await page.evaluate(() => {
  const btn = document.getElementById('btn-create');
  const r = btn.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return btn.contains(hit) || hit === btn;
}));

// Now actually tap through, using real touch events rather than synthetic clicks.
await page.tap('#btn-create');
const code = (await page.textContent('#room-code-label'))?.trim() ?? '';
check('tapping Create opens character select', await page.isVisible('#screen-class'), `room ${code}`);

await page.tap('.class-card[data-cls="glitcher"]');
check('tapping a class card selects it',
  (await page.getAttribute('.class-card[data-cls="glitcher"]', 'aria-pressed')) === 'true');

await page.tap('#btn-deploy');
await page.waitForSelector('#screen-lobby:not([hidden])', { timeout: 15000 });
check('tapping Deploy reaches the lobby', true);

// The host still has to start the run, and the button only appears once the
// election settles.
await page.waitForSelector('#btn-start-run:not([hidden])', { timeout: 15000 });
await page.tap('#btn-start-run');
await page.waitForSelector('#screen-hud:not([hidden])', { timeout: 15000 });
check('tapping Start begins the match', true);

await page.waitForTimeout(1200);

check('the stick overlay appears once in game', await page.evaluate(() => {
  const layer = document.querySelector('.touch-layer');
  return layer !== null && !layer.hidden;
}));

check('in-game HUD controls stay tappable above the sticks', await page.evaluate(() => {
  const btn = document.getElementById('btn-leave');
  const r = btn.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return btn.contains(hit) || hit === btn;
}), 'Leave is not buried by the touch layer');

// The ability button lives *inside* the touch layer, so lowering that layer
// beneath the UI must not have buried it behind the HUD.
check('the on-screen ability button is hittable', await page.evaluate(() => {
  const btn = document.querySelector('.touch-ability');
  if (!btn) return false;
  const r = btn.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return btn.contains(hit) || hit === btn;
}));

// Drag the movement half and confirm the character actually moves.
const box = page.viewportSize();
const before = await page.evaluate(() => {
  const s = window.glitchburst.game.scene.getScene('game');
  return { x: s.me.x, y: s.me.y };
});
await page.touchscreen.tap(box.width * 0.25, box.height * 0.7);
await page.mouse.move(0, 0);
await page.evaluate(async ({ w, h }) => {
  const layer = document.querySelector('.touch-layer');
  const send = (type, x, y) => layer.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
  send('pointerdown', w * 0.25, h * 0.7);
  for (let i = 1; i <= 12; i++) send('pointermove', w * 0.25, h * 0.7 - i * 6);
  await new Promise((r) => setTimeout(r, 700));
  send('pointerup', w * 0.25, h * 0.7 - 72);
}, { w: box.width, h: box.height });

const after = await page.evaluate(() => {
  const s = window.glitchburst.game.scene.getScene('game');
  return { x: s.me.x, y: s.me.y };
});
check('the virtual stick moves the player',
  Math.hypot(after.x - before.x, after.y - before.y) > 20,
  `moved ${Math.hypot(after.x - before.x, after.y - before.y).toFixed(0)}px`);

check('leaving the match hides the sticks again', await (async () => {
  await page.tap('#btn-leave');
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const layer = document.querySelector('.touch-layer');
    return !layer || layer.hidden;
  });
})());

check('back on the menu, the buttons are hittable again', await page.evaluate(() => {
  const btn = document.getElementById('btn-create');
  const r = btn.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return btn.contains(hit) || hit === btn;
}));

check('no uncaught errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');

await page.screenshot({ path: 'test/rig/mobile.png', animations: 'disabled', timeout: 15000 });
await browser.close();
server.close();
finish();
