/** The Vault's force graph: d3-force over a 2D canvas, no React.
 *
 *  A sibling of `brain/graph2d.ts`, deliberately not an import of it. That
 *  file implements `RendererHandle`, whose only extension point is
 *  `configure(options: Record<string, unknown>)` — an untyped bag — so local
 *  mode, hop depth, selection, tag dimming and node dragging would all have to
 *  land in the *Brain's* renderer contract, where they mean nothing. It also
 *  hard-codes the brain's semantics (radius from mtime, colours by platform
 *  type, engagement ripples) and runs a permanent rAF loop.
 *
 *  The ~80 lines of pan/zoom and hit-test arithmetic below are the same
 *  arithmetic as there. That duplication is the price, and it is named here so
 *  nobody reads it as an accident.
 *
 *  The one behaviour that is genuinely different, and the main reason for a
 *  separate engine: THIS ONE STOPS DRAWING. The vault sits over a canvas that
 *  is itself animating, so when the simulation settles and the pointer is
 *  still, frames must stop rather than idle at 60fps forever.
 */

import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation,
  type Simulation, type SimulationNodeDatum,
} from 'd3';
import type { GraphEdge, GraphNode } from '../../api';
import { NODE_COLOR, EDGE_COLOR, SELECTED_EDGE, LABEL, SELECTED_RING } from './colors';

interface SimNode extends SimulationNodeDatum {
  id: string;
  label: string;
  type: string;
  r: number;
}
interface SimLink { source: string | SimNode; target: string | SimNode; kind: string }

const MIN_SCALE = 0.15;
const MAX_SCALE = 5;
/** Below this a click is a click; above it, it was a pan. */
const DRAG_SLOP = 4;
/** Show every label under this many nodes, or when zoomed past LABEL_SCALE. */
const LABEL_ALL_UNDER = 40;
const LABEL_SCALE = 1.6;
/** Above this many neighbours, the selection is named and the fan is not. */
const LABEL_NEIGHBOURS_UNDER = 12;

export interface VaultGraphOpts {
  /** A genuine click, not the end of a pan. `null` is empty space. */
  onPick(id: string | null): void;
  /** Fires ONLY when the hovered id changes — never per mousemove. A React
   *  state update per pointer event is the thing this avoids. */
  onHover?(id: string | null): void;
}

export interface VaultGraphEngine {
  setData(nodes: GraphNode[], links: GraphEdge[]): void;
  setSelected(id: string | null): void;
  /** Ids to recede. Nodes are never REMOVED by a filter — removing them
   *  fragments the layout and lies about the corpus. */
  setDim(ids: Set<string> | null): void;
  resize(cssW: number, cssH: number, dpr: number): void;
  fit(): void;
  focus(id: string): void;
  zoomBy(factor: number): void;
  setPaused(p: boolean): void;
  destroy(): void;
}

