// Work that may already have happened, in the PWA (M5 review, should-fix 2): the ledger holds it
// as Needs you with the reason in plain words, and the retry button says what running it again
// will ask for. Pure, without a browser; tests/ui/m5-browser-effects.test.ts drives the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceViewer } from '../ui/js/components.js';
import { retryLabel, statusOf } from '../ui/js/status.js';

const held = (tier, attempts = 1) => ({
  id: 't1', title: 'Sign up on the example site', state: 'waiting', user_visibility: 'attention', approval_tier: tier, approved_at: '2026-10-30T10:00:00.000Z', attempts,
  reason: 'May already have happened: The evidence didn’t hold up: Nova fetched http://127.0.0.1:4321/records again itself (HTTP 200), and it doesn’t show “Bo Example”. Check, then retry or cancel.',
  brief: { goal: 'Fill in the example sign-up form and send it.' }, report: null, verification: null,
});

test('a held task is Needs you, and its sheet says why', () => {
  assert.equal(statusOf(held(2)), 'needs-you');
  assert.match(evidenceViewer(held(2)), /<p class="sheet-line task-reason">May already have happened: .*Check, then retry or cancel\.<\/p>/);
  assert.doesNotMatch(evidenceViewer({ ...held(2), state: 'done' }), /task-reason/);
});

test('the retry button says what running it again asks for', () => {
  assert.equal(retryLabel(held(1)), 'Try again');
  assert.equal(retryLabel(held(2)), 'Try again (asks for your OK)');
  assert.equal(retryLabel(held(3)), 'Try again (you confirm first)');
  assert.equal(retryLabel(held(2, 0)), 'Try again', 'never run: nothing to ask again');
});
