/** Galaxy theme — canvas-2D homage to the v0.1.0-alpha Three.js brain.
 *
 * Recipe carried over from the original (ForceGraph3D.tsx at that tag):
 * star nodes with breathing glow + white-hot centers, domain colors,
 * neon topic labels, clusters seeded on a Fibonacci sphere, slow orbit,
 * starfield + nebula backdrop, golden core. Bloom is approximated with
 * additive compositing + radial gradients instead of UnrealBloomPass.
 */

import type { GraphNode, GraphEdge } from '../api';
import type { RendererHandle, RendererOpts } from './theme';

const NODE_COLORS: Record<string, string> = {
  topic: '#22d3ee',
  skill: '#fbbf24',
  journal: '#a8a29e',
  source: '#818cf8',
};
const CLUSTER_COLORS = ['#22d3ee', '#4ade80', '#a78bfa', '#fb923c', '#f472b6', '#facc15'];

interface Star3D {
  node: GraphNode;
  x: number; y: number; z: number;
  color: string;
  size: number;
  phase: number;      // breathing offset
  born: number;       // fade-in timestamp
  px?: number; py?: number; pscale?: number; pdepth?: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Deterministic PRNG so the starfield doesn't twinkle on re-render. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fibonacciSphere(i: number, n: number, radius: number) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const y = n === 1 ? 0 : 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(1 - y * y);
  const theta = golden * i;
  return { x: Math.cos(theta) * r * radius, y: y * radius, z: Math.sin(theta) * r * radius };
}

