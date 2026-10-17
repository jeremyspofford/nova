// The private sign-in forms waiting for the user (FR-086), for one computer or all of them. A form
// answered here is replaced by its outcome until dismissed; the list follows the sign-in events.
// `focusId` (from a notification's `?signin=<id>` link) scrolls to that form and focuses it.
import { useEffect, useRef, useState } from 'react';
import type { BrowserSigninView } from '@nova/shared';
import { Button, Spinner } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useDebounced } from '../work/events.ts';
import { useBrowserApi } from './api.ts';
import { SIGNIN_EVENTS, eventComputerId, useHubEvents } from './events.ts';
import { SigninForm, type SigninOutcome } from './SigninForm.tsx';

interface Answered {
  host: string;
  outcome: SigninOutcome;
  message: string;
}

export function PendingSignins({
  computerId,
  focusId,
  empty,
}: {
  /** Only this computer's forms; all of the account's otherwise. */
  computerId?: string;
  focusId?: string | null;
  /** Shown when nothing waits; nothing is shown when omitted. */
  empty?: string;
}) {
  const api = useBrowserApi();
  const [items, setItems] = useState<BrowserSigninView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [answered, setAnswered] = useState<Record<string, Answered>>({});

  useEffect(() => {
    let alive = true;
    api.listBrowserSignins().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list.filter((s) => !computerId || s.computerId === computerId));
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load sign-in requests.')),
    );
    return () => {
      alive = false;
    };
  }, [api, computerId, attempt]);

  const reload = useDebounced(() => setAttempt((n) => n + 1), 150);
  useHubEvents(SIGNIN_EVENTS, (env) => {
    if (!computerId || eventComputerId(env) === computerId) reload();
  });

  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || focused.current === focusId || !items?.some((s) => s.id === focusId)) return;
    focused.current = focusId;
    const el = [...document.querySelectorAll<HTMLElement>('[data-signin]')].find(
      (x) => x.dataset.signin === focusId,
    );
    el?.scrollIntoView?.({ block: 'center' });
    el?.querySelector<HTMLElement>('input')?.focus();
  }, [focusId, items]);

  const done = (s: BrowserSigninView) => (id: string, outcome: SigninOutcome, message: string) =>
    setAnswered((a) => ({ ...a, [id]: { host: s.host, outcome, message } }));

  const waiting = (items ?? []).filter((s) => !answered[s.id]);
  const results = Object.entries(answered);

  if (error)
    return (
      <div className="ws-error" role="alert">
        <p>{error}</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  if (items === null) return <Spinner label="Loading sign-in requests" />;
  if (!waiting.length && !results.length) return empty ? <p className="muted">{empty}</p> : null;
  return (
    <div className="brw-signins">
      {results.map(([id, r]) => (
        <div key={id} className="brw-signin-result" data-outcome={r.outcome}>
          <p role="status">
            <strong>Sign in to {r.host}:</strong> {r.message}
          </p>
          <Button
            variant="ghost"
            onClick={() =>
              setAnswered((a) => {
                const next = { ...a };
                delete next[id];
                return next;
              })
            }
          >
            Dismiss
          </Button>
        </div>
      ))}
      {waiting.map((s) => (
        <SigninForm key={s.id} signin={s} onDone={done(s)} />
      ))}
    </div>
  );
}
