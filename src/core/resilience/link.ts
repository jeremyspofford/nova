// How a supervised Nova and its supervisor (src/supervisor) talk. The supervisor starts the server
// with an IPC channel and NOVA_SUPERVISED=1, and writes its state to the file NOVA_SUPERVISOR_STATE
// names. Nothing listens on a port for this: only the process the supervisor started can ask it
// anything, and only these few things.
//
//   supervisor → Nova: {nova: 'problem', source, said, playbook, subject?, detail?, repairs?}
//   Nova → supervisor: {nova: 'request', id, type: 'deploy' | 'rollback' | 'restart' | 'service-promote' | 'service-rollback', fixed fields?}
//   supervisor → Nova: {nova: 'reply', id, ok, said}
//   Nova → supervisor: {nova: 'mark', seq, problem}  where the database stands once it is
//     upgraded and before any work runs (core.start()), so a release that changed the database
//     knows exactly what going back would undo: everything after this, the work's own records too.
import { readFileSync } from 'node:fs';
import type { ServiceExpectedState } from '../services/expected.ts';
import type { ServicePolicy } from '../services/topology.ts';
import type { ServiceStatus } from '../services/driver.ts';

export type ServerMode = 'starting' | 'running' | 'restarting' | 'safe_mode' | 'deploying' | 'stopped';

export interface ProbeLine { at: string; ok: boolean; said: string }
export interface Stage { stage: 'prepare' | 'tests' | 'sandbox' | 'smoke' | 'switch' | 'canary' | 'promote' | 'rollback'; ok: boolean; at: string; said: string }

// `migration`: the database upgrade this release made when it went live (from → to), the backup
// taken before it, and where the person's data stood then, so going back knows what it may undo.
export interface ReleaseSlot {
  version: string;
  commit: string | null;
  created_at: string;
  status: 'ready' | 'live' | 'previous' | 'failed' | 'rolled_back';
  // `mark.by`: 'release' when the release said where the data stood before it ran any work;
  // 'supervisor' when an older release couldn't, and the supervisor read it after the start.
  migration?: { from: number; to: number; backup: string | null; mark: { seq: number; problem: number; by?: 'release' | 'supervisor' } } | null;
}

export interface SupervisorState {
  v: 1;
  pid: number;
  mode: ServerMode;
  since: string;
  server: { pid: number | null; port: number | null; started_at: string | null; restarts: number; last_exit: { code: number | null; signal: string | null; at: string } | null; code: string };
  safe_mode: { reason: string; at: string; last_good: string | null; output: string } | null;
  health: { last_check_at: string | null; last_ok_at: string | null; failing: number; said: string | null };
  // `base_commit`: the commit "base" runs, pinned when the supervisor started (never the
  // checkout as it is on disk now).
  releases: { current: string | null; previous: string | null; last_good: string | null; slots: ReleaseSlot[]; base_commit?: string | null };
  deploy: { version: string; from: string | null; started_at: string; stage: Stage['stage']; stages: Stage[]; canary: { until: string; probes: ProbeLine[] } | null; outcome: 'running' | 'promoted' | 'rolled_back' | 'stopped' | 'refused' | null } | null;
  history: { version: string; from: string | null; at: string; outcome: string; said: string }[];
  // The services the supervisor driver runs besides the console (M10e), as the driver reports them.
  services?: ServiceStatus[];
  observed_at?: string;
  service_policies?: ServicePolicy[];
}

export interface SupervisorProblem { source: string; said: string; playbook: string; subject?: string | null; detail?: string; repairs?: { name: string; ok: boolean; said: string }[] }

export interface SupervisorLink {
  state(): SupervisorState | null;
  request(type: 'deploy' | 'rollback' | 'restart', o?: { version?: string; staged?: boolean }): Promise<{ ok: boolean; said: string }>;
  service?(request: HubServiceRequest): Promise<{ ok: boolean; said: string; accepted?: boolean }>;
  onProblem(fn: (p: SupervisorProblem) => void): void;
  // Where the database stands before any work runs (see `mark` above).
  mark?(m: { seq: number; problem: number }): void;
}

