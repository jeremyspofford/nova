// Restoring a nightly backup (F-018; ruling D7: a command first, no screen). Used by
// scripts/restore-backup.js and documented in docs/restore.md, which Health links to.
//
// A backup becomes a new home, never written over an old one: a backup folder as it is, or an
// encrypted copy opened with the person's recovery key alone (no vault, any machine). Before the new
// home is in place, every file is checked against the backup's manifest, the database's integrity
// and its migrations against this Nova's, and what the person forgot is taken out again:
//  - the backup's own records of forgets (memories by id, capture by its tombstones);
//  - when the home it replaces is still there (`keepFrom`), everything a checkpoint restore keeps
//    from now (restore.ts carryOver): forgets made since (memories, capture and day notes), revoked
//    devices, this node's keys, problems and Nova's records of its backups.
//
// The vault (F-014): no checkpoint and no backup brings secrets back. A backup holds the vault's
// file, still encrypted, and never its key. If the key this computer holds still opens that file,
// the secrets are as they were at the backup; with `keepFrom`, the vault is the replaced home's as it
// is now (carryOver). Otherwise the file is set aside (vault/secrets.json.unopenable-<time>) and
// Nova starts with an empty vault, an open problem says connectors need signing in again, and the
// encrypted copies keep the person's recovery key when that is what opened the backup.
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db, type Migration } from '../db.ts';
import { cleanDbFile } from '../backups.ts';
import { CoreError } from '../errors.ts';
import { Vault } from '../vault.ts';
import { sha256 } from '../workspace.ts';
import { KEY_NAME, inside, openEncrypted, parseRecoveryKey, restoreInto, sha256File, type Manifest } from './backup.ts';
import { carryOver } from './restore.ts';
import type { Carried } from './checkpoints.ts';
import { dropScratch, makeScratch } from './scratch.ts';

export interface RestoreBackupOptions {
  // A backup folder (nova-backup-NNNNNN) or an encrypted copy (nova-backup-NNNNNN.nbk).
  from: string;
  // The new home: a folder that isn't there yet, or an empty one.
  into: string;
  // The encrypted copy's recovery key, as the person keeps it.
  recoveryKey?: string;
  // The home this restore replaces, when it is still there (stopped): what is kept from now.
  keepFrom?: string | null;
  // This Nova's migrations: a backup from a newer Nova, or one whose migrations differ, isn't restored.
  migrations: Migration[];
  // How a home's vault is opened (tests pass file-key mode).
  vaultAt?: (home: string) => Vault;
  now?: () => Date;
}

export interface RestoreBackupResult {
  home: string;
  source: 'folder' | 'encrypted';
  backup: { id: string; seq: number; at: string; nova_version: string; schema_version: number };
  files: number;
  forgotten: { memories: number; capture: number };
  kept: Carried | null;
  // opened: the backup's vault opened with a key this computer holds; now: the replaced home's
  // vault as it is now; set-aside: it couldn't be opened, so Nova starts with an empty one; none:
  // the backup had no vault.
  vault: 'opened' | 'now' | 'set-aside' | 'none';
  backups: { target: string | null; encrypted_target: string | null };
  said: string[];
}

const has = (d: DatabaseSync, table: string) => !!d.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
const empty = (dir: string) => !existsSync(dir) || (statSync(dir).isDirectory() && readdirSync(dir).length === 0);

