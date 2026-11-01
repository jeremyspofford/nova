// The native update pipeline on a device (M10h; the orchestration ADR Point 6(b)), decided here, in
// the runtime agent, and carried out by the boot agent's five verbs (src/device/workloads.ts). Part of
// the runtime: it runs under Node's permission model with no network and no child processes, so it
// can only ask, over IPC, and report what happened in its heartbeat.
//
// What the hub assigns, per service (its heartbeat answer's `workloads`):
//   want alongside   deploy a version next to the live one, with no traffic: install it (fetch and
//                    verify), start it alongside or as a shadow if its definition says so, check its
//                    health three times in a row, and report `ready`. A version that can't run twice
//                    (alongside none) is `ready` once installed and verified; its health is checked
//                    at the switch.
//   want live        the version the hub promoted, at its tier: switch to it, check its health, and
//                    if it fails go back to the kept version by itself (tier 1: act and report). The
//                    kept slot is used, so going back downloads nothing. A version that failed after
//                    its switch isn't tried again until the hub assigns it again.
//   want stopped     stop whatever runs.
// Reports (`workloads[]` in the heartbeat): service, version, status, health, since and why.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { WorkloadState, VerbResult, WorkloadVerb } from './workloads.ts';

export interface Assignment {
  service: string;
  version: string;
  want: 'alongside' | 'live' | 'stopped';
  previous: string | null;
  alongside: 'full' | 'shadow' | 'copy' | 'none';
  capture: boolean;
  // When the hub made this assignment: a version that failed is tried again only for a new one.
  assigned_at: string;
}
export type ReportStatus = 'installed' | 'alongside' | 'ready' | 'live' | 'kept' | 'failed' | 'rolled_back';
export interface Report { service: string; version: string; status: ReportStatus; health: boolean | null; since: string; said: string }
export type Verb = (verb: WorkloadVerb, service: string, version: string) => Promise<VerbResult>;

const SERVICE = /^[a-z][a-z0-9-]{0,52}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// What the hub sent, kept only where it makes sense: anything else in the answer is dropped.
export function readAssignments(v: unknown): Assignment[] {
  if (!Array.isArray(v)) return [];
  const out: Assignment[] = [];
  for (const a of v.slice(0, 32)) {
    if (!a || typeof a !== 'object') continue;
    const x = a as Record<string, unknown>;
    if (typeof x.service !== 'string' || !SERVICE.test(x.service) || typeof x.version !== 'string' || !VERSION.test(x.version)) continue;
    if (!['alongside', 'live', 'stopped'].includes(x.want as string)) continue;
    out.push({
      service: x.service, version: x.version, want: x.want as Assignment['want'],
      previous: typeof x.previous === 'string' && VERSION.test(x.previous) ? x.previous : null,
      alongside: ['full', 'shadow', 'copy', 'none'].includes(x.alongside as string) ? x.alongside as Assignment['alongside'] : 'none',
      capture: x.capture === true, assigned_at: typeof x.assigned_at === 'string' ? x.assigned_at.slice(0, 40) : '',
    });
  }
  return out;
}

export interface RolloutOptions {
  verb: Verb;
  // state/rollout.json: what was reported and which assignments failed, across restarts.
  file?: string;
  // Health passes in a row before a version counts as healthy, and the wait between them.
  passes?: number;
  gapMs?: number;
  // Failed checks in a row, once live, before it goes back to the kept version.
  failsLive?: number;
  now?: () => Date;
}

interface Saved { reports: Record<string, Report>; failed: string[]; done: string[] }

export class Rollout {
  #o: Required<Omit<RolloutOptions, 'file'>> & { file?: string };
  #saved: Saved = { reports: {}, failed: [], done: [] };
  #busy = false;
  #misses = new Map<string, number>();

  constructor(o: RolloutOptions) {
    this.#o = { passes: 3, gapMs: 300, failsLive: 3, now: () => new Date(), ...o };
    if (o.file) {
      try {
        const s = JSON.parse(readFileSync(o.file, 'utf8')) as Saved;
        this.#saved = { reports: s.reports ?? {}, failed: Array.isArray(s.failed) ? s.failed : [], done: Array.isArray(s.done) ? s.done : [] };
      } catch { /* first run */ }
    }
  }

