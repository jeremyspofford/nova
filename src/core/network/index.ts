// Networking through chat (M10d, docs/plans/M10d.md). A network target is something whose
// configuration Nova may change (a router, DNS, a firewall, a tailnet's policy), registered by the
// person. A change is a JSON merge patch of its configuration, carried by a chain of Work Ledger tasks
// for the `network` worker, in this order:
//
//   prepare (tier 1: the snapshot and the diff; nothing outside changes) → apply (tier 3, always: a
//   compare-and-swap on the snapshot's version, a checkpoint, the write, and the dead-man's switch
//   armed) → if the hub can't confirm contact with one of the person's devices within the window, a
//   revert (made by Nova itself: the snapshot, written back) and an alert
//
// "Contact confirmed" is built on the device mesh: a request on the mesh listener, under a trusted
// device's session (the access policy's own check, `Devices.touch`, which emits `heard`), started
// after the switch was armed, from a phone, browser or computer that was trusted at the apply.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreError } from '../errors.ts';
import { ENVELOPE_VERSION, PRIVACY_MODES, type Brief, type Evidence, type PrivacyMode, type Report, type Tier } from '../envelope.ts';
import { unifiedDiff } from '../providers/taskspace.ts';
import { ADAPTERS, KINDS, changedPaths, checkUrl, digest, httpConfig, mask, mergePatch, pretty, urlEgress, validatePatch, type Config, type Json, type NetworkTarget } from './targets.ts';
import type { Db } from '../db.ts';
import type { Log } from '../log.ts';
import type { Ledger, LanedWorker, Task, TaskInput } from '../ledger.ts';
import type { Verifier } from '../verify.ts';
import type { Vault } from '../vault.ts';
import type { Devices, Device } from '../mesh/devices.ts';
import type { Egress } from '../workers.ts';

export const NETWORK_WORKER = 'network';
export const CONFIRMATION_SYSTEM = 'nova-network';
export const STEPS = ['prepare', 'apply', 'revert'] as const;
export type Step = (typeof STEPS)[number];
export const CHANGE_STATES = ['preparing', 'review', 'applying', 'watching', 'kept', 'reverting', 'reverted', 'revert_failed', 'nothing', 'failed', 'declined', 'cancelled'] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];
const ENDED: readonly ChangeState[] = ['kept', 'reverted', 'revert_failed', 'nothing', 'failed', 'declined', 'cancelled'];
const OPEN: readonly ChangeState[] = ['preparing', 'review', 'applying', 'watching', 'reverting'];
// The device kinds whose contact counts: the person's own. The hub isn't one, nor the standby
// (infrastructure that keeps in touch with the hub by itself).
const COUNTED = ['phone', 'browser', 'computer'];
export const WINDOW_DEFAULT_S = 300;
export const WINDOW_MIN_S = 60;
export const WINDOW_MAX_S = 3600;

interface TargetRow { id: string; name: string; kind: string; adapter: string; url: string; created_at: string; updated_at: string }
interface ChangeRow {
  id: string; target_id: string; title: string; patch: string; privacy_mode: PrivacyMode; session_id: string | null; state: ChangeState; reason: string | null;
  snapshot_sha: string | null; snapshot_version: string | null; proposed_sha: string | null; applied_version: string | null; diff: string | null; changed_keys: string | null;
  window_s: number; armed_at: string | null; deadline: string | null; devices: string | null; contact_at: string | null; contact_device: string | null; checkpoint: string | null;
  tasks: string; created_at: string; updated_at: string;
}
interface TaskRef { step: Step; id: string }
interface ReadBack { change: string; task_id: string; what: 'applied' | 'reverted'; sha: string; version: string; at: string }
type Reporter = (status: Report['status'], summary: string, more?: Partial<Report>) => Report;

export interface NetworkOptions {
  db: Db; log: Log; home: string; ledger: Ledger; verifier: Verifier; vault: Vault; devices: Devices;
  privacy: () => PrivacyMode;
  checkpoint: (reason: string) => { id: string };
  notify?: (key: string, text: string) => void;
  // The switch's window in seconds, from the person's settings (mesh.contact_window_s).
  windowS?: () => number;
  // Tests: the window in milliseconds, whatever the setting says.
  windowMs?: number;
  // Tests: another adapter for a target than http-config.
  target?: (t: { id: string; url: string; token: () => string | null }) => NetworkTarget;
  now?: () => Date;
}

