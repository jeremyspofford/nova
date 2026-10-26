// Where each body sits. Pure and deterministic: the same files always give
// the same sky, so a planet is where you left it on every visit. Positions are
// world units; the camera decides how big that is on screen.
//
// The Nova is the origin. Constellations ring it, each holding its members
// close; planets outside a constellation sit nearer the core the more salient
// they are; stars (goals) keep a wider orbit, mostly overhead; comets travel
// near what they mention; asteroids drift in a belt beyond everything.

export const ORBIT_TILT = 0.42; // orbits are ellipses seen from slightly above: 2.5D, fixed up
const PLANE = 0.62;             // the system's plane, foreshortened the same way, more gently

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
const TAU = Math.PI * 2;
const unit = (seed, k = 0) => {
  // xorshift on the seed, so each call site gets its own stable number in [0, 1)
  let x = (seed ^ (0x9e3779b9 * (k + 1))) >>> 0;
  x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
  return x / 4294967296;
};

export function radiusOf(n) {
  const s = n.salience ?? 0.4;
  switch (n.type) {
    case 'core': return 40;
    case 'star': return 8 + 9 * s;
    case 'planet':
      if (n.kind === 'topic') return 48 + 62 * s;
      return (n.owner ? 58 : 26) + 50 * s;
    case 'moon': return n.kind === 'stack' ? 9 : n.kind === 'file' ? 7.5 : 6 + unit(n.seed, 3) * 2.5;
    case 'comet': return 3.6;
    case 'asteroid': return n.kind === 'stack' ? 7 : 2.6 + unit(n.seed, 4) * 3.2;
    default: return 5;
  }
}

