// Telegram adapter (FR-110, docs/13 §4): the Bot API over HTTPS. Inbound updates arrive either
// as webhook posts, authenticated by the `X-Telegram-Bot-Api-Secret-Token` header (the Hub makes
// the secret and registers it with `setWebhook` on connect), or by long polling (`getUpdates`)
// for a Hub without a public address; both feed the same parser. A private chat is private and
// always addresses the bot; groups, supergroups and channels are shared and address it only by a
// mention, a command for it, or a reply to its message. Bots' messages (ours included) are never
// returned. Approval prompts get an inline keyboard; a button press comes back as a callback
// query from the user who pressed it. The bot token is read from the secret store on each call
// and only ever appears in the request path, never in errors or logs.
import { randomBytes } from 'node:crypto';
import type { ChannelReceipt } from '../types.ts';
import { headerOf, safeEqual, unauthorized } from '../signing.ts';
import {
  jsonBody,
  notConfigured,
  obj,
  sendFailed,
  str,
  type AdapterProbe,
  type BindingCredentials,
  type ChannelAction,
  type FetchLike,
  type NovaChannelAdapter,
  type NovaInboundMessage,
  type NovaOutboundMessage,
} from './common.ts';

export const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram's limit on one message's text. */
const MAX_TEXT = 4096;
const ALLOWED_UPDATES = ['message', 'callback_query'];

/** Callback data is at most 64 bytes: `nova:a:<approval id>:<decision letter>`. */
const DECISION_LETTERS: Record<ChannelAction['decision'], string> = {
  allow_once: 'o',
  allow_session: 's',
  deny_continue: 'd',
  deny_stop: 'x',
};
const BUTTON_TEXT: Record<ChannelAction['decision'], string> = {
  allow_once: 'Allow',
  allow_session: 'Allow for session',
  deny_continue: 'Deny',
  deny_stop: 'Deny and stop',
};
const CALLBACK = /^nova:a:([0-9a-f-]{36}):([osdx])$/;

export interface TelegramAdapterOptions {
  credentials: BindingCredentials;
  /** The Bot API base (tests point it at a mock server). */
  apiBase?: string;
  fetch?: FetchLike;
  now?: () => Date;
  /** The public address of a binding's inbound endpoint, for `setWebhook`; null when none. */
  webhookUrl?: (bindingId: string) => Promise<string | null>;
}

export class TelegramAdapter implements NovaChannelAdapter {
  readonly kind = 'telegram' as const;
  readonly credentialNames = ['botToken', 'webhookSecret'] as const;
  readonly generatedCredentials = {
    // Telegram accepts 1-256 characters of A-Z, a-z, 0-9, _ and -.
    webhookSecret: () => randomBytes(32).toString('base64url'),
  };
  readonly configKeys = ['mode', 'botUserId', 'botUsername'] as const;
  readonly #creds: BindingCredentials;
  readonly #api: string;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #webhookUrl: (bindingId: string) => Promise<string | null>;

  constructor(opts: TelegramAdapterOptions) {
    this.#creds = opts.credentials;
    this.#api = (opts.apiBase ?? TELEGRAM_API).replace(/\/+$/, '');
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? (() => new Date());
    this.#webhookUrl = opts.webhookUrl ?? (() => Promise.resolve(null));
  }

  async parse(input: {
    bindingId: string;
    headers: Record<string, string | undefined>;
    rawBody: Uint8Array;
  }): Promise<NovaInboundMessage | null> {
    const secret = await this.#creds.secret(input.bindingId, 'webhookSecret');
    if (!secret) throw unauthorized('no webhook secret is configured');
    const given = headerOf(input.headers, 'x-telegram-bot-api-secret-token');
    if (!given) throw unauthorized('missing secret token');
    if (!safeEqual(given, secret)) throw unauthorized('bad secret token');
    return this.parseUpdate(input.bindingId, jsonBody(input.rawBody));
  }

