// Settings → Import (FR-200, docs/04 §2.11, docs/08 §4.2): a four-step wizard. 1 Source: folders
// on the Hub and the kinds to look for. 2 Choose: what was found, grouped by kind, with items
// already imported (same SHA-256) marked and left out. 3 Review: secrets that move to the vault,
// name conflicts, and what stays off until confirmed. 4 Import: the result, with the import
// records (the ledger) below. Nothing is written before step 4.
import { useEffect, useRef, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
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
import { formatWhen } from './common.ts';
import { embed } from './embed.tsx';
import { isAbsolutePath } from './PermissionsPage.tsx';
import { shortHash } from './plugin-text.ts';
import '../workspace.css';

export const IMPORT_TEXT = defineMessages('settings.import', {
  kind: {
    instructions: 'Instruction files',
    skills: 'Skills',
    commands: 'Commands',
    plugins: 'Plugins',
    mcp_servers: 'MCP servers',
    projects: 'Projects',
    memories: 'Memories',
    chats: 'Chat exports',
  },
  kindNote: {
    commands: 'become skills',
    plugins: 'stay off until you confirm their permissions',
    mcp_servers: 'stay off until you confirm them',
    memories: 'you review them before they are saved',
  },
  status: {
    new: 'New',
    duplicate: 'Already imported',
    conflict: 'Name in use',
    unsupported: 'Not supported',
  },
  steps: { source: 'Source', choose: 'Choose', review: 'Review', import: 'Import' },
  stepTitles: {
    source: 'Where to look',
    choose: 'Choose what to import',
    review: 'Review before importing',
    done: 'Done',
  },
  needPath: 'Enter at least one folder or file on the Hub.',
  tooManyPaths: 'Scan at most {max} folders or files at a time.',
  notFull: 'Use a full path: {path}',
  needKind: 'Choose at least one kind of item.',
  scanFailed: 'Could not scan those folders.',
  applyFailed: 'The import failed. Nothing was changed.',
  title: 'Import',
  intro:
    'Bring instructions, skills, commands, plugins, MCP servers, projects, memories and chats ' +
    'from other assistants. Nova reads the files on the Hub and never changes them.',
  stepsLabel: 'Import steps',
  stepHeading: 'Step {n} of {total}: {title}',
  paths: 'Folders or files on the Hub',
  pathsExample: '/home/me/.config/assistant',
  pathsExample2: '/home/me/Downloads/chat-export.zip',
  pathsHint:
    'One per line: a configuration folder, a skills folder, an MCP config file or a chat ' +
    'export.',
  lookFor: 'Look for',
  withNote: '({note})',
  scan: 'Scan',
  nothingFound: 'Nothing to import was found there.',
  group: '{kind}: {n}',
  groupDupes: '{kind}: {n}, {dupes} already imported',
  becomes: 'Becomes {target}',
  secretsFound:
    '{n, plural, one {# secret found; moved to the vault} other {# secrets found; moved to the vault}}',
  back: 'Back',
  reviewN: '{n, plural, one {Review # item} other {Review # items}}',
  importN: '{n, plural, one {Import # item} other {Import # items}}',
  finished: 'Import finished.',
  imported: 'Imported',
  skipped: 'Skipped as already imported',
  leftOff: 'Left off until you confirm them',
  secretsMoved: 'Secrets moved to the vault',
  items: '{n, plural, one {# item} other {# items}}',
  secrets: '{n, plural, one {# secret} other {# secrets}}',
  tagged:
    'Everything from this import is tagged with its id ({id}) in the {link}. Imported plugins and servers are off: turn them on in Plugins & skills or Tools & MCP once you have checked their permissions.',
  recordsLink: 'import records',
  again: 'Import something else',
  willImport:
    '{n, plural, one {# item will be imported: {kinds}.} other {# items will be imported: {kinds}.}}',
  kindCount: '{kind} ({n})',
  secretsTitle: 'Secrets',
  secretsHint:
    'These move into the vault. The imported configuration keeps only a secret:// reference.',
  secretLine: '{name}: {secret}',
  noSecrets: 'No secrets were found in what you chose.',
  conflicts: 'Names already in use',
  conflictsHint: 'Go back and untick any you want to skip.',
  conflict: '{name} becomes {target}',
  conflictNote: '{name} becomes {target}: {note}',
  staysOff: 'Stays off',
  staysOffHint:
    'Imported plugins and MCP servers stay off until you declare and confirm their permissions.',
  memoriesHint:
    'Imported memories arrive as suggestions in Memory; they are used only after you keep them.',
  recordsFailed: 'Could not load the import records.',
  records: 'Import records',
  recordsHint:
    'Every imported item, by its content hash, so the same item is never imported twice.',
  loadingRecords: 'Loading import records',
  noRecords: 'Nothing imported yet.',
  became: 'Became',
  kindCol: 'Kind',
  from: 'From',
  hash: 'Hash',
  when: 'When',
});
const S = IMPORT_TEXT;

/** The kinds of item, in the wizard's order. */
export const IMPORT_KINDS: readonly ImportKind[] = [
  'instructions',
  'skills',
  'commands',
  'plugins',
  'mcp_servers',
  'projects',
  'memories',
  'chats',
];

const KIND_LABEL: Readonly<Record<ImportKind, string>> = S.kind;
const KIND_NOTE = S.kindNote as Readonly<Partial<Record<ImportKind, string>>>;
const STATUS_TEXT: Readonly<Record<ImportItemView['status'], string>> = S.status;

const STEPS = ['source', 'choose', 'review', 'import'] as const;
const STEP_TITLES = ['source', 'choose', 'review', 'done'] as const;

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
  if (!paths.length) return { error: S.needPath };
  if (paths.length > 20) return { error: S.tooManyPaths({ max: 20 }) };
  const bad = paths.find((p) => !isAbsolutePath(p));
  if (bad) return { error: S.notFull({ path: bad }) };
  return { paths };
}

