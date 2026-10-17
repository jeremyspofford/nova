// M6 seams: channels (FR-088, docs/13 §4) and event triggers (FR-056, FR-201, docs/09 §7).
// A channel binding maps one external conversation to one thread of an agent; all channel
// content is untrusted (FR-103, FR-189). Lead-owned: request changes.

export type ChannelKind = 'inapp' | 'slack' | 'teams' | 'email' | 'webhook' | 'telegram';

/** A message that arrived on a channel, normalized by its adapter. Untrusted. */
export interface InboundMessage {
  kind: ChannelKind;
  /** The adapter's id of the external conversation (Slack channel or DM id, email address). */
  conversation: string;
  /** Whether the conversation is private to the owner (a DM) or shared (FR-088, docs/13 §4). */
  visibility: 'private' | 'shared';
  /** The external sender; mapped to a Nova identity or ignored when unknown. */
  sender: { externalId: string; displayName: string | null };
  /** Was the agent addressed (mention, DM)? Unaddressed messages never start a turn. */
  addressed: boolean;
  text: string;
  /** Dedupe key: the adapter's message id. */
  messageId: string;
  /** Reply threading inside the external conversation, when the channel has it. */
  threadRef: string | null;
  receivedAt: string;
}

export interface OutboundMessage {
  conversation: string;
  threadRef?: string | null;
  text: string;
}

/** A delivery receipt (FR-187): the channel's own id for the sent message. */
export interface ChannelReceipt {
  id: string;
  at: string;
}

/**
 * One channel kind's connection: verifies inbound requests (signatures, tokens), normalizes
 * them, and sends replies. Adapters never decide policy; the channels area does.
 */
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** Verify and parse an inbound HTTP delivery; null when it is not a message (a ping). */
  parse(input: {
    bindingId: string;
    headers: Record<string, string | undefined>;
    rawBody: Uint8Array;
  }): Promise<InboundMessage | null>;
  send(bindingId: string, message: OutboundMessage, signal: AbortSignal): Promise<ChannelReceipt>;
}

/** Where agents' turns reply to: the channels area delivers a reply for a thread's binding. */
export interface ChannelSender {
  replyFor(accountId: string, threadId: string, text: string): Promise<ChannelReceipt | null>;
}
