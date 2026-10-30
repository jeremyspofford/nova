// Factory reset (M7 amendment §2): Nova back to how it was the first time, on this machine.
//
// The flow: an export is offered first (recommended, never forced): the encrypted-copy format of
// archive.ts under a fresh recovery key shown once, plus the plain memory files, into a folder the
// person names and Nova never creates. It holds no vault, no vault key and no identity, and says so.
//
// Then, confirmed every time from the hub's own screen (tier 3), the reset is staged: a marker in
// the home says exactly what goes, decided while Nova still runs and can tell its own sealed
// backups from strays. Before anything is wiped the hub tells every paired device it can reach:
// a phone or browser on its open stream, a computer in its next heartbeat, the standby in its next
// sync answer (it wipes its copy and reports back). Every session then ends. Nova restarts in place
// (the restart belongs to the checkpoints work; until it is wired, the marker waits for the next
// start), and `finishReset` does the wipe before anything opens the database:
//   1. the vault's key, from the keychain (through the vault's own key abstraction) and its file;
//   2. Nova's own sealed backups and encrypted copies, in every folder it ever backed up to, each
//      checked again against what was recorded (anything changed since is left, and said);
//   3. Nova's own entries in its home, by name (OWN_ENTRIES). Anything else there is the person's:
//      left in place and listed;
//   4. Nova's leftover scratch folders.
// Then the report (reset-report.json in the new home), and only then the marker goes. A reset
// stopped anywhere in that finishes at the next start; a start that can't finish it doesn't run.
//
// What stays, said before and after: backup folders that aren't there (an unplugged drive), devices
// that couldn't be told, the export, and the supervisor's code releases (code, not data).
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Memory } from '../memory.ts';
import type { Route, Who } from '../api.ts';
import type { Access } from '../mesh/access.ts';
import type { Device, Devices } from '../mesh/devices.ts';
import type { MeshRole } from '../mesh/promote.ts';
import type { ResetNotice } from '../mesh/replica.ts';
import type { Spokes } from '../mesh/spokes.ts';
import { REPLICATED } from '../mesh/sync.ts';
import { ONLINE_WINDOW_MS } from '../mesh/devices.ts';
import { CoreError } from '../errors.ts';
import { Vault, type KeyMode, type KeyStore } from '../vault.ts';
import { encryptDir, readHeader } from './archive.ts';
import { EXCLUDED, backupFiles, folderProblem, formatRecoveryKey, keyFingerprint, sha256File, type FolderKind, type Manifest, type ManifestFile, type NightlyBackups } from './backup.ts';
import { dropScratch, freeScratch, makeScratch } from './scratch.ts';

export const RESET_MARKER = 'factory-reset.json';
export const RESET_REPORT = 'reset-report.json';
export const EXPORT_SAID = 'Your saved passwords and keys aren’t in the export; you’ll add them again.';
export const RELEASES_SAID = 'The supervisor’s code releases stay: they are Nova’s code, not your data.';
export const CONFIRM_WORDS = 'I understand this erases Nova on this machine, and I want to start over.';
const CANT_TELL_SAID = 'A device that can’t be reached now can’t be told. Its copy stays on that device until it is reset or removed there. The hub’s identity is gone either way, so it can never reconnect to the new Nova.';
const NOTICE_SAID = 'The hub was reset: Nova there was erased and starts over. This device is no longer paired with it.';
const DEFAULT_TELL_MS = 45_000;

