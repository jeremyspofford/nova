// The pane layout tree (FR-005, docs/04 §4.3): a mode's main area is a tree of splits and panes.
// Every mode has exactly one `main` pane (the chat, or the mode's own view) that cannot close;
// other panes hold an editor, a preview, a terminal, a diff (M5) or a browser (M6), or are empty
// until a kind is chosen. All operations are pure and return a new layout, so a layout can be
// saved to `workspace.layout` and restored on start. The bottom panel (FR-006) is part of it.

export const PANE_KINDS = [
  'main',
  'empty',
  'editor',
  'preview',
  'terminal',
  'diff',
  'browser',
] as const;
export type PaneKind = (typeof PANE_KINDS)[number];

/** Kinds a user can add; `main` exists once and `empty` is what a split starts as. */
export const ADDABLE_KINDS = ['editor', 'preview', 'terminal', 'diff', 'browser'] as const;
export type AddableKind = (typeof ADDABLE_KINDS)[number];

export interface FileRef {
  root: string;
  path: string;
}

export interface PaneLeaf {
  type: 'pane';
  id: string;
  kind: PaneKind;
  /** The file an editor or preview pane shows. */
  file?: FileRef | null;
}

export interface PaneSplit {
  type: 'split';
  id: string;
  /** `row` places children side by side; `column` stacks them. */
  direction: 'row' | 'column';
  children: LayoutNode[];
  /** One fraction per child, summing to 1. */
  sizes: number[];
}

export type LayoutNode = PaneLeaf | PaneSplit;

export interface ModeLayout {
  root: LayoutNode;
  /** A pane shown alone, or null. */
  maximized: string | null;
  /** The pane commands act on, and the one a phone shows. */
  active: string;
  /** The bottom panel: open or not, and its share of the main area's height. */
  bottom: { open: boolean; size: number };
}

export const MAIN_PANE = 'main';
export const MIN_SHARE = 0.1;
export const MAX_PANES = 12;
const MAX_DEPTH = 6;
export const BOTTOM_MIN = 0.15;
export const BOTTOM_MAX = 0.8;

export function defaultLayout(): ModeLayout {
  return {
    root: { type: 'pane', id: MAIN_PANE, kind: 'main' },
    maximized: null,
    active: MAIN_PANE,
    bottom: { open: false, size: 0.3 },
  };
}

// ---- reading ---------------------------------------------------------------------------------------

/** Panes in reading order (left to right, top to bottom). */
export function leaves(node: LayoutNode): PaneLeaf[] {
  return node.type === 'pane' ? [node] : node.children.flatMap(leaves);
}

export function findPane(layout: ModeLayout, id: string): PaneLeaf | null {
  return leaves(layout.root).find((p) => p.id === id) ?? null;
}

function parentOf(node: LayoutNode, id: string): { parent: PaneSplit; index: number } | null {
  if (node.type === 'pane') return null;
  const index = node.children.findIndex((c) => c.id === id);
  if (index >= 0) return { parent: node, index };
  for (const c of node.children) {
    const hit = parentOf(c, id);
    if (hit) return hit;
  }
  return null;
}

function allIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.id] : [node.id, ...node.children.flatMap(allIds)];
}

function freshId(layout: ModeLayout, prefix: 'p' | 's'): string {
  const used = new Set(allIds(layout.root));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

// ---- writing ---------------------------------------------------------------------------------------

/** Replace the node with `id` by `next` (or remove it when `next` is null). */
function replaceNode(node: LayoutNode, id: string, next: LayoutNode | null): LayoutNode | null {
  if (node.id === id) return next;
  if (node.type === 'pane') return node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((c, i) => {
    const r = replaceNode(c, id, next);
    if (r) {
      children.push(r);
      sizes.push(node.sizes[i] ?? 0);
    }
  });
  if (children.length === 0) return null;
  // A split left with one child is replaced by that child.
  if (children.length === 1) return children[0]!;
  return { ...node, children, sizes: normalize(sizes) };
}

export function normalize(sizes: readonly number[]): number[] {
  const clean = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= 0) return clean.map(() => 1 / Math.max(1, clean.length));
  return clean.map((s) => s / total);
}

function depthOf(node: LayoutNode, id: string, depth = 0): number {
  if (node.id === id) return depth;
  if (node.type === 'pane') return -1;
  for (const c of node.children) {
    const d = depthOf(c, id, depth + 1);
    if (d >= 0) return d;
  }
  return -1;
}

/**
 * Split pane `targetId` and put a new pane after it. `row` splits to the right, `column` below.
 * Returns the same layout when the limit on panes or depth is reached.
 */
