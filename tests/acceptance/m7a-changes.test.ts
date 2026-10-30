// M7a over the API, with real server processes and the egress tripwire (the sandboxes Nova starts
// inherit it): the foundry writes a daily wind-down reminder with the stand-in local model, it is
// tried in a sandbox, waits for the person's tier-3 OK with its evidence, canaries on the test clock,
// is promoted and fires; the record reaches the standby. Then sabotage: a change that passes the
// sandbox but fails live is rolled back by itself, the previous version restored, the ledger says
// Failed with the probe's reason, a problem is opened. And a change that tries to weaken a gate,
// or skip a stage, is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { blank, stop, until } from './support.ts';
import { kill, setup } from './m4c-support.ts';
import { startFakeOllama } from '../../scripts/stand-ins/fake-ollama.js';
import { filesReply } from '../../scripts/stand-ins/fake-openai.js';
import { CONTRACT_SYSTEM } from '../../src/core/providers/prompt.ts';
import { INSTALLED, hardwareFile } from '../support/models.ts';
import { notesSkill, windDown, windDownFiles } from '../support/changes.ts';

const api = (p: string) => `/api/v1${p}`;
type Node = ReturnType<typeof blank>;
const change = (m: Node, id: string) => m.get(api(`/changes/${id}`));
const settled = (m: Node, id: string, done: (c: any) => boolean) => until<any>(() => change(m, id), done, 1600);
const finished = (m: Node, task: string) => until<any>(() => m.get(api(`/tasks/${task}`)), (t) => ['done', 'failed', 'cancelled'].includes(t.state), 1600);
// The canary's window on the test clock: three looks, the last past its end.
async function canary(m: Node, id: string, from: string) {
  const start = Date.parse(from);
  for (let i = 1; i <= 3; i++) {
    const c = await change(m, id);
    if (c.state !== 'canary') break;
    await m.send('POST', api('/changes/tick'), { now: new Date(start + i * 15 * 60_000).toISOString() });
  }
  return change(m, id);
}

