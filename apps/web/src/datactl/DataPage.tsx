// Settings → Data (FR-105, FR-121; docs/12 §9; ADR-097 D5) at /settings/data, the Hub owner's:
// what the Hub holds; Export (one file, sealed and carrying the stored keys when a passphrase is
// given, which also needs the Hub's name typed and a browser of the Hub itself, not a paired
// device; downloaded by the browser through a one-use ticket); Import into an empty Hub (upload,
// check what the file holds and what must be entered again, the passphrase, then an explicit
// confirmation); Delete all (says exactly what goes, needs the Hub's name typed); how long each
// kind of data is kept (the audit floor; managed policy can lock each); and crash reports (local
// reports, the exact preview, sending only when turned on with an endpoint, delete). Delete-all
// and an import restart the Hub; the page waits for it and reloads.
import { useEffect, useId, useRef, useState } from 'react';
import type {
  DataDeleteResultView,
  DataImportCheckView,
  DataImportResultView,
  DataImportUploadView,
  DataOverviewView,
} from '@nova/shared';
import { EXPORT_PASSPHRASE_MIN } from '@nova/shared';
import { Button, Icon, Spinner, TextField } from '@nova/ui';
import { rich } from '../i18n/rich.tsx';
import { formatWhen } from '../settings/common.ts';
import { MemberGate } from '../team/role.tsx';
import { useDatactlApi } from './api-m8.ts';
import { CrashReportsSection } from './CrashReportsSection.tsx';
import { startDownload } from './download.ts';
import {
  DATA_STRINGS as S,
  DATA_TEXT as T,
  count,
  dataErrorMessage,
  formatSize,
  omissionText,
  reasonOf,
  secretGroups,
} from './format.ts';
import { ConfirmDialog, ErrorBox, useFetched } from './parts.tsx';
import { RestartNotice, type RestartOptions } from './RestartNotice.tsx';
import { RetentionSection } from './RetentionSection.tsx';
import '../workspace.css';
import './datactl.css';

type Done =
  | { kind: 'deleted'; result: DataDeleteResultView }
  | { kind: 'imported'; result: DataImportResultView };

export function DataPage({ restart }: { restart?: RestartOptions }) {
  const [done, setDone] = useState<Done | null>(null);
  return (
    <div className="settings-page">
      <h2>{S.title}</h2>
      <p className="muted">{S.intro}</p>
      <MemberGate ownerOnly what={S.title}>
        {done ? <Finished done={done} restart={restart} /> : <Sections onDone={setDone} />}
      </MemberGate>
    </div>
  );
}

function Sections({ onDone }: { onDone: (d: Done) => void }) {
  const api = useDatactlApi();
  const overview = useFetched(api.getDataOverview ? () => api.getDataOverview!() : null);
  if (!api.getDataOverview) return null;
  return (
    <>
      <p className="dc-privacy">
        <Icon name="shield" /> {S.privacy}
      </p>
      <Overview overview={overview.data} error={overview.error} onRetry={overview.reload} />
      {overview.data ? (
        <>
          <ExportSection overview={overview.data} />
          <ImportSection
            overview={overview.data}
            onDone={(r) => onDone({ kind: 'imported', result: r })}
          />
          <RetentionSection />
          <CrashReportsSection />
          <DeleteAllSection
            overview={overview.data}
            onDone={(r) => onDone({ kind: 'deleted', result: r })}
          />
        </>
      ) : null}
    </>
  );
}

function Finished({ done, restart }: { done: Done; restart: RestartOptions | undefined }) {
  const r = done.result;
  // The dialog that started it is gone: focus moves to what happened.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section className="settings-section dc-finished">
      <h3 ref={heading} tabIndex={-1}>
        {done.kind === 'deleted' ? S.deleteDone : S.importDone}
      </h3>
      <p>{done.kind === 'deleted' ? T.deleted(r) : T.imported(r)}</p>
      {done.kind === 'imported' && done.result.toReEnter.length ? (
        <ReEnter refs={done.result.toReEnter} />
      ) : null}
      {done.kind === 'imported' && done.result.keptTables.length ? (
        <p className="muted">{S.importDevices}</p>
      ) : null}
      {done.kind === 'imported' ? <RestoredOff result={done.result} /> : null}
      <RestartNotice options={restart} />
    </section>
  );
}

