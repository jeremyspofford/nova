// Menu button and context menu (docs/04 §4.2). Items use a roving tabindex: arrows, Home/End and
// first-letter type-ahead move focus; Enter or Space selects; Esc closes and returns focus to the
// trigger; Tab or a click outside closes.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { rovingIndex } from '../focus.ts';

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  /** Accessible name of the trigger button. */
  label: string;
  items: MenuItem[];
  /** Visible trigger content (an icon or text). Defaults to the label. */
  trigger?: ReactNode;
  /** Controlled open state (for context menus opened from elsewhere). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Viewport point to open at (context menu); otherwise the menu drops below the trigger. */
  at?: { x: number; y: number } | null;
  triggerProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'aria-label'>;
  className?: string;
}

export function Menu({
  label,
  items,
  trigger,
  open: controlled,
  onOpenChange,
  at,
  triggerProps,
  className,
}: MenuProps) {
  const [uncontrolled, setUncontrolled] = useState(false);
  const open = controlled ?? uncontrolled;
  const [startAt, setStartAt] = useState<'first' | 'last'>('first');
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const setOpen = (next: boolean) => {
    if (controlled === undefined) setUncontrolled(next);
    onOpenChange?.(next);
  };

  return (
    <span className={className ? `nv-menu-anchor ${className}` : 'nv-menu-anchor'}>
      <button
        type="button"
        ref={button}
        className="nv-btn"
        data-variant="ghost"
        data-size="icon"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setStartAt('first');
          setOpen(!open);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setStartAt(e.key === 'ArrowUp' ? 'last' : 'first');
            setOpen(true);
          }
        }}
        {...triggerProps}
      >
        {trigger ?? label}
      </button>
      {open ? (
        <MenuList
          id={menuId}
          label={label}
          items={items}
          startAt={startAt}
          at={at ?? null}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) button.current?.focus();
          }}
        />
      ) : null}
    </span>
  );
}

function MenuList({
  id,
  label,
  items,
  startAt,
  at,
  onClose,
}: {
  id: string;
  label: string;
  items: MenuItem[];
  startAt: 'first' | 'last';
  at: { x: number; y: number } | null;
  onClose: (refocus: boolean) => void;
}) {
  const list = useRef<HTMLUListElement>(null);
  const enabled = items.filter((i) => !i.disabled);
  const [active, setActive] = useState(() => (startAt === 'last' ? enabled.length - 1 : 0));
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [active]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const anchor = list.current?.parentElement;
      if (anchor && e.target instanceof Node && !anchor.contains(e.target)) closeRef.current(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const select = (item: MenuItem) => {
    onClose(true);
    item.onSelect();
  };

  return (
    <ul
      ref={list}
      id={id}
      role="menu"
      aria-label={label}
      className="nv-menu"
      data-placement={at ? 'point' : 'below'}
      style={at ? { position: 'fixed', left: at.x, top: at.y } : undefined}
      onKeyDown={(e) => {
        const next = rovingIndex(e.key, active, enabled.length);
        if (next !== null) {
          e.preventDefault();
          setActive(next);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose(true);
        } else if (e.key === 'Tab') {
          onClose(false);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const item = enabled[active];
          if (item) select(item);
        } else if (e.key.length === 1 && /\S/.test(e.key)) {
          const k = e.key.toLowerCase();
          const from = enabled.findIndex(
            (it, i) => i > active && it.label.toLowerCase().startsWith(k),
          );
          const wrap = enabled.findIndex((it) => it.label.toLowerCase().startsWith(k));
          const hit = from >= 0 ? from : wrap;
          if (hit >= 0) setActive(hit);
        }
      }}
    >
      {items.map((item) => {
        const idx = enabled.indexOf(item);
        return (
          <li
            key={item.id}
            role="menuitem"
            tabIndex={idx === active ? 0 : -1}
            aria-disabled={item.disabled ? true : undefined}
            data-danger={item.danger ? true : undefined}
            className="nv-menu-item"
            onClick={() => {
              if (!item.disabled) select(item);
            }}
            onMouseEnter={() => {
              if (idx >= 0) setActive(idx);
            }}
          >
            {item.label}
          </li>
        );
      })}
    </ul>
  );
}