test('M7a: the foundry ships a wind-down reminder through every gate, with the tier-3 OK; the record reaches the standby; skipping and weakening are refused', { timeout: 240_000 }, async () => {
  const ollama = await startFakeOllama({
    models: INSTALLED,
    reply: (req: { messages?: { role: string; content: string }[] }) => (req.messages?.[0]?.content === CONTRACT_SYSTEM ? filesReply(windDownFiles(), 'A daily wind-down reminder at nine.') : 'ok'),
  });
  const dir = blank('nova-m7a-hw-').dir;
  const s = await setup('nova-m7a', () => {}, { NOVA_TEST_CLOCK: '1', NOVA_OLLAMA_URL: ollama.url, NOVA_HARDWARE_FILE: hardwareFile(dir) });
  const m = s.hub;
  let standbyProc: Awaited<ReturnType<typeof m.start>> | null = null;
  try {
    standbyProc = await s.standby.start(s.env(s.standbyMesh));
    assert.equal((await m.send('PUT', api('/profile/user/timezone'), { value: 'UTC' })).status, 200);
    assert.equal((await m.send('PUT', api('/models/roles/reasoner'), { model: 'example-deep:32b' })).status, 200);

    // The person asks; the foundry writes it with the local model and proposes it.
    const asked = await m.send('POST', api('/foundry'), { need: 'Remind me to wind down at nine every evening', kind: 'trigger-rules' });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const authored = await finished(m, asked.body.id);
    assert.equal(authored.state, 'done', authored.reason);
    const receipts = await m.get(api(`/receipts?task_id=${asked.body.id}`));
    assert.deepEqual(receipts.map((r: any) => [r.provider, r.egress]), [['ollama', 'local']]);
    const proposed = (await m.get(api('/changes'))).changes.find((c: any) => c.proposed_by === 'foundry');
    assert.equal(proposed.tier, 3);
    assert.equal((await m.get(api('/triggers/rules'))).length, 0, 'nothing live yet');
    // Approving before the sandbox has spoken is skipping a stage.
    if (proposed.state === 'checking') {
      const early = await m.send('POST', api(`/changes/${proposed.id}/ship`), { confirm: true });
      assert.equal(early.status, 409);
      assert.match(early.body.error, /A change can’t skip a stage/);
    }

    // It waits for the person, with the sandbox evidence to show.
    const waiting = await settled(m, proposed.id, (c) => c.state !== 'checking');
    assert.equal(waiting.state, 'waiting', waiting.reason);
    assert.equal(waiting.status, 'Needs you');
    assert.equal((await m.get(api('/changes'))).standout, proposed.id);
    assert.deepEqual(waiting.stages_in_order.map((x: any) => x.status), ['passed', 'passed', 'passed', 'passed', 'pending', 'pending', 'pending']);
    assert.match(waiting.stages.health.summary, /Health and 6 smoke probes passed on the sandbox/);
    assert.match(waiting.asks.join(' '), /every day at 9:00 PM: sends you “Time to wind down for the evening\.”/i);
    const confirmless = await m.send('POST', api(`/changes/${proposed.id}/ship`), {});
    assert.equal(confirmless.status, 400, 'tier 3 needs confirming, every time');
    assert.equal((await m.send('POST', api(`/changes/${proposed.id}/ship`), { confirm: true })).status, 200);

    // The canary on the test clock, then promoted.
    const started = await settled(m, proposed.id, (c) => !!c.canary?.started_at);
    assert.equal(started.state, 'canary');
    const live = await canary(m, proposed.id, started.canary.started_at);
    assert.equal(live.state, 'live', live.reason);
    assert.equal(live.status, 'Verified');
    const ship = await finished(m, live.ship_task_id);
    assert.equal(ship.state, 'done', ship.reason);

    // It works live: the reminder fires at nine on the test clock.
    await m.send('POST', api('/triggers/tick'), { now: '2030-01-15T20:59:00.000Z' });
    await m.send('POST', api('/triggers/tick'), { now: '2030-01-15T21:00:30.000Z' });
    const messages = await m.get(api('/messages'));
    assert.equal(messages[0]?.text, 'Time to wind down for the evening.');

    // The ledger shows every stage.
    const events = [...await m.get(api(`/tasks/${live.check_task_id}/events`)), ...await m.get(api(`/tasks/${live.ship_task_id}/events`))];
    assert.deepEqual(events.filter((e: any) => e.kind === 'stage').map((e: any) => `${e.detail.stage}:${e.detail.status}`),
      ['sandbox:passed', 'tests:passed', 'health:passed', 'release:passed', 'approval:passed', 'canary:running', 'canary:passed', 'promote:passed']);
    // The release is in the home's change history, as files.
    const art = readFileSync(join(m.home, live.release.dir, 'artifact.json'), 'utf8');
    assert.match(art, /"Wind down"/);

    // The standby has the record, and the release files.
    const copy = await until<any>(() => s.standby.get(api(`/changes/${proposed.id}`)).catch(() => null), (c) => c?.state === 'live', 800);
    assert.equal(copy?.state, 'live', 'the change record replicated');
    await until(async () => { try { return readFileSync(join(s.standby.home, live.release.dir, 'artifact.json'), 'utf8'); } catch { return ''; } }, (t) => t === art, 800);
    assert.equal(readFileSync(join(s.standby.home, live.release.dir, 'artifact.json'), 'utf8'), art);

    // Weakening a gate is refused.
    const weak = await m.send('POST', api('/changes'), { kind: 'config', artifact: { section: 'changes', key: 'min_canary_s', value: 0 } });
    assert.equal(weak.status, 403);
    assert.match(weak.body.error, /^Refused: .*gates are part of Nova’s core/);
    const skip = await m.send('POST', api('/changes'), { kind: 'trigger-rules', artifact: windDown('2.0.0'), skip_stages: ['canary'] });
    assert.equal(skip.status, 403);
    const short = await m.send('POST', api('/changes'), { kind: 'trigger-rules', artifact: windDown('2.0.0'), canary: { window_s: 5 } });
    assert.equal(short.status, 403);
    assert.equal((await m.get(api('/changes/gates'))).min_canary_s['trigger-rules'], 1800);

    // Nothing left this machine: the egress tripwire, the sandboxes included.
    assert.equal(readFileSync(m.egress, 'utf8'), '', 'no egress');
  } finally {
    if (standbyProc) await kill(standbyProc);
    await stop(s.hubProc);
    await ollama.close();
  }
});

