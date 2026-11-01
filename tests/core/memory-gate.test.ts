// memory-gate v1 (DS2; plan docs/plans/ds2-memory-gate.md): the template passes the authoring
// rules, its rule is a full truth table where a wrong save is the costliest error, an exact
// duplicate merges with no model call, Nova's answer never counts as the person's words, and the
// person's own conversation never goes to a cloud seat in a local mode, whatever opt-in is on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate, Registry } from '../../src/core/decision-service/registry.ts';
import { rows, checkTable, band } from '../../src/core/decision-service/policy.ts';
import { buildState } from '../../src/core/decision-service/state.ts';
import { DecisionService } from '../../src/core/decision-service/service.ts';
import { MemoryLog } from '../../src/core/decision-service/log.ts';
import { memoryVerdicts, type VerdictRecord } from '../../src/core/decision-service/verdicts.ts';
import { Tev1Seat } from '../../src/core/decision-service/seats/tev1.ts';
import { JevSeat } from '../../src/core/decision-service/seats/jev.ts';
import { DEFAULT_SETTINGS, type DecisionSettings } from '../../src/core/decision-service/settings.ts';
import { MEMORY_GATE_V1, MG_QUESTIONS, memoryPolicy, memoryPrecheck, existingList } from '../../src/core/decision-service/templates/memory-gate.ts';
import { startTev1StandIn } from '../support/tev1-stand-in.ts';
import { startJevStandIn } from '../support/jev-stand-in.ts';
import type { PrivacyMode } from '../../src/core/envelope.ts';

test('the template passes the authoring rules with no warnings, and its rule is a full truth table', () => {
  assert.deepEqual(validate(MEMORY_GATE_V1), { errors: [], warnings: [] });
  assert.equal(MEMORY_GATE_V1.feature, 'private');
  assert.equal(rows(MEMORY_GATE_V1).length, 3 ** 4);
  assert.deepEqual(checkTable(MEMORY_GATE_V1), []);
  const all = (b: string) => Object.fromEntries(MG_QUESTIONS.map((q) => [q, b]));
  const ok = { lasting: 'yes', in_person_words: 'yes', duplicate: 'no', contradicts: 'no' };
  assert.equal(memoryPolicy(ok), 'save');
  assert.equal(memoryPolicy({ ...ok, in_person_words: 'no' }), 'skip', 'only in Nova’s answer: never saved');
  assert.equal(memoryPolicy({ ...ok, in_person_words: 'unsettled' }), 'skip', 'unsure whose words: skip');
  assert.equal(memoryPolicy({ ...ok, lasting: 'no' }), 'skip');
  assert.equal(memoryPolicy({ ...ok, lasting: 'unsettled' }), 'skip', 'unsure it lasts: skip');
  assert.equal(memoryPolicy({ ...ok, contradicts: 'yes' }), 'flag');
  assert.equal(memoryPolicy({ ...ok, contradicts: 'unsettled' }), 'flag');
  assert.equal(memoryPolicy({ ...ok, duplicate: 'yes' }), 'merge');
  assert.equal(memoryPolicy({ ...ok, duplicate: 'unsettled' }), 'merge');
  assert.equal(memoryPolicy({ ...ok, duplicate: 'yes', contradicts: 'yes' }), 'flag', 'a conflict is the person’s to settle');
  // Save is reached by one row only: every other combination is not a save.
  assert.equal(rows(MEMORY_GATE_V1).filter((r) => memoryPolicy(r) === 'save').length, 1);
  assert.equal(memoryPolicy(all('unsettled')), 'skip');
});

test('saving needs a confident yes: 0.8 for lasting and the person’s own words; 0.7 for the others', () => {
  const p = MEMORY_GATE_V1.policy;
  const b = (q: (typeof MG_QUESTIONS)[number], x: number) => band(MEMORY_GATE_V1.questions[q]!, { type: 'noul', noul: x }, q, p);
  assert.deepEqual([b('lasting', 0.79), b('lasting', 0.8), b('in_person_words', 0.79), b('in_person_words', 0.8)], ['unsettled', 'yes', 'unsettled', 'yes']);
  assert.deepEqual([b('duplicate', 0.7), b('contradicts', 0.69), b('contradicts', 0.29)], ['yes', 'unsettled', 'no']);
});

test('deterministic first: an exact duplicate merges, an empty candidate is skipped, anything else goes to the model', () => {
  assert.deepEqual(memoryPrecheck({ person_said: 'x', candidate: 'Alex lives in Leeds.', existing_memories: 'alex lives in leeds\nSam has a cat' }), { outcome: 'merge', why: 'An existing memory says exactly this already.', findings: [], final: true });
  assert.equal(memoryPrecheck({ person_said: 'x', candidate: '   ' })!.outcome, 'skip');
  assert.equal(memoryPrecheck({ person_said: 'x', candidate: 'Alex lives in York.', existing_memories: 'Alex lives in Leeds' }), null);
  assert.deepEqual(existingList(' a \n\n b '), ['a', 'b']);
});

