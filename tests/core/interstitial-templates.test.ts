// The Interstitial Research templates (src/core/decision-service/templates/interstitial.ts): they
// pass the authoring rules, their truth tables are whole, the verify-transfer bands are SKILL.md
// §4's, an untrusted seat falls to the safe default (quarantine / withhold), and in a local mode
// no state ever reaches the cloud seat. Stand-in seats only: no model, network or device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionService } from '../../src/core/decision-service/service.ts';
import { Registry, validate } from '../../src/core/decision-service/registry.ts';
import { MemoryLog } from '../../src/core/decision-service/log.ts';
import { memoryVerdicts, type VerdictRecord } from '../../src/core/decision-service/verdicts.ts';
import { checkTable, rows } from '../../src/core/decision-service/policy.ts';
import { DEFAULT_SETTINGS, type DecisionSettings } from '../../src/core/decision-service/settings.ts';
import { BUILT_INS } from '../../src/core/decision-service/index.ts';
import { OC_QUESTIONS, OUTBOUND_CHECK_V1, VERIFY_TRANSFER_V1, VT_QUESTIONS, outboundPolicy, verifyPolicy } from '../../src/core/decision-service/templates/interstitial.ts';
import type { PrivacyMode } from '../../src/core/envelope.ts';
import type { Seat, SeatId } from '../../src/core/decision-service/types.ts';

const MODEL = { tev1: 'tev1-test:1b@abc123', jev: 'jev-1.14.0' };

// A seat that answers every Noul with the probability `p(question)` and counts what it was sent.
function seat(id: 'tev1' | 'jev', p: (q: string) => number) {
  const asked: unknown[] = [];
  const s: Seat = {
    id, egress: id === 'jev' ? 'remote' : 'local',
    limits: () => ({ maxQuestions: 64, images: false, types: ['noul', 'choice', 'score', 'box'] }),
    status: () => ({ available: true, model: MODEL[id], why: '' }),
    async ask(t, built) {
      asked.push(built.state);
      return { answers: Object.fromEntries(Object.keys(t.questions).map((q) => [q, { type: 'noul' as const, noul: p(q) }])), model_answered: MODEL[id], pieces: 1, requests: 1, usage: { input_tokens: 10, output_tokens: 1 } };
    },
  };
  return { s, asked };
}
const pass = (template_id: string, s: SeatId): VerdictRecord => ({ template_id, version: 1, seat: s, model: MODEL[s as 'tev1' | 'jev'], status: 'pass', why: 'test', run_at: null, ref: 'test' });

function service(o: { mode: PrivacyMode; p?: (q: string) => number; trusted?: SeatId[] }) {
  const registry = new Registry();
  for (const t of BUILT_INS) registry.add(t);
  const settings: DecisionSettings = { ...DEFAULT_SETTINGS, jev: { base_url: 'http://jev.invalid', model: MODEL.jev } };
  const tev1 = seat('tev1', o.p ?? (() => 0.9));
  const jev = seat('jev', o.p ?? (() => 0.9));
  const log = new MemoryLog();
  const trusted = o.trusted ?? ['tev1', 'jev'];
  const svc = new DecisionService({
    registry, log, settings: () => settings, privacy: () => o.mode,
    verdicts: memoryVerdicts(trusted.flatMap((s) => [pass(VERIFY_TRANSFER_V1.template_id, s), pass(OUTBOUND_CHECK_V1.template_id, s)])),
    seats: { tev1: tev1.s, jev: jev.s },
  });
  return { svc, log, tev1, jev };
}
const CLAIM = { claim: 'WIP limits cut CI queue time.', claimed_field: 'manufacturing flow', cited_source_excerpt: '<outside source="web">Limiting work in progress shortens lead time.</outside>' };

test('both templates pass the authoring rules with no warnings, and their tables are whole', () => {
  for (const t of [VERIFY_TRANSFER_V1, OUTBOUND_CHECK_V1]) {
    assert.deepEqual(validate(t), { errors: [], warnings: [] }, t.template_id);
    assert.deepEqual(checkTable(t), []);
    assert.equal(t.feature, 'private', 'never a cloud seat in a local mode');
    assert.equal(t.version, 1);
    assert.equal(t.legacy, false, 'the sorting model never answers these');
  }
  assert.deepEqual(Object.keys(VERIFY_TRANSFER_V1.questions), [...VT_QUESTIONS]);
  assert.deepEqual(Object.keys(OUTBOUND_CHECK_V1.questions), [...OC_QUESTIONS]);
  assert.equal(VERIFY_TRANSFER_V1.fields.cited_source_excerpt!.type === 'text' && VERIFY_TRANSFER_V1.fields.cited_source_excerpt!.chunk, 'worst');
  assert.equal(rows(VERIFY_TRANSFER_V1).length, 81);
  // The safe defaults: nothing untrusted makes a claim usable or lets a search leave.
  assert.equal(VERIFY_TRANSFER_V1.policy.default, 'quarantine');
  assert.equal(OUTBOUND_CHECK_V1.policy.default, 'withhold');
});

