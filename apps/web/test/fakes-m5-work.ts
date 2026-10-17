// The fake Hub's M5 Work part: runs, goals, schedules and server-to-client requests. An in-memory
// version with just enough behaviour for the Work UI tests: runs pause, resume, extend and start;
// goals change status; schedules are created, edited and fired; requests resolve once.
/* eslint-disable @typescript-eslint/require-await */
import type {
  GoalView,
  RunPlanStep,
  RunStatus,
  RunView,
  ScheduleFireView,
  ScheduleView,
  ServerRequestView,
  StatusView,
  SubagentView,
} from '@nova/shared';
import { ApiError, type Api } from '../src/api.ts';

export interface M5WorkState {
  runs: RunView[];
  subagents: SubagentView[];
  goals: GoalView[];
  schedules: ScheduleView[];
  fires: ScheduleFireView[];
  requests: ServerRequestView[];
  /** Redirect texts sent to runs, oldest first. */
  redirects: { runId: string; text: string }[];
}

export function m5WorkState(init: Partial<M5WorkState> = {}): M5WorkState {
  return {
    runs: [],
    subagents: [],
    goals: [],
    schedules: [],
    fires: [],
    requests: [],
    redirects: [],
    ...init,
  };
}

let n = 0;
const T0 = '2026-10-01T12:00:00.000Z';

const DERIVED: Record<RunStatus, StatusView> = {
  planning: { status: 'needs_input', reason: 'Plan to approve' },
  running: { status: 'running', reason: null },
  waiting_approval: { status: 'needs_input', reason: 'Approval needed' },
  paused: { status: 'ready', reason: null },
  done: { status: 'ready', reason: null },
  output_missing: { status: 'blocked', reason: 'Output missing' },
  failed: { status: 'blocked', reason: 'Run failed' },
  cancelled: { status: 'ready', reason: null },
};

export function runView(over: Partial<RunView> = {}): RunView {
  const id = over.id ?? `run${++n}`;
  const status = over.status ?? 'running';
  return {
    id,
    title: 'Summarize the report',
    objective: 'Summarize the attached report and save a Markdown artifact.',
    threadId: `${id}-thread`,
    projectId: null,
    parentRunId: null,
    origin: 'user',
    originRef: null,
    status,
    pauseReason: null,
    autonomy: 'standard',
    plan: null,
    planApproved: false,
    budgets: { timeSeconds: 3600, tokens: 2_000_000, costUsd: null },
    used: { timeSeconds: 0, tokens: 0, costUsd: 0 },
    expectedOutput: null,
    outputVerifiedAt: null,
    result: null,
    goalId: null,
    derived: DERIVED[status],
    createdAt: T0,
    updatedAt: T0,
    endedAt: null,
    ...over,
  };
}

export function planSteps(
  titles: string[],
  status: (i: number) => RunPlanStep['status'] = () => 'pending',
): RunPlanStep[] {
  return titles.map((title, idx) => ({
    idx,
    title,
    status: status(idx),
    detail: null,
    startedAt: null,
    endedAt: null,
  }));
}

export function goalView(over: Partial<GoalView> = {}): GoalView {
  return {
    id: `goal${++n}`,
    runId: null,
    agentId: null,
    threadId: null,
    objective: 'Migrate the billing tests to the new fixtures',
    status: 'active',
    statusSetBy: 'user',
    statusReason: null,
    progressNote: null,
    completionSummary: null,
    budgets: {},
    usage: {},
    blocker: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    ...over,
  };
}

export function subagentView(over: Partial<SubagentView> = {}): SubagentView {
  return {
    id: `sub${++n}`,
    runId: 'run1',
    threadId: null,
    role: 'researcher',
    objective: 'Find the Q3 invoices',
    status: 'running',
    result: null,
    createdAt: T0,
    endedAt: null,
    ...over,
  };
}

