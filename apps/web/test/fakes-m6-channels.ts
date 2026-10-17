// The fake Hub's M6 channels part: channel bindings and identity mapping (FR-088), event triggers
// (FR-056), MCP event subscriptions (FR-201) and notification routing with quiet hours (FR-060),
// in memory, with the Hub's rules: bodies are checked with the shared zod schemas (400
// `validation`); email and unavailable kinds are 400 `capability_missing`; Slack and Teams need
// credentials or another binding's, not both; a conversation bound twice with the same app is 409
// `conflict`; the in-app channel stays private; only a private binding shares the primary thread;
// a disconnected binding cannot send a test (409); credential names are checked per kind and
// values are kept here, never returned; a binding's status follows enabled, credentials and the
// adapter. Triggers: a channel watch needs a Slack binding; an MCP event needs a known server
// and, when it is connected, an offered event; a project must exist; only webhooks take
// credentials or a dedupe field and only watches a text filter; deleting an MCP subscription
// keeps it as `removed` and turns its trigger off. Rules only name Slack, Teams or webhook
// bindings; quiet hours need a known time zone. Views handed out are copies.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m6channels: M6ChannelsState`,
// `createHub` defaults it to `m6ChannelsState()`, and `impl` spreads
// `...m6ChannelsImpl(state.m6channels, { id, ts: () => ts(), maybeFail })`. Until then tests build
// the client with `createChannelsHub()` and spread its `api` over `createHub().api`.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import type { z } from 'zod';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  NOTIFICATION_KINDS,
  channelIdentitySchema,
  channelTestSchema,
  createChannelBindingSchema,
  createMcpSubscriptionSchema,
  createTriggerSchema,
  notificationRuleSchema,
  quietHoursSchema,
  updateChannelBindingSchema,
  updateTriggerSchema,
  type AgentView,
  type ChannelAdapterView,
  type ChannelBindingKind,
  type ChannelBindingView,
  type ChannelIdentityView,
  type CreateChannelBindingRequest,
  type CreateTriggerRequest,
  type McpEventSourceView,
  type McpServerView,
  type McpSubscriptionView,
  type NotificationKind,
  type NotificationRuleView,
  type ProjectView,
  type QuietHoursView,
  type ServerRequestView,
  type TriggerEventView,
  type TriggerView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { ChannelsApi } from '../src/channels/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;

const CREDENTIAL_NAMES: Partial<Record<ChannelBindingKind, readonly string[]>> = {
  slack: ['botToken', 'signingSecret'],
  teams: ['appPassword'],
  webhook: ['token', 'secret'],
};
const CONFIG_KEYS: Partial<Record<ChannelBindingKind, readonly string[]>> = {
  slack: ['botUserId', 'teamId'],
  teams: ['appId', 'serviceUrl'],
  webhook: ['callbackUrl'],
};
const INBOUND = new Set<ChannelBindingKind>(['slack', 'teams', 'webhook']);
const ROUTABLE = new Set<ChannelBindingKind>(['slack', 'teams', 'webhook']);
const EMAIL_UNAVAILABLE =
  'email channels are not available yet: they need a connected mailbox (IMAP and SMTP)';

export const DEFAULT_ADAPTERS: ChannelAdapterView[] = [
  { kind: 'inapp', available: true, detail: null },
  { kind: 'slack', available: true, detail: null },
  { kind: 'teams', available: true, detail: null },
  { kind: 'email', available: false, detail: EMAIL_UNAVAILABLE },
  { kind: 'webhook', available: true, detail: null },
];

