// The offline banner (FR-112, docs/04 §6 "offline/queued"): above the workspace while the Hub is
// unreachable ("Offline: showing what this device has", where that comes from, what waits to send,
// Try again), while waiting changes go out or failed, and once when this device's offline copy was
// removed. One polite live region, so each change is announced once.
import { useState } from 'react';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, Spinner } from '@nova/ui';
import { REMOVAL_TEXT } from '../replica/engine.ts';
import { navigate } from '../router.ts';
import { formatWhen } from '../settings/common.ts';
import { useOffline } from './context.tsx';
import './offline.css';

export const SYNC_SETTINGS_PATH = '/settings/sync';

export const BANNER_TEXT = defineMessages('offline.banner', {
  region: 'Connection to the Hub',
  offline: 'Offline: showing what this device has.',
  fromCopy:
    "This device's offline copy was last updated {when}. Changes you make wait here and go to the Hub when it is back.",
  fromMemory:
    'Only what this page already loaded is shown, and changes cannot be saved until the Hub is back.',
  waiting: '{n, plural, one {# change waiting to send.} other {# changes waiting to send.}}',
  review: 'Review',
  tryAgain: 'Try again',
  notSent: '{n, plural, one {# change could not be sent.} other {# changes could not be sent.}}',
  staysHere:
    '{n, plural, one {It stays on this device until you retry or discard it.} other {They stay on this device until you retry or discard them.}}',
  sending:
    '{n, plural, one {Sending # change made while offline.} other {Sending # changes made while offline.}}',
  details: 'Details',
  dismiss: 'Dismiss',
});

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
  const removed = state.replica.phase === 'removed' ? state.replica.removal : null;

  let body = null;
  if (state.hub === 'offline') {
    const where =
      state.reads === 'replica'
        ? BANNER_TEXT.fromCopy({ when: formatWhen(state.replica.lastSyncAt) })
        : BANNER_TEXT.fromMemory;
    body = (
      <div className="of-banner" data-tone="offline">
        <Icon name="alert" />
        <div className="of-banner-text">
          <strong>{BANNER_TEXT.offline}</strong>
          <span>
            {where}
            {pending.length ? ` ${BANNER_TEXT.waiting({ n: pending.length })}` : ''}
          </span>
        </div>
        <div className="of-banner-actions">
          {pending.length ? <ReviewLink text={BANNER_TEXT.review} /> : null}
          <Button onClick={() => void runtime.checkNow()} disabled={state.checking}>
            {state.checking ? <Spinner /> : null} {BANNER_TEXT.tryAgain}
          </Button>
        </div>
      </div>
    );
  } else if (failed.length) {
    body = (
      <div className="of-banner" data-tone="failed">
        <Icon name="alert" />
        <div className="of-banner-text">
          <strong>{BANNER_TEXT.notSent({ n: failed.length })}</strong>
          <span>{BANNER_TEXT.staysHere({ n: failed.length })}</span>
        </div>
        <div className="of-banner-actions">
          <ReviewLink text={BANNER_TEXT.review} />
        </div>
      </div>
    );
  } else if (pending.length) {
    body = (
      <div className="of-banner" data-tone="sending">
        <Spinner />
        <div className="of-banner-text">
          <strong>{BANNER_TEXT.sending({ n: pending.length })}</strong>
        </div>
        <div className="of-banner-actions">
          <ReviewLink text={BANNER_TEXT.details} />
        </div>
      </div>
    );
  } else if (removed && dismissed !== removed) {
    body = (
      <div className="of-banner" data-tone="failed">
        <Icon name="shield" />
        <div className="of-banner-text">
          <strong>{REMOVAL_TEXT[removed]}</strong>
        </div>
        <div className="of-banner-actions">
          <Button variant="ghost" onClick={() => setDismissed(removed)}>
            {BANNER_TEXT.dismiss}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div role="status" className="of-banner-region" aria-label={BANNER_TEXT.region}>
      {body}
    </div>
  );
}
