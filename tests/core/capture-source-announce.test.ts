// B1: a heartbeat that advertises what a computer can capture makes each new source once and says
// so once; a heartbeat that changes nothing announces nothing. Synthetic device, placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, enroll, hub } from './mesh-support.ts';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

test('capture announces a new device source once, and an unchanged heartbeat not at all', async () => {
  const h = await hub();
  try {
    const { dev, token } = await enroll(h, { kind: 'computer', name: 'Test computer', purposes: ['compute', 'capture-source'] });
    const changes: string[] = [];
    h.core.capture.on('change', (e: { what: string }) => { if (e.what === 'sources') changes.push(e.what); });
    const beat = () => call(h.mesh, 'POST', '/api/v1/mesh/devices/me/heartbeat', { capabilities: ['heartbeat', 'capture.app-activity'], version: '0.1.0' }, bearer(token));
    assert.equal((await beat()).status, 200);
    const sources = h.core.capture.sources().filter((s: { id: string }) => s.id.startsWith(`device:${dev.deviceId}:`));
    assert.equal(sources.length, 1, 'the advertised kind became a source');
    assert.equal(changes.length, 1, `a new source is announced once (got ${changes.length})`);
    assert.equal((await beat()).status, 200);
    assert.equal(changes.length, 1, `an unchanged heartbeat announces nothing (got ${changes.length})`);
  } finally {
    await h.stop();
  }
});
