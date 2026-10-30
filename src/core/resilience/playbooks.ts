// Repair playbooks (NOVA-SPEC §7, M7 plan §2). A problem Nova knows how to deal with carries a
// playbook: what happened in a few words, the steps the person can take, and, where one is safe,
// a repair Nova makes by itself. "Safe" means it can't lose or change the person's data: start a
// process again, ask a worker again, put work that never ran back in the queue, reconnect, copy
// again. Every attempt is recorded with the problem, so the person sees what Nova already did, and
// a problem is marked dealt with only when the repair could tell the cause is gone.
import { EventEmitter } from 'node:events';
import type { Db } from '../db.ts';
import { UNSAVED_FROM, type Log, type Problem } from '../log.ts';
import type { Route } from '../api.ts';
import { CoreError } from '../errors.ts';
import { allows } from '../mesh/access.ts';

export interface PlaybookDef {
  id: string;
  // What kind of problem this is, in a few words.
  title: string;
  // What the person can do, in order. Plain words; a command only where one is the way.
  steps: string[];
  // The repair Nova makes by itself, by name, and what it does in words. None when no repair is safe.
  repair?: string;
  automatic?: string;
}

export const PLAYBOOKS: Readonly<Record<string, PlaybookDef>> = {
  // ---- the hub's own process (the supervisor, src/supervisor) ----
  'server-crashed': {
    id: 'server-crashed', title: 'Nova stopped unexpectedly',
    repair: 'restart-server', automatic: 'The supervisor starts Nova again, waiting a little longer after each crash. This closes by itself once Nova is running again.',
    steps: ['Nothing to do if Nova stays up: work that was running is picked up again.', 'If it happens again, open the technical detail: it has the last lines Nova wrote before it stopped.'],
  },
  'safe-mode': {
    id: 'safe-mode', title: 'Nova is held in safe mode',
    steps: [
      'Nova stopped three times within a minute of starting, so the supervisor stopped trying and is holding it, rather than restart it forever.',
      'If a new release came before this, go back to the last good one: node src/supervisor/main.ts rollback.',
      'Otherwise read the reason (the technical detail has Nova’s last words), fix what it names, then start it again: node src/supervisor/main.ts recover.',
    ],
  },
  'server-unresponsive': {
    id: 'server-unresponsive', title: 'Nova stopped answering',
    repair: 'restart-server', automatic: 'The supervisor stops the process that no longer answers and starts Nova again. This closes by itself once Nova is running again.',
    steps: ['Nothing to do if Nova answers again after the restart.', 'If it keeps happening, the technical detail says what the health check saw.'],
  },
  // ---- code releases ----
  'release-stopped': {
    id: 'release-stopped', title: 'A release didn’t pass its checks',
    steps: ['Nothing changed: Nova kept running the release it had.', 'The technical detail says which check failed (its tests, the sandbox start or a smoke probe). Fix that in a new release, then deploy it.'],
  },
  'release-rolled-back': {
    id: 'release-rolled-back', title: 'A release was rolled back',
    steps: ['Nova went back to the release before it by itself, because its health failed in the canary window. Your data is as it was.', 'The technical detail names the probe that failed. Fix it in a new release before deploying again.'],
  },
  'rollback-refused': {
    id: 'rollback-refused', title: 'Nova couldn’t go back to the older release',
    steps: [
      'The newer release changed the database, and things were written since. Going back would lose them, so Nova kept the newer release running.',
      'Fix the problem forward in a new release, or, if losing what was written since is acceptable, restore the pre-upgrade backup yourself with Nova stopped.',
    ],
  },
  // ---- backups and the restore drill ----
  'backup-failed': {
    id: 'backup-failed', title: 'A backup didn’t finish',
    repair: 'retry-backup', automatic: 'Nova tries the backup again once; your earlier backups were left as they were.',
    steps: ['Check the backup folder is there and has room.', 'Then run a backup now from Health.'],
  },
  'backup-target-missing': {
    id: 'backup-target-missing', title: 'The backup folder isn’t there',
    repair: 'retry-backup', automatic: 'Nova tries again once the folder is back. It never creates the folder itself, in case a drive isn’t plugged in.',
    steps: ['Plug in or mount the drive the backup folder is on, or choose another backup folder (PUT /api/v1/backups/settings).', 'Nova never makes the folder itself: writing where a drive should be would fill the wrong disk.'],
  },
  'disk-full': {
    id: 'disk-full', title: 'A disk is full',
    repair: 'free-scratch', automatic: 'Nova deletes only its own leftovers: sandbox and drill copies it made and no longer uses. Nothing of yours.',
    steps: ['Free some space on the disk named in the technical detail.', 'What failed to save wasn’t saved: try it again once there is room.'],
  },
  'drill-failed': {
    id: 'drill-failed', title: 'The restore drill failed',
    steps: [
      'The latest backup couldn’t be restored as it should. Your live data is not affected.',
      'Run a new backup now from Health, then run the drill again.',
      'If the drill fails on a new backup too, the technical detail names the check that failed; keep your older backups until it passes.',
    ],
  },
  'forget-owed': {
    id: 'forget-owed', title: 'A forget is waiting for a backup folder',
    automatic: 'Nova carries the forget into the backups there as soon as the folder is back, before it backs up, prunes or drills there, and closes this.',
    steps: [
      'You asked Nova to forget something while this backup folder wasn’t there, so the backups in it still hold it.',
      'Plug in or mount the drive it is on: Nova cleans the backups there within a minute.',
      'If you no longer use that folder or drive, delete the backups in it yourself (the folders named nova-backup-…).',
    ],
  },
  'backup-cleaning': {
    id: 'backup-cleaning', title: 'A backup was deleted to keep a forget',
    steps: ['Nova couldn’t clean a backup of something you asked it to forget, so it deleted that backup rather than keep it.', 'Run a new backup now so a recent one exists.'],
  },
  // ---- work and workers ----
  'provider-failed': {
    id: 'provider-failed', title: 'A worker failed',
    repair: 'recheck-worker', automatic: 'Nova checks the worker again and, once it answers, runs the work again once, if nothing of it had happened yet.',
    steps: ['If the worker is a program on this computer, check it starts on its own.', 'Retry the task from Tasks, or cancel it.'],
  },
  'local-model-down': {
    id: 'local-model-down', title: 'The local model isn’t answering',
    repair: 'recheck-models', automatic: 'Nova keeps checking the local model and runs waiting work as soon as it answers again.',
    steps: ['Check the model runtime (Ollama) is running on the computer in Settings › Models.', 'Local-only work waits for it; nothing is sent to the cloud instead.'],
  },
  'connector-down': {
    id: 'connector-down', title: 'A connection is down',
    repair: 'reconnect', automatic: 'Nova reconnects to the service, waiting longer between tries.',
    steps: ['Check the service is running and reachable from this computer.', 'If its address or token changed, connect it again in Settings › Connections.'],
  },
  'name-lookup': {
    id: 'name-lookup', title: 'A name couldn’t be looked up',
    repair: 'reconnect', automatic: 'Nova tries again later; nothing is sent anywhere else instead.',
    steps: ['The network’s name lookup (DNS) failed for an address Nova uses. Check this computer’s network.', 'If the service has a fixed local address, use that instead of its name in Settings › Connections.'],
  },
  // ---- the mesh ----
  'standby-behind': {
    id: 'standby-behind', title: 'The standby is behind',
    repair: 'resync', automatic: 'The standby copies again as soon as it reaches the hub; nothing is lost while it can’t.',
    steps: ['Check the standby computer is on and on the network.', 'Until it catches up, a failover would miss the newest changes.'],
  },
  'device-safe-mode': {
    id: 'device-safe-mode', title: 'A computer’s agent is in safe mode',
    repair: 'restart-runtime', automatic: 'Nova asks that computer’s boot agent to start its runtime again, once. If it crashes again, it stays in safe mode.',
    steps: ['If the restart didn’t hold, run node src/device/boot.ts recover on that computer.', 'If it keeps crashing, remove the computer in Settings › Devices and add it again.'],
  },
  'hub-failover': {
    id: 'hub-failover', title: 'The standby took over as hub',
    steps: ['The hub stopped answering, so the standby became the hub. Everything it had copied is here.', 'When the old hub is back, it steps down by itself; add it again as the standby if you want one.'],
  },
  // ---- the clock ----
  'clock-jump': {
    id: 'clock-jump', title: 'The clock jumped',
    repair: 'clock', automatic: 'Nova puts schedules that were thrown off back on time, ends device sign-ins made in the "future", and holds deleting old capture until you say the clock is right.',
    steps: ['Check this computer’s date and time (and that it sets them automatically).', 'When the time is right, mark this as dealt with: deleting old capture resumes then.'],
  },
};

