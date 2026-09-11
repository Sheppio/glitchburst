/**
 * The whole front end, driven by a controller and nothing else.
 *
 * A console or a Steam Deck has no pointer worth using and, more importantly,
 * no keyboard — so "navigable by pad" is not a nicety, it is whether the game
 * is playable at all on those devices. Every step below uses button presses
 * only: no click, no fill, no keypress.
 *
 * `navigator.getGamepads()` is the sole thing `GamepadSource` reads, so a plain
 * object standing in for a pad is a complete and honest fake.
 */
import { buildRig, launch, reporter, startServer } from './rig.mjs';

await buildRig();
const { server, url } = await startServer();
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });

const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.addInitScript(() => {
  window.__pad = {
    id: 'virtual', index: 0, connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    timestamp: 0,
  };
  navigator.getGamepads = () => [window.__pad];
  // Two frames down, two up: the navigator is edge-triggered off a rAF poll,
  // so a press has to survive at least one poll to be seen at all.
  window.__press = async (button) => {
    const set = (pressed) => {
      window.__pad.buttons[button] = { pressed, value: pressed ? 1 : 0 };
      window.__pad.timestamp = performance.now();
    };
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    set(true); await frame();
    set(false); await frame();
  };
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const { check, finish } = reporter('GLITCHBURST — controller only');
const step = async (label, fn) => { const out = await fn(); check(label, out.ok, out.note); return out; };

const BTN = { A: 0, B: 1, MENU: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const press = (button) => page.evaluate((b) => window.__press(b), button);
const focus = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || 'none');
const screen = () => page.evaluate(() => [...document.querySelectorAll('[data-screen]')].find((s) => !s.hidden)?.dataset.screen ?? 'none');
const visible = (id) => page.evaluate((x) => !document.getElementById(x).hidden, id);

/** Press `button` until focus lands on `id`, or give up. */
const focusOn = async (id, button = BTN.DOWN, tries = 25) => {
  for (let i = 0; i < tries; i++) {
    if ((await focus()) === id) return true;
    await press(button);
  }
  return (await focus()) === id;
};

await step('a connected pad puts the ring on the menu', async () => {
  const where = await focus();
  return { ok: where === 'btn-create', note: `ring on ${where}` };
});

await step('every direction moves the ring, even on a single row', async () => {
  // The menu is one row of three. An axis-based wrap resolved "down" to the
  // button already focused, so down did nothing and the menu looked broken.
  const seen = [];
  for (const b of [BTN.DOWN, BTN.DOWN, BTN.UP, BTN.RIGHT, BTN.LEFT]) {
    const from = await focus();
    await press(b);
    seen.push(from !== (await focus()));
  }
  return { ok: seen.every(Boolean), note: `${seen.filter(Boolean).length}/5 presses moved the ring` };
});

await step('A opens a room and lands on character select', async () => {
  await focusOn('btn-create');
  await press(BTN.A);
  const s = await screen();
  return { ok: s === 'class', note: `on ${s}, ring at ${await focus()}` };
});

await step('the on-screen keyboard fills a text field from the pad', async () => {
  // The crux: a controller has no keys, and the callsign and room code are the
  // game's front door. Before this the fields simply could not be filled.
  const reached = await focusOn('input-callsign');
  await press(BTN.A);
  const opened = await visible('keyboard-veil');
  const ringOnKey = (await focus()).includes('key');

  await press(BTN.A);                    // type the focused key
  await press(BTN.RIGHT); await press(BTN.A);
  await press(BTN.DOWN); await press(BTN.A);
  const typed = await page.inputValue('#input-callsign');
  const preview = (await page.textContent('#keyboard-preview'))?.trim();

  await press(BTN.B);                    // B is Done
  const closed = !(await visible('keyboard-veil'));

  return {
    ok: reached && opened && ringOnKey && typed.length === 3 && preview === typed && closed,
    note: opened
      ? `typed "${typed}", preview "${preview}", ring started on ${ringOnKey ? 'a key' : 'the wrong element'}`
      : 'the keyboard never opened',
  };
});

await step('B backs out of the keyboard, not out of the screen behind it', async () => {
  // The back action used to take the first match in the whole document and
  // could reach past an open modal: B on the keyboard walked the player out of
  // character select entirely.
  const s = await screen();
  return { ok: s === 'class', note: `still on ${s}` };
});

await step('deploying reaches the lobby from the pad', async () => {
  await focusOn('btn-deploy');
  await press(BTN.A);
  await page.waitForSelector('#screen-lobby:not([hidden])', { timeout: 15000 });
  const roster = await page.$$eval('.roster-row .roster-name', (n) => n.map((e) => e.textContent));
  return { ok: (await screen()) === 'lobby' && roster.length === 1, note: `roster: ${roster.join(', ')}` };
});

await step('the program cycles in place from the pad', async () => {
  // A native select popup is drawn by the browser chrome, where a pad cannot
  // reach — so the staging area's program picker has to step its options in
  // place. That is also exactly the "cycle through the classes" this control
  // exists to offer.
  const before = await page.evaluate(() => ({
    value: document.getElementById('select-lobby-class').value,
    row: document.querySelector('.roster-class')?.textContent,
  }));

  const reached = await focusOn('select-lobby-class');
  await press(BTN.RIGHT);
  await page.waitForTimeout(200);
  const forward = await page.evaluate(() => ({
    value: document.getElementById('select-lobby-class').value,
    row: document.querySelector('.roster-class')?.textContent,
    card: document.querySelector('.class-card[aria-pressed="true"]')?.dataset.cls,
  }));

  await press(BTN.LEFT);
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => document.getElementById('select-lobby-class').value);

  return {
    ok:
      reached &&
      forward.value !== before.value &&
      forward.row !== before.row &&
      forward.card === forward.value &&
      back === before.value,
    note: reached
      ? `${before.value} → ${forward.value} → ${back}; roster row "${before.row}" → "${forward.row}"`
      : `never reached the picker, ring stuck on ${await focus()}`,
  };
});

await step('a colour can be picked with the pad', async () => {
  const before = await page.evaluate(() => window.glitchburst.room.claimedColour);

  // The swatches carry no id — they are a row of colours, not named controls —
  // so this walks the ring by what is focused rather than by `focusOn`.
  const onSwatch = () => page.evaluate(
    () => document.activeElement?.dataset?.colour ?? null,
  );

  let reached = null;
  for (let i = 0; i < 30 && !reached; i++) {
    await press(BTN.DOWN);
    reached = await onSwatch();
  }
  // Walk along the row to one that is not already selected, or pressing A
  // would re-pick the colour the player already has and prove nothing.
  for (let i = 0; i < 8 && reached === before; i++) {
    await press(BTN.RIGHT);
    reached = await onSwatch();
  }

  await press(BTN.A);
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => ({
    claimed: window.glitchburst.room.claimedColour,
    pressed: document.querySelector('#colour-grid-lobby .colour-swatch[aria-pressed="true"]')
      ?.dataset.colour,
    chassis: window.glitchburst.game?.scene.getScene('game')?.player?.texture?.key ?? null,
  }));

  return {
    ok: Boolean(reached) && reached !== before && after.claimed === reached &&
      after.pressed === reached,
    note: reached
      ? `${before} → ${after.claimed} (swatch ${reached}, ring landed by direction alone)`
      : 'the ring never reached a swatch',
  };
});

