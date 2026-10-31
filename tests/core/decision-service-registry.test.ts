// The registry and policy (ADR §1), the cloud Jev seat's own limits (§2), and the person's choices
// (owner decision 2): authoring rules refused or flagged, immutable versions, every truth-table row
// enumerated, Jev's pin, context and Box limits against a stand-in, and the notices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, validate, refs } from '../../src/core/decision-service/registry.ts';
import { checkTable, rows, band, MAX_ROWS } from '../../src/core/decision-service/policy.ts';
import { INGEST_SCREEN_V1 } from '../../src/core/decision-service/templates/ingest-screen.ts';
import { JevSeat, boxCapable, fits as jevFits, modelProblem } from '../../src/core/decision-service/seats/jev.ts';
import { buildState } from '../../src/core/decision-service/state.ts';
import { wireQuestions, readAnswer } from '../../src/core/decision-service/wire.ts';
import { notices, recommend, scorecard, OPT_IN_WORDS, DEFAULT_SETTINGS } from '../../src/core/decision-service/settings.ts';
import { memoryVerdicts } from '../../src/core/decision-service/verdicts.ts';
import { startJevStandIn } from '../support/jev-stand-in.ts';
import { hubHardware } from '../support/models.ts';
import type { ServiceTemplate } from '../../src/core/decision-service/types.ts';

const base = (over: Partial<ServiceTemplate> = {}): ServiceTemplate => ({
  template_id: 'demo', version: 1, purpose: 'A test battery.', feature: 'screening',
  fields: { note: { type: 'text', max_chars: 200 } },
  questions: { urgent: { type: 'noul', instructions: 'Does `note` ask for a reply today?' } },
  policy: { outcomes: { reply: { action: 'flag for a reply', tier: 1 }, wait: { action: 'leave it', tier: 0, restrictive: true } }, table: (b) => (b.urgent === 'yes' ? 'reply' : 'wait'), default: 'wait', low: 'escalate' },
  ...over,
});

test('the authoring rules: what the registry refuses', () => {
  const err = (t: ServiceTemplate) => validate(t).errors.join(' | ');
  assert.match(err(base({ questions: { q: { type: 'noul', instructions: 'Is `memory` about money?' } } })), /refers to `memory`, which isn’t a field/);
  assert.match(err(base({ questions: { q: { type: 'choice', instructions: 'Which folder for `note`?', criteria: { A: 'bills', B: 'travel', unknown: null } } } })), /option names that say nothing about the content \(A, B\)/);
  assert.match(err(base({ questions: { q: { type: 'choice', instructions: 'Which folder for `note`?', criteria: { bills: null, travel: null } } } })), /needs an escape/);
  assert.equal(validate(base({ questions: { q: { type: 'choice', instructions: 'Which folder for `note`?', criteria: { bills: null, travel: null } }, any: { type: 'noul', instructions: 'Does `note` fit bills or travel?', escapes: 'q' } }, policy: { ...base().policy, table: () => 'wait' } })).errors.length, 0, 'a companion Noul is an escape');
  assert.match(err(base({ feature: 'box', fields: { frame: { type: 'image' } }, questions: { p: { type: 'box', instructions: 'the parcel in `frame`', companion: 'nope' } }, policy: { ...base().policy, table: () => 'wait' } })), /needs a companion Noul/);
  assert.match(err(base({ fields: { frame: { type: 'image' } }, questions: { has: { type: 'noul', instructions: 'Is there a parcel in `frame`?' } }, policy: { ...base().policy, table: () => 'wait' } })), /is the "box" feature/);
  assert.match(err(base({ fields: { note: { type: 'text', max_chars: 9, chunk: 'worst' } }, questions: { c: { type: 'choice', instructions: 'Which for `note`?', criteria: { bills: null, other: null } } }, policy: { ...base().policy, table: () => 'wait' } })), /a chunked field needs a battery of Nouls only/);
  assert.match(err(base({ policy: { ...base().policy, table: () => 'shout' } })), /policy: the table gives "shout"/);
  assert.match(err(base({ policy: { ...base().policy, default: 'nothing' } })), /the default "nothing" isn’t one of its outcomes/);
  assert.deepEqual(refs('Is `order.items[0]` in `note`?'), ['order', 'note']);
});

