/** 2D force-directed brain renderer (canvas, d3-force). */

import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation,
  type Simulation, type SimulationNodeDatum,
} from 'd3';
import type { GraphNode, GraphEdge } from '../api';
import type { LegendEntry, RendererHandle, RendererOpts } from './theme';

interface SimNode extends SimulationNodeDatum {
  id: string;
  label: string;
  type: string;
  mtime: number;
  enabled?: boolean;
}
interface SimLink { source: string | SimNode; target: string | SimNode; kind: string }

const NODE_COLORS: Record<string, string> = {
  topic: '#24C9B8',      // teal — knowledge
  skill: '#FBBF24',      // amber — behavior
  journal: '#78716C',    // stone — episodic, dim
  source: '#60A5FA',     // blue — external
  core: '#FACC15',       // gold — Nova herself
  user: '#93C5FD',       // blue-white — the operator, Nova's companion star
  agent: '#8B5CF6',      // violet — capabilities
  tool: '#84A98C',       // sage — what agents may do
  automation: '#3B82F6', // blue — habits
  rule: '#EF4444',       // red — boundaries
};

const EDGE_COLORS: Record<string, string> = {
  link: 'rgba(36,201,184,0.35)',
  platform: 'rgba(139,92,246,0.30)',
  grant: 'rgba(132,169,140,0.25)',
  guard: 'rgba(239,68,68,0.35)',
  bond: 'rgba(250,204,21,0.35)',
  about: 'rgba(250,204,21,0.28)',   // personal fact → the operator (bond family)
  writes: 'rgba(59,130,246,0.30)',  // automation → the doc it maintains
};

export const GRAPH_LEGEND: LegendEntry[] = [
  { key: 'core', color: NODE_COLORS.core, label: 'Nova' },
  { key: 'user', color: NODE_COLORS.user, label: 'You' },
  { key: 'topic', color: NODE_COLORS.topic, label: 'Memories' },
  { key: 'journal', color: NODE_COLORS.journal, label: 'Journals' },
  { key: 'source', color: NODE_COLORS.source, label: 'Sources' },
  { key: 'agent', color: NODE_COLORS.agent, label: 'Agents' },
  { key: 'tool', color: NODE_COLORS.tool, label: 'Tools' },
  { key: 'automation', color: NODE_COLORS.automation, label: 'Automations' },
  { key: 'rule', color: NODE_COLORS.rule, label: 'Rules' },
  { key: 'skill', color: NODE_COLORS.skill, label: 'Skills' },
];


// A cheap identity for a graph dataset: enough to tell "the poll returned
// the same thing again" from a real change, without JSON.stringify-ing the
// whole node+edge array on every tick the way universe.ts does.
function graphFingerprint(nodes: GraphNode[], edges: GraphEdge[]): string {
  // Same shape universe.ts has always used, and for the same reason: a
  // count-and-max-mtime fingerprint silently misses the platform half of
  // the graph. Agents, tools, automations and rules are all stamped with a
  // FROZEN mtime (`_CAP_MTIME`, evaluated once at backend import), so
  // renaming an agent, toggling an automation or changing its interval
  // changes neither the counts nor the max — and the view would quietly
  // stop updating while looking perfectly alive. The graph is a few hundred
  // nodes; comparing them properly costs nothing worth having a bug over.
  return JSON.stringify([
    nodes.map(n => [n.id, n.label, n.type, n.mtime, n.enabled, n.interval_minutes]),
    edges.map(e => [e.source, e.target, e.kind]),
  ]);
}