export function layout(data) {
  const nodes = data.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pos = new Map();
  const put = (n, x, y, extra = {}) => pos.set(n.id, { x, y, r: radiusOf(n), ...extra });

  const core = byId.get('core');
  if (core) put(core, 0, 0);

  // ---- moons need their parent's size first, to know how far their orbits reach
  const moonsOf = new Map();
  for (const n of nodes) if (n.type === 'moon' && n.parent) {
    if (!moonsOf.has(n.parent)) moonsOf.set(n.parent, []);
    moonsOf.get(n.parent).push(n);
  }
  const reach = (n) => {
    const r = radiusOf(n);
    const k = moonsOf.get(n.id)?.length ?? 0;
    const ring = n.pinned && n.type === 'planet' ? r * 2.2 : r;
    return Math.max(ring, k ? r * 1.7 + 12 + Math.min(k, 14) * 7 : r) + 26;
  };

  // ---- constellations and lone planets, spaced evenly round the core ---------
  const clusters = (data.clusters ?? []).filter((c) => c.members.some((id) => byId.get(id)?.cluster === c.id));
  const tops = nodes.filter((n) => n.type === 'planet' || n.type === 'star');
  const ownerCluster = byId.get(data.owner)?.cluster;
  const units = [
    ...clusters.map((c) => ({ cluster: c, members: c.members.map((id) => byId.get(id)).filter((m) => m && m.cluster === c.id)
      .sort((a, b) => (b.owner ? 1 : 0) - (a.owner ? 1 : 0) || (b.salience ?? 0) - (a.salience ?? 0)) })),
    ...tops.filter((n) => n.type === 'planet' && !n.cluster).sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0)).map((n) => ({ members: [n] })),
  ];
  // The owner sits lower left, where the eye lands first; the rest follow round.
  units.sort((a, b) => (isOwner(b) ? 1 : 0) - (isOwner(a) ? 1 : 0));
  function isOwner(u) { return u.members.some((m) => m.owner) || (ownerCluster && u.cluster?.id === ownerCluster); }
  const placedClusters = [];
  units.forEach((u, i) => {
    const seed = u.cluster?.seed ?? u.members[0].seed;
    const angle = 2.45 + i * (TAU / Math.max(units.length, 3)) + (i ? (unit(seed, 1) - 0.5) * 0.35 : 0);
    const [hub, ...rest] = u.members;
    // Members round the hub, evenly, the first on the side away from the core.
    const step = Math.min(Math.PI * 1.15 / Math.max(rest.length, 1), Math.PI * 0.4);
    const ring = rest.map((m, j) => ({ m, a: angle + (j - (rest.length - 1) / 2) * step, d: reach(hub) * 0.8 + reach(m) * 0.8 }));
    const span = ring.length ? Math.max(...ring.map((x) => x.d + reach(x.m))) : reach(hub);
    const s = hub.salience ?? 0.4;
    const dist = 110 + span * (ring.length ? 0.85 : 1) + (u.cluster ? 0 : 90 * (1 - s));
    // The system's plane is seen from above at a slant, so the sky is wider than tall.
    const cx = Math.cos(angle) * dist;
    const cy = Math.sin(angle) * dist * PLANE;
    put(hub, cx, cy);
    for (const { m, a, d } of ring) put(m, cx + Math.cos(a) * d, cy + Math.sin(a) * d * PLANE);
    if (u.cluster) placedClusters.push({ id: u.cluster.id, name: u.cluster.name, x: cx, y: cy, seed, members: u.members.map((m) => m.id) });
  });

  // ---- stars: a wider orbit, across the upper sky ------------------------------
  const stars = tops.filter((n) => n.type === 'star').sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0));
  stars.forEach((n, i) => {
    const s = n.salience ?? 0.4;
    const a = -Math.PI * (0.18 + 0.64 * ((i + 0.5) / stars.length)) + (unit(n.seed, 1) - 0.5) * 0.3;
    const d = 400 + 120 * (1 - s) + 50 * unit(n.seed, 2);
    put(n, Math.cos(a) * d, Math.sin(a) * d * PLANE);
  });

  // ---- settle: push apart anything whose moon systems would touch ----------
  const movable = tops.filter((n) => pos.has(n.id));
  for (let it = 0; it < 80; it++) {
    let moved = false;
    for (let i = 0; i < movable.length; i++) {
      const a = pos.get(movable[i].id);
      // keep clear of the core's glare
      const dc = Math.hypot(a.x, a.y);
      const minCore = 120 + reach(movable[i]);
      if (dc < minCore) { const k = (minCore - dc) / (dc || 1) * 0.5; a.x += a.x * k || minCore * 0.5; a.y += a.y * k; moved = true; }
      for (let j = i + 1; j < movable.length; j++) {
        const b = pos.get(movable[j].id);
        const dx = b.x - a.x; const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        const min = reach(movable[i]) + reach(movable[j]) + 18;
        if (d < min) {
          const push = (min - d) / 2;
          const ux = dx / d; const uy = dy / d;
          a.x -= ux * push; a.y -= uy * push; b.x += ux * push; b.y += uy * push;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  for (const c of placedClusters) {
    const pts = c.members.map((id) => pos.get(id));
    c.x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    c.y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    c.r = Math.max(...c.members.map((id) => { const p = pos.get(id); return Math.hypot(p.x - c.x, p.y - c.y) + reach(byId.get(id)); })) + 60;
  }

  // ---- moons on visible orbits ------------------------------------------------
  for (const [parentId, moons] of moonsOf) {
    const parent = pos.get(parentId);
    if (!parent) continue;
    const pr = parent.r;
    moons.forEach((m, i) => {
      const k = Math.min(i, 14);
      const orbit = pr * (parentId === 'core' ? 2.1 : 1.7) + 12 + k * 7 + (i > 14 ? (i - 14) * 2 : 0);
      const phase = unit(m.seed, 1) * TAU;
      // Inner moons a little quicker, as they would be; all of it barely perceptible.
      const speed = (0.012 + 0.02 * unit(m.seed, 2)) * Math.sqrt(40 / orbit);
      put(m, parent.x, parent.y, { orbit: { parent: parentId, radius: orbit, phase, speed } });
    });
  }

  // ---- comets near what they mention ------------------------------------------
  for (const n of nodes.filter((x) => x.type === 'comet')) {
    const near = (n.near ?? []).map((id) => pos.get(id)).find(Boolean);
    const a = unit(n.seed, 1) * TAU;
    let x; let y;
    if (near) { const d = near.r * 2.6 + 70 + 40 * unit(n.seed, 2); x = near.x + Math.cos(a) * d; y = near.y + Math.sin(a) * d * 0.8; }
    else { const d = 380 + 140 * unit(n.seed, 2); x = Math.cos(a) * d; y = Math.sin(a) * d; }
    put(n, x, y, { age: n.age ?? 0 });
  }

  // ---- the belt ----------------------------------------------------------------
  let extent = 320;
  for (const [id, p] of pos) if (!p.orbit && byId.get(id)?.type !== 'comet') extent = Math.max(extent, Math.hypot(p.x, p.y) + reach(byId.get(id)));
  const rocks = nodes.filter((x) => x.type === 'asteroid');
  rocks.forEach((n, i) => {
    const a = (i * GOLDEN + unit(n.seed, 1) * 0.6) % TAU;
    const d = extent + 120 + (unit(n.seed, 2) - 0.5) * 90;
    put(n, Math.cos(a) * d, Math.sin(a) * d * 0.86);
  });

  return { pos, clusters: placedClusters, extent, belt: rocks.length ? extent + 120 : 0 };
}

// A moon's place at time t (seconds), and whether it is in front of its parent.
export function orbitAt(p, parent, t) {
  const a = p.orbit.phase + t * p.orbit.speed;
  return { x: parent.x + Math.cos(a) * p.orbit.radius, y: parent.y + Math.sin(a) * p.orbit.radius * ORBIT_TILT, front: Math.sin(a) > 0 };
}

// The box that frames the galaxy view: everything but the belt.
export function bounds(lay, data) {
  const types = new Map((data.nodes ?? []).map((n) => [n.id, n.type]));
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [id, p] of lay.pos) {
    const t = types.get(id);
    if (t !== 'planet' && t !== 'star' && t !== 'core') continue;
    x0 = Math.min(x0, p.x - p.r); x1 = Math.max(x1, p.x + p.r);
    y0 = Math.min(y0, p.y - p.r); y1 = Math.max(y1, p.y + p.r);
  }
  if (!Number.isFinite(x0)) return { x0: -200, y0: -200, x1: 200, y1: 200 };
  return { x0, y0, x1, y1 };
}
