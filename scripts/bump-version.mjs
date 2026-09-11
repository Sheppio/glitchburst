/**
 * Increment the patch version and bake it into the source.
 *
 * The version has to be a committed artefact rather than something computed at
 * runtime: GitHub Pages serves static files, and `dist/` is committed, so
 * whatever the player sees on the menu must already be in the repository.
 *
 * Deriving it from `git rev-list --count` was the obvious alternative and is
 * worse here — at pre-commit time the commit being created does not exist yet,
 * so the count is always one behind, and rebases or amends renumber history
 * retroactively. A counter in package.json only ever moves forward.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(ROOT, 'package.json');
const SOURCE = join(ROOT, 'src', 'version.ts');
const README = join(ROOT, 'README.md');

/**
 * The generated span in README.md. Matched on the markers, not on the text.
 *
 * Deliberately not exported: this module bumps the version as a side effect of
 * being loaded, so anything that imported the pattern would bump the version
 * just by asking what it was. `test/consistency.mjs` keys off the same literal
 * markers and fails loudly if they ever stop matching.
 */
const VERSION_MARKERS = /(<!-- version -->)[\s\S]*?(<!-- \/version -->)/;

const pkg = JSON.parse(await readFile(PACKAGE, 'utf8'));
const [major, minor, patch] = String(pkg.version ?? '0.0.0').split('.').map(Number);

if ([major, minor, patch].some((n) => !Number.isFinite(n))) {
  console.error(`::error::package.json version "${pkg.version}" is not major.minor.patch`);
  process.exit(1);
}

const next = process.argv.includes('--check')
  ? `${major}.${minor}.${patch}`
  : `${major}.${minor}.${patch + 1}`;

if (!process.argv.includes('--check')) {
  pkg.version = next;
  await writeFile(PACKAGE, `${JSON.stringify(pkg, null, 2)}\n`);
}

await writeFile(
  SOURCE,
  `/**
 * Build version, shown on the main menu.
 *
 * GENERATED — do not edit. \`scripts/bump-version.mjs\` rewrites this on every
 * commit via the pre-commit hook in \`.githooks/\`, which \`npm install\` wires up.
 */
export const VERSION = '${next}';
`,
);

/**
 * The README states the version too, so it is rewritten here rather than by
 * hand. A version number a human has to remember to update is one that is
 * wrong within a commit or two — and a README claiming the wrong build is
 * worse than a README claiming none, because that is the number a bug report
 * quotes back at you.
 */
const readme = await readFile(README, 'utf8');
if (!VERSION_MARKERS.test(readme)) {
  console.error('::error::README.md is missing its <!-- version --> markers.');
  process.exit(1);
}
const updated = readme.replace(VERSION_MARKERS, `$1**v${next}**$2`);
if (!process.argv.includes('--check') && updated !== readme) {
  await writeFile(README, updated);
}

console.log(next);
