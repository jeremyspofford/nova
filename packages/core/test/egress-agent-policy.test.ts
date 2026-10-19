// An explicit egress policy (FR-203; M7 review finding 9): an external agent's network is its
// adapter's declared hosts only. The policy replaces the thread's scopes, their grants and the
// global allow list, injects no credential, and still obeys the global mode and deny list.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import {
  EgressStore,
  proxyEgress,
  type EgressGlobal,
  type EgressProxyService,
} from '../src/computers/index.ts';
import { egressContext } from '../src/tools/sandbox-egress.ts';
import { ACCOUNT, AGENT, AGENT_THREAD, computersDb } from './computers-env.ts';

let db: NovaDatabase;
let store: EgressStore;
beforeEach(async () => {
  db = await computersDb();
  store = new EgressStore({ db, secrets: new MemorySecretStore() });
});
afterEach(() => db.close());

function fakeProxy() {
  const opened: { accountId: string; scope: unknown; policy: Record<string, unknown> }[] = [];
  const proxy = {
    open: (x: (typeof opened)[number]) => {
      opened.push(x);
      return Promise.resolve({
        dir: '/tmp/x',
        socketName: 's',
        caBundleName: null,
        close: () => Promise.resolve(),
      });
    },
  } as unknown as EgressProxyService;
  return { proxy, opened };
}

describe('an explicit egress policy', () => {
  it('allows only its hosts, with no credentials, grants or global allow entries', async () => {
    await store.putScope(ACCOUNT, 'agent', AGENT, {
      mode: null,
      allow: ['granted.example'],
      deny: [],
      hooks: [],
      allowLocalBinding: true,
    });
    await store.createCredential(ACCOUNT, {
      name: 'c',
      hosts: ['api.model.example'],
      scheme: 'bearer',
      value: 'tok-should-not-be-used',
    });
    let global: EgressGlobal = {
      mode: 'allowlist',
      allow: ['pypi.org'],
      deny: ['blocked.example'],
    };
    const { proxy, opened } = fakeProxy();
    const egress = proxyEgress({ proxy, store, db, global: () => Promise.resolve(global) });
    const s = await egress.open({
      accountId: ACCOUNT,
      threadId: AGENT_THREAD,
      network: 'allowlist',
      scope: { kind: 'sandbox', id: 'agent-d1' },
      policy: { allow: ['api.model.example', '*'] },
    });
    expect(s).not.toBeNull();
    expect(opened[0]).toEqual({
      accountId: ACCOUNT,
      scope: { kind: 'sandbox', id: 'agent-d1' },
      policy: {
        mode: 'allowlist',
        allow: ['api.model.example'],
        deny: ['blocked.example'],
        credentials: [],
        allowLocalBinding: false,
        hooks: [],
      },
    });
    // Without the policy the same thread gets its grants, the global list and the credential.
    await egress.open({
      accountId: ACCOUNT,
      threadId: AGENT_THREAD,
      network: 'allowlist',
      scope: null,
    });
    expect(opened[1]!.policy.allow).toEqual(
      expect.arrayContaining(['pypi.org', 'granted.example']),
    );
    expect((opened[1]!.policy.credentials as unknown[]).length).toBe(1);
    // The global mode still applies, and no hosts means no network.
    global = { ...global, mode: 'off' };
    expect(
      await egress.open({
        accountId: ACCOUNT,
        threadId: null,
        network: 'allowlist',
        scope: null,
        policy: { allow: ['api.model.example'] },
      }),
    ).toBeNull();
    global = { ...global, mode: 'allowlist' };
    expect(
      await egress.open({
        accountId: ACCOUNT,
        threadId: null,
        network: 'allowlist',
        scope: null,
        policy: { allow: [] },
      }),
    ).toBeNull();
    expect(opened).toHaveLength(2);
  });

  it('travels from the exec request into the egress context', () => {
    const base = {
      cmd: 'x',
      cwd: '/',
      roots: [],
      yieldMs: 0,
      signal: new AbortController().signal,
    };
    expect(
      egressContext({
        ...base,
        network: 'allowlist',
        egress: {
          accountId: ACCOUNT,
          scope: { kind: 'sandbox', id: 'a' },
          policy: { allow: ['h.example'] },
        },
      }),
    ).toEqual({
      accountId: ACCOUNT,
      threadId: null,
      network: 'allowlist',
      scope: { kind: 'sandbox', id: 'a' },
      policy: { allow: ['h.example'] },
    });
    expect(
      egressContext({
        ...base,
        network: 'off',
        egress: { accountId: ACCOUNT, policy: { allow: ['h'] } },
      }),
    ).toBeNull();
  });
});
