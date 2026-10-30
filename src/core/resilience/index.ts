// Resilience (M7b): nightly backups and the restore drill as ledger work, repair playbooks for the
// problems Nova knows how to deal with, the clock watch, and what the supervisor says. The pieces:
// backup.ts (and archive.ts for the encrypted copy), drill.ts, sandbox.ts, playbooks.ts, clock.ts,
// link.ts (the supervisor's side is src/supervisor).
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db, Migration } from '../db.ts';
import type { Log, Problem } from '../log.ts';
import type { Profile } from '../profile.ts';
import type { Ledger, LanedWorker, Task } from '../ledger.ts';
import type { Verifier } from '../verify.ts';
import type { Triggers } from '../triggers.ts';
import type { Vault } from '../vault.ts';
import type { Backups } from '../backups.ts';
import type { Brief, Report } from '../envelope.ts';
import type { Route, Who } from '../api.ts';
import { ENVELOPE_VERSION } from '../envelope.ts';
import { CoreError } from '../errors.ts';
import { BackupError, DEFAULT_KEEP, KEY_NAME, NightlyBackups, newKey, sha256File, type BackupSettings, type FailureKind } from './backup.ts';
import { drill, type DrillResult } from './drill.ts';
import { ClockWatch, duration, type Jump } from './clock.ts';
import { Playbooks } from './playbooks.ts';
import type { SupervisorLink } from './link.ts';

export const WORKER_ID = 'resilience';
export const CONFIRMATION_SYSTEM = 'nova-resilience';
// The schedules Nova keeps once a backup folder is set: visible in Automations, like every other.
export const NIGHTLY = { name: 'Nightly backup', cron: '30 3 * * *' };
export const DRILL = { name: 'Weekly restore drill', cron: '0 4 * * 0' };

export interface ResilienceOptions {
  db: Db;
  log: Log;
  home: string;
  version: string;
  profile: Profile;
  ledger: Ledger;
  verifier: Verifier;
  triggers: Triggers;
  vault: Vault;
  backups: Backups;
  migrations: () => Migration[];
  supervisor?: SupervisorLink | null;
  now: () => Date;
  monotonic?: () => number;
  // The restore drill's sandbox: which code it runs and test hooks for its start.
  drill?: { root?: string; env?: Record<string, string>; timeoutMs?: number };
}

const inside = (path: string, root: string) => {
  const r = relative(resolve(root), resolve(path));
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
};

export class Resilience {
  readonly playbooks: Playbooks;
  readonly nightly: NightlyBackups;
  readonly worker: LanedWorker;
  readonly clock: ClockWatch;
  #o: ResilienceOptions;
  // Why each failed backup task failed, for its playbook (target missing, disk full, other).
  #failed = new Map<string, FailureKind>();

