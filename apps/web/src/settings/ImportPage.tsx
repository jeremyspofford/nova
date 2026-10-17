// Settings → Import (FR-200, docs/04 §2.11, docs/08 §4.2): a four-step wizard. 1 Source: folders
// on the Hub and the kinds to look for. 2 Choose: what was found, grouped by kind, with items
// already imported (same SHA-256) marked and left out. 3 Review: secrets that move to the vault,
// name conflicts, and what stays off until confirmed. 4 Import: the result, with the import
// records (the ledger) below. Nothing is written before step 4.
import { useEffect, useRef, useState } from 'react';
import type {
  ImportItemView,
  ImportKind,
  ImportPreview,
  ImportRecordView,
  ImportResult,
} from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { formatWhen, plural } from './common.ts';
import { isAbsolutePath } from './PermissionsPage.tsx';
import { shortHash } from './plugin-text.ts';
import '../workspace.css';

export const IMPORT_KINDS: { kind: ImportKind; label: string; note?: string }[] = [
  { kind: 'instructions', label: 'Instruction files' },
  { kind: 'skills', label: 'Skills' },
  { kind: 'commands', label: 'Commands', note: 'become skills' },
  { kind: 'plugins', label: 'Plugins', note: 'stay off until you confirm their permissions' },
  { kind: 'mcp_servers', label: 'MCP servers', note: 'stay off until you confirm them' },
  { kind: 'projects', label: 'Projects' },
  { kind: 'memories', label: 'Memories', note: 'you review them before they are saved' },
  { kind: 'chats', label: 'Chat exports' },
];

const KIND_LABEL = Object.fromEntries(IMPORT_KINDS.map((k) => [k.kind, k.label])) as Record<
  ImportKind,
  string
>;

const STATUS_TEXT: Record<ImportItemView['status'], string> = {
  new: 'New',
  duplicate: 'Already imported',
  conflict: 'Name in use',
  unsupported: 'Not supported',
};

const STEPS = ['Source', 'Choose', 'Review', 'Import'] as const;

/** Folder lines to send, or what is wrong with them. */
export function parsePaths(text: string): { paths: string[] } | { error: string } {
  const paths = [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  ];
  if (!paths.length) return { error: 'Enter at least one folder or file on the Hub.' };
  if (paths.length > 20) return { error: 'Scan at most 20 folders or files at a time.' };
  const bad = paths.find((p) => !isAbsolutePath(p));
  if (bad) return { error: `Use a full path: ${bad}` };
  return { paths };
}

/** Preview items by kind, in the wizard's kind order. */
export function groupItems(
  items: readonly ImportItemView[],
): { kind: ImportKind; items: ImportItemView[] }[] {
  return IMPORT_KINDS.map(({ kind }) => ({
    kind,
    items: items.filter((i) => i.kind === kind),
  })).filter((g) => g.items.length > 0);
}

/** Selected by default: new items only; duplicates and unsupported items cannot be chosen. */
export function defaultSelection(items: readonly ImportItemView[]): Set<string> {
  return new Set(items.filter((i) => i.status === 'new').map((i) => i.id));
}

export const selectable = (i: ImportItemView) => i.status === 'new' || i.status === 'conflict';

type Step = 0 | 1 | 2 | 3;

