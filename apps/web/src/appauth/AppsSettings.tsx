// Settings → Apps (FR-222, ADR-097 D6): whether third-party apps may ask for access at all
// (`apps.enabled`, which managed policy can lock off), how an app signs in, the apps the owner
// allowed with what each may read, where its sign-ins return, how many devices it is signed in on
// and when it was last used, and Revoke (asks first: its sign-ins end and its tokens stop at once);
// and how many registered apps nobody approved yet (an app shows its request when it opens the
// consent page; unapproved ones are removed after a day). Live through `app.authorization.changed`.
import { useCallback, useEffect, useId, useState } from 'react';
import type { AppGrantView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { CopyValue } from '../channels/parts.tsx';
import { useHubStream } from '../hub-events.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useAppAuthApi } from './api-m8.ts';
import { APPS_TEXT, appErrorMessage, scopeText } from './format.ts';
import '../workspace.css';
import './appauth.css';

const APP_EVENTS = ['app.authorization.changed'] as const;

/** `http://127.0.0.1:53682/cb` → `127.0.0.1 (any port)`; `com.example.app:/cb` → `com.example.app:`. */
export function redirectLabel(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === 'http:') return `${u.hostname} (any port)`;
    return `${u.protocol}`;
  } catch {
    return uri;
  }
}

