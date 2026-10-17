// Command palette (FR-003): opens on mod+K or mod+shift+P, fuzzy-searches the registry, shows each
// command's current binding, runs on Enter, and is fully keyboard-operable as a modal dialog. A
// Picker uses the same dialog for a list a command offers, e.g. "Open app…" (FR-198).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Kbd, trapTab } from '@nova/ui';
import { filterCommands, fuzzyScore, type CommandRegistry } from './commands.ts';
import { formatBinding } from './keys.ts';

export interface CommandPaletteProps {
  registry: CommandRegistry;
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ registry, open, onClose }: CommandPaletteProps) {
  // Mounting the dialog only while open resets its query and selection on every open.
  if (!open) return null;
  return <PaletteDialog registry={registry} onClose={onClose} />;
}

function PaletteDialog({ registry, onClose }: Omit<CommandPaletteProps, 'open'>) {
  const commands = useSyncExternalStore(
    (fn) => registry.subscribe(fn),
    () => registry.list(),
  );
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const mac = registry.platform.mac;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => {
      queueMicrotask(() => {
        // Running a command may move focus on purpose; only restore when it was left nowhere.
        const now = document.activeElement;
        if (opener?.isConnected && (!now || now === document.body)) opener.focus();
      });
    };
  }, []);

  useEffect(() => {
    document.getElementById(`cmd-${results[active]?.id ?? ''}`)?.scrollIntoView?.({
      block: 'nearest',
    });
  }, [active, results]);

  const runAt = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    onClose();
    // Let the dialog unmount first so the command can move focus freely.
    queueMicrotask(() => cmd.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runAt(active);
    } else {
      trapTab(e, panel.current);
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={input}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          aria-label="Search commands"
          placeholder="Type a command"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <ul id="palette-list" role="listbox" aria-label="Commands" className="palette-list">
          {results.length === 0 ? (
            <li className="palette-empty" role="option" aria-selected="false" aria-disabled="true">
              {commands.length === 0 ? 'No commands yet' : 'No matching commands'}
            </li>
          ) : (
            results.map((c, i) => {
              const binding = registry.primaryBinding(c.id);
              return (
                <li
                  key={c.id}
                  id={`cmd-${c.id}`}
                  role="option"
                  aria-selected={i === active}
                  className="palette-item"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => runAt(i)}
                >
                  <span className="palette-category">{c.category}</span>
                  <span className="palette-title">{c.title}</span>
                  {binding ? <Kbd keys={formatBinding(binding, mac)} /> : null}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}

export interface PickerOption {
  id: string;
  label: string;
  detail?: string | null;
}

export interface PickerProps {
  /** Names the dialog, e.g. "Open app". */
  label: string;
  placeholder: string;
  /** Null while the options load. */
  options: PickerOption[] | null;
  /** Shown when there are no options at all. */
  empty: string;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** A modal list to choose one item from, with the palette's search and keys. */
export function Picker({ label, placeholder, options, empty, onPick, onClose }: PickerProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const results = useMemo(
    () =>
      (options ?? [])
        .map((o) => ({ o, s: fuzzyScore(query, `${o.label} ${o.detail ?? ''}`) }))
        .filter((x): x is { o: PickerOption; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.o),
    [options, query],
  );

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.current?.focus();
    return () => {
      queueMicrotask(() => {
        const now = document.activeElement;
        if (opener?.isConnected && (!now || now === document.body)) opener.focus();
      });
    };
  }, []);

  const pickAt = (i: number) => {
    const o = results[i];
    if (!o) return;
    onClose();
    queueMicrotask(() => onPick(o.id));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pickAt(active);
    } else {
      trapTab(e, panel.current);
    }
  };

  const optionId = (o: PickerOption) => `pick-${o.id}`;
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={input}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="picker-list"
          aria-autocomplete="list"
          aria-activedescendant={results[active] ? optionId(results[active]) : undefined}
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <ul id="picker-list" role="listbox" aria-label={label} className="palette-list">
          {options === null ? (
            <li className="palette-empty" role="option" aria-selected="false" aria-disabled="true">
              Loading…
            </li>
          ) : results.length === 0 ? (
            <li className="palette-empty" role="option" aria-selected="false" aria-disabled="true">
              {options.length === 0 ? empty : 'Nothing matches'}
            </li>
          ) : (
            results.map((o, i) => (
              <li
                key={o.id}
                id={optionId(o)}
                role="option"
                aria-selected={i === active}
                className="palette-item"
                onMouseEnter={() => setActive(i)}
                onClick={() => pickAt(i)}
              >
                <span className="palette-title">{o.label}</span>
                {o.detail ? <span className="palette-category">{o.detail}</span> : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
