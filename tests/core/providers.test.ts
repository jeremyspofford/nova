// The provider registry (M5a): lifecycle, each adapter against a stand-in that speaks its real
// protocol, privacy gating, receipts per call, the JSON files contract's path checks, Nova's own
// verification (a provider that lies ends failed, with the verifier's reason), copy-back only
// after verification, and n8n's signed callback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, type Core } from '../../src/core/index.ts';
import { applyFiles, safePath, unifiedDiff } from '../../src/core/providers/taskspace.ts';
import { checkSignature, signatureHeader } from '../../src/core/providers/n8n.ts';
import { words } from '../../src/core/providers/cli.ts';
import { parseContract } from '../../src/core/providers/prompt.ts';
import { startFakeOpenAI, filesReply } from '../../scripts/stand-ins/fake-openai.js';
import { startFakeN8n } from '../../scripts/stand-ins/fake-n8n.js';
import { FAKE_CLAUDE, FAKE_CODEX, FIXED_SUM, BROKEN_SUM, calcTask, script, writeCalc } from '../support/providers.ts';

const SECRET = 'example-signing-secret-0123456789';

function boot(o: { secrets?: Record<string, string>; privacy?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'nova-providers-'));
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, agent: { command: 'my-model --flag', egress: 'remote' }, secrets: (n) => o.secrets?.[n] ?? null });
  core.profile.set('privacy', 'default', o.privacy ?? 'cloud-allowed', 'settings');
  writeCalc(core.workspace.root);
  return { core, home, ws: core.workspace.root };
}