test('the authoring rules: what it flags, as Part 1’s v1 battery shows (a shared preamble, "or" lists)', () => {
  const { errors, warnings } = validate(INGEST_SCREEN_V1);
  assert.deepEqual(errors, [], 'v1 is valid: it is kept exactly as Part 1 ran it');
  assert.ok(warnings.some((w) => /every question opens with the same sentence/.test(w)), 'the preamble');
  assert.ok(warnings.some((w) => /^hidden_instruction joins conditions with "or"/.test(w)));
  assert.ok(warnings.some((w) => /^impersonation joins conditions with "or"/.test(w)));
});

test('versions are immutable: a changed copy of a registered version is refused; a new version is fine', () => {
  const r = new Registry();
  const t = base();
  r.add(t);
  assert.equal(r.add(t).template, t);
  assert.throws(() => r.add({ ...t, purpose: 'Changed.' }), /already registered; a change is a new version/);
  r.add({ ...t, version: 2 });
  assert.equal(r.get('demo')!.template.version, 2);
  assert.equal(r.get('demo', 1)!.template.version, 1);
  assert.throws(() => r.add(base({ template_id: 'Bad Id' })), /can’t be used/);
  assert.ok(Object.isFrozen(r.get('demo')!.template));
});

test('the truth table: every row is enumerated, including every unsettled band', () => {
  assert.equal(rows(INGEST_SCREEN_V1).length, 3 ** 5);
  assert.deepEqual(checkTable(INGEST_SCREEN_V1), []);
  const t = base({ questions: { a: { type: 'noul', instructions: 'Is `note` short?' }, c: { type: 'choice', instructions: 'Which for `note`?', criteria: { bills: null, travel: null, other: null } } } });
  assert.equal(rows(t).length, 3 * 4);
  // A table that forgets one row is refused, naming the row.
  const holes = { ...t, policy: { ...t.policy, table: (b: Record<string, string>) => (b.c === 'unsettled' && b.a === 'unsettled' ? 'oops' : 'wait') } };
  assert.match(checkTable(holes).join(' '), /gives "oops" for \{"a":"unsettled","c":"unsettled"\}/);
  const wide = base({ questions: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`q${i}`, { type: 'noul' as const, instructions: `Is \`note\` item ${i}?` }])) });
  assert.match(checkTable(wide).join(' '), new RegExp(`has ${3 ** 12} rows`));
  assert.ok(3 ** 12 > MAX_ROWS);
});

test('bands: Nouls at 0.7 and 0.3 by default (TypeSafe’s starting point); the gate’s 0.2 and 0.8 for ingest-screen v1', () => {
  const t = base();
  const n = (p: number) => band(t.questions.urgent!, { type: 'noul', noul: p }, 'urgent', t.policy);
  assert.deepEqual([n(0.71), n(0.7), n(0.69), n(0.3), n(0.29)], ['yes', 'yes', 'unsettled', 'unsettled', 'no']);
  const v1 = (p: number) => band(INGEST_SCREEN_V1.questions.exfiltration!, { type: 'noul', noul: p }, 'exfiltration', INGEST_SCREEN_V1.policy);
  assert.deepEqual([v1(0.19), v1(0.2), v1(0.79), v1(0.8)], ['no', 'unsettled', 'unsettled', 'yes'], 'pass below 0.2, block at 0.8, as the gate');
});

