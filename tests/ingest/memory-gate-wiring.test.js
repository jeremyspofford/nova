// The memory gate's consumer (docs/plans/ds2-memory-gate.md NOTES 1–3; docs/plans/track1-follow-up-queue.md,
// "Memory-gate wiring"), end to end through a real Nova (createNova): the scripted chat model writes
// <remember> blocks, the runner's keep() asks the real Decision Service, which asks a Tev1 stand-in
// (loopback) or a Jev stand-in (loopback), and the memory, the candidates, the decision records, the
// receipts and the session's memory events are read back. Verdicts are in memory, so a seat is trusted
// only when a test says so; the committed verdicts, questions, cases and bounds are not touched. No
// real model, no owner service.
//
// Covers: save, skip, merge and flag on a trusted seat; the deterministic duplicate (no model call, even
// untrusted); the missing, untrusted and unanswered fallbacks (today's write); a tainted run (held for
// the person, the gate never asked); a cross-conversation regression; the privacy rule (the person's
// conversation never reaches a cloud seat in local-first or local-only, whatever opt-in is on); the
// flag off (nothing asked); the candidate's reason in the Memory view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, scripted, startNova } from './support.js';
import { memoryVerdicts } from '../../src/core/decision-service/index.ts';
import { startTev1StandIn } from '../support/tev1-stand-in.ts';
import { startJevStandIn } from '../support/jev-stand-in.ts';
import { renderKept, renderMemory } from '../../ui/js/view.js';

const CLOSED = 'http://127.0.0.1:9';
const TEV1 = 'tev1:4b@aaaa4b';
const pass = (seat, model) => ({ template_id: 'memory-gate', version: 1, seat, model, status: 'pass', why: 'test pass', run_at: null, ref: `test#${seat}` });

// What the stand-in model answers for a candidate: the probabilities that give each outcome by the
// template's own table (nothing here changes the table or its bands).
const P = {
  save: { lasting: 0.95, in_person_words: 0.95, duplicate: 0.05, contradicts: 0.05 },
  skip: { lasting: 0.95, in_person_words: 0.05, duplicate: 0.05, contradicts: 0.05 },
  merge: { lasting: 0.95, in_person_words: 0.95, duplicate: 0.95, contradicts: 0.05 },
  flag: { lasting: 0.95, in_person_words: 0.95, duplicate: 0.05, contradicts: 0.95 },
};
const candidateOf = (content) => { try { return JSON.parse(content).candidate ?? ''; } catch { return ''; } };
const isGate = (r) => Object.hasOwn(r.questions ?? {}, 'in_person_words');

// A Nova with the flag on, a Tev1 stand-in that answers each candidate by `outcomes` (save when not
// named), and verdicts as given. `replies`: the person's message → what the scripted model writes.
async function rig({ replies, outcomes = {}, verdicts = [pass('tev1', TEV1)], privacy = 'local-only', hub = 'stand-in', decision = null, flag = true }) {
  const tev1 = hub === 'stand-in' ? await startTev1StandIn({ score: (content, q) => P[outcomes[candidateOf(content)] ?? 'save'][q] ?? 0.05 }) : null;
  const m = scripted((step, c) => (step === 0 ? (replies[c.user] ?? 'OK.') : 'Done.'));
  const h = await startNova({ agent: m.agent, privacy, hub: tev1?.url ?? hub, decisions: { verdicts: memoryVerdicts(verdicts) }, ...(decision ? { decision } : {}) });
  h.nova.runner.config.features.memoryGate = flag;
  return {
    h, m, tev1,
    gateAsks: () => (tev1?.requests ?? []).filter(isGate),
    records: () => h.nova.core.db.all("SELECT * FROM decision_record WHERE template_id = 'memory-gate' ORDER BY at"),
    memories: () => h.nova.core.memory.active().map((r) => ({ content: r.content, source: r.source ?? null })),
    plant: (content) => { h.nova.core.memory.remember({ kind: 'fact', content, recorded_by: 'person' }); h.nova.runner.memory.sync(); },
    close: async () => { await h.close(); await tev1?.close(); },
  };
}
const items = (s) => s.session.turns.flatMap((t) => t.items);
const memoryOps = (s) => items(s).filter((i) => i.kind === 'memory').flatMap((i) => i.ops);
const lastTurn = (s) => s.session.turns.at(-1).id;
const remember = (text) => `<remember kind="fact">${text}</remember>`;

