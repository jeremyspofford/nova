// The composition root takes workers and confirmation checkers from outside the core (Era 2's
// chat-run worker is one), so their tasks run through the same ledger, gates and verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, ENVELOPE_VERSION, type Brief, type Worker } from '../../src/core/index.ts';

const report = (b: Brief, id: string) => ({
  envelope: ENVELOPE_VERSION, task_id: b.task_id, status: 'done', summary: 'Delivered.', evidence: [{ kind: 'confirmation', system: 'example-log', id }],
  artifacts: [], blockers: [], usage: { duration_ms: 1 }, follow_up_suggestions: [],
});

test('createCore registers outside workers and confirmation checkers; the checker reads the target, not the claim', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-core-options-'));
  const log = new Set<string>();
  const worker: Worker = {
    id: 'example', name: 'Example worker', about: 'Writes to an example log.', egress: 'none', evidence: ['confirmation'], health: () => ({ ok: true }),
    run: async (b) => { const id = String(b.inputs?.id); if (b.inputs?.write) log.add(id); return report(b, id); },
  };
  const core = createCore({
    home, version: '0.1.0', trustedOrigin: () => true, workers: [worker],
    confirmations: { 'example-log': (e) => (e.kind === 'confirmation' && log.has(e.id) ? { ok: true, why: `Nova found ${e.id} in the example log.` } : { ok: false, why: 'Nova looked and it isn’t there.' }) },
  });
  try {
    assert.ok(core.ledger.workers.has('example'));
    const task = (id: string, write: boolean) => core.ledger.create({ title: `Log ${id}`, owner: 'example', goal: 'An entry is in the example log.', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation' }], inputs: { id, write }, idempotency_key: id });
    const good = task('e1', true);
    const claimed = task('e2', false);
    await core.ledger.idle();
    assert.equal(core.ledger.get(good.id).state, 'done');
    assert.equal(core.ledger.get(claimed.id).state, 'failed');
    assert.match(core.ledger.get(claimed.id).reason ?? '', /looked and it isn’t there/);
    assert.ok(core.health().checks.workers.workers.some((w) => w.id === 'example'));
  } finally {
    await core.close();
  }
});

test('an outside worker that sends data away is held to the privacy rules like any other', async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-core-options-'));
  let called = false;
  const cloud: Worker = { id: 'cloudy', name: 'An example cloud worker', about: 'x', egress: 'remote', evidence: ['confirmation'], health: () => ({ ok: true }), run: async (b) => { called = true; return report(b, 'x'); } };
  const core = createCore({ home, version: '0.1.0', trustedOrigin: () => true, workers: [cloud] });
  try {
    assert.equal(core.profile.privacyDefault(), 'local-only');
    assert.throws(() => core.ledger.create({ title: 'x', owner: 'cloudy', goal: 'x', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation' }] }), /An example cloud worker sends data off your devices, and this task is local-only/);
    await core.ledger.idle();
    assert.equal(called, false);
  } finally {
    await core.close();
  }
});
