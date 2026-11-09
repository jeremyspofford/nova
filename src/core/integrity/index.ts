// The integrity scrub and disk-health signals (Amendment 2026-10-31-B Part 6; plan
// docs/plans/integrity-scrub.md). One read-only pass over Nova's own data home, built for the
// request that asked, kept nowhere, sent nowhere.
//
// THE RULE (inherited from diagnostics): metadata only, redacted by construction. Every string in
// the result is a fixed word or sentence from this file with numbers put in; no path, file name,
// checkpoint name or id, device name, or SQLite message text ever reaches it. Findings use the
// existing problem model's fields (log.ts `Problem`: source, message, detail, stops) and are
// returned, never stored: storing one would be a write.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, statfsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { CoreError } from '../errors.ts';
import type { Problem } from '../log.ts';
import type { Route } from '../api.ts';
import { CHECKPOINTS_DIR, scanCheckpoints, stagedPending } from '../resilience/checkpoints.ts';
import { RESET_MARKER } from '../resilience/reset.ts';
import { safeRel } from '../resilience/archive.ts';
import { isNovaEntry } from '../resilience/entries.ts';
import type { DbCheckInput, DbCheckResult, FindingKind } from './worker.ts';

export const TIME_MS = 10_000;
export const IO_BYTES = 256 * 1024 * 1024;
export const COOLDOWN_MS = 60_000;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
export const DISK = { stopsBytes: 512 * MiB, warnBytes: 2 * GiB, warnRatio: 0.05, stopsInodeRatio: 0.01, stopsInodes: 1_000, warnInodeRatio: 0.05 };

// A promotion record in one of these states is moving the hub between machines (mesh/handover.ts).
export const PROMOTION_IN_FLIGHT: ReadonlySet<string> = new Set(['checking', 'catching-up', 'draining', 'holding', 'transferring', 'verifying', 'rolling-back', 'staged']);

export type Finding =Pick<Problem, 'source' | 'message' | 'detail' | 'stops'>;
export type CheckState = 'ok' | 'problem' | 'unfinished' | 'partial' | 'unavailable' | 'stopped' | 'none';

export interface StatFs { bavail: number | bigint; bsize: number | bigint; blocks: number | bigint; files: number | bigint; ffree: number | bigint }

export interface ScrubOptions {
  home: string;
  full?: boolean;
  timeMs?: number;
  ioBytes?: number;
  now?: () => number;
  // What else is writing heavily (a promotion in flight), from Core; the home-based guards are here.
  busy?: () => string | null;
  // Injected in tests: the disk's numbers, the root that holds /proc and /sys, the worker module.
  statfs?: (dir: string) => StatFs;
  sysRoot?: string;
  worker?: URL;
}

const n = (v: number | bigint) => Number(v);
const size = (b: number) => (b >= GiB ? `${(b / GiB).toFixed(1)} GB` : `${Math.max(0, Math.round(b / MiB))} MB`);
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const find = (message: string, stops: 0 | 1): Finding => ({ source: 'integrity', message, detail: null, stops });

// What is writing heavily in this home, in plain words, or null. Read-only: existence checks only.
export function homeBusy(home: string): string | null {
  if (existsSync(join(home, RESET_MARKER))) return 'A factory reset is staged; Nova doesn’t check its data while one is waiting.';
  if (stagedPending(home)) return 'A checkpoint restore is staged; Nova checks its data again after it has restarted.';
  try {
    if (readdirSync(join(home, CHECKPOINTS_DIR)).some((e) => e.startsWith('.partial-'))) return 'A checkpoint is being written right now; try again when it has finished.';
  } catch { /* no checkpoints yet */ }
  return null;
}

// ---- the database, in a worker the bound can stop ----
async function databaseCheck(o: ScrubOptions, deadline: number, now: () => number) {
  const started = now();
  const input: DbCheckInput = { path: join(o.home, 'nova.db'), full: !!o.full };
  const left = Math.max(0, deadline - started);
  const w = new Worker(o.worker ?? new URL('./worker.ts', import.meta.url), { workerData: input });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const r = await new Promise<DbCheckResult | 'timeout' | 'failed'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), left);
      w.once('message', (m: DbCheckResult) => resolve(m));
      w.once('error', () => resolve('failed'));
      w.once('exit', () => resolve('failed'));
    });
    const ms = now() - started;
    const mode = o.full ? 'integrity_check' : 'quick_check';
    if (r === 'timeout') return { state: 'unfinished' as CheckState, mode, findings: 0, kinds: {}, ms };
    if (r === 'failed') return { state: 'unavailable' as CheckState, mode, why: 'error', findings: 0, kinds: {}, ms };
    return { state: r.state as CheckState, mode, why: r.why, findings: r.findings, kinds: r.kinds as Partial<Record<FindingKind, number>>, ms };
  } finally {
    clearTimeout(timer);
    await w.terminate();
  }
}

