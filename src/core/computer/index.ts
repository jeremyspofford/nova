// Nova Computer as the core wires it (M10a, docs/plans/M10a.md): workspaces, one per project, each
// action a Work Ledger task for the `computer` worker. Nothing here is parallel to the rest of Nova:
//  - approval is the ledger's tiers (`minTier`) and its privacy gate (`egressFor` + `permits`);
//  - a command's output is kept as a file and checked by Nova itself (a `confirmation` from
//    `nova-computer`), and screened by the ingest gate as tool output before any model could read it;
//  - a write is undone through the checkpoint taken just before it;
//  - egress goes through the proxy in egress.ts, which applies safe-fetch's rules.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, type Brief, type Evidence, type PrivacyMode, type Report, type Tier } from '../envelope.ts';
import { stricter, type Egress } from '../workers.ts';
import { sha256 } from '../workspace.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Ledger, LanedWorker, Task, TaskInput } from '../ledger.ts';
import type { Checker, Verifier } from '../verify.ts';
import { FOLDER_COPY, copyTree, treeDigest, type Computer, type ExecResult, type Machine } from './computer.ts';
import { DockerComputer } from './docker.ts';
import { RELAY_ARGV, RELAY_USER, Tunnel, proxyConnection, type Attempt } from './egress.ts';
import { DEFAULT_TIMEOUT_S, IMAGE, IMAGE_ABOUT, MAX_TIMEOUT_S, OPS, checkFolder, declaredHosts, egressOf, tierFor, validateArgv, validateEgress, type EgressDecl, type Op } from './policy.ts';

export const COMPUTER_WORKER = 'computer';
export const CONFIRMATION_SYSTEM = 'nova-computer';
// At most this many automatic and named checkpoints are kept per workspace (the clean one always is).
export const KEEP_AUTO = 20;
export const KEEP_NAMED = 20;
const MAX_OUTPUT = 1_000_000;

export type WorkspaceState = 'creating' | 'ready' | 'broken' | 'destroyed';

interface WsRow { id: string; name: string; folder: string; own_folder: number; egress: string; container: string | null; image: string; state: WorkspaceState; detail: string | null; task_id: string; created_at: string; updated_at: string }
interface CpRow { id: string; workspace_id: string; kind: 'clean' | 'auto' | 'named'; name: string | null; reason: string; image: string; digest: string; files: number; bytes: number; task_id: string | null; created_at: string }
interface RunRow { task_id: string; workspace_id: string; op: Op; argv: string | null; access: string | null; exit_code: number | null; sha256: string | null; bytes: number | null; screen_id: string | null; verdict: string | null; checkpoint_id: string | null; outcome: string; at: string }

export interface ComputerOptions {
  db: Db; log: Log; home: string; ledger: Ledger; verifier: Verifier;
  now?: () => Date;
  // The person's default privacy mode: while it is local-only, no workspace reaches outside.
  privacy: () => PrivacyMode;
  // The ingest gate, for a command's output (tool output).
  screen?: (r: { text: string; origin: string; ref: string }) => Promise<{ id: string; verdict: string; extract?: string }>;
  // The adapter; Docker on this machine unless a test gives another.
  computer?: Computer & { sweep?(keep: Set<string>): Promise<string[]> };
  // Whose home folder a project may never be (os.homedir() unless a test says).
  userHome?: string;
  // Tests only: which addresses the egress proxy counts as public (safe-fetch's rule otherwise).
  egressAllow?: (address: string) => boolean;
}

export interface Inputs {
  op: Op; workspace: string;
  name?: string; folder?: string; egress?: EgressDecl;
  argv?: string[]; access?: 'read' | 'write'; timeout_s?: number;
  checkpoint?: string; label?: string; undo_of?: string;
}

