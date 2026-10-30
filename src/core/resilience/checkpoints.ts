// Checkpoints (M7 amendment §1): restore points of the whole data home, kept on this machine. A
// checkpoint is a consistent snapshot of the database (VACUUM INTO) and a copy of every file in the
// home, the vault's key file and this node's identity included, with a sealed manifest in the
// nightly backups' format (backup.ts). It never leaves the machine, which is why it may hold what a
// backup may not; nightly backups and the standby's journal leave `checkpoints/` out.
//
// Where: <home>/checkpoints/<seq>-<slug>/ (folders 0700, files 0600), with nova.db, files/<rel> and
// manifest.json, exactly a backup's layout, so the same cleaning (cleanBackup) applies to both.
// The seal's key is <home>/checkpoints/.seal (0600): not in the vault, so a stopped home (the
// supervisor, before a release switch) can be checkpointed, and a restore can't lose it.
//
// Retention: the newest KEEP_AUTO automatic checkpoints, by sequence number and never by date; a
// named one stays until the person deletes it, and is never deleted to make room. A new checkpoint
// is complete (renamed into place) before any old one is pruned. A disk too full to take one
// refuses in plain words, and an automatic one that was needed stops what needed it.
//
// Forgetting holds here too: Backups.also cleans every checkpoint (and a restore that is staged);
// one that can't be cleaned is destroyed and reported.
//
// Restoring (tier 3, the hub's own screen) is staged, then applied when Nova next starts, before
// the database opens, by swapping folders (finishStaged): see `stageRestore` and `finishStaged`.
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db.ts';
import { cleanDbFile } from '../backups.ts';
import { CoreError } from '../errors.ts';
import type { Log } from '../log.ts';
import type { Ledger, LanedWorker, Task } from '../ledger.ts';
import type { Verifier } from '../verify.ts';
import type { Vault } from '../vault.ts';
import type { Route, Who } from '../api.ts';
import { ENVELOPE_VERSION, type Brief, type Report } from '../envelope.ts';
import { cleanBackup, sha256File, writeManifest, type ManifestFile } from './backup.ts';
import { safeRel } from './archive.ts';
import { carryOver, droppedDevices } from './restore.ts';
import { isNovaEntry } from './entries.ts';
import type { Restarter } from './restart.ts';

export const CHECKPOINTS_DIR = 'checkpoints';
export const KEEP_AUTO = 10;
export const NAME_MAX = 80;
// Named checkpoints are kept until deleted, so their number is capped: no device can fill the disk.
export const NAMED_MAX = 20;
export const RETENTION = `Nova keeps the newest ${KEEP_AUTO} automatic checkpoints, counted in the order they were taken, never by date, and every checkpoint you name until you delete it. A new checkpoint is complete before an old one is removed, and a named one is never removed to make room.`;

export type CheckpointKind = 'auto' | 'named';

export interface CheckpointManifest {
  v: 1;
  id: string;
  seq: number;
  name: string | null;
  kind: CheckpointKind;
  reason: string | null;
  at: string;
  nova_version: string;
  schema_version: number;
  migrations: { version: number; name: string; checksum: string }[];
  db: ManifestFile;
  files: ManifestFile[];
  total_bytes: number;
  excluded: string[];
  cleaned: { at: string; table: string; rows: number }[];
  seal?: string;
}

export interface CheckpointView {
  id: string; seq: number; name: string | null; kind: CheckpointKind; reason: string | null; label: string;
  at: string; nova_version: string; schema_version: number; bytes: number; size: string; files: number;
}

export type CheckpointFailure = 'disk-full' | 'failed';
export class CheckpointError extends CoreError {
  readonly kind: CheckpointFailure;
  constructor(kind: CheckpointFailure, message: string) {
    super('conflict', message);
    this.kind = kind;
  }
}

// Top-level names in the home that are never in a checkpoint, and why (shown in every manifest).
const SKIP_TOP: Record<string, string> = {
  checkpoints: 'checkpoints are never inside each other',
  backups: 'the pre-upgrade copies are kept separately',
  exports: 'exports are copies made on request',
  logs: 'Nova’s logs are for diagnosing this machine',
  kept: 'Nova’s own scratch',
  workers: 'workers’ scratch folders',
  'nova.pid': 'which process runs this home',
  '.git': 'the home’s git history stays as it is',
};
const DB_FILE = /^nova\.db/;
const TEMP = /\.(tmp|partial)$|\.nova-sync-\d+\.tmp$/;
const DIR = /^(\d{6,})-[a-z0-9-]{1,48}$/;
export const EXCLUDED = ['nova.db: copied as a consistent snapshot instead', ...Object.entries(SKIP_TOP).map(([p, why]) => `${p}: ${why}`), 'anything that isn’t Nova’s own (entries.ts): left as it is'];

const root = (home: string) => join(home, CHECKPOINTS_DIR);

