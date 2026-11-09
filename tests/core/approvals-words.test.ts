// Nova's words follow the tier in effect (the honesty rule): once a tier is lowered, nothing Nova
// says claims it will ask or wait for a confirmation. At the defaults the words are exactly as before.
// Checked on the workers' own descriptions, the chat tools' descriptions and outputs (src/tools.js),
// and, end to end, an infrastructure run's messages with apply lowered to 1 (the coding run's are in
// approvals-coding.test.ts). Also: Home Assistant's older settings route reads and writes the
// registry, and a service tier kept in its settings file before moves to the registry once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { TOOLS, toolProtocol } from '../../src/tools.js';
import { GUARDED, guardedWords } from '../../src/runner.js';
import { PRICES, makeProject, fakeToken, tofuOnPath } from '../support/infra.ts';

// The words before tiers were settings, exactly.
const ABOUT = {
  coding: 'Makes a code change you asked for in chat: a coding agent writes it in a git worktree of Nova’s own, Nova runs the tests and a preview (asking first), and merges into your branch only when you confirm. It never pushes.',
  infra: 'Plans and applies infrastructure with OpenTofu in a project you registered: the plan runs by itself and changes nothing; Nova shows it to you in full, priced against the project’s budget, and applies it only when you confirm, after a checkpoint. A plan over budget, or one it can’t price, is never offered.',
  network: 'Changes a network target’s configuration you registered (a router, DNS, a firewall, a tailnet’s policy): it takes a snapshot and shows you the diff, applies only when you confirm, and puts the snapshot back by itself if Nova can’t hear from one of your devices within the window afterwards.',
  'home-assistant': 'Changes things in your home through Home Assistant when you ask, and reports what changed. Domains you mark confirm every time.',
};
const CLAIMS = /confirm|your OK|asks? (?:you|them|the person|again|before|first)|until the person|waits? for/i;

function boot(more: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nova-approvals-words-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, ...more });
  return { core, home };
}
const lower = (core: Core) => {
  for (const id of ['coding.merge', 'coding.check', 'infra.apply', 'network.apply']) core.approvals.set(id, 1, { confirm: true });
};
const about = (core: Core, id: string) => core.ledger.workers.get(id)!.about;

test('the workers’ own descriptions: exactly as before at the defaults; no claimed confirmation once lowered', async () => {
  const { core } = boot();
  try {
    for (const [id, words] of Object.entries(ABOUT)) assert.equal(about(core, id), words, id);
    lower(core);
    for (const id of ['coding', 'infra', 'network']) assert.doesNotMatch(about(core, id).replace(/without asking/g, ''), CLAIMS, id);
    assert.match(about(core, 'coding'), /merges into your branch without asking, as you set/);
    core.approvals.set('home-assistant.service', 2, {});
    assert.match(about(core, 'home-assistant'), /after your OK/);
  } finally {
    await core.close();
  }
});

test('the chat tools: descriptions and outputs exactly as before at the defaults; no claimed confirmation once lowered', async () => {
  const { core } = boot();
  const names = ['code_change', 'infra_plan', 'network_change', 'account_change', 'home_call'];
  const fake = {
    coding: { start: async () => ({ run: { id: 'r1', agent_name: 'Agent', title: 'T', nova_branch: 'nova/r1', branch: 'main', repo: '/repo', test_command: 'npm test', preview_command: 'npm start' } }) },
    ops: {
      infra: { start: async () => ({ run: { id: 'i1', project: { name: 'P' }, destroy: false } }) },
      network: { start: () => ({ change: { id: 'n1', target: { name: 'Router' }, title: 'Close SSH', window_s: 300 } }) },
      browser: { account: () => ({ title: 'Change the password on example.com' }) },
    },
    sessionId: 's1',
  };
  const outputs = async (approvals: unknown) => Promise.all(['code_change', 'infra_plan', 'network_change', 'account_change'].map(async (n) => (await (TOOLS as any)[n].run({}, { ...fake, approvals })).output as string));
  try {
    // At the defaults: the registry changes nothing in what the model reads or the tools say.
    assert.equal(toolProtocol(names, core.approvals), toolProtocol(names));
    for (const n of names) assert.equal((TOOLS as any)[n].docFor(core.approvals), (TOOLS as any)[n].doc, n);
    assert.deepEqual(await outputs(core.approvals), await outputs(null));
    const before = await outputs(null);
    assert.match(before[0]!, /Nothing in the repository changes until the person confirms the merge\. Nova asks them before it runs `npm test` and the preview, and again before it merges; they follow it in Tasks\./);
    assert.match(before[1]!, /the person sees the plan in full and confirms any apply in Tasks/);
    assert.match(before[2]!, /nothing changes until the person confirms it in Tasks/);

    lower(core);
    const doc = (n: string) => (TOOLS as any)[n].docFor(core.approvals) as string;
    assert.doesNotMatch(doc('code_change'), /asks the person before|asks again/);
    assert.match(doc('code_change'), /merges into the branch without asking \(the person set that\)/);
    assert.doesNotMatch(doc('infra_plan'), /only when they confirm/);
    assert.doesNotMatch(doc('network_change'), /confirms the change/);
    const [code, infra, network] = await outputs(core.approvals);
    for (const o of [code, infra, network]) assert.doesNotMatch(String(o).replace(/without asking/g, ''), CLAIMS, String(o));
    // Home Assistant at 2 says it asks.
    core.approvals.set('home-assistant.service', 2, {});
    assert.match(doc('home_call'), /After the person’s OK in Tasks/);
  } finally {
    await core.close();
  }
});

