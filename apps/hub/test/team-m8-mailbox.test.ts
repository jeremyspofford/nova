// A removed member's mailboxes (decision 5; M8): when the team area announces a removal, the
// channels area revokes the OAuth tokens of the person's mailboxes at the provider and forgets
// them, as signing out does, and audits it; another person's mailbox is left alone.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NovaError, SETTINGS, httpStatusFor, isNovaError, type SettingKey } from '@nova/shared';
import type { AuditRecord } from '@nova/core';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import {
  CHANNEL_OAUTH_CALLBACK_PATH,
  mcpOAuthFlows,
  setupChannels,
  type ChannelsArea,
} from '../src/channels.ts';
import { EventStore } from '../src/event-store.ts';
import { DiagnosticsRegistry } from '../src/hub-context.ts';
import {
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

const BEA = '01920000-0000-7000-8000-0000000000b1';
const CY = '01920000-0000-7000-8000-0000000000c1';

let db: NovaDatabase;
let events: EventStore;
let app: FastifyInstance;
let area: ChannelsArea;
let secrets: MemorySecretStore;
let audit: AuditRecord[];
let dir: string;
let provider: FakeOAuth;
let imap: FakeImap;
let smtp: FakeSmtp;

beforeEach(async () => {
  provider = await startFakeOAuth();
  imap = await startFakeImap({ acceptToken: (t) => provider.valid(t) });
  smtp = await startFakeSmtp({ acceptToken: (t) => provider.valid(t) });
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-member-mail-'));
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  for (const id of [BEA, CY])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, now, now);
  secrets = new MemorySecretStore();
  audit = [];
  events = new EventStore(db);
  const ctx = {
    config: { host: '127.0.0.1', port: 7419, tls: null, allowedOrigins: [] },
    db,
    log: new Logger({ module: 'hub', sinks: [] }),
    events,
    secrets,
    dataDir: dir,
    registry: {} as never,
    router: {} as never,
    nodes: {} as never,
    threads: {} as never,
    setting: (key: SettingKey) =>
      Promise.resolve(
        (key === 'channels.publicUrl' ? 'https://hub.example.com' : SETTINGS[key].default) as never,
      ),
    accountOf: (req: FastifyRequest) => {
      const id = req.headers['x-account'];
      if (id !== BEA && id !== CY)
        return Promise.reject(new NovaError('token_required', 'sign in to use the Hub'));
      return Promise.resolve(id);
    },
    diagnostics: new DiagnosticsRegistry(),
  } as unknown as Parameters<typeof setupChannels>[0];
  // Both accounts may reach this machine's fake provider: the test's flows are not pinned to
  // public addresses (a member's are in the Hub).
  area = await setupChannels(ctx, {
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    mailOAuthFlows: mcpOAuthFlows({ now: () => new Date(), fetchFor: () => undefined }),
  });
  app = Fastify({ logger: false });
  app.setErrorHandler((err, req, reply) => {
    if (isNovaError(err))
      return reply.status(httpStatusFor(err.code)).send({ error: err.toJSON(), requestId: req.id });
    return reply.status(500).send({ error: { code: 'server_error', message: String(err) } });
  });
  area.register(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await area.close();
  db.close();
  await Promise.all([provider.close(), imap.close(), smtp.close()]);
  rmSync(dir, { recursive: true, force: true });
});

const as = (accountId: string) => ({ 'x-account': accountId, host: 'hub.test:7419' });

/** A mailbox signed in over OAuth for the account; returns its binding id. */
async function signedInMailbox(accountId: string, address: string): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/channels',
    headers: as(accountId),
    payload: {
      kind: 'email',
      externalRef: address,
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
      },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = (JSON.parse(created.body) as { id: string }).id;
  const start = await app.inject({
    method: 'POST',
    url: `/api/v1/channels/${id}/oauth/start`,
    headers: as(accountId),
    payload: {},
  });
  const { authorizeUrl } = JSON.parse(start.body) as { authorizeUrl: string };
  const q = await consent(authorizeUrl);
  const back = await app.inject({
    method: 'GET',
    url: `${CHANNEL_OAUTH_CALLBACK_PATH}?${q.toString()}`,
    headers: { host: 'hub.test:7419' },
  });
  expect(back.headers.location).toBe('/settings/channels?oauth=ok');
  return id;
}

const tokensOf = async (bindingId: string) =>
  (await secrets.list('secret://channel/')).filter(
    (r) => r.includes(bindingId) && /oauth(Access|Refresh)Token/.test(r),
  );

describe("a removed member's mailboxes", () => {
  it('have their OAuth tokens revoked at the provider and forgotten', async () => {
    const beas = await signedInMailbox(BEA, 'bea@home.example');
    const cys = await signedInMailbox(CY, 'cy@home.example');
    expect(await tokensOf(beas)).not.toEqual([]);
    expect(provider.revoked).toEqual([]);
    // What TeamService.removeMember emits once the account is closed.
    await events.emit({
      name: 'team.member.removed',
      actor: 'user',
      accountId: CY,
      payload: { accountId: BEA, sessionsEnded: 1 },
    });
    await vi.waitFor(() => expect(provider.revoked.length).toBe(2));
    expect(await tokensOf(beas)).toEqual([]);
    // Another person's mailbox keeps working.
    expect(await tokensOf(cys)).not.toEqual([]);
    expect(provider.revoked.every((t) => !provider.valid(t))).toBe(true);
    await vi.waitFor(() =>
      expect(audit.filter((a) => a.action === 'channel.oauth.revoke')).toEqual([
        expect.objectContaining({
          accountId: BEA,
          actor: 'system',
          resource: `channel_binding:${beas}`,
          detail: { kind: 'email', reason: 'member_removed' },
        }),
      ]),
    );
  });
});
