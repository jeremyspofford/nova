// Channel adapters (FR-088, docs/13 §4): Slack signing-secret verification with the replay window,
// DMs vs channels, mentions and bot messages; Teams bearer tokens checked against the mock's
// signing keys; webhook token and signature; email has no inbound endpoint; the approval
// reply grammar.
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import {
  BotFrameworkVerifier,
  EmailAdapter,
  InAppAdapter,
  SlackAdapter,
  TeamsAdapter,
  WebhookAdapter,
  approvalCode,
  approvalPrompt,
  parseAnswer,
  type BindingCredentials,
} from '../src/index.ts';
import { signBody } from '../src/channels/signing.ts';
import { startMockSlack, type MockSlack } from './fixtures/channels/mock-slack.ts';
import { startMockTeams, type MockTeams } from './fixtures/channels/mock-teams.ts';

function creds(
  secrets: Record<string, string>,
  config: Record<string, string | null> = {},
): BindingCredentials & { remembered: Record<string, string> } {
  const remembered: Record<string, string> = {};
  return {
    remembered,
    secret: (_id, name) => Promise.resolve(secrets[name] ?? null),
    config: () => Promise.resolve({ ...config, ...remembered }),
    remember: (_id, key, value) => {
      remembered[key] = value;
      return Promise.resolve();
    },
  };
}

const signal = () => AbortSignal.timeout(5000);

async function rejectsWith(p: Promise<unknown>, reason: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(NovaError);
  expect((err as NovaError).code).toBe('token_required');
  expect((err as NovaError).details).toMatchObject({ reason });
}

describe('Slack adapter', () => {
  let slack: MockSlack;
  let adapter: SlackAdapter;
  beforeAll(async () => {
    slack = await startMockSlack();
    adapter = new SlackAdapter({
      credentials: creds(
        { botToken: slack.botToken, signingSecret: slack.signingSecret },
        { botUserId: slack.botUserId },
      ),
      apiBase: slack.api,
    });
  });
  afterAll(() => slack.close());

  it('accepts a correctly signed DM as private and addressed', async () => {
    const m = await adapter.parse({
      bindingId: 'b',
      ...slack.message({ channel: 'D1', user: 'U1', text: 'hello &amp; welcome', ts: '100.1' }),
    });
    expect(m).toMatchObject({
      kind: 'slack',
      conversation: 'D1',
      visibility: 'private',
      addressed: true,
      text: 'hello & welcome',
      messageId: 'D1:100.1',
      threadRef: null,
      sender: { externalId: 'U1' },
    });
  });

  it('a channel message is shared and addressed only when it mentions the bot', async () => {
    const plain = await adapter.parse({
      bindingId: 'b',
      ...slack.message({ channel: 'C1', user: 'U2', text: 'lunch?', ts: '200.1' }),
    });
    expect(plain).toMatchObject({ visibility: 'shared', addressed: false, threadRef: '200.1' });
    const mention = await adapter.parse({
      bindingId: 'b',
      ...slack.message({ channel: 'C1', user: 'U2', text: '<@UBOT> status?', threadTs: '199.0' }),
    });
    expect(mention).toMatchObject({ addressed: true, text: 'status?', threadRef: '199.0' });
    const appMention = await adapter.parse({
      bindingId: 'b',
      ...slack.message({ channel: 'C1', user: 'U2', text: 'hey', type: 'app_mention' }),
    });
    expect(appMention?.addressed).toBe(true);
  });

  it('refuses a bad signature, a stale timestamp and a missing signature', async () => {
    await rejectsWith(
      adapter.parse({
        bindingId: 'b',
        ...slack.message({ channel: 'D1', user: 'U1', text: 'x' }, { secret: 'wrong' }),
      }),
      'bad signature',
    );
    await rejectsWith(
      adapter.parse({
        bindingId: 'b',
        ...slack.message(
          { channel: 'D1', user: 'U1', text: 'x' },
          { timestamp: Math.floor(Date.now() / 1000) - 6 * 60 },
        ),
      }),
      'stale timestamp',
    );
    const signed = slack.message({ channel: 'D1', user: 'U1', text: 'x' });
    await rejectsWith(
      adapter.parse({ bindingId: 'b', headers: {}, rawBody: signed.rawBody }),
      'missing signature',
    );
    // A body changed after signing fails the signature.
    const tampered = new Uint8Array(
      Buffer.from(Buffer.from(signed.rawBody).toString().replace('x', 'y')),
    );
    await rejectsWith(
      adapter.parse({ bindingId: 'b', headers: signed.headers, rawBody: tampered }),
      'bad signature',
    );
  });

  it('never returns bot messages, edits or the bot itself (loop prevention)', async () => {
    for (const extra of [{ botId: 'B1' }, { subtype: 'message_changed' }, {}]) {
      const user = 'botId' in extra || 'subtype' in extra ? 'U1' : 'UBOT';
      const m = await adapter.parse({
        bindingId: 'b',
        ...slack.message({ channel: 'C1', user, text: 'echo', ...extra }),
      });
      expect(m).toBeNull();
    }
  });

  it('answers the URL verification after the signature check', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc' });
    const req = slack.sign(body);
    expect(await adapter.parse({ bindingId: 'b', ...req })).toBeNull();
    expect(adapter.handshake(req.rawBody)).toEqual({ challenge: 'abc' });
    expect(adapter.handshake(new Uint8Array(Buffer.from('{}')))).toBeNull();
  });

  it('posts with the bot token, in the thread, and learns the bot user id', async () => {
    const r = await adapter.send(
      'b',
      { conversation: 'C1', text: 'a < b', threadRef: '5.5' },
      signal(),
    );
    expect(slack.posts.at(-1)).toMatchObject({ channel: 'C1', text: 'a &lt; b', thread_ts: '5.5' });
    expect(r.id).toBe(slack.posts.at(-1)!.ts);
    expect(await adapter.probe('b', signal())).toMatchObject({
      ok: true,
      learned: { botUserId: 'UBOT', teamId: 'T1' },
    });
  });

  it('fails a send with a bad token or without one', async () => {
    const bad = new SlackAdapter({ credentials: creds({ botToken: 'nope' }), apiBase: slack.api });
    await expect(bad.send('b', { conversation: 'C1', text: 'x' }, signal())).rejects.toThrow(
      /invalid_auth/,
    );
    expect((await bad.probe('b', signal())).ok).toBe(false);
    const none = new SlackAdapter({ credentials: creds({}), apiBase: slack.api });
    await expect(none.send('b', { conversation: 'C1', text: 'x' }, signal())).rejects.toThrow(
      /not configured/,
    );
    await rejectsWith(
      none.parse({ bindingId: 'b', ...slack.message({ channel: 'D1', user: 'U1', text: 'x' }) }),
      'no signing secret is configured',
    );
  });
});