export function splitPane(
  layout: ModeLayout,
  targetId: string,
  direction: 'row' | 'column',
  kind: PaneKind = 'empty',
  file: FileRef | null = null,
): { layout: ModeLayout; paneId: string | null } {
  const target = findPane(layout, targetId);
  if (!target || kind === 'main' || leaves(layout.root).length >= MAX_PANES)
    return { layout, paneId: null };
  const paneId = freshId(layout, 'p');
  const leaf: PaneLeaf = { type: 'pane', id: paneId, kind, ...(file ? { file } : {}) };
  const at = parentOf(layout.root, targetId);
  let root: LayoutNode;
  if (at && at.parent.direction === direction) {
    // Same direction: the target shares its space with the new sibling.
    const half = (at.parent.sizes[at.index] ?? 0) / 2;
    const children = [...at.parent.children];
    const sizes = [...at.parent.sizes];
    children.splice(at.index + 1, 0, leaf);
    sizes.splice(at.index, 1, half, half);
    root = replaceNode(layout.root, at.parent.id, {
      ...at.parent,
      children,
      sizes: normalize(sizes),
    })!;
  } else {
    if (depthOf(layout.root, targetId) >= MAX_DEPTH) return { layout, paneId: null };
    const split: PaneSplit = {
      type: 'split',
      id: freshId(layout, 's'),
      direction,
      children: [target, leaf],
      sizes: [0.5, 0.5],
    };
    root = replaceNode(layout.root, targetId, split)!;
  }
  return { layout: { ...layout, root, active: paneId, maximized: null }, paneId };
}

/** Close a pane; the main pane never closes. */
export function closePane(layout: ModeLayout, id: string): ModeLayout {
  const pane = findPane(layout, id);
  if (!pane || pane.kind === 'main') return layout;
  const order = leaves(layout.root).map((p) => p.id);
  const root = replaceNode(layout.root, id, null) ?? defaultLayout().root;
  const left = leaves(root).map((p) => p.id);
  const i = order.indexOf(id);
  const neighbour = order[i - 1] ?? order[i + 1] ?? MAIN_PANE;
  return {
    ...layout,
    root,
    maximized: layout.maximized === id ? null : layout.maximized,
    active:
      layout.active === id ? (left.includes(neighbour) ? neighbour : MAIN_PANE) : layout.active,
  };
}

export function setSizes(
  layout: ModeLayout,
  splitId: string,
  sizes: readonly number[],
): ModeLayout {
  const at = findSplit(layout.root, splitId);
  if (!at || at.children.length !== sizes.length) return layout;
  const next = normalize(sizes.map((s) => Math.max(MIN_SHARE / 2, s)));
  return { ...layout, root: replaceNode(layout.root, splitId, { ...at, sizes: next })! };
}

function findSplit(node: LayoutNode, id: string): PaneSplit | null {
  if (node.type === 'pane') return null;
  if (node.id === id) return node;
  for (const c of node.children) {
    const hit = findSplit(c, id);
    if (hit) return hit;
  }
  return null;
}

/** Move a pane one place earlier (-1) or later (+1) among its siblings. */
export function movePane(layout: ModeLayout, id: string, by: -1 | 1): ModeLayout {
  const at = parentOf(layout.root, id);
  if (!at) return layout;
  const j = at.index + by;
  if (j < 0 || j >= at.parent.children.length) return layout;
  const children = [...at.parent.children];
  const sizes = [...at.parent.sizes];
  [children[at.index], children[j]] = [children[j]!, children[at.index]!];
  [sizes[at.index], sizes[j]] = [sizes[j]!, sizes[at.index]!];
  return {
    ...layout,
    root: replaceNode(layout.root, at.parent.id, { ...at.parent, children, sizes })!,
  };
}

/** Exchange two panes' places (a drag of one pane onto another). */
export function swapPanes(layout: ModeLayout, a: string, b: string): ModeLayout {
  const pa = findPane(layout, a);
  const pb = findPane(layout, b);
  if (!pa || !pb || a === b) return layout;
  const swap = (node: LayoutNode): LayoutNode =>
    node.type === 'pane'
      ? node.id === a
        ? pb
        : node.id === b
          ? pa
          : node
      : { ...node, children: node.children.map(swap) };
  return { ...layout, root: swap(layout.root) };
}

export function toggleMaximize(layout: ModeLayout, id: string): ModeLayout {
  if (!findPane(layout, id)) return layout;
  return { ...layout, maximized: layout.maximized === id ? null : id, active: id };
}