await step('down alone reaches every control in the staging area', async () => {
  // The ring is placed by geometry, and geometry has a way of quietly stranding
  // things. A full-width field above a two-button row is directly above both of
  // them; when that was scored by centre distance the nearer centre won by a
  // handful of pixels, and pressing down from the program picker landed on
  // Leave every single time. Start run — the point of the screen — could only
  // be reached by knowing to press left.
  const seen = new Set();
  for (let i = 0; i < 12; i++) {
    await press(BTN.DOWN);
    seen.add(await focus());
  }
  const wanted = ['input-lobby-callsign', 'select-lobby-class', 'btn-start-run', 'btn-lobby-leave'];
  const missed = wanted.filter((id) => !seen.has(id));
  return {
    ok: missed.length === 0,
    note: missed.length ? `never reached: ${missed.join(', ')}` : `all four in ${seen.size} stops`,
  };
});

await step('the host starts the run from the pad', async () => {
  await page.waitForSelector('#btn-start-run:not([hidden])', { timeout: 15000 });
  await focusOn('btn-start-run');
  await press(BTN.A);
  await page.waitForSelector('#screen-hud:not([hidden])', { timeout: 15000 });
  const name = await page.evaluate(() => window.glitchburst.game.scene.getScene('game').me.name);
  return { ok: (await screen()) === 'hud' && name.length === 3, note: `deployed as "${name}"` };
});

await step('Start pauses, and the pause card takes the ring', async () => {
  await page.waitForTimeout(600);
  await press(BTN.MENU);
  await page.waitForTimeout(400);
  const paused = await visible('pause-veil');
  return { ok: paused && (await focus()) === 'btn-resume', note: paused ? `ring on ${await focus()}` : 'did not pause' };
});

await step('the assists are reachable on the pause card', async () => {
  // They used to live on the HUD, where a controller could never reach them.
  const reached = await focusOn('chip-autoaim');
  const row = [await focus()];
  await press(BTN.RIGHT); row.push(await focus());
  await press(BTN.RIGHT); row.push(await focus());

  const before = await page.evaluate(() => window.glitchburst.settings.current.autoMove);
  await press(BTN.A);
  const after = await page.evaluate(() => window.glitchburst.settings.current.autoMove);

  return {
    ok: reached && row.join() === 'chip-autoaim,chip-autofire,chip-automove' && after !== before,
    note: `${row.join(' → ')}; auto-move ${before} → ${after}`,
  };
});

await step('a slider can be moved with the D-pad', async () => {
  // Left/right on a focused range adjusts it instead of walking the ring off
  // it — without this no volume or deadzone is settable from a controller.
  await focusOn('btn-pause-settings');
  await press(BTN.A);
  await page.waitForTimeout(300);
  const onSettings = (await screen()) === 'settings';

  const reached = await focusOn('range-sfxVolume');
  const before = await page.evaluate(() => window.glitchburst.settings.current.sfxVolume);
  await press(BTN.LEFT);
  await press(BTN.LEFT);
  const after = await page.evaluate(() => window.glitchburst.settings.current.sfxVolume);

  return {
    ok: onSettings && reached && after < before,
    note: reached ? `sfx volume ${before} → ${after}` : 'never reached the slider',
  };
});

await step('B returns to the paused match rather than the main menu', async () => {
  await press(BTN.B);
  await page.waitForTimeout(300);
  const s = await screen();
  const stillPaused = await visible('pause-veil');
  return { ok: s === 'hud' && stillPaused, note: `${s}, pause veil ${stillPaused ? 'still up' : 'gone'}` };
});

await step('Start resumes instead of going fullscreen', async () => {
  // Pause and menu navigation both read Start. They used to share one edge
  // latch, so whichever polled first that frame won and the other saw nothing.
  await press(BTN.MENU);
  await page.waitForTimeout(400);
  return { ok: !(await visible('pause-veil')), note: 'resumed from the pad' };
});

await step('no uncaught errors', async () => ({ ok: errors.length === 0, note: errors.slice(0, 3).join(' | ') || 'clean' }));

await browser.close();
server.close();
finish();