// The home's files a checkpoint carries: Nova's own entries (entries.ts) but the names above, the
// database (snapshot) and temporary files. Files Nova didn't make are never in one. Links and
// sockets are never followed.
export function checkpointFiles(home: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries;
    try { entries = readdirSync(join(home, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (!isNovaEntry(e.name) || SKIP_TOP[e.name] || DB_FILE.test(e.name))) continue;
      if (TEMP.test(e.name)) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk('');
  return out;
}

// "4.2 MB", in the units a person reads.
export function humanSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const isFull = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOSPC' || /disk is full|SQLITE_FULL|ENOSPC/i.test((e as Error)?.message ?? '');

// The seal's key: made once, the person's alone, outside every checkpoint and every backup.
function sealKey(home: string, create: boolean): Buffer | null {
  const file = join(root(home), '.seal');
  try { return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex'); } catch { /* none yet */ }
  if (!create) return null;
  ensureRoot(home);
  try {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, randomBytes(32).toString('hex')); } finally { closeSync(fd); }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
}

function ensureRoot(home: string): string {
  const r = root(home);
  mkdirSync(r, { recursive: true, mode: 0o700 });
  chmodSync(r, 0o700);
  return r;
}

const slugOf = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'checkpoint';

export function cleanCheckpointName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!s) throw new CoreError('validation', 'A checkpoint you take yourself needs a name, so you can tell it apart later.');
  if (s.length > NAME_MAX) throw new CoreError('validation', `A checkpoint’s name can be up to ${NAME_MAX} characters.`);
  return s;
}

export interface TakeOptions {
  home: string;
  kind: CheckpointKind;
  name?: string | null;
  // Why Nova took it ("Before shipping …"), for an automatic one.
  reason?: string | null;
  version: string;
  // The open database (a running Nova); without it, the home's database file is opened (a stopped
  // home: the supervisor, before a release switch).
  db?: Db | null;
  now?: () => Date;
  // Free bytes where checkpoints go (tests); statfs otherwise.
  free?: (dir: string) => number | null;
}

// Takes one checkpoint now, then prunes automatic ones past KEEP_AUTO. Throws a CheckpointError
// when it can't; nothing half-made stays, and the old ones are untouched then.
export function takeCheckpoint(o: TakeOptions): CheckpointManifest {
  const now = o.now ?? (() => new Date());
  const name = o.kind === 'named' ? cleanCheckpointName(o.name) : null;
  const reason = o.kind === 'auto' ? String(o.reason ?? 'Taken by Nova') : (o.reason ?? null);
  const dbPath = join(o.home, 'nova.db');
  if (!o.db && !existsSync(dbPath)) throw new CheckpointError('failed', `${o.home} has no database to checkpoint.`);
  const r = ensureRoot(o.home);
  dropPartials(o.home);
  if (o.kind === 'named' && scanCheckpoints(o.home).found.filter((f) => f.manifest.kind === 'named').length >= NAMED_MAX) {
    throw new CheckpointError('failed', `You have ${NAMED_MAX} named checkpoints. Delete one to take another.`);
  }
  const key = sealKey(o.home, true)!;
  const files = checkpointFiles(o.home);

  // Room first: about the database and every file, with a margin. Refused in plain words.
  let need = 0;
  for (const s of ['', '-wal']) { try { need += statSync(dbPath + s).size; } catch { /* none */ } }
  for (const rel of files) { try { need += statSync(join(o.home, rel)).size; } catch { /* gone */ } }
  need = Math.ceil(need * 1.1) + 1_000_000;
  let free: number | null = null;
  try { free = o.free ? o.free(r) : (() => { const s = statfsSync(r); return Number(s.bavail) * Number(s.bsize); })(); } catch { free = null; }
  if (free !== null && free < need) {
    throw new CheckpointError('disk-full', `There isn’t enough free space on this disk for a checkpoint: it needs about ${humanSize(need)} and ${humanSize(free)} is free. Nova took none. Free some space, then try again.`);
  }

  const seq = nextSeq(r);
  const id = `${String(seq).padStart(6, '0')}-${slugOf(name ?? reason ?? 'checkpoint')}`;
  const partial = join(r, `.partial-${id}`);
  const at = now().toISOString();
  let manifest: CheckpointManifest;
  try {
    mkdirSync(join(partial, 'files'), { recursive: true, mode: 0o700 });
    chmodSync(partial, 0o700);
    chmodSync(join(partial, 'files'), 0o700);
    const snap = join(partial, 'nova.db');
    const vacuum = `VACUUM INTO '${snap.replaceAll("'", "''")}'`;
    if (o.db) o.db.raw.exec(vacuum);
    else {
      const d = new DatabaseSync(dbPath);
      try { d.exec('PRAGMA busy_timeout = 5000'); d.exec(vacuum); } finally { d.close(); }
    }
    chmodSync(snap, 0o600);
    const list: ManifestFile[] = [];
    for (const rel of files) {
      const dst = join(partial, 'files', rel);
      mkdirDeep(join(partial, 'files'), rel);
      try {
        copyFileSync(join(o.home, rel), dst, constants.COPYFILE_FICLONE);
        chmodSync(dst, 0o600);
      } catch (e) {
        // A file that went away while copying is simply not in it; anything else stops it.
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      list.push({ path: rel, sha256: sha256File(dst), bytes: statSync(dst).size });
    }
    const snapDb = new DatabaseSync(snap, { readOnly: true });
    let migrations: CheckpointManifest['migrations'] = [];
    try {
      if (snapDb.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get()) {
        migrations = snapDb.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as unknown as CheckpointManifest['migrations'];
      }
    } finally {
      snapDb.close();
    }
    const dbFile = { path: 'nova.db', sha256: sha256File(snap), bytes: statSync(snap).size };
    manifest = {
      v: 1, id, seq, name, kind: o.kind, reason, at, nova_version: o.version,
      schema_version: migrations.at(-1)?.version ?? 0, migrations, db: dbFile, files: list,
      total_bytes: dbFile.bytes + list.reduce((n, f) => n + f.bytes, 0), excluded: EXCLUDED, cleaned: [],
    };
    writeManifest(partial, manifest as never, key);
    renameSync(partial, join(r, id));
  } catch (e) {
    rmSync(partial, { recursive: true, force: true });
    if (isFull(e)) throw new CheckpointError('disk-full', `The disk filled up while Nova took a checkpoint, so it stopped and kept none. Your earlier checkpoints are untouched. Free some space, then try again.`);
    throw new CheckpointError('failed', `Nova couldn’t take a checkpoint: ${(e as Error).message}. Your earlier checkpoints are untouched.`);
  }
  // Only now, with the new one complete: the oldest automatic ones past the limit go.
  pruneCheckpoints(o.home);
  return manifest;
}

// What a checkpoint stopped part-way left behind: never used, and never kept holding data. Removed
// at every start, before every checkpoint and before every forget.
export function dropPartials(home: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(root(home)); } catch { return out; }
  for (const e of names) if (e.startsWith('.partial-')) { rmSync(join(root(home), e), { recursive: true, force: true }); out.push(e); }
  return out;
}

