// A mock Telegram Bot API for the channel tests (offline, 127.0.0.1): `/bot<token>/<method>` for
// getMe, sendMessage, setWebhook, deleteWebhook, getUpdates (a queue the test fills),
// answerCallbackQuery and editMessageText; everything is recorded. Builders make updates and
// webhook deliveries carrying the secret-token header. M8: files the test adds are served by
// getFile and `/file/bot<token>/<path>` (with the declared size the test chooses), and sendPhoto
// and sendDocument take multipart uploads, recorded in `uploads`.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
}

export interface TelegramUpload {
  method: string;
  chatId: string;
  name: string;
  mime: string;
  bytes: Buffer;
  caption: string | null;
  replyParameters: string | null;
}

export interface MockFile {
  fileId: string;
  /** The size getFile and the message say (default the real size). */
  size?: number;
  /** A path getFile returns (default `docs/<id>`). */
  path?: string;
}

export interface MockTelegram {
  /** The Bot API base, e.g. http://127.0.0.1:1234 */
  api: string;
  botToken: string;
  botId: number;
  botUsername: string;
  calls: TelegramCall[];
  /** Calls of one method. */
  of(method: string): Record<string, unknown>[];
  /** Updates `getUpdates` hands out (those with update_id >= offset). */
  queue: Record<string, unknown>[];
  /** Fail the next call of a method with this description. */
  failNext: { method: string; description: string; status?: number } | null;
  /** M8: multipart uploads (sendPhoto, sendDocument). */
  uploads: TelegramUpload[];
  /** M8: file downloads served, by path. */
  downloads: string[];
  /** M8: add a file the Bot API serves; returns what a message carries for it. */
  addFile(bytes: Buffer, opts?: { size?: number; path?: string }): MockFile;
  message(m: {
    chat: number;
    chatType?: 'private' | 'group' | 'supergroup';
    from: number;
    text?: string;
    caption?: string;
    photo?: MockFile[];
    document?: MockFile & { name?: string; mime?: string };
    voice?: MockFile & { duration?: number };
    videoNote?: MockFile & { duration?: number };
    /** Other message fields (a sticker, a video). */
    extra?: Record<string, unknown>;
    firstName?: string;
    isBot?: boolean;
    replyToBot?: boolean;
    messageId?: number;
  }): Record<string, unknown>;
  callback(c: {
    chat: number;
    chatType?: 'private' | 'group' | 'supergroup';
    from: number;
    data: string;
    messageId: number;
    text?: string;
  }): Record<string, unknown>;
  /** A webhook delivery of an update, with the secret-token header (or another one). */
  webhook(
    update: Record<string, unknown>,
    secret: string | null,
  ): { headers: Record<string, string>; rawBody: Uint8Array };
  close(): Promise<void>;
}

let updateSeq = 100;
let messageSeq = 1000;
let fileSeq = 1;