export function ImportPage() {
  const { api } = useServices();
  const [step, setStep] = useState<Step>(0);
  const [pathsText, setPathsText] = useState('');
  const [kinds, setKinds] = useState<Set<ImportKind>>(
    () => new Set(IMPORT_KINDS.map((k) => k.kind)),
  );
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recordsVersion, setRecordsVersion] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  // Move focus to the step heading so the change is announced (not on first load).
  useEffect(() => {
    if (!moved.current) {
      moved.current = true;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const go = (s: Step) => {
    setError(null);
    setStep(s);
  };

  const scan = async () => {
    const parsed = parsePaths(pathsText);
    if ('error' in parsed) return setError(parsed.error);
    if (!kinds.size) return setError('Choose at least one kind of item.');
    setBusy(true);
    setError(null);
    try {
      const p = await api.importPreview({
        paths: parsed.paths,
        kinds: IMPORT_KINDS.map((k) => k.kind).filter((k) => kinds.has(k)),
      });
      setPreview(p);
      setSelected(defaultSelection(p.items));
      go(1);
    } catch (err) {
      setError(errorMessage(err, 'Could not scan those folders.'));
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.importApply(preview.previewId, [...selected]));
      setRecordsVersion((v) => v + 1);
      go(3);
    } catch (err) {
      setError(errorMessage(err, 'The import failed. Nothing was changed.'));
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setPreview(null);
    setSelected(new Set());
    setResult(null);
    go(0);
  };

  const chosen = preview?.items.filter((i) => selected.has(i.id)) ?? [];

  return (
    <div className="settings-page">
      <h2>Import</h2>
      <p className="muted">
        Bring instructions, skills, commands, plugins, MCP servers, projects, memories and chats
        from other assistants. Nova reads the files on the Hub and never changes them.
      </p>
      <section className="settings-section ws-wizard" aria-labelledby="import-step">
        <ol className="ws-steps" aria-label="Import steps">
          {STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={i === step ? 'step' : undefined}
              data-done={i < step || undefined}
            >
              {s}
            </li>
          ))}
        </ol>
        <h3 id="import-step" ref={heading} tabIndex={-1}>
          Step {step + 1} of 4: {STEP_TITLES[step]}
        </h3>

        {step === 0 ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              void scan();
            }}
          >
            <div className="nv-field">
              <label className="nv-field-label" htmlFor="import-paths">
                Folders or files on the Hub
              </label>
              <textarea
                id="import-paths"
                className="nv-input ws-textarea"
                rows={3}
                spellCheck={false}
                value={pathsText}
                placeholder={'/home/me/.config/assistant\n/home/me/Downloads/chat-export.zip'}
                aria-describedby="import-paths-hint"
                onChange={(e) => setPathsText(e.target.value)}
              />
              <span id="import-paths-hint" className="nv-field-hint">
                One per line: a configuration folder, a skills folder, an MCP config file or a chat
                export.
              </span>
            </div>
            <fieldset className="ws-fieldset">
              <legend>Look for</legend>
              <div className="ws-checks">
                {IMPORT_KINDS.map((k) => (
                  <label key={k.kind} className="ws-check">
                    <input
                      type="checkbox"
                      checked={kinds.has(k.kind)}
                      onChange={(e) =>
                        setKinds((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(k.kind);
                          else next.delete(k.kind);
                          return next;
                        })
                      }
                    />
                    <span>
                      {k.label}
                      {k.note ? <span className="muted"> ({k.note})</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {error ? (
              <p role="alert" className="nv-field-error">
                {error}
              </p>
            ) : null}
            <div className="row">
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? <Spinner /> : null} Scan
              </Button>
            </div>
          </form>
        ) : null}

        {step === 1 && preview ? (
          <div className="stack">
            {preview.items.length === 0 ? (
              <p className="muted">Nothing to import was found there.</p>
            ) : null}
            {groupItems(preview.items).map((g) => {
              const dupes = g.items.filter((i) => i.status === 'duplicate').length;
              return (
                <fieldset key={g.kind} className="ws-fieldset">
                  <legend>
                    {KIND_LABEL[g.kind]}: {g.items.length}
                    {dupes ? `, ${dupes} already imported` : ''}
                  </legend>
                  <ul className="ws-list">
                    {g.items.map((i) => (
                      <li key={i.id} className="ws-list-row">
                        <label className="ws-check ws-import-item">
                          <input
                            type="checkbox"
                            checked={selected.has(i.id)}
                            disabled={!selectable(i)}
                            onChange={(e) =>
                              setSelected((s) => {
                                const next = new Set(s);
                                if (e.target.checked) next.add(i.id);
                                else next.delete(i.id);
                                return next;
                              })
                            }
                          />
                          <span className="ws-source-main">
                            <span className="ws-row-meta">
                              <strong>{i.name}</strong>
                              <span
                                className="ws-badge"
                                data-tone={i.status === 'new' ? undefined : 'warn'}
                              >
                                {STATUS_TEXT[i.status]}
                              </span>
                            </span>
                            <span className="muted">Becomes {i.target}</span>
                            <code className="ws-code-inline">{i.sourcePath}</code>
                            {i.maskedSecrets.length ? (
                              <span className="muted">
                                {plural(i.maskedSecrets.length, 'secret')} found; moved to the vault
                              </span>
                            ) : null}
                            {i.note ? <span className="muted">{i.note}</span> : null}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              );
            })}
            <div className="row">
              <Button onClick={() => go(0)}>Back</Button>
              <Button variant="primary" disabled={selected.size === 0} onClick={() => go(2)}>
                Review {plural(selected.size, 'item')}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 2 && preview ? <Review items={chosen} /> : null}
        {step === 2 && preview ? (
          <div className="stack">
            {error ? (
              <p role="alert" className="nv-field-error">
                {error}
              </p>
            ) : null}
            <div className="row">
              <Button onClick={() => go(1)}>Back</Button>
              <Button
                variant="primary"
                disabled={busy || chosen.length === 0}
                onClick={() => void apply()}
              >
                {busy ? <Spinner /> : null} Import {plural(chosen.length, 'item')}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 && result ? (
          <div className="stack" role="status">
            <p className="ws-ok">
              <Icon name="check" /> Import finished.
            </p>
            <dl className="ws-dl">
              <dt>Imported</dt>
              <dd>{plural(result.imported, 'item')}</dd>
              <dt>Skipped as already imported</dt>
              <dd>{plural(result.duplicates, 'item')}</dd>
              <dt>Left off until you confirm them</dt>
              <dd>{plural(result.disabled, 'item')}</dd>
              <dt>Secrets moved to the vault</dt>
              <dd>{plural(result.secretsMigrated, 'secret')}</dd>
            </dl>
            <p className="muted">
              Everything from this import is tagged with its id ({result.importId}) in the{' '}
              <a
                href="#import-records"
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById('import-records')?.focus();
                }}
              >
                import records
              </a>
              . Imported plugins and servers are off: turn them on in Plugins &amp; skills or Tools
              &amp; MCP once you have checked their permissions.
            </p>
            <div className="row">
              <Button onClick={restart}>Import something else</Button>
            </div>
          </div>
        ) : null}
      </section>
      <ImportRecords version={recordsVersion} />
    </div>
  );
}

const STEP_TITLES = [
  'Where to look',
  'Choose what to import',
  'Review before importing',
  'Done',
] as const;

function Review({ items }: { items: ImportItemView[] }) {
  const secrets = items.filter((i) => i.maskedSecrets.length);
  const conflicts = items.filter((i) => i.status === 'conflict');
  const off = items.filter((i) => i.kind === 'plugins' || i.kind === 'mcp_servers');
  const memories = items.filter((i) => i.kind === 'memories');
  return (
    <div className="stack">
      <p>
        {plural(items.length, 'item')} will be imported:{' '}
        {groupItems(items)
          .map((g) => `${KIND_LABEL[g.kind]} (${g.items.length})`)
          .join(', ')}
        .
      </p>
      <section aria-labelledby="import-secrets">
        <h4 id="import-secrets">Secrets</h4>
        {secrets.length ? (
          <>
            <p className="muted">
              These move into the vault. The imported configuration keeps only a secret://
              reference.
            </p>
            <ul className="ws-plain-list">
              {secrets.map((i) =>
                i.maskedSecrets.map((s) => (
                  <li key={`${i.id}-${s}`}>
                    {i.name}: <code className="ws-code-inline">{s}</code>
                  </li>
                )),
              )}
            </ul>
          </>
        ) : (
          <p className="muted">No secrets were found in what you chose.</p>
        )}
      </section>
      {conflicts.length ? (
        <section aria-labelledby="import-conflicts">
          <h4 id="import-conflicts">Names already in use</h4>
          <p className="muted">Go back and untick any you want to skip.</p>
          <ul className="ws-plain-list">
            {conflicts.map((i) => (
              <li key={i.id}>
                {i.name} becomes {i.target}
                {i.note ? `: ${i.note}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {off.length ? (
        <section aria-labelledby="import-off">
          <h4 id="import-off">Stays off</h4>
          <p className="muted">
            Imported plugins and MCP servers stay off until you declare and confirm their
            permissions.
          </p>
          <ul className="ws-plain-list">
            {off.map((i) => (
              <li key={i.id}>{i.target}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {memories.length ? (
        <p className="muted">
          Imported memories arrive as suggestions in Memory; they are used only after you keep them.
        </p>
      ) : null}
    </div>
  );
}

function ImportRecords({ version }: { version: number }) {
  const { api } = useServices();
  const [records, setRecords] = useState<ImportRecordView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.importRecords().then(
      ({ items }) => {
        if (!alive) return;
        setRecords(items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the import records.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  return (
    <section className="settings-section" aria-labelledby="import-records">
      <h3 id="import-records" tabIndex={-1}>
        Import records
      </h3>
      <p className="muted">
        Every imported item, by its content hash, so the same item is never imported twice.
      </p>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {records === null && !error ? <Spinner label="Loading import records" /> : null}
      {records?.length === 0 ? <p className="muted">Nothing imported yet.</p> : null}
      {records?.length ? (
        <table className="ws-table">
          <caption className="nv-vh">Import records</caption>
          <thead>
            <tr>
              <th scope="col">Became</th>
              <th scope="col">Kind</th>
              <th scope="col">From</th>
              <th scope="col">Hash</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.target}</th>
                <td>{KIND_LABEL[r.kind]}</td>
                <td>
                  <code className="ws-code-inline">{r.sourcePath}</code>
                </td>
                <td title={r.sha256}>{shortHash(r.sha256)}</td>
                <td>{formatWhen(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
