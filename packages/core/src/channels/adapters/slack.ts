// Slack adapter (FR-088, docs/13 §4): Events API deliveries in, chat.postMessage out. Every
// delivery must carry the app's signing signature (`v0=` HMAC-SHA256 over `v0:<ts>:<body>`) and
// a timestamp inside the five-minute replay window. Direct messages are private, everything else
// is shared; a DM or a mention of the bot addresses the agent. Messages written by bots (the
// agent's own replies included) and edits are never returned, so they cannot start a turn. The
// bot token and signing secret come from the secret store on each use.
import { uuidv7 } from '@nova/shared';
import type { ChannelReceipt, InboundMessage, OutboundMessage } from '../types.ts';
import { freshTimestamp, hmacHex, headerOf, safeEqual, unauthorized } from '../signing.ts';
import {
  jsonBody,
  notConfigured,
  obj,
  sendFailed,
  str,
  type AdapterProbe,
  type BindingCredentials,
  type FetchLike,
  type NovaChannelAdapter,
} from './common.ts';

export const SLACK_API = 'https://slack.com/api';

export interface SlackAdapterOptions {
  credentials: BindingCredentials;
  /** The Web API base (tests point it at a mock server). */
  apiBase?: string;
  fetch?: FetchLike;
  now?: () => Date;
}

/** Message subtypes that are still a person writing (others are edits, joins, bots). */
const PERSON_SUBTYPES = new Set(['thread_broadcast', 'file_share']);

/** Slack escapes &, < and > in message text. */
function decode(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function encode(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class SlackAdapter implements NovaChannelAdapter {
  readonly kind = 'slack' as const;
  readonly credentialNames = ['botToken', 'signingSecret'] as const;
  readonly #creds: BindingCredentials;
  readonly #api: string;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;

  constructor(opts: SlackAdapterOptions) {
    this.#creds = opts.credentials;
    this.#api = (opts.apiBase ?? SLACK_API).replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? (() => new Date());
  }

  async parse(input: {
    bindingId: string;
    headers: Record<string, string | undefined>;
    rawBody: Uint8Array;
  }): Promise<InboundMessage | null> {
    const secret = await this.#creds.secret(input.bindingId, 'signingSecret');
    if (!secret) throw unauthorized('no signing secret is configured');
    const ts = headerOf(input.headers, 'x-slack-request-timestamp');
    const sig = headerOf(input.headers, 'x-slack-signature');
    if (!ts || !sig) throw unauthorized('missing signature');
    if (!/^\d{1,12}$/.test(ts) || !freshTimestamp(ts, this.#now().getTime()))
      throw unauthorized('stale timestamp');
    const base = Buffer.concat([Buffer.from(`v0:${ts}:`), Buffer.from(input.rawBody)]);
    if (!safeEqual(`v0=${hmacHex(secret, base)}`, sig)) throw unauthorized('bad signature');

    const body = jsonBody(input.rawBody);
    if (body.type !== 'event_callback') return null;
    const ev = obj(body.event);
    if (ev.type !== 'message' && ev.type !== 'app_mention') return null;
    const subtype = str(ev.subtype);
    if (subtype && !PERSON_SUBTYPES.has(subtype)) return null;
    // Loop prevention: nothing a bot wrote (our own replies included) is a message to answer.
    if (ev.bot_id !== undefined || ev.bot_profile !== undefined) return null;
    const user = str(ev.user);
    const channel = str(ev.channel);
    const ts2 = str(ev.ts);
    if (!user || !channel || !ts2) return null;
    const config = await this.#creds.config(input.bindingId);
    const botUserId = config.botUserId ?? null;
    if (botUserId && user === botUserId) return null;

    const raw = decode(typeof ev.text === 'string' ? ev.text : '');
    const direct = ev.channel_type === 'im';
    const mention = botUserId ? `<@${botUserId}>` : null;
    const mentioned = ev.type === 'app_mention' || (mention !== null && raw.includes(mention));
    const text = (mention ? raw.split(mention).join(' ') : raw).replace(/\s+/g, ' ').trim();
    return {
      kind: 'slack',
      conversation: channel,
      visibility: direct ? 'private' : 'shared',
      sender: { externalId: user, displayName: null },
      addressed: direct || mentioned,
      text,
      // A mention arrives as both `message` and `app_mention`; the ts identifies the message.
      messageId: `${channel}:${ts2}`,
      threadRef: str(ev.thread_ts) ?? (direct ? null : ts2),
      receivedAt: this.#now().toISOString(),
    };
  }

  /** The URL verification Slack sends when the Request URL is set (after the signature check). */
  handshake(rawBody: Uint8Array): Record<string, unknown> | null {
    try {
      const body = jsonBody(rawBody);
      if (body.type === 'url_verification' && typeof body.challenge === 'string')
        return { challenge: body.challenge };
    } catch {
      // not JSON: no handshake
    }
    return null;
  }

  async send(
    bindingId: string,
    message: OutboundMessage,
    signal: AbortSignal,
  ): Promise<ChannelReceipt> {
    const res = await this.#call(
      bindingId,
      'chat.postMessage',
      {
        channel: message.conversation,
        text: encode(message.text),
        ...(message.threadRef ? { thread_ts: message.threadRef } : {}),
      },
      signal,
    );
    const ts = str(res.ts);
    return { id: ts ?? `slack:${uuidv7()}`, at: this.#now().toISOString() };
  }

  /** `auth.test`: the token works; learns the bot user id (mentions, loop prevention) and team. */
  async probe(bindingId: string, signal: AbortSignal): Promise<AdapterProbe> {
    try {
      const res = await this.#call(bindingId, 'auth.test', {}, signal);
      const learned: Record<string, string> = {};
      const userId = str(res.user_id);
      const team = str(res.team_id);
      if (userId) learned.botUserId = userId;
      if (team) learned.teamId = team;
      return { ok: true, detail: `connected as ${str(res.user) ?? userId ?? 'the bot'}`, learned };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async #call(
    bindingId: string,
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const token = await this.#creds.secret(bindingId, 'botToken');
    if (!token) throw notConfigured('the Slack bot token');
    let res: Response;
    try {
      res = await this.#fetch(`${this.#api}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      throw sendFailed(`Slack ${method}`, err instanceof Error ? err.message : String(err));
    }
    let body: Record<string, unknown> = {};
    try {
      body = obj(await res.json());
    } catch {
      // handled below
    }
    if (!res.ok || body.ok !== true)
      throw sendFailed(`Slack ${method}`, str(body.error) ?? `HTTP ${res.status}`);
    return body;
  }
}