export async function startMockTelegram(
  opts: { botToken?: string; botId?: number; botUsername?: string } = {},
): Promise<MockTelegram> {
  const botToken = opts.botToken ?? '123456:ABCdefGhIJKlmnoPQRstuVWXyz0123456789';
  const botId = opts.botId ?? 123456;
  const botUsername = opts.botUsername ?? 'nova_test_bot';
  const calls: TelegramCall[] = [];
  const files = new Map<string, { bytes: Buffer; size: number; path: string }>();
  const byPath = new Map<string, Buffer>();
  const sized = (f: MockFile) => ({
    file_id: f.fileId,
    file_unique_id: `u${f.fileId}`,
    ...(f.size !== undefined ? { file_size: f.size } : {}),
  });
  const state: MockTelegram = {
    api: '',
    botToken,
    botId,
    botUsername,
    calls,
    of: (method) => calls.filter((c) => c.method === method).map((c) => c.body),
    queue: [],
    failNext: null,
    uploads: [],
    downloads: [],
    addFile: (bytes, opts = {}) => {
      const fileId = `f${fileSeq++}`;
      const path = opts.path ?? `docs/file_${fileId}`;
      const size = opts.size ?? bytes.length;
      files.set(fileId, { bytes, size, path });
      byPath.set(path, bytes);
      return { fileId, size, path };
    },
    message: (m) => ({
      update_id: ++updateSeq,
      message: {
        message_id: m.messageId ?? ++messageSeq,
        date: 1_760_000_000,
        chat: { id: m.chat, type: m.chatType ?? (m.chat > 0 ? 'private' : 'group') },
        from: { id: m.from, is_bot: m.isBot ?? false, first_name: m.firstName ?? 'Jeremy' },
        ...(m.text !== undefined ? { text: m.text } : {}),
        ...(m.caption !== undefined ? { caption: m.caption } : {}),
        ...(m.photo
          ? {
              photo: m.photo.map((p, i) => ({
                ...sized(p),
                width: 90 * (i + 1),
                height: 60 * (i + 1),
              })),
            }
          : {}),
        ...(m.document
          ? {
              document: {
                ...sized(m.document),
                ...(m.document.name ? { file_name: m.document.name } : {}),
                ...(m.document.mime ? { mime_type: m.document.mime } : {}),
              },
            }
          : {}),
        ...(m.voice
          ? {
              voice: { ...sized(m.voice), duration: m.voice.duration ?? 3, mime_type: 'audio/ogg' },
            }
          : {}),
        ...(m.videoNote
          ? {
              video_note: {
                ...sized(m.videoNote),
                duration: m.videoNote.duration ?? 4,
                length: 240,
              },
            }
          : {}),
        ...m.extra,
        ...(m.replyToBot
          ? { reply_to_message: { message_id: 1, from: { id: botId, is_bot: true } } }
          : {}),
      },
    }),
    callback: (c) => ({
      update_id: ++updateSeq,
      callback_query: {
        id: `cq${++messageSeq}`,
        from: { id: c.from, is_bot: false, first_name: 'Jeremy' },
        data: c.data,
        message: {
          message_id: c.messageId,
          chat: { id: c.chat, type: c.chatType ?? (c.chat > 0 ? 'private' : 'group') },
          text: c.text ?? 'Approval needed',
        },
      },
    }),
    webhook: (update, secret) => ({
      headers: {
        'content-type': 'application/json',
        ...(secret !== null ? { 'x-telegram-bot-api-secret-token': secret } : {}),
      },
      rawBody: new Uint8Array(Buffer.from(JSON.stringify(update))),
    }),
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void handle(Buffer.concat(chunks));
    });
    const handle = async (raw: Buffer) => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      // File downloads: /file/bot<token>/<path>
      const f = /^\/file\/bot([^/]+)\/(.+)$/.exec(req.url ?? '');
      if (f) {
        const bytes = f[1] === botToken ? byPath.get(f[2]!) : undefined;
        if (!bytes) return send(404, { ok: false, error_code: 404, description: 'Not Found' });
        state.downloads.push(f[2]!);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(bytes);
        return;
      }
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      if (!m || m[1] !== botToken)
        return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const method = m[2]!;
      let body: Record<string, unknown> = {};
      let upload: TelegramUpload | null = null;
      const type = String(req.headers['content-type'] ?? '');
      if (type.startsWith('multipart/form-data')) {
        const form = await new Response(new Uint8Array(raw), {
          headers: { 'content-type': type },
        }).formData();
        const field = method === 'sendPhoto' ? 'photo' : 'document';
        const file = form.get(field);
        const chat = form.get('chat_id');
        if (file instanceof File) {
          upload = {
            method,
            chatId: typeof chat === 'string' ? chat : '',
            name: file.name,
            mime: file.type,
            bytes: Buffer.from(await file.arrayBuffer()),
            caption:
              typeof form.get('caption') === 'string' ? (form.get('caption') as string) : null,
            replyParameters:
              typeof form.get('reply_parameters') === 'string'
                ? (form.get('reply_parameters') as string)
                : null,
          };
        }
        body = { chat_id: form.get('chat_id'), [field]: file instanceof Blob ? '<file>' : null };
      } else if (raw.length) body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      calls.push({ method, body });
      if (state.failNext?.method === method) {
        const f = state.failNext;
        state.failNext = null;
        return send(f.status ?? 400, {
          ok: false,
          error_code: f.status ?? 400,
          description: f.description,
        });
      }
      switch (method) {
        case 'getMe':
          return send(200, {
            ok: true,
            result: { id: botId, is_bot: true, first_name: 'Nova', username: botUsername },
          });
        case 'sendMessage':
          return send(200, {
            ok: true,
            result: {
              message_id: ++messageSeq,
              chat: { id: Number(body.chat_id) },
              text: body.text,
            },
          });
        case 'getUpdates': {
          const offset = typeof body.offset === 'number' ? body.offset : 0;
          // Confirming an offset drops the updates before it (Telegram's own rule).
          state.queue = state.queue.filter((u) => (u.update_id as number) >= offset);
          return send(200, { ok: true, result: state.queue.slice(0, 100) });
        }
        case 'setWebhook':
        case 'deleteWebhook':
        case 'answerCallbackQuery':
          return send(200, { ok: true, result: true });
        case 'editMessageText':
          return send(200, { ok: true, result: { message_id: body.message_id } });
        case 'getFile': {
          const file = files.get(String(body.file_id));
          if (!file)
            return send(400, {
              ok: false,
              error_code: 400,
              description: 'Bad Request: invalid file_id',
            });
          return send(200, {
            ok: true,
            result: {
              file_id: body.file_id,
              file_unique_id: `u${String(body.file_id)}`,
              file_size: file.size,
              file_path: file.path,
            },
          });
        }
        case 'sendPhoto':
        case 'sendDocument':
          if (!upload)
            return send(400, { ok: false, error_code: 400, description: 'Bad Request: no file' });
          // Recorded only when accepted (a refused photo is not an upload).
          state.uploads.push(upload);
          return send(200, {
            ok: true,
            result: { message_id: ++messageSeq, chat: { id: Number(body.chat_id) } },
          });
        default:
          return send(404, { ok: false, error_code: 404, description: 'Not Found' });
      }
    };
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}
