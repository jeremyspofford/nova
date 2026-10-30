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
// cleaned is destroyed and that is reported. That covers every folder Nova ever backed up to, not
// only the one set now; a folder that isn't there when the forget happens (a drive unplugged) is
// owed it: the forget is written down (out of every backup, its words sealed) and carried in as
// soon as the folder is back, before any backup, prune or drill touches it.
//
// What counts as a backup: only a folder Nova recorded making (backup_run, by id and sequence)
// whose manifest still carries Nova's seal (an HMAC under a key in the vault, never in a backup).
// Anything else named like one is a stray: never restored, never "latest", never pruned, and
// reported. Backups are the person's alone (folders 0700, files 0600), in a folder only they can
// write.
//
// The encrypted copy's key is the person's recovery key: shown once when the copy is set up (and
// again only at tier 3), it opens the copy on any machine, without this one's vault.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import { cleanDbFile } from '../backups.ts';
import { CoreError } from '../errors.ts';
import { decryptTo, encryptDir, keyFingerprint, readHeader, safeRel } from './archive.ts';
import { dropScratch, makeScratch } from './scratch.ts';

export interface BackupSettings { target: string | null; keep: number; encrypted_target: string | null }
export const DEFAULT_KEEP = 7;
export const KEY_NAME = 'nova/backup-key';
// Seals manifests and the list of owed forgets: only Nova, holding it, can make a backup count.
export const SEAL_NAME = 'nova/backup-seal';

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
  // Nova's seal over everything above (HMAC-SHA256): a manifest without it, or changed since, is
  // not one of Nova's backups.
  seal?: string;
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
  // The encryption key (the person's recovery key), from the vault: made once, on first use.
  key: () => Buffer;
  // The seal's key, from the vault: made once, on first use. Null when the vault can't give it.
  seal: () => Buffer | null;
  // A folder now owes forgets (it isn't there), or owes none any more (they were carried in).
  owed?: (folder: string, kind: FolderKind, owes: boolean) => void;
  now?: () => Date;
}

