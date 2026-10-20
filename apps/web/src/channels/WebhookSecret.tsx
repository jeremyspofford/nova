// A schedule's webhook signing secret (FR-055, docs/09 §6): every delivery to the schedule's
// webhook is signed with it, and the Hub never shows it again after it is made. "Make a new
// secret" asks first (the current one stops working at once), then shows the new one once with
// how receivers check a delivery. Shown in the schedule's form when it delivers to a webhook. The
// confirmation is inline, so it works inside the schedule dialog.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { WebhookSecretView } from '@nova/shared';
import { Button, Icon, Spinner } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { rich } from '../i18n/rich.tsx';
import { attempt } from './api.ts';
import { useChannelsM7Api } from './api-m7.ts';
import { CREDENTIAL_TEXT, formatStamp } from './format.ts';
import { SIGNING, SecretsOnce } from './parts.tsx';
import './channels.css';

/** A schedule's webhook secret's words (FR-016). Header names and code stay as they are. */
export const WEBHOOK_SECRET_TEXT = defineMessages('channels.webhookSecret', {
  title: 'Signing secret',
  how: 'Each delivery is signed: {header} is the HMAC-SHA256 of {payload} made with this secret. The secret is never shown again after it is made.',
  made: 'Made {when}.',
  ask: 'Make a new secret? The current one stops working at once, so your receiver refuses deliveries until you give it the new one.',
  cancel: 'Cancel',
  make: 'Make a new secret',
  another: 'Make another secret',
  noWebhook:
    'This schedule does not deliver to a webhook yet. Save it with a webhook address first.',
  failed: 'Could not make a new secret.',
});

export function ScheduleWebhookSecret({ scheduleId }: { scheduleId: string }) {
  const api = useChannelsM7Api();
  const S = WEBHOOK_SECRET_TEXT;
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
        err instanceof ApiError && err.status === 409 ? S.noWebhook : errorMessage(err, S.failed),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ch-webhook-secret" role="group" aria-labelledby={headingId}>
      <span id={headingId} className="nv-field-label">
        {S.title}
      </span>
      <p className="nv-field-hint ws-flush">
        {rich(S.how, {
          header: <code>{SIGNING.signature}</code>,
          payload: <code>{SIGNING.deliveryPayload}</code>,
        })}
      </p>
      {fresh ? (
        <>
          <SecretsOnce items={[{ label: CREDENTIAL_TEXT.secret, value: fresh.secret }]} />
          <p className="muted ws-flush">{S.made({ when: formatStamp(fresh.rotatedAt) })}</p>
        </>
      ) : null}
      {asking ? (
        <div className="ws-callout" role="group" aria-labelledby={`${headingId}-ask`}>
          <p id={`${headingId}-ask`} className="ws-flush">
            <Icon name="alert" /> {S.ask}
          </p>
          <div className="row">
            <Button autoFocus onClick={() => setAsking(false)} disabled={busy}>
              {S.cancel}
            </Button>
            <Button variant="danger" onClick={() => void rotate()} disabled={busy}>
              {busy ? <Spinner /> : null} {S.make}
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
            <Icon name="refresh" /> {fresh ? S.another : S.make}
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