export function createGraph2D(canvas: HTMLCanvasElement, opts?: RendererOpts): RendererHandle {
  const ctx = canvas.getContext('2d')!;
  let nodes: SimNode[] = [];
  let links: SimLink[] = [];
  let sim: Simulation<SimNode, SimLink> | null = null;
  let raf = 0;
  let hovered: SimNode | null = null;
  let labelScale = 1;

  // chat-activity engagement (#7): soft rings ripple out from the core
  // while Nova is answering
  let act = { active: false, at: 0 };
  let eng = 0;
  let ringPhase = 0;

  // pan/zoom transform
  let scale = 1, tx = 0, ty = 0;
  let panning = false, lastX = 0, lastY = 0;
  let lastFingerprint = '';
  let dragDistance = 0; // distinguishes a click from a pan

  const toWorld = (px: number, py: number) => ({ x: (px - tx) / scale, y: (py - ty) / scale });

  // Recomputed once per dataset, not once per node per frame. This used to
  // map every node's mtime into a new array and spread it into Math.min/max
  // INSIDE nodeRadius — which draw() calls per node per frame and hitTest()
  // calls per node per click. That is O(n^2) allocations at 60fps, and the
  // spread also risks a stack overflow once the graph is large enough.
  let mtimeLo = 0, mtimeHi = 0;
  function recomputeMtimeRange() {
    mtimeLo = Infinity; mtimeHi = -Infinity;
    for (const n of nodes) {
      if (n.mtime < mtimeLo) mtimeLo = n.mtime;
      if (n.mtime > mtimeHi) mtimeHi = n.mtime;
    }
  }

  function nodeRadius(n: SimNode): number {
    if (!nodes.length) return 5;
    const t = mtimeHi > mtimeLo ? (n.mtime - mtimeLo) / (mtimeHi - mtimeLo) : 0.5;
    return 4 + t * 5; // newer memories are bigger
  }

  function draw() {
    const w = canvas.width, h = canvas.height;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#0C0A09');
    g.addColorStop(1, '#12100e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    ctx.lineWidth = 1 / scale;
    for (const l of links) {
      const s = l.source as SimNode, t = l.target as SimNode;
      if (typeof s === 'string' || typeof t === 'string') continue;
      if (s.x == null || t.x == null) continue;
      ctx.strokeStyle = EDGE_COLORS[l.kind] ?? 'rgba(120,113,108,0.25)';
      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.lineTo(t.x!, t.y!);
      ctx.stroke();
    }

    const showAllLabels = nodes.length <= 30;
    for (const n of nodes) {
      if (n.x == null) continue;
      const r = nodeRadius(n);
      const color = NODE_COLORS[n.type] ?? '#A8A29E';

      ctx.beginPath();
      ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      // switched-off entities stay visible but recede
      ctx.globalAlpha = n.enabled === false ? 0.35 : n.type === 'journal' ? 0.6 : 0.95;
      ctx.fill();
      ctx.globalAlpha = 1;

      if (n === hovered) {
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, r + 3 / scale, 0, Math.PI * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5 / scale;
        ctx.stroke();
      }

      if (showAllLabels || n === hovered || n.type === 'skill') {
        ctx.font = `${(11 * labelScale) / scale}px sans-serif`;
        ctx.fillStyle = n === hovered ? '#F5F5F4' : 'rgba(214,211,209,0.75)';
        ctx.textAlign = 'center';
        ctx.fillText(n.label.slice(0, 32), n.x!, n.y! + r + 12 / scale);
      }
    }

    // engagement ripples — expanding rings from the core node, eased in/out
    const engaged = act.active && performance.now() - act.at < 90_000;
    eng += ((engaged ? 1 : 0) - eng) * 0.03;
    if (eng > 0.02) {
      const core = nodes.find(n => n.type === 'core');
      if (core?.x != null) {
        ringPhase = (ringPhase + 0.006) % 1;
        for (const off of [0, 0.34, 0.67]) {
          const p = (ringPhase + off) % 1;
          ctx.strokeStyle = `rgba(45, 212, 191, ${0.28 * eng * Math.sin(p * Math.PI)})`;
          ctx.lineWidth = 1.2 / scale;
          ctx.beginPath();
          ctx.arc(core.x!, core.y!, 20 + p * 260, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
    if (running()) raf = requestAnimationFrame(draw);
  }

  function hitTest(px: number, py: number): SimNode | null {
    const { x, y } = toWorld(px, py);
    for (const n of nodes) {
      if (n.x == null) continue;
      const r = nodeRadius(n) + 3;
      const dx = n.x! - x, dy = n.y! - y;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }

  const onPointerDown = (e: PointerEvent) => {
    panning = true; lastX = e.offsetX; lastY = e.offsetY;
    dragDistance = 0;
    canvas.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (panning) {
      dragDistance += Math.abs(e.offsetX - lastX) + Math.abs(e.offsetY - lastY);
      tx += e.offsetX - lastX; ty += e.offsetY - lastY;
      lastX = e.offsetX; lastY = e.offsetY;
    } else {
      hovered = hitTest(e.offsetX, e.offsetY);
      canvas.style.cursor = hovered ? 'pointer' : 'grab';
    }
  };
  const onPointerUp = (e: PointerEvent) => {
    panning = false;
    canvas.releasePointerCapture(e.pointerId);
    if (dragDistance < 4) {
      const hit = hitTest(e.offsetX, e.offsetY);
      opts?.onNodeClick?.(hit ? hit.id : null);
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.min(4, Math.max(0.25, scale * factor));
    // zoom around the cursor
    tx = e.offsetX - ((e.offsetX - tx) / scale) * next;
    ty = e.offsetY - ((e.offsetY - ty) / scale) * next;
    scale = next;
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });


  // Pause control. The canvas keeps rendering when nothing can see it:
  // <Brain/> is mounted permanently outside the router (deliberately — a
  // route change must never tear down the WebGL context), so this loop ran
  // at full rate behind every overlay, and on the phone behind an opaque
  // chat panel. Only universe.ts watched visibilitychange; these did not,
  // so a backgrounded tab relied purely on the browser throttling rAF.
  let paused = false;
  let hidden = false;
  const running = () => !paused && !hidden;
  function kick() {
    cancelAnimationFrame(raf);
    if (running()) raf = requestAnimationFrame(draw);
  }
  const onVisibility = () => { hidden = document.hidden; kick(); };
  document.addEventListener('visibilitychange', onVisibility);

  raf = requestAnimationFrame(draw);

  return {
    setPaused(next: boolean) { paused = next; kick(); },
    setData(newNodes: GraphNode[], newEdges: GraphEdge[]) {
      // The graph is polled every 20s and almost always comes back
      // identical, but setData rebuilt the whole force simulation and
      // restarted alpha regardless — so the layout visibly re-settled every
      // 20 seconds, on a canvas the operator was reading.
      const fp = graphFingerprint(newNodes, newEdges);
      if (fp === lastFingerprint) return;
      lastFingerprint = fp;
      // keep positions of nodes that already exist so refreshes don't jump
      const prev = new Map(nodes.map(n => [n.id, n]));
      nodes = newNodes.map(n => {
        const old = prev.get(n.id);
        return { ...n, x: old?.x, y: old?.y, vx: old?.vx, vy: old?.vy };
      });
      links = newEdges.map(e => ({ ...e }));

      sim?.stop();
      sim = forceSimulation<SimNode>(nodes)
        .force('link', forceLink<SimNode, SimLink>(links).id(n => n.id).distance(90))
        .force('charge', forceManyBody().strength(-200))
        .force('center', forceCenter(canvas.width / 2, canvas.height / 2))
        .force('collide', forceCollide(18));
      recomputeMtimeRange();
      sim.alpha(prev.size ? 0.4 : 1).restart();
    },
    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
      sim?.force('center', forceCenter(width / 2, height / 2));
      sim?.alpha(0.3).restart();
    },
    configure(options: Record<string, unknown>) {
      if (typeof options.labelScale === 'number') labelScale = options.labelScale;
    },
    recenter() {
      // fit the node bounding box into the viewport with a margin
      const xs = nodes.map(n => n.x ?? 0), ys = nodes.map(n => n.y ?? 0);
      if (!xs.length) { scale = 1; tx = 0; ty = 0; return; }
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
      scale = Math.min(2, Math.max(0.25,
        Math.min(canvas.width / (w + 160), canvas.height / (h + 160))));
      tx = canvas.width / 2 - ((minX + maxX) / 2) * scale;
      ty = canvas.height / 2 - ((minY + maxY) / 2) * scale;
    },
    setActivity(state: { active: boolean; kind?: 'thinking' | 'dispatch' | 'tool' | 'listening' }) {
      if (state.kind === 'listening') return;   // mic state has no graph treatment
      act = { active: state.active, at: performance.now() };
    },
    destroy() {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      sim?.stop();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
