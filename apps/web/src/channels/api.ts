// Hub client calls for channels (FR-088, FR-110, docs/13 §4), event triggers (FR-056, docs/09
// §7), MCP event subscriptions (FR-201) and notification routing with quiet hours (FR-060), in the
// conventions of src/api.ts. `createApi` spreads `channelsApi(call)` into the client, so `Api`
// includes these; until then `useChannelsApi` reads them from the same services object. Secrets
// are write-only: requests carry them, views only say whether one is set. Since M7 the bindings
// may be Telegram or email (FR-110); the M7 calls are in api-m7.ts.
import type { z } from 'zod';
import type {
  AgentView,
  ChannelAdapterViewM7,
  ChannelBindingViewM7,
  ChannelIdentityViewM7,
  McpEventSourceView,
  McpSubscriptionView,
  NotificationKind,
  NotificationRuleView,
  QuietHoursView,
  TriggerEventView,
  TriggerView,
  channelIdentityM7Schema,
  channelTestSchema,
  channelUpdateConfirmSchema,
  createChannelBindingM7Schema,
  createMcpSubscriptionSchema,
  createTriggerSchema,
  notificationRuleSchema,
  quietHoursSchema,
  updateChannelBindingSchema,
  updateTriggerSchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** A channel test's delivery receipt: the channel's own id for the sent message. */
export interface ChannelReceiptView {
  id: string;
  at: string;
}

const V1 = '/api/v1';
const enc = encodeURIComponent;
const channel = (id: string) => `${V1}/channels/${enc(id)}`;
const trigger = (id: string) => `${V1}/triggers/${enc(id)}`;

export function channelsApi(call: HubCall) {
  return {
    // ---- M6: channel bindings (FR-088) ---------------------------------------------------------
    /** Bindings plus which kinds this Hub can bind (`adapters`). */
    listChannels: (q: { agentId?: string } = {}) =>
      call<{ items: ChannelBindingViewM7[]; adapters: ChannelAdapterViewM7[] }>(
        'GET',
        `${V1}/channels${q.agentId ? `?agentId=${enc(q.agentId)}` : ''}`,
      ),
    /**
     * 409 `conflict` when the conversation is already bound; 400 when a kind is unavailable, an
     * email binding lacks its mailbox, or a mailbox server would be reached without TLS.
     */
    createChannel: (body: z.input<typeof createChannelBindingM7Schema>) =>
      call<ChannelBindingViewM7>('POST', `${V1}/channels`, body),
    getChannel: (id: string) => call<ChannelBindingViewM7>('GET', channel(id)),
    /**
     * Credentials are replaced by name; values are never returned. Turning an email binding's
     * sender check off (`config.senderCheck: none`) needs `confirmSenderCheckNone: true`, else
     * 400 `validation` with reason `confirm_required`.
     */
    updateChannel: (
      id: string,
      body: z.input<typeof updateChannelBindingSchema> & z.input<typeof channelUpdateConfirmSchema>,
    ) => call<ChannelBindingViewM7>('PATCH', channel(id), body),
    deleteChannel: (id: string) => call<{ ok: true }>('DELETE', channel(id)),
    /** Connecting probes the credentials; a problem shows as `statusDetail`. */
    connectChannel: (id: string) =>
      call<ChannelBindingViewM7>('POST', `${channel(id)}/connect`, {}),
    /** Stops messages both ways at once and cancels the turns the channel started. */
    disconnectChannel: (id: string) =>
      call<ChannelBindingViewM7>('POST', `${channel(id)}/disconnect`, {}),
    /** Sends a test message to the conversation; 409 `conflict` while disconnected. */
    testChannel: (id: string, body: z.input<typeof channelTestSchema> = {}) =>
      call<{ receipt: ChannelReceiptView }>('POST', `${channel(id)}/test`, body),
    listChannelIdentities: () =>
      call<{ items: ChannelIdentityViewM7[] }>('GET', `${V1}/channel-identities`),
    /** Adds or updates (same kind and external id) a mapped person. */
    addChannelIdentity: (body: z.input<typeof channelIdentityM7Schema>) =>
      call<ChannelIdentityViewM7>('POST', `${V1}/channel-identities`, body),
    removeChannelIdentity: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/channel-identities/${enc(id)}`),
    /** The agents a binding or trigger can belong to (GET /agents). */
    listChannelAgents: () => call<{ items: AgentView[] }>('GET', `${V1}/agents`),

    // ---- M6: event triggers (FR-056) -----------------------------------------------------------
    listTriggers: () => call<{ items: TriggerView[] }>('GET', `${V1}/triggers`),
    createTrigger: (body: z.input<typeof createTriggerSchema>) =>
      call<TriggerView>('POST', `${V1}/triggers`, body),
    getTrigger: (id: string) => call<TriggerView>('GET', trigger(id)),
    updateTrigger: (id: string, body: z.input<typeof updateTriggerSchema>) =>
      call<TriggerView>('PATCH', trigger(id), body),
    /** Unsubscribes an MCP event trigger's subscription first. */
    deleteTrigger: (id: string) => call<{ ok: true }>('DELETE', trigger(id)),
    /** The trigger's deliveries, newest first. */
    listTriggerEvents: (id: string, limit = 50) =>
      call<{ items: TriggerEventView[] }>('GET', `${trigger(id)}/events?limit=${limit}`),

    // ---- M6: MCP event subscriptions (FR-201) --------------------------------------------------
    listMcpSubscriptions: () =>
      call<{ items: McpSubscriptionView[] }>('GET', `${V1}/mcp/subscriptions`),
    /** An `mcp_event` trigger and its subscription in one call. */
    createMcpSubscription: (body: z.input<typeof createMcpSubscriptionSchema>) =>
      call<McpSubscriptionView>('POST', `${V1}/mcp/subscriptions`, body),
    getMcpSubscription: (id: string) =>
      call<McpSubscriptionView>('GET', `${V1}/mcp/subscriptions/${enc(id)}`),
    /** Unsubscribes; the row stays as `removed` and its trigger is turned off. */
    deleteMcpSubscription: (id: string) =>
      call<McpSubscriptionView>('DELETE', `${V1}/mcp/subscriptions/${enc(id)}`),
    /** Connected MCP servers that advertise events, with their events. */
    listMcpEventSources: () =>
      call<{ items: McpEventSourceView[] }>('GET', `${V1}/mcp/event-sources`),

    // ---- M6: notification routing and quiet hours (FR-060) -------------------------------------
    listNotificationRules: () =>
      call<{ items: NotificationRuleView[]; quietHours: QuietHoursView }>(
        'GET',
        `${V1}/notification-rules`,
      ),
    setNotificationRule: (
      category: NotificationKind,
      body: z.input<typeof notificationRuleSchema>,
    ) => call<NotificationRuleView>('PUT', `${V1}/notification-rules/${enc(category)}`, body),
    /** Back to the built-in default. */
    resetNotificationRule: (category: NotificationKind) =>
      call<NotificationRuleView>('DELETE', `${V1}/notification-rules/${enc(category)}`),
    getQuietHours: () => call<QuietHoursView>('GET', `${V1}/quiet-hours`),
    setQuietHours: (body: z.input<typeof quietHoursSchema>) =>
      call<QuietHoursView>('PUT', `${V1}/quiet-hours`, body),
  };
}

export type ChannelsApi = ReturnType<typeof channelsApi>;

/**
 * Run a call, turning a synchronous throw into a rejection: a section embedded in another page
 * shows its error state instead of breaking the page when a client lacks these calls.
 */
export function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** The channels calls of the app's client (part of `Api` once `createApi` spreads them in). */
export function useChannelsApi(): ChannelsApi {
  const api: unknown = useServices().api;
  return api as ChannelsApi;
}
