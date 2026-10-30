// The per-task workspace (M5 plan §1): a provider works in workspace/tasks/<task-id>/ and nowhere
// else. Files a brief names are copied in; what the provider changed is copied back into the
// workspace only after Nova verified it. A copy of what went in (the baseline) lives outside the
// workspace, under the worker's own state, so a provider can't rewrite what it is compared with.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CoreError } from '../errors.ts';
import { sha256, type Workspace } from '../workspace.ts';
import { words } from './cli.ts';
import type { Brief } from '../envelope.ts';

export const TASKS_DIR = 'tasks';
const MAX_COPY_BYTES = 50 * 1024 * 1024;
export const MAX_REPLY_FILES = 50;
export const MAX_REPLY_FILE_BYTES = 1024 * 1024;

export interface Change { path: string; kind: 'added' | 'modified' | 'deleted'; sha256: string | null }
export interface TestAsk {
  task_id: string;
  provider: string;
  command: string;
  // The folder as the person saw it.
  tree: string;
  files: { path: string; kind: Change['kind']; added: number; removed: number; preview: string }[];
  more: number;
  asked_at: string;
  approved_at: string | null;
  // What the provider's run cost, carried to the report that ends the task.
  usage?: Record<string, unknown>;
  // What the provider reported of its own run (a Relay run), carried to that report too.
  artifacts?: Record<string, unknown>[];
}

const inside = (root: string, abs: string) => abs === root || abs.startsWith(root + sep);

// Every file under a folder, as forward-slash paths relative to it. Symlinks are never followed:
// a provider could plant one pointing anywhere on the machine.
export function walk(root: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const go = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (skip(rel)) continue;
      if (e.isDirectory()) go(abs);
      else if (e.isFile()) out.push(rel);
    }
  };
  go(root);
  return out.sort();
}

// One hash for a whole folder: each file's path and content. Changes if anything is added,
// removed or edited, so a check made earlier can tell the files moved on since.
export function treeHash(root: string): string {
  if (!existsSync(root)) return sha256('');
  return sha256(walk(root).map((p) => `${p}\0${sha256(readFileSync(join(root, p)))}`).join('\n'));
}

// Checks a path a provider asked to write, relative to the task's folder, before anything is
// written. Refused: empty, absolute, `..`, `.` or empty segments, backslashes, NUL, and any path
// that runs through a symlink (which could lead out of the folder).
export function safePath(root: string, path: unknown): { abs: string; rel: string } {
  if (typeof path !== 'string' || !path.trim()) throw new CoreError('validation', 'A file in the reply has no path.');
  const show = JSON.stringify(path.length > 80 ? `${path.slice(0, 77)}…` : path);
  if (path.length > 512) throw new CoreError('forbidden', `${show} is too long a path.`);
  if (path.includes('\0')) throw new CoreError('forbidden', `${show} has a NUL character in it.`);
  if (path.includes('\\')) throw new CoreError('forbidden', `${show} uses backslashes; paths in the reply use forward slashes.`);
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.startsWith('~')) throw new CoreError('forbidden', `${show} is an absolute path; only paths inside the task's folder are allowed.`);
  const parts = path.split('/');
  if (parts.some((p) => p === '..')) throw new CoreError('forbidden', `${show} climbs out with "..".`);
  if (parts.some((p) => p === '' || p === '.')) throw new CoreError('forbidden', `${show} has an empty or "." part.`);
  const abs = resolve(root, ...parts);
  if (!inside(root, abs) || abs === root) throw new CoreError('forbidden', `${show} is outside the task's folder.`);
  // Each part that exists must be a real folder (or, for the last, a real file), never a link.
  let at = root;
  for (const p of parts) {
    at = join(at, p);
    let st;
    try { st = lstatSync(at); } catch { break; }
    if (st.isSymbolicLink()) throw new CoreError('forbidden', `${show} goes through a symlink, which could lead outside the task's folder.`);
  }
  let existing = dirname(abs);
  while (!existsSync(existing)) existing = dirname(existing);
  const real = realpathSync(existing);
  if (!inside(realpathSync(root), real)) throw new CoreError('forbidden', `${show} leads outside the task's folder.`);
  return { abs, rel: parts.join('/') };
}

