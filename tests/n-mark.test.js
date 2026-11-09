// The supernova N's path data (ui/js/n-mark.js; owner direction 2026-11-08, single mark, step 1):
// three constructions, each at its large and small size, with a closed dark core, three strokes
// that make an N (two uprights and a diagonal from top left to bottom right), and nothing outside
// the canvas; and the ribbon the shared shader takes, in whole passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N_MARK_VARIANTS, nMarkShape, ribbonPasses, rimPass, spline } from '../ui/js/n-mark.js';
import { RIBBON_POINTS } from '../ui/js/status-icon.js';

const IDS = ['accretion', 'swirl', 'eclipse'];
const SIZES = [['large', false], ['small', true]];
// The shader fades its glow out from 0.9 of the half-canvas: a ribbon stays inside that.
const FIT = 0.92;

// The nearest any stroke's ribbon (its centre line widened by its half-width) comes to the centre.
function closest(strokes) {
  let best = Infinity;
  for (const { points } of strokes) {
    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const h = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / Math.max(dx * dx + dy * dy, 1e-12)));
      best = Math.min(best, Math.hypot(a[0] + dx * h, a[1] + dy * h) - (a[2] + (b[2] - a[2]) * h));
    }
  }
  return best;
}

test('three constructions, A, B and C, each named plainly', () => {
  assert.deepEqual(N_MARK_VARIANTS.map((v) => v.id), IDS);
  assert.deepEqual(N_MARK_VARIANTS.map((v) => v.letter), ['A', 'B', 'C']);
  assert.deepEqual(N_MARK_VARIANTS.map((v) => v.name), ['Accretion N', 'Swirl N', 'Eclipse N']);
  for (const v of N_MARK_VARIANTS) assert.ok(v.about.length > 40, `${v.id} says what it is`);
  assert.throws(() => nMarkShape('script-n'), /Unknown N mark: script-n/);
});

for (const id of IDS) {
  for (const [size, small] of SIZES) {
    test(`${id} (${size}): three strokes make an N round a closed dark core, inside the canvas`, () => {
      const shape = nMarkShape(id, small);
      assert.deepEqual(shape.strokes.map((s) => s.name), ['left', 'diagonal', 'right'], 'two uprights and a diagonal');
      for (const { name, points } of shape.strokes) {
        assert.ok(points.length >= 2, `${name}: a stroke`);
        for (const p of points) {
          assert.equal(p.length, 4);
          assert.ok(p.every(Number.isFinite), `${name}: finite`);
          assert.ok(p[2] > 0, `${name}: has width`);
          assert.ok(p[3] >= 0 && p[3] <= 1, `${name}: on the nebula ramp`);
          assert.ok(Math.abs(p[0]) + p[2] <= FIT && Math.abs(p[1]) + p[2] <= FIT, `${name}: ${p.map((v) => v.toFixed(2))} fits the canvas`);
        }
      }
      // The letter: the uprights stand at the left and right edges, top to bottom; the diagonal
      // runs from the top of the left to the bottom of the right, through the centre.
      const [left, diagonal, right] = shape.strokes.map((s) => s.points);
      const spans = (pts, side) => pts.some(([x, y]) => side * x > 0.45 && y > 0.5) && pts.some(([x, y]) => side * x > 0.45 && y < -0.5);
      assert.ok(spans(left, -1), 'the left upright runs top to bottom on the left');
      assert.ok(spans(right, 1), 'the right upright runs top to bottom on the right');
      assert.ok(left.every(([x]) => x < 0) && right.every(([x]) => x > 0), 'each upright keeps to its side');
      const [d0, d1] = [diagonal[0], diagonal.at(-1)];
      assert.ok(d0[0] < -0.45 && d0[1] > 0.5, 'the diagonal starts top left');
      assert.ok(d1[0] > 0.45 && d1[1] < -0.5, 'and ends bottom right');
      // The core: a closed black disc at the centre. Drawn over the ribbon, it closes by itself;
      // drawn under it, no ribbon may cross into it.
      const { r, soft, over } = shape.core;
      assert.ok(r >= 0.15 && r <= 0.3 && soft >= 0, `a core of radius ${r}`);
      if (!over) assert.ok(closest(shape.strokes) >= r, `the ribbon clears the core (${closest(shape.strokes).toFixed(3)} ≥ ${r})`);
      if (shape.continuous) {
        for (let i = 1; i < 3; i++) assert.deepEqual(shape.strokes[i].points[0], shape.strokes[i - 1].points.at(-1), 'one continuous ribbon');
      }
      if (shape.rim) assert.ok(shape.rim.r - shape.rim.w >= r - 0.01 && shape.rim.r + shape.rim.w < 0.4, 'the horizon rings the core');
    });
  }
}

test('each construction is its own: B is the continuous ribbon, C has the horizon, A neither', () => {
  const [a, b, c] = IDS.map((id) => nMarkShape(id));
  assert.deepEqual([a.continuous, b.continuous, c.continuous], [false, true, false]);
  assert.deepEqual([!!a.rim, !!b.rim, !!c.rim], [false, false, true]);
  assert.deepEqual([a.core.over, b.core.over, c.core.over], [true, false, true], 'B’s ribbon lies over its core; A’s and C’s core swallows the diagonal');
  // Small sizes keep the silhouette but thicken it (no hairline uprights).
  for (const id of IDS) {
    const thin = (s) => Math.min(...s.strokes.filter((x) => x.name !== 'diagonal').flatMap((x) => x.points.slice(1, -1).map((p) => p[2])));
    assert.ok(thin(nMarkShape(id, true)) >= 0.1, `${id}: no hairline at 16 px`);
  }
});

test('the ribbon the shared shader takes: whole passes, each stroke starting fresh', () => {
  for (const id of IDS) {
    for (const [, small] of SIZES) {
      const shape = nMarkShape(id, small);
      const passes = ribbonPasses(shape);
      assert.ok(passes.length >= 1 && passes.length <= 3, `${id}: ${passes.length} passes`);
      for (const p of passes) {
        assert.equal(p.length, RIBBON_POINTS * 5);
        assert.ok([...p].every(Number.isFinite));
        assert.equal(p[4], 0, 'a pass starts a stroke');
      }
      const drawn = passes.reduce((n, p) => n + [...p.keys()].filter((i) => i % 5 === 2 && p[i] > 0).length, 0);
      const points = shape.strokes.reduce((n, s) => n + s.points.length, 0);
      if (shape.continuous) assert.ok(drawn >= points - 2, `${id}: the whole ribbon, its joints shared`);
      else assert.equal(drawn, points, `${id}: every point`);
    }
  }
  assert.throws(() => ribbonPasses({ continuous: false, strokes: [{ name: 'x', points: spline([[0, 0, 0.1, 0], [0.1, 0.1, 0.1, 1]], RIBBON_POINTS + 1) }] }), /longer than one pass/);
  const rim = rimPass({ r: 0.27, w: 0.03, u: 0.9 });
  assert.equal(rim.length, RIBBON_POINTS * 5);
  assert.ok(Math.hypot(rim[0] - rim[(RIBBON_POINTS - 1) * 5], rim[1] - rim[(RIBBON_POINTS - 1) * 5 + 1]) < 1e-6, 'the horizon is a closed ring');
});
