/**
 * Cheap consistency guards for things that drift silently.
 *
 * It already had — the README claimed 85 while the suites ran 141, because
 * tests get added constantly and prose does not. A stale number is worse than
 * no number: it quietly misrepresents how well covered the thing is.
 *
 * Counting is static (one `check(...)` or `await step(...)` per assertion)
 * rather than by running the suites, so this stays a sub-second check in the
 * fast CI job instead of a second full browser run. Verified to match the
 * runtime totals exactly.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUITES = ['sim', 'smoke', 'mobile', 'multiplayer'];

let total = 0;
const parts = [];
for (const suite of SUITES) {
  const src = await readFile(join(HERE, `${suite}.test.mjs`), 'utf8');
  const count = (src.match(/^\s*(?:await step|check)\(/gm) ?? []).length;
  total += count;
  parts.push(`${suite} ${count}`);
}

const readme = await readFile(join(HERE, '..', 'README.md'), 'utf8');
const claimed = [...readme.matchAll(/(\d+)\s+(?:tests|checks)\b/g)].map((m) => Number(m[1]));

console.log(`suites: ${parts.join(', ')} = ${total}`);

if (!claimed.length) {
  console.error('::error::README states no test count. Expected "%d tests" and "%d checks".', total, total);
  process.exit(1);
}

const wrong = claimed.filter((n) => n !== total);
if (wrong.length) {
  console.error(
    `::error::README claims ${[...new Set(claimed)].join(' and ')} tests but the suites contain ${total}. Update README.md.`,
  );
  process.exit(1);
}

console.log(`README agrees: ${total}`);

// The displayed version is generated into src/version.ts from package.json by
// the pre-commit hook. If someone commits with hooks disabled the two diverge,
// and the menu then quietly advertises the wrong build — the exact situation
// where a version number is worse than none, because a bug report cites it.
const pkg = JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8'));
const source = await readFile(join(HERE, '..', 'src', 'version.ts'), 'utf8');
const baked = source.match(/VERSION = '([^']+)'/)?.[1];

if (baked !== pkg.version) {
  console.error(
    `::error::src/version.ts says ${baked} but package.json says ${pkg.version}. Run 'npm run version:bump -- --check'.`,
  );
  process.exit(1);
}

console.log(`version ${pkg.version} baked in`);
