// Hub client calls for Web Push (FR-111, FR-060; docs/13 §6; apps/hub/src/push.ts), in the
// conventions of src/api.ts. Every route needs a session. `createApi` spreads `pushApi(call)` into
// the client; until then `usePushApi` reads these from the services object.
//   GET    /api/v1/push/vapid-key           the application server key to subscribe with
//   GET    /api/v1/push/subscriptions       the account's browser subscriptions (no endpoints)
//   POST   /api/v1/push/subscriptions       add or renew one (PushSubscription.toJSON()), 201
//   DELETE /api/v1/push/subscriptions/:id   remove one (404 `not_found` for an unknown id)
//   POST   /api/v1/push/test                push a test to each (or one; 404 for an unknown id)
import type {
  CreatePushSubscriptionRequest,
  PushSubscriptionView,
  PushTestView,
  PushVapidKeyView,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

export function pushApi(call: HubCall) {
  return {
    getPushVapidKey: () => call<PushVapidKeyView>('GET', `${V1}/push/vapid-key`),
    listPushSubscriptions: () =>
      call<{ items: PushSubscriptionView[] }>('GET', `${V1}/push/subscriptions`),
    /**
     * The endpoint must be https on `push.webPushHosts` (400 `validation` otherwise); the same
     * endpoint again renews its keys. A device session's subscription is tied to its device.
     */
    subscribePush: (body: CreatePushSubscriptionRequest) =>
      call<PushSubscriptionView>('POST', `${V1}/push/subscriptions`, body),
    unsubscribePush: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/push/subscriptions/${enc(id)}`),
    testPush: (subscriptionId?: string) =>
      call<PushTestView>('POST', `${V1}/push/test`, subscriptionId ? { subscriptionId } : {}),
  };
}

export type PushApi = ReturnType<typeof pushApi>;

/** The push calls of the app's client (part of `Api` once `createApi` spreads them). */
export function usePushApi(): PushApi {
  const api: unknown = useServices().api;
  return api as PushApi;
}
