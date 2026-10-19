// What the channels area gives its adapters, and what it asks of them beyond the seam
// (channels/types.ts): credential lookup by binding, a probe for connect and test, and the
// handshake answers some services expect before they send messages.
import { NovaError } from '@nova/shared';
import type { ChannelAdapter, ChannelReceipt, InboundMessage, OutboundMessage } from '../types.ts';

/** Credentials and settings of a binding; secrets come from the secret store on each use. */
export interface BindingCredentials {
  /** A secret of the binding (bot token, signing secret), or null when none is stored. */
  secret(bindingId: string, name: string): Promise<string | null>;
  /** The binding's settings without secrets. */
  config(bindingId: string): Promise<Record<string, string | null>>;
  /** Remember a setting learned from a verified request (a Teams service URL). */
  remember(bindingId: string, key: string, value: string): Promise<void>;
}

export interface AdapterProbe {
  ok: boolean;
  detail: string;
  /** Settings the probe learned (Slack bot user id and team); stored on the binding. */
  learned?: Record<string, string>;
}

/** A button answer to an approval prompt (Slack buttons, Telegram inline keyboards; M7). */
export interface ChannelAction {
  kind: 'approval';
  approvalId: string;
  decision: 'allow_once' | 'allow_session' | 'deny_continue' | 'deny_stop';
  /** What the adapter needs to update the prompt afterwards (message ids, callback id). */
  ref: Record<string, string>;
  /** The prompt's text as the service shows it, so the update can keep it. */
  promptText: string | null;
}

/** A file that came with an inbound message (email attachments; M7). Untrusted. */
export interface InboundAttachment {
  name: string;
  mime: string;
  bytes: Buffer;
  /**
   * M8: a voice or video note (Telegram). It is kept with the thread's files but is not model
   * input: models here cannot listen to it.
   */
  note?: { kind: 'voice' | 'video_note'; seconds: number | null };
}

/**
 * M8: a file an inbound message points at but does not carry (Telegram). It is downloaded only
 * after the message passed every check and will start a turn (`download`), so a stranger in a
 * group cannot make the Hub fetch files.
 */
export interface InboundFileRef {
  /** The service's file id. */
  ref: string;
  kind: 'photo' | 'document' | 'voice' | 'video_note' | 'unsupported';
  name: string;
  mime: string;
  /** What the service says it weighs (checked again while downloading); null when unknown. */
  size: number | null;
  /** Voice and video notes: their length. */
  seconds?: number | null;
}

/** M8: a file sent to a conversation (an artifact or attachment of the agent's turn). */
export interface OutboundFile {
  conversation: string;
  threadRef?: string | null;
  name: string;
  mime: string;
  bytes: Buffer;
  caption?: string | null;
}

/** An inbound message with the M7 extras (channels/types.ts stays as it is). */
export interface NovaInboundMessage extends InboundMessage {
  /** A button press instead of a message. */
  action?: ChannelAction;
  attachments?: InboundAttachment[];
  /** M8: files to download once the message is accepted (Telegram). */
  files?: InboundFileRef[];
  /**
   * Email: whether the sender's address is authenticated (DMARC or DKIM for its domain, per the
   * receiving server). An unauthenticated sender is never matched to a mapped identity.
   */
  senderVerified?: boolean;
  /** Email: the binding trusts From addresses unchecked (`senderCheck: none`); recorded. */
  senderUnchecked?: boolean;
  /** Email: a subject to reply under. */
  subject?: string | null;
}

/** An approval the outbound message asks about, so an adapter can add buttons or links (M7). */
export interface OutboundApproval {
  id: string;
  code: string;
  options: ChannelAction['decision'][];
  /** Email: the signed one-use link that answers it (plain email text never does). */
  link?: string | null;
}

export interface NovaOutboundMessage extends OutboundMessage {
  approval?: OutboundApproval;
  /** Email: the message this one answers (its Message-ID, without brackets). */
  inReplyTo?: string | null;
  /** Email: the subject of a new message (replies reuse the thread's). */
  subject?: string | null;
}

/** Optional parts of an adapter (the seam stays minimal). */
export interface ChannelAdapterExtras {
  /** The secrets a binding of this kind needs, by name. */
  readonly credentialNames?: readonly string[];
  /** Secrets the Hub makes itself at create time (a Telegram webhook secret token). */
  readonly generatedCredentials?: Readonly<Record<string, () => string>>;
  /** Settings a binding of this kind may hold (no secrets), beyond what probes learn. */
  readonly configKeys?: readonly string[];
  /** Whether the adapter can work at all. */
  availability?(): { available: boolean; detail: string | null };
  /** Check the credentials (connect, test). */
  probe?(bindingId: string, signal: AbortSignal): Promise<AdapterProbe>;
  /** The answer to a verified request that is not a message (Slack URL verification). */
  handshake?(rawBody: Uint8Array): Record<string, unknown> | null;
  /** After a button answer: update the prompt (drop its buttons, show the outcome). */
  settle?(
    bindingId: string,
    action: ChannelAction,
    outcome: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** After a refused button answer: tell the person who pressed it. */
  refuse?(
    bindingId: string,
    action: ChannelAction,
    text: string,
    signal: AbortSignal,
  ): Promise<void>;
  /** Approvals answered by message text from this channel (email: never, only by its link). */
  readonly textAnswers?: boolean;
  /**
   * M8: the credentials one binding uses, given its settings (email: a password, or an OAuth
   * client secret, which a public client does not have). Default: every `credentialNames`.
   */
  credentialsFor?(
    config: Record<string, string | null>,
  ): readonly { name: string; required: boolean }[];
  /** M8: fetch an inbound file (size-capped); throws a `validation` error saying why not. */
  download?(
    bindingId: string,
    file: InboundFileRef,
    signal: AbortSignal,
  ): Promise<InboundAttachment>;
  /** M8: send a file to a conversation (Telegram: a photo or a document). */
  sendFile?(bindingId: string, file: OutboundFile, signal: AbortSignal): Promise<ChannelReceipt>;
}

export type NovaChannelAdapter = ChannelAdapter & ChannelAdapterExtras;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Parse a JSON body, or a validation error (after authentication only). */
export function jsonBody(rawBody: Uint8Array): Record<string, unknown> {
  try {
    const v = JSON.parse(Buffer.from(rawBody).toString('utf8')) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new NovaError('validation', 'the body is not a JSON object');
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The service refused or could not be reached: the send failed. */
export function sendFailed(what: string, detail: string): NovaError {
  return new NovaError('server_error', `${what} failed: ${detail}`, {
    retryable: true,
    details: { reason: detail },
  });
}

export function notConfigured(what: string): NovaError {
  return new NovaError('capability_missing', `${what} is not configured`, {
    action: 'Add the credentials in Settings → Channels',
  });
}