test('the state: the person’s words, Nova’s answer as context, the candidate, and existing memories as a list', () => {
  const b = buildState(MEMORY_GATE_V1, { person_said: 'I moved to York last month.', nova_answer: 'Welcome to York!', candidate: 'Lives in York.', existing_memories: 'Lives in Leeds.\nHas a cat called Pepper.' });
  assert.deepEqual(b.state, { person_said: 'I moved to York last month.', nova_answer: 'Welcome to York!', candidate: 'Lives in York.', existing_memories: ['Lives in Leeds.', 'Has a cat called Pepper.'] });
  const none = buildState(MEMORY_GATE_V1, { person_said: 'I always take the train.', candidate: 'Prefers the train.' });
  assert.deepEqual(none.state, { person_said: 'I always take the train.', nova_answer: '', candidate: 'Prefers the train.', existing_memories: [] });
});

const pass = (seat: 'jev' | 'tev1', model: string): VerdictRecord => ({ template_id: 'memory-gate', version: 1, seat, model, status: 'pass', why: 'test', run_at: null, ref: 'test' });

async function rig(o: { mode?: PrivacyMode; verdicts?: VerdictRecord[]; screeningOptIn?: boolean; tev1?: Parameters<typeof startTev1StandIn>[0] } = {}) {
  const ollama = await startTev1StandIn(o.tev1 ?? {});
  const api = await startJevStandIn({ noul: () => 0.9 });
  const settings: DecisionSettings = { ...DEFAULT_SETTINGS, jev: { base_url: api.url, model: 'jev-1.14.0' }, opt_in: { screening: o.screeningOptIn ?? false, box: false } };
  const registry = new Registry();
  registry.add(MEMORY_GATE_V1);
  const tev1 = new Tev1Seat({ url: ollama.url });
  await tev1.refresh();
  const log = new MemoryLog();
  const service = new DecisionService({
    registry, log, settings: () => settings, privacy: () => o.mode ?? 'local-only',
    verdicts: memoryVerdicts(o.verdicts ?? []),
    seats: { tev1, jev: new JevSeat({ config: () => ({ ...settings.jev!, key: () => api.key }) }) },
  });
  return { service, log, ollama, api, close: async () => { await ollama.close(); await api.close(); } };
}

const fields = { person_said: 'I moved to York last month.', nova_answer: 'Welcome to York!', candidate: 'Lives in York.', existing_memories: 'Has a cat called Pepper.' };

test('an exact duplicate is merged with no model call, and the record says so', async () => {
  const r = await rig({ verdicts: [pass('tev1', 'tev1:4b@aaaa4b')] });
  try {
    const d = (await r.service.ask('memory-gate', { ...fields, existing_memories: 'lives in york' }, { subsystem: 'memory' }))!;
    assert.equal(d.outcome, 'merge');
    assert.equal(r.ollama.requests.length, 0);
    assert.equal(r.log.records[0]!.egress, 'none');
  } finally { await r.close(); }
});

test('trusted: the model’s answers decide by the table (the stand-in says “yes” to all → a conflict is flagged)', async () => {
  const r = await rig({ verdicts: [pass('tev1', 'tev1:4b@aaaa4b')], tev1: { score: () => 0.95 } });
  try {
    const d = (await r.service.ask('memory-gate', fields, { subsystem: 'memory' }))!;
    assert.equal(d.trust, 'verdict');
    assert.equal(d.outcome, 'flag');
    assert.equal(d.autonomy, 'ask', 'a conflict asks the person');
    assert.deepEqual(Object.keys(r.ollama.requests[0]!.questions), [...MG_QUESTIONS]);
  } finally { await r.close(); }
});

test('untrusted: today’s behaviour (save, unreviewed), with the model’s answers kept as a shadow', async () => {
  const r = await rig();
  try {
    const d = (await r.service.ask('memory-gate', fields, { subsystem: 'memory' }))!;
    assert.equal(d.trust, 'none');
    assert.equal(d.outcome, 'save');
    assert.equal(r.log.records[0]!.shadows[0]!.seat, 'tev1');
  } finally { await r.close(); }
});

test('the person’s own conversation never goes to a cloud seat in a local mode, even with the screening opt-in on', async () => {
  for (const mode of ['local-only', 'local-preferred'] as const) {
    const r = await rig({ mode, screeningOptIn: true, verdicts: [pass('jev', 'jev-1.14.0')] });
    try {
      await r.service.ask('memory-gate', fields, { subsystem: 'memory' });
      assert.equal(r.api.requests.length, 0, mode);
      assert.ok(r.log.records[0]!.failures.some((f) => f.seat === 'jev' && /keeps the person’s own conversation on this device; no opt-in sends it/.test(f.why)));
    } finally { await r.close(); }
  }
  const c = await rig({ mode: 'cloud-allowed', verdicts: [pass('jev', 'jev-1.14.0')] });
  try {
    const d = (await c.service.ask('memory-gate', fields, { subsystem: 'memory' }))!;
    assert.equal(d.seat, 'jev', 'cloud mode may use the cloud seat');
    assert.equal(c.log.records[0]!.opt_in, null);
  } finally { await c.close(); }
});
