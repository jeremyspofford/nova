// A device's Boot tab (FR-143; docs/23 §5.2; ADR-096 D2, D3, D5): the bootloader and its entries
// as the device reports them, the booted entry, a pending trial with its deadline counting down,
// and the last result. Boot profiles (a name for an entry; kernel arguments are not supported, and
// the form says so when some are typed) are created, renamed and deleted here. "Try on next boot"
// asks for approval on a Hub-only card, then the device boots the entry once with a watchdog that
// returns it to its default entry if it does not come back; a confirmed trial can be made the
// default (its own approval). "Revert" clears a pending one-shot and works even with low-level boot
// off. Network boot: whether PXE is on, the device's boot token (shown once, rotated, revoked), the
// iPXE address to give a DHCP server, and the images the Hub offers. Owner-only.
import { useId, useRef, useState, type FormEvent } from 'react';
import type {
  BootAttemptView,
  BootProfileView,
  BootRequestView,
  DeviceBootView,
  PxeTokenCreatedView,
} from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import type { PanelProps } from '../devices/DevicePage.tsx';
import { formatBytes, listText } from '../devices/format.ts';
import {
  Chip,
  ConfirmDialog,
  LoadError,
  Unavailable,
  useCopy,
  useLoad,
} from '../devices/parts.tsx';
import { HubOnlyApproval } from '../firmware/HubOnlyApproval.tsx';
import {
  FIRMWARE_SETTINGS_PATH,
  FIRMWARE_TEXT,
  clockText,
  countdownText,
  firmwareErrorMessage,
  inPlainWords,
  storedErrorText,
} from '../firmware/format.ts';
import { useHubStream } from '../hub-events.ts';
import { rich } from '../i18n/rich.tsx';
import { useAnnounce } from '../services.tsx';
import { formatWhen, useInterval } from '../settings/common.ts';
import { MemberGate } from '../team/role.tsx';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useBootApi, type BootImagesResult } from './api-m75.ts';
import {
  ATTEMPT_STATUS,
  bootloaderText,
  REQUEST_KIND_TEXT,
  REQUEST_STATUS,
  attemptReasonText,
  minutesText,
  watchdogOptions,
} from './format.ts';
import '../firmware/firmware.css';

