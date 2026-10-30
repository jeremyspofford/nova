// The restore drill (LOCAL-FIRST §5, M7 plan §3): a backup is only a backup once it has been
// restored. The latest one is restored into a scratch home, checked, and a sandbox Nova is started
// on it and asked the smoke probes. Each check is recorded in words; any failed check fails the
// drill, and a failed drill is a problem with its playbook. The live home is only read (for what
// was forgotten), never written.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Db, Migration } from '../db.ts';
import { restoreInto, sha256File, type Manifest } from './backup.ts';
import { smoke, startSandbox } from './sandbox.ts';

export interface DrillCheck { name: string; ok: boolean; said: string }
export interface DrillResult { ok: boolean; backup: string | null; source: 'folder' | 'encrypted' | null; checks: DrillCheck[] }

export interface DrillInput {
  // The live database: read for what was forgotten, so the drill can prove it stays forgotten.
  live: Db;
  // The backup folder to restore, or an encrypted copy unpacked into one (`source`).
  backupDir: string | null;
  source: 'folder' | 'encrypted';
  // This Nova's migrations: the restored database's checksums must match them.
  migrations: Migration[];
  // The code the sandbox runs (this Nova's own, by default) and test hooks for its start.
  root?: string;
  sandboxEnv?: Record<string, string>;
  timeoutMs?: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function drill(o: DrillInput): Promise<DrillResult> {
  const checks: DrillCheck[] = [];
  const check = (name: string, ok: boolean, said: string) => { checks.push({ name, ok, said }); return ok; };
  if (!o.backupDir || !existsSync(join(o.backupDir, 'manifest.json'))) {
    check('backup', false, 'There is no finished backup to restore.');
    return { ok: false, backup: null, source: null, checks };
  }
  const scratch = mkdtempSync(join(tmpdir(), 'nova-drill-'));
  const home = join(scratch, 'home');
  try {
    let m: Manifest;
    try {
      m = restoreInto(o.backupDir, home);
      check('restore', true, `Restored ${m.id} (${m.files.length} files and the database) into a scratch home.`);
    } catch (e) {
      check('restore', false, `The backup couldn’t be restored: ${(e as Error).message}`);
      return { ok: false, backup: o.backupDir, source: o.source, checks };
    }

    // Content hashes against the manifest: what came back is what went in.
    const wrong: string[] = [];
    if (sha256File(join(home, 'nova.db')) !== m.db.sha256) wrong.push('nova.db');
    for (const f of m.files) {
      const p = join(home, f.path);
      if (!existsSync(p) || statSync(p).size !== f.bytes || sha256File(p) !== f.sha256) wrong.push(f.path);
    }
    check('content', !wrong.length, wrong.length ? `${wrong.length} ${wrong.length === 1 ? 'file doesn’t' : 'files don’t'} match the backup’s manifest: ${wrong.slice(0, 5).join(', ')}${wrong.length > 5 ? '…' : ''}.` : `All ${m.files.length + 1} files match the manifest’s hashes.`);

    // The database itself, before any Nova touches it.
    let restored: DatabaseSync | null = null;
    try {
      restored = new DatabaseSync(join(home, 'nova.db'));
      const ic = (restored.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((r) => r.integrity_check);
      check('integrity', ic.length === 1 && ic[0] === 'ok', ic[0] === 'ok' ? 'SQLite’s integrity check passed.' : `SQLite’s integrity check failed: ${ic.slice(0, 3).join('; ')}`);
    } catch (e) {
      check('integrity', false, `The database couldn’t be opened: ${(e as Error).message}`);
    }

    if (restored && checks.every((c) => c.ok)) {
      try {
        // Migration checksums: the backup's own record, the manifest, and this Nova's migrations agree.
        const rows = restored.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as unknown as Manifest['migrations'];
        const known = new Map(o.migrations.map((x) => [x.version, x]));
        const off = rows.filter((r) => known.get(r.version)?.checksum !== r.checksum).map((r) => r.version);
        const vsManifest = JSON.stringify(rows) === JSON.stringify(m.migrations);
        check('migrations', !off.length && vsManifest, off.length
          ? `Migration ${off.join(', ')} in the backup ${off.length === 1 ? 'doesn’t' : 'don’t'} match what this Nova has${rows.some((r) => !known.has(r.version)) ? ' (the backup is from a newer Nova)' : ''}.`
          : !vsManifest ? 'The database’s migration record doesn’t match the manifest.' : `All ${rows.length} migration checksums match.`);

        // Forgotten things stay forgotten: nothing the live Nova forgot is in the backup.
        const forgotten = o.live.all<{ memory_id: string }>(`SELECT DISTINCT memory_id FROM memory_event WHERE kind = 'forgotten'`).map((r) => r.memory_id);
        const has = (table: string) => !!restored!.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
        let back = 0;
        if (has('memory')) {
          const q = restored.prepare('SELECT 1 FROM memory WHERE id = ?');
          for (const id of forgotten) if (q.get(id)) back++;
        }
        // Capture forgotten with a tombstone (the source's key, hashed) must not be in it either.
        let backCapture = 0;
        if (has('capture_event')) {
          const tombs = new Set(o.live.all<{ source_id: string; key: string }>('SELECT source_id, key FROM capture_tombstone').map((t) => `${t.source_id}\0${t.key}`));
          if (tombs.size) {
            for (const r of restored.prepare('SELECT source_id, external_id FROM capture_event WHERE external_id IS NOT NULL').all() as { source_id: string; external_id: string }[]) {
              if (tombs.has(`${r.source_id}\0${sha(`${r.source_id}\0${r.external_id}`)}`)) backCapture++;
            }
          }
        }
        check('forgotten', back + backCapture === 0, back + backCapture
          ? `${back + backCapture} forgotten ${back + backCapture === 1 ? 'item is' : 'items are'} back in the backup.`
          : `None of the ${forgotten.length} forgotten ${forgotten.length === 1 ? 'memory is' : 'memories are'} in it.`);
      } catch (e) {
        check('database', false, `Nova couldn’t read the restored database: ${(e as Error).message}`);
      }
    }
    const memories = restored ? safeCount(restored) : null;
    restored?.close();
    if (!checks.every((c) => c.ok)) return { ok: false, backup: o.backupDir, source: o.source, checks };

    // A real Nova on the restored home, and the smoke probes.
    let sb: Awaited<ReturnType<typeof startSandbox>> | null = null;
    try {
      sb = await startSandbox({ ...(o.root ? { root: o.root } : {}), home, ...(o.sandboxEnv ? { env: o.sandboxEnv } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
      check('start', true, 'A sandbox Nova started on the restored home.');
      // The vault's key is never in a backup, so a restored vault can't open by design; and the
      // restored copy's own backup records describe the live home's backups, not this copy.
      for (const p of await smoke(sb.base, { ignore: ['vault', 'backups'], ...(memories === null ? {} : { memories }) })) check(`probe:${p.name}`, p.ok, p.said);
    } catch (e) {
      check('start', false, (e as Error).message);
    } finally {
      await sb?.stop();
    }
    return { ok: checks.every((c) => c.ok), backup: o.backupDir, source: o.source, checks };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function safeCount(db: DatabaseSync): number | null {
  try { return (db.prepare('SELECT COUNT(*) AS n FROM memory').get() as { n: number }).n; } catch { return null; }
}
