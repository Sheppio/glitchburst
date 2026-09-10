import { buildRig, launch, reporter, startServer } from './rig.mjs';

await buildRig();
const { server, url } = await startServer();
const browser = await launch({ uncapped: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(url, { waitUntil: 'networkidle' });

const { check, finish } = reporter('GLITCHBURST — single client');

const step = async (label, fn) => {
  const out = await fn();
  check(label, out.ok, out.note);
  return out;
};

await step('menu screen renders', async () => {
  const visible = await page.isVisible('#screen-menu');
  const title = await page.textContent('.brand-title');
  return { ok: visible && title.includes('GLITCH'), note: title?.trim() };
});

await step('class cards built from CLASSES table', async () => {
  const names = await page.$$eval('.class-card .class-name', (n) => n.map((e) => e.textContent));
  return { ok: names.length === 4, note: names.join(', ') };
});

await step('settings toggles render', async () => {
  await page.click('#btn-settings');
  const count = await page.$$eval('.toggle', (n) => n.length);
  await page.click('#btn-settings-back');
  return { ok: count === 5, note: `${count} toggles` };
});

await step('the callsign and class are remembered across a reload', async () => {
  await page.click('#btn-create');
  await page.fill('#input-callsign', 'PERSIST');
  await page.click('.class-card[data-cls="encoder"]');
  // A clean navigation, not a reload: creating a room rewrites the URL with a
  // ?room= param, which would land the reload on the join screen instead.
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.click('#btn-create');
  const restored = await page.inputValue('#input-callsign');
  const cls = await page.getAttribute('.class-card[data-cls="encoder"]', 'aria-pressed');
  // Hand the next step a clean menu rather than the class screen.
  await page.click('#btn-class-back');
  return { ok: restored === 'PERSIST' && cls === 'true', note: `restored "${restored}" as Encoder` };
});

await step('create room generates a code', async () => {
  await page.click('#btn-create');
  const code = (await page.textContent('#room-code-label'))?.trim();
  return { ok: /^[A-Z0-9]{4}$/.test(code ?? ''), note: code };
});

await step('deploy boots Phaser and enters the HUD', async () => {
  await page.fill('#input-callsign', 'NEO');
  await page.click('.class-card[data-cls="fireman"]');
  await page.click('#btn-deploy');
  await page.waitForSelector('#screen-hud:not([hidden])', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#game-root canvas') !== null, null, { timeout: 10000 });
  const size = await page.$eval('#game-root canvas', (c) => `${c.width}x${c.height}`);
  return { ok: true, note: `canvas ${size}` };
});

// The test player never moves, so a wave of eleven will eventually corner and
// kill it — and a downed player cannot fire or use abilities, which would make
// the two combat assertions below flaky for reasons unrelated to what they
// test. Keep it topped up: a real player would be dodging.
await page.evaluate(() => {
  const scene = window.glitchburst.game.scene.getScene('game');
  window.__keepAlive = setInterval(() => { scene.me.hp = scene.me.maxHp; }, 100);
});

await step('client wins election and becomes host', async () => {
  await page.waitForFunction(() => window.glitchburst?.room?.isHost === true, null, { timeout: 6000 });
  const host = await page.textContent('#hud-host');
  return { ok: host?.includes('THIS CLIENT'), note: host?.trim() };
});

// Let a few waves run so the horde is populated and batching is exercised.
await page.waitForTimeout(11000);

const wire = await step('host batches the whole horde into one message', async () => {
  const stats = await page.evaluate(() => {
    const horde = window.__published.filter((m) => m.topic.endsWith('/horde/positions'));
    const last = horde[horde.length - 1];
    const window_ = window.__published.filter((m) => m.t > performance.now() - 2000 && m.topic.endsWith('/horde/positions'));
    return {
      messages: horde.length,
      hz: window_.length / 2,
      bytes: last ? last.payload.length : 0,
      records: last ? last.payload.split(';').filter(Boolean).length : 0,
      sample: last ? last.payload.split(';').slice(0, 3).join(';') : '',
    };
  });
  return {
    ok: stats.messages > 0 && stats.records > 0,
    note: `${stats.messages} msgs, ~${stats.hz.toFixed(0)}Hz, ${stats.records} enemies in ${stats.bytes}B → "${stats.sample}"`,
  };
});

await step('broadcast rate is capped near 20Hz', async () => {
  const hz = Number(wire.note.match(/~(\d+)Hz/)?.[1] ?? 0);
  return { ok: hz >= 16 && hz <= 24, note: `${hz}Hz (target 20)` };
});

await step('enemy cap of 100 is respected', async () => {
  const max = await page.evaluate(() =>
    Math.max(...window.__published.filter((m) => m.topic.endsWith('/horde/positions')).map((m) => m.payload.split(';').filter(Boolean).length)),
  );
  return { ok: max <= 100, note: `peak ${max} enemies` };
});

await step('enemies are alive on screen and the HUD tracks them', async () => {
  const enemies = Number(await page.textContent('#hud-enemies'));
  const wave = Number(await page.textContent('#hud-wave'));
  return { ok: enemies > 0 && wave > 0, note: `wave ${wave}, ${enemies} hostiles` };
});

await step('player state is published on its own topic', async () => {
  const topics = await page.evaluate(() => [...new Set(window.__published.map((m) => m.topic))]);
  const player = topics.find((t) => t.includes('/player/') && t.endsWith('/state'));
  return { ok: Boolean(player), note: player };
});

await step('firing produces damage reports (attacker authority)', async () => {
  // Auto-fire + auto-aim removes any need to simulate a mouse.
  await page.evaluate(() => {
    window.glitchburst.settings.set('autoFire', true);
    window.glitchburst.settings.set('autoAim', true);
  });
  // The Fireman's EMP shotgun is short-ranged by design, so wait for the horde
  // to actually close the distance rather than assuming an instant kill.
  await page.waitForFunction(() => Number(document.getElementById('hud-score').textContent) > 0,
    null, { timeout: 25000 }).catch(() => {});
  const stats = await page.evaluate(() => {
    const scene = window.glitchburst.game.scene.getScene('game');
    return {
      hud: Number(document.getElementById('hud-score').textContent),
      real: scene.score,
      bullets: scene.bullets.size,
    };
  });
  return {
    ok: stats.real > 0 && stats.bullets > 0 && stats.hud === stats.real,
    note: `score ${stats.real} (HUD shows ${stats.hud}), ${stats.bullets} pooled rounds`,
  };
});

await step('ability fields reach the wire', async () => {
  const before = await page.evaluate(() => window.__published.filter((m) => m.topic.endsWith('/ability')).length);
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__published.filter((m) => m.topic.endsWith('/ability')).length);
  return { ok: after > before, note: `${after - before} ability broadcast` };
});

// The host's authoritative tick must not be a function of its own framerate.
// A host on a weak GPU or a throttled tab would otherwise broadcast slowly and
// simulate in huge steps, degrading the game for every peer in the room.
await step('broadcast rate survives a starved renderer', async () => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 10 });

  const measure = await page.evaluate(async () => {
    const count = () => window.__published.filter((m) => m.topic.endsWith('/horde/positions')).length;
    const before = count();
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 3000));
    const seconds = (performance.now() - t0) / 1000;
    return { hz: (count() - before) / seconds, fps: window.glitchburst.game.loop.actualFps };
  });

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  return {
    ok: measure.hz >= 14,
    note: `${measure.hz.toFixed(1)}Hz broadcast while rendering at ${measure.fps.toFixed(0)}fps`,
  };
});

