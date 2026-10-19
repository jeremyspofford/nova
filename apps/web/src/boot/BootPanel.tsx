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
import { Button, Icon, SelectField, Spinner, TextField, useToast } from '@nova/ui';
import type { PanelProps } from '../devices/DevicePage.tsx';
import { formatBytes } from '../devices/format.ts';
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
  clockText,
  countdownText,
  firmwareErrorMessage,
  inPlainWords,
  storedErrorText,
} from '../firmware/format.ts';
import { useHubStream } from '../hub-events.ts';
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

/** The events that change what the tab shows (contracts/events.md). */
export const BOOT_EVENTS = [
  'device.boot.changed',
  'approval.decided',
  'approval.requested',
  'settings.changed',
] as const;

export function BootPanel(props: PanelProps) {
  return (
    <MemberGate ownerOnly what="Device boot">
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
    if (!id) return 'unknown entry';
    const e = status?.entries.find((x) => x.id === id);
    return e ? e.title : id;
  };
  const profileName = (id: string | null | undefined) =>
    v?.profiles.find((p) => p.id === id)?.name ?? 'a deleted profile';
  const defaultEntry = status?.entries.find((e) => e.isDefault) ?? null;
  const lowLevel = v?.lowLevelBoot === true;
  const openRequest = v?.requests.find((r) => r.status === 'awaiting_approval') ?? null;

  const onRequested = (r: BootRequestView, what: string) => {
    view.setData((cur) =>
      cur ? { ...cur, requests: [r, ...cur.requests.filter((x) => x.id !== r.id)] } : cur,
    );
    setAsked(r.id);
    view.reload();
    announce(`${what}: approval requested. Answer it below or on the Approvals page.`);
  };

  return (
    <div className="stack">
      <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
        <div className="ws-section-header">
          <h2 id={`${base}-h`}>Boot</h2>
          <Button onClick={view.reload}>
            <Icon name="refresh" /> Read again
          </Button>
        </div>
        {v && !lowLevel ? <LowLevelOffNote /> : null}
        {view.error ? (
          <LoadError
            error={view.error}
            fallback="Could not load the boot status."
            onRetry={view.reload}
          />
        ) : null}
        {view.loading ? <Spinner label="Reading the boot status" /> : null}
        {v?.statusError ? (
          <Unavailable>
            The device’s boot status could not be read. {storedErrorText(v.statusError)}
          </Unavailable>
        ) : null}
        {status && !status.supported ? (
          <Unavailable>
            Boot cannot be managed on this device:{' '}
            {status.reason ?? 'its bootloader is not supported'}.
          </Unavailable>
        ) : null}
        {status && status.supported ? (
          <>
            <dl className="devices-facts" aria-label="Bootloader">
              <div>
                <dt>Bootloader</dt>
                <dd>{bootloaderText(status.bootloader)}</dd>
              </div>
              <div>
                <dt>Booted entry</dt>
                <dd>{status.booted ? entryTitle(status.booted) : 'Not reported'}</dd>
              </div>
              <div>
                <dt>Default entry</dt>
                <dd>{defaultEntry ? defaultEntry.title : 'Not reported'}</dd>
              </div>
            </dl>
            {status.entries.length ? (
              <div className="fw-table-wrap">
                <table className="ws-table">
                  <caption>Entries the device lists</caption>
                  <thead>
                    <tr>
                      <th scope="col">Entry</th>
                      <th scope="col">Id</th>
                      <th scope="col">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.entries.map((e) => (
                      <tr key={e.id}>
                        <th scope="row">{e.title}</th>
                        <td>
                          <code className="ws-code-inline">{e.id}</code>
                        </td>
                        <td>
                          {[
                            e.isDefault ? 'Default' : null,
                            status.booted === e.id ? 'Booted now' : null,
                          ]
                            .filter(Boolean)
                            .join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted ws-flush">The device lists no boot entries.</p>
            )}
            {status.last ? (
              <p className="ws-flush">
                Last trial: {profileName(status.last.profileId)} on “
                {entryTitle(status.last.entryId)}”:{' '}
                {status.last.result === 'ok'
                  ? 'came back'
                  : status.last.result === 'reverted'
                    ? 'returned to its default entry'
                    : 'failed'}
                , {formatWhen(status.last.at)}.
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      {pending || pendingAttempt ? (
        <section className="ws-section devices-flat" aria-labelledby={`${base}-p`}>
          <h2 id={`${base}-p`}>Pending trial</h2>
          <p className="ws-flush">
            {device.name} boots “{entryTitle(pending?.entryId ?? pendingAttempt?.entryId)}” once
            (profile {profileName(pending?.profileId ?? pendingAttempt?.profileId)}).
            {deadline ? (
              <>
                {' '}
                If it does not come back on it by {clockText(deadline)}, it returns to its default
                entry. <strong data-countdown>{countdownText(deadline, now)}</strong>
              </>
            ) : null}
          </p>
          <div className="row">
            <Button variant="danger" disabled={revoked} onClick={() => setReverting(true)}>
              Revert…
            </Button>
            <span className="muted">Works even with low-level boot changes off.</span>
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
          <h2 id={`${base}-t`}>Trials</h2>
          <ul className="fw-list" aria-label="Boot trials">
            {v.attempts.map((a) => {
              const st = ATTEMPT_STATUS[a.status];
              const why = attemptReasonText(a.reason, a.detail);
              return (
                <li key={a.id} className="fw-card">
                  <div className="fw-card-head">
                    <h3>
                      {profileName(a.profileId)}: “{entryTitle(a.entryId)}”
                    </h3>
                    <Chip tone={st.tone} icon={st.icon} text={st.text} />
                  </div>
                  <p className="muted">
                    Started {formatWhen(a.createdAt)}, watchdog {minutesText(a.watchdogSeconds)}
                    {a.reboot ? ', restarted at once' : ', at the next restart'}.
                    {a.finishedAt ? ` Ended ${formatWhen(a.finishedAt)}.` : ''}
                  </p>
                  {why ? <p>{why}</p> : null}
                  {a.status === 'ok' && a.verified === false ? (
                    <p className="devices-unavailable">
                      <Icon name="alert" />{' '}
                      <span>
                        Not verified: the device could not tell which entry it booted (GRUB does not
                        report it). Check that it booted “{entryTitle(a.entryId)}” before making it
                        the default.
                      </span>
                    </p>
                  ) : null}
                  {a.committedAt ? (
                    <p>
                      <Icon name="check" /> The default entry since {formatWhen(a.committedAt)}.
                    </p>
                  ) : a.status === 'ok' ? (
                    <div className="row">
                      <Button
                        disabled={revoked || !lowLevel || openRequest !== null}
                        onClick={() => setCommitting(a)}
                      >
                        Make default…
                      </Button>
                      {!lowLevel ? (
                        <span className="muted">Needs low-level boot changes on.</span>
                      ) : null}
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
          <h2 id={`${base}-r`}>Requests</h2>
          <ul className="fw-list" aria-label="Boot requests">
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
        title={`Clear the one-shot boot of ${device.name}?`}
        description={`${device.name} boots its default entry${
          defaultEntry ? ` (“${defaultEntry.title}”)` : ''
        } at its next restart, and the trial ends. This works even with low-level boot changes off.`}
        confirmLabel="Revert"
        danger
        onClose={() => setReverting(false)}
        onConfirm={async () => {
          await inPlainWords(api.revertBoot(device.id));
          setReverting(false);
          view.reload();
          announce('The one-shot boot is cleared.');
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
            onRequested(r, 'Boot once');
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
            onRequested(r, 'Make default');
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
      title={`Make “${entry}” the default of ${deviceName}?`}
      description={`${
        unverified
          ? `This trial was not verified: the device could not tell which entry it booted. `
          : ''
      }${deviceName} then boots this entry at every restart${
        defaultTitle ? `, instead of “${defaultTitle}”` : ''
      }. This needs your approval next, here in Nova.`}
      confirmLabel="Ask for approval"
      onClose={onClose}
      onConfirm={async () => {
        if (unverified && !checked)
          throw new Error(`First check that ${deviceName} booted “${entry}”, then tick the box.`);
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
            I checked that {deviceName} booted “{entry}”
            <span id={`${id}-why`} className="nv-field-hint">
              The device could not verify it: its bootloader does not report which entry booted.
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
          <strong>Low-level boot changes are off.</strong> They are off by default: booting a
          machine into another entry can leave it unreachable until someone is in front of it.
        </p>
        <p>
          Turned on, you can try a boot profile once, with a watchdog that sends the device back to
          its default entry if it does not come back, and make a confirmed one the default. Each
          needs your approval here in Nova. Clearing a pending one-shot always works.
        </p>
        <p>
          <a href={FIRMWARE_SETTINGS_PATH} onClick={(e) => followLink(e, FIRMWARE_SETTINGS_PATH)}>
            Turn it on in Settings → Devices
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
      ? `Boot once into “${entryTitle(r.entryId)}” (profile ${profileName(r.profileId)})`
      : r.kind === 'commit'
        ? `Make “${entryTitle(r.entryId)}” the default entry`
        : 'Clear the pending one-shot boot';
  return (
    <li className="fw-card" data-status={r.status}>
      <div className="fw-card-head">
        <h3>
          {REQUEST_KIND_TEXT[r.kind]}: {what}
        </h3>
        <Chip tone={st.tone} icon={st.icon} text={st.text} />
      </div>
      <p className="muted">
        Asked {formatWhen(r.createdAt)}
        {r.sentAt ? `, sent ${formatWhen(r.sentAt)}` : ''}.
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
              ? `Approve booting ${deviceName} once into “${entryTitle(r.entryId)}”`
              : `Approve making “${entryTitle(r.entryId)}” the default of ${deviceName}`
          }
          onDecided={onDecided}
        >
          <div className="fw-table-wrap">
            <table className="ws-table">
              <caption>What changes on {deviceName}</caption>
              <thead>
                <tr>
                  <th scope="col">Setting</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {r.kind === 'try' ? (
                  <tr>
                    <th scope="row">Next boot</th>
                    <td>{defaultTitle ?? 'The default entry'}</td>
                    <td>{entryTitle(r.entryId)}, once</td>
                  </tr>
                ) : (
                  <tr>
                    <th scope="row">Default entry</th>
                    <td>{defaultTitle ?? 'Not reported'}</td>
                    <td>{entryTitle(r.entryId)}</td>
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

const KERNEL_ARGS_TEXT =
  'Kernel arguments are not supported yet: a profile boots an entry as its bootloader defines it. Clear this field to save the profile.';

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
    ? 'Needs low-level boot changes on.'
    : view.attempts.some((a) => a.status === 'pending')
      ? 'A trial is already pending.'
      : view.requests.some((r) => r.status === 'awaiting_approval')
        ? 'A request is waiting for approval.'
        : null;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setArgsError(null);
    if (args.trim()) {
      setArgsError(KERNEL_ARGS_TEXT);
      return;
    }
    const entryId = (entry || entries[0]?.id || '').trim();
    if (!name.trim() || !entryId) {
      setError('Give the profile a name and choose an entry.');
      return;
    }
    setBusy(true);
    try {
      await api.createBootProfile(deviceId, { name: name.trim(), entryId });
      setName('');
      setEntry('');
      onChanged();
      announce(`Boot profile ${name.trim()} created.`);
    } catch (err) {
      setError(firmwareErrorMessage(err, 'Could not create the profile.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>Boot profiles</h2>
      <p className="muted ws-flush">
        A profile names a bootloader entry to try. Kernel arguments are not supported yet.
      </p>
      {view.profiles.length ? (
        <ul className="ws-list" aria-label="Boot profiles">
          {view.profiles.map((p) => (
            <li key={p.id} className="ws-list-row">
              <span>
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
                  aria-label={`Try ${p.name} on next boot`}
                >
                  Try on next boot…
                </Button>
                <Button
                  disabled={disabled}
                  onClick={() => setRenaming(p)}
                  aria-label={`Rename ${p.name}`}
                >
                  Rename…
                </Button>
                <Button
                  variant="danger"
                  disabled={disabled}
                  onClick={() => setDeleting(p)}
                  aria-label={`Delete ${p.name}`}
                >
                  Delete…
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ws-flush">No boot profiles yet.</p>
      )}
      {view.profiles.length && blockedTry ? <Unavailable>{blockedTry}</Unavailable> : null}

      {!disabled ? (
        <form className="stack" onSubmit={(e) => void create(e)} aria-label="New boot profile">
          <h3>New profile</h3>
          <div className="fw-plan-grid">
            <TextField
              label="Name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
            {entries.length ? (
              <SelectField
                label="Entry"
                value={entry || entries[0]!.id}
                onChange={setEntry}
                options={entries.map((x) => ({ value: x.id, label: x.title }))}
              />
            ) : (
              <TextField
                label="Entry id"
                value={entry}
                maxLength={200}
                hint="The device’s entries could not be read; type the id its bootloader uses."
                onChange={(e) => setEntry(e.target.value)}
              />
            )}
            <TextField
              label="Kernel arguments"
              value={args}
              hint="Not supported yet."
              error={argsError ?? undefined}
              onChange={(e) => {
                setArgs(e.target.value);
                setArgsError(e.target.value.trim() ? KERNEL_ARGS_TEXT : null);
              }}
            />
          </div>
          <div className="row">
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner /> : <Icon name="plus" />} Create profile
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
        title={`Delete the boot profile ${deleting?.name ?? ''}?`}
        description="The profile goes away; its trials stay in the history. The device’s entries are not changed."
        confirmLabel="Delete"
        danger
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await inPlainWords(api.deleteBootProfile(deviceId, deleting.id));
          setDeleting(null);
          onChanged();
          toast.show('Boot profile deleted.', { tone: 'success' });
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
      title={`Rename ${profile.name}`}
      confirmLabel="Save"
      onClose={onClose}
      onConfirm={async () => {
        if (!name.trim()) throw new Error('Give the profile a name.');
        await inPlainWords(api.updateBootProfile(deviceId, profile.id, { name: name.trim() }));
        onSaved();
      }}
    >
      <TextField
        label="Name"
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
      title={`Try “${profile.name}” on ${deviceName}?`}
      description={`${deviceName} boots “${entry}” once. If it does not come back and confirm it within the watchdog time, it returns to its default entry by itself. This needs your approval next, here in Nova.`}
      confirmLabel="Ask for approval"
      onClose={onClose}
      onConfirm={async () => {
        const r = await inPlainWords(
          api.tryBootProfile(deviceId, profile.id, { watchdogSeconds: Number(seconds), reboot }),
        );
        onRequested(r);
      }}
    >
      <SelectField
        label="Watchdog"
        value={seconds}
        onChange={setSeconds}
        options={watchdogOptions(defaultSeconds)}
        hint="How long it has to come back on this entry."
      />
      <label className="fw-check">
        <input
          type="checkbox"
          checked={reboot}
          onChange={(e) => setReboot(e.target.checked)}
          aria-describedby={`${id}-reboot`}
        />
        <span>
          Restart {deviceName} as soon as you approve
          <span id={`${id}-reboot`} className="nv-field-hint">
            {reboot
              ? 'Anything open on it closes.'
              : 'It boots this entry at its next restart; the watchdog counts from when the device takes the change.'}
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
      announce('Boot token made. Copy it now: it is shown only once.');
    } catch (err) {
      toast.show(firmwareErrorMessage(err, 'Could not make a boot token.'), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ws-section devices-flat" aria-labelledby={`${base}-h`}>
      <h2 id={`${base}-h`}>Network boot (PXE)</h2>
      {!view.pxeEnabled ? (
        <div className="ws-callout" role="note">
          <Icon name="shield" />
          <div className="stack">
            <p>
              <strong>Network boot is off.</strong> It is off by default: when on, the Hub serves an
              iPXE menu and the images in its boot-images folder to any machine that presents this
              device’s boot token, without signing in.
            </p>
            <p>
              <a
                href={FIRMWARE_SETTINGS_PATH}
                onClick={(e) => followLink(e, FIRMWARE_SETTINGS_PATH)}
              >
                Turn it on in Settings → Devices
              </a>
            </p>
          </div>
        </div>
      ) : (
        <p className="ws-flush">
          <Chip tone="ready" icon="check" text="On" /> The Hub serves the iPXE menu to this device’s
          boot token.
        </p>
      )}
      <p className="muted ws-flush">
        Nova runs no DHCP or TFTP server. Give the iPXE address below to your DHCP server (its boot
        file name, with next-server pointing at the Hub), or embed it in an iPXE build.
      </p>
      <p className="ws-flush">
        {pxe.active
          ? `A boot token is active: made ${formatWhen(pxe.createdAt)}, last used ${formatWhen(pxe.lastUsedAt)}.`
          : 'This device has no boot token.'}
      </p>
      <div className="row">
        {pxe.active ? (
          <>
            <Button disabled={disabled || busy} onClick={() => setAsking('rotate')}>
              Make a new token…
            </Button>
            <Button
              variant="danger"
              disabled={disabled || busy}
              onClick={() => setAsking('revoke')}
            >
              Revoke…
            </Button>
          </>
        ) : (
          <Button disabled={disabled || busy} onClick={() => void create()}>
            {busy ? <Spinner /> : null} Make a boot token
          </Button>
        )}
      </div>
      {made ? (
        <div className="fw-once" role="region" aria-label="New boot token" aria-live="polite">
          <p>
            <Icon name="alert" /> <strong>Copy it now:</strong> it is shown only once, and the Hub
            keeps only a hash of it.
          </p>
          <p>
            Boot token: <code ref={tokenRef}>{made.token}</code>{' '}
            <Button
              variant="ghost"
              onClick={() => void copy(made.token, tokenRef.current, 'Boot token')}
            >
              <Icon name="copy" /> Copy
            </Button>
          </p>
          <p>
            iPXE address: <code ref={urlRef}>{made.scriptUrl}</code>{' '}
            <Button
              variant="ghost"
              onClick={() => void copy(made.scriptUrl, urlRef.current, 'iPXE address')}
            >
              <Icon name="copy" /> Copy
            </Button>
          </p>
          <div className="row">
            <Button onClick={() => setMade(null)}>Done</Button>
          </div>
        </div>
      ) : null}

      <h3>Images</h3>
      {images.error ? (
        <LoadError
          error={images.error}
          fallback="Could not list the boot images."
          onRetry={images.reload}
        />
      ) : null}
      {images.data ? (
        images.data.items.length ? (
          <ul className="ws-list" aria-label="Boot images">
            {images.data.items.map((i) => (
              <li key={i.name} className="ws-list-row">
                <span>
                  <code className="ws-code-inline">{i.name}</code>{' '}
                  <span className="muted">
                    {formatBytes(i.size)}, changed {formatWhen(i.modifiedAt)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ws-flush">
            No images yet. Put boot images (kernels, initrds, ISO files) in{' '}
            <code className="ws-code-inline">{images.data.folder}</code> on the Hub.
          </p>
        )
      ) : null}

      <ConfirmDialog
        open={asking === 'rotate'}
        title={`Make a new boot token for ${deviceName}?`}
        description="The current token stops working at once: anything set up with the old iPXE address needs the new one."
        confirmLabel="Make a new token"
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
          announce('New boot token made. Copy it now: it is shown only once.');
        }}
      />
      <ConfirmDialog
        open={asking === 'revoke'}
        title={`Revoke the boot token of ${deviceName}?`}
        description="Network boot with it stops at once. You can make a new one later."
        confirmLabel="Revoke"
        danger
        onClose={() => setAsking(null)}
        onConfirm={async () => {
          const t = await inPlainWords(api.revokePxeToken(deviceId));
          setAsking(null);
          setMade(null);
          onToken(t);
          toast.show('Boot token revoked.', { tone: 'success' });
        }}
      />
    </section>
  );
}
