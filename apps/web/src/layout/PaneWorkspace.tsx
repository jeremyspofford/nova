// A mode's main area (FR-005, FR-006): its pane tree with keyboard-operable splitters, each pane
// with a header to split, maximize, move and close it (and drag it onto another pane to swap
// them), and the collapsible bottom panel. Pane contents render through portals into elements
// that move between slots, so splitting, moving or maximizing never restarts a chat, an editor
// or a terminal. Phones show one pane at a time with a pane switcher.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, IconButton, Menu, PaneGroup, Splitter, rovingIndex, type MenuItem } from '@nova/ui';
import {
  BOTTOM_MAX,
  BOTTOM_MIN,
  closePane,
  findPane,
  leaves,
  movePane,
  setActive,
  setBottom,
  setSizes,
  splitPane,
  swapPanes,
  toggleMaximize,
  defaultLayout,
  type LayoutNode,
  type ModeLayout,
  type PaneLeaf,
} from './model.ts';

const DRAG_TYPE = 'application/x-nova-pane';

/** Elements pane contents render into; each moves to wherever its pane is shown. */
class PaneHosts {
  readonly #els = new Map<string, HTMLDivElement>();
  get(id: string): HTMLDivElement {
    let el = this.#els.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'pane-host';
      this.#els.set(id, el);
    }
    return el;
  }
  prune(keep: ReadonlySet<string>): void {
    for (const [id, el] of this.#els) {
      if (keep.has(id)) continue;
      el.remove();
      this.#els.delete(id);
    }
  }
}

export interface PaneInfo {
  title: string;
  icon: Parameters<typeof Icon>[0]['name'];
}

export interface PaneWorkspaceProps {
  /** Names the area, e.g. "Chat workspace". */
  label: string;
  layout: ModeLayout;
  onChange: (fn: (layout: ModeLayout) => ModeLayout) => void;
  /** False while another mode or page is shown. */
  visible: boolean;
  phone: boolean;
  info: (pane: PaneLeaf) => PaneInfo;
  /** A pane's contents; `shown` is false while it is hidden by a maximized pane or on a phone. */
  renderPane: (pane: PaneLeaf, shown: boolean) => ReactNode;
  /** The bottom panel's contents; `shown` is false while it is closed. */
  renderBottom: (shown: boolean) => ReactNode;
  /** Moves focus into a pane when `n` changes. */
  focus?: { id: string; n: number } | null;
  /** Called when a pane is created from its header (to focus it). */
  onCreated?: (id: string) => void;
}

export function PaneWorkspace({
  label,
  layout,
  onChange,
  visible,
  phone,
  info,
  renderPane,
  renderBottom,
  focus,
  onCreated,
}: PaneWorkspaceProps) {
  const [hosts] = useState(() => new PaneHosts());
  const base = useId();
  const panes = leaves(layout.root);
  const count = panes.length;
  const ids = new Set(panes.map((p) => p.id));
  const keyIds = [...ids].join(' ');
  useEffect(() => {
    hosts.prune(new Set(keyIds.split(' ')));
  }, [hosts, keyIds]);

  const maximized = layout.maximized ? findPane(layout, layout.maximized) : null;
  const active = findPane(layout, layout.active) ?? panes[0]!;
  const alone = phone ? active : maximized;
  const shownIds = alone ? new Set([alone.id]) : ids;

  const split = (id: string, direction: 'row' | 'column') => {
    // New ids are chosen from the layout, so the one shown now names the pane the update adds.
    const created = splitPane(layout, id, direction).paneId;
    onChange((l) => splitPane(l, id, direction).layout);
    if (created) onCreated?.(created);
  };

  const frame = (pane: PaneLeaf) => (
    <PaneFrame
      key={pane.id}
      pane={pane}
      info={info(pane)}
      host={hosts.get(pane.id)}
      layout={layout}
      single={count === 1}
      phone={phone}
      active={pane.id === active.id && count > 1}
      focus={focus?.id === pane.id ? focus.n : 0}
      onChange={onChange}
      onSplit={split}
    />
  );

  const renderNode = (node: LayoutNode): ReactNode => {
    if (node.type === 'pane') return frame(node);
    const names = node.children.map((c) =>
      c.type === 'pane' ? info(c).title : `${leaves(c).length} panes`,
    );
    return (
      <PaneGroup
        key={node.id}
        direction={node.direction}
        sizes={node.sizes}
        onSizes={(sizes) => onChange((l) => setSizes(l, node.id, sizes))}
        splitterLabel={(i) => `Resize ${names[i] ?? 'pane'} and ${names[i + 1] ?? 'pane'}`}
      >
        {node.children.map(renderNode)}
      </PaneGroup>
    );
  };

  const bottom = layout.bottom;
  const panelId = `${base}-bottom`;
  return (
    <div className="workspace" aria-label={label} role="region" data-phone={phone || undefined}>
      {phone && count > 1 ? (
        <PaneSwitcher
          panes={panes}
          activeId={active.id}
          info={info}
          onSelect={(id) => onChange((l) => setActive(l, id))}
          onClose={(id) => onChange((l) => closePane(l, id))}
        />
      ) : null}
      <div
        className="workspace-panes"
        style={bottom.open ? { flex: `${1 - bottom.size} 1 0` } : undefined}
      >
        {alone ? frame(alone) : renderNode(layout.root)}
      </div>
      {bottom.open ? (
        <Splitter
          label="Resize the bottom panel"
          orientation="horizontal"
          value={(1 - bottom.size) * 100}
          min={(1 - BOTTOM_MAX) * 100}
          max={(1 - BOTTOM_MIN) * 100}
          controls={panelId}
          onMove={(delta) => onChange((l) => setBottom(l, { size: l.bottom.size - delta / 100 }))}
        />
      ) : null}
      <section
        id={panelId}
        className="bottom-panel"
        aria-label="Bottom panel"
        hidden={!bottom.open}
        style={bottom.open ? { flex: `${bottom.size} 1 0` } : undefined}
      >
        <div className="bottom-panel-head">
          <span className="bottom-panel-title">
            <Icon name="terminal" /> Terminal
          </span>
          <span className="pane-head-spacer" />
          <IconButton
            label="Close the bottom panel"
            icon={<Icon name="close" />}
            variant="ghost"
            onClick={() => onChange((l) => setBottom(l, { open: false }))}
          />
        </div>
        <div className="bottom-panel-body">{renderBottom(visible && bottom.open)}</div>
      </section>
      {panes.map((p) =>
        createPortal(renderPane(p, visible && shownIds.has(p.id)), hosts.get(p.id), p.id),
      )}
    </div>
  );
}

