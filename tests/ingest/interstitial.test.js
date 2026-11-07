// The Interstitial Research hook end to end, through a real Nova (createNova) with a scripted chat
// model, the stand-in web, and a stand-in Decision Service ask that answers with chosen
// probabilities. No real model, network or device. Covers: flag on with the skill loaded runs the
// hook; flag on without the skill and flag off run none of it; the outbound check withholds a
// personal-derived query (P1-like); a claim citing an unfetched page fails; an injected page's
// instruction is never acted on and never becomes a finding (P2-like); local-only offers no web
// tools and makes no Decision Service call (P3-like; seat routing is tests/core/interstitial-templates);
// removal wipes ~/workspace/interstitial/; the improvement trigger files a proposal that applies nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, scripted, sleep, startNova } from './support.js';
import { Interstitial, OUTBOUND, VERIFY, readBlocks, unbacked, validateFieldMap } from '../../src/interstitial.js';

const FIELD_MAP = {
  core_fields: ['CI/CD'],
  boundary_conditions: ['adding runners stops helping once the queue is not the bottleneck'],
  adjacent_fields: [
    { name: 'queueing theory', relationship: 'shares-problem', rationale: 'build jobs are arrivals at servers' },
    { name: 'manufacturing flow', relationship: 'historical-analogue', rationale: 'WIP limits and flow efficiency' },
  ],
  interstitial_questions: ['Which queueing result predicts when more runners stop helping?'],
  gap_hypotheses: ['Little’s law is rarely applied to CI dashboards'],
  search_matrix: [{ query: 'ci pipeline slow', cell: 'core' }, { query: 'flow efficiency build pipelines', cell: 'core x manufacturing flow' }],
};
const fence = (kind, v) => `\`\`\`interstitial-${kind}\n${JSON.stringify(v)}\n\`\`\``;
const decided = (template_id, outcome, answers = null, trust = 'verdict') => ({ id: `dec-${Math.random().toString(16).slice(2, 10)}`, template_id, version: 1, outcome, action: '', tier: 0, autonomy: 'act', quality: 'high', trust, seat: 'tev1', model: 'tev1-test:1b@abc', answers, bands: null, why: 'stand-in' });
const nouls = (o) => Object.fromEntries(Object.entries(o).map(([q, p]) => [q, { type: 'noul', noul: p }]));
const SEND = () => decided(OUTBOUND, 'send', nouls({ person: 0.05, record: 0.05, memory: 0.05 }));
const USE = () => decided(VERIFY, 'use_established', nouls({ from_field: 0.9, mechanism: 0.85, supports: 0.9, established: 0.8 }));

// A Nova with the skill installed, the flag as given, and the stand-in ask.
async function start({ plan, flag = true, ask = (id) => (id === OUTBOUND ? SEND() : USE()), privacy = 'cloud-allowed', install = true }) {
  const m = scripted(plan);
  const h = await startNova({ agent: m.agent, privacy });
  const features = h.nova.runner.config.features;
  features.interstitial = true;
  if (install) assert.equal((await h.post('/api/skills/interstitial-research/install')).status, 200);
  features.interstitial = flag;
  const asked = [];
  h.nova.runner.decisions = async (id, fields, o) => { asked.push({ id, fields, o }); return ask(id, fields, o); };
  return { h, m, asked };
}
const items = (s) => s.session.turns.flatMap((t) => t.items);
const steps = (s, phase) => items(s).filter((i) => i.kind === 'interstitial' && (!phase || i.phase === phase));
const searched = (h) => h.web.hits.filter((x) => x.url.startsWith('/search')).map((x) => decodeURIComponent(x.url.replace(/\+/g, ' ')));