export function createGalaxy(canvas: HTMLCanvasElement, opts?: RendererOpts): RendererHandle {
  const ctx = canvas.getContext('2d')!;
  let stars: Star3D[] = [];
  let links: { a: string; b: string }[] = [];
  let byId = new Map<string, Star3D>();
  let raf = 0;
  let hovered: Star3D | null = null;

  // camera
  let yaw = 0.4, pitch = 0.25, dist = 620;
  const FOV = 520;
  let dragging = false, lastX = 0, lastY = 0, dragDist = 0;
  const autoRotate = true;

  // runtime settings (Brain HUD -> configure())
  let rotationSpeed = 2;                       // multiplier on the base spin
  let labelMode: 'auto' | 'on' | 'off' = 'auto';
  let labelScale = 1;                          // text-size dial

  // clusters: category groupings labelled when zoomed out
  let clusters = new Map<string, { label: string; color: string; ids: string[] }>();

  function clusterKey(n: GraphNode): string {
    if (n.type === 'topic') return n.tags?.[0] ?? 'topics';
    return n.type === 'skill' ? 'skills' : n.type === 'journal' ? 'journals' : 'sources';
  }

  // deterministic backdrop
  const rand = mulberry32(1337);
  const bgStars = Array.from({ length: 220 }, () => ({
    x: rand(), y: rand(), r: rand() * 1.1 + 0.2, a: rand() * 0.5 + 0.15,
  }));

  function layout(nodes: GraphNode[]) {
    // cluster homes per type on a Fibonacci sphere; nodes jitter around home
    const types = [...new Set(nodes.map(n => n.type))].sort();
    const homes = new Map(types.map((t, i) => [t, fibonacciSphere(i, Math.max(types.length, 2), 190)]));
    const prev = byId;

    stars = nodes.map(n => {
      const old = prev.get(n.id);
      if (old) { old.node = n; return old; }
      const home = homes.get(n.type)!;
      const r = mulberry32(hash(n.id));
      const jitter = () => (r() - 0.5) * 170;
      const times = nodes.map(m => m.mtime);
      const lo = Math.min(...times), hi = Math.max(...times);
      const recency = hi > lo ? (n.mtime - lo) / (hi - lo) : 0.5;
      return {
        node: n,
        x: home.x + jitter(), y: home.y + jitter(), z: home.z + jitter(),
        color: n.type === 'topic'
          ? CLUSTER_COLORS[hash(n.tags?.[0] ?? n.id) % CLUSTER_COLORS.length]
          : (NODE_COLORS[n.type] ?? '#a8a29e'),
        size: 5 + recency * 6 + (n.type === 'journal' ? -2 : 0),
        phase: (hash(n.id) % 628) / 100,
        born: performance.now(),
      };
    });
    byId = new Map(stars.map(s => [s.node.id, s]));

    clusters = new Map();
    for (const s of stars) {
      const key = clusterKey(s.node);
      const c = clusters.get(key) ?? { label: key, color: s.color, ids: [] };
      c.ids.push(s.node.id);
      clusters.set(key, c);
    }

    // few relaxation passes: springs on links, mild repulsion inside clusters
    for (let pass = 0; pass < 60; pass++) {
      for (const l of links) {
        const a = byId.get(l.a), b = byId.get(l.b);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const d = Math.hypot(dx, dy, dz) || 1;
        const f = (d - 120) * 0.004;
        a.x += dx / d * f; a.y += dy / d * f; a.z += dz / d * f;
        b.x -= dx / d * f; b.y -= dy / d * f; b.z -= dz / d * f;
      }
      for (let i = 0; i < stars.length; i++) {
        for (let j = i + 1; j < stars.length; j++) {
          const a = stars[i], b = stars[j];
          const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > 0 && d2 < 3600) {
            const d = Math.sqrt(d2), f = (60 - d) * 0.02 / d;
            a.x -= dx * f; a.y -= dy * f; a.z -= dz * f;
            b.x += dx * f; b.y += dy * f; b.z += dz * f;
          }
        }
      }
    }
  }

  function project(s: Star3D) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    let x = s.x * cy - s.z * sy;
    let z = s.x * sy + s.z * cy;
    let y = s.y * cp - z * sp;
    z = s.y * sp + z * cp;
    const depth = z + dist;
    const scale = FOV / Math.max(depth, 60);
    s.px = canvas.width / 2 + x * scale;
    s.py = canvas.height / 2 + y * scale;
    s.pscale = scale;
    s.pdepth = depth;
  }

  function draw(now: number) {
    const w = canvas.width, h = canvas.height;
    if (autoRotate && !dragging) yaw += 0.0016 * rotationSpeed;

    // semantic zoom: g grows as you zoom in. Node titles fade in up close;
    // cluster/category names fade in when zoomed out (like the original's
    // giant topic labels).
    const g0 = FOV / dist;
    const nodeLabelAlpha = labelMode === 'on' ? 1
      : labelMode === 'off' ? 0
      : Math.max(0, Math.min(1, (g0 - 1.0) / 0.4));
    const clusterLabelAlpha = labelMode === 'off' ? 0
      : Math.max(0, Math.min(1, (0.95 - g0) / 0.3));

    // deep space + nebula
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#060505';
    ctx.fillRect(0, 0, w, h);
    const neb1 = ctx.createRadialGradient(w * 0.62, h * 0.42, 0, w * 0.62, h * 0.42, w * 0.5);
    neb1.addColorStop(0, 'rgba(20, 90, 90, 0.10)');
    neb1.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = neb1; ctx.fillRect(0, 0, w, h);
    const neb2 = ctx.createRadialGradient(w * 0.3, h * 0.7, 0, w * 0.3, h * 0.7, w * 0.4);
    neb2.addColorStop(0, 'rgba(60, 50, 120, 0.07)');
    neb2.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = neb2; ctx.fillRect(0, 0, w, h);

    for (const st of bgStars) {
      ctx.fillStyle = `rgba(255,255,255,${st.a})`;
      ctx.fillRect(st.x * w, st.y * h, st.r, st.r);
    }

    for (const s of stars) project(s);
    const ordered = [...stars].sort((a, b) => (b.pdepth ?? 0) - (a.pdepth ?? 0));

    // golden core (the "sun" anchor from v0.1.0-alpha)
    ctx.globalCompositeOperation = 'lighter';
    const core = { x: 0, y: 0, z: 0 } as unknown as Star3D;
    project(core);
    const coreR = 34 * (core.pscale ?? 1) * (1 + Math.sin(now / 1400) * 0.05);
    corePx = core.px!; corePy = core.py!; coreHitR = coreR * 1.4;
    const cg = ctx.createRadialGradient(core.px!, core.py!, 0, core.px!, core.py!, coreR * 2.4);
    cg.addColorStop(0, 'rgba(255, 214, 130, 0.85)');
    cg.addColorStop(0.35, 'rgba(255, 170, 60, 0.25)');
    cg.addColorStop(1, 'rgba(255, 150, 40, 0)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(core.px!, core.py!, coreR * 2.4, 0, Math.PI * 2); ctx.fill();

    // edges — depth-faded additive lines
    for (const l of links) {
      const a = byId.get(l.a), b = byId.get(l.b);
      if (!a?.px || !b?.px) continue;
      const alpha = Math.min(0.35, 90 / Math.max(a.pdepth!, b.pdepth!));
      ctx.strokeStyle = `rgba(90, 160, 200, ${alpha})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(a.px!, a.py!); ctx.lineTo(b.px!, b.py!); ctx.stroke();
    }

    // stars: glow sprite + white-hot center, breathing (from the original shader)
    for (const s of ordered) {
      if (s.px == null) continue;
      const breathe = 1 + Math.sin(now / 2500 + s.phase) * 0.08;
      const birth = Math.min(1, (now - s.born) / 900);
      const r = s.size * (s.pscale ?? 1) * breathe * (s === hovered ? 1.35 : 1);
      const depthFade = Math.min(1, 420 / (s.pdepth ?? 420));
      const alpha = (s.node.type === 'journal' ? 0.5 : 0.95) * depthFade * birth;

      const g = ctx.createRadialGradient(s.px, s.py!, 0, s.px, s.py!, r * 2.6);
      g.addColorStop(0, s.color);
      g.addColorStop(0.4, s.color + '55');
      g.addColorStop(1, s.color + '00');
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(s.px, s.py!, r * 2.6, 0, Math.PI * 2); ctx.fill();

      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath(); ctx.arc(s.px, s.py!, r * 0.32, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.textAlign = 'center';

    // core identity label — the golden orb is Nova itself, the anchor the
    // memories orbit
    if (core.px != null) {
      ctx.font = `500 ${Math.min(14, Math.max(11, 12 * (core.pscale ?? 1))) * labelScale}px system-ui`;
      ctx.shadowColor = '#ffd682';
      ctx.shadowBlur = 12;
      ctx.fillStyle = 'rgba(255, 236, 200, 0.9)';
      ctx.fillText('Nova', core.px, core.py! + coreR * 2.4 + 16);
      ctx.shadowBlur = 0;
    }

    // node titles — fade in as you zoom near (or forced by label mode);
    // hover always shows
    for (const s of ordered) {
      if (s.px == null) continue;
      const alphaBase = s === hovered ? 1 : nodeLabelAlpha;
      if (alphaBase <= 0.02) continue;
      if (s.node.type === 'journal' && s !== hovered && labelMode !== 'on') continue;
      const depthFade = Math.min(1, 380 / (s.pdepth ?? 380));
      const alpha = alphaBase * (s === hovered ? 1 : 0.9 * depthFade);
      if (alpha <= 0.03) continue;
      // clamp: labels must not balloon as the camera closes in
      const size = Math.min(15, Math.max(10, 13 * (s.pscale ?? 1))) * labelScale;
      ctx.font = `500 ${size}px system-ui`;
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = s === hovered ? '#ffffff' : `rgba(235, 250, 250, ${alpha})`;
      const text = s.node.label.length > 30 ? s.node.label.slice(0, 28) + '…' : s.node.label;
      ctx.fillText(text, s.px, s.py! + s.size * (s.pscale ?? 1) * 2.6 + size);
      ctx.shadowBlur = 0;
    }

    // cluster/category names — the zoomed-out view (big neon words)
    if (clusterLabelAlpha > 0.02) {
      for (const c of clusters.values()) {
        let cx = 0, cy = 0, cd = 0, count = 0;
        for (const id of c.ids) {
          const s = byId.get(id);
          if (!s?.px) continue;
          cx += s.px; cy += s.py!; cd += s.pdepth ?? dist; count++;
        }
        if (!count) continue;
        cx /= count; cy /= count; cd /= count;
        const depthFade = Math.min(1, 500 / cd);
        const size = Math.min(20, Math.max(13, 22 * (FOV / cd))) * labelScale;
        ctx.font = `600 ${size}px system-ui`;
        ctx.shadowColor = c.color;
        ctx.shadowBlur = 14;
        ctx.fillStyle = `rgba(240, 253, 250, ${0.85 * clusterLabelAlpha * depthFade})`;
        ctx.fillText(c.label, cx, cy - size * 0.4);
        ctx.shadowBlur = 0;
      }
    }

    raf = requestAnimationFrame(draw);
  }

  // the core's projected position, refreshed each frame for hit-testing
  let corePx = 0, corePy = 0, coreHitR = 0;

  function hitTest(x: number, y: number): Star3D | null {
    let best: Star3D | null = null;
    let bestD = Infinity;
    for (const s of stars) {
      if (s.px == null) continue;
      const r = Math.max(10, s.size * (s.pscale ?? 1) * 2);
      const d = (s.px - x) ** 2 + (s.py! - y) ** 2;
      if (d <= r * r && d < bestD) { best = s; bestD = d; }
    }
    return best;
  }

  const onPointerDown = (e: PointerEvent) => {
    dragging = true; dragDist = 0; lastX = e.offsetX; lastY = e.offsetY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (dragging) {
      dragDist += Math.abs(e.offsetX - lastX) + Math.abs(e.offsetY - lastY);
      yaw += (e.offsetX - lastX) * 0.005;
      pitch = Math.max(-1.3, Math.min(1.3, pitch + (e.offsetY - lastY) * 0.005));
      lastX = e.offsetX; lastY = e.offsetY;
    } else {
      hovered = hitTest(e.offsetX, e.offsetY);
      canvas.style.cursor = hovered ? 'pointer' : 'grab';
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
    if (dragDist < 4) {
      const hit = hitTest(e.offsetX, e.offsetY);
      if (hit) {
        opts?.onNodeClick?.(hit.node.id);
      } else if ((e.offsetX - corePx) ** 2 + (e.offsetY - corePy) ** 2 <= coreHitR ** 2) {
        opts?.onNodeClick?.('soul.md'); // the core IS Nova — open the soul
      } else {
        opts?.onNodeClick?.(null);
      }
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    dist = Math.max(220, Math.min(1600, dist * (e.deltaY > 0 ? 1.08 : 1 / 1.08)));
  };
  const onLeave = () => { hovered = null; };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  raf = requestAnimationFrame(draw);

  return {
    setData(nodes: GraphNode[], edges: GraphEdge[]) {
      links = edges.map(e => ({ a: e.source, b: e.target }));
      layout(nodes);
    },
    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
    },
    recenter() {
      yaw = 0.4; pitch = 0.25; dist = 620;
    },
    configure(options: Record<string, unknown>) {
      if (typeof options.rotationSpeed === 'number') rotationSpeed = options.rotationSpeed;
      if (typeof options.labelScale === 'number') labelScale = options.labelScale;
      if (options.labelMode === 'auto' || options.labelMode === 'on' || options.labelMode === 'off') {
        labelMode = options.labelMode;
      }
    },
    destroy() {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