test('trusted: save, skip, merge and flag, each through keep() and the real service, with provenance kept', async () => {
  const said = 'I live in York and work as a nurse. I might visit Leeds on Friday. I like tea.';
  const answer = 'Noted, all of it.';
  const r = await rig({
    replies: { [said]: `${answer}\n${remember('Lives in York.')}\n${remember('Is visiting Leeds on Friday.')}\n${remember('Likes tea.')}\n${remember('Works as a nurse.')}` },
    outcomes: { 'Lives in York.': 'save', 'Is visiting Leeds on Friday.': 'skip', 'Likes tea.': 'merge', 'Works as a nurse.': 'flag' },
  });
  try {
    r.plant('Enjoys a cup of tea.');
    r.plant('Works as a teacher.');
    const { id: sid, s } = await r.h.run(said);
    const turn = lastTurn(s);
    const from = `${sid}/${turn}`;

    // The gate was asked four times, with the person's exact words, the reply as context, the
    // candidate and the nearest memories.
    const asks = r.gateAsks();
    assert.equal(asks.length, 4);
    for (const a of asks) {
      assert.equal(a.state.person_said, said, 'the person’s exact turn');
      assert.equal(a.state.nova_answer, answer, 'Nova’s visible answer, as context');
    }
    const nurse = asks.find((a) => a.state.candidate === 'Works as a nurse.');
    assert.ok(nurse.state.existing_memories.includes('Works as a teacher.'), 'the nearest existing memory goes with it');
    assert.ok(asks.find((a) => a.state.candidate === 'Likes tea.').state.existing_memories.includes('Enjoys a cup of tea.'));

    // save: written as today, with this conversation and turn as its source.
    const mem = r.memories();
    assert.deepEqual(mem.filter((x) => x.content === 'Lives in York.'), [{ content: 'Lives in York.', source: from }]);
    // skip and merge: nothing new written.
    assert.ok(!mem.some((x) => /Leeds/.test(x.content)), 'skipped: not kept');
    assert.ok(!mem.some((x) => x.content === 'Likes tea.'), 'merged: the existing memory stays, nothing new');
    assert.ok(mem.some((x) => x.content === 'Enjoys a cup of tea.'));
    // flag: not written; it waits for the person with the conflict as its reason.
    assert.ok(!mem.some((x) => x.content === 'Works as a nurse.'));
    const data = await r.h.get('/api/memory');
    assert.equal(data.candidates.length, 1);
    const c = data.candidates[0];
    assert.equal(c.content, 'Works as a nurse.');
    assert.equal(c.source, from, 'the candidate keeps the conversation and turn');
    assert.deepEqual(c.taint, []);
    assert.match(c.reason, /conflict with what Nova remembers: .*“Works as a teacher\.”/);

    // The session's memory event: what happened to each, and the decision behind it.
    const ops = memoryOps((await r.h.session(sid)));
    assert.equal(ops.length, 4);
    const [save, skip, merge, flag] = ops;
    assert.ok(save.id && !save.skipped && save.gate.outcome === 'save' && save.gate.relied);
    assert.ok(skip.skipped && skip.gate.outcome === 'skip' && !skip.id);
    assert.ok(merge.existing && merge.gate.outcome === 'merge');
    assert.ok(flag.held && flag.conflict && flag.id === c.id && flag.gate.outcome === 'flag');

    // Each decision is recorded with this conversation and turn, as the memory subsystem, local only.
    const recs = r.records();
    assert.equal(recs.length, 4);
    for (const x of recs) {
      assert.equal(x.subsystem, 'memory');
      assert.equal(x.source, from);
      assert.equal(x.egress, 'local');
      assert.equal(x.trust, 'verdict');
    }
    assert.deepEqual(new Set(recs.map((x) => x.id)), new Set(ops.map((o) => o.gate.decision)));

    // The conversation's margin: the kept one, and the one that waits; nothing for the skipped one.
    const margin = renderKept(ops, new Map([[save.id, { text: 'Lives in York.' }]]));
    assert.match(margin, /kept in memory<\/a>: Lives in York\./);
    assert.match(margin, /waiting for your OK<\/a>: this conflicts with what Nova remembers/);
    assert.doesNotMatch(margin, /since forgotten/);
    // The Memory view shows why it waits.
    const html = renderMemory(data);
    assert.match(html, /These conflict with what Nova remembers, so they wait for you/);
    assert.match(html, /Nova heard something that conflicts with what it remembers\. It may conflict with what Nova remembers: “Works as a teacher\.”/);
    // Keeping it is the person's choice, and then it is written.
    assert.equal((await r.h.post(`/api/memory/candidates/${c.id}/keep`)).status, 200);
    assert.ok(r.memories().some((x) => x.content === 'Works as a nurse.' && x.source === from));
  } finally { await r.close(); }
});

