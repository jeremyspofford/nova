// M8 gate against the real Relay (docs/plans/M8.md §3), opt-in: not part of CI, since Relay is a
// private repository. NOVA_RELAY_DIR=<a Relay checkout at v0.9.0> runs it; the checkout is only read:
// Relay gets a fresh data folder (RELAY_DATA_DIR) and an ephemeral port, and its process is stopped,
// by its own pid, when the test ends.
//
// 1. Relay's fake worker (test/fixtures/fake-claude-worker.mjs as RELAY_CLAUDE_BIN; no model, no
//    network): Nova, on a blank home, sends the calc/ brief to the relay provider; a Relay worker runs
//    in a real git worktree; Nova asks before running the test, runs it itself, verifies and copies
//    the fix back. Also: tests/support/relay-contract-v1.json is Relay's contract/v1.json, byte for
//    byte.
// 2. With NOVA_RELAY_MODEL=<an Ollama model> as well: Relay runs the real `claude` CLI against the
//    local Ollama's Anthropic-compatible API (ANTHROPIC_BASE_URL=http://127.0.0.1:11434), with a
//    fresh HOME so the CLI can't use anyone's sign-in. Free and local; Relay must report
//    workerEgress local. If the CLI refuses or the model can't do it, that is recorded as it was.
//
// Both write their part of docs/evidence/m8-gate.md. Nova runs with its egress tripwire, and Relay's
// own process has it too (node --import); the claude CLI is a native binary the tripwire can't
// wrap, so for it the evidence is its settings and Relay's report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, blank, sleep, stop, until } from './support.ts';
import { CONTRACT_FILE } from '../support/relay-contract.ts';
import { BROKEN_SUM, FIXED_SUM, calcTask, writeCalc } from '../support/providers.ts';

const RELAY = process.env.NOVA_RELAY_DIR ?? '';
const MODEL = process.env.NOVA_RELAY_MODEL ?? '';
const EVIDENCE = join(ROOT, 'docs', 'evidence', 'm8-gate.md');
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address() as AddressInfo;
  await new Promise((r) => s.close(r));
  return port;
}

interface Relay { url: string; proc: ChildProcess; out: string[]; data: string; egress: string }

