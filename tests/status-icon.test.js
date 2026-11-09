// The agent status icon's state model and treatments (ui/js/status-icon.js; owner, 2026-11-08):
// a change mid-transition starts from what is on screen and never jumps or restarts; success is a
// flourish that settles to idle by itself; unknown states are refused; and every state is a
// treatment of the one artwork (the state table), never a shape of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MORPH_MS, STATUS_ICON_STATES, SUCCESS_MS, StatusModel, stateTreatment } from '../ui/js/status-icon.js';

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
  assert.throws(() => stateTreatment('warning'), /Unknown status/);
});

test('timing (owner, 2026-11-08): an 800 ms morph on a soft ease-in-out; success shows about a second', () => {
  assert.equal(MORPH_MS, 800);
  assert.equal(SUCCESS_MS, 1800);
  const m = new StatusModel('idle', 0);
  m.set('working', 0);
  assert.ok(Math.abs(m.weights(400).working - 0.5) < 1e-9, 'half way at half time');
  assert.ok(m.weights(80).working < 0.03 && m.weights(720).working > 0.97, 'eases in and out');
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

// ---- the treatments (the owner's state table, nova-single-mark-n-direction-2026-11-08.md) --------

const T = (s, t = 0) => stateTreatment(s, t);
const moves = (s) => [0.3, 1.1, 2.9, 5.3].some((t) => JSON.stringify(T(s, t)) !== JSON.stringify(T(s, 0)));

test('one mark: a state is a treatment (palette, brightness, motion), never a shape', () => {
  for (const s of STATUS_ICON_STATES) {
    const tr = T(s, 1.7);
    assert.deepEqual(Object.keys(tr).sort(), ['bright', 'hue', 'pulse', 'sat', 'tint', 'tintAmt', 'twirl'], `${s}: only treatment fields`);
    for (const k of ['bright', 'hue', 'pulse', 'sat', 'tintAmt', 'twirl']) assert.ok(Number.isFinite(tr[k]), `${s}.${k}`);
  }
  assert.throws(() => stateTreatment('warning'), /Unknown status/);
});

test('the state table: tints, brightness, and which states move', () => {
  // Red only for stopped, amber only for needs-you, cyan leaning for listening; nothing else tints.
  const tinted = Object.fromEntries(STATUS_ICON_STATES.map((s) => [s, T(s).tint]));
  assert.deepEqual(tinted, { idle: null, listening: 'cyan', thinking: null, working: null, speaking: null, 'needs-you': 'amber', success: null, paused: null, stopped: 'red', offline: null });
  assert.equal(T('offline').sat, 0, 'offline is greyscale');
  assert.ok(T('paused').sat < 1 && T('paused').bright < 1, 'paused is dimmed');
  const dimmest = Math.min(...STATUS_ICON_STATES.filter((s) => s !== 'offline').map((s) => T(s).bright));
  assert.ok(T('offline').bright < dimmest, 'offline is the dimmest');
  assert.ok(T('working').bright > T('idle').bright, 'working is brighter than idle');
  // Frozen: paused, stopped, offline (and success, whose sweep runs on the model's clock).
  for (const s of ['paused', 'stopped', 'offline', 'success']) assert.equal(moves(s), false, `${s} is still`);
  for (const s of ['idle', 'listening', 'thinking', 'working', 'speaking', 'needs-you']) assert.equal(moves(s), true, `${s} moves`);
  // Reduced motion draws t = 0: no twirl and no pulse, so the frame is the art itself, treated...
  for (const s of STATUS_ICON_STATES) { const tr = T(s, 0); assert.equal(tr.twirl + tr.pulse, 0, `${s} at rest`); }
  // ...and every state's still frame is its own: no two treatments are the same at rest.
  const rest = STATUS_ICON_STATES.map((s) => JSON.stringify(T(s, 0)));
  assert.equal(new Set(rest).size, rest.length, 'every state differs at rest');
  // Listening pulses inward, speaking outward; thinking churns the palette.
  assert.ok(T('listening', 2).pulse > 0 && T('speaking', 0.9).pulse < 0);
  assert.ok(Math.abs(T('thinking', 1.5).hue) > 0.3);
});

test('motion eases in and out over long periods: no linear spin', () => {
  // idle sways over 12 s: at rest at its turns, moving fastest through the middle.
  const speed = (s, t) => Math.abs(T(s, t + 0.01).twirl - T(s, t).twirl);
  assert.ok(speed('idle', 3) * 20 < speed('idle', 0), 'idle at rest at its turn, a quarter period in');
  assert.ok(Math.abs(T('idle', 12).twirl - T('idle', 0).twirl) < 1e-9, 'one idle period is 12 s');
  assert.ok(speed('working', 0) > speed('idle', 0) * 3, 'working moves faster than idle');
  assert.ok(Math.abs(T('listening', 4).pulse - T('listening', 0).pulse) < 1e-9, 'one listening pulse is 4 s');
});