test('the outside-content guard: the names it always had, and any registered capability’s chat tool', async () => {
  const { core } = boot();
  try {
    for (const [name, words] of Object.entries(GUARDED)) assert.equal(guardedWords(name, core.approvals), words);
    assert.equal(guardedWords('home_call', null), 'change your home');
    assert.equal(guardedWords('read_file', core.approvals), null);
    core.extensions.install({
      id: 'acme-lights', version: '1.0.0', kind: 'plugin', name: 'Acme lights', capabilities: [], permissions: [], secrets: [], config_schema: {}, setup_flow: null, health_check: {},
      nova_compat: '>=0.1.0 <1.0.0', on_remove: { delete: [], keep: [], export: [] },
      approvals: [{ id: 'switch', name: 'Switch the lights', effect: 'irreversible', tools: ['lights_switch'] }],
    });
    assert.equal(guardedWords('lights_switch', core.approvals), 'take this step (switch the lights)');
    core.extensions.remove('acme-lights');
    assert.equal(guardedWords('lights_switch', core.approvals), null);
  } finally {
    await core.close();
  }
});

test('infrastructure with apply lowered to 1: the plan applies without an OK, and no message claims one; at the default, the words are as before', { timeout: 60_000 }, async () => {
  const { path } = tofuOnPath();
  const messages = (core: Core) => core.db.all<{ text: string }>('SELECT text FROM message').map((m) => m.text).join('\n');
  const run = async (lowered: boolean) => {
    const { core } = boot({ infra: { path: () => path, timeoutS: 60 } });
    core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    try {
      if (lowered) core.approvals.set('infra.apply', 1, { confirm: true });
      const { dir, folder } = makeProject();
      const p = core.infra.createProject({ name: `Example ${dir.slice(-6)}`, folder, budget_usd_month: 20, prices: PRICES, secrets: ['STANDIN_TOKEN'] });
      core.infra.setSecret(p.id, 'STANDIN_TOKEN', fakeToken());
      const { run: { id } } = await core.infra.start({ project: p.id });
      for (let i = 0; i < 800; i++) {
        await core.ledger.idle();
        const v = core.infra.view(id);
        if (lowered ? ['applied', 'failed'].includes(v.state) : v.state === 'review') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const apply = core.infra.view(id).tasks.find((x) => x.step === 'apply')!;
      return { state: core.infra.view(id).state, apply: core.ledger.get(apply.id), messages: messages(core) };
    } finally {
      await core.close();
    }
  };
  const asIs = await run(false);
  assert.equal(asIs.apply.state, 'waiting');
  assert.match(asIs.messages, /is ready for you to review: .*Nova applies it only when you confirm, in Tasks\./);
  const low = await run(true);
  assert.deepEqual([low.state, low.apply.approval_tier, low.apply.approved_at], ['applied', 1, null], low.apply.reason ?? '');
  assert.doesNotMatch(low.messages.replace(/without asking/g, ''), CLAIMS, low.messages);
  assert.match(low.messages, /Nova is applying it now, without asking \(you set applies to not ask\)/);
});

test('Home Assistant’s older settings route reads and writes the registry; a tier kept in its settings file moves there once', async () => {
  const { core } = boot();
  const who = { principal: { kind: 'console' as const }, listener: 'console' as const, address: 'console' };
  const route = (method: string) => core.routes.find((r) => r.method === method && r.path === '/connectors/home-assistant/settings')!;
  try {
    // An older Nova kept service_tier: 2 in the connector's own settings file.
    const dir = core.extensions.dataDir('home-assistant');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ url: 'http://homeassistant.local:8123', service_tier: 2 }));
    const got = await route('GET').handle({ params: {}, query: new URLSearchParams(), body: {}, headers: {}, who }) as { service_tier: number; default_service_tier: number };
    assert.deepEqual([got.service_tier, got.default_service_tier], [2, 1]);
    assert.equal(core.approvals.override('home-assistant.service'), 2, 'moved to the registry');
    assert.deepEqual(core.profile.get('policy', 'approvals'), { 'home-assistant.service': 2 });
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).service_tier, undefined, 'and out of the settings file');
    // The route writes the registry, with its own confirmation rule.
    await assert.rejects(Promise.resolve().then(() => route('PUT').handle({ params: {}, query: new URLSearchParams(), body: { service_tier: 1 }, headers: {}, who })), /confirm: true/);
    const put = await route('PUT').handle({ params: {}, query: new URLSearchParams(), body: { service_tier: 1, confirm: true }, headers: {}, who }) as { service_tier: number };
    assert.equal(put.service_tier, 1);
    assert.equal(core.approvals.override('home-assistant.service'), 1);
    // And the registry's route is read back by the older one.
    core.approvals.set('home-assistant.service', 2, {});
    assert.equal((await route('GET').handle({ params: {}, query: new URLSearchParams(), body: {}, headers: {}, who }) as { service_tier: number }).service_tier, 2);
  } finally {
    await core.close();
  }
});