export function restoreFromBackup(o: RestoreBackupOptions): RestoreBackupResult {
  const from = resolve(o.from);
  const into = resolve(o.into);
  const keepFrom = o.keepFrom ? resolve(o.keepFrom) : null;
  const vaultAt = o.vaultAt ?? ((h: string) => new Vault({ home: h }));
  const now = o.now ?? (() => new Date());
  if (!existsSync(from)) throw new CoreError('not_found', `There is no backup at ${from}.`);
  if (!empty(into)) throw new CoreError('conflict', `${into} isn’t empty. Restore into a new folder: Nova never restores over a home. To replace a home, stop Nova, move it aside, and name it with --keep-from.`);
  if (inside(into, from) || inside(from, into)) throw new CoreError('validation', 'The new home can’t be inside the backup, or the backup inside it.');
  if (keepFrom) {
    if (keepFrom === into || inside(into, keepFrom) || inside(keepFrom, into)) throw new CoreError('validation', 'The home to keep things from is the old one; restore into a different, new folder.');
    if (!existsSync(join(keepFrom, 'nova.db'))) throw new CoreError('not_found', `${keepFrom} has no database (nova.db), so there is nothing to keep from it.`);
  }

  const encrypted = statSync(from).isFile();
  let scratch: string | null = null;
  const stage = join(dirname(into), `.${basename(into)}.restoring-${randomBytes(4).toString('hex')}`);
  try {
    let dir = from;
    if (encrypted) {
      if (!o.recoveryKey) throw new CoreError('validation', 'An encrypted copy opens with its recovery key (the 64 digits and letters a–f you were shown when you set it up).');
      parseRecoveryKey(o.recoveryKey);
      scratch = makeScratch('restore-open');
      dir = join(scratch, 'backup');
      openEncrypted(from, o.recoveryKey, dir);
    } else if (!existsSync(join(from, 'manifest.json'))) {
      throw new CoreError('validation', `${from} isn’t a backup: it has no manifest.json. Name a nova-backup-NNNNNN folder, or an encrypted copy (.nbk).`);
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
    const newest = o.migrations.at(-1)?.version ?? 0;
    if (manifest.schema_version > newest) throw new CoreError('conflict', `The backup was made by a newer Nova (database version ${manifest.schema_version}); this one knows up to ${newest}. Restore it with that version or later.`);

    mkdirSync(dirname(into), { recursive: true });
    restoreInto(dir, stage);
    checkRestored(stage, manifest, o.migrations);

    // What is kept from the home this replaces, exactly as a checkpoint restore keeps it.
    let kept: Carried | null = null;
    if (keepFrom) {
      const live = new Db(join(keepFrom, 'nova.db'));
      try {
        kept = carryOver({ home: keepFrom, staged: stage, live, hubId: hubOf(keepFrom, live), now: now(), vault: vaultAt(keepFrom), vaultAt });
      } finally {
        live.close();
      }
    }
    const forgotten = forgetAgain(stage);
    const vault = settleVault(stage, { vaultAt, keepFrom, recoveryKey: encrypted ? o.recoveryKey! : null, at: manifest.at, now });
    const backups = backupSettings(stage);

    if (existsSync(into)) rmdirSync(into);
    renameSync(stage, into);

    const said: string[] = [
      `Restored ${manifest.id} (made ${manifest.at} by Nova ${manifest.nova_version}) into ${into}: the database and ${manifest.files.length} files, each checked against the backup’s manifest.`,
      forgotten.memories + forgotten.capture + (kept ? kept.forgotten.memories + kept.forgotten.capture : 0)
        ? `Things you asked Nova to forget were taken out again: ${forgotten.memories + (kept?.forgotten.memories ?? 0)} memories and ${forgotten.capture + (kept?.forgotten.capture ?? 0)} captured items.`
        : 'Nothing you asked Nova to forget was in it.',
      VAULT_WORDS[vault],
      backups.target
        ? `Backups still go to ${backups.target}${backups.encrypted_target ? ` (encrypted copies to ${backups.encrypted_target})` : ''}. Change that in Settings › Backups if that folder belongs to the old computer.${vault === 'set-aside' ? ' The backups already there were sealed with the old vault’s key, so this Nova leaves them alone: it never prunes or restores them.' : ''}`
        : 'No backup folder is set: choose one in Settings › Backups.',
    ];
    if (kept) said.splice(2, 0, `Kept from ${keepFrom}: ${kept.revoked.length} revoked device${kept.revoked.length === 1 ? '' : 's'} stay revoked, ${kept.dropped.length} paired since need${kept.dropped.length === 1 ? 's' : ''} pairing again, ${kept.problems.carried} problem${kept.problems.carried === 1 ? '' : 's'} carried. ${kept.identity}`);
    return {
      home: into, source: encrypted ? 'encrypted' : 'folder',
      backup: { id: manifest.id, seq: manifest.seq, at: manifest.at, nova_version: manifest.nova_version, schema_version: manifest.schema_version },
      files: manifest.files.length, forgotten, kept, vault, backups, said,
    };
  } catch (e) {
    rmSync(stage, { recursive: true, force: true });
    throw e;
  } finally {
    if (scratch) dropScratch(scratch);
  }
}

const VAULT_WORDS: Record<RestoreBackupResult['vault'], string> = {
  opened: 'Your saved secrets came back from the backup’s encrypted vault file, opened with the key this computer still holds. A secret deleted after the backup was made doesn’t open: deleting one changes that key.',
  now: 'Your saved secrets are as they are now in the home you kept from: a restore never brings back one you deleted.',
  'set-aside': 'Your saved secrets didn’t come back: a backup never holds the vault’s key, and this computer doesn’t have it. Nova starts with an empty vault (the old file is kept aside in vault/). Sign in to each connector and enter each provider key again.',
  none: 'The backup had no saved secrets.',
};

// The restored home is what was backed up: every file's hash, the database's integrity, and
// migrations this Nova knows and agrees with.
function checkRestored(home: string, m: Manifest, migrations: Migration[]): void {
  const wrong: string[] = [];
  if (sha256File(join(home, 'nova.db')) !== m.db.sha256) wrong.push('nova.db');
  for (const f of m.files) {
    const p = join(home, f.path);
    if (!existsSync(p) || statSync(p).size !== f.bytes || sha256File(p) !== f.sha256) wrong.push(f.path);
  }
  if (wrong.length) throw new CoreError('conflict', `The backup is damaged: ${wrong.length} ${wrong.length === 1 ? 'file doesn’t' : 'files don’t'} match its manifest (${wrong.slice(0, 5).join(', ')}${wrong.length > 5 ? '…' : ''}). Nothing was restored.`);
  const d = new DatabaseSync(join(home, 'nova.db'));
  try {
    const ic = (d.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check);
    if (ic.length !== 1 || ic[0] !== 'ok') throw new CoreError('conflict', `The backup’s database fails SQLite’s integrity check (${ic.slice(0, 3).join('; ')}). Nothing was restored.`);
    const known = new Map(migrations.map((x) => [x.version, x]));
    const off = (d.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as { version: number; checksum: string }[]).filter((r) => known.get(r.version)?.checksum !== r.checksum).map((r) => r.version);
    if (off.length) throw new CoreError('conflict', `Migration ${off.join(', ')} in the backup ${off.length === 1 ? 'doesn’t' : 'don’t'} match what this Nova has. Restore it with the version of Nova that made it (${m.nova_version}). Nothing was restored.`);
  } finally {
    d.close();
  }
}

// The replaced home's hub id: the one its mesh records, or its identity file's.
function hubOf(home: string, live: Db): string {
  const id = live.get<{ hub_id: string | null }>('SELECT hub_id FROM mesh_state WHERE id = 1')?.hub_id ?? null;
  if (id) return id;
  try { return (JSON.parse(readFileSync(join(home, 'mesh', 'identity.json'), 'utf8')) as { id: string }).id; } catch { return ''; }
}

// The backup's own records of forgets, applied again: a memory with a "forgotten" note, and capture
// whose source key has a tombstone, are deleted the way every forget deletes (pages overwritten).
function forgetAgain(home: string): { memories: number; capture: number } {
  const file = join(home, 'nova.db');
  const memories: string[] = [];
  const capture: string[] = [];
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    if (has(d, 'memory_event') && has(d, 'memory')) {
      memories.push(...(d.prepare(`SELECT DISTINCT e.memory_id AS id FROM memory_event e JOIN memory m ON m.id = e.memory_id WHERE e.kind = 'forgotten'`).all() as { id: string }[]).map((r) => r.id));
    }
    if (has(d, 'capture_tombstone') && has(d, 'capture_event')) {
      const keys = new Set((d.prepare('SELECT source_id, key FROM capture_tombstone').all() as { source_id: string; key: string }[]).map((t) => `${t.source_id}\0${t.key}`));
      if (keys.size) {
        for (const r of d.prepare('SELECT id, source_id, external_id FROM capture_event WHERE external_id IS NOT NULL').all() as { id: string; source_id: string; external_id: string }[]) {
          if (keys.has(`${r.source_id}\0${sha256(`${r.source_id}\0${r.external_id}`)}`)) capture.push(r.id);
        }
      }
    }
  } finally {
    d.close();
  }
  if (memories.length) cleanDbFile(file, 'memory', memories);
  if (capture.length) for (const id of cleanDbFile(file, 'capture_event', capture)) rmSync(join(home, 'capture', 'raw', id), { force: true });
  return { memories: memories.length, capture: capture.length };
}

