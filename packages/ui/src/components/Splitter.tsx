// Splitter and resizable pane group (docs/04 §4.2, §4.4; WAI-ARIA window splitter pattern). The
// splitter is a focusable separator whose value is the boundary position in percent of its
// container: arrow keys move it by `step` (Shift: four steps), Home and End go to the limits, and a
// pointer drag moves it with the pointer. A PaneGroup lays out panes in a row or column with a
// splitter between each pair; sizes are fractions that always sum to 1 (FR-005).
import { Children, isValidElement, useRef, type ReactNode } from 'react';
import { readingDirection } from '../focus.ts';

export type SplitterOrientation = 'vertical' | 'horizontal';

export interface SplitterProps {
  /** Accessible name, e.g. "Resize Chat and Editor". */
  label: string;
  /**
   * A `vertical` separator stands between side-by-side panes and moves left and right; a
   * `horizontal` one stands between stacked panes and moves up and down.
   */
  orientation: SplitterOrientation;
  /** Boundary position, 0 to 100 percent of the container. */
  value: number;
  min?: number;
  max?: number;
  /** Keyboard step in percent (default 5). */
  step?: number;
  /** Called with the change in percent; the owner clamps and applies it. */
  onMove: (delta: number) => void;
  /** Ids of the panes the splitter resizes. */
  controls?: string;
  className?: string;
}

const round = (n: number) => Math.round(n * 10) / 10;

export function Splitter({
  label,
  orientation,
  value,
  min = 0,
  max = 100,
  step = 5,
  onMove,
  controls,
  className,
}: SplitterProps) {
  const drag = useRef<{
    start: number;
    from: number;
    size: number;
    applied: number;
    sign: number;
  } | null>(null);
  const vertical = orientation === 'vertical';
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  // In right-to-left the first pane is on the right: moving the boundary left grows it (FR-016).
  const signAt = (el: Element) => (vertical && readingDirection(el) === 'rtl' ? -1 : 1);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const big = (e.shiftKey ? step * 4 : step) * signAt(e.currentTarget);
    let target: number | null = null;
    if (e.key === (vertical ? 'ArrowLeft' : 'ArrowUp')) target = value - big;
    else if (e.key === (vertical ? 'ArrowRight' : 'ArrowDown')) target = value + big;
    else if (e.key === 'Home') target = min;
    else if (e.key === 'End') target = max;
    if (target === null) return;
    e.preventDefault();
    const delta = clamp(target) - value;
    if (delta !== 0) onMove(delta);
  };

  const point = (e: React.PointerEvent) => (vertical ? e.clientX : e.clientY);

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={round(value)}
      aria-valuemin={round(min)}
      aria-valuemax={round(max)}
      aria-controls={controls}
      data-orientation={orientation}
      className={className ? `nv-splitter ${className}` : 'nv-splitter'}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const box = e.currentTarget.parentElement?.getBoundingClientRect();
        const size = box ? (vertical ? box.width : box.height) : 0;
        if (size <= 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.currentTarget.focus();
        drag.current = {
          start: point(e),
          from: value,
          size,
          applied: 0,
          sign: signAt(e.currentTarget),
        };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const wanted = ((point(e) - d.start) / d.size) * 100 * d.sign;
        // Apply only what is left after earlier moves of this drag, within the limits.
        const next = clamp(d.from + wanted) - (d.from + d.applied);
        if (Math.abs(next) < 0.05) return;
        d.applied += next;
        onMove(next);
      }}
      onPointerUp={(e) => {
        drag.current = null;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    />
  );
}

export interface PaneGroupProps {
  /** `row` puts panes side by side; `column` stacks them. */
  direction: 'row' | 'column';
  /** One fraction per child, summing to 1. */
  sizes: readonly number[];
  onSizes: (sizes: number[]) => void;
  /** Accessible name of the splitter after child `i`. */
  splitterLabel: (i: number) => string;
  /** Smallest share a pane can be resized to (default 0.1). */
  minSize?: number;
  children: ReactNode;
  className?: string;
}

/** Moves the boundary after pane `i` by `delta` (a fraction), keeping both panes above `min`. */
export function moveBoundary(
  sizes: readonly number[],
  i: number,
  delta: number,
  min: number,
): number[] {
  const a = sizes[i];
  const b = sizes[i + 1];
  if (a === undefined || b === undefined) return [...sizes];
  const d = Math.max(min - a, Math.min(b - min, delta));
  const out = [...sizes];
  out[i] = a + d;
  out[i + 1] = b - d;
  return out;
}

export function PaneGroup({
  direction,
  sizes,
  onSizes,
  splitterLabel,
  minSize = 0.1,
  children,
  className,
}: PaneGroupProps) {
  const items = Children.toArray(children);
  const share = (i: number) => sizes[i] ?? 1 / Math.max(1, items.length);
  const out: ReactNode[] = [];
  let before = 0;
  items.forEach((child, i) => {
    const size = share(i);
    // Cells follow their child's key, so reordering moves panes instead of remounting them.
    const key = isValidElement(child) && child.key !== null ? child.key : i;
    out.push(
      <div key={`cell-${key}`} className="nv-pane-cell" style={{ flex: `${size} 1 0` }}>
        {child}
      </div>,
    );
    before += size;
    if (i < items.length - 1) {
      const start = before - size;
      const next = share(i + 1);
      out.push(
        <Splitter
          key={`split-${i}`}
          label={splitterLabel(i)}
          orientation={direction === 'row' ? 'vertical' : 'horizontal'}
          value={before * 100}
          min={(start + minSize) * 100}
          max={(before + next - minSize) * 100}
          onMove={(delta) => onSizes(moveBoundary(sizes, i, delta / 100, minSize))}
        />,
      );
    }
  });
  return (
    <div className={className ? `nv-panes ${className}` : 'nv-panes'} data-direction={direction}>
      {out}
    </div>
  );
}