test('field map and claims blocks: strict schema, and the blocks come out of the visible text', () => {
  assert.deepEqual(validateFieldMap(FIELD_MAP), []);
  assert.ok(validateFieldMap({ ...FIELD_MAP, adjacent_fields: [{ name: 'x', relationship: 'vibes', rationale: 'y' }] }).some((e) => /relationship/.test(e)));
  assert.ok(validateFieldMap({ ...FIELD_MAP, extra: 1 }).some((e) => /unknown key/.test(e)));
  assert.ok(validateFieldMap({ ...FIELD_MAP, core_fields: [] }).length);
  const b = readBlocks(`Working on it.\n\n${fence('field-map', FIELD_MAP)}\n\n${fence('claims', [{ claim: 'c', field: 'f', source: 'https://a.example/' }])}`);
  assert.equal(b.rest, 'Working on it.');
  assert.deepEqual(b.fieldMap.value, FIELD_MAP);
  assert.equal(b.claims.value.length, 1);
  assert.deepEqual(readBlocks('```interstitial-field-map\n{not json\n```').fieldMap, { value: null, errors: ['not valid JSON'] });
});

test('flag on, skill loaded: outbound check per search, one verify per fetched claim, unfetched fails, the record is kept', async () => {
  let h0;
  const { h, m, asked } = await start({
    plan: (step) => [
      `Starting.\n${fence('field-map', FIELD_MAP)}\n${call('web_search', { query: 'flow efficiency build pipelines' })}`,
      call('web_fetch', { url: `${h0.web.base}/plain` }),
      fence('claims', [
        { claim: 'Limiting work in progress shortens CI lead time.', field: 'manufacturing flow', source: `${h0.web.base}/plain` },
        { claim: 'Runners behave like M/M/c servers.', field: 'queueing theory', source: 'https://unfetched.example/queues' },
      ]),
      'One line: WIP limits help.\n\n## Core findings\n...\n\n## Adjacent findings\n...',
    ][step] ?? 'Done.',
  });
  h0 = h;
  try {
    const { s } = await h.run(`Research why CI pipelines got slower. Notes: ${h.web.base}/plain`, () => 'allow');
    assert.ok(items(s).some((i) => i.kind === 'skill' && i.id === 'interstitial-research' && i.how === 'matched'));
    assert.deepEqual(asked.map((a) => a.id), [OUTBOUND, VERIFY], 'one outbound check, one verify (the unfetched claim needs no model)');
    assert.equal(asked[0].fields.query, 'flow efficiency build pipelines');
    assert.equal(asked[0].o.subsystem, 'interstitial-research');
    assert.equal(asked[0].o.privacy_mode, 'cloud-allowed');
    assert.match(asked[1].fields.cited_source_excerpt, /Mix flour, water, salt and yeast/);
    assert.match(asked[1].fields.cited_source_excerpt, /^<outside /, 'the screened extract, as data');
    assert.deepEqual(searched(h), ['/search?q=flow efficiency build pipelines']);

    const [verify] = steps(s, 'verify');
    assert.deepEqual(verify.claims.map((c) => c.outcome), ['use_established', 'discard']);
    // The model got the verdicts back as data before it wrote the answer.
    assert.match(m.calls.at(-1).prompt, /<tool_result name="interstitial_verify" ok="true">[\s\S]*wasn’t fetched in this run/);
    // The blocks never show in the conversation.
    assert.ok(items(s).filter((i) => i.kind === 'text').every((t) => !t.text.includes('```interstitial')));

    const [rec] = steps(s, 'record');
    assert.equal(rec.depth, 'standard');
    assert.equal(rec.privacy_class, 'public');
    assert.deepEqual(rec.field_map, FIELD_MAP);
    assert.deepEqual(rec.templates.map((t) => `${t.id}@${t.version}`), ['interstitial.verify-transfer@1', 'interstitial.outbound-check@1']);
    assert.deepEqual(rec.searches.map((x) => [x.query, x.cell, x.sent]), [['flow efficiency build pipelines', 'core x manufacturing flow', true]]);
    assert.equal(rec.sources[0].url, `${h.web.base}/plain`);
    assert.ok(rec.sources[0].screen && rec.sources[0].verdict);
    assert.deepEqual(rec.claims.map((c) => [c.outcome, c.verified, c.label]), [['use_established', true, 'established'], ['discard', false, 'hypothesis']]);
    assert.equal(rec.claims[0].probabilities.supports, 0.9);
    assert.equal(rec.claims[1].deterministic, true);
    assert.equal(rec.discarded, 1);
    assert.deepEqual(rec.layers, ['Core findings', 'Adjacent findings']);
    assert.ok(rec.cost.tokens.total > 0 && rec.cost.tokens.skill > 0 && rec.cost.tokens.core > 0);
    assert.equal(rec.cost.searches.skill, 1);
    assert.equal(rec.cost.decision_calls, 2);
    assert.ok(Number.isInteger(rec.elapsed_ms));

    const state = JSON.parse(readFileSync(join(h.home, 'workspace', 'interstitial', 'state.json'), 'utf8'));
    assert.equal(state.runs, 1);
    assert.equal(readFileSync(join(h.home, 'workspace', 'interstitial', 'runs.jsonl'), 'utf8').trim().split('\n').length, 1);
    // Activity shows the run as a step.
    const act = await h.get('/api/activity');
    const step = act.days.flatMap((d) => d.entries).flatMap((e) => e.steps).find((x) => x.kind === 'interstitial');
    assert.match(step.words, /^Interstitial research at standard depth: 1 search, 2 claims checked \(1 used, 0 uncertain, 1 left out\)$/);
  } finally { await h.close(); }
});