test('the deterministic duplicate: an exact match merges with no model call, even with no trusted seat', async () => {
  const r = await rig({ replies: { 'I live in York.': `Noted.\n${remember('lives in York!')}` }, verdicts: [] });
  try {
    r.plant('Lives in York.');
    const { id: sid, s } = await r.h.run('I live in York.');
    assert.equal(r.gateAsks().length, 0, 'no model was asked');
    const [rec] = r.records();
    assert.equal(rec.outcome, 'merge');
    assert.equal(rec.egress, 'none');
    assert.equal(rec.model, 'rules@memory-gate@1');
    assert.equal(rec.source, `${sid}/${lastTurn(s)}`);
    assert.deepEqual(r.memories().map((x) => x.content), ['Lives in York.'], 'nothing new written');
    const [op] = memoryOps(s);
    assert.ok(op.existing && op.gate.relied && op.gate.outcome === 'merge');
  } finally { await r.close(); }
});

test('fallbacks: an untrusted answer, no answer, a gate that throws, and no gate at all each write as today', async () => {
  // Untrusted: the stand-in says "skip", but no verdict passed, so it is evidence only.
  const u = await rig({ replies: { 'I keep bees.': `Lovely.\n${remember('Keeps bees.')}` }, outcomes: { 'Keeps bees.': 'skip' }, verdicts: [] });
  try {
    const { s } = await u.h.run('I keep bees.');
    assert.ok(u.memories().some((x) => x.content === 'Keeps bees.'), 'untrusted: written as today');
    const [rec] = u.records();
    assert.equal(rec.trust, 'none');
    assert.equal(rec.outcome, 'save');
    assert.equal(JSON.parse(rec.shadows)[0].seat, 'tev1', 'the untrusted answer is kept as evidence');
    const [op] = memoryOps(s);
    assert.equal(op.gate.relied, false);
  } finally { await u.close(); }

  // Unanswered: Tev1 doesn't answer (a closed port), and there is no other seat.
  const n = await rig({ replies: { 'I keep bees.': `Lovely.\n${remember('Keeps bees.')}` }, hub: CLOSED });
  try {
    await n.h.run('I keep bees.');
    assert.ok(n.memories().some((x) => x.content === 'Keeps bees.'), 'unanswered: written as today');
    const [rec] = n.records();
    assert.equal(rec.trust, 'none');
    assert.ok(JSON.parse(rec.failures).some((f) => f.seat === 'tev1'));
  } finally { await n.close(); }

  // A gate that throws, one that finds no template (null), and none at all.
  for (const gate of [async () => { throw new Error('down'); }, async () => null, null]) {
    const g = await rig({ replies: { 'I keep bees.': `Lovely.\n${remember('Keeps bees.')}` }, hub: CLOSED });
    try {
      g.h.nova.runner.memoryGate = gate;
      const { s } = await g.h.run('I keep bees.');
      assert.ok(g.memories().some((x) => x.content === 'Keeps bees.'));
      const [op] = memoryOps(s);
      assert.equal(op.ok, true);
      assert.ok(!op.skipped && !op.held);
      if (gate) assert.deepEqual(op.gate, { decision: null, outcome: null, relied: false });
      else assert.equal(op.gate, undefined, 'no gate wired: today’s write, nothing asked');
    } finally { await g.close(); }
  }
});

