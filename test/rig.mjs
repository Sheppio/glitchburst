/**
 * Shared test rig.
 *
 * The game normally pulls Phaser and MQTT.js from a CDN and talks to a public
 * broker. Neither is appropriate in a test: the CDN is a network dependency and
 * the broker is shared with the whole internet. So the rig generates a copy of
 * index.html whose import map points at the local Phaser build and at a
 * loopback broker stub, and serves the repository over http.
 *
 * The stub relays publishes over a BroadcastChannel, so several tabs share one
 * "broker" — which is what makes a real multi-client room testable offline.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
const RIG = join(HERE, 'rig');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.map': 'application/json', '.png': 'image/png',
};

/**
 * Chromium location.
 *
 * Prefer an explicit CHROME_PATH, then the browser this dev container ships
 * with, and otherwise fall back to letting Playwright resolve its own download
 * — which is what happens in CI after `playwright install chromium`.
 */
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  return existsSync(bundled) ? bundled : undefined;
}

/** Build test/rig/index.html plus its local dependencies. */
export async function buildRig() {
  await mkdir(RIG, { recursive: true });
  await copyFile(join(ROOT, 'node_modules/phaser/dist/phaser.esm.min.js'), join(RIG, 'phaser.esm.min.js'));
  await copyFile(join(HERE, 'mqtt-stub.js'), join(RIG, 'mqtt-stub.js'));

  let html = await readFile(join(ROOT, 'index.html'), 'utf8');
  html = html
    .replace(/"phaser":\s*"[^"]+"/, '"phaser": "./phaser.esm.min.js"')
    .replace(/"mqtt":\s*"[^"]+"/, '"mqtt": "./mqtt-stub.js"')
    .replace('href="./css/ui.css"', 'href="../../css/ui.css"')
    .replace('src="./dist/main.js"', 'src="../../dist/main.js"')
    // Google Fonts are unavailable offline and would stall `networkidle`.
    .replace(/\s*<link rel="preconnect"[^>]*>/g, '')
    .replace(/\s*<link\s+href="https:\/\/fonts\.googleapis[^>]*>/g, '');
  await writeFile(join(RIG, 'index.html'), html);
}

export async function startServer(port = 8099) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = join(ROOT, normalize(url.pathname));
      if (!path.startsWith(ROOT)) throw new Error('outside root');
      const body = await readFile(path);
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return { server, url: `http://127.0.0.1:${port}/test/rig/index.html` };
}

/**
 * `uncapped` lets a single-client test run as fast as it can. Multi-client
 * tests must leave it off: this container renders through SwiftShader, and one
 * uncapped tab saturates the CPU badly enough to starve the other tab's
 * requestAnimationFrame — which stalls Playwright's own actionability polling.
 */
export async function launch({ uncapped = false } = {}) {
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  if (uncapped) args.push('--disable-frame-rate-limit');
  return chromium.launch({ executablePath: chromePath(), args });
}

export function reporter(title) {
  let pass = 0;
  let fail = 0;
  console.log(`\n${title}\n`);
  return {
    check(label, ok, note = '') {
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
      ok ? pass++ : fail++;
    },
    finish() {
      console.log(`\n  ${pass} passed, ${fail} failed\n`);
      if (fail) process.exitCode = 1;
      return fail === 0;
    },
  };
}

/**
 * Deploy lands in the lobby now, not in the match — the host still has to
 * start the run. Shared by every browser suite so the flow is described once.
 *
 * The start button appears only once the host election settles, which takes
 * about a second, so this waits for the button rather than the screen.
 */
export async function startRunAsHost(page, timeout = 20000) {
  await page.waitForSelector('#screen-lobby:not([hidden])', { timeout });
  await page.waitForSelector('#btn-start-run:not([hidden])', { timeout });
  await page.click('#btn-start-run');
  await page.waitForSelector('#screen-hud:not([hidden])', { timeout });
}

/** A peer is pulled into the run by the host's heartbeat; it never starts one. */
export async function waitForRun(page, timeout = 20000) {
  await page.waitForSelector('#screen-hud:not([hidden])', { timeout });
}
