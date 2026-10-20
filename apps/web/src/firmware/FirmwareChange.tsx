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
import { defineMessages } from '@nova/i18n';
import { ApiError } from '../api.ts';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { Chip, ConfirmDialog, Unavailable } from '../devices/parts.tsx';
import { minutesText } from '../boot/format.ts';
import { rich } from '../i18n/rich.tsx';
import { useAnnounce } from '../services.tsx';
import { useSetting } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { followLink } from '../work/nav.tsx';
import { useFirmwareApi } from './api-m75.ts';
import {
  CHANGE_STATUS,
  FIRMWARE_SETTINGS_PATH,
  FIRMWARE_TEXT,
  OPEN_STATUSES,
  REFUSAL_TEXT,
  changeErrorText,
  firmwareErrorMessage,
  inPlainWords,
  keyLabel,
  valueText,
  watchdogText,
} from './format.ts';
import { HubOnlyApproval } from './HubOnlyApproval.tsx';
import './firmware.css';

export const FIRMWARE_CHANGE_TEXT = defineMessages('firmware.change', {
  nothingChanges: 'Nothing changes.',
  onDeviceNow: 'On the device now',
  security: 'Security',
  notRead: 'Not read',
  weakensSecurity: 'Weakens security',
  /** The tag next to a security-degrading change in the Apply dialog's list. */
  weakensSecurityTag: 'weakens security',
  /** "Change planned 5 min ago", "Rollback applied just now". */
  applied: '{kind, select, rollback {Rollback applied {when}} other {Change applied {when}}}',
  planned: '{kind, select, rollback {Rollback planned {when}} other {Change planned {when}}}',
  lastExpired: 'The last approval request expired.',
  lastDenied: 'Your last approval request was denied.',
  asked: 'Approval requested. Answer it below or on the Approvals page.',
  askFailed: 'Could not ask for approval.',
  rollbackRestores: 'What the rollback restores on {device}',
  unsafe:
    'These settings may not be safe: the watchdog could not restore everything, so {device} may still hold some of the new values. Check what it holds now, and roll the change back from here.',
  leftOut: 'Left out of the plan:',
  leftOutItem: '{setting}: {reason}',
  afterRestart: 'Takes effect after the device restarts.',
  weakensOff:
    'This change weakens security, and “Allow changes that weaken security” is off. {link}.',
  changeInSettings: 'Change it in Settings → Devices',
  approveRollback: 'Approve restoring the firmware settings of {device}',
  approveChange: 'Approve this firmware change on {device}',
  approved: 'Approved. Nothing has changed yet: apply it when you are ready.',
  applyRollback: 'Apply the rollback…',
  apply: 'Apply…',
  rollBackAt: 'Roll back the change applied {when}',
  rollBack: 'Roll back…',
  snapshotOf: 'Snapshot of {when}',
  rollbackTitle: 'Roll back the firmware settings of {device}?',
  applyTitle: 'Apply this firmware change to {device}?',
  rollbackBody:
    '{n, plural, one {# setting on {device} goes back to its value in the snapshot.} other {# settings on {device} go back to their values in the snapshot.}} A rollback does not restart the device: restart it yourself for the settings to take effect.',
  applyBody:
    '{n, plural, one {# setting changes on {device}.} other {# settings change on {device}.}} The values before are kept in a snapshot, so you can roll back.',
  rollbackConfirm: 'Roll back {device}',
  applyConfirm: 'Apply to {device}',
  rolledBackOn: 'Rolled back on {device}.',
  appliedRestarting: 'Applied. {device} is restarting with the watchdog armed.',
  appliedTo: 'Applied to {device}.',
  changesToApply: 'Changes to apply',
  changeItem: '{setting}: {from} → {to}',
  noWatchdog:
    '{device} has a BIOS admin password, which novad never keeps, so its watchdog could not restore the settings: Nova does not restart it.',
  restartYourself:
    'Restart it yourself for the settings to take effect, and roll back from here if it misbehaves.',
  restartNow: 'Restart {device} now, with the watchdog',
  restartHint:
    'If {device} does not come back within {duration}, it restores the previous settings and restarts once.',
  nextRestart: 'The settings take effect at its next restart, without the watchdog.',
  noRestart: 'These settings take effect without a restart.',
});

