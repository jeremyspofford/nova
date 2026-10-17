// Webhook adapter (FR-088, docs/13 §4): a generic HTTP channel. Inbound posts carry the binding's
// bearer token and a signature (`sha256=` HMAC over `<timestamp>.<body>` with the binding's
// secret, `x-nova-timestamp` inside the replay window); both are checked in constant time.
// Replies are POSTed to the binding's callback URL, signed the same way, over https to a public
// address only (the scheduler's webhook transport: DNS is checked and pinned).
import { uuidv7 } from '@nova/shared';
import {
  httpsTransport,
  webhookUrlProblem,
  type WebhookTransport,
} from '../../scheduler/delivery.ts';
import type { ChannelReceipt, InboundMessage, OutboundMessage } from '../types.ts';
import {
  bearerOf,
  freshTimestamp,
  headerOf,
  safeEqual,
  signBody,
  unauthorized,
} from '../signing.ts';
import {
  jsonBody,
  notConfigured,
  obj,
  sendFailed,
  str,
  type BindingCredentials,
  type NovaChannelAdapter,
} from './common.ts';

export interface WebhookAdapterOptions {
  credentials: BindingCredentials;
  transport?: WebhookTransport;
  now?: () => Date;
  timeoutMs?: number;
}

export class WebhookAdapter implements NovaChannelAdapter {
  readonly kind = 'webhook' as const;
  readonly credentialNames = ['token', 'secret'] as const;
  readonly #creds: BindingCredentials;
  readonly #transport: WebhookTransport;
  readonly #now: () => Date;
  readonly #timeoutMs: number;

  constructor(opts: WebhookAdapterOptions) {
    this.#creds = opts.credentials;
    this.#transport = opts.transport ?? httpsTransport();
    this.#now = opts.now ?? (() => new Date());
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async parse(input: {
    bindingId: string;
    headers: Record<string, string | undefined>;
    rawBody: Uint8Array;
  }): Promise<InboundMessage | null> {
    const token = await this.#creds.secret(input.bindingId, 'token');
    const secret = await this.#creds.secret(input.bindingId, 'secret');
    if (!token || !secret) throw unauthorized('the webhook has no credentials');
    const given = bearerOf(input.headers);
    if (!given || !safeEqual(given, token)) throw unauthorized('bad token');
    const ts = headerOf(input.headers, 'x-nova-timestamp');
    const sig = headerOf(input.headers, 'x-nova-signature');
    if (!ts || !sig) throw unauthorized('missing signature');
    if (!freshTimestamp(ts, this.#now().getTime())) throw unauthorized('stale timestamp');
    if (!safeEqual(signBody(secret, ts, input.rawBody), sig)) throw unauthorized('bad signature');

    const body = jsonBody(input.rawBody);
    const id = str(body.id);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const from = obj(body.from);
    const sender = str(from.id);
    if (!id || !text || !sender) return null;
    const config = await this.#creds.config(input.bindingId);
    return {
      kind: 'webhook',
      conversation: str(body.conversation) ?? config.externalRef ?? input.bindingId,
      // A webhook gives no evidence of other readers: the binding's audience decides.
      visibility: 'private',
      sender: { externalId: sender, displayName: str(from.name) },
      addressed: true,
      text,
      messageId: id,
      threadRef: str(body.threadRef),
      receivedAt: this.#now().toISOString(),
    };
  }

  async send(
    bindingId: string,
    message: OutboundMessage,
    signal: AbortSignal,
  ): Promise<ChannelReceipt> {
    const config = await this.#creds.config(bindingId);
    const url = config.callbackUrl;
    if (!url) throw notConfigured('the callback URL of this webhook');
    const problem = webhookUrlProblem(url);
    if (problem) throw sendFailed('the webhook reply', problem);
    const secret = await this.#creds.secret(bindingId, 'secret');
    if (!secret) throw notConfigured('the webhook signing secret');
    const id = uuidv7();
    const sentAt = this.#now();
    const body = JSON.stringify({
      id,
      bindingId,
      conversation: message.conversation,
      threadRef: message.threadRef ?? null,
      text: message.text,
      sentAt: sentAt.toISOString(),
    });
    const timestamp = String(Math.floor(sentAt.getTime() / 1000));
    let status: number;
    try {
      ({ status } = await this.#transport({
        url: new URL(url),
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Nova channels',
          'x-nova-delivery': id,
          'x-nova-timestamp': timestamp,
          'x-nova-signature': signBody(secret, timestamp, body),
        },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
      }));
    } catch (err) {
      throw sendFailed('the webhook reply', err instanceof Error ? err.message : String(err));
    }
    if (status < 200 || status >= 300) throw sendFailed('the webhook reply', `HTTP ${status}`);
    return { id: `webhook:${id}`, at: sentAt.toISOString() };
  }
}