test('an invalid field map means Quick depth, core only, and the record says so', async () => {
  const { h } = await start({ plan: (step) => [`${'```'}interstitial-field-map\n{"core_fields": []}\n${'```'}\nAnswer.`][step] ?? 'Done.' });
  try {
    const { s } = await h.run('Research quiet bike tyres');
    const [rec] = steps(s, 'record');
    assert.equal(rec.depth, 'quick');
    assert.equal(rec.field_map, null);
    assert.match(rec.depth_why, /didn’t validate/);
  } finally { await h.close(); }
});

test('flag on without the skill loaded, and flag off with it installed: no hook, no template', async () => {
  const plan = (step) => [call('web_search', { query: 'bread basics' }), 'Bread needs flour.'][step] ?? 'Done.';
  for (const [name, o] of Object.entries({ notLoaded: { flag: true, text: 'Tell me about bread' }, off: { flag: false, text: 'Research bread' }, offNone: { flag: false, text: 'Research bread', install: false } })) {
    const { h, m, asked } = await start({ plan, flag: o.flag, install: o.install !== false });
    try {
      const { s } = await h.run(o.text);
      assert.equal(asked.length, 0, `${name}: no template called`);
      assert.deepEqual(steps(s), [], `${name}: no hook step`);
      assert.ok(!items(s).some((i) => i.kind === 'skill'), name);
      assert.equal(existsSync(join(h.home, 'workspace', 'interstitial')), false);
      if (name !== 'notLoaded') assert.doesNotMatch(m.calls[0].system, /interstitial/i);
      assert.deepEqual(searched(h), ['/search?q=bread basics']);
    } finally { await h.close(); }
  }
  // Byte-for-byte equality of the context itself: tests/skills.test.js (flag off: a home with the skill...).
});

test('P1-like: a personal-derived query is withheld and never leaves; the generalised one goes', async () => {
  const personal = 'sleep aids like my zolpidem 10mg prescription from Dr Alex Placeholder';
  const { h, asked } = await start({
    ask: (id, f) => (id === OUTBOUND ? (/zolpidem|Placeholder|my /i.test(f.query) ? decided(OUTBOUND, 'withhold', nouls({ person: 0.9, record: 0.95, memory: 0.6 })) : SEND()) : USE()),
    plan: (step, { turn }) => [
      `${fence('field-map', { ...FIELD_MAP, core_fields: ['sleep medicine'], privacy_class: 'personal-derived', search_matrix: [] })}\n${call('web_search', { query: personal })}`,
      /Not sent: this search could carry something/.test(turn) ? call('web_search', { query: 'how do common sleep aids work' }) : 'expected a refusal',
      'Sleep aids work in a few ways.',
    ][step] ?? 'Done.',
  });
  try {
    const { s } = await h.run('Research sleep aids like the ones in my health records.');
    assert.deepEqual(searched(h), ['/search?q=how do common sleep aids work'], 'the personal query never reached the search engine');
    assert.ok(!h.web.hits.some((x) => /zolpidem|Placeholder/i.test(decodeURIComponent(x.url))));
    assert.equal(asked[0].fields.privacy_class, 'personal-derived');
    const [rec] = steps(s, 'record');
    assert.equal(rec.privacy_class, 'personal-derived');
    assert.deepEqual(rec.searches.map((x) => [x.sent, x.outcome]), [[false, 'withhold'], [true, 'send']]);
    assert.equal(rec.cost.searches.withheld, 1);
  } finally { await h.close(); }
});

