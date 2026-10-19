// Settings → Telemetry export (FR-223, docs/16 §1, ADR-097 D6): the Hub's traces, metrics and
// logs to the owner's own OpenTelemetry collector over OTLP (HTTP, JSON). Off by default. The
// collector address (https, or http to this computer), headers the collector needs (write-only:
// stored in the vault, shown as Set), which signals go, and content (prompts, replies, tool
// results: off unless explicitly turned on, which asks first and says where it goes); a test that
// sends one log line now, and how the export is doing. Managed policy can forbid it or lock any
// of its settings: the controls are then disabled and say so, with where the lock comes from.
import { useCallback, useEffect, useId, useState } from 'react';
import {
  OTLP_SIGNALS,
  otlpEndpointSchema,
  otlpHeaderNameSchema,
  type OtlpSignal,
  type OtlpStatusView,
  type OtlpTestResultView,
  type PutOtlpRequest,
  type SettingKey,
} from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { useSettings } from '../settings.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useAppAuthApi } from './api-m8.ts';
import { OTLP_TEXT, SIGNAL_TEXT, appErrorMessage } from './format.ts';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import '../workspace.css';
import './appauth.css';

/** How often the status refreshes while the page is open. */
export const OTLP_POLL_MS = 10_000;

const OTLP_KEYS = [
  'telemetry.otlp.enabled',
  'telemetry.otlp.endpoint',
  'telemetry.otlp.headers',
  'telemetry.otlp.signals',
  'telemetry.otlp.includeContent',
] as const satisfies readonly SettingKey[];

/** Why the export is not running, in words (null while it is). */
export function inactiveWhy(s: OtlpStatusView): string | null {
  if (s.active) return null;
  if (s.managedOff) return OTLP_TEXT.inactiveWhy.managed;
  if (!s.enabled) return OTLP_TEXT.inactiveWhy.off;
  if (!s.endpoint) return OTLP_TEXT.inactiveWhy.noEndpoint;
  if (!OTLP_SIGNALS.some((k) => s.signals[k])) return OTLP_TEXT.inactiveWhy.noSignal;
  return null;
}

