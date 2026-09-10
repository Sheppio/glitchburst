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

console.log(next);