test('answers are read strictly in each question’s own type; nothing is repaired', () => {
  const choice = { type: 'choice' as const, instructions: 'x', criteria: { bills: null, travel: null } };
  assert.equal(readAnswer(choice, { type: 'choice', choice: 'food', probabilities: { bills: 0.5, travel: 0.5 }, confidence: 0.1 }), null);
  assert.equal(readAnswer(choice, { type: 'choice', choice: 'bills', probabilities: { bills: 0.9 }, confidence: 0.8 }), null, 'every option’s probability');
  assert.equal(readAnswer({ type: 'noul', instructions: 'x' }, { type: 'noul', noul: 1.2 }), null);
  assert.equal(readAnswer({ type: 'box', instructions: 'x', companion: 'y' }, { type: 'box', box: { top: 0.5, bottom: 0.4, left: 0.1, right: 0.2 }, confidence: 0.9 }), null, 'top must be above bottom');
  assert.deepEqual(readAnswer({ type: 'box', instructions: 'x', companion: 'y' }, { type: 'box', box: { top: 0.1, bottom: 0.4, left: 0.1, right: 0.2 }, confidence: null }), { type: 'box', box: { top: 0.1, bottom: 0.4, left: 0.1, right: 0.2 }, confidence: null });
  assert.equal(readAnswer({ type: 'score', instructions: 'x', criteria: ['low', 'high'] }, { type: 'score', score: 3, probabilities: { 0: 0.5, 1: 0.5 }, confidence: 0.1 }), null);
});

test('the Jev seat: the pin, the key, Box on 1.14 only, and TypeSafe’s two context limits', async () => {
  assert.match(modelProblem('jev-latest')!, /alias that moves/);
  assert.match(modelProblem('jev-preview')!, /alias that moves/);
  assert.match(modelProblem('gpt-4')!, /isn’t a versioned Jev model id/);
  assert.equal(modelProblem('jev-1.13.0'), null);
  assert.equal(boxCapable('jev-1.14.0'), true);
  assert.equal(boxCapable('jev-1.13.0'), false);
  assert.equal(boxCapable('jev-2.0.0'), true);
  const s = await startJevStandIn();
  try {
    let key: string | null = null;
    const seat = new JevSeat({ config: () => ({ base_url: s.url, model: 'jev-1.13.0', key: () => key }) });
    assert.match(seat.status().why, /without a key/);
    key = s.key;
    assert.equal(seat.status().available, true);
    assert.deepEqual(seat.limits().types, ['noul', 'choice', 'score'], 'no Box on 1.13');
    assert.equal(seat.limits().maxQuestions, null, 'no question-count limit on cloud Jev');
    // Many questions, one request: there is no 64 limit here.
    const many = base({ questions: Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`q${i}`, { type: 'noul' as const, instructions: `Is \`note\` about topic ${i}?` }])), policy: { ...base().policy, table: () => 'wait' } });
    const a = await seat.ask(many, buildState(many, { note: 'hello' }));
    assert.equal(s.requests.length, 1);
    assert.equal(Object.keys(a.answers).length, 80);
    assert.equal(s.requests[0]!.headers.authorization, `Bearer ${s.key}`);
    assert.equal(s.requests[0]!.headers['typesafe-danger-zone-images'], undefined, 'no images header without images');
    // A wrong key is the seat being unavailable, in words.
    key = 'wrong';
    await assert.rejects(seat.ask(many, buildState(many, { note: 'hello' })), /refused Nova’s key \(401\)/);
  } finally { await s.close(); }
  // Context: 32k per question and 64k per request (estimated at two bytes a token).
  const wq = wireQuestions(base().questions);
  assert.equal(jevFits('jev-1.14.0', { note: 'a'.repeat(60_000) }, wq), true);
  assert.equal(jevFits('jev-1.14.0', { note: 'a'.repeat(64_000) }, wq), false, 'over 32k tokens with one question');
  const tenQs = wireQuestions(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`q${i}`, { type: 'noul' as const, instructions: 'b'.repeat(14_000) }])));
  assert.equal(jevFits('jev-1.14.0', { note: 'short' }, tenQs), false, 'over 64k tokens across the request');
});

