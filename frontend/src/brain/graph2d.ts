/** 2D force-directed brain renderer (canvas, d3-force). */

import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation,
  type Simulation, type SimulationNodeDatum,
} from 'd3';
import type { GraphNode, GraphEdge } from '../api';
import type { RendererHandle, RendererOpts } from './theme';

interface SimNode extends SimulationNodeDatum {
  id: string;
  label: string;
  type: string;
  mtime: number;
}
interface SimLink { source: string | SimNode; target: string | SimNode; kind: string }

const NODE_COLORS: Record<string, string> = {
  topic: '#24C9B8',    // teal — knowledge
  skill: '#FBBF24',    // amber — behavior
  journal: '#78716C',  // stone — episodic, dim
  source: '#60A5FA',   // blue — external
};

export function createGraph2D(canvas: HTMLCanvasElement, opts?: RendererOpts): RendererHandle {
  const ctx = canvas.getContext('2d')!;
  let nodes: SimNode[] = [];
  let links: SimLink[] = [];
  let sim: Simulation<SimNode, SimLink> | null = null;
  let raf = 0;
  let hovered: SimNode | null = null;

  // pan/zoom transform
  let scale = 1, tx = 0, ty = 0;
  let panning = false, lastX = 0, lastY = 0;
  let dragDistance = 0; // distinguishes a click from a pan

  const toWorld = (px: number, py: number) => ({ x: (px - tx) / scale, y: (py - ty) / scale });

  function nodeRadius(n: SimNode): number {
    if (!nodes.length) return 5;
    const times = nodes.map(m => m.mtime);
    const min = Math.min(...times), max = Math.max(...times);
    const t = max > min ? (n.mtime - min) / (max - min) : 0.5;
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
      ctx.strokeStyle = l.kind === 'link' ? 'rgba(36,201,184,0.35)' : 'rgba(120,113,108,0.25)';
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
      ctx.globalAlpha = n.type === 'journal' ? 0.6 : 0.95;
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
        ctx.font = `${11 / scale}px sans-serif`;
        ctx.fillStyle = n === hovered ? '#F5F5F4' : 'rgba(214,211,209,0.75)';
        ctx.textAlign = 'center';
        ctx.fillText(n.label.slice(0, 32), n.x!, n.y! + r + 12 / scale);
      }
    }
    ctx.restore();
    raf = requestAnimationFrame(draw);
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

  raf = requestAnimationFrame(draw);

  return {
    setData(newNodes: GraphNode[], newEdges: GraphEdge[]) {
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
      sim.alpha(prev.size ? 0.4 : 1).restart();
    },
    resize(width: number, height: number) {
      canvas.width = width;
      canvas.height = height;
      sim?.force('center', forceCenter(width / 2, height / 2));
      sim?.alpha(0.3).restart();
    },
    destroy() {
      cancelAnimationFrame(raf);
      sim?.stop();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