  constructor(o: ResilienceOptions) {
    this.#o = o;
    this.playbooks = new Playbooks({ db: o.db, log: o.log, now: o.now });
    this.clock = new ClockWatch({ now: o.now, ...(o.monotonic ? { monotonic: o.monotonic } : {}) });
    this.nightly = new NightlyBackups({ db: o.db, home: o.home, log: o.log, version: o.version, now: o.now, settings: () => this.settings(), key: () => this.#key() });
    // Every forget reaches the nightly backups and their encrypted copies too.
    o.backups.also((table, ids, words) => this.nightly.forget(table, ids, words));
    this.worker = this.#makeWorker();
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e, brief) => this.#confirm(e as { id?: string }, brief));
    this.playbooks.repair('retry-backup', () => this.#retryBackup());
    this.playbooks.repair('free-scratch', () => this.#freeScratch());
    this.playbooks.repair('clock', () => this.#clockRepair());
    this.playbooks.repair('restart-server', async () => {
      if (!o.supervisor) return { ok: false, said: 'This Nova isn’t running under the supervisor, so it can’t be restarted from here.' };
      return o.supervisor.request('restart');
    });
    // The ledger's "a task failed" for Nova's own backup work, and the backup modules' own words.
    this.playbooks.classify((p) => {
      if (p.source === 'ledger' && p.task_id) {
        const t = this.#task(p.task_id);
        if (t?.owner !== WORKER_ID) return null;
        if ((t.brief.inputs as { action?: string } | undefined)?.action === 'drill') return { playbook: 'drill-failed', subject: null };
        const kind = this.#failed.get(t.id) ?? 'failed';
        return { playbook: kind === 'target-missing' ? 'backup-target-missing' : kind === 'disk-full' ? 'disk-full' : 'backup-failed', subject: kind === 'disk-full' ? 'backup' : null };
      }
      if (p.source === 'backups' && /deleted that (backup|copy) rather than keep it/.test(p.message)) return { playbook: 'backup-cleaning', subject: null };
      return null;
    });
    o.supervisor?.onProblem((sp) => {
      try { this.playbooks.open(sp.source, sp.said, sp.playbook, { subject: sp.subject ?? null, ...(sp.detail ? { detail: sp.detail } : {}), ...(sp.repairs ? { repairs: sp.repairs } : {}) }); } catch (e) {
        o.log.warn('resilience', 'A problem from the supervisor couldn’t be recorded.', { error: (e as Error).message });
      }
    });
  }

  // ---- settings and schedules ---------------------------------------------------------------

  settings(): BackupSettings {
    const s = this.#o.profile.section('backups');
    const keep = typeof s.keep === 'number' && Number.isInteger(s.keep) && s.keep >= 1 ? s.keep : DEFAULT_KEEP;
    return { target: typeof s.target === 'string' && s.target ? s.target : null, keep, encrypted_target: typeof s.encrypted_target === 'string' && s.encrypted_target ? s.encrypted_target : null };
  }

  setSettings(body: Record<string, unknown>): BackupSettings {
    const folder = (v: unknown, what: string): string | null => {
      if (v === null) return null;
      if (typeof v !== 'string' || !v.trim() || !isAbsolute(v.trim())) throw new CoreError('validation', `${what} is a folder’s full path (or null for none).`);
      const p = resolve(v.trim());
      let dir = false;
      try { dir = statSync(p).isDirectory(); } catch { /* not there */ }
      if (!dir) throw new CoreError('validation', `${p} isn’t a folder Nova can see. Make it first (or plug in its drive): Nova never creates a backup folder itself.`);
      if (inside(p, this.#o.home) || inside(this.#o.home, p)) throw new CoreError('validation', `${what} can’t be inside Nova’s home or contain it: a backup would contain itself.`);
      return p;
    };
    const next = { ...this.settings() };
    if (body.target !== undefined) next.target = folder(body.target, 'target');
    if (body.encrypted_target !== undefined) next.encrypted_target = folder(body.encrypted_target, 'encrypted_target');
    if (body.keep !== undefined) {
      if (!Number.isInteger(body.keep) || (body.keep as number) < 1 || (body.keep as number) > 365) throw new CoreError('validation', 'keep is how many backups to keep: a whole number from 1 to 365.');
      next.keep = body.keep as number;
    }
    if (next.encrypted_target && next.encrypted_target === next.target) throw new CoreError('validation', 'The encrypted copy goes to a second folder, not the backup folder itself.');
    if (next.encrypted_target && !next.target) throw new CoreError('validation', 'Choose the backup folder first; the encrypted copy is made from each backup.');
    // The encrypted copy's key goes into the vault now, so a vault that can't take it says so here.
    if (next.encrypted_target) this.#key();
    this.#o.profile.set('backups', 'target', next.target, 'settings');
    this.#o.profile.set('backups', 'encrypted_target', next.encrypted_target, 'settings');
    this.#o.profile.set('backups', 'keep', next.keep, 'settings');
    this.#schedules(!!next.target);
    return next;
  }

  // The nightly backup and the weekly drill, as heartbeat rules everyone can see and pause.
  #schedules(on: boolean): void {
    const t = this.#o.triggers;
    const mine = t.listRules().filter((r) => r.action.kind === 'task' && r.action.task.owner === WORKER_ID);
    for (const [def, action] of [[NIGHTLY, 'backup'], [DRILL, 'drill']] as const) {
      const have = mine.find((r) => r.action.kind === 'task' && (r.action.task.inputs as { action?: string } | undefined)?.action === action);
      if (!on) { if (have) t.deleteRule(have.id); continue; }
      if (have) continue;
      t.createRule({
        name: def.name, class: 'heartbeat', cron: def.cron,
        action: { kind: 'task', task: this.#taskInput(action) },
      }, 'nova');
    }
  }

  #taskInput(action: 'backup' | 'drill') {
    return action === 'backup'
      ? { title: 'Nightly backup', owner: WORKER_ID, goal: 'Back up the database and the home’s files to the backup folder, with an encrypted copy if one is set.', evidence_required: [{ kind: 'confirmation' as const, note: 'Nova reads the backup back and checks its hashes' }], approval_tier: 0 as const, user_visibility: 'silent' as const, inputs: { action } }
      : { title: 'Restore drill', owner: WORKER_ID, goal: 'Restore the latest backup into a scratch home, check it, and start a sandbox Nova on it.', evidence_required: [{ kind: 'confirmation' as const, note: 'the drill’s checks, recorded by Nova' }], approval_tier: 0 as const, user_visibility: 'silent' as const, inputs: { action } };
  }

  // On demand: the same work as the schedule, as a ledger task now.
  request(action: 'backup' | 'drill', o: { source?: 'folder' | 'encrypted' } = {}): Task {
    if (!this.settings().target && action === 'backup') throw new CoreError('validation', 'Choose a backup folder first (PUT /api/v1/backups/settings).');
    const input = this.#taskInput(action);
    const task = this.#o.ledger.create({ ...input, user_visibility: 'handling', title: action === 'backup' ? 'Backup now' : 'Restore drill now', origin: { kind: 'user' }, inputs: { ...input.inputs, ...(o.source ? { source: o.source } : {}) } });
    void this.#o.ledger.pump();
    return task;
  }

  // ---- the worker ---------------------------------------------------------------------------

  #makeWorker(): LanedWorker {
    return {
      id: WORKER_ID, name: 'Backups', about: 'Makes the nightly backup and runs the restore drill, on this machine only.', egress: 'none', evidence: ['confirmation'],
      timeoutMs: 15 * 60_000,
      lane: () => ({ key: 'resilience', max: 1 }),
      health: () => ({ ok: true }),
      run: async (brief: Brief) => {
        const started = performance.now();
        const report = (status: Report['status'], summary: string, more: Partial<Report> = {}): Report => ({
          envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary, evidence: [], artifacts: [], blockers: status === 'blocked' ? [summary] : [], follow_up_suggestions: [],
          ...more, usage: { duration_ms: Math.round(performance.now() - started) },
        });
        const i = (brief.inputs ?? {}) as { action?: string; source?: string };
        if (i.action === 'backup') {
          try {
            const r = this.nightly.run({ taskId: brief.task_id });
            if (r.encrypted_error) this.playbooks.open('backups', r.encrypted_error, 'backup-failed', { subject: 'encrypted', taskId: brief.task_id });
            else this.#resolveOpen(['backup-failed', 'backup-target-missing'], [null, 'encrypted']);
            const mb = (r.bytes / 1e6).toFixed(1);
            return report('done', `Backed up the database and ${r.files} files (${mb} MB) to ${r.path}.${r.encrypted_path ? ` The encrypted copy is ${r.encrypted_path}.` : ''}`, {
              evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `backup:${r.id}@${r.manifest.db.sha256}` }],
              artifacts: [{ kind: 'backup', ref: r.path!, sha256: r.manifest.db.sha256 }],
            });
          } catch (e) {
            if (e instanceof BackupError) this.#failed.set(brief.task_id, e.kind);
            return report('failed', (e as Error).message);
          }
        }
        if (i.action === 'drill') {
          const r = await this.drill({ source: i.source === 'encrypted' ? 'encrypted' : 'folder', taskId: brief.task_id });
          const failed = r.checks.filter((c) => !c.ok);
          this.#o.ledger.note(brief.task_id, 'drill_checks', { backup: r.backup, source: r.source, checks: r.checks });
          if (!r.ok) return report('failed', `The restore drill failed: ${failed.map((c) => c.said).join(' ')}`);
          return report('done', `The restore drill passed: ${r.checks.length} checks, the latest backup restored and a sandbox Nova answered on it.`, {
            evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `drill:${r.id}` }],
          });
        }
        return report('failed', 'The brief asks for something the backups worker doesn’t do.');
      },
    };
  }

