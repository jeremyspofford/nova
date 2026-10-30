// Nightly backups of the hub (LOCAL-FIRST §5, M7 plan §3). A backup is a folder in a place the
// person names: a consistent snapshot of the database (VACUUM INTO, taken while Nova runs), the
// home's files, and a manifest with the content hash of every one of them, the schema version and
// the migration checksums, so a restore drill can tell whether what comes back is what went in.
//
// What never goes in: the vault's key and this node's private keys (mesh/identity.json): a backup
// that leaves the machine must not carry what opens everything. The vault's file goes in, still
// encrypted. The home's git history, logs, the pre-upgrade backups and Nova's scratch stay too.
//
// Retention keeps the newest N by sequence number, never by date, so a clock that jumped can't
// make Nova delete the wrong ones. A new backup is complete before any old one is removed. Nova
// never creates the backup folder: if it isn't there (a drive not mounted), it refuses.
//
// Forgetting holds here too (owner's standing order 4): every forget is carried into each backup
// and each encrypted copy, which is decrypted, cleaned and encrypted again; a copy that can't be
// cleaned is destroyed and that is reported.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import { cleanDbFile } from '../backups.ts';
import { CoreError } from '../errors.ts';
import { decryptTo, encryptDir, readHeader } from './archive.ts';

export interface BackupSettings { target: string | null; keep: number; encrypted_target: string | null }
export const DEFAULT_KEEP = 7;
export const KEY_NAME = 'nova/backup-key';

export interface ManifestFile { path: string; sha256: string; bytes: number }
export interface Manifest {
  v: 1;
  id: string;
  seq: number;
  at: string;
  nova_version: string;
  schema_version: number;
  migrations: { version: number; name: string; checksum: string }[];
  db: ManifestFile;
  files: ManifestFile[];
  excluded: string[];
  cleaned: { at: string; table: string; rows: number }[];
}

export interface BackupRun { id: string; seq: number; at: string; target: string; path: string | null; ok: boolean; bytes: number; files: number; encrypted_path: string | null; error: string | null; task_id: string | null }

// Why a backup didn't happen, for its playbook.
export type FailureKind = 'target-missing' | 'disk-full' | 'failed';
export class BackupError extends CoreError {
  readonly kind: FailureKind;
  constructor(kind: FailureKind, message: string) {
    super(kind === 'target-missing' ? 'not_found' : 'conflict', message);
    this.kind = kind;
  }
}

const DIR = /^nova-backup-(\d{6,})$/;
const ENC = /^nova-backup-(\d{6,})\.nbk$/;
const dirName = (seq: number) => `nova-backup-${String(seq).padStart(6, '0')}`;

// Top-level names in the home that are never in a backup, and why (shown in every manifest).
const SKIP_TOP: Record<string, string> = {
  '.git': 'the home’s git history stays on this machine',
  logs: 'Nova’s logs are for diagnosing this machine',
  backups: 'the pre-upgrade backups are kept separately',
  exports: 'exports are copies made on request',
  workers: 'workers’ scratch folders',
  kept: 'Nova’s own scratch',
  connectors: 'Era 2’s connection secrets (the vault holds them now)',
  'nova.pid': 'which process runs this home',
};
const SKIP_FILE: Record<string, string> = {
  'vault/key': 'the vault’s key never leaves this machine',
  'mesh/identity.json': 'this node’s private keys never leave this machine',
};
const DB_FILE = /^nova\.db/;
const TEMP = /\.(tmp|partial)$|\.nova-sync-\d+\.tmp$/;

export const EXCLUDED = [
  'nova.db: copied as a consistent snapshot instead',
  ...Object.entries(SKIP_FILE).map(([p, why]) => `${p}: ${why}`),
  ...Object.entries(SKIP_TOP).map(([p, why]) => `${p}: ${why}`),
];

export const sha256File = (path: string): string => {
  const h = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let at = 0; ;) {
      const n = readSync(fd, buf, 0, buf.length, at);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      at += n;
    }
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
};

// The home's files a backup carries, as paths relative to the home.
export function backupFiles(home: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(home, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && (SKIP_TOP[e.name] || DB_FILE.test(e.name))) continue;
      if (SKIP_FILE[r] || TEMP.test(e.name)) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) out.push(r);
      // Links, sockets and the like are not the person's content and are never followed.
    }
  };
  walk('');
  return out;
}