describe('Teams adapter', () => {
  let teams: MockTeams;
  let verifier: BotFrameworkVerifier;
  beforeAll(async () => {
    teams = await startMockTeams();
    verifier = new BotFrameworkVerifier({ openIdUrl: teams.openIdUrl });
  });
  afterAll(() => teams.close());

  function adapter(c = creds({ appPassword: teams.appPassword }, { appId: teams.appId })) {
    return {
      c,
      a: new TeamsAdapter({
        credentials: c,
        verifier,
        tokenUrl: teams.tokenUrl,
        serviceHost: (host) => host === '127.0.0.1',
      }),
    };
  }

  it('accepts a valid token, remembers the service URL and classifies the conversation', async () => {
    const { a, c } = adapter();
    const m = await a.parse({
      bindingId: 'b',
      ...teams.activity({ conversation: 'conv-1', from: 'user-1', fromName: 'Ada', text: 'hi' }),
    });
    expect(m).toMatchObject({
      kind: 'teams',
      visibility: 'private',
      addressed: true,
      sender: { externalId: 'user-1', displayName: 'Ada' },
      text: 'hi',
    });
    expect(c.remembered.serviceUrl).toBe(teams.serviceUrl);
    const ch = await a.parse({
      bindingId: 'b',
      ...teams.activity({
        conversation: 'chan-1',
        conversationType: 'channel',
        from: 'user-2',
        text: 'status',
        mention: true,
      }),
    });
    expect(ch).toMatchObject({ visibility: 'shared', addressed: true, text: 'status' });
    // A message in a channel thread: the binding names the channel; the reply goes to the thread.
    const inThread = await a.parse({
      bindingId: 'b',
      ...teams.activity({
        conversation: 'chan-1;messageid=777',
        conversationType: 'channel',
        from: 'user-2',
        text: 'follow-up',
        mention: true,
        id: 'act-778',
      }),
    });
    expect(inThread).toMatchObject({
      conversation: 'chan-1',
      threadRef: 'chan-1;messageid=777|act-778',
    });
    const quiet = await a.parse({
      bindingId: 'b',
      ...teams.activity({
        conversation: 'chan-1',
        conversationType: 'channel',
        from: 'u',
        text: 'x',
      }),
    });
    expect(quiet?.addressed).toBe(false);
    expect(
      await a.parse({
        bindingId: 'b',
        ...teams.activity({ conversation: 'c', from: 'u', text: '', type: 'typing' }),
      }),
    ).toBeNull();
  });

  it('refuses a wrong audience, an expired token, a foreign key and a different service URL', async () => {
    const { a } = adapter();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const cases = [
      teams.activity({ conversation: 'c', from: 'u', text: 'x' }, { audience: 'someone-else' }),
      teams.activity({ conversation: 'c', from: 'u', text: 'x' }, { expiresIn: -3600 }),
      teams.activity({ conversation: 'c', from: 'u', text: 'x' }, { key: other }),
      teams.activity(
        { conversation: 'c', from: 'u', text: 'x' },
        { serviceUrlClaim: 'https://evil.example/' },
      ),
      { headers: {}, rawBody: teams.activity({ conversation: 'c', from: 'u', text: 'x' }).rawBody },
    ];
    for (const req of cases)
      await rejectsWith(a.parse({ bindingId: 'b', ...req }), 'invalid token');
    await rejectsWith(
      a.parse({ bindingId: 'b', headers: {}, rawBody: new Uint8Array(Buffer.from('nope')) }),
      'the body is not an activity',
    );
  });

  it('replies through the connector with an app token, reused until it expires', async () => {
    const { a } = adapter(
      creds(
        { appPassword: teams.appPassword },
        { appId: teams.appId, serviceUrl: teams.serviceUrl },
      ),
    );
    const before = teams.tokenRequests;
    const r1 = await a.send('b', { conversation: 'conv-1', text: 'one' }, signal());
    await a.send('b', { conversation: 'chan-1', text: 'two', threadRef: 'act-9' }, signal());
    await a.send(
      'b',
      { conversation: 'chan-1', text: 'three', threadRef: 'chan-1;messageid=777|act-778' },
      signal(),
    );
    expect(teams.tokenRequests - before).toBe(1);
    expect(teams.replies.slice(-3)).toMatchObject([
      { conversation: 'conv-1', replyToId: null, text: 'one', id: r1.id },
      { conversation: 'chan-1', replyToId: 'act-9', text: 'two' },
      { conversation: 'chan-1;messageid=777', replyToId: 'act-778', text: 'three' },
    ]);
    expect((await a.probe('b', signal())).ok).toBe(true);
  });

  it('sends nothing to a host outside the connector list, or without a service URL', async () => {
    const strict = new TeamsAdapter({
      credentials: creds(
        { appPassword: teams.appPassword },
        { appId: teams.appId, serviceUrl: 'https://evil.example/' },
      ),
      verifier,
      tokenUrl: teams.tokenUrl,
    });
    await expect(strict.send('b', { conversation: 'c', text: 'x' }, signal())).rejects.toThrow(
      /not a Bot Framework connector host/,
    );
    const { a } = adapter();
    await expect(a.send('b', { conversation: 'c', text: 'x' }, signal())).rejects.toThrow(
      /service URL/,
    );
    const badPass = adapter(creds({ appPassword: 'wrong-password' }, { appId: 'other-app' }));
    expect((await badPass.a.probe('b', signal())).ok).toBe(false);
  });
});