  // Runs the drill now, records it, and returns its checks. A passed drill closes an open
  // drill-failed problem; a failed one opens it (through the ledger's failure).
  async drill(o: { source?: 'folder' | 'encrypted'; taskId?: string } = {}): Promise<DrillResult & { id: string }> {
    const id = randomUUID();
    let dir: string | null = null;
    let scratch: string | null = null;
    try {
      if (o.source === 'encrypted') {
        const latest = this.nightly.encrypted()[0];
        if (latest) {
          scratch = mkdtempSync(join(tmpdir(), 'nova-drill-open-'));
          try {
            this.nightly.decrypt(latest.path, join(scratch, 'backup'));
            dir = join(scratch, 'backup');
          } catch (e) {
            const r: DrillResult = { ok: false, backup: latest.path, source: 'encrypted', checks: [{ name: 'decrypt', ok: false, said: `The encrypted copy couldn’t be opened: ${(e as Error).message}` }] };
            return this.#record(id, r, o.taskId);
          }
        }
      } else dir = this.nightly.complete()[0]?.path ?? null;
      const r = await drill({
        live: this.#o.db, backupDir: dir, source: o.source ?? 'folder', migrations: this.#o.migrations(),
        ...(this.#o.drill?.root ? { root: this.#o.drill.root } : {}), ...(this.#o.drill?.env ? { sandboxEnv: this.#o.drill.env } : {}), ...(this.#o.drill?.timeoutMs ? { timeoutMs: this.#o.drill.timeoutMs } : {}),
      });
      if (o.source === 'encrypted' && r.backup) r.backup = this.nightly.encrypted()[0]?.path ?? r.backup;
      return this.#record(id, r, o.taskId);
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }

  #record(id: string, r: DrillResult, taskId?: string): DrillResult & { id: string } {
    this.#o.db.run('INSERT INTO backup_drill (id, at, backup_id, ok, checks, task_id) VALUES (?, ?, ?, ?, ?, ?)', id, this.#o.now().toISOString(), r.backup, r.ok ? 1 : 0, JSON.stringify(r.checks), taskId ?? null);
    if (r.ok) this.#resolveOpen(['drill-failed'], [null]);
    return { ...r, id };
  }

  drills(limit = 10): { id: string; at: string; backup_id: string | null; ok: boolean; checks: { name: string; ok: boolean; said: string }[]; task_id: string | null }[] {
    return this.#o.db.all<Record<string, unknown>>('SELECT * FROM backup_drill ORDER BY at DESC LIMIT ?', limit)
      .map((r) => ({ id: String(r.id), at: String(r.at), backup_id: (r.backup_id as string | null) ?? null, ok: r.ok === 1, checks: JSON.parse(String(r.checks)), task_id: (r.task_id as string | null) ?? null }));
  }

  // ---- evidence -----------------------------------------------------------------------------

  // A backup counts only if Nova reads it back itself: the manifest is there, and the database's
  // hash in it matches the file. A drill counts only as recorded by Nova, for this task.
  #confirm(e: { id?: string }, brief: Brief): { ok: boolean; why: string } {
    const id = e.id ?? '';
    const b = /^backup:(nova-backup-\d+)@([0-9a-f]{64})$/.exec(id);
    if (b) {
      const found = this.nightly.complete().find((x) => x.manifest.id === b[1]);
      if (!found) return { ok: false, why: `Nova looked for ${b[1]} in the backup folder and it isn’t there.` };
      const actual = sha256File(join(found.path, 'nova.db'));
      if (actual !== b[2] || found.manifest.db.sha256 !== b[2]) return { ok: false, why: `${b[1]}’s database doesn’t match what the backup reported.` };
      return { ok: true, why: `Nova read ${b[1]} back itself: the database’s hash matches its manifest, with ${found.manifest.files.length} files listed.` };
    }
    const d = /^drill:([0-9a-f-]{36})$/.exec(id);
    if (d) {
      const row = this.#o.db.get<{ ok: number; task_id: string | null; checks: string }>('SELECT ok, task_id, checks FROM backup_drill WHERE id = ?', d[1]!);
      if (!row || row.task_id !== brief.task_id) return { ok: false, why: 'Nova has no record of that drill for this task.' };
      return row.ok === 1 ? { ok: true, why: `Nova recorded the drill itself: all ${JSON.parse(row.checks).length} checks passed.` } : { ok: false, why: 'Nova’s record of that drill says it failed.' };
    }
    return { ok: false, why: 'Not a confirmation the backups worker gives.' };
  }