test('a tainted run: the memory waits for the person as today, and the gate is never asked', async () => {
  // The web tools are offered only when the privacy setting allows the network.
  const r = await rig({ replies: {}, outcomes: { 'Bakes bread on Sundays.': 'save' }, privacy: 'cloud-allowed' });
  try {
    const base = r.h.web.base;
    // A reply that reads a page, then remembers (the gate would save it, if it were asked).
    const m = scripted((step) => [call('web_fetch', { url: `${base}/plain` }), `Read it.\n${remember('Bakes bread on Sundays.')}`][step] ?? 'Done.');
    r.h.nova.runner.agent = m.agent;
    const { id: sid, s } = await r.h.run(`I bake bread on Sundays. Notes: ${base}/plain`, () => 'allow');
    assert.equal(r.gateAsks().length, 0, 'the gate is never asked in a tainted run');
    assert.equal(r.records().length, 0);
    assert.ok(!r.memories().some((x) => x.content === 'Bakes bread on Sundays.'));
    const [c] = (await r.h.get('/api/memory')).candidates;
    assert.equal(c.content, 'Bakes bread on Sundays.');
    assert.equal(c.reason, null, 'held for outside content, not for a conflict');
    assert.ok(c.taint.length > 0);
    assert.equal(c.source, `${sid}/${lastTurn(s)}`);
    const [op] = memoryOps(s);
    assert.ok(op.held && !op.conflict && !op.gate);
  } finally { await r.close(); }
});

test('cross-conversation: a memory saved in one conversation is merged or flagged against in the next', async () => {
  const r = await rig({
    replies: {
      'I live in York.': `Noted.\n${remember('Lives in York.')}`,
      'You told me I have a dog.': `Sorry, my mistake.\n${remember('Has a dog.')}`,
      'Still in York, as I said.': `Good.\n${remember('Lives in York.')}`,
      'I moved to Leeds last week.': `Congratulations!\n${remember('Lives in Leeds.')}`,
    },
    outcomes: { 'Lives in York.': 'save', 'Has a dog.': 'skip', 'Lives in Leeds.': 'flag' },
  });
  try {
    const a = await r.h.run('I live in York.');
    await r.h.run('You told me I have a dog.', () => 'deny', a.id);
    assert.deepEqual(r.memories().map((x) => x.content), ['Lives in York.']);

    // A new conversation reads the saved memory, and never the skipped one.
    r.m.calls.length = 0;
    const b = await r.h.run('Still in York, as I said.');
    assert.ok(r.m.calls.some((c) => (c.system + c.prompt).includes('Lives in York.')), 'the next conversation reads it');
    assert.ok(!r.m.calls.some((c) => (c.system + c.prompt).includes('Has a dog')), 'a skipped memory never reaches a prompt');
    const asked = r.gateAsks().length;
    // The same fact again: merged by the deterministic check, no model call, no second copy.
    assert.equal(asked, 2, 'only the first conversation’s two candidates went to the model');
    assert.deepEqual(r.memories().map((x) => x.content), ['Lives in York.']);
    assert.ok(memoryOps(b.s)[0].existing);

    // A changed fact in the second conversation: the first one's memory is what it conflicts with.
    const c = await r.h.run('I moved to Leeds last week.', () => 'deny', b.id);
    const ask = r.gateAsks().at(-1);
    assert.equal(ask.state.person_said, 'I moved to Leeds last week.');
    assert.ok(ask.state.existing_memories.includes('Lives in York.'));
    assert.deepEqual(r.memories().map((x) => x.content), ['Lives in York.'], 'the old fact stays until the person chooses');
    const [cand] = (await r.h.get('/api/memory')).candidates;
    assert.equal(cand.content, 'Lives in Leeds.');
    assert.match(cand.reason, /“Lives in York\.”/);
    assert.equal(cand.source, `${b.id}/${lastTurn(c.s)}`);
    assert.equal(r.records().at(-1).source, `${b.id}/${lastTurn(c.s)}`);
  } finally { await r.close(); }
});

