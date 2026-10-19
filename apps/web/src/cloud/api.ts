// Hub client calls for the cloud runner (FR-108, FR-071, FR-116; docs/13 §3, docs/10 §12): the
// runner's registration (URL, a write-only token, on or off, a test), cloud environments with what
// the runner reports (rebuild, files, snapshots), the runs (leases) with their usage and caps,
// artifacts kept in a thread, and Work runs started on a cloud environment, in the conventions of
// src/api.ts. Cloud environments are created and removed through /api/v1/environments with kind
// `cloud`. `createApi` spreads `cloudApi(call)` into the client, so `Api` includes these; until
// then `useCloudApi` reads them from the services object.
import type { z } from 'zod';
import type {
  ArtifactView,
  CloudEnvironmentView,
  CloudFileView,
  CloudRunView,
  CloudRunnerTestView,
  CloudRunnerView,
  CloudSnapshotView,
  CloudWorkView,
  SavedEnvironmentView,
  cloudConnectionSchema,
  startCloudWorkSchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

function query(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
}

export type CloudConnectionBody = z.input<typeof cloudConnectionSchema>;
export type StartCloudWorkBody = z.input<typeof startCloudWorkSchema>;

export interface CloudRunsQuery {
  environmentId?: string;
  threadId?: string;
  status?: 'active' | 'all';
}

export function cloudApi(call: HubCall) {
  return {
    // ---- the runner ----------------------------------------------------------------------------
    getCloudRunner: () => call<CloudRunnerView>('GET', `${V1}/cloud/runner`),
    /**
     * Register or change the runner; the token goes to the vault (omit it to keep the stored one).
     * 400 `validation` with `token_required`, or `runner_test_failed` (with `test`) when turning
     * on a runner that does not pass its test; 403 `policy_denied` (`managed`).
     */
    configureCloudRunner: (body: { url: string; token?: string; enabled?: boolean }) =>
      call<CloudRunnerView>('PUT', `${V1}/cloud/runner`, body),
    /** 400 `runner_unconfigured` or `runner_test_failed` when turning on. */
    setCloudRunnerEnabled: (enabled: boolean) =>
      call<CloudRunnerView>('PATCH', `${V1}/cloud/runner`, { enabled }),
    testCloudRunner: () => call<CloudRunnerTestView>('POST', `${V1}/cloud/runner/test`, {}),
    /** The token leaves the vault, the URL is cleared and the runner is off. */
    forgetCloudRunner: () => call<{ ok: true }>('DELETE', `${V1}/cloud/runner`),

    // ---- environments --------------------------------------------------------------------------
    listCloudEnvironments: () =>
      call<{ items: CloudEnvironmentView[] }>('GET', `${V1}/cloud/environments`),
    getCloudEnvironment: (id: string) =>
      call<CloudEnvironmentView>('GET', `${V1}/cloud/environments/${enc(id)}`),
    /**
     * Made on the runner first, then saved. 400 `validation` (`over_cap` for disk above
     * `cloud.runner.caps`); 400 capability_missing `runner_unconfigured` / `runner_disabled`.
     */
    createCloudEnvironment: (label: string, connection: CloudConnectionBody) =>
      call<SavedEnvironmentView>('POST', `${V1}/environments`, {
        kind: 'cloud',
        label,
        connection,
      }),
    /** 409 `in_use` while active sessions use it. */
    deleteCloudEnvironment: (id: string) =>
      call<unknown>('DELETE', `${V1}/environments/${enc(id)}`),
    /** Clone again and run the setup again (202); 409 while commands run there. */
    rebuildCloudEnvironment: (id: string) =>
      call<CloudEnvironmentView>('POST', `${V1}/cloud/environments/${enc(id)}/rebuild`, {}),
    /** A folder listing or a file (text, or null for binary content), read on the runner. */
    readCloudFile: (id: string, path: string) =>
      call<CloudFileView>('GET', `${V1}/cloud/environments/${enc(id)}/files${query({ path })}`),

    // ---- snapshots -----------------------------------------------------------------------------
    listCloudSnapshots: (environmentId: string) =>
      call<{ items: CloudSnapshotView[] }>(
        'GET',
        `${V1}/cloud/environments/${enc(environmentId)}/snapshots`,
      ),
    createCloudSnapshot: (environmentId: string, label?: string) =>
      call<CloudSnapshotView>(
        'POST',
        `${V1}/cloud/environments/${enc(environmentId)}/snapshots`,
        label ? { label } : {},
      ),
    /** The workdir goes back to the snapshot; 409 `busy` while commands run there. */
    restoreCloudSnapshot: (id: string, keepCurrent: boolean) =>
      call<CloudSnapshotView>('POST', `${V1}/cloud/snapshots/${enc(id)}/restore`, {
        keepCurrent,
      }),
    deleteCloudSnapshot: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/cloud/snapshots/${enc(id)}`),

    // ---- runs ----------------------------------------------------------------------------------
    listCloudRuns: (q: CloudRunsQuery = {}) =>
      call<{ items: CloudRunView[] }>('GET', `${V1}/cloud/runs${query({ ...q })}`),
    getCloudRun: (id: string) => call<CloudRunView>('GET', `${V1}/cloud/runs/${enc(id)}`),
    /** New caps; a capped run with room again is active again. 409 `ended` for an ended run. */
    setCloudRunCaps: (id: string, caps: { cpuSeconds?: number; wallSeconds?: number }) =>
      call<CloudRunView>('PATCH', `${V1}/cloud/runs/${enc(id)}`, caps),
    cancelCloudRun: (id: string) =>
      call<CloudRunView>('POST', `${V1}/cloud/runs/${enc(id)}/cancel`, {}),
    /** Keep a file of the run's workdir in its thread (201); 400 when the run has no thread. */
    collectCloudArtifact: (id: string, body: { path: string; title?: string }) =>
      call<ArtifactView>('POST', `${V1}/cloud/runs/${enc(id)}/artifacts`, body),

    // ---- Work runs on a cloud environment ------------------------------------------------------
    /** 201; 409 `not_ready` while the environment is not ready; 400 `review_model_required`. */
    startCloudWork: (body: StartCloudWorkBody) =>
      call<CloudWorkView>('POST', `${V1}/cloud/work`, body),
  };
}

export type CloudApi = ReturnType<typeof cloudApi>;

/** The cloud runner calls of the app's client (part of `Api` once `createApi` spreads them). */
export function useCloudApi(): CloudApi {
  const api: unknown = useServices().api;
  return api as CloudApi;
}