// The JSON files reply contract for chat providers: {files: [{path, content}], notes}. Every path is
// checked before any file is written, so a reply with one bad path changes nothing.
export function applyFiles(root: string, files: unknown): string[] {
  if (!Array.isArray(files)) throw new CoreError('validation', 'The reply\'s "files" must be a list.');
  if (files.length > MAX_REPLY_FILES) throw new CoreError('validation', `The reply has ${files.length} files; at most ${MAX_REPLY_FILES} are taken.`);
  const planned = files.map((f, i) => {
    if (typeof f !== 'object' || f === null) throw new CoreError('validation', `File ${i + 1} in the reply isn't {path, content}.`);
    const { path, content } = f as { path?: unknown; content?: unknown };
    const at = safePath(root, path);
    if (typeof content !== 'string') throw new CoreError('validation', `${at.rel} in the reply has no text content.`);
    if (Buffer.byteLength(content) > MAX_REPLY_FILE_BYTES) throw new CoreError('validation', `${at.rel} in the reply is over 1 MB.`);
    return { ...at, content };
  });
  for (const f of planned) {
    mkdirSync(dirname(f.abs), { recursive: true });
    writeFileSync(f.abs, f.content);
  }
  return planned.map((f) => f.rel);
}

// The files a brief points at (context_refs of kind file), as paths in the workspace.
export function fileRefs(brief: Brief): string[] {
  return brief.context_refs.filter((r) => r.kind === 'file').map((r) => r.ref);
}

// ---- what a provider may change ------------------------------------------------------------------
// A test only proves something if the provider couldn't rewrite it. So a brief says what the
// provider may change (inputs.editable: paths or globs in the workspace); without that, it may change
// what the brief gave it except the tests, test-runner settings, and anything the test command names.

// Tests by the usual names and folders.
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)[^/]*\.(test|spec)\.[^/]+$|(^|\/)[^/]*_test\.[^/]+$|(^|\/)test_[^/]*\.[^/]+$|(^|\/)conftest\.py$/;
// Settings that decide what a test run checks.
const TEST_CONFIG = /(^|\/)(jest|vitest|playwright|karma|cypress|ava)\.config\.[^/]+$|(^|\/)\.mocharc(\.[^/]+)?$|(^|\/)(pytest\.ini|tox\.ini)$/;
// A program in the test command, and the files that tell it what to run.
const RUNNER_FILES: [RegExp, RegExp][] = [
  [/^(npm|npx|pnpm|yarn|bun|node)$/, /(^|\/)package\.json$/],
  [/^(make|gmake)$/, /(^|\/)(GNUmakefile|[Mm]akefile)$/],
  [/^(pytest|py\.test|tox)$/, /(^|\/)(setup\.cfg|pyproject\.toml)$/],
];