  reports(): Report[] {
    return Object.values(this.#saved.reports).sort((a, b) => a.service.localeCompare(b.service) || a.version.localeCompare(b.version));
  }

  // One pass over what the hub assigned. Passes never overlap; one that is running makes the next
  // call a no-op, and the next heartbeat tries again.
  async step(assignments: Assignment[], state: WorkloadState[]): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      let st = state;
      for (const a of assignments) st = await this.#one(a, st);
    } finally {
      this.#busy = false;
      this.#save();
    }
  }

  async #one(a: Assignment, state: WorkloadState[]): Promise<WorkloadState[]> {
    let st = state;
    const key = `${a.service}@${a.version}#${a.assigned_at}`;
    const s = () => st.find((x) => x.service === a.service);
    const once = async (verb: WorkloadVerb, version: string) => { const r = await this.#o.verb(verb, a.service, version); st = r.state ?? st; return r; };
    // A slot the boot agent refuses to start (changed since it was installed, or signed by a key the
    // roster no longer accepts after a promotion) is installed again from the hub, verified afresh,
    // and tried once more.
    const run = async (verb: WorkloadVerb, version = a.version) => {
      const r = await once(verb, version);
      if (r.ok || !r.refused || (verb !== 'start' && verb !== 'switch')) return r;
      const again = await once('install', version);
      return again.ok ? once(verb, version) : r;
    };
    const running = (version: string) => s()?.running.some((r) => r.version === version && !r.failed) ?? false;

    if (a.want === 'stopped') {
      for (const r of s()?.running ?? []) await run('stop', r.version);
      return st;
    }
    if (this.#saved.failed.includes(key)) return st;
    if (!s()?.installed.includes(a.version)) {
      const r = await run('install');
      if (!r.ok) {
        this.#report(a.service, a.version, 'failed', null, r.said);
        // A refusal (unsigned, a wrong hash, a role it doesn't hold) won't change by asking again.
        if (r.refused) this.#saved.failed.push(key);
        return st;
      }
      this.#report(a.service, a.version, 'installed', null, r.said);
    }

    if (a.want === 'alongside') {
      // The live version keeps running while a new one is tried (after a restart, or capture turned
      // back on, it is started again).
      const live = s()?.live;
      if (live && live !== a.version && !running(live)) await run('start', live);
      if (this.#saved.done.includes(key)) return st;
      if (a.alongside === 'none' || a.alongside === 'copy') {
        this.#report(a.service, a.version, 'ready', null, 'Installed and checked. It can’t run next to the live version, so its health is checked when it is switched to; the version before it is kept for one step back.');
        this.#saved.done.push(key);
        return st;
      }
      if (!running(a.version)) {
        const r = await run('start');
        if (!r.ok) { this.#report(a.service, a.version, 'installed', null, r.said); return st; }
      }
      this.#report(a.service, a.version, 'alongside', null, a.alongside === 'shadow' ? 'Running as a shadow: its output is thrown away.' : 'Running alongside the live version, with no traffic.');
      const h = await this.#healthy(a.service, a.version, run);
      if (h.ok) {
        this.#report(a.service, a.version, 'ready', true, `Its health passed ${this.#o.passes} times in a row ${a.alongside === 'shadow' ? 'as a shadow' : 'alongside'}.`);
        this.#saved.done.push(key);
      } else {
        await run('stop');
        this.#report(a.service, a.version, 'failed', false, h.said);
        this.#saved.failed.push(key);
      }
      return st;
    }

    // want live
    const before = s()?.live ?? null;
    if (before !== a.version) {
      const r = await run('switch');
      if (!r.ok) { this.#report(a.service, a.version, 'failed', null, r.said); if (r.refused) this.#saved.failed.push(key); return st; }
      if (!running(a.version)) {
        // Live, but not started: capture is off on this device (the boot agent said so).
        this.#report(a.service, a.version, 'live', null, r.said);
        if (before) this.#report(a.service, before, 'kept', null, 'Kept, stopped, for one step back.');
        return st;
      }
      const h = await this.#healthy(a.service, a.version, run);
      if (h.ok) {
        this.#report(a.service, a.version, 'live', true, r.said);
        if (before) this.#report(a.service, before, 'kept', null, 'Kept, stopped, for one step back.');
        return st;
      }
      return this.#back(a, before, h.said, run, () => st, key);
    }
    // Live already: started if it isn't running and may run (after a restart, or capture turned on),
    // and watched. Failing health several times in a row goes back to the kept version by itself.
    // A held instance still exists: probe it as failed health, preserving its watchdog's crash
    // history and the usual consecutive-check rollback path instead of asking for a fresh start.
    if (!s()?.running.some((r) => r.version === a.version)) {
      const r = await run('start');
      if (!r.ok) { this.#report(a.service, a.version, 'live', null, r.said); return st; }
    }
    const p = await run('probe');
    const id = `${a.service}@${a.version}`;
    if (p.ok) { this.#misses.delete(id); this.#report(a.service, a.version, 'live', true, this.#saved.reports[id]?.said ?? p.said, { keepSince: true }); return st; }
    const n = (this.#misses.get(id) ?? 0) + 1;
    this.#misses.set(id, n);
    this.#report(a.service, a.version, 'live', false, p.said, { keepSince: true });
    // Back only to the version the hub says is kept: not one it withdrew (a version that failed).
    if (n >= this.#o.failsLive && a.previous && a.previous !== a.version && s()?.installed.includes(a.previous)) {
      this.#misses.delete(id);
      return this.#back(a, a.previous, `${p.said} (${n} checks in a row)`, run, () => st, key);
    }
    return st;
  }

  // Back to the kept version in one step, by itself.
  async #back(a: Assignment, to: string | null, why: string, run: (verb: WorkloadVerb, version?: string) => Promise<VerbResult>, st: () => WorkloadState[], key: string): Promise<WorkloadState[]> {
    this.#saved.failed.push(key);
    if (!to) {
      await run('stop');
      this.#report(a.service, a.version, 'failed', false, `Its health failed after it was switched to, and there is no version kept to go back to: ${why}`);
      return st();
    }
    const r = await run('switch', to);
    this.#report(a.service, a.version, 'rolled_back', false, `Its health failed after it was switched to, so the device went back to ${to} by itself${r.ok ? ', from the kept slot (nothing was downloaded)' : `, but that failed too: ${r.said}`}. ${why}`);
    if (r.ok) this.#report(a.service, to, 'live', null, `Live again after ${a.version} failed its health.`);
    return st();
  }

  async #healthy(service: string, version: string, run: (verb: WorkloadVerb, version?: string) => Promise<VerbResult>): Promise<{ ok: boolean; said: string }> {
    let passed = 0;
    let last = '';
    // A program needs a moment to listen: a few more tries than passes, a pause between each.
    for (let i = 0; i < this.#o.passes * 4 && passed < this.#o.passes; i++) {
      await new Promise((r) => setTimeout(r, this.#o.gapMs));
      const p = await run('probe', version);
      last = p.said;
      if (p.ok) passed++;
      else if (passed > 0) return { ok: false, said: `${service} ${version} passed its health check, then failed it: ${p.said}` };
    }
    return passed >= this.#o.passes ? { ok: true, said: last } : { ok: false, said: `${service} ${version} didn’t pass its health check ${this.#o.passes} times in a row: ${last}` };
  }

  #report(service: string, version: string, status: ReportStatus, health: boolean | null, said: string, o: { keepSince?: boolean } = {}): void {
    const id = `${service}@${version}`;
    const prev = this.#saved.reports[id];
    const since = o.keepSince && prev?.status === status ? prev.since : this.#o.now().toISOString();
    this.#saved.reports[id] = { service, version, status, health, since, said: said.slice(0, 300) };
    // Only the versions that matter are reported: at most a few per service.
    const mine = Object.values(this.#saved.reports).filter((r) => r.service === service).sort((a, b) => b.since.localeCompare(a.since));
    for (const r of mine.slice(4)) delete this.#saved.reports[`${r.service}@${r.version}`];
  }

  #save(): void {
    if (!this.#o.file) return;
    this.#saved.failed = this.#saved.failed.slice(-100);
    this.#saved.done = this.#saved.done.slice(-100);
    const tmp = `${this.#o.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#saved)}\n`);
    renameSync(tmp, this.#o.file);
  }
}
