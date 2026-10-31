// M1 gate — fresh-user acceptance test #1 (ROADMAP-AND-GATES, PROFILES-AND-CUSTOMIZATION):
// a blank profile, setup completed by conversation, one task delegated and verified with
// evidence, all in local-only mode. It runs the real server as its own process, as a new user
// would, with an egress tripwire preloaded. Set NOVA_EVIDENCE=<file> to keep a transcript.
//
// M10f (Amendment 2026-10-31-B Part 2): onboarding in the ADR's order, discovery against stand-ins
// on 127.0.0.1 only (no multicast, no real network), a consent-first import from the blank user's
// own folder, the populated first view, and the timed first win: from the first GET /setup to the
// person keeping one imported note and Nova finding it, under 15 minutes, with each step's time
// in the evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sampleManifest } from '../core/fixtures.ts';
import { blank, sleep, stop } from './support.ts';
import { fakeMdns, fakeRuntime, freePort } from '../support/fake-mdns.ts';
import { NOTE_WORD, seedUserHome } from '../support/onboard-home.ts';

const FIRST_WIN_LIMIT_MS = 15 * 60_000;
// The human path, estimated (the test answers at machine speed): reading at 200 words a minute,
// 10 s to decide and give each answer, 5 s for each click after setup.
const READ_WPM = 200;
const ANSWER_S = 10;
const CLICK_S = 5;

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
  // The blank user's own folder, with notes, a calendar file and bookmarks to offer; stand-ins on
  // loopback for a model runtime and a home hub on the network.
  seedUserHome(m.env.HOME);
  const runtime = await fakeRuntime();
  const mdns = await fakeMdns();
  const discovery = {
    NOVA_DISCOVERY_PORTS: `model-runtime=${runtime.port},screenpipe=${await freePort()},home-assistant=${await freePort()}`,
    NOVA_DISCOVERY_MDNS: `127.0.0.1:${mdns.port}`,
  };

  let nova = await m.start(discovery);
  try {
    // 1. Blank: no profile, setup not done, nothing in the ledger.
    const h0 = await get('/health');
    assert.equal(h0.ok, true);
    assert.equal(h0.setup.done, false);
    assert.deepEqual(await get('/profile'), { identity: {}, user: {}, tuning: {}, privacy: {}, policy: {}, appearance: {}, mesh: {}, providers: {}, capture: {}, models: {}, backups: {} });
    // The built-in design systems are there without the person doing anything; Orb Teal shows.
    assert.equal((await get('/design-systems')).length, 6);
    assert.equal((await get('/design-systems/active')).id, 'orb-teal');
    assert.deepEqual(await get('/tasks'), []);

    // 2. Setup, as a conversation: this device first (the ADR's order), then the person, then
    // discovery and the import they ask for. The first-win clock starts here.
    const t0 = performance.now();
    const path: { step: string; ms: number }[] = [];
    const mark = (step: string) => path.push({ step, ms: Math.round(performance.now() - t0) });
    let words = 0;
    const count = (s: string) => { words += s.split(/\s+/).filter(Boolean).length; };
    const first = await get('/setup');
    count(first.question);
    assert.equal(first.step, 'device');
    assert.match(first.question, /This is a (Linux|macOS|Windows|Linux inside Windows \(WSL2\)) computer/);
    mark('setup opened: this computer described');
    evidence.push('## Setup conversation', '', `**Nova:** ${first.question}`, '');
    const answers = ['new', 'yes', 'yes', "Hi! I'm Sam.", 'yes', 'keep', 'plainly, please', 'keep everything on this machine', 'this computer and the network too', 'all', 'yes'];
    let last: { reply: string; view: { done: boolean; step: string; options: { choices: { id: string; selected: boolean; available?: boolean }[] } | null; first: { found: { kind: string; connected: boolean }[]; waiting: number; action: { id: string; label: string }; device: { backend: string } } | null }; task: { id: string } | null } | null = null;
    for (const text of answers) {
      const before = last?.view.step ?? 'device';
      if (before === 'backend') {
        // The backend step: the supervisor pre-selected, and K3s never offered as working.
        const choices: { id: string; selected: boolean; available?: boolean }[] = last!.view.options!.choices;
        assert.deepEqual(choices.filter((c) => c.selected).map((c) => c.id), ['supervisor']);
        assert.equal(choices.some((c) => c.id === 'k3s' && c.available !== false), false);
      }
      const r = await post('/setup/messages', { text });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      last = r.body;
      count(r.body.reply);
      mark(`answered ${before}: “${text}”`);
      evidence.push(`**Person:** ${text}`, '', `**Nova:** ${r.body.reply}`, '');
    }
    assert.equal(last!.view.done, true);
    assert.ok(last!.task, 'setup started the first task');
    // The first view: what was found (never connected), what was brought in, the backend, and one
    // suggested action.
    const firstView = last!.view.first!;
    assert.deepEqual(firstView.found.map((f) => [f.kind, f.connected]), [['model-runtime', false], ['home-assistant', false], ['computer', false]]);
    assert.ok(firstView.waiting >= 3, `imported and waiting: ${firstView.waiting}`);
    assert.equal(firstView.device.backend, 'supervisor');
    assert.equal(firstView.action.id, 'review-imports');
    assert.deepEqual(runtime.hits, ['GET /api/version'], 'found, not connected: one GET, nothing after');
    assert.ok(mdns.queries.every((q) => q.from === '127.0.0.1'), 'discovery stayed on loopback');
    evidence.push('## The first view', '', '```json', JSON.stringify(firstView, null, 2), '```', '');

    // 2b. The first win: the person follows the one suggested action (Memory's waiting list), keeps
    // the imported note that is right, and Nova finds it by a word from it.
    const memory = await m.get('/api/memory');
    const note = (memory.candidates as { id: string; content: string; source: string }[]).find((c) => c.content.includes(NOTE_WORD));
    assert.ok(note, `the imported note waits for the person: ${JSON.stringify(memory.candidates.map((c: { source: string }) => c.source))}`);
    assert.equal(note.source, 'imported from ~/Notes/garden/plants.md');
    assert.equal((await get(`/memory/search?q=${NOTE_WORD}`)).records.length, 0, 'nothing imported is memory before the person keeps it');
    mark(`followed “${firstView.action.label}”: the imported note waits in Memory`);
    const kept = await m.send('POST', `/api/memory/candidates/${encodeURIComponent(note.id)}/keep`);
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    mark('kept the imported note');
    const found = await get(`/memory/search?q=${NOTE_WORD}`);
    assert.equal(found.records.length, 1);
    assert.match(found.records[0].content, new RegExp(`Plant ${NOTE_WORD} by the north fence`));
    const winMs = Math.round(performance.now() - t0);
    mark(`Nova found it: “${found.records[0].content.slice(0, 60)}…”`);
    assert.ok(winMs < FIRST_WIN_LIMIT_MS, `the first win took ${winMs} ms, over 15 minutes`);
    const clicks = 2;
    const humanS = Math.round((words / READ_WPM) * 60 + answers.length * ANSWER_S + clicks * CLICK_S);
    assert.ok(humanS * 1000 < FIRST_WIN_LIMIT_MS, `the human path, estimated, is ${humanS} s`);
    evidence.push('## The timed first win', '',
      `- Measured (machine speed, from the first GET /setup): **${winMs} ms**, under the 15-minute bound.`,
      `- The human path, estimated: ${answers.length} answers, ${clicks} clicks after setup, ${words} words shown by Nova. At ${READ_WPM} words a minute, ${ANSWER_S} s per answer and ${CLICK_S} s per click: **about ${Math.round(humanS / 60)} min ${humanS % 60} s**. An estimate, not a measurement of a person.`,
      '', '| Step | ms from start |', '|---|---|', ...path.map((p) => `| ${p.step.replace(/\|/g, '/')} | ${p.ms} |`), '');
    console.log(`first win: ${winMs} ms measured; the human path estimated at ${humanS} s (${words} words, ${answers.length} answers, ${clicks} clicks)`);
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
      capture: {},
      models: {},
      backups: {},
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
  nova = await m.start(discovery);
  try {
    const h1 = await get('/health');
    assert.equal(h1.setup.done, true);
    assert.equal(h1.checks.ledger.counts.done, 1);
    assert.equal((await get('/identity')).identity.user_name, 'Sam');
    assert.equal((await get('/problems')).length, 0, 'nothing went wrong along the way');
    evidence.push('## After a restart', '', `- Health ok: ${h1.ok}; setup done: ${h1.setup.done}; tasks done: ${h1.checks.ledger.counts.done}; open problems: ${h1.checks.problems.open}`, '');
  } finally {
    await stop(nova);
    await runtime.close();
    await mdns.close();
  }

  // 7. Local-only held: nothing tried to leave the machine.
  const leaks = readFileSync(egress, 'utf8').trim();
  assert.equal(leaks, '', `connections off this machine:\n${leaks}`);
  assert.ok(existsSync(join(home, 'nova.db')));
  evidence.push('## Egress', '', '- Connections attempted off this machine across both runs: **none** (tripwire on every TCP connect).', '');

  if (process.env.NOVA_EVIDENCE) writeFileSync(process.env.NOVA_EVIDENCE, evidence.join('\n'));
});
