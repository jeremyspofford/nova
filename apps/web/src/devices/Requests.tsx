// A device's request to join, for the owner (FR-132; docs/22 §4.1 step 3): what asks (its name,
// what it runs, platform, role and when), and the six-digit code the device shows, which the owner
// types here. The field is never filled in for them: reading the device's screen and typing what
// it shows is the check that the right device is joining. A wrong code shows the Hub's refusal.
// `PendingRequests` lists every pending request on the Devices page ("Waiting for approval").
import { useId, useState } from 'react';
import type { AddDeviceRequestView } from '@nova/shared';
import { Button, Spinner, TextField, useToast } from '@nova/ui';
import { ApiError } from '../api.ts';
import { formatWhen, useInterval } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { useDevicesApi } from './api.ts';
import { ADD_REQUEST_EVENTS, useDeviceEvents } from './events.ts';
import {
  JOIN_KIND_LABEL,
  ROLE_LABEL,
  deviceErrorMessage,
  errorReason,
  scopesText,
} from './format.ts';
import { LoadError, useLoad } from './parts.tsx';

/** "Web browser · iOS · as Client · 2 min ago". */
export function requestMeta(r: AddDeviceRequestView, now = Date.now()): string {
  return [
    JOIN_KIND_LABEL[r.kind],
    r.platform,
    `as ${ROLE_LABEL[r.role] ?? r.role}`,
    formatWhen(r.createdAt, now),
  ].join(' · ');
}

export function AddRequestCard({
  request,
  onDecided,
  level = 2,
}: {
  request: AddDeviceRequestView;
  /** The request after Approve or Deny (or after the Hub said it was already decided). */
  onDecided: (r: AddDeviceRequestView) => void;
  level?: 2 | 3;
}) {
  const api = useDevicesApi();
  const id = useId();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), 30_000);
  const expired = Date.parse(request.expiresAt) <= now;
  const H = level === 2 ? 'h2' : 'h3';

  const settle = (err: unknown) => {
    // Decided elsewhere or expired: the card goes, and the page says what happened.
    const reason = errorReason(err);
    if (reason !== 'decided' && reason !== 'expired') return;
    const was = err instanceof ApiError ? err.body.details?.status : undefined;
    const status =
      reason === 'expired' || was === 'expired'
        ? 'expired'
        : was === 'approved'
          ? 'approved'
          : 'denied';
    onDecided({ ...request, status });
  };

  const approve = async () => {
    const digits = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(digits)) {
      setError('Type the six digits the device shows.');
      return;
    }
    setBusy('approve');
    setError(null);
    try {
      onDecided(await api.approveAddRequest(request.id, digits));
    } catch (err) {
      setError(deviceErrorMessage(err, 'Could not approve the device.'));
      setBusy(null);
      settle(err);
    }
  };

  const deny = async () => {
    setBusy('deny');
    setError(null);
    try {
      onDecided(await api.denyAddRequest(request.id));
    } catch (err) {
      setError(deviceErrorMessage(err, 'Could not deny the device.'));
      setBusy(null);
      settle(err);
    }
  };

  return (
    <section className="ws-card devices-join-request" aria-labelledby={`${id}-h`}>
      <H id={`${id}-h`} className="devices-join-title">
        {request.name} wants to join
      </H>
      <p className="muted ws-flush ws-card-meta">{requestMeta(request, now)}</p>
      <p className="muted ws-flush ws-card-meta">
        Scopes: {scopesText(request.scopes)}
        {request.via === 'relay' ? ' · through the Relay' : ''}
      </p>
      {expired ? (
        <p role="alert" className="nv-field-error ws-flush">
          This request has expired. Add the device again with a new code.
        </p>
      ) : (
        <form
          className="devices-join-form"
          onSubmit={(e) => {
            e.preventDefault();
            void approve();
          }}
        >
          <TextField
            label="Code shown on the device"
            hint="Type the six digits the device shows. Approve only if it is the device you are adding."
            value={code}
            inputMode="numeric"
            autoComplete="off"
            maxLength={7}
            className="devices-confirm-input"
            onChange={(e) => setCode(e.target.value)}
            error={error ?? undefined}
          />
          <div className="row">
            <Button type="submit" variant="primary" disabled={busy !== null}>
              {busy === 'approve' ? <Spinner /> : null} Approve
            </Button>
            <Button onClick={() => void deny()} disabled={busy !== null}>
              {busy === 'deny' ? <Spinner /> : null} Deny
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Pending requests from any pairing (the Devices page's "Waiting for approval"). */
export function PendingRequests({ onChange }: { onChange: () => void }) {
  const api = useDevicesApi();
  const toast = useToast();
  const list = useLoad(() => api.listAddRequests('pending').then((r) => r.items), 'pending');
  const reload = useDebounced(list.reload, 150);
  useDeviceEvents(ADD_REQUEST_EVENTS, reload);

  const decided = (r: AddDeviceRequestView) => {
    list.setData((cur) => cur?.filter((x) => x.id !== r.id) ?? null);
    if (r.status === 'approved') toast.show(`${r.name} is added.`, { tone: 'success' });
    else if (r.status === 'denied') toast.show(`${r.name} was not added.`, { tone: 'info' });
    else toast.show(`The request from ${r.name} expired.`, { tone: 'info' });
    onChange();
    reload();
  };

  if (list.error && !list.data)
    return (
      <LoadError
        error={list.error}
        fallback="Could not load the requests to join."
        onRetry={list.reload}
      />
    );
  const items = list.data ?? [];
  if (!items.length) return null;
  return (
    <section className="ws-section devices-flat" aria-labelledby="devices-waiting-h">
      <h2 id="devices-waiting-h">Waiting for approval</h2>
      <ul className="ws-list" aria-label="Waiting for approval">
        {items.map((r) => (
          <li key={r.id}>
            <AddRequestCard request={r} onDecided={decided} level={3} />
          </li>
        ))}
      </ul>
    </section>
  );
}
