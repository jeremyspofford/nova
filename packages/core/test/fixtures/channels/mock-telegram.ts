// A mock Telegram Bot API for the channel tests (offline, 127.0.0.1): `/bot<token>/<method>` for
// getMe, sendMessage, setWebhook, deleteWebhook, getUpdates (a queue the test fills),
// answerCallbackQuery and editMessageText; everything is recorded. Builders make updates and
// webhook deliveries carrying the secret-token header.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TelegramCall {
  method: string;
  body: Record<string, unknown>;
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
  message(m: {
    chat: number;
    chatType?: 'private' | 'group' | 'supergroup';
    from: number;
    text: string;
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

export async function startMockTelegram(
  opts: { botToken?: string; botId?: number; botUsername?: string } = {},
): Promise<MockTelegram> {
  const botToken = opts.botToken ?? '123456:ABCdefGhIJKlmnoPQRstuVWXyz0123456789';
  const botId = opts.botId ?? 123456;
  const botUsername = opts.botUsername ?? 'nova_test_bot';
  const calls: TelegramCall[] = [];
  const state: MockTelegram = {
    api: '',
    botToken,
    botId,
    botUsername,
    calls,
    of: (method) => calls.filter((c) => c.method === method).map((c) => c.body),
    queue: [],
    failNext: null,
    message: (m) => ({
      update_id: ++updateSeq,
      message: {
        message_id: m.messageId ?? ++messageSeq,
        date: 1_760_000_000,
        chat: { id: m.chat, type: m.chatType ?? (m.chat > 0 ? 'private' : 'group') },
        from: { id: m.from, is_bot: m.isBot ?? false, first_name: m.firstName ?? 'Jeremy' },
        text: m.text,
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
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
      if (!m || m[1] !== botToken)
        return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const method = m[2]!;
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        : {};
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
        default:
          return send(404, { ok: false, error_code: 404, description: 'Not Found' });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  state.api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = () => new Promise((r) => server.close(() => r()));
  return state;
}
