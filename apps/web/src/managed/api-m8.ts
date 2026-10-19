// M8 Hub client calls for managed policy (FR-106; docs/12 §10; ADR-097 D4), in the conventions of
// src/api.ts: what applies and where it comes from, and the owner's reload. `createApi` spreads
// `managedApi(call)` into the client; until then `useManagedApi` reads them from the services
// object (and the views treat a client without them as a Hub without managed policy).
import type { ManagedPolicyView } from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';

export function managedApi(call: HubCall) {
  return {
    /**
     * What applies, each value's source, the sources with their status, and what was ignored and
     * why. The route is classified for members (it applies to everyone); a Hub that still checks
     * the owner answers a member 403 `policy_denied` `{reason: owner_only}`.
     */
    getManagedPolicy: () => call<ManagedPolicyView>('GET', `${V1}/managed`),
    /** Read the file and fetch the remote policy again (owner only); the new view. */
    reloadManagedPolicy: () => call<ManagedPolicyView>('POST', `${V1}/managed/reload`, {}),
  };
}

export type ManagedApi = ReturnType<typeof managedApi>;

/** The managed-policy calls of the app's client; absent ones are `undefined`. */
export function useManagedApi(): Partial<ManagedApi> {
  const api: unknown = useServices().api;
  return api as Partial<ManagedApi>;
}