// Runs until the task settles (done, failed, cancelled, or waiting for something).
async function settle(core: Core, id: string) {
  for (let i = 0; i < 400; i++) {
    await core.ledger.idle();
    const t = core.ledger.get(id);
    if (['done', 'failed', 'cancelled', 'waiting'].includes(t.state)) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  return core.ledger.get(id);
}

// Settles, OK'ing the test run whenever Nova asks to run what a provider wrote.
async function settleOK(core: Core, id: string) {
  let t = await settle(core, id);
  while (t.state === 'waiting' && core.providers.testAsk(id)) {
    core.providers.approveTest(id);
    t = await settle(core, id);
  }
  return t;
}

const claude = (core: Core, kind: Parameters<typeof script>[0], record?: string) => {
  core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${script(kind)}${record ? ` --record ${record}` : ''}` });
  core.providers.enable('claude-code', { approved: true });
};

// ---- the pieces ---------------------------------------------------------------------------------

test('the JSON files contract: every path is checked first, and one bad path changes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-task-'));
  const outside = mkdtempSync(join(tmpdir(), 'nova-outside-'));
  mkdirSync(join(root, 'ok'));
  symlinkSync(outside, join(root, 'door'));
  writeFileSync(join(outside, 'target.txt'), 'untouched');
  symlinkSync(join(outside, 'target.txt'), join(root, 'link.txt'));
  for (const [bad, why] of [
    ['../escape.txt', /climbs out/], ['/etc/passwd', /absolute/], ['ok/../../x', /climbs out/], ['C:/x', /absolute/], ['~/x', /absolute/],
    ['a\\b', /backslashes/], ['a\0b', /NUL/], ['door/x.txt', /symlink/], ['link.txt', /symlink/], ['ok//x', /empty/], ['./x', /"\."/], ['', /no path/],
  ] as const) assert.throws(() => safePath(root, bad), why, String(bad));
  assert.equal(safePath(root, 'ok/new/file.txt').rel, 'ok/new/file.txt');
  assert.throws(() => applyFiles(root, [{ path: 'good.txt', content: 'x' }, { path: 'door/evil.txt', content: 'x' }]), /symlink/);
  assert.equal(existsSync(join(root, 'good.txt')), false, 'nothing is written when any path is refused');
  assert.equal(existsSync(join(outside, 'evil.txt')), false);
  assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'untouched');
  assert.deepEqual(applyFiles(root, [{ path: 'ok/a.txt', content: 'A' }]), ['ok/a.txt']);
  assert.throws(() => applyFiles(root, [{ path: 'x.txt' }]), /no text content/);
  assert.throws(() => parseContract('Sure! Here are the files.'), /isn't the JSON/);
  assert.deepEqual(parseContract('```json\n{"files": [], "notes": "n"}\n```'), { files: [], notes: 'n' });
});

test('diffs, command words and signatures', () => {
  assert.equal(unifiedDiff('a.js', 'x\ny\n', 'x\ny\n'), '');
  assert.equal(unifiedDiff('calc/sum.mjs', BROKEN_SUM, FIXED_SUM), '--- a/calc/sum.mjs\n+++ b/calc/sum.mjs\n@@ -1,2 +1,2 @@\n-export const sum = (a, b) => a - b;\n+export const sum = (a, b) => a + b;\n \n');
  assert.match(unifiedDiff('new.txt', null, 'hi\n'), /^--- \/dev\/null\n\+\+\+ b\/new.txt\n@@ -0,0 \+1,2 @@\n\+hi\n\+\n$/);
  assert.deepEqual(words(`node "/a b/fake.js" --script 'x y.json'`), ['node', '/a b/fake.js', '--script', 'x y.json']);
  const body = '{"a":1}';
  const h = signatureHeader(SECRET, body, 1000);
  assert.equal(checkSignature(SECRET, h, body, 1000), null);
  assert.match(checkSignature(SECRET, h, '{"a":2}', 1000) ?? '', /doesn’t match/);
  assert.match(checkSignature('other', h, body, 1000) ?? '', /doesn’t match/);
  assert.match(checkSignature(SECRET, h, body, 1000 + 301) ?? '', /too old/);
  assert.match(checkSignature(SECRET, undefined, body) ?? '', /no x-nova-signature/);
});

// ---- the registry -------------------------------------------------------------------------------

test('registry lifecycle: built-ins installed and off; configure checks settings; enabling is tier 2 and needs a configured, installed provider', async () => {
  const { core } = boot();
  try {
    const ids = core.providers.list().map((p) => p.id).sort();
    assert.deepEqual(ids, ['claude-code', 'codex', 'custom-cli', 'n8n', 'openai-compatible']);
    assert.ok(core.providers.list().every((p) => !p.enabled));
    assert.ok(!core.ledger.workers.has('claude-code'));
    // Health in plain words, without running anything.
    core.providers.configure('claude-code', { command: '/nowhere/claude' });
    assert.equal(core.providers.health('claude-code').state, 'not_installed');
    assert.match(core.providers.health('claude-code').words, /^Not installed\. Nova can’t find `\/nowhere\/claude`/);
    assert.throws(() => core.providers.enable('claude-code', { approved: true }), /can’t turn on Claude Code yet. Not installed/);
    assert.equal(core.providers.health('openai-compatible').state, 'not_configured');
    assert.match(core.providers.health('openai-compatible').words, /needs a model name/);
    assert.throws(() => core.providers.configure('openai-compatible', { api_key: 'sk-raw-key-value' }), (e: Error & { details?: string[] }) => /secret:\/\/API_KEY/.test(e.details?.join(' ') ?? ''));
    assert.throws(() => core.providers.configure('openai-compatible', { colour: 'teal' }), /no setting called colour/);
    assert.throws(() => core.providers.configure('custom-cli', { command: 'x' }), /nova.config.json/);
    // The model command is Era 2's agent_cmd, as configured.
    assert.equal(core.providers.config('custom-cli').command, 'my-model --flag');
    assert.equal(core.providers.where('custom-cli').receipt, 'remote:my-model');
    core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE}` });
    assert.equal(core.providers.health('claude-code').state, 'ready');
    assert.throws(() => core.providers.enable('claude-code'), /needs your OK on its permissions/);
    core.providers.enable('claude-code', { approved: true });
    assert.ok(core.ledger.workers.has('claude-code'));
    assert.equal(core.ledger.workers.get('claude-code')!.egress, 'remote');
    core.providers.disable('claude-code');
    assert.ok(!core.ledger.workers.has('claude-code'), 'a provider turned off is no longer a worker');
    assert.throws(() => core.extensions.remove('claude-code'), /built into Nova; turn it off instead/);
  } finally {
    await core.close();
  }
});

