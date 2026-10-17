// Quick symbol search for a Code session (FR-074): type a name, pick a symbol, and its file opens
// at its line. An ARIA combobox: arrows move through the results, Enter opens one, Escape
// closes the list (and clears the box when the list is already closed).
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import type { CodeSymbolView } from '@nova/shared';
import { VisuallyHidden } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { plural } from '../settings/common.ts';

/** Wait this long after the last key before asking the Hub. */
export const SYMBOL_DEBOUNCE_MS = 200;

interface Results {
  query: string;
  items: CodeSymbolView[];
  error: string | null;
}

export function SymbolSearch({
  sessionId,
  onPick,
}: {
  sessionId: string;
  onPick: (s: CodeSymbolView) => void;
}) {
  const { api } = useServices();
  const id = `sym${useId()}`;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = query.trim();

  useEffect(() => {
    if (!q) return;
    let alive = true;
    const timer = setTimeout(() => {
      api.codeSymbols(sessionId, q).then(
        ({ items }) => alive && setResults({ query: q, items: items.slice(0, 50), error: null }),
        (err: unknown) =>
          alive &&
          setResults({
            query: q,
            items: [],
            error: errorMessage(err, 'Could not search symbols.'),
          }),
      );
    }, SYMBOL_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, q, sessionId]);

  const current = results && results.query === q ? results : null;
  const items = q ? (current?.items ?? []) : [];
  const expanded = open && !!q && !!current;
  const index = Math.min(active, Math.max(0, items.length - 1));

  const pick = (s: CodeSymbolView) => {
    setOpen(false);
    onPick(s);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      setOpen(true);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((index + step + items.length) % items.length);
    } else if (e.key === 'Enter') {
      const s = expanded ? items[index] : undefined;
      if (!s) return;
      e.preventDefault();
      pick(s);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (expanded) setOpen(false);
      else setQuery('');
    }
  };

  const status = !q
    ? ''
    : !current
      ? 'Searching…'
      : current.error
        ? current.error
        : current.items.length
          ? `${plural(current.items.length, 'symbol')} found.`
          : 'No symbols match.';

  return (
    <div className="code-symbols" role="search" aria-label="Symbols">
      <label htmlFor={`${id}-input`} className="nv-vh">
        Go to symbol
      </label>
      <input
        id={`${id}-input`}
        className="nv-input code-symbols-input"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={`${id}-list`}
        aria-activedescendant={expanded && items.length ? `${id}-opt-${index}` : undefined}
        placeholder="Go to symbol"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      <ul id={`${id}-list`} role="listbox" aria-label="Symbols found" hidden={!expanded}>
        {items.map((s, i) => (
          <li
            key={`${s.path}:${s.line}:${s.name}`}
            id={`${id}-opt-${i}`}
            role="option"
            aria-selected={i === index}
            className="code-symbol"
            // Keep focus in the box: mousedown would blur it and close the list first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(s)}
          >
            <span className="code-symbol-name">{s.name}</span>{' '}
            <span className="muted">
              {s.kind}
              {s.container ? ` in ${s.container}` : ''} · {s.path}:{s.line}
            </span>
          </li>
        ))}
      </ul>
      <VisuallyHidden>
        <span role="status">{open ? status : ''}</span>
      </VisuallyHidden>
    </div>
  );
}
