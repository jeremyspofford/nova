// The Tev1 seat of the Decision Service (moved from Part 1's Tev1Provider; ADR §2, §9), against a
// stand-in of Ollama's /v1/systemone on loopback (CI has no Ollama). Part 1's plumbing, carried
// over: one request per battery, at most 64 questions, every chunk screened with the worst score
// winning, both caps, split-and-retry, the version check and its words, size, local addresses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fence, QUESTIONS } from '../../src/core/ingest/screen.ts';
import { SystemOne, TooLong, Unavailable, older, MAX_BODY_BYTES, wireQuestions } from '../../src/core/decision-service/wire.ts';
import { estimateTokens, plan } from '../../src/core/decision-service/chunk.ts';
import { CONTEXT_TOKENS, LIMITS, SIZE_BYTES, Tev1Seat, chooseSize, fits, localUrl } from '../../src/core/decision-service/seats/tev1.ts';
import { buildState } from '../../src/core/decision-service/state.ts';
import { INGEST_SCREEN_V1, unfence } from '../../src/core/decision-service/templates/ingest-screen.ts';
import { readVerdicts, relianceFor, type VerdictFile } from '../../src/core/decision-service/verdicts.ts';
import { BOUNDS } from '../../src/core/decision-service/eval.ts';
import { HEADROOM } from '../../src/core/models/recommend.ts';
import { MARK, startTev1StandIn } from '../support/tev1-stand-in.ts';
import { hubHardware } from '../support/models.ts';
import type { Answer, ServiceTemplate } from '../../src/core/decision-service/types.ts';

const GiB = 1024 ** 3;
const T = INGEST_SCREEN_V1;
const built = (content: string, t: ServiceTemplate = T) => buildState(t, { source_kind: 'web', origin: 'www.example.org', content: fence(content) });
const contentOf = (state: unknown) => String((state as { content?: unknown }).content ?? '');
const inner = (state: unknown) => unfence(contentOf(state)).inner;
const noul = (a: Record<string, Answer>, q: string) => { const x = a[q]; return x?.type === 'noul' ? x.noul : Number.NaN; };

async function seat(o: Parameters<typeof startTev1StandIn>[0] = {}, p: Partial<ConstructorParameters<typeof Tev1Seat>[0]> = {}) {
  const s = await startTev1StandIn(o);
  const tev1 = new Tev1Seat({ url: s.url, ...p });
  await tev1.refresh();
  return { s, tev1 };
}

const prose = (n: number) => {
  const words = ['the', 'garden', 'club', 'met', 'on', 'saturday', 'and', 'planted', 'beans', 'along', 'north', 'fence'];
  let s = '';
  for (let i = 0; s.length < n; i++) s += `${words[i % words.length]}${i % 17 === 16 ? '.\n' : ' '}`;
  return s.slice(0, n);
};

test('the wire format: one POST /v1/systemone with every question as a named noul, read strictly', async () => {
  const { s, tev1 } = await seat();
  try {
    const a = await tev1.ask(T, built('Plant peas early.'));
    assert.equal(s.requests.length, 1, 'one battery is one request');
    const r = s.requests[0]!;
    assert.equal(r.model, 'tev1:4b');
    assert.deepEqual(Object.keys(r.questions), [...QUESTIONS]);
    for (const q of Object.values(r.questions)) { assert.equal(q.type, 'noul'); assert.equal(typeof q.instructions, 'string'); }
    assert.deepEqual(r.state, { source: 'web from www.example.org', content: contentOf(r.state) }, 'Part 1’s exact state shape');
    assert.match(contentOf(r.state), /^BEGIN OUTSIDE DATA [0-9a-f]+\nPlant peas early\.\nEND OUTSIDE DATA [0-9a-f]+$/);
    assert.equal(a.model_answered, 'tev1:4b');
    for (const q of QUESTIONS) assert.equal(noul(a.answers, q), 0.03);
    assert.deepEqual(r.questions, wireQuestions(T.questions), 'the registry’s v1 wording, unchanged from Part 1');
  } finally { await s.close(); }
});

test('an answer that isn’t a probability fails the call; nothing is repaired', async () => {
  const { s, tev1 } = await seat({ broken: 1 });
  try { await assert.rejects(tev1.ask(T, built('hello')), /didn’t answer .* in the question’s own type/); } finally { await s.close(); }
});

