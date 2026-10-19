// M8 channels routes (FR-110; docs/13 §4, docs/12 §5): email OAuth through the Hub, end to end
// with the M4 MCP OAuth helpers against a fake provider and the local mail servers speaking SASL
// XOAUTH2 (start needs a session; the public callback is authenticated by its single-use state
// and only ever redirects to settings; tokens never reach a response); the create schema's OAuth
// checks; and a Telegram photo through the Hub kept as a thread attachment.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  NovaError,
  SETTINGS,
  httpStatusFor,
  isNovaError,
  uuidv7,
  type SettingKey,
} from '@nova/shared';
import {
  ArtifactService,
  MemoryEventSink,
  type AskInput,
  type AuditRecord,
  type StartTurnInput,
  type StartedTurn,
  type TurnStarter,
} from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { CHANNEL_OAUTH_CALLBACK_PATH, setupChannels, type ChannelsArea } from '../src/channels.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import {
  mail,
  startFakeImap,
  startFakeSmtp,
  type FakeImap,
  type FakeSmtp,
} from '../../../packages/core/test/fixtures/channels/mail-servers.ts';
import {
  consent,
  startFakeOAuth,
  type FakeOAuth,
} from '../../../packages/core/test/fixtures/channels/oauth-server.ts';
import {
  startMockTelegram,
  type MockTelegram,
} from '../../../packages/core/test/fixtures/channels/mock-telegram.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000eb';
const AUTH = { 'x-account': ACCOUNT, host: 'hub.test:7419' };