const S = FIRMWARE_CHANGE_TEXT;

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
  if (!change.diff.length) return <p className="muted">{S.nothingChanges}</p>;
  const marked = change.diff.some((e) => e.securityDegrading);
  const C = FIRMWARE_TEXT.columns;
  return (
    <div className="fw-table-wrap">
      <table className="ws-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{C.setting}</th>
            <th scope="col">{C.before}</th>
            <th scope="col">{C.after}</th>
            {held ? <th scope="col">{S.onDeviceNow}</th> : null}
            {marked ? <th scope="col">{S.security}</th> : null}
          </tr>
        </thead>
        <tbody>
          {change.diff.map((e) => (
            <tr key={e.key} data-degrading={e.securityDegrading || undefined}>
              <th scope="row">{keyLabel(e.key)}</th>
              <td>{valueText(e.from)}</td>
              <td>{valueText(e.to)}</td>
              {held ? <td>{e.key in held ? valueText(held[e.key]) : S.notRead}</td> : null}
              {marked ? (
                <td>
                  {e.securityDegrading ? (
                    <span className="fw-degrading">
                      <Icon name="alert" /> {S.weakensSecurity}
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
  if (c.appliedAt) return S.applied({ kind: c.kind, when: formatWhen(c.appliedAt) });
  return S.planned({ kind: c.kind, when: formatWhen(c.createdAt) });
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
      ? S.lastExpired
      : last?.status === 'decided' && last.decision !== 'allow_once'
        ? S.lastDenied
        : null;

  const ask = async () => {
    setAsking(true);
    setAskError(null);
    try {
      const view = await api.requestFirmwareApproval(device.id, c.id);
      onChanged(view, 'asked');
      announce(S.asked);
    } catch (e) {
      setAskError(firmwareErrorMessage(e, S.askFailed));
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
            ? S.rollbackRestores({ device: device.name })
            : FIRMWARE_TEXT.whatChanges({ device: device.name })
        }
        held={c.status === 'revert_failed' ? (held ?? {}) : null}
      />
      {c.status === 'revert_failed' ? (
        <p className="fw-degrading" data-unsafe>
          <Icon name="alert" /> {S.unsafe({ device: device.name })}
        </p>
      ) : null}
      {c.refused.length ? (
        <div>
          <p>{S.leftOut}</p>
          <ul>
            {c.refused.map((r) => (
              <li key={r.key}>
                {S.leftOutItem({
                  setting: keyLabel(r.key),
                  reason: REFUSAL_TEXT[r.reason] ?? r.reason,
                })}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {c.requiresReboot && OPEN_STATUSES.includes(c.status) ? (
        <p className="muted">{S.afterRestart}</p>
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
              {rich(S.weakensOff, {
                link: (
                  <a
                    href={FIRMWARE_SETTINGS_PATH}
                    onClick={(e) => followLink(e, FIRMWARE_SETTINGS_PATH)}
                  >
                    {S.changeInSettings}
                  </a>
                ),
              })}
            </Unavailable>
          ) : null}
          <div className="row">
            <Button variant="primary" disabled={asking || !on} onClick={() => void ask()}>
              {asking ? <Spinner /> : <Icon name="shield" />} {FIRMWARE_TEXT.askForApproval}
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
              ? S.approveRollback({ device: device.name })
              : S.approveChange({ device: device.name })
          }
          onDecided={onReload}
        />
      ) : null}

      {current && c.status === 'approved' ? (
        <div className="stack">
          <p>
            <Icon name="check" /> {S.approved}
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
              {isRollback ? S.applyRollback : S.apply}
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
            aria-label={S.rollBackAt({ when: formatWhen(c.appliedAt) })}
          >
            <Icon name="undo" /> {S.rollBack}
          </Button>
          {snapshotTakenAt ? (
            <span className="muted">{S.snapshotOf({ when: formatWhen(snapshotTakenAt) })}</span>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={applying}
        title={
          isRollback
            ? S.rollbackTitle({ device: device.name })
            : S.applyTitle({ device: device.name })
        }
        description={
          isRollback
            ? S.rollbackBody({ n: c.diff.length, device: device.name })
            : S.applyBody({ n: c.diff.length, device: device.name })
        }
        confirmLabel={
          isRollback
            ? S.rollbackConfirm({ device: device.name })
            : S.applyConfirm({ device: device.name })
        }
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
            ? S.rolledBackOn({ device: device.name })
            : view.watchdog?.state === 'pending'
              ? S.appliedRestarting({ device: device.name })
              : S.appliedTo({ device: device.name });
          toast.show(msg, { tone: 'success' });
          announce(msg);
        }}
      >
        <ul aria-label={S.changesToApply}>
          {c.diff.map((e) => (
            <li key={e.key}>
              {S.changeItem({
                setting: keyLabel(e.key),
                from: valueText(e.from),
                to: valueText(e.to),
              })}
              {e.securityDegrading ? (
                <span className="fw-degrading">
                  {' '}
                  <Icon name="alert" /> {S.weakensSecurityTag}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {!isRollback && watchdogOff ? (
          <p className="muted">
            {S.noWatchdog({ device: device.name })}
            {c.requiresReboot ? ` ${S.restartYourself}` : null}
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
              {S.restartNow({ device: device.name })}
              <span id={`${id}-reboot`} className="nv-field-hint">
                {reboot
                  ? S.restartHint({
                      device: device.name,
                      duration: minutesText(watchdogSeconds),
                    })
                  : c.requiresReboot
                    ? S.nextRestart
                    : S.noRestart}
              </span>
            </span>
          </label>
        ) : null}
      </ConfirmDialog>
    </article>
  );
}
