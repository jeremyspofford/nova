// A mock Slack for the channel tests and the J7 journey (offline): an in-process Web API that
// answers `auth.test` and `chat.postMessage` for one bot token and records what was posted, and
// signed Events API deliveries (`v0=` HMAC-SHA256 of `v0:<ts>:<body>` with the signing secret)
// for the Hub's inbound endpoint.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SlackPost {
  channel: string;
  text: string;
  thread_ts?: string;
  ts: string;
}

export interface MockSlack {
  /** The Web API base, e.g. http://127.0.0.1:1234/api */
  api: string;
  posts: SlackPost[];
  botToken: string;
  signingSecret: string;
  botUserId: string;
  /** A signed Events API delivery of a message event. */
  message(
    m: {
      channel: string;
      user: string;
      text: string;
      ts?: string;
      channelType?: 'im' | 'channel' | 'group' | 'mpim';
      type?: 'message' | 'app_mention';
      threadTs?: string;
      botId?: string;
      subtype?: string;
    },
    opts?: { secret?: string; timestamp?: number },
  ): { headers: Record<string, string>; rawBody: Uint8Array };
  /** Sign any body (URL verification, tampering tests). */
  sign(
    body: string,
    opts?: { secret?: string; timestamp?: number },
  ): {
    headers: Record<string, string>;
    rawBody: Uint8Array;
  };
  close(): Promise<void>;
}

let seq = 1000;

export async function startMockSlack(
  opts: { botToken?: string; signingSecret?: string; botUserId?: string; now?: () => number } = {},
): Promise<MockSlack> {
  const botToken = opts.botToken ?? 'xoxb-test-token-0001';
  const signingSecret = opts.signingSecret ?? 'slack-signing-secret-01';
  const botUserId = opts.botUserId ?? 'UBOT';
  const now = opts.now ?? (() => Date.now());
  const posts: SlackPost[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const send = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${botToken}`)
        return send({ ok: false, error: 'invalid_auth' });
      const body = chunks.length
        ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
        : {};
      if (req.url === '/api/auth.test')
        return send({ ok: true, user_id: botUserId, user: 'nova', team_id: 'T1' });
      if (req.url === '/api/chat.postMessage') {
        if (typeof body.channel !== 'string' || typeof body.text !== 'string')
          return send({ ok: false, error: 'invalid_arguments' });
        const ts = `${Math.floor(now() / 1000)}.${String(++seq).padStart(6, '0')}`;
        const post: SlackPost = { channel: body.channel, text: body.text, ts };
        if (typeof body.thread_ts === 'string') post.thread_ts = body.thread_ts;
        posts.push(post);
        return send({ ok: true, channel: body.channel, ts });
      }
      send({ ok: false, error: 'unknown_method' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const sign = (body: string, o: { secret?: string; timestamp?: number } = {}) => {
    const ts = String(o.timestamp ?? Math.floor(now() / 1000));
    const sig = `v0=${createHmac('sha256', o.secret ?? signingSecret)
      .update(`v0:${ts}:${body}`)
      .digest('hex')}`;
    return {
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts,
        'x-slack-signature': sig,
      },
      rawBody: new Uint8Array(Buffer.from(body)),
    };
  };
  return {
    api: `http://127.0.0.1:${port}/api`,
    posts,
    botToken,
    signingSecret,
    botUserId,
    sign,
    message: (m, o) => {
      const ts = m.ts ?? `${Math.floor(now() / 1000)}.${String(++seq).padStart(6, '0')}`;
      const event: Record<string, unknown> = {
        type: m.type ?? 'message',
        channel: m.channel,
        user: m.user,
        text: m.text,
        ts,
        channel_type: m.channelType ?? (m.channel.startsWith('D') ? 'im' : 'channel'),
      };
      if (m.threadTs) event.thread_ts = m.threadTs;
      if (m.botId) event.bot_id = m.botId;
      if (m.subtype) event.subtype = m.subtype;
      return sign(
        JSON.stringify({ type: 'event_callback', team_id: 'T1', event_id: `Ev${ts}`, event }),
        o,
      );
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