test('M7a: sabotage that passes the sandbox fails live and is rolled back by itself: the previous version, Failed with the probe’s reason, a problem, nothing else changed', { timeout: 180_000 }, async () => {
  const m = blank('nova-m7a-canary-');
  const nova = await m.start({ NOVA_TEST_CLOCK: '1' });
  try {
    const v1 = await m.send('POST', api('/changes'), { kind: 'extension', artifact: notesSkill('1.0.0') });
    assert.equal(v1.status, 201, JSON.stringify(v1.body));
    const c1 = await settled(m, v1.body.id, (c) => !!c.canary?.started_at || ['stopped', 'refused'].includes(c.state));
    assert.equal((await canary(m, v1.body.id, c1.canary.started_at)).state, 'live');
    await m.send('POST', api('/triggers/rules'), { name: 'Weekly review', class: 'heartbeat', cron: '0 9 * * 1', action: { kind: 'message', text: 'Weekly review time.' } });
    const others = async () => JSON.stringify([await m.get(api('/triggers/rules')), (await m.get(api('/extensions'))).filter((x: any) => x.id !== 'example-notes').map((x: any) => [x.id, x.version, x.state]), await m.get(api('/design-systems/active'))]);
    const before = await others();

    const v2 = await m.send('POST', api('/changes'), { kind: 'extension', artifact: notesSkill('2.0.0', { maxMemories: 2, text: 'Write each note as two lines.' }) });
    const c2 = await settled(m, v2.body.id, (c) => !!c.canary?.started_at || ['stopped', 'refused'].includes(c.state));
    assert.equal(c2.state, 'canary', c2.reason);
    assert.equal((await m.get(api('/extensions'))).find((x: any) => x.id === 'example-notes').version, '2.0.0');
    // Live data grows past what its probe allows.
    for (const n of ['one', 'two', 'three']) assert.equal((await m.send('POST', api('/memory'), { kind: 'fact', content: `Example note ${n}` })).status, 201);
    const look = await m.send('POST', api('/changes/tick'), { now: '2030-01-15T08:05:00.000Z' });
    assert.equal(look.body[0].state, 'rolled_back');
    const after = await change(m, v2.body.id);
    assert.equal(after.state, 'rolled_back');
    assert.equal(after.status, 'Failed');
    assert.equal((await m.get(api('/extensions'))).find((x: any) => x.id === 'example-notes').version, '1.0.0', 'the previous version is back');
    assert.match(readFileSync(join(m.home, 'extensions', 'example-notes', 'SKILL.md'), 'utf8'), /\(v1\.0\.0\)/);
    const ship = await finished(m, after.ship_task_id);
    assert.equal(ship.state, 'failed');
    assert.match(ship.reason, /The canary’s probe failed: memories stay few: length is 3, expected lte 2\. Version 1\.0\.0 is back, as it was\./);
    const problems = await m.get(api('/problems?open=1'));
    assert.ok(problems.some((p: any) => p.task_id === ship.id && /memories stay few/.test(p.message)), 'a problem, in plain words');
    assert.equal(await others(), before, 'nothing else changed');
    assert.equal(readFileSync(m.egress, 'utf8'), '', 'no egress');
  } finally {
    await stop(nova);
  }
});