await step('killed enemies drop chips', async () => {
  const dropped = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    const before = scene.progression.chips.items.filter((c) => c.active).length;
    const banked = scene.progression.progress.totalChips;

    // Kill enemies well away from the player, or the magnet collects the chips
    // inside the sampling window and the floor looks empty.
    const farX = scene.me.x > 1200 ? 220 : 2180;
    const farY = scene.me.y > 800 ? 220 : 1380;
    const ids = [...scene.horde.enemies.keys()].slice(0, 3);
    for (const id of ids) {
      const enemy = scene.horde.enemies.get(id);
      enemy.x = farX;
      enemy.y = farY;
      scene.horde.reportDamage(id, 99999, 'test');
    }
    await new Promise((r) => setTimeout(r, 500));
    return {
      before,
      after: scene.progression.chips.items.filter((c) => c.active).length,
      killed: ids.length,
      collected: scene.progression.progress.totalChips - banked,
    };
  });
  return {
    ok: dropped.after > dropped.before,
    note: `${dropped.killed} kills left ${dropped.after - dropped.before} chips lying at range`,
  };
});

await step('chips are drawn to the player and collected', async () => {
  const result = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    const chip = scene.progression.chips.items.find((c) => c.active);
    if (!chip) return { ok: false, why: 'no chip on the floor' };
    // Drop one just outside the pickup radius but inside the magnet radius.
    chip.x = scene.me.x + 120;
    chip.y = scene.me.y;
    chip.vx = 0;
    chip.vy = 0;
    chip.ttl = 20;
    const banked = scene.progression.progress.totalChips;

    // Poll, for the same reason as the point-blank test: a fixed wall-clock
    // sleep measures the renderer, not the game, once dt clamping kicks in.
    const start = performance.now();
    while (performance.now() - start < 2500 && scene.progression.progress.totalChips === banked) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      ok: scene.progression.progress.totalChips > banked,
      ms: Math.round(performance.now() - start),
      why: 'never collected',
    };
  });
  return { ok: result.ok, note: result.ok ? `magnetised and banked in ${result.ms}ms` : result.why };
});

