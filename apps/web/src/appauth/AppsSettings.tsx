// Settings → Authorized apps (FR-222, ADR-097 D6): whether third-party apps may ask for access at all
// (`apps.enabled`, which managed policy can lock off), how an app signs in, the apps the owner
// allowed with what each may read, where its sign-ins return, how many devices it is signed in on
// and when it was last used, and Revoke (asks first: its sign-ins end and its tokens stop at once);
// and the registered apps nobody allows now, by name, with what they ask for and Remove (asks
// first; an app nobody approves is removed after an hour anyway). Live through
// `app.authorization.changed`.
import { useCallback, useEffect, useId, useState } from 'react';
import type { AppGrantView, AppPendingView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { CopyValue } from '../channels/parts.tsx';
import { useHubStream } from '../hub-events.ts';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { useAppAuthApi } from './api-m8.ts';
import { APPS_TEXT, appErrorMessage, lapseTime, pendingHostLabel, scopeText } from './format.ts';
import '../workspace.css';
import './appauth.css';

const APP_EVENTS = ['app.authorization.changed'] as const;

/** `http://127.0.0.1:53682/cb` → `127.0.0.1 (any port)`; `com.example.app:/cb` → `com.example.app:`. */
export function redirectLabel(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === 'http:') return APPS_TEXT.anyPort({ host: u.hostname });
    return `${u.protocol}`;
  } catch {
    return uri;
  }
}

export function AppsSettings() {
  const api = useAppAuthApi();
  const settings = useSettings();
  const toast = useToast();
  const listId = useId();
  const enabled = settings.get('apps.enabled');
  const restrict = settings.get('managed.restrict');
  const managedOff = restrict.value.layers.some((l) => l.apps === false);
  const [apps, setApps] = useState<AppGrantView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<AppPendingView[] | null>(null);
  const [pendingError, setPendingError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);
  const [revoking, setRevoking] = useState<AppGrantView | null>(null);
  const [removing, setRemoving] = useState<AppPendingView | null>(null);
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
    api.listPendingApps().then(
      ({ items }) => {
        if (!alive) return;
        setPending(items);
        setPendingError(null);
      },
      (err: unknown) => alive && setPendingError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useHubStream(APP_EVENTS, reload, reload);

  const setEnabled = (on: boolean) => {
    settings.set('apps.enabled', on).then(
      () => {
        const text = on ? APPS_TEXT.switchedOn : APPS_TEXT.switchedOff;
        toast.show(text, { tone: 'success' });
      },
      (err: unknown) =>
        toast.show(APPS_TEXT.changeFailed({ why: appErrorMessage(err) }), { tone: 'error' }),
    );
  };

  const revoke = async (a: AppGrantView) => {
    setBusy(true);
    try {
      await api.revokeApp(a.id);
      setApps((list) => list?.filter((x) => x.id !== a.id) ?? null);
      setRevoking(null);
      const text = APPS_TEXT.revoked({ name: a.name });
      toast.show(text, { tone: 'success' });
      // A revoked app stays registered: it now shows under "Registered, not allowed".
      reload();
    } catch (err) {
      setRevoking(null);
      toast.show(APPS_TEXT.revokeFailed({ name: a.name, why: appErrorMessage(err) }), {
        tone: 'error',
      });
      reload();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: AppPendingView) => {
    setBusy(true);
    try {
      await api.removePendingApp(p.clientId);
      setPending((list) => list?.filter((x) => x.clientId !== p.clientId) ?? null);
      setRemoving(null);
      toast.show(APPS_TEXT.removed({ name: p.name }), { tone: 'success' });
    } catch (err) {
      setRemoving(null);
      toast.show(APPS_TEXT.removeFailed({ name: p.name, why: appErrorMessage(err) }), {
        tone: 'error',
      });
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
            <span>{APPS_TEXT.managedOff}</span> <ManagedNote setting="restrict.apps" />
          </p>
        ) : null}
        <SwitchField
          label={APPS_TEXT.switchLabel}
          description={enabled.value && !managedOff ? APPS_TEXT.switchOn : APPS_TEXT.switchOff}
          checked={enabled.value && !managedOff}
          locked={locked}
          setting={managedOff && !enabled.locked ? 'restrict.apps' : 'apps.enabled'}
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
                  <strong dir="auto">{a.name}</strong>
                  <span className="muted">
                    {APPS_TEXT.mayRead({
                      scopes: a.scopes.map((s) => scopeText(s).label).join(' · '),
                    })}
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
                    {APPS_TEXT.sessions({ n: a.sessions })} ·{' '}
                    {APPS_TEXT.lastUsed({ when: formatWhen(a.lastUsedAt) })} ·{' '}
                    {APPS_TEXT.allowedWhen({ when: formatWhen(a.createdAt) })}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  aria-label={APPS_TEXT.revokeLabel({ name: a.name })}
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
        <p className="muted ws-flush">{APPS_TEXT.pendingIntro}</p>
        {pendingError ? (
          <div role="alert" className="ws-error">
            <p>{appErrorMessage(pendingError, APPS_TEXT.pendingLoadFailed)}</p>
            <Button onClick={reload}>{APPS_TEXT.retry}</Button>
          </div>
        ) : null}
        {pending === null && !pendingError ? <Spinner label={APPS_TEXT.pendingLoading} /> : null}
        {pending?.length === 0 ? <p className="ws-flush">{APPS_TEXT.pendingNone}</p> : null}
        {pending?.length ? (
          <ul className="ws-list" aria-label={APPS_TEXT.pendingLabel}>
            {pending.map((p) => (
              <li key={p.clientId} className="ws-list-row" aria-label={p.name}>
                <div className="ws-source-main">
                  <strong dir="auto">{p.name}</strong>
                  <span className="muted">
                    {APPS_TEXT.asksFor({
                      scopes: p.scopes.map((s) => scopeText(s).label).join(' · '),
                    })}
                  </span>
                  {p.redirectHosts.length ? (
                    <span className="muted ws-row-meta aa-uris">
                      <span>{APPS_TEXT.returnsTo}</span>
                      {[...new Set(p.redirectHosts.map(pendingHostLabel))].map((h) => (
                        <code key={h} className="ws-code-inline aa-break">
                          {h}
                        </code>
                      ))}
                    </span>
                  ) : null}
                  <span className="muted ws-row-meta">
                    {p.expiresAt
                      ? APPS_TEXT.waitingUntil({ time: lapseTime(p.expiresAt) })
                      : APPS_TEXT.notAllowedNow}{' '}
                    {APPS_TEXT.registeredWhen({ when: formatWhen(p.registeredAt) })}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  aria-label={APPS_TEXT.removeLabel({ name: p.name })}
                  onClick={() => setRemoving(p)}
                >
                  {APPS_TEXT.remove}
                </Button>
              </li>
            ))}
          </ul>
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
        title={revoking ? APPS_TEXT.revokeTitle({ name: revoking.name }) : APPS_TEXT.revoke}
        description={
          revoking
            ? APPS_TEXT.revokeWhat({ name: revoking.name, sessions: revoking.sessions })
            : undefined
        }
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
      <Dialog
        open={removing !== null}
        title={removing ? APPS_TEXT.removeTitle({ name: removing.name }) : APPS_TEXT.remove}
        description={removing ? APPS_TEXT.removeWhat({ name: removing.name }) : undefined}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button onClick={() => setRemoving(null)}>{APPS_TEXT.cancel}</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => removing && void remove(removing)}
            >
              {busy ? <Spinner /> : null} {APPS_TEXT.remove}
            </Button>
          </>
        }
      />
    </div>
  );
}