// Entry titles, entry ids, profile names and the device's own reasons are the device's or the
// owner's words: they reach these messages as placeholders and are never translated.
export const BOOT_PANEL_TEXT = defineMessages('boot.panel', {
  /** What the owner-only notice names. */
  ownerOnlyWhat: 'Device boot',
  unknownEntry: 'unknown entry',
  deletedProfile: 'a deleted profile',
  requested:
    '{kind, select, try {Boot once} commit {Make default} other {Clear the one-shot}}: approval requested. Answer it below or on the Approvals page.',
  title: 'Boot',
  loadFailed: 'Could not load the boot status.',
  reading: 'Reading the boot status',
  statusUnreadable: 'The device’s boot status could not be read.',
  /** `reason` is the device's own reason, as it sent it. */
  unmanagedBecause: 'Boot cannot be managed on this device: {reason}.',
  unmanaged: 'Boot cannot be managed on this device: its bootloader is not supported.',
  bootloader: 'Bootloader',
  bootedEntry: 'Booted entry',
  defaultEntry: 'Default entry',
  entriesCaption: 'Entries the device lists',
  entry: 'Entry',
  id: 'Id',
  state: 'State',
  isDefault: 'Default',
  bootedNow: 'Booted now',
  noEntries: 'The device lists no boot entries.',
  lastTrial:
    'Last trial: {profile} on “{entry}”: {result, select, ok {came back} reverted {returned to its default entry} other {failed}}, {when}.',
  pendingTitle: 'Pending trial',
  pendingOnce: '{device} boots “{entry}” once (profile {profile}).',
  pendingBy: 'If it does not come back on it by {time}, it returns to its default entry.',
  revertMore: 'Revert…',
  revertWorks: 'Works even with low-level boot changes off.',
  trials: 'Trials',
  bootTrials: 'Boot trials',
  trialTitle: '{profile}: “{entry}”',
  started:
    'Started {when}, watchdog {duration}, {reboot, select, yes {restarted at once} other {at the next restart}}.',
  ended: 'Ended {when}.',
  notVerified:
    'Not verified: the device could not tell which entry it booted (GRUB does not report it). Check that it booted “{entry}” before making it the default.',
  defaultSince: 'The default entry since {when}.',
  makeDefaultMore: 'Make default…',
  needsLowLevel: 'Needs low-level boot changes on.',
  requests: 'Requests',
  bootRequests: 'Boot requests',
  revertTitle: 'Clear the one-shot boot of {device}?',
  revertBodyDefault:
    '{device} boots its default entry (“{entry}”) at its next restart, and the trial ends. This works even with low-level boot changes off.',
  revertBody:
    '{device} boots its default entry at its next restart, and the trial ends. This works even with low-level boot changes off.',
  revert: 'Revert',
  reverted: 'The one-shot boot is cleared.',
  commitTitle: 'Make “{entry}” the default of {device}?',
  unverifiedLead: 'This trial was not verified: the device could not tell which entry it booted.',
  commitBodyInstead:
    '{device} then boots this entry at every restart, instead of “{current}”. This needs your approval next, here in Nova.',
  commitBody:
    '{device} then boots this entry at every restart. This needs your approval next, here in Nova.',
  checkFirst: 'First check that {device} booted “{entry}”, then tick the box.',
  checked: 'I checked that {device} booted “{entry}”',
  checkedWhy: 'The device could not verify it: its bootloader does not report which entry booted.',
  lowLevelOffTitle: 'Low-level boot changes are off.',
  lowLevelOffWhy:
    'They are off by default: booting a machine into another entry can leave it unreachable until someone is in front of it.',
  lowLevelOffWhat:
    'Turned on, you can try a boot profile once, with a watchdog that sends the device back to its default entry if it does not come back, and make a confirmed one the default. Each needs your approval here in Nova. Clearing a pending one-shot always works.',
  /** What a request asks for, after its kind ("Boot once: …"). */
  whatTry: 'Boot once into “{entry}” (profile {profile})',
  whatCommit: 'Make “{entry}” the default entry',
  whatRevert: 'Clear the pending one-shot boot',
  requestTitle: '{kind}: {what}',
  asked: 'Asked {when}.',
  askedSent: 'Asked {when}, sent {sent}.',
  approveTry: 'Approve booting {device} once into “{entry}”',
  approveCommit: 'Approve making “{entry}” the default of {device}',
  nextBoot: 'Next boot',
  theDefaultEntry: 'The default entry',
  once: '{entry}, once',
  kernelArgs:
    'Kernel arguments are not supported yet: a profile boots an entry as its bootloader defines it. Clear this field to save the profile.',
  tryPending: 'A trial is already pending.',
  requestWaiting: 'A request is waiting for approval.',
  nameAndEntry: 'Give the profile a name and choose an entry.',
  created: 'Boot profile {name} created.',
  createFailed: 'Could not create the profile.',
  profiles: 'Boot profiles',
  profilesIntro:
    'A profile names a bootloader entry to try. Kernel arguments are not supported yet.',
  tryOnNextBoot: 'Try {name} on next boot',
  tryMore: 'Try on next boot…',
  renameNamed: 'Rename {name}',
  renameMore: 'Rename…',
  deleteNamed: 'Delete {name}',
  deleteMore: 'Delete…',
  noProfiles: 'No boot profiles yet.',
  newProfile: 'New boot profile',
  newProfileTitle: 'New profile',
  name: 'Name',
  entryId: 'Entry id',
  entryIdHint: 'The device’s entries could not be read; type the id its bootloader uses.',
  kernelArgsLabel: 'Kernel arguments',
  notSupportedYet: 'Not supported yet.',
  createProfile: 'Create profile',
  deleteTitle: 'Delete the boot profile {name}?',
  deleteBody:
    'The profile goes away; its trials stay in the history. The device’s entries are not changed.',
  delete: 'Delete',
  deleted: 'Boot profile deleted.',
  save: 'Save',
  giveName: 'Give the profile a name.',
  tryTitle: 'Try “{profile}” on {device}?',
  tryBody:
    '{device} boots “{entry}” once. If it does not come back and confirm it within the watchdog time, it returns to its default entry by itself. This needs your approval next, here in Nova.',
  watchdog: 'Watchdog',
  watchdogHint: 'How long it has to come back on this entry.',
  restartOnApprove: 'Restart {device} as soon as you approve',
  restartCloses: 'Anything open on it closes.',
  restartLater:
    'It boots this entry at its next restart; the watchdog counts from when the device takes the change.',
  tokenMade: 'Boot token made. Copy it now: it is shown only once.',
  tokenFailed: 'Could not make a boot token.',
  network: 'Network boot (PXE)',
  networkOffTitle: 'Network boot is off.',
  networkOffWhy:
    'It is off by default: when on, the Hub serves an iPXE menu and the images in its boot-images folder to any machine that presents this device’s boot token, without signing in.',
  on: 'On',
  networkOn: 'The Hub serves the iPXE menu to this device’s boot token.',
  noDhcp:
    'Nova runs no DHCP or TFTP server. Give the iPXE address below to your DHCP server (its boot file name, with next-server pointing at the Hub), or embed it in an iPXE build.',
  tokenActive: 'A boot token is active: made {made}, last used {used}.',
  noToken: 'This device has no boot token.',
  newTokenMore: 'Make a new token…',
  revokeMore: 'Revoke…',
  makeToken: 'Make a boot token',
  newToken: 'New boot token',
  copyNowLead: 'Copy it now:',
  /** `lead` is the bold "Copy it now:". */
  copyNow: '{lead} it is shown only once, and the Hub keeps only a hash of it.',
  tokenLine: 'Boot token: {token}',
  ipxeLine: 'iPXE address: {url}',
  copy: 'Copy',
  done: 'Done',
  images: 'Images',
  imagesFailed: 'Could not list the boot images.',
  bootImages: 'Boot images',
  imageMeta: '{size}, changed {when}',
  noImages: 'No images yet. Put boot images (kernels, initrds, ISO files) in {folder} on the Hub.',
  rotateTitle: 'Make a new boot token for {device}?',
  rotateBody:
    'The current token stops working at once: anything set up with the old iPXE address needs the new one.',
  rotate: 'Make a new token',
  rotated: 'New boot token made. Copy it now: it is shown only once.',
  revokeTitle: 'Revoke the boot token of {device}?',
  revokeBody: 'Network boot with it stops at once. You can make a new one later.',
  revoke: 'Revoke',
  revokedToken: 'Boot token revoked.',
});