// Nova's own entries at the top of its home, by name, and what each is. Nothing else in the home
// is ever touched. (The database's own files and sync's temporary ones are matched by OWN_PATTERN.)
export const OWN_ENTRIES: Readonly<Record<string, string>> = {
  'nova.db': 'the database',
  vault: 'saved passwords and keys (encrypted), and the vault’s key when it is a file',
  mesh: 'this hub’s identity, its keys, and its place among your devices',
  checkpoints: 'restore points',
  backups: 'the copies kept before database upgrades',
  '.git': 'the home’s history',
  '.gitignore': 'what the home’s history leaves out',
  logs: 'Nova’s logs',
  workers: 'workers’ scratch folders',
  kept: 'Nova’s own scratch, and what removed extensions left',
  captures: 'captured items',
  connectors: 'connection secrets from before the vault',
  'nova.pid': 'which process runs this home',
  'MEMORY.md': 'memory',
  memory: 'memory notes',
  'AGENTS.md': 'Nova’s standing instructions',
  'SOUL.md': 'Nova’s standing instructions',
  'IDENTITY.md': 'who Nova is',
  'USER.md': 'who you are',
  'permissions.md': 'what Nova may do without asking',
  sessions: 'conversations',
  skills: 'skills',
  schedules: 'schedules',
  workspace: 'Nova’s workspace',
  extensions: 'extensions and design systems',
  exports: 'copies Nova made on request inside its home',
};
const OWN_PATTERN = [/^nova\.db/, /\.nova-sync-\d+\.tmp$/];
const isOwn = (name: string) => name in OWN_ENTRIES || OWN_PATTERN.some((p) => p.test(name)) || name === RESET_REPORT;

// What the export leaves out, and why (shown in its manifest and README).
const EXPORT_SKIP: Record<string, string> = {
  vault: 'vault/: your saved passwords and keys, and the vault’s key, aren’t in the export; you’ll add them again',
  mesh: 'mesh/: this hub’s identity stays out; a new Nova makes its own',
};

export interface DeviceLine { id: string; name: string; kind: string; said: string }
export interface BackupItem { path: string; folder: string; kind: FolderKind; check: string | null }
export interface Unreachable { folder: string; kind: FolderKind; said: string }

interface Marker {
  v: 1;
  id: string;
  // A hub erases itself; a standby erases the copy of a hub that was reset.
  kind: 'hub' | 'standby';
  home: string;
  staged_at: string;
  version: string;
  vault_ids: string[];
  own: string[];
  backups: BackupItem[];
  strays: string[];
  unreachable: Unreachable[];
  devices: { told: DeviceLine[]; not_told: DeviceLine[] } | null;
  export: string | null;
}

export interface ResetReport {
  v: 1;
  id: string;
  kind: 'hub' | 'standby';
  staged_at: string;
  finished_at: string;
  version: string;
  wiped: { home: string[]; keychain: string | null; key_file: boolean; backups: string[]; folders: string[]; scratch: number };
  left: { foreign: string[]; unreachable: Unreachable[]; strays: string[]; changed: string[]; releases: string; export: string | null; keychain: string | null };
  devices: { told: DeviceLine[]; not_told: DeviceLine[] };
  said: string;
}

// ---- the home ----------------------------------------------------------------------------------

// Nova's own entries in the home, and everything else (the person's), by top-level name.
export function homeEntries(home: string): { own: string[]; foreign: string[] } {
  let names: string[] = [];
  try { names = readdirSync(home).sort(); } catch { /* no home yet */ }
  return { own: names.filter((n) => n !== RESET_MARKER && isOwn(n)), foreign: names.filter((n) => n !== RESET_MARKER && !isOwn(n)) };
}

const inside = (path: string, root: string) => {
  const r = relative(resolve(root), resolve(path));
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
};

function writeJson(path: string, data: unknown): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function readReport(home: string): ResetReport | null {
  try { return JSON.parse(readFileSync(join(home, RESET_REPORT), 'utf8')) as ResetReport; } catch { return null; }
}

// ---- finishing, at start ----------------------------------------------------------------------

export interface FinishOptions {
  // Where the vault's key lives (as the core is given it): the keychain is reached the vault's way.
  vault?: { mode?: KeyMode; keychain?: ((account: string) => KeyStore | null) | null };
  // Called before each step ("keychain", "backup:<path>", "home:<name>", "scratch", "report"):
  // tests stop a reset part way through here, as a power cut would.
  step?: (what: string) => void;
  scratchRoot?: string;
  now?: () => Date;
}