const newId = (p: string) => `${p}${randomBytes(5).toString('hex')}`;
const WS_ID = /^w[0-9a-f]{10}$/;
const CP_ID = /^c[0-9a-f]{10}$/;
const words = (argv: string[]) => argv.map((a) => (/^[\w./:=@+-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class NovaComputer {
  readonly worker: LanedWorker;
  readonly computer: Computer & { sweep?(keep: Set<string>): Promise<string[]> };
  #o: ComputerOptions;
  #now: () => Date;
  #dir: string;
  #tunnels = new Map<string, { tunnel: Tunnel; attempts: Attempt[] }>();
  #status: { ok: boolean; available: boolean | null; detail: string; at: number } = { ok: true, available: null, detail: 'Not checked yet: it is checked when the computer is first used.', at: 0 };
  #swept = false;

  constructor(o: ComputerOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.#dir = join(o.home, 'workers', 'computer');
    this.computer = o.computer ?? new DockerComputer({ home: o.home });
    const self = this;
    this.worker = {
      id: COMPUTER_WORKER,
      name: 'Nova Computer',
      about: 'Runs commands in Nova’s own workspaces: one container per project, with only that project’s folder, no network unless declared, and a checkpoint before every change so it can be undone.',
      // The most it could reach; each task's own reach comes from its workspace's declaration.
      egress: 'remote',
      evidence: ['confirmation'],
      timeoutMs: (MAX_TIMEOUT_S + 600) * 1000,
      lane: (brief: Brief) => ({ key: `computer:${String(brief.inputs?.workspace ?? '')}`, max: 1 }),
      egressFor: (brief: Brief): Egress => egressOf(self.#declOf(self.#inputs(brief.inputs))),
      minTier: (input: Pick<TaskInput, 'inputs' | 'evidence_required'>): Tier => {
        try { return self.#tier(self.#inputs(input.inputs)); } catch { return 3; }
      },
      // A command that may reach outside may have sent something by the time it fails; a write would
      // change the workspace again. Neither runs again by itself.
      effects: (brief: Brief) => {
        const i = self.#inputs(brief.inputs);
        return i.op === 'exec' && (i.access !== 'read' || self.#declOf(i).mode !== 'none') ? 'external' : 'none';
      },
      health: () => ({ ok: self.#status.ok, detail: self.#status.detail }),
      run: (brief: Brief, signal: AbortSignal) => self.#run(brief, signal),
    };
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, this.#confirm);
  }

  // ---- what callers see -------------------------------------------------------------------------

  async status(): Promise<{ ok: boolean; available: boolean | null; detail: string }> {
    if (Date.now() - this.#status.at > 30_000) {
      const a = await this.computer.available().catch((e: Error) => ({ ok: false, detail: e.message }));
      // No Docker isn't a fault: the computer is simply unavailable (as the browser is with no Chromium).
      this.#status = { ok: true, available: a.ok, detail: a.detail, at: Date.now() };
    }
    const { at: _, ...s } = this.#status;
    return s;
  }

  health(): { ok: boolean; available: boolean | null; detail: string; workspaces: number } {
    return { ok: this.#status.ok, available: this.#status.available, detail: this.#status.detail, workspaces: this.#rows().length };
  }

  #rows(): WsRow[] { return this.#o.db.all<WsRow>(`SELECT * FROM computer_workspace WHERE state != 'destroyed' ORDER BY created_at`); }
  #row(id: string): WsRow {
    const r = this.#o.db.get<WsRow>('SELECT * FROM computer_workspace WHERE id = ?', id);
    if (!r || r.state === 'destroyed') throw new CoreError('not_found', `There is no workspace ${id}.`);
    return r;
  }

  #viewOf(r: WsRow) {
    const egress = JSON.parse(r.egress) as EgressDecl;
    return {
      id: r.id, name: r.name, state: r.state, detail: r.detail, folder: r.folder, own_folder: !!r.own_folder,
      egress: { ...egress, reaches: declaredHosts(egress) }, image: r.image, created_at: r.created_at, updated_at: r.updated_at,
      checkpoints: this.#o.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM computer_checkpoint WHERE workspace_id = ?', r.id)!.n,
    };
  }

  list() { return this.#rows().map((r) => this.#viewOf(r)); }

  view(id: string) {
    const r = this.#row(id);
    return {
      ...this.#viewOf(r),
      checkpoints: this.#o.db.all<CpRow>('SELECT * FROM computer_checkpoint WHERE workspace_id = ? ORDER BY created_at DESC', id)
        .map(({ id: cid, kind, name, reason, digest, files, bytes, task_id, created_at }) => ({ id: cid, kind, name, reason, digest, files, bytes, task_id, created_at })),
      runs: this.#o.db.all<RunRow>('SELECT * FROM computer_run WHERE workspace_id = ? ORDER BY at DESC LIMIT 50', id).map((x) => this.#runView(x)),
    };
  }

  #runView(x: RunRow) {
    return { task_id: x.task_id, op: x.op, argv: x.argv ? JSON.parse(x.argv) as string[] : null, access: x.access, exit_code: x.exit_code, verdict: x.verdict, checkpoint_id: x.checkpoint_id, outcome: x.outcome, at: x.at };
  }

  // A command's record: its output as it was kept, the screen it passed, what it reached.
  run(taskId: string): Record<string, unknown> {
    const x = this.#o.db.get<RunRow>('SELECT * FROM computer_run WHERE task_id = ?', taskId);
    if (!x) throw new CoreError('not_found', `No computer record for task ${taskId}.`);
    const file = this.#runFile(taskId);
    const kept = x.op === 'exec' && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : null;
    return { ...this.#runView(x), sha256: x.sha256, bytes: x.bytes, screen_id: x.screen_id, record: kept };
  }

  #runFile(taskId: string): string { return join(this.#dir, 'runs', `${taskId}.json`); }
  #cpDir(ws: string, cp: string): string { return join(this.#dir, ws, 'checkpoints', cp); }

  // ---- asking for work (each a ledger task) ------------------------------------------------------

  // Builds the task for an action and gives it to the ledger, which gates it by tier and privacy.
  request(op: Op, body: Record<string, unknown>, workspace?: string): Task {
    const inputs: Record<string, unknown> = { op, workspace: workspace ?? (op === 'create' ? newId('w') : '') };
    for (const k of ['name', 'folder', 'egress', 'argv', 'access', 'timeout_s', 'checkpoint', 'label', 'undo_of'] as const) if (body[k] !== undefined) inputs[k] = body[k];
    if (op === 'exec' && inputs.access === undefined) inputs.access = 'write';
    const i = this.#inputs(inputs);
    const ws = op === 'create' ? null : this.#row(i.workspace);
    const name = i.name ?? ws?.name ?? i.workspace;
    const title = op === 'create' ? `Make the workspace “${name}”`
      : op === 'exec' ? `Run ${clip(words(i.argv!), 80)} in “${name}”`
        : op === 'checkpoint' ? `Checkpoint “${name}”${i.label ? `: ${i.label}` : ''}`
          : op === 'reset' ? (i.undo_of ? `Undo task ${i.undo_of.slice(0, 8)} in “${name}”` : `Reset “${name}” to ${i.checkpoint ? `checkpoint ${i.checkpoint}` : 'its clean state'}`)
            : `Delete the workspace “${name}” and its checkpoints`;
    return this.#o.ledger.create({
      title, owner: COMPUTER_WORKER, origin: { kind: 'user' },
      goal: op === 'exec' ? `Run ${words(i.argv!)} in the workspace “${name}” and keep its output as evidence.` : `${title}.`,
      evidence_required: [{ kind: 'confirmation', note: 'Nova’s own record of what the computer did.' }],
      approval_tier: this.#tier(i),
      inputs: inputs as Record<string, unknown>,
    });
  }

  // The inputs of a computer task, checked: a brief that could never run is refused when it is
  // delegated (the ledger calls `egressFor`, which calls this).
  #inputs(raw: unknown): Inputs {
    const v = (raw ?? {}) as Record<string, unknown>;
    const bad = (m: string) => new CoreError('validation', m);
    if (!OPS.includes(v.op as Op)) throw bad(`inputs.op must be one of ${OPS.join(', ')}.`);
    const op = v.op as Op;
    if (typeof v.workspace !== 'string' || !WS_ID.test(v.workspace)) throw bad('inputs.workspace must be a workspace id.');
    const out: Inputs = { op, workspace: v.workspace };
    if (op === 'create') {
      if (this.#o.db.get('SELECT 1 FROM computer_workspace WHERE id = ?', v.workspace)) throw bad(`There already is a workspace ${v.workspace}.`);
      if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 80) throw bad('name must be 1 to 80 characters.');
      out.name = v.name.trim();
      out.egress = validateEgress(v.egress);
      if (v.folder !== undefined) out.folder = checkFolder(v.folder, { home: this.#o.home, userHome: this.#o.userHome ?? homedir() });
    } else {
      const ws = this.#o.db.get<WsRow>('SELECT * FROM computer_workspace WHERE id = ?', v.workspace);
      if (!ws || ws.state === 'destroyed') throw bad(`There is no workspace ${v.workspace}.`);
    }
    if (op === 'exec') {
      out.argv = validateArgv(v.argv);
      if (v.access !== undefined && v.access !== 'read' && v.access !== 'write') throw bad('access must be read or write.');
      out.access = v.access === 'read' ? 'read' : 'write';
      if (v.timeout_s !== undefined && !(Number.isInteger(v.timeout_s) && (v.timeout_s as number) >= 1 && (v.timeout_s as number) <= MAX_TIMEOUT_S)) throw bad(`timeout_s must be 1 to ${MAX_TIMEOUT_S} seconds.`);
      out.timeout_s = (v.timeout_s as number | undefined) ?? DEFAULT_TIMEOUT_S;
    }
    if (op === 'checkpoint' && v.label !== undefined) {
      if (typeof v.label !== 'string' || !v.label.trim() || v.label.length > 80) throw bad('label must be 1 to 80 characters.');
      out.label = v.label.trim();
    }
    if (op === 'reset') {
      if (v.checkpoint !== undefined) {
        if (typeof v.checkpoint !== 'string' || !CP_ID.test(v.checkpoint) || !this.#o.db.get('SELECT 1 FROM computer_checkpoint WHERE id = ? AND workspace_id = ?', v.checkpoint, v.workspace)) throw bad(`Workspace ${v.workspace} has no checkpoint ${String(v.checkpoint)}.`);
        out.checkpoint = v.checkpoint;
      }
      if (typeof v.undo_of === 'string') out.undo_of = v.undo_of;
    }
    return out;
  }

  #declOf(i: Inputs): EgressDecl {
    if (i.op === 'create') return i.egress ?? { mode: 'none', hosts: [] };
    const ws = this.#o.db.get<WsRow>('SELECT egress FROM computer_workspace WHERE id = ?', i.workspace);
    return ws ? JSON.parse(ws.egress) as EgressDecl : { mode: 'none', hosts: [] };
  }

  #tier(i: Inputs): Tier {
    return tierFor({ op: i.op, egress: this.#declOf(i), ...(i.access ? { access: i.access } : {}), ownFolder: i.folder === undefined });
  }

  // Undo a command: back to the checkpoint taken just before it (a reset, so it can itself be undone).
  undo(taskId: string): Task {
    const x = this.#o.db.get<RunRow>('SELECT * FROM computer_run WHERE task_id = ?', taskId);
    if (!x?.checkpoint_id) throw new CoreError('not_found', 'That task has no checkpoint before it to go back to.');
    return this.request('reset', { checkpoint: x.checkpoint_id, undo_of: taskId }, x.workspace_id);
  }

  // ---- running --------------------------------------------------------------------------------

  async #run(brief: Brief, signal: AbortSignal): Promise<Report> {
    const started = Date.now();
    const report = (status: Report['status'], summary: string, extra: Partial<Report> = {}): Report => ({
      envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary,
      evidence: status === 'done' ? [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: brief.task_id }] : [],
      artifacts: [], blockers: [], follow_up_suggestions: [], usage: { duration_ms: Date.now() - started }, ...extra,
    });
    let i: Inputs;
    try { i = this.#inputs(brief.inputs); } catch (e) {
      // A create checked before it existed now finds itself; anything else can't run.
      const raw = (brief.inputs ?? {}) as Record<string, unknown>;
      const mine = raw.op === 'create' && this.#o.db.get<WsRow>('SELECT * FROM computer_workspace WHERE id = ? AND task_id = ?', String(raw.workspace), brief.task_id);
      if (mine && mine.state === 'ready') return report('done', `The workspace “${mine.name}” is ready.`);
      return report('failed', e instanceof CoreError ? e.message : (e as Error).message);
    }
    try {
      const a = await this.status();
      if (!a.available) return report('failed', a.detail);
      switch (i.op) {
        case 'create': return await this.#create(i, brief, report);
        case 'exec': return await this.#exec(i, brief, signal, report);
        case 'checkpoint': {
          const cp = await this.#checkpoint(i.workspace, i.label ? 'named' : 'auto', i.label ? `Named: ${i.label}` : 'Asked for', brief.task_id, i.label);
          this.#record(brief.task_id, i, { checkpoint_id: cp.id, outcome: 'done' });
          return report('done', `Took checkpoint ${cp.id} of “${this.#row(i.workspace).name}”: the machine’s image and ${cp.files} file${cp.files === 1 ? '' : 's'} (${cp.bytes} bytes) of the folder.`, { artifacts: [{ kind: 'checkpoint', ref: cp.id, sha256: cp.digest }] });
        }
        case 'reset': return await this.#reset(i, brief, report);
        case 'destroy': return await this.#destroy(i, brief, report);
      }
    } catch (e) {
      const msg = (e as Error).message;
      this.#o.log.warn('computer', `A computer task stopped: ${msg}`, { task: brief.task_id });
      try { this.#record(brief.task_id, i, { outcome: `failed: ${clip(msg, 300)}` }); } catch { /* the record is best effort here */ }
      return report('failed', msg);
    }
  }

  #machine(r: WsRow): Machine {
    return { id: r.id, folder: r.folder, egress: JSON.parse(r.egress) as EgressDecl, container: r.container, image: r.image };
  }

  #save(m: Machine, state?: WorkspaceState, detail?: string | null): void {
    this.#o.db.run('UPDATE computer_workspace SET container = ?, image = ?, updated_at = ?' + (state ? ', state = ?, detail = ?' : '') + ' WHERE id = ?',
      ...([m.container, m.image, this.#now().toISOString(), ...(state ? [state, detail ?? null] : []), m.id] as (string | null)[]));
  }

  #record(taskId: string, i: Inputs, x: Partial<RunRow> & { outcome: string }): void {
    this.#o.db.run(
      `INSERT OR REPLACE INTO computer_run (task_id, workspace_id, op, argv, access, exit_code, sha256, bytes, screen_id, verdict, checkpoint_id, outcome, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      taskId, i.workspace, i.op, i.argv ? JSON.stringify(i.argv) : null, i.access ?? null, x.exit_code ?? null, x.sha256 ?? null, x.bytes ?? null,
      x.screen_id ?? null, x.verdict ?? null, x.checkpoint_id ?? null, x.outcome, this.#now().toISOString(),
    );
  }

  async #create(i: Inputs, brief: Brief, report: (s: Report['status'], m: string, x?: Partial<Report>) => Report): Promise<Report> {
    // Anything this Nova left behind for a workspace it no longer has (a factory reset, a crash)
    // goes first, once.
    if (!this.#swept && this.computer.sweep) {
      this.#swept = true;
      const keep = new Set(this.#o.db.all<{ id: string }>(`SELECT id FROM computer_workspace WHERE state != 'destroyed'`).map((r) => r.id));
      const gone = await this.computer.sweep(keep);
      if (gone.length) this.#o.log.info('computer', `Removed ${gone.length} workspace machine${gone.length === 1 ? '' : 's'} Nova no longer had a record of.`, { count: gone.length });
    }
    const own = i.folder === undefined;
    const folder = i.folder ?? join(this.#dir, i.workspace, 'project');
    if (own) mkdirSync(folder, { recursive: true, mode: 0o755 });
    const at = this.#now().toISOString();
    this.#o.db.run(`INSERT INTO computer_workspace (id, name, folder, own_folder, egress, container, image, state, detail, task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?, 'creating', NULL, ?, ?, ?)`,
      i.workspace, i.name!, folder, own ? 1 : 0, JSON.stringify(i.egress), IMAGE, brief.task_id, at, at);
    const m = this.#machine(this.#row(i.workspace));
    try {
      await this.computer.create(m);
      this.#save(m);
      // The clean state: the pinned image and the folder as it is now.
      const cp = this.#cleanCheckpoint(m, brief.task_id);
      this.#save(m, 'ready');
      this.#record(brief.task_id, i, { checkpoint_id: cp.id, outcome: 'done' });
      const reach = i.egress!.mode === 'none' ? 'no network' : `reaching only ${declaredHosts(i.egress!).join(', ')} through Nova`;
      return report('done', `The workspace “${i.name}” is ready: ${IMAGE_ABOUT}, ${own ? 'a new empty project folder' : `the folder ${folder}`}, ${reach}. Its clean state is checkpoint ${cp.id}.`, { artifacts: [{ kind: 'workspace', ref: i.workspace }, { kind: 'checkpoint', ref: cp.id, sha256: cp.digest }] });
    } catch (e) {
      this.#save(m, 'broken', (e as Error).message);
      throw e;
    }
  }

  #cleanCheckpoint(m: Machine, taskId: string): CpRow {
    const id = newId('c');
    const dir = this.#cpDir(m.id, id);
    copyTree(m.folder, join(dir, FOLDER_COPY));
    const d = treeDigest(join(dir, FOLDER_COPY));
    return this.#insertCp({ id, workspace_id: m.id, kind: 'clean', name: null, reason: 'Its clean state, when it was made', image: m.image, ...d, task_id: taskId, created_at: this.#now().toISOString() });
  }

  #insertCp(c: CpRow): CpRow {
    this.#o.db.run('INSERT INTO computer_checkpoint (id, workspace_id, kind, name, reason, image, digest, files, bytes, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.id, c.workspace_id, c.kind, c.name, c.reason, c.image, c.digest, c.files, c.bytes, c.task_id, c.created_at);
    return c;
  }

  async #checkpoint(ws: string, kind: 'auto' | 'named', reason: string, taskId: string, name?: string): Promise<CpRow> {
    if (kind === 'named' && this.#o.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM computer_checkpoint WHERE workspace_id = ? AND kind = 'named'`, ws)!.n >= KEEP_NAMED) {
      throw new CoreError('conflict', `This workspace has ${KEEP_NAMED} named checkpoints. Reset to one or delete the workspace to take another.`);
    }
    const r = this.#row(ws);
    const m = this.#machine(r);
    const id = newId('c');
    const saved = await this.computer.checkpoint(m, { id, dir: this.#cpDir(ws, id) });
    this.#save(m);
    const cp = this.#insertCp({ id, workspace_id: ws, kind, name: name ?? null, reason, image: saved.image, digest: saved.digest, files: saved.files, bytes: saved.bytes, task_id: taskId, created_at: this.#now().toISOString() });
    await this.#prune(ws);
    return cp;
  }

  // Automatic checkpoints past KEEP_AUTO go, oldest first; never the clean one, a named one, or the
  // one the machine is made from now.
  async #prune(ws: string): Promise<void> {
    const r = this.#row(ws);
    const autos = this.#o.db.all<CpRow>(`SELECT * FROM computer_checkpoint WHERE workspace_id = ? AND kind = 'auto' ORDER BY created_at DESC, rowid DESC`, ws);
    for (const c of autos.slice(KEEP_AUTO)) {
      if (c.image === r.image) continue;
      await this.computer.drop(this.#machine(r), [c.image]).catch(() => {});
      rmSync(this.#cpDir(ws, c.id), { recursive: true, force: true });
      this.#o.db.run('DELETE FROM computer_checkpoint WHERE id = ?', c.id);
    }
  }

  async #tunnel(m: Machine): Promise<{ tunnel: Tunnel; attempts: Attempt[] }> {
    const had = this.#tunnels.get(m.id);
    if (had?.tunnel.live) return had;
    had?.tunnel.close();
    const attempts: Attempt[] = [];
    const hosts = declaredHosts(m.egress);
    const tunnel = new Tunnel(this.computer.attach(m, RELAY_ARGV, RELAY_USER), (d) => proxyConnection(d, {
      hosts: () => hosts, now: this.#now, record: (a) => attempts.push(a),
      ...(this.#o.egressAllow ? { allow: this.#o.egressAllow } : {}),
    }));
    const t = { tunnel, attempts };
    this.#tunnels.set(m.id, t);
    await tunnel.ready;
    return t;
  }

  #dropTunnel(ws: string): void {
    this.#tunnels.get(ws)?.tunnel.close();
    this.#tunnels.delete(ws);
  }

  async #exec(i: Inputs, brief: Brief, signal: AbortSignal, report: (s: Report['status'], m: string, x?: Partial<Report>) => Report): Promise<Report> {
    const r = this.#row(i.workspace);
    if (r.state !== 'ready') return report('failed', `The workspace “${r.name}” isn’t ready (${r.state}${r.detail ? `: ${r.detail}` : ''}).`);
    const m = this.#machine(r);
    const outside = m.egress.mode !== 'none';
    // Local-only reaches nothing outside: the ledger refuses such a task, and the computer refuses
    // too if the person's default became local-only after it was approved.
    if (outside && stricter(brief.privacy_mode, this.#o.privacy()) === 'local-only') {
      return report('failed', `This workspace may reach ${declaredHosts(m.egress).join(', ')}, and your Nova is local-only: nothing leaves this machine, so the command didn’t run.`);
    }
    // A write: a checkpoint first, so it can be undone. A read: a picture of what it must not change.
    let cp: CpRow | null = null;
    let before: { folder: string; machine: string[] } | null = null;
    if (i.access === 'write') cp = await this.#checkpoint(i.workspace, 'auto', `Before task ${brief.task_id.slice(0, 8)}: ${clip(words(i.argv!), 80)}`, brief.task_id);
    else {
      before = { folder: treeDigest(m.folder, { content: false }).digest, machine: await this.computer.changes(m) };
      this.#save(m);
    }
    const m2 = this.#machine(this.#row(i.workspace));
    let egress: { tunnel: Tunnel; attempts: Attempt[] } | null = null;
    if (outside) egress = await this.#tunnel(m2);
    const mark = egress?.attempts.length ?? 0;
    const res: ExecResult = await this.computer.exec(m2, { argv: i.argv!, timeoutS: i.timeout_s!, maxBytes: MAX_OUTPUT }, signal);
    this.#save(m2);
    let changed: string[] = [];
    if (before) {
      const machineNow = await this.computer.changes(m2);
      const was = new Set(before.machine);
      changed = machineNow.filter((l) => !was.has(l)).map((l) => `in the machine: ${l}`);
      if (treeDigest(m2.folder, { content: false }).digest !== before.folder) changed.unshift('in the project folder');
    }
    const reached = egress ? egress.attempts.slice(mark) : [];
    // The output is outside content to any model that reads it: screened first, as tool output.
    const text = `$ ${words(i.argv!)}\n${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}\n[exit ${res.exit}]`;
    let screen: { id: string | null; verdict: string; extract?: string; error?: string };
    try {
      screen = this.#o.screen ? await this.#o.screen({ text, origin: `computer:${r.name}`, ref: brief.task_id }) : { id: null, verdict: 'block', error: 'Nova couldn’t screen this output.' };
    } catch (e) {
      screen = { id: null, verdict: 'block', error: `Nova couldn’t screen this output: ${(e as Error).message}` };
    }
    const record = {
      task_id: brief.task_id, workspace: i.workspace, argv: i.argv, access: i.access, at: this.#now().toISOString(),
      exit: res.exit, timed_out: res.timed_out, truncated: res.truncated, duration_ms: res.duration_ms,
      stdout: res.stdout, stderr: res.stderr,
      screen: { id: screen.id, verdict: screen.verdict, ...(screen.error ? { error: screen.error } : {}) },
      extract: screen.extract ?? null,
      checkpoint_before: cp?.id ?? null, changed, egress: reached,
    };
    const file = this.#runFile(brief.task_id);
    mkdirSync(join(this.#dir, 'runs'), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(record, null, 2));
    writeFileSync(file, bytes);
    const ok = res.exit === 0 && !res.timed_out && changed.length === 0;
    const outcome = ok ? 'done' : res.timed_out ? 'timed out' : changed.length ? 'a read changed the workspace' : `exit ${res.exit}`;
    this.#record(brief.task_id, i, { exit_code: res.exit, sha256: sha256(bytes), bytes: bytes.length, screen_id: screen.id, verdict: screen.verdict, checkpoint_id: cp?.id ?? null, outcome });
    const lines = res.stdout ? res.stdout.split('\n').length - (res.stdout.endsWith('\n') ? 1 : 0) : 0;
    const said = [
      res.timed_out ? `It ran out of time after ${i.timeout_s} s and was stopped.` : `It exited with ${res.exit}, ${lines} line${lines === 1 ? '' : 's'} of output${res.truncated ? ' (cut at 1 MB)' : ''}.`,
      changed.length ? `It was run as a read but it changed the workspace (${changed.slice(0, 5).join('; ')}). The checkpoint before the last change is where to go back to.` : '',
      `Output screened: ${screen.verdict}.`,
      reached.length ? `Reached outside: ${reached.filter((a) => a.allowed).map((a) => `${a.host}:${a.port}`).join(', ') || 'nothing'}; refused: ${reached.filter((a) => !a.allowed).map((a) => `${a.host}${a.port ? `:${a.port}` : ''} (${a.why})`).join(', ') || 'nothing'}.` : '',
      cp ? `Undo: reset to checkpoint ${cp.id}, taken just before.` : '',
    ].filter(Boolean).join(' ');
    const artifacts = [{ kind: 'output', ref: `workers/computer/runs/${brief.task_id}.json`, sha256: sha256(bytes) }, ...(cp ? [{ kind: 'checkpoint', ref: cp.id, sha256: cp.digest }] : [])];
    const follow = cp ? [`To undo it: POST /api/v1/computer/runs/${brief.task_id}/undo`] : [];
    if (!ok) return report('failed', `${words(i.argv!).slice(0, 100)}: ${said}`, { artifacts, follow_up_suggestions: follow });
    return report('done', `Ran ${clip(words(i.argv!), 100)} in “${r.name}”. ${said}`, { artifacts, follow_up_suggestions: follow });
  }

  async #reset(i: Inputs, brief: Brief, report: (s: Report['status'], m: string, x?: Partial<Report>) => Report): Promise<Report> {
    const r = this.#row(i.workspace);
    const to = i.checkpoint
      ? this.#o.db.get<CpRow>('SELECT * FROM computer_checkpoint WHERE id = ?', i.checkpoint)!
      : this.#o.db.get<CpRow>(`SELECT * FROM computer_checkpoint WHERE workspace_id = ? AND kind = 'clean'`, i.workspace)!;
    // A reset is undone the same way: the state it leaves is checkpointed first.
    const before = await this.#checkpoint(i.workspace, 'auto', `Before a reset to ${to.id}`, brief.task_id);
    this.#dropTunnel(i.workspace);
    const m = this.#machine(this.#row(i.workspace));
    await this.computer.reset(m, { image: to.image, dir: this.#cpDir(i.workspace, to.id) });
    this.#save(m, 'ready');
    const now = treeDigest(m.folder);
    if (now.digest !== to.digest) {
      this.#record(brief.task_id, i, { checkpoint_id: before.id, outcome: 'the folder didn’t match its checkpoint' });
      return report('failed', `The folder doesn’t match checkpoint ${to.id} after the reset (Nova read it back). Checkpoint ${before.id} holds what was there before.`);
    }
    this.#record(brief.task_id, i, { checkpoint_id: before.id, outcome: 'done' });
    return report('done', `“${r.name}” is back to ${to.kind === 'clean' ? 'its clean state' : `checkpoint ${to.id}`}: the machine made again from its image, and the folder read back byte for byte (${now.files} file${now.files === 1 ? '' : 's'}). To undo the reset, reset to checkpoint ${before.id}.`, {
      artifacts: [{ kind: 'checkpoint', ref: to.id, sha256: to.digest }, { kind: 'checkpoint', ref: before.id, sha256: before.digest }],
    });
  }

  async #destroy(i: Inputs, brief: Brief, report: (s: Report['status'], m: string, x?: Partial<Report>) => Report): Promise<Report> {
    const r = this.#row(i.workspace);
    this.#dropTunnel(i.workspace);
    const images = this.#o.db.all<{ image: string }>('SELECT image FROM computer_checkpoint WHERE workspace_id = ?', i.workspace).map((x) => x.image);
    await this.computer.destroy(this.#machine(r), images);
    // Nova's own copies (and its own project folder) go; a folder of the person's stays as it is.
    rmSync(join(this.#dir, i.workspace), { recursive: true, force: true });
    this.#o.db.run('DELETE FROM computer_checkpoint WHERE workspace_id = ?', i.workspace);
    this.#o.db.run(`UPDATE computer_workspace SET state = 'destroyed', container = NULL, updated_at = ? WHERE id = ?`, this.#now().toISOString(), i.workspace);
    this.#record(brief.task_id, i, { outcome: 'done' });
    return report('done', `Deleted the workspace “${r.name}”, its machine and its ${images.length} checkpoint${images.length === 1 ? '' : 's'}.${r.own_folder ? '' : ` Your folder ${r.folder} is as it was.`}`);
  }

  // ---- evidence ----------------------------------------------------------------------------------

  // Nova reads its own record, and what it points at, again: a command's output file by its hash; a
  // checkpoint's copy by its digest; a reset by the folder as it is now; a workspace by its record.
  #confirm: Checker = (e: Evidence, brief: Brief) => {
    const id = (e as { id?: string }).id;
    if (id !== brief.task_id) return { ok: false, why: `Record ${id ?? '(none)'} belongs to other work.` };
    const x = this.#o.db.get<RunRow>('SELECT * FROM computer_run WHERE task_id = ?', id);
    if (!x) return { ok: false, why: `Nova has no computer record for task ${id}.` };
    if (x.outcome !== 'done') return { ok: false, why: `The computer’s record says: ${x.outcome}.` };
    switch (x.op) {
      case 'exec': {
        const file = this.#runFile(id);
        if (!existsSync(file)) return { ok: false, why: 'The command’s output file isn’t there.' };
        const data = readFileSync(file);
        if (sha256(data) !== x.sha256 || data.length !== x.bytes) return { ok: false, why: 'The command’s output file doesn’t match Nova’s record of it.' };
        return { ok: true, why: `Nova read the command’s output back itself: ${data.length} bytes, sha256 ${x.sha256!.slice(0, 12)}…, exit ${x.exit_code}, screened ${x.verdict}.` };
      }
      case 'create':
      case 'checkpoint': {
        const cp = x.checkpoint_id ? this.#o.db.get<CpRow>('SELECT * FROM computer_checkpoint WHERE id = ?', x.checkpoint_id) : undefined;
        if (!cp) return { ok: false, why: 'The checkpoint isn’t in Nova’s record.' };
        const d = treeDigest(join(this.#cpDir(x.workspace_id, cp.id), FOLDER_COPY));
        if (d.digest !== cp.digest) return { ok: false, why: `Checkpoint ${cp.id}’s copy doesn’t match its digest.` };
        return { ok: true, why: `Nova read checkpoint ${cp.id}’s copy back itself: ${d.files} files, digest ${d.digest.slice(0, 12)}…, as recorded.` };
      }
      case 'reset': {
        const ws = this.#o.db.get<WsRow>('SELECT * FROM computer_workspace WHERE id = ?', x.workspace_id);
        const brief_cp = (brief.inputs?.checkpoint as string | undefined);
        const to = brief_cp ? this.#o.db.get<CpRow>('SELECT * FROM computer_checkpoint WHERE id = ?', brief_cp) : this.#o.db.get<CpRow>(`SELECT * FROM computer_checkpoint WHERE workspace_id = ? AND kind = 'clean'`, x.workspace_id);
        if (!ws || !to) return { ok: false, why: 'The workspace or its checkpoint isn’t in Nova’s record.' };
        const d = treeDigest(ws.folder);
        if (d.digest !== to.digest) return { ok: false, why: `The folder doesn’t match checkpoint ${to.id} (Nova read it back).` };
        return { ok: true, why: `Nova read the folder back itself: it matches checkpoint ${to.id} byte for byte (${d.files} files).` };
      }
      case 'destroy': {
        const ws = this.#o.db.get<WsRow>('SELECT state FROM computer_workspace WHERE id = ?', x.workspace_id);
        return ws?.state === 'destroyed' && !existsSync(join(this.#dir, x.workspace_id))
          ? { ok: true, why: 'Nova’s record shows the workspace deleted, and none of its copies are left.' }
          : { ok: false, why: 'The workspace is still in Nova’s record.' };
      }
    }
  };

  close(): void {
    for (const ws of [...this.#tunnels.keys()]) this.#dropTunnel(ws);
  }
}