function PaneFrame({
  pane,
  info,
  host,
  layout,
  single,
  phone,
  active,
  focus,
  onChange,
  onSplit,
}: {
  pane: PaneLeaf;
  info: PaneInfo;
  host: HTMLDivElement;
  layout: ModeLayout;
  single: boolean;
  phone: boolean;
  active: boolean;
  focus: number;
  onChange: (fn: (layout: ModeLayout) => ModeLayout) => void;
  onSplit: (id: string, direction: 'row' | 'column') => void;
}) {
  const titleId = useId();
  const section = useRef<HTMLElement>(null);
  const adopt = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && host.parentElement !== el) el.appendChild(host);
    },
    [host],
  );

  // Pane contents render through a portal, so their React events do not reach this element;
  // native listeners see focus, pointer and drag events from the header and the contents alike.
  const change = useRef(onChange);
  useEffect(() => {
    change.current = onChange;
  });
  useEffect(() => {
    const el = section.current;
    if (!el) return;
    const activate = () => change.current((l) => setActive(l, pane.id));
    const carries = (e: DragEvent) => !!e.dataTransfer?.types?.includes(DRAG_TYPE);
    const over = (e: DragEvent) => {
      if (!carries(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      el.dataset.drop = 'true';
    };
    const leave = (e: DragEvent) => {
      if (!el.contains(e.relatedTarget as Node | null)) delete el.dataset.drop;
    };
    const drop = (e: DragEvent) => {
      delete el.dataset.drop;
      if (!carries(e)) return;
      const from = e.dataTransfer?.getData(DRAG_TYPE);
      if (!from) return;
      e.preventDefault();
      if (from !== pane.id) change.current((l) => swapPanes(l, from, pane.id));
    };
    el.addEventListener('focusin', activate);
    el.addEventListener('pointerdown', activate, true);
    el.addEventListener('dragover', over);
    el.addEventListener('dragleave', leave);
    el.addEventListener('drop', drop);
    return () => {
      el.removeEventListener('focusin', activate);
      el.removeEventListener('pointerdown', activate, true);
      el.removeEventListener('dragover', over);
      el.removeEventListener('dragleave', leave);
      el.removeEventListener('drop', drop);
    };
  }, [pane.id]);

  // A focus request lands on the pane's first control, or its title. While the contents load it
  // retries briefly, but never takes focus back once the user has moved it elsewhere.
  useEffect(() => {
    if (!focus) return;
    let tries = 10;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const from = document.activeElement;
    const attempt = () => {
      if (tries < 10 && document.activeElement !== from) return;
      const target =
        host.querySelector<HTMLElement>('[data-pane-focus]') ??
        host.querySelector<HTMLElement>(
          'textarea, input, button:not([disabled]), [tabindex="0"], a[href]',
        );
      if (target) target.focus();
      else if (tries-- > 0) timer = setTimeout(attempt, 50);
      else section.current?.querySelector<HTMLElement>('.pane-title')?.focus();
    };
    attempt();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [focus, host]);

  const maximized = layout.maximized === pane.id;
  const chrome = !single && !phone;
  const parent = parentDirection(layout.root, pane.id);
  const [earlier, later] =
    parent === 'column' ? ['Move up', 'Move down'] : ['Move left', 'Move right'];
  const siblings = siblingPlace(layout.root, pane.id);
  const more: MenuItem[] = [
    {
      id: 'earlier',
      label: earlier,
      disabled: !siblings.earlier,
      onSelect: () => onChange((l) => movePane(l, pane.id, -1)),
    },
    {
      id: 'later',
      label: later,
      disabled: !siblings.later,
      onSelect: () => onChange((l) => movePane(l, pane.id, 1)),
    },
    { id: 'reset', label: 'Reset layout', onSelect: () => onChange(resetKeepingBottom) },
  ];

  return (
    <section
      ref={section}
      className="pane"
      aria-labelledby={chrome ? titleId : undefined}
      aria-label={chrome ? undefined : info.title}
      data-kind={pane.kind}
      data-active={active || undefined}
    >
      {chrome ? (
        <div
          className="pane-head"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(DRAG_TYPE, pane.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
        >
          <span className="pane-grip" aria-hidden="true">
            <Icon name="grip" />
          </span>
          <Icon name={info.icon} />
          <h2 id={titleId} className="pane-title" tabIndex={-1}>
            {info.title}
          </h2>
          <span className="pane-head-spacer" />
          <IconButton
            label={`Split ${info.title} right`}
            icon={<Icon name="split-right" />}
            variant="ghost"
            onClick={() => onSplit(pane.id, 'row')}
          />
          <IconButton
            label={`Split ${info.title} down`}
            icon={<Icon name="split-down" />}
            variant="ghost"
            onClick={() => onSplit(pane.id, 'column')}
          />
          <IconButton
            label={maximized ? `Restore ${info.title}` : `Maximize ${info.title}`}
            icon={<Icon name={maximized ? 'restore' : 'maximize'} />}
            variant="ghost"
            aria-pressed={maximized}
            onClick={() => onChange((l) => toggleMaximize(l, pane.id))}
          />
          <Menu
            label={`More actions for ${info.title}`}
            trigger={<Icon name="more" />}
            items={more}
          />
          {pane.kind === 'main' ? null : (
            <IconButton
              label={`Close ${info.title}`}
              icon={<Icon name="close" />}
              variant="ghost"
              onClick={() => onChange((l) => closePane(l, pane.id))}
            />
          )}
        </div>
      ) : null}
      <div className="pane-body" ref={adopt} />
    </section>
  );
}

/** Reset the panes; the bottom panel keeps its state. */
export function resetKeepingBottom(l: ModeLayout): ModeLayout {
  return { ...defaultLayout(), bottom: l.bottom };
}

function parentDirection(node: LayoutNode, id: string): 'row' | 'column' | null {
  if (node.type === 'pane') return null;
  if (node.children.some((c) => c.id === id)) return node.direction;
  for (const c of node.children) {
    const d = parentDirection(c, id);
    if (d) return d;
  }
  return null;
}

function siblingPlace(node: LayoutNode, id: string): { earlier: boolean; later: boolean } {
  if (node.type === 'pane') return { earlier: false, later: false };
  const i = node.children.findIndex((c) => c.id === id);
  if (i >= 0) return { earlier: i > 0, later: i < node.children.length - 1 };
  for (const c of node.children) {
    const r = siblingPlace(c, id);
    if (r.earlier || r.later) return r;
  }
  return { earlier: false, later: false };
}

function PaneSwitcher({
  panes,
  activeId,
  info,
  onSelect,
  onClose,
}: {
  panes: PaneLeaf[];
  activeId: string;
  info: (p: PaneLeaf) => PaneInfo;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const current = Math.max(
    0,
    panes.findIndex((p) => p.id === activeId),
  );
  const activePane = panes[current];
  return (
    <div className="pane-switcher">
      <div
        ref={list}
        role="tablist"
        aria-label="Panes"
        className="pane-switcher-tabs"
        onKeyDown={(e) => {
          const next = rovingIndex(e.key, current, panes.length, 'horizontal');
          if (next === null) return;
          e.preventDefault();
          const p = panes[next];
          if (!p) return;
          onSelect(p.id);
          list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {panes.map((p, i) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={i === current}
            tabIndex={i === current ? 0 : -1}
            className="pane-switcher-tab"
            onClick={() => onSelect(p.id)}
          >
            <Icon name={info(p).icon} /> {info(p).title}
          </button>
        ))}
      </div>
      {activePane && activePane.kind !== 'main' ? (
        <IconButton
          label={`Close ${info(activePane).title}`}
          icon={<Icon name="close" />}
          variant="ghost"
          onClick={() => onClose(activePane.id)}
        />
      ) : null}
    </div>
  );
}
