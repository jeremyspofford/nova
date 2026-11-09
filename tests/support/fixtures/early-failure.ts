// Not part of the suite (no glob reaches it): tests/acceptance/fixture-cleanup.test.ts runs it as
// its own ordinary `node --test`. The fresh-user test's setup (a blank machine, discovery's
// stand-ins, a real Nova server), then a failure before anything else, as when an early assertion
// fails. It writes what it started to NOVA_FIXTURE_REPORT first, for the outer test to check.
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { blank } from '../../acceptance/support.ts';
import { discoveryStandIns } from '../fake-mdns.ts';

test('fails early, on purpose', async (t) => {
  const m = blank('nova-early-', t);
  const s = await discoveryStandIns((close) => t.after(close));
  const nova = await m.start(s.env);
  writeFileSync(process.env.NOVA_FIXTURE_REPORT!, JSON.stringify({ dir: m.dir, nova: nova.proc.pid }));
  throw new Error('the intended early failure');
});