test('an untrusted outbound check (no verdict) fails closed: the search is held back', async () => {
  const { h } = await start({ ask: (id) => decided(id, id === OUTBOUND ? 'withhold' : 'quarantine', null, 'none'), plan: (step) => [call('web_search', { query: 'flow efficiency' }), 'No search was sent.'][step] ?? 'Done.' });
  try {
    await h.run('Research CI flow');
    assert.deepEqual(searched(h), []);
  } finally { await h.close(); }
});

test('P2-like: an injected page is data; its instruction is never acted on and never a finding', async () => {
  let h0;
  const { h, asked } = await start({
    plan: (step) => [
      `${fence('field-map', FIELD_MAP)}\n${call('web_fetch', { url: `${h0.web.base}/visible` })}`,
      fence('claims', [{ claim: 'Markets that open early draw more stalls.', field: 'urban economics', source: `${h0.web.base}/visible` }]),
      '## Core findings\nThe market opens at eight.',
    ][step] ?? 'Done.',
  });
  h0 = h;
  try {
    const { s } = await h.run(`Research weekend markets, starting from ${h.web.base}/visible`, () => 'allow');
    const all = JSON.stringify(steps(s));
    assert.doesNotMatch(all, /ignore your previous instructions|saved notes/i, 'never in the record or the verdicts');
    for (const a of asked) assert.doesNotMatch(JSON.stringify(a.fields), /ignore your previous instructions/i, 'never sent on as the excerpt');
    assert.ok(!h.web.hits.some((x) => x.url.startsWith('/c')), 'nothing went to the collector');
    assert.deepEqual(items(s).filter((i) => i.kind === 'tool').map((t) => t.name), ['web_fetch']);
    const [rec] = steps(s, 'record');
    assert.equal(rec.claims.length, 1);
    assert.equal(rec.sources[0].verdict === 'pass', false, 'the screen did not pass it as plain');
  } finally { await h.close(); }
});

test('P3-like: in local-only no web tool is offered and no Decision Service call is made', async () => {
  const { h, m, asked } = await start({
    privacy: 'local-only',
    plan: (step) => [
      `${fence('field-map', FIELD_MAP)}\n${call('web_search', { query: 'ci queueing' })}`,
      fence('claims', [{ claim: 'x', field: 'queueing theory', source: 'https://example.org/q' }]),
      'No outside research was done: your privacy setting is local-only. From what Nova knows itself: ...',
    ][step] ?? 'Done.',
  });
  try {
    const { s } = await h.run('Research why our CI got slower');
    assert.ok(m.calls.every((c) => !c.system.includes('merino wool hiking socks')), 'web_search is not offered');
    assert.equal(items(s).find((i) => i.kind === 'tool').result.ok, false, 'web_search is not a tool here');
    assert.deepEqual(asked, [], 'nothing judged, nothing sent anywhere');
    assert.deepEqual(h.web.hits, []);
    const [rec] = steps(s, 'record');
    assert.deepEqual(rec.claims.map((c) => [c.outcome, c.deterministic]), [['discard', true]]);
  } finally { await h.close(); }
});