export function AppsSettings() {
  const api = useAppAuthApi();
  const { api: hub } = useServices();
  const settings = useSettings();
  const toast = useToast();
  const listId = useId();
  const enabled = settings.get('apps.enabled');
  const restrict = settings.get('managed.restrict');
  const managedOff = restrict.value.layers.some((l) => l.apps === false);
  const [apps, setApps] = useState<AppGrantView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<number | null | 'unknown'>(null);
  const [version, setVersion] = useState(0);
  const [revoking, setRevoking] = useState<AppGrantView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.listApps().then(
      ({ items }) => {
        if (!alive) return;
        setApps(items);
        setError(null);
      },
      (err: unknown) => alive && setError(err),
    );
    hub.diagnostics().then(
      (d) => {
        if (!alive) return;
        const probe = d.probes?.apps as { pendingClients?: unknown } | undefined;
        setPending(typeof probe?.pendingClients === 'number' ? probe.pendingClients : 'unknown');
      },
      () => alive && setPending('unknown'),
    );
    return () => {
      alive = false;
    };
  }, [api, hub, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useHubStream(APP_EVENTS, reload, reload);

  const setEnabled = (on: boolean) => {
    settings.set('apps.enabled', on).then(
      () => {
        const text = on ? APPS_TEXT.switchedOn : APPS_TEXT.switchedOff;
        toast.show(text, { tone: 'success' });
      },
      (err: unknown) =>
        toast.show(`Could not change it: ${appErrorMessage(err)}`, { tone: 'error' }),
    );
  };

  const revoke = async (a: AppGrantView) => {
    setBusy(true);
    try {
      await api.revokeApp(a.id);
      setApps((list) => list?.filter((x) => x.id !== a.id) ?? null);
      setRevoking(null);
      const text = APPS_TEXT.revoked(a.name);
      toast.show(text, { tone: 'success' });
    } catch (err) {
      setRevoking(null);
      toast.show(APPS_TEXT.revokeFailed(a.name, appErrorMessage(err)), { tone: 'error' });
      reload();
    } finally {
      setBusy(false);
    }
  };

  const metadata = `${window.location.origin}/.well-known/oauth-authorization-server`;
  const locked = enabled.locked || managedOff;
  return (
    <div className="settings-page">
      <h2>{APPS_TEXT.heading}</h2>
      <p className="muted ws-flush">{APPS_TEXT.intro}</p>
      <section className="settings-section" aria-label={APPS_TEXT.switchLabel}>
        {managedOff ? (
          <p className="ws-callout ws-flush" role="note">
            <Icon name="shield" />
            <span>{APPS_TEXT.managedOff}</span>
          </p>
        ) : null}
        <SwitchField
          label={APPS_TEXT.switchLabel}
          description={enabled.value && !managedOff ? APPS_TEXT.switchOn : APPS_TEXT.switchOff}
          checked={enabled.value && !managedOff}
          locked={locked}
          setting="apps.enabled"
          onChange={setEnabled}
        />
      </section>
      <section className="settings-section" aria-labelledby={`${listId}-list`}>
        <h3 id={`${listId}-list`}>{APPS_TEXT.listHeading}</h3>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{appErrorMessage(error, APPS_TEXT.loadFailed)}</p>
            <Button onClick={reload}>{APPS_TEXT.retry}</Button>
          </div>
        ) : null}
        {apps === null && !error ? <Spinner label={APPS_TEXT.loading} /> : null}
        {apps?.length === 0 ? (
          <EmptyState
            level={3}
            title={APPS_TEXT.emptyTitle}
            description={APPS_TEXT.emptyDescription}
          />
        ) : null}
        {apps?.length ? (
          <ul className="ws-list" aria-label={APPS_TEXT.listLabel}>
            {apps.map((a) => (
              <li key={a.id} className="ws-list-row" aria-label={a.name}>
                <div className="ws-source-main">
                  <strong>{a.name}</strong>
                  <span className="muted">
                    {APPS_TEXT.mayRead}: {a.scopes.map((s) => scopeText(s).label).join(' · ')}
                  </span>
                  <span className="muted ws-row-meta aa-uris">
                    <span>{APPS_TEXT.returnsTo}</span>
                    {a.redirectUris.map((u) => (
                      <code key={u} className="ws-code-inline aa-break">
                        {redirectLabel(u)}
                      </code>
                    ))}
                  </span>
                  <span className="muted ws-row-meta">
                    {APPS_TEXT.sessions(a.sessions)} ·{' '}
                    {APPS_TEXT.lastUsed(formatWhen(a.lastUsedAt))} ·{' '}
                    {APPS_TEXT.allowedWhen(formatWhen(a.createdAt))}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  aria-label={APPS_TEXT.revokeLabel(a.name)}
                  onClick={() => setRevoking(a)}
                >
                  {APPS_TEXT.revoke}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section className="settings-section" aria-labelledby={`${listId}-pending`}>
        <h3 id={`${listId}-pending`}>{APPS_TEXT.pendingHeading}</h3>
        {pending === null ? <Spinner /> : null}
        {typeof pending === 'number' ? (
          <p className="ws-flush" role="status">
            {pending > 0 ? APPS_TEXT.pending(pending) : APPS_TEXT.pendingNone}
          </p>
        ) : null}
        {pending === 'unknown' ? (
          <p className="muted ws-flush">{APPS_TEXT.pendingUnknown}</p>
        ) : null}
        <p className="muted ws-flush">{APPS_TEXT.pendingHow}</p>
      </section>
      <section className="settings-section" aria-labelledby={`${listId}-how`}>
        <h3 id={`${listId}-how`}>{APPS_TEXT.howHeading}</h3>
        <p className="muted ws-flush">{APPS_TEXT.how}</p>
        <CopyValue label={APPS_TEXT.metadataLabel} value={metadata} />
      </section>
      <Dialog
        open={revoking !== null}
        title={revoking ? APPS_TEXT.revokeTitle(revoking.name) : APPS_TEXT.revoke}
        description={revoking ? APPS_TEXT.revokeWhat(revoking.name, revoking.sessions) : undefined}
        onClose={() => setRevoking(null)}
        footer={
          <>
            <Button onClick={() => setRevoking(null)}>{APPS_TEXT.cancel}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => revoking && void revoke(revoking)}
            >
              {busy ? <Spinner /> : null} {APPS_TEXT.revoke}
            </Button>
          </>
        }
      />
    </div>
  );
}
