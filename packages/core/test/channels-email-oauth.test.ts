// Email OAuth (M8; FR-110, docs/13 §4, docs/12 §5) against a fake OAuth provider and the local
// IMAP and SMTP servers speaking SASL XOAUTH2: the owner configures the provider; authorization
// runs with PKCE and a single-use state; tokens live in the vault of the mailbox's credential
// group, never in rows, views or audit; the access token is refreshed before it expires and once
// more when a server refuses it; a refused refresh token means authorizing again; signing out and
// removing the last binding revoke at the provider. The password path is unchanged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import { SETTINGS, type SettingKey } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import {
  ChannelOAuth,
  ChannelPollers,
  ChannelService,
  EmailAdapter,
  MemoryEventSink,
  type AuditRecord,
} from '../src/index.ts';
import { ACCOUNT, Clock, FakeTurns, channelsDb, insertThread } from './fixtures/channels/env.ts';
import {
  mail,
  startFakeImap,
  startFakeSmtp,
  type FakeImap,
  type FakeSmtp,
} from './fixtures/channels/mail-servers.ts';
import {
  consent,
  startFakeOAuth,
  testFlows,
  type FakeOAuth,
} from './fixtures/channels/oauth-server.ts';

let db: NovaDatabase;
let secrets: MemorySecretStore;
let audit: AuditRecord[];
let clock: Clock;
let service: ChannelService;
let oauth: ChannelOAuth;
let turns: FakeTurns;
let provider: FakeOAuth;
let imap: FakeImap;
let smtp: FakeSmtp;
let pollers: ChannelPollers | null = null;
const changed: string[] = [];

const REDIRECT = 'https://hub.example.com/api/v1/channels/oauth/callback';

beforeEach(async () => {
  provider = await startFakeOAuth();
  imap = await startFakeImap({ acceptToken: (t) => provider.valid(t) });
  smtp = await startFakeSmtp({ acceptToken: (t) => provider.valid(t) });
  db = await channelsDb();
  secrets = new MemorySecretStore();
  audit = [];
  clock = new Clock();
  changed.length = 0;
  const auditSink = { append: (r: AuditRecord) => (audit.push(r), Promise.resolve()) };
  oauth = new ChannelOAuth({
    db,
    secrets,
    flows: testFlows(clock.now),
    audit: auditSink,
    now: clock.now,
    onChange: (id) => {
      changed.push(id);
      void service.credentialsChanged(id);
    },
  });
  service = new ChannelService({
    db,
    events: new MemoryEventSink(),
    secrets,
    setting: (key: SettingKey) => Promise.resolve(SETTINGS[key].default as never),
    audit: auditSink,
    now: clock.now,
    oauth,
    createThread: (_a, input) => Promise.resolve(insertThread(db, input.title, input.mode)),
    adapters: (credentials) => ({
      email: new EmailAdapter({ credentials, now: clock.now, oauth }),
    }),
  });
  turns = new FakeTurns();
  service.useTurns(turns);
});

afterEach(async () => {
  await pollers?.stop();
  pollers = null;
  await service.close();
  db.close();
  await Promise.all([provider.close(), imap.close(), smtp.close()]);
});

function config(over: Record<string, string> = {}) {
  return {
    address: imap.user,
    imapHost: '127.0.0.1',
    imapPort: String(imap.port),
    imapSecurity: 'none',
    smtpHost: '127.0.0.1',
    smtpPort: String(smtp.port),
    smtpSecurity: 'none',
    mode: 'polling',
    authservId: 'mx.example.com',
    auth: 'oauth',
    oauthAuthUrl: `${provider.authUrl}?access_type=offline`,
    oauthTokenUrl: provider.tokenUrl,
    oauthRevokeUrl: provider.revokeUrl,
    oauthClientId: provider.clientId,
    oauthScopes: 'https://mail.example/ offline_access',
    ...over,
  };
}

