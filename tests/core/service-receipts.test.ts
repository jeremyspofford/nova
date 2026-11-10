// Calls to a connected service leave a receipt (F-031). The receipt is written in the one generic
// step that runs a connector's worker, so two stand-in services, one remote and one local, written
// only against the connector contract, are receipted with no code of their own: which service and
// action, local or remote, the privacy setting, and a fingerprint of what it was given. In
// local-only a remote service is refused and leaves no "sent" receipt. No model is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { reportOf } from '../../src/core/envelope.ts';
import type { Connector, ConnectorContext } from '../../src/core/connectors/index.ts';
import type { Egress } from '../../src/core/workers.ts';
import { bootCore, until } from './connector-support.ts';

// A service with one action, `set`, that records what it was asked and reports done.
function service(id: string, egress: Egress, seen: unknown[]) {
  return (ctx: ConnectorContext): Connector => ({
    manifest: {
      id, version: '1.0.0', kind: 'connector', name: `Example ${id}`, capabilities: [],
      permissions: [{ kind: 'device', target: id, why: 'to set it when you ask' }], secrets: [], config_schema: {}, setup_flow: null,
      health_check: {}, nova_compat: '>=0.1.0 <1.0.0', on_remove: { delete: [], keep: [], export: [] },
      approvals: [{ id: 'set', name: 'Set it', effect: 'irreversible', default: 1, guard: 'set it' }],
      actions: [{ id: 'set', name: 'Set it', words: 'Set a value.', args: { value: 'a number' }, approval: 'set' }],
    } as never,
    summary: id, can: [], never: [], setup: { kind: 'form', fields: [] } as never,
    egress: () => egress, status: () => ({ connected: true }), disconnect: async () => ({ revoked: true }),
    worker: {
      id, name: id, about: `Sets ${id}.`, egress, evidence: ['confirmation'], health: () => ({ ok: true }),
      async run(brief) {
        seen.push(brief.inputs);
        return reportOf(brief.task_id, 'done', 'Set.', { evidence: [{ kind: 'confirmation', system: id, id: `set@${brief.task_id}` }] });
      },
    },
    confirm: () => ({ ok: true, why: 'Read back.' }),
    act: (_action: string, args: Record<string, unknown>) => ctx.delegate({ title: `Set ${id}`, goal: `${id} is set.`, approval_tier: 1, evidence_required: [{ kind: 'confirmation' }], inputs: { value: args.value } }),
  }) as Connector;
}

test('a remote and a local service, each called once in local-first: both receipted, only the remote one in the remote list', async () => {
  const n = await bootCore();
  const seen = { cloud: [] as unknown[], lan: [] as unknown[] };
  try {
    n.core.profile.set('privacy', 'default', 'local-preferred', 'settings');
    n.core.connectors.register(service('example-cloud', 'remote', seen.cloud));
    n.core.connectors.register(service('example-lan', 'local', seen.lan));
    const a = n.core.connectors.act('example-cloud', 'set', { value: 21 });
    const b = n.core.connectors.act('example-lan', 'set', { value: 7 });
    for (const t of [a, b]) assert.equal((await until(() => n.core.ledger.get(t.id).state, (s) => s === 'done')), 'done');

    const remote = n.core.receipts.list({ egress: 'remote' });
    assert.deepEqual(remote.map((r) => [r.provider, r.model, r.purpose, r.privacy_mode, r.egress, r.task_id]), [
      ['service:example-cloud', 'set', 'service: Example example-cloud, set', 'local-preferred', 'remote:example-cloud', a.id],
    ]);
    assert.deepEqual(remote[0]!.context_items.map((c) => [c.kind, c.ref]), [['file', `brief:${a.id}`]]);
    assert.match(remote[0]!.context_items[0]!.sha256, /^[0-9a-f]{64}$/);
    assert.doesNotMatch(JSON.stringify(remote), /"value"|21/, 'a fingerprint of what it was given, never the text');
    // The local one has its receipt too, and stays out of the remote list.
    const local = n.core.receipts.list({ egress: 'local' }).filter((r) => r.provider.startsWith('service:'));
    assert.deepEqual(local.map((r) => [r.provider, r.egress, r.task_id]), [['service:example-lan', 'local', b.id]]);
    // The route the receipts screen reads returns it.
    const route = await n.get('/receipts?egress=remote');
    assert.deepEqual(route.map((r: { provider: string }) => r.provider), ['service:example-cloud']);
    assert.deepEqual([seen.cloud.length, seen.lan.length], [1, 1]);
  } finally { await n.stop(); }
});

test('local-only: a call to a remote service is refused, and no "sent" receipt is written', async () => {
  const n = await bootCore();
  const seen: unknown[] = [];
  try {
    n.core.profile.set('privacy', 'default', 'local-only', 'settings');
    n.core.connectors.register(service('example-cloud', 'remote', seen));
    let task = null;
    try { task = n.core.connectors.act('example-cloud', 'set', { value: 21 }); } catch { task = null; }
    if (task) await until(() => n.core.ledger.get(task!.id).state, (s) => ['failed', 'done', 'cancelled', 'blocked'].includes(s));
    assert.deepEqual(n.core.receipts.list({ egress: 'remote' }), []);
    assert.deepEqual(seen, [], 'the service was never called');
  } finally { await n.stop(); }
});