export function createVaultGraph(
  canvas: HTMLCanvasElement, opts: VaultGraphOpts,
): VaultGraphEngine {
  const ctx = canvas.getContext('2d')!;
  let nodes: SimNode[] = [];
  let links: SimLink[] = [];
  let selected: string | null = null;
  let dimmed: Set<string> | null = null;
  let hovered: string | null = null;
  let neighbours = new Set<string>();

  let W = 1, H = 1, dpr = 1;
  let scale = 1, tx = 0, ty = 0;
  let paused = false;
  let hidden = document.hidden;
  let frame = 0;
  let dead = false;

  // The layout lives in WORLD space centred on the origin; where it appears on
  // screen is the view transform's business. Keeping forceCenter pinned to
  // (0,0) means panning and zooming never fight the simulation.
  const sim: Simulation<SimNode, undefined> = forceSimulation<SimNode>([])
    .force('charge', forceManyBody<SimNode>().strength(-170).distanceMax(420))
    .force('collide', forceCollide<SimNode>(d => d.r + 6))
    .force('center', forceCenter(0, 0))
    .alphaDecay(0.035)
    .stop();

  /** True once the operator has panned, zoomed or dragged. Until then the view
   *  stays fitted — on every resize and every time the layout settles — which
   *  is what makes "open a note, see its neighbourhood" work without a click.
   *  After that the viewport is theirs and nothing moves it but `fit()`. */
  let userAdjusted = false;

  // ── the render-on-demand contract ──────────────────────────────────────
  // draw() clears `frame` and does NOT reschedule itself. Anything that
  // changes what is on screen calls requestDraw(). When the simulation ends
  // and the pointer stops, there is no next frame.
  function requestDraw() {
    if (dead || frame || paused || hidden) return;
    frame = requestAnimationFrame(drawVault);
  }
  sim.on('tick', requestDraw);
  sim.on('end', () => { if (!userAdjusted) fit(); });

  const onVisibility = () => {
    hidden = document.hidden;
    if (!hidden) requestDraw();
  };
  document.addEventListener('visibilitychange', onVisibility);

  // ── geometry ───────────────────────────────────────────────────────────
  const toWorld = (px: number, py: number) => ({ x: (px - tx) / scale, y: (py - ty) / scale });

  function hit(px: number, py: number): SimNode | null {
    const { x, y } = toWorld(px, py);
    // last drawn wins, so iterate backwards
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (n.x == null || n.y == null) continue;
      const pad = Math.max(n.r, 8 / scale);
      const dx = n.x - x, dy = n.y - y;
      if (dx * dx + dy * dy <= pad * pad) return n;
    }
    return null;
  }

  function recomputeNeighbours() {
    neighbours = new Set();
    if (!selected) return;
    for (const l of links) {
      const s = typeof l.source === 'string' ? l.source : l.source.id;
      const t = typeof l.target === 'string' ? l.target : l.target.id;
      if (s === selected) neighbours.add(t);
      else if (t === selected) neighbours.add(s);
    }
  }

  // ── draw ───────────────────────────────────────────────────────────────
  function drawVault() {
    frame = 0;
    if (dead) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(tx, ty);
    ctx.scale(scale, scale);

    const alphaOf = (id: string) => (dimmed && dimmed.has(id) ? 0.15 : 1);

    ctx.lineWidth = 1 / scale;
    for (const l of links) {
      const s = l.source as SimNode, t = l.target as SimNode;
      if (s.x == null || t.x == null) continue;
      const lit = selected != null && (s.id === selected || t.id === selected);
      ctx.globalAlpha = Math.min(alphaOf(s.id), alphaOf(t.id));
      ctx.strokeStyle = lit ? SELECTED_EDGE : (EDGE_COLOR[l.kind] ?? EDGE_COLOR.link);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y!);
      ctx.lineTo(t.x, t.y!);
      ctx.stroke();
    }

    const showAll = nodes.length <= LABEL_ALL_UNDER || scale > LABEL_SCALE;
    // "…and its neighbours" is a useful rule until the selection IS a hub:
    // `sources/cloud-codes---videos.md` has 69, and in its own local graph
    // every node is a neighbour, so the exception swallowed the rule and drew
    // 70 overlapping labels. Past a handful, only the selection is named.
    const labelNeighbours = neighbours.size <= LABEL_NEIGHBOURS_UNDER;
    for (const n of nodes) {
      if (n.x == null || n.y == null) continue;
      ctx.globalAlpha = alphaOf(n.id);
      ctx.fillStyle = NODE_COLOR(n.type, n.id);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      if (n.id === selected) {
        ctx.strokeStyle = SELECTED_RING;
        ctx.lineWidth = 2 / scale;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3 / scale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.lineWidth = 1 / scale;
      }
      const label = showAll || n.id === selected || n.id === hovered
        || (labelNeighbours && neighbours.has(n.id));
      if (label) {
        ctx.globalAlpha = alphaOf(n.id) * (showAll && n.id !== selected && n.id !== hovered ? 0.75 : 1);
        ctx.fillStyle = LABEL;
        // Divided by `scale` and NOT floored: everything here is drawn inside
        // the zoom transform, so a floor in world units becomes a ceiling-less
        // font on screen — a two-node local graph fits at high zoom and the
        // labels came out several times the size of the pane.
        ctx.font = `${11 / scale}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const text = n.label.length > 42 ? n.label.slice(0, 41) + '…' : n.label;
        ctx.fillText(text, n.x, n.y + n.r + 3 / scale);
      }
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ── pointer ────────────────────────────────────────────────────────────
  let panning = false;
  let dragNode: SimNode | null = null;
  let downX = 0, downY = 0, moved = 0;

  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  function onDown(e: PointerEvent) {
    const { x, y } = local(e);
    downX = x; downY = y; moved = 0;
    const n = hit(x, y);
    if (n) {
      dragNode = n;
      const w = toWorld(x, y);
      n.fx = w.x; n.fy = w.y;
      sim.alphaTarget(0.3).restart();
    } else {
      panning = true;
    }
    canvas.setPointerCapture(e.pointerId);
  }

  function onMove(e: PointerEvent) {
    const { x, y } = local(e);
    if (dragNode) {
      moved += Math.abs(x - downX) + Math.abs(y - downY);
      // Moving a node by hand is a claim on the layout; a settle must not
      // re-fit the viewport out from under it.
      if (moved > DRAG_SLOP) userAdjusted = true;
      const w = toWorld(x, y);
      dragNode.fx = w.x; dragNode.fy = w.y;
      downX = x; downY = y;
      requestDraw();
      return;
    }
    if (panning) {
      const dx = x - downX, dy = y - downY;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > DRAG_SLOP) userAdjusted = true;
      tx += dx; ty += dy;
      downX = x; downY = y;
      requestDraw();
      return;
    }
    const n = hit(x, y);
    const id = n?.id ?? null;
    if (id !== hovered) {
      hovered = id;
      canvas.style.cursor = id ? 'pointer' : 'default';
      opts.onHover?.(id);
      requestDraw();
    }
  }

  function onUp(e: PointerEvent) {
    const wasDrag = moved > DRAG_SLOP;
    if (dragNode) {
      dragNode.fx = null; dragNode.fy = null;
      sim.alphaTarget(0);
      if (!wasDrag) opts.onPick(dragNode.id);
      dragNode = null;
    } else if (panning && !wasDrag) {
      const { x, y } = local(e);
      opts.onPick(hit(x, y)?.id ?? null);
    }
    panning = false;
    canvas.releasePointerCapture?.(e.pointerId);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    userAdjusted = true;
    const { x, y } = local(e);
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * Math.exp(-e.deltaY * 0.0015)));
    // keep the point under the cursor fixed
    tx = x - (x - tx) * (next / scale);
    ty = y - (y - ty) * (next / scale);
    scale = next;
    requestDraw();
  }

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // ── api ────────────────────────────────────────────────────────────────
  function fit() {
    const pts = nodes.filter(n => n.x != null && n.y != null);
    if (!pts.length) { scale = 1; tx = W / 2; ty = H / 2; requestDraw(); return; }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of pts) {
      minX = Math.min(minX, n.x! - n.r); maxX = Math.max(maxX, n.x! + n.r);
      minY = Math.min(minY, n.y! - n.r); maxY = Math.max(maxY, n.y! + n.r);
    }
    const pad = 32;
    const s = Math.min((W - pad * 2) / Math.max(1, maxX - minX),
                       (H - pad * 2) / Math.max(1, maxY - minY));
    // Capped at 1: a note with one neighbour would otherwise fit to a 2x zoom
    // and fill the pane with two dots. Fitting is about seeing everything, not
    // about filling the box.
    scale = Math.min(1, Math.max(MIN_SCALE, s));
    tx = W / 2 - ((minX + maxX) / 2) * scale;
    ty = H / 2 - ((minY + maxY) / 2) * scale;
    requestDraw();
  }

  return {
    setData(nextNodes, nextLinks) {
      // Carry positions across so a save, or a local→global switch, relaxes
      // rather than re-exploding. Same trick as graph2d.ts.
      const prev = new Map(nodes.map(n => [n.id, n]));
      nodes = nextNodes.map(n => {
        const p = prev.get(n.id);
        const deg = nextLinks.reduce((c, e) => c + (e.source === n.id || e.target === n.id ? 1 : 0), 0);
        return {
          id: n.id,
          label: n.label,
          type: n.type,
          // Degree, not mtime: a vault asks how CONNECTED a note is, which is
          // also what makes the four hub sources read as hubs.
          r: 3 + Math.min(7, Math.sqrt(deg) * 2.2),
          x: p?.x, y: p?.y, vx: p?.vx, vy: p?.vy,
        };
      });
      links = nextLinks.map(e => ({ source: e.source, target: e.target, kind: e.kind }));
      recomputeNeighbours();
      const carried = nodes.some(n => n.x != null);
      sim.nodes(nodes);
      sim.force('link', forceLink<SimNode, SimLink>(links)
        .id(d => d.id).distance(46).strength(0.55));
      sim.alpha(carried ? 0.4 : 1).restart();
      requestDraw();
    },
    setSelected(id) {
      selected = id;
      recomputeNeighbours();
      requestDraw();
    },
    setDim(ids) { dimmed = ids; requestDraw(); },
    resize(cssW, cssH, nextDpr) {
      W = Math.max(1, cssW); H = Math.max(1, cssH); dpr = nextDpr;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      if (!userAdjusted) fit();
      requestDraw();
    },
    /** The button. Pressing it is a request to go back to auto-framing, so it
     *  hands the viewport back rather than fitting once and drifting again. */
    fit() { userAdjusted = false; fit(); },
    focus(id) {
      userAdjusted = true;
      const n = nodes.find(x => x.id === id);
      if (!n || n.x == null || n.y == null) return;
      tx = W / 2 - n.x * scale;
      ty = H / 2 - n.y * scale;
      requestDraw();
    },
    zoomBy(factor) {
      userAdjusted = true;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
      tx = W / 2 - (W / 2 - tx) * (next / scale);
      ty = H / 2 - (H / 2 - ty) * (next / scale);
      scale = next;
      requestDraw();
    },
    setPaused(p) { paused = p; if (!p) requestDraw(); },
    destroy() {
      dead = true;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      sim.on('tick', null);
      sim.stop();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
}
