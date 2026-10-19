// Decommission a device running novad (ADR-096 D9; docs/23 §11): for a computer being given away,
// sold or retired. The dialog says what happens, explains the purge option and needs the device's
// name typed to go on; the Hub then files a high-risk approval card, and once it is allowed the
// device (when online) stops its modules, removes its services and wipes its credentials (and its
// Nova data with purge), and is revoked with its certificate either way; an offline device is
// revoked at once and wipes its credentials at its next contact. The page shows the request, its
// approval card and the outcome.
import { useEffect, useId, useRef, useState } from 'react';
import type {
  DeviceDecommissionResult,
  DeviceDecommissionStatus,
  DeviceDecommissionView,
  DeviceView,
} from '@nova/shared';
import { Button, Dialog, Icon, Spinner, TextField, useToast, type IconName } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { InlineApproval } from '../oob/HubApproval.tsx';
import { useDeviceOpsApi, type DeviceOpsApi } from './api-m75.ts';
import type { ChipTone } from './format.ts';
import { opsErrorMessage } from './ops.tsx';
import { Chip, useLoad } from './parts.tsx';

export const DECOMMISSION_EVENTS: readonly string[] = [
  'device.decommission.requested',
  'device.decommissioned',
  'device.status.changed',
  'approval.decided',
  'approval.cancelled',
];

export const DECOMMISSION_STATUS: Record<
  DeviceDecommissionStatus,
  { text: string; tone: ChipTone; icon: IconName | null }
> = {
  awaiting_approval: { text: 'Waiting for your approval', tone: 'needs_input', icon: 'hand' },
  running: { text: 'Decommissioning', tone: 'running', icon: null },
  done: { text: 'Decommissioned', tone: 'ready', icon: 'check' },
  denied: { text: 'Denied', tone: 'neutral', icon: 'stop' },
  expired: { text: 'Expired: nobody answered in time', tone: 'neutral', icon: 'clock' },
  cancelled: { text: 'Withdrawn', tone: 'neutral', icon: 'stop' },
  failed: { text: 'Failed', tone: 'blocked', icon: 'alert' },
};

/** What the device did, in a sentence. */
export function decommissionResultText(
  result: DeviceDecommissionResult | null,
  purge: boolean,
): string | null {
  switch (result) {
    case 'wiped':
      return purge
        ? 'The device wiped its credentials, deleted its Nova data and removed its service, then was revoked.'
        : 'The device wiped its credentials and removed its service, then was revoked.';
    case 'unreachable':
      return 'The device did not answer. It is revoked, and wipes its credentials the next time it reaches the Hub.';
    case 'refused':
      return 'The device refused. It was revoked anyway.';
    case 'not_told':
      return 'The Hub could not sign the instruction, so the device was revoked without being told.';
    default:
      return null;
  }
}

/** What decommissioning does, said in its dialog. */
export function DecommissionSteps({ online }: { online: boolean }) {
  return (
    <ul className="oob-consent">
      <li>
        {online
          ? 'novad on the device stops its modules, deletes its key, credentials and certificate, and removes its service, so it stops running.'
          : 'The device is offline: it wipes its key and credentials the next time it reaches the Hub.'}
      </li>
      <li>
        The Hub revokes the device and its certificate, whether or not the device could be told.
        Agents lose it as their computer and every folder it shared is closed.
      </li>
      <li>It cannot be undone. To use the computer again, add it with a new code.</li>
    </ul>
  );
}

/** "Decommission…" in the device page's header, with its dialog. */
export function DecommissionButton({
  device,
  onRequested,
}: {
  device: DeviceView;
  onRequested: (v: DeviceDecommissionView) => void;
}) {
  const api = useDeviceOpsApi();
  const [open, setOpen] = useState(false);
  if (!api || device.status === 'revoked') return null;
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Decommission…
      </Button>
      {open ? (
        <DecommissionDialog
          api={api}
          device={device}
          onClose={() => setOpen(false)}
          onRequested={(v) => {
            setOpen(false);
            onRequested(v);
          }}
        />
      ) : null}
    </>
  );
}