/** Preview items by kind, in the wizard's kind order. */
export function groupItems(
  items: readonly ImportItemView[],
): { kind: ImportKind; items: ImportItemView[] }[] {
  return IMPORT_KINDS.map((kind) => ({
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
  const [kinds, setKinds] = useState<Set<ImportKind>>(() => new Set(IMPORT_KINDS));
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
    if (!kinds.size) return setError(S.needKind);
    setBusy(true);
    setError(null);
    try {
      const p = await api.importPreview({
        paths: parsed.paths,
        kinds: IMPORT_KINDS.filter((k) => kinds.has(k)),
      });
      setPreview(p);
      setSelected(defaultSelection(p.items));
      go(1);
    } catch (err) {
      setError(errorMessage(err, S.scanFailed));
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
      setError(errorMessage(err, S.applyFailed));
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
      <h2>{S.title}</h2>
      <p className="muted">{S.intro}</p>
      <section className="settings-section ws-wizard" aria-labelledby="import-step">
        <ol className="ws-steps" aria-label={S.stepsLabel}>
          {STEPS.map((s, i) => (
            <li
              key={s}
              aria-current={i === step ? 'step' : undefined}
              data-done={i < step || undefined}
            >
              {S.steps[s]}
            </li>
          ))}
        </ol>
        <h3 id="import-step" ref={heading} tabIndex={-1}>
          {S.stepHeading({
            n: step + 1,
            total: STEPS.length,
            title: S.stepTitles[STEP_TITLES[step]],
          })}
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
                {S.paths}
              </label>
              <textarea
                id="import-paths"
                className="nv-input ws-textarea"
                rows={3}
                spellCheck={false}
                dir="ltr"
                value={pathsText}
                placeholder={`${S.pathsExample}\n${S.pathsExample2}`}
                aria-describedby="import-paths-hint"
                onChange={(e) => setPathsText(e.target.value)}
              />
              <span id="import-paths-hint" className="nv-field-hint">
                {S.pathsHint}
              </span>
            </div>
            <fieldset className="ws-fieldset">
              <legend>{S.lookFor}</legend>
              <div className="ws-checks">
                {IMPORT_KINDS.map((k) => (
                  <label key={k} className="ws-check">
                    <input
                      type="checkbox"
                      checked={kinds.has(k)}
                      onChange={(e) =>
                        setKinds((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(k);
                          else next.delete(k);
                          return next;
                        })
                      }
                    />
                    <span>
                      {KIND_LABEL[k]}
                      {KIND_NOTE[k] ? (
                        <span className="muted"> {S.withNote({ note: KIND_NOTE[k] })}</span>
                      ) : null}
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
                {busy ? <Spinner /> : null} {S.scan}
              </Button>
            </div>
          </form>
        ) : null}

        {step === 1 && preview ? (
          <div className="stack">
            {preview.items.length === 0 ? <p className="muted">{S.nothingFound}</p> : null}
            {groupItems(preview.items).map((g) => {
              const dupes = g.items.filter((i) => i.status === 'duplicate').length;
              return (
                <fieldset key={g.kind} className="ws-fieldset">
                  <legend>
                    {dupes
                      ? S.groupDupes({ kind: KIND_LABEL[g.kind], n: g.items.length, dupes })
                      : S.group({ kind: KIND_LABEL[g.kind], n: g.items.length })}
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
                            <span className="muted">{S.becomes({ target: i.target })}</span>
                            <code className="ws-code-inline" dir="ltr">
                              {i.sourcePath}
                            </code>
                            {i.maskedSecrets.length ? (
                              <span className="muted">
                                {S.secretsFound({ n: i.maskedSecrets.length })}
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
              <Button onClick={() => go(0)}>{S.back}</Button>
              <Button variant="primary" disabled={selected.size === 0} onClick={() => go(2)}>
                {S.reviewN({ n: selected.size })}
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
              <Button onClick={() => go(1)}>{S.back}</Button>
              <Button
                variant="primary"
                disabled={busy || chosen.length === 0}
                onClick={() => void apply()}
              >
                {busy ? <Spinner /> : null} {S.importN({ n: chosen.length })}
              </Button>
            </div>
          </div>
        ) : null}

        {step === 3 && result ? (
          <div className="stack" role="status">
            <p className="ws-ok">
              <Icon name="check" /> {S.finished}
            </p>
            <dl className="ws-dl">
              <dt>{S.imported}</dt>
              <dd>{S.items({ n: result.imported })}</dd>
              <dt>{S.skipped}</dt>
              <dd>{S.items({ n: result.duplicates })}</dd>
              <dt>{S.leftOff}</dt>
              <dd>{S.items({ n: result.disabled })}</dd>
              <dt>{S.secretsMoved}</dt>
              <dd>{S.secrets({ n: result.secretsMigrated })}</dd>
            </dl>
            <p className="muted">
              {embed(S.tagged, {
                id: <span translate="no">{result.importId}</span>,
                link: (
                  <a
                    href="#import-records"
                    onClick={(e) => {
                      e.preventDefault();
                      document.getElementById('import-records')?.focus();
                    }}
                  >
                    {S.recordsLink}
                  </a>
                ),
              })}
            </p>
            <div className="row">
              <Button onClick={restart}>{S.again}</Button>
            </div>
          </div>
        ) : null}
      </section>
      <ImportRecords version={recordsVersion} />
    </div>
  );
}

function Review({ items }: { items: ImportItemView[] }) {
  const secrets = items.filter((i) => i.maskedSecrets.length);
  const conflicts = items.filter((i) => i.status === 'conflict');
  const off = items.filter((i) => i.kind === 'plugins' || i.kind === 'mcp_servers');
  const memories = items.filter((i) => i.kind === 'memories');
  return (
    <div className="stack">
      <p>
        {S.willImport({
          n: items.length,
          kinds: fmt.list(
            groupItems(items).map((g) =>
              S.kindCount({ kind: KIND_LABEL[g.kind], n: g.items.length }),
            ),
            { type: 'unit' },
          ),
        })}
      </p>
      <section aria-labelledby="import-secrets">
        <h4 id="import-secrets">{S.secretsTitle}</h4>
        {secrets.length ? (
          <>
            <p className="muted">{S.secretsHint}</p>
            <ul className="ws-plain-list">
              {secrets.map((i) =>
                i.maskedSecrets.map((s) => (
                  <li key={`${i.id}-${s}`}>
                    {embed(S.secretLine, {
                      name: i.name,
                      secret: (
                        <code className="ws-code-inline" dir="ltr">
                          {s}
                        </code>
                      ),
                    })}
                  </li>
                )),
              )}
            </ul>
          </>
        ) : (
          <p className="muted">{S.noSecrets}</p>
        )}
      </section>
      {conflicts.length ? (
        <section aria-labelledby="import-conflicts">
          <h4 id="import-conflicts">{S.conflicts}</h4>
          <p className="muted">{S.conflictsHint}</p>
          <ul className="ws-plain-list">
            {conflicts.map((i) => (
              <li key={i.id}>
                {i.note
                  ? S.conflictNote({ name: i.name, target: i.target, note: i.note })
                  : S.conflict({ name: i.name, target: i.target })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {off.length ? (
        <section aria-labelledby="import-off">
          <h4 id="import-off">{S.staysOff}</h4>
          <p className="muted">{S.staysOffHint}</p>
          <ul className="ws-plain-list">
            {off.map((i) => (
              <li key={i.id}>{i.target}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {memories.length ? <p className="muted">{S.memoriesHint}</p> : null}
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
      (err: unknown) => alive && setError(errorMessage(err, S.recordsFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  return (
    <section className="settings-section" aria-labelledby="import-records">
      <h3 id="import-records" tabIndex={-1}>
        {S.records}
      </h3>
      <p className="muted">{S.recordsHint}</p>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {records === null && !error ? <Spinner label={S.loadingRecords} /> : null}
      {records?.length === 0 ? <p className="muted">{S.noRecords}</p> : null}
      {records?.length ? (
        <table className="ws-table">
          <caption className="nv-vh">{S.records}</caption>
          <thead>
            <tr>
              <th scope="col">{S.became}</th>
              <th scope="col">{S.kindCol}</th>
              <th scope="col">{S.from}</th>
              <th scope="col">{S.hash}</th>
              <th scope="col">{S.when}</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <th scope="row">{r.target}</th>
                <td>{KIND_LABEL[r.kind]}</td>
                <td>
                  <code className="ws-code-inline" dir="ltr">
                    {r.sourcePath}
                  </code>
                </td>
                <td title={r.sha256} translate="no">
                  {shortHash(r.sha256)}
                </td>
                <td>{formatWhen(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
