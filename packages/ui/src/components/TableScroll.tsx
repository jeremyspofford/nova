// A wide table on a narrow screen (WCAG 1.4.10 exempts two-dimensional tables): the table scrolls
// sideways inside this region instead of the page. When it does overflow, the region is a named
// keyboard stop so arrow keys can scroll it (axe: scrollable-region-focusable); otherwise it is not.
import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface TableScrollProps {
  /** What the region holds, for assistive tech (usually the table's caption or heading). */
  label: string;
  children: ReactNode;
}

export function TableScroll({ label, children }: TableScrollProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => setOverflows(el.scrollWidth > el.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="nv-table-scroll"
      role={overflows ? 'region' : undefined}
      aria-label={overflows ? label : undefined}
      tabIndex={overflows ? 0 : undefined}
    >
      {children}
    </div>
  );
}