// The vault (F-014): never from a checkpoint and never its key from a backup. See the top of the file.
function settleVault(home: string, o: { vaultAt: (home: string) => Vault; keepFrom: string | null; recoveryKey: string | null; at: string; now: () => Date }): RestoreBackupResult['vault'] {
  // The home this replaces is still here: its vault, as it is now, is the one (a secret deleted
  // since the backup stays deleted), whatever the backup's file holds.
  if (o.keepFrom && existsSync(join(o.keepFrom, 'vault', 'secrets.json')) && o.vaultAt(o.keepFrom).status().ok) {
    rmSync(join(home, 'vault'), { recursive: true, force: true });
    cpSync(join(o.keepFrom, 'vault'), join(home, 'vault'), { recursive: true });
    if (o.vaultAt(home).status().ok) return 'now';
  }
  const file = join(home, 'vault', 'secrets.json');
  if (!existsSync(file)) return 'none';
  const v = o.vaultAt(home);
  if (v.status().ok) return 'opened';
  v.reset(true);
  // The encrypted copies go on opening with the recovery key the person holds.
  if (o.recoveryKey) v.put(KEY_NAME, parseRecoveryKey(o.recoveryKey).toString('base64'));
  const d = new DatabaseSync(join(home, 'nova.db'));
  try {
    const stops = (d.prepare(`PRAGMA table_info(problem)`).all() as { name: string }[]).some((c) => c.name === 'stops');
    d.prepare(`INSERT INTO problem (at, source, message${stops ? ', stops' : ''}) VALUES (?, ?, ?${stops ? ', 0' : ''})`).run(
      o.now().toISOString(), 'resilience',
      `Nova was restored from the backup of ${o.at}. Your saved secrets weren’t in it (a backup never holds the vault’s key), so sign in to each connector and enter each provider key again. The old vault file is kept aside in vault/ in case its key turns up.`,
    );
  } finally {
    d.close();
  }
  return 'set-aside';
}

// Where the restored home's backups go: the backup's own settings.
function backupSettings(home: string): { target: string | null; encrypted_target: string | null } {
  const d = new DatabaseSync(join(home, 'nova.db'), { readOnly: true });
  try {
    if (!has(d, 'profile')) return { target: null, encrypted_target: null };
    const get = (key: string) => {
      const r = d.prepare(`SELECT value FROM profile WHERE section = 'backups' AND key = ?`).get(key) as { value: string } | undefined;
      try { const v = r ? JSON.parse(r.value) : null; return typeof v === 'string' && v ? v : null; } catch { return null; }
    };
    return { target: get('target'), encrypted_target: get('encrypted_target') };
  } finally {
    d.close();
  }
}
