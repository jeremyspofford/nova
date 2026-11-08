// CHANGELOG.md, generated from fragments (docs/changelog/README.md): each pull request that changes
// what Nova does adds its own docs/changelog/<YYYY-MM-DD>-<branch>.md, so two pull requests never
// edit the same file. When the version is bumped, the fragments waiting at the top of docs/changelog/
// move into docs/changelog/<version>/ (`npm run changelog -- --release`), and CHANGELOG.md is written
// from the version folders: Keep a Changelog, newest version first.
//
//   npm run changelog                 write CHANGELOG.md from the version folders
//   npm run changelog -- --release    move the waiting fragments into package.json's version, then write
//   npm run changelog -- --check      fail if CHANGELOG.md isn't what the fragments make
//
// Deterministic: the same fragments always make the same file (no clock, no git, no network).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAGMENT, SECTIONS, compareVersions, isFragment, isVersion, parseFragment } from '../src/core/changelog.ts';

export const ROOT = join(import.meta.dirname, '..');
export const DIR = join(ROOT, 'docs', 'changelog');
export const TARGET = join(ROOT, 'CHANGELOG.md');

// The grammar (sections, fragment names, versions and their order, a fragment's shape) is the core's
// (src/core/changelog.ts), which the in-app changelog reads CHANGELOG.md back with: one grammar for
// writing the file and for showing it.
export { SECTIONS, compareVersions, isFragment, isVersion, parseFragment };

const HEADER = `# Changelog

What changed in Nova, in plain language, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Nova's versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) on an alpha line (0.1.0-alpha.1, …).

This file is generated from docs/changelog/ by \`npm run changelog\`: edit the fragments there, never
this file. A change merged but not yet in a version waits at the top of docs/changelog/.
`;

const fragmentsIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f !== 'README.md' && f.endsWith('.md')) : []);

function checkNames(dir, names) {
  for (const f of names) if (!isFragment(f)) throw new Error(`${join(dir, f)}: a fragment is named <YYYY-MM-DD>-<branch>.md.`);
}

// The released versions: each folder under docs/changelog/ named by a version, its fragments.
export function releases(dir = DIR) {
  const versions = existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory()) : [];
  for (const v of versions) if (!isVersion(v)) throw new Error(`docs/changelog/${v}/ isn't named by a version (like 0.1.0-alpha.2).`);
  return versions.sort((a, b) => compareVersions(b, a)).map((version) => {
    const vdir = join(dir, version);
    const names = fragmentsIn(vdir);
    checkNames(vdir, names);
    if (!names.length) throw new Error(`docs/changelog/${version}/ has no fragments.`);
    // Newest first within a version, by file name (date, then branch).
    names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const fragments = names.map((f) => ({ file: f, sections: parseFragment(readFileSync(join(vdir, f), 'utf8'), `docs/changelog/${version}/${f}`) }));
    return { version, date: FRAGMENT.exec(names[0])[1], fragments };
  });
}

// The fragments waiting for the next version (checked, so a bad one fails before it is released).
export function waiting(dir = DIR) {
  const names = fragmentsIn(dir).filter((f) => statSync(join(dir, f)).isFile()).sort();
  checkNames(dir, names);
  for (const f of names) parseFragment(readFileSync(join(dir, f), 'utf8'), `docs/changelog/${f}`);
  return names;
}

export function generate(dir = DIR) {
  waiting(dir);
  const blocks = releases(dir).map(({ version, date, fragments }) => {
    const parts = SECTIONS.map((s) => {
      const items = fragments.flatMap((f) => f.sections[s] ?? []);
      return items.length ? `### ${s}\n\n${items.map((it) => `- ${it}`).join('\n')}\n` : null;
    }).filter(Boolean);
    return `## ${version} - ${date}\n\n${parts.join('\n')}`;
  });
  return `${HEADER}${blocks.map((b) => `\n${b}`).join('')}`;
}

// Moves every waiting fragment into docs/changelog/<version>/ (made if it isn't there).
export function release(version, dir = DIR) {
  if (!isVersion(version)) throw new Error(`Not a version: ${version}`);
  const names = waiting(dir);
  if (!names.length) throw new Error('No fragments are waiting in docs/changelog/.');
  const vdir = join(dir, version);
  mkdirSync(vdir, { recursive: true });
  for (const f of names) {
    if (existsSync(join(vdir, f))) throw new Error(`docs/changelog/${version}/${f} already exists.`);
    renameSync(join(dir, f), join(vdir, f));
  }
  return names;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--check')) {
      const now = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
      if (now !== generate()) { console.error('CHANGELOG.md is out of date with docs/changelog/: run npm run changelog'); process.exit(1); }
      console.log('CHANGELOG.md matches docs/changelog/.');
    } else {
      if (args.includes('--release')) {
        const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
        const moved = release(version);
        console.log(`Released into ${version}: ${moved.join(', ')}`);
      }
      writeFileSync(TARGET, generate());
      console.log('Wrote CHANGELOG.md.');
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
