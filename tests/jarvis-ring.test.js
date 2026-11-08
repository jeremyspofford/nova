// Jarvis rings (ui/js/jarvis-ring.js; owner direction 2026-11-08, step 1): the pure renderer draws
// every state and refuses unknown ones, gets coarser and heavier at 24 px and under, has no motion
// under reduced motion, takes an amplitude for speaking; the model morphs in 800 ms and success
// settles to idle by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JARVIS_MORPH_MS, JARVIS_STATES, JARVIS_SUCCESS_MS, JarvisModel, jarvisRing, jarvisTier } from '../ui/js/jarvis-ring.js';
import { STATUS_ICON_STATES } from '../ui/js/status-icon.js';

const SIZES = [16, 24, 48, 96, 200];
const circles = (svg) => svg.match(/<circle /g)?.length ?? 0;
const widths = (svg) => [...svg.matchAll(/stroke-width: ([\d.]+)/g)].map((m) => Number(m[1]));
const motion = (svg) => [...svg.matchAll(/\bjv-(a-[\w-]+|amp)\b/g)].map((m) => m[1]);

test('the same states as the status icon, and nothing else', () => {
  assert.deepEqual(JARVIS_STATES, STATUS_ICON_STATES);
  for (const bad of ['happy', 'error', null, '']) assert.throws(() => jarvisRing({ status: bad }), /Unknown status/);
  assert.throws(() => jarvisRing({ status: 'idle', size: 0 }), /Bad size/);
  assert.throws(() => jarvisRing({ status: 'speaking', amplitude: Number.NaN }), /Bad amplitude/);
  assert.throws(() => new JarvisModel('happy'), /Unknown status: happy/);
});

