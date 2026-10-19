// Telegram adapter (FR-110, docs/13 §4): the Bot API over HTTPS. Inbound updates arrive either
// as webhook posts, authenticated by the `X-Telegram-Bot-Api-Secret-Token` header (the Hub makes
// the secret and registers it with `setWebhook` on connect), or by long polling (`getUpdates`)
// for a Hub without a public address; both feed the same parser. A private chat is private and
// always addresses the bot; groups, supergroups and channels are shared and address it only by a
// mention, a command for it, or a reply to its message. Bots' messages (ours included) are never
// returned. Approval prompts get an inline keyboard; a button press comes back as a callback
// query from the user who pressed it. The bot token is read from the secret store on each call
// and only ever appears in the request path, never in errors or logs.
// M8: photos, documents, voice and video notes are read. Parsing only names them (file id, size,
// type); the service downloads them (`getFile`, then the file URL, size-capped while reading)
// after the message passed every check. Outbound files go as photos (JPEG, PNG or WebP up to
// 10 MB) or documents (up to 50 MB).
import { randomBytes } from 'node:crypto';
import { NovaError } from '@nova/shared';
import type { ChannelReceipt } from '../types.ts';
import { MAX_CHANNEL_FILE_BYTES, tooLarge } from '../files.ts';
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
  type InboundAttachment,
  type InboundFileRef,
  type NovaChannelAdapter,
  type NovaInboundMessage,
  type NovaOutboundMessage,
  type OutboundFile,
} from './common.ts';

