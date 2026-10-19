// Hub client calls for the flagged features (docs/17 §M7; off by default): scripted tool calls
// (FR-202, `scripts.enabled`) and external coding agents with their adapters and delegations from a
// Code session (FR-203, `externalAgents.enabled`), in the conventions of src/api.ts. While a flag
// is off its routes answer 404 as if absent. `createApi` spreads `flaggedApi(call)` into the
// client, so `Api` includes these; until then `useFlaggedApi` reads them from the services object.
import type {
  AgentAdapterCheck,
  AgentAdapterView,
  CreateAgentAdapterRequest,
  DelegationView,
  ScriptRunView,
  ScriptRunsPageView,
  UpdateAgentAdapterRequest,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

/** `GET /api/v1/scripts/runs`: one thread or the account; `limit` 1-200 (default 100). */
export interface ScriptRunsQuery {
  threadId?: string;
  limit?: number;
  cursor?: string;
}

/** A thread's script runs as listed (the nested calls come with one run). */
export type ScriptRunSummary = Omit<ScriptRunView, 'nested'>;

export function flaggedApi(call: HubCall) {
  return {
    // ---- scripted tool calls (FR-202) ----------------------------------------------------------
    /**
     * One thread's runs (`threadId`) or the whole account's, newest first, a page at a time
     * (`cursor` is the previous page's `nextCursor`); 404 while `scripts.enabled` is off.
     */
    listScriptRuns: (q: ScriptRunsQuery = {}) => {
      const p = new URLSearchParams();
      if (q.threadId) p.set('threadId', q.threadId);
      if (q.limit !== undefined) p.set('limit', String(q.limit));
      if (q.cursor) p.set('cursor', q.cursor);
      const qs = p.toString();
      return call<ScriptRunsPageView>('GET', `${V1}/scripts/runs${qs ? `?${qs}` : ''}`);
    },
    /** One run with each nested tool call and the gate's decision on it. */
    getScriptRun: (id: string) => call<ScriptRunView>('GET', `${V1}/scripts/runs/${enc(id)}`),

    // ---- external agent adapters (FR-203) ------------------------------------------------------
    /** 404 while `externalAgents.enabled` is off. */
    listAgentAdapters: () => call<{ items: AgentAdapterView[] }>('GET', `${V1}/agent-adapters`),
    /**
     * 201. Secret values in `env` go to the vault. 400 `permission_routing` for an adapter that
     * does not route every permission request to Nova; 409 for a name in use.
     */
    createAgentAdapter: (body: CreateAgentAdapterRequest) =>
      call<AgentAdapterView>('POST', `${V1}/agent-adapters`, body),
    /** `env` replaces the variables; an empty value keeps a variable's saved secret. */
    updateAgentAdapter: (id: string, body: UpdateAgentAdapterRequest) =>
      call<AgentAdapterView>('PATCH', `${V1}/agent-adapters/${enc(id)}`, body),
    /** Its secrets leave the vault and its running delegations stop. */
    deleteAgentAdapter: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/agent-adapters/${enc(id)}`),
    /** Starts the agent in that Code session's sandbox and runs the handshake only. */
    checkAgentAdapter: (id: string, sessionId: string) =>
      call<AgentAdapterCheck>('POST', `${V1}/agent-adapters/${enc(id)}/check`, { sessionId }),

    // ---- delegations from a Code session (FR-203) ----------------------------------------------
    listDelegations: (sessionId: string) =>
      call<{ items: DelegationView[] }>('GET', `${V1}/code/sessions/${enc(sessionId)}/delegations`),
    /** 202; 409 when the adapter is off or an agent already works in the session. */
    startDelegation: (sessionId: string, body: { adapterId: string; prompt: string }) =>
      call<DelegationView>('POST', `${V1}/code/sessions/${enc(sessionId)}/delegations`, body),
    getDelegation: (id: string) => call<DelegationView>('GET', `${V1}/delegations/${enc(id)}`),
    cancelDelegation: (id: string) =>
      call<DelegationView>('POST', `${V1}/delegations/${enc(id)}/cancel`, {}),
  };
}

export type FlaggedApi = ReturnType<typeof flaggedApi>;

/** The flagged-feature calls of the app's client (part of `Api` once `createApi` spreads them). */
export function useFlaggedApi(): FlaggedApi {
  const api: unknown = useServices().api;
  return api as FlaggedApi;
}
