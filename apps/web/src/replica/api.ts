// Hub client calls for sync (FR-109, FR-112, FR-129; apps/hub/src/sync.ts), in the conventions of
// src/api.ts. The replica routes (snapshot, changes, push) need a device session with the
// `offline-replica` scope: 403 `policy_denied` with `replica_not_granted` (or `sync_disabled`)
// otherwise, 401 for a revoked device. The merge log, restore and the replica list take any
// session of the account. `createApi` spreads `syncApi(call)` into the client; until then
// `useSyncApi` reads them from the services object. The offline layer builds its own from the
// request function `createApi` hands it.
import type {
  SendMessageResponse,
  SyncChangesView,
  SyncKind,
  SyncMergeEntryView,
  SyncPushRequest,
  SyncPushResult,
  SyncReplicaView,
  SyncSnapshotView,
} from '@nova/shared';
import type { CallOptions } from '../api.ts';
import { useServices } from '../services.tsx';

export type SyncCall = <T>(
  method: string,
  path: string,
  body?: unknown,
  options?: CallOptions,
) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/**
 * `GET /api/v1/session` as sync reads it (decision 3 of ADR-095): a device session names its
 * device and scopes; the owner's own browser session has neither (null).
 */
export interface SyncSession {
  accountId: string | null;
  displayName: string | null;
  deviceId?: string | null;
  scopes?: string[] | null;
}

export const REPLICA_SCOPE = 'offline-replica';
export const LOCAL_RUNTIME_SCOPE = 'local-runtime';

export function syncApi(call: SyncCall) {
  return {
    /** The session with its device and scopes. */
    syncSession: (options?: CallOptions) =>
      call<SyncSession>('GET', `${V1}/session`, undefined, options),
    /** A page of the full load; `kind` limits it to one kind. */
    syncSnapshot: (q: { kind?: SyncKind; cursor?: string; limit?: number } = {}) =>
      call<SyncSnapshotView>('GET', `${V1}/sync/snapshot${query({ ...q })}`),
    /** What changed after `since`; 409 `replica_reset` or `cursor_ahead`: load again. */
    syncChanges: (since: number, limit?: number) =>
      call<SyncChangesView>('GET', `${V1}/sync/changes${query({ since, limit })}`),
    /** This device's changes; a resend carries the same Idempotency-Key. */
    syncPush: (body: SyncPushRequest, idempotencyKey: string) =>
      call<SyncPushResult>('POST', `${V1}/sync/push`, body, { idempotencyKey, offline: false }),
    listMergeLog: (
      q: { status?: 'open' | 'restored' | 'all'; limit?: number; before?: string } = {},
    ) => call<{ items: SyncMergeEntryView[] }>('GET', `${V1}/sync/merge-log${query({ ...q })}`),
    /** 409 `already_restored`, `deleted`, `not_supported`; 400 `invalid_value`; 404. */
    restoreMergeEntry: (id: string) =>
      call<SyncMergeEntryView>('POST', `${V1}/sync/merge-log/${enc(id)}/restore`, {}),
    listSyncDevices: () => call<{ items: SyncReplicaView[] }>('GET', `${V1}/sync/devices`),
    /** The device loads its offline copy again before it pulls more changes; 404 unknown. */
    resetSyncDevice: (id: string) =>
      call<SyncReplicaView>('POST', `${V1}/sync/devices/${enc(id)}/reset`, {}),
    /**
     * Ask the Hub to answer a message this device wrote offline (202 with the turn). 409
     * `answered`, `not_last` or `turn_in_progress`; 400 `shared_thread` or `not_user_message`.
     */
    answerMessage: (threadId: string, messageId: string, idempotencyKey: string) =>
      call<SendMessageResponse>(
        'POST',
        `${V1}/threads/${enc(threadId)}/messages/${enc(messageId)}/answer`,
        {},
        { idempotencyKey, offline: false },
      ),
  };
}

export type SyncApi = ReturnType<typeof syncApi>;

/** The sync calls of the app's client (part of `Api` once `createApi` spreads them). */
export function useSyncApi(): SyncApi {
  const api: unknown = useServices().api;
  return api as SyncApi;
}
