// A mock Slack for E2E journeys (J7): the Web API methods the Hub calls (`auth.test` when a binding
// connects or is tested, `chat.postMessage` for replies) and signed Events API deliveries to a
// binding's inbound URL, the way Slack signs them (`v0=` HMAC-SHA256 of `v0:<ts>:<body>` with the
// app's signing secret). The Hub reaches this server through e2e/support/slack-api-redirect.ts.
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SlackPost {
  method: string;
  channel: string;
  text: string;
  threadTs: string | null;
  /** The bearer token the Hub sent. */
  token: string;
}

export interface SlackDelivery {
  status: number;
  body: unknown;
}

export interface MockSlack {
  /** The Web API base the Hub's redirect points at, e.g. http://127.0.0.1:1234/api. */
  api: string;
  readonly botUserId: string;
  readonly teamId: string;
  /** Messages the Hub posted, oldest first. */
  posts: SlackPost[];
  /** Send a signed `event_callback` with this event to a binding's inbound URL. */
  deliver(
    inboundUrl: string,
    signingSecret: string,
    event: Record<string, unknown>,
    opts?: { unsigned?: boolean },
  ): Promise<SlackDelivery>;
  /** A person's direct message to the bot in the DM conversation `channel`. */
  dm(user: string, channel: string, text: string): Record<string, unknown>;
  /** A person's message in a shared channel that mentions the bot. */
  mention(user: string, channel: string, text: string): Record<string, unknown>;
  stop(): Promise<void>;
}

export const SLACK_BOT_TOKEN = 'xoxb-e2e-bot-token';
export const SLACK_SIGNING_SECRET = 'e2e-signing-secret-0123456789';

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

const decode = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export async function startMockSlack(): Promise<MockSlack> {
  const botUserId = 'UNOVABOT';
  const teamId = 'TE2E';
  const posts: SlackPost[] = [];
  let seq = 1_700_000_000;
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (token !== SLACK_BOT_TOKEN) return reply(200, { ok: false, error: 'invalid_auth' });
      const method = (req.url ?? '').replace(/^\/api\//, '').split('?')[0] ?? '';
      if (method === 'auth.test')
        return reply(200, { ok: true, user: 'nova', user_id: botUserId, team_id: teamId });
      if (method === 'chat.postMessage') {
        const ts = `${++seq}.000100`;
        posts.push({
          method,
          channel: typeof body.channel === 'string' ? body.channel : '',
          text: decode(typeof body.text === 'string' ? body.text : ''),
          threadTs: typeof body.thread_ts === 'string' ? body.thread_ts : null,
          token,
        });
        return reply(200, { ok: true, channel: body.channel, ts });
      }
      return reply(200, { ok: false, error: 'unknown_method' });
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  let eventSeq = 0;
  const nextTs = () => `${Math.floor(Date.now() / 1000)}.${String(++eventSeq).padStart(6, '0')}`;

  return {
    api: `http://127.0.0.1:${port}/api`,
    botUserId,
    teamId,
    posts,
    async deliver(inboundUrl, signingSecret, event, opts = {}) {
      const body = JSON.stringify({
        token: 'deprecated',
        team_id: teamId,
        type: 'event_callback',
        event_id: `Ev${++eventSeq}`,
        event_time: Math.floor(Date.now() / 1000),
        event,
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = `v0=${createHmac('sha256', signingSecret).update(`v0:${ts}:${body}`).digest('hex')}`;
      const res = await fetch(inboundUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(opts.unsigned ? {} : { 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }),
        },
        body,
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        // not JSON
      }
      return { status: res.status, body: parsed };
    },
    dm: (user, channel, text) => ({
      type: 'message',
      channel_type: 'im',
      channel,
      user,
      text,
      ts: nextTs(),
    }),
    mention: (user, channel, text) => ({
      type: 'app_mention',
      channel_type: 'channel',
      channel,
      user,
      text: `<@${botUserId}> ${text}`,
      ts: nextTs(),
    }),
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}
