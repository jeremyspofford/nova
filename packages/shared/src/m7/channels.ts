// M7 channels API shapes (owned by the channels area; the web reads them): Telegram and email
// bindings (FR-110), the channel message log, Web Push subscriptions and the push leg of
// notification routing (FR-111, FR-060, docs/13 §6), the test notification, and the
// rotate-and-show-once webhook signing secret of a schedule (FR-055). The M6 shapes stay as they
// are (`m6/channels.ts`); these widen them with the new kinds. Secrets are write-only.
import { z } from 'zod';
import { NOTIFICATION_KINDS, idSchema, type NotificationKind } from '../api.ts';
import {
  CHANNEL_BINDING_KINDS,
  CHANNEL_ROLES,
  createChannelBindingSchema,
  type ChannelBindingView,
  type ChannelIdentityView,
} from '../m6/channels.ts';

// ---- binding kinds (FR-110) --------------------------------------------------------------------

/** Every kind a binding can have since M7 (the M6 list plus Telegram; email is now available). */
export const CHANNEL_KINDS_M7 = [...CHANNEL_BINDING_KINDS, 'telegram'] as const;
export type ChannelKindM7 = (typeof CHANNEL_KINDS_M7)[number];

/** A binding view whose kind may be any M7 kind. */
export interface ChannelBindingViewM7 extends Omit<ChannelBindingView, 'kind'> {
  kind: ChannelKindM7;
  /** M8: an email binding signing in with OAuth (`config.auth: oauth`): its authorization. */
  oauth?: ChannelOAuthView | null;
}

// ---- email OAuth (M8, SASL XOAUTH2) ------------------------------------------------------------

/** How an email binding signs in to its mailbox: a password (default) or OAuth (M8). */
export const MAIL_AUTH = ['password', 'oauth'] as const;
export type MailAuth = (typeof MAIL_AUTH)[number];

/**
 * needs_auth: not authorized yet (or signed out); connected: tokens are stored; expired: the
 * provider refused the refresh token (authorize again); error: the last exchange or refresh
 * failed for another reason (retried on the next use).
 */
export const CHANNEL_OAUTH_STATUSES = ['needs_auth', 'connected', 'expired', 'error'] as const;
export type ChannelOAuthStatus = (typeof CHANNEL_OAUTH_STATUSES)[number];

/** A mailbox's OAuth authorization (shared by the bindings of one mailbox). Never a token. */
export interface ChannelOAuthView {
  status: ChannelOAuthStatus;
  /** Scopes the provider granted. */
  scopes: string[];
  /** When the access token expires (it is refreshed shortly before). */
  expiresAt: string | null;
  authorizedAt: string | null;
  lastError: string | null;
}

/**
 * POST /api/v1/channels/:id/oauth/start: the provider's authorization page to open in the browser
 * (single-use state, PKCE S256), and the redirect URI to register with the provider.
 */
export interface ChannelOAuthStartView {
  authorizeUrl: string;
  redirectUri: string;
  /** When the state stops being accepted. */
  expiresAt: string;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** An OAuth endpoint: https, or http only to this machine. */
const oauthUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname));
    } catch {
      return false;
    }
  }, 'an https URL');

/** An identity mapping whose kind may be any M7 kind (Telegram user ids, email addresses). */
export interface ChannelIdentityViewM7 extends Omit<ChannelIdentityView, 'kind'> {
  kind: ChannelKindM7;
}

export interface ChannelAdapterViewM7 {
  kind: ChannelKindM7;
  available: boolean;
  detail: string | null;
}

const port = z
  .union([z.number().int().min(1).max(65_535), z.string().regex(/^\d{1,5}$/)])
  .transform(String);
const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/, 'a host name or address');
/** `tls`: TLS from the start; `starttls`: upgrade, required; `none`: plain, only on this machine. */
export const MAIL_SECURITY = ['tls', 'starttls', 'none'] as const;
export type MailSecurity = (typeof MAIL_SECURITY)[number];

/** Telegram: a chat id (private chats are positive, groups and channels negative). */
const telegramChat = z
  .string()
  .trim()
  .regex(/^-?\d{1,20}$/, 'a numeric Telegram chat id');

