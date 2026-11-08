// The changelog's grammar, shared by the generator (scripts/changelog.js writes CHANGELOG.md from
// the fragments in docs/changelog/) and the in-app changelog (GET /api/v1/changelog reads
// CHANGELOG.md back, plus the fragments still waiting for a version). One grammar in one place, so
// what the app shows can't drift from the file: tests/changelog-view.test.js holds them together.
//
// Reading is for the owner's screen, so it never throws: a malformed block is left out and named
// in `problems`, and the rest is still shown. Writing (the generator) stays strict and throws.
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Keep a Changelog's sections, in its order; Nova uses these five.
export const SECTIONS = ['Added', 'Changed', 'Removed', 'Fixed', 'Security'] as const;
export type Section = (typeof SECTIONS)[number];
export const FRAGMENT = /^(\d{4}-\d{2}-\d{2})-[a-z0-9][a-z0-9.-]*\.md$/;
// SemVer: major.minor.patch, optionally -prerelease (0.1.0-alpha.1).
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const isFragment = (name: string): boolean => FRAGMENT.test(name);
export const isVersion = (v: string): boolean => VERSION.test(v);

// SemVer precedence (§11): numbers, then a release above its prereleases, then identifiers in turn.
export function compareVersions(a: string, b: string): number {
  const pa = VERSION.exec(a), pb = VERSION.exec(b);
  if (!pa || !pb) throw new Error(`Not a version: ${!pa ? a : b}`);
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return d; }
  const ra = pa[4], rb = pb[4];
  if (!ra || !rb) return ra === rb ? 0 : ra ? -1 : 1;
  const xa = ra.split('.'), xb = rb.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const ia = xa[i], ib = xb[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia), nb = /^\d+$/.test(ib);
    if (na && nb) { const d = Number(ia) - Number(ib); if (d) return d; continue; }
    if (na !== nb) return na ? -1 : 1;
    if (ia !== ib) return ia < ib ? -1 : 1;
  }
  return 0;
}

export type Sections = Partial<Record<Section, string[]>>;
const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s);

