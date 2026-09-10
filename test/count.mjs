/**
 * Guard against the README's test count drifting from reality.
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
