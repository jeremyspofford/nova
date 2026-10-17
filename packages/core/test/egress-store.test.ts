// Per-scope network policy and proxy credentials (FR-102, FR-193, ADR-063): scopes stored and
// listed, credential values only in the vault, the effective policy of a command (modes narrow,
// grants add, deny wins), the scopes of a thread, and the sandbox adapter opening sessions.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import {
  EgressProxyService,
  EgressStore,
  effectivePolicy,
  proxyEgress,
  threadScopes,
  type EgressGlobal,
} from '../src/computers/index.ts';
import { ACCOUNT, AGENT, AGENT_THREAD, OTHER, PLAIN_THREAD, computersDb } from './computers-env.ts';

let db: NovaDatabase;
let secrets: MemorySecretStore;
let store: EgressStore;
let dir: string;

beforeEach(async () => {
  db = await computersDb();
  secrets = new MemorySecretStore();
  store = new EgressStore({ db, secrets });
  dir = mkdtempSync(join(tmpdir(), 'nova-egress-store-'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const scopeInput = (over: Partial<Parameters<EgressStore['putScope']>[3]> = {}) => ({
  mode: null,
  allow: [] as string[],
  deny: [] as string[],
  hooks: [],
  allowLocalBinding: false,
  ...over,
});

describe('egress scopes', () => {
  it('stores one policy per scope and account, replacing it on update', async () => {
    const v = await store.putScope(
      ACCOUNT,
      'agent',
      AGENT,
      scopeInput({ allow: ['api.example.com'] }),
    );
    expect(v).toMatchObject({ kind: 'agent', id: AGENT, mode: null, allow: ['api.example.com'] });
    await store.putScope(
      ACCOUNT,
      'agent',
      AGENT,
      scopeInput({ mode: 'limited', deny: ['x.example'] }),
    );
    expect(store.listScopes(ACCOUNT)).toHaveLength(1);
    expect(store.getScope(ACCOUNT, 'agent', AGENT)).toMatchObject({
      mode: 'limited',
      allow: [],
      deny: ['x.example'],
    });
    expect(store.listScopes(OTHER)).toEqual([]);
    expect(await store.deleteScope(ACCOUNT, 'agent', AGENT)).toBe(true);
    expect(await store.deleteScope(ACCOUNT, 'agent', AGENT)).toBe(false);
  });
});

describe('egress credentials', () => {
  it('keeps the value in the vault only, and never in a view', async () => {
    const c = await store.createCredential(ACCOUNT, {
      name: 'Mock API',
      hosts: ['api.test'],
      scheme: 'bearer',
      value: 'tok-123456',
    });
    expect(c.secretRef).toBe(`secret://egress/${c.id}`);
    expect(JSON.stringify(c)).not.toContain('tok-123456');
    expect(await secrets.get(c.secretRef)).toBe('tok-123456');
    const raw = JSON.stringify(db.raw.prepare('SELECT * FROM egress_credential').all());
    expect(raw).not.toContain('tok-123456');
    const updated = await store.updateCredential(ACCOUNT, c.id, {
      value: 'tok-654321',
      scheme: 'header',
      header: 'X-Api-Key',
    });
    expect(updated).toMatchObject({ scheme: 'header', header: 'X-Api-Key' });
    expect(await secrets.get(c.secretRef)).toBe('tok-654321');
    await expect(
      store.updateCredential(ACCOUNT, c.id, { scheme: 'header', header: null }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(store.updateCredential(OTHER, c.id, { name: 'x' })).rejects.toMatchObject({
      code: 'not_found',
    });
    const [forProxy] = await store.credentials(ACCOUNT, [c.id]);
    expect(await forProxy?.value()).toBe('tok-654321');
    expect(await store.deleteCredential(ACCOUNT, c.id)).toBe(true);
    expect(await secrets.has(c.secretRef)).toBe(false);
    expect(await store.deleteCredential(ACCOUNT, c.id)).toBe(false);
  });

  it('gives a scoped credential only to commands of that scope', async () => {
    const all = await store.createCredential(ACCOUNT, {
      name: 'all',
      hosts: ['a.test'],
      scheme: 'basic',
      username: 'bot',
      value: 'v1',
    });
    const mine = await store.createCredential(ACCOUNT, {
      name: 'agent only',
      hosts: ['b.test'],
      scheme: 'bearer',
      scope: { kind: 'agent', id: AGENT },
      value: 'v2',
    });
    expect(store.credentialIdsFor(ACCOUNT, [])).toEqual([all.id]);
    expect(store.credentialIdsFor(ACCOUNT, [{ kind: 'agent', id: AGENT }])).toEqual([
      all.id,
      mine.id,
    ]);
    expect(store.credentialIdsFor(OTHER, [{ kind: 'agent', id: AGENT }])).toEqual([]);
    expect(all.username).toBe('bot');
  });
});

describe('effective policy', () => {
  const global: EgressGlobal = { mode: 'allowlist', allow: ['pypi.org'], deny: ['bad.example'] };

  it('narrows the mode and unions grants and denies', () => {
    const p = effectivePolicy({
      global,
      network: 'allowlist',
      scopes: [
        {
          kind: 'agent',
          id: 'a',
          mode: 'limited',
          allow: ['api.test'],
          deny: ['x.test'],
          hooks: [],
          allowLocalBinding: true,
          updatedAt: '',
        },
      ],
      profile: { allow: ['registry.npmjs.org'] },
      credentials: ['c1'],
    });
    expect(p.mode).toBe('limited');
    expect(p.allow.sort()).toEqual(['api.test', 'pypi.org', 'registry.npmjs.org']);
    expect(p.deny.sort()).toEqual(['bad.example', 'x.test']);
    expect(p.allowLocalBinding).toBe(true);
    expect(p.credentials).toEqual(['c1']);
    expect(effectivePolicy({ global, network: 'limited', scopes: [], credentials: [] }).mode).toBe(
      'limited',
    );
    expect(
      effectivePolicy({
        global: { ...global, mode: 'off' },
        network: 'allowlist',
        scopes: [],
        credentials: [],
      }).mode,
    ).toBe('off');
  });
});

describe('the sandbox adapter', () => {
  it('finds the agent, run and Code session of a thread', () => {
    expect(threadScopes(db, ACCOUNT, AGENT_THREAD)).toEqual([{ kind: 'agent', id: AGENT }]);
    expect(threadScopes(db, ACCOUNT, PLAIN_THREAD)).toEqual([]);
    expect(threadScopes(db, OTHER, AGENT_THREAD)).toEqual([]);
  });

  it('opens a proxy session under the effective policy, or none when it is off', async () => {
    const audit: unknown[] = [];
    const proxy = new EgressProxyService({
      socketDir: join(dir, 's'),
      audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    });
    let global: EgressGlobal = { mode: 'allowlist', allow: ['pypi.org'], deny: [] };
    await store.putScope(ACCOUNT, 'agent', AGENT, scopeInput({ allow: ['api.test'] }));
    await store.createCredential(ACCOUNT, {
      name: 'c',
      hosts: ['api.test'],
      scheme: 'bearer',
      value: 'v',
    });
    const egress = proxyEgress({ proxy, store, db, global: () => Promise.resolve(global) });
    const s = await egress.open({
      accountId: ACCOUNT,
      threadId: AGENT_THREAD,
      network: 'allowlist',
      scope: null,
    });
    expect(s).not.toBeNull();
    expect(proxy.sessionCount).toBe(1);
    await s?.close();
    await expect(
      egress.open({ accountId: null, threadId: null, network: 'allowlist', scope: null }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    global = { ...global, mode: 'off' };
    expect(
      await egress.open({
        accountId: ACCOUNT,
        threadId: PLAIN_THREAD,
        network: 'allowlist',
        scope: null,
      }),
    ).toBeNull();
    // A bare * that reached a list is dropped (never a match-all), so the session still opens.
    global = { mode: 'allowlist', allow: ['*'], deny: [] };
    const none = await egress.open({
      accountId: ACCOUNT,
      threadId: PLAIN_THREAD,
      network: 'allowlist',
      scope: null,
    });
    expect(none).not.toBeNull();
    await none?.close();
    expect(
      effectivePolicy({ global, network: 'allowlist', scopes: [], credentials: [] }).allow,
    ).toEqual([]);
    await proxy.close();
  });
});
