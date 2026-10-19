// Managed policy in the areas that check it themselves (FR-106, ADR-097 D4): model routing keeps
// only the provider kinds the policy allows; the agent browser never opens a site the policy
// refuses and its network lists carry the policy's domains; SSH connections are refused before any
// client runs; a Code session mode the policy turns off is unavailable (and refused with
// `policy_denied` `{reason: managed}` when asked for), falling back to Manual.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ROUTING_STEPS, SETTINGS, type ManagedRestrict, type SettingKey } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  BrowserSites,
  OpenSshTransport,
  PolicyStore,
  Router,
  assertModeAvailable,
  modePolicy,
  modeUnavailable,
  managedRestrictions,
  type RoutingSettings,
} from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

const restrictOf = (...layers: ManagedRestrict[]) => ({ layers, failClosed: null });

describe('model routing', () => {
  let env: Env;
  afterEach(async () => {
    await env.close();
  });

  it('keeps only the provider kinds the policy allows', async () => {
    env = await makeEnv();
    const settings: RoutingSettings = {
      presets: [],
      order: [...ROUTING_STEPS],
      allowCloud: true,
      providers: ['ollama', 'node'],
    };
    const router = new Router({
      registry: env.registry,
      settings: () => Promise.resolve(settings),
    });
    const ref = `${env.mockAccountId}/mock-fast`;
    await expect(router.route(ACCOUNT, ref)).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'managed', model: ref },
    });
    settings.presets = [
      {
        id: 'only-mock',
        label: 'Only mock',
        rank: 1,
        strategy: 'single',
        targets: [ref],
      },
    ];
    await expect(router.route(ACCOUNT, 'preset:only-mock')).rejects.toMatchObject({
      code: 'policy_denied',
    });
    settings.providers = ['mock'];
    expect((await router.route(ACCOUNT, ref)).targets[0]?.providerKind).toBe('mock');
    settings.providers = null;
    expect((await router.route(ACCOUNT, 'preset:only-mock')).targets).toHaveLength(1);
  });
});

describe('the agent browser', () => {
  let db: NovaDatabase;
  let settings: Partial<Record<SettingKey, unknown>>;
  let sites: BrowserSites;
  beforeEach(async () => {
    db = openDatabase({ path: ':memory:' });
    await migrate(db);
    const now = new Date().toISOString();
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(ACCOUNT, now, now);
    settings = {};
    sites = new BrowserSites({
      db,
      store: new PolicyStore({ db }),
      setting: (key) => Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    });
  });
  afterEach(() => db.close());

  it('never opens a site the policy refuses, whatever the entries say', async () => {
    await sites.put(ACCOUNT, { pattern: 'www.bank.example', access: 'allow' });
    await sites.put(ACCOUNT, { pattern: 'docs.corp.example', access: 'allow' });
    expect((await sites.decide(ACCOUNT, 'www.bank.example')).access).toBe('allowed');
    settings['managed.restrict'] = restrictOf({
      browserDomains: { allow: ['*.corp.example'], deny: ['*.bank.example'] },
    });
    expect(await sites.decide(ACCOUNT, 'www.bank.example')).toMatchObject({
      access: 'blocked',
      source: 'managed',
    });
    expect((await sites.decide(ACCOUNT, 'news.example')).source).toBe('managed');
    expect((await sites.decide(ACCOUNT, 'docs.corp.example')).access).toBe('allowed');
    settings['network.egressAllow'] = ['api.corp.example', 'cdn.example'];
    const lists = await sites.networkLists(ACCOUNT);
    expect(lists.allow).toEqual(['docs.corp.example', 'api.corp.example']);
    expect(lists.deny).toContain('*.bank.example');
    expect(lists.named).toEqual(['docs.corp.example']);
  });
});

describe('SSH sessions', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nova-managed-ssh-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses a host before any client runs', async () => {
    const t = new OpenSshTransport({
      runDir: join(dir, 'run'),
      // A client that must never run: the refusal comes first.
      sshBin: join(dir, 'no-such-ssh'),
      enabled: () => Promise.resolve(true),
      managedHost: (host) =>
        Promise.resolve(
          managedRestrictions(restrictOf({ sessions: { sshHosts: ['*.build.example'] } })).sshHost(
            host,
          ),
        ),
    });
    await expect(
      t.connect(
        {
          host: 'evil.example',
          port: 22,
          user: 'me',
          credential: { privateKey: 'k' },
          hostKey: null,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'managed', host: 'evil.example' },
    });
  });
});

describe('Code session modes', () => {
  const checks = managedRestrictions(restrictOf({ permissionModes: { deny: ['bypass'] } }));
  const conditions = {
    reviewerModel: 'r',
    allowBypass: true,
    substrate: 'container' as const,
    managed: (mode: Parameters<typeof checks.permissionMode>[0]) => checks.permissionMode(mode),
  };

  it('makes a mode the policy turns off unavailable, and refuses it as managed', () => {
    expect(modeUnavailable('bypass', conditions)).toMatch(/Bypass mode is turned off/);
    expect(modeUnavailable('auto', conditions)).toBeNull();
    expect(() => assertModeAvailable('bypass', conditions)).toThrow(
      expect.objectContaining({
        code: 'policy_denied',
        details: { mode: 'bypass', reason: 'managed' },
      }),
    );
    expect(() => assertModeAvailable('auto', conditions)).not.toThrow();
    // A session whose mode the policy turned off runs with Manual's axes.
    expect(modePolicy('bypass', '/w', conditions)).toMatchObject({
      permissionMode: 'manual',
      approvalPolicy: 'ask_always',
    });
  });
});