function mkdirDeep(base: string, rel: string): void {
  const parts = rel.split('/').slice(0, -1);
  let at = base;
  for (const p of parts) {
    at = join(at, p);
    if (!existsSync(at)) mkdirSync(at, { mode: 0o700 });
  }
}

function nextSeq(r: string): number {
  let max = 0;
  for (const e of readdirSync(r)) { const m = /^(?:\.partial-)?(\d{6,})-/.exec(e); if (m) max = Math.max(max, Number(m[1])); }
  // The highest number ever used, so a deleted newest one's number isn't given out again.
  try { max = Math.max(max, Number(readFileSync(join(r, '.seq'), 'utf8')) || 0); } catch { /* none yet */ }
  writeFileSync(join(r, '.seq'), String(max + 1), { mode: 0o600 });
  return max + 1;
}

interface Found { path: string; manifest: CheckpointManifest }

// Nova's own checkpoints (sealed, named as their manifest says), newest first by sequence, and
// anything else in the folder named like one (strays: never restored, never pruned).
export function scanCheckpoints(home: string): { found: Found[]; strays: string[] } {
  const r = root(home);
  const found: Found[] = [];
  const strays: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(r); } catch { return { found, strays }; }
  const key = sealKey(home, false);
  for (const e of names) {
    const m = DIR.exec(e);
    if (!m) continue;
    const path = join(r, e);
    let manifest: CheckpointManifest | null = null;
    try { manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as CheckpointManifest; } catch { /* below */ }
    if (manifest && key && manifest.id === e && manifest.seq === Number(m[1]) && sealedBy(manifest, key)) found.push({ path, manifest });
    else strays.push(path);
  }
  return { found: found.sort((a, b) => b.manifest.seq - a.manifest.seq), strays };
}

function sealedBy(m: CheckpointManifest, key: Buffer): boolean {
  const { seal, ...rest } = m;
  if (typeof seal !== 'string' || !/^[0-9a-f]{64}$/.test(seal)) return false;
  // The same seal as a nightly backup's manifest (backup.ts writeManifest).
  const want = createHmac('sha256', key).update(JSON.stringify(rest)).digest();
  return timingSafeEqual(want, Buffer.from(seal, 'hex'));
}

export function viewOf(m: CheckpointManifest): CheckpointView {
  return {
    id: m.id, seq: m.seq, name: m.name, kind: m.kind, reason: m.reason, label: m.name ?? m.reason ?? 'Checkpoint',
    at: m.at, nova_version: m.nova_version, schema_version: m.schema_version, bytes: m.total_bytes, size: humanSize(m.total_bytes), files: m.files.length,
  };
}

export function listCheckpoints(home: string): CheckpointView[] {
  return scanCheckpoints(home).found.map((f) => viewOf(f.manifest));
}