export type HubServiceRequest = { action: 'promote'; service: string; version: string; confirm: string; expected: ServiceExpectedState } | { action: 'rollback'; service: string; confirm: string; expected: ServiceExpectedState };

// The link for a server the supervisor started (server.js passes it to the core), or null.
export function ipcLink(proc: NodeJS.Process, env: NodeJS.ProcessEnv = process.env): SupervisorLink | null {
  if (env.NOVA_SUPERVISED !== '1' || typeof proc.send !== 'function') return null;
  const file = env.NOVA_SUPERVISOR_STATE ?? null;
  const waiting = new Map<string, (r: { ok: boolean; said: string; accepted?: boolean }) => void>();
  const problems: ((p: SupervisorProblem) => void)[] = [];
  let n = 0;
  proc.on('message', (m: unknown) => {
    const msg = m as Record<string, unknown>;
    if (msg?.nova === 'reply' && typeof msg.id === 'string') {
      waiting.get(msg.id)?.({ ok: msg.ok === true, said: String(msg.said ?? ''), ...(msg.accepted === true ? { accepted: true } : {}) });
      waiting.delete(msg.id);
    } else if (msg?.nova === 'problem') {
      for (const fn of problems) fn(msg as unknown as SupervisorProblem);
    }
  });
  // The channel must not keep a stopping server alive.
  (proc.channel as { unref?: () => void } | undefined)?.unref?.();
  const request = (type: string, o: object = {}): Promise<{ ok: boolean; said: string; accepted?: boolean }> => {
    const id = `r${++n}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, said: 'The supervisor didn’t answer.' }); }, 10_000);
      timer.unref();
      waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
      try { proc.send!({ nova: 'request', id, type, ...o }); } catch { waiting.delete(id); clearTimeout(timer); resolve({ ok: false, said: 'The supervisor can’t be reached.' }); }
    });
  };
  return {
    state() {
      if (!file) return null;
      try { return JSON.parse(readFileSync(file, 'utf8')) as SupervisorState; } catch { return null; }
    },
    request,
    service(r) {
      return r.action === 'promote' ? request('service-promote', { service: r.service, version: r.version, confirm: r.confirm, expected: r.expected }) : request('service-rollback', { service: r.service, confirm: r.confirm, expected: r.expected });
    },
    onProblem(fn) { problems.push(fn); },
    mark(m) {
      try { proc.send!({ nova: 'mark', seq: m.seq, problem: m.problem }); } catch { /* the supervisor reads it itself then */ }
    },
  };
}

// Shared console projection: the supervisor driver and topology use exactly the same mapping.
export function consoleStatus(s: SupervisorState): ServiceStatus {
  const kind: Record<ReleaseSlot['status'], ServiceStatus['versions'][number]['status']> = { ready: 'ready', live: 'live', previous: 'kept', failed: 'failed', rolled_back: 'rolled_back' };
  const cur = s.releases.current ?? 'base';
  const versions = s.releases.slots.map((r) => ({ version: r.version, status: kind[r.status], since: r.created_at, said: null as string | null, ports: r.version === cur && s.server.port ? { console: s.server.port } : null, pid: r.version === cur ? s.server.pid : null }));
  if (!versions.some((v) => v.version === cur)) versions.unshift({ version: cur, status: 'live', since: s.server.started_at ?? s.since, said: cur === 'base' ? 'The code the supervisor started from.' : null, ports: s.server.port ? { console: s.server.port } : null, pid: s.server.pid });
  return {
    service: 'nova-console', driver: 'supervisor', live: cur, previous: s.releases.previous, soak_until: null,
    held: s.safe_mode ? { reason: s.safe_mode.reason, at: s.safe_mode.at } : null,
    health: { ok: s.health.last_check_at ? s.health.failing === 0 : null, checked_at: s.health.last_check_at, said: s.health.said },
    stable: s.server.port ? { console: s.server.port } : {},
    versions,
    history: s.history.map((h) => ({ at: h.at, version: h.version, outcome: h.outcome, said: h.said })),
  };
}