test('verify-transfer rule: any of a–c no discards, any unsettled quarantines, all yes uses, labelled by (d)', () => {
  for (const r of rows(VERIFY_TRANSFER_V1)) {
    const gate = [r.from_field, r.mechanism, r.supports];
    const want = gate.includes('no') ? 'discard' : gate.includes('unsettled') ? 'quarantine' : r.established === 'yes' ? 'use_established' : 'use_hypothesis';
    assert.equal(verifyPolicy(r), want, JSON.stringify(r));
  }
  for (const r of rows(OUTBOUND_CHECK_V1)) assert.equal(outboundPolicy(r), OC_QUESTIONS.every((q) => r[q] === 'no') ? 'send' : 'withhold', JSON.stringify(r));
});

test('verify-transfer bands through the service (errata E2): exactly 0.7 passes, 0.4 ≤ p < 0.7 quarantines, < 0.4 discards; (d) sets the label', async () => {
  const at = async (gate: number, d = 0.9, only: string | null = null) => (await service({ mode: 'local-only', p: (q) => (q === 'established' ? d : only && q !== only ? 0.95 : gate) }).svc.ask(VERIFY_TRANSFER_V1.template_id, CLAIM, { subsystem: 'test' }))!;
  assert.equal((await at(0.7)).outcome, 'use_established');
  assert.equal((await at(0.95, 0.2)).outcome, 'use_hypothesis');
  assert.equal((await at(0.6999)).outcome, 'quarantine');
  assert.equal((await at(0.4)).outcome, 'quarantine');
  assert.equal((await at(0.3999)).outcome, 'discard');
  // Each of (a), (b) and (c) on its own, at every boundary.
  for (const q of ['from_field', 'mechanism', 'supports']) {
    assert.deepEqual(await Promise.all([0.7, 0.6999, 0.4, 0.3999].map(async (p) => (await at(p, 0.9, q)).outcome)), ['use_established', 'quarantine', 'quarantine', 'discard'], q);
  }
  // One weak answer is enough.
  const mixed = (await service({ mode: 'local-only', p: (q) => (q === 'supports' ? 0.1 : 0.95) }).svc.ask(VERIFY_TRANSFER_V1.template_id, CLAIM, { subsystem: 'test' }))!;
  assert.equal(mixed.outcome, 'discard');
});

test('an untrusted seat answers only as evidence: the claim falls to quarantine, the query to withhold', async () => {
  const { svc, log, tev1 } = service({ mode: 'local-only', p: () => 0.99, trusted: [] });
  const v = (await svc.ask(VERIFY_TRANSFER_V1.template_id, CLAIM, { subsystem: 'test' }))!;
  assert.equal(v.outcome, 'quarantine');
  assert.equal(v.trust, 'none');
  assert.equal(v.answers, null);
  assert.equal(tev1.asked.length, 1, 'asked, as a shadow');
  assert.equal(log.records.at(-1)!.shadows.length, 1);
  const o = (await svc.ask(OUTBOUND_CHECK_V1.template_id, { query: 'queueing theory ci', privacy_class: 'public' }, { subsystem: 'test' }))!;
  assert.equal(o.outcome, 'withhold', 'fails closed');
});

test('outbound-check: any yes withholds; all a confident no sends', async () => {
  const q = { query: 'flow efficiency in build pipelines', privacy_class: 'public' };
  assert.equal((await service({ mode: 'local-only', p: () => 0.05 }).svc.ask(OUTBOUND_CHECK_V1.template_id, q, { subsystem: 'test' }))!.outcome, 'send');
  assert.equal((await service({ mode: 'local-only', p: (x) => (x === 'record' ? 0.9 : 0.05) }).svc.ask(OUTBOUND_CHECK_V1.template_id, q, { subsystem: 'test' }))!.outcome, 'withhold');
  assert.equal((await service({ mode: 'local-only', p: (x) => (x === 'person' ? 0.5 : 0.05) }).svc.ask(OUTBOUND_CHECK_V1.template_id, q, { subsystem: 'test' }))!.outcome, 'withhold', 'unsure withholds');
});

test('local-only and local-preferred: every call on the local seat, nothing to the cloud; cloud mode may use Jev', async () => {
  for (const mode of ['local-only', 'local-preferred'] as PrivacyMode[]) {
    const { svc, log, jev } = service({ mode, p: () => 0.05 });
    for (const [id, f] of [[VERIFY_TRANSFER_V1.template_id, CLAIM], [OUTBOUND_CHECK_V1.template_id, { query: 'x', privacy_class: 'public' }]] as const) {
      const d = (await svc.ask(id, f, { subsystem: 'test' }))!;
      assert.equal(d.seat, 'tev1', `${mode} ${id}`);
    }
    assert.equal(jev.asked.length, 0, `${mode}: the cloud seat was never sent anything`);
    assert.ok(log.records.every((r) => r.egress === 'local' && r.privacy_mode === mode));
  }
  const cloud = service({ mode: 'cloud-allowed', p: () => 0.05 });
  assert.equal((await cloud.svc.ask(OUTBOUND_CHECK_V1.template_id, { query: 'x', privacy_class: 'public' }, { subsystem: 'test' }))!.seat, 'jev');
  // A run's own stricter mode wins over a cloud setting.
  const strict = service({ mode: 'cloud-allowed', p: () => 0.05 });
  assert.equal((await strict.svc.ask(OUTBOUND_CHECK_V1.template_id, { query: 'x', privacy_class: 'public' }, { subsystem: 'test', privacy_mode: 'local-only' }))!.seat, 'tev1');
  assert.equal(strict.jev.asked.length, 0);
});
