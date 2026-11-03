// Core's existing clock and live profile timezone drive Caps, including day/month rollover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCore } from '../../src/core/index.ts';
import { blank } from '../acceptance/support.ts';

test('Core Caps uses its injected clock and dynamically reads profile timezone before detected timezone and UTC', async () => {
  const m = blank('nova-caps-clock-');
  let at = new Date('2026-11-01T00:30:00.000Z');
  const core = createCore({ home: m.home, version: 'test', trustedOrigin: () => true, vault: { mode: 'file' }, sandbox: true, detectedTimezone: 'America/New_York', now: () => at, onboarding: { userHome: m.env.HOME } });
  try {
    assert.equal(core.caps.view().day, '2026-10-31');
    core.caps.meter({ task_id: 'example', session_id: 'example', capped: true }).model({ provider: 'example', model: 'example', where: 'local', usage: { tokens_in: 11, tokens_out: 2 }, sent: 0, received: 0 });
    assert.equal(core.caps.view().month.month, '2026-10');
    assert.equal(core.caps.view().today.tokens_in, 11);
    core.profile.set('user', 'timezone', 'Asia/Tokyo', 'settings');
    assert.equal(core.caps.view().day, '2026-11-01');
    assert.equal(core.caps.view().month.month, '2026-11');
    assert.equal(core.caps.view().today.tokens_in, 0);
    core.profile.set('user', 'timezone', 'America/New_York', 'settings');
    assert.equal(core.caps.view().today.tokens_in, 11);
    at = new Date('2026-11-01T05:30:00.000Z');
    assert.equal(core.caps.view().day, '2026-11-01');
    assert.equal(core.caps.view().today.tokens_in, 0);
  } finally { await core.close(); }
  at = new Date('2026-11-01T00:30:00.000Z');
  const fallback = createCore({ home: blank('nova-caps-utc-').home, version: 'test', trustedOrigin: () => true, vault: { mode: 'file' }, sandbox: true, now: () => at, onboarding: { userHome: m.env.HOME } });
  try { assert.equal(fallback.caps.view().day, '2026-11-01'); } finally { await fallback.close(); }
});