export function scheduleView(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: `sch${++n}`,
    title: 'Morning digest',
    when: { cron: '0 9 * * *' },
    timezone: 'UTC',
    startsAt: null,
    endsAt: null,
    instructions: 'Summarize what changed overnight.',
    notifyCondition: null,
    deliveryTargets: [{ kind: 'inapp' }],
    output: null,
    catchUp: { policy: 'once', lookbackSeconds: 604_800 },
    origin: 'user',
    agentId: null,
    wakeReason: null,
    projectId: null,
    autonomy: 'standard',
    enabled: true,
    nextRunAt: '2026-10-02T09:00:00.000Z',
    lastRunAt: null,
    lastOutcome: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function fireView(over: Partial<ScheduleFireView> = {}): ScheduleFireView {
  return {
    id: `fire${++n}`,
    scheduleId: 'sch1',
    kind: 'fire',
    window: null,
    runId: null,
    outcome: 'done',
    firedAt: T0,
    ...over,
  };
}

export function requestView(over: Partial<ServerRequestView> = {}): ServerRequestView {
  return {
    id: `req${++n}`,
    kind: 'user_input',
    correlation: {},
    targetDeviceId: null,
    status: 'pending',
    payload: { question: 'Which quarter?' },
    resolution: null,
    createdAt: T0,
    expiresAt: '2026-10-02T12:00:00.000Z',
    ...over,
  };
}

export type M5WorkApi = Pick<
  Api,
  | 'listRuns'
  | 'createRun'
  | 'getRun'
  | 'controlRun'
  | 'extendRunBudget'
  | 'updateRunPlan'
  | 'startRun'
  | 'listSubagents'
  | 'getRunGoal'
  | 'setRunGoal'
  | 'clearRunGoal'
  | 'listGoals'
  | 'updateGoal'
  | 'goalAction'
  | 'listSchedules'
  | 'createSchedule'
  | 'updateSchedule'
  | 'deleteSchedule'
  | 'scheduleHistory'
  | 'runScheduleNow'
  | 'listRequests'
  | 'respondRequest'
>;

const ACTIVE: readonly RunStatus[] = ['planning', 'running', 'waiting_approval', 'paused'];

export function m5WorkImpl(
  st: M5WorkState,
  helpers: { id: (prefix: string) => string; ts: () => string; maybeFail: (n: keyof Api) => void },
): M5WorkApi {
  const { maybeFail, id, ts } = helpers;
  const notFound = () =>
    new ApiError(404, { code: 'not_found', message: 'Not found', retryable: false });
  const run = (rid: string) => {
    const r = st.runs.find((x) => x.id === rid);
    if (!r) throw notFound();
    return r;
  };
  /** Replace a run with a patched copy (views handed out are never mutated). */
  const patchRun = (rid: string, patch: Partial<RunView>): RunView => {
    const next = { ...run(rid), ...patch, updatedAt: ts() };
    if (patch.status && !patch.derived) next.derived = DERIVED[patch.status];
    st.runs = st.runs.map((r) => (r.id === rid ? next : r));
    return { ...next };
  };
  const goal = (gid: string) => {
    const g = st.goals.find((x) => x.id === gid);
    if (!g) throw notFound();
    return g;
  };
  const patchGoal = (gid: string, patch: Partial<GoalView>): GoalView => {
    const next = { ...goal(gid), ...patch, updatedAt: ts() };
    st.goals = st.goals.map((g) => (g.id === gid ? next : g));
    return { ...next };
  };
  const schedule = (sid: string) => {
    const s = st.schedules.find((x) => x.id === sid);
    if (!s) throw notFound();
    return s;
  };
  return {
    listRuns: async (q = {}) => {
      maybeFail('listRuns');
      const items = st.runs
        .filter((r) => q.status !== 'active' || ACTIVE.includes(r.status))
        .filter((r) => !q.projectId || r.projectId === q.projectId)
        .map((r) => ({ ...r }));
      return { items, nextCursor: null };
    },
    createRun: async (body) => {
      maybeFail('createRun');
      const rid = id('run');
      const status: RunStatus = body.autonomy === 'ask_first' ? 'planning' : 'running';
      const r = runView({
        id: rid,
        threadId: id('t'),
        title: body.title ?? body.objective.slice(0, 60),
        objective: body.objective,
        projectId: body.projectId ?? null,
        autonomy: body.autonomy ?? 'standard',
        status,
        budgets: {
          timeSeconds: body.budgets?.timeSeconds ?? 3600,
          tokens: body.budgets?.tokens ?? 2_000_000,
          costUsd: body.budgets?.costUsd ?? null,
        },
        expectedOutput: body.expectedOutput ?? null,
        createdAt: ts(),
        updatedAt: ts(),
      });
      if (body.goal) {
        const g = goalView({ runId: rid, threadId: r.threadId, objective: body.goal.objective });
        st.goals = [...st.goals, g];
        r.goalId = g.id;
      }
      st.runs = [r, ...st.runs];
      return { ...r };
    },
    getRun: async (rid) => {
      maybeFail('getRun');
      return { ...run(rid) };
    },
    controlRun: async (rid, action, text) => {
      maybeFail('controlRun');
      switch (action) {
        case 'pause':
          return patchRun(rid, { status: 'paused', pauseReason: 'user' });
        case 'resume':
          return patchRun(rid, { status: 'running', pauseReason: null });
        case 'cancel':
          return patchRun(rid, { status: 'cancelled', pauseReason: null, endedAt: ts() });
        case 'redirect':
          st.redirects.push({ runId: rid, text: text ?? '' });
          return { ...run(rid) };
      }
    },
    extendRunBudget: async (rid, body) => {
      maybeFail('extendRunBudget');
      const r = run(rid);
      // Amounts are added to the budgets; a run paused at a bound continues (FR-182).
      const budgets = {
        timeSeconds: r.budgets.timeSeconds + (body.timeSeconds ?? 0),
        tokens: r.budgets.tokens + (body.tokens ?? 0),
        costUsd:
          body.costUsd === undefined ? r.budgets.costUsd : (r.budgets.costUsd ?? 0) + body.costUsd,
      };
      const atBound = r.status === 'paused' && r.pauseReason !== 'user';
      return patchRun(rid, {
        budgets,
        ...(atBound ? { status: 'running' as const, pauseReason: null } : {}),
      });
    },
    updateRunPlan: async (rid, body) => {
      maybeFail('updateRunPlan');
      return patchRun(rid, {
        plan: body.steps.map((s, idx) => ({
          idx,
          title: s.title,
          status: 'pending',
          detail: s.detail ?? null,
          startedAt: null,
          endedAt: null,
        })),
      });
    },
    startRun: async (rid) => {
      maybeFail('startRun');
      return patchRun(rid, { planApproved: true, status: 'running' });
    },
    listSubagents: async (runId) => {
      maybeFail('listSubagents');
      return { items: st.subagents.filter((s) => s.runId === runId) };
    },
    getRunGoal: async (runId) => {
      maybeFail('getRunGoal');
      const g = st.goals.find((x) => x.runId === runId);
      return g ? { ...g } : null;
    },
    setRunGoal: async (runId, body) => {
      maybeFail('setRunGoal');
      const r = run(runId);
      const existing = st.goals.find((x) => x.runId === runId);
      if (existing) return patchGoal(existing.id, { objective: body.objective, status: 'active' });
      const g = goalView({ runId, threadId: r.threadId, objective: body.objective });
      st.goals = [...st.goals, g];
      patchRun(runId, { goalId: g.id });
      return { ...g };
    },
    clearRunGoal: async (runId) => {
      maybeFail('clearRunGoal');
      st.goals = st.goals.filter((g) => g.runId !== runId);
      if (st.runs.some((r) => r.id === runId)) patchRun(runId, { goalId: null });
      return { ok: true as const };
    },
    listGoals: async () => {
      maybeFail('listGoals');
      return { items: st.goals };
    },
    updateGoal: async (gid, body) => {
      maybeFail('updateGoal');
      return patchGoal(gid, {
        ...(body.objective !== undefined ? { objective: body.objective } : {}),
        ...(body.budgets ? { budgets: body.budgets } : {}),
      });
    },
    goalAction: async (gid, action) => {
      maybeFail('goalAction');
      const status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'complete';
      return patchGoal(gid, {
        status,
        statusSetBy: 'user',
        blocker: null,
        completedAt: status === 'complete' ? ts() : null,
      });
    },
    listSchedules: async () => {
      maybeFail('listSchedules');
      return { items: st.schedules.map((s) => ({ ...s })) };
    },
    createSchedule: async (body) => {
      maybeFail('createSchedule');
      const s = scheduleView({
        id: id('sch'),
        title: body.title ?? body.instructions.slice(0, 60),
        when: body.when,
        timezone: body.timezone,
        instructions: body.instructions,
        notifyCondition: body.notifyCondition ?? null,
        deliveryTargets: body.deliveryTargets ?? [{ kind: 'inapp' }],
        output: body.output ?? null,
        catchUp: {
          policy: body.catchUp?.policy ?? 'once',
          lookbackSeconds: body.catchUp?.lookbackSeconds ?? 604_800,
        },
        projectId: body.projectId ?? null,
        enabled: body.enabled ?? true,
        createdAt: ts(),
        updatedAt: ts(),
      });
      st.schedules = [...st.schedules, s];
      return { ...s };
    },
    updateSchedule: async (sid, body) => {
      maybeFail('updateSchedule');
      const prev = schedule(sid);
      const next: ScheduleView = {
        ...prev,
        ...(body.when ? { when: body.when } : {}),
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.instructions ? { instructions: body.instructions } : {}),
        ...(body.notifyCondition !== undefined ? { notifyCondition: body.notifyCondition } : {}),
        ...(body.deliveryTargets ? { deliveryTargets: body.deliveryTargets } : {}),
        ...(body.output ? { output: body.output } : {}),
        ...(body.catchUp
          ? {
              catchUp: {
                policy: body.catchUp.policy ?? prev.catchUp.policy,
                lookbackSeconds: body.catchUp.lookbackSeconds ?? prev.catchUp.lookbackSeconds,
              },
            }
          : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        updatedAt: ts(),
      };
      st.schedules = st.schedules.map((s) => (s.id === sid ? next : s));
      return { ...next };
    },
    deleteSchedule: async (sid) => {
      maybeFail('deleteSchedule');
      st.schedules = st.schedules.filter((x) => x.id !== sid);
      return { ok: true as const };
    },
    scheduleHistory: async (sid) => {
      maybeFail('scheduleHistory');
      return { items: st.fires.filter((f) => f.scheduleId === sid) };
    },
    runScheduleNow: async (sid) => {
      maybeFail('runScheduleNow');
      const s = schedule(sid);
      const r = runView({
        id: id('run'),
        title: s.title,
        objective: s.instructions,
        origin: 'schedule',
        originRef: sid,
      });
      st.runs = [r, ...st.runs];
      st.fires = [
        ...st.fires,
        fireView({ scheduleId: sid, runId: r.id, outcome: null, firedAt: ts() }),
      ];
      return { runId: r.id };
    },
    listRequests: async (status = 'pending') => {
      maybeFail('listRequests');
      return {
        items: st.requests.filter((r) => status === 'all' || r.status === 'pending'),
      };
    },
    respondRequest: async (rid, result) => {
      maybeFail('respondRequest');
      const r = st.requests.find((x) => x.id === rid);
      if (!r) throw notFound();
      // The first valid answer wins (FR-188); a later one is a conflict.
      if (r.status === 'expired')
        throw new ApiError(410, {
          code: 'request_expired',
          message: 'The question expired.',
          retryable: false,
        });
      if (r.status === 'resolved')
        throw new ApiError(409, {
          code: 'conflict',
          message: 'Already answered.',
          retryable: false,
        });
      const next: ServerRequestView = {
        ...r,
        status: 'resolved',
        resolution: { by: 'user', at: ts(), result },
      };
      st.requests = st.requests.map((x) => (x.id === rid ? next : x));
      return { ...next };
    },
  };
}