export function setActive(layout: ModeLayout, id: string): ModeLayout {
  if (layout.active === id || !findPane(layout, id)) return layout;
  return { ...layout, active: id };
}

export function updatePane(
  layout: ModeLayout,
  id: string,
  patch: { kind?: PaneKind; file?: FileRef | null },
): ModeLayout {
  const pane = findPane(layout, id);
  if (!pane || pane.kind === 'main' || patch.kind === 'main') return layout;
  const next: PaneLeaf = { ...pane, ...patch };
  if (!next.file) delete next.file;
  return { ...layout, root: replaceNode(layout.root, id, next)! };
}

export function setBottom(layout: ModeLayout, patch: Partial<ModeLayout['bottom']>): ModeLayout {
  const size = Math.min(BOTTOM_MAX, Math.max(BOTTOM_MIN, patch.size ?? layout.bottom.size));
  const open = patch.open ?? layout.bottom.open;
  if (open === layout.bottom.open && size === layout.bottom.size) return layout;
  return { ...layout, bottom: { open, size } };
}

/**
 * Where a file opens: the active pane when it already has that kind, else the first pane of the
 * kind, else an empty pane, else a new pane to the right of the active one.
 */
export function openInPane(
  layout: ModeLayout,
  kind: 'editor' | 'preview',
  file: FileRef,
): { layout: ModeLayout; paneId: string | null } {
  const all = leaves(layout.root);
  const active = all.find((p) => p.id === layout.active);
  const target =
    (active?.kind === kind ? active : null) ??
    all.find((p) => p.kind === kind) ??
    all.find((p) => p.kind === 'empty');
  if (target) {
    const next = updatePane(layout, target.id, { kind, file });
    return {
      layout: {
        ...next,
        active: target.id,
        maximized: layout.maximized && layout.maximized !== target.id ? null : layout.maximized,
      },
      paneId: target.id,
    };
  }
  return splitPane(layout, layout.active, 'row', kind, file);
}

// ---- persistence -----------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ID = /^[a-z0-9_-]{1,40}$/i;

function parseNode(v: unknown, depth: number, ids: Set<string>): LayoutNode | null {
  if (!isRecord(v) || typeof v.id !== 'string' || !ID.test(v.id) || ids.has(v.id)) return null;
  ids.add(v.id);
  if (v.type === 'pane') {
    if (typeof v.kind !== 'string' || !(PANE_KINDS as readonly string[]).includes(v.kind))
      return null;
    const leaf: PaneLeaf = { type: 'pane', id: v.id, kind: v.kind as PaneKind };
    const f = v.file;
    if (isRecord(f) && typeof f.root === 'string' && typeof f.path === 'string')
      leaf.file = { root: f.root.slice(0, 1000), path: f.path.slice(0, 1000) };
    return leaf;
  }
  if (v.type !== 'split' || depth >= MAX_DEPTH) return null;
  if (v.direction !== 'row' && v.direction !== 'column') return null;
  if (!Array.isArray(v.children) || v.children.length < 2 || v.children.length > MAX_PANES)
    return null;
  const children: LayoutNode[] = [];
  for (const c of v.children as unknown[]) {
    const n = parseNode(c, depth + 1, ids);
    if (!n) return null;
    children.push(n);
  }
  const raw = Array.isArray(v.sizes) ? (v.sizes as unknown[]) : [];
  const sizes =
    raw.length === children.length && raw.every((s) => typeof s === 'number')
      ? normalize(raw)
      : children.map(() => 1 / children.length);
  return { type: 'split', id: v.id, direction: v.direction, children, sizes };
}

/** A saved layout, or null when it is missing or malformed (the default is used then). */
export function parseLayout(v: unknown): ModeLayout | null {
  if (!isRecord(v)) return null;
  const root = parseNode(v.root, 0, new Set());
  if (!root) return null;
  const panes = leaves(root);
  if (panes.length > MAX_PANES || panes.filter((p) => p.kind === 'main').length !== 1) return null;
  const main = panes.find((p) => p.kind === 'main')!;
  const has = (id: unknown): id is string =>
    typeof id === 'string' && panes.some((p) => p.id === id);
  const b = isRecord(v.bottom) ? v.bottom : {};
  const size = typeof b.size === 'number' && Number.isFinite(b.size) ? b.size : 0.3;
  return {
    root,
    maximized: has(v.maximized) ? v.maximized : null,
    active: has(v.active) ? v.active : main.id,
    bottom: {
      open: b.open === true,
      size: Math.min(BOTTOM_MAX, Math.max(BOTTOM_MIN, size)),
    },
  };
}
