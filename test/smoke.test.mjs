import { buildRig, launch, reporter, startServer } from './rig.mjs';
import { UPGRADE_ORDER } from '../dist/sim/progression.js';
import { LIVES, WORLD } from '../dist/config.js';

/**
 * The observable effect of each upgrade.
 *
 * Checked against `UPGRADE_ORDER` below rather than assumed, because the
 * previous version of this test listed three effects by hand and a fourth
 * upgrade had since been added: whenever the roll landed on the unlisted one it
 * failed, and the rest of the time it silently stopped testing anything.
 */
const EFFECT_OF = {
  damage: 'damageMultiplier',
  speed: 'speedMultiplier',
  firerate: 'fireIntervalMultiplier',
  regen: 'bonusRegenPerSec',
};

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

await step('the menu shows the build version', async () => {
  const shown = (await page.textContent('#version-label'))?.trim() ?? '';
  const runtime = await page.evaluate(() => window.glitchburst.version);
  return {
    ok: /^v\d+\.\d+\.\d+$/.test(shown) && shown === `v${runtime}`,
    note: shown,
  };
});

await step('class cards built from CLASSES table', async () => {
  const names = await page.$$eval('.class-card .class-name', (n) => n.map((e) => e.textContent));
  return { ok: names.length === 4, note: names.join(', ') };
});

await step('settings toggles render', async () => {
  await page.click('#btn-settings');
  // Assert the ones that matter by name rather than pinning a count, which
  // breaks every time a setting is added and tells you nothing when it does.
  const keys = await page.$$eval('.toggle', (n) => n.map((e) => e.dataset.key));
  await page.click('#btn-settings-back');
  const required = ['autoFire', 'autoAim'];
  return {
    ok: required.every((k) => keys.includes(k)),
    note: `${keys.length} toggles: ${keys.join(', ')}`,
  };
});

await step('audio levels are sliders, not switches', async () => {
  await page.click('#btn-settings');
  const rows = await page.$$eval('.slider-row', (n) =>
    n.map((e) => {
      const input = e.querySelector('input[type="range"]');
      return { key: e.dataset.key, min: Number(input.min), max: Number(input.max) };
    }),
  );
  await page.click('#btn-settings-back');

  const sfx = rows.find((r) => r.key === 'sfxVolume');
  const music = rows.find((r) => r.key === 'musicVolume');
  return {
    ok: Boolean(sfx && music) && sfx.min === 0 && sfx.max === 1 && music.min === 0 && music.max === 1,
    note: rows.map((r) => `${r.key} ${r.min}–${r.max}`).join(', ') || 'no sliders found',
  };
});

await step('a volume slider moves the gain it controls', async () => {
  const out = await page.evaluate(async () => {
    const { audio, settings } = window.glitchburst;
    audio.unlock();
    await new Promise((r) => setTimeout(r, 120));

    // Drive the DOM control, not the store: this is the wiring under test.
    const set = async (value) => {
      const el = document.getElementById('range-sfxVolume');
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 140));
      return audio.destination('sfx')?.gain.value ?? null;
    };

    document.getElementById('btn-settings').click();
    const full = await set(1);
    const half = await set(0.5);
    const readout = document.querySelector('.slider-row[data-key="sfxVolume"] [data-value]').textContent;
    const zero = await set(0);
    const mutedLabel = document.querySelector('.slider-row[data-key="sfxVolume"] [data-value]').textContent;
    await set(1);
    document.getElementById('btn-settings-back').click();

    return { full, half, zero, readout, mutedLabel, stored: settings.current.sfxVolume };
  });

  // Zero detaches the channel entirely rather than scaling it to nothing, so
  // a muted game builds no oscillators at all.
  return {
    ok: out.full > out.half && out.half > 0 && out.zero === null && out.mutedLabel === 'MUTED',
    note: `100% → ${out.full?.toFixed(3)}, 50% → ${out.half?.toFixed(3)} (${out.readout}), 0% → detached`,
  };
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

