// Plain-language text and small helpers shared by the channels, triggers and routing views
// (docs/04 §7: short, plain, no jargon). Secrets generated here never leave the browser except
// in the request that stores them; the views show them once. M7 adds Telegram and email
// (FR-110) and the channel message log.
import type {
  ChannelBindingView,
  ChannelKindM7,
  ChannelMessageStatus,
  ChannelMessageView,
  McpSubscriptionStatus,
  TriggerEventView,
  TriggerKind,
} from '@nova/shared';
import type { IconName, Status } from '@nova/ui';
import { ApiError } from '../api.ts';

export const KIND_TEXT: Record<ChannelKindM7, string> = {
  inapp: 'In-app',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  email: 'Email',
  webhook: 'Webhook',
  telegram: 'Telegram',
};

export const KIND_HINT: Record<ChannelKindM7, string> = {
  inapp: 'Message the agent from Nova itself.',
  slack: 'A Slack direct message or channel, through your Slack app.',
  teams: 'A Teams chat or channel, through your Azure bot.',
  email: 'One person (or a list) the agent writes with, through a mailbox you give it.',
  webhook: 'Any service that can send and receive signed HTTP requests.',
  telegram: 'A private chat or a group with your Telegram bot.',
};

/** What a binding's conversation reference is called, per kind. */
export const REF_TEXT: Record<ChannelKindM7, { label: string; hint: string }> = {
  inapp: { label: 'Conversation', hint: '' },
  slack: {
    label: 'Slack conversation ID',
    hint: 'The channel or direct message ID, like C0123ABCD or D0123ABCD.',
  },
  teams: {
    label: 'Teams conversation ID',
    hint: 'The conversation ID of the chat or channel the bot is in.',
  },
  email: {
    label: 'Their email address',
    hint: 'Who the agent writes with: a person, or a mailing list address.',
  },
  webhook: {
    label: 'Conversation name',
    hint: 'A name for the conversation on the other side, like support-bot.',
  },
  telegram: {
    label: 'Telegram chat ID',
    hint: 'A number: positive for a private chat, negative (like -1001234567890) for a group.',
  },
};

export const CREDENTIAL_TEXT: Record<string, string> = {
  botToken: 'Bot token',
  signingSecret: 'Signing secret',
  appPassword: 'App password',
  token: 'Bearer token',
  secret: 'Signing secret',
  webhookSecret: 'Webhook secret',
  password: 'Mailbox password',
};

/** Credentials the Hub makes itself: shown as set or not, never replaced by hand. */
export const GENERATED_CREDENTIALS: Partial<Record<ChannelKindM7, readonly string[]>> = {
  telegram: ['webhookSecret'],
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
  mode: { label: 'How messages arrive', hint: '' },
  address: { label: 'Mailbox address', hint: 'The agent’s address: replies come from it.' },
  username: { label: 'Login name', hint: 'Leave empty to sign in with the mailbox address.' },
  imapHost: { label: 'IMAP server', hint: 'Where mail is read, like imap.example.com.' },
  imapPort: { label: 'IMAP port', hint: 'Leave empty for the usual port (993 with TLS).' },
  imapSecurity: { label: 'IMAP security', hint: '' },
  smtpHost: { label: 'SMTP server', hint: 'Where replies are sent, like smtp.example.com.' },
  smtpPort: { label: 'SMTP port', hint: 'Leave empty for the usual port (465 with TLS).' },
  smtpSecurity: { label: 'SMTP security', hint: '' },
  folder: { label: 'Folder', hint: 'The folder read; leave empty for INBOX.' },
  senderCheck: { label: 'Check senders', hint: '' },
  authservId: {
    label: 'Authentication-Results name',
    hint: 'The name your mail server writes in Authentication-Results, like mx.google.com. Leave empty to use the IMAP server’s domain. Mail from big providers stays unverified until it is set.',
  },
};