async function hashFile(path: string, deadline: number, now: () => number): Promise<string | 'timeout'> {
  const h = createHash('sha256');
  const f = await open(path, 'r');
  try {
    const buf = Buffer.alloc(MiB);
    for (let at = 0; ;) {
      if (now() >= deadline) return 'timeout';
      const { bytesRead } = await f.read(buf, 0, buf.length, at);
      if (bytesRead <= 0) break;
      h.update(buf.subarray(0, bytesRead));
      at += bytesRead;
    }
  } finally { await f.close(); }
  return h.digest('hex');
}

// ---- the newest sealed checkpoint against its own manifest, within the budget and the bound ----
export interface CheckpointCheck {
  state: CheckState; checkpoints?: number; strays?: number; checked?: number; of?: number; damaged?: number;
  damaged_in?: Record<string, number>; bytes?: number; stopped_by?: 'budget' | 'time'; ms?: number;
}
export interface DiskCheck {
  state: CheckState; free_bytes?: number; total_bytes?: number; free_ratio?: number; inodes_free?: number | null;
  inodes_total?: number | null; checkpoint_needs_bytes?: number;
}
export interface FsErrorsCheck { state: CheckState; fs?: string; errors?: number; why?: string }

async function checkpointCheck(o: ScrubOptions, deadline: number, now: () => number): Promise<CheckpointCheck> {
  const started = now();
  const budget = o.ioBytes ?? IO_BYTES;
  const { found, strays } = scanCheckpoints(o.home);
  const newest = found[0];
  if (!newest) return { state: 'none' as CheckState, checkpoints: 0, strays: strays.length, checked: 0, of: 0, damaged: 0, damaged_in: {}, bytes: 0, ms: now() - started };
  const m = newest.manifest;
  const items = [{ entry: 'nova.db', path: join(newest.path, 'nova.db'), sha256: m.db.sha256, bytes: m.db.bytes, rel: 'nova.db' }, ...m.files.map((f) => ({ entry: '', path: '', sha256: f.sha256, bytes: f.bytes, rel: f.path }))];
  let bytes = 0, checked = 0, damaged = 0, stoppedBy: 'budget' | 'time' | null = null;
  const damagedIn: Record<string, number> = {};
  for (const it of items) {
    if (bytes + it.bytes > budget) { stoppedBy = 'budget'; break; }
    if (now() >= deadline) { stoppedBy = 'time'; break; }
    let entry = it.entry, path = it.path, ok = false;
    try {
      if (!path) { const rel = safeRel(it.rel); const top = rel.split(/[\\/]/)[0] ?? ''; entry = isNovaEntry(top) ? top : 'other'; path = join(newest.path, 'files', rel); }
      if (existsSync(path) && statSync(path).isFile()) {
        const got = await hashFile(path, deadline, now);
        if (got === 'timeout') { stoppedBy = 'time'; break; }
        ok = got === it.sha256;
      }
    } catch { ok = false; entry ||= 'other'; }
    bytes += it.bytes;
    checked++;
    if (!ok) { damaged++; damagedIn[entry] = (damagedIn[entry] ?? 0) + 1; }
  }
  const state: CheckState = damaged ? 'problem' : stoppedBy ? 'partial' : 'ok';
  return { state, checkpoints: found.length, strays: strays.length, checked, of: items.length, damaged, damaged_in: damagedIn, bytes, ...(stoppedBy ? { stopped_by: stoppedBy } : {}), ms: now() - started };
}