await step('every setting survives a reload', async () => {
  // One toggle and both sliders, so the assertion covers the boolean path and
  // the numeric one — the numbers are the new risk, since they are clamped and
  // migrated on the way back in.
  await page.evaluate(() => {
    const { settings } = window.glitchburst;
    settings.set('southpaw', true);
    settings.set('sfxVolume', 0.35);
    settings.set('musicVolume', 0);
  });
  await page.goto(url, { waitUntil: 'networkidle' });

  const out = await page.evaluate(() => {
    const s = window.glitchburst.settings.current;
    document.getElementById('btn-settings').click();
    const value = (key) =>
      Number(document.querySelector(`.slider-row[data-key="${key}"] input`).value);
    const readout = document.querySelector('.slider-row[data-key="musicVolume"] [data-value]').textContent;
    document.getElementById('btn-settings-back').click();
    return { stored: s, sliderSfx: value('sfxVolume'), sliderMusic: value('musicVolume'), readout };
  });

  // Restore, so the rest of the run is not played on a muted, southpaw client.
  await page.evaluate(() => {
    const { settings } = window.glitchburst;
    settings.set('southpaw', false);
    settings.set('sfxVolume', 1);
    settings.set('musicVolume', 1);
  });

  const ok =
    out.stored.southpaw === true &&
    out.stored.sfxVolume === 0.35 &&
    out.stored.musicVolume === 0 &&
    // The controls have to show the restored values, not just hold them.
    out.sliderSfx === 0.35 &&
    out.sliderMusic === 0 &&
    out.readout === 'MUTED';
  return { ok, note: `sfx ${out.sliderSfx}, music ${out.sliderMusic} (${out.readout}), southpaw ${out.stored.southpaw}` };
});

await step('legacy on/off audio settings migrate to levels', async () => {
  // Anyone who played before this build has booleans in storage. Reading one as
  // a volume would mute them silently, which is the worst kind of regression:
  // it looks like broken audio, not like a setting.
  await page.evaluate(() => {
    localStorage.setItem(
      'glitchburst.input.v1',
      JSON.stringify({ sfx: true, music: false, southpaw: true, deadzone: 0.3 }),
    );
  });
  await page.goto(url, { waitUntil: 'networkidle' });

  const s = await page.evaluate(() => window.glitchburst.settings.current);
  await page.evaluate(() => {
    window.glitchburst.settings.set('southpaw', false);
    window.glitchburst.settings.set('musicVolume', 1);
    window.glitchburst.settings.set('deadzone', 0.15);
  });

  return {
    ok: s.sfxVolume === 1 && s.musicVolume === 0 && s.southpaw === true && s.deadzone === 0.3 && !('sfx' in s),
    note: `sfx:true → ${s.sfxVolume}, music:false → ${s.musicVolume}, unrelated settings kept`,
  };
});

