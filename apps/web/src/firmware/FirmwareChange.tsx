// One firmware change of a device (FR-146; docs/23 §6.3): its diff (security-degrading rows
// marked with an icon and words, never color alone), what was left out and why, whether it needs a
// restart, the watchdog outcome, the error in plain words, and, for the device's current change,
// the next step: ask for approval, the Hub-only approval card, or Apply after a confirmation that
// names the device and lists every change (with the optional restart and its watchdog). Applied
// changes in the history offer Roll back, which plans restoring their snapshot behind its own
// approval.
import { useId, useState } from 'react';
import type {
  DeviceView,
  FirmwareChangeView,
  FirmwarePolicyView,
  FirmwareValue,
} from '@nova/shared';
import { ApiError } from '../api.ts';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { Chip, ConfirmDialog, Unavailable } from '../devices/parts.tsx';
import { minutesText } from '../boot/format.ts';
import { useAnnounce } from '../services.tsx';
import { useSetting } from '../settings.tsx';
import { formatWhen, plural } from '../settings/common.ts';
import { followLink } from '../work/nav.tsx';
import { useFirmwareApi } from './api-m75.ts';
import {
  CHANGE_STATUS,
  FIRMWARE_SETTINGS_PATH,
  OPEN_STATUSES,
  REFUSAL_TEXT,
  changeErrorText,
  changeKindText,
  firmwareErrorMessage,
  inPlainWords,
  keyLabel,
  valueText,
  watchdogText,
} from './format.ts';
import { HubOnlyApproval } from './HubOnlyApproval.tsx';
import './firmware.css';

