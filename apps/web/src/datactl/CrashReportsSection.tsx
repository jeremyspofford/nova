// Crash reports (FR-121; docs/12 §9): a crash always writes a local report (no content: the error
// type, a stack with relative paths, versions and platform). Sending is off until the owner turns
// it on (asked first, and saying where reports go) with an endpoint of their own; managed policy
// can lock both. Each report can be previewed exactly as it would be sent, sent from its preview
// when sending is on and an endpoint is set, and deleted.
import { useEffect, useId, useRef, useState } from 'react';
import {
  crashReportEndpointSchema,
  type CrashReportPreviewView,
  type CrashReportView,
} from '@nova/shared';
import { Button, Dialog, Spinner, TextField, useToast } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { rich } from '../i18n/rich.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useSettings } from '../settings.tsx';
import { useDatactlApi } from './api-m8.ts';
import { CRASH_KIND, DATA_STRINGS as S, dataErrorMessage } from './format.ts';
import { ConfirmDialog, ErrorBox, useFetched } from './parts.tsx';

export function CrashReportsSection() {
  const api = useDatactlApi();
  const settings = useSettings();
  const toast = useToast();
  const id = useId();
  const list = useFetched(api.listCrashReports ? () => api.listCrashReports!() : null);
  const on = settings.get('privacy.crashReports');
  const endpoint = settings.get('privacy.crashReportEndpoint');
  const [draft, setDraft] = useState<string | null>(null);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [preview, setPreview] = useState<CrashReportView | null>(null);
  const [deleting, setDeleting] = useState<CrashReportView | 'all' | null>(null);
  useHubStream(['settings.changed'], (env) => {
    const key = env.payload.key;
    if (typeof key === 'string' && key.startsWith('privacy.crashReport')) list.reload();
  });

  const shown = draft ?? endpoint.value;
  const saveEndpoint = async () => {
    const value = shown.trim();
    if (!crashReportEndpointSchema.safeParse(value).success) {
      setEndpointError(S.crashEndpointInvalid);
      return;
    }
    setEndpointError(null);
    try {
      await settings.set('privacy.crashReportEndpoint', value);
      setDraft(null);
      toast.show(S.crashEndpointSaved, { tone: 'success' });
    } catch (err) {
      setEndpointError(dataErrorMessage(err, S.crashEndpointFailed));
    }
  };

  const items = list.data?.items ?? [];
  const replace = (r: CrashReportView) =>
    list.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === r.id ? r : x)) } : d));

  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 id={id}>{S.crashTitle}</h3>
      <p className="muted">{S.crashIntro}</p>
      <SwitchField
        label={S.crashSwitch}
        description={S.crashSwitchHint}
        checked={on.value}
        locked={on.locked}
        setting="privacy.crashReports"
        onChange={(next) => {
          if (next) setAsking(true);
          else
            void settings
              .set('privacy.crashReports', false)
              .catch((err: unknown) =>
                toast.show(S.saveFailedWhy({ why: dataErrorMessage(err) }), { tone: 'error' }),
              );
        }}
      />
      <form
        className="dc-endpoint"
        onSubmit={(e) => {
          e.preventDefault();
          void saveEndpoint();
        }}
      >
        <TextField
          label={S.crashEndpoint}
          type="url"
          inputMode="url"
          spellCheck={false}
          // eslint-disable-next-line nova-i18n/no-literal-ui-text -- a URL scheme, not words
          placeholder="https://"
          dir="ltr"
          value={shown}
          locked={endpoint.locked}
          setting="privacy.crashReportEndpoint"
          hint={S.crashEndpointHint}
          error={endpointError ?? undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setEndpointError(null);
          }}
        />
        <Button type="submit" disabled={endpoint.locked || draft === null}>
          {S.crashEndpointSave}
        </Button>
      </form>
      {list.error ? (
        <ErrorBox message={dataErrorMessage(list.error, S.crashLoadError)} onRetry={list.reload} />
      ) : null}
      {list.loading ? <Spinner label={S.crashLoading} /> : null}
      {list.data && items.length === 0 ? <p className="muted">{S.crashNone}</p> : null}
      {items.length ? (
        <ul className="dc-reports">
          {items.map((r) => (
            <li key={r.id} className="dc-report">
              <div className="stack">
                <strong>
                  {S.crashReportTitle({ name: r.errorName, when: formatWhen(r.createdAt) })}
                </strong>
                <span className="muted">{CRASH_KIND[r.kind]}</span>
                <span className="muted">
                  {r.sentAt
                    ? S.crashSentAt({ when: formatWhen(r.sentAt) })
                    : r.lastError
                      ? S.crashFailed({ why: r.lastError })
                      : S.notSent}
                </span>
              </div>
              <div className="row">
                <Button onClick={() => setPreview(r)}>{S.crashPreview}</Button>
                <Button variant="ghost" onClick={() => setDeleting(r)}>
                  {S.crashDelete}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {items.length > 1 ? (
        <div className="row">
          <Button variant="ghost" onClick={() => setDeleting('all')}>
            {S.crashDeleteAll}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={asking}
        title={S.crashOnTitle}
        confirmLabel={S.crashOnConfirm}
        errorText={(err) => dataErrorMessage(err, S.saveFailed)}
        onClose={() => setAsking(false)}
        onConfirm={async () => {
          await settings.set('privacy.crashReports', true);
          setAsking(false);
          list.reload();
        }}
      >
        <div className="stack">
          <p>{S.crashIntro}</p>
          <p>{S.crashOnBody}</p>
          <p>
            {endpoint.value ? S.crashEndpointIs({ endpoint: endpoint.value }) : S.crashOnNoEndpoint}
          </p>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting !== null}
        title={deleting === 'all' ? S.crashDeleteAllTitle : S.crashDeleteTitle}
        confirmLabel={S.crashDelete}
        danger
        errorText={(err) => dataErrorMessage(err, S.crashDeleteFailed)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting === 'all') {
            const { deleted } = await api.deleteAllCrashReports!();
            toast.show(S.crashDeletedAll({ n: deleted }), { tone: 'success' });
          } else if (deleting) {
            await api.deleteCrashReport!(deleting.id);
            toast.show(S.crashDeleted, { tone: 'success' });
          }
          setDeleting(null);
          list.reload();
        }}
      >
        {deleting && deleting !== 'all' ? (
          <p>
            {S.crashReportTitle({
              name: deleting.errorName,
              when: formatWhen(deleting.createdAt),
            })}
          </p>
        ) : null}
      </ConfirmDialog>
      {preview ? (
        <PreviewDialog report={preview} onClose={() => setPreview(null)} onSent={replace} />
      ) : null}
    </section>
  );
}

function PreviewDialog({
  report,
  onClose,
  onSent,
}: {
  report: CrashReportView;
  onClose: () => void;
  onSent: (r: CrashReportView) => void;
}) {
  const api = useDatactlApi();
  const [view, setView] = useState<CrashReportPreviewView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let alive = true;
    api.previewCrashReport!(report.id).then(
      (v) => alive && setView(v),
      (err: unknown) => alive && setError(dataErrorMessage(err, S.crashPreviewFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, report.id]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.sendCrashReport!(report.id);
      onSent(r);
      setSent(true);
    } catch (err) {
      setError(dataErrorMessage(err, S.crashSendFailed));
    } finally {
      setBusy(false);
    }
  };

  const why =
    view && !view.wouldSend ? (view.reason === 'off' ? S.crashWhyOff : S.crashWhyNoEndpoint) : null;
  return (
    <Dialog
      open
      title={S.crashPreviewTitle}
      description={S.crashPreviewIntro}
      onClose={onClose}
      initialFocusRef={closeRef}
      className="ws-wide-dialog"
      footer={
        <>
          <Button ref={closeRef} onClick={onClose}>
            {S.close}
          </Button>
          <Button
            variant="primary"
            disabled={!view?.wouldSend || busy || sent}
            onClick={() => void send()}
          >
            {busy ? <Spinner /> : null} {S.crashSend}
          </Button>
        </>
      }
    >
      {!view && !error ? <Spinner label={S.crashPreviewLoading} /> : null}
      {view ? (
        <div className="stack">
          <pre role="group" className="dc-pre" tabIndex={0} aria-label={S.crashPreviewTitle}>
            {view.body}
          </pre>
          {view.wouldSend && view.endpoint ? (
            <p>
              {rich(S.crashWouldSend, {
                endpoint: (
                  <code className="dc-mono" dir="ltr">
                    {view.endpoint}
                  </code>
                ),
              })}
            </p>
          ) : (
            <p className="muted">{why}</p>
          )}
        </div>
      ) : null}
      <p role="status">{sent ? S.crashSent : ''}</p>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