  // ---- repairs --------------------------------------------------------------------------------

  async #retryBackup() {
    const s = this.settings();
    if (s.target && !existsSync(s.target)) return { ok: false, said: `The backup folder ${s.target} still isn’t there.` };
    try {
      const r = this.nightly.run();
      this.#resolveOpen(['backup-failed', 'backup-target-missing'], [null]);
      return { ok: true, said: `Backed up again: ${r.id}.`, resolved: true };
    } catch (e) {
      return { ok: false, said: (e as Error).message };
    }
  }

  // Nova's own leftovers only: sandbox and drill copies in the temporary folder it made.
  async #freeScratch() {
    let n = 0;
    for (const e of readdirSync(tmpdir())) {
      if (!/^nova-(drill|drill-open|forget|sandbox)-/.test(e)) continue;
      try { rmSync(join(tmpdir(), e), { recursive: true, force: true }); n++; } catch { /* in use */ }
    }
    return { ok: true, said: n ? `Deleted ${n} of Nova’s own scratch folders.` : 'Nova had no scratch of its own to delete.' };
  }

  // ---- the clock ----------------------------------------------------------------------------

  // Called by the heartbeat, and once at start with the newest time Nova had written down.
  checkClock(atStart = false): Jump | null {
    let j: Jump | null;
    if (atStart) {
      const newest = this.#o.db.get<{ at: string | null }>(`SELECT MAX(at) AS at FROM (SELECT MAX(at) AS at FROM task_event UNION ALL SELECT MAX(at) FROM trigger UNION ALL SELECT MAX(at) FROM memory_event)`)?.at ?? null;
      j = ClockWatch.atStart(newest, this.#o.now());
      this.clock.look();
    } else j = this.clock.look();
    if (!j) return null;
    const words = j.direction === 'forward'
      ? `This computer’s clock jumped ${duration(j.ms)} ahead${j.while === 'running' ? ' while Nova was running' : ''}. Schedules that “missed” their time ran once or were recorded as missed; deleting old capture is on hold until you say the time is right.`
      : `This computer’s clock went back ${duration(j.ms)}${j.while === 'stopped' ? ' while Nova was off' : ''}. Nova put its schedules back on time and holds deleting old capture until you say the time is right.`;
    this.playbooks.open('clock', words, 'clock-jump', { subject: 'clock', detail: JSON.stringify(j) });
    return j;
  }

  // While a clock jump is open, nothing is deleted for being old: it may not be.
  retentionHeld(): string | null {
    return this.playbooks.openFor('clock-jump', 'clock') ? 'The clock jumped, so Nova holds deleting old capture until you say the time is right.' : null;
  }

  async #clockRepair() {
    const now = this.#o.now().toISOString();
    let rules = 0;
    let sessions = 0;
    this.#o.db.tx(() => {
      rules = this.#o.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trigger_rule WHERE last_due_at > ?', now)?.n ?? 0;
      this.#o.db.run('UPDATE trigger_rule SET last_due_at = ? WHERE last_due_at > ?', now, now);
      sessions = this.#o.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM device_session WHERE created_at > ?', now)?.n ?? 0;
      this.#o.db.run('DELETE FROM device_session WHERE created_at > ?', now);
    });
    return { ok: true, said: `Put ${rules} schedule${rules === 1 ? '' : 's'} back on time and ended ${sessions} device sign-in${sessions === 1 ? '' : 's'} dated in the future. Deleting old capture waits for you.` };
  }

  // ---- helpers --------------------------------------------------------------------------------

  #resolveOpen(playbooks: string[], subjects: (string | null)[]): void {
    for (const pb of playbooks) for (const s of subjects) {
      const p = this.playbooks.openFor(pb, s);
      if (p) this.#o.log.resolve(p.id);
    }
  }

  #task(id: string): Task | null {
    try { return this.#o.ledger.get(id); } catch { return null; }
  }

  #key(): Buffer {
    const v = this.#o.vault;
    let k = v.get(KEY_NAME);
    if (!k) { k = newKey().toString('base64'); v.put(KEY_NAME, k); }
    return Buffer.from(k, 'base64');
  }

  // What Health shows: the supervisor, releases, backups and the last drill.
  view() {
    const s = this.settings();
    const runs = this.nightly.runs(10);
    const last = runs[0] ?? null;
    const lastOk = runs.find((r) => r.ok) ?? null;
    const complete = this.nightly.complete();
    const drills = this.drills(1);
    const sup = this.#o.supervisor?.state() ?? null;
    return {
      supervisor: sup ? { mode: sup.mode, since: sup.since, server: sup.server, safe_mode: sup.safe_mode, health: sup.health } : null,
      releases: sup ? { ...sup.releases, deploy: sup.deploy, history: sup.history.slice(0, 5) } : null,
      backups: {
        settings: s,
        target_present: s.target ? existsSync(s.target) : null,
        last: last ? { ...last } : null,
        last_ok: lastOk,
        count: complete.length,
        encrypted: s.encrypted_target ? this.nightly.encrypted().length : null,
        schedule: { nightly: NIGHTLY.cron, drill: DRILL.cron },
      },
      drill: drills[0] ?? null,
      clock: { held: this.retentionHeld() },
    };
  }

  health(): { ok: boolean; detail: string } {
    const s = this.settings();
    if (!s.target) return { ok: true, detail: 'No backup folder set yet.' };
    if (!existsSync(s.target)) return { ok: false, detail: `The backup folder ${s.target} isn’t there.` };
    const last = this.nightly.runs(1)[0];
    if (last && !last.ok) return { ok: false, detail: `The last backup didn’t finish: ${last.error}` };
    const d = this.drills(1)[0];
    if (d && !d.ok) return { ok: false, detail: 'The last restore drill failed.' };
    return { ok: true, detail: last ? `Last backup ${last.at}.` : 'No backup yet.' };
  }

  routes(console: (who: Who) => void): Route[] {
    const sup = () => {
      if (!this.#o.supervisor) throw new CoreError('conflict', 'This Nova isn’t running under the supervisor (node src/supervisor/main.ts run), so it has no releases to deploy or roll back.');
      return this.#o.supervisor;
    };
    return [
      { method: 'GET', path: '/resilience', summary: 'Keeping Nova running: the supervisor, releases (current, previous, a canary in progress), backups and the last restore drill.', handle: () => this.view() },
      { method: 'GET', path: '/backups', summary: 'Backups: the settings, recent runs, the backups in the folder and the encrypted copies.', handle: () => ({ settings: this.settings(), runs: this.nightly.runs(), complete: this.nightly.complete().map((b) => ({ path: b.path, ...b.manifest, files: b.manifest.files.length })), encrypted: this.nightly.encrypted(), drills: this.drills() }) },
      {
        method: 'PUT', path: '/backups/settings', summary: 'Where backups go (a folder that must already exist, outside Nova’s home), how many to keep, and a second folder for an encrypted copy (AES-256-GCM, key in the vault). Setting a folder starts the nightly backup and the weekly drill.',
        body: '{target?, keep?, encrypted_target?}', handle: ({ body }) => this.setSettings(body),
      },
      { method: 'POST', path: '/backups', status: 202, summary: 'Back up now, as a ledger task.', handle: () => this.request('backup') },
      { method: 'POST', path: '/backups/drill', status: 202, summary: 'Run the restore drill now, as a ledger task. {source: encrypted} drills the encrypted copy.', body: '{source?}', handle: ({ body }) => this.request('drill', body.source === 'encrypted' ? { source: 'encrypted' } : {}) },
      { method: 'GET', path: '/supervisor', summary: 'What the supervisor says: the server process, safe mode, health checks, releases and any deploy in progress. Null when Nova runs without it.', handle: () => this.#o.supervisor?.state() ?? null },
      {
        method: 'POST', path: '/supervisor/deploy', status: 202, summary: 'Deploy a tagged release (tier 3: {version, confirm: true}, the hub’s own screen only). Its tests, a sandbox start, smoke probes, the switch, then a canary window that rolls back by itself if health fails.',
        body: '{version, confirm}',
        handle: async ({ body, who }) => {
          console(who);
          if (typeof body.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.version)) throw new CoreError('validation', 'version is a release’s tag, like v1.2.0.');
          if (body.confirm !== true) throw new CoreError('validation', 'Deploying a release changes Nova itself: it needs your explicit confirmation every time (confirm: true).');
          const r = await sup().request('deploy', { version: body.version });
          if (!r.ok) throw new CoreError('conflict', r.said);
          return r;
        },
      },
      {
        method: 'POST', path: '/supervisor/rollback', status: 202, summary: 'Go back to the previous release ({confirm: true}, the hub’s own screen only). Refused, with the reason, when it would lose what was written since a database upgrade.',
        body: '{confirm}',
        handle: async ({ body, who }) => {
          console(who);
          if (body.confirm !== true) throw new CoreError('validation', 'Going back to the previous release needs your confirmation (confirm: true).');
          const r = await sup().request('rollback');
          if (!r.ok) throw new CoreError('conflict', r.said);
          return r;
        },
      },
      ...this.playbooks.routes(),
    ];
  }

  // The heartbeat's part: the clock, and Nova's own retries of repairs.
  async sweep(): Promise<void> {
    this.checkClock();
    await this.playbooks.sweep();
  }

  problemFor(p: Problem) {
    return this.playbooks.view(p.id);
  }
}

export { PLAYBOOKS } from './playbooks.ts';
export type { SupervisorLink, SupervisorState, SupervisorProblem } from './link.ts';
