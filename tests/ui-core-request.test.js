// An answer cut off mid-way (a page left, a dropped connection) is no answer: the page keeps what
// it had rather than taking `null` for tasks or requests and crashing on it. Browser storage is
// stood in for by small fakes. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { assign() {} };
let reply = null;
globalThis.fetch = async (...a) => reply(...a);

const core = await import('../ui/js/core.js');
const wait = await import('../ui/js/wait.js');
const json = (body, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'application/json' } });

test('a JSON answer cut off part-way is no answer, never null data', async () => {
  reply = json('[{"id":"example-task","sta');
  await assert.rejects(core.request('GET', '/mesh/requests'), core.Unreachable);
});

test('a whole JSON answer still comes through, including a plain null', async () => {
  reply = json('[{"id":"example-task"}]');
  assert.deepEqual((await core.request('GET', '/tasks')).data, [{ id: 'example-task' }]);
  reply = json('null');
  assert.equal((await core.request('GET', '/example')).data, null);
});

test('an error answer that is cut off still fails with its status', async () => {
  reply = json('{"error":"Not fo', 404);
  await assert.rejects(core.request('GET', '/example'), (e) => e.status === 404);
});

// The page's one HTTP client (core.js reach): app.js's post and getJson go through it too.
test('no answer at all is Unreachable, in the caller’s words; an error answer keeps its status', async () => {
  reply = () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(core.request('GET', '/example'), (e) => e instanceof core.Unreachable && e.message === 'Nova’s server didn’t answer.');
  await assert.rejects(core.reach('/api/example', {}, "Nova's server didn't answer."), (e) => e instanceof core.Unreachable && e.message === "Nova's server didn't answer.");
  reply = json('{"error":"Example refused."}', 409);
  const res = await core.reach('/api/example');
  const e = core.refused(res, await res.json());
  assert.equal(e.message, 'Example refused.');
  assert.equal(e.status, 409);
  assert.equal(core.refused({ status: 500 }, {}).message, 'Something went wrong.');
});

// The no-answer deadline and the progress bands (DESIGN-SYSTEM §1 "Progress and waiting"): a read
// that is slow shows its over-10 s words before the page gives it up as no answer. The words are
// written by wait.js's clock, once a tick, so they reach the screen by LONG_MS + TICK_MS at the
// latest; the deadline comes after that, and a person sees them for at least a tick.
test('a read is given up as no answer only after the over-10 s band’s words have been on screen', () => {
  assert.equal(core.NO_ANSWER_MS, wait.NO_ANSWER_MS, 'one deadline, kept beside the bands in wait.js');
  assert.ok(wait.TICK_MS > 0, 'the clock that writes long waits’ words has a period');
  const shown = wait.NO_ANSWER_MS - (wait.LONG_MS + wait.TICK_MS);
  assert.ok(shown >= wait.TICK_MS, `the over-10 s words are on screen for at least one tick before the deadline (${shown} ms)`);
  // Just before the deadline the wait is in the last band and has its words.
  assert.equal(wait.band(wait.NO_ANSWER_MS - 1), 'progress');
  assert.match(wait.longWords({ elapsed: wait.NO_ANSWER_MS - 1, usual: 'under a second' }), /s so far · it usually takes under a second$/);
});

// The deadline runs on the page's own timers (as wait.js's clock does), so a fake clock moves it
// and a real one keeps it honest. A hub that takes the read and never answers is still found out.
test('a read with no answer is Unreachable at NO_ANSWER_MS on the page’s timers, not before; a change waits for its answer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = () => new Promise((r) => setImmediate(r));
  const signals = [];
  // A hub that takes the request and never answers: only an abort ends it, as for a real fetch.
  reply = (_url, init) => new Promise((_ok, no) => {
    signals.push(init?.signal);
    init?.signal?.addEventListener('abort', () => no(init.signal.reason));
  });
  let read = null;
  core.request('GET', '/example').then(() => { read = 'answered'; }, (e) => { read = e; });
  let change = null;
  core.request('POST', '/example', {}).then(() => { change = 'answered'; }, (e) => { change = e; });
  await flush();
  assert.equal(signals.length, 2, 'both were sent');
  assert.equal(signals[1], undefined, 'a change carries no deadline');
  t.mock.timers.tick(core.NO_ANSWER_MS - 1);
  await flush();
  assert.equal(read, null, 'not given up before the deadline');
  t.mock.timers.tick(1);
  await flush();
  assert.ok(read instanceof core.Unreachable, `given up at the deadline, on the page’s clock (${read})`);
  assert.equal(read.message, 'Nova’s server didn’t answer.');
  t.mock.timers.tick(core.NO_ANSWER_MS * 10);
  await flush();
  assert.equal(change, null, 'a change still waits for its answer');

  // A read that is answered ends its deadline: nothing aborts it (or a later read of its body) afterwards.
  reply = (_url, init) => { signals.push(init?.signal); return json('{"ok":true}')(); };
  assert.deepEqual((await core.request('GET', '/example')).data, { ok: true });
  t.mock.timers.tick(core.NO_ANSWER_MS * 2);
  assert.equal(signals.at(-1).aborted, false, 'the answered read’s deadline was cleared');
});

test('every request sends the same headers', async () => {
  let sent = null;
  globalThis.fetch = async (url, init) => { sent = init; return new Response('{}', { headers: { 'content-type': 'application/json' } }); };
  try {
    await core.request('POST', '/example', {});
    assert.equal(sent.headers['x-nova'], '1');
    assert.equal(sent.headers['content-type'], 'application/json');
  } finally { globalThis.fetch = async () => reply(); }
});
