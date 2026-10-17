// Profile, usage and account switching routes (FR-113, FR-114, FR-115; hub-api M4) on a real
// Hub: GET/PATCH /account (the M1 fields keep working), the avatar, GET /usage after a real
// turn, and PATCH /providers/:id {active: true}.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockProvider } from '@nova/providers';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const HOST = { host: '127.0.0.1:7419' };

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let auth: Record<string, string>;
let accountId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-profile-'));
  const config = loadConfig(
    { NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: join(dir, 'noweb') },
    [],
  );
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
    secrets: new MemorySecretStore(),
    chat: { deltaIntervalMs: 0, flushIntervalMs: 20 },
    providerFactory: ({ row }) =>
      row.provider === 'openai'
        ? new MockProvider({
            id: row.id,
            models: [{ id: 'gpt-shared', label: 'shared', capabilities: { reasoning: false } }],
          })
        : undefined,
  });
  const code = await hub.auth.issueSetupCode();
  const res = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: HOST,
    payload: { code, displayName: 'Owner' },
  });
  accountId = res.json().accountId;
  auth = {
    ...HOST,
    authorization: `Bearer ${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`,
  };
});

afterEach(async () => {
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string) => hub.app.inject({ method: 'GET', url, headers: auth });
const send = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  hub.app.inject({
    method,
    url,
    headers: auth,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A PNG with a text chunk and an image data chunk of `size` bytes. */
function png(size = 16): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.alloc(13, 1)),
    pngChunk('tEXt', Buffer.from('Location\0somewhere private', 'latin1')),
    pngChunk('IDAT', Buffer.alloc(size, 7)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('profile routes require a session', () => {
  it.each([
    ['GET', '/api/v1/account'],
    ['PATCH', '/api/v1/account'],
    ['GET', '/api/v1/account/avatar'],
    ['GET', '/api/v1/usage'],
    ['PATCH', '/api/v1/providers/x'],
    ['POST', '/api/v1/import/preview'],
    ['POST', '/api/v1/import/apply'],
    ['GET', '/api/v1/import/records'],
  ] as const)('%s %s', async (method, url) => {
    const res = await hub.app.inject({
      method,
      url,
      headers: HOST,
      payload: method === 'GET' ? undefined : {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('token_required');
  });
});

describe('account (FR-113)', () => {
  it('reads and updates the profile, keeping the M1 fields', async () => {
    expect((await get('/api/v1/account')).json()).toMatchObject({
      accountId,
      displayName: 'Owner',
      username: null,
      hasAvatar: false,
    });
    // The M1 body still works and the response still has accountId and displayName.
    const old = await send('PATCH', '/api/v1/account', { displayName: ' Jeremy ', avatar: null });
    expect(old.statusCode).toBe(200);
    expect(old.json()).toMatchObject({ accountId, displayName: 'Jeremy' });
    expect((await get('/api/v1/session')).json().displayName).toBe('Jeremy');
    const named = await send('PATCH', '/api/v1/account', { username: 'jeremy' });
    expect(named.json()).toMatchObject({ username: 'jeremy', displayName: 'Jeremy' });
    for (const bad of [
      {},
      { username: 'Not Valid' },
      { displayName: 'x'.repeat(101) },
      { avatar: 'http://x' },
    ]) {
      const r = await send('PATCH', '/api/v1/account', bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it('refuses a username another account has', async () => {
    const now = new Date().toISOString();
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, username, created_at, updated_at) VALUES ('other', 'local', 'taken', ?, ?)",
      )
      .run(now, now);
    const r = await send('PATCH', '/api/v1/account', { username: 'taken' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatchObject({ code: 'conflict' });
  });

  it('uploads an avatar larger than the default body limit, strips its metadata and serves it', async () => {
    expect((await get('/api/v1/account/avatar')).statusCode).toBe(404);
    const image = png(1_500_000);
    const up = await send('PATCH', '/api/v1/account', {
      avatar: { mime: 'image/png', data: image.toString('base64') },
    });
    expect(up.statusCode).toBe(200);
    expect(up.json().hasAvatar).toBe(true);
    const res = await get('/api/v1/account/avatar');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.rawPayload.length).toBe(image.length - (12 + 'Location\0somewhere private'.length));
    expect(res.rawPayload.includes(Buffer.from('somewhere private'))).toBe(false);
    // Too large, the wrong type, then removal.
    const big = await send('PATCH', '/api/v1/account', {
      avatar: { mime: 'image/png', data: png(2_200_000).toString('base64') },
    });
    expect(big.statusCode).toBe(400);
    const wrong = await send('PATCH', '/api/v1/account', {
      avatar: { mime: 'image/jpeg', data: png().toString('base64') },
    });
    expect(wrong.json().error.details).toMatchObject({ field: 'avatar', reason: 'content' });
    expect((await send('PATCH', '/api/v1/account', { avatar: null })).json().hasAvatar).toBe(false);
    expect((await get('/api/v1/account/avatar')).statusCode).toBe(404);
  });
});

describe('usage (FR-114)', () => {
  it('summarises a real turn from usage_event', async () => {
    const t = (await send('POST', '/api/v1/threads', {})).json();
    expect(
      (await send('POST', `/api/v1/threads/${t.id}/messages`, { text: 'hello' })).statusCode,
    ).toBe(202);
    await hub.chat.idle();
    const s = (await get('/api/v1/usage')).json();
    expect(s.totals.turns).toBe(1);
    expect(s.totals.inputTokens + s.totals.outputTokens).toBeGreaterThan(0);
    expect(s.byModel).toEqual([expect.objectContaining({ provider: 'mock', turns: 1 })]);
    expect(s.byProject).toEqual([expect.objectContaining({ projectId: null })]);
    expect(s.activeDays).toBe(1);
    expect(s.streak).toBe(1);
    expect(s.longestTurn).toMatchObject({ threadId: t.id });
    const past = (await get('/api/v1/usage?from=2020-01-01&to=2020-01-31')).json();
    expect(past).toMatchObject({
      activeDays: 0,
      longestTurn: null,
      from: '2020-01-01T00:00:00.000Z',
    });
    expect((await get('/api/v1/usage?from=soon')).statusCode).toBe(400);
  });
});

describe('active provider accounts (FR-115)', () => {
  it('switches the active account of a kind', async () => {
    const add = async (label: string) =>
      (
        await send('POST', '/api/v1/providers', {
          provider: 'openai',
          label,
          apiKey: 'sk-test-fake-0123456789abcdef',
        })
      ).json();
    const a = await add('personal');
    const b = await add('work');
    expect(a.active).toBe(true);
    expect(b.active).toBe(false);
    const models = async () =>
      ((await get('/api/v1/models')).json().items as { ref: string; kind: string }[])
        .filter((m) => m.kind === 'model' && m.ref.endsWith('/gpt-shared'))
        .map((m) => m.ref);
    expect(await models()).toEqual([`${a.id}/gpt-shared`]);

    const res = await send('PATCH', `/api/v1/providers/${b.id}`, { active: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: b.id, active: true });
    const list = (await get('/api/v1/providers')).json().items as {
      label: string;
      active: boolean;
    }[];
    expect(list.filter((p) => p.active).map((p) => p.label)).toEqual(['Mock (offline)', 'work']);
    expect(await models()).toEqual([`${b.id}/gpt-shared`]);
    const events = (await get('/api/v1/events?limit=500')).json().events as {
      name: string;
      payload: unknown;
    }[];
    expect(events.find((e) => e.name === 'provider.account.activated')?.payload).toEqual({
      providerAccountId: b.id,
      provider: 'openai',
    });

    // Removing the active one activates the next of its kind.
    await send('DELETE', `/api/v1/providers/${b.id}`);
    const after = (await get('/api/v1/providers')).json().items as {
      id: string;
      active: boolean;
    }[];
    expect(after.find((p) => p.id === a.id)?.active).toBe(true);

    expect((await send('PATCH', `/api/v1/providers/${a.id}`, { active: false })).statusCode).toBe(
      400,
    );
    expect(
      (await send('PATCH', `/api/v1/providers/${a.id}`, { active: true, label: 'x' })).statusCode,
    ).toBe(400);
    expect((await send('PATCH', '/api/v1/providers/missing', { active: true })).statusCode).toBe(
      404,
    );
  });
});