describe('webhook adapter', () => {
  const token = 't'.repeat(32);
  const secret = 's'.repeat(40);
  const c = creds(
    { token, secret },
    { externalRef: 'ops', callbackUrl: 'https://hooks.example/cb' },
  );
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const a = new WebhookAdapter({
    credentials: c,
    transport: (req) => {
      sent.push({ url: req.url.href, headers: req.headers, body: req.body });
      return Promise.resolve({ status: 200 });
    },
  });
  const signed = (body: string, o: { token?: string; ts?: number; secret?: string } = {}) => {
    const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
    return {
      headers: {
        authorization: `Bearer ${o.token ?? token}`,
        'x-nova-timestamp': ts,
        'x-nova-signature': signBody(o.secret ?? secret, ts, body),
      },
      rawBody: new Uint8Array(Buffer.from(body)),
    };
  };

  it('accepts the token and signature; refuses either one wrong or stale', async () => {
    const body = JSON.stringify({ id: 'm1', text: 'hello', from: { id: 'ext-1', name: 'Bo' } });
    expect(await a.parse({ bindingId: 'b', ...signed(body) })).toMatchObject({
      conversation: 'ops',
      addressed: true,
      sender: { externalId: 'ext-1', displayName: 'Bo' },
      messageId: 'm1',
    });
    await rejectsWith(
      a.parse({ bindingId: 'b', ...signed(body, { token: 'x'.repeat(32) }) }),
      'bad token',
    );
    await rejectsWith(
      a.parse({ bindingId: 'b', ...signed(body, { secret: 'z'.repeat(40) }) }),
      'bad signature',
    );
    await rejectsWith(
      a.parse({ bindingId: 'b', ...signed(body, { ts: Math.floor(Date.now() / 1000) - 3600 }) }),
      'stale timestamp',
    );
    const s = signed(body);
    await rejectsWith(
      a.parse({
        bindingId: 'b',
        headers: { authorization: s.headers.authorization },
        rawBody: s.rawBody,
      }),
      'missing signature',
    );
    expect(await a.parse({ bindingId: 'b', ...signed(JSON.stringify({ id: 'x' })) })).toBeNull();
  });

  it('replies to the callback URL, signed', async () => {
    const r = await a.send('b', { conversation: 'ops', text: 'done' }, signal());
    const last = sent.at(-1)!;
    expect(last.url).toBe('https://hooks.example/cb');
    expect(last.headers['x-nova-signature']).toBe(
      signBody(secret, last.headers['x-nova-timestamp']!, last.body),
    );
    expect(JSON.parse(last.body)).toMatchObject({ conversation: 'ops', text: 'done' });
    expect(r.id).toMatch(/^webhook:/);
    const local = new WebhookAdapter({
      credentials: creds({ token, secret }, { callbackUrl: 'http://127.0.0.1/cb' }),
    });
    await expect(local.send('b', { conversation: 'x', text: 'y' }, signal())).rejects.toThrow(
      /https/,
    );
    const failing = new WebhookAdapter({
      credentials: c,
      transport: () => Promise.resolve({ status: 500 }),
    });
    await expect(failing.send('b', { conversation: 'x', text: 'y' }, signal())).rejects.toThrow(
      /500/,
    );
  });
});

