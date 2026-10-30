// Chaos pass, the clock (M7 plan §3): the wall clock jumps forward or back, against the time that
// really passed in the process (a monotonic clock the test drives) or against what Nova wrote down
// before it stopped. Schedules don't flood or stall, device sign-ins dated in the future end, and
// nothing is deleted for being "old" while the clock is in doubt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { open, world } from '../core/resilience-support.ts';
import { problemWith, repairs } from './support.ts';

const DAY = 86_400_000;

test('the clock jumps forward while Nova runs: noticed, said, schedules run once (not once per missed day), and old capture isn’t deleted while it’s in doubt', async () => {
  const w = world('nova-chaos-fwd-');
  let wall = Date.parse('2026-10-30T08:00:00Z');
  let mono = 0;
  const core = open(w.home, { now: () => new Date(wall), resilience: { monotonic: () => mono } });
  try {
    core.start();
    core.triggers.createRule({ name: 'Morning check-in', class: 'heartbeat', cron: '0 9 * * *', action: { kind: 'message', text: 'Good morning.' } }, 'person');
    wall += 2 * 3_600_000; mono += 2 * 3_600_000;
    await core.triggers.tick(new Date(wall));
    assert.equal(core.triggers.messages().length, 1, 'today’s ran');
    await core.resilience.sweep();

    // Five days pass on the wall clock in thirty seconds.
    wall += 5 * DAY; mono += 30_000;
    await core.resilience.sweep();
    const p = await problemWith(core, 'clock-jump', { subject: 'clock' });
    assert.match(p.message, /jumped 5 days ahead while Nova was running/);
    await core.triggers.tick(new Date(wall));
    assert.ok(core.triggers.messages().length <= 2, `missed days don’t flood: ${core.triggers.messages().length} messages`);
    const held = core.capture.sweep();
    assert.equal(held.swept, 0);
    assert.match(held.held ?? '', /clock jumped/);
    // Once the person says the time is right, retention runs again.
    core.log.resolve(p.id);
    assert.equal(core.capture.sweep().held, undefined);
  } finally {
    await core.close();
  }
});

test('the clock went back while Nova was off: noticed at start, schedules put back on time, future-dated device sign-ins ended', async () => {
  const w = world('nova-chaos-back-');
  let wall = Date.parse('2026-10-30T10:00:00Z');
  let core = open(w.home, { now: () => new Date(wall) });
  let ruleId = '';
  try {
    core.start();
    ruleId = core.triggers.createRule({ name: 'Morning check-in', class: 'heartbeat', cron: '0 9 * * *', action: { kind: 'message', text: 'Good morning.' } }, 'person').rule.id;
    wall += DAY; // the next morning
    await core.triggers.tick(new Date(wall));
    assert.ok(core.triggers.rule(ruleId).last_due_at, 'it ran');
    // A device sign-in made "now".
    core.db.run(`INSERT INTO device_session (token_hash, device_id, created_at, expires_at) VALUES ('h', (SELECT id FROM device LIMIT 1), ?, ?)`, new Date(wall).toISOString(), new Date(wall + 12 * 3_600_000).toISOString());
  } finally {
    await core.close();
  }
  // Started again with the clock three days behind.
  wall -= 3 * DAY;
  core = open(w.home, { now: () => new Date(wall) });
  try {
    core.start();
    const p = await problemWith(core, 'clock-jump', { subject: 'clock' });
    assert.match(p.message, /went back .* while Nova was off/);
    const r = await repairs(core, p.id);
    assert.equal(r[0]!.ok, true);
    assert.match(r[0]!.said, /Put 1 schedule back on time and ended 1 device sign-in/);
    assert.ok(Date.parse(core.triggers.rule(ruleId).last_due_at!) <= wall, 'no longer waiting for a time three days away');
    // The next morning (by this clock), it runs: not three days later.
    wall += DAY;
    await core.triggers.tick(new Date(wall));
    assert.ok(core.triggers.list({ rule: ruleId }).length >= 2, 'it ran on schedule again');
  } finally {
    await core.close();
  }
});
