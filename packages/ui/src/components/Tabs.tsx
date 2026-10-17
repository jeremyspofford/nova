// Tabs (docs/04 §4.2): one tab stop for the tablist; arrows, Home and End move and select
// (automatic activation); the panel is labelled by its tab.
import { useId, useRef, type ReactNode } from 'react';
import { rovingIndex } from '../focus.ts';

export interface TabItem {
  id: string;
  label: ReactNode;
  panel: ReactNode;
}

export interface TabsProps {
  /** Accessible name of the tablist. */
  label: string;
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

export function Tabs({ label, items, value, onChange, className }: TabsProps) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const current = Math.max(
    0,
    items.findIndex((t) => t.id === value),
  );
  const selected = items[current];

  return (
    <div className={className ? `nv-tabs ${className}` : 'nv-tabs'}>
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        className="nv-tablist"
        onKeyDown={(e) => {
          const next = rovingIndex(e.key, current, items.length, 'horizontal');
          if (next === null) return;
          e.preventDefault();
          const item = items[next];
          if (!item) return;
          onChange(item.id);
          list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {items.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={i === current}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={i === current ? 0 : -1}
            className="nv-tab"
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {selected ? (
        <div
          role="tabpanel"
          id={`${base}-panel-${selected.id}`}
          aria-labelledby={`${base}-tab-${selected.id}`}
          tabIndex={0}
          className="nv-tabpanel"
        >
          {selected.panel}
        </div>
      ) : null}
    </div>
  );
}