const [inappVariant, slackVariant, teamsVariant, webhookVariant, m6EmailVariant] =
  createChannelBindingSchema.options;
const bindingBase = {
  agentId: m6EmailVariant.shape.agentId,
  label: m6EmailVariant.shape.label,
  audience: m6EmailVariant.shape.audience,
  sharePrimaryThread: m6EmailVariant.shape.sharePrimaryThread,
  allowUnknown: m6EmailVariant.shape.allowUnknown,
  rateLimit: m6EmailVariant.shape.rateLimit,
  enabled: m6EmailVariant.shape.enabled,
};

/**
 * POST /api/v1/channels since M7: the M6 kinds, Telegram, and email with its mailbox. A Telegram
 * binding is one chat of a bot (`externalRef` the chat id); bindings of one bot share its token
 * (`shareCredentialsWith`). The Hub makes the webhook's secret token itself. An email binding is
 * one correspondent (`externalRef` their address, or a list address) of a mailbox; bindings of one
 * mailbox share its password.
 */
export const createChannelBindingM7Schema = z
  .discriminatedUnion('kind', [
    inappVariant,
    slackVariant,
    teamsVariant,
    webhookVariant,
    z
      .object({
        ...bindingBase,
        kind: z.literal('telegram'),
        externalRef: telegramChat,
        credentials: z
          .object({
            botToken: z
              .string()
              .trim()
              .regex(/^\d{1,20}:[A-Za-z0-9_-]{20,200}$/, 'a Telegram bot token'),
          })
          .strict()
          .optional(),
        shareCredentialsWith: idSchema.optional(),
        config: z
          .object({
            /** `webhook` needs `channels.publicUrl`; `polling` works behind NAT. */
            mode: z.enum(['webhook', 'polling']).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    z
      .object({
        ...bindingBase,
        kind: z.literal('email'),
        externalRef: z.string().trim().toLowerCase().email().max(300),
        credentials: z
          .object({ password: z.string().min(1).max(2000) })
          .strict()
          .optional(),
        /**
         * M8: an OAuth sign-in's client secret (a confidential client; a public client with PKCE
         * has none). Kept in the vault like `credentials`, never returned; replaced later with
         * `PATCH {credentials: {oauthClientSecret}}`.
         */
        oauthClientSecret: z.string().min(1).max(2000).optional(),
        shareCredentialsWith: idSchema.optional(),
        config: z
          .object({
            /**
             * M8: `password` (default) or `oauth`: IMAP and SMTP sign in with SASL XOAUTH2 using
             * tokens from the provider's endpoints below, authorized in the browser
             * (`POST /channels/:id/oauth/start`).
             */
            auth: z.enum(MAIL_AUTH).optional(),
            /** The provider's authorization endpoint (extra query parameters are kept). */
            oauthAuthUrl: oauthUrl.optional(),
            oauthTokenUrl: oauthUrl.optional(),
            /** The provider's revocation endpoint (RFC 7009), used when signing out. */
            oauthRevokeUrl: oauthUrl.optional(),
            oauthClientId: z.string().trim().min(1).max(500).optional(),
            /** Space-separated scopes, e.g. the provider's IMAP and SMTP scopes. */
            oauthScopes: z.string().trim().min(1).max(1000).optional(),
            /** The mailbox's own address: replies come from it. */
            address: z.string().trim().toLowerCase().email().max(300),
            /** The login name (default the address). */
            username: z.string().trim().min(1).max(300).optional(),
            imapHost: host,
            imapPort: port.optional(),
            imapSecurity: z.enum(MAIL_SECURITY).optional(),
            smtpHost: host,
            smtpPort: port.optional(),
            smtpSecurity: z.enum(MAIL_SECURITY).optional(),
            /** The folder watched (default INBOX). */
            folder: z.string().trim().min(1).max(200).optional(),
            /** `idle` keeps a connection open; `polling` checks every `channels.email.pollSeconds`. */
            mode: z.enum(['idle', 'polling']).optional(),
            /**
             * `dmarc` (default): a sender counts as their mapped identity only when an
             * Authentication-Results header of the receiving server (`authservId`) says DMARC
             * passed for the From domain (or DKIM with an aligned domain); `none` trusts the From
             * address (a server that adds no results). `none` must be confirmed and is audited.
             */
            senderCheck: z.enum(['dmarc', 'none']).optional(),
            /**
             * The receiving server's authserv-id (RFC 8601), the first word of its
             * Authentication-Results headers; default: the IMAP host's domain and its subdomains.
             */
            authservId: z
              .string()
              .trim()
              .toLowerCase()
              .regex(/^[a-z0-9.-]{1,253}$/, 'a host name')
              .optional(),
          })
          .strict()
          .optional(),
        /** Required with `senderCheck: none`: every From address is then taken as it says. */
        confirmSenderCheckNone: z.literal(true).optional(),
      })
      .strict(),
  ])
  .refine((v) => !v.sharePrimaryThread || v.audience === 'private', {
    message: 'only a private binding can share the primary thread',
    path: ['sharePrimaryThread'],
  });
export type CreateChannelBindingM7Request = z.infer<typeof createChannelBindingM7Schema>;

/**
 * PATCH /api/v1/channels/:id since M7: the M6 fields plus the confirmation turning an email
 * binding's sender check off needs (`config.senderCheck: none`).
 */
export const channelUpdateConfirmSchema = z
  .object({ confirmSenderCheckNone: z.literal(true).optional() })
  .strict();

/** POST /api/v1/channel-identities since M7 (Telegram user ids, email addresses). */
export const channelIdentityM7Schema = z
  .object({
    kind: z.enum(CHANNEL_KINDS_M7),
    externalId: z.string().trim().min(1).max(300),
    displayName: z.string().trim().max(200).optional(),
    role: z.enum(CHANNEL_ROLES).default('member'),
  })
  .strict();

// ---- message log (M6 known gap) ----------------------------------------------------------------

export const CHANNEL_MESSAGE_STATUSES = [
  'started',
  'answered',
  'ignored',
  'dropped',
  'sent',
  'failed',
  'withheld',
] as const;
export type ChannelMessageStatus = (typeof CHANNEL_MESSAGE_STATUSES)[number];

/** One message in or out of a binding. The text stays in the thread; the log holds no content. */
export interface ChannelMessageView {
  id: string;
  bindingId: string;
  direction: 'in' | 'out';
  /** The service's message id (inbound) or the delivery receipt (outbound). */
  externalId: string | null;
  conversation: string | null;
  threadRef: string | null;
  /** The external sender (inbound). */
  sender: string | null;
  threadId: string | null;
  turnId: string | null;
  status: ChannelMessageStatus;
  /** Why it was ignored, dropped, withheld or failed. */
  reason: string | null;
  createdAt: string;
  /**
   * M8: the file this entry carried: an inbound message's file (received and kept as a thread
   * attachment, or refused), or a file sent out (sent, withheld or failed).
   */
  file?: ChannelMessageFileView;
  /** M8: every file, only when the entry carried more than one (an email's attachments). */
  files?: ChannelMessageFileView[];
}

/** received: kept as a thread attachment (inbound); sent, withheld, failed: outbound. */
export const CHANNEL_MESSAGE_FILE_STATUSES = ['received', 'sent', 'withheld', 'failed'] as const;
export type ChannelMessageFileStatus = (typeof CHANNEL_MESSAGE_FILE_STATUSES)[number];

/** A file of a message-log entry (M8). No content: the bytes are the attachment or artifact. */
export interface ChannelMessageFileView {
  name: string;
  /** Bytes; null when unknown (refused before it was read). */
  size: number | null;
  contentType: string | null;
  direction: 'in' | 'out';
  status: ChannelMessageFileStatus;
  /** The thread attachment it was kept as (inbound) or sent from (outbound). */
  attachmentId?: string;
  /** The artifact it was sent from (outbound). */
  artifactId?: string;
  /** Why it was refused, withheld or failed. */
  reason?: string;
}

/**
 * GET /api/v1/channels/:id/messages, newest first. Page with `cursor` (the previous page's
 * `nextCursor`: its last message's time and id, so messages sharing a timestamp at a page
 * boundary are never skipped); `before` (strictly older than a time) still works, not with it.
 */
export const channelMessagesQuery = z
  .object({
    direction: z.enum(['in', 'out']).optional(),
    status: z.enum(CHANNEL_MESSAGE_STATUSES).optional(),
    /** Only messages older than this (ISO). */
    before: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().min(1).max(300).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict()
  .refine((q) => !(q.before && q.cursor), {
    message: 'give cursor or before, not both',
    path: ['cursor'],
  });
export type ChannelMessagesQuery = z.infer<typeof channelMessagesQuery>;

/** A page of the message log; null `nextCursor` on the last page. */
export interface ChannelMessagesPageView {
  items: ChannelMessageView[];
  nextCursor: string | null;
}

// ---- notifications: test and push (FR-060, FR-111, docs/13 §6) ---------------------------------

/** POST /api/v1/notification-rules/:category/test */
export const notificationTestSchema = z
  .object({ title: z.string().trim().min(1).max(200).optional() })
  .strict();

export interface NotificationTestView {
  category: NotificationKind;
  /** Where the rule sends it now (quiet hours included). */
  inapp: boolean;
  os: boolean;
  channels: string[];
  deferUntil: string | null;
}

/** How much a push notification says (docs/13 §6); secrets and file contents never. */
export const PUSH_DETAIL_LEVELS = ['none', 'redacted', 'titles'] as const;
export type PushDetailLevel = (typeof PUSH_DETAIL_LEVELS)[number];

/**
 * What a push carries, end-to-end encrypted to the browser (RFC 8291): ids, a title of the chosen
 * detail, and where it opens (decision 7 deep links).
 */
export interface PushPayload {
  v: 1;
  /** The notification id (the in-app record). */
  id: string;
  category: NotificationKind;
  title: string;
  /** In-app path for the web (`/work/<id>`, `/code/<id>`, the approval in its thread). */
  path: string | null;
  /** `nova://run/<id>`, `nova://code/<id>` or `nova://approval/<id>`, when it names one. */
  link: string | null;
  at: string;
}

export interface PushSubscriptionView {
  id: string;
  kind: 'webpush';
  /** The push service's origin (the full endpoint is a capability and is not returned). */
  endpointOrigin: string;
  label: string | null;
  deviceId: string | null;
  status: 'active' | 'failing' | 'gone';
  lastSuccessAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

const b64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'base64url');

/** POST /api/v1/push/subscriptions: the browser's PushSubscription.toJSON(). */
export const createPushSubscriptionSchema = z
  .object({
    endpoint: z.string().url().max(2000),
    // Milliseconds since the epoch, bounded (2100-01-01) so a date can always be made of it.
    expirationTime: z
      .number()
      .int()
      .min(0)
      .max(Date.UTC(2100, 0, 1))
      .nullable()
      .optional(),
    keys: z
      .object({
        /** The browser's P-256 public key, uncompressed (65 bytes). */
        p256dh: b64url(80, 100),
        /** The 16-byte authentication secret. */
        auth: b64url(16, 30),
      })
      .strict(),
    label: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type CreatePushSubscriptionRequest = z.infer<typeof createPushSubscriptionSchema>;

/** GET /api/v1/push/vapid-key: the application server key the browser subscribes with. */
export interface PushVapidKeyView {
  /** Uncompressed P-256 public key, base64url (RFC 8292 `k`). */
  publicKey: string;
}

/** POST /api/v1/push/test: one push to each (or one) of the account's subscriptions. */
export const pushTestSchema = z.object({ subscriptionId: idSchema.optional() }).strict();

export interface PushTestView {
  sent: number;
  failed: number;
  results: { subscriptionId: string; status: 'sent' | 'failed' | 'gone'; detail: string | null }[];
}

export const pushCategorySchema = z.enum(NOTIFICATION_KINDS);

// ---- schedule webhook signing secret (FR-055) --------------------------------------------------

/**
 * POST /api/v1/schedules/:id/webhook-secret: a new signing secret, shown once. The old one stops
 * working at once; the Hub never returns a secret again.
 */
export interface WebhookSecretView {
  scheduleId: string;
  secret: string;
  /** How receivers check it: `sha256=` HMAC-SHA256 over `<x-nova-timestamp>.<body>`. */
  scheme: 'hmac-sha256';
  rotatedAt: string;
}
