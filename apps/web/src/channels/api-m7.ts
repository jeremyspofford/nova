// M7 Hub client calls of the channels area (FR-110, FR-060, FR-055; docs/13 §4, §6), in the
// conventions of src/api.ts: a binding's message log, paged by cursor (no content: the text stays
// in the thread), a test notification of one kind through the whole pipeline, and a schedule's
// webhook signing secret, rotated and shown once. `createApi` spreads `channelsM7Api(call)` into the client next
// to `channelsApi(call)`; until then `useChannelsM7Api` reads them from the same services object.
import type {
  ChannelMessageStatus,
  ChannelMessagesPageView,
  NotificationKind,
  NotificationTestView,
  WebhookSecretView,
} from '@nova/shared';
import { useServices } from '../services.tsx';
import type { ChannelsApi, HubCall } from './api.ts';

const V1 = '/api/v1';
const enc = encodeURIComponent;

/**
 * `GET /channels/:id/messages` filters; `cursor` is the previous page's `nextCursor`. (The Hub
 * also takes `before`, but never together with `cursor`, so this client pages by cursor only.)
 */
export interface ChannelMessagesFilter {
  direction?: 'in' | 'out';
  status?: ChannelMessageStatus;
  cursor?: string;
  limit?: number;
}

export function channelsM7Api(call: HubCall) {
  return {
    /**
     * The binding's messages in and out, newest first, a page at a time (`nextCursor` is null on
     * the last page); 404 for an unknown binding, 400 for a cursor the Hub did not make.
     */
    listChannelMessages: (id: string, q: ChannelMessagesFilter = {}) => {
      const params = new URLSearchParams();
      if (q.direction) params.set('direction', q.direction);
      if (q.status) params.set('status', q.status);
      if (q.cursor) params.set('cursor', q.cursor);
      if (q.limit !== undefined) params.set('limit', String(q.limit));
      const qs = params.toString();
      return call<ChannelMessagesPageView>(
        'GET',
        `${V1}/channels/${enc(id)}/messages${qs ? `?${qs}` : ''}`,
      );
    },
    /**
     * A test notification of this kind through the whole pipeline (in Nova, on devices, to
     * channels); the answer says where the rule sends it now, quiet hours included.
     */
    testNotification: (category: NotificationKind, title?: string) =>
      call<NotificationTestView>(
        'POST',
        `${V1}/notification-rules/${enc(category)}/test`,
        title ? { title } : {},
      ),
    /**
     * A new signing secret for a schedule's webhook deliveries, shown once (`no-store`); the old
     * one stops working at once. 409 `conflict` when the schedule delivers to no webhook.
     */
    rotateScheduleWebhookSecret: (scheduleId: string) =>
      call<WebhookSecretView>('POST', `${V1}/schedules/${enc(scheduleId)}/webhook-secret`, {}),
  };
}

export type ChannelsM7Api = ReturnType<typeof channelsM7Api>;

/** The channels calls, M6 and M7, of the app's client. */
export function useChannelsM7Api(): ChannelsApi & ChannelsM7Api {
  const api: unknown = useServices().api;
  return api as ChannelsApi & ChannelsM7Api;
}