  /** One update, from a verified webhook post or our own `getUpdates` call. */
  async parseUpdate(
    bindingId: string,
    update: Record<string, unknown>,
  ): Promise<NovaInboundMessage | null> {
    const config = await this.#creds.config(bindingId);
    const botId = config.botUserId ?? null;
    const cq = obj(update.callback_query);
    if (update.callback_query !== undefined) return this.#callback(cq);
    if (update.message === undefined) return null;
    const m = obj(update.message);
    const from = obj(m.from);
    const chat = obj(m.chat);
    // Loop prevention: nothing a bot wrote (our replies included) is a message to answer.
    if (from.is_bot === true) return null;
    const userId = idOf(from.id);
    const chatId = idOf(chat.id);
    const messageId = idOf(m.message_id);
    if (!userId || !chatId || !messageId) return null;
    if (botId && userId === botId) return null;
    const raw =
      typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '';
    if (!raw.trim()) return null;
    const direct = chat.type === 'private';
    const username = config.botUsername ?? null;
    const mention = username ? `@${username}` : null;
    const reply = obj(m.reply_to_message);
    const repliedToBot = !!botId && idOf(obj(reply.from).id) === botId;
    const mentioned = mention !== null && raw.toLowerCase().includes(mention.toLowerCase());
    const text = (mention ? raw.replace(new RegExp(escapeRe(mention), 'gi'), ' ') : raw)
      .replace(/\s+/g, ' ')
      .trim();
    const name = [str(from.first_name), str(from.last_name)].filter(Boolean).join(' ');
    return {
      kind: 'telegram',
      conversation: chatId,
      visibility: direct ? 'private' : 'shared',
      sender: { externalId: userId, displayName: name || str(from.username) },
      addressed: direct || mentioned || repliedToBot,
      text,
      messageId: `${chatId}:${messageId}`,
      // In a group the reply quotes the message it answers; a private chat needs no quoting.
      threadRef: direct ? null : messageId,
      receivedAt: this.#now().toISOString(),
    };
  }