// Relay itself, from its checkout, with its own data folder, port and HOME.
async function startRelay(env: Record<string, string>): Promise<Relay> {
  const root = mkdtempSync(join(tmpdir(), 'nova-m8-relay-'));
  const data = join(root, 'data');
  const egress = join(root, 'relay-egress.log');
  writeFileSync(egress, '');
  mkdirSync(join(root, 'home'));
  const port = await freePort();
  const out: string[] = [];
  const proc = spawn(process.execPath, ['--import', join(ROOT, 'tests/acceptance/egress-guard.ts'), 'server.mjs'], {
    cwd: RELAY,
    env: { PATH: process.env.PATH ?? '', HOME: join(root, 'home'), TZ: 'UTC', RELAY_PORT: String(port), RELAY_DATA_DIR: data, RELAY_CODEX_BIN: '/bin/false', NOVA_EGRESS_LOG: egress, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => out.push(String(d)));
  proc.stderr!.on('data', (d) => out.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 400; i++) {
    if (proc.exitCode !== null) break;
    try { if ((await fetch(`${url}/api/status`)).ok) return { url, proc, out, data, egress }; } catch { /* not yet */ }
    await sleep(50);
  }
  proc.kill('SIGTERM');
  throw new Error(`Relay did not start:\n${out.join('')}`);
}

async function stopRelay(r: Relay): Promise<void> {
  if (r.proc.exitCode === null && r.proc.signalCode === null) r.proc.kill('SIGTERM');
  for (let i = 0; i < 200 && r.proc.exitCode === null && r.proc.signalCode === null; i++) await sleep(25);
  if (r.proc.exitCode === null && r.proc.signalCode === null) r.proc.kill('SIGKILL');
}

// Each test writes its own part of the evidence file and keeps the other's.
function writeEvidence(part: 'fake' | 'model', lines: string[]): void {
  const have = existsSync(EVIDENCE) ? readFileSync(EVIDENCE, 'utf8') : '';
  const section = (p: string) => new RegExp(`<!-- ${p} -->[\\s\\S]*?<!-- /${p} -->`).exec(have)?.[0] ?? `<!-- ${p} -->\n_Not run yet._\n<!-- /${p} -->`;
  const mine = `<!-- ${part} -->\n${lines.join('\n')}\n<!-- /${part} -->`;
  const body = [
    '# M8 gate evidence — Nova and the real Relay',
    '',
    'Written by `tests/acceptance/m8-relay-real.test.ts` (opt-in: `NOVA_RELAY_DIR`, and `NOVA_RELAY_MODEL` for the model run). Not part of CI; the CI half is `tests/acceptance/m8-relay.test.ts` against the stand-in.',
    '',
    'Worktree paths are in the test run’s own temporary folder, removed when the run ends. `costUsd` is what the engine reports: the claude CLI prices tokens from its own table by model name, so a local model shows a nominal cost although nothing is billed. Relay enforces no cost cap.',
    '',
    part === 'fake' ? mine : section('fake'),
    '',
    part === 'model' ? mine : section('model'),
    '',
  ].join('\n');
  mkdirSync(join(ROOT, 'docs', 'evidence'), { recursive: true });
  writeFileSync(EVIDENCE, body);
}

// One brief, end to end, the way a person would: Nova sends it, asks before running the test on what
// Relay's worker wrote (the OK is given here), checks it and copies it back. Returns what the
// evidence needs.
async function brief(relay: Relay, o: { title: string; part: 'fake' | 'model'; env: string; waitMs: number }) {
  const m = blank('nova-m8-real-');
  const nova = await m.start();
  const api = (p: string) => `/api/v1${p}`;
  const started = Date.now();
  try {
    writeCalc(join(m.home, 'workspace'));
    const status = await (await fetch(`${relay.url}/api/status`)).json() as { version: string; api: number; workerEgress: string; engines: { id: string; workersAvailable?: boolean; version?: string }[] };
    assert.equal(status.api, 1);
    assert.equal((await m.send('PUT', api('/providers/relay/config'), { config: { base_url: relay.url, poll_ms: 300 } })).status, 200);
    assert.equal((await m.send('POST', api('/providers/relay/enable'), { approved: true })).body.enabled, true);
    const checked = await m.send('POST', api('/providers/relay/check'));
    assert.equal(checked.body.health.state, 'ready', checked.body.health.words);
    assert.equal(status.workerEgress, 'local', 'Relay reports its workers stay on this computer');
    assert.equal(checked.body.egress.receipt, 'local');

    const created = await m.send('POST', api('/tasks'), calcTask('relay', { privacy_mode: 'local-only' }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id as string;
    let t: any;
    let asked = '';
    const tries = Math.ceil(o.waitMs / 25);
    for (;;) {
      t = await until<any>(() => m.get(api(`/tasks/${id}`)), (x) => ['done', 'failed', 'cancelled'].includes(x.state) || (x.state === 'waiting' && /OK/.test(x.reason ?? '')), tries);
      if (t.state !== 'waiting') break;
      const ask = await m.send('GET', api(`/providers/tasks/${id}/test-run`));
      assert.equal(ask.status, 200, `waiting, but not for the test run: ${t.reason}`);
      asked = `${ask.body.files.map((f: { path: string }) => f.path).join(', ') || '(no files changed)'} — “${ask.body.words}”`;
      await m.send('POST', api(`/providers/tasks/${id}/test-run`), {});
      await until<any>(() => m.get(api(`/tasks/${id}`)), (x) => x.state !== 'waiting', 400);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    const receipts = await m.get(api(`/receipts?task_id=${id}`));
    const events = await m.get(api(`/tasks/${id}/events`));
    const art = (t.report?.artifacts ?? []).find((a: { kind: string }) => a.kind === 'relay-run');
    const run = art ? await (await fetch(`${relay.url}/api/workers/${art.ref}`)).json() as Record<string, any> : null;
    // The run Relay last started, when Nova's report carries none (a failed run).
    const runs = existsSync(join(relay.data, 'worktrees')) ? execFileSync('ls', [join(relay.data, 'worktrees')]).toString().split('\n').filter(Boolean) : [];
    const worktreeBranch = art && existsSync(art.worktree) ? git(art.worktree, 'rev-parse', '--abbrev-ref', 'HEAD') : null;
    const novaEgress = readFileSync(m.egress, 'utf8');
    const relayEgress = readFileSync(relay.egress, 'utf8');
    const sum = readFileSync(join(m.home, 'workspace', 'calc', 'sum.mjs'), 'utf8');
    const fence = '```';
    const lines = [
      `## ${o.title}`,
      '',
      `Run ${new Date().toISOString()}, ${seconds} s from brief to verified. Nova commit \`${git(ROOT, 'rev-parse', '--short', 'HEAD')}\`; Relay ${status.version} at \`${git(RELAY, 'rev-parse', '--short', 'HEAD')}\` (${RELAY}), on an ephemeral port with a fresh data folder. ${o.env}`,
      '',
      `- **Relay status:** api ${status.api}, workerEgress \`${status.workerEgress}\`, engines: ${status.engines.map((e) => `${e.id} (${e.workersAvailable ? 'workers' : 'no workers'}${e.version ? `, ${e.version}` : ''})`).join(', ')}.`,
      `- **Brief:** ${t.title}, privacy local-only (\`${calcTask('x').inputs.test_command}\`, evidence: test_result + file_diff).`,
      `- **Asked before running the worker's code:** ${asked || '(not asked)'}.`,
      `- **Outcome:** ${t.state}${t.reason ? ` — ${String(t.reason).replace(/[.\s]+$/, '')}` : ''}.`,
      ...((t.verification?.checks ?? []) as { ok: boolean; why: string; requirement: { kind: string } }[]).map((c) => `- **${c.requirement.kind}:** ${c.ok ? 'passed' : 'failed'} — ${c.why}`),
      art ? `- **Relay run:** \`${art.ref}\`, status ${run?.status}, branch \`${art.branch}\` (the worktree's HEAD: \`${worktreeBranch}\`), worktree \`${art.worktree}\`, base \`${String(art.baseCommit).slice(0, 12)}\`, files ${JSON.stringify(art.files)}, usage ${JSON.stringify(run?.usage)}, costUsd ${run?.costUsd}. Relay's summary: “${run?.text}”.` : `- **Relay run:** none in Nova's report (worktrees in Relay's data folder: ${runs.join(', ') || 'none'}).`,
      `- **Workspace after:** calc/sum.mjs is ${sum === FIXED_SUM ? 'the fix' : sum === BROKEN_SUM ? 'unchanged (still broken)' : 'changed'}.`,
      `- **Receipts:** ${receipts.map((r: { provider: string; model: string; egress: string }) => `${r.provider} / ${r.model} (egress ${r.egress})`).join(', ') || 'none'}.`,
      `- **Events:** ${events.map((e: { kind: string }) => e.kind).join(' → ')}.`,
      `- **Egress tripwire:** Nova: ${novaEgress === '' ? 'nothing tried to leave this machine' : `tried to leave: ${novaEgress.trim()}`}. Relay's own process: ${relayEgress === '' ? 'nothing tried to leave this machine' : `tried to leave: ${relayEgress.trim()}`}.`,
      '',
      ...(art?.diff ? ["Relay's diff (provider-reported, kept in the `relay-run` artifact):", '', `${fence}diff`, String(art.diff).trimEnd(), fence, ''] : []),
    ];
    writeEvidence(o.part, lines);
    console.log(lines.join('\n'));
    assert.equal(novaEgress, '', 'Nova reached nothing outside this machine');
    assert.equal(relayEgress, '', 'Relay reached nothing outside this machine');
    assert.ok(receipts.length >= 1 && receipts.every((r: { egress: string }) => r.egress === 'local'), 'every receipt says local');
    return { t, art, run, worktreeBranch, sum };
  } finally {
    await stop(nova);
  }
}

test('M8 gate (real Relay): the contract copy is Relay’s own file, byte for byte', { skip: !RELAY && 'set NOVA_RELAY_DIR to a Relay checkout at v0.9.0' }, () => {
  assert.ok(readFileSync(join(RELAY, 'contract', 'v1.json')).equals(readFileSync(CONTRACT_FILE)), 'tests/support/relay-contract-v1.json matches contract/v1.json');
});

test('M8 gate (real Relay, fake worker): the calc/ brief, run by a Relay worker in a real worktree, verified by Nova', { skip: !RELAY && 'set NOVA_RELAY_DIR to a Relay checkout at v0.9.0', timeout: 180_000 }, async () => {
  const relay = await startRelay({ RELAY_CLAUDE_BIN: join(RELAY, 'test', 'fixtures', 'fake-claude-worker.mjs'), ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' });
  try {
    const r = await brief(relay, {
      title: 'Relay’s fake worker (no model)', part: 'fake', waitMs: 60_000,
      env: '`RELAY_CLAUDE_BIN` is Relay’s `test/fixtures/fake-claude-worker.mjs` (its honest default: it fixes calc/sum.mjs); `ANTHROPIC_BASE_URL=http://127.0.0.1:9`, so Relay reports local.',
    });
    assert.equal(r.t.state, 'done', r.t.reason);
    assert.ok(r.t.verification.ok);
    assert.deepEqual(r.t.verification.checks.map((c: { requirement: { kind: string } }) => c.requirement.kind).sort(), ['file_diff', 'test_result']);
    assert.ok(r.art, 'the relay-run artifact is recorded');
    assert.ok(existsSync(r.art.worktree), 'the worktree is real');
    assert.equal(r.art.branch, `relay/${r.art.ref}`);
    assert.equal(r.worktreeBranch, `relay/${r.art.ref}`, 'the worktree is on the run’s branch');
    assert.equal(r.run!.status, 'completed');
    assert.match(r.art.diff, /^\+export const sum = \(a, b\) => a \+ b;$/m, 'Relay’s diff shows the fix');
    assert.equal(readFileSync(join(r.art.worktree, 'calc', 'sum.mjs'), 'utf8'), FIXED_SUM);
    assert.equal(r.sum, FIXED_SUM, 'copied back after verification');
  } finally {
    await stopRelay(relay);
  }
});

test('M8 gate (real Relay, a local model): the real claude CLI against the local Ollama, free and local', { skip: !(RELAY && MODEL) && 'set NOVA_RELAY_DIR and NOVA_RELAY_MODEL (an Ollama model) to run', timeout: 1_800_000 }, async () => {
  const relay = await startRelay({
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'ollama', ANTHROPIC_API_KEY: '', ANTHROPIC_MODEL: MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
  try {
    const r = await brief(relay, {
      title: `The real claude CLI on a local model (${MODEL})`, part: 'model', waitMs: 1_500_000,
      env: `\`RELAY_CLAUDE_BIN\` unset (Relay runs \`claude\`, ${execFileSync('claude', ['--version']).toString().trim()}), \`ANTHROPIC_BASE_URL=http://127.0.0.1:11434\` (Ollama ${await fetch('http://127.0.0.1:11434/api/version').then((x) => x.json()).then((v: { version: string }) => v.version).catch(() => '?')}), \`ANTHROPIC_AUTH_TOKEN=ollama\`, \`ANTHROPIC_API_KEY\` empty, \`ANTHROPIC_MODEL=${MODEL}\`, \`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1\`, and a fresh empty \`HOME\`: no sign-in, no subscription.`,
    });
    // The outcome is recorded either way; a model that can't do it is a failed task with Nova's
    // reason, never a pass.
    if (r.t.state === 'done') {
      assert.ok(r.t.verification.ok);
      assert.ok(existsSync(r.art.worktree));
      assert.equal(r.worktreeBranch, `relay/${r.art.ref}`);
    } else {
      assert.equal(r.t.state, 'failed', r.t.reason);
      assert.equal(r.sum, BROKEN_SUM, 'nothing unverified was copied back');
    }
  } finally {
    await stopRelay(relay);
  }
});