test('every state renders at every size: one SVG, named by its state and size class', () => {
  for (const status of JARVIS_STATES) for (const size of SIZES) for (const reduced of [false, true]) {
    const svg = jarvisRing({ status, size, reduced });
    assert.match(svg, /^<svg [^>]*viewBox="0 0 100 100"[^>]*>.*<\/svg>$/s, `${status} ${size}`);
    assert.ok(svg.includes(`data-state="${status}"`) && svg.includes(`width="${size}"`), `${status} ${size}: labelled`);
    assert.ok(circles(svg) >= 1, `${status} ${size}: draws something`);
    assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|rgba?\(|stroke="(?!currentColor)/i, 'colours come from the surface’s custom properties');
  }
});

test('no two states draw the same rings, at 16 px or at the hero size, moving or still', () => {
  for (const size of [16, 200]) for (const reduced of [false, true]) {
    const drawn = JARVIS_STATES.map((status) => jarvisRing({ status, size, reduced }).replace(/data-state="[^"]+"/, ''));
    assert.equal(new Set(drawn).size, drawn.length, `${size} px${reduced ? ', reduced' : ''}`);
  }
});

test('at 24 px and under: no ticks, fewer segments, heavier strokes', () => {
  assert.equal(jarvisTier(16), 's');
  assert.equal(jarvisTier(24), 's');
  assert.equal(jarvisTier(25), 'm');
  for (const status of JARVIS_STATES) {
    const small = jarvisRing({ status, size: 16 }), big = jarvisRing({ status, size: 96 });
    assert.ok(circles(small) < circles(big), `${status}: fewer pieces small (${circles(small)} vs ${circles(big)})`);
    assert.ok(Math.min(...widths(small)) > Math.max(...widths(big).filter((w) => w < 4.5)), `${status}: heavier strokes small`);
  }
  const segs = (size) => jarvisRing({ status: 'listening', size }).match(/jv-a-seg/g).length;
  assert.ok(segs(16) < segs(48) && segs(48) < segs(96), 'listening: fewer segments as it shrinks');
});

test('reduced motion: no animation classes at all, still configurations', () => {
  for (const status of JARVIS_STATES) for (const size of SIZES) {
    const svg = jarvisRing({ status, size, reduced: true });
    assert.deepEqual(motion(svg), [], `${status} ${size}`);
    assert.match(svg, /data-reduced/);
  }
  // Moving states do move when motion is allowed (all but the still ones: paused, stopped, offline).
  for (const status of JARVIS_STATES.filter((s) => !['paused', 'stopped', 'offline'].includes(s))) assert.ok(motion(jarvisRing({ status, size: 48 })).length, `${status} moves`);
  for (const status of ['paused', 'stopped', 'offline']) assert.deepEqual(motion(jarvisRing({ status, size: 96 })), [], `${status} is still`);
  // Working still shows how far along it is: part of its progress arc lit, the rest dim.
  assert.match(jarvisRing({ status: 'working', size: 96, reduced: true }), /opacity="0.2"/);
});

test('red only for stopped, amber only for needs-you', () => {
  for (const status of JARVIS_STATES) for (const size of [16, 96]) {
    const svg = jarvisRing({ status, size });
    assert.equal(/jv-red/.test(svg), status === 'stopped', `${status}: red`);
    assert.equal(/jv-amber/.test(svg), status === 'needs-you', `${status}: amber`);
  }
});

test('speaking: a gentle pulse by default, the voice’s amplitude when given (clamped to 0..1)', () => {
  const plain = jarvisRing({ status: 'speaking', size: 96 });
  assert.match(plain, /jv-a-pulse/);
  assert.doesNotMatch(plain, /--jv-amp/);
  const voiced = jarvisRing({ status: 'speaking', size: 96, amplitude: 0.4 });
  assert.match(voiced, /class="jv-amp"/);
  assert.doesNotMatch(voiced, /jv-a-pulse/);
  assert.match(voiced, /--jv-amp: 0.4"/);
  assert.match(jarvisRing({ status: 'speaking', size: 96, amplitude: 3 }), /--jv-amp: 1"/);
  assert.doesNotMatch(jarvisRing({ status: 'idle', size: 96, amplitude: 0.4 }), /--jv-amp/, 'only speaking reads it');
  assert.deepEqual(motion(jarvisRing({ status: 'speaking', size: 96, amplitude: 0.4, reduced: true })), [], 'reduced: still, even with a voice');
});

test('a morph takes 800 ms, eased, and a change mid-morph starts from what is on screen', () => {
  assert.equal(JARVIS_MORPH_MS, 800);
  const m = new JarvisModel('idle', 0);
  m.set('working', 1000);
  assert.deepEqual(m.weights(1000), { idle: 1, working: 0 });
  const q = m.weights(1200), h = m.weights(1400);
  assert.ok(q.working < 0.25 && h.working === 0.5, `soft in: ${q.working} at a quarter, ${h.working} at half`);
  assert.deepEqual(m.weights(1800), { idle: 0, working: 1 });
  assert.equal(m.moving(1800), false);
  m.set('idle', 2000);
  const before = m.weights(2300);
  m.set('needs-you', 2300);
  assert.deepEqual(m.weights(2300), { ...before, 'needs-you': 0 }, 'no jump');
});

test('success settles to idle by itself, moving or reduced', () => {
  for (const reduced of [false, true]) {
    const m = new JarvisModel('working', 0);
    m.reduced = reduced;
    m.set('success', 5000);
    assert.equal(m.status(5000 + JARVIS_SUCCESS_MS - 1), 'success');
    assert.equal(m.moving(5000 + JARVIS_SUCCESS_MS - 1), true, 'a flourish keeps drawing');
    assert.equal(m.status(5000 + JARVIS_SUCCESS_MS), 'idle');
    assert.equal(m.status(5000 + JARVIS_SUCCESS_MS + JARVIS_MORPH_MS), 'idle');
    assert.equal(m.weights(5000 + JARVIS_SUCCESS_MS + JARVIS_MORPH_MS).idle, 1, `${reduced ? 'reduced: ' : ''}ends on idle alone`);
  }
});
