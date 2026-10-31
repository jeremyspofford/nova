// Tev1, the local decision provider behind the Jev interface (Amendment 2026-10-31-B Part 1, plan
// docs/plans/tev1.md), against a stand-in of Ollama's /v1/systemone on loopback (CI has no
// Ollama). The plumbing: one request per battery, at most 64 questions, every chunk screened with
// the worst score winning, the caps, the version check and its words, the size, and the
// verdict-driven switch, with the real gate end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../../src/core/db.ts';
import { Log } from '../../src/core/log.ts';
import { Verifier } from '../../src/core/verify.ts';
import { Workspace } from '../../src/core/workspace.ts';
import { Decisions, JevProvider, RulesProvider, Templates, validateTemplate, type Template } from '../../src/core/decide.ts';
import { CHUNK, Ingest, QUESTIONS, SCREEN, fence } from '../../src/core/ingest/screen.ts';
import { SystemOne, TooLong, Unavailable, older, MAX_BODY_BYTES } from '../../src/core/jev/systemone.ts';
import { CONTEXT_TOKENS, INGEST_BATTERY, LIMITS, SIZE_BYTES, Tev1Provider, chooseSize, estimateTokens, fits, localUrl, plan, unfence, type Battery } from '../../src/core/jev/tev1.ts';
import { boundToVerdict, readVerdicts, relianceFor, type VerdictFile } from '../../src/core/jev/verdict.ts';
import { BOUNDS } from '../../src/core/jev/eval.ts';
import { HEADROOM } from '../../src/core/models/recommend.ts';
import { MARK, startTev1StandIn } from '../support/tev1-stand-in.ts';
import { hubHardware } from '../support/models.ts';

const GiB = 1024 ** 3;

function template(def = SCREEN): Template {
  const t = validateTemplate(def);
  return { ...t, stats: { uses: 0, agreed: 0, disagreed: 0 }, state: 'active', dry_runs: [], activation_task_id: null, created_by: 'test', created_at: '', updated_at: '' };
}
const inputs = (content: string) => ({ source_kind: 'web', origin: 'www.example.org', content: fence(content) });
const contentOf = (state: unknown) => String((state as { content?: unknown }).content ?? '');
// The inside of a fenced piece, as the stand-in saw it.
const inner = (state: unknown) => unfence(contentOf(state)).inner;

async function provider(o: Parameters<typeof startTev1StandIn>[0] = {}, p: Partial<ConstructorParameters<typeof Tev1Provider>[0]> = {}) {
  const s = await startTev1StandIn(o);
  const tev1 = new Tev1Provider({ url: s.url, ...p });
  await tev1.refresh();
  return { s, tev1 };
}