class Turns implements TurnStarter {
  calls: StartTurnInput[] = [];
  startTurn(input: StartTurnInput): Promise<StartedTurn> {
    this.calls.push(input);
    const turnId = uuidv7();
    return Promise.resolve({
      turnId,
      messageId: uuidv7(),
      done: Promise.resolve({
        turnId,
        status: 'completed' as const,
        stop: 'end' as const,
        replyText: `Got it: ${input.text.split('\n').at(-1) ?? ''}`,
        steps: 1,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        activeMs: 1,
      }),
    });
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

let db: NovaDatabase;
let app: FastifyInstance;
let area: ChannelsArea;
let secrets: MemorySecretStore;
let audit: AuditRecord[];
let turns: Turns;
let dataDir: string;
let provider: FakeOAuth;
let imap: FakeImap;
let smtp: FakeSmtp;
let tg: MockTelegram;

beforeEach(async () => {
  provider = await startFakeOAuth();
  imap = await startFakeImap({ acceptToken: (t) => provider.valid(t) });
  smtp = await startFakeSmtp({ acceptToken: (t) => provider.valid(t) });
  tg = await startMockTelegram();
  dataDir = mkdtempSync(join(tmpdir(), 'nova-hub-ch8-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  secrets = new MemorySecretStore();
  audit = [];
  turns = new Turns();
  const settings: Partial<Record<SettingKey, unknown>> = {
    'channels.publicUrl': 'https://hub.example.com',
  };
  const ctx = {
    config: { host: '127.0.0.1', port: 7419, tls: null, allowedOrigins: [] },
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events: new EventStore(db),
    secrets,
    dataDir,
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {
      create: (_accountId: string, req: { title?: string; mode?: string }) => {
        const id = uuidv7();
        const at = new Date().toISOString();
        db.raw
          .prepare(
            'INSERT INTO thread (id, account_id, mode, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(id, ACCOUNT, req.mode ?? 'chat', req.title ?? null, at, at);
        return Promise.resolve({ id });
      },
    },
    setting: (key: SettingKey) =>
      Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    accountOf: (req: FastifyRequest) => {
      if (req.headers['x-account'] !== ACCOUNT)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(ACCOUNT);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as Parameters<typeof setupChannels>[0];
  area = await setupChannels(ctx, {
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    telegramApiBase: tg.api,
    pollers: { telegramWaitSeconds: 0, idleMs: 20, backoffMs: 50 },
  });
  area.useTurns(turns);
  app = Fastify({ logger: false });
  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
    if (err instanceof z.ZodError)
      return reply.status(400).send({ error: { code: 'validation', issues: err.issues } });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return reply.status(status).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await area.close();
  db.close();
  await Promise.all([provider.close(), imap.close(), smtp.close(), tg.close()]);
  rmSync(dataDir, { recursive: true, force: true });
});

const json = (r: { body: string }) => JSON.parse(r.body);

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = AUTH,
) {
  return app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

function mailbox(over: Record<string, unknown> = {}) {
  return {
    kind: 'email',
    externalRef: 'jeremy@home.example',
    audience: 'private',
    oauthClientSecret: provider.clientSecret,
    config: {
      address: imap.user,
      imapHost: '127.0.0.1',
      imapPort: imap.port,
      imapSecurity: 'none',
      smtpHost: '127.0.0.1',
      smtpPort: smtp.port,
      smtpSecurity: 'none',
      mode: 'polling',
      authservId: 'mx.example.com',
      auth: 'oauth',
      oauthAuthUrl: provider.authUrl,
      oauthTokenUrl: provider.tokenUrl,
      oauthRevokeUrl: provider.revokeUrl,
      oauthClientId: provider.clientId,
      oauthScopes: 'https://mail.example/',
      ...((over.config as object | undefined) ?? {}),
    },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'config')),
  };
}

describe('sessions and the public callback', () => {
  it('starting and signing out need a session; the callback needs its state', async () => {
    for (const [method, url] of [
      ['POST', `/api/v1/channels/${uuidv7()}/oauth/start`],
      ['DELETE', `/api/v1/channels/${uuidv7()}/oauth`],
    ] as const) {
      const r = await call(method, url, method === 'POST' ? {} : undefined, {});
      expect(r.statusCode, url).toBe(401);
    }
    expect((await call('GET', CHANNEL_OAUTH_CALLBACK_PATH, undefined, {})).statusCode).toBe(400);
    const unknown = await call(
      'GET',
      `${CHANNEL_OAUTH_CALLBACK_PATH}?state=made-up&code=x`,
      undefined,
      {},
    );
    expect(unknown.statusCode).toBe(302);
    expect(unknown.headers.location).toBe('/settings/channels?oauth=error');
    expect(unknown.headers['cache-control']).toBe('no-store');
  });
});

describe('email OAuth through the Hub', () => {
  it('checks the OAuth settings on create', async () => {
    const plain = await call(
      'POST',
      '/api/v1/channels',
      mailbox({ config: { oauthTokenUrl: 'http://login.example.com/token' } }),
    );
    expect(plain.statusCode).toBe(400);
    const missing = await call(
      'POST',
      '/api/v1/channels',
      mailbox({ config: { oauthClientId: undefined } }),
    );
    expect(json(missing).error.details).toMatchObject({ field: 'config.oauthClientId' });
    const unknown = await call(
      'POST',
      '/api/v1/channels',
      mailbox({ config: { oauthSecret: 'x' } }),
    );
    expect(unknown.statusCode).toBe(400);
  });

  it('authorizes in the browser, reads and replies over XOAUTH2, and signs out', async () => {
    const created = await call('POST', '/api/v1/channels', mailbox());
    expect(created.statusCode, created.body).toBe(201);
    const b = json(created);
    expect(b).toMatchObject({ status: 'not_configured', oauth: { status: 'needs_auth' } });
    const start = await call('POST', `/api/v1/channels/${b.id}/oauth/start`, {});
    expect(start.statusCode, start.body).toBe(200);
    expect(start.headers['cache-control']).toBe('no-store');
    const { authorizeUrl, redirectUri } = json(start) as {
      authorizeUrl: string;
      redirectUri: string;
    };
    expect(redirectUri).toBe(`http://hub.test:7419${CHANNEL_OAUTH_CALLBACK_PATH}`);
    const q = await consent(authorizeUrl);
    expect(provider.authorizeCalls.at(-1)!.get('code_challenge_method')).toBe('S256');
    // The provider's redirect lands on the public callback (no session), then in settings.
    const back = await call(
      'GET',
      `${CHANNEL_OAUTH_CALLBACK_PATH}?${q.toString()}&scope=x`,
      undefined,
      {},
    );
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe('/settings/channels?oauth=ok');
    // The state was single use.
    const again = await call(
      'GET',
      `${CHANNEL_OAUTH_CALLBACK_PATH}?${q.toString()}`,
      undefined,
      {},
    );
    expect(again.headers.location).toBe('/settings/channels?oauth=error');
    const view = json(await call('GET', `/api/v1/channels/${b.id}`));
    expect(view).toMatchObject({ status: 'connected', oauth: { status: 'connected' } });
    const token = provider.lastAccess()!;
    expect(JSON.stringify(view)).not.toContain(token);
    // The MCP helpers sent the client secret in the body.
    expect(provider.tokenCalls).toEqual([{ grant: 'authorization_code', clientAuth: 'post' }]);

    await call('POST', '/api/v1/channel-identities', {
      kind: 'email',
      externalId: 'jeremy@home.example',
      role: 'owner',
    });
    const on = json(await call('POST', `/api/v1/channels/${b.id}/connect`));
    expect(on.statusDetail).toBeNull();
    await vi.waitFor(() =>
      expect(db.raw.prepare('SELECT count(*) AS n FROM channel_cursor').get()).toEqual({ n: 1 }),
    );
    await area.pollers.stop();
    imap.deliver(
      mail({
        from: 'jeremy@home.example',
        to: imap.user,
        subject: 'Trip',
        text: 'book the train',
        auth: 'dmarc=pass header.from=home.example',
      }),
    );
    expect(await area.pollers.pollOnce(b.id)).toBe(1);
    await vi.waitFor(() => expect(smtp.sent.at(-1)?.data).toMatch(/^Subject: Re: Trip$/m));
    expect(imap.logins).toEqual([]);
    expect(smtp.oauthLogins.at(-1)).toMatchObject({ ok: true });

    const out = await call('DELETE', `/api/v1/channels/${b.id}/oauth`);
    expect(json(out)).toMatchObject({ status: 'not_configured', oauth: { status: 'needs_auth' } });
    expect(provider.revoked.length).toBeGreaterThan(0);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'channel.oauth.start',
        'channel.oauth.connect',
        'channel.oauth.revoke',
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain(token);
  });
});

describe('Telegram files through the Hub', () => {
  it('keeps a photo as a thread attachment of the turn', async () => {
    const created = await call('POST', '/api/v1/channels', {
      kind: 'telegram',
      externalRef: '42',
      audience: 'private',
      credentials: { botToken: tg.botToken },
      config: { mode: 'webhook' },
    });
    const b = json(created);
    await call('POST', '/api/v1/channel-identities', {
      kind: 'telegram',
      externalId: '42',
      role: 'owner',
    });
    await call('POST', `/api/v1/channels/${b.id}/connect`);
    const secret = String(tg.of('setWebhook').at(-1)!.secret_token);
    const photo = tg.addFile(
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]),
    );
    const req = tg.webhook(
      tg.message({ chat: 42, from: 42, caption: 'look', photo: [photo] }),
      secret,
    );
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/channels/${b.id}/inbound`,
      headers: req.headers,
      payload: Buffer.from(req.rawBody),
    });
    expect(json(r)).toEqual({ ok: true, status: 'started' });
    const call0 = turns.calls.at(-1)!;
    expect(call0.attachmentIds).toHaveLength(1);
    const row = db.raw
      .prepare('SELECT name, mime FROM attachment WHERE id = ?')
      .get(call0.attachmentIds![0]!);
    expect(row).toMatchObject({ mime: 'image/jpeg' });
    // The message log names the file (M8).
    const log = json(await call('GET', `/api/v1/channels/${b.id}/messages?direction=in`));
    expect(log.items[0].file).toEqual({
      name: expect.stringMatching(/^photo-\d+\.jpg$/),
      size: 36,
      contentType: 'image/jpeg',
      direction: 'in',
      status: 'received',
      attachmentId: call0.attachmentIds![0],
    });
  });
});

describe('files to a shared group', () => {
  it('asks the owner about files the check cannot read, and sends them when allowed', async () => {
    const asked: AskInput[] = [];
    area.useRequests({
      ask: (input) => {
        asked.push(input);
        return Promise.resolve({ status: 'resolved', result: { choice: 'Share' }, by: 'user' });
      },
    });
    const bot = json(
      await call('POST', '/api/v1/channels', {
        kind: 'telegram',
        externalRef: '42',
        audience: 'private',
        credentials: { botToken: tg.botToken },
      }),
    );
    const group = json(
      await call('POST', '/api/v1/channels', {
        kind: 'telegram',
        externalRef: '-100777',
        label: 'Team group',
        shareCredentialsWith: bot.id,
      }),
    );
    const threadId = uuidv7();
    const at = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO thread (id, account_id, mode, title, created_at, updated_at) VALUES (?, ?, 'chat', 't', ?, ?)",
      )
      .run(threadId, ACCOUNT, at, at);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32, 1),
    ]);
    const chart = await new ArtifactService({ db, events: new MemoryEventSink(), dataDir }).save({
      accountId: ACCOUNT,
      threadId,
      messageId: null,
      kind: 'image',
      title: 'Chart',
      content: png.toString('base64'),
      encoding: 'base64',
    });
    await area.service.sendAsAgent({
      accountId: ACCOUNT,
      threadId,
      turnId: null,
      bindingId: group.id,
      text: 'The weekly chart.',
      files: [chart.id],
    });
    expect(asked.map((a) => a.payload.question)).toEqual([
      'A reply in Team group, a shared channel, has 1 file Nova cannot check for private information. Share them there?',
    ]);
    expect(tg.uploads.map((u) => [u.method, u.name, u.chatId])).toEqual([
      ['sendPhoto', 'Chart.png', '-100777'],
    ]);
  });
});