await step('a chip cannot be outrun', async () => {
  const out = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');

    // Drop a chip behind the player, then sprint directly away from it faster
    // than any class can actually move. Constant acceleration has to win.
    const away = scene.me.y > 800 ? -1 : 1;
    scene.progression.spawnChips(scene.me.x, scene.me.y - away * 150, 1, 'outrun-probe');

    const banked = scene.progression.progress.totalChips;
    const runSpeed = 320; // above every class's top speed
    const start = performance.now();

    while (performance.now() - start < 2500 && scene.progression.progress.totalChips === banked) {
      await new Promise((r) => requestAnimationFrame(r));
      scene.me.y = Math.max(40, Math.min(1560, scene.me.y + (away * runSpeed) / 60));
    }

    return {
      collected: scene.progression.progress.totalChips > banked,
      ms: Math.round(performance.now() - start),
    };
  });
  return {
    ok: out.collected && out.ms < 2000,
    note: out.collected ? `caught the fleeing player in ${out.ms}ms` : 'chip was outrun',
  };
});

await step('a point-blank enemy is still hittable', async () => {
  const out = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    const view = [...scene.enemies.values()][0];
    if (!view) return { ok: false, why: 'no enemy' };

    // Move the simulated entity, not the view: on the host every view position
    // is rewritten from the engine on the next 20Hz tick, so nudging the sprite
    // alone would be undone before the next frame.
    const entity = scene.horde.enemies.get(view.id);
    if (!entity) return { ok: false, why: 'enemy not in the simulation' };
    entity.x = scene.me.x + 2;
    entity.y = scene.me.y + 2;
    const before = entity.hp;

    // Pin the aim to this enemy. Auto-aim now chooses by time-to-kill and may
    // quite correctly prefer something else, but what is under test here is
    // whether a contact-range target *can* be hit at all.
    const restore = scene.cfg.input.aimAssist;
    scene.cfg.input.aimAssist = () => ({ x: entity.x, y: entity.y });

    // Poll rather than sleep. The scene clamps dt to 50ms a frame, so on a slow
    // renderer wall time and simulated time diverge badly — at 11fps a 900ms
    // sleep is barely 500ms of game time, which is less than one Fireman fire
    // interval. The test would then be asserting on a window in which the
    // player never fired.
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) {
      const live = scene.horde.enemies.get(view.id);
      if (!live || live.hp < before) break;
      await new Promise((r) => requestAnimationFrame(r));
      // Hold it in place; a drone's AI backs away from anything this close.
      if (live) {
        live.x = scene.me.x + 2;
        live.y = scene.me.y + 2;
      }
    }
    scene.cfg.input.aimAssist = restore;
    const survivor = scene.horde.enemies.get(view.id);
    return { ok: !survivor || survivor.hp < before, why: `hp stayed at ${before}` };
  });
  return { ok: out.ok, note: out.ok ? 'took damage at contact range' : out.why };
});