// Automatic checkpoints past the newest KEEP_AUTO, by sequence number. Named ones and strays stay.
export function pruneCheckpoints(home: string): string[] {
  const autos = scanCheckpoints(home).found.filter((f) => f.manifest.kind === 'auto');
  const removed: string[] = [];
  for (const f of autos.slice(KEEP_AUTO)) { rmSync(f.path, { recursive: true, force: true }); removed.push(f.manifest.id); }
  return removed;
}

export function findCheckpoint(home: string, id: string): Found {
  const f = scanCheckpoints(home).found.find((x) => x.manifest.id === id);
  if (!f) throw new CoreError('not_found', 'There is no such checkpoint.');
  return f;
}

// Every hash in the manifest, read back from disk: the database and each file. Throws, naming the
// first that differs, when the checkpoint isn't exactly what was taken (or cleaned since).
export function verifyCheckpoint(f: Found): { db: string; files: number; bytes: number } {
  const m = f.manifest;
  const db = join(f.path, 'nova.db');
  if (!existsSync(db) || sha256File(db) !== m.db.sha256) throw new CoreError('conflict', `The checkpoint “${viewOf(m).label}” is damaged: its database isn’t what was taken. Nova won’t restore it.`);
  for (const file of m.files) {
    const p = join(f.path, 'files', safeRel(file.path));
    if (!existsSync(p) || !lstatSync(p).isFile() || sha256File(p) !== file.sha256) throw new CoreError('conflict', `The checkpoint “${viewOf(m).label}” is damaged: ${file.path} isn’t what was taken. Nova won’t restore it.`);
  }
  return { db: m.db.sha256, files: m.files.length, bytes: m.total_bytes };
}

// A forget, carried into every checkpoint (and a restore that is staged). One that can't be
// cleaned is destroyed; `destroyed` names it so the caller reports it.
export function forgetInCheckpoints(home: string, table: string, ids: string[], words: string[], at: Date): { cleaned: string[]; destroyed: string[] } {
  const cleaned: string[] = [];
  const destroyed: string[] = [];
  // A half-taken checkpoint holds a whole copy of the database and no manifest to clean by: it goes.
  dropPartials(home);
  if (!ids.length) return { cleaned, destroyed };
  const key = sealKey(home, false);
  const { found, strays } = scanCheckpoints(home);
  for (const f of found) {
    try {
      cleanBackup(f.path, table, ids, words, at, key!);
      cleaned.push(f.path);
    } catch {
      rmSync(f.path, { recursive: true, force: true });
      destroyed.push(f.path);
    }
  }
  // A stray can't be told from a checkpoint someone changed: it holds whatever it holds, so it goes.
  for (const s of strays) {
    try { cleanDbFile(join(s, 'nova.db'), table, ids, words); } catch { rmSync(s, { recursive: true, force: true }); destroyed.push(s); }
  }
  const staged = join(root(home), RESTORE_DIR, 'new');
  if (existsSync(staged)) {
    try {
      cleanDbFile(join(staged, 'nova.db'), table, ids, words);
      cleanTextTree(staged, words);
      cleaned.push(staged);
    } catch {
      // A staged restore that can't be cleaned doesn't happen: Nova starts on the home as it is.
      rmSync(join(root(home), RESTORE_DIR), { recursive: true, force: true });
      destroyed.push(staged);
    }
  }
  return { cleaned, destroyed };
}

// Lines carrying the words go from every text file under `dir` (a staged restore's files).
function cleanTextTree(dir: string, words: string[]): void {
  const ws = words.map((w) => w.trim()).filter((w) => w.length >= 3);
  if (!ws.length) return;
  for (const rel of checkpointFiles(dir)) {
    const p = join(dir, rel);
    const raw = readFileSync(p);
    if (!ws.some((w) => raw.includes(Buffer.from(w)))) continue;
    if (raw.includes(0)) throw new Error(`${rel} holds forgotten words and isn’t text.`);
    let text = raw.toString('utf8').split('\n').filter((line) => !ws.some((w) => line.includes(w))).join('\n');
    for (const w of ws) text = text.split(w).join('');
    writeFileSync(p, text);
  }
}

export function deleteCheckpoint(home: string, id: string): CheckpointView {
  const f = findCheckpoint(home, id);
  if (f.manifest.kind !== 'named') throw new CoreError('conflict', `Nova manages its automatic checkpoints itself (the newest ${KEEP_AUTO} are kept). You can delete the ones you named.`);
  rmSync(f.path, { recursive: true, force: true });
  return viewOf(f.manifest);
}

// ---- restoring ------------------------------------------------------------------------------------

// The staged restore: <home>/checkpoints/.restore/{marker.json, new/, old/}. `new` is the home as
// it will be (the checkpoint with what is carried over from now), laid out like the home itself.
export const RESTORE_DIR = '.restore';
const MARKER = 'marker.json';
// What a restore never swaps: they stay as they are now (the checkpoints themselves among them).
const STAYS = new Set(Object.keys(SKIP_TOP));