export const TELEGRAM_API = 'https://api.telegram.org';
/** Telegram's limit on one message's text. */
const MAX_TEXT = 4096;
/** Telegram's limit on a caption. */
const MAX_CAPTION = 1024;
/** What the Bot API takes as a photo upload, and as a document. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** A Bot API file path (`photos/file_1.jpg`): relative, no `..`, nothing to escape. */
const FILE_PATH = /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}$/;
/** Media that is not read, and how a turn names it. */
const NOT_READ: [string, string][] = [
  ['video', 'a video'],
  ['audio', 'an audio file'],
  ['animation', 'an animation'],
  ['sticker', 'a sticker'],
];
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
};
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
    const files = filesOf(m, messageId);
    if (!raw.trim() && !files.length) return null;
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
      ...(files.length ? { files } : {}),
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
   * Download an inbound file (M8): `getFile` names its path, then the file URL is read with the
   * size cap enforced while reading, whatever the service said it weighs. The URL holds the
   * token, so failures name the cause only.
   */
  async download(
    bindingId: string,
    file: InboundFileRef,
    signal: AbortSignal,
  ): Promise<InboundAttachment> {
    if (file.kind === 'unsupported')
      throw new NovaError('validation', `${file.name} is not read`, {
        details: { attachment: file.name, reason: 'type' },
      });
    if (file.size !== null && file.size > MAX_CHANNEL_FILE_BYTES)
      throw tooLarge(file.name, file.size);
    const info = obj(await this.#call(bindingId, 'getFile', { file_id: file.ref }, signal));
    const size = typeof info.file_size === 'number' ? info.file_size : null;
    if (size !== null && size > MAX_CHANNEL_FILE_BYTES) throw tooLarge(file.name, size);
    const path = str(info.file_path);
    if (!path || !FILE_PATH.test(path))
      throw new NovaError('validation', `"${file.name}" cannot be downloaded`, {
        details: { attachment: file.name, reason: 'unavailable' },
      });
    const token = await this.#creds.secret(bindingId, 'botToken');
    if (!token) throw notConfigured('the Telegram bot token');
    let res: Response;
    try {
      res = await this.#fetch(`${this.#api}/file/bot${token}/${path}`, {
        method: 'GET',
        signal,
        redirect: 'error',
      });
    } catch (err) {
      throw sendFailed('Telegram file download', err instanceof Error ? err.name : 'network error');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw sendFailed('Telegram file download', `HTTP ${res.status}`);
    }
    const bytes = await readCapped(res, file.name);
    return {
      name: file.name,
      mime: file.mime,
      bytes,
      ...(file.kind === 'voice' || file.kind === 'video_note'
        ? { note: { kind: file.kind, seconds: file.seconds ?? null } }
        : {}),
    };
  }

  /** Send a file (M8): a photo when Telegram takes it as one, otherwise a document. */
  async sendFile(
    bindingId: string,
    file: OutboundFile,
    signal: AbortSignal,
  ): Promise<ChannelReceipt> {
    if (file.bytes.length > MAX_DOCUMENT_BYTES)
      throw tooLarge(file.name, file.bytes.length, MAX_DOCUMENT_BYTES);
    const photo = PHOTO_MIMES.has(file.mime) && file.bytes.length <= MAX_PHOTO_BYTES;
    if (photo) {
      try {
        return await this.#sendMedia(bindingId, 'sendPhoto', 'photo', file, signal);
      } catch {
        // A photo Telegram refuses (its dimensions, its format) still goes as a document.
      }
    }
    return this.#sendMedia(bindingId, 'sendDocument', 'document', file, signal);
  }

  async #sendMedia(
    bindingId: string,
    method: 'sendPhoto' | 'sendDocument',
    field: 'photo' | 'document',
    file: OutboundFile,
    signal: AbortSignal,
  ): Promise<ChannelReceipt> {
    const form = new FormData();
    form.set('chat_id', file.conversation);
    if (file.threadRef && /^\d+$/.test(file.threadRef))
      form.set(
        'reply_parameters',
        JSON.stringify({ message_id: Number(file.threadRef), allow_sending_without_reply: true }),
      );
    if (file.caption) form.set('caption', file.caption.slice(0, MAX_CAPTION));
    form.set(field, new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
    const res = obj(await this.#call(bindingId, method, form, signal));
    const id = idOf(res.message_id);
    const chat = idOf(obj(res.chat).id) ?? file.conversation;
    return { id: `tg:${chat}:${id ?? '0'}`, at: this.#now().toISOString() };
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
    payload: Record<string, unknown> | FormData,
    signal: AbortSignal,
  ): Promise<unknown> {
    const token = await this.#creds.secret(bindingId, 'botToken');
    if (!token) throw notConfigured('the Telegram bot token');
    let res: Response;
    try {
      // A form (a file upload) sets its own multipart content type.
      res = await this.#fetch(`${this.#api}/bot${token}/${method}`, {
        method: 'POST',
        ...(payload instanceof FormData
          ? { body: payload }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
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

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** The files a message carries (M8), by kind; media that is not read is named so a turn knows. */
function filesOf(m: Record<string, unknown>, messageId: string): InboundFileRef[] {
  const out: InboundFileRef[] = [];
  const photos = (Array.isArray(m.photo) ? m.photo.map(obj) : []).filter((p) => str(p.file_id));
  if (photos.length) {
    // The sizes Telegram made of one photo: the largest within the cap (else the smallest, which
    // the download then refuses with its size).
    const area = (p: Record<string, unknown>) => (num(p.width) ?? 0) * (num(p.height) ?? 0);
    const fits = photos.filter((p) => (num(p.file_size) ?? 0) <= MAX_CHANNEL_FILE_BYTES);
    const pick = fits.length
      ? fits.reduce((a, b) => (area(b) > area(a) ? b : a))
      : photos.reduce((a, b) => (area(b) < area(a) ? b : a));
    out.push({
      ref: str(pick.file_id)!,
      kind: 'photo',
      name: `photo-${messageId}.jpg`,
      mime: 'image/jpeg',
      size: num(pick.file_size),
    });
  }
  // An animation also arrives as a document (for old clients): it is not read.
  const doc = obj(m.document);
  if (str(doc.file_id) && m.animation === undefined) {
    const name = str(doc.file_name) ?? `document-${messageId}`;
    const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
    out.push({
      ref: str(doc.file_id)!,
      kind: 'document',
      name,
      mime: str(doc.mime_type) ?? MIME_BY_EXT[ext] ?? 'application/octet-stream',
      size: num(doc.file_size),
    });
  }
  const voice = obj(m.voice);
  if (str(voice.file_id))
    out.push({
      ref: str(voice.file_id)!,
      kind: 'voice',
      name: `voice-${messageId}.ogg`,
      mime: 'audio/ogg',
      size: num(voice.file_size),
      seconds: num(voice.duration),
    });
  const note = obj(m.video_note);
  if (str(note.file_id))
    out.push({
      ref: str(note.file_id)!,
      kind: 'video_note',
      name: `video-note-${messageId}.mp4`,
      mime: 'video/mp4',
      size: num(note.file_size),
      seconds: num(note.duration),
    });
  for (const [key, label] of NOT_READ)
    if (m[key] !== undefined)
      out.push({ ref: '', kind: 'unsupported', name: label, mime: '', size: null });
  return out;
}

/** A response body, refused as soon as it passes the cap (a missing or false length included). */
async function readCapped(res: Response, name: string): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_CHANNEL_FILE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge(name, declared);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CHANNEL_FILE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(name, total);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