await step('out-of-range stored values are clamped, not trusted', async () => {
  await page.evaluate(() => {
    localStorage.setItem(
      'glitchburst.input.v1',
      JSON.stringify({ sfxVolume: 9, musicVolume: -3, deadzone: 'nonsense' }),
    );
  });
  await page.goto(url, { waitUntil: 'networkidle' });

  const s = await page.evaluate(() => window.glitchburst.settings.current);
  await page.evaluate(() => localStorage.removeItem('glitchburst.input.v1'));
  await page.goto(url, { waitUntil: 'networkidle' });

  return {
    ok: s.sfxVolume === 1 && s.musicVolume === 0 && s.deadzone === 0.15 && Number.isFinite(s.deadzone),
    note: `9 → ${s.sfxVolume}, -3 → ${s.musicVolume}, "nonsense" → ${s.deadzone}`,
  };
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

await step('every enemy kind has a texture at every level', async () => {
  // A missing texture key is a silent failure in Phaser — it renders a green
  // placeholder box rather than throwing — so this is checked explicitly.
  const out = await page.evaluate(() => {
    const scene = window.glitchburst.game.scene.getScene('game');
    const missing = [];
    for (let kind = 0; kind < 6; kind++) {
      for (let level = 1; level <= 7; level++) {
        const key = `tex-enemy-${kind}-${level}`;
        if (!scene.textures.exists(key)) missing.push(key);
      }
    }
    // The pip has to actually differ between levels, or 42 textures is 42
    // copies of the same picture.
    const pixel = (key) => {
      const src = scene.textures.get(key).getSourceImage();
      const canvas = document.createElement('canvas');
      canvas.width = src.width;
      canvas.height = src.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(src, 0, 0);
      const d = ctx.getImageData(Math.floor(src.width / 2), Math.floor(src.height / 2), 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    };
    const centres = Array.from({ length: 7 }, (_, i) => pixel(`tex-enemy-0-${i + 1}`));
    return { missing, centres, distinct: new Set(centres).size };
  });

  return {
    ok: out.missing.length === 0 && out.distinct === 7,
    note: out.missing.length
      ? `missing ${out.missing.slice(0, 3).join(', ')}`
      : `42 textures, ${out.distinct} distinct pip colours: ${out.centres.join(' ')}`,
  };
});

await step('auto-move drives the client with no input at all', async () => {
  const out = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    const { settings } = window.glitchburst;

    const before = { autoMove: settings.current.autoMove };

    // Park the player well off-centre first. This step runs before the horde
    // has spawned, and with nothing to fight or collect the autopilot drifts to
    // the middle of the arena and then deliberately stops — so starting near
    // the centre measures nothing and fails about one run in three.
    scene.me.x = 400;
    scene.me.y = 400;

    // Measured as a difference over the same wall-clock window rather than as a
    // raw pixel count: distance per frame depends on the frame rate, and this
    // suite deliberately runs the renderer starved.
    const travelFor = async (ms) => {
      const from = { x: scene.me.x, y: scene.me.y };
      let total = 0;
      let last = from;
      const until = performance.now() + ms;
      while (performance.now() < until) {
        await new Promise((r) => requestAnimationFrame(r));
        total += Math.hypot(scene.me.x - last.x, scene.me.y - last.y);
        last = { x: scene.me.x, y: scene.me.y };
      }
      return total;
    };

    settings.set('autoMove', false);
    const parkedTravel = await travelFor(900);

    settings.set('autoMove', true);
    const start = { x: scene.me.x, y: scene.me.y };
    const travelled = await travelFor(900);
    const enemies = scene.enemies.size;

    // Real input has to win, or a human cannot take a self-driving client back
    // without first going to the settings screen.
    scene.cfg.input.moveAssist = () => ({ x: 1, y: 0, ability: false });
    const held = { x: scene.me.x, y: scene.me.y };
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    const drivenRight = scene.me.x > held.x;

    settings.set('autoMove', before.autoMove);
    const parked = { x: scene.me.x, y: scene.me.y };
    for (let i = 0; i < 10; i++) await new Promise((r) => requestAnimationFrame(r));
    const stillAfterOff = Math.hypot(scene.me.x - parked.x, scene.me.y - parked.y);

    return {
      travelled,
      parkedTravel,
      enemies,
      net: Math.hypot(scene.me.x - start.x, scene.me.y - start.y),
      drivenRight,
      stillAfterOff,
      finite: Number.isFinite(scene.me.x) && Number.isFinite(scene.me.y),
    };
  });

  return {
    ok:
      out.parkedTravel < 1 &&
      out.travelled > 20 &&
      out.drivenRight &&
      out.stillAfterOff < 2 &&
      out.finite,
    note: `${out.parkedTravel.toFixed(0)}px parked → ${out.travelled.toFixed(0)}px self-driving over the same window (${out.enemies} hostiles), ${out.stillAfterOff.toFixed(1)}px once off`,
  };
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

await step('bullets fade out at the end of their range', async () => {
  const out = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');

    // Drive a round directly rather than firing one. Auto-fire was the obvious
    // approach and is unusable here: at the arena centre the player is
    // surrounded, so every pellet connects and retires on the frame it is
    // fired, and at the edge they spawn out of bounds. Neither says anything
    // about fading.
    const bullet = scene.bullets.acquire();
    Object.assign(bullet, {
      x: 60, y: 60, vx: 0, vy: 0, maxLife: 3, life: 3,
      damage: 0, pierce: 999, radius: 1, knockback: 0, active: true,
    });
    bullet.hit.clear();
    bullet.sprite.setVisible(true).setAlpha(1);

    await new Promise((r) => requestAnimationFrame(r));
    const fresh = bullet.sprite.alpha;

    bullet.life = 0.2;
    await new Promise((r) => requestAnimationFrame(r));
    const expiring = bullet.sprite.alpha;

    bullet.active = false;
    bullet.sprite.setVisible(false);
    return { fresh, expiring };
  });
  return {
    ok: out.fresh > 0.95 && out.expiring < 0.4 && out.expiring > 0,
    note: `alpha ${out.fresh.toFixed(2)} fresh, ${out.expiring.toFixed(2)} expiring`,
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
  const unmapped = UPGRADE_ORDER.filter((id) => !EFFECT_OF[id]);
  if (unmapped.length) return { ok: false, note: `this test has no effect mapped for ${unmapped.join(', ')}` };

  const out = await page.evaluate(async (effectOf) => {
    const scene = window.glitchburst.game.scene.getScene('game');
    const powerUp = scene.progression.powerUps.items.find((p) => p.active);
    if (!powerUp) return { ok: false, why: 'no power-up present' };

    const read = () => {
      const p = scene.progression.progress;
      const out = { stacks: { ...p.stacks } };
      for (const effect of Object.values(effectOf)) out[effect] = p[effect];
      return out;
    };

    const before = read();
    // Walk it onto the player.
    powerUp.x = scene.me.x;
    powerUp.y = scene.me.y;
    await new Promise((r) => setTimeout(r, 300));
    const after = read();

    const gained = Object.keys(after.stacks).find((k) => after.stacks[k] > before.stacks[k]);
    // A power-up is three sprites — crystal, orbit and shadow. They have to
    // leave play together, or collecting one strands its ring on the floor.
    const stranded = scene.progression.powerUps.items.some(
      (p) => !p.active && (p.sprite.visible || p.orbit.visible || p.shadow.visible),
    );
    // The stack has to move the thing it claims to: a counter that goes up
    // without changing the player is exactly the bug worth catching.
    const effect = gained ? effectOf[gained] : null;
    const applied = Boolean(effect) && after[effect] !== before[effect];

    return {
      ok: Boolean(gained) && applied && !stranded,
      why: stranded
        ? 'collected power-up left sprites on screen'
        : !gained
          ? 'no stack gained'
          : `${gained} stack gained but ${effect} did not move`,
      gained,
      effect,
      value: effect ? after[effect] : null,
    };
  }, EFFECT_OF);

  return { ok: out.ok, note: out.ok ? `gained a ${out.gained} stack — ${out.effect} now ${out.value}` : out.why };
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

await step('settings open from the pause veil and hand the match back', async () => {
  await page.click('#btn-pause-settings');
  await page.waitForSelector('#screen-settings:not([hidden])', { timeout: 4000 });

  // The point of opening settings here is to change audio mid-match, so the
  // controls have to be real, and the horde has to stay frozen behind them.
  const before = await positions();
  await page.waitForTimeout(700);
  const stillFrozen = (await positions()) === before;
  const sliders = await page.$$eval('.slider-row', (n) => n.length);

  await page.click('#btn-settings-back');
  await page.waitForSelector('#screen-hud:not([hidden])', { timeout: 4000 });
  // Back to the paused match, not out to the main menu.
  const backToPause = await page.isVisible('#pause-veil');

  return {
    ok: stillFrozen && sliders === 3 && backToPause,
    note: backToPause
      ? `${sliders} sliders reachable, horde still frozen, returned to the pause veil`
      : 'Done did not return to the match',
  };
});

await step('resuming restarts the simulation', async () => {
  await page.click('#btn-resume');
  await page.waitForTimeout(150);
  const before = await positions();
  await page.waitForTimeout(700);
  const after = await positions();
  return { ok: before !== after && !(await page.isVisible('#pause-veil')), note: 'horde moving again' };
});

await step('health regenerates once out of combat, not during it', async () => {
  const out = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    clearInterval(window.__keepAlive);

    // Step out of the swarm first. Left where it was, the player takes contact
    // damage throughout, which both suppresses regen (correctly — being hit
    // resets the timer) and masks it. The test would then be measuring the
    // horde, not regeneration.
    scene.me.x = 140;
    scene.me.y = 140;
    scene.me.hp = 40;

    // Freshly hit: regeneration must stay off.
    scene.sinceDamage = 0;
    await new Promise((r) => setTimeout(r, 500));
    const duringCombat = scene.me.hp;

    // Disengaged: it should climb.
    scene.sinceDamage = 99;
    await new Promise((r) => setTimeout(r, 900));
    const afterDisengaging = scene.me.hp;

    scene.me.hp = scene.me.maxHp;
    window.__keepAlive = setInterval(() => { scene.me.hp = scene.me.maxHp; }, 100);
    return { duringCombat, afterDisengaging };
  });
  return {
    ok: out.duringCombat === 40 && out.afterDisengaging > 40,
    note: `held at ${out.duringCombat} under fire, healed to ${out.afterDisengaging.toFixed(1)} after`,
  };
});

await step('a reboot restores full health', async () => {
  const out = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    clearInterval(window.__keepAlive);
    // Away from the horde, or the fresh reboot is chipped before it is read.
    scene.me.x = 140;
    scene.me.y = 140;
    scene.deaths = 0;
    scene.downedFor = 0;
    scene.me.hp = scene.me.maxHp;
    scene.takeDamage(99999);
    scene.downedFor = 0.01;           // skip the wait
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    const hp = scene.me.hp;
    scene.deaths = 0;
    window.__keepAlive = setInterval(() => { scene.me.hp = scene.me.maxHp; }, 100);
    return { hp, max: scene.me.maxHp };
  });
  return { ok: out.hp === out.max, note: `${out.hp}/${out.max}` };
});