function RestoredOff({ result }: { result: DataImportResultView }) {
  const lines = result.restoredOff ? T.restoredOff(result.restoredOff) : [];
  if (!lines.length) return null;
  return (
    <div className="stack">
      <h4 className="dc-subhead">{S.restoredOffTitle}</h4>
      <ul className="dc-list">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

// ---- overview ----------------------------------------------------------------------------------

function Overview({
  overview,
  error,
  onRetry,
}: {
  overview: DataOverviewView | null;
  error: unknown;
  onRetry: () => void;
}) {
  const id = useId();
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.overviewTitle}</h3>
      {error ? (
        <ErrorBox
          message={dataErrorMessage(error, S.overviewLoadError)}
          onRetry={reasonOf(error) === 'owner_only' ? undefined : onRetry}
        />
      ) : null}
      {!overview && !error ? <Spinner label={S.overviewLoading} /> : null}
      {overview ? (
        <dl className="ws-stats">
          <div>
            <dt>{S.hubName}</dt>
            <dd className="dc-name" dir="auto">
              {overview.hubName}
            </dd>
          </div>
          <div>
            <dt>{S.rows}</dt>
            <dd>{count(overview.rows)}</dd>
          </div>
          <div>
            <dt>{S.tables}</dt>
            <dd>{count(overview.tables)}</dd>
          </div>
          <div>
            <dt>{S.files}</dt>
            <dd>
              {count(overview.files.count)}{' '}
              <span className="dc-sub">{formatSize(overview.files.bytes)}</span>
            </dd>
          </div>
          <div>
            <dt>{S.secrets}</dt>
            <dd>{count(overview.secrets.count)}</dd>
          </div>
          <div>
            <dt>{S.version}</dt>
            <dd>{overview.hubVersion}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}

// ---- export ------------------------------------------------------------------------------------

function ExportSection({ overview }: { overview: DataOverviewView }) {
  const api = useDatactlApi();
  const id = useId();
  const [pass, setPass] = useState('');
  const [repeat, setRepeat] = useState('');
  // A sealed export carries every stored secret: the Hub wants its name typed (compared trimmed,
  // ignoring case, as the Hub compares).
  const [name, setName] = useState('');
  const [fieldError, setFieldError] = useState<{
    field: 'pass' | 'repeat' | 'name';
    text: string;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const start = async () => {
    setFailure(null);
    setStatus('');
    if (pass && pass.length < 12) {
      setFieldError({ field: 'pass', text: S.passphraseShort({ min: EXPORT_PASSPHRASE_MIN }) });
      return;
    }
    if (pass && pass !== repeat) {
      setFieldError({ field: 'repeat', text: S.passphraseMismatch });
      return;
    }
    if (pass && name.trim().toLowerCase() !== overview.hubName.trim().toLowerCase()) {
      setFieldError({ field: 'name', text: S.sealedNameMismatch });
      return;
    }
    setFieldError(null);
    setBusy(true);
    try {
      const { ticket } = await api.createExportTicket!(
        pass ? pass : undefined,
        pass ? name.trim() : undefined,
      );
      startDownload(api.exportDownloadUrl!(ticket));
      setPass('');
      setRepeat('');
      setName('');
      setStatus(S.exportStarted);
    } catch (err) {
      if (reasonOf(err) === 'confirmation_mismatch')
        setFieldError({ field: 'name', text: S.sealedNameMismatch });
      else setFailure(dataErrorMessage(err, S.exportFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.exportTitle}</h3>
      <p>{S.exportIntro}</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <TextField
          label={S.passphrase}
          type="password"
          autoComplete="new-password"
          value={pass}
          hint={S.passphraseHint({ min: EXPORT_PASSPHRASE_MIN })}
          error={fieldError?.field === 'pass' ? fieldError.text : undefined}
          onChange={(e) => setPass(e.target.value)}
        />
        {pass ? (
          <>
            <TextField
              label={S.passphraseRepeat}
              type="password"
              autoComplete="new-password"
              value={repeat}
              error={fieldError?.field === 'repeat' ? fieldError.text : undefined}
              onChange={(e) => setRepeat(e.target.value)}
            />
            <TextField
              label={T.typeName(overview.hubName)}
              value={name}
              autoComplete="off"
              spellCheck={false}
              hint={S.sealedConfirmHint}
              error={fieldError?.field === 'name' ? fieldError.text : undefined}
              onChange={(e) => setName(e.target.value)}
            />
          </>
        ) : (
          <p className="muted">
            {S.withoutPassphrase}{' '}
            {overview.secrets.count ? T.holdsSecrets(overview.secrets.count) : ''}
          </p>
        )}
        {failure ? (
          <p role="alert" className="nv-field-error">
            {failure}
          </p>
        ) : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : <Icon name="download" />} {busy ? S.exporting : S.exportButton}
          </Button>
        </div>
        <p role="status" className="muted">
          {status}
        </p>
      </form>
    </section>
  );
}

// ---- import ------------------------------------------------------------------------------------

function ReEnter({ refs }: { refs: readonly string[] }) {
  const groups = secretGroups(refs);
  return (
    <div className="stack">
      <h4 className="dc-subhead">{S.toReEnterTitle}</h4>
      {groups.length ? (
        <ul className="dc-list">
          {groups.map((g) => (
            <li key={g.label}>{S.groupCount({ group: g.label, n: count(g.count) })}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">{S.toReEnterNone}</p>
      )}
    </div>
  );
}

function ImportSection({
  overview,
  onDone,
}: {
  overview: DataOverviewView;
  onDone: (r: DataImportResultView) => void;
}) {
  const api = useDatactlApi();
  const id = useId();
  const fileId = useId();
  const [upload, setUpload] = useState<(DataImportUploadView & { name: string }) | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [check, setCheck] = useState<DataImportCheckView | null>(null);
  const [busy, setBusy] = useState<'upload' | 'check' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Onboarding's "Restore from an export file" opens /settings/data#import: show this section.
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.location.hash !== '#import') return;
    section.current?.scrollIntoView?.({ block: 'start' });
    section.current?.querySelector<HTMLElement>('h3')?.focus();
  }, []);

  const runCheck = async (u: DataImportUploadView, pass?: string) => {
    setBusy('check');
    setError(null);
    try {
      setCheck(await api.checkImport!(u.uploadId, pass));
    } catch (err) {
      setCheck(null);
      setError(dataErrorMessage(err, S.checkFailed));
    } finally {
      setBusy(null);
    }
  };

  const choose = async (file: File) => {
    setError(null);
    setCheck(null);
    setPassphrase('');
    if (upload) void api.removeImportUpload?.(upload.uploadId).catch(() => undefined);
    setUpload(null);
    setBusy('upload');
    try {
      const u = await api.uploadImport!(file);
      setUpload({ ...u, name: file.name });
      setBusy(null);
      if (!u.encrypted) await runCheck(u);
    } catch (err) {
      setError(dataErrorMessage(err, S.uploadFailed));
      setBusy(null);
    }
  };

  const reset = () => {
    if (upload) void api.removeImportUpload?.(upload.uploadId).catch(() => undefined);
    setUpload(null);
    setCheck(null);
    setPassphrase('');
    setError(null);
  };

  const empty = check ? check.hubEmpty : overview.empty;
  const blocking = check ? check.blockingTables : overview.blockingTables;
  const pass = upload?.encrypted ? passphrase : undefined;

  return (
    <section ref={section} id="import" className="settings-section" aria-labelledby={id}>
      <h3 id={id} tabIndex={-1}>
        {S.importTitle}
      </h3>
      <p>{S.importIntro}</p>
      {!empty ? (
        <div className="ws-callout" role="note">
          <Icon name="alert" />
          <div className="stack">
            <p>{S.importNotEmpty}</p>
            {blocking.length ? (
              <details className="ws-advanced">
                <summary>{S.importBlocking}</summary>
                <p className="dc-mono" dir="ltr" translate="no">
                  {blocking.join(', ')}
                </p>
              </details>
            ) : null}
          </div>
        </div>
      ) : null}
      {!upload ? (
        <div className="nv-field">
          <label className="nv-field-label" htmlFor={fileId}>
            {S.importChoose}
          </label>
          <input
            id={fileId}
            type="file"
            className="dc-file"
            accept=".novaexport,application/zip,application/octet-stream"
            disabled={busy !== null}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void choose(f);
            }}
          />
        </div>
      ) : (
        <div className="dc-upload">
          <p>
            <Icon name="file" />{' '}
            {rich(S.uploadedAs, {
              file: <strong dir="auto">{T.uploadedFile(upload.name, upload.bytes)}</strong>,
            })}
          </p>
          <Button variant="ghost" onClick={reset} disabled={busy !== null}>
            {S.cancelImport}
          </Button>
        </div>
      )}
      {busy === 'upload' ? <Spinner label={S.uploading} /> : null}
      {upload?.encrypted && !check ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void runCheck(upload, passphrase);
          }}
        >
          <p>{S.importEncrypted}</p>
          <TextField
            label={S.importPassphrase}
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <div className="row">
            <Button type="submit" disabled={busy !== null || !passphrase}>
              {busy === 'check' ? <Spinner /> : null}{' '}
              {busy === 'check' ? S.checking : S.checkButton}
            </Button>
          </div>
        </form>
      ) : null}
      {busy === 'check' && !upload?.encrypted ? <Spinner label={S.checking} /> : null}
      <p role="status" className="nv-vh">
        {check ? S.checkedStatus : ''}
      </p>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
      {check ? <CheckResult check={check} /> : null}
      {check ? (
        <div className="row">
          <Button variant="danger" disabled={!check.hubEmpty} onClick={() => setConfirming(true)}>
            {S.importButton}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirming && check !== null && upload !== null}
        title={S.importConfirmTitle}
        confirmLabel={S.importConfirm}
        danger
        errorText={(err) => dataErrorMessage(err, S.importFailed)}
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          const r = await api.importData!(upload!.uploadId, pass);
          setConfirming(false);
          onDone(r);
        }}
      >
        {check ? (
          <div className="stack">
            <p>{T.importWrites({ ...check, when: formatWhen(check.createdAt) })}</p>
            <p>{S.importConfirmBody}</p>
            <p>{S.importRestoredOff}</p>
            {check.secrets.included ? (
              <p>{T.secretsCome(check.secrets.count)}</p>
            ) : (
              <>
                <ReEnter refs={check.toReEnter} />
                <p>{S.importDevices}</p>
              </>
            )}
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

function CheckResult({ check }: { check: DataImportCheckView }) {
  const omitted = check.omitted.filter((o) => o.kind !== 'secret');
  return (
    <div className="dc-check stack">
      <h4 className="dc-subhead">{S.checkTitle}</h4>
      <dl className="ws-dl">
        <dt>{S.exportedAt}</dt>
        <dd>{formatWhen(check.createdAt)}</dd>
        <dt>{S.fromVersion}</dt>
        <dd>{check.hubVersion}</dd>
        <dt>{S.rows}</dt>
        <dd>{T.checkRows(check.rows, check.tables.length)}</dd>
        <dt>{S.files}</dt>
        <dd>{T.sizeOf(check.files.count, check.files.bytes)}</dd>
        <dt>{check.secrets.included ? S.secretsIncluded : S.secretsLeftOut}</dt>
        <dd>
          {check.secrets.included ? count(check.secrets.count) : count(check.toReEnter.length)}
        </dd>
      </dl>
      {check.migratesFrom !== null ? <p className="muted">{S.migrates}</p> : null}
      {!check.secrets.included ? <ReEnter refs={check.toReEnter} /> : null}
      {omitted.length ? (
        <details className="ws-advanced">
          <summary>{S.omittedTitle}</summary>
          <ul className="dc-list">
            {omitted.map((o) => (
              <li key={`${o.kind}:${o.ref}`}>{omissionText(o)}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// ---- delete-all --------------------------------------------------------------------------------

function DeleteAllSection({
  overview,
  onDone,
}: {
  overview: DataOverviewView;
  onDone: (r: DataDeleteResultView) => void;
}) {
  const api = useDatactlApi();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === overview.hubName.trim().toLowerCase();
  return (
    <section className="settings-section dc-danger" aria-labelledby={id}>
      <h3 id={id}>{S.deleteTitle}</h3>
      <p>{S.deleteIntro}</p>
      <div className="row">
        <Button
          variant="danger"
          onClick={() => {
            setTyped('');
            setOpen(true);
          }}
        >
          {S.deleteButton}
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        title={S.deleteConfirmTitle}
        confirmLabel={S.deleteConfirm}
        danger
        ready={matches}
        errorText={(err) => dataErrorMessage(err, S.deleteFailed)}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          const r = await api.deleteAllData!(typed.trim());
          setOpen(false);
          onDone(r);
        }}
      >
        <div className="stack">
          <p>{S.deleteWhat}</p>
          <p>{T.deleteCounts(overview)}</p>
          <p>{S.deleteKept}</p>
          <p className="dc-strong">{S.deleteNoUndo}</p>
          <TextField
            label={T.typeName(overview.hubName)}
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
      </ConfirmDialog>
    </section>
  );
}
