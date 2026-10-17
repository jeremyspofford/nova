// A list of host patterns for the egress proxy (FR-193, docs/12 §8), checked the way the Hub
// checks them: host names or IP addresses, a wildcard only as the whole leftmost label
// (`*.example.com`, never over a top-level domain), and never a bare `*`. Several entries can be
// added at once, separated by spaces or commas; nothing is added unless every entry is valid,
// and a failed save keeps what was typed.
import { useId, useRef, useState } from 'react';
import { checkHostPattern } from '@nova/shared';
import { Button, Icon, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { normalizeHost } from '../computers/format.ts';
import { useAnnounce } from '../services.tsx';
import { MANAGED } from '../settings/common.ts';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Why the typed entries cannot be added (first problem), or the normalized new entries. */
export function parseHostEntries(
  text: string,
  existing: readonly string[],
): { ok: true; hosts: string[] } | { ok: false; error: string } {
  const entries = text.split(/[\s,]+/).filter(Boolean);
  if (!entries.length) return { ok: false, error: 'Type a host name or IP address.' };
  const seen = new Set(existing.map(normalizeHost));
  const out: string[] = [];
  for (const e of entries) {
    const why = checkHostPattern(e);
    if (why) return { ok: false, error: `${capital(why)}.` };
    const h = normalizeHost(e);
    if (seen.has(h)) return { ok: false, error: `${h} is already in the list.` };
    seen.add(h);
    out.push(h);
  }
  return { ok: true, hosts: out };
}

export function HostListEditor({
  label,
  inputLabel,
  hint,
  hosts,
  onChange,
  locked,
  disabled,
  annotate,
  emptyText = 'None.',
}: {
  /** Names the list and the group (e.g. "Allowed hosts"). */
  label: string;
  /** The text field's label (e.g. "Add an allowed host"). */
  inputLabel: string;
  hint?: string;
  hosts: readonly string[];
  /** Save the new list; a rejection keeps the typed text and shows why. */
  onChange: (next: string[]) => Promise<void> | void;
  locked?: boolean;
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
      setError(errorMessage(err, 'Could not save the list.'));
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
    if (await save([...hosts, ...parsed.hosts], `Added ${parsed.hosts.join(', ')}.`)) setText('');
  };

  const remove = async (host: string) => {
    if (off) return;
    if (
      await save(
        hosts.filter((h) => h !== host),
        `Removed ${host}.`,
      )
    )
      setTimeout(() => input.current?.focus(), 0);
  };

  return (
    <fieldset className="hosts" aria-describedby={hint ? `${id}-hint` : undefined}>
      <legend className="nv-field-label">{label}</legend>
      {locked ? <span className="nv-field-hint nv-field-lock">{MANAGED}</span> : null}
      {hint ? (
        <span id={`${id}-hint`} className="nv-field-hint">
          {hint}
        </span>
      ) : null}
      {hosts.length ? (
        <ul className="hosts-list" aria-label={label}>
          {hosts.map((h) => {
            const why = checkHostPattern(h);
            const note = annotate?.(h) ?? null;
            return (
              <li key={h} className="hosts-item">
                <code className="hosts-name">{h}</code>
                {why ? (
                  <span className="ws-badge" data-tone="warn">
                    <Icon name="alert" /> Not valid, remove it: {why}
                  </span>
                ) : null}
                {note ? <span className="muted hosts-note">{note}</span> : null}
                <Button
                  variant="ghost"
                  disabled={off}
                  aria-label={`Remove ${h} from ${label.toLowerCase()}`}
                  onClick={() => void remove(h)}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted ws-flush">{emptyText}</p>
      )}
      <div className="ws-toolbar hosts-add">
        <TextField
          ref={input}
          label={inputLabel}
          value={text}
          disabled={locked || disabled}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder="api.example.com, *.example.org"
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
          <Icon name="plus" /> Add
        </Button>
      </div>
    </fieldset>
  );
}