const isFull = (e: unknown) => {
  const m = (e as Error)?.message ?? '';
  return (e as NodeJS.ErrnoException)?.code === 'ENOSPC' || /disk is full|SQLITE_FULL|ENOSPC/i.test(m);
};

export interface NightlyOptions {
  db: Db;
  home: string;
  log: Log;
  version: string;
  settings: () => BackupSettings;
  // The encryption key, from the vault: made once, on first use.
  key: () => Buffer;
  now?: () => Date;
}

export class NightlyBackups {
  #o: NightlyOptions;
  #now: () => Date;

  constructor(o: NightlyOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
  }

  // Makes one backup now. Throws a BackupError (with its kind) when it can't; the old backups are
  // untouched then. Returns the run, with the encrypted copy's path or why there isn't one.
  run(o: { taskId?: string } = {}): BackupRun & { manifest: Manifest; encrypted_error: string | null } {
    const s = this.#o.settings();
    if (!s.target) throw new BackupError('target-missing', 'No backup folder is set yet. Choose one in Settings › Backups.');
    const target = resolve(s.target);
    const at = this.#now().toISOString();
    const seq = this.#nextSeq(target);
    const id = dirName(seq);
    const fail = (kind: FailureKind, message: string): never => {
      this.#record({ id: `${id}-failed-${randomBytes(3).toString('hex')}`, seq, at, target, path: null, ok: false, bytes: 0, files: 0, encrypted_path: null, error: message, task_id: o.taskId ?? null });
      throw new BackupError(kind, message);
    };
    let st: ReturnType<typeof statSync> | null = null;
    try { st = statSync(target); } catch { /* not there */ }
    if (!st?.isDirectory()) return fail('target-missing', `The backup folder ${target} isn’t there. Nova won’t create it, in case it’s a drive that isn’t plugged in.`);
    if (inside(target, this.#o.home)) return fail('failed', 'The backup folder is inside Nova’s home, so a backup would contain itself. Choose a folder outside it.');

    const final = join(target, id);
    const partial = join(target, `.${id}.partial`);
    let manifest: Manifest;
    try {
      rmSync(partial, { recursive: true, force: true });
      mkdirSync(join(partial, 'files'), { recursive: true });
      const snap = join(partial, 'nova.db');
      this.#o.db.raw.exec(`VACUUM INTO '${snap.replaceAll("'", "''")}'`);
      const files: ManifestFile[] = [];
      for (const rel of backupFiles(this.#o.home)) {
        const src = join(this.#o.home, rel);
        const dst = join(partial, 'files', rel);
        mkdirSync(join(dst, '..'), { recursive: true });
        try {
          copyFileSync(src, dst);
        } catch (e) {
          // A file that went away while copying (a journal rotated, a scratch file removed) is
          // simply not in this backup; anything else stops it.
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw e;
        }
        files.push({ path: rel, sha256: sha256File(dst), bytes: statSync(dst).size });
      }
      const snapDb = new DatabaseSync(snap, { readOnly: true });
      let migrations: Manifest['migrations'];
      try {
        migrations = snapDb.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as unknown as Manifest['migrations'];
      } finally {
        snapDb.close();
      }
      manifest = {
        v: 1, id, seq, at, nova_version: this.#o.version,
        schema_version: migrations.at(-1)?.version ?? 0, migrations,
        db: { path: 'nova.db', sha256: sha256File(snap), bytes: statSync(snap).size },
        files, excluded: EXCLUDED, cleaned: [],
      };
      writeFileSync(join(partial, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      renameSync(partial, final);
    } catch (e) {
      rmSync(partial, { recursive: true, force: true });
      if (isFull(e)) return fail('disk-full', `The disk the backup folder is on is full, so the backup stopped. Your earlier backups are untouched. (${(e as Error).message})`);
      return fail('failed', `The backup stopped: ${(e as Error).message}. Your earlier backups are untouched.`);
    }
    const bytes = manifest.db.bytes + manifest.files.reduce((n, f) => n + f.bytes, 0);
    let encrypted: string | null = null;
    let encryptedError: string | null = null;
    if (s.encrypted_target) {
      try {
        encrypted = this.#encrypt(final, manifest, s.encrypted_target);
      } catch (e) {
        encryptedError = isFull(e) ? `The encrypted copy wasn’t made: the disk it goes to is full.` : `The encrypted copy wasn’t made: ${(e as Error).message}`;
      }
    }
    const run: BackupRun = { id, seq, at, target, path: final, ok: true, bytes, files: manifest.files.length, encrypted_path: encrypted, error: encryptedError, task_id: o.taskId ?? null };
    this.#record(run);
    this.prune();
    return { ...run, manifest, encrypted_error: encryptedError };
  }

  // Keeps the newest `keep` complete backups (and encrypted copies), by sequence number; removes
  // the rest, and anything left half-written by a backup that was stopped.
  prune(): { removed: string[] } {
    const s = this.#o.settings();
    const removed: string[] = [];
    const keep = Math.max(1, s.keep || DEFAULT_KEEP);
    if (s.target && existsSync(s.target)) {
      for (const e of readdirSync(s.target)) if (/^\.nova-backup-\d+\.partial$/.test(e)) rmSync(join(s.target, e), { recursive: true, force: true });
      for (const b of this.complete().slice(keep)) { rmSync(b.path, { recursive: true, force: true }); removed.push(b.path); }
    }
    if (s.encrypted_target && existsSync(s.encrypted_target)) {
      for (const e of this.encrypted().slice(keep)) { rmSync(e.path, { force: true }); removed.push(e.path); }
    }
    return { removed };
  }

  // Complete backups in the folder, newest first (a manifest means it finished).
  complete(): { path: string; seq: number; manifest: Manifest }[] {
    const target = this.#o.settings().target;
    if (!target || !existsSync(target)) return [];
    const out: { path: string; seq: number; manifest: Manifest }[] = [];
    for (const e of readdirSync(target)) {
      const m = DIR.exec(e);
      if (!m) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(target, e, 'manifest.json'), 'utf8')) as Manifest;
        out.push({ path: join(target, e), seq: Number(m[1]), manifest });
      } catch { /* not finished, or not Nova's */ }
    }
    return out.sort((a, b) => b.seq - a.seq);
  }

  encrypted(): { path: string; seq: number; at: string | null }[] {
    const t = this.#o.settings().encrypted_target;
    if (!t || !existsSync(t)) return [];
    return readdirSync(t).flatMap((e) => {
      const m = ENC.exec(e);
      if (!m) return [];
      let at: string | null = null;
      try { at = readHeader(join(t, e)).at; } catch { /* damaged: the drill says so */ }
      return [{ path: join(t, e), seq: Number(m[1]), at }];
    }).sort((a, b) => b.seq - a.seq);
  }

  runs(limit = 20): BackupRun[] {
    return this.#o.db.all<Record<string, unknown>>('SELECT * FROM backup_run ORDER BY at DESC, seq DESC LIMIT ?', limit).map((r) => ({ ...(r as unknown as BackupRun), ok: r.ok === 1 }));
  }

  // Unpacks an encrypted copy into `outDir` (which must not exist yet), checked whole first.
  decrypt(file: string, outDir: string): Manifest {
    decryptTo(file, this.#o.key(), outDir);
    return JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as Manifest;
  }

  // A forget, carried into every backup and every encrypted copy (backups.ts calls this).
  forget(table: string, ids: string[], words: string[]): { cleaned: string[]; destroyed: string[] } {
    const cleaned: string[] = [];
    const destroyed: string[] = [];
    if (!ids.length) return { cleaned, destroyed };
    for (const b of this.complete()) {
      try {
        cleanBackup(b.path, table, ids, words, this.#now());
        cleaned.push(b.path);
      } catch (e) {
        rmSync(b.path, { recursive: true, force: true });
        destroyed.push(b.path);
        this.#o.log.problem('backups', 'A nightly backup couldn’t be cleaned of something you asked Nova to forget, so Nova deleted that backup rather than keep it.', { detail: `${b.path}: ${(e as Error).message}` });
      }
    }
    for (const e of this.encrypted()) {
      const scratch = mkdtempSync(join(tmpdir(), 'nova-forget-'));
      try {
        const out = join(scratch, 'backup');
        const h = decryptTo(e.path, this.#o.key(), out);
        cleanBackup(out, table, ids, words, this.#now());
        encryptDir(out, e.path, this.#o.key(), { id: h.id, seq: h.seq, at: h.at });
        cleaned.push(e.path);
      } catch (err) {
        rmSync(e.path, { force: true });
        destroyed.push(e.path);
        this.#o.log.problem('backups', 'An encrypted backup copy couldn’t be cleaned of something you asked Nova to forget, so Nova deleted that copy rather than keep it.', { detail: `${e.path}: ${(err as Error).message}` });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
    return { cleaned, destroyed };
  }

  #encrypt(dir: string, m: Manifest, to: string): string {
    let st: ReturnType<typeof statSync> | null = null;
    try { st = statSync(to); } catch { /* not there */ }
    if (!st?.isDirectory()) throw new Error(`the folder ${to} isn’t there, and Nova won’t create it`);
    const file = join(to, `${m.id}.nbk`);
    encryptDir(dir, file, this.#o.key(), { id: m.id, seq: m.seq, at: m.at });
    return file;
  }

  #nextSeq(target: string): number {
    let max = this.#o.db.get<{ s: number | null }>('SELECT MAX(seq) AS s FROM backup_run')?.s ?? 0;
    try { for (const e of readdirSync(target)) { const m = DIR.exec(e) ?? ENC.exec(e); if (m) max = Math.max(max, Number(m[1])); } } catch { /* checked by the caller */ }
    return max + 1;
  }

  #record(r: BackupRun): void {
    this.#o.db.run('INSERT OR REPLACE INTO backup_run (id, seq, at, target, path, ok, bytes, files, encrypted_path, error, task_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.id, r.seq, r.at, r.target, r.path, r.ok ? 1 : 0, r.bytes, r.files, r.encrypted_path, r.error, r.task_id);
  }
}

const inside = (path: string, root: string) => {
  const r = relative(resolve(root), resolve(path));
  return r === '' || (!r.startsWith('..') && !r.startsWith(sep) && !r.includes(`..${sep}`));
};

// Cleans one backup folder of rows (and of the words, in its files), then writes its manifest's
// hashes again so the drill can still check it. Throws when it can't, so the caller destroys it.
export function cleanBackup(dir: string, table: string, ids: string[], words: string[], at: Date): void {
  const mpath = join(dir, 'manifest.json');
  const m = JSON.parse(readFileSync(mpath, 'utf8')) as Manifest;
  const db = join(dir, 'nova.db');
  cleanDbFile(db, table, ids, words);
  m.db = { path: 'nova.db', sha256: sha256File(db), bytes: statSync(db).size };
  const ws = words.map((w) => w.trim()).filter((w) => w.length >= 3);
  if (ws.length) {
    for (const f of m.files) {
      const p = join(dir, 'files', f.path);
      if (!existsSync(p) || lstatSync(p).isSymbolicLink()) continue;
      const raw = readFileSync(p);
      if (!ws.some((w) => raw.includes(Buffer.from(w)))) continue;
      if (raw.includes(0)) throw new Error(`${f.path} holds forgotten words and isn’t text, so it can’t be cleaned.`);
      // Lines that carry the words go; what's left of a record spread over lines goes too.
      let text = raw.toString('utf8').split('\n').filter((line) => !ws.some((w) => line.includes(w))).join('\n');
      for (const w of ws) text = text.split(w).join('');
      writeFileSync(p, text);
      f.sha256 = sha256File(p);
      f.bytes = statSync(p).size;
    }
  }
  m.cleaned = [...(m.cleaned ?? []), { at: at.toISOString(), table, rows: ids.length }];
  writeFileSync(`${mpath}.tmp`, `${JSON.stringify(m, null, 2)}\n`);
  renameSync(`${mpath}.tmp`, mpath);
}

// Copies a backup folder into a new home: the database and the files, nothing else. `into` must be
// empty or not exist yet: restoring never writes over a home.
export function restoreInto(backupDir: string, into: string): Manifest {
  const m = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as Manifest;
  if (existsSync(into) && readdirSync(into).length) throw new CoreError('conflict', `${into} isn’t empty. Restore into a new folder; Nova never restores over a home.`);
  mkdirSync(into, { recursive: true });
  for (const f of m.files) {
    const dst = join(into, f.path);
    mkdirSync(join(dst, '..'), { recursive: true });
    copyFileSync(join(backupDir, 'files', f.path), dst);
  }
  copyFileSync(join(backupDir, 'nova.db'), join(into, 'nova.db'));
  return m;
}

export function newKey(): Buffer {
  return randomBytes(32);
}