test('at most 64 questions per request: 65 are refused before anything is sent; 64 is one request', async () => {
  const many = Array.from({ length: 65 }, (_, i) => `q${i}`);
  const wide = (n: number): ServiceTemplate => ({ ...T, template_id: `wide${n}`, questions: Object.fromEntries(many.slice(0, n).map((q) => [q, { type: 'noul' as const, instructions: `Is ${q} true of \`content\`?` }])) });
  const { s, tev1 } = await seat({}, { limits: { contextTokens: 20_000 } });
  try {
    await assert.rejects(tev1.ask(wide(65), built('x', wide(65))), /at most 64/);
    assert.equal(s.requests.length, 0);
    await tev1.ask(wide(64), built('x', wide(64)));
    assert.equal(s.requests.length, 1);
    assert.equal(Object.keys(s.requests[0]!.questions).length, 64);
    await assert.rejects(new SystemOne(s.url).ask('tev1:4b', 'x', wide(65).questions), /at most 64 questions/);
  } finally { await s.close(); }
});

test('a payload only in the LAST chunk is caught: every chunk is screened and the worst score wins', async () => {
  const { s, tev1 } = await seat();
  try {
    const a = await tev1.ask(T, built(`${prose(2600)} ${MARK}`));
    assert.ok(s.requests.length >= 2, `split into ${s.requests.length} requests`);
    const saw = s.requests.map((r) => inner(r.state).includes(MARK));
    assert.equal(saw.at(-1), true);
    assert.ok(saw.slice(0, -1).every((x) => !x), 'the marker is only in the last piece');
    for (const q of QUESTIONS) assert.equal(noul(a.answers, q), 0.97);
  } finally { await s.close(); }
});

test('worst score per question: each question takes its own highest probability across the chunks', async () => {
  const score = (content: string, q: string) => (content.includes('alpha') && q === 'exfiltration' ? 0.9 : content.includes('omega') && q === 'impersonation' ? 0.7 : 0.1);
  const { s, tev1 } = await seat({ score });
  try {
    const a = await tev1.ask(T, built(`alpha ${prose(2800)} omega`));
    assert.ok(s.requests.length >= 2);
    assert.equal(noul(a.answers, 'exfiltration'), 0.9);
    assert.equal(noul(a.answers, 'impersonation'), 0.7);
    assert.equal(noul(a.answers, 'direct_instruction'), 0.1);
  } finally { await s.close(); }
});

// The largest content (ASCII) that fits one request at these caps.
function capOf(l = LIMITS) {
  const wq = wireQuestions(T.questions);
  const ok = (n: number) => fits('tev1:4b', { source: 'web from www.example.org', content: fence('a'.repeat(n), '0123456789abcdef') }, wq, l);
  let lo = 0, hi = 200_000;
  while (lo < hi) { const mid = Math.floor((lo + hi + 1) / 2); if (ok(mid)) lo = mid; else hi = mid - 1; }
  return lo;
}

test('the token cap: content just under it is one request, just over it is two, and each fits', async () => {
  const cap = capOf();
  assert.ok(cap > 1000 && cap < 4000, `about 2,000 tokens leaves ${cap} ASCII characters of content`);
  const { s, tev1 } = await seat();
  try {
    await tev1.ask(T, built('a'.repeat(cap)));
    assert.equal(s.requests.length, 1, 'just under the cap: one request');
    s.requests.length = 0;
    await tev1.ask(T, built('a'.repeat(cap + 1)));
    assert.equal(s.requests.length, 2, 'just over the cap: two requests');
    for (const r of s.requests) assert.ok(estimateTokens(JSON.stringify(r.state)) + estimateTokens(JSON.stringify(r.questions)) + 98 <= CONTEXT_TOKENS);
  } finally { await s.close(); }
});

test('the 64 KiB cap: with a large context, content just over it splits, each request within it, nothing lost', async () => {
  const big = { contextTokens: 1_000_000 };
  const cap = capOf({ ...LIMITS, ...big });
  // A 64 KiB template field cap for this test only: the ingest template caps content at 4,000.
  const roomy: ServiceTemplate = { ...T, template_id: 'roomy', fields: { ...T.fields, content: { type: 'text', max_chars: 200_000, chunk: 'worst' } } };
  const text = `${'é'.repeat(Math.floor(cap / 2) - 3)}${'x'.repeat(8)}🌱🌱${MARK}`;
  const { s, tev1 } = await seat({}, { limits: big });
  try {
    const a = await tev1.ask(roomy, built(text, roomy));
    assert.ok(s.requests.length >= 2, `${s.requests.length} requests`);
    for (const r of s.requests) assert.ok(r.bytes <= MAX_BODY_BYTES, `${r.bytes} bytes`);
    const pieces = s.requests.map((r) => inner(r.state));
    for (const p of pieces) assert.doesNotMatch(p, /�/, 'no broken character');
    let at = 0;
    for (const p of pieces) { const k = text.indexOf(p, Math.max(0, at - p.length)); assert.ok(k >= 0 && k <= at, 'contiguous runs, no gap'); at = Math.max(at, k + p.length); }
    assert.equal(at, text.length);
    assert.equal(noul(a.answers, 'direct_instruction'), 0.97, 'the marker at the very end is seen');
  } finally { await s.close(); }
});

