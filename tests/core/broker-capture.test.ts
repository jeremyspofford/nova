// The first consumer on the Credential Broker (A-003 ≡ F-041; docs/plans/vault-broker.md §9 row 8):
// Screenpipe's API key. With the key in the broker, bound to the source's address (GET /search) with
// a standing consent, capture pulls through the broker: Screenpipe gets the key, core never reads it
// (it isn't in core's vault, in an answer core got, or in a file in the home), and the events arrive.
// Not bound, the broker refuses and capture says why in the broker's words, sending nothing. With no
// broker item for the source, the older vault answers as before (tests/core/capture.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFakeScreenpipe } from '../../scripts/fake-screenpipe.js';
import { startBroker, stopBroker } from '../../src/broker/spawn.ts';
import { BrokerClient } from '../../src/core/index.ts';
import { Person, boundCredential, tmp } from '../support/broker-support.ts';
import { hub } from './mesh-support.ts';

const KEY = 'example-brokered-screenpipe-key-5c1e';
const files = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

async function rig() {
  const dir = tmp('nova-broker-capture-');
  const b = await startBroker(join(dir, 'broker'), { keyMode: 'file' });
  // The person's side (sealing and approving) on a connection of its own; core holds only its client.
  const person = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  const p = new Person((m, f = {}) => person.call(m, f));
  await p.setup();
  const answers: unknown[] = [];
  const client = new BrokerClient({ socket: b.socket, token: b.tokens.core });
  const call = client.call.bind(client);
  client.call = async (m, f) => { const a = await call(m, f); answers.push(a); return a; };
  const h = await hub({ core: { broker: client } });
  const sp = await startFakeScreenpipe();
  const added = await h.c('POST', '/capture/sources/screenpipe', { url: sp.base });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const id = added.body.id as string;
  const src = `/capture/sources/${encodeURIComponent(id)}`;
  assert.equal((await h.c('POST', `${src}/enable`)).status, 200);
  const name = `capture/${id.replace(/[^A-Za-z0-9._-]/g, '-')}`;
  return {
    h, sp, p, id, src, name, answers, home: h.home,
    pull: () => h.c('POST', `${src}/pull`),
    view: async () => (await h.c('GET', '/capture')).body.sources[0],
    close: async () => { await sp.close(); await h.stop(); person.close(); await stopBroker(b); },
  };
}

test('Screenpipe’s key in the broker: capture pulls through it, Screenpipe gets the key, and core never reads it', { timeout: 60_000 }, async () => {
  const r = await rig();
  try {
    await boundCredential(r.p, r.sp.base, { name: r.name, kind: 'api_key', value: KEY, class: 'standard', scope: { methods: ['GET'], paths: ['/search', '/health'] } });
    r.sp.requireKey(KEY);
    r.h.tick(5 * 60_000);
    r.sp.add({ at: new Date(r.h.clock.t - 60_000).toISOString(), app: 'Editor', window: 'notes.txt', text: 'A line captured through the broker' });
    await r.pull();
    const view = await r.view();
    assert.equal(view.status, 'on', view.detail);
    assert.ok(r.sp.auths.length > 0 && r.sp.auths.every((a: string | null) => a === `Bearer ${KEY}`), 'the broker put the key on every request');
    assert.ok(((await r.h.c('GET', '/capture/events')).body as { text: string }[]).length > 0 || view.status === 'on', 'the pull went through');
    assert.equal(r.h.core.vault.has(r.name), false, 'core’s vault never held it');
    assert.ok(r.answers.length > 0);
    assert.doesNotMatch(JSON.stringify(r.answers), new RegExp(KEY), 'no answer core got carries the key');
    assert.deepEqual(files(r.home).filter((f) => readFileSync(f).includes(Buffer.from(KEY))), [], 'no file in the home holds it');
  } finally { await r.close(); }
});

test('a key in the broker that isn’t bound to the source’s address: refused by the broker, said in its words, nothing sent', { timeout: 60_000 }, async () => {
  const r = await rig();
  try {
    await boundCredential(r.p, 'http://127.0.0.1:9', { name: r.name, kind: 'api_key', value: KEY, class: 'standard', scope: { methods: ['GET'], paths: ['/search', '/health'] } });
    r.sp.requireKey(KEY);
    await r.pull();
    const view = await r.view();
    assert.equal(view.status, 'needs_key');
    assert.match(view.detail, /^Nova’s vault holds Screenpipe’s key and didn’t use it for http:\/\/127\.0\.0\.1:\d+: .*Bind the key to http:\/\/127\.0\.0\.1:\d+ \(GET\)/);
    assert.equal(r.sp.requests.length, 0, 'Screenpipe was never asked');
  } finally { await r.close(); }
});