function DecommissionDialog({
  api,
  device,
  onClose,
  onRequested,
}: {
  api: DeviceOpsApi;
  device: DeviceView;
  onClose: () => void;
  onRequested: (v: DeviceDecommissionView) => void;
}) {
  const toast = useToast();
  const base = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [purge, setPurge] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === device.name.trim();
  const online = device.status === 'active' && Boolean(device.endpoint);
  const send = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      const v = await api.requestDecommission(device.id, { purge });
      toast.show('Approve the decommission on its card to go ahead.', { tone: 'success' });
      onRequested(v);
    } catch (err) {
      setError(opsErrorMessage(err, 'Could not ask to decommission the device.'));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Decommission ${device.name}?`}
      description="For a computer you are giving away, selling or retiring. After you approve it on the card that follows:"
      onClose={onClose}
      initialFocusRef={cancelRef}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <DecommissionSteps online={online} />
        <label className="nv-radio">
          <input
            type="checkbox"
            checked={purge}
            aria-describedby={`${base}-purge`}
            onChange={(e) => setPurge(e.target.checked)}
          />
          <span className="nv-radio-text">
            <span>Also delete its Nova data</span>
            <span id={`${base}-purge`} className="nv-field-hint">
              novad also deletes its data folder on that computer: its logs, settings, modules,
              staged writes and anything else it kept there. Your own files elsewhere are not
              touched. Without this, that folder stays on the computer. An offline device deletes
              nothing until it reaches the Hub, and only its credentials then.
            </span>
          </span>
        </label>
        <TextField
          label={`Type ${device.name} to confirm`}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
        />
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button ref={cancelRef} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!matches || busy}>
            {busy ? <Spinner /> : null} Ask to decommission {device.name}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The device's latest decommission: its approval card while it waits, then the outcome. */
export function DecommissionStatus({
  deviceId,
  latest,
  onChanged,
}: {
  deviceId: string;
  /** A request just made here (shown until the next load). */
  latest?: DeviceDecommissionView | null;
  onChanged: () => void;
}) {
  const api = useDeviceOpsApi();
  const base = useId();
  const load = useLoad(
    () => (api ? api.getDecommission(deviceId).then((r) => r.decommission) : Promise.resolve(null)),
    `decommission:${deviceId}:${latest?.id ?? ''}`,
  );
  const reload = useDebounced(load.reload, 150);
  const v = load.data ?? latest ?? null;
  // Once it is done the device is revoked: the page loads it again.
  const done = v?.status === 'done';
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  });
  useEffect(() => {
    if (done) changed.current();
  }, [done]);
  useHubStream(DECOMMISSION_EVENTS, (env) => {
    const p = env.payload;
    if (
      p.deviceId === deviceId ||
      (typeof p.approvalId === 'string' && p.approvalId === v?.approvalId)
    )
      reload();
  });
  if (!api || !v) return null;
  const s = DECOMMISSION_STATUS[v.status];
  const result = decommissionResultText(v.deviceResult, v.purge);
  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <div className="devices-row-head">
        <h2 id={`${base}-h`}>Decommission</h2>
        <Chip tone={s.tone} icon={s.icon} text={s.text} />
      </div>
      <p className="muted ws-flush">
        Asked {formatWhen(v.createdAt)} ·{' '}
        {v.purge ? 'its Nova data is deleted too' : 'its Nova data stays on the computer'}
        {v.finishedAt ? ` · ended ${formatWhen(v.finishedAt)}` : ''}
      </p>
      {v.status === 'awaiting_approval' && v.approvalId ? (
        <InlineApproval approvalId={v.approvalId} onSettled={reload} />
      ) : null}
      <div aria-live="polite">
        {result ? (
          <p className="ws-flush">
            <Icon name={v.deviceResult === 'wiped' ? 'check' : 'alert'} /> {result}
          </p>
        ) : null}
        {v.detail && v.deviceResult !== 'unreachable' ? (
          <p className="muted ws-flush">{v.detail}</p>
        ) : null}
      </div>
    </section>
  );
}