// Finishes a staged reset, before anything opens the database. Null when none is staged. Throws
// when it can't finish: a half-reset Nova never runs.
export function finishReset(home: string, o: FinishOptions = {}): ResetReport | null {
  const file = join(home, RESET_MARKER);
  if (!existsSync(file)) return null;
  let m: Marker;
  try {
    m = JSON.parse(readFileSync(file, 'utf8')) as Marker;
  } catch (e) {
    throw new Error(`Nova was part way through erasing itself, and its note of what is left (${file}) can’t be read: ${(e as Error).message}. Nova won’t start on a half-erased home.`);
  }
  // A marker copied into another folder (a copy of the home) acts nowhere but where it was made.
  if (m?.v !== 1 || typeof m.home !== 'string' || resolve(m.home) !== resolve(home)) {
    rmSync(file, { force: true });
    return null;
  }
  const step = o.step ?? (() => {});
  const now = o.now ?? (() => new Date());

  // 1. The vault's key, wherever it is.
  step('keychain');
  const vault = new Vault({ home, ...(o.vault?.mode ? { mode: o.vault.mode } : {}), ...(o.vault && 'keychain' in o.vault ? { keychain: o.vault.keychain ?? null } : {}) });
  const key = vault.forgetKeys(m.vault_ids ?? []);

  // 2. Nova's own backups, each checked again against what was recorded when it was staged.
  const wipedBackups: string[] = [];
  const changed: string[] = [];
  for (const b of m.backups ?? []) {
    step(`backup:${b.path}`);
    const state = backupState(b);
    if (state === 'changed') { changed.push(b.path); continue; }
    if (state === 'same') rmSync(b.path, { recursive: true, force: true });
    wipedBackups.push(b.path);
  }

  // 3. Nova's own entries in the home, by name; the marker last, after the report.
  const { own, foreign } = homeEntries(home);
  for (const name of own) {
    if (name === RESET_REPORT) continue;
    step(`home:${name}`);
    rmSync(join(home, name), { recursive: true, force: true });
  }

  // 4. Nova's leftover scratch (a drill's restored home, an opened copy): never another running
  // process's (scratch.ts).
  step('scratch');
  const scratch = freeScratch(o.scratchRoot).deleted.length;

  step('report');
  const devices = m.devices ?? { told: [], not_told: [] };
  const folders = [...new Set(wipedBackups.map((p) => resolve(p, '..')))].sort();
  const report: ResetReport = {
    v: 1, id: m.id, kind: m.kind, staged_at: m.staged_at, finished_at: now().toISOString(), version: m.version,
    wiped: { home: [...new Set([...(m.own ?? []), ...own.filter((n) => n !== RESET_REPORT)])].sort(), keychain: key.keychain, key_file: key.file, backups: wipedBackups, folders, scratch },
    left: { foreign, unreachable: m.unreachable ?? [], strays: m.strays ?? [], changed, releases: RELEASES_SAID, export: m.export ?? null, keychain: key.problem },
    devices,
    said: '',
  };
  report.said = summary(report);
  writeJson(join(home, RESET_REPORT), report);
  rmSync(file, { force: true });
  return report;
}

