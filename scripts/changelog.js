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

export const ROOT = join(import.meta.dirname, '..');
export const DIR = join(ROOT, 'docs', 'changelog');
export const TARGET = join(ROOT, 'CHANGELOG.md');

// Keep a Changelog's sections, in its order; Nova uses these five.
export const SECTIONS = ['Added', 'Changed', 'Removed', 'Fixed', 'Security'];
const FRAGMENT = /^(\d{4}-\d{2}-\d{2})-[a-z0-9][a-z0-9.-]*\.md$/;
// SemVer: major.minor.patch, optionally -prerelease (0.1.0-alpha.1).
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const HEADER = `# Changelog

What changed in Nova, in plain language, newest first. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Nova's versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) on an alpha line (0.1.0-alpha.1, …).

This file is generated from docs/changelog/ by \`npm run changelog\`: edit the fragments there, never
this file. A change merged but not yet in a version waits at the top of docs/changelog/.
`;

export const isFragment = (name) => FRAGMENT.test(name);
export const isVersion = (v) => VERSION.test(v);

// SemVer precedence (§11): numbers, then a release above its prereleases, then identifiers in turn.
export function compareVersions(a, b) {
  const pa = VERSION.exec(a), pb = VERSION.exec(b);
  if (!pa || !pb) throw new Error(`Not a version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d; }
  const ra = pa[4], rb = pb[4];
  if (!ra || !rb) return ra === rb ? 0 : ra ? -1 : 1;
  const xa = ra.split('.'), xb = rb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]), nb = /^\d+$/.test(xb[i]);
    if (na && nb) { const d = Number(xa[i]) - Number(xb[i]); if (d) return d; continue; }
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

// One fragment: `### <Section>` headings, each with "- " items (an item may continue on lines
// indented by two spaces). Nothing else, and no bare pull request numbers: say what it does.
export function parseFragment(text, name = 'fragment') {
  const out = {};
  let section = null;
  let item = null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, i) => {
    const where = `${name}:${i + 1}`;
    if (!line.trim()) { item = null; return; }
    const h = /^### (.+)$/.exec(line);
    if (h) {
      if (!SECTIONS.includes(h[1].trim())) throw new Error(`${where}: "${h[1].trim()}" isn't a section; use ${SECTIONS.join(', ')}.`);
      section = h[1].trim();
      if (out[section]) throw new Error(`${where}: ${section} appears twice.`);
      out[section] = [];
      item = null;
      return;
    }
    if (!section) throw new Error(`${where}: a fragment starts with a ### section heading (${SECTIONS.join(', ')}).`);
    if (line.startsWith('- ') && line.slice(2).trim()) { item = line.slice(2).trim(); out[section].push(item); return; }
    if (item !== null && /^ {2}\S/.test(line)) { out[section][out[section].length - 1] += ` ${line.trim()}`; return; }
    throw new Error(`${where}: only "- " items (continued on lines indented two spaces) go under a section.`);
  });
  const sections = Object.keys(out);
  if (!sections.length) throw new Error(`${name}: empty; a fragment has at least one section with an item.`);
  for (const s of sections) if (!out[s].length) throw new Error(`${name}: ${s} has no items.`);
  for (const s of sections) for (const it of out[s]) {
    if (/(^|[^\w&/])#\d+\b/.test(it) || /\bPR ?\d+\b/i.test(it)) throw new Error(`${name}: "${it.slice(0, 60)}…" names a pull request by number; say what the change does instead.`);
  }
  return out;
}

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
