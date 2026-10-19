// The consent page apps open (`/authorize?<their OAuth request>`, FR-222, ADR-097 D6): the app's
// name (its own, so the page says Nova cannot check it), where the browser goes next, and what it
// asks to read in plain words, each of which the owner can untick; Allow or Deny. The Hub checks
// the request first: one it cannot trust (an unknown app, a redirect the app did not register)
// is explained and never answered, so the browser is never sent to an unverified address; other
// refusals (app access off, managed policy, a malformed request) are explained with a way back
// that tells the app. Only the owner approves apps (members get the owner-only notice).
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { AppConsentView, AppScope } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { formatWhen } from '../settings/common.ts';
import { useTeamRole } from '../team/role.tsx';
import { useAppAuthApi } from './api-m8.ts';
import {
  CONSENT_TEXT,
  appErrorMessage,
  backText,
  reasonOf,
  refusalRedirect,
  sameTarget,
} from './format.ts';
import '../workspace.css';
import './appauth.css';

/** Where the browser goes after the decision; tests replace `go`. */
export const consentRedirect = {
  go: (url: string): void => {
    window.location.assign(url);
  },
};

type Decision = 'approve' | 'deny';

export function AuthorizePage({ query }: { query?: string }) {
  const search = (query ?? window.location.search).replace(/^\?/, '');
  const params = new URLSearchParams(search);
  const hasRequest = params.has('client_id');
  const requestedRedirect = params.get('redirect_uri');
  const api = useAppAuthApi();
  const { isMember } = useTeamRole();
  const [view, setView] = useState<AppConsentView | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [kept, setKept] = useState<Set<AppScope>>(new Set());
  const [busy, setBusy] = useState<Decision | null>(null);
  const [done, setDone] = useState<Decision | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const descId = useId();

  useEffect(() => {
    if (!hasRequest || isMember) return;
    let alive = true;
    api.getAppConsent(search).then(
      (v) => {
        if (!alive) return;
        setView(v);
        setKept(new Set(v.scopes.map((s) => s.scope)));
        setLoadError(null);
      },
      (err: unknown) => alive && setLoadError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, search, hasRequest, isMember]);

  // The heading names what is being decided; it takes focus once there is something to read.
  const ready = view !== null || loadError !== null;
  useEffect(() => {
    if (ready) headingRef.current?.focus();
  }, [ready]);

  /** Leave for the app's redirect, only when it is the address the request named. */
  const leave = (target: string, expected: string | null): boolean => {
    if (!expected || !sameTarget(target, expected)) {
      setFailure(CONSENT_TEXT.badRedirect);
      return false;
    }
    consentRedirect.go(target);
    return true;
  };

  const decide = async (decision: Decision) => {
    if (!view || busy) return;
    setBusy(decision);
    setFailure(null);
    const all = view.scopes.length === kept.size;
    try {
      const out = await api.decideAppConsent({
        query: search,
        decision,
        ...(decision === 'approve' && !all
          ? { scopes: view.scopes.map((s) => s.scope).filter((s) => kept.has(s)) }
          : {}),
      });
      if (leave(out.redirectTo, view.client.redirectUri)) setDone(decision);
    } catch (err) {
      const back = refusalRedirect(err);
      if (back) {
        // The request stopped being answerable (app access turned off meanwhile): say why and
        // let the app hear it.
        setView(null);
        setLoadError(err);
      } else setFailure(appErrorMessage(err, 'Could not send your answer.'));
    } finally {
      setBusy(null);
    }
  };

  if (isMember || reasonOf(loadError) === 'owner_only')
    return (
      <Frame>
        <h1 ref={headingRef} tabIndex={-1} className="aa-title">
          {CONSENT_TEXT.ownerOnly}
        </h1>
        <p className="ws-callout ws-flush" role="note">
          <Icon name="shield" />
          <span>{CONSENT_TEXT.ownerOnlyDetail}</span>
        </p>
      </Frame>
    );

  if (!hasRequest)
    return (
      <Frame>
        <h1 ref={headingRef} tabIndex={-1} className="aa-title">
          {CONSENT_TEXT.noRequest}
        </h1>
        <p className="muted ws-flush">{CONSENT_TEXT.noRequestDetail}</p>
      </Frame>
    );

  if (loadError) {
    const back = refusalRedirect(loadError);
    return (
      <Frame>
        <h1 ref={headingRef} tabIndex={-1} className="aa-title">
          {CONSENT_TEXT.refusedTitle}
        </h1>
        <p role="alert" className="ws-flush">
          {appErrorMessage(loadError, 'The Hub could not read this request.')}
        </p>
        {back ? (
          <div className="stack">
            <div className="row">
              <Button onClick={() => leave(back, requestedRedirect)}>{CONSENT_TEXT.tellApp}</Button>
            </div>
            <p className="muted ws-flush">{CONSENT_TEXT.tellAppHint}</p>
          </div>
        ) : null}
        {failure ? (
          <p role="alert" className="nv-field-error">
            {failure}
          </p>
        ) : null}
      </Frame>
    );
  }

  if (!view)
    return (
      <Frame>
        <Spinner label={CONSENT_TEXT.loading} />
      </Frame>
    );

  const name = view.client.name;
  return (
    <Frame>
      <h1 ref={headingRef} tabIndex={-1} className="aa-title" aria-describedby={descId}>
        {CONSENT_TEXT.title(name)}
      </h1>
      <p id={descId} className="ws-flush">
        {CONSENT_TEXT.intro(name)}
      </p>
      <p className="ws-callout ws-flush" role="note">
        <Icon name="alert" />
        <span>
          {CONSENT_TEXT.nameCaution} {CONSENT_TEXT.registered(formatWhen(view.client.registeredAt))}
        </span>
      </p>
      {view.authorized ? <p className="muted ws-flush">{CONSENT_TEXT.authorizedBefore}</p> : null}
      <fieldset className="ws-fieldset aa-scopes" disabled={done !== null || busy !== null}>
        <legend>{CONSENT_TEXT.asksHeading}</legend>
        {view.scopes.length > 1 ? (
          <p className="nv-field-hint ws-flush">{CONSENT_TEXT.keepHint}</p>
        ) : null}
        <ul className="aa-scope-list">
          {view.scopes.map((s) => {
            const boxId = `${descId}-${s.scope.replace(/[^a-z]/g, '-')}`;
            return (
              <li key={s.scope} className="aa-scope">
                <input
                  id={boxId}
                  type="checkbox"
                  checked={kept.has(s.scope)}
                  aria-describedby={`${boxId}-desc`}
                  onChange={(e) =>
                    setKept((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(s.scope);
                      else next.delete(s.scope);
                      return next;
                    })
                  }
                />
                <span className="aa-scope-text">
                  <label htmlFor={boxId} className="aa-scope-label">
                    {s.label}
                  </label>
                  <span id={`${boxId}-desc`} className="nv-field-hint">
                    {s.description}
                  </span>
                  {s.granted ? (
                    <span className="ws-badge" data-tone="ok">
                      <Icon name="check" /> {CONSENT_TEXT.alreadyAllowed}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      </fieldset>
      <p className="muted ws-flush">{backText(view.client)}</p>
      <p className="muted ws-flush">{CONSENT_TEXT.revokeLater}</p>
      {kept.size === 0 && !done ? (
        <p className="nv-field-hint ws-flush" role="status">
          {CONSENT_TEXT.keepOne}
        </p>
      ) : null}
      {failure ? (
        <p role="alert" className="nv-field-error">
          {failure}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="ws-flush">
          {done === 'approve' ? CONSENT_TEXT.allowed(name) : CONSENT_TEXT.denied(name)}
        </p>
      ) : (
        <div className="row aa-actions">
          <Button disabled={busy !== null} onClick={() => void decide('deny')}>
            {busy === 'deny' ? <Spinner /> : null}{' '}
            {busy === 'deny' ? CONSENT_TEXT.denying : CONSENT_TEXT.deny}
          </Button>
          <Button
            variant="primary"
            disabled={busy !== null || kept.size === 0}
            onClick={() => void decide('approve')}
          >
            {busy === 'approve' ? <Spinner /> : null}{' '}
            {busy === 'approve' ? CONSENT_TEXT.allowing : CONSENT_TEXT.allow}
          </Button>
        </div>
      )}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <section className="panel aa-consent stack">{children}</section>;
}
