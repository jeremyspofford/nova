// Plain-language text and small helpers shared by the channels, triggers and routing views
// (docs/04 §7: short, plain, no jargon). Secrets generated here never leave the browser except
// in the request that stores them; the views show them once. M7 adds Telegram and email
// (FR-110) and the channel message log.
import type {
  ChannelBindingView,
  ChannelKindM7,
  ChannelOAuthStatus,
  ChannelMessageFileStatus,
  ChannelMessageFileView,
  ChannelMessageStatus,
  ChannelMessageView,
  McpSubscriptionStatus,
  TriggerEventView,
  TriggerKind,
} from '@nova/shared';
import { defineMessages, fmt, getLocale, intlLocale, messageFor } from '@nova/i18n';
import type { IconName, Status } from '@nova/ui';
import { ApiError } from '../api.ts';

// The channels area's words (FR-016) are messages, read at render time so they follow the active
// locale. Channel names, conversation ids, senders and the Hub's own error text are data.

/** Words shared by the channels, triggers and routing views. */
export const CHANNEL_TEXT = defineMessages('channels', {
  /** What turning an email binding's sender check off means, for its confirmation. */
  senderCheckOff:
    'Anyone can then write as a person listed under People just by putting their address in From, and the agent treats them as that person, owners included. Only do this for a mail server that adds no Authentication-Results check.',
  /** The plain words for a `confirm_required` refusal. */
  confirmRequired:
    'The Hub needs your confirmation before it trusts the From address. Choose “From address only” again and confirm.',
  never: 'never',
  unknown: 'unknown',
  /** A status chip with a detail after it. */
  chipDetail: '{status}: {detail}',
  /** A channel named with its kind, like "Support (Slack)". */
  named: '{name} ({kind})',
});

/**
 * A translated label placed mid-sentence (`Copy {label}`): English lowercases it ("Copy inbound
 * address"); other languages keep the label as written, since their nouns may keep capitals.
 */
export function midSentence(label: string): string {
  return intlLocale(getLocale()).split('-')[0] === 'en' ? label.toLowerCase() : label;
}

export const KIND_TEXT: Record<ChannelKindM7, string> = defineMessages('channels.kind', {
  inapp: 'In-app',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  email: 'Email',
  webhook: 'Webhook',
  telegram: 'Telegram',
});

export const KIND_HINT: Record<ChannelKindM7, string> = defineMessages('channels.kindHint', {
  inapp: 'Message the agent from Nova itself.',
  slack: 'A Slack direct message or channel, through your Slack app.',
  teams: 'A Teams chat or channel, through your Azure bot.',
  email: 'One person (or a list) the agent writes with, through a mailbox you give it.',
  webhook: 'Any service that can send and receive signed HTTP requests.',
  telegram: 'A private chat or a group with your Telegram bot.',
});

/** What a binding's conversation reference is called, per kind. */
export const REF_TEXT: Record<ChannelKindM7, { label: string; hint?: string }> = defineMessages(
  'channels.ref',
  {
    inapp: { label: 'Conversation' },
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
  },
);

export const CREDENTIAL_TEXT = defineMessages('channels.credential', {
  botToken: 'Bot token',
  signingSecret: 'Signing secret',
  appPassword: 'App password',
  token: 'Bearer token',
  secret: 'Signing secret',
  webhookSecret: 'Webhook secret',
  password: 'Mailbox password',
  oauthClientSecret: 'OAuth client secret',
});

/** Credentials the Hub makes itself: shown as set or not, never replaced by hand. */
export const GENERATED_CREDENTIALS: Partial<Record<ChannelKindM7, readonly string[]>> = {
  telegram: ['webhookSecret'],
};

