// The offline banner (FR-112, docs/04 §6 "offline/queued"): above the workspace while the Hub is
// unreachable ("Offline: showing what this device has", where that comes from, what waits to send,
// Try again), while waiting changes go out or failed, and once when this device's offline copy was
// removed. One polite live region, so each change is announced once.
import { useState } from 'react';
import { Button, Icon, Spinner } from '@nova/ui';
import { navigate } from '../router.ts';
import { formatWhen } from '../settings/common.ts';
import { useOffline } from './context.tsx';
import { changesText } from './format.ts';
import './offline.css';

export const SYNC_SETTINGS_PATH = '/settings/sync';

function ReviewLink({ text }: { text: string }) {
  return (
    <a
      href={SYNC_SETTINGS_PATH}
      onClick={(e) => {
        e.preventDefault();
        navigate(SYNC_SETTINGS_PATH);
      }}
    >
      {text}
    </a>
  );
}

export function OfflineBanner() {
  const { runtime, state } = useOffline();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!runtime) return null;
  const pending = state.queue.filter((i) => i.status !== 'done');
  const failed = pending.filter((i) => i.status === 'failed');
  const removed = state.replica.phase === 'removed' ? state.replica.reason : null;

  let body = null;
  if (state.hub === 'offline') {
    const where =
      state.reads === 'replica'
        ? `This device's offline copy was last updated ${formatWhen(state.replica.lastSyncAt)}. Changes you make wait here and go to the Hub when it is back.`
        : 'Only what this page already loaded is shown, and changes cannot be saved until the Hub is back.';
    body = (
      <div className="of-banner" data-tone="offline">
        <Icon name="alert" />
        <div className="of-banner-text">
          <strong>Offline: showing what this device has.</strong>
          <span>
            {where}
            {pending.length ? ` ${changesText(pending.length)} waiting to send.` : ''}
          </span>
        </div>
        <div className="of-banner-actions">
          {pending.length ? <ReviewLink text="Review" /> : null}
          <Button onClick={() => void runtime.checkNow()} disabled={state.checking}>
            {state.checking ? <Spinner /> : null} Try again
          </Button>
        </div>
      </div>
    );
  } else if (failed.length) {
    body = (
      <div className="of-banner" data-tone="failed">
        <Icon name="alert" />
        <div className="of-banner-text">
          <strong>{changesText(failed.length)} could not be sent.</strong>
          <span>They stay on this device until you retry or discard them.</span>
        </div>
        <div className="of-banner-actions">
          <ReviewLink text="Review" />
        </div>
      </div>
    );
  } else if (pending.length) {
    body = (
      <div className="of-banner" data-tone="sending">
        <Spinner />
        <div className="of-banner-text">
          <strong>Sending {changesText(pending.length)} made while offline.</strong>
        </div>
        <div className="of-banner-actions">
          <ReviewLink text="Details" />
        </div>
      </div>
    );
  } else if (removed && dismissed !== removed) {
    body = (
      <div className="of-banner" data-tone="failed">
        <Icon name="shield" />
        <div className="of-banner-text">
          <strong>{removed}</strong>
        </div>
        <div className="of-banner-actions">
          <Button variant="ghost" onClick={() => setDismissed(removed)}>
            Dismiss
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div role="status" className="of-banner-region" aria-label="Connection to the Hub">
      {body}
    </div>
  );
}