await step('a full set of chips converts into a power-up', async () => {
  const out = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    const need = scene.progression.progress.chips;
    const perSet = window.glitchburst.game.registry.get('chipsPerPowerUp') ?? 10;
    for (let i = 0; i < perSet - need; i++) scene.progression.collectChip();
    await new Promise((r) => setTimeout(r, 300));
    return {
      powerUps: scene.progression.powerUps.items.filter((p) => p.active).length,
      chips: scene.progression.progress.chips,
    };
  });
  return { ok: out.powerUps > 0, note: `${out.powerUps} power-up spawned, counter back to ${out.chips}` };
});

await step('collecting a power-up upgrades the player', async () => {
  const out = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    const powerUp = scene.progression.powerUps.items.find((p) => p.active);
    if (!powerUp) return { ok: false, why: 'no power-up present' };
    const before = { ...scene.progression.progress.stacks };
    const dmg = scene.progression.progress.damageMultiplier;
    const spd = scene.progression.progress.speedMultiplier;
    const rof = scene.progression.progress.fireIntervalMultiplier;
    // Walk it onto the player.
    powerUp.x = scene.me.x;
    powerUp.y = scene.me.y;
    await new Promise((r) => setTimeout(r, 300));
    const after = scene.progression.progress.stacks;
    const gained = Object.keys(after).find((k) => after[k] > before[k]);
    const changed =
      scene.progression.progress.damageMultiplier !== dmg ||
      scene.progression.progress.speedMultiplier !== spd ||
      scene.progression.progress.fireIntervalMultiplier !== rof;
    return { ok: Boolean(gained) && changed, why: gained ?? 'no stack gained', gained };
  });
  return { ok: out.ok, note: out.ok ? `gained a ${out.gained} stack` : out.why };
});

await step('the player turns at a limited rate instead of snapping', async () => {
  const out = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    scene.me.angle = 0;
    // Ask for a half turn and sample how the chassis gets there.
    scene.cfg.input.aimAssist = () => ({ x: scene.me.x - 500, y: scene.me.y });
    window.glitchburst.settings.set('autoAim', true);
    const samples = [];
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      samples.push(scene.me.angle);
    }
    return { first: samples[0], samples };
  });
  // A snap would put the very first sample at the target; a rate limit walks it.
  return {
    ok: Math.abs(out.first) > 0 && Math.abs(out.first) < Math.PI - 0.01,
    note: `first frame moved to ${((out.first * 180) / Math.PI).toFixed(0)} degrees, not 180`,
  };
});

const positions = () => page.evaluate(() => {
  const scene = window.glitchburst.game.scene.getScene('game');
  return [...scene.enemies.values()].map((v) => `${Math.round(v.sprite.x)},${Math.round(v.sprite.y)}`).join('|');
});

await step('host can pause the whole room', async () => {
  await page.click('#btn-pause');
  await page.waitForTimeout(400);
  const before = await positions();
  await page.waitForTimeout(900);
  const after = await positions();
  const veiled = await page.isVisible('#pause-veil');
  return { ok: veiled && before === after && before.length > 0, note: veiled ? 'horde frozen behind the veil' : 'no veil' };
});

await step('resuming restarts the simulation', async () => {
  await page.click('#btn-resume');
  await page.waitForTimeout(150);
  const before = await positions();
  await page.waitForTimeout(700);
  const after = await positions();
  return { ok: before !== after && !(await page.isVisible('#pause-veil')), note: 'horde moving again' };
});

await step('no uncaught errors', async () => ({ ok: errors.length === 0, note: errors.slice(0, 4).join(' | ') || 'clean' }));

await page.screenshot({ path: 'test/rig/gameplay.png', animations: 'disabled', timeout: 15000 });
await browser.close();
server.close();
finish();
