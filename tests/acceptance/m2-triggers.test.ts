// M2 gate (ROADMAP-AND-GATES): an event trigger and a heartbeat job each produce ledger tasks; a
// proactive message traces to its trigger record; local-only mode never calls a remote provider,
// verified by the egress log. The real server, a blank local-only profile, the default (cloud)
// chat model configured, and the egress tripwire. NOVA_EVIDENCE=<file> keeps a transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { blank, stop, until } from './support.ts';

test('M2 gate: event and heartbeat triggers make verified ledger tasks; a proactive message traces to its trigger; local-only holds', async () => {
  const m = blank('nova-m2-');
  const nova = await m.start({ NOVA_TEST_CLOCK: '1' });
  const evidence: string[] = ['# M2 gate', ''];
  const task = (path: string, content: string) => ({
    kind: 'task',
    task: { title: `Write ${path}`, owner: 'workspace', goal: `${path} is in the workspace.`, evidence_required: [{ kind: 'read_back', target: `workspace:${path}` }], inputs: { action: 'append', path, content } },
  });
  const settled = (id: string) => until<any>(() => m.get(`/api/v1/tasks/${id}`), (t) => ['done', 'failed', 'waiting', 'cancelled'].includes(t.state));

  try {
    assert.equal((await m.get('/api/v1/profile')).privacy.default, undefined, 'blank profile');
    assert.equal((await m.get('/api/v1/health')).ok, true);

    // 1. An event trigger: a webhook rule, called twice with the same payload.
    const event = await m.send('POST', '/api/v1/triggers/rules', { name: 'Example inbox', class: 'event', hook: 'example-inbox', action: task('inbox.md', 'event\n') });
    assert.equal(event.status, 201);
    const token = event.body.token as string;
    assert.match(token, /.{20,}/);
    assert.equal((await m.send('POST', '/api/v1/hooks/example-inbox', { subject: 'hello' }, {})).status, 403, 'no token, no entry');
    const fired = await m.send('POST', '/api/v1/hooks/example-inbox', { subject: 'hello' }, { 'x-nova-hook-token': token });
    assert.equal(fired.status, 202);
    assert.equal(fired.body.decision, 'act');
    const again = await m.send('POST', '/api/v1/hooks/example-inbox', { subject: 'hello' }, { 'x-nova-hook-token': token });
    assert.equal(again.body.decision, 'drop', 'the same event twice is one piece of work');
    const eventTrigger = await m.get(`/api/v1/triggers/${fired.body.trigger_id}`);
    const eventTask = await settled(eventTrigger.ledger_task_id);
    assert.equal(eventTask.state, 'done', eventTask.reason);
    assert.deepEqual(eventTask.origin, { kind: 'trigger', ref: eventTrigger.trigger_id });
    assert.equal(eventTask.verification.ok, true);
    evidence.push('## Event trigger', '', `- Webhook fired: triage **${fired.body.decision}** (${fired.body.reason}); same payload again: **${again.body.decision}** (${again.body.reason})`,
      `- Ledger task "${eventTask.title}": **${eventTask.state}**, origin trigger ${eventTrigger.trigger_id.slice(0, 8)}…, verified: ${eventTask.verification.checks[0].why}`, '');

    // 2. A heartbeat job, due at 03:17 every day; the clock is moved to a day it is due, twice.
    const beat = await m.send('POST', '/api/v1/triggers/rules', { name: 'Example daily check', class: 'heartbeat', cron: '17 3 * * *', action: task('heartbeat.md', 'beat\n') });
    assert.equal(beat.status, 201);
    const due = '2030-01-15T03:17:20Z';
    await m.send('POST', '/api/v1/triggers/tick', { now: due });
    await m.send('POST', '/api/v1/triggers/tick', { now: due });
    const beats = (await m.get(`/api/v1/triggers?rule=${beat.body.rule.id}`)).filter((t: { ledger_task_id: string | null }) => t.ledger_task_id);
    assert.equal(beats.length, 1, 'one run per due time, however often the clock ticks');
    const beatTask = await settled(beats[0].ledger_task_id);
    assert.equal(beatTask.state, 'done', beatTask.reason);
    assert.deepEqual(beatTask.origin, { kind: 'trigger', ref: beats[0].trigger_id });
    assert.equal(readFileSync(`${m.home}/workspace/heartbeat.md`, 'utf8'), 'beat\n', 'ran once');
    evidence.push('## Heartbeat job', '', `- Rule "${beat.body.rule.name}" (${beat.body.rule.schedule ?? beat.body.rule.cron}); clock ticked twice at ${due}: **${beats.length}** run`,
      `- Ledger task "${beatTask.title}": **${beatTask.state}**, origin trigger ${beats[0].trigger_id.slice(0, 8)}…, verified: ${beatTask.verification.checks[0].why}`, '');

    // 3. A proactive message traces to its trigger record.
    const pro = await m.send('POST', '/api/v1/triggers/rules', { name: 'Example check-in', class: 'proactive', action: { kind: 'message', text: 'Your welcome note is ready when you are.' } });
    const proFired = await m.send('POST', `/api/v1/triggers/rules/${pro.body.rule.id}/fire`, {});
    assert.equal(proFired.status, 200);
    const messages = await m.get('/api/v1/messages');
    assert.equal(messages.length, 1);
    const origin = await m.get(`/api/v1/triggers/${messages[0].trigger_id}`);
    assert.equal(origin.class, 'proactive');
    assert.equal(origin.rule_id, pro.body.rule.id);
    assert.equal(origin.message_id, messages[0].id);
    assert.equal(origin.triage.model.provider, 'rules', 'triaged by the local decision provider');
    evidence.push('## Proactive message', '', `- "${messages[0].text}" → trigger ${origin.trigger_id.slice(0, 8)}… (class ${origin.class}, rule "${pro.body.rule.name}", triage **${origin.triage.decision}** by \`${origin.triage.model.provider}\` ${origin.triage.model.template_id}@${origin.triage.model.version})`, '');

    // 4. Local-only: chat is configured with a cloud model, and it must not be reached.
    const { id } = (await m.send('POST', '/api/sessions', { text: 'hello' })).body;
    const chat = await until<any>(() => m.get(`/api/sessions/${id}`), (s) => s.live === null);
    assert.equal(chat.session.turns[0].state, 'error');
    assert.match(chat.session.turns[0].items[0].message, /local-only.*haven't sent this anywhere/);
    const triggers = await m.get('/api/v1/triggers');
    for (const t of triggers) if (t.triage.model) assert.notEqual(t.triage.model.provider, 'jev', 'no remote decision provider');
    assert.deepEqual(await m.get('/api/v1/receipts?egress=remote'), [], 'no model call left this machine');
    evidence.push('## Local-only', '', `- Chat attempt with the default cloud model configured: refused before sending ("${chat.session.turns[0].items[0].message.slice(0, 80)}…")`,
      `- Triage providers used: ${[...new Set(triggers.filter((t: { triage: { model: unknown } }) => t.triage.model).map((t: { triage: { model: { provider: string } } }) => t.triage.model.provider))].join(', ')}`,
      '- Receipts with remote egress (the egress log): **none**', '');
  } finally {
    await stop(nova);
  }
  const leaks = readFileSync(m.egress, 'utf8').trim();
  assert.equal(leaks, '', `connections off this machine:\n${leaks}`);
  evidence.push('- Connections attempted off this machine (tripwire on every TCP connect): **none**', '');
  if (process.env.NOVA_EVIDENCE) writeFileSync(process.env.NOVA_EVIDENCE, evidence.join('\n'));
});
