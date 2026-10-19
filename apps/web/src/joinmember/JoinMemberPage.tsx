// Joining a Hub with an invitation, `/join` (decision 5 of ADR-095; FR-113). It works without a
// session: the owner's link carries a one-use token in its fragment (`#invite=…`, which never
// reaches a server log; `?token=` works too), and the page removes it from the address at once.
// The page asks the Hub whether the invitation is still usable, then the new member picks a
// display name and joins (the Hub sets the session cookie), or continues with a sign-in provider
// when the owner set one up. Refusals are said plainly: a used, withdrawn or expired link, too
// many tries from this address, a Hub that does not answer. Phone width first.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { JoinPreviewView } from '@nova/shared';
import { Button, Icon, Spinner, TextField, applyTheme, resolveTheme } from '@nova/ui';
import { ApiError } from '../api.ts';
import { readCachedTheme } from '../appearance.ts';
import { reasonOf, teamErrorMessage, untilText } from '../team/format.ts';
import { browser, isSafeExternalUrl } from '../team/leave.ts';
import { memberClient, type MemberClient } from './client.ts';
import './joinmember.css';

export const MEMBER_JOIN_PATH = '/join';

/** True for the invitation page (it renders without a session). */
export function isMemberJoinPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, '') === MEMBER_JOIN_PATH;
}

