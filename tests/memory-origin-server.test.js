// F-038 end to end: GET /api/memory (the route the Memory view already reads) carries each record's
// review state, the names of the devices its rows mention, and capture's promotion counts; the core's
// existing confirm route clears "Not yet checked". No new route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNova } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const root = new URL('..', import.meta.url).pathname;
let nova;
let base;
before(async () => {
  nova = createNova(loadConfig({ NOVA_HOME: mkdtempSync(join(tmpdir(), 'nova-origin-')), NOVA_AGENT_CMD: `node ${join(root, 'scripts/fake-agent.js')}`, NOVA_AGENT_EGRESS: 'none' }));
  await new Promise((r) => nova.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${nova.server.address().port}`;
});
after(() => nova.server.close());

const read = async () => (await fetch(`${base}/api/memory`)).json();
const find = (m, id) => m.sections.flatMap((s) => s.entries).find((e) => e.id === id);

test('the Memory view’s data: review state, device names from the registry, capture counts', async () => {
  const hub = nova.core.mesh.devices.list().find((d) => d.role === 'hub');
  assert.ok(hub?.name, 'the hub is on its own registry, with a name');
  const fromDevice = nova.core.memory.remember({ kind: 'fact', content: 'The shed key is on the blue hook.', recorded_by: 'nova', source: `device:${hub.id}` });
  const fromCapture = nova.core.memory.remember({ kind: 'fact', content: 'The boiler was serviced in October.', recorded_by: 'nova', source: 'capture:00000000-0000-4000-8000-000000000000' });
  const mine = nova.core.memory.remember({ kind: 'fact', content: 'Likes the window seat.', recorded_by: 'person' });

  const m = await read();
  assert.equal(find(m, fromDevice.id).state, 'unreviewed');
  assert.equal(find(m, mine.id).state, 'confirmed');
  assert.equal(m.devices[hub.id], hub.name);
  assert.deepEqual(m.captured[fromCapture.id], { count: 0, devices: [] }, 'no promotion rows: the view says "from captured items" and no count');
  assert.equal(m.captured[fromDevice.id], undefined);

  const r = await fetch(`${base}/api/v1/memory/${fromDevice.id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nova': '1' }, body: '{}' });
  assert.equal(r.status, 200);
  assert.equal(find(await read(), fromDevice.id).state, 'confirmed');
});