// A path or glob in the workspace: `*` within one folder, `**` across folders, `?` one character.
// A folder covers everything in it.
export function globRe(pattern: string): RegExp {
  const p = pattern.replace(/^workspace:/, '').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}(?:/.*)?$`);
}

export interface Scope {
  // The brief's file refs, as workspace paths (a folder covers what is in it).
  refs: string[];
  // What the brief said the provider may change, or null for the default.
  explicit: string[] | null;
  // What the test command names (and the runner files it implies), kept out of the default.
  named: string[];
  inRefs(path: string): boolean;
  editable(path: string): boolean;
  // For the provider's instructions.
  words: string;
}

export function editableList(v: unknown): string[] | null {
  if (v === undefined) return null;
  const bad = () => new CoreError('validation', 'inputs.editable is a list of paths or globs in the workspace, like calc/sum.mjs or src/**.');
  if (!Array.isArray(v) || v.length > 200) throw bad();
  for (const p of v) {
    if (typeof p !== 'string' || !p.trim() || p.length > 300 || p.includes('\\') || p.includes('\0')) throw bad();
    const rel = p.replace(/^workspace:/, '');
    if (isAbsolute(rel) || rel.startsWith('~') || rel.split('/').includes('..')) throw bad();
  }
  return v as string[];
}

// `refs`: workspace paths; `files`: what was copied in (for what the test command names).
export function scopeOf(refs: string[], inputs: Record<string, unknown> | undefined, files: string[]): Scope {
  const explicit = editableList(inputs?.editable);
  const command = typeof inputs?.test_command === 'string' ? inputs.test_command : '';
  const said = words(command);
  // Every word of the command counts as a path it may run, whether the file is there yet or not: a
  // provider that adds the script the command names has written the test.
  const named = new Set<string>();
  for (const w of said) {
    for (const part of [w, w.split('=').slice(1).join('=')]) {
      const p = part.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
      if (p) named.add(p);
    }
  }
  for (const [program, file] of RUNNER_FILES) {
    if (said.some((w) => program.test(w.split('/').pop() ?? ''))) for (const f of files) if (file.test(f)) named.add(f);
  }
  const inRefs = (p: string) => refs.some((r) => p === r || p.startsWith(`${r}/`));
  const globs = explicit?.map(globRe) ?? null;
  const editable = globs
    ? (p: string) => globs.some((g) => g.test(p))
    : (p: string) => inRefs(p) && !TEST_FILE.test(p) && !TEST_CONFIG.test(p) && !named.has(p);
  const list = (xs: string[]) => xs.slice(0, 20).join(', ') + (xs.length > 20 ? `, and ${xs.length - 20} more` : '');
  const kept = [...named].filter((p) => files.includes(p) || (p.includes('/') && !p.startsWith('-')));
  const words_ = explicit
    ? `You may change only these: ${list(explicit)}. Nova refuses the work if anything else changes.`
    : `You may change the files you were given, but not the tests or their settings${kept.length ? ` (nor ${list(kept)})` : ''}. Nova refuses the work if any of those change.`;
  return { refs, explicit, named: kept, inRefs, editable, words: words_ };
}

// The changes a provider wasn't allowed to make, in a sentence; null when there are none.
export function outOfScope(changes: Change[], scope: Scope): string | null {
  const bad = changes.filter((c) => !scope.editable(c.path)).map((c) => c.path);
  if (!bad.length) return null;
  const shown = bad.length > 5 ? `${bad.slice(0, 5).join(', ')} and ${bad.length - 5} more` : bad.length > 1 ? `${bad.slice(0, -1).join(', ')} and ${bad.at(-1)}` : bad[0];
  return `the provider changed ${shown}, which it was not allowed to change`;
}

// Why a change isn't copied into the workspace, or null when it is.
export function notCopied(path: string, scope: Scope): string | null {
  if (path === TASKS_DIR || path.startsWith(`${TASKS_DIR}/`)) return 'it is in the tasks folder, where other tasks work';
  if (!scope.inRefs(path)) return 'it is outside what the brief named';
  if (!scope.editable(path)) return 'the brief didn’t let the provider change it';
  return null;
}

export class TaskSpace {
  readonly id: string;
  readonly root: string;       // workspace/tasks/<id>
  readonly state: string;      // <home>/workers/providers/tasks/<id>
  readonly baseline: string;
  #ws: Workspace;

  constructor(ws: Workspace, stateRoot: string, taskId: string) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(taskId)) throw new CoreError('validation', 'A task id names its folder, so it must be letters, digits and dashes.');
    this.id = taskId;
    this.#ws = ws;
    this.root = join(ws.root, TASKS_DIR, taskId);
    this.state = join(stateRoot, 'tasks', taskId);
    this.baseline = join(this.state, 'baseline');
  }

  exists(): boolean {
    return existsSync(this.root);
  }

  // The brief's file refs as workspace paths (a ref Nova can't place counts for nothing).
  refPaths(refs: string[]): string[] {
    const out: string[] = [];
    for (const ref of refs) {
      try { out.push(relative(this.#ws.root, this.#ws.resolve(ref)).split(sep).join('/')); } catch { /* outside the workspace: prepare refuses it */ }
    }
    return out;
  }

  // What the provider may change in this task, from the brief and the copy it started from.
  scope(brief: Brief): Scope {
    return scopeOf(this.refPaths(fileRefs(brief)), brief.inputs, existsSync(this.baseline) ? walk(this.baseline) : []);
  }

  // A fresh start for each attempt: the folder is emptied, the named files copied in again, and the
  // baseline taken from what was copied. Returns the copied files with their hashes.
  prepare(refs: string[]): { path: string; sha256: string }[] {
    rmSync(this.root, { recursive: true, force: true });
    rmSync(this.baseline, { recursive: true, force: true });
    rmSync(join(this.state, 'changes.json'), { force: true });
    rmSync(join(this.state, 'test-ask.json'), { force: true });
    mkdirSync(this.root, { recursive: true });
    let bytes = 0;
    for (const ref of refs) {
      const src = this.#ws.resolve(ref);
      const rel = relative(this.#ws.root, src).split(sep).join('/');
      if (rel === TASKS_DIR || rel.startsWith(`${TASKS_DIR}/`)) throw new CoreError('forbidden', `${ref} is another task's folder; it can't be copied in.`);
      if (!existsSync(src)) throw new CoreError('not_found', `The brief names ${ref}, and it isn't in the workspace.`);
      const st = lstatSync(src);
      const files = st.isDirectory() ? walk(src).map((p) => (rel ? `${rel}/${p}` : p)) : st.isFile() ? [rel] : [];
      for (const f of files) {
        bytes += lstatSync(join(this.#ws.root, f)).size;
        if (bytes > MAX_COPY_BYTES) throw new CoreError('validation', 'The files the brief names add up to more than 50 MB; name fewer.');
        const dest = join(this.root, f);
        mkdirSync(dirname(dest), { recursive: true });
        cpSync(join(this.#ws.root, f), dest);
      }
    }
    mkdirSync(this.state, { recursive: true });
    cpSync(this.root, this.baseline, { recursive: true });
    return walk(this.root).map((p) => ({ path: p, sha256: sha256(readFileSync(join(this.root, p))) }));
  }

  read(rel: string): string | null {
    const abs = join(this.root, rel);
    return existsSync(abs) && lstatSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
  }

  readBaseline(rel: string): string | null {
    const abs = join(this.baseline, rel);
    return existsSync(abs) && lstatSync(abs).isFile() ? readFileSync(abs, 'utf8') : null;
  }

  // What differs from the baseline now: added, modified and deleted files.
  changes(): Change[] {
    const now = new Set(walk(this.root));
    const before = new Set(existsSync(this.baseline) ? walk(this.baseline) : []);
    const out: Change[] = [];
    for (const p of [...new Set([...now, ...before])].sort()) {
      if (!before.has(p)) out.push({ path: p, kind: 'added', sha256: sha256(readFileSync(join(this.root, p))) });
      else if (!now.has(p)) out.push({ path: p, kind: 'deleted', sha256: null });
      else {
        const a = readFileSync(join(this.baseline, p));
        const b = readFileSync(join(this.root, p));
        if (!a.equals(b)) out.push({ path: p, kind: 'modified', sha256: sha256(b) });
      }
    }
    return out;
  }

  // The changes as they stood when the provider finished, kept for the copy-back.
  recordChanges(changes: Change[]): void {
    mkdirSync(this.state, { recursive: true });
    writeFileSync(join(this.state, 'changes.json'), JSON.stringify(changes));
  }

  recorded(): Change[] | null {
    const f = join(this.state, 'changes.json');
    return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Change[]) : null;
  }

  // Nova's question before it runs the test on what a provider wrote: kept beside the task's state,
  // so it outlives a restart, with the folder's hash so what runs is what the person saw.
  ask(): TestAsk | null {
    const f = join(this.state, 'test-ask.json');
    try { return JSON.parse(readFileSync(f, 'utf8')) as TestAsk; } catch { return null; }
  }

  setAsk(a: TestAsk | null): void {
    const f = join(this.state, 'test-ask.json');
    if (!a) { rmSync(f, { force: true }); return; }
    mkdirSync(this.state, { recursive: true });
    writeFileSync(`${f}.tmp`, JSON.stringify(a));
    renameSync(`${f}.tmp`, f);
  }

  copiedBack(): boolean {
    return existsSync(join(this.state, 'copied-back.json'));
  }

  // After verification passed: the provider's changes go into the workspace. A file someone changed
  // in the workspace since it was copied in is left alone and named, never overwritten; so is
  // anything outside what the brief named or let the provider change (`skip` says why).
  copyBack(skip: (path: string) => string | null = () => null): { copied: string[]; deleted: string[]; skipped: { path: string; why: string }[] } {
    const out = { copied: [] as string[], deleted: [] as string[], skipped: [] as { path: string; why: string }[] };
    const changes = this.recorded() ?? [];
    for (const c of changes) {
      const no = skip(c.path);
      if (no) { out.skipped.push({ path: c.path, why: no }); continue; }
      let dest: string;
      try { dest = this.#ws.resolve(c.path); } catch (e) { out.skipped.push({ path: c.path, why: (e as Error).message }); continue; }
      const base = join(this.baseline, c.path);
      const was = existsSync(base) ? sha256(readFileSync(base)) : null;
      const is = existsSync(dest) && lstatSync(dest).isFile() ? sha256(readFileSync(dest)) : null;
      if (was !== is) { out.skipped.push({ path: c.path, why: 'it changed in the workspace while the task ran' }); continue; }
      if (c.kind === 'deleted') {
        if (is !== null) unlinkSync(dest);
        out.deleted.push(c.path);
        continue;
      }
      const src = join(this.root, c.path);
      const data = existsSync(src) ? readFileSync(src) : null;
      if (!data || sha256(data) !== c.sha256) { out.skipped.push({ path: c.path, why: 'it changed in the task’s folder after the provider finished' }); continue; }
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
      out.copied.push(c.path);
    }
    writeFileSync(join(this.state, 'copied-back.json'), JSON.stringify({ ...out, at: new Date().toISOString() }));
    rmSync(this.root, { recursive: true, force: true });
    return out;
  }
}

// A unified diff of two texts, with two lines of context. The same function makes the evidence and
// checks it, so the verifier recomputes exactly what the report claims.
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');
  const ops = lineOps(a, b);
  if (ops.every((o) => o.op === ' ')) return '';
  const head = `--- ${before === null ? '/dev/null' : `a/${path}`}\n+++ ${after === null ? '/dev/null' : `b/${path}`}\n`;
  const CONTEXT = 2;
  const hunks: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.op === ' ') { i++; continue; }
    let start = Math.max(0, i - CONTEXT);
    let end = i;
    // Extend while changes are close together.
    for (let j = i; j < ops.length; j++) {
      if (ops[j]!.op !== ' ') end = j;
      else if (j - end > CONTEXT * 2) break;
    }
    const stop = Math.min(ops.length, end + CONTEXT + 1);
    const slice = ops.slice(start, stop);
    const aStart = ops.slice(0, start).filter((o) => o.op !== '+').length;
    const bStart = ops.slice(0, start).filter((o) => o.op !== '-').length;
    const aLen = slice.filter((o) => o.op !== '+').length;
    const bLen = slice.filter((o) => o.op !== '-').length;
    hunks.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@\n${slice.map((o) => `${o.op}${o.line}`).join('\n')}\n`);
    i = stop;
    start = stop;
  }
  return head + hunks.join('');
}

type Op = { op: ' ' | '-' | '+'; line: string };

// Longest common subsequence on lines; for very large files, a whole replacement instead.
function lineOps(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const mid: Op[] = [];
  if (am.length * bm.length > 4_000_000) {
    mid.push(...am.map((line) => ({ op: '-' as const, line })), ...bm.map((line) => ({ op: '+' as const, line })));
  } else {
    const n = am.length;
    const m = bm.length;
    const t: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) t[x]![y] = am[x] === bm[y] ? t[x + 1]![y + 1]! + 1 : Math.max(t[x + 1]![y]!, t[x]![y + 1]!);
    let x = 0;
    let y = 0;
    while (x < n && y < m) {
      if (am[x] === bm[y]) { mid.push({ op: ' ', line: am[x]! }); x++; y++; }
      else if (t[x + 1]![y]! >= t[x]![y + 1]!) { mid.push({ op: '-', line: am[x]! }); x++; }
      else { mid.push({ op: '+', line: bm[y]! }); y++; }
    }
    while (x < n) mid.push({ op: '-', line: am[x++]! });
    while (y < m) mid.push({ op: '+', line: bm[y++]! });
  }
  return [...a.slice(0, pre).map((line) => ({ op: ' ' as const, line })), ...mid, ...a.slice(a.length - suf).map((line) => ({ op: ' ' as const, line }))];
}