await step('a solo run ends after three reboots, each the same flat wait', async () => {
  const out = await page.evaluate(async () => {
    const scene = window.glitchburst.game.scene.getScene('game');
    clearInterval(window.__keepAlive);

    const delays = [];
    for (let i = 0; i < 4; i++) {
      scene.downedFor = 0;
      scene.me.hp = scene.me.maxHp;
      scene.takeDamage(99999);
      delays.push(Number.isFinite(scene.downedFor) ? Math.round(scene.downedFor) : 'run over');
    }
    const over = scene.gameOver;
    const veiled = !document.getElementById('over-veil').hidden;

    // Put the scene back so later steps get a living player.
    scene.gameOver = false;
    scene.deaths = 0;
    scene.downedFor = 0;
    scene.me.hp = scene.me.maxHp;
    window.__keepAlive = setInterval(() => { scene.me.hp = scene.me.maxHp; }, 100);

    return { delays, over, veiled };
  });

  // Flat, not escalating: solo already pays for each death with one of three
  // reboots, and a rising timer on top charges twice for the same mistake.
  const flat = out.delays.slice(0, 3).every((d) => d === LIVES.soloRebootSec);
  return {
    ok: flat && out.delays[3] === 'run over' && out.over,
    note: `${out.delays.join('s, ')}${out.veiled ? ' (failure screen shown)' : ''}`,
  };
});

