// An answer cut off mid-way (a page left, a dropped connection) is no answer: the page keeps what
// it had rather than taking `null` for tasks or requests and crashing on it. Browser storage is
// stood in for by small fakes. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { assign() {} };
let reply = null;
globalThis.fetch = async () => reply();

const core = await import('../ui/js/core.js');
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

test('every request sends the same headers', async () => {
  let sent = null;
  globalThis.fetch = async (url, init) => { sent = init; return new Response('{}', { headers: { 'content-type': 'application/json' } }); };
  try {
    await core.request('POST', '/example', {});
    assert.equal(sent.headers['x-nova'], '1');
    assert.equal(sent.headers['content-type'], 'application/json');
  } finally { globalThis.fetch = async () => reply(); }
});