export const CONFIG_TEXT: Record<string, { label: string; hint?: string }> = defineMessages(
  'channels.config',
  {
    botUserId: { label: 'Bot user ID', hint: 'Lets Nova tell when the bot is mentioned.' },
    teamId: { label: 'Workspace ID', hint: 'The Slack workspace (team) ID.' },
    appId: { label: 'App ID', hint: 'The Microsoft app ID of your Azure bot.' },
    serviceUrl: { label: 'Service URL', hint: 'Learned from the first message; rarely needed.' },
    callbackUrl: {
      label: 'Reply URL',
      hint: 'Where replies are posted, signed with the secret. It must be a public https address.',
    },
    mode: { label: 'How messages arrive' },
    address: { label: 'Mailbox address', hint: 'The agent’s address: replies come from it.' },
    username: { label: 'Login name', hint: 'Leave empty to sign in with the mailbox address.' },
    imapHost: { label: 'IMAP server', hint: 'Where mail is read, like imap.example.com.' },
    imapPort: { label: 'IMAP port', hint: 'Leave empty for the usual port (993 with TLS).' },
    imapSecurity: { label: 'IMAP security' },
    smtpHost: { label: 'SMTP server', hint: 'Where replies are sent, like smtp.example.com.' },
    smtpPort: { label: 'SMTP port', hint: 'Leave empty for the usual port (465 with TLS).' },
    smtpSecurity: { label: 'SMTP security' },
    folder: { label: 'Folder', hint: 'The folder read; leave empty for INBOX.' },
    senderCheck: { label: 'Check senders' },
    auth: { label: 'How Nova signs in' },
    oauthAuthUrl: {
      label: 'Authorization URL',
      hint: 'Your provider’s authorization endpoint, where you sign in. https only.',
    },
    oauthTokenUrl: { label: 'Token URL', hint: 'Your provider’s token endpoint. https only.' },
    oauthRevokeUrl: {
      label: 'Revocation URL (optional)',
      hint: 'Where Nova revokes the tokens when you sign out, if your provider has one.',
    },
    oauthClientId: {
      label: 'Client ID',
      hint: 'From the app you registered for Nova with your mail provider.',
    },
    oauthScopes: {
      label: 'Scopes',
      hint: 'Space-separated: the scopes your provider needs for reading mail over IMAP and sending over SMTP.',
    },
    authservId: {
      label: 'Authentication-Results name',
      hint: 'The name your mail server writes in Authentication-Results, like mx.google.com. Leave empty to use the IMAP server’s domain. Mail from big providers stays unverified until it is set.',
    },
  },
);

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
    'auth',
    'oauthAuthUrl',
    'oauthTokenUrl',
    'oauthRevokeUrl',
    'oauthClientId',
    'oauthScopes',
  ],
};

/** An email binding's OAuth settings: shown only while it signs in with OAuth (M8). */
export const MAIL_OAUTH_KEYS: readonly string[] = [
  'oauthAuthUrl',
  'oauthTokenUrl',
  'oauthRevokeUrl',
  'oauthClientId',
  'oauthScopes',
];

/** The words of the settings with a fixed set of values. */
const CHOICE_TEXT = defineMessages('channels.choice', {
  polling: {
    label: 'Polling (default)',
    hint: 'Nova asks Telegram for new messages; works behind a router.',
  },
  webhook: { label: 'Webhook', hint: 'Telegram posts new messages to the public address.' },
  tls: 'TLS (default)',
  starttls: 'STARTTLS',
  plain: 'None (only on this machine)',
  idle: 'Stay connected (default)',
  checkOften: 'Check every few minutes',
  dmarc: 'Mail server vouches (default)',
  fromOnly: 'From address only',
  password: 'Password (default)',
  oauth: 'OAuth',
});

