// Hub client calls for the computers area (apps/hub/src/computers.ts): agent computers and their
// snapshots (FR-080), the egress proxy's network policy, the credentials it adds and its decision
// log (FR-102, FR-193, docs/12 §8), in the conventions of src/api.ts. `createApi` spreads
// `computersApi(call)` into the client, so `Api` includes these; until then
// `useComputersApi` reads them from the same services object.
import type { z } from 'zod';
import type {
  AgentView,
  ComputerSnapshotView,
  ComputerView,
  EgressCredentialView,
  EgressScopeKind,
  EgressScopeView,
  EgressView,
  NetworkDecisionView,
  computerSnapshotSchema,
  egressCredentialCreateSchema,
  egressCredentialUpdateSchema,
  egressScopeSchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** What the computers and network views need of an agent: its id and name. */
export type AgentRef = Pick<AgentView, 'id' | 'name'>;

export interface NetworkDecisionQuery {
  decision?: 'allow' | 'deny';
  /** An exact host; the Hub compares it in lower case. */
  host?: string;
  /** 1 to 500, newest first (the Hub's default is 100). */
  limit?: number;
  /** Older than this decision: a previous page's `nextCursor`. */
  before?: string;
}

const V1 = '/api/v1';
const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const computer = (id: string) => `${V1}/computers/${enc(id)}`;
const scope = (kind: EgressScopeKind, id: string) => `${V1}/egress/scopes/${enc(kind)}/${enc(id)}`;
const credential = (id: string) => `${V1}/egress/credentials/${enc(id)}`;

export function computersApi(call: HubCall) {
  return {
    // ---- M6: computers (FR-080, docs/11 §1-§2) --------------------------------------------------
    listComputers: () => call<{ items: ComputerView[] }>('GET', `${V1}/computers`),
    getComputer: (id: string) => call<ComputerView>('GET', computer(id)),
    /** Newest first. */
    listComputerSnapshots: (id: string) =>
      call<{ items: ComputerSnapshotView[] }>('GET', `${computer(id)}/snapshots`),
    /** 400 `capability_missing` for a connected device's computer. */
    createComputerSnapshot: (id: string, body: z.input<typeof computerSnapshotSchema> = {}) =>
      call<ComputerSnapshotView>('POST', `${computer(id)}/snapshots`, body),
    deleteComputerSnapshot: (id: string, snapshotId: string) =>
      call<{ ok: true }>('DELETE', `${computer(id)}/snapshots/${enc(snapshotId)}`),
    /** Put the computer's files back as they were in the snapshot; its sessions stop. */
    restoreComputer: (id: string, snapshotId: string) =>
      call<ComputerView>('POST', `${computer(id)}/restore`, { snapshotId }),
    stopComputer: (id: string) => call<ComputerView>('POST', `${computer(id)}/stop`, {}),
    /** The account's agents, to name a computer's owner and a network rule's scope. */
    listComputerAgents: () => call<{ items: AgentRef[] }>('GET', `${V1}/agents`),

    // ---- M6: egress policy (Settings > Network, FR-102, FR-193) --------------------------------
    /** The global policy (from settings), the per-scope rules and HTTPS inspection. */
    getEgress: () => call<EgressView>('GET', `${V1}/egress`),
    /** The per-Hub inspection certificate (PEM); 404 when HTTPS inspection is not set up. */
    egressCaUrl: () => `${V1}/egress/ca.pem`,
    /** Create or replace the rule of one scope (the whole rule: mode, lists, hooks). */
    putEgressScope: (kind: EgressScopeKind, id: string, body: z.input<typeof egressScopeSchema>) =>
      call<EgressScopeView>('PUT', scope(kind, id), body),
    deleteEgressScope: (kind: EgressScopeKind, id: string) =>
      call<{ ok: true }>('DELETE', scope(kind, id)),

    // ---- M6: credentials the proxy adds (ADR-063); values are write-only ----------------------
    listEgressCredentials: () =>
      call<{ items: EgressCredentialView[] }>('GET', `${V1}/egress/credentials`),
    createEgressCredential: (body: z.input<typeof egressCredentialCreateSchema>) =>
      call<EgressCredentialView>('POST', `${V1}/egress/credentials`, body),
    /** A `value` replaces the stored secret; 400 `validation` when nothing changes. */
    updateEgressCredential: (id: string, body: z.input<typeof egressCredentialUpdateSchema>) =>
      call<EgressCredentialView>('PATCH', credential(id), body),
    deleteEgressCredential: (id: string) => call<{ ok: true }>('DELETE', credential(id)),

    // ---- M6: the network decision log (docs/12 §8 audit) ---------------------------------------
    listNetworkDecisions: (q: NetworkDecisionQuery = {}) =>
      call<{ items: NetworkDecisionView[]; nextCursor: string | null }>(
        'GET',
        `${V1}/egress/decisions${query({ ...q })}`,
      ),
  };
}

export type ComputersApi = ReturnType<typeof computersApi>;

/** The computers calls of the app's client (part of `Api` once `createApi` spreads them in). */
export function useComputersApi(): ComputersApi {
  const api: unknown = useServices().api;
  return api as ComputersApi;
}
