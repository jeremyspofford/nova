// The PWA's pure logic: layout selection, navigation, the status vocabulary and the orb's state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LAYOUTS, POSTURES, asideOf, layoutOf, postureOf, resolve, viewportOf } from '../ui/js/layout.js';
import { DESTINATIONS, placement, reachable, routeOf } from '../ui/js/nav.js';
import { STATUS, activityStatus, greeting, label, needsApproval, orbState, statusOf, toolTier } from '../ui/js/status.js';

// ---- layout ----------------------------------------------------------------------------

test('layout follows the viewport: narrow is phone, medium is tablet, wide is desktop', () => {
  assert.equal(layoutOf({ viewport: 'narrow' }), 'phone');
  assert.equal(layoutOf({ viewport: 'medium' }), 'tablet');
  assert.equal(layoutOf({ viewport: 'wide' }), 'desktop');
});

test('the bands are the derived widths, not round numbers (UX review 2026-10-31, F8/F9)', () => {
  const bands = { two: 621.5, three: 916.3 };
  assert.equal(viewportOf(320, bands), 'narrow');
  assert.equal(viewportOf(621, bands), 'narrow', 'under the rail and the main column\'s minimum: one column');
  assert.equal(viewportOf(621.5, bands), 'medium');
  assert.equal(viewportOf(900, bands), 'medium', 'a fold\'s inner screen under the three-column band: the rail and one column');
  assert.equal(viewportOf(916.3, bands), 'wide');
  assert.equal(viewportOf(1024, { two: 600, three: 1100 }), 'medium', 'a design system whose regions need more moves the band');
});

test('posture overrides width: a folded cover screen is a phone, half-open is two panes', () => {
  for (const viewport of ['narrow', 'medium', 'wide']) {
    assert.equal(layoutOf({ viewport, posture: 'folded' }), 'phone', viewport);
    assert.equal(layoutOf({ viewport, posture: 'half-open-vertical' }), 'tablet', viewport);
    assert.equal(layoutOf({ viewport, posture: 'half-open-horizontal' }), 'tablet', viewport);
  }
});

test('posture comes from the ?posture= hook first, then viewport segments, then the Device Posture API', () => {
  assert.equal(postureOf({}), 'continuous');
  assert.equal(postureOf({ override: 'folded', segments: 'horizontal' }), 'folded');
  assert.equal(postureOf({ override: 'sideways' }), 'continuous', 'an unknown hook value is ignored');
  assert.equal(postureOf({ segments: 'horizontal' }), 'half-open-horizontal');
  assert.equal(postureOf({ segments: 'vertical' }), 'half-open-vertical');
  assert.equal(postureOf({ devicePosture: 'folded', orientation: 'landscape-primary' }), 'half-open-vertical');
  assert.equal(postureOf({ devicePosture: 'folded', orientation: 'portrait-primary' }), 'half-open-horizontal');
  for (const p of POSTURES) assert.equal(postureOf({ override: p }), p);
});

test('the quiet cards: a desktop right column with room, unless closed; a half-open tablet\'s second pane; never a flat tablet or a phone', () => {
  assert.equal(asideOf({ layout: 'desktop', room: 'yes' }), 'on');
  assert.equal(asideOf({ layout: 'desktop', room: 'yes', closed: true }), 'off');
  assert.equal(asideOf({ layout: 'desktop', room: 'no' }), 'off');
  assert.equal(asideOf({ layout: 'tablet', room: 'no' }), 'off', 'under the three-column band there is no right column to crush');
  assert.equal(asideOf({ layout: 'tablet', posture: 'half-open-vertical', room: 'no', closed: true }), 'on');
  assert.equal(asideOf({ layout: 'tablet', posture: 'half-open-horizontal', room: 'no' }), 'on');
  assert.equal(asideOf({ layout: 'phone', room: 'yes' }), 'off');
  assert.deepEqual(resolve({ viewport: 'wide', room: 'yes', segments: 'none' }), { layout: 'desktop', posture: 'continuous', aside: 'on' });
  assert.deepEqual(resolve({ viewport: 'wide', room: 'yes', override: 'folded' }), { layout: 'phone', posture: 'folded', aside: 'off' });
  assert.deepEqual(resolve({ viewport: 'wide', room: 'yes', override: 'half-open-vertical' }), { layout: 'tablet', posture: 'half-open-vertical', aside: 'on' });
});

test('breakpoints live in layout.css only: bands derived from the regions, plus viewport segments', () => {
  const css = readFileSync('ui/styles/layout.css', 'utf8');
  // F8/F9: each band starts at the sum of its regions' minimums, never a round number; the
  // compact width class (600 px) stays the floor under which a phone gets tabs.
  assert.match(css, /--band-two: max\(600px, calc\(var\(--layout-rail-width\) \+ var\(--region-main-min\)\)\);/);
  assert.match(css, /--band-three: calc\(var\(--layout-rail-width\) \+ var\(--region-main-min\) \+ var\(--region-aside-min\)\);/);
  assert.doesNotMatch(css, /min-width: 1024px/);
  assert.match(css, /@media \(horizontal-viewport-segments: 2\)/);
  assert.match(css, /@media \(vertical-viewport-segments: 2\)/);
  for (const f of ['ui/styles/base.css', 'ui/styles/components.css', 'ui/styles/views.css']) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /@media[^{]*width/, f);
  }
  for (const f of ['ui/js/layout.js', 'ui/js/shell.js', 'ui/js/app.js']) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /matchMedia\([^)]*width/, f);
  }
});

// ---- navigation ------------------------------------------------------------------------

