// Hub client calls for always-on agents (FR-079..FR-090, FR-181, FR-194, FR-206; docs/09 §8), in
// the conventions of src/api.ts. `createApi` spreads `agentsApi(call)` into the client, so `Api`
// includes these; until then `useAgentsApi` reads them from the same services object. The agent's
// channel bindings and computer are read through the channels and computers routes under names
// of their own, so they never clash with those areas' clients.
import type { z } from 'zod';
import type {
  ActivityItemView,
  AgentBackgroundView,
  AgentMemoryItemView,
  AgentResponsibilityView,
  AgentRulePreviewItem,
  AgentRuleView,
  AgentSuggestionView,
  AgentThreadView,
  AgentView,
  ChannelAdapterView,
  ChannelBindingView,
  ComputerView,
  ExternalAgentView,
  GoalView,
  ScheduleView,
  createAgentNoteSchema,
  createAgentRuleSchema,
  createAgentSchema,
  externalAgentSchema,
  responsibilitySchema,
  scheduleSchema,
  setAgentGoalSchema,
  updateAgentMemorySchema,
  updateAgentRuleSchema,
  updateAgentSchema,
  updateResponsibilitySchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

const agent = (id: string) => `${V1}/agents/${enc(id)}`;
const sub = (id: string, kind: string, subId: string) => `${agent(id)}/${kind}/${enc(subId)}`;

export type CreateAgentBody = z.input<typeof createAgentSchema>;
export type UpdateAgentBody = z.input<typeof updateAgentSchema>;
export type AgentRuleBody = z.input<typeof createAgentRuleSchema>;
export type AgentRulePatch = z.input<typeof updateAgentRuleSchema>;
export type AgentScheduleBody = z.input<typeof scheduleSchema>;

export function agentsApi(call: HubCall) {
  return {
    // ---- M6: agents (FR-079, FR-090) -----------------------------------------------------------
    listAgents: () => call<{ items: AgentView[] }>('GET', `${V1}/agents`),
    createAgent: (body: CreateAgentBody) => call<AgentView>('POST', `${V1}/agents`, body),
    getAgent: (id: string) => call<AgentView>('GET', agent(id)),
    /** Turning memory off purges what the agent derived (FR-089). */
    updateAgent: (id: string, body: UpdateAgentBody) => call<AgentView>('PATCH', agent(id), body),
    /** Irreversible (FR-090): the Hub refuses it without `{confirm: true}`. */
    deleteAgent: (id: string) => call<{ ok: true }>('DELETE', agent(id), { confirm: true }),
    /** The agent's avatar image, served by the Hub (only when `hasAvatar`). */
    agentAvatarUrl: (id: string) => `${agent(id)}/avatar`,
    pauseAgent: (id: string) => call<AgentView>('POST', `${agent(id)}/pause`, {}),
    /** 409 `conflict` when the agent is not paused or stopped. */
    resumeAgent: (id: string) => call<AgentView>('POST', `${agent(id)}/resume`, {}),
    stopAgent: (id: string) => call<AgentView>('POST', `${agent(id)}/stop`, {}),
    /** Proactive research now (FR-082); `started: false` with a reason when it cannot. */
    researchAgent: (id: string) =>
      call<{ started: boolean; reason: string | null }>('POST', `${agent(id)}/research`, {}),
    agentActivity: (id: string) =>
      call<{ items: ActivityItemView[] }>('GET', `${agent(id)}/activity`),
    agentThreads: (id: string) => call<{ items: AgentThreadView[] }>('GET', `${agent(id)}/threads`),
    agentBackground: (id: string) =>
      call<{ items: AgentBackgroundView[] }>('GET', `${agent(id)}/background`),

    // ---- responsibilities (FR-079) -------------------------------------------------------------
    listResponsibilities: (id: string) =>
      call<{ items: AgentResponsibilityView[] }>('GET', `${agent(id)}/responsibilities`),
    addResponsibility: (id: string, body: z.input<typeof responsibilitySchema>) =>
      call<AgentResponsibilityView>('POST', `${agent(id)}/responsibilities`, body),
    updateResponsibility: (
      id: string,
      rid: string,
      body: z.input<typeof updateResponsibilitySchema>,
    ) => call<AgentResponsibilityView>('PATCH', sub(id, 'responsibilities', rid), body),
    deleteResponsibility: (id: string, rid: string) =>
      call<{ ok: true }>('DELETE', sub(id, 'responsibilities', rid)),

    // ---- rules (FR-084) ------------------------------------------------------------------------
    listAgentRules: (id: string) => call<{ items: AgentRuleView[] }>('GET', `${agent(id)}/rules`),
    createAgentRule: (id: string, body: AgentRuleBody) =>
      call<AgentRuleView>('POST', `${agent(id)}/rules`, body),
    updateAgentRule: (id: string, ruleId: string, body: AgentRulePatch) =>
      call<AgentRuleView>('PATCH', sub(id, 'rules', ruleId), body),
    deleteAgentRule: (id: string, ruleId: string) =>
      call<{ ok: true }>('DELETE', sub(id, 'rules', ruleId)),
    /** Recent actions of the agent the rule would have matched. */
    previewAgentRule: (id: string, ruleId: string, limit = 50) =>
      call<{ items: AgentRulePreviewItem[] }>(
        'GET',
        `${sub(id, 'rules', ruleId)}/preview?limit=${limit}`,
      ),

    // ---- memory (FR-089) -----------------------------------------------------------------------
    listAgentMemory: (id: string) =>
      call<{ items: AgentMemoryItemView[] }>('GET', `${agent(id)}/memory`),
    addAgentNote: (id: string, body: z.input<typeof createAgentNoteSchema>) =>
      call<AgentMemoryItemView>('POST', `${agent(id)}/memory`, body),
    updateAgentMemory: (
      id: string,
      itemId: string,
      body: z.input<typeof updateAgentMemorySchema>,
    ) => call<AgentMemoryItemView>('PATCH', sub(id, 'memory', itemId), body),
    /** Forget one item. */
    deleteAgentMemory: (id: string, itemId: string) =>
      call<{ ok: true }>('DELETE', sub(id, 'memory', itemId)),

    // ---- suggestions (FR-082) ------------------------------------------------------------------
    listAgentSuggestions: (id: string, status?: AgentSuggestionView['status']) =>
      call<{ items: AgentSuggestionView[] }>(
        'GET',
        `${agent(id)}/suggestions${status ? `?status=${status}` : ''}`,
      ),
    /** Accepting only records it; 409 `conflict` once it was decided. */
    decideAgentSuggestion: (id: string, sid: string, action: 'accept' | 'dismiss') =>
      call<AgentSuggestionView>('POST', `${sub(id, 'suggestions', sid)}/${action}`, {}),

    // ---- goal (FR-181); pause, resume, complete and edits go through /goals/:id -----------------
    /** Null when the agent has no goal. */
    getAgentGoal: (id: string) => call<GoalView | null>('GET', `${agent(id)}/goal`),
    setAgentGoal: (id: string, body: z.input<typeof setAgentGoalSchema>) =>
      call<GoalView>('PUT', `${agent(id)}/goal`, body),
    clearAgentGoal: (id: string) => call<{ ok: true }>('DELETE', `${agent(id)}/goal`),

    // ---- schedules and self-set wakes (FR-059, FR-206); edits go through /schedules/:id --------
    listAgentSchedules: (id: string) =>
      call<{ items: ScheduleView[] }>('GET', `${agent(id)}/schedules`),
    createAgentSchedule: (id: string, body: AgentScheduleBody) =>
      call<ScheduleView>('POST', `${agent(id)}/schedules`, body),

    // ---- what other areas hold for an agent ------------------------------------------------------
    /** The agent's channel bindings (FR-088), from the channels area. */
    listAgentChannels: (id: string) =>
      call<{ items: ChannelBindingView[]; adapters: ChannelAdapterView[] }>(
        'GET',
        `${V1}/channels?agentId=${enc(id)}`,
      ),
    /** The agent's computer (FR-080), from the computers area. */
    getAgentComputer: (computerId: string) =>
      call<ComputerView>('GET', `${V1}/computers/${enc(computerId)}`),

    // ---- external agents (FR-194) --------------------------------------------------------------
    listExternalAgents: () => call<{ items: ExternalAgentView[] }>('GET', `${V1}/external-agents`),
    /** Marking an address that is already marked returns the existing entry. */
    addExternalAgent: (body: z.input<typeof externalAgentSchema>) =>
      call<ExternalAgentView>('POST', `${V1}/external-agents`, body),
    removeExternalAgent: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/external-agents/${enc(id)}`),
  };
}

export type AgentsApi = ReturnType<typeof agentsApi>;

/** The agents calls of the app's client (part of `Api` once `createApi` spreads them in). */
export function useAgentsApi(): AgentsApi {
  const api: unknown = useServices().api;
  return api as AgentsApi;
}