async function binding(over: Record<string, unknown> = {}) {
  return service.create(ACCOUNT, {
    kind: 'email',
    externalRef: 'jeremy@home.example',
    audience: 'private',
    oauthClientSecret: provider.clientSecret!,
    config: config(),
    ...over,
  } as never);
}

async function authorize(bindingId: string) {
  const start = await oauth.start({ accountId: ACCOUNT, bindingId, redirectUri: REDIRECT });
  const q = await consent(start.authorizeUrl);
  return oauth.finish({
    state: q.get('state')!,
    code: q.get('code') ?? undefined,
    error: q.get('error') ?? undefined,
  });
}

describe('configuring OAuth', () => {
  it('needs the provider, https endpoints, and keeps the client secret in the vault', async () => {
    await expect(binding({ config: config({ oauthTokenUrl: '' }) })).rejects.toMatchObject({
      code: 'validation',
      details: { field: 'config.oauthTokenUrl' },
    });
    await expect(
      binding({ config: config({ oauthAuthUrl: 'http://login.example.com/authorize' }) }),
    ).rejects.toMatchObject({ details: { field: 'config.oauthAuthUrl' } });
    await expect(
      binding({ credentials: { password: 'fake-pass-1' }, config: config({ auth: 'kerberos' }) }),
    ).rejects.toMatchObject({
      details: { field: 'config.auth' },
    });
    // The password path still needs its password.
    await expect(
      binding({ credentials: {}, config: config({ auth: 'password' }) }),
    ).rejects.toMatchObject({ details: { field: 'credentials.password' } });
    const b = await binding();
    expect(b).toMatchObject({
      status: 'not_configured',
      credentials: [{ name: 'oauthClientSecret', set: true }],
      oauth: { status: 'needs_auth', scopes: [], expiresAt: null },
    });
    expect(JSON.stringify(b)).not.toContain(provider.clientSecret!);
    const row = db.raw.prepare('SELECT * FROM channel_binding WHERE id = ?').get(b.id);
    expect(JSON.stringify(row)).not.toContain(provider.clientSecret!);
    // A public client (PKCE, no secret) needs no credential at all.
    const pub = await binding({ externalRef: 'sam@home.example', oauthClientSecret: undefined });
    expect(pub.credentials).toEqual([{ name: 'oauthClientSecret', set: false }]);
    expect(pub.status).toBe('not_configured');
  });

  it('refuses OAuth calls for a password binding', async () => {
    const b = await binding({
      credentials: { password: imap.password },
      config: config({ auth: 'password' }),
    });
    expect(b.oauth).toBeUndefined();
    await expect(
      oauth.start({ accountId: ACCOUNT, bindingId: b.id, redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: 'validation', details: { field: 'config.auth' } });
    await expect(
      oauth.start({ accountId: 'someone-else', bindingId: b.id, redirectUri: REDIRECT }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('authorizing', () => {
  it('runs the code flow with PKCE and a single-use state; tokens go to the vault only', async () => {
    const b = await binding();
    const start = await oauth.start({ accountId: ACCOUNT, bindingId: b.id, redirectUri: REDIRECT });
    const url = new URL(start.authorizeUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toBe('https://mail.example/ offline_access');
    expect(start.redirectUri).toBe(REDIRECT);
    const q = await consent(start.authorizeUrl);
    const state = q.get('state')!;
    const out = await oauth.finish({ state, code: q.get('code')! });
    expect(out).toEqual({ accountId: ACCOUNT, bindingId: b.id, ok: true, error: null });
    expect(provider.tokenCalls).toEqual([{ grant: 'authorization_code', clientAuth: 'post' }]);
    // The state works once.
    await expect(oauth.finish({ state, code: q.get('code')! })).rejects.toMatchObject({
      code: 'request_expired',
    });
    await expect(oauth.finish({ state: 'made-up', code: 'x' })).rejects.toMatchObject({
      code: 'request_expired',
    });
    const view = await service.get(ACCOUNT, b.id);
    expect(view).toMatchObject({
      status: 'connected',
      oauth: { status: 'connected', scopes: ['https://mail.example/', 'offline_access'] },
    });
    const at = provider.lastAccess()!;
    expect(await secrets.get(`secret://channel/${b.id}/oauthAccessToken`)).toBe(at);
    expect(JSON.stringify(view)).not.toContain(at);
    expect(JSON.stringify(audit)).not.toContain(at);
    expect(JSON.stringify(db.raw.prepare('SELECT * FROM channel_binding').all())).not.toContain(at);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['channel.oauth.start', 'channel.oauth.connect']),
    );
    expect(changed).toEqual([b.id]);
  });

  it('a refused or expired authorization changes nothing that works', async () => {
    const b = await binding();
    provider.deny = true;
    expect(await authorize(b.id)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/access_denied/),
    });
    expect((await service.get(ACCOUNT, b.id)).oauth).toMatchObject({ status: 'error' });
    expect(audit.at(-1)).toMatchObject({ action: 'channel.oauth.failed' });
    provider.deny = false;
    expect(await authorize(b.id)).toMatchObject({ ok: true });
    // A later failed attempt leaves the working tokens in place.
    provider.deny = true;
    await authorize(b.id);
    expect((await service.get(ACCOUNT, b.id)).oauth).toMatchObject({ status: 'connected' });
    // The state expires after ten minutes.
    provider.deny = false;
    const start = await oauth.start({ accountId: ACCOUNT, bindingId: b.id, redirectUri: REDIRECT });
    const q = await consent(start.authorizeUrl);
    clock.advance(11 * 60_000);
    await expect(
      oauth.finish({ state: q.get('state')!, code: q.get('code')! }),
    ).rejects.toMatchObject({
      code: 'request_expired',
    });
  });
});

describe('the mailbox over XOAUTH2', () => {
  it('reads with IMAP and replies with SMTP using the token, never a password', async () => {
    const b = await binding();
    await authorize(b.id);
    await service.addIdentity(ACCOUNT, {
      kind: 'email',
      externalId: 'jeremy@home.example',
      role: 'owner',
    });
    expect((await service.setEnabled(ACCOUNT, b.id, true)).statusDetail).toBeNull();
    pollers = new ChannelPollers({
      service,
      db,
      setting: (k) => Promise.resolve(SETTINGS[k].default as never),
    });
    // The first read sets the cursor at the end of the folder.
    await pollers.pollOnce(b.id);
    imap.deliver(
      mail({
        from: 'jeremy@home.example',
        to: imap.user,
        subject: 'Trip',
        text: 'book the train',
        auth: 'dmarc=pass header.from=home.example',
      }),
    );
    expect(await pollers.pollOnce(b.id)).toBe(1);
    await service.idle();
    expect(smtp.sent.at(-1)?.data).toMatch(/^Subject: Re: Trip$/m);
    expect(imap.logins).toEqual([]);
    expect(imap.oauthLogins.every((l) => l.ok && l.user === imap.user)).toBe(true);
    expect(smtp.oauthLogins.at(-1)).toMatchObject({ ok: true, user: imap.user });
  });

  it('refreshes before the token expires, and once more when a server refuses it', async () => {
    const b = await binding();
    await authorize(b.id);
    const first = provider.lastAccess()!;
    const adapter = service.adapterOf('email') as EmailAdapter;
    await adapter.read(b.id, null, 10, AbortSignal.timeout(10_000));
    expect(imap.oauthLogins.at(-1)).toMatchObject({ token: first, ok: true });
    // Within a minute of expiry the token is refreshed first.
    clock.advance((provider.lifetime - 30) * 1000);
    await adapter.read(b.id, null, 10, AbortSignal.timeout(10_000));
    const second = provider.lastAccess()!;
    expect(second).not.toBe(first);
    expect(provider.tokenCalls.at(-1)).toEqual({ grant: 'refresh_token', clientAuth: 'post' });
    expect(imap.oauthLogins.at(-1)).toMatchObject({ token: second, ok: true });
    // The provider dropped the token early: IMAP refuses it, one forced refresh, one retry.
    provider.dropAccess(second);
    await adapter.read(b.id, null, 10, AbortSignal.timeout(10_000));
    expect(imap.oauthLogins.slice(-2).map((l) => l.ok)).toEqual([false, true]);
    // SMTP likewise: nodemailer asks the Hub for a renewed token.
    provider.dropAccess(provider.lastAccess()!);
    await adapter.send(
      b.id,
      { conversation: 'jeremy@home.example', text: 'hi' },
      AbortSignal.timeout(10_000),
    );
    expect(smtp.oauthLogins.slice(-2).map((l) => l.ok)).toEqual([false, true]);
    expect(smtp.sent).toHaveLength(1);
    // A refresh that keeps the old refresh token (none sent back) still works the next time.
    clock.advance(provider.lifetime * 1000);
    await adapter.read(b.id, null, 10, AbortSignal.timeout(10_000));
    expect(imap.oauthLogins.at(-1)!.ok).toBe(true);
  });

  it('a refused refresh token means authorizing again; a provider outage is retried later', async () => {
    const b = await binding();
    await authorize(b.id);
    const adapter = service.adapterOf('email') as EmailAdapter;
    clock.advance(provider.lifetime * 1000);
    provider.failNext = true;
    await expect(adapter.read(b.id, null, 10, AbortSignal.timeout(10_000))).rejects.toMatchObject({
      code: 'server_error',
      retryable: true,
    });
    expect((await service.get(ACCOUNT, b.id)).oauth).toMatchObject({ status: 'error' });
    provider.refuseRefresh = true;
    await expect(adapter.read(b.id, null, 10, AbortSignal.timeout(10_000))).rejects.toMatchObject({
      code: 'token_required',
      details: { reason: 'oauth_expired' },
    });
    const view = await service.get(ACCOUNT, b.id);
    expect(view).toMatchObject({ status: 'not_configured', oauth: { status: 'expired' } });
    expect(audit.at(-1)).toMatchObject({ action: 'channel.oauth.expired', actor: 'system' });
    // Connecting reports it instead of failing.
    const probe = await service.setEnabled(ACCOUNT, b.id, true);
    expect(probe.statusDetail).toMatch(/needs authorizing/);
    provider.refuseRefresh = false;
    await authorize(b.id);
    expect((await service.get(ACCOUNT, b.id)).status).toBe('connected');
  });
});

describe('signing out', () => {
  it('revokes at the provider and forgets the tokens; the mailbox shares one authorization', async () => {
    const b = await binding();
    await authorize(b.id);
    const other = await service.create(ACCOUNT, {
      kind: 'email',
      externalRef: 'sam@home.example',
      shareCredentialsWith: b.id,
    } as never);
    expect(other.oauth).toMatchObject({ status: 'connected' });
    await expect(
      service.create(ACCOUNT, {
        kind: 'email',
        externalRef: 'kim@home.example',
        shareCredentialsWith: b.id,
        oauthClientSecret: 'another-fake-secret',
      } as never),
    ).rejects.toMatchObject({ details: { field: 'credentials' } });
    await oauth.revoke(ACCOUNT, other.id);
    expect(provider.revoked).toHaveLength(2);
    expect(await secrets.list(`secret://channel/${b.id}/oauthAccessToken`)).toEqual([]);
    expect((await service.get(ACCOUNT, b.id)).oauth).toMatchObject({ status: 'needs_auth' });
    expect(audit.at(-1)).toMatchObject({ action: 'channel.oauth.revoke' });
  });

  it('removing the last binding of the mailbox revokes its tokens', async () => {
    const b = await binding();
    await authorize(b.id);
    const other = await service.create(ACCOUNT, {
      kind: 'email',
      externalRef: 'sam@home.example',
      shareCredentialsWith: b.id,
    } as never);
    await service.remove(ACCOUNT, other.id);
    expect(provider.revoked).toEqual([]);
    await service.remove(ACCOUNT, b.id);
    expect(provider.revoked).toHaveLength(2);
    expect(await secrets.list(`secret://channel/${b.id}/`)).toEqual([]);
  });
});