await step('a reboot never puts you back inside the swarm', async () => {
  const out = await page.evaluate(async ({ safe, world }) => {
    const scene = window.glitchburst.game.scene.getScene('game');
    clearInterval(window.__keepAlive);

    // Bury the player: a ring of enemies right on top of them, which is what a
    // death at the cap actually looks like.
    //
    // The engine enemy, the view's network target and the sprite all have to be
    // moved together. Moving only the sprite fights the interpolation — it
    // glides straight back toward the target it was given, and the relocation
    // is then measured against positions that have already changed.
    const x = scene.me.x;
    const y = scene.me.y;
    for (const [id, view] of scene.enemies) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 170;
      const ex = x + Math.cos(a) * r;
      const ey = y + Math.sin(a) * r;
      view.tx = ex;
      view.ty = ey;
      view.sprite.setPosition(ex, ey);
      const live = scene.horde?.enemies.get(id);
      if (live) { live.x = ex; live.y = ey; live.stun = 5; }
    }
    const buried = scene.enemies.size;

    const nearest = (px, py) => {
      let best = Infinity;
      for (const v of scene.enemies.values()) {
        const d = Math.hypot(px - v.sprite.x, py - v.sprite.y);
        if (d < best) best = d;
      }
      return best;
    };
    const before = nearest(x, y);

    scene.deaths = 0;
    scene.gameOver = false;
    scene.me.hp = scene.me.maxHp;
    scene.takeDamage(99999);
    scene.downedFor = 0.01;
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    const after = nearest(scene.me.x, scene.me.y);
    const moved = Math.hypot(scene.me.x - x, scene.me.y - y);
    const inArena =
      scene.me.x > 0 && scene.me.y > 0 && scene.me.x < world.width && scene.me.y < world.height;

    scene.deaths = 0;
    scene.gameOver = false;
    scene.downedFor = 0;
    scene.me.hp = scene.me.maxHp;
    window.__keepAlive = setInterval(() => { scene.me.hp = scene.me.maxHp; }, 100);

    // And the clamping path: dying in a corner means half the search ring is
    // outside the arena, and a relocation must never land there.
    scene.me.x = 30;
    scene.me.y = 30;
    for (const [id, view] of scene.enemies) {
      view.tx = 60; view.ty = 60;
      view.sprite.setPosition(60, 60);
      const live = scene.horde?.enemies.get(id);
      if (live) { live.x = 60; live.y = 60; live.stun = 5; }
    }
    scene.deaths = 0;
    scene.gameOver = false;
    scene.me.hp = scene.me.maxHp;
    scene.takeDamage(99999);
    scene.downedFor = 0.01;
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
    const corner = {
      x: scene.me.x,
      y: scene.me.y,
      clear: nearest(scene.me.x, scene.me.y),
      inArena:
        scene.me.x > 0 && scene.me.y > 0 && scene.me.x < world.width && scene.me.y < world.height,
    };

    return { buried, before, after, moved, inArena, corner };
  }, { safe: LIVES.rebootSafeRadius, world: { width: WORLD.width, height: WORLD.height } });

  const safe = LIVES.rebootSafeRadius;
  const cornerOk =
    out.corner.inArena && Number.isFinite(out.corner.x) && out.corner.clear >= safe;
  return {
    ok: out.buried > 4 && out.before < safe && out.after >= safe && out.inArena && cornerOk,
    note: out.before >= safe
      ? 'could not bury the player to set the test up'
      : `${out.buried} hostiles on the corpse, nearest ${out.before.toFixed(0)}px → ${out.after.toFixed(0)}px after a ${out.moved.toFixed(0)}px relocation; from a corner → ${out.corner.clear.toFixed(0)}px clear at (${out.corner.x.toFixed(0)}, ${out.corner.y.toFixed(0)})`,
  };
});