/** The invitation token from a link's fragment (`#invite=`) or query (`?token=`), or null. */
export function readInvitation(search: string, hash: string): string | null {
  const fromHash = new URLSearchParams(hash.replace(/^#/, '')).get('invite');
  const fromQuery = new URLSearchParams(search).get('token');
  const token = (fromHash ?? fromQuery ?? '').trim();
  return token.length >= 20 && token.length <= 200 ? token : null;
}

/** A pasted link or a bare token, as the token. */
export function tokenFromPaste(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    return readInvitation(u.search, u.hash);
  } catch {
    return readInvitation('', `#invite=${encodeURIComponent(t)}`);
  }
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'ask' }
  | { kind: 'invalid' }
  | { kind: 'hub-error'; error: unknown }
  | { kind: 'form'; preview: JoinPreviewView }
  | { kind: 'joined' };

export interface JoinMemberPageProps {
  fetchImpl?: typeof fetch;
  client?: MemberClient;
  search?: string;
  hash?: string;
}

export function JoinMemberPage({ fetchImpl, client: given, search, hash }: JoinMemberPageProps) {
  const [client] = useState<MemberClient>(() => given ?? memberClient(fetchImpl));
  const [token, setToken] = useState<string | null>(() =>
    readInvitation(search ?? window.location.search, hash ?? window.location.hash),
  );
  const [phase, setPhase] = useState<Phase>(() => (token ? { kind: 'checking' } : { kind: 'ask' }));
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const id = useId();

  // The token leaves the address bar (and the history entry) at once.
  useEffect(() => {
    if (
      hash === undefined &&
      search === undefined &&
      (window.location.hash || window.location.search)
    )
      history.replaceState(null, '', MEMBER_JOIN_PATH);
  }, [hash, search]);

  useEffect(() => {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
    applyTheme(resolveTheme(readCachedTheme(), dark), document.documentElement);
  }, []);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    client.joinPreview(token).then(
      (preview) => {
        if (!alive) return;
        setPhase(preview.valid ? { kind: 'form', preview } : { kind: 'invalid' });
      },
      (error: unknown) => alive && setPhase({ kind: 'hub-error', error }),
    );
    return () => {
      alive = false;
    };
  }, [client, token, attempt]);

  useEffect(() => {
    if (phase.kind !== 'checking' && phase.kind !== 'form') headingRef.current?.focus();
  }, [phase.kind]);

  const join = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    const displayName = name.trim();
    if (!displayName) {
      setNameError('Enter the name the people of this Hub will see.');
      return;
    }
    setBusy('local');
    setFailure(null);
    try {
      await client.join(token, displayName);
      setPhase({ kind: 'joined' });
      browser.leaveTo('/');
    } catch (err) {
      if (reasonOf(err) === 'invitation_invalid') setPhase({ kind: 'invalid' });
      else setFailure(err);
    } finally {
      setBusy(null);
    }
  };

  const continueWith = async (providerId: string) => {
    if (!token) return;
    setBusy(providerId);
    setFailure(null);
    try {
      const out = await client.oidcStart({
        providerId,
        flow: 'join',
        invitation: token,
        ...(name.trim() ? { displayName: name.trim() } : {}),
      });
      if (!isSafeExternalUrl(out.url))
        throw new Error('The Hub sent an address this page will not open.');
      browser.leaveTo(out.url);
    } catch (err) {
      if (reasonOf(err) === 'invitation_invalid') setPhase({ kind: 'invalid' });
      else setFailure(err);
      setBusy(null);
    }
  };

  const usePasted = (e: FormEvent) => {
    e.preventDefault();
    const t = tokenFromPaste(pasted);
    if (!t) {
      setPasteError('That is not an invitation link. Paste the whole link you were sent.');
      return;
    }
    setPasteError(null);
    setToken(t);
    setPhase({ kind: 'checking' });
  };

  return (
    <div className="shell joinm">
      <header className="topbar">
        <span className="brand">Nova</span>
      </header>
      <main className="main" id="main">
        <section className="panel joinm-panel" aria-labelledby={`${id}-h`}>
          {phase.kind === 'checking' ? (
            <>
              <h1 id={`${id}-h`}>Join this Hub</h1>
              <Spinner label="Checking the invitation" />
            </>
          ) : null}

          {phase.kind === 'ask' ? (
            <>
              <h1 id={`${id}-h`} ref={headingRef} tabIndex={-1}>
                Join this Hub
              </h1>
              <p className="muted joinm-flush">
                Open the invitation link the owner of the Hub sent you, or paste it here.
              </p>
              <form className="stack" onSubmit={usePasted} noValidate>
                <TextField
                  label="Invitation link"
                  value={pasted}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setPasted(e.target.value)}
                  error={pasteError ?? undefined}
                />
                <div className="row">
                  <Button type="submit" variant="primary">
                    Continue
                  </Button>
                </div>
              </form>
            </>
          ) : null}

          {phase.kind === 'invalid' ? (
            <>
              <h1 id={`${id}-h`} ref={headingRef} tabIndex={-1}>
                <Icon name="alert" /> This invitation cannot be used
              </h1>
              <div role="alert" className="stack">
                <p className="joinm-flush">
                  It was used already, withdrawn by the owner, or it has expired. Each link works
                  once.
                </p>
                <p className="muted joinm-flush">
                  Ask the owner of the Hub for a new link. If you already joined, open Nova and sign
                  in.
                </p>
                <div className="row">
                  <a className="nv-btn" href="/">
                    Open Nova
                  </a>
                </div>
              </div>
            </>
          ) : null}

          {phase.kind === 'hub-error' ? (
            <>
              <h1 id={`${id}-h`} ref={headingRef} tabIndex={-1}>
                {phase.error instanceof ApiError && phase.error.status === 429
                  ? 'Too many tries'
                  : 'Cannot reach the Hub'}
              </h1>
              <div role="alert" className="stack">
                <p className="muted joinm-flush">
                  {teamErrorMessage(phase.error, 'The Hub did not answer.')}
                </p>
                <div className="row">
                  <Button
                    onClick={() => {
                      setPhase({ kind: 'checking' });
                      setAttempt((n) => n + 1);
                    }}
                  >
                    Retry
                  </Button>
                </div>
              </div>
            </>
          ) : null}

          {phase.kind === 'form' ? (
            <>
              <h1 id={`${id}-h`}>Join this Hub</h1>
              <p className="joinm-flush">
                {phase.preview.invitedBy
                  ? `${phase.preview.invitedBy} invited you`
                  : 'You were invited'}
                {phase.preview.label ? ` (${phase.preview.label})` : ''}.
                {phase.preview.expiresAt
                  ? ` The invitation expires ${untilText(phase.preview.expiresAt)}.`
                  : ''}
              </p>
              <p className="muted joinm-flush">
                You get your own account on this Hub: your own chats, memory, connectors and
                settings. The owner runs the Hub and can remove you.
              </p>
              <form className="stack" onSubmit={(e) => void join(e)} noValidate>
                <TextField
                  label="Your name"
                  hint="What the people of this Hub see. You can change it later."
                  value={name}
                  maxLength={100}
                  autoComplete="name"
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(null);
                  }}
                  error={nameError ?? undefined}
                />
                <div className="row">
                  <Button type="submit" variant="primary" disabled={busy !== null}>
                    {busy === 'local' ? <Spinner /> : null} Join
                  </Button>
                </div>
              </form>
              {phase.preview.providers.length > 0 ? (
                <div className="stack joinm-providers">
                  <p className="muted joinm-flush">
                    Or join with an account you already have; you then sign in with it.
                  </p>
                  {phase.preview.providers.map((p) => (
                    <Button
                      key={p.id}
                      onClick={() => void continueWith(p.id)}
                      disabled={busy !== null}
                    >
                      {busy === p.id ? <Spinner /> : <Icon name="external" />} Continue with{' '}
                      {p.label}
                    </Button>
                  ))}
                </div>
              ) : null}
              {failure ? (
                <p role="alert" className="nv-field-error">
                  {teamErrorMessage(failure, 'Could not join. Try again.')}
                </p>
              ) : null}
            </>
          ) : null}

          {phase.kind === 'joined' ? (
            <>
              <h1 id={`${id}-h`} ref={headingRef} tabIndex={-1}>
                <Icon name="check" /> You joined
              </h1>
              <p className="joinm-flush" role="status">
                Opening Nova…
              </p>
              <div className="row">
                <a className="nv-btn" data-variant="primary" href="/">
                  Open Nova
                </a>
              </div>
            </>
          ) : null}
        </section>
      </main>
    </div>
  );
}