/** The settings each kind keeps (no secrets), in the order they are shown. */
export const CONFIG_KEYS: Partial<Record<ChannelKindM7, readonly string[]>> = {
  slack: ['botUserId', 'teamId'],
  teams: ['appId', 'serviceUrl'],
  webhook: ['callbackUrl'],
  telegram: ['mode'],
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

/** Settings with a fixed set of values: the first option (empty value) is the Hub's default. */
export const CONFIG_CHOICES: Partial<
  Record<ChannelKindM7, Record<string, { value: string; label: string; hint?: string }[]>>
> = {
  telegram: {
    mode: [
      {
        value: '',
        label: 'Polling (default)',
        hint: 'Nova asks Telegram for new messages; works behind a router.',
      },
      {
        value: 'webhook',
        label: 'Webhook',
        hint: 'Telegram posts new messages to the public address.',
      },
    ],
  },
  email: {
    imapSecurity: [
      { value: '', label: 'TLS (default)' },
      { value: 'starttls', label: 'STARTTLS' },
      { value: 'none', label: 'None (only on this machine)' },
    ],
    smtpSecurity: [
      { value: '', label: 'TLS (default)' },
      { value: 'starttls', label: 'STARTTLS' },
      { value: 'none', label: 'None (only on this machine)' },
    ],
    mode: [
      { value: '', label: 'Stay connected (default)' },
      { value: 'polling', label: 'Check every few minutes' },
    ],
    senderCheck: [
      { value: '', label: 'Mail server vouches (default)' },
      { value: 'none', label: 'From address only' },
    ],
  },
};

/** What a choice-valued setting means, under its field. */
export const CHOICE_HINT: Record<string, string> = {
  senderCheck:
    'Who counts as a person listed under People. By default only when your mail server vouches for them (DMARC); From address only trusts whatever address a message claims, so it asks you first.',
  imapSecurity: 'Without TLS works only for a server on this machine.',
  smtpSecurity: 'Without TLS works only for a server on this machine.',
};

/** Where to paste the inbound address, per kind. */
export const INBOUND_HINT: Partial<Record<ChannelKindM7, string>> = {
  slack:
    'In your Slack app, paste this as the Request URL under Event Subscriptions, and subscribe the bot to message events.',
  teams: 'In your Azure bot, paste this as the messaging endpoint.',
  webhook:
    'Post messages here as JSON {"id", "text", "from": {"id", "name"}}, with the bearer token and a signature made with the secret.',
  telegram:
    'Nova gives this address to Telegram itself when the channel connects; there is nothing to paste.',
};

/** How approvals are answered from a channel of this kind (docs/13 §4). */
export const APPROVAL_HINT: Partial<Record<ChannelKindM7, string>> = {
  slack: 'Approvals show buttons in Slack; only people listed as owners can press them.',
  telegram: 'Approvals show buttons in Telegram; only people listed as owners can press them.',
  email:
    'Approvals are answered only with the signed, one-use link in the approval email, sent only to you. A reply to the email never answers an approval.',
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
/** What turning an email binding's sender check off means, for its confirmation. */
export const SENDER_CHECK_OFF_TEXT =
  'Anyone can then write as a person listed under People just by putting their address in From, and the agent treats them as that person, owners included. Only do this for a mail server that adds no Authentication-Results check.';

/** The Hub refused `senderCheck: none` because it was not confirmed (`confirm_required`). */
export function isConfirmRequired(err: unknown): boolean {
  return err instanceof ApiError && err.body.details?.reason === 'confirm_required';
}

/** The plain words for a `confirm_required` refusal. */
export const CONFIRM_REQUIRED_TEXT =
  'The Hub needs your confirmation before it trusts the From address. Choose “From address only” again and confirm.';

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

// ---- the message log (FR-110) ----------------------------------------------------------------

export const MESSAGE_STATUS: Record<ChannelMessageStatus, ChipSpec> = {
  started: { text: 'Started a turn', icon: 'check', tone: 'ready' },
  answered: { text: 'Answered', icon: 'check', tone: 'ready' },
  ignored: { text: 'Ignored', icon: 'slash' },
  dropped: { text: 'Dropped', icon: 'stop', tone: 'blocked' },
  sent: { text: 'Sent', icon: 'send', tone: 'ready' },
  failed: { text: 'Failed', icon: 'alert', tone: 'blocked' },
  withheld: { text: 'Held back', icon: 'shield', tone: 'needs_input' },
};

const MESSAGE_REASON: Record<string, string> = {
  received: 'Received; nothing was started yet.',
  own_message: 'Sent by Nova itself.',
  disconnected: 'The channel was disconnected.',
  unknown_sender: 'From someone not listed under People.',
  sender_unchecked:
    'Taken on its From address alone: the sender check is off for this mailbox, so the sender was not verified.',
  unverified_sender:
    'The sender claimed to be someone listed, but their mail server did not vouch for them.',
  not_owner: 'This private channel answers only you.',
  not_addressed: 'Not addressed to the agent.',
  external_agent: 'It came from another AI agent, so nothing was started.',
  rate_limited: 'Over this channel’s rate limit.',
  no_runtime: 'The Hub could not start the agent.',
  turn_failed: 'The agent’s turn failed to start.',
  handshake: 'A setup check from the service.',
  not_a_message: 'Not a message.',
  unbound_conversation: 'From a conversation this channel is not bound to.',
  denied: 'You declined to share a private detail here.',
  not_allowed: 'It would share a private detail, and the policy says never.',
  link_required: 'Approvals here are answered with the signed link only.',
  already_decided: 'The approval was already answered.',
  other_conversation: 'The approval belongs to another conversation.',
  unknown: 'No such approval.',
  unavailable: 'The approval could not be answered here.',
  rejected: 'The service refused it.',
};

/** Why a message was ignored, dropped, held back or failed, in plain words. */
export function messageReason(m: Pick<ChannelMessageView, 'reason'>): string | null {
  if (!m.reason) return null;
  return MESSAGE_REASON[m.reason] ?? sentence(m.reason.replace(/_/g, ' '));
}

/** A mail server the Hub may reach without TLS: only one on this machine (loopback). */
export function plainMailAllowed(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}
