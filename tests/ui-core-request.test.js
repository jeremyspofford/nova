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