// Long neutral text with no marker in it.
const prose = (n: number) => {
  const words = ['the', 'garden', 'club', 'met', 'on', 'saturday', 'and', 'planted', 'beans', 'along', 'north', 'fence'];
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${words[i % words.length]}${i % 17 === 16 ? '.\n' : ' '}`;
  return s.slice(0, n);
};

test('the wire format: one POST /v1/systemone with every question as a named noul, read strictly', async () => {
  const { s, tev1 } = await provider();
  try {
    const d = await tev1.decide(template(), inputs('Plant peas early.'));
    assert.equal(s.requests.length, 1, 'one battery is one request');
    const r = s.requests[0]!;
    assert.equal(r.model, 'tev1:4b');
    assert.deepEqual(Object.keys(r.questions), [...QUESTIONS]);
    for (const q of Object.values(r.questions)) {
      assert.equal(q.type, 'noul');
      assert.equal(typeof q.instructions, 'string');
    }
    assert.match(contentOf(r.state), /^BEGIN OUTSIDE DATA [0-9a-f]+\nPlant peas early\.\nEND OUTSIDE DATA [0-9a-f]+$/);
    assert.equal(d.provider, 'tev1');
    assert.equal(d.escalate, false);
    for (const q of QUESTIONS) assert.equal(d.answers[q], 0.03);
  } finally { await s.close(); }
});

test('an answer that isn’t a probability fails the call; nothing is repaired', async () => {
  const { s, tev1 } = await provider({ broken: 1 });
  try {
    await assert.rejects(tev1.decide(template(), inputs('hello')), /didn’t answer .* as a probability/);
  } finally { await s.close(); }
});

test('at most 64 questions per request: a 65-question battery is refused before anything is sent', async () => {
  const many = Array.from({ length: 65 }, (_, i) => `q${i}`);
  const def = { ...SCREEN, template_id: 'wide', questions: many.map((id) => ({ id, type: 'noul' as const })) };
  const battery: Battery = { ...INGEST_BATTERY, questions: Object.fromEntries(many.map((q) => [q, { type: 'noul' as const, instructions: `Is ${q} true?` }])) };
  const { s, tev1 } = await provider({}, { batteries: { wide: battery } });
  try {
    await assert.rejects(tev1.decide(template(def), inputs('x')), /at most 64/);
    assert.equal(s.requests.length, 0);
    // 64 is one request.
    const def64 = { ...def, template_id: 'wide64', questions: def.questions.slice(0, 64) };
    const b64 = { ...battery, questions: Object.fromEntries(many.slice(0, 64).map((q) => [q, battery.questions[q]!])) };
    const { s: s2, tev1: t2 } = await provider({}, { batteries: { wide64: b64 }, limits: { contextTokens: 20_000 } });
    try {
      await t2.decide(template(def64), inputs('x'));
      assert.equal(s2.requests.length, 1);
      assert.equal(Object.keys(s2.requests[0]!.questions).length, 64);
    } finally { await s2.close(); }
    // The client refuses on its own too.
    await assert.rejects(new SystemOne(s.url).ask('tev1:4b', 'x', Object.fromEntries(many.map((q) => [q, { type: 'noul' as const, instructions: q }]))), /at most 64 questions/);
  } finally { await s.close(); }
});

test('a payload only in the LAST chunk is caught: every chunk is screened and the worst score wins', async () => {
  const { s, tev1 } = await provider();
  try {
    const long = `${prose(2600)} ${MARK}`;
    const d = await tev1.decide(template(), inputs(long));
    assert.ok(s.requests.length >= 2, `split into ${s.requests.length} requests`);
    // Only the last request saw the marker, and it set every answer.
    const saw = s.requests.map((r) => inner(r.state).includes(MARK));
    assert.equal(saw.at(-1), true);
    assert.ok(saw.slice(0, -1).every((x) => !x), 'the marker is only in the last piece');
    for (const q of QUESTIONS) assert.equal(d.answers[q], 0.97);
  } finally { await s.close(); }
});

test('worst score per question: each question takes its own highest probability across the chunks', async () => {
  // Piece with "alpha" scores high on exfiltration only; piece with "omega" on impersonation only.
  const score = (content: string, q: string) => (content.includes('alpha') && q === 'exfiltration' ? 0.9 : content.includes('omega') && q === 'impersonation' ? 0.7 : 0.1);
  const { s, tev1 } = await provider({ score });
  try {
    const d = await tev1.decide(template(), inputs(`alpha ${prose(2800)} omega`));
    assert.ok(s.requests.length >= 2);
    assert.equal(d.answers.exfiltration, 0.9);
    assert.equal(d.answers.impersonation, 0.7);
    assert.equal(d.answers.direct_instruction, 0.1);
  } finally { await s.close(); }
});

// The budget for the ingest battery's content, in UTF-8 bytes of the state's JSON, at the default caps.
function capOf(model: string, l = LIMITS) {
  const ok = (n: number) => fits(model, INGEST_BATTERY, { source_kind: 'web', origin: 'www.example.org' }, fence('a'.repeat(n), '0123456789abcdef'), l);
  let n = 0;
  while (ok(n + 1)) n++;
  return n;
}

test('the token cap: content just under it is one request, just over it is two, and each fits', async () => {
  const cap = capOf('tev1:4b');
  assert.ok(cap > 1000 && cap < 4000, `about 2,000 tokens leaves ${cap} ASCII characters of content`);
  const { s, tev1 } = await provider();
  try {
    await tev1.decide(template(), inputs('a'.repeat(cap)));
    assert.equal(s.requests.length, 1, 'just under the cap: one request');
    s.requests.length = 0;
    await tev1.decide(template(), inputs('a'.repeat(cap + 1)));
    assert.equal(s.requests.length, 2, 'just over the cap: two requests');
    for (const r of s.requests) {
      const tokens = estimateTokens(JSON.stringify(r.state)) + estimateTokens(JSON.stringify(r.questions)) + 96 + 2;
      assert.ok(tokens <= CONTEXT_TOKENS, `${tokens} estimated tokens`);
    }
    // Together they cover every character.
    assert.equal(s.requests.map((r) => inner(r.state)).join('').length >= cap + 1, true);
  } finally { await s.close(); }
});

test('the 64 KiB cap: with a large context, content just over 64 KiB splits, each request is within it, and nothing is lost', async () => {
  const big = { contextTokens: 1_000_000 };
  const cap = capOf('tev1:4b', { ...LIMITS, ...big });
  // Multi-byte characters straddle the cut: no character may be broken.
  const text = `${'é'.repeat(Math.floor(cap / 2) - 3)}${'x'.repeat(8)}🌱🌱${MARK}`;
  const { s, tev1 } = await provider({}, { limits: big });
  try {
    const d = await tev1.decide(template(), inputs(text));
    assert.ok(s.requests.length >= 2, `${s.requests.length} requests`);
    for (const r of s.requests) assert.ok(r.bytes <= MAX_BODY_BYTES, `${r.bytes} bytes`);
    const pieces = s.requests.map((r) => inner(r.state));
    for (const p of pieces) assert.doesNotMatch(p, /�/, 'no broken character');
    // Coverage: every character is in some piece, in order (pieces overlap).
    let at = 0;
    for (const p of pieces) { const k = text.indexOf(p, Math.max(0, at - p.length)); assert.ok(k >= 0 && k <= at, 'pieces are contiguous runs that leave no gap'); at = Math.max(at, k + p.length); }
    assert.equal(at, text.length);
    assert.equal(d.answers.direct_instruction, 0.97, 'the marker at the very end is seen');
  } finally { await s.close(); }
  // Just under 64 KiB of body is one request.
  const { s: s2, tev1: t2 } = await provider({}, { limits: big });
  try {
    await t2.decide(template(), inputs('a'.repeat(cap)));
    assert.equal(s2.requests.length, 1);
    assert.ok(s2.requests[0]!.bytes <= MAX_BODY_BYTES && s2.requests[0]!.bytes > MAX_BODY_BYTES - 64);
  } finally { await s2.close(); }
});

test('the plan covers everything with overlapping pieces, prefers whitespace, and is never a prefix', () => {
  const text = prose(20_000);
  const ok = (p: string) => p.length <= 1000;
  const pieces = plan(text, ok);
  assert.equal(pieces[0]!.start, 0);
  assert.equal(pieces.at(-1)!.end, Array.from(text).length);
  for (let i = 1; i < pieces.length; i++) {
    assert.ok(pieces[i]!.start < pieces[i - 1]!.end, 'consecutive pieces overlap');
    assert.ok(pieces[i - 1]!.end - pieces[i]!.start <= 200);
  }
  assert.ok(pieces.slice(0, -1).every((p) => /\s$/.test(p.text)), 'cuts fall after whitespace');
  // A boundary-straddling phrase is whole in some piece.
  const phrase = 'CANARY PHRASE IN TWO HALVES';
  const t2 = `${'b '.repeat(495)}${phrase}${' c'.repeat(600)}`;
  assert.ok(plan(t2, ok).some((p) => p.text.includes(phrase)));
  // More pieces than allowed: refused, never decided on part.
  assert.throws(() => plan(prose(200_000), (p) => p.length <= 1000), TooLong);
});

test('a piece the model finds too long after all is split in half and both halves are screened', async () => {
  // The stand-in's own context is smaller than the provider's estimate allows: the questions and
  // about 900 bytes of state.
  const contextBytes = Buffer.byteLength(JSON.stringify({ questions: INGEST_BATTERY.questions })) + 900;
  const { s, tev1 } = await provider({ contextBytes });
  try {
    const d = await tev1.decide(template(), inputs(`${prose(2400)} ${MARK}`));
    assert.ok((tev1.last?.split_retries ?? 0) >= 1, 'it split');
    assert.equal(d.answers.direct_instruction, 0.97);
    assert.ok(s.requests.every((r) => Buffer.byteLength(JSON.stringify({ state: r.state, questions: r.questions })) <= contextBytes));
  } finally { await s.close(); }
});

test('version: below 0.35 and below 0.40.4 are unavailable in plain words; 0.40.4 is available', async () => {
  for (const [version, words] of [
    ['0.34.2', /This Ollama is version 0\.34\.2\. Decision models need Ollama 0\.35 or later, and Tev1’s published models need 0\.40\.4 or later; update Ollama to use Tev1\./],
    ['0.40.0', /This Ollama is version 0\.40\.0\. Tev1’s published models need Ollama 0\.40\.4 or later; update Ollama to use Tev1\./],
  ] as const) {
    const { s, tev1 } = await provider({ version });
    try {
      const st = tev1.status();
      assert.equal(st.available, false);
      assert.match(st.why, words);
      assert.equal(st.ollama, version);
      assert.equal(tev1.ready(template()), false, 'the decision stack doesn’t ask it');
      await assert.rejects(tev1.decide(template(), inputs('x')), Unavailable);
      assert.equal(s.requests.length, 0);
    } finally { await s.close(); }
  }
  const { s, tev1 } = await provider({ version: '0.40.4' });
  try { assert.equal(tev1.status().available, true); assert.equal(tev1.ready(template()), true); } finally { await s.close(); }
  assert.equal(older('0.40.0', '0.40.4'), true);
  assert.equal(older('0.41.0', '0.40.4'), false);
  assert.equal(older('v0.40.4-rc1', '0.40.4'), false);
});

test('unreachable, or the size not downloaded: unavailable in words, never a quiet switch to the small model', async () => {
  const gone = new Tev1Provider({ url: 'http://127.0.0.1:9' });
  assert.match((await gone.refresh()).why, /^Nova couldn’t reach Ollama at 127\.0\.0\.1:9/);
  const { s, tev1 } = await provider({ models: [{ name: 'tev1:0.8b', digest: 'sha256:bbbb08' }] }, { hardware: () => hubHardware() as never });
  try {
    const st = tev1.status();
    assert.equal(st.available, false);
    assert.equal(st.model, 'tev1:4b');
    assert.match(st.why, /Tev1 \(tev1:4b\) isn’t downloaded in Ollama at 127\.0\.0\.1:\d+\./);
  } finally { await s.close(); }
});

test('size: tev1:4b by default; tev1:0.8b only where the device can’t hold tev1:4b; the reason is said', () => {
  assert.equal(chooseSize(null).model, 'tev1:4b');
  assert.equal(chooseSize(hubHardware() as never).model, 'tev1:4b');
  const small = hubHardware({ gpus: [], ram_bytes: 8 * GiB }) as never;
  const c = chooseSize(small);
  assert.equal(c.model, 'tev1:0.8b');
  assert.match(c.why, /^Tev1 0\.8B: this device has 4 GB for models \(no GPU Nova can use.*\), and Tev1 4B needs about 4\.9 GB\.$/);
  assert.ok(SIZE_BYTES['tev1:4b'] * HEADROOM > 4 * GiB);
  const tiny = chooseSize(hubHardware({ gpus: [], ram_bytes: 1 * GiB }) as never);
  assert.equal(tiny.model, null);
  assert.match(tiny.why, /even Tev1 0\.8B needs about/);
});

test('the size in use is the one asked, and status says which and why (for the device record and Health)', async () => {
  const small = hubHardware({ gpus: [], ram_bytes: 8 * GiB });
  const { s, tev1 } = await provider({}, { hardware: () => small as never });
  try {
    const st = tev1.status();
    assert.equal(st.model, 'tev1:0.8b');
    assert.equal(st.digest, 'sha256:bbbb08');
    assert.match(st.size_why, /^Tev1 0\.8B: /);
    await tev1.decide(template(), inputs('x'));
    assert.equal(s.requests[0]!.model, 'tev1:0.8b');
  } finally { await s.close(); }
});

test('local only: an Ollama address that could be the internet is refused; egress is local', () => {
  assert.equal(localUrl('http://127.0.0.1:11434'), true);
  assert.equal(localUrl('http://localhost:11434'), true);
  assert.equal(localUrl('http://192.168.1.20:11434'), true);
  assert.equal(localUrl('https://ollama.com'), false);
  assert.equal(localUrl('http://203.0.114.1:11434'), false);
  assert.throws(() => new Tev1Provider({ url: 'https://ollama.com' }), /could be anywhere/);
  assert.equal(new Tev1Provider({ url: 'http://127.0.0.1:11434' }).egress, 'local');
  // The Jev stub stays the cloud seat and still refuses.
  assert.equal(new JevProvider().egress, 'remote');
});

const verdicts = (status: 'pass' | 'fail' | 'not-run', digest: string | null): VerdictFile => ({
  bounds: { ...BOUNDS }, bounds_commit: '0'.repeat(40), cases_sha256: 'x',
  sizes: {
    'tev1:4b': { status, why: status, digest, run_at: '2026-10-31T00:00:00.000Z', ollama: '0.40.4', metrics: null },
    'tev1:0.8b': { status: 'not-run', why: 'not run', digest: null, run_at: null, ollama: null, metrics: null },
  },
});

test('reliance follows the recorded verdict only: pass with the same digest and bounds, else advisory with the reason', () => {
  assert.equal(relianceFor(verdicts('pass', 'sha256:aaaa4b'), 'tev1:4b', 'sha256:aaaa4b').relied, true);
  assert.match(relianceFor(verdicts('pass', 'sha256:other'), 'tev1:4b', 'sha256:aaaa4b').why, /isn’t the build the eval passed/);
  assert.match(relianceFor(verdicts('fail', 'sha256:aaaa4b'), 'tev1:4b', 'sha256:aaaa4b').why, /didn’t pass the injection eval/);
  assert.match(relianceFor(verdicts('not-run', null), 'tev1:4b', 'sha256:aaaa4b').why, /hasn’t been run on tev1:4b yet/);
  assert.equal(relianceFor(verdicts('pass', 'sha256:aaaa4b'), 'tev1:0.8b', 'sha256:bbbb08').relied, false);
  const looser = { ...verdicts('pass', 'sha256:aaaa4b'), bounds: { ...BOUNDS, detection_min: 0.5 } };
  assert.match(relianceFor(looser, 'tev1:4b', 'sha256:aaaa4b').why, /other bounds/);
  assert.equal(relianceFor(null, 'tev1:4b', 'sha256:aaaa4b').relied, false);
});

test('the committed verdicts: both sizes advisory (not yet run), against the bounds in eval.ts', () => {
  const v = readVerdicts();
  assert.deepEqual(v.bounds, { ...BOUNDS });
  for (const size of ['tev1:4b', 'tev1:0.8b'] as const) {
    const r = relianceFor(v, size, 'sha256:anything');
    if (v.sizes[size].status !== 'pass') assert.equal(r.relied, false);
  }
});

// The real gate, with Tev1 registered as production would (bound to its verdict).
function gate(tev1: Tev1Provider, v: VerdictFile) {
  const db = new Db(':memory:');
  db.migrate();
  const home = mkdtempSync(join(tmpdir(), 'nova-tev1-'));
  const logFile = join(home, 'logs', 'nova.log');
  const log = new Log(db, logFile);
  const verifier = new Verifier(new Workspace(join(home, 'workspace')));
  const rules = new RulesProvider();
  const templates = new Templates({ db, verifier, rules });
  const decisions = new Decisions({ templates, providers: [rules], privacy: () => 'local-only', log });
  const bound = boundToVerdict(tev1, { verdicts: () => v, log });
  decisions.register(bound, { first: true });
  const ingest = new Ingest({ db, log, templates, decisions, ready: () => bound.readyFor(SCREEN.template_id), providerId: 'tev1' });
  return { ingest, logFile, bound };
}

test('through the real gate, relied on: Tev1’s worst-chunk scores drive the thresholds, a payload in the last chunk blocks', async () => {
  const { s, tev1 } = await provider();
  try {
    const { ingest, bound } = gate(tev1, verdicts('pass', 'sha256:aaaa4b'));
    assert.equal(bound.status().reliance.relied, true);
    const clean = await ingest.screen({ text: prose(500), source: { kind: 'web', origin: 'www.example.org' } });
    assert.equal(clean.verdict, 'pass');
    assert.equal(clean.model, 'tev1');
    // Neutral prose past several of the gate's chunks, the marker only at the very end.
    const r = await ingest.screen({ text: `${prose(CHUNK * 3 + 500)} ${MARK}`, source: { kind: 'web', origin: 'www.example.org' } });
    assert.equal(r.verdict, 'block');
    assert.equal(r.scores?.direct_instruction, 0.97);
    assert.ok(s.requests.length >= 4);
  } finally { await s.close(); }
});

test('through the real gate, advisory: Tev1 answers, its scores are logged, and the deterministic layer plus quarantine decide', async () => {
  const { s, tev1 } = await provider();
  try {
    const { ingest, logFile, bound } = gate(tev1, verdicts('not-run', null));
    assert.equal(bound.status().reliance.relied, false);
    const clean = await ingest.screen({ text: prose(500), source: { kind: 'web', origin: 'www.example.org' } });
    assert.equal(clean.verdict, 'quarantine', 'nothing passes on an advisory model’s say-so');
    assert.equal(clean.scores, null);
    assert.equal(clean.model, null);
    assert.ok(s.requests.length >= 1, 'Tev1 was asked');
    const logged = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.includes('Tev1 answered as advisory'));
    assert.ok(logged.length >= 1);
    assert.match(logged[0]!, /"scores":\{"direct_instruction":0\.03/);
    assert.doesNotMatch(logged.join('\n'), /garden/, 'scores, never content');
  } finally { await s.close(); }
});

test('the Ollama address is read as it is now, and checked again: one that changes to the internet is refused', async () => {
  const s = await startTev1StandIn();
  try {
    let url = s.url;
    const small = hubHardware({ gpus: [], ram_bytes: 8 * GiB });
    const tev1 = new Tev1Provider({ url: () => url, hardware: async () => small as never });
    assert.equal((await tev1.refresh()).model, 'tev1:0.8b', 'async hardware is read');
    assert.equal(tev1.readyFor(SCREEN.template_id), true);
    assert.equal(tev1.readyFor('browser-step'), false, 'no battery, not asked');
    url = 'https://ollama.example.com';
    const st = await tev1.refresh();
    assert.equal(st.available, false);
    assert.match(st.why, /could be anywhere/);
  } finally { await s.close(); }
});
