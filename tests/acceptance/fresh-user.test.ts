// M1 gate — fresh-user acceptance test #1 (ROADMAP-AND-GATES, PROFILES-AND-CUSTOMIZATION):
// a blank profile, setup completed by conversation, one task delegated and verified with
// evidence, all in local-only mode. It runs the real server as its own process, as a new user
// would, with an egress tripwire preloaded. Set NOVA_EVIDENCE=<file> to keep a transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sampleManifest } from '../core/fixtures.ts';
import { blank, sleep, stop } from './support.ts';

test('fresh user: blank profile → conversational setup → a delegated task verified with evidence, local-only, durable across a restart', async () => {
  // A new machine: its own user folder, nothing pinned, no config file in play.
  const m = blank('nova-fresh-');
  const { home, egress } = m;
  const get = (p: string) => m.get(`/api/v1${p}`);
  const post = async (p: string, body: unknown) => {
    const r = await m.send('POST', `/api/v1${p}`, body);
    return { status: r.status, body: r.body };
  };
  const evidence: string[] = ['# Fresh-user acceptance test #1', ''];

  let nova = await m.start();
  try {
    // 1. Blank: no profile, setup not done, nothing in the ledger.
    const h0 = await get('/health');
    assert.equal(h0.ok, true);
    assert.equal(h0.setup.done, false);
    assert.deepEqual(await get('/profile'), { identity: {}, user: {}, tuning: {}, privacy: {}, policy: {}, appearance: {}, mesh: {}, providers: {} });
    // The built-in design systems are there without the person doing anything; Orb Teal shows.
    assert.equal((await get('/design-systems')).length, 6);
    assert.equal((await get('/design-systems/active')).id, 'orb-teal');
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
      appearance: {},
      mesh: {},
      providers: {},
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
    const removed = await m.send('DELETE', '/api/v1/extensions/example.weather');
    assert.equal(removed.status, 200);
    // Built-in design systems and providers stay; the providers are installed but none is on.
    assert.deepEqual((await get('/extensions')).filter((x: { kind: string }) => !['design-system', 'agent-adapter', 'automation-adapter'].includes(x.kind)), []);
    assert.deepEqual((await get('/extensions')).filter((x: { kind: string; state: string }) => x.kind.endsWith('-adapter') && x.state === 'enabled'), []);
    assert.equal(readdirSync(join(home, 'extensions')).includes('example.weather'), false);
    evidence.push('## Extension', '', `- Installed \`example.weather\` (disabled, review: ${ext.body.review.join(' / ')}), then removed: no record, no data folder left.`, '');
  } finally {
    await stop(nova);
  }

  // 6. Restart: the profile, the setup state and the finished task are all still there.
  nova = await m.start();
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
