// What keeps a provider's word from becoming Verified by sleight of hand (M5 review): it may change
// only what the brief lets it (never the tests by default), Nova asks before running anything the
// provider wrote and shows what changed, the run gets nothing of the person's environment and
// leaves nothing running, and only what the brief named comes back into the workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { startFakeOpenAI, filesReply } from '../../scripts/stand-ins/fake-openai.js';
import { BROKEN_SUM, FIXED_SUM, SUM_TEST, calcTask, writeCalc } from '../support/providers.ts';

const PASSES = "import { test } from 'node:test';\ntest('adds', () => {});\n";

function boot() {
  const home = mkdtempSync(join(tmpdir(), 'nova-guard-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, agent: { command: 'my-model', egress: 'remote' }, secrets: () => null });
  core.profile.set('privacy', 'default', 'local-only', 'settings');
  // The loosest policy there is: it must still not cover code a provider wrote.
  core.profile.set('policy', 'task_tests', 'allow', 'settings');
  writeCalc(core.workspace.root);
  return { core, ws: core.workspace.root };
}

async function settle(core: Core, id: string) {
  for (let i = 0; i < 400; i++) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  return core.ledger.get(id);
}

async function withModel(files: { path: string; content: string }[], fn: (core: Core, ws: string, run: (over?: Record<string, unknown>) => Promise<ReturnType<Core['ledger']['get']>>) => Promise<void>) {
  const fake = await startFakeOpenAI({ model: 'm', reply: () => filesReply(files, 'Done.') });
  const { core, ws } = boot();
  try {
    core.providers.configure('openai-compatible', { base_url: fake.url, model: 'm' });
    core.providers.enable('openai-compatible', { approved: true });
    const run = async (over: Record<string, unknown> = {}) => settle(core, core.ledger.create({ ...calcTask('openai-compatible', { privacy_mode: 'local-only', ...over }), origin: { kind: 'user' } } as never).id);
    await fn(core, ws, run);
  } finally {
    await core.close();
    await fake.close();
  }
}

const runs = (core: Core) => (existsSync(core.providers.checks.runs) ? readdirSync(core.providers.checks.runs).length : 0);

test('a provider that rewrites the test is refused whole: nothing runs, nothing is copied back', async () => {
  await withModel([{ path: 'calc/sum.test.mjs', content: PASSES }], async (core, ws, run) => {
    const t = await run({ evidence_required: [{ kind: 'test_result' }] });
    assert.equal(t.state, 'failed', t.reason ?? '');
    assert.match(t.reason ?? '', /the provider changed calc\/sum\.test\.mjs, which it was not allowed to change/);
    assert.equal(runs(core), 0, 'the rewritten test never ran');
    assert.equal(readFileSync(join(ws, 'calc', 'sum.test.mjs'), 'utf8'), SUM_TEST);
  });
});

test('what the provider may change: inputs.editable is the list; by default the refs minus tests and what the test command names', async () => {
  // A brief that names the one file to fix; the provider also touches a helper.
  await withModel([{ path: 'calc/sum.mjs', content: FIXED_SUM }, { path: 'calc/helper.mjs', content: 'export {};\n' }], async (_core, ws, run) => {
    const t = await run({ inputs: { test_command: 'node --test calc/sum.test.mjs', editable: ['calc/sum.mjs'] } });
    assert.equal(t.state, 'failed', t.reason ?? '');
    assert.match(t.reason ?? '', /the provider changed calc\/helper\.mjs, which it was not allowed to change/);
    assert.equal(existsSync(join(ws, 'calc', 'helper.mjs')), false);
    const bad = await run({ inputs: { test_command: 'node --test calc/sum.test.mjs', editable: ['../outside'] } });
    assert.equal(bad.state, 'failed');
    assert.match(bad.reason ?? '', /inputs\.editable is a list of paths or globs/);
  });
  // A check script the test command names is as much the test as a *.test.* file.
  await withModel([{ path: 'calc/check.mjs', content: 'process.exit(0);\n' }], async (_core, _ws, run) => {
    const t = await run({ inputs: { test_command: 'node calc/check.mjs' } });
    assert.equal(t.state, 'failed', t.reason ?? '');
    assert.match(t.reason ?? '', /the provider changed calc\/check\.mjs, which it was not allowed to change/);
  });
});

test('Nova asks before running code a provider wrote, whatever the policy, showing the diff; the run is on exactly what was shown', async () => {
  await withModel([{ path: 'calc/sum.mjs', content: FIXED_SUM }], async (core, ws, run) => {
    const t = await run();
    assert.equal(t.state, 'waiting', `policy allow must not cover provider-written code: ${t.reason}`);
    assert.match(t.reason ?? '', /This runs code the provider wrote, as you, with access to your files\./);
    assert.equal(runs(core), 0, 'nothing ran before the OK');
    const ask = core.providers.testAsk(t.id)!;
    assert.equal(ask.command, 'node --test calc/sum.test.mjs');
    assert.deepEqual(ask.files.map((f) => [f.path, f.kind, f.added, f.removed]), [['calc/sum.mjs', 'modified', 1, 1]]);
    assert.match(ask.files[0]!.preview, /\+export const sum = \(a, b\) => a \+ b;/);
    // The API shows the same, and takes the OK.
    const route = (method: string) => core.providers.routes().find((r) => r.method === method && r.path === '/providers/tasks/{task}/test-run')!;
    assert.equal((await route('GET').handle({ params: { task: t.id } } as never) as { command: string }).command, ask.command);
    assert.ok(core.ledger.events(t.id).some((e) => e.kind === 'test_run_asked'));
    await route('POST').handle({ params: { task: t.id } } as never);
    const done = await settle(core, t.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.equal(readFileSync(join(ws, 'calc', 'sum.mjs'), 'utf8'), FIXED_SUM);
    assert.throws(() => core.providers.approveTest(t.id), /isn’t waiting for your OK/);
  });
  // The folder changed between the question and the OK: nothing runs.
  await withModel([{ path: 'calc/sum.mjs', content: FIXED_SUM }], async (core, ws, run) => {
    const t = await run();
    assert.equal(t.state, 'waiting');
    writeFileSync(join(ws, 'tasks', t.id, 'calc', 'sum.mjs'), 'export const sum = () => 5;\n');
    core.providers.approveTest(t.id);
    const end = await settle(core, t.id);
    assert.equal(end.state, 'failed');
    assert.match(end.reason ?? '', /changed after you OK’d running/);
    assert.equal(runs(core), 0);
    assert.equal(readFileSync(join(ws, 'calc', 'sum.mjs'), 'utf8'), BROKEN_SUM);
  });
});

test('the test run gets a bare environment, a home of its own, and nothing it starts outlives it', async () => {
  const { core } = boot();
  process.env.EXAMPLE_API_KEY = 'example-not-a-real-key-123';
  try {
    const space = core.providers.checks.space('00000000-0000-4000-8000-000000000001');
    space.prepare(['workspace:calc']);
    const env = await core.providers.checks.runTest(space, 'env', AbortSignal.timeout(20_000), 20);
    const vars = Object.fromEntries(env.output.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    assert.equal(vars.EXAMPLE_API_KEY, undefined, 'no keys from the environment');
    assert.deepEqual(Object.keys(vars).filter((k) => !['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'PWD', 'SHLVL', '_', 'OLDPWD'].includes(k)), []);
    assert.notEqual(vars.HOME, homedir());
    assert.equal(existsSync(vars.HOME!), false, 'its home is gone afterwards');
  } finally {
    delete process.env.EXAMPLE_API_KEY;
    await core.close();
  }
});

test('a background process a test run leaves behind is stopped when it exits', async () => {
  const { core } = boot();
  const marker = mkdtempSync(join(tmpdir(), 'nova-bg-'));
  try {
    const space = core.providers.checks.space('00000000-0000-4000-8000-000000000002');
    space.prepare(['workspace:calc']);
    const pidFile = join(marker, 'pid');
    await core.providers.checks.runTest(space, `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}`, AbortSignal.timeout(20_000), 20);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
    }
    if (alive) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    assert.equal(alive, false, 'the background process was stopped');
  } finally {
    await core.close();
  }
});

test('copy-back: only what the brief named and let the provider change; never the tasks folder; what stays behind is said', async () => {
  const files = [{ path: 'calc/sum.mjs', content: FIXED_SUM }, { path: 'notes/outside.md', content: 'x\n' }, { path: 'tasks/other-task/planted.txt', content: 'x\n' }];
  await withModel(files, async (core, ws, run) => {
    mkdirSync(join(ws, 'tasks', 'other-task'), { recursive: true });
    const first = await run({ inputs: { test_command: 'node --test calc/sum.test.mjs', editable: ['**'] } });
    if (first.state === 'waiting') core.providers.approveTest(first.id);
    const t = await settle(core, first.id);
    assert.equal(t.state, 'done', t.reason ?? '');
    assert.equal(readFileSync(join(ws, 'calc', 'sum.mjs'), 'utf8'), FIXED_SUM);
    assert.equal(existsSync(join(ws, 'notes', 'outside.md')), false, 'outside the refs');
    assert.equal(existsSync(join(ws, 'tasks', 'other-task', 'planted.txt')), false, 'another task’s folder');
    assert.match(t.report?.summary ?? '', /Not copied into your workspace: notes\/outside\.md \(it is outside what the brief named\); tasks\/other-task\/planted\.txt \(it is in the tasks folder/);
    const note = core.ledger.events(t.id).find((e) => e.kind === 'copied_back')!.detail as { skipped: { path: string }[] };
    assert.deepEqual(note.skipped.map((s) => s.path), ['notes/outside.md', 'tasks/other-task/planted.txt']);
  });
});
