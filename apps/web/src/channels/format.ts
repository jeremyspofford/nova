// Plain-language text and small helpers shared by the channels, triggers and routing views
// (docs/04 §7: short, plain, no jargon). Secrets generated here never leave the browser except
// in the request that stores them; the views show them once.
import type {
  ChannelBindingKind,
  ChannelBindingView,
  McpSubscriptionStatus,
  TriggerEventView,
  TriggerKind,
} from '@nova/shared';
import type { IconName, Status } from '@nova/ui';
import { ApiError } from '../api.ts';

export const KIND_TEXT: Record<ChannelBindingKind, string> = {
  inapp: 'In-app',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  email: 'Email',
  webhook: 'Webhook',
};

export const KIND_HINT: Record<ChannelBindingKind, string> = {
  inapp: 'Message the agent from Nova itself.',
  slack: 'A Slack direct message or channel, through your Slack app.',
  teams: 'A Teams chat or channel, through your Azure bot.',
  email: 'An email address the agent reads and answers.',
  webhook: 'Any service that can send and receive signed HTTP requests.',
};

/** What a binding's conversation reference is called, per kind. */
export const REF_TEXT: Record<ChannelBindingKind, { label: string; hint: string }> = {
  inapp: { label: 'Conversation', hint: '' },
  slack: {
    label: 'Slack conversation ID',
    hint: 'The channel or direct message ID, like C0123ABCD or D0123ABCD.',
  },
  teams: {
    label: 'Teams conversation ID',
    hint: 'The conversation ID of the chat or channel the bot is in.',
  },
  email: { label: 'Email address', hint: '' },
  webhook: {
    label: 'Conversation name',
    hint: 'A name for the conversation on the other side, like support-bot.',
  },
};

export const CREDENTIAL_TEXT: Record<string, string> = {
  botToken: 'Bot token',
  signingSecret: 'Signing secret',
  appPassword: 'App password',
  token: 'Bearer token',
  secret: 'Signing secret',
};

export const CONFIG_TEXT: Record<string, { label: string; hint: string }> = {
  botUserId: { label: 'Bot user ID', hint: 'Lets Nova tell when the bot is mentioned.' },
  teamId: { label: 'Workspace ID', hint: 'The Slack workspace (team) ID.' },
  appId: { label: 'App ID', hint: 'The Microsoft app ID of your Azure bot.' },
  serviceUrl: { label: 'Service URL', hint: 'Learned from the first message; rarely needed.' },
  callbackUrl: {
    label: 'Reply URL',
    hint: 'Where replies are posted, signed with the secret. It must be a public https address.',
  },
};

/** The settings each kind keeps (no secrets), in the order they are shown. */
export const CONFIG_KEYS: Partial<Record<ChannelBindingKind, readonly string[]>> = {
  slack: ['botUserId', 'teamId'],
  teams: ['appId', 'serviceUrl'],
  webhook: ['callbackUrl'],
};

/** Where to paste the inbound address, per kind. */
export const INBOUND_HINT: Partial<Record<ChannelBindingKind, string>> = {
  slack:
    'In your Slack app, paste this as the Request URL under Event Subscriptions, and subscribe the bot to message events.',
  teams: 'In your Azure bot, paste this as the messaging endpoint.',
  webhook:
    'Post messages here as JSON {"id", "text", "from": {"id", "name"}}, with the bearer token and a signature made with the secret.',
};

export interface ChipSpec {
  text: string;
  icon: IconName | null;
  /** A runtime status tone; undefined is neutral. */
  tone?: Status;
}

export const BINDING_STATUS: Record<ChannelBindingView['status'], ChipSpec> = {
  connected: { text: 'Connected', icon: 'check', tone: 'ready' },
  disconnected: { text: 'Disconnected', icon: 'stop' },
  not_configured: { text: 'Needs setup', icon: 'alert', tone: 'needs_input' },
};

export const TRIGGER_KIND_TEXT: Record<TriggerKind, string> = {
  webhook: 'Webhook',
  connector_event: 'Channel watch',
  mcp_event: 'MCP event',
  fs_change: 'File change',
  email: 'Email label',
};

export const SUBSCRIPTION_STATUS: Record<McpSubscriptionStatus, ChipSpec> = {
  pending: { text: 'Subscribing', icon: null, tone: 'running' },
  active: { text: 'Active', icon: 'check', tone: 'ready' },
  refreshing: { text: 'Renewing', icon: null, tone: 'running' },
  lapsed: { text: 'Lapsed', icon: 'alert', tone: 'blocked' },
  failed: { text: 'Failed', icon: 'stop', tone: 'blocked' },
  removed: { text: 'Unsubscribed', icon: 'stop' },
};

export const EVENT_STATUS: Record<TriggerEventView['status'], ChipSpec> = {
  started: { text: 'Started', icon: 'check', tone: 'ready' },
  failed: { text: 'Failed', icon: 'stop', tone: 'blocked' },
  skipped: { text: 'Skipped', icon: 'alert' },
};

const EVENT_DETAIL: Record<string, string> = {
  rate_limited: 'The hourly limit for this trigger was reached.',
  disabled: 'The trigger was off.',
  received: 'Received; nothing was started yet.',
};

/** A delivery's detail in plain words; unknown details are shown as they are. */
export function eventDetail(e: TriggerEventView): string | null {
  if (!e.detail) return null;
  return EVENT_DETAIL[e.detail] ?? e.detail;
}

/** The base external services reach the Hub at: the configured public address, else this page. */
export function publicBase(configured: string | null): string {
  const base = configured ?? (typeof window === 'undefined' ? '' : window.location.origin);
  return base.replace(/\/+$/, '');
}

/** An absolute URL for a Hub path such as `/api/v1/channels/<id>/inbound`. */
export function absoluteUrl(path: string, configured: string | null): string {
  return `${publicBase(configured)}${path}`;
}

/** A random URL-safe secret of `bytes` random bytes (base64url, no padding). */
export function randomSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Copy text; false when the clipboard is not available (the caller says so). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The field an API validation error names (`details.field`), if any. */
export function errorField(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const f = err.body.details?.field;
  return typeof f === 'string' ? f : null;
}

/** First message per field from a zod-style issue list (`path` joined with dots). */
export function issueErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const key = i.path.map(String).join('.') || '_';
    out[key] ??= sentence(i.message);
  }
  return out;
}

/** "too short" → "Too short." */
export function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const head = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

/** A local date and time, like "Oct 17, 09:30". */
export function formatStamp(iso: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  return new Date(t).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