// ---- free space and inodes on the home's volume ----
function diskCheck(o: ScrubOptions): { check: DiskCheck; findings: Finding[] } {
  let s: StatFs;
  try { s = (o.statfs ?? statfsSync)(o.home); } catch { return { check: { state: 'unavailable' }, findings: [] }; }
  const free = n(s.bavail) * n(s.bsize), total = n(s.blocks) * n(s.bsize);
  const inodes = n(s.files), inodesFree = n(s.ffree);
  // What a pre-upgrade checkpoint needs (takeCheckpoint's own rule): the database and its WAL.
  let dbBytes = 0;
  for (const x of ['', '-wal']) { try { dbBytes += statSync(join(o.home, `nova.db${x}`)).size; } catch { /* none */ } }
  const checkpointNeeds = Math.ceil(dbBytes * 1.1) + 1_000_000;
  const ratio = total > 0 ? free / total : 1;
  const inodeRatio = inodes > 0 ? inodesFree / inodes : 1;
  const findings: Finding[] = [];
  if (free < checkpointNeeds || free < DISK.stopsBytes) {
    findings.push(find(`The disk Nova keeps its data on has ${size(free)} free. That is too little for a checkpoint before an upgrade (about ${size(checkpointNeeds)}), so an upgrade would stop and new checkpoints are refused. Free some space.`, 1));
  } else if (free < DISK.warnBytes || ratio < DISK.warnRatio) {
    findings.push(find(`The disk Nova keeps its data on is getting full: ${size(free)} free (${Math.round(ratio * 100)}%). Free some space before it runs out.`, 0));
  }
  // A filesystem without fixed inodes reports zero of them: nothing to say then.
  if (inodes > 0) {
    if (inodeRatio < DISK.stopsInodeRatio || inodesFree < DISK.stopsInodes) findings.push(find(`The disk Nova keeps its data on has run out of room for new files (${plural(inodesFree, 'file slot')} left), so Nova can’t save new files. Delete some files.`, 1));
    else if (inodeRatio < DISK.warnInodeRatio) findings.push(find(`The disk Nova keeps its data on is running out of room for new files (${Math.round(inodeRatio * 100)}% left).`, 0));
  }
  const state: CheckState = findings.length ? 'problem' : 'ok';
  return { check: { state, free_bytes: free, total_bytes: total, free_ratio: Math.round(ratio * 1000) / 1000, inodes_free: inodes > 0 ? inodesFree : null, inodes_total: inodes > 0 ? inodes : null, checkpoint_needs_bytes: checkpointNeeds }, findings };
}