test('a provider extension: a manifest picks a built-in implementation; a bad adapter block is refused; removal leaves no settings behind', async () => {
  const { core } = boot();
  try {
    const base = core.extensions.get('openai-compatible').manifest as unknown as Record<string, unknown>;
    const m = { ...base, id: 'example.models', name: 'Example models', adapter: { ...(base.adapter as object), egress: 'remote:models.example' } };
    assert.throws(() => core.extensions.install({ ...m, adapter: { ...(base.adapter as object), implementation: 'my-own-code' } }), (e: Error & { details?: string[] }) => /runs no code an extension ships/.test(e.details?.join(' ') ?? ''));
    assert.throws(() => core.extensions.install({ ...m, adapter: undefined }), (e: Error & { details?: string[] }) => /needs an "adapter" block/.test(e.details?.join(' ') ?? ''));
    assert.throws(() => core.extensions.install({ ...m, id: 'workspace' }), (e: Error & { details?: string[] }) => /Nova’s own workers/.test(e.details?.join(' ') ?? ''));
    core.extensions.install(m);
    core.providers.configure('example.models', { base_url: 'https://models.example/v1', model: 'example-1' });
    assert.deepEqual(core.providers.where('example.models'), { coarse: 'remote', receipt: 'remote:models.example', words: 'Sends the brief to models.example.' });
    core.providers.enable('example.models', { approved: true });
    core.providers.choose('chat', 'example.models');
    assert.equal(core.providers.chat()?.id, 'example.models');
    core.extensions.remove('example.models');
    assert.ok(!core.ledger.workers.has('example.models'));
    assert.deepEqual(core.profile.section('providers'), {}, 'its settings and the choice naming it are gone');
    assert.equal(core.providers.chat(), null, 'chat is back on the model command');
  } finally {
    await core.close();
  }
});

// ---- coding agents ------------------------------------------------------------------------------