test('the plan covers everything with overlapping pieces, prefers whitespace, and is never a prefix', () => {
  const text = prose(20_000);
  const ok = (p: string) => p.length <= 1000;
  const pieces = plan(text, ok);
  assert.equal(pieces[0]!.start, 0);
  assert.equal(pieces.at(-1)!.end, Array.from(text).length);
  for (let i = 1; i < pieces.length; i++) { assert.ok(pieces[i]!.start < pieces[i - 1]!.end); assert.ok(pieces[i - 1]!.end - pieces[i]!.start <= 200); }
  assert.ok(pieces.slice(0, -1).every((p) => /\s$/.test(p.text)));
  const phrase = 'CANARY PHRASE IN TWO HALVES';
  assert.ok(plan(`${'b '.repeat(495)}${phrase}${' c'.repeat(600)}`, ok).some((p) => p.text.includes(phrase)));
  assert.throws(() => plan(prose(200_000), ok), TooLong);
});

test('a piece the model finds too long after all is split in half and both halves are screened', async () => {
  const contextBytes = Buffer.byteLength(JSON.stringify({ questions: wireQuestions(T.questions) })) + 900;
  const { s, tev1 } = await seat({ contextBytes });
  try {
    const b = built(`${prose(2400)} ${MARK}`);
    const wq = wireQuestions(T.questions);
    const { inner: whole, wrap } = unfence(contentOf(b.state));
    const planned = plan(whole, (p) => fits('tev1:4b', { ...b.state, content: wrap(p) }, wq)).length;
    const a = await tev1.ask(T, b);
    assert.ok(a.requests > planned, `it split: ${planned} pieces planned, ${a.requests} requests made`);
    assert.equal(noul(a.answers, 'direct_instruction'), 0.97);
    assert.ok(s.requests.every((r) => Buffer.byteLength(JSON.stringify({ state: r.state, questions: r.questions })) <= contextBytes));
  } finally { await s.close(); }
});

test('version: below 0.35 and below 0.40.4 are unavailable in plain words; 0.40.4 is available', async () => {
  for (const [version, words] of [
    ['0.34.2', /This Ollama is version 0\.34\.2\. Decision models need Ollama 0\.35 or later, and Tev1’s published models need 0\.40\.4 or later; update Ollama to use Tev1\./],
    ['0.40.0', /This Ollama is version 0\.40\.0\. Tev1’s published models need Ollama 0\.40\.4 or later; update Ollama to use Tev1\./],
  ] as const) {
    const { s, tev1 } = await seat({ version });
    try {
      const st = tev1.status();
      assert.equal(st.available, false);
      assert.match(st.why, words);
      assert.equal(tev1.detail().ollama, version);
      await assert.rejects(tev1.ask(T, built('x')), Unavailable);
      assert.equal(s.requests.length, 0);
    } finally { await s.close(); }
  }
  const { s, tev1 } = await seat({ version: '0.40.4' });
  try { assert.equal(tev1.status().available, true); assert.equal(tev1.status().model, 'tev1:4b@aaaa4b'); } finally { await s.close(); }
  assert.equal(older('0.40.0', '0.40.4'), true);
  assert.equal(older('0.41.0', '0.40.4'), false);
  assert.equal(older('v0.40.4-rc1', '0.40.4'), false);
});

test('unreachable, or the size not downloaded: unavailable in words, never a quiet switch to the small model', async () => {
  const gone = new Tev1Seat({ url: 'http://127.0.0.1:9' });
  assert.match((await gone.refresh()).why, /^Nova couldn’t reach 127\.0\.0\.1:9/);
  const { s, tev1 } = await seat({ models: [{ name: 'tev1:0.8b', digest: 'sha256:bbbb08' }] }, { hardware: () => hubHardware() as never });
  try {
    assert.equal(tev1.status().available, false);
    assert.equal(tev1.detail().model, 'tev1:4b');
    assert.match(tev1.status().why, /Tev1 \(tev1:4b\) isn’t downloaded in Ollama at 127\.0\.0\.1:\d+\./);
  } finally { await s.close(); }
});

