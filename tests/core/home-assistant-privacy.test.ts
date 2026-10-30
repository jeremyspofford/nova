// Home Assistant's live socket follows the privacy setting as it changes (M5 review): one opened
// while the cloud was allowed closes when Nova becomes local-only, and opens again when that is
// lifted; and a change to the setting reaches every started connector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeAssistant } from '../../src/core/connectors/home-assistant.ts';
import type { ConnectorContext } from '../../src/core/connectors/index.ts';
import { startFakeHomeAssistant } from '../../scripts/fake-home-assistant.js';
import { bootCore, until } from './connector-support.ts';

test('the socket closes when the setting stops allowing it, and opens again when it allows it', async () => {
  const ha = await startFakeHomeAssistant();
  let allowed = true;
  let config: Record<string, unknown> = { url: ha.base, since: new Date().toISOString() };
  const ctx = {
    id: 'home-assistant',
    secrets: { get: () => ha.token, put: () => '', delete: () => true, has: () => true },
    config: { get: () => config, set: (p: Record<string, unknown>) => (config = { ...config, ...p }), clear: () => { config = {}; } },
    emit: async () => null, topics: () => [], permits: () => allowed, privacy: () => (allowed ? 'cloud-allowed' : 'local-only'),
    meshHosts: () => [], delegate: () => { throw new Error('no tasks here'); }, problem: () => {}, changed: () => {}, now: () => new Date(),
  } as unknown as ConnectorContext;
  const c = homeAssistant({ reconnectMs: { first: 20, max: 100 }, timeoutMs: 3000 })(ctx);
  try {
    c.start!();
    await until(() => c.status().live, (v) => v === 'listening');
    assert.equal(ha.sockets().length, 1);
    allowed = false;
    c.recheck!();
    await until(() => ha.sockets().length, (n) => n === 0);
    assert.equal(ha.sockets().length, 0, 'closed once it is no longer allowed');
    assert.equal(c.status().live, 'off');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(ha.sockets().length, 0, 'and not reopened by the reconnect loop');
    allowed = true;
    c.recheck!();
    await until(() => c.status().live, (v) => v === 'listening');
    assert.equal(ha.sockets().length, 1, 'open again once allowed');
  } finally {
    await c.stop?.();
    await ha.close();
  }
});

test('a change to the privacy setting reaches every started connector', async () => {
  const nova = await bootCore();
  let rechecks = 0;
  try {
    nova.core.connectors.register(() => ({
      manifest: { id: 'example-conn', version: '1.0.0', kind: 'connector', name: 'Example', capabilities: [], permissions: [], secrets: [], config_schema: {}, setup_flow: null, health_check: null, nova_compat: '>=0.1.0', on_remove: { delete: [], keep: [], export: [] } } as never,
      summary: '', can: [], never: [], setup: { kind: 'form', fields: [] }, egress: () => 'local', status: () => ({ connected: false }),
      disconnect: async () => ({ revoked: false }), recheck: () => { rechecks++; },
    }));
    await nova.call('PUT', '/profile/privacy/default', { value: 'cloud-allowed' });
    assert.ok(rechecks >= 1, 'told of the change');
  } finally {
    await nova.stop();
  }
});