test('privacy: in local-first and local-only the person’s conversation never reaches a cloud seat, even with every opt-in on', async () => {
  const said = 'My sister Alex Placeholder lives at 12 Example Road.';
  for (const privacy of ['local-only', 'local-preferred']) {
    const jev = await startJevStandIn({ noul: (_c, q) => P.save[q] ?? 0.05 });
    // Jev alone has a passing verdict, so it is the seat the service would choose if it were allowed;
    // Tev1 doesn't answer.
    const r = await rig({
      replies: { [said]: `Noted.\n${remember('Has a sister, Alex Placeholder.')}` }, privacy, hub: CLOSED, verdicts: [pass('jev', 'jev-1.14.0')],
      decision: { settings: { jev: { base_url: jev.url, model: 'jev-1.14.0' }, tev1: { model: 'auto' }, opt_in: { screening: true, box: true } }, key: jev.key },
    });
    try {
      await r.h.run(said);
      assert.equal(jev.requests.length, 0, `${privacy}: nothing went to the cloud seat`);
      assert.equal(r.h.nova.core.db.all("SELECT 1 FROM receipt WHERE provider = 'jev'").length, 0, `${privacy}: no remote receipt`);
      const [rec] = r.records();
      assert.notEqual(rec.egress, 'remote:typesafe');
      assert.equal(rec.privacy_mode, privacy);
      assert.ok(JSON.parse(rec.failures).some((f) => f.seat === 'jev' && /keeps the person’s own conversation on this device; no opt-in sends it/.test(f.why)), rec.failures);
      // With nothing trusted to ask, today's write.
      assert.ok(r.memories().some((x) => x.content === 'Has a sister, Alex Placeholder.'));
    } finally { await r.close(); await jev.close(); }
  }
  // The control: in cloud mode the same setup does use the cloud seat, with a receipt.
  const jev = await startJevStandIn({ noul: (_c, q) => P.save[q] ?? 0.05 });
  const r = await rig({
    replies: { [said]: `Noted.\n${remember('Has a sister, Alex Placeholder.')}` }, privacy: 'cloud-allowed', hub: CLOSED, verdicts: [pass('jev', 'jev-1.14.0')],
    decision: { settings: { jev: { base_url: jev.url, model: 'jev-1.14.0' }, tev1: { model: 'auto' }, opt_in: { screening: false, box: false } }, key: jev.key },
  });
  try {
    await r.h.run(said);
    assert.equal(jev.requests.length, 1);
    assert.equal(jev.requests[0].body.state.person_said, said);
    assert.deepEqual(r.h.nova.core.db.all("SELECT privacy_mode FROM receipt WHERE provider = 'jev'").map((x) => x.privacy_mode), ['cloud-allowed']);
    assert.equal(r.records()[0].egress, 'remote:typesafe');
  } finally { await r.close(); await jev.close(); }
});

test('flag off: no memory is judged, and every remember is written as today', async () => {
  const r = await rig({ replies: { 'I keep bees.': `Lovely.\n${remember('Keeps bees.')}` }, outcomes: { 'Keeps bees.': 'skip' }, flag: false });
  try {
    const { s } = await r.h.run('I keep bees.');
    assert.equal(r.gateAsks().length, 0);
    assert.equal(r.records().length, 0);
    assert.ok(r.memories().some((x) => x.content === 'Keeps bees.'));
    assert.equal(memoryOps(s)[0].gate, undefined);
  } finally { await r.close(); }
});
