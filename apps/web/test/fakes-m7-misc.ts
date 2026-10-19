// secret-scan: fake-file (fixture tokens, passwords and key headers only)
// The fake Hub's M7 parts for web agent W5, in memory, with the Hub's rules:
// - Channels (apps/hub/src/channels.ts, packages/core/src/channels/service.ts): bindings may be
//   Telegram or email (the M7 schema, 400 `validation` with the field); Telegram bindings get the
//   Hub-made `webhookSecret` and an inbound address only in webhook mode; email needs its mailbox
//   (address, imapHost, smtpHost; 400 with field `config`) and TLS except to loopback; both share
//   a bot's or mailbox's credentials and settings with `shareCredentialsWith`. Credential names
//   and setting keys are checked per kind (email's include `authservId`); `senderCheck: none` needs
//   `confirmSenderCheckNone: true` on create, or on update when it turns the check off (else 400
//   with reason `confirm_required`). Telegram's Hub-made `webhookSecret` is refused on
//   create (the strict schema) and update (400 on `credentials.webhookSecret`). The message log
//   is newest first and pages with an opaque cursor of (time, id) answered as `nextCursor` (a
//   forged one is 400; `before`, strictly older, still works, but not with `cursor`: 400); at
//   most 500 a page. Notification rules may name Telegram and email bindings. A test
//   notification answers where the rule sends it now (quiet hours included), or 400
//   `capability_missing` without a notifier. A schedule's webhook secret is rotated and answered
//   once (404 unknown schedule, 409 `conflict` without a webhook target).
// - Browser (apps/hub/src/browser.ts, packages/core/src/browser/sites.ts): a site's level per
//   project or agent needs an allowed site (404, 400 for a blocked one) and a known project or
//   agent (404); removing one that is not set is 404. Console and network capture answer 404
//   without an open browser, and the newest `limit` (1..300) entries, newest last.
// - Devices (apps/hub/src/device-trust.ts): the certificate summary, newest first, with the
//   requirement read from `devices.tls.allowWithoutCertificate` and the Hub's problem sentences.
// - Relay (apps/hub/src/relay.ts): the registration token is checked with the shared schema (400),
//   kept here and never answered; GET/PATCH /relay say whether one is set.
// - The desktop shell (apps/desktop: preload/hub.js, routes.ts, shortcuts.ts): `window.novaShell`
//   opens app routes only, and remaps global shortcuts with the shell's accelerator rules (a
//   modifier other than Shift; a key another app holds is a conflict, one used twice a duplicate).
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m7misc: M7MiscState`, `createHub`
// defaults it to `m7MiscState()`, and `impl` spreads, after the M6 channels, M6 browser and M6.5
// network parts, `...m7MiscImpl(state.m7misc, { m6channels: state.m6channels, m6browser:
// state.m6browser, m65network: state.m65network, id, ts: () => ts(), maybeFail, setting: (k) =>
// resolveSetting(k, layers()).value })`. Until then tests use the `render*M7` helpers below.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import type { z } from 'zod';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  CHANNEL_MESSAGE_STATUSES,
  NOTIFICATION_KINDS,
  SHELL_SHORTCUT_ACTIONS,
  channelIdentityM7Schema,
  createChannelBindingM7Schema,
  notificationRuleSchema,
  relayRegistrationTokenSchema,
  resolveSetting,
  updateChannelBindingSchema,
  type BrowserCaptureView,
  type BrowserConsoleEntryView,
  type BrowserNetworkEntryView,
  type BrowserSiteScopedLevelView,
  type ChannelBindingViewM7,
  type ChannelIdentityViewM7,
  type ChannelKindM7,
  type ChannelMessageView,
  type DeviceTlsView,
  type NotificationKind,
  type SettingKey,
  type SettingValue,
  type ShellShortcutAction,
  type ShellShortcutView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { BrowserM7Api } from '../src/browser/api-m7.ts';
import type { ChannelsApi } from '../src/channels/api.ts';
import type { ChannelsM7Api } from '../src/channels/api-m7.ts';
import type { DeviceTlsApi } from '../src/devices/api-m7.ts';
import type { RelayTokenApi } from '../src/netsurface/api-m7.ts';
import type { ShellBridge } from '../src/shellbridge/bridge.ts';
import type { NetworkSurfaceApi } from '../src/netsurface/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { agentView } from './fakes-m6-agents.ts';
import { project } from './fakes-workspace.ts';
import {
  createBrowserHub,
  type BrowserScreenApi,
  type M6BrowserState,
} from './fakes-m6-browser.ts';
import {
  DEFAULT_ADAPTERS,
  bindingView,
  createChannelsHub,
  m6ChannelsImpl,
  ruleView,
  type M6ChannelsState,
} from './fakes-m6-channels.ts';
import { createDevicesHub, type M6DevicesState } from './fakes-m6-devices.ts';
import { createAddDeviceHub, type M65DevicesState } from './fakes-m65-devices.ts';
import { createNetworkHub, m65NetworkImpl, type M65NetworkState } from './fakes-m65-network.ts';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;

// ---- builders ----------------------------------------------------------------------------------

export function messageView(over: Partial<ChannelMessageView> = {}): ChannelMessageView {
  return {
    id: `cm${(++n).toString().padStart(4, '0')}`,
    bindingId: 'b1',
    direction: 'in',
    externalId: `ext${n}`,
    conversation: 'C0OPS',
    threadRef: null,
    sender: 'U0SAM',
    threadId: 't-ops',
    turnId: null,
    status: 'started',
    reason: null,
    createdAt: T0,
    ...over,
  };
}

/**
 * A binding of any M7 kind, typed for the M6 channels state it is seeded into: credentials follow
 * the kind (all set unless given) and Telegram has an inbound address only in webhook mode.
 */
export function bindingM7(
  over: Partial<ChannelBindingViewM7> = {},
): M6ChannelsState['bindings'][number] {
  const kind = over.kind ?? 'telegram';
  const id = over.id ?? `ch${++n}`;
  const config = over.config ?? {};
  const inbound =
    kind === 'slack' ||
    kind === 'teams' ||
    kind === 'webhook' ||
    (kind === 'telegram' && config.mode === 'webhook');
  const v: ChannelBindingViewM7 = {
    ...(bindingView({ id }) as unknown as ChannelBindingViewM7),
    kind,
    label:
      kind === 'telegram'
        ? 'Telegram family'
        : kind === 'email'
          ? 'Email with Sam'
          : `${kind} ${id}`,
    externalRef:
      kind === 'telegram' ? '-1001234567890' : kind === 'email' ? 'sam@example.com' : 'C0X',
    credentials: (CREDENTIAL_NAMES[kind] ?? []).map((name) => ({ name, set: true })),
    inboundPath: inbound ? `/api/v1/channels/${id}/inbound` : null,
    ...over,
    config,
  };
  return v as unknown as M6ChannelsState['bindings'][number];
}

export function consoleEntry(over: Partial<BrowserConsoleEntryView> = {}): BrowserConsoleEntryView {
  return {
    seq: ++n,
    at: T0,
    level: 'log',
    source: 'console',
    text: 'loaded',
    url: 'https://shop.example.com/app.js',
    line: 12,
    pageUrl: 'https://shop.example.com/cart',
    ...over,
  };
}

export function networkEntry(over: Partial<BrowserNetworkEntryView> = {}): BrowserNetworkEntryView {
  return {
    seq: ++n,
    at: T0,
    method: 'GET',
    url: 'https://shop.example.com/api/cart',
    resourceType: 'fetch',
    navigation: false,
    status: 200,
    statusText: 'OK',
    mimeType: 'application/json',
    size: 512,
    durationMs: 84,
    failure: null,
    blocked: false,
    requestHeaders: { accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    body: '{"items":2}',
    bodyOmitted: null,
    ...over,
  };
}

export function tlsView(over: Partial<DeviceTlsView> = {}): DeviceTlsView {
  return {
    deviceId: `dev${++n}`,
    kind: 'novad',
    name: 'Desk PC',
    certificate: 'verified',
    reason: null,
    serial: '3a4f9c0d11e2b7a8',
    lastHttpsAt: T0,
    ...over,
  };
}

// ---- state -------------------------------------------------------------------------------------

export interface M7MiscState {
  /** Channel messages of every binding (any order). */
  messages: ChannelMessageView[];
  /** A test notification needs the Hub's notifier. */
  notifier: boolean;
  /** Categories of the test notifications sent, oldest first. */
  notified: NotificationKind[];
  /** Schedules by id: whether one delivers to a webhook. */
  schedules: Record<string, { webhook: boolean }>;
  /** Signing secrets made, by schedule id (never in a view). */
  webhookSecrets: Record<string, string>;
  /** Project and agent ids a site level can be set for. */
  projects: string[];
  agents: string[];
  /** Capture buffers per computer (newest last). */
  console: Record<string, BrowserCaptureView<BrowserConsoleEntryView>>;
  network: Record<string, BrowserCaptureView<BrowserNetworkEntryView>>;
  /** Devices seen over HTTPS. */
  tls: DeviceTlsView[];
  /** The Relay registration token in the vault (null: none). */
  relayToken: string | null;
}

export function m7MiscState(init: Partial<M7MiscState> = {}): M7MiscState {
  return {
    messages: [],
    notifier: true,
    notified: [],
    schedules: {},
    webhookSecrets: {},
    projects: [],
    agents: [],
    console: {},
    network: {},
    tls: [],
    relayToken: null,
    ...init,
  };
}

/**
 * The adapters an M7 Hub offers: every kind, email and Telegram included. A function, not a
 * constant: test/fakes.ts imports this module while fakes-m6-channels is still loading.
 */
export const m7Adapters = () => [
  ...DEFAULT_ADAPTERS.map((a) =>
    a.kind === 'email' ? { kind: 'email' as const, available: true, detail: null } : { ...a },
  ),
  { kind: 'telegram' as const, available: true, detail: null },
];

const CREDENTIAL_NAMES: Partial<Record<ChannelKindM7, readonly string[]>> = {
  slack: ['botToken', 'signingSecret'],
  teams: ['appPassword'],
  webhook: ['token', 'secret'],
  telegram: ['botToken', 'webhookSecret'],
  email: ['password'],
};
const CONFIG_KEYS: Partial<Record<ChannelKindM7, readonly string[]>> = {
  slack: ['botUserId', 'teamId'],
  teams: ['appId', 'serviceUrl'],
  webhook: ['callbackUrl'],
  telegram: ['mode', 'botUserId', 'botUsername'],
  email: [
    'address',
    'username',
    'imapHost',
    'imapPort',
    'imapSecurity',
    'smtpHost',
    'smtpPort',
    'smtpSecurity',
    'folder',
    'mode',
    'senderCheck',
    'authservId',
  ],
};
const ROUTABLE = new Set<ChannelKindM7>(['slack', 'teams', 'telegram', 'email', 'webhook']);

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

const loopback = (host: string) =>
  ['localhost', '::1', '[::1]'].includes(host.toLowerCase()) || /^127(\.\d+){3}$/.test(host);

/** The Hub's refusal of an unconfirmed `senderCheck: none` (`confirm_required`). */
const senderCheckOff = () =>
  err(
    400,
    'validation',
    'turning the sender check off trusts every From address; confirm it with confirmSenderCheckNone',
    { field: 'confirmSenderCheckNone', reason: 'confirm_required' },
  );

/** The Hub's `mailboxCheck`: both servers, and TLS unless on this machine. */
function mailboxCheck(config: Record<string, string | null | undefined>): void {
  if (!config.address || !config.imapHost || !config.smtpHost)
    throw fieldError(
      'config',
      'an email binding needs its mailbox: address, imapHost and smtpHost',
    );
  for (const [what, host, sec] of [
    ['IMAP', config.imapHost, config.imapSecurity],
    ['SMTP', config.smtpHost, config.smtpSecurity],
  ] as const)
    if (sec === 'none' && !loopback(host))
      throw fieldError(
        'config',
        `${what} without TLS is only allowed on this machine; use tls or starttls`,
      );
}

// ---- implementation ----------------------------------------------------------------------------

/** Every API name this part answers (the M7 calls and the M6 ones it widens). */
export type M7MiscApi = ChannelsApi &
  ChannelsM7Api &
  BrowserM7Api &
  DeviceTlsApi &
  RelayTokenApi &
  Pick<NetworkSurfaceApi, 'getRelay' | 'updateRelay'>;

export interface M7MiscHelpers {
  m6channels: M6ChannelsState;
  m6browser: M6BrowserState;
  m65network: M65NetworkState;
  id: (p: string) => string;
  ts: () => string;
  maybeFail: (name: keyof M7MiscApi) => void;
  setting: <K extends SettingKey>(key: K) => SettingValue<K>;
}

export function m7MiscImpl(x: M7MiscState, h: M7MiscHelpers): M7MiscApi {
  const { id, ts, maybeFail, setting } = h;
  const st = h.m6channels;
  const br = h.m6browser;
  // The M6 channels and M6.5 network parts on the same state, for what M7 leaves as it was.
  const m6 = m6ChannelsImpl(st, { id, ts, maybeFail });
  const m65 = m65NetworkImpl(h.m65network, { id, ts, maybeFail: () => undefined, setting });

  // ---- channels ----
  const binding = (bid: string) => {
    const b = st.bindings.find((v) => v.id === bid) as ChannelBindingViewM7 | undefined;
    if (!b) throw notFound('channel binding not found');
    return b;
  };
  const adapter = (kind: ChannelKindM7) =>
    (st.adapters as { kind: ChannelKindM7; available: boolean }[]).find((a) => a.kind === kind);
  /** The view as the M7 Hub derives it now. */
  const view = (b: ChannelBindingViewM7): ChannelBindingViewM7 => {
    const group = st.groups[b.id] ?? b.id;
    const credentials = (CREDENTIAL_NAMES[b.kind] ?? []).map((name) => ({
      name,
      set: `${group}/${name}` in st.secrets,
    }));
    const configured = credentials.every((c) => c.set) && (adapter(b.kind)?.available ?? false);
    const inbound =
      b.kind === 'slack' ||
      b.kind === 'teams' ||
      b.kind === 'webhook' ||
      (b.kind === 'telegram' && b.config.mode === 'webhook');
    return {
      ...b,
      credentials,
      sharesCredentialsWith: group === b.id ? null : group,
      status: !st.enabled[b.id] ? 'disconnected' : configured ? 'connected' : 'not_configured',
      inboundPath: inbound ? `/api/v1/channels/${b.id}/inbound` : null,
      config: { ...b.config },
    };
  };
  const save = (b: ChannelBindingViewM7): ChannelBindingViewM7 => {
    const v = view(b);
    const list = st.bindings as unknown as ChannelBindingViewM7[];
    st.bindings = (
      list.some((x) => x.id === b.id) ? list.map((x) => (x.id === b.id ? v : x)) : [...list, v]
    ) as typeof st.bindings;
    return view(v);
  };
  const isM7Kind = (k: ChannelKindM7) => k === 'telegram' || k === 'email';

  return {
    // The M6 channel calls M7 leaves as they were (identities, triggers, routing, …).
    ...m6,
    listChannels: async (q = {}) => {
      maybeFail('listChannels');
      return {
        items: (st.bindings as unknown as ChannelBindingViewM7[])
          .filter((b) => !q.agentId || b.agentId === q.agentId)
          .map(view),
        adapters: st.adapters.map((a) => ({ ...a })),
      };
    },
    createChannel: async (body) => {
      maybeFail('createChannel');
      const req = parse(createChannelBindingM7Schema, body);
      if (req.kind !== 'telegram' && req.kind !== 'email') {
        const made = await m6.createChannel(req);
        return view(binding(made.id));
      }
      const a = adapter(req.kind);
      if (!a?.available)
        throw err(400, 'capability_missing', `${req.kind} channels are not set up`);
      const bid = id('ch');
      const externalRef = req.externalRef;
      let group: string;
      const config: Record<string, string | null> = {};
      if (req.shareCredentialsWith) {
        if (req.credentials)
          throw fieldError('credentials', 'give credentials or shareCredentialsWith, not both');
        const other = st.bindings.find((v) => v.id === req.shareCredentialsWith) as
          ChannelBindingViewM7 | undefined;
        if (!other) throw notFound('channel binding not found');
        if (other.kind !== req.kind)
          throw fieldError('shareCredentialsWith', `that binding is not a ${req.kind} binding`);
        group = st.groups[other.id] ?? other.id;
        Object.assign(config, other.config);
      } else if (req.credentials) {
        group = bid;
        if (req.kind === 'telegram') {
          st.secrets[`${group}/botToken`] = req.credentials.botToken;
          st.secrets[`${group}/webhookSecret`] = 'hub-made-webhook-secret';
        } else st.secrets[`${group}/password`] = req.credentials.password;
      } else
        throw fieldError(
          'credentials',
          `a ${req.kind === 'telegram' ? 'Telegram' : 'email'} binding needs credentials`,
        );
      if (req.config)
        for (const [k, v] of Object.entries(req.config)) if (typeof v === 'string') config[k] = v;
      if (req.kind === 'email') {
        mailboxCheck(config);
        if (config.senderCheck === 'none' && !req.confirmSenderCheckNone) throw senderCheckOff();
      }
      if (
        st.bindings.some(
          (v) =>
            (v.kind as ChannelKindM7) === req.kind &&
            st.groups[v.id] === group &&
            v.externalRef === externalRef,
        )
      )
        throw err(409, 'conflict', 'this conversation is already bound', { field: 'externalRef' });
      st.groups[bid] = group;
      st.enabled[bid] = req.enabled !== false;
      const at = ts();
      const audience = req.audience ?? 'shared';
      return save({
        ...(bindingView({ id: bid }) as unknown as ChannelBindingViewM7),
        kind: req.kind,
        agentId: req.agentId ?? null,
        label: req.label ?? `${req.kind === 'telegram' ? 'Telegram' : 'email'} ${externalRef}`,
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
      });
    },
    getChannel: async (bid) => {
      maybeFail('getChannel');
      return view(binding(bid));
    },
    updateChannel: async (bid, body) => {
      maybeFail('updateChannel');
      const b = binding(bid);
      if (!isM7Kind(b.kind)) {
        await m6.updateChannel(bid, body);
        return view(binding(bid));
      }
      // `confirmSenderCheckNone` rides along with the M6 fields (turning email's check off).
      const { confirmSenderCheckNone, ...rest } = body;
      const patch = parse(updateChannelBindingSchema, rest);
      const audience = patch.audience ?? b.audience;
      const share = patch.sharePrimaryThread ?? (audience === 'private' && b.sharePrimaryThread);
      if (share && audience !== 'private')
        throw fieldError(
          'sharePrimaryThread',
          'only a private binding can share the primary thread',
        );
      const config = { ...b.config };
      if (patch.config) {
        for (const [k, v] of Object.entries(patch.config)) {
          if (!(CONFIG_KEYS[b.kind] ?? []).includes(k))
            throw fieldError(`config.${k}`, `unknown setting ${k}`);
          if (v === null) delete config[k];
          else config[k] = v;
        }
        if (b.kind === 'email') mailboxCheck(config);
      }
      if (
        b.kind === 'email' &&
        config.senderCheck === 'none' &&
        b.config.senderCheck !== 'none' &&
        confirmSenderCheckNone !== true
      )
        throw senderCheckOff();
      if (patch.credentials) {
        const names = CREDENTIAL_NAMES[b.kind] ?? [];
        for (const name of Object.keys(patch.credentials)) {
          if (!names.includes(name))
            throw fieldError(`credentials.${name}`, `unknown credential ${name}`);
          if (b.kind === 'telegram' && name === 'webhookSecret')
            throw fieldError(`credentials.${name}`, `the Hub makes the ${name} itself`);
        }
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
      const b = binding(bid);
      if (!isM7Kind(b.kind)) return m6.testChannel(bid, body);
      if (!st.enabled[bid]) throw err(409, 'conflict', 'the channel is disconnected');
      const text = body.text ?? 'Nova is connected to this conversation.';
      st.sent = [...st.sent, { bindingId: bid, text }];
      return { receipt: { id: `${b.kind}:${id('msg')}`, at: ts() } };
    },
    addChannelIdentity: async (body) => {
      maybeFail('addChannelIdentity');
      const req = parse(channelIdentityM7Schema, body);
      const externalId =
        req.kind === 'email' ? req.externalId.trim().toLowerCase() : req.externalId.trim();
      const list = st.identities as unknown as ChannelIdentityViewM7[];
      const prev = list.find((i) => i.kind === req.kind && i.externalId === externalId);
      const v: ChannelIdentityViewM7 = {
        id: prev?.id ?? id('ci'),
        kind: req.kind,
        externalId,
        displayName: req.displayName ?? prev?.displayName ?? null,
        role: req.role,
        createdAt: prev?.createdAt ?? ts(),
      };
      st.identities = [...list.filter((i) => i.id !== v.id), v] as typeof st.identities;
      return { ...v };
    },
    setNotificationRule: async (category, body) => {
      maybeFail('setNotificationRule');
      if (!(NOTIFICATION_KINDS as readonly string[]).includes(category)) throw notFound();
      const req = parse(notificationRuleSchema, body);
      const channels = [...new Set(req.channels)];
      channels.forEach((cid, i) => {
        const b = st.bindings.find((v) => v.id === cid);
        if (!b || !ROUTABLE.has(b.kind))
          throw fieldError(
            `channels.${i}`,
            'notifications go to Slack, Teams, Telegram, email or webhook channels',
          );
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

    // ---- channels: M7 calls ----
    listChannelMessages: async (bid, q = {}) => {
      maybeFail('listChannelMessages');
      binding(bid);
      const query = q as typeof q & { before?: string };
      const limit = q.limit ?? 100;
      if (limit < 1 || limit > 500) throw fieldError('limit', 'limit must be 1 to 500');
      if (q.status && !(CHANNEL_MESSAGE_STATUSES as readonly string[]).includes(q.status))
        throw fieldError('status', 'unknown status');
      if (query.before && q.cursor) throw fieldError('cursor', 'give cursor or before, not both');
      const before = query.before ? Date.parse(query.before) : null;
      if (before !== null && Number.isNaN(before)) throw fieldError('before', 'not a date');
      let after: [string, string] | null = null;
      if (q.cursor) {
        try {
          const v = JSON.parse(atob(q.cursor)) as unknown;
          if (!Array.isArray(v) || v.length !== 2 || !v.every((e) => typeof e === 'string'))
            throw new Error('shape');
          after = [v[0] as string, v[1] as string];
        } catch {
          throw fieldError('cursor', 'that cursor is not one the Hub made');
        }
      }
      const sorted = x.messages
        .filter(
          (m) =>
            m.bindingId === bid &&
            (!q.direction || m.direction === q.direction) &&
            (!q.status || m.status === q.status) &&
            (before === null || Date.parse(m.createdAt) < before) &&
            (!after ||
              m.createdAt < after[0] ||
              (m.createdAt === after[0] && m.id.localeCompare(after[1]) < 0)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const items = sorted.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((m) => ({ ...m })),
        nextCursor:
          sorted.length > limit && last ? btoa(JSON.stringify([last.createdAt, last.id])) : null,
      };
    },
    testNotification: async (category) => {
      maybeFail('testNotification');
      if (!(NOTIFICATION_KINDS as readonly string[]).includes(category))
        throw fieldError('category', 'unknown category');
      if (!x.notifier) throw err(400, 'capability_missing', 'notifications are not available');
      const rule = st.rules.find((r) => r.category === category) ?? ruleView(category);
      const quiet = rule.bypassQuietHours ? null : st.quietHours;
      x.notified = [...x.notified, category];
      return {
        category,
        inapp: rule.inapp,
        os: rule.os && !quiet?.active,
        channels: [...rule.channels],
        deferUntil: quiet?.active ? quiet.until : null,
      };
    },
    rotateScheduleWebhookSecret: async (sid) => {
      maybeFail('rotateScheduleWebhookSecret');
      const s = x.schedules[sid];
      if (!s) throw notFound('schedule not found');
      if (!s.webhook)
        throw err(409, 'conflict', 'this schedule delivers to no webhook', { field: 'targets' });
      const secret = `${id('whsec')}`.padEnd(64, '0');
      x.webhookSecrets[sid] = secret;
      return { scheduleId: sid, secret, scheme: 'hmac-sha256', rotatedAt: ts() };
    },

    // ---- browser: site levels per scope and capture ----
    listBrowserSiteLevels: async (q = {}) => {
      maybeFail('listBrowserSiteLevels');
      return {
        items: br.sites
          .flatMap((s) => s.scopedLevels)
          .filter(
            (l) =>
              (!q.scopeKind || l.scopeKind === q.scopeKind) &&
              (!q.scopeRef || l.scopeRef === q.scopeRef) &&
              (!q.pattern || l.pattern === q.pattern),
          )
          .map((l) => ({ ...l })),
      };
    },
    putBrowserSiteLevel: async (pattern, scopeKind, scopeRef, level) => {
      maybeFail('putBrowserSiteLevel');
      const site = br.sites.find((s) => s.pattern === pattern.trim().toLowerCase());
      if (!site) throw notFound('no such site');
      if (site.access === 'block')
        throw err(400, 'validation', 'a blocked site has no levels; allow it first');
      const known = scopeKind === 'project' ? x.projects : x.agents;
      if (!known.includes(scopeRef)) throw notFound(`no such ${scopeKind}`);
      const prev = site.scopedLevels.find(
        (l) => l.scopeKind === scopeKind && l.scopeRef === scopeRef,
      );
      const at = ts();
      const v: BrowserSiteScopedLevelView = {
        pattern: site.pattern,
        scopeKind,
        scopeRef,
        level,
        createdAt: prev?.createdAt ?? at,
        updatedAt: at,
      };
      const next = {
        ...site,
        scopedLevels: [
          ...site.scopedLevels.filter(
            (l) => !(l.scopeKind === scopeKind && l.scopeRef === scopeRef),
          ),
          v,
        ],
      };
      br.sites = br.sites.map((s) => (s.pattern === site.pattern ? next : s));
      return { ...v };
    },
    deleteBrowserSiteLevel: async (pattern, scopeKind, scopeRef) => {
      maybeFail('deleteBrowserSiteLevel');
      const site = br.sites.find((s) => s.pattern === pattern.trim().toLowerCase());
      if (!site) throw notFound('no such site');
      if (!site.scopedLevels.some((l) => l.scopeKind === scopeKind && l.scopeRef === scopeRef))
        throw notFound('no level for that site in that scope');
      const next = {
        ...site,
        scopedLevels: site.scopedLevels.filter(
          (l) => !(l.scopeKind === scopeKind && l.scopeRef === scopeRef),
        ),
      };
      br.sites = br.sites.map((s) => (s.pattern === site.pattern ? next : s));
      return { ok: true };
    },
    browserConsole: async (cid, limit = 100) => {
      maybeFail('browserConsole');
      return capture(br, x.console[cid], cid, limit);
    },
    browserNetwork: async (cid, limit = 100) => {
      maybeFail('browserNetwork');
      return capture(br, x.network[cid], cid, limit);
    },

    // ---- devices ----
    getDeviceTls: async () => {
      maybeFail('getDeviceTls');
      const items = [...x.tls].sort((a, b) => b.lastHttpsAt.localeCompare(a.lastHttpsAt));
      const missing = items.filter((v) => v.certificate === 'missing');
      const refused = items.filter((v) => v.certificate === 'refused');
      const problems: string[] = [];
      if (missing.length)
        problems.push(
          `${missing.length} device${missing.length === 1 ? '' : 's'} reach the Hub over HTTPS without a device certificate (${missing
            .map((v) => v.name ?? v.deviceId)
            .join(', ')}).`,
        );
      if (refused.length)
        problems.push(
          `${refused.length} device${refused.length === 1 ? ' was' : 's were'} refused over HTTPS: ${refused
            .map((v) => `${v.name ?? v.deviceId} (${v.reason ?? 'refused'})`)
            .join(', ')}.`,
        );
      return {
        requireCertificate: !setting('devices.tls.allowWithoutCertificate'),
        items: items.map((v) => ({ ...v })),
        problems,
      };
    },

    // ---- relay ----
    getRelay: async () => {
      maybeFail('getRelay');
      return { ...(await m65.getRelay()), registrationToken: x.relayToken !== null };
    },
    updateRelay: async (body) => {
      maybeFail('updateRelay');
      return { ...(await m65.updateRelay(body)), registrationToken: x.relayToken !== null };
    },
    setRelayRegistrationToken: async (token) => {
      maybeFail('setRelayRegistrationToken');
      const r = relayRegistrationTokenSchema.safeParse({ token });
      if (!r.success)
        throw err(400, 'validation', r.error.issues.map((i) => i.message).join('; '), {
          field: 'token',
        });
      x.relayToken = r.data.token;
      return { ...(await m65.getRelay()), registrationToken: x.relayToken !== null };
    },
  };
}

/** A capture buffer as the Hub answers it: 404 without an open browser, the newest `limit`. */
function capture<T>(
  br: M6BrowserState,
  buf: BrowserCaptureView<T> | undefined,
  cid: string,
  limit: number,
): BrowserCaptureView<T> {
  if (!br.sessions.some((s) => s.computerId === cid && s.state !== 'closed'))
    throw notFound('no open browser for that computer');
  if (!Number.isInteger(limit) || limit < 1 || limit > 300)
    throw fieldError('limit', 'limit must be 1 to 300');
  const items = buf?.items ?? [];
  return { items: items.slice(-limit).map((e) => ({ ...e })), dropped: buf?.dropped ?? 0 };
}

// ---- the desktop shell ------------------------------------------------------------------------

const MODS: Record<string, string> = {
  command: 'Command',
  cmd: 'Command',
  control: 'Control',
  ctrl: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
};
const SHELL_DEFAULTS: Record<ShellShortcutAction, string> = {
  quickChat: 'Control+Alt+N',
  attachWindow: 'Control+Alt+A',
};
const WINDOW_HEADS = new Set([
  'chat',
  'work',
  'code',
  'agents',
  'projects',
  'library',
  'spaces',
  'sites',
  'apps',
  'devices',
  'network',
  'computers',
  'approvals',
  'settings',
]);

/** The shell's accelerator check (apps/desktop/src/shortcuts.ts `parseAccelerator`), simplified. */
function parseAccelerator(
  raw: string,
): { ok: true; accelerator: string } | { ok: false; reason: string } {
  const parts = raw
    .trim()
    .split('+')
    .map((p) => p.trim());
  if (parts.length < 2 || parts.some((p) => !p))
    return { ok: false, reason: 'Use one or more modifiers and one key, like Control+Alt+N.' };
  const key = parts.at(-1) ?? '';
  if (
    !/^([A-Za-z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Return|Up|Down|Left|Right|[`\-=[\];',./])$/.test(
      key,
    )
  )
    return { ok: false, reason: `${key} is not a key the app can use.` };
  const mods: string[] = [];
  for (const m of parts.slice(0, -1)) {
    const mod = MODS[m.toLowerCase()];
    if (!mod)
      return {
        ok: false,
        reason: `${m} is not a modifier (use Control, Alt, Shift, Super or Command).`,
      };
    if (!mods.includes(mod)) mods.push(mod);
  }
  if (!mods.some((m) => m !== 'Shift'))
    return { ok: false, reason: 'A global shortcut needs Control, Alt, Super or Command.' };
  const order = ['Command', 'Control', 'Alt', 'Shift', 'Super'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { ok: true, accelerator: [...mods, key.length === 1 ? key.toUpperCase() : key].join('+') };
}

function label(accelerator: string, platform: string): string {
  const parts = accelerator.split('+');
  const key = parts.pop() ?? '';
  if (platform === 'darwin') {
    const sym: Record<string, string> = {
      Command: '⌘',
      Control: '⌃',
      Alt: '⌥',
      Shift: '⇧',
      Super: '⌘',
    };
    return `${parts.map((m) => sym[m] ?? m).join('')}${key}`;
  }
  const pc: Record<string, string> = {
    Command: 'Super',
    Control: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
    Super: 'Super',
  };
  return [...parts.map((m) => pc[m] ?? m), key].join('+');
}

export interface FakeShellState {
  platform: string;
  /** Configured accelerators: undefined keeps the default, null unbinds. */
  config: Partial<Record<ShellShortcutAction, string | null>>;
  /** Accelerators other apps hold (registering them fails). */
  taken: string[];
  /** Paths opened in windows of their own. */
  opened: string[];
  /** Calls that reject once with this message. */
  failNext: Partial<Record<'openWindow' | 'shortcuts' | 'setShortcut', string>>;
}

export type FakeShell = ShellBridge & {
  openWindow: Mock<ShellBridge['openWindow']>;
  shortcuts: Mock<ShellBridge['shortcuts']>;
  setShortcut: Mock<ShellBridge['setShortcut']>;
};

/** A `window.novaShell` with the shell's rules; `installShell` puts it on the window. */
export function fakeShell(init: Partial<FakeShellState> = {}): {
  shell: FakeShell;
  state: FakeShellState;
} {
  const state: FakeShellState = {
    platform: 'linux',
    config: {},
    taken: [],
    opened: [],
    failNext: {},
    ...init,
  };
  const fail = (name: keyof FakeShellState['failNext']) => {
    const m = state.failNext[name];
    if (m) {
      delete state.failNext[name];
      throw new Error(m);
    }
  };
  const views = (): ShellShortcutView[] => {
    const used = new Map<string, ShellShortcutAction>();
    return SHELL_SHORTCUT_ACTIONS.map((action): ShellShortcutView => {
      const raw =
        state.config[action] === undefined ? SHELL_DEFAULTS[action] : state.config[action];
      if (raw === null)
        return { action, accelerator: null, label: null, registered: false, problem: null };
      const parsed = parseAccelerator(raw);
      if (!parsed.ok)
        return { action, accelerator: raw, label: raw, registered: false, problem: 'invalid' };
      const acc = parsed.accelerator;
      const lbl = label(acc, state.platform);
      if (used.has(acc))
        return { action, accelerator: acc, label: lbl, registered: false, problem: 'duplicate' };
      if (state.taken.includes(acc))
        return { action, accelerator: acc, label: lbl, registered: false, problem: 'conflict' };
      used.set(acc, action);
      return { action, accelerator: acc, label: lbl, registered: true, problem: null };
    });
  };
  const shell = {
    version: 1 as const,
    platform: state.platform,
    openWindow: vi.fn(async (path: string) => {
      fail('openWindow');
      const head =
        path.startsWith('/') && !path.startsWith('//') ? path.slice(1).split(/[/?#]/, 1)[0] : '';
      if (!head || !WINDOW_HEADS.has(head)) return false;
      state.opened = [...state.opened, path];
      return true;
    }),
    shortcuts: vi.fn(async () => {
      fail('shortcuts');
      return views();
    }),
    setShortcut: vi.fn(async (action: ShellShortcutAction, accelerator: string | null) => {
      fail('setShortcut');
      if (!(SHELL_SHORTCUT_ACTIONS as readonly string[]).includes(action))
        throw new Error('That is not a global shortcut of the app.');
      if (accelerator !== null) {
        const parsed = parseAccelerator(accelerator);
        if (!parsed.ok) throw new Error(parsed.reason);
        state.config = { ...state.config, [action]: parsed.accelerator };
      } else state.config = { ...state.config, [action]: null };
      return views();
    }),
  } satisfies ShellBridge;
  return { shell, state };
}

/** Put a bridge on `window.novaShell` (what the desktop app's preload does). */
export function installShell(shell: unknown): void {
  (window as unknown as { novaShell?: unknown }).novaShell = shell;
}

export function uninstallShell(): void {
  delete (window as unknown as { novaShell?: unknown }).novaShell;
}

// ---- test helpers ------------------------------------------------------------------------------

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 0, clock++)).toISOString();

export type M7MiscMocks = M7MiscApi & Record<keyof M7MiscApi, Mock<(...args: never[]) => unknown>>;

function spies<T extends object>(
  impl: T,
): T & Record<keyof T, Mock<(...args: never[]) => unknown>> {
  return Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as T & Record<keyof T, Mock<(...args: never[]) => unknown>>;
}

export interface RenderM7Options {
  /** Projects and agents of the account (site levels can be set for them). */
  projects?: { id: string; name: string }[];
  agents?: { id: string; name: string }[];
  channels?: Partial<M6ChannelsState>;
  browser?: Partial<M6BrowserState>;
  network?: Partial<M65NetworkState>;
  devices?: Partial<M6DevicesState>;
  added?: Partial<M65DevicesState>;
  misc?: Partial<M7MiscState>;
  settings?: Record<string, unknown>;
  managed?: Record<string, unknown>;
  /** Calls that fail once, from the first render on. */
  fail?: Partial<Record<keyof M7MiscApi, Error>>;
  /** M6 browser calls that fail once, from the first render on. */
  browserFail?: Partial<Record<keyof BrowserScreenApi, Error>>;
}

/**
 * Render `ui` with the main fake Hub's client, the M6 channels, browser and devices parts, the
 * M6.5 network and add-device parts, and this M7 part spread over them (what `createApi` will do).
 */
export async function renderM7(ui: ReactNode, opts: RenderM7Options = {}) {
  const hub = createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  if (opts.projects) hub.state.workspace.projects = opts.projects.map((p) => project(p));
  if (opts.agents) hub.state.m6agents.agents = opts.agents.map((a) => agentView(a));
  const setting = <K extends SettingKey>(k: K): SettingValue<K> =>
    resolveSetting(k, { global: hub.state.settings, managed: hub.state.managed }).value;
  const channels = createChannelsHub({
    adapters: m7Adapters().map((a) => ({ ...a })) as unknown as M6ChannelsState['adapters'],
    ...opts.channels,
  });
  const browser = createBrowserHub(
    opts.browser,
    () => hub.state.settings,
    () => hub.state.managed,
  );
  Object.assign(browser.failNext, opts.browserFail);
  const network = createNetworkHub(opts.network, setting);
  const devices = createDevicesHub(opts.devices, {
    approvals: {
      list: () => hub.state.m3.approvals,
      add: (a) => {
        hub.state.m3.approvals = [...hub.state.m3.approvals, a];
      },
    },
  });
  const added = createAddDeviceHub(opts.added ?? {}, devices.state);
  const state = m7MiscState({
    projects: (opts.projects ?? []).map((p) => p.id),
    agents: (opts.agents ?? []).map((a) => a.id),
    ...opts.misc,
  });
  const failNext: Partial<Record<keyof M7MiscApi, Error>> = { ...opts.fail };
  const misc = spies(
    m7MiscImpl(state, {
      m6channels: channels.state,
      m6browser: browser.state,
      m65network: network.state,
      id: nextId,
      ts: nextTs,
      setting,
      maybeFail: (name) => {
        const e = failNext[name];
        if (e) {
          delete failNext[name];
          throw e;
        }
      },
    }),
  );
  const api = {
    ...hub.api,
    ...devices.api,
    ...added.api,
    ...network.api,
    ...browser.api,
    ...channels.api,
    ...misc,
  };
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
  return {
    hub,
    api: misc,
    state,
    failNext,
    channels: channels.state,
    browser: browser.state,
    browserFail: browser.failNext,
    channelsFail: channels.failNext,
    network: network.state,
    devicesState: devices.state,
    ...utils,
  };
}

/** Render `ui` with only the app's providers (no Hub calls needed), e.g. the shell's parts. */
export function renderPlain(ui: ReactNode, opts: { mac?: boolean } = {}) {
  const hub = createHub();
  const registry = testRegistry(opts.mac ?? false);
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, { children: ui }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api: hub.api,
      eventSource: fakeEventSource,
      registry,
      children: inner,
    }),
  );
  return { registry, ...utils };
}