export interface ConfigChoice {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Settings with a fixed set of values: the first option (empty value) is the Hub's default. A
 * function, so the labels are read in the active locale.
 */
export function configChoices(): Partial<Record<ChannelKindM7, Record<string, ConfigChoice[]>>> {
  const C = CHOICE_TEXT;
  const security = (): ConfigChoice[] => [
    { value: '', label: C.tls },
    { value: 'starttls', label: C.starttls },
    { value: 'none', label: C.plain },
  ];
  return {
    telegram: {
      mode: [
        { value: '', label: C.polling.label, hint: C.polling.hint },
        { value: 'webhook', label: C.webhook.label, hint: C.webhook.hint },
      ],
    },
    email: {
      imapSecurity: security(),
      smtpSecurity: security(),
      mode: [
        { value: '', label: C.idle },
        { value: 'polling', label: C.checkOften },
      ],
      senderCheck: [
        { value: '', label: C.dmarc },
        { value: 'none', label: C.fromOnly },
      ],
      auth: [
        { value: '', label: C.password },
        { value: 'oauth', label: C.oauth },
      ],
    },
  };
}

/** What a choice-valued setting means, under its field. */
export const CHOICE_HINT: Record<string, string> = defineMessages('channels.choiceHint', {
  senderCheck:
    'Who counts as a person listed under People. By default only when your mail server vouches for them (DMARC); From address only trusts whatever address a message claims, so it asks you first.',
  imapSecurity: 'Without TLS works only for a server on this machine.',
  auth: 'OAuth is for providers that refuse passwords: you register Nova as an app with your provider, then authorize the mailbox here.',
  smtpSecurity: 'Without TLS works only for a server on this machine.',
});

/** Where to paste the inbound address, per kind. */
export const INBOUND_HINT: Partial<Record<ChannelKindM7, string>> = defineMessages(
  'channels.inboundHint',
  {
    slack:
      'In your Slack app, paste this as the Request URL under Event Subscriptions, and subscribe the bot to message events.',
    teams: 'In your Azure bot, paste this as the messaging endpoint.',
    webhook:
      'Post messages here as JSON \'{"id", "text", "from": {"id", "name"}}\', with the bearer token and a signature made with the secret.',
    telegram:
      'Nova gives this address to Telegram itself when the channel connects; there is nothing to paste.',
  },
);

/** How approvals are answered from a channel of this kind (docs/13 §4). */
export const APPROVAL_HINT: Partial<Record<ChannelKindM7, string>> = defineMessages(
  'channels.approvalHint',
  {
    slack: 'Approvals show buttons in Slack; only people listed as owners can press them.',
    telegram: 'Approvals show buttons in Telegram; only people listed as owners can press them.',
    email:
      'Approvals are answered only with the signed, one-use link in the approval email, sent only to you. A reply to the email never answers an approval.',
  },
);

export interface ChipSpec {
  text: string;
  icon: IconName | null;
  /** A runtime status tone; undefined is neutral. */
  tone?: Status;
}

/**
 * Chip specs whose text is read from `text` each time it is used (at render), so it follows the
 * active locale; `look` holds each one's icon and tone.
 */
export function chips<K extends string>(
  text: Readonly<Record<K, string>>,
  look: Record<K, Omit<ChipSpec, 'text'>>,
): Record<K, ChipSpec> {
  const out = {} as Record<K, ChipSpec>;
  for (const k of Object.keys(look) as K[])
    out[k] = Object.defineProperty({ ...look[k] }, 'text', {
      get: () => text[k],
      enumerable: true,
    }) as ChipSpec;
  return out;
}

export const BINDING_STATUS: Record<ChannelBindingView['status'], ChipSpec> = chips(
  defineMessages('channels.bindingStatus', {
    connected: 'Connected',
    disconnected: 'Disconnected',
    not_configured: 'Needs setup',
  }),
  {
    connected: { icon: 'check', tone: 'ready' },
    disconnected: { icon: 'stop' },
    not_configured: { icon: 'alert', tone: 'needs_input' },
  },
);

export const TRIGGER_KIND_TEXT: Record<TriggerKind, string> = defineMessages(
  'channels.triggerKind',
  {
    webhook: 'Webhook',
    connector_event: 'Channel watch',
    mcp_event: 'MCP event',
    fs_change: 'File change',
    email: 'Email label',
  },
);

export const SUBSCRIPTION_STATUS: Record<McpSubscriptionStatus, ChipSpec> = chips(
  defineMessages('channels.subscriptionStatus', {
    pending: 'Subscribing',
    active: 'Active',
    refreshing: 'Renewing',
    lapsed: 'Lapsed',
    failed: 'Failed',
    removed: 'Unsubscribed',
  }),
  {
    pending: { icon: null, tone: 'running' },
    active: { icon: 'check', tone: 'ready' },
    refreshing: { icon: null, tone: 'running' },
    lapsed: { icon: 'alert', tone: 'blocked' },
    failed: { icon: 'stop', tone: 'blocked' },
    removed: { icon: 'stop' },
  },
);

export const EVENT_STATUS: Record<TriggerEventView['status'], ChipSpec> = chips(
  defineMessages('channels.eventStatus', {
    started: 'Started',
    failed: 'Failed',
    skipped: 'Skipped',
  }),
  {
    started: { icon: 'check', tone: 'ready' },
    failed: { icon: 'stop', tone: 'blocked' },
    skipped: { icon: 'alert' },
  },
);

const EVENT_DETAIL = defineMessages('channels.eventDetail', {
  rate_limited: 'The hourly limit for this trigger was reached.',
  disabled: 'The trigger was off.',
  received: 'Received; nothing was started yet.',
});

/** A delivery's detail in plain words; unknown details are shown as they are. */
export function eventDetail(e: TriggerEventView): string | null {
  if (!e.detail) return null;
  return messageFor(EVENT_DETAIL, e.detail) ?? e.detail;
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

/** The Hub refused `senderCheck: none` because it was not confirmed (`confirm_required`). */
export function isConfirmRequired(err: unknown): boolean {
  return err instanceof ApiError && err.body.details?.reason === 'confirm_required';
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

/** A local date and time in the active locale, like "Oct 17, 09:30". */
export function formatStamp(iso: string | null): string {
  if (!iso) return CHANNEL_TEXT.never;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return CHANNEL_TEXT.unknown;
  return fmt.dateTime(t, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---- the message log (FR-110) ----------------------------------------------------------------

export const MESSAGE_STATUS: Record<ChannelMessageStatus, ChipSpec> = chips(
  defineMessages('channels.messageStatus', {
    started: 'Started a turn',
    answered: 'Answered',
    ignored: 'Ignored',
    dropped: 'Dropped',
    sent: 'Sent',
    failed: 'Failed',
    withheld: 'Held back',
  }),
  {
    started: { icon: 'check', tone: 'ready' },
    answered: { icon: 'check', tone: 'ready' },
    ignored: { icon: 'slash' },
    dropped: { icon: 'stop', tone: 'blocked' },
    sent: { icon: 'send', tone: 'ready' },
    failed: { icon: 'alert', tone: 'blocked' },
    withheld: { icon: 'shield', tone: 'needs_input' },
  },
);

/** Why a message was ignored, dropped, held back or failed, by the Hub's reason code. */
const MESSAGE_REASON = defineMessages('channels.messageReason', {
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
  file: 'A file from the agent’s reply.',
  files_not_supported: 'This channel does not carry files.',
});

/** A file the agent sent with its reply (M8: Telegram files), logged as its own row. */
export function isFileRow(m: Pick<ChannelMessageView, 'reason' | 'direction'>): boolean {
  return m.direction === 'out' && m.reason === 'file';
}

// ---- files of a log entry (M8) ------------------------------------------------------------------

export const FILE_STATUS: Record<ChannelMessageFileStatus, ChipSpec> = chips(
  defineMessages('channels.fileStatus', {
    received: 'Kept with the chat',
    sent: 'Sent',
    withheld: 'Held back',
    failed: 'Not delivered',
  }),
  {
    received: { icon: 'check', tone: 'ready' },
    sent: { icon: 'send', tone: 'ready' },
    withheld: { icon: 'shield', tone: 'needs_input' },
    failed: { icon: 'alert', tone: 'blocked' },
  },
);

export const FILE_TEXT = defineMessages('channels.files', {
  /** The badge of a file row in the message log (an entry logged before its files were kept). */
  badge: 'File',
  listLabel: '{n, plural, one {File of this message} other {# files of this message}}',
  sizeUnknown: 'size unknown',
  /** An inbound file the Hub refused (`failed` with the reason). */
  notKept: 'Not kept',
});

/** Why a file was refused, held back or failed, by the Hub's code or its short sentence. */
const FILE_REASON = defineMessages('channels.fileReason', {
  tooMany: 'Too many files in one message.',
  notKept: 'This Hub has no place set up to keep files.',
  notRead: 'This channel cannot download files.',
  size: 'The file is larger than Nova accepts.',
  empty: 'The file is empty.',
  content: 'The file is not the kind it claims to be.',
});

/** The Hub's file reasons (codes or short sentences) to their messages. */
const FILE_REASON_KEY = new Map<string, keyof typeof FILE_REASON>([
  ['too many files', 'tooMany'],
  ['files are not kept here', 'notKept'],
  ['files are not read here', 'notRead'],
  ['size', 'size'],
  ['empty', 'empty'],
  ['content', 'content'],
]);

/** The files of a log entry: every one when it carried several, else the one. */
export function entryFiles(
  m: Pick<ChannelMessageView, 'file' | 'files'>,
): ChannelMessageFileView[] {
  return m.files?.length ? m.files : m.file ? [m.file] : [];
}

/** A file's size in the active locale ("15 KB"). */
export function fileSize(bytes: number | null): string {
  if (bytes === null) return FILE_TEXT.sizeUnknown;
  return fmt.bytes(bytes);
}

/** A file's state: an inbound refusal is "Not kept", the rest as their status says. */
export function fileStatus(f: Pick<ChannelMessageFileView, 'status' | 'direction'>): ChipSpec {
  if (f.status === 'failed' && f.direction === 'in')
    return { ...FILE_STATUS.failed, text: FILE_TEXT.notKept };
  return FILE_STATUS[f.status];
}

/**
 * Why a file was not kept, held back or not delivered, in plain words (null when it went fine).
 * A reason the web does not know is the Hub's own text, shown as a sentence.
 */
export function fileReason(f: Pick<ChannelMessageFileView, 'reason'>): string | null {
  const r = f.reason?.trim();
  if (!r) return null;
  const key = FILE_REASON_KEY.get(r);
  if (key) return FILE_REASON[key];
  return messageFor(MESSAGE_REASON, r) ?? sentence(/^[a-z_]+$/.test(r) ? r.replace(/_/g, ' ') : r);
}

/** Why a message was ignored, dropped, held back or failed, in plain words. */
export function messageReason(m: Pick<ChannelMessageView, 'reason'>): string | null {
  if (!m.reason) return null;
  return messageFor(MESSAGE_REASON, m.reason) ?? sentence(m.reason.replace(/_/g, ' '));
}

/** A mail server the Hub may reach without TLS: only one on this machine (loopback). */
export function plainMailAllowed(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

// ---- email OAuth (M8, FR-110) ------------------------------------------------------------------

export const OAUTH_STATUS: Record<ChannelOAuthStatus, ChipSpec> = chips(
  defineMessages('channels.oauthStatus', {
    needs_auth: 'Not authorized yet',
    connected: 'Authorized',
    expired: 'Authorization expired',
    error: 'Sign-in failed',
  }),
  {
    needs_auth: { icon: 'hand', tone: 'needs_input' },
    connected: { icon: 'check', tone: 'ready' },
    expired: { icon: 'clock', tone: 'needs_input' },
    error: { icon: 'alert', tone: 'blocked' },
  },
);

export const MAIL_OAUTH_TEXT = defineMessages('channels.mailOAuth', {
  heading: 'OAuth sign-in',
  panelLabel: 'OAuth sign-in of {label}',
  intro:
    'Nova signs in to this mailbox with tokens from your provider. You sign in at the provider once; Nova refreshes the tokens itself.',
  authLegend: 'How Nova signs in',
  password: 'With a password',
  passwordHint: 'An app password if your provider has them.',
  oauth: 'With OAuth',
  oauthHint:
    'For providers that refuse passwords. Register Nova as an app with your provider first.',
  clientSecret: 'Client secret (optional)',
  clientSecretHint:
    'Only if your provider gave the app a secret. Kept in the Hub’s secret store and never shown again.',
  redirectLabel: 'Redirect URI to register with your provider',
  redirectHint:
    'Add this address to the app you registered with your provider, or authorizing fails.',
  authorizeAfter: 'After adding the channel, choose Authorize to sign in at your provider.',
  authorize: 'Authorize',
  authorizeAgain: 'Authorize again',
  authorizeLabel: 'Authorize the mailbox of {label}',
  authorizeAgainLabel: 'Authorize the mailbox of {label} again',
  starting: 'Opening your provider…',
  startFailed: 'Could not start the sign-in: {error}',
  unsafeUrl: 'The provider’s sign-in address is not https, so Nova did not open it.',
  signOut: 'Sign out',
  signOutLabel: 'Sign out of the mailbox of {label}',
  signOutTitle: 'Sign out of this mailbox?',
  signOutWhat:
    'Nova revokes its tokens at your provider and deletes them, and stops reading and sending mail here until you authorize again. Channels that share this mailbox stop too.',
  signedOut: 'Signed out of the mailbox of {label}. Its tokens were revoked.',
  signOutFailed: 'Could not sign out: {error}',
  cancel: 'Cancel',
  scopes: 'Granted: {scopes}',
  authorizedWhen: 'Authorized {when}',
  renews: 'Nova renews the sign-in itself before it runs out.',
  expiredHelp: 'Your provider no longer accepts the sign-in. Authorize again to keep reading mail.',
  lastError: 'Last error: {error}',
  rowNeeds: 'The mailbox is not authorized yet.',
  rowExpired: 'The mailbox needs authorizing again.',
  returnedOk: 'Mailbox authorized. Nova reads it again now.',
  returnedError: 'The mailbox was not authorized. Try again from its channel.',
  needAuthUrl: 'Enter the authorization URL.',
  needTokenUrl: 'Enter the token URL.',
  needClientId: 'Enter the client ID.',
});

/** The redirect URI the Hub gives the provider: this Hub as the browser reaches it. */
export function mailOAuthRedirectUri(origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, '')}/api/v1/channels/oauth/callback`;
}