await step('audio starts after a gesture and mutes on demand', async () => {
  const out = await page.evaluate(async () => {
    const { audio, music, sfx } = window.glitchburst;
    audio.unlock();
    await new Promise((r) => setTimeout(r, 150));

    // Every effect must survive being called; audio is a garnish and must never
    // be able to take a frame down.
    let threw = null;
    try {
      sfx.shoot('overclocker'); sfx.hit(); sfx.kill(true); sfx.hurt();
      sfx.ability(); sfx.chip(0.5); sfx.powerUp(); sfx.wave(); sfx.click();
    } catch (e) { threw = String(e); }

    const gainOf = (ch) => audio.destination(ch)?.gain.value ?? null;
    const before = { sfx: gainOf('sfx'), music: gainOf('music') };
    audio.setVolume('sfx', 0);
    audio.setVolume('music', 0);
    await new Promise((r) => setTimeout(r, 120));
    const muted = { sfx: audio.destination('sfx'), music: audio.destination('music') };
    audio.setVolume('sfx', 1);
    audio.setVolume('music', 1);

    return { state: audio.context?.state ?? 'none', threw, before, mutedSfx: muted.sfx, playing: music.isPlaying };
  });

  return {
    ok: out.threw === null && out.mutedSfx === null,
    note: out.threw
      ? `effect threw: ${out.threw}`
      : `context ${out.state}, muting detaches the channel, music playing: ${out.playing}`,
  };
});

await step('no uncaught errors', async () => ({ ok: errors.length === 0, note: errors.slice(0, 4).join(' | ') || 'clean' }));

await page.screenshot({ path: 'test/rig/gameplay.png', animations: 'disabled', timeout: 15000 });
await browser.close();
server.close();
finish();
