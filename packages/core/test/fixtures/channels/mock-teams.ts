// A mock Microsoft Teams (Bot Framework) for the channel tests (offline): an in-process server
// with an OpenID metadata document and signing keys, a token endpoint (client credentials), and
// the connector's activities endpoint, which records replies. `activity()` builds an inbound
// activity with a bearer JWT signed by the mock's key (RS256, issuer and audience as the Bot
// Framework sets them, and the `serviceUrl` claim).
import { generateKeyPairSync, sign as rsaSign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TeamsReply {
  conversation: string;
  replyToId: string | null;
  text: string;
  id: string;
}

export interface MockTeams {
  base: string;
  openIdUrl: string;
  tokenUrl: string;
  /** The service URL activities name (this server). */
  serviceUrl: string;
  appId: string;
  appPassword: string;
  replies: TeamsReply[];
  tokenRequests: number;
  activity(
    a: {
      conversation: string;
      conversationType?: 'personal' | 'channel' | 'groupChat';
      from: string;
      fromName?: string;
      text: string;
      id?: string;
      mention?: boolean;
      type?: string;
    },
    opts?: { audience?: string; expiresIn?: number; key?: KeyObject; serviceUrlClaim?: string },
  ): { headers: Record<string, string>; rawBody: Uint8Array };
  close(): Promise<void>;
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
let seq = 0;

export async function startMockTeams(
  opts: { appId?: string; appPassword?: string } = {},
): Promise<MockTeams> {
  const appId = opts.appId ?? 'app-0001';
  const appPassword = opts.appPassword ?? 'teams-app-password-01';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const replies: TeamsReply[] = [];
  const state = { tokenRequests: 0 };
  let base = '';
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? '/';
      if (url === '/openid') return json(200, { jwks_uri: `${base}/keys` });
      if (url === '/keys') return json(200, { keys: [jwk] });
      if (url === '/token') {
        state.tokenRequests++;
        const form = new URLSearchParams(raw);
        if (form.get('client_id') !== appId || form.get('client_secret') !== appPassword)
          return json(401, { error: 'invalid_client' });
        return json(200, { access_token: 'teams-access-token', expires_in: 3600 });
      }
      const m = /^\/v3\/conversations\/([^/]+)\/activities(?:\/([^/]+))?$/.exec(url);
      if (m && req.method === 'POST') {
        if (req.headers.authorization !== 'Bearer teams-access-token')
          return json(401, { error: 'unauthorized' });
        const body = JSON.parse(raw) as { text: string; replyToId?: string };
        const id = `reply-${++seq}`;
        replies.push({
          conversation: decodeURIComponent(m[1]!),
          replyToId: m[2] ? decodeURIComponent(m[2]) : null,
          text: body.text,
          id,
        });
        return json(201, { id });
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const serviceUrl = `${base}/`;
  return {
    base,
    openIdUrl: `${base}/openid`,
    tokenUrl: `${base}/token`,
    serviceUrl,
    appId,
    appPassword,
    replies,
    get tokenRequests() {
      return state.tokenRequests;
    },
    activity: (a, o = {}) => {
      const nowS = Math.floor(Date.now() / 1000);
      const header = b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
      const claims = b64({
        iss: 'https://api.botframework.com',
        aud: o.audience ?? appId,
        nbf: nowS - 10,
        exp: nowS + (o.expiresIn ?? 3600),
        serviceUrl: o.serviceUrlClaim ?? serviceUrl,
      });
      const sig = rsaSign('RSA-SHA256', Buffer.from(`${header}.${claims}`), o.key ?? privateKey);
      const token = `${header}.${claims}.${sig.toString('base64url')}`;
      const activity = {
        type: a.type ?? 'message',
        id: a.id ?? `act-${++seq}`,
        serviceUrl,
        channelId: 'msteams',
        from: { id: a.from, name: a.fromName ?? a.from },
        recipient: { id: 'bot-1', name: 'Nova' },
        conversation: { id: a.conversation, conversationType: a.conversationType ?? 'personal' },
        text: a.mention ? `<at>Nova</at> ${a.text}` : a.text,
        entities: a.mention ? [{ type: 'mention', mentioned: { id: 'bot-1', name: 'Nova' } }] : [],
      };
      return {
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        rawBody: new Uint8Array(Buffer.from(JSON.stringify(activity))),
      };
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