test('claude-code (stand-in speaking stream-json): asks first for the test run, works in its own folder, Nova runs the test and checks the diff, then copies back', async () => {
  const { core, ws } = boot();
  const record = join(mkdtempSync(join(tmpdir(), 'nova-rec-')), 'calls.jsonl');
  try {
    claude(core, 'honest', record);
    const t = core.ledger.create({ ...calcTask('claude-code'), origin: { kind: 'user' } } as never);
    assert.equal(t.approval_tier, 1, 'nothing to approve before any code exists');
    // Once Claude Code has finished, Nova asks before running the test on what it wrote.
    const asked = await settle(core, t.id);
    assert.equal(asked.state, 'waiting');
    assert.match(asked.reason ?? '', /Nova needs your OK to run `node --test calc\/sum.test.mjs`\. This runs code the provider wrote, as you, with access to your files\./);
    assert.deepEqual(core.providers.testAsk(t.id)?.files.map((f) => f.path), ['calc/sum.mjs']);
    core.providers.approveTest(t.id);
    const done = await settle(core, t.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    assert.ok(done.verification?.ok);
    assert.match(done.verification!.checks.map((c) => c.why).join(' '), /Nova ran `node --test calc\/sum.test.mjs` itself in the task’s folder: it passed/);
    assert.match(done.verification!.checks.map((c) => c.why).join(' '), /Nova compared calc\/sum.mjs .* 1 line added, 1 removed/);
    // Copied back only after verification; the task's folder is gone.
    assert.equal(readFileSync(join(ws, 'calc', 'sum.mjs'), 'utf8'), FIXED_SUM);
    assert.equal(existsSync(join(ws, 'tasks', t.id)), false);
    assert.ok(core.ledger.events(t.id).some((e) => e.kind === 'copied_back'));
    // What Nova sent: the real flags, in the task's folder, the brief on stdin.
    const call = JSON.parse(readFileSync(record, 'utf8').trim().split('\n')[0]!);
    assert.equal(call.cwd, join(ws, 'tasks', t.id));
    for (const flag of ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--strict-mcp-config']) assert.ok(call.argv.includes(flag), flag);
    assert.match(call.stdin, /Make the failing test in calc\/ pass/);
    assert.match(call.stdin, /Nova runs `node --test calc\/sum.test.mjs` itself/);
    // One receipt per call, naming where it went.
    const receipts = core.receipts.list({ task_id: t.id });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.egress, 'remote:anthropic');
    assert.equal(receipts[0]!.provider, 'claude-code');
    assert.ok(receipts[0]!.context_items.some((i) => i.ref === 'workspace:calc/sum.mjs'));
    assert.equal(done.report?.usage.cost_usd, 0.0042);
  } finally {
    await core.close();
  }
});

test('a provider that lies (says it fixed it, changed nothing) ends failed with the verifier’s reason, and nothing is copied back', async () => {
  const { core, ws } = boot();
  try {
    core.profile.set('policy', 'task_tests', 'allow', 'settings');
    claude(core, 'liar');
    const t = core.ledger.create({ ...calcTask('claude-code'), origin: { kind: 'user' } } as never);
    assert.equal(t.approval_tier, 1, 'policy lets the test run without asking on files nobody changed');
    const end = await settle(core, t.id);
    assert.equal(end.state, 'failed');
    assert.match(end.reason ?? '', /The evidence didn't hold up/);
    assert.match(end.reason ?? '', /Nova ran `node --test calc\/sum.test.mjs` itself in the task’s folder and it failed/);
    assert.match(end.reason ?? '', /no file-diff evidence for workspace:calc\/sum.mjs/);
    assert.equal(end.report?.summary.startsWith('Fixed calc/sum.mjs and the test passes.'), true, 'its claim is kept as data');
    assert.equal(readFileSync(join(ws, 'calc', 'sum.mjs'), 'utf8'), BROKEN_SUM, 'nothing was copied back');
    // A change that doesn't fix it: the diff holds, the test doesn't.
    core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${script('wrong')}` });
    const w = await settleOK(core, core.ledger.create({ ...calcTask('claude-code'), origin: { kind: 'user' } } as never).id);
    assert.equal(w.state, 'failed');
    assert.match(w.reason ?? '', /it failed \(exit 1\)/);
    assert.doesNotMatch(w.reason ?? '', /file-diff/);
    assert.equal(readFileSync(join(ws, 'calc', 'sum.mjs'), 'utf8'), BROKEN_SUM);
    // An error result is a failure in plain words.
    core.providers.configure('claude-code', { command: `node ${FAKE_CLAUDE} --script ${script('error')}` });
    const e = await settle(core, core.ledger.create({ ...calcTask('claude-code'), origin: { kind: 'user' } } as never).id);
    assert.equal(e.state, 'failed');
    assert.match(e.reason ?? '', /Claude Code stopped with an error: Credit balance is too low/);
  } finally {
    await core.close();
  }
});

test('codex (stand-in speaking exec --json): the same brief, verified the same way', async () => {
  const { core, ws } = boot();
  const record = join(mkdtempSync(join(tmpdir(), 'nova-rec-')), 'calls.jsonl');
  try {
    core.profile.set('policy', 'task_tests', 'allow', 'settings');
    core.providers.configure('codex', { command: `node ${FAKE_CODEX} --script ${script('honest')} --record ${record}` });
    core.providers.enable('codex', { approved: true });
    const t = await settleOK(core, core.ledger.create({ ...calcTask('codex'), origin: { kind: 'user' } } as never).id);
    assert.equal(t.state, 'done', t.reason ?? '');
    assert.equal(readFileSync(join(ws, 'calc', 'sum.mjs'), 'utf8'), FIXED_SUM);
    const call = JSON.parse(readFileSync(record, 'utf8').trim());
    assert.deepEqual(call.argv.slice(0, 6), ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-']);
    assert.equal(core.receipts.list({ task_id: t.id })[0]!.egress, 'remote:openai');
    assert.equal(t.report?.usage.tokens_in, 150);
  } finally {
    await core.close();
  }
});

// ---- chat models and the files contract -----------------------------------------------------------

test('openai-compatible (stand-in server, SSE): the JSON files contract applied in the task’s folder, local egress, verified', async () => {
  const fake = await startFakeOpenAI({ model: 'example-coder', reply: () => filesReply([{ path: 'calc/sum.mjs', content: FIXED_SUM }], 'It subtracted; now it adds.') });
  const { core, ws } = boot({ privacy: 'local-only' });
  try {
    core.profile.set('policy', 'task_tests', 'allow', 'settings');
    core.providers.configure('openai-compatible', { base_url: fake.url, model: 'example-coder' });
    assert.equal(core.providers.health('openai-compatible').state, 'unchecked');
    await core.providers.check('openai-compatible');
    assert.equal(core.providers.health('openai-compatible').state, 'ready');
    core.providers.enable('openai-compatible', { approved: true });
    const t = await settleOK(core, core.ledger.create({ ...calcTask('openai-compatible', { privacy_mode: 'local-only' }), origin: { kind: 'user' } } as never).id);
    assert.equal(t.state, 'done', t.reason ?? '');
    assert.equal(readFileSync(join(ws, 'calc', 'sum.mjs'), 'utf8'), FIXED_SUM);
    assert.match(t.report?.summary ?? '', /You OK’d running .* Nova ran .* it passed/);
    const sent = fake.requests.find((r) => r.url === '/v1/chat/completions')!.body;
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    assert.match(sent.messages[0].content, /Reply with one JSON object/);
    assert.match(sent.messages[1].content, /<file path="calc\/sum.mjs">\nexport const sum = \(a, b\) => a - b;/);
    assert.equal(core.receipts.list({ task_id: t.id })[0]!.egress, 'local');
    // A wrong model name is unreachable in plain words.
    core.providers.configure('openai-compatible', { model: 'not-pulled' });
    await core.providers.check('openai-compatible');
    assert.match(core.providers.health('openai-compatible').words, /^Unreachable\. .* has no model called not-pulled/);
  } finally {
    await core.close();
    await fake.close();
  }
});

test('a chat model’s reply that reaches outside the task’s folder is refused whole; nothing is written anywhere', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'nova-outside-'));
  let reply = '';
  const fake = await startFakeOpenAI({ model: 'm', reply: () => reply });
  const { core, ws } = boot();
  try {
    core.providers.configure('openai-compatible', { base_url: fake.url, model: 'm' });
    core.providers.enable('openai-compatible', { approved: true });
    const run = async (r: string) => {
      reply = r;
      return settle(core, core.ledger.create({ ...calcTask('openai-compatible', { inputs: {}, evidence_required: [{ kind: 'file_diff' }] }), origin: { kind: 'user' } } as never).id);
    };
    for (const [path, why] of [['../../escape.txt', /climbs out/], [join(outside, 'abs.txt'), /absolute/]] as const) {
      const t = await run(filesReply([{ path: 'calc/sum.mjs', content: FIXED_SUM }, { path, content: 'x' }]));
      assert.equal(t.state, 'failed');
      assert.match(t.reason ?? '', why);
    }
    assert.equal(readFileSync(join(ws, 'calc', 'sum.mjs'), 'utf8'), BROKEN_SUM);
    assert.equal(existsSync(join(ws, 'escape.txt')), false);
    assert.equal(existsSync(join(outside, 'abs.txt')), false);
    // A symlink in the copied-in files is never copied (it could point anywhere).
    symlinkSync(outside, join(ws, 'calc', 'door'));
    const t = await run(filesReply([{ path: 'calc/door/evil.txt', content: 'x' }]));
    assert.equal(t.state, 'done', 'the folder has no link, so this is an ordinary new folder');
    assert.equal(existsSync(join(outside, 'evil.txt')), false);
    const prose = await run('I would change sum.mjs to add.');
    assert.equal(prose.state, 'failed');
    assert.match(prose.reason ?? '', /isn't the JSON Nova asked for/);
  } finally {
    await core.close();
    await fake.close();
  }
});

// ---- privacy ------------------------------------------------------------------------------------

test('privacy: a local-only task refuses a remote provider and says why; a model on this machine is local', async () => {
  const { core } = boot({ privacy: 'local-only' });
  try {
    claude(core, 'honest');
    assert.throws(() => core.ledger.create({ ...calcTask('claude-code', { privacy_mode: 'local-only' }), origin: { kind: 'user' } } as never), /Claude Code sends data off your devices, and this task is local-only/);
    core.providers.configure('openai-compatible', { base_url: 'https://models.example/v1', model: 'm' });
    core.providers.enable('openai-compatible', { approved: true });
    assert.equal(core.providers.where('openai-compatible').receipt, 'remote:models.example');
    assert.throws(() => core.ledger.create({ ...calcTask('openai-compatible', { privacy_mode: 'local-only' }), origin: { kind: 'user' } } as never), /sends data off your devices/);
    core.providers.configure('openai-compatible', { base_url: 'http://127.0.0.1:11434/v1' });
    assert.equal(core.providers.where('openai-compatible').coarse, 'local');
    // A cloud-allowed task under a local-only setting waits, rather than going out.
    const t = core.ledger.create({ ...calcTask('claude-code'), approval_tier: 2, origin: { kind: 'user' } } as never);
    core.ledger.approve(t.id);
    const w = await settle(core, t.id);
    assert.equal(w.state, 'waiting');
    assert.match(w.reason ?? '', /Waiting on local capacity: Claude Code would send this off your devices/);
    assert.equal(core.receipts.list({ task_id: t.id }).length, 0, 'nothing was sent, so there is no receipt');
    // The recommendation keeps to the privacy setting.
    assert.equal(core.providers.recommend('coding-agent').id, null);
    assert.match(core.providers.recommend('coding-agent').why, /privacy setting is local-only/);
  } finally {
    await core.close();
  }
});

// ---- n8n ----------------------------------------------------------------------------------------

test('n8n: a signed brief out, a signed callback in through the token webhook, the confirmation checked by Nova', async () => {
  const { core } = boot({ secrets: { N8N_SIGNING_SECRET: SECRET } });
  const server = (await import('node:http')).createServer(async (req, res) => {
    await core.handle(req, res, new URL(req.url!, 'http://127.0.0.1'), { kind: 'console' }, 'console');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const nova = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let fake = await startFakeN8n({ secret: SECRET, nova, token: 'unset' });
  try {
    assert.equal(core.providers.health('n8n').state, 'not_configured');
    const { token, note } = core.providers.configure('n8n', { webhook_url: fake.url });
    assert.ok(token && note);
    await fake.close();
    fake = await startFakeN8n({ secret: SECRET, nova, token: token! });
    core.providers.configure('n8n', { webhook_url: fake.url });
    core.providers.enable('n8n', { approved: true });
    const task = (title: string) => core.ledger.create({ title, owner: 'n8n', goal: 'Archive this week’s example reports.', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation' }], privacy_mode: 'local-only' });
    const t = await settle(core, task('Run the archive workflow').id);
    assert.equal(t.state, 'done', t.reason ?? '');
    assert.equal(fake.received[0]!.signed, true, 'the stand-in checked Nova’s signature over the exact bytes');
    assert.equal(fake.received[0]!.body.brief.task_id, t.id);
    for (let i = 0; i < 200 && !fake.callbacks.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(fake.callbacks[0]!.status, 202);
    assert.match(t.verification!.checks[0]!.why, /Nova checked the workflow’s callback for this task itself: signed with the shared secret.*confirmation exec-1/);
    assert.equal(core.receipts.list({ task_id: t.id })[0]!.egress, 'local');
    assert.ok(core.triggers.list().some((r) => r.source === 'webhook:n8n-callback'), 'the callback is a trigger record');
    // A callback signed with the wrong secret is refused, and the task doesn't finish on it.
    await fake.close();
    for (const [behavior, status] of [['bad-signature', 403], ['no-confirmation', 400], ['wrong-task', 404]] as const) {
      fake = await startFakeN8n({ secret: SECRET, nova, token: token!, behavior });
      core.providers.configure('n8n', { webhook_url: fake.url, timeout_s: 5 });
      const b = task(`Workflow that misbehaves: ${behavior}`);
      for (let i = 0; i < 200 && !fake.callbacks.length; i++) await new Promise((r) => setTimeout(r, 25));
      assert.equal(fake.callbacks[0]!.status, status, `${behavior}: ${fake.callbacks[0]!.answer}`);
      assert.equal(core.ledger.get(b.id).state, 'active');
      core.ledger.cancel(b.id);
      await fake.close();
    }
    // A wrong token is refused before anything else.
    const r = await fetch(`${nova}/api/v1/hooks/n8n-callback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova-hook-token': 'wrong' }, body: '{}' });
    assert.equal(r.status, 403);
  } finally {
    server.close();
    await fake.close();
    await core.close();
  }
});
