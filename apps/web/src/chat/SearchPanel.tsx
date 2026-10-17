// Global chat search (FR-017, FR-025): full-text search over messages via GET /search, best
// match first as the Hub ranks them; each hit shows its chat, who wrote it, a snippet with the
// match and the date, and jumps to the message.
import { useEffect, useRef, useState } from 'react';
import type { SearchHit } from '@nova/shared';
import { Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { chatPath, navigate } from '../router.ts';
import { useServices } from '../services.tsx';

export interface SearchPanelProps {
  onClose: () => void;
  onOpen?: () => void;
  debounceMs?: number;
}

type Result =
  | { kind: 'idle' }
  | { kind: 'loading'; q: string }
  | { kind: 'done'; q: string; hits: SearchHit[] }
  | { kind: 'error'; q: string; message: string };

export function SearchPanel({ onClose, onOpen, debounceMs = 200 }: SearchPanelProps) {
  const { api } = useServices();
  const [q, setQ] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });
  const input = useRef<HTMLInputElement>(null);
  const term = q.trim();

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (!term) return;
    let alive = true;
    const t = setTimeout(() => {
      setResult({ kind: 'loading', q: term });
      api.search(term, 20).then(
        ({ items }) => alive && setResult({ kind: 'done', q: term, hits: items }),
        (err: unknown) =>
          alive &&
          setResult({ kind: 'error', q: term, message: errorMessage(err, 'Search failed.') }),
      );
    }, debounceMs);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [api, term, debounceMs]);

  const shown: Result = term ? result : { kind: 'idle' };

  const open = (h: SearchHit) => {
    navigate(chatPath(h.threadId, h.messageId));
    onOpen?.();
  };

  return (
    <div
      className="search-panel"
      role="search"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === 'ArrowDown' && e.target === input.current) {
          e.preventDefault();
          e.currentTarget.querySelector<HTMLElement>('.search-hit')?.focus();
        }
      }}
    >
      <label htmlFor="global-search" className="nv-vh">
        Search chats
      </label>
      <div className="search-box">
        <input
          id="global-search"
          ref={input}
          type="search"
          className="nv-input"
          placeholder="Search chats"
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <div aria-live="polite" className="search-status">
        {shown.kind === 'loading' ? <Spinner label="Searching" /> : null}
        {shown.kind === 'done'
          ? shown.hits.length
            ? `${shown.hits.length} ${shown.hits.length === 1 ? 'result' : 'results'}`
            : `No messages match “${shown.q}”.`
          : null}
        {shown.kind === 'error' ? <span role="alert">{shown.message}</span> : null}
      </div>
      {shown.kind === 'done' && shown.hits.length ? (
        <ul className="search-hits" aria-label="Search results">
          {shown.hits.map((h) => (
            <li key={h.messageId}>
              <a
                href={chatPath(h.threadId, h.messageId)}
                className="search-hit"
                onClick={(e) => {
                  e.preventDefault();
                  open(h);
                }}
                onKeyDown={(e) => {
                  const li = e.currentTarget.parentElement;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    li?.nextElementSibling?.querySelector<HTMLElement>('a')?.focus();
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const prev = li?.previousElementSibling?.querySelector<HTMLElement>('a');
                    (prev ?? input.current)?.focus();
                  }
                }}
              >
                <span className="search-hit-title">{h.threadTitle?.trim() || 'Untitled chat'}</span>
                {h.role ? <span className="search-hit-role">{roleName(h.role)}</span> : null}
                <Snippet text={h.snippet} />
                <time className="muted search-hit-date" dateTime={h.createdAt}>
                  {formatDate(h.createdAt)}
                </time>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Snippets mark the match with <mark>…</mark>. Everything is rendered as text and only the marker
 * becomes a highlight, so a snippet can never inject markup.
 */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(<mark>.*?<\/mark>)/g).filter(Boolean);
  return (
    <span className="search-hit-snippet">
      {parts.map((p, i) => {
        const m = /^<mark>(.*)<\/mark>$/.exec(p);
        return m ? <mark key={i}>{m[1]}</mark> : <span key={i}>{p}</span>;
      })}
    </span>
  );
}

function roleName(role: NonNullable<SearchHit['role']>): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Assistant';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