test('the person’s choices: recommendations, a notice for anything not recommended, and each opt-in in words', () => {
  const small = hubHardware({ gpus: [], ram_bytes: 8 * 1024 ** 3 }) as never;
  const r = recommend(hubHardware() as never);
  assert.deepEqual(r.jev, { base_url: 'https://api.typesafe.ai', model: 'jev-1.14.0' });
  assert.equal(r.tev1.model, 'tev1:4b');
  assert.equal(recommend(small).tev1.model, 'tev1:0.8b');
  assert.deepEqual(notices(DEFAULT_SETTINGS, { hardware: null }), [], 'the defaults need no notice');
  const n = notices({ jev: { base_url: 'https://gateway.example.com/typesafe', model: 'jev-1.13.0' }, tev1: { model: 'tev1:0.8b' }, opt_in: { screening: true, box: true } }, { hardware: hubHardware() as never });
  const kinds = n.map((x) => x.kind);
  assert.deepEqual(kinds, ['model', 'route', 'size', 'opt_in', 'opt_in']);
  assert.match(n[1]!.words, /gateway\.example\.com isn’t TypeSafe’s own API \(api\.typesafe\.ai\)/);
  assert.match(n[2]!.words, /smaller than this device can run/);
  assert.equal(n[3]!.words, OPT_IN_WORDS.screening);
  assert.match(OPT_IN_WORDS.screening, /Local-only isn’t strictly local for screening while it is on/);
  assert.match(OPT_IN_WORDS.box, /In local-only they never go to a cloud provider/);
  assert.match(notices({ ...DEFAULT_SETTINGS, jev: { base_url: 'https://api.typesafe.ai', model: 'jev-latest' } }, { hardware: null })[0]!.words, /alias that moves/);
  const v = memoryVerdicts([{ template_id: 'ingest-screen', version: 1, seat: 'jev', model: 'jev-1.14.0', status: 'pass', why: 'ok', run_at: null, ref: 'r' }]);
  assert.deepEqual(scorecard(v, [INGEST_SCREEN_V1], 'jev', 'jev-1.14.0').map((c) => c.trusted), [true]);
  assert.deepEqual(scorecard(v, [INGEST_SCREEN_V1], 'jev', 'jev-1.13.0').map((c) => c.trusted), [false], 'a verdict is per exact model version');
});

test('settings as the person sends them: aliases, plain-http remote routes and unknown sizes are refused, in words', async () => {
  const { validateSettings } = await import('../../src/core/decision-service/settings.ts');
  const ok = validateSettings({ jev: { base_url: 'https://api.typesafe.ai/', model: 'jev-1.14.0' }, tev1: { model: 'tev1:0.8b' }, opt_in: { screening: true } });
  assert.deepEqual(ok, { ok: true, settings: { jev: { base_url: 'https://api.typesafe.ai', model: 'jev-1.14.0' }, tev1: { model: 'tev1:0.8b' }, opt_in: { screening: true, box: false } } });
  const bad = validateSettings({ jev: { base_url: 'http://gateway.example.com', model: 'jev-latest' }, tev1: { model: 'tev1:70b' }, opt_in: { box: 'yes' } });
  assert.equal(bad.ok, false);
  const words = (bad as { problems: string[] }).problems.join(' | ');
  assert.match(words, /alias that moves/);
  assert.match(words, /must use https/);
  assert.match(words, /size must be auto/);
  assert.match(words, /box opt-in must be on or off/);
  assert.equal(validateSettings({ jev: { base_url: 'http://127.0.0.1:8080', model: 'jev-1.14.0' } }).ok, true, 'a local gateway on this machine');
  assert.deepEqual(validateSettings({}), { ok: true, settings: { jev: null, tev1: { model: 'auto' }, opt_in: { screening: false, box: false } } }, 'everything off by default');
});
