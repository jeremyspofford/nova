// Command palette (FR-003): opens on mod+K or mod+shift+P, fuzzy-searches the registry, shows each
// command's current binding, runs on Enter, and is fully keyboard-operable as a modal dialog.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Kbd, trapTab } from '@nova/ui';
import { filterCommands, type CommandRegistry } from './commands.ts';
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
