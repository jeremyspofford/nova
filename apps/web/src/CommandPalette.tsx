// Command palette (FR-003): opens on mod+K or mod+shift+P, fuzzy-searches the registry, runs on
// Enter, and is fully keyboard-operable as a modal dialog.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Kbd } from '@nova/ui';
import { filterCommands, isMac, type CommandRegistry } from './commands.ts';

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
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = results[active];
      if (cmd) {
        onClose();
        cmd.run();
      }
    }
  };

  const mod = isMac() ? '⌘' : 'Ctrl';
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
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
          aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          aria-label="Search commands"
          placeholder="Type a command"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <ul id="palette-list" role="listbox" className="palette-list">
          {results.length === 0 ? (
            <li className="palette-empty" role="option" aria-selected="false" aria-disabled="true">
              {commands.length === 0 ? 'No commands yet' : 'No matching commands'}
            </li>
          ) : (
            results.map((c, i) => (
              <li
                key={c.id}
                id={`cmd-${c.id}`}
                role="option"
                aria-selected={i === active}
                className="palette-item"
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  onClose();
                  c.run();
                }}
              >
                <span className="palette-category">{c.category}</span>
                <span>{c.title}</span>
                {c.binding ? (
                  <Kbd
                    keys={c.binding.split('+').map((k) => (k === 'mod' ? mod : k.toUpperCase()))}
                  />
                ) : null}
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