  #callback(cq: Record<string, unknown>): NovaInboundMessage | null {
    const id = str(cq.id);
    const data = str(cq.data);
    const from = obj(cq.from);
    const message = obj(cq.message);
    const chat = obj(message.chat);
    const userId = idOf(from.id);
    const chatId = idOf(chat.id);
    const messageId = idOf(message.message_id);
    if (!id || !data || !userId || !chatId || !messageId || from.is_bot === true) return null;
    const m = CALLBACK.exec(data);
    if (!m) return null;
    const decision = (Object.keys(DECISION_LETTERS) as ChannelAction['decision'][]).find(
      (d) => DECISION_LETTERS[d] === m[2],
    )!;
    const name = [str(from.first_name), str(from.last_name)].filter(Boolean).join(' ');
    return {
      kind: 'telegram',
      conversation: chatId,
      visibility: chat.type === 'private' ? 'private' : 'shared',
      sender: { externalId: userId, displayName: name || str(from.username) },
      addressed: true,
      text: '',
      messageId: `cb:${id}`,
      threadRef: null,
      receivedAt: this.#now().toISOString(),
      action: {
        kind: 'approval',
        approvalId: m[1]!,
        decision,
        ref: { callbackId: id, chatId, messageId },
        promptText: typeof message.text === 'string' ? message.text : null,
      },
    };
  }

  async send(
    bindingId: string,
    message: NovaOutboundMessage,
    signal: AbortSignal,
  ): Promise<ChannelReceipt> {
    const text =
      message.text.length > MAX_TEXT ? `${message.text.slice(0, MAX_TEXT - 1)}…` : message.text;
    const body: Record<string, unknown> = { chat_id: message.conversation, text };
    if (message.threadRef && /^\d+$/.test(message.threadRef))
      body.reply_parameters = {
        message_id: Number(message.threadRef),
        allow_sending_without_reply: true,
      };
    if (message.approval?.options.length)
      body.reply_markup = {
        inline_keyboard: [
          message.approval.options.map((d) => ({
            text: BUTTON_TEXT[d],
            callback_data: `nova:a:${message.approval!.id}:${DECISION_LETTERS[d]}`,
          })),
        ],
      };
    const res = obj(await this.#call(bindingId, 'sendMessage', body, signal));
    const id = idOf(res.message_id);
    const chat = idOf(obj(res.chat).id) ?? message.conversation;
    // Telegram message ids are small per-chat counters: the receipt names the chat too.
    return { id: `tg:${chat}:${id ?? '0'}`, at: this.#now().toISOString() };
  }

  /** Drop the prompt's buttons, show the outcome under it, and stop the client's spinner. */
  async settle(
    bindingId: string,
    action: ChannelAction,
    outcome: string,
    signal: AbortSignal,
  ): Promise<void> {
    const { callbackId, chatId, messageId } = action.ref;
    if (callbackId)
      await this.#call(
        bindingId,
        'answerCallbackQuery',
        { callback_query_id: callbackId, text: outcome.slice(0, 200) },
        signal,
      ).catch(() => undefined);
    if (chatId && messageId) {
      const text = action.promptText ? `${action.promptText}\n\n${outcome}` : outcome;
      await this.#call(
        bindingId,
        'editMessageText',
        {
          chat_id: chatId,
          message_id: Number(messageId),
          text: text.slice(0, MAX_TEXT),
          reply_markup: { inline_keyboard: [] },
        },
        signal,
      ).catch(() => undefined);
    }
  }

  /** Answer a press that changed nothing (refused), so the client stops waiting. */
  async refuse(bindingId: string, action: ChannelAction, text: string, signal: AbortSignal) {
    if (action.ref.callbackId)
      await this.#call(
        bindingId,
        'answerCallbackQuery',
        { callback_query_id: action.ref.callbackId, text: text.slice(0, 200), show_alert: true },
        signal,
      ).catch(() => undefined);
  }

  /**
   * `getMe` (the token works; learns the bot's id and username for mentions and loop prevention),
   * then the delivery mode: `setWebhook` with the secret token at the public inbound address, or
   * `deleteWebhook` so long polling can run.
   */
  async probe(bindingId: string, signal: AbortSignal): Promise<AdapterProbe> {
    try {
      const me = obj(await this.#call(bindingId, 'getMe', {}, signal));
      const learned: Record<string, string> = {};
      const id = idOf(me.id);
      const username = str(me.username);
      if (id) learned.botUserId = id;
      if (username) learned.botUsername = username;
      const config = await this.#creds.config(bindingId);
      const who = username ? `@${username}` : 'the bot';
      if ((config.mode ?? 'polling') === 'webhook') {
        const url = await this.#webhookUrl(bindingId);
        if (!url?.startsWith('https://'))
          return {
            ok: false,
            detail: 'webhook mode needs an https public address (channels.publicUrl)',
            learned,
          };
        const secret = await this.#creds.secret(bindingId, 'webhookSecret');
        if (!secret) return { ok: false, detail: 'the webhook secret is missing', learned };
        await this.#call(
          bindingId,
          'setWebhook',
          { url, secret_token: secret, allowed_updates: ALLOWED_UPDATES },
          signal,
        );
        return { ok: true, detail: `connected as ${who} (webhook)`, learned };
      }
      await this.#call(bindingId, 'deleteWebhook', { drop_pending_updates: false }, signal);
      return { ok: true, detail: `connected as ${who} (polling)`, learned };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Long polling: the updates after `offset` (waits up to `timeoutSeconds` for one). */
  async poll(
    bindingId: string,
    offset: number,
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    const res = await this.#call(
      bindingId,
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ALLOWED_UPDATES },
      signal,
    );
    return Array.isArray(res) ? res.map(obj) : [];
  }

  async #call(
    bindingId: string,
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const token = await this.#creds.secret(bindingId, 'botToken');
    if (!token) throw notConfigured('the Telegram bot token');
    let res: Response;
    try {
      res = await this.#fetch(`${this.#api}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      // The URL holds the token: report the cause only.
      throw sendFailed(`Telegram ${method}`, err instanceof Error ? err.name : 'network error');
    }
    let body: Record<string, unknown> = {};
    try {
      body = obj(await res.json());
    } catch {
      // handled below
    }
    if (!res.ok || body.ok !== true)
      throw sendFailed(
        `Telegram ${method}`,
        (str(body.description) ?? `HTTP ${res.status}`).slice(0, 200),
      );
    return body.result;
  }
}

function idOf(v: unknown): string | null {
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  if (typeof v === 'string' && /^-?\d{1,20}$/.test(v)) return v;
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