// ---- filesystem errors without root: ext4's own counter in sysfs ----
// /proc/self/mountinfo: the mount that holds the home (the longest mount point that prefixes it),
// its filesystem type and source device; then /sys/fs/ext4/<device>/errors_count.
const unescapeMount = (s: string) => s.replace(/\\([0-7]{3})/g, (_m, o: string) => String.fromCharCode(parseInt(o, 8)));
function fsErrorsCheck(o: ScrubOptions): FsErrorsCheck {
  if (process.platform !== 'linux' && !o.sysRoot) return { state: 'unavailable' as CheckState, why: 'Only Linux reports filesystem errors to a program without administrator rights.' };
  const root = o.sysRoot ?? '/';
  try {
    let home = o.home;
    try { home = realpathSync(o.home); } catch { /* as given */ }
    let best: { point: string; type: string; source: string } | null = null;
    for (const line of readFileSync(join(root, 'proc/self/mountinfo'), 'utf8').split('\n')) {
      const [left, right] = line.split(' - ');
      if (!left || !right) continue;
      const point = unescapeMount(left.split(' ')[4] ?? '');
      const [type = '', source = ''] = right.split(' ');
      const inside = point === '/' || home === point || home.startsWith(`${point}/`);
      if (inside && (!best || point.length >= best.point.length)) best = { point, type, source };
    }
    if (!best) return { state: 'unavailable' as CheckState, why: 'Nova couldn’t tell which filesystem holds its data.' };
    if (best.type !== 'ext4') return { state: 'unavailable' as CheckState, fs: /^[a-z0-9.]{1,16}$/.test(best.type) ? best.type : 'other', why: 'This filesystem doesn’t report its errors to a program without administrator rights; only ext4 does.' };
    const dev = best.source.replace(/^\/dev\//, '');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(dev)) return { state: 'unavailable' as CheckState, fs: 'ext4', why: 'Nova couldn’t find this filesystem’s error counter.' };
    const errors = Number(readFileSync(join(root, 'sys/fs/ext4', dev, 'errors_count'), 'utf8').trim());
    if (!Number.isFinite(errors)) return { state: 'unavailable' as CheckState, fs: 'ext4', why: 'Nova couldn’t read this filesystem’s error counter.' };
    return { state: (errors > 0 ? 'problem' : 'ok') as CheckState, fs: 'ext4', errors };
  } catch {
    return { state: 'unavailable' as CheckState, why: 'Nova couldn’t read this filesystem’s error counter.' };
  }
}

const SMART = { state: 'unavailable' as CheckState, why: 'Reading the disk’s own health (SMART) needs administrator rights, which Nova never has.' };

// One scrub. Throws CoreError('conflict') before reading anything when something is writing
// heavily; a guard that turns on mid-scrub skips the remaining checks as `stopped`.
export async function runScrub(o: ScrubOptions) {
  const now = o.now ?? (() => Date.now());
  const started = now();
  const deadline = started + (o.timeMs ?? TIME_MS);
  const busy = () => o.busy?.() ?? homeBusy(o.home);
  const first = busy();
  if (first) throw new CoreError('conflict', first);
  const database = await databaseCheck(o, deadline, now);
  const checkpoint: CheckpointCheck = busy() ? { state: 'stopped' } : await checkpointCheck(o, deadline, now);
  const disk = diskCheck(o);
  const fsErrors = fsErrorsCheck(o);

  const problems: Finding[] = [];
  if (database.state === 'problem') problems.push(find(database.why === 'unreadable'
    ? 'Nova’s database is damaged: SQLite can’t read it as a database. Restore a checkpoint or a backup.'
    : `Nova’s database is damaged: SQLite’s ${database.mode === 'integrity_check' ? 'integrity' : 'quick'} check found ${plural(database.findings, 'problem')}. Restore a checkpoint or a backup.`, 1));
  if (database.state === 'unfinished') problems.push(find(`Nova’s database check didn’t finish within ${Math.round((o.timeMs ?? TIME_MS) / 1000)} seconds, so its result is unknown. Try again when Nova is less busy.`, 0));
  if (checkpoint.state === 'problem') problems.push(find(`The newest checkpoint is damaged: ${plural(checkpoint.damaged ?? 0, 'file doesn’t', 'files don’t')} match what was taken. Nova won’t restore it; take a new checkpoint.`, 0));
  problems.push(...disk.findings);
  if (fsErrors.state === 'problem') problems.push(find(`The filesystem Nova keeps its data on has recorded ${plural(fsErrors.errors ?? 0, 'error')}. The disk may be failing: make sure your backups are current.`, 0));

  const checks = { database, checkpoint, disk: disk.check, fs_errors: fsErrors, smart: SMART };
  const incomplete = Object.entries(checks).filter(([, c]) => ['unfinished', 'partial', 'unavailable', 'stopped'].includes(c.state)).map(([k]) => k);
  return {
    format: 'nova-integrity', format_version: 1,
    ok: !Object.values(checks).some((c) => c.state === 'problem'),
    stops: problems.some((p) => p.stops === 1),
    checks, problems, incomplete,
    bounds: { time_ms: o.timeMs ?? TIME_MS, io_bytes: o.ioBytes ?? IO_BYTES, took_ms: now() - started },
    rule: 'Metadata only: states, counts and sizes. No path, file name, checkpoint name or content. Built for this request; nothing is kept or sent.',
  };
}

// Mounted by Core beside /diagnostics, at the same (person) access. One scrub at a time, and not
// again within the cool-down: each one reads the whole database.
export function integrityRoutes(run: (o: { full: boolean }) => ReturnType<typeof runScrub>, o: { cooldownMs?: number; now?: () => number } = {}): Route[] {
  const now = o.now ?? (() => Date.now());
  let running = false;
  let last = -Infinity;
  return [{
    method: 'GET', path: '/integrity',
    summary: 'The integrity scrub, read-only: SQLite’s quick check of Nova’s database (?full=1 for the full integrity check), the newest checkpoint against its own sealed manifest, free space and file slots on the disk, and filesystem errors where Linux reports them without administrator rights. States, counts and sizes only, within 10 seconds and 256 MB of reading. Built for this request; nothing is kept or sent. Refused while a restore, reset, checkpoint or handover is writing, while another scrub runs, or within a minute of the last.',
    handle: async ({ query }) => {
      if (running) throw new CoreError('conflict', 'An integrity check is already running.');
      const wait = last + (o.cooldownMs ?? COOLDOWN_MS) - now();
      if (wait > 0) throw new CoreError('conflict', `Nova checked its data a moment ago; try again in ${Math.ceil(wait / 1000)} seconds.`);
      running = true;
      // A refusal before anything was read (something writing) doesn't start the cool-down.
      let read = true;
      try { return await run({ full: query.get('full') === '1' }); }
      catch (e) { if (e instanceof CoreError) read = false; throw e; }
      finally { running = false; if (read) last = now(); }
    },
  }];
}