test('size: tev1:4b by default; tev1:0.8b only where the device can’t hold tev1:4b; the person’s choice wins', async () => {
  assert.equal(chooseSize(null).model, 'tev1:4b');
  assert.equal(chooseSize(hubHardware() as never).model, 'tev1:4b');
  const small = hubHardware({ gpus: [], ram_bytes: 8 * GiB }) as never;
  assert.equal(chooseSize(small).model, 'tev1:0.8b');
  assert.match(chooseSize(small).why, /and Tev1 4B needs about 4\.9 GB\.$/);
  assert.ok(SIZE_BYTES['tev1:4b'] * HEADROOM > 4 * GiB);
  assert.equal(chooseSize(hubHardware({ gpus: [], ram_bytes: 1 * GiB }) as never).model, null);
  let choice: 'auto' | 'tev1:0.8b' = 'auto';
  const { s, tev1 } = await seat({}, { hardware: async () => hubHardware() as never, model: () => choice });
  try {
    assert.equal(tev1.detail().model, 'tev1:4b');
    choice = 'tev1:0.8b';
    await tev1.refresh();
    assert.equal(tev1.status().model, 'tev1:0.8b@bbbb08');
    assert.match(tev1.detail().size_why, /chosen in Settings › Models/);
    await tev1.ask(T, built('x'));
    assert.equal(s.requests[0]!.model, 'tev1:0.8b');
  } finally { await s.close(); }
});

test('local only: an Ollama address that could be the internet is refused, also when it changes later', async () => {
  assert.equal(localUrl('http://127.0.0.1:11434'), true);
  assert.equal(localUrl('http://localhost:11434'), true);
  assert.equal(localUrl('http://192.168.1.20:11434'), true);
  assert.equal(localUrl('https://ollama.com'), false);
  assert.throws(() => new Tev1Seat({ url: 'https://ollama.com' }), /could be anywhere/);
  assert.equal(new Tev1Seat({ url: 'http://127.0.0.1:11434' }).egress, 'local');
  const s = await startTev1StandIn();
  try {
    let url = s.url;
    const tev1 = new Tev1Seat({ url: () => url });
    assert.equal((await tev1.refresh()).available, true);
    url = 'https://ollama.example.com';
    const st = await tev1.refresh();
    assert.equal(st.available, false);
    assert.match(st.why, /could be anywhere/);
  } finally { await s.close(); }
});

const verdicts = (status: 'pass' | 'fail' | 'not-run', digest: string | null): VerdictFile => ({
  bounds: { ...BOUNDS }, bounds_commit: '0'.repeat(40), cases_sha256: 'x',
  sizes: {
    'tev1:4b': { status, why: status, digest, run_at: '2026-10-31T00:00:00.000Z', ollama: '0.40.4', metrics: null },
    'tev1:0.8b': { status: 'not-run', why: 'not run', digest: null, run_at: null, ollama: null, metrics: null },
  },
});

test('Part 1’s rule: relied on only with a pass on the same digest and bounds, else advisory with the reason', () => {
  assert.equal(relianceFor(verdicts('pass', 'aaaa4b'), 'tev1:4b', 'aaaa4b').relied, true);
  assert.match(relianceFor(verdicts('pass', 'other'), 'tev1:4b', 'aaaa4b').why, /isn’t the build the eval passed/);
  assert.match(relianceFor(verdicts('fail', 'aaaa4b'), 'tev1:4b', 'aaaa4b').why, /didn’t pass the injection eval/);
  assert.match(relianceFor(verdicts('not-run', null), 'tev1:4b', 'aaaa4b').why, /hasn’t been run on tev1:4b yet/);
  assert.match(relianceFor({ ...verdicts('pass', 'aaaa4b'), bounds: { ...BOUNDS, detection_min: 0.5 } }, 'tev1:4b', 'aaaa4b').why, /other bounds/);
});

test('the committed verdicts: both sizes failed on their digests, so neither is relied on', () => {
  const v = readVerdicts();
  assert.deepEqual(v.bounds, { ...BOUNDS });
  for (const size of ['tev1:4b', 'tev1:0.8b'] as const) {
    assert.equal(v.sizes[size].status, 'fail');
    assert.equal(relianceFor(v, size, v.sizes[size].digest).relied, false);
  }
});
