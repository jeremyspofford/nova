// B3: a revoked device is no longer one of the person's own, so a connector at its address is not
// "local" for the privacy setting. Connectors use the same trusted-only mesh hosts as capture and
// providers. Synthetic devices and neutral placeholder names only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addressEgress, type ConnectorContext } from '../../src/core/connectors/index.ts';
import { bootCore } from './connector-support.ts';

test('connectors count only trusted devices as local: a revoked one is not', async () => {
  const nova = await bootCore();
  try {
    const at = new Date().toISOString();
    const add = (trust: string, address: string) => nova.core.db.run(
      `INSERT INTO device (id, name, platform, kind, role, public_key, x25519_public_key, fingerprint, capabilities, purposes, trust, can_approve, address, created_at, approved_at)
       VALUES (?, ?, 'linux', 'standby', 'standby', ?, ?, ?, '[]', '[]', ?, 0, ?, ?, ?)`,
      randomUUID(), `Placeholder ${trust}`, randomUUID(), randomUUID(), randomUUID(), trust, address, at, at,
    );
    add('trusted', 'https://kept.example.net');
    add('revoked', 'https://box.example.net');
    let ctx: ConnectorContext | null = null;
    nova.core.connectors.register((c) => {
      ctx = c;
      return {
        manifest: { id: 'example-hosts', version: '1.0.0', kind: 'connector', name: 'Example', capabilities: [], permissions: [], secrets: [], config_schema: {}, setup_flow: null, health_check: null, nova_compat: '>=0.1.0', on_remove: { delete_data: true } },
        summary: '', can: [], never: [], setup: { kind: 'form', fields: [] }, egress: () => 'local', status: () => ({ connected: false }),
        disconnect: async () => ({ revoked: false }),
      } as never;
    });
    const hosts = ctx!.meshHosts();
    assert.ok(hosts.includes('kept.example.net'), `a trusted device is local: ${JSON.stringify(hosts)}`);
    assert.ok(!hosts.includes('box.example.net'), `a revoked device is not: ${JSON.stringify(hosts)}`);
    assert.notEqual(addressEgress('https://box.example.net:8123', hosts), 'local');
    assert.equal(addressEgress('https://kept.example.net:8123', hosts), 'local');
  } finally {
    await nova.stop();
  }
});
