// Computer use on one computer (FR-093, FR-207, FR-087, FR-098, FR-075; docs/04 §2.8, docs/11
// §5-§6): the control state and the always-visible indicator while Nova controls the screen, the
// explicit enablement, the kill key (a big Stop button, and the `screen.killKey` binding while the
// app has focus) and Resume, the app grants, a live view with takeover (the user takes the
// keyboard and mouse; Nova waits until control is returned), the recorded screen actions with
// before/after screenshots, and appshots. Mounted on a computer's page.
import { useCallback, useEffect, useId, useState } from 'react';
import type { ScreenStatusView, ScreenWindowView } from '@nova/shared';
import { Button, Dialog, Icon, Kbd, Spinner, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { useDebounced } from '../work/events.ts';
import { useScreenApi } from './api.ts';
import { Appshots } from './Appshots.tsx';
import { eventComputerId, useHubEvents } from './events.ts';
import { STATE_CHIP, ariaKeys, controllerText, keyCaps, sentence } from './format.ts';
import { claimKill, useKillKey } from './killkey.ts';
import { LiveView } from './LiveView.tsx';
import { ScreenActions } from './ScreenActions.tsx';
import { ScreenGrants } from './ScreenGrants.tsx';
import { STATUS_EVENTS } from './statuses.ts';
import '../workspace.css';
import './screen.css';

export function ScreenStateChip({ status }: { status: ScreenStatusView }) {
  const c = STATE_CHIP[status.state];
  return (
    <span className="nv-chip" data-status={c.tone ?? undefined}>
      <Icon name={c.icon} />
      <span>{c.text}</span>
    </span>
  );
}

function loadError(err: unknown): string {
  return err instanceof ApiError && err.status === 404
    ? 'This computer does not exist or was removed.'
    : errorMessage(err, 'Could not load computer use for this computer.');
}

/** The Hub's reason a screen cannot be seen, in words. */
function desktopProblem(err: unknown): string {
  if (err instanceof ApiError && err.status === 409)
    return /no controlled desktop/i.test(err.body.message)
      ? 'This computer has no controlled desktop, so there is no screen to see or control.'
      : sentence(err.body.message);
  return errorMessage(err, 'The screen could not be seen.');
}

export function ScreenPanel({ computerId }: { computerId: string }) {
  const api = useScreenApi();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [status, setStatus] = useState<ScreenStatusView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(false);
  const [windows, setWindows] = useState<ScreenWindowView[] | null>(null);
  const [noDesktop, setNoDesktop] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  useEffect(() => {
    let alive = true;
    api.screenStatus(computerId).then(
      (s) => {
        if (!alive) return;
        setStatus(s);
        setError(null);
      },
      (err: unknown) => alive && setError(loadError(err)),
    );
    return () => {
      alive = false;
    };
  }, [api, computerId, attempt]);

  const reload = useDebounced(() => setAttempt((n) => n + 1), 120);
  useHubEvents(STATUS_EVENTS, (env) => {
    if (eventComputerId(env) === computerId) reload();
  });

  const run = async (what: () => Promise<ScreenStatusView>, fail: string) => {
    setBusy(true);
    try {
      const s = await what();
      setStatus(s);
      return s;
    } catch (err) {
      toast.show(`${fail}: ${errorMessage(err)}`, { tone: 'error' });
      reload();
      return null;
    } finally {
      setBusy(false);
    }
  };

  const kill = useCallback(async () => {
    try {
      const s = await api.killScreen(computerId);
      setStatus(s);
      announce('Computer use stopped. Nova waits until you resume control.');
    } catch (err) {
      toast.show(`Could not stop computer use: ${errorMessage(err)} Press Stop again.`, {
        tone: 'error',
        duration: 0,
      });
    }
  }, [api, computerId, announce, toast]);

  const killKey = status?.indicator.killKey ?? 'Escape';
  useKillKey(status?.state === 'controlling', killKey, (e) => {
    // Another listener (the global indicator) may have stopped it already: show the new state.
    if (claimKill(e, computerId)) void kill();
    else reload();
  });

  const setEnabled = async (enabled: boolean) => {
    setConfirmEnable(false);
    const s = await run(
      () => api.setScreenControl(computerId, enabled),
      enabled ? 'Could not turn on computer use' : 'Could not turn off computer use',
    );
    if (s) announce(enabled ? 'Computer use is on.' : 'Computer use is off.');
  };

  const resume = async () => {
    const s = await run(() => api.resumeScreen(computerId), 'Could not resume control');
    if (s) announce('Control resumed. Nova looks at the screen again before it acts.');
  };

  const takeOver = async () => {
    setBusy(true);
    try {
      await api.startTakeover(computerId, 'desktop');
      announce('You have control. Nova waits until you return control.');
      reload();
    } catch (err) {
      toast.show(`Could not take over: ${sentence(errorMessage(err))}`, { tone: 'error' });
      reload();
    } finally {
      setBusy(false);
    }
  };

  const giveBack = async () => {
    setBusy(true);
    try {
      await api.endTakeover(computerId);
      setWatching(false);
      announce('Control returned. Nova looks at the screen again before it acts.');
      toast.show('Control returned to Nova.', { tone: 'success' });
      reload();
    } catch (err) {
      toast.show(`Could not return control: ${sentence(errorMessage(err))}`, { tone: 'error' });
      reload();
    } finally {
      setBusy(false);
    }
  };

  const lookAtApps = () => {
    setLooking(true);
    api.screenObservation(computerId).then(
      (obs) => {
        setWindows(obs.windows);
        setNoDesktop(null);
        setLooking(false);
      },
      (err: unknown) => {
        setNoDesktop(desktopProblem(err));
        setLooking(false);
      },
    );
  };

  if (error)
    return (
      <section className="scr-panel" aria-labelledby={headingId}>
        <h2 id={headingId}>Computer use</h2>
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      </section>
    );
  if (!status)
    return (
      <section className="scr-panel" aria-labelledby={headingId}>
        <h2 id={headingId}>Computer use</h2>
        <Spinner label="Loading computer use" />
      </section>
    );

  const takeover = status.takeover;
  const desktopTakeover = takeover?.surface === 'desktop';
  const browserTakeover = takeover?.surface === 'browser';
  const showLive = watching || desktopTakeover;

  return (
    <section className="scr-panel" aria-labelledby={headingId} data-state={status.state}>
      <header className="ws-section-header">
        <h2 id={headingId}>Computer use</h2>
        <ScreenStateChip status={status} />
      </header>

      {status.state === 'controlling' ? (
        <div className="scr-banner" data-tone="active" role="group" aria-label="Control indicator">
          <Icon name="eye" />
          <p>
            <strong>{status.indicator.text ?? 'Nova is controlling apps on this computer.'}</strong>
          </p>
          <Button
            variant="danger"
            className="scr-stop"
            onClick={() => void kill()}
            aria-keyshortcuts={ariaKeys(killKey)}
          >
            <Icon name="stop" /> Stop
          </Button>
        </div>
      ) : null}
      {status.state === 'stopped' ? (
        <div className="scr-banner" data-tone="stopped" role="group" aria-label="Control stopped">
          <Icon name="stop" />
          <p>
            <strong>Control stopped by you.</strong> Nothing is sent to the screen and the work
            waits until you resume control.
          </p>
          <Button variant="primary" onClick={() => void resume()} disabled={busy}>
            Resume control
          </Button>
        </div>
      ) : null}
      {takeover ? (
        <div className="scr-banner" data-tone="user" role="group" aria-label="Takeover">
          <Icon name="hand" />
          <p>
            <strong>{browserTakeover ? 'You have the agent browser.' : 'You have control.'}</strong>{' '}
            Nova waits until you return control.
          </p>
          <Button variant="primary" onClick={() => void giveBack()} disabled={busy}>
            Return control
          </Button>
        </div>
      ) : null}

      {/* The banners above already say who has control in the other states. */}
      {status.state === 'idle' || status.state === 'disabled' ? (
        <p className="muted ws-flush scr-who">{controllerText(status)}</p>
      ) : null}

      <SwitchField
        label="Allow computer use on this computer"
        description={
          <>
            Nova can then ask to control apps here. Each app needs your permission, and{' '}
            <Kbd keys={keyCaps(killKey)} /> or Stop ends control at once.
          </>
        }
        checked={status.enabled}
        disabled={busy}
        onChange={(next) => (next ? setConfirmEnable(true) : void setEnabled(false))}
      />
      {status.state === 'idle' ? (
        <div className="row">
          <Button
            variant="danger"
            onClick={() => void kill()}
            aria-keyshortcuts={ariaKeys(killKey)}
          >
            <Icon name="stop" /> Stop computer use
          </Button>
        </div>
      ) : null}

      <section className="ws-section scr-live-section" aria-label="Screen">
        <div className="ws-section-header">
          <h3>Screen</h3>
          <div className="ws-toolbar">
            {!showLive ? (
              <Button onClick={() => setWatching(true)}>
                <Icon name="eye" /> Watch live
              </Button>
            ) : null}
            {!takeover ? (
              <Button variant="primary" onClick={() => void takeOver()} disabled={busy}>
                <Icon name="hand" /> Take over
              </Button>
            ) : null}
          </div>
        </div>
        <p className="muted ws-flush">
          Take over to use the keyboard and mouse yourself, for example to sign in or pass a check.
          Nova pauses until you return control, and your takeover is logged.
        </p>
        {showLive ? (
          <LiveView
            key={desktopTakeover ? 'control' : 'watch'}
            computerId={computerId}
            surface="desktop"
            control={desktopTakeover}
            onStatus={setStatus}
            onClose={desktopTakeover ? undefined : () => setWatching(false)}
          />
        ) : null}
      </section>

      <ScreenGrants
        computerId={computerId}
        grants={status.grants.filter((g) => g.active)}
        windows={windows}
        noDesktop={noDesktop}
        onChanged={reload}
        onLookAtApps={lookAtApps}
        lookingAtApps={looking}
      />
      <ScreenActions computerId={computerId} />
      <Appshots computerId={computerId} windows={windows} />

      <Dialog
        open={confirmEnable}
        onClose={() => setConfirmEnable(false)}
        title="Turn on computer use?"
        description="Nova can then ask to see the screen and control apps on this computer."
        footer={
          <>
            <Button onClick={() => setConfirmEnable(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void setEnabled(true)}>
              Turn on
            </Button>
          </>
        }
      >
        <ul className="ws-plain-list">
          <li>Nova acts only in apps you allow, each for a limited time.</li>
          <li>It never controls system settings, password managers, banking or payment apps.</li>
          <li>
            Press <Kbd keys={keyCaps(killKey)} /> or Stop to end control at once.
          </li>
          <li>Every action is recorded with a screenshot before and after.</li>
        </ul>
      </Dialog>
    </section>
  );
}
