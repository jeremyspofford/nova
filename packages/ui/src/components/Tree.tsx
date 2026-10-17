// Tree view (docs/04 §4.2, WAI-ARIA tree pattern). One tab stop: Up/Down, Home/End move;
// Right expands or enters a branch, Left collapses or goes to the parent; Enter (or a click)
// activates; Space toggles selection when the tree is multiselectable.
import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';

export interface TreeNode {
  id: string;
  /** Null (or an id not in the list) makes the node a root. */
  parentId: string | null;
  label: ReactNode;
  /** Shown after the label, e.g. a count. */
  detail?: ReactNode;
}

export interface TreeProps {
  /** Accessible name of the tree. */
  label: string;
  /** Nodes in display order; children keep their order under each parent. */
  nodes: TreeNode[];
  onActivate: (id: string) => void;
  /** Marks the node for the page being shown. */
  currentId?: string | null;
  /** Multi-select (Space, or the check box) for actions on several nodes. */
  selected?: readonly string[];
  onToggleSelect?: (id: string) => void;
  className?: string;
}

export function Tree({
  label,
  nodes,
  onActivate,
  currentId,
  selected,
  onToggleSelect,
  className,
}: TreeProps) {
  const base = useId();
  const root = useRef<HTMLUListElement>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusId, setFocusId] = useState<string | null>(null);
  const multi = selected !== undefined && onToggleSelect !== undefined;

  const { roots, children, parentOf } = useMemo(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const kids = new Map<string, TreeNode[]>();
    const tops: TreeNode[] = [];
    const parents = new Map<string, string>();
    for (const n of nodes) {
      if (n.parentId && ids.has(n.parentId) && n.parentId !== n.id) {
        const list = kids.get(n.parentId) ?? [];
        list.push(n);
        kids.set(n.parentId, list);
        parents.set(n.id, n.parentId);
      } else tops.push(n);
    }
    return { roots: tops, children: kids, parentOf: parents };
  }, [nodes]);

  // Visible nodes in order, so the arrow keys follow what is on screen.
  const visible = useMemo(() => {
    const out: string[] = [];
    const walk = (list: TreeNode[], seen: Set<string>) => {
      for (const n of list) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        out.push(n.id);
        if (!collapsed.has(n.id)) walk(children.get(n.id) ?? [], seen);
      }
    };
    walk(roots, new Set());
    return out;
  }, [roots, children, collapsed]);

  const active =
    (focusId && visible.includes(focusId) ? focusId : null) ??
    (currentId && visible.includes(currentId) ? currentId : null) ??
    visible[0] ??
    null;

  const focus = (id: string) => {
    setFocusId(id);
    queueMicrotask(() => {
      const items = root.current?.querySelectorAll<HTMLElement>('[data-node-id]') ?? [];
      for (const el of items) if (el.dataset.nodeId === id) el.focus();
    });
  };
  const setOpen = (id: string, open: boolean) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!active) return;
    const i = visible.indexOf(active);
    const hasKids = (children.get(active)?.length ?? 0) > 0;
    const open = hasKids && !collapsed.has(active);
    let handled = true;
    if (e.key === 'ArrowDown') {
      const next = visible[i + 1];
      if (next) focus(next);
    } else if (e.key === 'ArrowUp') {
      const prev = visible[i - 1];
      if (prev) focus(prev);
    } else if (e.key === 'Home') {
      if (visible[0]) focus(visible[0]);
    } else if (e.key === 'End') {
      const last = visible.at(-1);
      if (last) focus(last);
    } else if (e.key === 'ArrowRight') {
      if (hasKids && !open) setOpen(active, true);
      else if (open) {
        const first = children.get(active)?.[0];
        if (first) focus(first.id);
      }
    } else if (e.key === 'ArrowLeft') {
      if (open) setOpen(active, false);
      else {
        const parent = parentOf.get(active);
        if (parent) focus(parent);
      }
    } else if (e.key === 'Enter') {
      onActivate(active);
    } else if (e.key === ' ' && multi) {
      onToggleSelect(active);
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const renderNode = (n: TreeNode, level: number, seen: Set<string>): ReactNode => {
    if (seen.has(n.id)) return null;
    seen.add(n.id);
    const kids = children.get(n.id) ?? [];
    const open = !collapsed.has(n.id);
    const isSelected = multi ? selected.includes(n.id) : undefined;
    const labelId = `${base}-${n.id}`;
    return (
      <li
        key={n.id}
        role="treeitem"
        data-node-id={n.id}
        aria-level={level}
        aria-labelledby={labelId}
        aria-expanded={kids.length ? open : undefined}
        aria-selected={isSelected}
        aria-current={n.id === currentId ? 'page' : undefined}
        tabIndex={n.id === active ? 0 : -1}
        className="nv-tree-item"
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocusId(n.id);
        }}
        onClick={(e) => {
          e.stopPropagation();
          setFocusId(n.id);
          onActivate(n.id);
        }}
      >
        <span className="nv-tree-row" style={{ paddingInlineStart: `${(level - 1) * 16}px` }}>
          {kids.length ? (
            <span
              className="nv-tree-toggle"
              aria-hidden="true"
              data-open={open || undefined}
              onClick={(e) => {
                e.stopPropagation();
                setOpen(n.id, !open);
              }}
            >
              <Icon name="forward" />
            </span>
          ) : (
            <span className="nv-tree-toggle" aria-hidden="true" />
          )}
          {multi ? (
            <span
              className="nv-tree-check"
              aria-hidden="true"
              data-checked={isSelected || undefined}
              onClick={(e) => {
                e.stopPropagation();
                setFocusId(n.id);
                onToggleSelect(n.id);
              }}
            >
              {isSelected ? <Icon name="check" /> : null}
            </span>
          ) : null}
          <span id={labelId} className="nv-tree-label">
            {n.label}
          </span>
          {n.detail !== undefined ? <span className="nv-tree-detail">{n.detail}</span> : null}
        </span>
        {kids.length && open ? (
          <ul role="group" className="nv-tree-group">
            {kids.map((k) => renderNode(k, level + 1, seen))}
          </ul>
        ) : null}
      </li>
    );
  };

  const seen = new Set<string>();
  return (
    <ul
      ref={root}
      role="tree"
      aria-label={label}
      aria-multiselectable={multi || undefined}
      className={className ? `nv-tree ${className}` : 'nv-tree'}
      onKeyDown={onKeyDown}
    >
      {roots.map((n) => renderNode(n, 1, seen))}
    </ul>
  );
}