test('a correction in the next message is counted (a heuristic); removal wipes the data, Undo brings it back', async () => {
  const { h } = await start({ plan: (step) => [`${fence('field-map', FIELD_MAP)}\nAnswer.`][step] ?? 'Done.' });
  try {
    const { id } = await h.run('Research CI flow');
    const { s } = await h.run('That’s wrong, the queue was never the problem.', () => 'deny', id);
    const [c] = steps(s, 'correction');
    assert.equal(c.heuristic, 'pattern');
    const dir = join(h.home, 'workspace', 'interstitial');
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).corrections, 1);
    writeFileSync(join(dir, 'dead-ends.md'), '- ci x astronomy (2026-11-01)\n');

    const r = await (await h.post('/api/skills/interstitial-research/remove')).json();
    assert.equal(existsSync(dir), false, 'its data is gone with it');
    assert.equal(existsSync(join(h.home, 'skills', 'interstitial-research')), false);
    assert.ok(r.data['state.json'] && r.data['dead-ends.md']);
    // Decision and ledger history aren't touched; the conversation's record stays as history.
    assert.ok(steps(await h.session(id), 'record').length >= 1);
    assert.equal((await h.post('/api/skills/interstitial-research/restore', { files: r.files, data: r.data })).status, 200);
    assert.match(readFileSync(join(dir, 'dead-ends.md'), 'utf8'), /astronomy/);
  } finally { await h.close(); }
});

