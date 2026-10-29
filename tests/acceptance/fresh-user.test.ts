// M1 gate — fresh-user acceptance test #1 (ROADMAP-AND-GATES, PROFILES-AND-CUSTOMIZATION):
// a blank profile, setup completed by conversation, one task delegated and verified with
// evidence, all in local-only mode. It runs the real server as its own process, as a new user
// would, with an egress tripwire preloaded. Set NOVA_EVIDENCE=<file> to keep a transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleManifest } from '../core/fixtures.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => ok(port)); }); });

interface Running { proc: ChildProcess; out: string[] }

async function start(env: Record<string, string>): Promise<Running> {
  const out: string[] = [];
  const proc = spawn(process.execPath, ['--import', join(ROOT, 'tests/acceptance/egress-guard.ts'), 'src/server.js'], { cwd: ROOT, env: { ...env, PATH: process.env.PATH ?? '' } });
  proc.stdout!.on('data', (d) => out.push(String(d)));
  proc.stderr!.on('data', (d) => out.push(String(d)));
  for (let i = 0; i < 200 && !out.join('').includes('Nova is ready'); i++) {
    if (proc.exitCode !== null) break;
    await sleep(25);
  }
  assert.ok(out.join('').includes('Nova is ready'), `server did not start:\n${out.join('')}`);
  return { proc, out };
}

async function stop(r: Running) {
  r.proc.kill('SIGTERM');
  for (let i = 0; i < 200 && r.proc.exitCode === null; i++) await sleep(25);
}

test('fresh user: blank profile → conversational setup → a delegated task verified with evidence, local-only, durable across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nova-fresh-'));
  const home = join(dir, 'nova-home');
  const egress = join(dir, 'egress.log');
  writeFileSync(egress, '');
  const port = await freePort();
  // A new machine: its own user folder, nothing pinned, no config file in play.
  const env = { HOME: join(dir, 'user'), NOVA_HOME: home, NOVA_PORT: String(port), NOVA_EGRESS_LOG: egress, TZ: 'UTC' };
  const base = `http://127.0.0.1:${port}/api/v1`;
  const get = async (p: string) => (await fetch(base + p)).json();
  const post = async (p: string, body: unknown) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const evidence: string[] = ['# Fresh-user acceptance test #1', ''];

  let nova = await start(env);
  try {
    // 1. Blank: no profile, setup not done, nothing in the ledger.
    const h0 = await get('/health');
    assert.equal(h0.ok, true);
    assert.equal(h0.setup.done, false);
    assert.deepEqual(await get('/profile'), { identity: {}, user: {}, tuning: {}, privacy: {}, policy: {} });
    assert.deepEqual(await get('/tasks'), []);

    // 2. Setup, as a conversation.
    const first = await get('/setup');
    evidence.push('## Setup conversation', '', `**Nova:** ${first.question}`, '');
    const answers = ["Hi! I'm Sam.", 'yes', 'keep', 'plainly, please', 'keep everything on this machine', 'yes'];
    let last: { reply: string; view: { done: boolean }; task: { id: string } | null } | null = null;
    for (const text of answers) {
      const r = await post('/setup/messages', { text });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      last = r.body;
      evidence.push(`**Person:** ${text}`, '', `**Nova:** ${r.body.reply}`, '');
    }
    assert.equal(last!.view.done, true);
    assert.ok(last!.task, 'setup started the first task');
    const profile = await get('/profile');
    assert.deepEqual(profile, {
      identity: { name: 'Nova' },
      user: { name: 'Sam', address_as: 'Sam', timezone: 'UTC' },
      tuning: { directness: 'balanced' },
      privacy: { default: 'local-only' },
      policy: {},
    });
    evidence.push('## Profile written by the conversation', '', '```json', JSON.stringify(profile, null, 2), '```', '');

    // 3. The task: delegated to the local worker, verified, done.
    let task = await get(`/tasks/${last!.task!.id}`);
    for (let i = 0; i < 200 && !['done', 'failed', 'waiting'].includes(task.state); i++) {
      await sleep(25);
      task = await get(`/tasks/${task.id}`);
    }
    assert.equal(task.state, 'done', task.reason);
    assert.equal(task.privacy_mode, 'local-only');
    assert.equal(task.brief.envelope, '1');
    assert.equal(task.verification.ok, true);
    const workers = await get('/workers');
    assert.equal(workers.find((w: { id: string }) => w.id === task.owner).egress, 'none');

    // 4. Check the evidence independently of Nova: read the file from disk ourselves.
    const file = join(home, 'workspace', 'welcome.md');
    const bytes = readFileSync(file);
    const claim = task.report.evidence[0];
    assert.equal(claim.kind, 'read_back');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), claim.sha256);
    assert.equal(bytes.length, claim.bytes);
    const events = await get(`/tasks/${task.id}/events`);
    assert.deepEqual(events.map((e: { kind: string }) => e.kind), ['created', 'dispatched', 'reported', 'verifying', 'verified']);
    evidence.push('## The task', '', `- ${task.title}: **${task.state}**, ${task.privacy_mode}, owner \`${task.owner}\` (egress: none)`,
      `- Report: ${task.report.summary}`, `- Verification: ${task.verification.checks.map((c: { why: string }) => c.why).join(' ')}`,
      `- Independent check by the test: sha256 ${claim.sha256.slice(0, 16)}…, ${claim.bytes} bytes — matches`,
      `- Events: ${events.map((e: { kind: string; to_state: string | null }) => `${e.kind}${e.to_state ? `→${e.to_state}` : ''}`).join(', ')}`, '');

    // 5. An extension, installed and removed cleanly.
    const ext = await post('/extensions', { manifest: sampleManifest() });
    assert.equal(ext.status, 201);
    const removed = await fetch(`${base}/extensions/example.weather`, { method: 'DELETE', headers: { 'x-nova': '1' } });
    assert.equal(removed.status, 200);
    assert.deepEqual(await get('/extensions'), []);
    assert.deepEqual(readdirSync(join(home, 'extensions')), []);
    evidence.push('## Extension', '', `- Installed \`example.weather\` (disabled, review: ${ext.body.review.join(' / ')}), then removed: no record, no data folder left.`, '');
  } finally {
    await stop(nova);
  }

  // 6. Restart: the profile, the setup state and the finished task are all still there.
  nova = await start(env);
  try {
    const h1 = await get('/health');
    assert.equal(h1.setup.done, true);
    assert.equal(h1.checks.ledger.counts.done, 1);
    assert.equal((await get('/identity')).identity.user_name, 'Sam');
    assert.equal((await get('/problems')).length, 0, 'nothing went wrong along the way');
    evidence.push('## After a restart', '', `- Health ok: ${h1.ok}; setup done: ${h1.setup.done}; tasks done: ${h1.checks.ledger.counts.done}; open problems: ${h1.checks.problems.open}`, '');
  } finally {
    await stop(nova);
  }

  // 7. Local-only held: nothing tried to leave the machine.
  const leaks = readFileSync(egress, 'utf8').trim();
  assert.equal(leaks, '', `connections off this machine:\n${leaks}`);
  assert.ok(existsSync(join(home, 'nova.db')));
  evidence.push('## Egress', '', '- Connections attempted off this machine across both runs: **none** (tripwire on every TCP connect).', '');

  if (process.env.NOVA_EVIDENCE) writeFileSync(process.env.NOVA_EVIDENCE, evidence.join('\n'));
});
