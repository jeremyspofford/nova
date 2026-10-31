// M10a gate, end to end: a new user's Nova (blank profile, setup by conversation, local-only) makes a
// project workspace, runs commands in it as Work Ledger tasks whose output is evidence the test checks
// itself, undoes a write, resets, is refused egress while local-only, and survives a restart, all
// through the API of the real server with the egress tripwire preloaded. Set NOVA_EVIDENCE=<file> to
// keep a transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockerSkip } from '../core/computer-support.ts';
import { blank, sleep, stop } from './support.ts';

const skip = await dockerSkip();

test('M10a gate: a fresh user’s workspace — a command as a ledger task with evidence, checkpoint and reset, no egress when local-only, durable across a restart', { skip: skip ?? false, timeout: 300_000 }, async () => {
  const m = blank('nova-m10a-');
  const get = async (p: string) => m.get(`/api/v1${p}`);
  const post = async (p: string, body: unknown = {}) => m.send('POST', `/api/v1${p}`, body);
  const settle = async (id: string) => {
    let t = await get(`/tasks/${id}`);
    for (let i = 0; i < 2400 && !['done', 'failed', 'waiting', 'cancelled'].includes(t.state); i++) { await sleep(25); t = await get(`/tasks/${id}`); }
    return t;
  };
  const evidence: string[] = ['# M10a gate: Nova Computer, end to end', ''];
  // A command's output as Nova kept it, read by the test from the file on disk: the API hands raw
  // output back only when the ingest gate passed it, and with no local model here it holds it back.
  const kept = (id: string) => JSON.parse(readFileSync(join(m.home, 'workers', 'computer', 'runs', `${id}.json`), 'utf8')) as { stdout: string };
  let nova = await m.start();
  let ws = '';
  try {
    // A new user: setup by conversation, local-only.
    for (const text of ['new', 'yes', 'yes', "Hi! I'm Sam.", 'yes', 'keep', 'plainly, please', 'keep everything on this machine', 'no', 'yes']) assert.equal((await post('/setup/messages', { text })).status, 200);
    assert.equal((await get('/profile')).privacy.default, 'local-only');
    const c0 = await get('/computer');
    assert.equal(c0.available, true, c0.detail);
    assert.deepEqual(c0.workspaces, []);
    assert.match(c0.image, /@sha256:[0-9a-f]{64}$/);
    evidence.push(`- Computer: ${c0.detail} Image ${c0.image}.`);

    // A project workspace (Nova's own empty folder): tier 1, done, verified by Nova.
    const made = await post('/computer/workspaces', { name: 'Project' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.owner, 'computer');
    assert.equal(made.body.approval_tier, 1);
    const create = await settle(made.body.id);
    assert.equal(create.state, 'done', create.reason);
    assert.equal(create.verification.ok, true);
    ws = create.brief.inputs.workspace;
    evidence.push(`- Created workspace ${ws}: ${create.report.summary}`, `  - Verified: ${create.verification.checks[0].why}`);

    // A command runs as a ledger task; its output is evidence.
    const w = await post(`/computer/workspaces/${ws}/exec`, { argv: ['sh', '-c', 'printf "%s\\n" "hello from the workspace" > hello.txt && node --version'] });
    assert.equal(w.body.approval_tier, 1);
    const write = await settle(w.body.id);
    assert.equal(write.state, 'done', write.reason);
    assert.deepEqual((await get(`/tasks/${write.id}/events`)).map((e: { kind: string }) => e.kind), ['created', 'dispatched', 'reported', 'verifying', 'verified']);
    const run = await get(`/computer/runs/${write.id}`);
    assert.match(kept(write.id).stdout, /^v26\./);
    if (run.verdict !== 'pass') {
      assert.equal(run.record.stdout, undefined, 'held-back output isn’t handed back');
      assert.match(run.record.withheld, new RegExp(run.verdict));
    }
    // The test checks the evidence itself: the output file on disk matches what Nova recorded.
    const file = readFileSync(join(m.home, 'workers', 'computer', 'runs', `${write.id}.json`));
    assert.equal(createHash('sha256').update(file).digest('hex'), run.sha256);
    assert.equal(write.report.artifacts[0].sha256, run.sha256);
    assert.equal(JSON.parse(String(file)).stdout, kept(write.id).stdout);
    assert.ok(['pass', 'quarantine', 'block'].includes(run.record.screen.verdict) && run.record.screen.id, 'the output was screened by the ingest gate');
    evidence.push(`- Ran \`${write.brief.inputs.argv.join(' ')}\` (tier ${write.approval_tier}): ${write.report.summary}`,
      `  - Events: ${(await get(`/tasks/${write.id}/events`)).map((e: { kind: string }) => e.kind).join(', ')}`,
      `  - Output file sha256 ${run.sha256.slice(0, 16)}…, checked by the test against the file on disk; screened ${run.record.screen.verdict} (screen ${run.record.screen.id}).`);

    const r = await post(`/computer/workspaces/${ws}/exec`, { argv: ['cat', 'hello.txt'], access: 'read' });
    assert.equal(r.body.approval_tier, 0);
    const read = await settle(r.body.id);
    assert.equal(read.state, 'done', read.reason);
    assert.equal(kept(read.id).stdout, 'hello from the workspace\n');

    // Undo the write: back to the checkpoint before it.
    const u = await post(`/computer/runs/${write.id}/undo`);
    const undo = await settle(u.body.id);
    assert.equal(undo.state, 'done', undo.reason);
    const after = await settle((await post(`/computer/workspaces/${ws}/exec`, { argv: ['ls', '-A'], access: 'read' })).body.id);
    assert.equal(kept(after.id).stdout, '', 'the folder is as it was before the write');
    evidence.push(`- Undo: ${undo.report.summary}`, `  - Verified: ${undo.verification.checks[0].why}`);

    // From inside, Nova's console isn't there (tested in full in m10a-isolation).
    const probe = await settle((await post(`/computer/workspaces/${ws}/exec`, { argv: ['node', '-e', `const s=require('net').connect(${nova.port},'127.0.0.1');s.on('connect',()=>{console.log('REACHED');process.exit(0)});s.on('error',(e)=>{console.log(e.code);process.exit(0)})`], access: 'read' })).body.id);
    assert.equal(kept(probe.id).stdout.trim(), 'ECONNREFUSED');

    // Local-only: no egress, refused before anything runs.
    for (const egress of [{ mode: 'registries' }, { mode: 'hosts', hosts: ['example.test'] }]) {
      const out = await post('/computer/workspaces', { name: 'Out', egress });
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.match(out.body.error, /local-only/);
    }
    evidence.push('- Egress while local-only: refused by the ledger (400) for registries and for declared hosts.');
    const view = await get(`/computer/workspaces/${ws}`);
    assert.equal(view.state, 'ready');
    assert.ok(view.checkpoints.length >= 3, 'clean, before the write, before the undo');
  } finally {
    await stop(nova);
  }

  // A restart: the workspace is still there and still runs.
  nova = await m.start();
  try {
    assert.equal((await get('/computer')).workspaces[0].id, ws);
    const again = await settle((await post(`/computer/workspaces/${ws}/exec`, { argv: ['node', '-e', 'console.log(1 + 1)'], access: 'read' })).body.id);
    assert.equal(again.state, 'done', again.reason);
    assert.equal(kept(again.id).stdout, '2\n');
    // Reset to the clean state, then delete: tier 3, asked every time.
    const reset = await settle((await post(`/computer/workspaces/${ws}/reset`)).body.id);
    assert.equal(reset.state, 'done', reset.reason);
    const del = (await post(`/computer/workspaces/${ws}/destroy`)).body;
    assert.equal(del.approval_tier, 3);
    assert.equal((await settle(del.id)).state, 'waiting');
    assert.equal((await post(`/tasks/${del.id}/approve`, { confirm: true })).status, 200);
    assert.equal((await settle(del.id)).state, 'done');
    assert.deepEqual((await get('/computer')).workspaces, []);
    assert.equal((await get('/problems')).length, 0, 'nothing went wrong along the way');
    evidence.push(`- After a restart the workspace ran again; reset to clean; deleted at tier 3 after the OK.`);
  } finally {
    await stop(nova);
  }
  // Nova itself sent nothing off this machine.
  assert.equal(readFileSync(m.egress, 'utf8').trim(), '');
  evidence.push('- Connections Nova attempted off this machine: none (tripwire on every TCP connect).', '');
  if (process.env.NOVA_EVIDENCE) writeFileSync(process.env.NOVA_EVIDENCE, evidence.join('\n'));
});