test('the improvement trigger files a task that waits for the OK, and approving it only writes the proposal', async () => {
  const { h } = await start({ plan: () => 'Done.', install: false });
  try {
    const hook = new Interstitial({ home: h.home, ask: async () => null, ledger: h.nova.core.ledger });
    const rec = (breach = false, depth = 'quick') => ({ depth, cost: { breach } });
    const filed = [];
    for (let i = 0; i < 9; i++) assert.equal(hook.counted(rec()), null);
    filed.push(hook.counted(rec()));
    assert.ok(filed[0], 'every 10 runs');
    for (let i = 0; i < 2; i++) assert.equal(hook.counted(rec(true, 'deep')), null);
    filed.push(hook.counted(rec(true, 'deep')));
    assert.ok(filed[1], '3 breaches at one depth');
    assert.equal(hook.correction(), null);
    filed.push(hook.correction());
    assert.ok(filed[2], '2 corrections');
    const s = hook.state();
    assert.equal(s.runs, 13);
    assert.equal(s.proposals.length, 3);

    const t = h.nova.core.ledger.get(filed[0].id);
    assert.equal(t.owner, 'workspace');
    assert.equal(t.approval_tier, 2);
    assert.equal(t.state, 'waiting', 'waits for the owner’s OK');
    assert.match(t.brief.goal, /apply as a new skill version via a builder PR/i);
    assert.match(t.brief.inputs.path, /^interstitial\/proposals\//);
    assert.match(t.brief.inputs.content, /## Run records \(evidence\)/);
    const skillsBefore = readdirSync(join(h.nova.runner.config.root, 'skills')).join();
    h.nova.core.ledger.approve(t.id);
    for (let i = 0; i < 200 && h.nova.core.ledger.get(t.id).state !== 'done'; i++) await sleep(20);
    assert.equal(h.nova.core.ledger.get(t.id).state, 'done');
    assert.ok(existsSync(join(h.home, 'workspace', t.brief.inputs.path)));
    assert.equal(readdirSync(join(h.nova.runner.config.root, 'skills')).join(), skillsBefore, 'nothing applied');
    assert.equal(existsSync(join(h.home, 'skills', 'interstitial-research')), false);
  } finally { await h.close(); }
});

test('field-map cache (errata E1): same public topic and key hits; another model, template or skill version misses; private maps are never kept', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-ir-'));
  const mk = (o = {}) => new Interstitial({ home, ask: async () => null, skillText: () => 'playbook v1', ...o });
  const hook = mk();
  const topic = 'Research why CI pipelines got slower';
  const a = hook.begin({ topic, model: 'model-a' });
  assert.equal(a.cache, 'miss');
  hook.fieldMap(a, { value: FIELD_MAP, errors: [] });
  assert.equal(a.cache, 'stored');
  const b = hook.begin({ topic: 'research why CI pipelines got slower?', model: 'model-a' });
  assert.equal(b.cache, 'hit');
  assert.deepEqual(b.field_map, FIELD_MAP);
  hook.fieldMap(b, { value: { ...FIELD_MAP, core_fields: ['something else'] }, errors: [] });
  assert.deepEqual(b.field_map, FIELD_MAP, 'written only on a miss');
  assert.equal(hook.begin({ topic, model: 'model-b' }).cache, 'miss', 'another model version');
  assert.equal(mk({ templates: [{ id: VERIFY, version: 2 }, { id: OUTBOUND, version: 1 }] }).begin({ topic, model: 'model-a' }).cache, 'miss', 'another template version');
  assert.equal(mk({ skillText: () => 'playbook v2' }).begin({ topic, model: 'model-a' }).cache, 'miss', 'another skill version');
  assert.equal(hook.begin({ topic: 'Research quiet bike tyres', model: 'model-a' }).cache, 'miss', 'another topic');
  // A topic that recalled the person's memory is personal-derived: it never reads or writes the shared cache.
  assert.equal(hook.begin({ topic, model: 'model-a', recall: [{ id: 'n1' }] }).cache, 'miss');
  const secret = { ...FIELD_MAP, core_fields: ['sleep medicine marker-pd'] };
  const p = hook.begin({ topic: 'Research sleep aids', model: 'model-a', recall: [{ id: 'n1' }] });
  hook.fieldMap(p, { value: secret, errors: [] });
  assert.equal(p.cache, 'per-task');
  const q = hook.begin({ topic: 'Research sensitive thing', model: 'model-a' });
  hook.fieldMap(q, { value: { ...secret, privacy_class: 'sensitive' }, errors: [] });
  assert.equal(q.cache, 'per-task', 'a map that says sensitive is kept for the task only');
  assert.equal(hook.begin({ topic: 'Research sensitive thing', model: 'model-a' }).cache, 'miss');
  assert.doesNotMatch(readFileSync(join(home, 'workspace', 'interstitial', 'field-maps.json'), 'utf8'), /marker-pd/);
  // A tampered cache entry that no longer validates is not used.
  writeFileSync(join(home, 'workspace', 'interstitial', 'field-maps.json'), JSON.stringify({ [hook.cacheKey(a, 'public')]: { map: { core_fields: [] } } }));
  assert.equal(hook.begin({ topic, model: 'model-a' }).cache, 'miss');
});

test('field-map cache end to end: a second conversation on the same public topic is handed the map; a personal-derived one is not', async () => {
  const plan = (pd) => (step, { turn }) => (turn.includes('interstitial_field_map')
    ? ['Using the cached map.\n\n## Core findings\n...'][step - 1]
    : [`${fence('field-map', pd ? { ...FIELD_MAP, privacy_class: 'personal-derived' } : FIELD_MAP)}\n## Core findings\n...`][step]) ?? 'Done.';
  for (const pd of [false, true]) {
    const { h, m } = await start({ plan: plan(pd) });
    try {
      const first = (await h.run('Research why CI pipelines got slower')).s;
      const second = (await h.run('Research why CI pipelines got slower')).s;
      const [r1] = steps(first, 'record');
      const [r2] = steps(second, 'record');
      if (!pd) {
        assert.equal(r1.field_map_cache, 'stored');
        assert.equal(r2.field_map_cache, 'hit');
        assert.deepEqual(r2.field_map, FIELD_MAP);
        assert.equal(steps(second, 'field-map').length, 1);
        assert.match(m.calls.at(-1).prompt, /<tool_result name="interstitial_field_map" ok="true">/);
      } else {
        assert.deepEqual([r1.field_map_cache, r2.field_map_cache], ['per-task', 'per-task'], 'never reused across conversations');
        assert.equal(steps(second, 'field-map').length, 0);
        assert.equal(existsSync(join(h.home, 'workspace', 'interstitial', 'field-maps.json')), false, 'never written to the shared cache');
      }
    } finally { await h.close(); }
  }
});

test('a tampered state.json can only hold counts', () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-ir-'));
  mkdirSync(join(home, 'workspace', 'interstitial'), { recursive: true });
  writeFileSync(join(home, 'workspace', 'interstitial', 'state.json'), '{"runs":"lots","breaches":{"quick":-4,"x":9},"proposals":[{"task":1},"no"],"window":{"runs":9.7}}');
  const s = new Interstitial({ home, ask: async () => null }).state();
  assert.deepEqual(s, { runs: 0, breaches: { quick: 0, standard: 0, deep: 0 }, corrections: 0, window: { runs: 9, breaches: { quick: 0, standard: 0, deep: 0 }, corrections: 0 }, proposals: [] });
});