// One fragment: `### <Section>` headings, each with "- " items (an item may continue on lines
// indented by two spaces). Nothing else, and no bare pull request numbers: say what it does.
export function parseFragment(text: string, name = 'fragment'): Sections {
  const out: Sections = {};
  let section: Section | null = null;
  let item: string | null = null;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((line, i) => {
    const where = `${name}:${i + 1}`;
    if (!line.trim()) { item = null; return; }
    const h = /^### (.+)$/.exec(line);
    if (h) {
      const s = h[1]!.trim();
      if (!isSection(s)) throw new Error(`${where}: "${s}" isn't a section; use ${SECTIONS.join(', ')}.`);
      section = s;
      if (out[section]) throw new Error(`${where}: ${section} appears twice.`);
      out[section] = [];
      item = null;
      return;
    }
    if (!section) throw new Error(`${where}: a fragment starts with a ### section heading (${SECTIONS.join(', ')}).`);
    const list = out[section]!;
    if (line.startsWith('- ') && line.slice(2).trim()) { item = line.slice(2).trim(); list.push(item); return; }
    if (item !== null && /^ {2}\S/.test(line)) { list[list.length - 1] += ` ${line.trim()}`; return; }
    throw new Error(`${where}: only "- " items (continued on lines indented two spaces) go under a section.`);
  });
  const sections = Object.keys(out) as Section[];
  if (!sections.length) throw new Error(`${name}: empty; a fragment has at least one section with an item.`);
  for (const s of sections) if (!out[s]!.length) throw new Error(`${name}: ${s} has no items.`);
  for (const s of sections) for (const it of out[s]!) {
    if (/(^|[^\w&/])#\d+\b/.test(it) || /\bPR ?\d+\b/i.test(it)) throw new Error(`${name}: "${it.slice(0, 60)}…" names a pull request by number; say what the change does instead.`);
  }
  return out;
}

// ---- reading CHANGELOG.md back --------------------------------------------------------------------

export interface Release { version: string; date: string; sections: { name: Section; items: string[] }[] }
export interface Waiting { file: string; date: string; sections: { name: Section; items: string[] }[] }
export interface Parsed { versions: Release[]; problems: string[] }

const ordered = (s: Sections) => SECTIONS.filter((n) => s[n]?.length).map((name) => ({ name, items: [...s[name]!] }));

// CHANGELOG.md as the generator writes it: a header, then `## <version> - <date>` blocks of
// `### <Section>` lists of one-line "- " items. A block that doesn't keep that shape (a heading
// that isn't a version, a section it doesn't know, loose text, a version twice) is left out and
// said in `problems`; the blocks around it still count. Newest version first, whatever the file's order.
export function parseChangelog(text: string, name = 'CHANGELOG.md'): Parsed {
  const problems: string[] = [];
  const versions: Release[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let block: { version: string; date: string; sections: Sections; at: number; bad: string | null } | null = null;
  let section: Section | null = null;
  const close = () => {
    if (!block) return;
    const b = block;
    block = null;
    if (!b.bad && !Object.keys(b.sections).length) b.bad = 'it has no entries';
    if (!b.bad && Object.values(b.sections).some((items) => !items?.length)) b.bad = 'a section has no items';
    if (!b.bad && versions.some((v) => v.version === b.version)) b.bad = `${b.version} appears twice`;
    if (b.bad) { problems.push(`${name}:${b.at}: the block for ${b.version || 'an unnamed version'} was left out: ${b.bad}.`); return; }
    versions.push({ version: b.version, date: b.date, sections: ordered(b.sections) });
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (line.startsWith('## ')) {
      close();
      section = null;
      const m = /^## (\S+) - (\d{4}-\d{2}-\d{2})$/.exec(line);
      const version = m?.[1] ?? line.slice(3).trim();
      block = { version, date: m?.[2] ?? '', sections: {}, at: n, bad: m && isVersion(version) ? null : `"${line.slice(3).trim()}" isn't "<version> - <YYYY-MM-DD>"` };
      return;
    }
    if (!block) return; // the header: prose about the file, not an entry
    const b: { sections: Sections; bad: string | null } = block;
    if (b.bad || !line.trim()) return;
    const h = /^### (.+)$/.exec(line);
    if (h) {
      const s = h[1]!.trim();
      if (!isSection(s)) { b.bad = `"${s}" isn't a section`; return; }
      if (b.sections[s]) { b.bad = `${s} appears twice`; return; }
      section = s;
      b.sections[s] = [];
      return;
    }
    if (section && line.startsWith('- ') && line.slice(2).trim()) { b.sections[section]!.push(line.slice(2).trim()); return; }
    b.bad = `line ${n} isn't a "- " item under a ### section`;
  });
  close();
  versions.sort((a, b) => compareVersions(b.version, a.version));
  return { versions, problems };
}

// ---- the files, read for the app ------------------------------------------------------------------

// A plain file (not a link, not a folder) at most `max` bytes, or null. What Nova serves from its own
// checkout is read through this, so a planted link or a huge file can't make it read something else.
export function readPlain(path: string, max: number): string | null {
  let fd: number | null = null;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    if (size > max) return null;
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export const CHANGELOG_MAX_BYTES = 1024 * 1024;
const FRAGMENT_MAX_BYTES = 64 * 1024;

export interface ChangelogView {
  // What this Nova was started as (build.ts): pinned on top, and compared with the newest entry.
  running: { version: string; commit_short: string | null };
  newest: string | null;
  versions: Release[];
  // Merged since the newest version, waiting for the next one: docs/changelog/<date>-<branch>.md.
  waiting: Waiting[];
  problems: string[];
}

// GET /api/v1/changelog. Read on every ask, from the code's own checkout: a redeploy that has
// checked out a newer commit but not yet restarted shows a newer changelog than the running version,
// which the app says. Only CHANGELOG.md and docs/changelog/*.md are read; no path comes from the request.
export function changelogView(root: string, running: ChangelogView['running']): ChangelogView {
  const text = readPlain(join(root, 'CHANGELOG.md'), CHANGELOG_MAX_BYTES);
  const parsed = text === null ? { versions: [], problems: ['CHANGELOG.md isn’t in this build of Nova, so there is no changelog to show.'] } : parseChangelog(text);
  const waiting: Waiting[] = [];
  const problems = [...parsed.problems];
  let names: string[] = [];
  try { names = readdirSync(join(root, 'docs', 'changelog')); } catch { /* no fragments folder: nothing waiting */ }
  for (const f of names.filter(isFragment).sort().reverse()) {
    const body = readPlain(join(root, 'docs', 'changelog', f), FRAGMENT_MAX_BYTES);
    if (body === null) continue; // a folder (a released version) or not a plain file
    try {
      waiting.push({ file: f, date: FRAGMENT.exec(f)![1]!, sections: ordered(parseFragment(body, `docs/changelog/${f}`)) });
    } catch (e) {
      problems.push(`${(e as Error).message} It was left out.`);
    }
  }
  return { running, newest: parsed.versions[0]?.version ?? null, versions: parsed.versions, waiting, problems };
}
