// A schedule's webhook signing secret (FR-055, docs/09 §6): every delivery to the schedule's
// webhook is signed with it, and the Hub never shows it again after it is made. "Make a new
// secret" asks first (the current one stops working at once), then shows the new one once with
// how receivers check a delivery. Shown in the schedule's form when it delivers to a webhook. The
// confirmation is inline, so it works inside the schedule dialog.
import { useId, useState } from 'react';
import type { WebhookSecretView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { attempt } from './api.ts';
import { useChannelsM7Api } from './api-m7.ts';
import { formatStamp } from './format.ts';
import { SecretsOnce } from './parts.tsx';
import './channels.css';

export function ScheduleWebhookSecret({ scheduleId }: { scheduleId: string }) {
  const api = useChannelsM7Api();
  const headingId = useId();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<WebhookSecretView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rotate = async () => {
    setBusy(true);
    setError(null);
    try {
      const v = await attempt(() => api.rotateScheduleWebhookSecret(scheduleId));
      setFresh(v);
      setAsking(false);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? 'This schedule does not deliver to a webhook yet. Save it with a webhook address first.'
          : errorMessage(err, 'Could not make a new secret.'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ch-webhook-secret" role="group" aria-labelledby={headingId}>
      <span id={headingId} className="nv-field-label">
        Signing secret
      </span>
      <p className="nv-field-hint ws-flush">
        Each delivery is signed: <code>x-nova-signature: sha256=&lt;hex&gt;</code> is the
        HMAC-SHA256 of <code>&lt;x-nova-timestamp&gt;.&lt;body&gt;</code> made with this secret. The
        secret is never shown again after it is made.
      </p>
      {fresh ? (
        <>
          <SecretsOnce items={[{ label: 'Signing secret', value: fresh.secret }]} />
          <p className="muted ws-flush">Made {formatStamp(fresh.rotatedAt)}.</p>
        </>
      ) : null}
      {asking ? (
        <div className="ws-callout" role="group" aria-labelledby={`${headingId}-ask`}>
          <p id={`${headingId}-ask`} className="ws-flush">
            <Icon name="alert" /> Make a new secret? The current one stops working at once, so your
            receiver refuses deliveries until you give it the new one.
          </p>
          <div className="row">
            <Button autoFocus onClick={() => setAsking(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void rotate()} disabled={busy}>
              {busy ? <Spinner /> : null} Make a new secret
            </Button>
          </div>
        </div>
      ) : (
        <div className="row">
          <Button
            onClick={() => {
              setError(null);
              setAsking(true);
            }}
          >
            <Icon name="refresh" /> {fresh ? 'Make another secret' : 'Make a new secret'}
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