const parse = <T>(s: string | null): T | null => (s ? JSON.parse(s) as T : null);
const clip = (s: string, n = 80) => { const t = s.trim().replace(/\s+/g, ' '); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const minutes = (s: number) => (s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`);

export class Network {
  readonly worker: LanedWorker;
  readonly dir: string;
  #o: NetworkOptions;
  #now: () => Date;
  #key = Symbol('network');
  #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(o: NetworkOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
    this.dir = join(o.home, 'workers', 'network');
    const self = this;
    this.worker = {
      id: NETWORK_WORKER,
      name: 'Network',
      about: 'Changes a network target’s configuration you registered (a router, DNS, a firewall, a tailnet’s policy): it takes a snapshot and shows you the diff, applies only when you confirm, and puts the snapshot back by itself if Nova can’t hear from one of your devices within the window afterwards.',
      egress: 'remote',
      evidence: ['confirmation'],
      timeoutMs: 10 * 60_000,
      lane: (brief: Brief) => ({ key: `target:${String(brief.inputs?.target_id ?? '')}`, max: 1 }),
      egressFor: (brief: Brief): Egress => {
        const t = self.#o.db.get<TargetRow>('SELECT * FROM network_target WHERE id = ?', String(brief.inputs?.target_id ?? ''));
        return t ? urlEgress(t.url) : 'remote';
      },
      // A revert the switch makes was confirmed with the change (tier 3) and puts back what was
      // there: it runs by itself. One the person asks for is a network change of its own: tier 3.
      minTier: (input: Pick<TaskInput, 'inputs' | 'evidence_required'>): Tier => {
        const step = input.inputs?.step as Step;
        return step === 'prepare' ? 1 : step === 'revert' && input.inputs?.by === 'switch' ? 1 : 3;
      },
      effects: (brief: Brief) => (brief.inputs?.step === 'prepare' ? 'none' : 'external'),
      commits: (brief: Brief) => brief.inputs?.step === 'apply' || brief.inputs?.step === 'revert',
      internal: { key: this.#key, why: 'Only Nova’s network changes make their own tasks. Ask for a change in chat, or start one with POST /network/changes.' },
      health: () => ({ ok: true }),
      run: (brief: Brief, signal: AbortSignal) => self.#run(brief, signal),
    };
    o.verifier.registerConfirmation(CONFIRMATION_SYSTEM, (e, brief) => this.#confirm(e, brief));
    o.ledger.on('task', (t: Task) => {
      if (t.owner !== NETWORK_WORKER) return;
      try { this.#advance(t); } catch (e) { o.log.problem('network', `Nova couldn’t take a network change to its next step: ${(e as Error).message}`, { detail: (e as Error).stack, taskId: t.id }); }
    });
    // Contact: every request a trusted device's session makes on the mesh listener.
    o.devices.on('heard', (id: string) => { try { this.#heard(id); } catch (e) { o.log.warn('network', 'Nova couldn’t record contact with a device.', { error: (e as Error).message }); } });
  }

  #windowS(): number {
    const v = this.#o.windowS?.() ?? WINDOW_DEFAULT_S;
    return Math.min(WINDOW_MAX_S, Math.max(WINDOW_MIN_S, Number.isFinite(v) ? Math.round(v) : WINDOW_DEFAULT_S));
  }

  #windowMs(row?: ChangeRow): number { return this.#o.windowMs ?? (row?.window_s ?? this.#windowS()) * 1000; }

  // ---- targets -----------------------------------------------------------------------------------

  createTarget(body: Record<string, unknown>) {
    const name = typeof body.name === 'string' ? body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    if (!name || name.length > 60) throw new CoreError('validation', 'name is the target’s name, 1 to 60 characters.');
    if (!KINDS.includes(body.kind as never)) throw new CoreError('validation', `kind is one of ${KINDS.join(', ')}.`);
    const adapter = body.adapter ?? 'http-config';
    if (!ADAPTERS.includes(adapter as never)) throw new CoreError('validation', `adapter is one of ${ADAPTERS.join(', ')}.`);
    const url = checkUrl(body.url).href;
    const id = `n${randomBytes(5).toString('hex')}`;
    const at = this.#now().toISOString();
    this.#o.db.run('INSERT INTO network_target (id, name, kind, adapter, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, name, body.kind as string, adapter as string, url, at, at);
    return this.target(id);
  }

  setToken(id: string, value: unknown): { target: string; stored: true } {
    this.#target(id);
    if (typeof value !== 'string' || !value.trim() || value.length > 10_000) throw new CoreError('validation', 'value is the token itself (1 to 10000 characters).');
    this.#o.vault.put(this.#tokenName(id), value.trim());
    return { target: id, stored: true };
  }

  #tokenName(id: string): string { return `network/${id}/token`; }

  #target(id: string): TargetRow {
    const t = this.#o.db.get<TargetRow>('SELECT * FROM network_target WHERE id = ?', id);
    if (!t) throw new CoreError('not_found', `There is no network target ${id}.`);
    return t;
  }

  target(id: string) {
    const t = this.#target(id);
    return { id: t.id, name: t.name, kind: t.kind, adapter: t.adapter, url: t.url, token: this.#o.vault.has(this.#tokenName(t.id)), egress: urlEgress(t.url), created_at: t.created_at };
  }

  #adapter(t: TargetRow): NetworkTarget {
    const token = () => this.#o.vault.get(this.#tokenName(t.id));
    return this.#o.target ? this.#o.target({ id: t.id, url: t.url, token }) : httpConfig({ url: t.url, token });
  }

  // The devices whose contact would count, trusted now.
  #counted(): Device[] {
    return this.#o.devices.list().filter((d) => d.trust === 'trusted' && d.role !== 'hub' && COUNTED.includes(d.kind));
  }

  // ---- changes -------------------------------------------------------------------------------------

  start(input: Record<string, unknown>, o: { session?: string | null; origin?: TaskInput['origin'] } = {}) {
    const ref = typeof input.target === 'string' ? input.target.trim() : '';
    const t = this.#o.db.get<TargetRow>('SELECT * FROM network_target WHERE id = ? OR name = ? ORDER BY created_at LIMIT 1', ref, ref);
    if (!t) throw new CoreError('validation', `There is no network target “${ref}”. ${this.#targetNames()}`);
    const patch = validatePatch(input.patch);
    if (!this.#o.vault.has(this.#tokenName(t.id))) throw new CoreError('conflict', `${t.name}’s token isn’t in the vault yet. The person saves it with PUT /network/targets/${t.id}/token (never in chat).`);
    // No device, no change: its contact could never be confirmed, so the switch would always fire.
    if (!this.#counted().length) throw new CoreError('conflict', 'Nova confirms a network change by hearing from one of your devices afterwards, and none is paired. Pair your phone first (Devices), then ask again.');
    const open = this.#o.db.get<ChangeRow>(`SELECT * FROM network_change WHERE target_id = ? AND state IN (${OPEN.map(() => '?').join(', ')})`, t.id, ...OPEN);
    if (open) throw new CoreError('conflict', `Change ${open.id} on ${t.name} is still open (${open.state}); one change at a time on a target.`);
    const privacy = input.privacy_mode === undefined ? this.#o.privacy() : input.privacy_mode;
    if (!PRIVACY_MODES.includes(privacy as PrivacyMode)) throw new CoreError('validation', `privacy_mode is one of ${PRIVACY_MODES.join(', ')}.`);
    const id = `c${randomBytes(5).toString('hex')}`;
    const at = this.#now().toISOString();
    const title = typeof input.title === 'string' && input.title.trim() ? clip(input.title, 80) : `Change ${t.name}`;
    this.#o.db.run(
      `INSERT INTO network_change (id, target_id, title, patch, privacy_mode, session_id, state, window_s, tasks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, '[]', ?, ?)`,
      id, t.id, title, JSON.stringify(patch), privacy as PrivacyMode, o.session ?? null, this.#windowS(), at, at,
    );
    let task: Task;
    try { task = this.#make(this.#change(id), 'prepare', 'chat', o.origin ?? { kind: 'user' }); } catch (e) {
      this.#o.db.run('DELETE FROM network_change WHERE id = ?', id);
      throw e;
    }
    return { change: this.view(id), task };
  }

  #targetNames(): string {
    const names = this.#o.db.all<{ name: string }>('SELECT name FROM network_target ORDER BY created_at').map((r) => r.name);
    return names.length ? `Targets: ${names.join(', ')}.` : 'No network target is registered yet: the person registers one with POST /network/targets.';
  }

  #change(id: string): ChangeRow {
    const c = this.#o.db.get<ChangeRow>('SELECT * FROM network_change WHERE id = ?', id);
    if (!c) throw new CoreError('not_found', `There is no network change ${id}.`);
    return c;
  }

  #make(c: ChangeRow, step: Step, by: 'chat' | 'switch' | 'person' = 'chat', origin: TaskInput['origin'] = { kind: 'user' }): Task {
    const t = this.#target(c.target_id);
    const tasks = parse<TaskRef[]>(c.tasks) ?? [];
    const n = tasks.filter((x) => x.step === step).length;
    const titles: Record<Step, string> = { prepare: `Snapshot and diff: ${c.title}`, apply: `Apply to ${t.name}: ${c.title}`, revert: `Put ${t.name} back as it was: ${c.title}` };
    const goals: Record<Step, string> = {
      prepare: `Read ${t.name}’s configuration as a snapshot, and work out the diff of “${c.title}”. Nothing on ${t.name} changes.`,
      apply: `Change ${t.name}’s configuration (${(parse<string[]>(c.changed_keys) ?? []).join(', ') || 'see the diff'}), from the snapshot ${String(c.snapshot_sha).slice(0, 12)}…, after a checkpoint. If Nova can’t hear from one of your devices within ${minutes(c.window_s)} afterwards, it puts the snapshot back by itself.`,
      revert: by === 'switch'
        ? `Nova heard from none of your devices within ${minutes(c.window_s)} of the change to ${t.name}: put the snapshot (${String(c.snapshot_sha).slice(0, 12)}…) back.`
        : `Put ${t.name}’s configuration back to the snapshot from before “${c.title}” (${String(c.snapshot_sha).slice(0, 12)}…).`,
    };
    const task = this.#o.ledger.create({
      title: titles[step], owner: NETWORK_WORKER, goal: goals[step], origin,
      evidence_required: [{ kind: 'confirmation', note: step === 'prepare' ? 'the snapshot, as Nova recorded it' : `Nova reads ${t.name} back` }],
      privacy_mode: c.privacy_mode, approval_tier: step === 'prepare' || (step === 'revert' && by === 'switch') ? 1 : 3,
      inputs: { step, change_id: c.id, target_id: t.id, ...(step === 'revert' ? { by } : {}), ...(step !== 'prepare' ? { snapshot_sha: c.snapshot_sha, proposed_sha: c.proposed_sha } : {}) },
      idempotency_key: `network:${c.id}:${step}:${n + (step === 'revert' ? 1 : 0)}:${by}`,
      ...(tasks[0] ? { parent_id: tasks[0].id } : {}),
    }, { as: this.#key });
    if (!tasks.some((x) => x.id === task.id)) {
      tasks.push({ step, id: task.id });
      this.#o.db.run('UPDATE network_change SET tasks = ?, updated_at = ? WHERE id = ?', JSON.stringify(tasks), this.#now().toISOString(), c.id);
    }
    return task;
  }

  #set(id: string, f: Partial<Omit<ChangeRow, 'id' | 'target_id' | 'title' | 'patch' | 'privacy_mode' | 'session_id' | 'window_s' | 'tasks' | 'created_at' | 'updated_at'>>): void {
    const keys = Object.keys(f) as (keyof typeof f)[];
    if (!keys.length) return;
    this.#o.db.run(`UPDATE network_change SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => (f[k] ?? null) as unknown as string | number | null), this.#now().toISOString(), id);
  }

  #tell(key: string, text: string): void {
    try { this.#o.notify?.(key, text); } catch { /* the change's record says it too */ }
  }

  #advance(t: Task): void {
    const step = t.brief.inputs?.step as Step;
    const c = this.#o.db.get<ChangeRow>('SELECT * FROM network_change WHERE id = ?', String(t.brief.inputs?.change_id ?? ''));
    if (!c) return;
    const target = this.#target(c.target_id);
    if (step === 'prepare') {
      if (c.state !== 'preparing') return;
      if (t.state === 'done') {
        if (c.proposed_sha === c.snapshot_sha) {
          this.#set(c.id, { state: 'nothing', reason: `${target.name} is already like that: the patch changes nothing.` });
          this.#dropFiles(c.id);
          return;
        }
        this.#set(c.id, { state: 'review', reason: `Ready for you: the diff against the snapshot. Nova applies it only when you confirm, and puts the snapshot back by itself if it can’t hear from your devices within ${minutes(c.window_s)}.` });
        this.#make(this.#change(c.id), 'apply');
        this.#tell(`network:${c.id}:review`, `The change “${c.title}” to ${target.name} is ready for you to review (${(parse<string[]>(c.changed_keys) ?? []).join(', ')}). Nova applies it only when you confirm, in Tasks.`);
      } else if (t.state === 'failed' || t.state === 'cancelled') {
        this.#set(c.id, { state: t.state === 'failed' ? 'failed' : 'cancelled', reason: t.reason });
        this.#dropFiles(c.id);
      }
      return;
    }
    if (step === 'apply') {
      if (t.state === 'done' && c.state === 'watching') {
        this.#tell(`network:${c.id}:applied`, `Changed ${target.name}: “${c.title}”. Nova is waiting to hear from one of your devices; if none reaches it within ${minutes(c.window_s)}, it puts the snapshot back by itself.`);
        return;
      }
      // An apply that stopped once the switch was armed is the switch's to settle.
      if (c.state === 'watching' || c.state === 'kept' || c.state === 'reverting' || ENDED.includes(c.state)) return;
      if (t.state === 'cancelled') {
        this.#set(c.id, { state: 'declined', reason: `You didn’t apply it. ${target.name} is as it was.` });
        this.#dropFiles(c.id);
      } else if (t.state === 'failed') {
        this.#set(c.id, { state: 'failed', reason: t.reason });
        this.#dropFiles(c.id);
        this.#tell(`network:${c.id}:failed`, `The change “${c.title}” to ${target.name} stopped: ${clip(t.reason ?? 'it failed', 300)}`);
      }
      return;
    }
    if (step === 'revert') {
      if (t.state === 'done') {
        const by = t.brief.inputs?.by;
        this.#set(c.id, { state: 'reverted', reason: by === 'switch' ? `Nova heard from none of your devices within ${minutes(c.window_s)} of the change, so it put ${target.name} back to the snapshot.` : `Put back as you asked: ${target.name} is at the snapshot from before the change.` });
        this.#tell(`network:${c.id}:reverted`, `${target.name} is back to how it was before “${c.title}”: Nova read it back and it is the snapshot.`);
      } else if (t.state === 'failed' || (t.state === 'waiting' && /May already have happened/.test(t.reason ?? ''))) {
        this.#set(c.id, { state: 'revert_failed', reason: t.reason });
        this.#o.log.problem('network', `Nova couldn’t put ${target.name} back to the snapshot after “${c.title}”: ${clip(t.reason ?? 'it failed', 400)} Check ${target.name} yourself.`, { taskId: t.id });
        this.#tell(`network:${c.id}:revert-failed`, `Nova couldn’t put ${target.name} back after “${c.title}”: ${clip(t.reason ?? 'it failed', 300)} Check ${target.name} yourself.`);
      } else if (t.state === 'cancelled' && c.state === 'reverting') {
        // The person stopped a revert they had asked for: the change stays.
        this.#set(c.id, { state: c.contact_at ? 'kept' : 'reverted', reason: c.contact_at ? 'You didn’t put it back; the change stays.' : c.reason });
      }
    }
  }

  // ---- the dead-man's switch -----------------------------------------------------------------------

  #arm(c: ChangeRow, deviceIds: string[]): void {
    const at = this.#now();
    const ms = this.#windowMs(c);
    this.#set(c.id, { state: 'watching', armed_at: at.toISOString(), deadline: new Date(at.getTime() + ms).toISOString(), devices: JSON.stringify(deviceIds) });
    this.#timer(c.id, ms);
  }

  #timer(id: string, ms: number): void {
    clearTimeout(this.#timers.get(id));
    const timer = setTimeout(() => { this.#timers.delete(id); this.#fire(id); }, Math.max(0, ms));
    timer.unref();
    this.#timers.set(id, timer);
  }

  // A request from a counted device's session, started now: contact with the person's devices.
  #heard(deviceId: string): void {
    for (const c of this.#o.db.all<ChangeRow>(`SELECT * FROM network_change WHERE state = 'watching' AND contact_at IS NULL`)) {
      if (!(parse<string[]>(c.devices) ?? []).includes(deviceId)) continue;
      const d = this.#o.devices.find(deviceId);
      if (!d || d.trust !== 'trusted') continue;
      clearTimeout(this.#timers.get(c.id));
      this.#timers.delete(c.id);
      const target = this.#target(c.target_id);
      this.#set(c.id, { state: 'kept', contact_at: this.#now().toISOString(), contact_device: d.name, reason: `Kept: Nova heard from ${d.name} after the change, so your devices still reach it.` });
      this.#o.log.info('network', 'A network change was kept: contact confirmed.', { change: c.id, device: d.id });
      this.#tell(`network:${c.id}:kept`, `The change “${c.title}” to ${target.name} stays: Nova heard from ${d.name} after it.`);
    }
  }

  // The window ran out with no contact: Nova puts the snapshot back by itself, and says so.
  #fire(id: string): void {
    const c = this.#o.db.get<ChangeRow>('SELECT * FROM network_change WHERE id = ?', id);
    if (!c || c.state !== 'watching' || c.contact_at) return;
    const target = this.#target(c.target_id);
    this.#set(c.id, { state: 'reverting', reason: `Nova heard from none of your devices within ${minutes(c.window_s)} of the change: it is putting ${target.name} back to the snapshot.` });
    this.#o.log.problem('network', `Nova lost contact with your devices after “${c.title}” on ${target.name}, so it is putting the snapshot back by itself.`);
    this.#tell(`network:${c.id}:lost`, `Nova heard from none of your devices within ${minutes(c.window_s)} of the change “${c.title}” to ${target.name}, so it is putting the snapshot back by itself.`);
    try { this.#make(this.#change(c.id), 'revert', 'switch'); } catch (e) {
      this.#set(c.id, { state: 'revert_failed', reason: (e as Error).message });
      this.#o.log.problem('network', `Nova couldn’t start putting ${target.name} back after “${c.title}”: ${(e as Error).message} Check ${target.name} yourself.`);
    }
  }

  // On the heartbeat and at start: a change past its deadline with no contact reverts; one before it
  // waits for the rest of its window.
  sweep(): void {
    const now = this.#now().getTime();
    for (const c of this.#o.db.all<ChangeRow>(`SELECT * FROM network_change WHERE state = 'watching'`)) {
      if (c.contact_at) { this.#set(c.id, { state: 'kept' }); continue; }
      const left = Date.parse(c.deadline ?? '') - now;
      if (!(left > 0)) this.#fire(c.id);
      else if (!this.#timers.has(c.id)) this.#timer(c.id, this.#o.windowMs ?? left);
    }
  }

  // ---- running a step ------------------------------------------------------------------------------

  #changeDir(id: string): string { return join(this.dir, id); }

  #writeJson(file: string, v: unknown): void {
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(v), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  #readJson<T>(file: string): T | null {
    try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
  }

  #dropFiles(id: string): void {
    try { rmSync(this.#changeDir(id), { recursive: true, force: true }); } catch { /* best effort */ }
  }

  async #run(brief: Brief, signal: AbortSignal): Promise<Report> {
    const started = performance.now();
    const report: Reporter = (status, summary, more = {}) => ({
      envelope: ENVELOPE_VERSION, task_id: brief.task_id, status, summary, evidence: [], artifacts: [], blockers: status === 'blocked' ? [summary] : [], follow_up_suggestions: [],
      ...more, usage: { duration_ms: Math.round(performance.now() - started) },
    });
    const step = brief.inputs?.step as Step;
    const c = this.#o.db.get<ChangeRow>('SELECT * FROM network_change WHERE id = ?', String(brief.inputs?.change_id ?? ''));
    if (!c) return report('failed', 'This network change isn’t in Nova’s record any more.');
    try {
      const t = this.#target(c.target_id);
      const a = this.#adapter(t);
      if (step === 'prepare') return await this.#prepare(c, t, a, signal, report);
      if (step === 'apply') return await this.#apply(c, t, a, brief, signal, report);
      if (step === 'revert') return await this.#revert(c, t, a, brief, signal, report);
      return report('failed', `There is no network step called “${String(step)}”.`);
    } catch (e) {
      if (signal.aborted) throw e;
      return report('failed', (e as Error).message);
    }
  }

  async #prepare(c: ChangeRow, t: TargetRow, a: NetworkTarget, signal: AbortSignal, report: Reporter): Promise<Report> {
    if (c.state !== 'preparing') return report('failed', `This change isn’t being prepared (it is ${c.state}).`);
    const now = await a.read(signal);
    const sha = digest(now.config);
    this.#writeJson(join(this.#changeDir(c.id), 'snapshot.json'), { version: now.version, sha, config: now.config, at: this.#now().toISOString() });
    const proposed = mergePatch(now.config, parse<Config>(c.patch)!) as Config;
    const psha = digest(proposed);
    this.#writeJson(join(this.#changeDir(c.id), 'proposed.json'), { sha: psha, config: proposed });
    const keys = changedPaths(now.config, proposed);
    const diff = unifiedDiff(t.name, pretty(mask(now.config)), pretty(mask(proposed)));
    this.#set(c.id, { snapshot_sha: sha, snapshot_version: now.version, proposed_sha: psha, diff, changed_keys: JSON.stringify(keys) });
    return report('done', `Nova took a snapshot of ${t.name} (sha256 ${sha.slice(0, 12)}…, version ${now.version}). ${keys.length ? `The change touches ${keys.join(', ')}.` : 'The patch changes nothing.'} Nothing on ${t.name} changed.`, {
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `snapshot:${c.id}:${sha}` }],
    });
  }

  async #apply(c: ChangeRow, t: TargetRow, a: NetworkTarget, brief: Brief, signal: AbortSignal, report: Reporter): Promise<Report> {
    if (c.state !== 'review' && c.state !== 'applying') return report('failed', `This change isn’t waiting to be applied (it is ${c.state}).`);
    if (brief.inputs?.snapshot_sha !== c.snapshot_sha || brief.inputs?.proposed_sha !== c.proposed_sha) return report('failed', 'The change isn’t the one you reviewed any more, so Nova applied nothing.');
    const snap = this.#readJson<{ version: string; sha: string; config: Config }>(join(this.#changeDir(c.id), 'snapshot.json'));
    const prop = this.#readJson<{ sha: string; config: Config }>(join(this.#changeDir(c.id), 'proposed.json'));
    if (!snap || !prop || snap.sha !== c.snapshot_sha || digest(snap.config) !== c.snapshot_sha || prop.sha !== c.proposed_sha || digest(prop.config) !== c.proposed_sha) return report('failed', 'Nova’s snapshot or the reviewed configuration isn’t as recorded, so it applied nothing.');
    // The target must still be the snapshot: nothing changed it since the review.
    const now = await a.read(signal);
    if (now.version !== snap.version || digest(now.config) !== snap.sha) return report('failed', `${t.name}’s configuration changed since the snapshot, so Nova applied nothing. Ask again to start from what is there now.`);
    const devices = this.#counted().map((d) => d.id);
    if (!devices.length) return report('failed', 'None of your devices is paired any more, so Nova couldn’t confirm contact after the change: it applied nothing.');
    this.#set(c.id, { state: 'applying' });
    let cp: { id: string };
    try { cp = this.#o.checkpoint(`Before changing ${t.name}: “${c.title}” (network change ${c.id})`); } catch (e) {
      return report('failed', `Nova couldn’t take a checkpoint before the change, so it applied nothing: ${(e as Error).message}`);
    }
    this.#set(c.id, { checkpoint: cp.id });
    this.#o.ledger.committing(brief.task_id, `write the new configuration to ${t.name}`);
    // The switch is armed once the write may have landed: a write that failed is checked by reading
    // the target, and only one that certainly changed nothing leaves it unarmed.
    let written: { version: string } | null = null;
    try {
      written = await a.write(prop.config, snap.version, signal);
    } catch (e) {
      let landed = true;
      try { landed = digest((await a.read()).config) !== snap.sha; } catch { /* unknown: as if it landed */ }
      if (!landed) return report('failed', `Nova couldn’t change ${t.name}: ${(e as Error).message} Reading it again, it is still the snapshot: nothing changed.`);
      this.#arm(this.#change(c.id), devices);
      return report('failed', `The change to ${t.name} may have landed (${(e as Error).message}). The dead-man’s switch is armed: without contact from your devices within ${minutes(c.window_s)}, Nova puts the snapshot back.`);
    }
    this.#set(c.id, { applied_version: written.version || null });
    this.#arm(this.#change(c.id), devices);
    const back = await a.read(signal);
    const sha = digest(back.config);
    if (sha !== c.proposed_sha) return report('failed', `Nova wrote the change to ${t.name}, and reading it back finds something else (sha256 ${sha.slice(0, 12)}…). The dead-man’s switch is armed: without contact from your devices it puts the snapshot back.`);
    this.#writeJson(join(this.#changeDir(c.id), `readback-${brief.task_id}.json`), { change: c.id, task_id: brief.task_id, what: 'applied', sha, version: back.version, at: this.#now().toISOString() } satisfies ReadBack);
    if (back.version !== written.version) this.#set(c.id, { applied_version: back.version });
    return report('done', `Changed ${t.name} (now sha256 ${sha.slice(0, 12)}…, after a checkpoint, ${cp.id}). Nova is waiting up to ${minutes(c.window_s)} to hear from one of your devices; without that, it puts the snapshot back by itself.`, {
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `applied:${c.id}:${brief.task_id}` }],
    });
  }

  async #revert(c: ChangeRow, t: TargetRow, a: NetworkTarget, brief: Brief, signal: AbortSignal, report: Reporter): Promise<Report> {
    if (c.state !== 'reverting') return report('failed', `This change isn’t being put back (it is ${c.state}).`);
    const snap = this.#readJson<{ version: string; sha: string; config: Config }>(join(this.#changeDir(c.id), 'snapshot.json'));
    if (!snap || digest(snap.config) !== c.snapshot_sha) return report('failed', 'Nova’s snapshot isn’t as recorded, so it wrote nothing.');
    const now = await a.read(signal);
    const sha = digest(now.config);
    if (sha !== c.snapshot_sha) {
      // Only Nova's own change is undone: if someone changed the configuration after it, that isn't
      // overwritten.
      const ours = (c.applied_version && now.version === c.applied_version) || sha === c.proposed_sha;
      if (!ours) return report('failed', `${t.name}’s configuration changed after Nova’s change (it isn’t the snapshot or Nova’s change), so Nova didn’t overwrite it.`);
      this.#o.ledger.committing(brief.task_id, `write the snapshot back to ${t.name}`);
      await a.write(snap.config, now.version, signal);
    }
    const back = await a.read(signal);
    const bsha = digest(back.config);
    if (bsha !== c.snapshot_sha) return report('failed', `Nova wrote the snapshot back to ${t.name}, and reading it back finds something else (sha256 ${bsha.slice(0, 12)}…).`);
    this.#writeJson(join(this.#changeDir(c.id), `readback-${brief.task_id}.json`), { change: c.id, task_id: brief.task_id, what: 'reverted', sha: bsha, version: back.version, at: this.#now().toISOString() } satisfies ReadBack);
    return report('done', `${t.name} is back at the snapshot: Nova read it back (sha256 ${bsha.slice(0, 12)}…).`, {
      evidence: [{ kind: 'confirmation', system: CONFIRMATION_SYSTEM, id: `reverted:${c.id}:${brief.task_id}` }],
    });
  }

  // ---- evidence ----------------------------------------------------------------------------------------

  #confirm(e: Evidence, brief: Brief): { ok: boolean; why: string } {
    if (e.kind !== 'confirmation') return { ok: false, why: 'Not a confirmation.' };
    const [what, id, ref] = e.id.split(':');
    const c = this.#o.db.get<ChangeRow>('SELECT * FROM network_change WHERE id = ?', id ?? '');
    if (!c || id !== brief.inputs?.change_id) return { ok: false, why: 'That confirmation is for another network change.' };
    if (what === 'snapshot') {
      const snap = this.#readJson<{ sha: string; config: Json }>(join(this.#changeDir(c.id), 'snapshot.json'));
      if (!snap || ref !== c.snapshot_sha) return { ok: false, why: 'Nova has no snapshot by that hash for this change.' };
      const actual = digest(snap.config);
      if (actual !== ref) return { ok: false, why: `The snapshot’s sha256 is ${actual.slice(0, 12)}…, not the ${String(ref).slice(0, 12)}… recorded.` };
      return { ok: true, why: `Nova read its snapshot itself: sha256 ${actual.slice(0, 12)}…, as recorded.` };
    }
    if (what === 'applied' || what === 'reverted') {
      if (ref !== brief.task_id || !/^[0-9a-f-]{36}$/.test(ref)) return { ok: false, why: 'That read-back is for another task.' };
      const rb = this.#readJson<ReadBack>(join(this.#changeDir(c.id), `readback-${ref}.json`));
      if (!rb || rb.change !== c.id || rb.task_id !== brief.task_id || rb.what !== what) return { ok: false, why: 'Nova has no record of reading the target back for this step.' };
      const want = what === 'applied' ? c.proposed_sha : c.snapshot_sha;
      if (rb.sha !== want) return { ok: false, why: `Nova read the target back at sha256 ${rb.sha.slice(0, 12)}…, not the ${String(want).slice(0, 12)}… it should be.` };
      return { ok: true, why: `Nova read the target back itself after the ${what === 'applied' ? 'change' : 'revert'}: sha256 ${rb.sha.slice(0, 12)}…, ${what === 'applied' ? 'the reviewed configuration' : 'the snapshot'} exactly.` };
    }
    return { ok: false, why: `Nova doesn’t know a network confirmation called “${what}”.` };
  }

  // ---- what callers see ----------------------------------------------------------------------------

  list() {
    return {
      window_s: this.#windowS(),
      devices: this.#counted().map((d) => ({ id: d.id, name: d.name, kind: d.kind })),
      targets: this.#o.db.all<TargetRow>('SELECT * FROM network_target ORDER BY created_at').map((t) => this.target(t.id)),
      changes: this.#o.db.all<ChangeRow>('SELECT * FROM network_change ORDER BY created_at DESC LIMIT 100').map((c) => this.#summary(c)),
    };
  }

  #summary(c: ChangeRow) {
    const t = this.#target(c.target_id);
    const tasks = (parse<TaskRef[]>(c.tasks) ?? []).map((x) => {
      let task: Task | null = null;
      try { task = this.#o.ledger.get(x.id); } catch { /* gone */ }
      return { ...x, state: task?.state ?? 'gone', reason: task?.reason ?? null, approval_tier: task?.approval_tier ?? null };
    });
    return {
      id: c.id, title: c.title, target: { id: t.id, name: t.name, kind: t.kind }, state: c.state, reason: c.reason, changed: parse<string[]>(c.changed_keys) ?? [],
      window_s: c.window_s, armed_at: c.armed_at, deadline: c.deadline, contact_at: c.contact_at, contact_device: c.contact_device, session_id: c.session_id, tasks, created_at: c.created_at, updated_at: c.updated_at,
    };
  }

  // One change: everything the person reviews. Secret values are masked in the diff and the patch
  // can't hold one.
  view(id: string) {
    const c = this.#change(id);
    const snap = this.#readJson<{ at: string }>(join(this.#changeDir(c.id), 'snapshot.json'));
    return {
      ...this.#summary(c), patch: mask(parse<Json>(c.patch)), diff: c.diff, snapshot: c.snapshot_sha ? { sha256: c.snapshot_sha, version: c.snapshot_version, at: snap?.at ?? null } : null,
      checkpoint: c.checkpoint,
      apply: c.snapshot_sha ? `Applying writes this change to ${this.#target(c.target_id).name}, after a checkpoint. If Nova can’t hear from one of your devices within ${minutes(c.window_s)} afterwards, it puts the snapshot back by itself.` : null,
    };
  }

  changeOf(taskId: string): string | null {
    let t: Task;
    try { t = this.#o.ledger.get(taskId); } catch { return null; }
    return t.owner === NETWORK_WORKER ? String(t.brief.inputs?.change_id ?? '') || null : null;
  }

  decline(id: string) {
    const c = this.#change(id);
    const apply = (parse<TaskRef[]>(c.tasks) ?? []).filter((x) => x.step === 'apply').at(-1);
    const t = apply ? this.#o.ledger.get(apply.id) : null;
    if (!t || ['done', 'failed', 'cancelled'].includes(t.state) || c.state !== 'review') throw new CoreError('conflict', 'This change isn’t waiting for you to apply it.');
    this.#o.ledger.cancel(t.id, 'You didn’t apply it.');
    return this.view(id);
  }

  // The person asks to put a change back (tier 3: it is a network change of its own).
  revert(id: string) {
    const c = this.#change(id);
    // While the switch watches, it decides; a kept change is the person's to put back.
    if (c.state !== 'kept') throw new CoreError('conflict', c.state === 'watching' ? 'Nova is still waiting to hear from your devices after this change; it puts it back by itself without that.' : `This change can’t be put back now (it is ${c.state}).`);
    this.#set(c.id, { state: 'reverting', reason: 'You asked to put it back.' });
    const task = this.#make(this.#change(c.id), 'revert', 'person');
    return { change: this.view(id), task };
  }

  recover(): void {
    for (const c of this.#o.db.all<ChangeRow>(`SELECT * FROM network_change WHERE state IN ('preparing', 'review', 'applying', 'reverting')`)) {
      const last = (parse<TaskRef[]>(c.tasks) ?? []).at(-1);
      if (!last) continue;
      try { this.#advance(this.#o.ledger.get(last.id)); } catch (e) { this.#o.log.warn('network', 'Nova couldn’t pick a network change up again after a restart.', { change: c.id, error: (e as Error).message }); }
    }
    this.sweep();
  }

  close(): void {
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
  }

  // Whether a change's files are there (tests and the view).
  hasSnapshot(id: string): boolean { return existsSync(join(this.#changeDir(id), 'snapshot.json')); }
}
