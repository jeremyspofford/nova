// The private sign-in form (FR-086; docs/11 §4.1): when the agent needs to sign in to a site, the
// user types the username and password here. They go to the agent browser (and to the vault only
// when "Save this login" is ticked), never to the agent, its model, a log or the audit. A saved
// login for the site can be reused, after an explicit confirmation. The form waits for a limited
// time; an answer after that gets the Hub's 410 and says so. The password is cleared from the
// form as soon as it is sent.
import { useEffect, useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { BrowserSigninView } from '@nova/shared';
import { Button, Icon, RadioGroup, TextField, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { useInterval } from '../settings/common.ts';
import { sentence } from '../screen/format.ts';
import { useBrowserApi } from './api.ts';
import { countdown } from './format.ts';

export type SigninOutcome = 'completed' | 'failed' | 'cancelled' | 'gone';

/** The private sign-in form. {site} is the site's host, {user} a saved username (data). */
export const SIGNIN_TEXT = defineMessages('browser.signin', {
  expiredAnnounce: 'The sign-in to {site} expired.',
  signedIn: 'Signed in to {site}.',
  /** {reason} is the browser's own words (English). */
  didNotWork: 'Signing in did not work: {reason}',
  sendFailed: 'The sign-in could not be sent.',
  notSignedIn: 'You did not sign in to {site}. The agent was told.',
  cancelFailed: 'Could not cancel the sign-in.',
  heading: 'Sign in to {site}',
  intro:
    'The agent asked to sign in. What you enter goes only to the agent browser, never to the agent or its model. CAPTCHAs and codes are yours to complete in the browser.',
  how: 'How to sign in',
  typeIt: 'Enter a username and password',
  savedLogin: 'Use the saved login for {user}',
  confirmSaved: 'Yes, sign in to {site} as {user} with the saved password',
  username: 'Username or email',
  password: 'Password',
  save: 'Save this login to your passwords (kept in the vault, asked before reuse)',
  expired: 'This sign-in expired. The agent can ask again.',
  /** {time} is the time left, such as "4:59". */
  waits: 'Waits for {time} more.',
  signIn: 'Sign in',
  signInAs: 'Sign in as {user}',
  dontSignIn: 'Don’t sign in',
  /** A finished sign-in: "Sign in to shop.example.com:" before what happened. */
  resultTitle: 'Sign in to {site}:',
  dismiss: 'Dismiss',
  loadFailed: 'Could not load sign-in requests.',
  loading: 'Loading sign-in requests',
});

export function SigninForm({
  signin,
  onDone,
  autoFocus,
}: {
  signin: BrowserSigninView;
  /** The form no longer waits: signed in, failed, cancelled, or answered elsewhere. */
  onDone: (id: string, outcome: SigninOutcome, message: string) => void;
  /** Focus the first field (the form was opened from a notification). */
  autoFocus?: boolean;
}) {
  const api = useBrowserApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [mode, setMode] = useState<string>('type');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [closed, setClosed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const expiresAt = Date.parse(signin.expiresAt);
  const left = Number.isNaN(expiresAt) ? null : expiresAt - now;
  const expired = left !== null && left <= 0;
  useInterval(() => setNow(Date.now()), 1000, !closed && !expired);

  useEffect(() => {
    if (expired && !closed) announce(SIGNIN_TEXT.expiredAnnounce({ site: signin.host }));
  }, [expired, closed, announce, signin.host]);

  const saved = signin.savedLogins.find((l) => l.id === mode) ?? null;
  const ready = saved ? confirmed : username.trim() !== '' && password !== '';

  const S = SIGNIN_TEXT;
  const site = signin.host;
  const finish = (outcome: SigninOutcome, message: string) => {
    setClosed(message);
    announce(message);
    onDone(signin.id, outcome, message);
  };

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setProblem(null);
    const body = saved
      ? { loginId: saved.id, confirm: true as const }
      : { username: username.trim(), password, save };
    // The password leaves the form with the request.
    setPassword('');
    try {
      const out = await api.submitBrowserSignin(signin.id, body);
      if (out.state === 'completed') {
        toast.show(S.signedIn({ site }), { tone: 'success' });
        finish('completed', sentence(out.message));
      } else finish('failed', S.didNotWork({ reason: sentence(out.message) }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) finish('gone', sentence(err.body.message));
      else setProblem(sentence(errorMessage(err, S.sendFailed)));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setPassword('');
    try {
      await api.cancelBrowserSignin(signin.id);
      finish('cancelled', S.notSignedIn({ site }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) finish('gone', sentence(err.body.message));
      else setProblem(sentence(errorMessage(err, S.cancelFailed)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="brw-signin" aria-labelledby={headingId} data-signin={signin.id}>
      <h4 id={headingId} className="ws-subhead">
        <Icon name="shield" /> {S.heading({ site })}
      </h4>
      {closed ? (
        <p role="status" className="brw-signin-closed">
          {closed}
        </p>
      ) : (
        <form
          className="brw-signin-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="muted ws-flush">{S.intro}</p>
          {signin.url ? (
            <p className="muted ws-flush brw-url" dir="ltr">
              {signin.url}
            </p>
          ) : null}
          {signin.savedLogins.length ? (
            <RadioGroup
              legend={S.how}
              name={`signin-${signin.id}`}
              value={mode}
              onChange={(v) => {
                setMode(v);
                setConfirmed(false);
              }}
              options={[
                { value: 'type', label: S.typeIt },
                ...signin.savedLogins.map((l) => ({
                  value: l.id,
                  label: S.savedLogin({ user: l.username }),
                })),
              ]}
            />
          ) : null}
          {saved ? (
            <label className="ws-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>{S.confirmSaved({ site, user: saved.username })}</span>
            </label>
          ) : (
            <>
              <TextField
                label={S.username}
                value={username}
                autoComplete="username"
                maxLength={500}
                autoFocus={autoFocus}
                disabled={expired}
                onChange={(e) => setUsername(e.target.value)}
              />
              <TextField
                label={S.password}
                type="password"
                value={password}
                autoComplete="current-password"
                maxLength={1000}
                disabled={expired}
                onChange={(e) => setPassword(e.target.value)}
              />
              <label className="ws-check">
                <input
                  type="checkbox"
                  checked={save}
                  disabled={expired}
                  onChange={(e) => setSave(e.target.checked)}
                />
                <span>{S.save}</span>
              </label>
            </>
          )}
          {problem ? (
            <p className="ws-warning" role="alert">
              <Icon name="alert" /> {problem}
            </p>
          ) : null}
          {expired ? (
            <p className="ws-warning" role="alert">
              <Icon name="clock" /> {S.expired}
            </p>
          ) : left !== null ? (
            <p className="muted ws-flush">{S.waits({ time: countdown(left) })}</p>
          ) : null}
          <div className="row">
            <Button type="submit" variant="primary" disabled={!ready || busy || expired}>
              {saved ? S.signInAs({ user: saved.username }) : S.signIn}
            </Button>
            <Button onClick={() => void cancel()} disabled={busy}>
              {S.dontSignIn}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