// ---- Part 3 findings: the record says what happened ------------------------------------------------

test('Part 3 P1: a topic about the person, or a query carrying a word from their memory, is personal-derived', async () => {
  const hook = new Interstitial({ home: mkdtempSync(join(tmpdir(), 'nova-ir-')), ask: async () => null });
  assert.equal(hook.begin({ topic: 'Research sleep aids like the ones in my health records' }).privacy_class, 'personal-derived');
  assert.equal(hook.begin({ topic: 'Research how sleep aids work' }).privacy_class, 'public');
  const asked = [];
  const memoryHook = new Interstitial({ home: mkdtempSync(join(tmpdir(), 'nova-ir-')), ask: async (id, f) => { asked.push(f.privacy_class); return null; } });
  const ir = memoryHook.begin({ topic: 'Research sleep aids', personal: 'Takes zolpidem 10 mg nightly since March 2024.' });
  assert.equal(ir.privacy_class, 'public');
  await memoryHook.outbound(ir, 'how do sleep aids work', 'cloud-allowed');
  await memoryHook.outbound(ir, 'alternatives to zolpidem', 'cloud-allowed');
  assert.deepEqual(asked, ['public', 'personal-derived'], 'the check is told before it decides');
  assert.equal(ir.searches[1].from_memory, true);
  assert.equal(ir.searches[0].from_memory, undefined);
  const rec = memoryHook.record(ir);
  assert.equal(rec.privacy_class, 'personal-derived');
  assert.doesNotMatch(JSON.stringify(rec), /personal_terms|nightly|March/, 'the person’s own words are never in the record');
});

test('Part 3 P1 end to end: MEMORY.md feeds the check; the query never leaves, and the record is not "public"', async () => {
  const { h, asked } = await start({
    ask: (id, f) => (id === OUTBOUND ? (f.privacy_class === 'personal-derived' ? decided(OUTBOUND, 'withhold', nouls({ person: 0.2, record: 0.9, memory: 0.9 })) : SEND()) : USE()),
    plan: (step) => [call('web_search', { query: 'alternatives to zolpidem and melatonin' }), 'Sleep aids work in a few ways.'][step] ?? 'Done.',
  });
  try {
    writeFileSync(join(h.home, 'MEMORY.md'), '- Health record: takes zolpidem 10 mg nightly; also tried melatonin.\n');
    const { s } = await h.run('Research sleep aids');
    assert.equal(asked[0].fields.privacy_class, 'personal-derived');
    assert.ok(!h.web.hits.some((x) => /zolpidem/i.test(decodeURIComponent(x.url))));
    const [rec] = steps(s, 'record');
    assert.equal(rec.privacy_class, 'personal-derived');
    assert.deepEqual(rec.searches.map((x) => [x.sent, x.why_withheld, x.from_memory]), [[false, 'judged', true]]);
  } finally { await h.close(); }
});

test('Part 3: an untrusted check says so to the model, and the record says why it held back', async () => {
  const { h, m } = await start({ ask: (id) => decided(id, id === OUTBOUND ? 'withhold' : 'quarantine', null, 'none'), plan: (step) => [call('web_search', { query: 'flow efficiency' }), 'No outside search was done. From what I know: flow matters.'][step] ?? 'Done.' });
  try {
    const { s } = await h.run('Research CI flow');
    assert.match(m.calls[1].prompt, /hasn’t passed its eval yet[\s\S]*say plainly that no outside search was done/);
    assert.doesNotMatch(m.calls[1].prompt, /could carry something of the person’s own/);
    const [rec] = steps(s, 'record');
    assert.equal(rec.privacy_class, 'public');
    assert.equal(rec.searches[0].why_withheld, 'untrusted');
    assert.deepEqual(rec.unbacked, [], 'an honest answer is not flagged');
    assert.equal(steps(s, 'honesty').length, 0);
  } finally { await h.close(); }
});

