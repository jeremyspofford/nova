// The agent status icon's state model and forms (ui/js/status-icon.js; owner spec 2026-11-08):
// a change mid-morph starts from the form on screen and never jumps or restarts; success is a
// flourish that settles to idle by itself; unknown states are refused; every form is the same
// N points (so any form morphs into any other) and fits the canvas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MORPH_MS, STATUS_ICON_STATES, SUCCESS_MS, StatusModel, statePalettes, statusForm } from '../ui/js/status-icon.js';

// The same weights, a state at zero counting as absent.
const close = (a, b, label) => {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) assert.ok(Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < 1e-9, `${label}: ${k} ${a[k]} vs ${b[k]}`);
};
const sum = (w) => Object.values(w).reduce((x, y) => x + y, 0);

test('the canonical states, and nothing else', () => {
  assert.deepEqual(STATUS_ICON_STATES, ['idle', 'listening', 'thinking', 'working', 'speaking', 'needs-you', 'success', 'paused', 'stopped', 'offline']);
  assert.throws(() => new StatusModel('happy'), /Unknown status: happy/);
  const m = new StatusModel('idle', 0);
  assert.throws(() => m.set('error', 10), /Unknown status: error/);
  assert.throws(() => m.set(undefined, 10), /Unknown status/);
  assert.equal(m.status(10), 'idle', 'a refused change changes nothing');
  assert.throws(() => statusForm('warning'), /Unknown status/);
});

test('a morph takes MORPH_MS and ends on the new form alone', () => {
  const m = new StatusModel('idle', 0);
  m.set('working', 1000);
  close(m.weights(1000), { idle: 1, working: 0 }, 'starts where it was');
  const mid = m.weights(1000 + MORPH_MS / 2);
  assert.ok(mid.idle > 0 && mid.working > 0 && Math.abs(sum(mid) - 1) < 1e-9, 'half way is both');
  close(m.weights(1000 + MORPH_MS), { idle: 0, working: 1 }, 'ends on working');
  assert.equal(m.moving(1000 + MORPH_MS), false);
});

test('a change mid-transition retargets from the current form: no jump, no restart', () => {
  const m = new StatusModel('idle', 0);
  m.set('working', 1000);
  const before = m.weights(1150);
  assert.ok(before.working > 0 && before.working < 1, 'mid-morph');
  m.set('needs-you', 1150);
  const after = m.weights(1150);
  close(after, { ...before, 'needs-you': 0 }, 'the form on screen is the same the instant the target changes');
  // It moves on from there, smoothly and only toward the new target.
  let last = after['needs-you'];
  for (let t = 1160; t <= 1150 + MORPH_MS; t += 10) {
    const w = m.weights(t);
    assert.ok(w['needs-you'] >= last, `needs-you only grows (${t})`);
    assert.ok(Math.abs(sum(w) - 1) < 1e-9, 'weights sum to one');
    assert.ok(w.working <= before.working + 1e-9, 'working never comes back from zero');
    last = w['needs-you'];
  }
  assert.equal(m.weights(1150 + MORPH_MS)['needs-you'], 1);
  // Setting the same target again changes nothing.
  m.set('needs-you', 1200);
  assert.equal(m.weights(1150 + MORPH_MS)['needs-you'], 1);
});

test('success is a flourish: it settles to idle by itself, and the model never rests on it', () => {
  const m = new StatusModel('working', 0);
  m.set('success', 100);
  assert.equal(m.status(100 + SUCCESS_MS - 1), 'success');
  assert.equal(m.moving(100 + SUCCESS_MS - 1), true, 'success keeps the loop going until it settles');
  assert.equal(m.status(100 + SUCCESS_MS), 'idle');
  const w = m.weights(100 + SUCCESS_MS);
  assert.ok(Math.abs(w.success - 1) < 1e-9, 'and morphs from the success form');
  close(m.weights(100 + SUCCESS_MS + MORPH_MS), { idle: 1, success: 0 }, 'to idle');
  // A change before it settles wins.
  const n = new StatusModel('idle', 0);
  n.set('success', 0);
  n.set('paused', 500);
  assert.equal(n.status(5000), 'paused');
});

test('reduced motion: every change is an instant swap, success included', () => {
  const m = new StatusModel('idle', 0);
  m.reduced = true;
  m.set('working', 100);
  close(m.weights(100), { working: 1 }, 'no morph');
  m.set('success', 200);
  close(m.weights(200), { success: 1 }, 'success shows at once');
  close(m.weights(200 + SUCCESS_MS), { idle: 1 }, 'and swaps to idle at once');
});

test('every form: the same N points, finite, inside the canvas; small sizes are broader', () => {
  const N = statusForm('idle').length;
  for (const s of STATUS_ICON_STATES) for (const small of [false, true]) for (const t of [0, 0.37, 5.2]) {
    const f = statusForm(s, t, small);
    assert.equal(f.length, N, `${s}: same point count`);
    for (let i = 0; i < f.length; i += 5) {
      assert.ok([...f.subarray(i, i + 5)].every(Number.isFinite), `${s}: finite`);
      assert.ok(Math.abs(f[i]) + f[i + 2] <= 0.95 && Math.abs(f[i + 1]) + f[i + 2] <= 0.95, `${s}${small ? ' small' : ''}: point ${i / 5} fits`);
      if (small) assert.ok(f[i + 2] >= 0.1, `${s} small: no hairlines`);
    }
  }
  // Paused and stopped hold still; the loops move.
  for (const s of ['paused', 'stopped', 'offline']) assert.deepEqual(statusForm(s, 0), statusForm(s, 3), `${s} is still`);
  for (const s of ['idle', 'thinking', 'working', 'listening', 'speaking']) assert.notDeepEqual(statusForm(s, 0), statusForm(s, 0.5), `${s} moves`);
});

test('colour: red only for stopped, amber leads needs-you, offline is dim', () => {
  const tok = { core: [0.1, 0.5, 0.7], violet: [0.5, 0.2, 0.7], coral: [0.9, 0.6, 0.55], amber: [0.94, 0.55, 0.12], red: [1, 0.2, 0.2] };
  const p = statePalettes(tok);
  assert.deepEqual(Object.keys(p).sort(), [...STATUS_ICON_STATES].sort());
  for (const [s, [stops]] of Object.entries(p)) assert.equal(stops.some((c) => c === tok.red), s === 'stopped', `${s}: red`);
  for (const s of ['paused', 'success', 'listening', 'thinking']) assert.ok(!p[s][0].includes(tok.amber), `${s}: no amber`);
  assert.ok(p['needs-you'][0].filter((c) => c === tok.amber).length >= 3, 'needs-you is amber');
  assert.ok(p.offline[1] < Math.min(...Object.entries(p).filter(([s]) => s !== 'offline').map(([, [, b]]) => b)), 'offline is the dimmest');
});