export type FolderKind = 'folder' | 'encrypted';
interface Found { path: string; seq: number; manifest: Manifest }
interface FoundCopy { path: string; seq: number; at: string | null }
// A forget a folder still owes: which rows, and the words (sealed: they are what was forgotten).
interface Owed { folder: string; kind: FolderKind; table: string; ids: string[]; words: string; at: string }

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
    // Forgets owed to a folder that is back go in before anything else is done there.
    this.applyOwed();
    const s = this.#o.settings();
    if (!s.target) throw new BackupError('target-missing', 'No backup folder is set yet. Choose one with PUT /api/v1/backups/settings.');
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
    const unsafe = folderProblem(target);
    if (unsafe) return fail('failed', unsafe);
    const sealKey = this.#o.seal();
    if (!sealKey) return fail('failed', 'Nova couldn’t get the key it seals backups with from the vault, so it made no backup.');

    const final = join(target, id);
    const partial = join(target, `.${id}.partial`);
    let manifest: Manifest;
    try {
      rmSync(partial, { recursive: true, force: true });
      // The person's alone, whatever the umask: folders 0700, files 0600.
      mkdirSync(join(partial, 'files'), { recursive: true, mode: 0o700 });
      chmodSync(partial, 0o700);
      chmodSync(join(partial, 'files'), 0o700);
      const snap = join(partial, 'nova.db');
      this.#o.db.raw.exec(`VACUUM INTO '${snap.replaceAll("'", "''")}'`);
      chmodSync(snap, 0o600);
      const files: ManifestFile[] = [];
      for (const rel of backupFiles(this.#o.home)) {
        const src = join(this.#o.home, rel);
        const dst = join(partial, 'files', rel);
        mkdirSync(join(dst, '..'), { recursive: true, mode: 0o700 });
        try {
          copyFileSync(src, dst);
          chmodSync(dst, 0o600);
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
      writeManifest(partial, manifest, sealKey);
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

  // Keeps the newest `keep` backups (and encrypted copies) Nova made, by sequence number; removes
  // the rest, and anything left half-written by a backup that was stopped. Strays are left alone.
  prune(): { removed: string[] } {
    this.applyOwed();
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

  // Nova's own complete backups in the folder, newest first.
  complete(): Found[] {
    const target = this.#o.settings().target;
    return target ? this.#scan(target).found : [];
  }

  encrypted(): FoundCopy[] {
    const t = this.#o.settings().encrypted_target;
    return t ? this.#scanCopies(t).found : [];
  }

  // Things in the backup folders named like Nova's backups that Nova didn't make (or that were
  // changed since): never used, never pruned, shown so the person can look.
  strays(): string[] {
    const s = this.#o.settings();
    return [...(s.target ? this.#scan(s.target).strays : []), ...(s.encrypted_target ? this.#scanCopies(s.encrypted_target).strays : [])];
  }

  #scan(folder: string): { found: Found[]; strays: string[] } {
    const found: Found[] = [];
    const strays: string[] = [];
    let names: string[] = [];
    try { names = readdirSync(folder); } catch { return { found, strays }; }
    const key = this.#o.seal();
    for (const e of names) {
      const m = DIR.exec(e);
      if (!m) continue;
      const path = join(folder, e);
      let manifest: Manifest | null = null;
      try { manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')) as Manifest; } catch { /* below */ }
      const seq = Number(m[1]);
      const ours = !!manifest && !!key && manifest.id === e && manifest.seq === seq && sealed(manifest, key)
        && !!this.#o.db.get('SELECT 1 FROM backup_run WHERE id = ? AND seq = ? AND ok = 1', manifest.id, seq);
      if (ours) found.push({ path, seq, manifest: manifest! });
      else strays.push(path);
    }
    return { found: found.sort((a, b) => b.seq - a.seq), strays };
  }

  #scanCopies(folder: string): { found: FoundCopy[]; strays: string[] } {
    const found: FoundCopy[] = [];
    const strays: string[] = [];
    let names: string[] = [];
    try { names = readdirSync(folder); } catch { return { found, strays }; }
    for (const e of names) {
      const m = ENC.exec(e);
      if (!m) continue;
      const path = join(folder, e);
      const seq = Number(m[1]);
      const recorded = this.#o.db.all<{ encrypted_path: string }>('SELECT encrypted_path FROM backup_run WHERE seq = ? AND ok = 1 AND encrypted_path IS NOT NULL', seq).some((r) => basename(r.encrypted_path) === e);
      let at: string | null = null;
      // A copy whose header can't be read is still Nova's when recorded: the drill says it's damaged.
      let named = true;
      try { const h = readHeader(path); at = h.at; named = h.id === dirName(seq) && h.seq === seq; } catch { /* damaged */ }
      if (recorded && named) found.push({ path, seq, at });
      else strays.push(path);
    }
    return { found: found.sort((a, b) => b.seq - a.seq), strays };
  }

  runs(limit = 20): BackupRun[] {
    return this.#o.db.all<Record<string, unknown>>('SELECT * FROM backup_run ORDER BY at DESC, seq DESC LIMIT ?', limit).map((r) => ({ ...(r as unknown as BackupRun), ok: r.ok === 1 }));
  }

  // Unpacks an encrypted copy into `outDir` (which must not exist yet), checked whole first.
  decrypt(file: string, outDir: string, key: Buffer = this.#o.key()): Manifest {
    decryptTo(file, key, outDir);
    return JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as Manifest;
  }

  // ---- forgetting -------------------------------------------------------------------------------

  // A forget, carried into every backup and every encrypted copy, in every folder Nova ever backed
  // up to (backups.ts calls this). A folder that isn't there owes it.
  forget(table: string, ids: string[], words: string[]): { cleaned: string[]; destroyed: string[] } {
    const cleaned: string[] = [];
    const destroyed: string[] = [];
    if (!ids.length) return { cleaned, destroyed };
    // What was owed before goes first, so forgets reach each folder in the order they were made.
    this.applyOwed();
    for (const f of this.folders()) {
      if (this.#reachable(f.folder, f.kind)) {
        const r = this.#clean(f.folder, f.kind, table, ids, words);
        cleaned.push(...r.cleaned);
        destroyed.push(...r.destroyed);
      } else this.#owe(f.folder, f.kind, table, ids, words);
    }
    return { cleaned, destroyed };
  }

  // Every folder Nova backed up to, and the ones set now: forgetting reaches them all.
  folders(): { folder: string; kind: FolderKind }[] {
    const s = this.#o.settings();
    const out = new Map<string, { folder: string; kind: FolderKind }>();
    const add = (folder: string | null, kind: FolderKind) => { if (folder) out.set(`${kind}\0${resolve(folder)}`, { folder: resolve(folder), kind }); };
    for (const r of this.#o.db.all<{ target: string }>('SELECT DISTINCT target FROM backup_run WHERE ok = 1')) add(r.target, 'folder');
    for (const r of this.#o.db.all<{ p: string }>('SELECT DISTINCT encrypted_path AS p FROM backup_run WHERE encrypted_path IS NOT NULL')) add(dirname(r.p), 'encrypted');
    add(s.target, 'folder');
    add(s.encrypted_target, 'encrypted');
    return [...out.values()];
  }

  // Forgets owed to folders that aren't there, by folder: shown in Health.
  owedView(): { folder: string; kind: FolderKind; forgets: number; since: string }[] {
    const by = new Map<string, { folder: string; kind: FolderKind; forgets: number; since: string }>();
    for (const o of this.#loadOwed()) {
      const k = `${o.kind}\0${o.folder}`;
      const v = by.get(k) ?? { folder: o.folder, kind: o.kind, forgets: 0, since: o.at };
      v.forgets++;
      by.set(k, v);
    }
    return [...by.values()];
  }

  // Carries owed forgets into each folder that is back. Called before a backup, a prune and a
  // drill, and by the heartbeat; a folder still away keeps what it owes.
  applyOwed(): { applied: { folder: string; kind: FolderKind }[] } {
    const owed = this.#loadOwed();
    const applied: { folder: string; kind: FolderKind }[] = [];
    if (!owed.length) return { applied };
    const left: Owed[] = [];
    const key = this.#owedKey();
    const groups = new Map<string, Owed[]>();
    for (const o of owed) groups.set(`${o.kind}\0${o.folder}`, [...(groups.get(`${o.kind}\0${o.folder}`) ?? []), o]);
    for (const list of groups.values()) {
      const { folder, kind } = list[0]!;
      if (!key || !this.#reachable(folder, kind)) { left.push(...list); continue; }
      try {
        for (const o of list) this.#clean(folder, kind, o.table, o.ids, unsealWords(o.words, key));
        applied.push({ folder, kind });
      } catch (e) {
        left.push(...list);
        this.#o.log.warn('backups', 'Nova couldn’t carry an owed forget into a backup folder yet.', { folder, error: (e as Error).message });
      }
    }
    this.#saveOwed(left);
    for (const a of applied) this.#o.owed?.(a.folder, a.kind, false);
    return { applied };
  }

  // A folder is there for forgetting when it exists and either holds Nova's backups or never had
  // any. An empty folder where backups were (a drive's mount point with the drive unplugged) is
  // not: cleaning it would clean nothing and let the forget be dropped.
  #reachable(folder: string, kind: FolderKind): boolean {
    try { if (!statSync(folder).isDirectory()) return false; } catch { return false; }
    const found = kind === 'folder' ? this.#scan(folder).found.length : this.#scanCopies(folder).found.length;
    if (found) return true;
    const had = kind === 'folder'
      ? !!this.#o.db.get('SELECT 1 FROM backup_run WHERE ok = 1 AND target = ?', folder)
      : this.#o.db.all<{ p: string }>('SELECT encrypted_path AS p FROM backup_run WHERE encrypted_path IS NOT NULL').some((r) => dirname(r.p) === folder);
    return !had;
  }

  #clean(folder: string, kind: FolderKind, table: string, ids: string[], words: string[]): { cleaned: string[]; destroyed: string[] } {
    const cleaned: string[] = [];
    const destroyed: string[] = [];
    const sealKey = this.#o.seal();
    if (!sealKey) throw new Error('the key that seals backups isn’t available');
    if (kind === 'folder') {
      for (const b of this.#scan(folder).found) {
        try {
          cleanBackup(b.path, table, ids, words, this.#now(), sealKey);
          cleaned.push(b.path);
        } catch (e) {
          rmSync(b.path, { recursive: true, force: true });
          destroyed.push(b.path);
          this.#o.log.problem('backups', 'A nightly backup couldn’t be cleaned of something you asked Nova to forget, so Nova deleted that backup rather than keep it.', { detail: `${b.path}: ${(e as Error).message}` });
        }
      }
      return { cleaned, destroyed };
    }
    for (const e of this.#scanCopies(folder).found) {
      const scratch = makeScratch('forget');
      try {
        const out = join(scratch, 'backup');
        const h = decryptTo(e.path, this.#o.key(), out);
        cleanBackup(out, table, ids, words, this.#now(), sealKey);
        encryptDir(out, e.path, this.#o.key(), { id: h.id, seq: h.seq, at: h.at });
        cleaned.push(e.path);
      } catch (err) {
        rmSync(e.path, { force: true });
        destroyed.push(e.path);
        this.#o.log.problem('backups', 'An encrypted backup copy couldn’t be cleaned of something you asked Nova to forget, so Nova deleted that copy rather than keep it.', { detail: `${e.path}: ${(err as Error).message}` });
      } finally {
        dropScratch(scratch);
      }
    }
    return { cleaned, destroyed };
  }

  #owe(folder: string, kind: FolderKind, table: string, ids: string[], words: string[]): void {
    const key = this.#owedKey();
    if (!key) {
      this.#o.log.problem('backups', `Nova couldn’t write down a forget owed to ${folder}: the vault can’t give it the key it seals them with. Delete the backups there yourself.`);
      return;
    }
    this.#saveOwed([...this.#loadOwed(), { folder, kind, table, ids, words: sealWords(words, key), at: this.#now().toISOString() }]);
    this.#o.owed?.(folder, kind, true);
  }

  // The owed list lives in the home's `kept` folder: never in a backup, never copied to a sandbox
  // or the standby, and emptied once every folder has what it owed.
  #owedFile(): string {
    return join(this.#o.home, 'kept', '.nova', 'forgets-owed.json');
  }

  #loadOwed(): Owed[] {
    try { return (JSON.parse(readFileSync(this.#owedFile(), 'utf8')) as { owed: Owed[] }).owed ?? []; } catch { return []; }
  }

  #saveOwed(list: Owed[]): void {
    const file = this.#owedFile();
    if (!list.length && !existsSync(file)) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ v: 1, owed: list }, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  #owedKey(): Buffer | null {
    const k = this.#o.seal();
    return k ? createHash('sha256').update('nova-owed-forgets\0').update(k).digest() : null;
  }

  #encrypt(dir: string, m: Manifest, to: string): string {
    let st: ReturnType<typeof statSync> | null = null;
    try { st = statSync(to); } catch { /* not there */ }
    if (!st?.isDirectory()) throw new Error(`the folder ${to} isn’t there, and Nova won’t create it`);
    const unsafe = folderProblem(to);
    if (unsafe) throw new Error(unsafe);
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

// Why a folder can't hold backups, or null: it must be the person's own, and no one else may
// write it (they could change or plant backups there).
export function folderProblem(path: string): string | null {
  let st: ReturnType<typeof statSync>;
  try { st = statSync(path); } catch { return null; }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null && st.uid !== uid) return `${path} belongs to another user, so they could change or plant backups there. Choose a folder of your own.`;
  if (Number(st.mode) & 0o022) return `${path} is a folder other users can write to, so they could change or plant backups there. Choose a folder only you can write (chmod go-w).`;
  return null;
}

const sealOf = (m: Manifest, key: Buffer) => {
  const { seal: _seal, ...rest } = m;
  return createHmac('sha256', key).update(JSON.stringify(rest)).digest('hex');
};

const sealed = (m: Manifest, key: Buffer) => {
  if (typeof m.seal !== 'string' || !/^[0-9a-f]{64}$/.test(m.seal)) return false;
  return timingSafeEqual(Buffer.from(m.seal, 'hex'), Buffer.from(sealOf(m, key), 'hex'));
};

// Writes a backup's manifest with Nova's seal, all at once, readable by the person only.
export function writeManifest(dir: string, m: Manifest, key: Buffer): void {
  const path = join(dir, 'manifest.json');
  m.seal = sealOf(m, key);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

const sealWords = (words: string[], key: Buffer): string => {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([c.update(JSON.stringify(words)), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64');
};

const unsealWords = (text: string, key: Buffer): string[] => {
  const b = Buffer.from(text, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(b.length - 16));
  return JSON.parse(Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString('utf8')) as string[];
};

// Cleans one backup folder of rows (and of the words, in its files), then writes its manifest's
// hashes again, sealed, so the drill can still check it. Throws when it can't, so the caller
// destroys it. Every path the manifest names is checked first: none may reach outside the backup.
export function cleanBackup(dir: string, table: string, ids: string[], words: string[], at: Date, sealKey: Buffer): void {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  const rels = m.files.map((f) => safeRel(f.path));
  const db = join(dir, 'nova.db');
  cleanDbFile(db, table, ids, words);
  m.db = { path: 'nova.db', sha256: sha256File(db), bytes: statSync(db).size };
  const ws = words.map((w) => w.trim()).filter((w) => w.length >= 3);
  if (ws.length) {
    m.files.forEach((f, i) => {
      const p = join(dir, 'files', rels[i]!);
      if (!existsSync(p) || lstatSync(p).isSymbolicLink()) return;
      const raw = readFileSync(p);
      if (!ws.some((w) => raw.includes(Buffer.from(w)))) return;
      if (raw.includes(0)) throw new Error(`${f.path} holds forgotten words and isn’t text, so it can’t be cleaned.`);
      // Lines that carry the words go; what's left of a record spread over lines goes too.
      let text = raw.toString('utf8').split('\n').filter((line) => !ws.some((w) => line.includes(w))).join('\n');
      for (const w of ws) text = text.split(w).join('');
      writeFileSync(p, text);
      f.sha256 = sha256File(p);
      f.bytes = statSync(p).size;
    });
  }
  m.cleaned = [...(m.cleaned ?? []), { at: at.toISOString(), table, rows: ids.length }];
  writeManifest(dir, m, sealKey);
}

// Copies a backup folder into a new home: the database and the files, nothing else. `into` must be
// empty or not exist yet: restoring never writes over a home. A path that would reach outside the
// backup, or anything that isn't a plain file, stops it before anything is written.
export function restoreInto(backupDir: string, into: string): Manifest {
  const m = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8')) as Manifest;
  const rels = m.files.map((f) => safeRel(f.path));
  for (const rel of rels) if (!lstatSync(join(backupDir, 'files', rel)).isFile()) throw new Error(`${rel} in the backup isn’t a plain file.`);
  if (!lstatSync(join(backupDir, 'nova.db')).isFile()) throw new Error('The backup’s database isn’t a plain file.');
  if (existsSync(into) && readdirSync(into).length) throw new CoreError('conflict', `${into} isn’t empty. Restore into a new folder; Nova never restores over a home.`);
  mkdirSync(into, { recursive: true, mode: 0o700 });
  for (const rel of rels) {
    const dst = join(into, rel);
    mkdirSync(join(dst, '..'), { recursive: true, mode: 0o700 });
    copyFileSync(join(backupDir, 'files', rel), dst);
  }
  copyFileSync(join(backupDir, 'nova.db'), join(into, 'nova.db'));
  return m;
}

export function newKey(): Buffer {
  return randomBytes(32);
}

// ---- the recovery key ---------------------------------------------------------------------------

// The encrypted copy's key as the person keeps it: 64 hex digits in eight groups.
export function formatRecoveryKey(key: Buffer): string {
  return (key.toString('hex').match(/.{8}/g) ?? []).join('-');
}

export function parseRecoveryKey(text: string): Buffer {
  const hex = String(text ?? '').toLowerCase().replace(/[\s-]/g, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new CoreError('validation', 'A recovery key is 64 digits and letters a–f, in eight groups.');
  return Buffer.from(hex, 'hex');
}

export { keyFingerprint };

// Opens an encrypted copy with the person's recovery key alone: no home, no vault, any machine.
export function openEncrypted(file: string, recoveryKey: string, outDir: string): Manifest {
  const key = parseRecoveryKey(recoveryKey);
  if (readHeader(file).key_fp !== keyFingerprint(key)) throw new Error('That recovery key doesn’t open this encrypted backup: it was made with a different key.');
  decryptTo(file, key, outDir);
  return JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8')) as Manifest;
}
