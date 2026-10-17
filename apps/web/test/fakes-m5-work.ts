// The fake Hub's M5 Work part: runs, goals, schedules and server-to-client requests. A minimal
// in-memory version; the Work UI extends it with the behaviour its tests need.
/* eslint-disable @typescript-eslint/require-await */
import type {
  GoalView,
  RunView,
  ScheduleFireView,
  ScheduleView,
  ServerRequestView,
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
}

export function m5WorkState(init: Partial<M5WorkState> = {}): M5WorkState {
  return { runs: [], subagents: [], goals: [], schedules: [], fires: [], requests: [], ...init };
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

export function m5WorkImpl(
  st: M5WorkState,
  helpers: { id: (prefix: string) => string; ts: () => string; maybeFail: (n: keyof Api) => void },
): M5WorkApi {
  const { maybeFail } = helpers;
  const notFound = () =>
    new ApiError(404, { code: 'not_found', message: 'Not found', retryable: false });
  const run = (id: string) => {
    const r = st.runs.find((x) => x.id === id);
    if (!r) throw notFound();
    return r;
  };
  return {
    listRuns: async () => {
      maybeFail('listRuns');
      return { items: st.runs, nextCursor: null };
    },
    createRun: async () => {
      maybeFail('createRun');
      throw notFound();
    },
    getRun: async (id) => {
      maybeFail('getRun');
      return run(id);
    },
    controlRun: async (id) => {
      maybeFail('controlRun');
      return run(id);
    },
    extendRunBudget: async (id) => {
      maybeFail('extendRunBudget');
      return run(id);
    },
    updateRunPlan: async (id) => {
      maybeFail('updateRunPlan');
      return run(id);
    },
    startRun: async (id) => {
      maybeFail('startRun');
      return run(id);
    },
    listSubagents: async (runId) => {
      maybeFail('listSubagents');
      return { items: st.subagents.filter((s) => s.runId === runId) };
    },
    getRunGoal: async (runId) => {
      maybeFail('getRunGoal');
      return st.goals.find((g) => g.runId === runId && g.status !== 'complete') ?? null;
    },
    setRunGoal: async () => {
      maybeFail('setRunGoal');
      throw notFound();
    },
    clearRunGoal: async () => {
      maybeFail('clearRunGoal');
      return { ok: true as const };
    },
    listGoals: async () => {
      maybeFail('listGoals');
      return { items: st.goals };
    },
    updateGoal: async (id) => {
      maybeFail('updateGoal');
      const g = st.goals.find((x) => x.id === id);
      if (!g) throw notFound();
      return g;
    },
    goalAction: async (id) => {
      maybeFail('goalAction');
      const g = st.goals.find((x) => x.id === id);
      if (!g) throw notFound();
      return g;
    },
    listSchedules: async () => {
      maybeFail('listSchedules');
      return { items: st.schedules };
    },
    createSchedule: async () => {
      maybeFail('createSchedule');
      throw notFound();
    },
    updateSchedule: async (id) => {
      maybeFail('updateSchedule');
      const s = st.schedules.find((x) => x.id === id);
      if (!s) throw notFound();
      return s;
    },
    deleteSchedule: async (id) => {
      maybeFail('deleteSchedule');
      st.schedules = st.schedules.filter((x) => x.id !== id);
      return { ok: true as const };
    },
    scheduleHistory: async (id) => {
      maybeFail('scheduleHistory');
      return { items: st.fires.filter((f) => f.scheduleId === id) };
    },
    runScheduleNow: async () => {
      maybeFail('runScheduleNow');
      throw notFound();
    },
    listRequests: async () => {
      maybeFail('listRequests');
      return { items: st.requests.filter((r) => r.status === 'pending') };
    },
    respondRequest: async (id) => {
      maybeFail('respondRequest');
      const r = st.requests.find((x) => x.id === id);
      if (!r) throw notFound();
      return r;
    },
  };
}