test('every layout reaches the same nine destinations', () => {
  const all = DESTINATIONS.map((d) => d.id).sort();
  assert.deepEqual(all, ['activity', 'automations', 'chat', 'health', 'home', 'memory', 'settings', 'skills', 'tasks']);
  for (const l of LAYOUTS) assert.deepEqual(reachable(l).sort(), all, l);
});

test('phone has five tabs (four destinations and More); the rail has the orb and at most six', () => {
  const phone = placement('phone');
  assert.deepEqual(phone.primary, ['home', 'chat', 'tasks', 'memory']);
  assert.equal(phone.home, 'tab');
  for (const l of ['tablet', 'desktop']) {
    const p = placement(l);
    assert.equal(p.home, 'orb');
    assert.ok(p.primary.length + p.foot.length <= 6, l);
    assert.ok(!p.primary.includes('home'));
  }
});

test('paths map to destinations, and Era 2 paths keep working', () => {
  assert.deepEqual(routeOf('/'), { dest: 'home' });
  assert.deepEqual(routeOf('/chat'), { dest: 'chat', conversation: 'main' });
  assert.deepEqual(routeOf('/new'), { dest: 'chat', conversation: null });
  assert.deepEqual(routeOf('/c/abc-123'), { dest: 'chat', conversation: 'abc-123' });
  assert.deepEqual(routeOf('/schedules'), { dest: 'automations' });
  for (const d of DESTINATIONS) assert.equal(routeOf(d.path).dest, d.id);
  assert.equal(routeOf('/nowhere').unknown, true);
});

// ---- status vocabulary -------------------------------------------------------------------

const task = (state, more = {}) => ({ state, approval_tier: 1, approved_at: null, user_visibility: 'handling', ...more });

test('ledger states map onto the one status vocabulary', () => {
  assert.equal(statusOf(task('queued')), 'waiting');
  assert.equal(statusOf(task('active')), 'working');
  assert.equal(statusOf(task('verifying')), 'working');
  assert.equal(statusOf(task('waiting', { reason: 'Waiting on local capacity.' })), 'waiting');
  assert.equal(statusOf(task('waiting', { approval_tier: 2 })), 'needs-you');
  assert.equal(statusOf(task('waiting', { approval_tier: 3 })), 'needs-you');
  assert.equal(statusOf(task('waiting', { approval_tier: 2, approved_at: '2026-10-29T10:00:00Z' })), 'waiting');
  assert.equal(statusOf(task('waiting', { user_visibility: 'attention' })), 'needs-you');
  assert.equal(statusOf(task('done', { verification: { ok: true, checks: [] } })), 'verified');
  assert.equal(statusOf(task('failed')), 'failed');
  assert.equal(statusOf(task('cancelled')), 'quiet');
  assert.equal(statusOf(null), 'quiet');
  assert.deepEqual(Object.values(STATUS).map((s) => s.label), ['Quiet', 'Working', 'Waiting', 'Verified', 'Needs you', 'Failed']);
  assert.equal(label('needs-you'), 'Needs you');
  assert.equal(needsApproval(task('queued', { approval_tier: 3 })), false);
});

test('Era 2 activity states use the same words, and never claim Verified', () => {
  assert.equal(activityStatus('working'), 'working');
  assert.equal(activityStatus('waiting'), 'needs-you');
  assert.equal(activityStatus('queued'), 'waiting');
  for (const s of ['failed', 'interrupted', 'missed']) assert.equal(activityStatus(s), 'failed');
  for (const s of ['done', 'stopped']) assert.equal(activityStatus(s), 'quiet');
});

test('the orb takes its state from real signals, most urgent first', () => {
  assert.equal(orbState({}), 'idle');
  assert.equal(orbState({ working: 2 }), 'working');
  assert.equal(orbState({ working: 1, speaking: true }), 'speaking');
  assert.equal(orbState({ working: 1, needsYou: 1 }), 'attention');
  assert.equal(orbState({ needsYou: 1, problems: 1 }), 'alert');
  assert.equal(orbState({ problems: 1, listening: true }), 'listening');
  assert.equal(orbState({ reachable: false, listening: true, problems: 3 }), 'offline');
});

test('the greeting follows the hour', () => {
  assert.equal(greeting(new Date(2026, 9, 29, 8), 'Sam'), 'Good morning, Sam');
  assert.equal(greeting(new Date(2026, 9, 29, 14)), 'Good afternoon');
  assert.equal(greeting(new Date(2026, 9, 29, 21)), 'Good evening');
});

// Review finding: every Era 2 tool step was drawn as tier 2, so a deletion took one Enter.
test('Era 2 tool steps: deletions and irreversible-looking commands are tier 3', () => {
  assert.equal(toolTier('schedule_remove', { id: 'morning' }), 3);
  for (const command of ['rm -rf build', 'cd x && rm notes.md', 'git push --force origin main', 'git push origin :old', 'git reset --hard HEAD~3', 'git clean -fdx', 'git branch -D topic', 'find . -name "*.tmp" -delete', 'dd if=/dev/zero of=/dev/sda', 'sqlite3 db "DROP TABLE notes"', 'chmod -R 777 .']) {
    assert.equal(toolTier('exec', { command }), 3, command);
  }
  for (const command of ['git status', 'ls -la', 'npm test', 'git push origin main', 'grep -r "rm " src', 'cat format.md', 'echo firmware']) {
    assert.equal(toolTier('exec', { command }), 2, command);
  }
  for (const name of ['schedule_set', 'gmail_draft', 'gmail_organize', 'web_fetch', 'write_file']) assert.equal(toolTier(name, {}), 2, name);
});