export interface Repair { at: string; name: string; by: 'nova' | 'person'; ok: boolean; said: string }
export interface RepairOutcome { ok: boolean; said: string; resolved?: boolean }
export type RepairFn = (subject: string | null, problem: Problem) => Promise<RepairOutcome> | RepairOutcome;

export interface PlaybookView extends PlaybookDef { subject: string | null; repairs: Repair[] }

// Classifies a problem other modules opened in their own words (a failed task, a standby behind)
// into its playbook, and what it is about. Null: there's no playbook for it.
export type Classifier = (p: Problem) => { playbook: string; subject: string | null } | null;

const AUTO_TRIES = 3;
const AUTO_SPACING_MS = 60_000;

// Repairs Nova never makes by itself. Restarting the hub is the supervisor's to do when Nova
// stops; a running Nova that restarts itself to "repair" a problem the supervisor already dealt
// with only stops healthy work. The person may still ask (from the hub's screen or an approver).
export const RESTARTS: ReadonlySet<string> = new Set(['restart-server']);

export class Playbooks extends EventEmitter {
  #db: Db;
  #log: Log;
  #now: () => Date;
  #repairs = new Map<string, RepairFn>();
  #classifiers: Classifier[] = [];
  #running = new Set<number>();

  constructor(o: { db: Db; log: Log; now?: () => Date }) {
    super();
    this.#db = o.db;
    this.#log = o.log;
    this.#now = o.now ?? (() => new Date());
    // Every problem, whoever opened it, gets its playbook when one fits.
    this.#log.on('problem', (p: Problem) => {
      if (this.#row(p.id)) return;
      for (const c of this.#classifiers) {
        let hit: ReturnType<Classifier> = null;
        try { hit = c(p); } catch { /* a classifier that can't tell leaves it to the next */ }
        if (hit && PLAYBOOKS[hit.playbook]) {
          this.attach(p.id, hit.playbook, hit.subject);
          break;
        }
      }
    });
  }

  repair(name: string, fn: RepairFn): void {
    this.#repairs.set(name, fn);
  }

  classify(fn: Classifier): void {
    this.#classifiers.push(fn);
  }

  // Opens a problem with its playbook. One stays open per playbook and subject: the same thing
  // going wrong again adds nothing new (the open one already says it).
  open(source: string, said: string, playbook: string, o: { detail?: string; taskId?: string; subject?: string | null; repairs?: { name: string; ok: boolean; said: string }[] } = {}): Problem {
    if (!PLAYBOOKS[playbook]) throw new Error(`No playbook ${playbook}.`);
    const open = this.openFor(playbook, o.subject ?? null);
    if (open) return open;
    // Attached before the problem event is heard by anyone else, so classifiers don't re-tag it.
    const pending = { playbook, subject: o.subject ?? null };
    const tag = (p: Problem) => { if (!this.#row(p.id)) this.attach(p.id, pending.playbook, pending.subject, o.repairs); };
    this.#log.prependOnceListener('problem', tag);
    try {
      // The problem and its playbook are one write. A server killed between the two (the
      // supervisor's chaos pass did it) left a problem with no playbook: the next one of its kind
      // couldn't find it and opened a second, and nothing would ever close the first.
      return this.#db.tx(() => this.#log.problem(source, said, { ...(o.detail ? { detail: o.detail } : {}), ...(o.taskId ? { taskId: o.taskId } : {}) }));
    } finally {
      this.#log.off('problem', tag);
    }
  }

  openFor(playbook: string, subject: string | null): Problem | null {
    const row = this.#db.get<{ problem_id: number }>(
      `SELECT pp.problem_id FROM problem_playbook pp JOIN problem p ON p.id = pp.problem_id
       WHERE pp.playbook = ? AND pp.subject IS ? AND p.resolved_at IS NULL ORDER BY pp.problem_id DESC LIMIT 1`, playbook, subject);
    if (row) return this.#problem(row.problem_id);
    for (const [id, r] of this.#mem) {
      const p = this.#problem(id);
      if (r.playbook === playbook && r.subject === subject && p && !p.resolved_at) return p;
    }
    return null;
  }

  // `done`: repairs already made before the problem was recorded (the supervisor restarted Nova);
  // with them, Nova doesn't start another repair of its own.
  attach(problemId: number, playbook: string, subject: string | null = null, done?: { name: string; ok: boolean; said: string }[]): void {
    const at = this.#now().toISOString();
    const repairs = (done ?? []).map((r) => ({ at, name: r.name, by: 'nova' as const, ok: r.ok, said: r.said }));
    this.#put(problemId, { playbook, subject, repairs: JSON.stringify(repairs) });
    this.emit('change', { problem_id: problemId, playbook });
    // A safe repair starts at once (after the current step, so the problem is fully recorded).
    const repair = PLAYBOOKS[playbook]?.repair;
    if (repair && !RESTARTS.has(repair) && !done?.length) setImmediate(() => { void this.attempt(problemId, 'nova').catch(() => {}); });
  }

  view(problemId: number): PlaybookView | null {
    const r = this.#row(problemId);
    if (!r) return null;
    const def = PLAYBOOKS[r.playbook];
    return def ? { ...def, subject: r.subject, repairs: JSON.parse(r.repairs) as Repair[] } : null;
  }

  // Open problems with their playbooks, newest first.
  list(o: { open?: boolean } = { open: true }): (Problem & { playbook: PlaybookView | null })[] {
    return this.#log.problems(o).map((p) => ({ ...p, playbook: this.view(p.id) }));
  }

  // Runs the problem's repair once, now. Nova's own attempts are limited (three, a minute apart);
  // the person may ask again whenever they like. The outcome is recorded either way.
  async attempt(problemId: number, by: 'nova' | 'person'): Promise<RepairOutcome & { repairs: Repair[] }> {
    const r = this.#row(problemId);
    if (!r) throw new CoreError('not_found', 'That problem has no playbook.');
    const def = PLAYBOOKS[r.playbook];
    const fn = def?.repair ? this.#repairs.get(def.repair) : undefined;
    const p = this.#problem(problemId);
    if (!def?.repair || !fn) throw new CoreError('conflict', 'There is no repair Nova can make by itself for this one; its steps say what you can do.');
    if (!p || p.resolved_at) return { ok: true, said: 'Already dealt with.', repairs: JSON.parse(r.repairs) };
    const past = JSON.parse(r.repairs) as Repair[];
    if (by === 'nova') {
      if (RESTARTS.has(def.repair)) return { ok: false, said: 'Nova never restarts itself as a repair: the supervisor does that when Nova stops.', repairs: past };
      const mine = past.filter((x) => x.by === 'nova');
      if (mine.length >= AUTO_TRIES) return { ok: false, said: 'Nova has tried this three times; it’s over to you.', repairs: past };
      const last = mine.at(-1);
      if (last && this.#now().getTime() - Date.parse(last.at) < AUTO_SPACING_MS) return { ok: false, said: 'Nova tried a moment ago.', repairs: past };
    }
    if (this.#running.has(problemId)) return { ok: false, said: 'A repair is already running.', repairs: past };
    this.#running.add(problemId);
    let out: RepairOutcome;
    try {
      out = await fn(r.subject, p);
    } catch (e) {
      out = { ok: false, said: `The repair didn’t work: ${(e as Error).message}` };
    } finally {
      this.#running.delete(problemId);
    }
    const repairs = [...(JSON.parse(this.#row(problemId)?.repairs ?? '[]') as Repair[]), { at: this.#now().toISOString(), name: def.repair, by, ok: out.ok, said: out.said }];
    this.#update(problemId, repairs);
    this.#log.info('playbooks', `${def.title}: ${out.said}`, { problem: problemId, repair: def.repair, by, ok: out.ok });
    if (out.ok && out.resolved) this.#log.resolve(problemId);
    this.emit('change', { problem_id: problemId, repair: def.repair, ok: out.ok });
    return { ...out, repairs };
  }

  // The cause went away by itself (a connection is listening again): recorded, and closed.
  settle(problemId: number, said: string): void {
    const r = this.#row(problemId);
    if (!r) return;
    const repairs = [...(JSON.parse(r.repairs) as Repair[]), { at: this.#now().toISOString(), name: 'watch', by: 'nova' as const, ok: true, said }];
    this.#update(problemId, repairs);
    this.#log.resolve(problemId);
    this.emit('change', { problem_id: problemId, settled: true });
  }

  // Nova's own retries of repairs that haven't worked yet (the heartbeat calls this).
  async sweep(): Promise<void> {
    const rows = this.#db.all<{ problem_id: number; playbook: string }>(
      `SELECT pp.problem_id, pp.playbook FROM problem_playbook pp JOIN problem p ON p.id = pp.problem_id WHERE p.resolved_at IS NULL`);
    for (const r of rows) {
      const repair = PLAYBOOKS[r.playbook]?.repair;
      if (!repair || RESTARTS.has(repair)) continue;
      await this.attempt(r.problem_id, 'nova').catch(() => {});
    }
  }

  routes(): Route[] {
    return [
      { method: 'GET', path: '/playbooks', summary: 'Every repair playbook: what each kind of problem is, the steps for you, and the repair Nova makes by itself where one is safe.', handle: () => Object.values(PLAYBOOKS) },
      { method: 'GET', path: '/problems/{id}/playbook', summary: 'A problem’s playbook: its steps, and every repair Nova tried, with how it went.', handle: ({ params }) => this.view(Number(params.id)) ?? (() => { throw new CoreError('not_found', 'That problem has no playbook.'); })() },
      {
        method: 'POST', path: '/problems/{id}/repair', summary: 'Run a problem’s safe repair now. Only repairs that can’t change your data exist. Restarting Nova is for the hub’s own screen or a device that may approve.',
        handle: ({ params, who }) => {
          const r = this.#row(Number(params.id));
          const repair = r ? PLAYBOOKS[r.playbook]?.repair : undefined;
          if (repair && RESTARTS.has(repair) && allows('approver', who.principal) !== 'ok') throw new CoreError('forbidden', 'Restarting Nova is for the hub’s own screen or a device that may approve.');
          return this.attempt(Number(params.id), 'person');
        },
      },
    ];
  }

  // A playbook row: in the database, or, when it can't take it (a full disk, a problem that
  // couldn't be saved either), kept in memory until Nova restarts.
  #mem = new Map<number, { playbook: string; subject: string | null; repairs: string }>();

  #put(problemId: number, r: { playbook: string; subject: string | null; repairs: string }): void {
    if (problemId > UNSAVED_FROM) {
      try {
        this.#db.run('INSERT OR REPLACE INTO problem_playbook (problem_id, playbook, subject, repairs, updated_at) VALUES (?, ?, ?, ?, ?)', problemId, r.playbook, r.subject, r.repairs, this.#now().toISOString());
        return;
      } catch { /* kept in memory below */ }
    }
    this.#mem.set(problemId, r);
  }

  #update(problemId: number, repairs: Repair[]): void {
    const r = this.#row(problemId);
    if (!r) return;
    if (this.#mem.has(problemId)) { this.#mem.set(problemId, { ...r, repairs: JSON.stringify(repairs) }); return; }
    this.#put(problemId, { ...r, repairs: JSON.stringify(repairs) });
  }

  #row(problemId: number) {
    return this.#mem.get(problemId) ?? this.#db.get<{ playbook: string; subject: string | null; repairs: string }>('SELECT playbook, subject, repairs FROM problem_playbook WHERE problem_id = ?', problemId);
  }

  #problem(id: number): Problem | null {
    return this.#db.get<Problem>('SELECT * FROM problem WHERE id = ?', id) ?? this.#log.unsaved(id);
  }
}