test('Part 3: headings and "verified"/"searched" with nothing behind them are flagged in the record and to the person', async () => {
  const answer = 'I searched as “design patterns across fields” and verified the main idea.\n\n## Core findings\n...\n\n## Interstitial insight\n...\n\n## Gaps confirmed\n...';
  const { h } = await start({ ask: (id) => decided(id, 'withhold', null, 'none'), plan: (step) => [answer][step] ?? 'Done.' });
  try {
    const { s } = await h.run('Research design patterns across fields');
    const [rec] = steps(s, 'record');
    assert.deepEqual(rec.layers, ['Core findings', 'Interstitial insight', 'Gaps confirmed'], 'headings are still listed as headings');
    assert.deepEqual(rec.unbacked, ['adjacent-unchecked', 'gaps-unsearched', 'says-verified', 'says-searched']);
    const [note] = steps(s, 'honesty');
    assert.match(note.words, /^Read this answer with care: it has adjacent or interstitial findings, but no claim behind them passed the check; .*no search left Nova in this run\.$/);
    const act = await h.get('/api/activity');
    const step = act.days.flatMap((d) => d.entries).flatMap((e) => e.steps).find((x) => x.kind === 'interstitial');
    assert.match(step.words, /the answer claims more than the run backs/);
  } finally { await h.close(); }
  // Negation is not a claim.
  const ir = { text: 'Nothing here could be verified, and no search was sent; I never searched.', searches: [], claims: [] };
  assert.deepEqual(unbacked(ir), []);
});

test('Part 3 cost: the playbook carried in every call is the skill’s, so a run with only core searches still shows its overhead', async () => {
  const hook = new Interstitial({ home: mkdtempSync(join(tmpdir(), 'nova-ir-')), ask: async () => null });
  const ir = hook.begin({ topic: 'Research CI flow' });
  hook.tokens(ir, 1000, 400);
  hook.tokens(ir, 1000, 5000);
  assert.deepEqual(ir.tokens, { core: 600, skill: 1400 }, 'a share is never more than the call');
  const rec = hook.record(ir);
  assert.ok(rec.cost.overhead > 2 && rec.cost.breach === true);
  // End to end: a run whose only search is core still counts the playbook.
  const { h } = await start({ plan: (step) => [call('web_search', { query: 'ci flow' }), 'Flow matters.'][step] ?? 'Done.' });
  try {
    const { s } = await h.run('Research CI flow');
    const [r] = steps(s, 'record');
    assert.equal(r.cost.searches.skill, 0);
    assert.ok(r.cost.tokens.skill > 0, 'the playbook’s tokens are the skill’s');
    assert.ok(r.cost.overhead > 0);
  } finally { await h.close(); }
});

test('Part 3 P1: today’s notes are the person’s own text too (they are in every prompt)', async () => {
  const { h, asked } = await start({
    ask: (id, f) => (id === OUTBOUND ? (f.privacy_class === 'personal-derived' ? decided(OUTBOUND, 'withhold', nouls({ person: 0.2, record: 0.9, memory: 0.9 })) : SEND()) : USE()),
    plan: (step) => [call('web_search', { query: 'side effects of trazodone' }), 'Sleep aids work in a few ways.'][step] ?? 'Done.',
  });
  try {
    mkdirSync(join(h.home, 'memory'), { recursive: true });
    writeFileSync(join(h.home, 'memory', `${h.nova.runner.memory.today()}.md`), '- Started trazodone tonight, per the clinic.\n');
    const { s } = await h.run('Research sleep aids');
    assert.equal(asked[0].fields.privacy_class, 'personal-derived');
    assert.ok(!h.web.hits.some((x) => /trazodone/i.test(decodeURIComponent(x.url))));
    const [rec] = steps(s, 'record');
    assert.equal(rec.searches[0].from_memory, true);
  } finally { await h.close(); }
});
