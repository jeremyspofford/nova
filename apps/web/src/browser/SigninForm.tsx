// The private sign-in form (FR-086; docs/11 §4.1): when the agent needs to sign in to a site, the
// user types the username and password here. They go to the agent browser (and to the vault only
// when "Save this login" is ticked), never to the agent, its model, a log or the audit. A saved
// login for the site can be reused, after an explicit confirmation. The form waits for a limited
// time; an answer after that gets the Hub's 410 and says so. The password is cleared from the
// form as soon as it is sent.
import { useEffect, useId, useState } from 'react';
import type { BrowserSigninView } from '@nova/shared';
import { Button, Icon, RadioGroup, TextField, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { useInterval } from '../settings/common.ts';
import { sentence } from '../screen/format.ts';
import { useBrowserApi } from './api.ts';
import { countdown } from './format.ts';

export type SigninOutcome = 'completed' | 'failed' | 'cancelled' | 'gone';

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
    if (expired && !closed) announce(`The sign-in to ${signin.host} expired.`);
  }, [expired, closed, announce, signin.host]);

  const saved = signin.savedLogins.find((l) => l.id === mode) ?? null;
  const ready = saved ? confirmed : username.trim() !== '' && password !== '';

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
        toast.show(`Signed in to ${signin.host}.`, { tone: 'success' });
        finish('completed', sentence(out.message));
      } else finish('failed', `Signing in did not work: ${sentence(out.message)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) finish('gone', sentence(err.body.message));
      else setProblem(sentence(errorMessage(err, 'The sign-in could not be sent.')));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setPassword('');
    try {
      await api.cancelBrowserSignin(signin.id);
      finish('cancelled', `You did not sign in to ${signin.host}. The agent was told.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 410) finish('gone', sentence(err.body.message));
      else setProblem(sentence(errorMessage(err, 'Could not cancel the sign-in.')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="brw-signin" aria-labelledby={headingId} data-signin={signin.id}>
      <h4 id={headingId} className="ws-subhead">
        <Icon name="shield" /> Sign in to {signin.host}
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
          <p className="muted ws-flush">
            The agent asked to sign in. What you enter goes only to the agent browser, never to the
            agent or its model. CAPTCHAs and codes are yours to complete in the browser.
          </p>
          {signin.url ? <p className="muted ws-flush brw-url">{signin.url}</p> : null}
          {signin.savedLogins.length ? (
            <RadioGroup
              legend="How to sign in"
              name={`signin-${signin.id}`}
              value={mode}
              onChange={(v) => {
                setMode(v);
                setConfirmed(false);
              }}
              options={[
                { value: 'type', label: 'Enter a username and password' },
                ...signin.savedLogins.map((l) => ({
                  value: l.id,
                  label: `Use the saved login for ${l.username}`,
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
              <span>
                Yes, sign in to {signin.host} as {saved.username} with the saved password
              </span>
            </label>
          ) : (
            <>
              <TextField
                label="Username or email"
                value={username}
                autoComplete="username"
                maxLength={500}
                autoFocus={autoFocus}
                disabled={expired}
                onChange={(e) => setUsername(e.target.value)}
              />
              <TextField
                label="Password"
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
                <span>
                  Save this login to your passwords (kept in the vault, asked before reuse)
                </span>
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
              <Icon name="clock" /> This sign-in expired. The agent can ask again.
            </p>
          ) : left !== null ? (
            <p className="muted ws-flush">Waits for {countdown(left)} more.</p>
          ) : null}
          <div className="row">
            <Button type="submit" variant="primary" disabled={!ready || busy || expired}>
              {saved ? `Sign in as ${saved.username}` : 'Sign in'}
            </Button>
            <Button onClick={() => void cancel()} disabled={busy}>
              Don’t sign in
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