export function OtlpSettings() {
  const api = useAppAuthApi();
  const settings = useSettings();
  const toast = useToast();
  const id = useId();
  const [status, setStatus] = useState<OtlpStatusView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [askContent, setAskContent] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const locked = Object.fromEntries(OTLP_KEYS.map((k) => [k, settings.get(k).locked])) as Record<
    (typeof OTLP_KEYS)[number],
    boolean
  >;
  const restrictOff = settings
    .get('managed.restrict')
    .value.layers.some((l) => l.telemetryExport === false);

  useEffect(() => {
    let alive = true;
    api.getOtlp().then(
      (s) => {
        if (!alive) return;
        setStatus(s);
        setLoadError(null);
      },
      (err: unknown) => alive && setLoadError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useInterval(reload, OTLP_POLL_MS, status !== null);
  useHubStream(
    ['settings.changed', 'managed.policy.changed'],
    (env) => {
      const key = typeof env.payload.key === 'string' ? env.payload.key : '';
      if (env.name !== 'settings.changed' || key.startsWith('telemetry.otlp.')) reload();
      else if (key === 'managed.restrict') reload();
    },
    reload,
  );

  /** One change through the export's own route; the answer is the new status. */
  const put = async (body: PutOtlpRequest, done: string): Promise<boolean> => {
    setBusy(true);
    try {
      setStatus(await api.updateOtlp(body));
      toast.show(done, { tone: 'success' });
      return true;
    } catch (err) {
      toast.show(appErrorMessage(err, 'Could not save.'), { tone: 'error' });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTested(null);
    try {
      const r: OtlpTestResultView = await api.testOtlp();
      setTested(
        r.ok
          ? { ok: true, text: OTLP_TEXT.testOk(r.status) }
          : {
              ok: false,
              text: OTLP_TEXT.testFailed(r.error ?? (r.status ? `HTTP ${r.status}` : 'no answer')),
            },
      );
      reload();
    } catch (err) {
      setTested({ ok: false, text: appErrorMessage(err, 'The test did not run.') });
    } finally {
      setTesting(false);
    }
  };

  const managedOff = (status?.managedOff ?? false) || restrictOff;

  return (
    <div className="settings-page">
      <h2>{OTLP_TEXT.heading}</h2>
      <p className="muted ws-flush">{OTLP_TEXT.intro}</p>
      {managedOff ? (
        <p className="ws-callout ws-flush" role="note">
          <Icon name="shield" />
          <span>{OTLP_TEXT.managedOff}</span>
        </p>
      ) : null}
      {loadError && !status ? (
        <div role="alert" className="ws-error">
          <p>{appErrorMessage(loadError, OTLP_TEXT.loadFailed)}</p>
          <Button onClick={reload}>{OTLP_TEXT.retry}</Button>
        </div>
      ) : null}
      {!status && !loadError ? <Spinner label={OTLP_TEXT.loading} /> : null}
      {status ? (
        <>
          <section className="settings-section" aria-label={OTLP_TEXT.switchLabel}>
            <SwitchField
              label={OTLP_TEXT.switchLabel}
              description={
                !status.endpoint && !status.enabled
                  ? OTLP_TEXT.needsEndpoint
                  : status.enabled
                    ? OTLP_TEXT.switchOn
                    : OTLP_TEXT.switchOff
              }
              checked={status.enabled && !managedOff}
              locked={locked['telemetry.otlp.enabled'] || managedOff}
              setting="telemetry.otlp.enabled"
              disabled={busy || (!status.endpoint && !status.enabled)}
              onChange={(on) =>
                void put({ enabled: on }, on ? OTLP_TEXT.turnedOn : OTLP_TEXT.turnedOff)
              }
            />
          </section>
          <EndpointSection
            key={status.endpoint}
            endpoint={status.endpoint}
            locked={locked['telemetry.otlp.endpoint']}
            busy={busy}
            onSave={(endpoint) =>
              put({ endpoint }, endpoint ? OTLP_TEXT.endpointSaved : OTLP_TEXT.endpointCleared)
            }
          />
          <HeadersSection
            headers={status.headers}
            locked={locked['telemetry.otlp.headers']}
            busy={busy}
            put={put}
          />
          <section className="settings-section" aria-labelledby={`${id}-signals`}>
            <h3 id={`${id}-signals`}>{OTLP_TEXT.signalsHeading}</h3>
            {OTLP_SIGNALS.map((k: OtlpSignal) => (
              <SwitchField
                key={k}
                label={SIGNAL_TEXT[k].label}
                description={SIGNAL_TEXT[k].description}
                checked={status.signals[k]}
                locked={locked['telemetry.otlp.signals']}
                setting="telemetry.otlp.signals"
                disabled={busy}
                onChange={(on) =>
                  void put(
                    { signals: { [k]: on } },
                    OTLP_TEXT.savedSignal(SIGNAL_TEXT[k].label, on),
                  )
                }
              />
            ))}
          </section>
          <section className="settings-section" aria-labelledby={`${id}-content`}>
            <h3 id={`${id}-content`}>{OTLP_TEXT.contentHeading}</h3>
            <SwitchField
              label={OTLP_TEXT.contentLabel}
              description={OTLP_TEXT.contentDescription}
              checked={status.includeContent}
              locked={locked['telemetry.otlp.includeContent']}
              setting="telemetry.otlp.includeContent"
              disabled={busy}
              onChange={(on) =>
                on ? setAskContent(true) : void put({ includeContent: false }, OTLP_TEXT.contentOff)
              }
            />
            {status.includeContent ? (
              <p className="ws-callout ws-flush" role="note">
                <Icon name="alert" />
                <span>{OTLP_TEXT.contentWarning}</span>
              </p>
            ) : null}
          </section>
          <section className="settings-section" aria-labelledby={`${id}-test`}>
            <h3 id={`${id}-test`}>{OTLP_TEXT.testHeading}</h3>
            <div className="row">
              <Button
                disabled={testing || managedOff || !status.endpoint}
                onClick={() => void test()}
              >
                {testing ? <Spinner /> : null} {testing ? OTLP_TEXT.testing : OTLP_TEXT.test}
              </Button>
            </div>
            {!status.endpoint ? <p className="muted ws-flush">{OTLP_TEXT.testNoEndpoint}</p> : null}
            <p
              role="status"
              className={tested && !tested.ok ? 'nv-field-error ws-flush' : 'ws-flush'}
            >
              {tested?.text ?? ''}
            </p>
          </section>
          <StatusSection status={status} />
        </>
      ) : null}
      <Dialog
        open={askContent}
        title={OTLP_TEXT.contentConfirmTitle}
        description={OTLP_TEXT.contentConfirm(status?.endpoint || OTLP_TEXT.yourCollector)}
        onClose={() => setAskContent(false)}
        footer={
          <>
            <Button onClick={() => setAskContent(false)}>{OTLP_TEXT.cancel}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setAskContent(false);
                void put({ includeContent: true }, OTLP_TEXT.contentOn);
              }}
            >
              {OTLP_TEXT.contentConfirmButton}
            </Button>
          </>
        }
      />
    </div>
  );
}

/** The collector's address: checked here with the Hub's own rule before it is sent. */
function EndpointSection({
  endpoint,
  locked,
  busy,
  onSave,
}: {
  endpoint: string;
  locked: boolean;
  busy: boolean;
  onSave: (endpoint: string) => Promise<boolean>;
}) {
  const id = useId();
  const [value, setValue] = useState(endpoint);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim().replace(/\/+$/, '');
  const dirty = trimmed !== endpoint;
  const save = async (next: string) => {
    if (next && !otlpEndpointSchema.safeParse(next).success) {
      setError(OTLP_TEXT.endpointInvalid);
      return;
    }
    setError(null);
    if (!(await onSave(next))) return;
    setValue(next);
  };
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{OTLP_TEXT.collectorHeading}</h3>
      <form
        className="stack"
        noValidate
        aria-labelledby={`${id}-h`}
        onSubmit={(e) => {
          e.preventDefault();
          void save(trimmed);
        }}
      >
        <TextField
          label={OTLP_TEXT.endpointLabel}
          type="url"
          value={value}
          placeholder="https://collector.example.com:4318"
          spellCheck={false}
          autoComplete="off"
          disabled={locked}
          hint={OTLP_TEXT.endpointHint}
          error={error ?? undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        {locked ? <ManagedNote setting="telemetry.otlp.endpoint" as="p" /> : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={locked || busy || !dirty}>
            {OTLP_TEXT.save}
          </Button>
          {endpoint && !locked ? (
            <Button variant="ghost" disabled={busy} onClick={() => void save('')}>
              {OTLP_TEXT.clear}
            </Button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

/** Header names with Set or Not set; values are write-only (replace, remove, add). */
function HeadersSection({
  headers,
  locked,
  busy,
  put,
}: {
  headers: OtlpStatusView['headers'];
  locked: boolean;
  busy: boolean;
  put: (body: PutOtlpRequest, done: string) => Promise<boolean>;
}) {
  const id = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{OTLP_TEXT.headersHeading}</h3>
      <p className="muted ws-flush">{OTLP_TEXT.headersIntro}</p>
      {locked ? <ManagedNote setting="telemetry.otlp.headers" as="p" /> : null}
      {headers.length === 0 ? <p className="muted ws-flush">{OTLP_TEXT.headersNone}</p> : null}
      {headers.length ? (
        <ul className="ws-list" aria-label={OTLP_TEXT.headersLabel}>
          {headers.map((h) => (
            <li key={h.name} className="ws-list-row" aria-label={h.name}>
              <div className="ws-source-main">
                <code className="ws-code-inline">{h.name}</code>
                <span className="ws-badge" data-tone={h.set ? 'ok' : 'warn'}>
                  <Icon name={h.set ? 'check' : 'alert'} />{' '}
                  {h.set ? OTLP_TEXT.set : OTLP_TEXT.notSet}
                </span>
              </div>
              {locked ? null : (
                <div className="row ws-row-actions">
                  <Button
                    variant="ghost"
                    aria-label={OTLP_TEXT.replaceLabel(h.name)}
                    onClick={() => {
                      setAdding(false);
                      setEditing(h.name);
                    }}
                  >
                    {OTLP_TEXT.replace}
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={OTLP_TEXT.removeLabel(h.name)}
                    onClick={() => setRemoving(h.name)}
                  >
                    {OTLP_TEXT.remove}
                  </Button>
                </div>
              )}
              {editing === h.name ? (
                <HeaderForm
                  fixedName={h.name}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={async (name, value) => {
                    if (await put({ headers: { [name]: value } }, OTLP_TEXT.headerSaved(name)))
                      setEditing(null);
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {locked ? null : adding ? (
        <HeaderForm
          busy={busy}
          onCancel={() => setAdding(false)}
          onSave={async (name, value) => {
            if (await put({ headers: { [name]: value } }, OTLP_TEXT.headerSaved(name)))
              setAdding(false);
          }}
        />
      ) : (
        <div className="row">
          <Button
            onClick={() => {
              setEditing(null);
              setAdding(true);
            }}
          >
            <Icon name="plus" /> {OTLP_TEXT.addHeader}
          </Button>
        </div>
      )}
      <Dialog
        open={removing !== null}
        title={removing ? OTLP_TEXT.removeTitle(removing) : OTLP_TEXT.remove}
        description={OTLP_TEXT.removeWhat}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{OTLP_TEXT.cancel}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                const name = removing;
                setRemoving(null);
                if (name) void put({ headers: { [name]: null } }, OTLP_TEXT.removed(name));
              }}
            >
              {OTLP_TEXT.remove}
            </Button>
          </>
        }
      />
    </section>
  );
}

function HeaderForm({
  fixedName,
  busy,
  onSave,
  onCancel,
}: {
  /** Replacing this header's value (the name cannot change). */
  fixedName?: string;
  busy: boolean;
  onSave: (name: string, value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(fixedName ?? '');
  const [value, setValue] = useState('');
  const [errors, setErrors] = useState<{ name?: string; value?: string }>({});
  const submit = async () => {
    const n = name.trim();
    const next: { name?: string; value?: string } = {};
    if (!otlpHeaderNameSchema.safeParse(n).success) next.name = OTLP_TEXT.headerNameInvalid;
    if (!value) next.value = OTLP_TEXT.headerValueMissing;
    setErrors(next);
    if (next.name || next.value) return;
    // A name already listed (in any case) gets the new value: the Hub matches names that way.
    await onSave(n, value);
  };
  return (
    <form
      className="aa-header-form"
      noValidate
      aria-label={fixedName ? OTLP_TEXT.replaceLabel(fixedName) : OTLP_TEXT.addHeader}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {fixedName ? null : (
        <TextField
          label={OTLP_TEXT.headerName}
          value={name}
          spellCheck={false}
          autoComplete="off"
          maxLength={64}
          placeholder="Authorization"
          hint={OTLP_TEXT.headerNameHint}
          error={errors.name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      )}
      <TextField
        label={fixedName ? OTLP_TEXT.headerValueNew(fixedName) : OTLP_TEXT.headerValue}
        type="password"
        autoComplete="new-password"
        value={value}
        maxLength={4000}
        error={errors.value}
        autoFocus={!!fixedName}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="row">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? OTLP_TEXT.saving : OTLP_TEXT.save}
        </Button>
        <Button onClick={onCancel}>{OTLP_TEXT.cancel}</Button>
      </div>
    </form>
  );
}

function StatusSection({ status: s }: { status: OtlpStatusView }) {
  const id = useId();
  const why = inactiveWhy(s);
  const per = (r: Record<OtlpSignal, number>) =>
    OTLP_SIGNALS.map((k) => `${SIGNAL_TEXT[k].label} ${r[k]}`).join(' · ');
  return (
    <section className="settings-section" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>{OTLP_TEXT.statusHeading}</h3>
      <p className="ws-flush" role="status">
        <span className="ws-badge" data-tone={s.active ? 'ok' : undefined}>
          <Icon name={s.active ? 'check' : 'stop'} />{' '}
          {s.active ? OTLP_TEXT.active : OTLP_TEXT.inactive}
        </span>{' '}
        {why ? <span className="muted">{why}</span> : null}
      </p>
      <dl className="ws-dl">
        <dt>{OTLP_TEXT.sent}</dt>
        <dd>{per(s.sent)}</dd>
        <dt>{OTLP_TEXT.queued}</dt>
        <dd>{per(s.queued)}</dd>
        <dt>{OTLP_TEXT.dropped}</dt>
        <dd>{per(s.dropped)}</dd>
        <dt>{OTLP_TEXT.failures}</dt>
        <dd>{s.failures}</dd>
        <dt>{OTLP_TEXT.lastSuccess}</dt>
        <dd>{s.lastSuccessAt ? formatWhen(s.lastSuccessAt) : OTLP_TEXT.never}</dd>
        {s.lastError ? (
          <>
            <dt>{OTLP_TEXT.lastError}</dt>
            <dd className="aa-break">{s.lastError}</dd>
          </>
        ) : null}
        {s.nextAttemptAt ? (
          <>
            <dt>{OTLP_TEXT.nextAttempt}</dt>
            <dd>{new Date(s.nextAttemptAt).toLocaleTimeString()}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
