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
  for (const status of JARVIS_STATES.filter((s) => s !== 'offline')) { // offline has no ticks at any size
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

// The arcs a state draws, from its dash arrays: [start°, length°] for each dash, wrapped to 0..360.
function arcs(svg, cls) {
  const out = [];
  for (const m of svg.matchAll(/<circle [^>]*class="([^"]+)"[^>]*>/g)) {
    if (!m[1].split(' ').includes(cls)) continue;
    const dash = /stroke-dasharray="([\d. ]+)"/.exec(m[0]);
    const at = -Number(/stroke-dashoffset="(-?[\d.]+)"/.exec(m[0])?.[1] ?? 0);
    if (!dash) { out.push([0, 360]); continue; }
    const [on, off] = dash[1].split(' ').map(Number);
    for (let a = at; a < at + 360 - 1e-6; a += on + off) out.push([((a % 360) + 360) % 360, on]);
  }
  return out;
}
const width = (svg, cls) => Number(new RegExp(`class="${cls}" style="stroke-width: ([\\d.]+)`).exec(svg)?.[1]);

test('stopped, paused and needs-you differ by structure at 16 px, not only by where the gaps are', () => {
  for (const size of [16, 96]) {
    const stopped = jarvisRing({ status: 'stopped', size }), paused = jarvisRing({ status: 'paused', size }), needs = jarvisRing({ status: 'needs-you', size }), idle = jarvisRing({ status: 'idle', size });
    // Stopped: three heavy segments, gaps of 48° evenly at 60°, 180° and 300°.
    assert.deepEqual(arcs(stopped, 'jv-red').map(([a, l]) => [Math.round(a), l]), [[324, 72], [84, 72], [204, 72]], `${size}: stopped`);
    assert.ok(width(stopped, 'jv-red') > width(idle, 'jv-c'), `${size}: stopped heavier than idle`);
    // Paused: two halves, gaps of 70° at the top and the bottom.
    assert.deepEqual(arcs(paused, 'jv-c'), [[35, 110], [215, 110]], `${size}: paused brackets`);
    // Needs-you: one amber arc of 60–75°, heavier than the ring, across the top, and one gap.
    const [[aAt, aLen]] = arcs(needs, 'jv-amber');
    assert.ok(aLen >= 60 && aLen <= 76 && (aAt + aLen) % 360 < 60 && aAt > 300, `${size}: amber ${aAt}+${aLen}`);
    assert.ok(width(needs, 'jv-amber') > width(needs, 'jv-c'), `${size}: amber heavier`);
    const [[cAt, cLen]] = arcs(needs, 'jv-c');
    assert.equal(Math.round(cAt + cLen) % 360, Math.round(aAt), `${size}: the ring meets the amber arc on one side (one gap only)`);
    assert.ok(cAt - (aAt + aLen - 360) >= 30, `${size}: and leaves a clear gap on the other`);
  }
});

test('success differs from idle by structure, moving or still: a sweep arc with a bright head', () => {
  for (const size of [16, 96]) for (const reduced of [false, true]) {
    const svg = jarvisRing({ status: 'success', size, reduced });
    assert.equal(arcs(svg, 'jv-flash').length, 1, `${size}${reduced ? ' reduced' : ''}: a head`);
    assert.equal(arcs(svg, 'jv-tail').length, 1, 'a tail');
    assert.ok(arcs(svg, 'jv-base').some(([, l]) => l === 360), 'over the full ring');
    assert.ok(width(svg, 'jv-hi jv-tail') > width(svg, 'jv-c jv-base'), 'the sweep is heavier than the ring');
  }
});

test('offline: dashed, dim, and no ticks at any size', () => {
  for (const size of SIZES) {
    const svg = jarvisRing({ status: 'offline', size });
    assert.equal(circles(svg), 1, `${size}: one dashed ring only`);
    assert.match(svg, /class="jv-grey"[^>]*stroke-dasharray/);
  }
  assert.ok(circles(jarvisRing({ status: 'idle', size: 96 })) > 1, 'idle keeps its ticks');
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