const S = BOOT_PANEL_TEXT;

/** The events that change what the tab shows (contracts/events.md). */
export const BOOT_EVENTS = [
  'device.boot.changed',
  'approval.decided',
  'approval.requested',
  'settings.changed',
] as const;

export function BootPanel(props: PanelProps) {
  return (
    <MemberGate ownerOnly what={S.ownerOnlyWhat}>
      <BootBody {...props} />
    </MemberGate>
  );
}

function BootBody({ device }: PanelProps) {
  const api = useBootApi();
  const announce = useAnnounce();
  const base = useId();
  const revoked = device.status === 'revoked';
  const view = useLoad<DeviceBootView>(() => api.getDeviceBoot(device.id), device.id);
  const images = useLoad<BootImagesResult>(() => api.listBootImages(), `img:${device.id}`);
  const [now, setNow] = useState(() => Date.now());
  const [reverting, setReverting] = useState(false);
  const [trying, setTrying] = useState<BootProfileView | null>(null);
  const [committing, setCommitting] = useState<BootAttemptView | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const reload = useDebounced(view.reload, 150);
  const reloadImages = useDebounced(images.reload, 150);
  useHubStream(BOOT_EVENTS, (env) => {
    if (env.name === 'device.boot.changed' && env.payload.deviceId !== device.id) return;
    if (env.name === 'settings.changed') {
      const key = typeof env.payload.key === 'string' ? env.payload.key : '';
      if (!key.startsWith('devices.boot.') && key !== 'devices.pxe.enabled') return;
      reloadImages();
    }
    reload();
  });

  const v = view.data;
  const status = v?.status ?? null;
  const pendingAttempt = v?.attempts.find((a) => a.status === 'pending') ?? null;
  const pending = status?.pending ?? null;
  // The Hub's own clock first: its watchdog fails the trial from that deadline.
  const deadline = pendingAttempt?.deadline ?? pending?.deadline ?? null;
  useInterval(() => setNow(Date.now()), 1000, deadline !== null);

  const entryTitle = (id: string | null | undefined) => {
    if (!id) return S.unknownEntry;
    const e = status?.entries.find((x) => x.id === id);
    return e ? e.title : id;
  };
  const profileName = (id: string | null | undefined) =>
    v?.profiles.find((p) => p.id === id)?.name ?? S.deletedProfile;
  const defaultEntry = status?.entries.find((e) => e.isDefault) ?? null;
  const lowLevel = v?.lowLevelBoot === true;
  const openRequest = v?.requests.find((r) => r.status === 'awaiting_approval') ?? null;

  const onRequested = (r: BootRequestView, kind: BootRequestView['kind']) => {
    view.setData((cur) =>
      cur ? { ...cur, requests: [r, ...cur.requests.filter((x) => x.id !== r.id)] } : cur,
    );
    setAsked(r.id);
    view.reload();
    announce(S.requested({ kind }));
  };

  return (
    <div className="stack">
      <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
        <div className="ws-section-header">
          <h2 id={`${base}-h`}>{S.title}</h2>
          <Button onClick={view.reload}>
            <Icon name="refresh" /> {FIRMWARE_TEXT.readAgain}
          </Button>
        </div>
        {v && !lowLevel ? <LowLevelOffNote /> : null}
        {view.error ? (
          <LoadError error={view.error} fallback={S.loadFailed} onRetry={view.reload} />
        ) : null}
        {view.loading ? <Spinner label={S.reading} /> : null}
        {v?.statusError ? (
          <Unavailable>
            {S.statusUnreadable} {storedErrorText(v.statusError)}
          </Unavailable>
        ) : null}
        {status && !status.supported ? (
          <Unavailable>
            {status.reason ? S.unmanagedBecause({ reason: status.reason }) : S.unmanaged}
          </Unavailable>
        ) : null}
        {status && status.supported ? (
          <>
            <dl className="devices-facts" aria-label={S.bootloader}>
              <div>
                <dt>{S.bootloader}</dt>
                <dd>{bootloaderText(status.bootloader)}</dd>
              </div>
              <div>
                <dt>{S.bootedEntry}</dt>
                <dd dir="auto">
                  {status.booted ? entryTitle(status.booted) : FIRMWARE_TEXT.notReported}
                </dd>
              </div>
              <div>
                <dt>{S.defaultEntry}</dt>
                <dd dir="auto">{defaultEntry ? defaultEntry.title : FIRMWARE_TEXT.notReported}</dd>
              </div>
            </dl>
            {status.entries.length ? (
              <div className="fw-table-wrap">
                <table className="ws-table">
                  <caption>{S.entriesCaption}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{S.entry}</th>
                      <th scope="col">{S.id}</th>
                      <th scope="col">{S.state}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.entries.map((e) => (
                      <tr key={e.id}>
                        <th scope="row" dir="auto">
                          {e.title}
                        </th>
                        <td>
                          <code className="ws-code-inline">{e.id}</code>
                        </td>
                        <td>
                          {listText(
                            [
                              e.isDefault ? S.isDefault : null,
                              status.booted === e.id ? S.bootedNow : null,
                            ].filter((x): x is string => x !== null),
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted ws-flush">{S.noEntries}</p>
            )}
            {status.last ? (
              <p className="ws-flush">
                {S.lastTrial({
                  profile: profileName(status.last.profileId),
                  entry: entryTitle(status.last.entryId),
                  result: status.last.result,
                  when: formatWhen(status.last.at),
                })}
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {pending || pendingAttempt ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-p`}>
          <h2 id={`${base}-p`}>{S.pendingTitle}</h2>
          <p className="ws-flush">
            {S.pendingOnce({
              device: device.name,
              entry: entryTitle(pending?.entryId ?? pendingAttempt?.entryId),
              profile: profileName(pending?.profileId ?? pendingAttempt?.profileId),
            })}
            {deadline ? (
              <>
                {' '}
                {S.pendingBy({ time: clockText(deadline) })}{' '}
                <strong data-countdown>{countdownText(deadline, now)}</strong>
              </>
            ) : null}
          </p>
          <div className="row">
            <Button variant="danger" disabled={revoked} onClick={() => setReverting(true)}>
              {S.revertMore}
            </Button>
            <span className="muted">{S.revertWorks}</span>
          </div>
        </section>
      ) : null}

      {v ? (
        <Profiles
          deviceId={device.id}
          view={v}
          disabled={revoked}
          entryTitle={entryTitle}
          onTry={setTrying}
          onChanged={view.reload}
        />
      ) : null}

      {v?.attempts.length ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-t`}>
          <h2 id={`${base}-t`}>{S.trials}</h2>
          <ul className="fw-list" aria-label={S.bootTrials}>
            {v.attempts.map((a) => {
              const st = ATTEMPT_STATUS[a.status];
              const why = attemptReasonText(a.reason, a.detail);
              const started = S.started({
                when: formatWhen(a.createdAt),
                duration: minutesText(a.watchdogSeconds),
                reboot: a.reboot ? 'yes' : 'no',
              });
              return (
                <li key={a.id} className="fw-card">
                  <div className="fw-card-head">
                    <h3 dir="auto">
                      {S.trialTitle({
                        profile: profileName(a.profileId),
                        entry: entryTitle(a.entryId),
                      })}
                    </h3>
                    <Chip tone={st.tone} icon={st.icon} text={st.text} />
                  </div>
                  <p className="muted">
                    {a.finishedAt
                      ? `${started} ${S.ended({ when: formatWhen(a.finishedAt) })}`
                      : started}
                  </p>
                  {why ? <p>{why}</p> : null}
                  {a.status === 'ok' && a.verified === false ? (
                    <p className="devices-unavailable">
                      <Icon name="alert" />{' '}
                      <span>{S.notVerified({ entry: entryTitle(a.entryId) })}</span>
                    </p>
                  ) : null}
                  {a.committedAt ? (
                    <p>
                      <Icon name="check" /> {S.defaultSince({ when: formatWhen(a.committedAt) })}
                    </p>
                  ) : a.status === 'ok' ? (
                    <div className="row">
                      <Button
                        disabled={revoked || !lowLevel || openRequest !== null}
                        onClick={() => setCommitting(a)}
                      >
                        {S.makeDefaultMore}
                      </Button>
                      {!lowLevel ? <span className="muted">{S.needsLowLevel}</span> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {v?.requests.length ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-r`}>
          <h2 id={`${base}-r`}>{S.requests}</h2>
          <ul className="fw-list" aria-label={S.bootRequests}>
            {v.requests.map((r) => (
              <RequestItem
                key={r.id}
                request={r}
                deviceName={device.name}
                entryTitle={entryTitle}
                profileName={profileName}
                defaultTitle={defaultEntry?.title ?? null}
                focus={asked === r.id}
                onDecided={view.reload}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {v ? (
        <NetworkBoot
          deviceId={device.id}
          deviceName={device.name}
          view={v}
          images={images}
          disabled={revoked}
          onToken={(pxe) => view.setData((cur) => (cur ? { ...cur, pxe } : cur))}
        />
      ) : null}

      <ConfirmDialog
        open={reverting}
        title={S.revertTitle({ device: device.name })}
        description={
          defaultEntry
            ? S.revertBodyDefault({ device: device.name, entry: defaultEntry.title })
            : S.revertBody({ device: device.name })
        }
        confirmLabel={S.revert}
        danger
        onClose={() => setReverting(false)}
        onConfirm={async () => {
          await inPlainWords(api.revertBoot(device.id));
          setReverting(false);
          view.reload();
          announce(S.reverted);
        }}
      />
      {trying && v ? (
        <TryDialog
          deviceId={device.id}
          deviceName={device.name}
          profile={trying}
          entry={entryTitle(trying.entryId)}
          defaultSeconds={v.watchdogSeconds}
          onClose={() => setTrying(null)}
          onRequested={(r) => {
            setTrying(null);
            onRequested(r, 'try');
          }}
        />
      ) : null}
      {committing ? (
        <CommitDialog
          deviceId={device.id}
          deviceName={device.name}
          attempt={committing}
          entry={entryTitle(committing.entryId)}
          defaultTitle={defaultEntry?.title ?? null}
          onClose={() => setCommitting(null)}
          onRequested={(r) => {
            setCommitting(null);
            onRequested(r, 'commit');
          }}
        />
      ) : null}
    </div>
  );
}

/** Make a confirmed trial the default; an unverified one needs the owner's own check first. */
function CommitDialog({
  deviceId,
  deviceName,
  attempt,
  entry,
  defaultTitle,
  onClose,
  onRequested,
}: {
  deviceId: string;
  deviceName: string;
  attempt: BootAttemptView;
  entry: string;
  defaultTitle: string | null;
  onClose: () => void;
  onRequested: (r: BootRequestView) => void;
}) {
  const api = useBootApi();
  const id = useId();
  const unverified = attempt.verified === false;
  const [checked, setChecked] = useState(false);
  return (
    <ConfirmDialog
      open
      title={S.commitTitle({ entry, device: deviceName })}
      description={[
        unverified ? S.unverifiedLead : null,
        defaultTitle
          ? S.commitBodyInstead({ device: deviceName, current: defaultTitle })
          : S.commitBody({ device: deviceName }),
      ]
        .filter(Boolean)
        .join(' ')}
      confirmLabel={FIRMWARE_TEXT.askForApproval}
      onClose={onClose}
      onConfirm={async () => {
        if (unverified && !checked) throw new Error(S.checkFirst({ device: deviceName, entry }));
        const r = await inPlainWords(
          api.commitBootAttempt(
            deviceId,
            attempt.id,
            unverified ? { confirmUnverified: true } : {},
          ),
        );
        onRequested(r);
      }}
    >
      {unverified ? (
        <label className="fw-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            aria-describedby={`${id}-why`}
          />
          <span>
            {S.checked({ device: deviceName, entry })}
            <span id={`${id}-why`} className="nv-field-hint">
              {S.checkedWhy}
            </span>
          </span>
        </label>
      ) : null}
    </ConfirmDialog>
  );
}

function LowLevelOffNote() {
  return (
    <div className="ws-callout" role="note">
      <Icon name="shield" />
      <div className="stack">
        <p>
          <strong>{S.lowLevelOffTitle}</strong> {S.lowLevelOffWhy}
        </p>
        <p>{S.lowLevelOffWhat}</p>
        <p>
          <a href={FIRMWARE_SETTINGS_PATH} onClick={(e) => followLink(e, FIRMWARE_SETTINGS_PATH)}>
            {FIRMWARE_TEXT.turnOnInSettings}
          </a>
        </p>
      </div>
    </div>
  );
}

function RequestItem({
  request: r,
  deviceName,
  entryTitle,
  profileName,
  defaultTitle,
  focus,
  onDecided,
}: {
  request: BootRequestView;
  deviceName: string;
  entryTitle: (id: string | null) => string;
  profileName: (id: string | null) => string;
  defaultTitle: string | null;
  focus: boolean;
  onDecided: () => void;
}) {
  const st = REQUEST_STATUS[r.status];
  const what =
    r.kind === 'try'
      ? S.whatTry({ entry: entryTitle(r.entryId), profile: profileName(r.profileId) })
      : r.kind === 'commit'
        ? S.whatCommit({ entry: entryTitle(r.entryId) })
        : S.whatRevert;
  return (
    <li className="fw-card" data-status={r.status}>
      <div className="fw-card-head">
        <h3 dir="auto">{S.requestTitle({ kind: REQUEST_KIND_TEXT[r.kind], what })}</h3>
        <Chip tone={st.tone} icon={st.icon} text={st.text} />
      </div>
      <p className="muted">
        {r.sentAt
          ? S.askedSent({ when: formatWhen(r.createdAt), sent: formatWhen(r.sentAt) })
          : S.asked({ when: formatWhen(r.createdAt) })}
      </p>
      {r.status === 'failed' && r.error ? (
        <p className="devices-unavailable">
          <Icon name="alert" /> <span>{storedErrorText(r.error)}</span>
        </p>
      ) : null}
      {r.status === 'awaiting_approval' && r.approvalId ? (
        <HubOnlyApproval
          approvalId={r.approvalId}
          focusOnShow={focus}
          title={
            r.kind === 'try'
              ? S.approveTry({ device: deviceName, entry: entryTitle(r.entryId) })
              : S.approveCommit({ device: deviceName, entry: entryTitle(r.entryId) })
          }
          onDecided={onDecided}
        >
          <div className="fw-table-wrap">
            <table className="ws-table">
              <caption>{FIRMWARE_TEXT.whatChanges({ device: deviceName })}</caption>
              <thead>
                <tr>
                  <th scope="col">{FIRMWARE_TEXT.columns.setting}</th>
                  <th scope="col">{FIRMWARE_TEXT.columns.before}</th>
                  <th scope="col">{FIRMWARE_TEXT.columns.after}</th>
                </tr>
              </thead>
              <tbody>
                {r.kind === 'try' ? (
                  <tr>
                    <th scope="row">{S.nextBoot}</th>
                    <td dir="auto">{defaultTitle ?? S.theDefaultEntry}</td>
                    <td dir="auto">{S.once({ entry: entryTitle(r.entryId) })}</td>
                  </tr>
                ) : (
                  <tr>
                    <th scope="row">{S.defaultEntry}</th>
                    <td dir="auto">{defaultTitle ?? FIRMWARE_TEXT.notReported}</td>
                    <td dir="auto">{entryTitle(r.entryId)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </HubOnlyApproval>
      ) : null}
    </li>
  );
}

function Profiles({
  deviceId,
  view,
  disabled,
  entryTitle,
  onTry,
  onChanged,
}: {
  deviceId: string;
  view: DeviceBootView;
  disabled: boolean;
  entryTitle: (id: string) => string;
  onTry: (p: BootProfileView) => void;
  onChanged: () => void;
}) {
  const api = useBootApi();
  const toast = useToast();
  const announce = useAnnounce();
  const base = useId();
  const entries = view.status?.supported ? view.status.entries : [];
  const [name, setName] = useState('');
  const [entry, setEntry] = useState('');
  const [args, setArgs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [argsError, setArgsError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<BootProfileView | null>(null);
  const [deleting, setDeleting] = useState<BootProfileView | null>(null);
  const blockedTry = !view.lowLevelBoot
    ? S.needsLowLevel
    : view.attempts.some((a) => a.status === 'pending')
      ? S.tryPending
      : view.requests.some((r) => r.status === 'awaiting_approval')
        ? S.requestWaiting
        : null;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setArgsError(null);
    if (args.trim()) {
      setArgsError(S.kernelArgs);
      return;
    }
    const entryId = (entry || entries[0]?.id || '').trim();
    if (!name.trim() || !entryId) {
      setError(S.nameAndEntry);
      return;
    }
    setBusy(true);
    try {
      await api.createBootProfile(deviceId, { name: name.trim(), entryId });
      setName('');
      setEntry('');
      onChanged();
      announce(S.created({ name: name.trim() }));
    } catch (err) {
      setError(firmwareErrorMessage(err, S.createFailed));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>{S.profiles}</h2>
      <p className="muted ws-flush">{S.profilesIntro}</p>
      {view.profiles.length ? (
        <ul className="ws-list" aria-label={S.profiles}>
          {view.profiles.map((p) => (
            <li key={p.id} className="ws-list-row">
              <span dir="auto">
                <strong>{p.name}</strong>{' '}
                <span className="muted">
                  “{entryTitle(p.entryId)}” <code className="ws-code-inline">{p.entryId}</code>
                </span>
              </span>
              <span className="row">
                <Button
                  disabled={disabled || blockedTry !== null}
                  title={blockedTry ?? undefined}
                  onClick={() => onTry(p)}
                  aria-label={S.tryOnNextBoot({ name: p.name })}
                >
                  {S.tryMore}
                </Button>
                <Button
                  disabled={disabled}
                  onClick={() => setRenaming(p)}
                  aria-label={S.renameNamed({ name: p.name })}
                >
                  {S.renameMore}
                </Button>
                <Button
                  variant="danger"
                  disabled={disabled}
                  onClick={() => setDeleting(p)}
                  aria-label={S.deleteNamed({ name: p.name })}
                >
                  {S.deleteMore}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ws-flush">{S.noProfiles}</p>
      )}
      {view.profiles.length && blockedTry ? <Unavailable>{blockedTry}</Unavailable> : null}

      {!disabled ? (
        <form className="stack" onSubmit={(e) => void create(e)} aria-label={S.newProfile}>
          <h3>{S.newProfileTitle}</h3>
          <div className="fw-plan-grid">
            <TextField
              label={S.name}
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
            {entries.length ? (
              <SelectField
                label={S.entry}
                value={entry || entries[0]!.id}
                onChange={setEntry}
                options={entries.map((x) => ({ value: x.id, label: x.title }))}
              />
            ) : (
              <TextField
                label={S.entryId}
                value={entry}
                maxLength={200}
                hint={S.entryIdHint}
                onChange={(e) => setEntry(e.target.value)}
              />
            )}
            <TextField
              label={S.kernelArgsLabel}
              value={args}
              hint={S.notSupportedYet}
              error={argsError ?? undefined}
              onChange={(e) => {
                setArgs(e.target.value);
                setArgsError(e.target.value.trim() ? S.kernelArgs : null);
              }}
            />
          </div>
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner /> : <Icon name="plus" />} {S.createProfile}
            </Button>
          </div>
          {error ? (
            <p role="alert" className="nv-field-error">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}

      {renaming ? (
        <RenameProfile
          deviceId={deviceId}
          profile={renaming}
          onClose={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null);
            onChanged();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={S.deleteTitle({ name: deleting?.name ?? '' })}
        description={S.deleteBody}
        confirmLabel={S.delete}
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await inPlainWords(api.deleteBootProfile(deviceId, deleting.id));
          setDeleting(null);
          onChanged();
          toast.show(S.deleted, { tone: 'success' });
        }}
      />
    </section>
  );
}

function RenameProfile({
  deviceId,
  profile,
  onClose,
  onSaved,
}: {
  deviceId: string;
  profile: BootProfileView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useBootApi();
  const [name, setName] = useState(profile.name);
  return (
    <ConfirmDialog
      open
      title={S.renameNamed({ name: profile.name })}
      confirmLabel={S.save}
      onClose={onClose}
      onConfirm={async () => {
        if (!name.trim()) throw new Error(S.giveName);
        await inPlainWords(api.updateBootProfile(deviceId, profile.id, { name: name.trim() }));
        onSaved();
      }}
    >
      <TextField
        label={S.name}
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
      />
    </ConfirmDialog>
  );
}

function TryDialog({
  deviceId,
  deviceName,
  profile,
  entry,
  defaultSeconds,
  onClose,
  onRequested,
}: {
  deviceId: string;
  deviceName: string;
  profile: BootProfileView;
  entry: string;
  defaultSeconds: number;
  onClose: () => void;
  onRequested: (r: BootRequestView) => void;
}) {
  const api = useBootApi();
  const id = useId();
  const [seconds, setSeconds] = useState(String(defaultSeconds));
  const [reboot, setReboot] = useState(true);
  return (
    <ConfirmDialog
      open
      title={S.tryTitle({ profile: profile.name, device: deviceName })}
      description={S.tryBody({ device: deviceName, entry })}
      confirmLabel={FIRMWARE_TEXT.askForApproval}
      onClose={onClose}
      onConfirm={async () => {
        const r = await inPlainWords(
          api.tryBootProfile(deviceId, profile.id, { watchdogSeconds: Number(seconds), reboot }),
        );
        onRequested(r);
      }}
    >
      <SelectField
        label={S.watchdog}
        value={seconds}
        onChange={setSeconds}
        options={watchdogOptions(defaultSeconds)}
        hint={S.watchdogHint}
      />
      <label className="fw-check">
        <input
          type="checkbox"
          checked={reboot}
          onChange={(e) => setReboot(e.target.checked)}
          aria-describedby={`${id}-reboot`}
        />
        <span>
          {S.restartOnApprove({ device: deviceName })}
          <span id={`${id}-reboot`} className="nv-field-hint">
            {reboot ? S.restartCloses : S.restartLater}
          </span>
        </span>
      </label>
    </ConfirmDialog>
  );
}

function NetworkBoot({
  deviceId,
  deviceName,
  view,
  images,
  disabled,
  onToken,
}: {
  deviceId: string;
  deviceName: string;
  view: DeviceBootView;
  images: ReturnType<typeof useLoad<BootImagesResult>>;
  disabled: boolean;
  onToken: (pxe: DeviceBootView['pxe']) => void;
}) {
  const api = useBootApi();
  const toast = useToast();
  const announce = useAnnounce();
  const copy = useCopy();
  const base = useId();
  const tokenRef = useRef<HTMLElement>(null);
  const urlRef = useRef<HTMLElement>(null);
  const [made, setMade] = useState<PxeTokenCreatedView | null>(null);
  const [asking, setAsking] = useState<'rotate' | 'revoke' | null>(null);
  const [busy, setBusy] = useState(false);
  const pxe = view.pxe;

  const create = async () => {
    setBusy(true);
    try {
      const t = await api.createPxeToken(deviceId);
      setMade(t);
      onToken({
        deviceId: t.deviceId,
        active: t.active,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
      });
      announce(S.tokenMade);
    } catch (err) {
      toast.show(firmwareErrorMessage(err, S.tokenFailed), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>{S.network}</h2>
      {!view.pxeEnabled ? (
        <div className="ws-callout" role="note">
          <Icon name="shield" />
          <div className="stack">
            <p>
              <strong>{S.networkOffTitle}</strong> {S.networkOffWhy}
            </p>
            <p>
              <a
                href={FIRMWARE_SETTINGS_PATH}
                onClick={(e) => followLink(e, FIRMWARE_SETTINGS_PATH)}
              >
                {FIRMWARE_TEXT.turnOnInSettings}
              </a>
            </p>
          </div>
        </div>
      ) : (
        <p className="ws-flush">
          <Chip tone="ready" icon="check" text={S.on} /> {S.networkOn}
        </p>
      )}
      <p className="muted ws-flush">{S.noDhcp}</p>
      <p className="ws-flush">
        {pxe.active
          ? S.tokenActive({ made: formatWhen(pxe.createdAt), used: formatWhen(pxe.lastUsedAt) })
          : S.noToken}
      </p>
      <div className="row">
        {pxe.active ? (
          <>
            <Button disabled={disabled || busy} onClick={() => setAsking('rotate')}>
              {S.newTokenMore}
            </Button>
            <Button
              variant="danger"
              disabled={disabled || busy}
              onClick={() => setAsking('revoke')}
            >
              {S.revokeMore}
            </Button>
          </>
        ) : (
          <Button disabled={disabled || busy} onClick={() => void create()}>
            {busy ? <Spinner /> : null} {S.makeToken}
          </Button>
        )}
      </div>
      {made ? (
        <div className="fw-once" role="region" aria-label={S.newToken} aria-live="polite">
          <p>
            <Icon name="alert" /> {rich(S.copyNow, { lead: <strong>{S.copyNowLead}</strong> })}
          </p>
          <p>
            {rich(S.tokenLine, { token: <code ref={tokenRef}>{made.token}</code> })}{' '}
            <Button
              variant="ghost"
              onClick={() => void copy(made.token, tokenRef.current, 'bootToken')}
            >
              <Icon name="copy" /> {S.copy}
            </Button>
          </p>
          <p>
            {rich(S.ipxeLine, {
              url: (
                <code ref={urlRef} dir="ltr">
                  {made.scriptUrl}
                </code>
              ),
            })}{' '}
            <Button
              variant="ghost"
              onClick={() => void copy(made.scriptUrl, urlRef.current, 'ipxeAddress')}
            >
              <Icon name="copy" /> {S.copy}
            </Button>
          </p>
          <div className="row">
            <Button onClick={() => setMade(null)}>{S.done}</Button>
          </div>
        </div>
      ) : null}

      <h3>{S.images}</h3>
      {images.error ? (
        <LoadError error={images.error} fallback={S.imagesFailed} onRetry={images.reload} />
      ) : null}
      {images.data ? (
        images.data.items.length ? (
          <ul className="ws-list" aria-label={S.bootImages}>
            {images.data.items.map((i) => (
              <li key={i.name} className="ws-list-row">
                <span>
                  <code className="ws-code-inline">{i.name}</code>{' '}
                  <span className="muted">
                    {S.imageMeta({ size: formatBytes(i.size), when: formatWhen(i.modifiedAt) })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ws-flush">
            {rich(S.noImages, {
              folder: (
                <code className="ws-code-inline" dir="ltr">
                  {images.data.folder}
                </code>
              ),
            })}
          </p>
        )
      ) : null}

      <ConfirmDialog
        open={asking === 'rotate'}
        title={S.rotateTitle({ device: deviceName })}
        description={S.rotateBody}
        confirmLabel={S.rotate}
        danger
        onClose={() => setAsking(null)}
        onConfirm={async () => {
          const t = await inPlainWords(api.createPxeToken(deviceId));
          setAsking(null);
          setMade(t);
          onToken({
            deviceId: t.deviceId,
            active: t.active,
            createdAt: t.createdAt,
            lastUsedAt: t.lastUsedAt,
          });
          announce(S.rotated);
        }}
      />
      <ConfirmDialog
        open={asking === 'revoke'}
        title={S.revokeTitle({ device: deviceName })}
        description={S.revokeBody}
        confirmLabel={S.revoke}
        danger
        onClose={() => setAsking(null)}
        onConfirm={async () => {
          const t = await inPlainWords(api.revokePxeToken(deviceId));
          setAsking(null);
          setMade(null);
          onToken(t);
          toast.show(S.revokedToken, { tone: 'success' });
        }}
      />
    </section>
  );
}