// Whether a recorded backup is still the one Nova made: the same seal (a folder) or the same
// header (an encrypted copy). Gone already counts as done (a reset that was stopped part way).
function backupState(b: BackupItem): 'same' | 'gone' | 'changed' {
  if (!existsSync(b.path)) return 'gone';
  try {
    if (b.kind === 'folder') {
      const seal = (JSON.parse(readFileSync(join(b.path, 'manifest.json'), 'utf8')) as Manifest).seal ?? null;
      return seal && seal === b.check ? 'same' : 'changed';
    }
    return readHeader(b.path).nonce === b.check ? 'same' : 'changed';
  } catch {
    return 'changed';
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function summary(r: ResetReport): string {
  const parts = [r.kind === 'standby'
    ? 'This standby’s copy of a hub that was reset is erased.'
    : 'Nova was erased on this machine and started over.'];
  const wiped = [`${plural(r.wiped.home.length, 'of Nova’s own entry', 'of Nova’s own entries')} in its home`];
  if (r.wiped.keychain) wiped.push(`the vault’s key in ${r.wiped.keychain}`);
  if (r.wiped.backups.length) wiped.push(`${plural(r.wiped.backups.length, 'backup')} in ${plural(r.wiped.folders.length, 'folder')}`);
  parts.push(`Erased: ${wiped.join(', ')}.`);
  if (r.left.foreign.length) parts.push(`Left in place, because they aren’t Nova’s: ${r.left.foreign.join(', ')}.`);
  for (const u of r.left.unreachable) parts.push(u.said);
  if (r.left.changed.length) parts.push(`Left because they changed since the reset was asked for: ${r.left.changed.join(', ')}.`);
  if (r.devices.told.length) parts.push(`Told: ${r.devices.told.map((d) => d.name).join(', ')}.`);
  if (r.devices.not_told.length) parts.push(`Couldn’t be told: ${r.devices.not_told.map((d) => d.name).join(', ')}. Their copy stays on them until they are reset or removed there.`);
  if (r.left.export) parts.push(`Your export is in ${r.left.export}, untouched.`);
  if (r.left.keychain) parts.push(r.left.keychain);
  if (r.kind === 'hub') parts.push(RELEASES_SAID);
  return parts.join(' ');
}

// ---- while Nova runs: the preview, the export, staging and telling ------------------------------

export interface ResetOptions {
  home: string;
  db: Db;
  log: Log;
  version: string;
  now: () => Date;
  vault: Vault;
  nightly: NightlyBackups;
  memory: Memory;
  devices: Devices;
  access: Access;
  spokes: Spokes;
  role: MeshRole;
  // The core's event bus: every open stream hears "reset".
  emit: (event: string, data: unknown) => void;
  // The restart in place that finishes the reset (the checkpoints work owns it). Null: the marker
  // waits for the next start.
  restart: (() => void | Promise<void>) | null;
  // How long the hub waits for devices it can reach to hear it.
  tellMs?: number;
}

export interface Preview {
  wipes: { home: string[]; keychain: string | null; backups: { folder: string; kind: FolderKind; count: number }[] };
  keeps: { foreign: string[]; unreachable: Unreachable[]; strays: string[]; releases: string; export: string | null };
  devices: { can_tell: Omit<DeviceLine, 'said'>[]; cant_tell: Omit<DeviceLine, 'said'>[]; cant_tell_said: string };
  export_said: string;
  confirm: string;
  staged: boolean;
}

export class FactoryReset {
  #o: ResetOptions;
  // The last export this process made: the reset's result says where it is.
  #export: string | null = null;
  #staging = false;

  constructor(o: ResetOptions) {
    this.#o = o;
  }

  staged(): boolean {
    return this.#staging || existsSync(join(this.#o.home, RESET_MARKER));
  }

  report(): ResetReport | null {
    return readReport(this.#o.home);
  }

  // What a reset would wipe and what it would leave, for the confirmation.
  preview(): Preview {
    const { own, foreign } = homeEntries(this.#o.home);
    const b = this.#backups();
    const by = new Map<string, { folder: string; kind: FolderKind; count: number }>();
    for (const x of b.items) {
      const k = `${x.kind}\0${x.folder}`;
      const v = by.get(k) ?? { folder: x.folder, kind: x.kind, count: 0 };
      v.count++;
      by.set(k, v);
    }
    const d = this.#reach();
    let keychain: string | null = null;
    try { const s = this.#o.vault.status(); keychain = s.key === 'keychain' ? s.where : null; } catch { /* a vault that won't open: its key still goes */ }
    return {
      wipes: { home: own.filter((n) => n !== RESET_REPORT), keychain, backups: [...by.values()] },
      keeps: { foreign, unreachable: b.unreachable, strays: b.strays, releases: RELEASES_SAID, export: this.#export },
      devices: { can_tell: d.can.map(line), cant_tell: d.cant.map(line), cant_tell_said: CANT_TELL_SAID },
      export_said: EXPORT_SAID,
      confirm: CONFIRM_WORDS,
      staged: this.staged(),
    };
  }

  // Every folder Nova ever backed up to: its own sealed backups there (to wipe), the strays (left),
  // and the folders that aren't there now (said, and left).
  #backups(): { items: BackupItem[]; strays: string[]; unreachable: Unreachable[] } {
    const items: BackupItem[] = [];
    const strays: string[] = [];
    const unreachable: Unreachable[] = [];
    const n = this.#o.nightly;
    for (const f of n.folders()) {
      if (!n.reachable(f.folder, f.kind)) {
        const what = f.kind === 'folder' ? 'backup folder' : 'folder for the encrypted copies';
        unreachable.push({ folder: f.folder, kind: f.kind, said: `The ${what} ${f.folder} isn’t there (a drive unplugged?), so the backups in it can’t be erased. They stay there until you delete them.` });
        continue;
      }
      const r = n.inFolder(f.folder, f.kind);
      strays.push(...r.strays);
      for (const x of r.found) {
        let check: string | null = x.seal;
        if (f.kind === 'encrypted') { try { check = readHeader(x.path).nonce; } catch { check = null; } }
        items.push({ path: x.path, folder: f.folder, kind: f.kind, check });
      }
    }
    return { items, strays, unreachable };
  }

  // Who can be told now: the standby while it copies, a computer heard from lately (it hears at
  // its next heartbeat), a phone or browser with its stream open. The rest can't.
  #reach(): { can: Device[]; cant: Device[] } {
    const me = this.#o.devices.identity.id;
    const now = this.#o.now().getTime();
    const recent = (d: Device) => !!d.last_seen && now - Date.parse(d.last_seen) < ONLINE_WINDOW_MS;
    const can: Device[] = [];
    const cant: Device[] = [];
    for (const d of this.#o.devices.list()) {
      if (d.id === me || d.trust !== 'trusted') continue;
      const live = this.#o.access.isLive(d.id);
      const ok = d.kind === 'phone' || d.kind === 'browser' ? live : live || recent(d);
      (ok ? can : cant).push(d);
    }
    return { can, cant };
  }

  // ---- the export --------------------------------------------------------------------------------

  // Into a folder of the person's (which must already exist, outside Nova's home): the database
  // snapshot and the home's files, encrypted under a fresh recovery key, and the memory in plain
  // files. The key is returned here once and kept nowhere.
  exportTo(folder: unknown) {
    if (typeof folder !== 'string' || !folder.trim() || !isAbsolute(folder.trim())) throw new CoreError('validation', 'folder is the full path of a folder of yours, like /media/drive/nova-export.');
    const dir = resolve(folder.trim());
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { /* not there */ }
    if (!isDir) throw new CoreError('validation', `${dir} isn’t a folder Nova can see. Make it first (or plug in its drive): Nova never creates the folder for an export.`);
    if (inside(dir, this.#o.home) || inside(this.#o.home, dir)) throw new CoreError('validation', 'The export can’t go inside Nova’s home or contain it: erasing Nova would take it too.');
    const unsafe = folderProblem(dir);
    if (unsafe) throw new CoreError('validation', unsafe.replaceAll('backups', 'files'));
    const at = this.#o.now();
    const stamp = at.toISOString().replace(/[:.]/g, '-');
    const id = `nova-export-${stamp}`;
    const out = join(dir, id);
    if (existsSync(out)) throw new CoreError('conflict', `${out} is already there. Wait a moment and export again.`);
    const key = randomBytes(32);
    const scratch = makeScratch('export');
    const stage = join(scratch, 'export');
    const file = join(out, 'nova-export.nbk');
    try {
      mkdirSync(join(stage, 'files'), { recursive: true, mode: 0o700 });
      const snap = join(stage, 'nova.db');
      this.#o.db.raw.exec(`VACUUM INTO '${snap.replaceAll("'", "''")}'`);
      const files: ManifestFile[] = [];
      for (const rel of backupFiles(this.#o.home)) {
        if (Object.keys(EXPORT_SKIP).some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
        const dst = join(stage, 'files', rel);
        mkdirSync(join(dst, '..'), { recursive: true, mode: 0o700 });
        try { copyFileSync(join(this.#o.home, rel), dst); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e; }
        files.push({ path: rel, sha256: sha256File(dst), bytes: statSync(dst).size });
      }
      const d = new DatabaseSync(snap, { readOnly: true });
      let migrations: Manifest['migrations'];
      try { migrations = d.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as unknown as Manifest['migrations']; } finally { d.close(); }
      const manifest: Manifest = {
        v: 1, id, seq: 0, at: at.toISOString(), nova_version: this.#o.version, schema_version: migrations.at(-1)?.version ?? 0, migrations,
        db: { path: 'nova.db', sha256: sha256File(snap), bytes: statSync(snap).size }, files,
        excluded: [...Object.values(EXPORT_SKIP), ...EXCLUDED.filter((x) => !/^(vault\/key|mesh\/identity\.json):/.test(x))], cleaned: [],
      };
      writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      mkdirSync(out, { mode: 0o700 });
      chmodSync(out, 0o700);
      encryptDir(stage, file, key, { id, seq: 0, at: at.toISOString() });
      const mem = this.#o.memory.export({ dir: out });
      for (const f of [mem.json, mem.markdown]) chmodSync(f, 0o600);
      writeFileSync(join(out, 'README.txt'), readme(id, manifest), { mode: 0o600 });
    } catch (e) {
      rmSync(out, { recursive: true, force: true });
      const full = (e as NodeJS.ErrnoException).code === 'ENOSPC' || /SQLITE_FULL|disk is full/i.test((e as Error).message);
      throw new CoreError('conflict', full ? `The export stopped: the disk ${dir} is on is full. Nothing was erased.` : `The export stopped: ${(e as Error).message}. Nothing was erased.`);
    } finally {
      dropScratch(scratch);
    }
    this.#export = out;
    this.#o.log.info('reset', 'Exported everything before a reset.', { folder: out, key: keyFingerprint(key) });
    return {
      folder: out, file, memory: { json: join(out, 'memory.json'), markdown: join(out, 'memory.md') },
      recovery_key: formatRecoveryKey(key), key_fingerprint: keyFingerprint(key),
      said: `Exported to ${out}. This recovery key opens it, on any machine: keep it somewhere other than this computer. It is shown only now. ${EXPORT_SAID}`,
      left_out: Object.values(EXPORT_SKIP),
    };
  }

  // ---- staging and telling --------------------------------------------------------------------

  // Stages the reset (tier 3: the hub's own screen, confirmed every time), tells the devices it can
  // reach, ends every session, and restarts in place. `done` settles once the devices are told.
  stage(o: { confirm: unknown; who: Who }): { staged: true; id: string; restart: 'in-place' | 'next-start'; said: string; done: Promise<{ told: DeviceLine[]; not_told: DeviceLine[] }> } {
    hubScreen(o.who);
    if (o.confirm !== true) throw new CoreError('validation', `Erasing Nova needs your explicit confirmation every time (confirm: true): “${CONFIRM_WORDS}”`);
    if (this.#o.role.role() !== 'hub') throw new CoreError('conflict', 'This is the standby. Reset the hub: it tells this node to wipe its copy.');
    if (this.staged()) throw new CoreError('conflict', 'Nova is already erasing itself.');
    const b = this.#backups();
    const { own } = homeEntries(this.#o.home);
    const m: Marker = {
      v: 1, id: randomUUID(), kind: 'hub', home: resolve(this.#o.home), staged_at: this.#o.now().toISOString(), version: this.#o.version,
      vault_ids: this.#o.vault.keyIds(), own: own.filter((n) => n !== RESET_REPORT), backups: b.items, strays: b.strays, unreachable: b.unreachable,
      devices: null, export: this.#export,
    };
    writeJson(join(this.#o.home, RESET_MARKER), m);
    this.#staging = true;
    this.#o.log.info('reset', 'A factory reset is staged; telling devices first.', { id: m.id });
    const done = this.#tell(m).then(async (devices) => {
      m.devices = devices;
      writeJson(join(this.#o.home, RESET_MARKER), m);
      // Every session ends, and whatever devices hold open closes.
      this.#o.db.run('DELETE FROM device_session');
      for (const d of this.#o.devices.list()) this.#o.access.close(d.id);
      this.#o.spokes.resetNotice = null;
      this.#o.role.resetNotice = null;
      // WIRE: the checkpoints work's restart in place goes here (index.ts passes it as `restart`).
      if (this.#o.restart) await this.#o.restart();
      return devices;
    });
    return {
      staged: true, id: m.id, restart: this.#o.restart ? 'in-place' : 'next-start',
      said: this.#o.restart ? 'Nova is telling your devices, then erasing itself and starting over.' : 'Nova is telling your devices. It finishes erasing itself the next time it starts.',
      done,
    };
  }

  // Tells every device it can reach, and waits (up to tellMs) for each to hear it.
  async #tell(m: Marker): Promise<{ told: DeviceLine[]; not_told: DeviceLine[] }> {
    const notice: ResetNotice = { id: m.id, said: NOTICE_SAID };
    const { can, cant } = this.#reach();
    const told = new Map<string, DeviceLine>();
    let settle: () => void = () => {};
    const all = new Promise<void>((r) => { settle = r; });
    const check = () => { if (can.every((d) => told.has(d.id))) settle(); };
    const hear = (d: Device, said: string) => { if (can.some((c) => c.id === d.id) && !told.has(d.id)) { told.set(d.id, { ...line(d), said }); check(); } };
    this.#ack = (d, said) => hear(d, said);
    // A computer hears it in its next heartbeat; the standby in its next sync answer.
    this.#o.spokes.resetNotice = { ...notice, told: (d) => hear(d, 'Told at its heartbeat; its session ended.') };
    this.#o.role.resetNotice = notice;
    // Phones and browsers with a stream open hear it there, now.
    this.#o.emit('reset', notice);
    for (const d of can) if ((d.kind === 'phone' || d.kind === 'browser') && this.#o.access.isLive(d.id)) hear(d, 'Told on its open connection; its session ended.');
    check();
    const ms = this.#o.tellMs ?? DEFAULT_TELL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([all, new Promise<void>((r) => { timer = setTimeout(r, ms); })]);
    if (timer) clearTimeout(timer);
    this.#ack = null;
    const notTold = [
      ...can.filter((d) => !told.has(d.id)).map((d) => ({ ...line(d), said: 'It didn’t answer in time, so it wasn’t told. Its copy stays on it until it is reset or removed there.' })),
      ...cant.map((d) => ({ ...line(d), said: 'It couldn’t be reached, so it wasn’t told. Its copy stays on it until it is reset or removed there.' })),
    ];
    return { told: [...told.values()], not_told: notTold };
  }

  #ack: ((d: Device, said: string) => void) | null = null;

  // ---- on a standby: the hub was reset -----------------------------------------------------------

  // Wipes this standby's copy of the hub's data now (every replicated row, the vault and its key,
  // the copied files), stages the rest (its identity and role) for its next start, and returns
  // what it did, for the hub's result.
  async standbyWipe(notice: ResetNotice): Promise<string> {
    const home = this.#o.home;
    const { own } = homeEntries(home);
    const m: Marker = {
      v: 1, id: notice.id, kind: 'standby', home: resolve(home), staged_at: this.#o.now().toISOString(), version: this.#o.version,
      vault_ids: this.#o.vault.keyIds(), own: own.filter((n) => n !== RESET_REPORT), backups: [], strays: [], unreachable: [], devices: null, export: null,
    };
    writeJson(join(home, RESET_MARKER), m);
    this.#staging = true;
    const db = this.#o.db;
    let rows = 0;
    db.tx(() => {
      db.raw.exec('PRAGMA defer_foreign_keys = ON');
      for (const t of [...Object.keys(REPLICATED), 'sync_log']) rows += Number(db.raw.prepare(`DELETE FROM "${t}"`).run().changes);
    });
    // Nothing of it left in the file's free pages or the write-ahead log.
    db.raw.exec('VACUUM');
    db.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.#o.vault.forgetKeys();
    this.#o.vault.clear();
    const keep = new Set(['mesh', 'logs', 'nova.pid', RESET_REPORT]);
    for (const n of own) if (!keep.has(n) && !OWN_PATTERN[0]!.test(n)) rmSync(join(home, n), { recursive: true, force: true });
    this.#o.log.info('reset', 'The hub was reset: this standby wiped its copy.', { id: notice.id, rows });
    return `It wiped its copy: ${plural(rows, 'record')}, the vault and the copied files. Its own keys go when it next starts.`;
  }

  // ---- routes ---------------------------------------------------------------------------------

  routes(): Route[] {
    return [
      {
        method: 'GET', path: '/reset', summary: 'What a factory reset would erase and what it would leave: Nova’s own entries in its home, the vault’s key, its backups in every folder it used (and folders that aren’t there), devices it can and can’t tell, and the person’s own files. The hub’s own screen only.',
        handle: ({ who }) => { hubScreen(who); return this.preview(); },
      },
      {
        method: 'POST', path: '/reset/export', status: 201, summary: 'Export everything before a reset, into a folder of yours that already exists, outside Nova’s home: encrypted under a new recovery key shown once in this reply, plus memory.json and memory.md in plain text. Saved passwords, keys and this hub’s identity stay out. The hub’s own screen only.',
        body: '{folder}', handle: ({ body, who }) => { hubScreen(who); return this.exportTo(body.folder); },
      },
      {
        method: 'POST', path: '/reset', status: 202, summary: 'Erase Nova on this machine and start over (tier 3: {confirm: true}, every time, the hub’s own screen only). Devices it can reach are told first; then Nova restarts in first-run setup.',
        body: '{confirm}',
        handle: ({ body, who }) => {
          const { done, ...r } = this.stage({ confirm: body.confirm, who });
          done.catch((e) => this.#o.log.problem('reset', 'The factory reset stumbled while telling devices; it finishes when Nova next starts.', { detail: (e as Error)?.stack ?? String(e) }));
          return r;
        },
      },
      { method: 'GET', path: '/reset/report', summary: 'What the last factory reset did, for the first-run screen, or null. The hub’s own screen only.', handle: ({ who }) => { hubScreen(who); return this.report(); } },
      {
        method: 'POST', path: '/mesh/reset/ack', access: 'sync', summary: 'The standby says it wiped its copy of a hub that is being reset.', body: '{id, said}',
        handle: ({ body, who }) => {
          if (who.principal.kind !== 'device' || who.principal.device.kind !== 'standby') throw new CoreError('forbidden', 'Only the standby reports this.');
          if (!this.#ack || body.id !== this.#o.role.resetNotice?.id) throw new CoreError('conflict', 'No reset is waiting for that.');
          this.#ack(who.principal.device, typeof body.said === 'string' && body.said.trim() ? body.said.trim().slice(0, 300) : 'It wiped its copy.');
          return { ok: true };
        },
      },
    ];
  }

  // While a reset is staged nothing new is taken: only what telling devices needs gets through.
  blocks(method: string | undefined, path: string): string | null {
    if (!this.staged() || method === 'GET' || method === 'HEAD') return null;
    if (['/api/v1/mesh/reset/ack', '/api/v1/mesh/session', '/api/v1/mesh/sync/ack', '/api/v1/mesh/devices/me/heartbeat'].includes(path)) return null;
    return 'Nova is erasing itself and starting over, so it takes nothing new now.';
  }
}

const line = (d: Device): DeviceLine => ({ id: d.id, name: d.name, kind: d.kind, said: '' });

function hubScreen(who: Who): void {
  if (who.principal.kind !== 'console') throw new CoreError('forbidden', 'Erasing Nova, and the export before it, happen on the hub’s own screen only.');
}

function readme(id: string, m: Manifest): string {
  return [
    `Nova export ${id}`,
    '',
    'nova-export.nbk holds Nova’s database and its home’s files, encrypted (AES-256-GCM). It opens with',
    'the recovery key Nova showed you once when it made this export; Nova kept no copy of that key.',
    'memory.json and memory.md are what Nova remembered, in plain text.',
    '',
    'Not in this export:',
    ...m.excluded.filter((x) => /^(vault|mesh)\//.test(x)).map((x) => `- ${x}`),
    '',
    'A factory reset never touches this folder.',
    '',
  ].join('\n');
}