describe('email and in-app', () => {
  it('email arrives through its mailbox only, and a binding without one cannot send', async () => {
    const e = new EmailAdapter({ credentials: creds({}) });
    await expect(e.parse()).rejects.toMatchObject({ code: 'not_found' });
    await expect(e.send('b', { conversation: 'x@y.z', text: 'y' }, signal())).rejects.toMatchObject(
      { code: 'capability_missing' },
    );
  });

  it('in-app replies are already in the thread; nothing arrives through it', async () => {
    const i = new InAppAdapter();
    expect((await i.send()).id).toMatch(/^inapp:/);
    await expect(i.parse()).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('approval replies', () => {
  it('parses the decisions a channel may give', () => {
    expect(parseAnswer('allow')).toEqual({ decision: 'allow_once', code: null, reason: null });
    expect(parseAnswer('Approve once 1a2b3c')).toMatchObject({
      decision: 'allow_once',
      code: '1a2b3c',
    });
    expect(parseAnswer('allow session abc123')).toMatchObject({ decision: 'allow_session' });
    expect(parseAnswer('allow for this session')).toMatchObject({ decision: 'allow_session' });
    expect(parseAnswer('deny abc123: not now')).toEqual({
      decision: 'deny_continue',
      code: 'abc123',
      reason: 'not now',
    });
    expect(parseAnswer('deny and stop')).toMatchObject({ decision: 'deny_stop' });
    expect(parseAnswer('allow and stop')).toBeNull();
    expect(parseAnswer('deny once')).toBeNull();
    expect(parseAnswer('allow me to explain')).toBeNull();
  });

  it('prompts with the short code, or sends to Nova for confirm-at-action', () => {
    const id = '01920000-0000-7000-8000-00000000abcd';
    expect(approvalCode(id)).toBe('00abcd');
    const base = {
      id,
      action: 'Write notes.md',
      reason: 'a rule asks',
      options: ['allow_once', 'allow_always', 'deny_continue'] as never,
    };
    expect(approvalPrompt({ ...base, tier: 'pre_approvable' })).toBe(
      'Approval needed: Write notes.md\na rule asks\nReply "allow 00abcd", "deny 00abcd".',
    );
    expect(approvalPrompt({ ...base, tier: 'confirm_at_action' })).toMatch(
      /only be answered in Nova/,
    );
    expect(approvalPrompt({ ...base, tier: 'pre_approvable' }, { shared: true })).toBe(
      'Approval needed for an action (00abcd); the details are in Nova.\nReply "allow 00abcd", "deny 00abcd".',
    );
  });
});
