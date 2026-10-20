// A list of host patterns for the egress proxy (FR-193, docs/12 §8), checked the way the Hub
// checks them: host names or IP addresses, a wildcard only as the whole leftmost label
// (`*.example.com`, never over a top-level domain), and never a bare `*`. Several entries can be
// added at once, separated by spaces or commas; nothing is added unless every entry is valid,
// and a failed save keeps what was typed.
import { useId, useRef, useState } from 'react';
import { fmt } from '@nova/i18n';
import { checkHostPattern } from '@nova/shared';
import { Button, Icon, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { normalizeHost } from '../computers/format.ts';
import { useAnnounce } from '../services.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { HOSTS_TEXT } from './strings.ts';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Why `pattern` is not a valid host pattern, as a sentence in the active locale, or null. The
 * check is the Hub's (`checkHostPattern`, which words its reasons in English for the Hub's own
 * errors); its reasons map to messages here, and an unknown one shows as it is.
 */
export function hostProblem(pattern: string): string | null {
  const why = checkHostPattern(pattern);
  if (!why) return null;
  const P = HOSTS_TEXT.problem;
  if (why.startsWith('a bare *')) return P.bare;
  if (why === 'empty host') return P.empty;
  if (why === 'host name is too long') return P.tooLong;
  if (why.startsWith('not a host')) return P.notHost({ host: pattern });
  if (why.startsWith('a wildcard is allowed only')) return P.wildcardLeft({ host: pattern });
  if (why.startsWith('a wildcard cannot cover')) return P.wildcardTld({ host: pattern });
  return `${capital(why)}.`;
}

/** Why the typed entries cannot be added (first problem), or the normalized new entries. */
export function parseHostEntries(
  text: string,
  existing: readonly string[],
): { ok: true; hosts: string[] } | { ok: false; error: string } {
  const entries = text.split(/[\s,]+/).filter(Boolean);
  if (!entries.length) return { ok: false, error: HOSTS_TEXT.typeHost };
  const seen = new Set(existing.map(normalizeHost));
  const out: string[] = [];
  for (const e of entries) {
    const why = hostProblem(e);
    if (why) return { ok: false, error: why };
    const h = normalizeHost(e);
    if (seen.has(h)) return { ok: false, error: HOSTS_TEXT.already({ host: h }) };
    seen.add(h);
    out.push(h);
  }
  return { ok: true, hosts: out };
}

export function HostListEditor({
  label,
  inputLabel,
  removeLabel,
  hint,
  hosts,
  onChange,
  locked,
  setting,
  disabled,
  annotate,
  emptyText,
}: {
  /** Names the list and the group (e.g. "Allowed hosts"). */
  label: string;
  /** The text field's label (e.g. "Add an allowed host"). */
  inputLabel: string;
  /** An entry's Remove button's name (e.g. "Remove a.test from allowed hosts"). */
  removeLabel: (host: string) => string;
  hint?: string;
  hosts: readonly string[];
  /** Save the new list; a rejection keeps the typed text and shows why. */
  onChange: (next: string[]) => Promise<void> | void;
  locked?: boolean;
  /** The setting the list shows: a lock then names the policy's source. */
  setting?: string;
  disabled?: boolean;
  /** A note for one entry, e.g. that it is also blocked. */
  annotate?: (host: string) => string | null;
  emptyText?: string;
}) {
  const id = useId();
  const announce = useAnnounce();
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const off = locked || disabled || busy;

  const save = async (next: string[], done: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
      announce(done);
      return true;
    } catch (err) {
      setError(errorMessage(err, HOSTS_TEXT.saveError));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (off) return;
    const parsed = parseHostEntries(text, hosts);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (
      await save([...hosts, ...parsed.hosts], HOSTS_TEXT.added({ hosts: fmt.list(parsed.hosts) }))
    )
      setText('');
  };

  const remove = async (host: string) => {
    if (off) return;
    if (
      await save(
        hosts.filter((h) => h !== host),
        HOSTS_TEXT.removed({ host }),
      )
    )
      setTimeout(() => input.current?.focus(), 0);
  };

  return (
    <fieldset
      className="hosts"
      aria-describedby={
        [locked ? `${id}-lock` : null, hint ? `${id}-hint` : null].filter(Boolean).join(' ') ||
        undefined
      }
    >
      <legend className="nv-field-label">{label}</legend>
      {locked ? <ManagedNote id={`${id}-lock`} setting={setting} /> : null}
      {hint ? (
        <span id={`${id}-hint`} className="nv-field-hint">
          {hint}
        </span>
      ) : null}
      {hosts.length ? (
        <ul className="hosts-list" aria-label={label}>
          {hosts.map((h) => {
            const why = hostProblem(h);
            const note = annotate?.(h) ?? null;
            return (
              <li key={h} className="hosts-item">
                <code className="hosts-name">{h}</code>
                {why ? (
                  <span className="ws-badge" data-tone="warn">
                    <Icon name="alert" /> {HOSTS_TEXT.invalid({ why })}
                  </span>
                ) : null}
                {note ? <span className="muted hosts-note">{note}</span> : null}
                <Button
                  variant="ghost"
                  disabled={off}
                  aria-label={removeLabel(h)}
                  onClick={() => void remove(h)}
                >
                  {HOSTS_TEXT.remove}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted ws-flush">{emptyText ?? HOSTS_TEXT.none}</p>
      )}
      <div className="ws-toolbar hosts-add">
        <TextField
          ref={input}
          label={inputLabel}
          value={text}
          disabled={locked || disabled}
          aria-describedby={locked ? `${id}-lock` : undefined}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder={HOSTS_TEXT.placeholder}
          error={error ?? undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
        <Button disabled={off || !text.trim()} onClick={() => void add()}>
          <Icon name="plus" /> {HOSTS_TEXT.add}
        </Button>
      </div>
    </fieldset>
  );
}