/** The diff as a table: one row per setting, before and after, security-degrading rows marked. */
export function DiffTable({
  change,
  caption,
  held,
}: {
  change: Pick<FirmwareChangeView, 'diff'>;
  caption: string;
  /** What the device reports now, per setting (shown when a revert did not complete). */
  held?: Record<string, FirmwareValue | null> | null;
}) {
  if (!change.diff.length) return <p className="muted">Nothing changes.</p>;
  const marked = change.diff.some((e) => e.securityDegrading);
  return (
    <div className="fw-table-wrap">
      <table className="ws-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
            {held ? <th scope="col">On the device now</th> : null}
            {marked ? <th scope="col">Security</th> : null}
          </tr>
        </thead>
        <tbody>
          {change.diff.map((e) => (
            <tr key={e.key} data-degrading={e.securityDegrading || undefined}>
              <th scope="row">{keyLabel(e.key)}</th>
              <td>{valueText(e.from)}</td>
              <td>{valueText(e.to)}</td>
              {held ? <td>{e.key in held ? valueText(held[e.key]) : 'Not read'}</td> : null}
              {marked ? (
                <td>
                  {e.securityDegrading ? (
                    <span className="fw-degrading">
                      <Icon name="alert" /> Weakens security
                    </span>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Change planned 5 min ago", "Rollback applied just now". */
function headline(c: FirmwareChangeView): string {
  const kind = changeKindText(c);
  if (c.appliedAt) return `${kind} applied ${formatWhen(c.appliedAt)}`;
  return `${kind} planned ${formatWhen(c.createdAt)}`;
}

export function ChangeCard({
  change: c,
  device,
  policy,
  current,
  now,
  snapshotTakenAt,
  focusApproval,
  onChanged,
  onReload,
  onRollback,
  noWatchdog = false,
  held = null,
}: {
  change: FirmwareChangeView;
  device: DeviceView;
  policy: FirmwarePolicyView | null;
  /** The device's change in progress: its next step is offered. */
  current: boolean;
  now: number;
  snapshotTakenAt?: string | null;
  /** Focus the approval card when it appears (the owner just asked for it). */
  focusApproval?: boolean;
  onChanged: (c: FirmwareChangeView, how: 'asked' | 'applied' | 'other') => void;
  onReload: () => void;
  /** Applied changes in the history: plan restoring their snapshot. */
  onRollback?: (c: FirmwareChangeView) => void;
  /**
   * The machine has a BIOS admin password: novad never keeps it, so its watchdog cannot restore
   * the settings and the Hub refuses a guarded restart (`watchdog_unavailable`).
   */
  noWatchdog?: boolean;
  /** The device's current values (its last read), for a change the watchdog could not revert. */
  held?: Record<string, FirmwareValue | null> | null;
}) {
  const api = useFirmwareApi();
  const toast = useToast();
  const announce = useAnnounce();
  const id = useId();
  // `devices.firmware.watchdogSeconds`: the window the Hub gives a change applied with a restart.
  const watchdogSeconds = useSetting('devices.firmware.watchdogSeconds').value;
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  // The Hub refused a guarded restart for this machine (`watchdog_unavailable`): apply without one.
  const [refusedRestart, setRefusedRestart] = useState(false);
  const watchdogOff = noWatchdog || refusedRestart;
  const rebootByDefault = c.requiresReboot && !watchdogOff;
  const [reboot, setReboot] = useState(rebootByDefault);
  const status = CHANGE_STATUS[c.status];
  const isRollback = c.kind === 'rollback';
  const on = policy?.allowChanges === true;
  const blockedBySecurity = c.securityDegrading && policy?.allowSecurityDegrading === false;
  const wd = watchdogText(c.watchdog, now);
  // A revert's recorded reason (`watchdog:<reason>`) is what the watchdog line already says.
  const err =
    c.watchdog?.state === 'reverted' && c.error?.startsWith('watchdog:')
      ? null
      : changeErrorText(c.error);
  const last = c.approval;
  const lastNote =
    last?.status === 'expired'
      ? 'The last approval request expired.'
      : last?.status === 'decided' && last.decision !== 'allow_once'
        ? 'Your last approval request was denied.'
        : null;

  const ask = async () => {
    setAsking(true);
    setAskError(null);
    try {
      const view = await api.requestFirmwareApproval(device.id, c.id);
      onChanged(view, 'asked');
      announce('Approval requested. Answer it below or on the Approvals page.');
    } catch (e) {
      setAskError(firmwareErrorMessage(e, 'Could not ask for approval.'));
    } finally {
      setAsking(false);
    }
  };

  return (
    <article
      className="fw-card"
      aria-labelledby={`${id}-h`}
      data-current={current || undefined}
      data-status={c.status}
    >
      <div className="fw-card-head">
        <h3 id={`${id}-h`}>{headline(c)}</h3>
        <Chip tone={status.tone} icon={status.icon} text={status.text} />
      </div>
      <DiffTable
        change={c}
        caption={
          isRollback
            ? `What the rollback restores on ${device.name}`
            : `What changes on ${device.name}`
        }
        held={c.status === 'revert_failed' ? (held ?? {}) : null}
      />
      {c.status === 'revert_failed' ? (
        <p className="fw-degrading" data-unsafe>
          <Icon name="alert" /> These settings may not be safe: the watchdog could not restore
          everything, so {device.name} may still hold some of the new values. Check what it holds
          now, and roll the change back from here.
        </p>
      ) : null}
      {c.refused.length ? (
        <div>
          <p>Left out of the plan:</p>
          <ul>
            {c.refused.map((r) => (
              <li key={r.key}>
                {keyLabel(r.key)}: {REFUSAL_TEXT[r.reason] ?? r.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {c.requiresReboot && OPEN_STATUSES.includes(c.status) ? (
        <p className="muted">Takes effect after the device restarts.</p>
      ) : null}
      {wd ? (
        <p data-watchdog={c.watchdog?.state}>
          <Icon name={c.watchdog?.state === 'ok' ? 'check' : 'clock'} /> {wd}
        </p>
      ) : null}
      {err &&
      (current ||
        c.status === 'failed' ||
        c.status === 'reverted' ||
        c.status === 'revert_failed') ? (
        <p className="devices-unavailable">
          <Icon name="alert" /> <span>{err}</span>
        </p>
      ) : null}

      {current && c.status === 'planned' ? (
        <div className="stack">
          {lastNote ? <p className="muted">{lastNote}</p> : null}
          {blockedBySecurity ? (
            <Unavailable>
              This change weakens security, and “Allow changes that weaken security” is off.{' '}
              <a
                href={FIRMWARE_SETTINGS_PATH}
                onClick={(e) => followLink(e, FIRMWARE_SETTINGS_PATH)}
              >
                Change it in Settings → Devices
              </a>
              .
            </Unavailable>
          ) : null}
          <div className="row">
            <Button variant="primary" disabled={asking || !on} onClick={() => void ask()}>
              {asking ? <Spinner /> : <Icon name="shield" />} Ask for approval
            </Button>
          </div>
          {askError ? (
            <p role="alert" className="nv-field-error">
              {askError}
            </p>
          ) : null}
        </div>
      ) : null}

      {current && c.status === 'awaiting_approval' && last ? (
        <HubOnlyApproval
          approvalId={last.id}
          focusOnShow={focusApproval}
          title={
            isRollback
              ? `Approve restoring the firmware settings of ${device.name}`
              : `Approve this firmware change on ${device.name}`
          }
          onDecided={onReload}
        />
      ) : null}

      {current && c.status === 'approved' ? (
        <div className="stack">
          <p>
            <Icon name="check" /> Approved. Nothing has changed yet: apply it when you are ready.
          </p>
          <div className="row">
            <Button
              variant="danger"
              disabled={!on}
              onClick={() => {
                setReboot(rebootByDefault);
                setApplying(true);
              }}
            >
              {isRollback ? 'Apply the rollback…' : 'Apply…'}
            </Button>
          </div>
        </div>
      ) : null}

      {onRollback &&
      !current &&
      c.kind === 'apply' &&
      (c.status === 'applied' || c.status === 'revert_failed') &&
      c.snapshotId ? (
        <div className="row">
          <Button
            disabled={!on}
            onClick={() => onRollback(c)}
            aria-label={`Roll back the change applied ${formatWhen(c.appliedAt)}`}
          >
            <Icon name="undo" /> Roll back…
          </Button>
          {snapshotTakenAt ? (
            <span className="muted">Snapshot of {formatWhen(snapshotTakenAt)}</span>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={applying}
        title={
          isRollback
            ? `Roll back the firmware settings of ${device.name}?`
            : `Apply this firmware change to ${device.name}?`
        }
        description={
          isRollback
            ? `${plural(c.diff.length, 'setting')} on ${device.name} go back to their values in the snapshot. A rollback does not restart the device: restart it yourself for the settings to take effect.`
            : `${plural(c.diff.length, 'setting')} change on ${device.name}. The values before are kept in a snapshot, so you can roll back.`
        }
        confirmLabel={isRollback ? `Roll back ${device.name}` : `Apply to ${device.name}`}
        danger
        onClose={() => setApplying(false)}
        onConfirm={async () => {
          const send = api.applyFirmwareChange(device.id, c.id, isRollback ? {} : { reboot });
          const view = await inPlainWords(
            send.catch((err: unknown) => {
              // No guarded restart for this machine: offer the apply without one.
              if (err instanceof ApiError && err.body.details?.reason === 'watchdog_unavailable') {
                setRefusedRestart(true);
                setReboot(false);
              }
              throw err;
            }),
          );
          setApplying(false);
          onChanged(view, 'applied');
          const msg = isRollback
            ? `Rolled back on ${device.name}.`
            : view.watchdog?.state === 'pending'
              ? `Applied. ${device.name} is restarting with the watchdog armed.`
              : `Applied to ${device.name}.`;
          toast.show(msg, { tone: 'success' });
          announce(msg);
        }}
      >
        <ul aria-label="Changes to apply">
          {c.diff.map((e) => (
            <li key={e.key}>
              {keyLabel(e.key)}: {valueText(e.from)} → {valueText(e.to)}
              {e.securityDegrading ? (
                <span className="fw-degrading">
                  {' '}
                  <Icon name="alert" /> weakens security
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {!isRollback && watchdogOff ? (
          <p className="muted">
            {device.name} has a BIOS admin password, which novad never keeps, so its watchdog could
            not restore the settings: Nova does not restart it.{' '}
            {c.requiresReboot
              ? 'Restart it yourself for the settings to take effect, and roll back from here if it misbehaves.'
              : ''}
          </p>
        ) : null}
        {!isRollback && !watchdogOff ? (
          <label className="fw-check">
            <input
              type="checkbox"
              checked={reboot}
              onChange={(e) => setReboot(e.target.checked)}
              aria-describedby={`${id}-reboot`}
            />
            <span>
              Restart {device.name} now, with the watchdog
              <span id={`${id}-reboot`} className="nv-field-hint">
                {reboot
                  ? `If ${device.name} does not come back within ${minutesText(watchdogSeconds)}, it restores the previous settings and restarts once.`
                  : c.requiresReboot
                    ? 'The settings take effect at its next restart, without the watchdog.'
                    : 'These settings take effect without a restart.'}
              </span>
            </span>
          </label>
        ) : null}
      </ConfirmDialog>
    </article>
  );
}