export function bindingView(over: Partial<ChannelBindingView> = {}): ChannelBindingView {
  const id = over.id ?? `ch${++n}`;
  const kind = over.kind ?? 'slack';
  return {
    id,
    agentId: null,
    kind,
    label: `${kind === 'slack' ? 'Slack' : kind} C0${n}`,
    externalRef: `C0${n}`,
    audience: kind === 'inapp' ? 'private' : 'shared',
    threadId: null,
    sharePrimaryThread: false,
    allowUnknown: false,
    rateLimit: { perMinute: 10, perHour: 120 },
    status: 'connected',
    statusDetail: null,
    config: {},
    credentials: (CREDENTIAL_NAMES[kind] ?? []).map((name) => ({ name, set: true })),
    sharesCredentialsWith: null,
    inboundPath: INBOUND.has(kind) ? `/api/v1/channels/${id}/inbound` : null,
    lastMessageAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function identityView(over: Partial<ChannelIdentityView> = {}): ChannelIdentityView {
  return {
    id: `ci${++n}`,
    kind: 'slack',
    externalId: `U0${n}`,
    displayName: null,
    role: 'member',
    createdAt: T0,
    ...over,
  };
}

export function agentChoice(over: Partial<AgentView> = {}): AgentView {
  return {
    id: `ag${++n}`,
    name: 'Research',
    hasAvatar: false,
    instructions: '',
    status: 'active',
    pauseReason: null,
    statusDetail: null,
    autonomy: 'standard',
    model: null,
    computerId: null,
    primaryThreadId: null,
    proactive: { enabled: false, lastRunAt: null },
    memoryEnabled: true,
    budgets: { timeSeconds: 600, tokens: 100_000, costUsd: null },
    usage: { timeSeconds: 0, tokens: 0, costUsd: 0 },
    goalId: null,
    responsibilities: [],
    derived: { status: 'ready', reason: null },
    openSuggestions: 0,
    lastActiveAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function subscriptionView(over: Partial<McpSubscriptionView> = {}): McpSubscriptionView {
  const id = over.id ?? `sub${++n}`;
  return {
    id,
    triggerId: 'tr1',
    serverId: 'srv1',
    event: 'issue.created',
    status: 'active',
    filter: null,
    expiresAt: '2026-10-02T12:00:00.000Z',
    refreshBefore: '2026-10-02T06:00:00.000Z',
    lastDeliveryAt: null,
    lastError: null,
    webhookPath: `/api/v1/mcp/events/${id}`,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function triggerView(over: Partial<TriggerView> = {}): TriggerView {
  const id = over.id ?? `tr${++n}`;
  const kind = over.kind ?? 'webhook';
  return {
    id,
    kind,
    title: 'Webhook: Triage new issues',
    action: 'run',
    agentId: null,
    projectId: null,
    instructions: 'Triage new issues',
    autonomy: 'standard',
    enabled: true,
    available: kind !== 'fs_change' && kind !== 'email',
    unavailableReason:
      kind === 'fs_change'
        ? 'file-change triggers need a connected device (novad); they do not fire yet'
        : kind === 'email'
          ? 'email triggers need a connected mailbox; they do not fire yet'
          : null,
    sourceRef: null,
    config: {},
    dedupeKey: null,
    webhookPath: kind === 'webhook' ? `/api/v1/triggers/${id}/webhook` : null,
    subscription: null,
    lastFiredAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function triggerEventView(over: Partial<TriggerEventView> = {}): TriggerEventView {
  return {
    triggerId: 'tr1',
    dedupeKey: `evt-${++n}`,
    status: 'started',
    runId: null,
    threadId: null,
    turnId: null,
    detail: null,
    receivedAt: T0,
    ...over,
  };
}

export function ruleView(
  category: NotificationKind,
  over: Partial<NotificationRuleView> = {},
): NotificationRuleView {
  return {
    category,
    inapp: true,
    os: true,
    channels: [],
    bypassQuietHours: category === 'approval',
    isDefault: true,
    updatedAt: null,
    ...over,
  };
}

export function quietView(over: Partial<QuietHoursView> = {}): QuietHoursView {
  return {
    enabled: false,
    start: '22:00',
    end: '07:00',
    timezone: 'UTC',
    days: [0, 1, 2, 3, 4, 5, 6],
    active: false,
    until: null,
    ...over,
  };
}

/** A pending share ask (the channels area's `user_input` request for a shared binding's thread). */
export function shareAsk(
  threadId: string,
  over: Partial<ServerRequestView> = {},
): ServerRequestView {
  return {
    id: `rq${++n}`,
    kind: 'user_input',
    correlation: { threadId },
    targetDeviceId: null,
    status: 'pending',
    payload: {
      question:
        'A reply in Slack #ops, a shared channel, uses private information (1 source). Share it there?',
      choices: ['Share', 'Do not share'],
      allowFreeText: false,
    },
    resolution: null,
    createdAt: T0,
    expiresAt: '2026-10-02T12:00:00.000Z',
    ...over,
  };
}

export interface M6ChannelsState {
  bindings: ChannelBindingView[];
  adapters: ChannelAdapterView[];
  identities: ChannelIdentityView[];
  agents: AgentView[];
  /** null: GET /agents fails (no agents area on this Hub). */
  agentsAvailable: boolean;
  triggers: TriggerView[];
  triggerEvents: TriggerEventView[];
  subscriptions: McpSubscriptionView[];
  /** Connected servers that advertise events. */
  sources: McpEventSourceView[];
  /** Every MCP server of the account (connected or not). */
  mcpServers: { id: string; name: string }[];
  /** Stored rules only; the rest are defaults. */
  rules: NotificationRuleView[];
  quietHours: QuietHoursView;
  /** Secret values the Hub keeps, by `<credential group>/<name>` (never in a view). */
  secrets: Record<string, string>;
  /** Each binding's credential group (its own id, or the binding it shares with). */
  groups: Record<string, string>;
  /** Bindings that are turned on (a disconnected one is off). */
  enabled: Record<string, boolean>;
  /** Test messages sent, oldest first. */
  sent: { bindingId: string; text: string }[];
  projectIds: string[];
}

export function m6ChannelsState(init: Partial<M6ChannelsState> = {}): M6ChannelsState {
  const st: M6ChannelsState = {
    bindings: [],
    adapters: DEFAULT_ADAPTERS.map((a) => ({ ...a })),
    identities: [],
    agents: [],
    agentsAvailable: true,
    triggers: [],
    triggerEvents: [],
    subscriptions: [],
    sources: [],
    mcpServers: [],
    rules: [],
    quietHours: quietView(),
    secrets: {},
    groups: {},
    enabled: {},
    sent: [],
    projectIds: [],
    ...init,
  };
  // Given bindings keep their status: fill in what it implies.
  for (const b of st.bindings) {
    st.groups[b.id] ??= b.sharesCredentialsWith ?? b.id;
    st.enabled[b.id] ??= b.status !== 'disconnected';
    for (const c of b.credentials)
      if (c.set) st.secrets[`${st.groups[b.id]}/${c.name}`] ??= 'stored-secret-value';
  }
  for (const s of st.sources)
    if (!st.mcpServers.some((x) => x.id === s.serverId))
      st.mcpServers.push({ id: s.serverId, name: s.name });
  return st;
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

const notFound = (what = 'Not found') => err(404, 'not_found', what);
const fieldError = (field: string, message: string) => err(400, 'validation', message, { field });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const first = r.error.issues[0];
    throw err(
      400,
      'validation',
      r.error.issues.map((i) => i.message).join('; ') || 'Invalid',
      first?.path.length ? { field: first.path.map(String).join('.') } : undefined,
    );
  }
  return r.data;
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function m6ChannelsImpl(
  st: M6ChannelsState,
  helpers: {
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof ChannelsApi) => void;
  },
): ChannelsApi {
  const { id, ts, maybeFail } = helpers;

  const binding = (bid: string) => {
    const b = st.bindings.find((x) => x.id === bid);
    if (!b) throw notFound('channel binding not found');
    return b;
  };
  const adapter = (kind: ChannelBindingKind) => st.adapters.find((a) => a.kind === kind);
  /** The view as the Hub derives it now: credentials from the store, status from them. */
  const view = (b: ChannelBindingView): ChannelBindingView => {
    const group = st.groups[b.id] ?? b.id;
    const credentials = (CREDENTIAL_NAMES[b.kind] ?? []).map((name) => ({
      name,
      set: `${group}/${name}` in st.secrets,
    }));
    const configured = credentials.every((c) => c.set) && (adapter(b.kind)?.available ?? false);
    return {
      ...b,
      credentials,
      sharesCredentialsWith: group === b.id ? null : group,
      status: !st.enabled[b.id] ? 'disconnected' : configured ? 'connected' : 'not_configured',
    };
  };
  const save = (b: ChannelBindingView): ChannelBindingView => {
    const v = view(b);
    st.bindings = st.bindings.some((x) => x.id === b.id)
      ? st.bindings.map((x) => (x.id === b.id ? v : x))
      : [...st.bindings, v];
    return { ...v };
  };
  const trigger = (tid: string) => {
    const t = st.triggers.find((x) => x.id === tid);
    if (!t) throw notFound('trigger not found');
    return t;
  };
  const triggerOut = (t: TriggerView): TriggerView => ({
    ...t,
    subscription:
      t.kind === 'mcp_event'
        ? ({ ...st.subscriptions.find((s) => s.triggerId === t.id) } as McpSubscriptionView)
        : null,
  });
  const saveTrigger = (t: TriggerView): TriggerView => {
    st.triggers = st.triggers.some((x) => x.id === t.id)
      ? st.triggers.map((x) => (x.id === t.id ? t : x))
      : [...st.triggers, t];
    return triggerOut(t);
  };
  const checkMcp = (serverId: string, event: string) => {
    const server = st.mcpServers.find((s) => s.id === serverId);
    if (!server) throw fieldError('serverId', 'no such MCP server');
    const source = st.sources.find((s) => s.serverId === serverId);
    if (source && !source.events.some((e) => e.name === event))
      throw err(400, 'validation', `${server.name} does not offer the event ${event}`, {
        field: 'event',
      });
  };
  const defaultTitle = (kind: TriggerView['kind'], instructions: string) => {
    const label: Record<TriggerView['kind'], string> = {
      webhook: 'Webhook',
      connector_event: 'Channel watch',
      mcp_event: 'MCP event',
      fs_change: 'File change',
      email: 'Email',
    };
    return `${label[kind]}: ${instructions.split('\n')[0]!.trim()}`.slice(0, 200);
  };
  const createTriggerImpl = (req: CreateTriggerRequest): TriggerView => {
    const tid = id('tr');
    let sourceRef: string | null = null;
    const config: Record<string, unknown> = {};
    switch (req.kind) {
      case 'webhook':
        break;
      case 'connector_event': {
        const b = st.bindings.find((x) => x.id === req.bindingId);
        if (!b) throw fieldError('bindingId', 'no such channel binding');
        if (b.kind !== 'slack')
          throw fieldError('bindingId', 'only Slack conversations can be watched for now');
        sourceRef = b.id;
        config.conversation = req.conversation ?? b.externalRef;
        if (req.contains) config.contains = req.contains;
        break;
      }
      case 'mcp_event':
        checkMcp(req.serverId, req.event);
        config.serverId = req.serverId;
        config.event = req.event;
        break;
      case 'fs_change':
        sourceRef = req.deviceId;
        config.path = req.path;
        break;
      case 'email':
        config.mailbox = req.mailbox;
        config.label = req.label;
        break;
    }
    if (req.projectId && !st.projectIds.includes(req.projectId))
      throw fieldError('projectId', 'no such project');
    if (req.kind === 'webhook') {
      st.secrets[`trigger/${tid}/token`] = req.credentials.token;
      st.secrets[`trigger/${tid}/secret`] = req.credentials.secret;
    }
    const at = ts();
    const t = triggerView({
      id: tid,
      kind: req.kind,
      title: req.title ?? defaultTitle(req.kind, req.instructions),
      action: req.action,
      agentId: req.agentId ?? null,
      projectId: req.projectId ?? null,
      instructions: req.instructions,
      autonomy: req.autonomy ?? 'standard',
      enabled: req.enabled !== false,
      sourceRef,
      config,
      dedupeKey: req.kind === 'webhook' ? (req.dedupeKey ?? null) : null,
      createdAt: at,
      updatedAt: at,
    });
    if (req.kind === 'mcp_event') {
      const connected = st.sources.some((s) => s.serverId === req.serverId);
      const sub = subscriptionView({
        id: id('sub'),
        triggerId: tid,
        serverId: req.serverId,
        event: req.event,
        filter: req.filter ?? null,
        status: connected ? 'active' : 'pending',
        expiresAt: connected ? '2026-10-03T09:00:00.000Z' : null,
        refreshBefore: connected ? '2026-10-03T03:00:00.000Z' : null,
        lastError: connected ? null : 'the MCP server is not connected',
        createdAt: at,
        updatedAt: at,
      });
      st.subscriptions = [...st.subscriptions, sub];
      t.sourceRef = sub.id;
    }
    return saveTrigger(t);
  };
  const rule = (category: NotificationKind) =>
    st.rules.find((r) => r.category === category) ?? ruleView(category);

  return {
    // ---- bindings ------------------------------------------------------------------------------
    listChannels: async (q = {}) => {
      maybeFail('listChannels');
      return {
        items: st.bindings
          .filter((b) => !q.agentId || b.agentId === q.agentId)
          .map((b) => ({ ...view(b) })),
        adapters: st.adapters.map((a) => ({ ...a })),
      };
    },
    createChannel: async (body) => {
      maybeFail('createChannel');
      const req: CreateChannelBindingRequest = parse(createChannelBindingSchema, body);
      if (req.kind === 'email') throw err(400, 'capability_missing', EMAIL_UNAVAILABLE);
      const a = adapter(req.kind);
      if (!a) throw err(400, 'capability_missing', `${req.kind} channels are not set up`);
      const bid = id('ch');
      const audience = req.kind === 'inapp' ? 'private' : (req.audience ?? 'shared');
      const externalRef =
        req.externalRef ?? (req.kind === 'inapp' ? `agent:${req.agentId ?? 'default'}` : '');
      let group: string | null = null;
      let credentials: Record<string, string> = {};
      if (req.kind === 'slack' || req.kind === 'teams') {
        if (req.shareCredentialsWith) {
          if (req.credentials)
            throw fieldError('credentials', 'give credentials or shareCredentialsWith, not both');
          const other = binding(req.shareCredentialsWith);
          if (other.kind !== req.kind)
            throw fieldError('shareCredentialsWith', `that binding is not a ${req.kind} binding`);
          group = st.groups[other.id] ?? other.id;
        } else if (req.credentials) {
          group = bid;
          credentials = { ...req.credentials };
        } else throw fieldError('credentials', `a ${req.kind} binding needs credentials`);
      } else if (req.kind === 'webhook') {
        group = bid;
        credentials = { ...req.credentials };
      }
      const config: Record<string, string | null> = {};
      if ('config' in req && req.config)
        for (const [k, v] of Object.entries(req.config)) if (typeof v === 'string') config[k] = v;
      if (req.kind === 'teams' && !config.appId) {
        const sibling = st.bindings.find((x) => group && st.groups[x.id] === group);
        const appId = sibling?.config.appId ?? null;
        if (!appId) throw fieldError('config.appId', 'a Teams binding needs the app id');
        config.appId = appId;
      }
      if (
        req.kind === 'webhook' &&
        config.callbackUrl &&
        !config.callbackUrl.startsWith('https://')
      )
        throw fieldError('config.callbackUrl', 'the URL must use https');
      if (
        group &&
        st.bindings.some(
          (x) => x.kind === req.kind && st.groups[x.id] === group && x.externalRef === externalRef,
        )
      )
        throw err(409, 'conflict', 'this conversation is already bound', { field: 'externalRef' });
      for (const [name, value] of Object.entries(credentials))
        st.secrets[`${group}/${name}`] = value;
      if (group) st.groups[bid] = group;
      st.enabled[bid] = req.enabled !== false;
      const at = ts();
      const kindLabel: Record<ChannelBindingKind, string> = {
        inapp: 'Nova',
        slack: 'Slack',
        teams: 'Microsoft Teams',
        email: 'email',
        webhook: 'a webhook',
      };
      return save(
        bindingView({
          id: bid,
          agentId: req.agentId ?? null,
          kind: req.kind,
          label:
            req.label ??
            (req.kind === 'inapp' ? 'In-app' : `${kindLabel[req.kind]} ${externalRef}`),
          externalRef,
          audience,
          sharePrimaryThread: !!req.sharePrimaryThread,
          allowUnknown: !!req.allowUnknown,
          rateLimit: {
            perMinute: req.rateLimit?.perMinute ?? 10,
            perHour: req.rateLimit?.perHour ?? 120,
          },
          config,
          createdAt: at,
          updatedAt: at,
        }),
      );
    },
    getChannel: async (bid) => {
      maybeFail('getChannel');
      return { ...view(binding(bid)) };
    },
    updateChannel: async (bid, body) => {
      maybeFail('updateChannel');
      const patch = parse(updateChannelBindingSchema, body);
      const b = binding(bid);
      const audience = patch.audience ?? b.audience;
      const share = patch.sharePrimaryThread ?? (audience === 'private' && b.sharePrimaryThread);
      if (share && audience !== 'private')
        throw fieldError(
          'sharePrimaryThread',
          'only a private binding can share the primary thread',
        );
      if (b.kind === 'inapp' && audience !== 'private')
        throw fieldError('audience', 'the in-app channel is private');
      const config = { ...b.config };
      if (patch.config)
        for (const [k, v] of Object.entries(patch.config)) {
          if (!(CONFIG_KEYS[b.kind] ?? []).includes(k))
            throw fieldError(`config.${k}`, `unknown setting ${k}`);
          if (k === 'callbackUrl' && v && !v.startsWith('https://'))
            throw fieldError('config.callbackUrl', 'the URL must use https');
          if (v === null) delete config[k];
          else config[k] = v;
        }
      if (patch.credentials) {
        const names = CREDENTIAL_NAMES[b.kind] ?? [];
        if (!names.length) throw fieldError('credentials', 'this binding has no credentials');
        for (const name of Object.keys(patch.credentials))
          if (!names.includes(name))
            throw fieldError(`credentials.${name}`, `unknown credential ${name}`);
        const group = st.groups[b.id] ?? b.id;
        for (const [name, value] of Object.entries(patch.credentials))
          st.secrets[`${group}/${name}`] = value;
      }
      return save({
        ...b,
        label: patch.label ?? b.label,
        audience,
        sharePrimaryThread: share,
        allowUnknown: patch.allowUnknown ?? b.allowUnknown,
        rateLimit: patch.rateLimit ?? b.rateLimit,
        config,
        updatedAt: ts(),
      });
    },
    deleteChannel: async (bid) => {
      maybeFail('deleteChannel');
      const b = binding(bid);
      st.bindings = st.bindings.filter((x) => x.id !== bid);
      const group = st.groups[b.id];
      delete st.groups[b.id];
      // Secrets go with the last binding that uses them.
      if (group && !Object.values(st.groups).includes(group))
        for (const k of Object.keys(st.secrets))
          if (k.startsWith(`${group}/`)) delete st.secrets[k];
      return { ok: true };
    },
    connectChannel: async (bid) => {
      maybeFail('connectChannel');
      const b = binding(bid);
      st.enabled[bid] = true;
      return save({ ...b, statusDetail: null, updatedAt: ts() });
    },
    disconnectChannel: async (bid) => {
      maybeFail('disconnectChannel');
      const b = binding(bid);
      st.enabled[bid] = false;
      return save({ ...b, updatedAt: ts() });
    },
    testChannel: async (bid, body = {}) => {
      maybeFail('testChannel');
      const { text } = parse(channelTestSchema, body);
      const b = binding(bid);
      if (!st.enabled[bid]) throw err(409, 'conflict', 'the channel is disconnected');
      if (b.kind === 'email') throw err(400, 'capability_missing', EMAIL_UNAVAILABLE);
      st.sent = [
        ...st.sent,
        { bindingId: bid, text: text ?? 'Nova is connected to this conversation.' },
      ];
      return { receipt: { id: `${b.kind}:${id('msg')}`, at: ts() } };
    },
    listChannelIdentities: async () => {
      maybeFail('listChannelIdentities');
      return {
        items: [...st.identities]
          .sort((a, b) => a.kind.localeCompare(b.kind) || a.externalId.localeCompare(b.externalId))
          .map((i) => ({ ...i })),
      };
    },
    addChannelIdentity: async (body) => {
      maybeFail('addChannelIdentity');
      const req = parse(channelIdentitySchema, body);
      const existing = st.identities.find(
        (i) => i.kind === req.kind && i.externalId === req.externalId,
      );
      const next: ChannelIdentityView = existing
        ? { ...existing, displayName: req.displayName ?? null, role: req.role }
        : identityView({
            id: id('ci'),
            kind: req.kind,
            externalId: req.externalId,
            displayName: req.displayName ?? null,
            role: req.role,
            createdAt: ts(),
          });
      st.identities = existing
        ? st.identities.map((i) => (i.id === existing.id ? next : i))
        : [...st.identities, next];
      return { ...next };
    },
    removeChannelIdentity: async (iid) => {
      maybeFail('removeChannelIdentity');
      if (!st.identities.some((i) => i.id === iid)) throw notFound('identity not found');
      st.identities = st.identities.filter((i) => i.id !== iid);
      return { ok: true };
    },
    listChannelAgents: async () => {
      maybeFail('listChannelAgents');
      if (!st.agentsAvailable) throw notFound();
      return { items: st.agents.map((a) => ({ ...a })) };
    },

    // ---- triggers ------------------------------------------------------------------------------
    listTriggers: async () => {
      maybeFail('listTriggers');
      return { items: st.triggers.map(triggerOut) };
    },
    createTrigger: async (body) => {
      maybeFail('createTrigger');
      return createTriggerImpl(parse(createTriggerSchema, body));
    },
    getTrigger: async (tid) => {
      maybeFail('getTrigger');
      return triggerOut(trigger(tid));
    },
    updateTrigger: async (tid, body) => {
      maybeFail('updateTrigger');
      const patch = parse(updateTriggerSchema, body);
      const t = trigger(tid);
      if (patch.credentials) {
        if (t.kind !== 'webhook')
          throw fieldError('credentials', 'only webhook triggers have credentials');
        st.secrets[`trigger/${tid}/token`] = patch.credentials.token;
        st.secrets[`trigger/${tid}/secret`] = patch.credentials.secret;
      }
      const config = { ...t.config };
      if (patch.contains !== undefined) {
        if (t.kind !== 'connector_event')
          throw fieldError('contains', 'only channel watches have a text filter');
        if (patch.contains === null) delete config.contains;
        else config.contains = patch.contains;
      }
      if (patch.dedupeKey !== undefined && t.kind !== 'webhook')
        throw fieldError('dedupeKey', 'only webhook triggers name their dedupe field');
      return saveTrigger({
        ...t,
        title: patch.title ?? t.title,
        instructions: patch.instructions ?? t.instructions,
        enabled: patch.enabled ?? t.enabled,
        autonomy: patch.autonomy ?? t.autonomy,
        dedupeKey: patch.dedupeKey === undefined ? t.dedupeKey : patch.dedupeKey,
        config,
        updatedAt: ts(),
      });
    },
    deleteTrigger: async (tid) => {
      maybeFail('deleteTrigger');
      trigger(tid);
      st.triggers = st.triggers.filter((x) => x.id !== tid);
      st.subscriptions = st.subscriptions.filter((s) => s.triggerId !== tid);
      st.triggerEvents = st.triggerEvents.filter((e) => e.triggerId !== tid);
      for (const k of Object.keys(st.secrets))
        if (k.startsWith(`trigger/${tid}/`)) delete st.secrets[k];
      return { ok: true };
    },
    listTriggerEvents: async (tid, limit = 50) => {
      maybeFail('listTriggerEvents');
      trigger(tid);
      return {
        items: st.triggerEvents
          .filter((e) => e.triggerId === tid)
          .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
          .slice(0, limit)
          .map((e) => ({ ...e })),
      };
    },

    // ---- MCP subscriptions ---------------------------------------------------------------------
    listMcpSubscriptions: async () => {
      maybeFail('listMcpSubscriptions');
      return { items: st.subscriptions.map((s) => ({ ...s })) };
    },
    createMcpSubscription: async (body) => {
      maybeFail('createMcpSubscription');
      const req = parse(createMcpSubscriptionSchema, body);
      const t = createTriggerImpl({ ...req, kind: 'mcp_event' });
      return { ...st.subscriptions.find((s) => s.triggerId === t.id)! };
    },
    getMcpSubscription: async (sid) => {
      maybeFail('getMcpSubscription');
      const s = st.subscriptions.find((x) => x.id === sid);
      if (!s) throw notFound('subscription not found');
      return { ...s };
    },
    deleteMcpSubscription: async (sid) => {
      maybeFail('deleteMcpSubscription');
      const s = st.subscriptions.find((x) => x.id === sid);
      if (!s) throw notFound('subscription not found');
      if (s.status !== 'removed') {
        const next: McpSubscriptionView = { ...s, status: 'removed', lastError: null };
        st.subscriptions = st.subscriptions.map((x) => (x.id === sid ? next : x));
        st.triggers = st.triggers.map((t) =>
          t.id === s.triggerId ? { ...t, enabled: false, updatedAt: ts() } : t,
        );
      }
      return { ...st.subscriptions.find((x) => x.id === sid)! };
    },
    listMcpEventSources: async () => {
      maybeFail('listMcpEventSources');
      return {
        items: st.sources.map((s) => ({ ...s, events: s.events.map((e) => ({ ...e })) })),
      };
    },

    // ---- routing ---------------------------------------------------------------------------------
    listNotificationRules: async () => {
      maybeFail('listNotificationRules');
      return {
        items: NOTIFICATION_KINDS.map((k) => ({ ...rule(k) })),
        quietHours: { ...st.quietHours },
      };
    },
    setNotificationRule: async (category, body) => {
      maybeFail('setNotificationRule');
      if (!(NOTIFICATION_KINDS as readonly string[]).includes(category)) throw notFound();
      const req = parse(notificationRuleSchema, body);
      const channels = [...new Set(req.channels)];
      channels.forEach((cid, i) => {
        const b = st.bindings.find((x) => x.id === cid);
        if (!b || !ROUTABLE.has(b.kind))
          throw fieldError(`channels.${i}`, 'notifications go to Slack, Teams or webhook channels');
      });
      const next = ruleView(category, {
        inapp: req.inapp,
        os: req.os,
        channels,
        bypassQuietHours: req.bypassQuietHours,
        isDefault: false,
        updatedAt: ts(),
      });
      st.rules = [...st.rules.filter((r) => r.category !== category), next];
      return { ...next };
    },
    resetNotificationRule: async (category) => {
      maybeFail('resetNotificationRule');
      st.rules = st.rules.filter((r) => r.category !== category);
      return { ...rule(category) };
    },
    getQuietHours: async () => {
      maybeFail('getQuietHours');
      return { ...st.quietHours };
    },
    setQuietHours: async (body) => {
      maybeFail('setQuietHours');
      const req = parse(quietHoursSchema, body);
      if (!validZone(req.timezone))
        throw fieldError('timezone', `unknown time zone ${req.timezone}`);
      st.quietHours = {
        ...st.quietHours,
        enabled: req.enabled,
        start: req.start,
        end: req.end,
        timezone: req.timezone,
        days: [...new Set(req.days ?? [0, 1, 2, 3, 4, 5, 6])].sort((a, b) => a - b),
        active: false,
        until: null,
      };
      return { ...st.quietHours };
    },
  };
}

// ---- test helpers -----------------------------------------------------------------------------

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 0, clock++)).toISOString();

export type ChannelsMocks = ChannelsApi &
  Record<keyof ChannelsApi, Mock<(...args: never[]) => unknown>>;

/** A standalone fake: every method a spy over the in-memory implementation. */
export function createChannelsHub(init: Partial<M6ChannelsState> = {}) {
  const state = m6ChannelsState(init);
  const failNext: Partial<Record<keyof ChannelsApi, Error>> = {};
  const impl = m6ChannelsImpl(state, {
    id: nextId,
    ts: nextTs,
    maybeFail: (name) => {
      const e = failNext[name];
      if (e) {
        delete failNext[name];
        throw e;
      }
    },
  });
  const api = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as ChannelsMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` inside the providers the channels views need, with the main fake Hub's client and
 * the channels part spread over it (what `createApi` will do).
 */
export async function renderWithChannels(
  ui: ReactNode,
  opts: {
    channels?: Partial<M6ChannelsState>;
    settings?: Record<string, unknown>;
    /** Values set by managed policy (locked). */
    managed?: Record<string, unknown>;
    /** Pending and past server requests (share asks). */
    requests?: ServerRequestView[];
    projects?: ProjectView[];
    /** Calls that fail once, from the first render on. */
    fail?: Partial<Record<keyof ChannelsApi, Error>>;
  } = {},
) {
  const hub = createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  hub.state.m5work.requests = [...(opts.requests ?? [])];
  if (opts.projects) hub.state.workspace.projects = [...opts.projects];
  const channels = createChannelsHub({
    projectIds: (opts.projects ?? []).map((p) => p.id),
    ...opts.channels,
  });
  Object.assign(channels.failNext, opts.fail);
  // GET /mcp/servers names the account's servers, connected or not (only id and name are read).
  hub.state.m3.mcpServers = channels.state.mcpServers.map(
    (s) => ({ ...s }) as unknown as McpServerView,
  );
  const api = { ...hub.api, ...channels.api };
  const { settings } = await hub.api.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, { children: ui }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { hub, channels, api: channels.api, state: channels.state, ...utils };
}
