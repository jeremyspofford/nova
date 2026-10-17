// Hub client calls for the Network surface (docs/04 §9, docs/22): the network panel and its
// diagnostics with one-click rollback (FR-135, FR-139), the Network Setup assistant (FR-136), trust
// and certificates (FR-134), the Relay and its paired clients (FR-137) and Wake helpers (FR-138),
// in the conventions of src/api.ts. `createApi` spreads `networkSurfaceApi(call)` into the client,
// so `Api` includes these; until then `useNetworkSurfaceApi` reads them from the services object.
import type { z } from 'zod';
import type {
  MeshProvider,
  NetworkChangeView,
  NetworkDetectionView,
  NetworkDiagnosticsView,
  NetworkSetupCheckView,
  NetworkSetupConsentView,
  NetworkSetupRunView,
  NetworkSetupStepView,
  NetworkTestResult,
  NetworkView,
  RelayConfigView,
  RelayPairedClientView,
  RelayTestView,
  TrustView,
  networkSetupOptionsSchema,
  patchRelaySchema,
  trustPatchSchema,
  updateNetworkSchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

export type UpdateNetworkBody = z.input<typeof updateNetworkSchema>;
export type NetworkSetupOptionsBody = z.input<typeof networkSetupOptionsSchema>;
export type TrustPatchBody = z.input<typeof trustPatchSchema>;
export type RelayPatchBody = z.input<typeof patchRelaySchema>;

/**
 * One wake as the Wake helpers section shows it (FR-138): `via` is the helper's device id, `hub`
 * when the Hub sent it, or null when nothing could. From the panel's `wakeHelpers.recent` and
 * live `device.wake.sent` events.
 */
export interface WakeLogEntry {
  id: string;
  deviceId: string;
  deviceName?: string | null;
  mac: string | null;
  status: string;
  via: string | null;
  viaName?: string | null;
  error?: string | null;
  createdAt: string;
}

/** `GET /api/v1/network`. */
export type NetworkPanel = NetworkView;

/** `PATCH /api/v1/network`: the panel and the change it recorded (null when nothing changed). */
export type NetworkUpdated = NetworkPanel & { change: NetworkChangeView | null };

export interface NetworkRolledBack {
  change: NetworkChangeView;
  network: NetworkPanel;
}

export interface SetupApplied {
  action: 'apply';
  run: NetworkSetupRunView;
  step: NetworkSetupStepView;
}

export interface SetupVerified {
  action: 'verify';
  run: NetworkSetupRunView;
  ok: boolean;
  checks: NetworkSetupCheckView[];
}

export function networkSurfaceApi(call: HubCall) {
  return {
    // ---- transports, endpoints, diagnostics, rollback (FR-135, FR-139) -------------------------
    getNetworkPanel: () => call<NetworkPanel>('GET', `${V1}/network`),
    /**
     * All or nothing, audited and recorded for rollback. 400 `validation` with `no_transport` when
     * every transport would be off, `url_required` for Direct public without a URL,
     * `unknown_device` for a Wake helper that is not this account's.
     */
    updateNetworkPanel: (body: UpdateNetworkBody) =>
      call<NetworkUpdated>('PATCH', `${V1}/network`, body),
    /** Every reachability test now; 400 `capability_missing` (`no_listener`) before the Hub listens. */
    testNetwork: () => call<NetworkTestResult>('POST', `${V1}/network/test`, {}),
    /** The last applied change (or `changeId`); 409 `nothing_to_roll_back` when there is none. */
    rollbackNetworkChange: (changeId?: string) =>
      call<NetworkRolledBack>('POST', `${V1}/network/rollback`, changeId ? { changeId } : {}),
    getNetworkDiagnostics: () => call<NetworkDiagnosticsView>('GET', `${V1}/network/diagnostics`),

    // ---- the Network Setup assistant (FR-136, docs/22 §6) --------------------------------------
    detectNetwork: () =>
      call<{ action: 'detect'; detection: NetworkDetectionView }>('POST', `${V1}/network/setup`, {
        action: 'detect',
      }),
    /** 201 with the run; secrets in `options` go to the vault and come back as `stored`. */
    planNetworkSetup: (provider: MeshProvider, options: NetworkSetupOptionsBody = {}) =>
      call<{ action: 'plan'; run: NetworkSetupRunView }>('POST', `${V1}/network/setup`, {
        action: 'plan',
        provider,
        options,
      }),
    /**
     * Apply one step (the next pending one without `stepId`). 403 `policy_denied` with
     * `consent_required` (its details carry the exact description to send back) or
     * `system_changes_disabled`; 409 `would_lock_out`, `setup_busy`, `earlier_step_pending`… A
     * step that failed or was rolled back is a result, not an error.
     */
    applyNetworkSetupStep: (
      runId: string,
      opts: { stepId?: string; consent?: { stepId: string; description: string } } = {},
    ) =>
      call<SetupApplied>('POST', `${V1}/network/setup`, {
        action: 'apply',
        runId,
        ...(opts.stepId ? { stepId: opts.stepId } : {}),
        ...(opts.consent ? { consent: opts.consent } : {}),
      }),
    verifyNetworkSetup: (runId: string, stepId?: string) =>
      call<SetupVerified>('POST', `${V1}/network/setup`, {
        action: 'verify',
        runId,
        ...(stepId ? { stepId } : {}),
      }),
    listNetworkSetupRuns: () =>
      call<{ items: NetworkSetupRunView[] }>('GET', `${V1}/network/setup/runs`),
    getNetworkSetupRun: (id: string) =>
      call<NetworkSetupRunView>('GET', `${V1}/network/setup/runs/${enc(id)}`),
    /** The whole run, or only its last applied step; 409 `not_last_step`, `nothing_to_roll_back`. */
    rollbackNetworkSetup: (id: string, stepId?: string) =>
      call<NetworkSetupRunView>(
        'POST',
        `${V1}/network/setup/runs/${enc(id)}/rollback`,
        stepId ? { stepId } : {},
      ),
    listNetworkSetupConsents: () =>
      call<{ items: NetworkSetupConsentView[] }>('GET', `${V1}/network/setup/consents`),
    revokeNetworkSetupConsent: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/network/setup/consents/${enc(id)}`),

    // ---- trust and certificates (FR-134, docs/22 §5) -------------------------------------------
    getTrust: () => call<TrustView>('GET', `${V1}/trust`),
    /** 403 `policy_denied` (`managed`) for a value managed policy sets. */
    updateTrust: (body: TrustPatchBody) => call<TrustView>('PATCH', `${V1}/trust`, body),
    /** 409 `conflict`: `trust_off`, `no_local_ca` or `no_mesh_cert`. */
    renewTrust: (target: 'leaf' | 'mesh' | 'all') =>
      call<TrustView>('POST', `${V1}/trust/renew`, { target }),
    /** The local CA's root for devices to install (public; 404 unless the mode is `local-ca`). */
    trustCaUrl: (format: 'pem' | 'crt') => `${V1}/trust/ca.${format}`,

    // ---- the Relay (FR-137, docs/22 §3) --------------------------------------------------------
    getRelay: () => call<RelayConfigView>('GET', `${V1}/relay`),
    /** 403 `policy_denied` (`managed`) for a setting managed policy sets. */
    updateRelay: (body: RelayPatchBody) => call<RelayConfigView>('PATCH', `${V1}/relay`, body),
    testRelay: () => call<RelayTestView>('POST', `${V1}/relay/test`, {}),
    listRelayClients: () => call<{ items: RelayPairedClientView[] }>('GET', `${V1}/relay/clients`),
    /** The client loses its route at the Relay and its device is revoked; 404 for an unknown id. */
    revokeRelayClient: (id: string) =>
      call<{ ok: true; client: RelayPairedClientView }>(
        'POST',
        `${V1}/relay/clients/${enc(id)}/revoke`,
        {},
      ),
  };
}

export type NetworkSurfaceApi = ReturnType<typeof networkSurfaceApi>;

/** The Network surface calls of the app's client (part of `Api` once `createApi` spreads them). */
export function useNetworkSurfaceApi(): NetworkSurfaceApi {
  const api: unknown = useServices().api;
  return api as NetworkSurfaceApi;
}