export interface RestoreMarker {
  v: 1;
  id: string;
  state: 'staged' | 'swapped';
  at: string;
  checkpoint: { id: string; label: string; at: string; kind: CheckpointKind };
  verified: { db: string; files: number; bytes: number; seal: string };
  before: string | null;
  carried: Carried;
  // The top-level names the staged home has: the swap's plan, fixed when it was staged.
  names: string[];
}

export interface Carried {
  revoked: { id: string; name: string }[];
  dropped: { id: string; name: string; kind: string }[];
  epoch: { now: number; checkpoint: number; restored: number };
  standby_resync: boolean;
  problems: { carried: number; resolved: number };
  forgotten: { memories: number; capture: number };
  sessions_ended: number;
  backup_records: number;
  identity: string;
  vault: string;
}

export function stagedPending(home: string): boolean {
  return existsSync(join(root(home), RESTORE_DIR, MARKER));
}

export function readMarker(home: string): RestoreMarker | null {
  try { return JSON.parse(readFileSync(join(root(home), RESTORE_DIR, MARKER), 'utf8')) as RestoreMarker; } catch { return null; }
}

function writeMarker(home: string, m: RestoreMarker): void {
  const file = join(root(home), RESTORE_DIR, MARKER);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

// The staged copy of the home (the checkpoint as it was taken), before what is carried over goes in.
export function stageCopy(home: string, f: Found): string {
  const dir = join(ensureRoot(home), RESTORE_DIR);
  rmSync(dir, { recursive: true, force: true });
  const out = join(dir, 'new');
  mkdirSync(out, { recursive: true, mode: 0o700 });
  for (const file of f.manifest.files) {
    const rel = safeRel(file.path);
    // A checkpoint from before entries.ts may hold files that aren't Nova's: those are never put back.
    if (!isNovaEntry(rel.split('/')[0]!)) continue;
    mkdirDeep(out, rel);
    copyFileSync(join(f.path, 'files', rel), join(out, rel), constants.COPYFILE_FICLONE);
  }
  copyFileSync(join(f.path, 'nova.db'), join(out, 'nova.db'));
  return out;
}

// Seals the staging: from here the restore happens at the next start, whatever stops in between.
export function writeStaged(home: string, m: Omit<RestoreMarker, 'v' | 'state' | 'names'>): RestoreMarker {
  const out = join(root(home), RESTORE_DIR, 'new');
  const marker: RestoreMarker = { v: 1, state: 'staged', names: readdirSync(out).filter(isNovaEntry).sort(), ...m };
  writeMarker(home, marker);
  return marker;
}

export function dropStaged(home: string): void {
  rmSync(join(root(home), RESTORE_DIR), { recursive: true, force: true });
}

// Applies a staged restore, before the database opens: each top-level entry of the home moves
// aside into .restore/old, and the staged one moves in, by rename (one disk, so each move is whole).
// Every step can be done again: a start after a crash part-way picks up where it stopped, so Nova
// only ever opens the home as it was or as restored, never a mix. Returns the restore's record
// once it is applied (also kept as checkpoints/restores/<id>.json, the ledger task's evidence),
// or null when nothing was staged.
export function finishStaged(home: string, o: { interrupt?: (step: number, what: 'aside' | 'in') => void } = {}): RestoreMarker | null {
  const m = readMarker(home);
  if (!m) {
    // A staging that never got its marker (stopped while copying) is dropped: nothing was promised.
    if (existsSync(join(root(home), RESTORE_DIR))) dropStaged(home);
    return null;
  }
  const dir = join(root(home), RESTORE_DIR);
  const neu = join(dir, 'new');
  const old = join(dir, 'old');
  if (m.state === 'staged') {
    mkdirSync(old, { recursive: true, mode: 0o700 });
    let step = 0;
    const tick = (what: 'aside' | 'in') => { step++; o.interrupt?.(step, what); };
    const incoming = new Set(m.names);
    // What of Nova's isn't in the restored home goes aside first (the database's WAL and SHM among
    // them). What isn't Nova's is never moved.
    for (const n of readdirSync(home).sort((a, b) => (/^nova\.db-/.test(b) ? 1 : 0) - (/^nova\.db-/.test(a) ? 1 : 0))) {
      if (!isNovaEntry(n) || STAYS.has(n) || incoming.has(n)) continue;
      if (existsSync(join(old, n))) rmSync(join(old, n), { recursive: true, force: true });
      renameSync(join(home, n), join(old, n));
      tick('aside');
    }
    for (const n of m.names) {
      if (!existsSync(join(neu, n))) continue; // moved in already
      if (existsSync(join(home, n))) {
        rmSync(join(old, n), { recursive: true, force: true });
        renameSync(join(home, n), join(old, n));
        tick('aside');
      }
      renameSync(join(neu, n), join(home, n));
      tick('in');
    }
    m.state = 'swapped';
    writeMarker(home, m);
  }
  // The record, then the leftovers: the home as it was is in the "before" checkpoint already.
  const records = join(root(home), 'restores');
  mkdirSync(records, { recursive: true, mode: 0o700 });
  writeFileSync(join(records, `${m.id}.json`), `${JSON.stringify({ ...m, finished_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  dropStaged(home);
  return m;
}

export function restoreRecord(home: string, id: string): (RestoreMarker & { finished_at: string }) | null {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try { return JSON.parse(readFileSync(join(root(home), 'restores', `${id}.json`), 'utf8')); } catch { return null; }
}

// Restores finished but not yet recorded in the ledger (the ledger task is made once the core is up).
export function unrecordedRestores(home: string, recorded: (id: string) => boolean): (RestoreMarker & { finished_at: string })[] {
  let names: string[] = [];
  try { names = readdirSync(join(root(home), 'restores')); } catch { return []; }
  return names.map((n) => restoreRecord(home, n.replace(/\.json$/, ''))).filter((r): r is RestoreMarker & { finished_at: string } => !!r && !recorded(r.id));
}

export const newRestoreId = () => randomUUID();
export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---- the service: what the core and its routes use -------------------------------------------------

export const WORKER_ID = 'checkpoints';
export const CONFIRMATION_SYSTEM = 'nova-checkpoints';

export interface CheckpointsOptions {
  db: Db;
  log: Log;
  home: string;
  version: string;
  now: () => Date;
  ledger: Ledger;
  verifier: Verifier;
  vault: Vault;
  vaultAt: (home: string) => Vault;
  hubId: () => string;
  role: () => 'hub' | 'standby';
  // The newest database version this code knows: a checkpoint from a newer Nova isn't restored.
  schema: () => number;
  restarter: Restarter;
  free?: (dir: string) => number | null;
}

export class Checkpoints {
  readonly worker: LanedWorker;
  #o: CheckpointsOptions;

  constructor(o: CheckpointsOptions) {
    this.#o = o;
    this.worker = this.#makeWorker();
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e) => this.#confirm(e as { id?: string }));
  }

  take(o: { kind: CheckpointKind; name?: string | null; reason?: string | null }): CheckpointView {
    const m = takeCheckpoint({ home: this.#o.home, db: this.#o.db, version: this.#o.version, now: this.#o.now, ...(this.#o.free ? { free: this.#o.free } : {}), ...o });
    this.#o.log.info('resilience', m.kind === 'named' ? 'Checkpoint taken.' : 'Automatic checkpoint taken.', { id: m.id, reason: m.reason });
    return viewOf(m);
  }

  // An automatic checkpoint before something that needs one; throws (CheckpointError) when it can't,
  // and the caller stops.
  auto(reason: string): CheckpointView {
    return this.take({ kind: 'auto', reason });
  }

  list(): CheckpointView[] {
    return listCheckpoints(this.#o.home);
  }

  // Deleting data is tier 3 (NOVA-SPEC §6): the hub's own screen, confirmed every time.
  remove(id: string, o: { confirm: boolean; who: Who }): CheckpointView {
    if (o.who.principal.kind !== 'console') throw new CoreError('forbidden', 'Deleting a checkpoint is done from the hub’s own screen only.');
    if (!o.confirm) throw new CoreError('validation', 'Deleting a checkpoint can’t be undone: it needs your explicit confirmation every time (confirm: true).');
    const v = deleteCheckpoint(this.#o.home, id);
    this.#o.log.info('resilience', 'Checkpoint deleted.', { id });
    return v;
  }

  // Backups.also: every forget reaches each checkpoint; one that couldn't be cleaned was destroyed,
  // and the person is told.
  forget(table: string, ids: string[], words: string[]): { cleaned: string[]; destroyed: string[] } {
    const r = forgetInCheckpoints(this.#o.home, table, ids, words, this.#o.now());
    for (const p of r.destroyed) this.#o.log.problem('backups', 'A checkpoint couldn’t be cleaned of something you asked Nova to forget, so Nova deleted that checkpoint rather than keep it.', { detail: p });
    return r;
  }

  // What the confirmation says before a restore: the checkpoint's date, that everything since is
  // undone, that a checkpoint of now is taken first, and which devices would need pairing again.
  preview(id: string) {
    const f = findCheckpoint(this.#o.home, id);
    const v = viewOf(f.manifest);
    const dropped = droppedDevices(join(f.path, 'nova.db'), this.#o.db, this.#o.hubId());
    return {
      checkpoint: v,
      said: [
        `Nova goes back to how it was on ${v.at} (“${v.label}”).`,
        'Everything since then is undone: tasks, memories, settings and changes.',
        'Nova takes a checkpoint of now first, so you can come back to this.',
        'Devices you removed stay removed, anything you asked Nova to forget stays forgotten, and open problems stay listed.',
        'Files in this folder that aren’t Nova’s are left as they are.',
        ...(dropped.length ? [`${dropped.map((d) => `“${d.name}”`).join(', ')} ${dropped.length === 1 ? 'was' : 'were'} paired since then and will need pairing again.`] : []),
        'Nova restarts by itself; you don’t need to do anything.',
      ],
      dropped,
      from: 'console' as const,
    };
  }

  // Tier 3, from the hub's own screen, confirmed every time. Verifies the checkpoint, stages it
  // with what is carried over from now, takes a checkpoint of now, then restarts Nova, which applies
  // it before its database opens.
  async restore(id: string, o: { confirm: boolean; who: Who }) {
    if (o.who.principal.kind !== 'console') throw new CoreError('forbidden', 'Restoring a checkpoint is done from the hub’s own screen only.');
    if (!o.confirm) throw new CoreError('validation', 'Restoring rolls Nova back and undoes everything since: it needs your explicit confirmation every time (confirm: true).');
    if (this.#o.role() !== 'hub') throw new CoreError('conflict', 'This node is a standby; restore on the hub.');
    if (stagedPending(this.#o.home)) throw new CoreError('conflict', 'A restore is already waiting for Nova to restart.');
    const f = findCheckpoint(this.#o.home, id);
    const v = viewOf(f.manifest);
    if (f.manifest.schema_version > this.#o.schema()) throw new CoreError('conflict', `“${v.label}” was taken by a newer version of Nova (database version ${f.manifest.schema_version}); this one can’t open it.`);
    const verified = verifyCheckpoint(f);
    const staged = stageCopy(this.#o.home, f);
    let before: CheckpointView;
    let marker: RestoreMarker;
    try {
      before = this.auto(`Before restoring to “${v.label}”`);
      const carried = carryOver({ home: this.#o.home, staged, live: this.#o.db, hubId: this.#o.hubId(), now: this.#o.now(), vault: this.#o.vault, vaultAt: this.#o.vaultAt });
      marker = writeStaged(this.#o.home, {
        id: newRestoreId(), at: this.#o.now().toISOString(),
        checkpoint: { id: v.id, label: v.label, at: v.at, kind: v.kind },
        verified: { ...verified, seal: f.manifest.seal ?? '' }, before: before.id, carried,
      });
    } catch (e) {
      dropStaged(this.#o.home);
      if (e instanceof CheckpointError) throw new CoreError('conflict', `Nova didn’t restore: it couldn’t take a checkpoint of now first. ${e.message}`);
      throw e;
    }
    this.#o.log.info('resilience', 'Restore staged.', { id: marker.id, checkpoint: v.id, before: before.id });
    let restart: { how: string; said: string };
    try { restart = await this.#o.restarter.restartInPlace(`restore to ${v.id}`); } catch (e) { restart = { how: 'next-start', said: (e as Error).message }; }
    return { restoring: true, id: marker.id, checkpoint: v, before, carried: marker.carried, verified: marker.verified, restart };
  }

  // Restores finished at this start: each becomes a ledger task with its evidence (once).
  recordFinished(): Task[] {
    const out: Task[] = [];
    for (const r of unrecordedRestores(this.#o.home, (id) => !!this.#o.db.get('SELECT 1 FROM task WHERE idempotency_key = ?', `restore:${id}`))) {
      out.push(this.#o.ledger.create({
        title: `Restore to “${r.checkpoint.label}”`,
        owner: WORKER_ID,
        goal: `Put Nova back to the checkpoint “${r.checkpoint.label}” (${r.checkpoint.at}), keeping revocations, forgets, problems and the mesh epoch from now.`,
        origin: { kind: 'user' },
        evidence_required: [{ kind: 'confirmation', note: 'the checkpoint’s hashes, verified before applying, and what was carried over' }],
        approval_tier: 0,
        privacy_mode: 'local-only',
        user_visibility: 'attention',
        idempotency_key: `restore:${r.id}`,
        inputs: { action: 'restore', restore_id: r.id, checkpoint: r.checkpoint, verified: r.verified, before: r.before, carried: r.carried, confirmed: 'tier 3, on the hub’s own screen' },
      }));
    }
    if (out.length) void this.#o.ledger.pump();
    return out;
  }

  #makeWorker(): LanedWorker {
    return {
      id: WORKER_ID, name: 'Checkpoints', about: 'Records a restore to a checkpoint, with what it verified and what it carried over. On this machine only.', egress: 'none', evidence: ['confirmation'],
      timeoutMs: 60_000,
      lane: () => ({ key: 'checkpoints', max: 1 }),
      health: () => ({ ok: true }),
      run: async (brief: Brief): Promise<Report> => {
        const id = String((brief.inputs as { restore_id?: string } | undefined)?.restore_id ?? '');
        const r = restoreRecord(this.#o.home, id);
        const base = { envelope: ENVELOPE_VERSION as typeof ENVELOPE_VERSION, task_id: brief.task_id, artifacts: [] as Report['artifacts'], follow_up_suggestions: [] as string[], usage: { duration_ms: 0 } };
        if (!r) return { ...base, status: 'failed', summary: 'Nova has no record of that restore.', evidence: [], blockers: [] };
        const c = r.carried;
        const parts = [
          `Restored “${r.checkpoint.label}” (${r.checkpoint.at}) after checking its database and ${r.verified.files} files against their hashes.`,
          c.revoked.length ? `${c.revoked.length} revoked ${c.revoked.length === 1 ? 'device stays' : 'devices stay'} revoked.` : '',
          c.dropped.length ? `${c.dropped.map((d) => `“${d.name}”`).join(', ')} need${c.dropped.length === 1 ? 's' : ''} pairing again.` : '',
          `The mesh epoch is ${c.epoch.restored}${c.standby_resync ? ', and the standby copies the hub afresh' : ''}.`,
          `${c.problems.carried} problem${c.problems.carried === 1 ? '' : 's'} carried over.`,
          r.before ? `A checkpoint of how Nova was just before is kept (${r.before}).` : '',
        ];
        return { ...base, status: 'done', summary: parts.filter(Boolean).join(' '), evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `restore:${r.id}` }], blockers: [] };
      },
    };
  }

  // Nova reads it back itself: its record of the restore, the checkpoint's manifest (when it is
  // still there and uncleaned) and the mesh epoch it set.
  #confirm(e: { id?: string }): { ok: boolean; why: string } {
    const m = /^restore:([0-9a-f-]{36})$/.exec(e.id ?? '');
    if (!m) return { ok: false, why: 'Not a confirmation the checkpoints worker gives.' };
    const r = restoreRecord(this.#o.home, m[1]!);
    if (!r) return { ok: false, why: 'Nova has no record of that restore.' };
    const epoch = this.#o.db.get<{ epoch: number }>('SELECT epoch FROM mesh_state WHERE id = 1')?.epoch ?? 0;
    if (epoch < r.carried.epoch.restored) return { ok: false, why: `The mesh epoch is ${epoch}, lower than the restore set (${r.carried.epoch.restored}).` };
    const f = scanCheckpoints(this.#o.home).found.find((x) => x.manifest.id === r.checkpoint.id);
    const same = f && !f.manifest.cleaned.length ? f.manifest.db.sha256 === r.verified.db : null;
    if (same === false) return { ok: false, why: 'The checkpoint’s manifest doesn’t name the database Nova verified.' };
    return { ok: true, why: `Nova read its record of the restore: “${r.checkpoint.label}”, database ${r.verified.db.slice(0, 12)}… and ${r.verified.files} files verified before applying${same ? ' (the checkpoint’s sealed manifest agrees)' : ''}; the mesh epoch is ${epoch}.` };
  }

  view(who: Who) {
    const marker = readMarker(this.#o.home);
    return {
      checkpoints: this.list(),
      retention: { keep_auto: KEEP_AUTO, rule: RETENTION },
      can_restore: who.principal.kind === 'console',
      restoring: marker ? { checkpoint: marker.checkpoint, at: marker.at } : null,
      strays: scanCheckpoints(this.#o.home).strays.length,
    };
  }

  routes(): Route[] {
    return [
      { method: 'GET', path: '/resilience/checkpoints', summary: `Checkpoints, newest first: each one’s name or reason, kind (auto or named), date, size and Nova version, and the retention rule. ${RETENTION}`, handle: ({ who }) => this.view(who) },
      {
        method: 'POST', path: '/resilience/checkpoints', status: 201, summary: `Take a named checkpoint of Nova’s own entries in the home now (tier 1). The name is up to ${NAME_MAX} characters; at most ${NAMED_MAX} named ones are kept.`, body: '{name}',
        handle: ({ body }) => this.take({ kind: 'named', name: body.name as string }),
      },
      {
        method: 'POST', path: '/resilience/checkpoints/{id}/delete', summary: 'Delete a checkpoint you named (tier 3: {confirm: true}, the hub’s own screen only). Automatic ones are kept by the retention rule.', body: '{confirm}',
        handle: ({ params, body, who }) => this.remove(params.id!, { confirm: body.confirm === true, who }),
      },
      { method: 'GET', path: '/resilience/checkpoints/{id}/restore', summary: 'What restoring this checkpoint would do, in the words the confirmation shows.', handle: ({ params }) => this.preview(params.id!) },
      {
        method: 'POST', path: '/resilience/checkpoints/{id}/restore', status: 202, summary: 'Restore this checkpoint (tier 3: {confirm: true}, the hub’s own screen only). A checkpoint of now is taken first; revocations, forgets, problems and the mesh epoch are kept from now. Nova restarts by itself and applies it before its database opens.', body: '{confirm}',
        handle: ({ params, body, who }) => this.restore(params.id!, { confirm: body.confirm === true, who }),
      },
    ];
  }
}
