// The takeover view's words and its one standout action come from the browser session's real
// state (M5c); pure, so the rules are checked here: who may take over, who may hand back, and what
// each state says in the one status vocabulary. The live view itself is tests/ui/m5c-takeover.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceViewer, takeoverActions, takeoverPanel, takeoverState } from '../ui/js/components.js';

const view = (over = {}) => ({ task_id: 't1', live: true, mode: 'working', url: 'http://127.0.0.1:4321/form/x/details', step: { n: 2, of: 9, what: 'Fill in #name' }, asked: null, holder: null, blocked: [], ...over });
const task = { id: 't1', title: 'Sign up on the example site' };

test('working: Nova says which step; Take over is the one standout, for those allowed', () => {
  const st = takeoverState(view());
  assert.deepEqual([st.status, st.line, st.action], ['working', 'Nova is working. Step 2 of 9: Fill in #name.', 'take-over']);
  const html = takeoverActions(st);
  assert.equal((html.match(/btn primary/g) ?? []).length, 1);
  assert.match(html, /data-action="take-over">Take over</);
  const phone = takeoverState(view(), { me: 'device:p1', canTake: false });
  assert.equal(phone.action, null);
  assert.match(takeoverActions(phone, { canTake: false }), /Only the hub’s own screen, or a device you’ve allowed to approve, can take over/);
  assert.doesNotMatch(takeoverActions(phone, { canTake: false }), /btn primary/);
});

test('asked for: Needs you, in the words the worker used', () => {
  const st = takeoverState(view({ mode: 'needs_person', asked: 'Type the code shown in the picture.' }));
  assert.deepEqual([st.status, st.line, st.action], ['needs-you', 'Needs you: Type the code shown in the picture.', 'take-over']);
});

test('held: the holder hands back; others wait; the hub’s own screen can end someone else’s takeover', () => {
  const v = view({ mode: 'taken_over', asked: 'Type the code.', holder: { key: 'device:p1', label: 'Example phone', since: '2026-10-30T10:00:00Z' } });
  const mine = takeoverState(v, { me: 'device:p1' });
  assert.deepEqual([mine.status, mine.action, mine.mine], ['waiting', 'hand-back', true]);
  assert.match(mine.line, /^You have control\. Nova waits until you hand back\. It asked you to: Type the code\./);
  assert.match(takeoverActions(mine), /data-action="hand-back">Hand back</);
  const other = takeoverState(v, { me: 'device:p2' });
  assert.deepEqual([other.line, other.action], ['Example phone has control. Nova waits until they hand back.', null]);
  const hub = takeoverState(v, { me: 'console' });
  assert.equal(hub.action, 'hand-back');
  assert.match(takeoverActions(hub), />End their takeover</);
});

test('over: the browser is closed and nothing is offered but Close', () => {
  const st = takeoverState({ task_id: 't1', live: false });
  assert.equal(st.status, 'quiet');
  assert.doesNotMatch(takeoverActions(st), /btn primary/);
});

test('the panel: the live picture, the Type field only for the holder, refused hosts listed', () => {
  const html = takeoverPanel(task, view({ blocked: [{ host: 'tracker.example.test:80', count: 3 }] }));
  assert.match(html, /class="takeover-frame" alt="The browser’s screen, live, at 127\.0\.0\.1:4321"/);
  assert.match(html, /<form class="takeover-type" hidden>/);
  assert.match(html, /Refused 1 host the task didn’t declare.*tracker\.example\.test:80 · 3 times/s);
  const held = takeoverPanel(task, view({ mode: 'taken_over', holder: { key: 'console', label: 'The hub’s own screen', since: 'x' } }));
  assert.match(held, /data-held="true"/);
  assert.match(held, /<form class="takeover-type">/);
});

test('the evidence: a screenshot the browser took is shown from Nova, never as a bare file name', () => {
  const t = { id: 't1', title: 'x', state: 'done', brief: { goal: 'g' }, verification: { ok: true, at: '2026-10-30T10:00:00Z', checks: [{ ok: true, why: 'Nova took this screenshot itself.', requirement: { kind: 'screenshot' }, evidence: { kind: 'screenshot', ref: 'workers/browser/t1/final.png' } }] } };
  assert.match(evidenceViewer(t), /<img class="evidence-shot" src="\/api\/v1\/browser\/tasks\/t1\/screenshot"/);
});
