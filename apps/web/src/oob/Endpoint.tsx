// One BMC (FR-147; docs/23 §7; ADR-096 D6): what it is and how the Hub reaches it (address, the
// Redfish system, the device it belongs to, whether credentials are stored, the pinned
// certificate), a loud warning when the BMC presented another certificate with how to re-pin, and
// its actions: power status, on, off, cycle and reset; the next boot device (once); the sensors;
// the allowlisted BIOS settings, a dry-run plan whose approval card shows the diff, then applying
// it as pending settings for the next restart (the same toggles as device firmware). Reads run at
// once; every change says what it will do, is confirmed here, then waits for its Hub-only approval
// card, shown inline. The action log lists everything asked of this BMC.
import { useEffect, useId, useRef, useState } from 'react';
import {
  OOB_BOOT_TARGETS,
  type OobAction,
  type OobActionView,
  type OobBiosKey,
  type OobBiosPlanView,
  type OobBootTarget,
  type OobEndpointView,
  type OobStatusView,
} from '@nova/shared';
import { Button, Icon, SelectField, Spinner, useToast } from '@nova/ui';
import { defineMessages, fmt } from '@nova/i18n';
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { followLink } from '../work/nav.tsx';
import { rich } from '../i18n/rich.tsx';
import { Chip, ConfirmDialog, LoadError, Unavailable } from '../devices/parts.tsx';
import { devicePath, listText } from '../devices/format.ts';
import type { OobApi, OobActionBody } from './api-m75.ts';
import { EndpointDialog, RepinDialog } from './EndpointForm.tsx';
import {
  ACTION_LABEL,
  BIOS_KEY_LABEL,
  BIOS_REFUSAL_TEXT,
  BOOT_TARGET_LABEL,
  HEALTH_TEXT,
  OOB_TEXT,
  POWER_ACTIONS,
  POWER_EFFECT,
  POWER_KEY,
  POWER_TEXT,
  SENSOR_KIND_LABEL,
  STATUS_CHIP,
  actionErrorText,
  actionSummary,
  addressText,
  biosReadOf,
  bootText,
  oobErrorMessage,
  openActions,
  pinMismatch,
  pinPairs,
  planOf,
  powerOf,
  sensorsOf,
  valueText,
  type OobPowerAction,
} from './format.ts';
import { InlineApproval } from './HubApproval.tsx';
import {
  KindChip,
  LastCheck,
  PinText,
  Section,
  actionBlocked,
  checkBlocked,
  plainly,
  useOobActions,
} from './parts.tsx';

export const ENDPOINT_TEXT = defineMessages('oob.endpoint', {
  /** Announced after a read: the action's name, then what came of it. */
  readDone: '{action}: {result}',
  waitsApproval: '{action} waits for your approval.',
  approveBelow: 'Approve it below to run it.',
  editOff: 'Turn out-of-band management on to edit',
  edit: 'Edit',
  remove: 'Remove',
  facts: {
    address: 'Address',
    system: 'System',
    device: 'Device',
    credentials: 'Credentials',
    certificate: 'Certificate',
    lastCheck: 'Last check',
  },
  onlySystem: 'Its only system',
  openDevice: 'Open the device',
  noDevice: 'Not linked to a device',
  credentialsStored: 'Stored in the Hub’s vault (never shown)',
  credentialsMissing: 'Missing: enter them again',
  /** `error`: the Hub's own words for the last failed check. */
  lastError: 'Last error: {error}',
  confirm: {
    question: 'Is this your BMC’s certificate?',
    read: 'The Hub read it without sending any credentials. Compare its fingerprint with the one on the BMC’s own web page or console, not one sent over this network:',
    after:
      'Only after you confirm it does the Hub send the BMC its user name and password, and only to a BMC presenting this certificate.',
    yes: 'Yes, it is my BMC’s…',
    enter: 'Enter the fingerprint instead…',
  },
  /** `pin`: the fingerprint, shown as code. */
  sha256: 'SHA-256 {pin}',
  mismatch: {
    /** The bold start of `said`, which continues the same sentence. */
    headline: 'This BMC presented a different certificate',
    /** `headline` is the bold start of this sentence; `when` is when the BMC presented it. */
    said: '{headline} than the one pinned ({when}). Nova sent it nothing, not even the credentials, and refuses it until you decide.',
    /** `pin`: the fingerprint, shown as code. */
    pinned: 'Pinned: {pin}',
    advice:
      'If you replaced the BMC’s certificate on purpose, read the new fingerprint on the BMC’s own page or console and pin it. Otherwise something else may be answering at this address: leave the pin as it is.',
    repin: 'Pin the new certificate…',
    unpin: 'Clear the pin…',
  },
  connection: 'Connection',
  checkRedfish:
    'Reads the BMC’s Redfish service. The first check reads its certificate, without credentials, for you to confirm.',
  checkIpmi: 'Reads the chassis status over IPMI.',
  waiting: 'Waiting for you',
  power: 'Power',
  /** `state` is shown bold; `when` is when it was read, in parentheses. */
  powerNow: 'Power: {state} {when}',
  powerUnread: 'Power state not read yet.',
  readPower: 'Read the power state',
  sensors: 'Sensors',
  notRead: 'Not read yet.',
  log: 'Action log',
  logFailed: 'Could not load the actions.',
  logLoading: 'Loading the actions',
  logEmpty: 'Nothing asked of this BMC yet.',
  saved: '{name} saved.',
  repinned: 'The new certificate is pinned.',
  powerAsk: {
    title: {
      on: 'Power on {name}?',
      off: 'Power off {name}?',
      cycle: 'Power cycle {name}?',
      reset: 'Reset {name}?',
    },
    confirm: {
      on: 'Ask to power on',
      off: 'Ask to power off',
      cycle: 'Ask to power cycle',
      reset: 'Ask to reset',
    },
  },
  ask: 'Ask',
  boot: {
    title: 'Set the next boot of {name}?',
    /** `boot`: "Hard disk once (UEFI)". */
    effect: 'It starts from {boot} at its next start, then boots as before. Nothing restarts now.',
    ipmi: 'Many BMCs drop an IPMI boot override if the machine does not restart within 60 seconds.',
    confirm: 'Ask to set the next boot',
    help: 'Start the machine once from another device, for example to reinstall it over the network. After that start it boots as before.',
    from: 'Boot from',
    /** A boot target IPMI cannot set: `target` is its name. */
    notIpmi: '{target} (not over IPMI)',
    mode: 'Boot mode',
    modeAsIs: 'As the BMC has it',
    uefi: 'UEFI',
    legacy: 'Legacy',
    set: 'Set the next boot…',
    /** In the waiting list: `boot` is "Hard disk once (UEFI)". */
    what: 'Next boot: {boot}',
  },
  apply: {
    title: 'Apply the BIOS change to {name}?',
    description:
      'The BMC stores these values as pending settings; they take effect at the next restart. Nothing restarts now.',
    descriptionDevice:
      'The BMC stores these values as pending settings; they take effect at the next restart of {device}. Nothing restarts now.',
    confirm: 'Apply at the next restart',
    applied: 'Applied.',
    open: 'Apply at the next restart…',
    approved: 'Approved. Apply it before it runs out.',
  },
  confirmPin: {
    title: 'Is this the certificate of {name}?',
    description:
      'Confirm only if this fingerprint is the one the BMC itself shows. From now on the Hub sends it the credentials, and refuses any other certificate at this address.',
    confirm: 'Confirm the fingerprint',
    done: 'Certificate confirmed. The Hub may now send the BMC its credentials.',
  },
  removeAsk: {
    title: 'Remove {name}?',
    description:
      'The Hub forgets this BMC and deletes its credentials from the vault. Approvals still waiting for it are withdrawn. The machine itself is not touched.',
    done: '{name} removed.',
  },
  unpin: {
    title: 'Clear the pinned certificate of {name}?',
    description:
      'The next check reads whatever certificate the BMC presents then, for you to confirm again; until then the Hub sends it no credentials. Do this only if you know its certificate changed.',
    confirm: 'Clear the pin',
    done: 'The pin is cleared. The next connection pins the certificate again.',
  },
  manages: 'This BMC manages {device}.',
  runsAfter: 'It runs only after you approve it on the card that appears next, within 10 minutes.',
  asked: 'Asked {when}',
  until: 'Until {time}',
  diff: {
    caption: 'BIOS change ({vendor}): pending until the next restart',
    setting: 'Setting',
    now: 'Now',
    after: 'After the restart',
    weakens: 'Weakens security',
    /** `items`: the settings left out, each "Secure Boot (why)", comma-joined. */
    leftOut: 'Left out: {items}.',
    /** One setting left out of a plan, and why. */
    leftOutItem: '{setting} ({reason})',
  },
  sensorTable: {
    caption: 'Read {when}',
    sensor: 'Sensor',
    kind: 'Kind',
    reading: 'Reading',
    health: 'Health',
    noReading: 'No reading',
    none: 'The BMC reported no sensors.',
  },
  bios: {
    title: 'BIOS settings',
    ipmi: 'BIOS settings are not available over IPMI. Add the BMC’s Redfish address to change them.',
    planned: 'The BIOS plan waits for your approval. Its diff is on the card.',
    planFailed: 'Could not make the plan.',
    help: 'Only the allowlisted settings: Wake-on-LAN, power on after power loss, boot order, virtualization, Secure Boot, the TPM and the fan profile. A change is a dry run first: you approve its diff, then it is stored as pending settings for the next restart.',
    /** `link`: a link to Settings → Devices (`settingsDevices`). */
    changesOff:
      'BIOS and firmware changes are off, as they are by default: reading works, plans are refused. Turn on “Allow BIOS/firmware changes” in {link} to change them, here and on devices running novad.',
    settingsDevices: 'Settings → Devices',
    /** `reason`: the Hub's words, or `unknownHardware`. */
    unsupported: 'BIOS settings are not supported on this hardware: {reason}.',
    unsupportedVendor: 'BIOS settings are not supported on this hardware ({vendor}): {reason}.',
    form: 'Plan a BIOS change',
    caption: 'BIOS settings, read {when}',
    captionVendor: '{vendor} settings, read {when}',
    setting: 'Setting',
    now: 'Now',
    pending: 'Pending',
    changeTo: 'Change to',
    none: 'none',
    changeSetting: 'Change {setting} to',
    keep: 'Keep',
    /** A value that would weaken security: `value` is the BMC's own value name. */
    weakensValue: '{value} (weakens security)',
    readOnly: 'Read-only',
    /** `settings`: the settings' names, joined ("Secure Boot and TPM"). */
    weakens:
      '{settings} would weaken the machine’s security. Such a change is refused unless you include it here and “Allow changes that weaken security” is on (it is).',
    weakensOff:
      '{settings} would weaken the machine’s security. Such a change is refused unless you include it here and “Allow changes that weaken security” is on (it is off).',
    include: 'Include the change that weakens security',
    plan: 'Plan the change',
    nothingYet: 'Nothing changes until you approve the plan and apply it.',
  },
  how: {
    read: 'A read: no approval needed',
    plan: 'From an approved plan',
    approval: 'With your approval',
  },
});

const S = ENDPOINT_TEXT;

const FIRMWARE_SETTINGS_PATH = '/settings/devices';

/** A change waiting for the owner's confirmation in a dialog. */
type Pending =
  | { kind: 'power'; action: OobPowerAction }
  | { kind: 'boot'; body: OobActionBody<'boot.next'> }
  | { kind: 'apply'; plan: OobBiosPlanView }
  | { kind: 'delete' }
  | { kind: 'unpin' }
  | { kind: 'confirmPin'; pin: string };

export interface EndpointViewProps {
  api: OobApi;
  endpoint: OobEndpointView;
  status: OobStatusView | null;
  onEndpoint: (ep: OobEndpointView) => void;
  onDeleted: () => void;
  /** The device it belongs to, by name, when known. */
  deviceName?: string | null;
  /** `?action=`: a power action whose confirmation opens once (it never runs by itself). */
  initialAction?: OobAction | null;
  /** h1 on its own page, h2 in a device's tab. */
  level?: 1 | 2;
}

export function EndpointView({
  api,
  endpoint: ep,
  status,
  onEndpoint,
  onDeleted,
  deviceName = null,
  initialAction = null,
  level = 1,
}: EndpointViewProps) {
  const toast = useToast();
  const announce = useAnnounce();
  const base = useId();
  const actions = useOobActions(api, ep.id);
  const items = actions.data ?? [];
  const blocked = actionBlocked(status, ep);
  const checkOff = checkBlocked(status, ep);
  const [pending, setPending] = useState<Pending | null>(null);
  const [editing, setEditing] = useState(false);
  const [repinning, setRepinning] = useState(false);
  const [busy, setBusy] = useState<OobAction | null>(null);
  const [errors, setErrors] = useState<Partial<Record<OobAction, string>>>({});
  const opened = useRef(false);

  // `?action=power.cycle` (the failed-boot alert): open that confirmation once.
  useEffect(() => {
    if (opened.current || !initialAction) return;
    if ((POWER_ACTIONS as readonly string[]).includes(initialAction)) {
      opened.current = true;
      setPending({ kind: 'power', action: initialAction as OobPowerAction });
    }
  }, [initialAction]);

  const remember = (a: OobActionView) =>
    actions.setData((prev) => [a, ...(prev ?? []).filter((x) => x.id !== a.id)]);

  /** A read: runs now; its result lands in the log. */
  const read = async (action: 'check' | 'power.status' | 'sensors' | 'bios.read') => {
    setBusy(action);
    setErrors((e) => ({ ...e, [action]: undefined }));
    try {
      const { action: a } = await api.oobAction(ep.id, action, {});
      remember(a);
      announce(
        S.readDone({
          action: ACTION_LABEL[action],
          result: actionSummary(a) ?? STATUS_CHIP[a.status].text,
        }),
      );
      if (action === 'check') onEndpoint(await api.getOobEndpoint(ep.id));
    } catch (err) {
      setErrors((e) => ({ ...e, [action]: oobErrorMessage(err, OOB_TEXT.failed) }));
      actions.reload();
      if (action === 'check') await api.getOobEndpoint(ep.id).then(onEndpoint, () => undefined);
    } finally {
      setBusy(null);
    }
  };

  /** A change: filed with its approval card, which appears below. */
  const ask = async <A extends OobAction>(action: A, body: OobActionBody<A>) => {
    const { action: a } = await plainly(() => api.oobAction(ep.id, action, body));
    remember(a);
    setPending(null);
    if (a.status === 'awaiting_approval') {
      announce(S.waitsApproval({ action: ACTION_LABEL[action] }));
      toast.show(S.approveBelow, { tone: 'success' });
    }
    return a;
  };

  const open = openActions(items);
  const mismatch = pinMismatch(ep, items);
  // A first check read the certificate: the owner compares and confirms it before anything else.
  const awaitingConfirm =
    !checkOff && ep.kind === 'redfish' && Boolean(ep.tlsPin) && !ep.tlsPinConfirmed && !mismatch;
  const power = items.find((a) => a.status === 'done' && powerOf(a) !== null);
  const sensors = items.find((a) => a.action === 'sensors' && a.status === 'done');
  const bios = items.find((a) => a.action === 'bios.read' && a.status === 'done');
  const H = level === 1 ? 'h1' : 'h2';
  const deviceHref = ep.deviceId ? devicePath(ep.deviceId) : null;

  return (
    <div className="stack oob-endpoint">
      <header className="ws-page-header">
        <div className="devices-title">
          <H dir="auto">{ep.name}</H>
          <KindChip kind={ep.kind} />
        </div>
        <div className="row">
          {ep.kind !== 'amt' ? (
            <Button
              onClick={() => setEditing(true)}
              disabled={status !== null && !status.enabled}
              title={status && !status.enabled ? S.editOff : undefined}
            >
              <Icon name="edit" /> {S.edit}
            </Button>
          ) : null}
          <Button variant="danger" onClick={() => setPending({ kind: 'delete' })}>
            <Icon name="trash" /> {S.remove}
          </Button>
        </div>
      </header>
      <dl className="devices-facts">
        <div>
          <dt>{S.facts.address}</dt>
          <dd>
            <code className="ws-code-inline" dir="ltr">
              {addressText(ep)}
            </code>
          </dd>
        </div>
        {ep.kind === 'redfish' ? (
          <div>
            <dt>{S.facts.system}</dt>
            <dd>{ep.systemId ? <span dir="ltr">{ep.systemId}</span> : S.onlySystem}</dd>
          </div>
        ) : null}
        <div>
          <dt>{S.facts.device}</dt>
          <dd>
            {deviceHref ? (
              <a href={deviceHref} dir="auto" onClick={(e) => followLink(e, deviceHref)}>
                {deviceName ?? S.openDevice}
              </a>
            ) : (
              <span className="muted">{S.noDevice}</span>
            )}
          </dd>
        </div>
        <div>
          <dt>{S.facts.credentials}</dt>
          <dd>
            {ep.hasCredentials ? (
              S.credentialsStored
            ) : (
              <Chip tone="needs_input" icon="alert" text={S.credentialsMissing} />
            )}
          </dd>
        </div>
        <div>
          <dt>{S.facts.certificate}</dt>
          <dd>
            <PinText ep={ep} />
          </dd>
        </div>
        <div>
          <dt>{S.facts.lastCheck}</dt>
          <dd>
            <LastCheck ep={ep} />
          </dd>
        </div>
      </dl>
      {ep.lastError && ep.lastCheckOk === false && !mismatch ? (
        <p className="muted ws-flush">{S.lastError({ error: ep.lastError })}</p>
      ) : null}
      {blocked && !awaitingConfirm ? <Unavailable>{blocked}</Unavailable> : null}

      {awaitingConfirm && ep.tlsPin ? (
        <div className="devices-note oob-confirm" role="status">
          <p className="ws-flush">
            <Icon name="shield" /> <strong>{S.confirm.question}</strong> {S.confirm.read}
          </p>
          <p className="ws-flush">
            {rich(S.sha256, {
              pin: (
                <code className="ws-code-inline oob-pin" dir="ltr">
                  {pinPairs(ep.tlsPin)}
                </code>
              ),
            })}
          </p>
          <p className="ws-flush">{S.confirm.after}</p>
          <div className="row">
            <Button
              variant="primary"
              disabled={Boolean(checkOff)}
              onClick={() => setPending({ kind: 'confirmPin', pin: ep.tlsPin! })}
            >
              {S.confirm.yes}
            </Button>
            <Button onClick={() => setRepinning(true)}>{S.confirm.enter}</Button>
          </div>
        </div>
      ) : null}

      {mismatch && ep.tlsPin ? (
        <div className="devices-note oob-mismatch" data-tone="bad" role="alert">
          <p className="ws-flush">
            <Icon name="alert" />{' '}
            {rich(S.mismatch.said, {
              headline: <strong>{S.mismatch.headline}</strong>,
              when: formatWhen(mismatch.createdAt),
            })}
          </p>
          <p className="ws-flush">
            {rich(S.mismatch.pinned, {
              pin: (
                <code className="ws-code-inline oob-pin" dir="ltr">
                  {pinPairs(ep.tlsPin)}
                </code>
              ),
            })}
          </p>
          <p className="ws-flush">{S.mismatch.advice}</p>
          <div className="row">
            <Button variant="primary" onClick={() => setRepinning(true)}>
              {S.mismatch.repin}
            </Button>
            <Button onClick={() => setPending({ kind: 'unpin' })}>{S.mismatch.unpin}</Button>
          </div>
        </div>
      ) : null}

      <Section
        id={`${base}-check`}
        title={S.connection}
        actions={
          <Button disabled={Boolean(checkOff) || busy !== null} onClick={() => void read('check')}>
            {busy === 'check' ? <Spinner /> : null} {ACTION_LABEL.check}
          </Button>
        }
      >
        <p className="muted ws-flush">{ep.kind === 'redfish' ? S.checkRedfish : S.checkIpmi}</p>

        <ActionError text={errors.check} />
      </Section>

      {open.length ? (
        <Section id={`${base}-open`} title={S.waiting}>
          <ul className="ws-list oob-open" aria-label={S.waiting}>
            {open.map((a) => (
              <li key={a.id} className="oob-open-item">
                <OpenAction
                  action={a}
                  deviceName={deviceName}
                  endpointName={ep.name}
                  blocked={blocked}
                  onApply={(plan) => setPending({ kind: 'apply', plan })}
                  onSettled={actions.reload}
                />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section id={`${base}-power`} title={S.power}>
        <p className="ws-flush" aria-live="polite">
          {power ? (
            rich(S.powerNow, {
              state: <strong>{POWER_TEXT[powerOf(power)!]}</strong>,
              when: (
                <span className="muted">({formatWhen(power.finishedAt ?? power.createdAt)})</span>
              ),
            })
          ) : (
            <span className="muted">{S.powerUnread}</span>
          )}
        </p>
        <div className="row">
          <Button
            disabled={Boolean(blocked) || busy !== null}
            onClick={() => void read('power.status')}
          >
            {busy === 'power.status' ? <Spinner /> : null} {S.readPower}
          </Button>
          {POWER_ACTIONS.map((a) => (
            <Button
              key={a}
              variant={a === 'power.on' ? 'default' : 'danger'}
              disabled={Boolean(blocked)}
              onClick={() => setPending({ kind: 'power', action: a })}
            >
              {ACTION_LABEL[a]}…
            </Button>
          ))}
        </div>
        <ActionError text={errors['power.status']} />
      </Section>

      <BootSection ep={ep} blocked={blocked} onAsk={(body) => setPending({ kind: 'boot', body })} />

      <Section
        id={`${base}-sensors`}
        title={S.sensors}
        actions={
          <Button disabled={Boolean(blocked) || busy !== null} onClick={() => void read('sensors')}>
            {busy === 'sensors' ? <Spinner /> : null} {ACTION_LABEL.sensors}
          </Button>
        }
      >
        <ActionError text={errors.sensors} />
        {sensors ? <SensorTable action={sensors} /> : <p className="muted ws-flush">{S.notRead}</p>}
      </Section>

      <BiosSection
        api={api}
        ep={ep}
        blocked={blocked}
        busy={busy === 'bios.read'}
        error={errors['bios.read']}
        read={bios ?? null}
        onRead={() => void read('bios.read')}
        onPlanned={remember}
      />

      <Section id={`${base}-log`} title={S.log}>
        {actions.error ? (
          <LoadError error={actions.error} fallback={S.logFailed} onRetry={actions.reload} />
        ) : null}
        {actions.loading ? <Spinner label={S.logLoading} /> : null}
        {actions.data?.length === 0 ? <p className="muted ws-flush">{S.logEmpty}</p> : null}
        {items.length ? <ActionLog items={items} /> : null}
      </Section>

      {editing ? (
        <EndpointDialog
          api={api}
          endpoint={ep}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            setEditing(false);
            onEndpoint(next);
            toast.show(S.saved({ name: next.name }), { tone: 'success' });
          }}
        />
      ) : null}
      {repinning ? (
        <RepinDialog
          api={api}
          endpoint={ep}
          onClose={() => setRepinning(false)}
          onSaved={(next) => {
            setRepinning(false);
            onEndpoint(next);
            toast.show(S.repinned, { tone: 'success' });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={pending?.kind === 'power'}
        title={
          pending?.kind === 'power'
            ? S.powerAsk.title[POWER_KEY[pending.action]]({ name: ep.name })
            : ''
        }
        description={
          pending?.kind === 'power' ? (
            <ChangeText deviceName={deviceName} effect={POWER_EFFECT[pending.action]} />
          ) : undefined
        }
        confirmLabel={
          pending?.kind === 'power' ? S.powerAsk.confirm[POWER_KEY[pending.action]] : S.ask
        }
        danger={pending?.kind === 'power' && pending.action !== 'power.on'}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind === 'power') await ask(pending.action, {});
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'boot'}
        title={S.boot.title({ name: ep.name })}
        description={
          pending?.kind === 'boot' ? (
            <ChangeText
              deviceName={deviceName}
              effect={[
                S.boot.effect({ boot: bootText(pending.body) }),
                ep.kind === 'ipmi' ? S.boot.ipmi : '',
              ]
                .filter(Boolean)
                .join(' ')}
            />
          ) : undefined
        }
        confirmLabel={S.boot.confirm}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind === 'boot') await ask('boot.next', pending.body);
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'apply'}
        title={S.apply.title({ name: ep.name })}
        description={
          deviceName ? S.apply.descriptionDevice({ device: deviceName }) : S.apply.description
        }
        confirmLabel={S.apply.confirm}
        danger
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== 'apply') return;
          try {
            const a = await ask('bios.apply', { planId: pending.plan.planId });
            toast.show(actionSummary(a) ?? S.apply.applied, { tone: 'success' });
          } finally {
            // A failed apply may end the plan (`apply_outcome_unknown`): show it as it is now.
            actions.reload();
          }
        }}
      >
        {pending?.kind === 'apply' ? <DiffTable plan={pending.plan} /> : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === 'confirmPin'}
        title={S.confirmPin.title({ name: ep.name })}
        description={S.confirmPin.description}
        confirmLabel={S.confirmPin.confirm}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== 'confirmPin') return;
          const next = await plainly(() => api.confirmOobPin(ep.id, pending.pin));
          setPending(null);
          onEndpoint(next);
          toast.show(S.confirmPin.done, { tone: 'success' });
        }}
      >
        {pending?.kind === 'confirmPin' ? (
          <p className="ws-flush">
            {rich(S.sha256, {
              pin: (
                <code className="ws-code-inline oob-pin" dir="ltr">
                  {pinPairs(pending.pin)}
                </code>
              ),
            })}
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === 'delete'}
        title={S.removeAsk.title({ name: ep.name })}
        description={S.removeAsk.description}
        confirmLabel={S.remove}
        danger
        onClose={() => setPending(null)}
        onConfirm={async () => {
          await plainly(() => api.deleteOobEndpoint(ep.id));
          setPending(null);
          toast.show(S.removeAsk.done({ name: ep.name }), { tone: 'success' });
          onDeleted();
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'unpin'}
        title={S.unpin.title({ name: ep.name })}
        description={S.unpin.description}
        confirmLabel={S.unpin.confirm}
        danger
        onClose={() => setPending(null)}
        onConfirm={async () => {
          const next = await plainly(() => api.updateOobEndpoint(ep.id, { tlsPin: null }));
          setPending(null);
          onEndpoint(next);
          toast.show(S.unpin.done, { tone: 'success' });
        }}
      />
    </div>
  );
}

function ActionError({ text }: { text: string | undefined }) {
  return text ? (
    <p role="alert" className="nv-field-error">
      {text}
    </p>
  ) : null;
}

/** What a change does, on which machine, and that it still needs its approval. */
function ChangeText({ deviceName, effect }: { deviceName: string | null; effect: string }) {
  return (
    <>
      {[effect, deviceName ? S.manages({ device: deviceName }) : '', S.runsAfter]
        .filter(Boolean)
        .join(' ')}
    </>
  );
}

/** A waiting approval card or an approved plan, with what it covers. */
function OpenAction({
  action: a,
  endpointName,
  deviceName,
  blocked,
  onApply,
  onSettled,
}: {
  action: OobActionView;
  endpointName: string;
  deviceName: string | null;
  blocked: string | null;
  onApply: (plan: OobBiosPlanView) => void;
  onSettled: () => void;
}) {
  const plan = planOf(a);
  const what =
    a.action === 'boot.next' ? S.boot.what({ boot: bootText(a.params) }) : ACTION_LABEL[a.action];
  return (
    <div className="stack">
      <div className="devices-row-head">
        <strong>{what}</strong>
        <OobStatusChip status={a.status} />
      </div>
      <span className="muted ws-row-meta">
        <span dir="auto">
          {endpointName}
          {deviceName ? ` (${deviceName})` : ''}
        </span>
        <span>{S.asked({ when: formatWhen(a.createdAt) })}</span>
        {a.expiresAt ? (
          <span>{S.until({ time: fmt.time(a.expiresAt, { timeStyle: 'medium' }) })}</span>
        ) : null}
      </span>
      {plan ? <DiffTable plan={plan} /> : null}
      {a.status === 'awaiting_approval' && a.approvalId ? (
        <InlineApproval approvalId={a.approvalId} onSettled={onSettled} />
      ) : null}
      {a.status === 'approved' && plan ? (
        <div className="row">
          <Button variant="primary" disabled={Boolean(blocked)} onClick={() => onApply(plan)}>
            {S.apply.open}
          </Button>
          <span className="muted">{S.apply.approved}</span>
        </div>
      ) : null}
    </div>
  );
}

export function OobStatusChip({ status }: { status: OobActionView['status'] }) {
  const s = STATUS_CHIP[status];
  return <Chip tone={s.tone} icon={s.icon} text={s.text} />;
}

/** A plan's diff (current → planned), security-degrading rows marked, then what was left out. */
export function DiffTable({ plan }: { plan: OobBiosPlanView }) {
  return (
    <div className="stack">
      <table className="ws-table oob-diff">
        <caption>{S.diff.caption({ vendor: plan.vendor })}</caption>
        <thead>
          <tr>
            <th scope="col">{S.diff.setting}</th>
            <th scope="col">{S.diff.now}</th>
            <th scope="col">{S.diff.after}</th>
          </tr>
        </thead>
        <tbody>
          {plan.diff.map((d) => (
            <tr key={d.key} data-degrading={d.securityDegrading || undefined}>
              <th scope="row">{BIOS_KEY_LABEL[d.key]}</th>
              <td dir="auto">{valueText(d.from)}</td>
              <td>
                <span dir="auto">{d.to}</span>
                {d.securityDegrading ? (
                  <span className="oob-degrading">
                    {' '}
                    <Icon name="alert" /> {S.diff.weakens}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {plan.refused.length ? (
        <p className="muted ws-flush">
          {S.diff.leftOut({
            items: listText(
              plan.refused.map((r) =>
                S.diff.leftOutItem({
                  setting: BIOS_KEY_LABEL[r.key],
                  reason: BIOS_REFUSAL_TEXT[r.reason],
                }),
              ),
            ),
          })}
        </p>
      ) : null}
    </div>
  );
}

function BootSection({
  ep,
  blocked,
  onAsk,
}: {
  ep: OobEndpointView;
  blocked: string | null;
  onAsk: (body: OobActionBody<'boot.next'>) => void;
}) {
  const base = useId();
  const [target, setTarget] = useState<OobBootTarget>('pxe');
  const [mode, setMode] = useState<'' | 'uefi' | 'legacy'>('');
  const usbOff = ep.kind === 'ipmi';
  return (
    <Section id={`${base}-boot`} title={ACTION_LABEL['boot.next']}>
      <p className="muted ws-flush">{S.boot.help}</p>
      <div className="devices-fields">
        <SelectField
          label={S.boot.from}
          value={target}
          disabled={Boolean(blocked)}
          onChange={(v) => setTarget(v as OobBootTarget)}
          options={OOB_BOOT_TARGETS.map((t) => ({
            value: t,
            label:
              t === 'usb' && usbOff
                ? S.boot.notIpmi({ target: BOOT_TARGET_LABEL[t] })
                : BOOT_TARGET_LABEL[t],
            disabled: t === 'usb' && usbOff,
          }))}
        />
        <SelectField
          label={S.boot.mode}
          value={mode}
          disabled={Boolean(blocked)}
          onChange={(v) => setMode(v as '' | 'uefi' | 'legacy')}
          options={[
            { value: '', label: S.boot.modeAsIs },
            { value: 'uefi', label: S.boot.uefi },
            { value: 'legacy', label: S.boot.legacy },
          ]}
        />
      </div>
      <div className="row">
        <Button
          disabled={Boolean(blocked)}
          onClick={() => onAsk({ target, ...(mode ? { mode } : {}) })}
        >
          {S.boot.set}
        </Button>
      </div>
    </Section>
  );
}

/** A sensor reading and its unit (the BMC's own unit name, e.g. "RPM"). */
function readingText(s: { reading: number | null; unit: string | null }): string {
  if (s.reading === null) return S.sensorTable.noReading;
  const value = fmt.number(s.reading, { useGrouping: false, maximumFractionDigits: 3 });
  return s.unit ? `${value} ${s.unit}` : value;
}

function SensorTable({ action }: { action: OobActionView }) {
  const list = sensorsOf(action);
  if (!list.length) return <p className="muted ws-flush">{S.sensorTable.none}</p>;
  return (
    <table className="ws-table oob-sensors">
      <caption>
        {S.sensorTable.caption({ when: formatWhen(action.finishedAt ?? action.createdAt) })}
      </caption>
      <thead>
        <tr>
          <th scope="col">{S.sensorTable.sensor}</th>
          <th scope="col">{S.sensorTable.kind}</th>
          <th scope="col">{S.sensorTable.reading}</th>
          <th scope="col">{S.sensorTable.health}</th>
        </tr>
      </thead>
      <tbody>
        {list.map((s, i) => (
          <tr key={`${s.name}-${i}`} data-health={s.health}>
            <th scope="row" dir="auto">
              {s.name}
            </th>
            <td>{SENSOR_KIND_LABEL[s.kind]}</td>
            <td>{readingText(s)}</td>
            <td>
              {s.health === 'warning' || s.health === 'critical' ? <Icon name="alert" /> : null}{' '}
              {HEALTH_TEXT[s.health]}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BiosSection({
  api,
  ep,
  blocked,
  busy,
  error,
  read,
  onRead,
  onPlanned,
}: {
  api: OobApi;
  ep: OobEndpointView;
  blocked: string | null;
  busy: boolean;
  error: string | undefined;
  read: OobActionView | null;
  onRead: () => void;
  onPlanned: (a: OobActionView) => void;
}) {
  const base = useId();
  const settings = useSettings();
  const announce = useAnnounce();
  const allowChanges = settings.get('devices.firmware.allowChanges').value === true;
  const allowDegrading = settings.get('devices.firmware.allowSecurityDegrading').value === true;
  const view = read ? biosReadOf(read) : null;
  const [choices, setChoices] = useState<Partial<Record<OobBiosKey, string>>>({});
  const [degrading, setDegrading] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);

  if (ep.kind !== 'redfish')
    return (
      <Section id={`${base}-bios`} title={S.bios.title}>
        <Unavailable>{S.bios.ipmi}</Unavailable>
      </Section>
    );

  const changes = Object.entries(choices)
    .filter(([, v]) => v)
    .map(([key, value]) => ({ key: key as OobBiosKey, value: value ?? '' }));
  const weakening = (view?.settings ?? []).filter(
    (s) => choices[s.key] && s.securityDegrading.includes(choices[s.key]!),
  );

  const plan = async () => {
    setPlanning(true);
    setPlanError(null);
    try {
      const { action } = await api.oobAction(ep.id, 'bios.plan', {
        changes,
        ...(degrading && weakening.length ? { allowSecurityDegrading: true } : {}),
      });
      onPlanned(action);
      setChoices({});
      setDegrading(false);
      announce(S.bios.planned);
    } catch (err) {
      setPlanError(oobErrorMessage(err, S.bios.planFailed));
    } finally {
      setPlanning(false);
    }
  };

  const weakens = fmt.list(weakening.map((s) => BIOS_KEY_LABEL[s.key]));
  return (
    <Section
      id={`${base}-bios`}
      title={S.bios.title}
      actions={
        <Button disabled={Boolean(blocked) || busy} onClick={onRead}>
          {busy ? <Spinner /> : null} {ACTION_LABEL['bios.read']}
        </Button>
      }
    >
      <p className="muted ws-flush">{S.bios.help}</p>
      {!allowChanges ? (
        <div className="devices-note" role="status">
          <p className="ws-flush">
            <Icon name="shield" />{' '}
            {rich(S.bios.changesOff, {
              link: (
                <a
                  href={FIRMWARE_SETTINGS_PATH}
                  onClick={(e) => followLink(e, FIRMWARE_SETTINGS_PATH)}
                >
                  {S.bios.settingsDevices}
                </a>
              ),
            })}
          </p>
        </div>
      ) : null}
      <ActionError text={error} />
      {view && !view.supported ? (
        <Unavailable>
          {view.vendor
            ? S.bios.unsupportedVendor({
                vendor: view.vendor,
                reason: view.reason ?? OOB_TEXT.unknownHardware,
              })
            : S.bios.unsupported({ reason: view.reason ?? OOB_TEXT.unknownHardware })}
        </Unavailable>
      ) : null}
      {view?.supported ? (
        <form
          className="stack"
          aria-label={S.bios.form}
          onSubmit={(e) => {
            e.preventDefault();
            void plan();
          }}
        >
          <table className="ws-table oob-bios">
            <caption>
              {view.vendor
                ? S.bios.captionVendor({
                    vendor: view.vendor,
                    when: formatWhen(read?.finishedAt ?? null),
                  })
                : S.bios.caption({ when: formatWhen(read?.finishedAt ?? null) })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{S.bios.setting}</th>
                <th scope="col">{S.bios.now}</th>
                <th scope="col">{S.bios.pending}</th>
                <th scope="col">{S.bios.changeTo}</th>
              </tr>
            </thead>
            <tbody>
              {view.settings.map((s) => {
                const chosen = choices[s.key] ?? '';
                return (
                  <tr key={s.key}>
                    <th scope="row">{BIOS_KEY_LABEL[s.key]}</th>
                    <td dir="auto">{valueText(s.value)}</td>
                    <td dir="auto">
                      {s.pending ? s.pending : <span className="muted">{S.bios.none}</span>}
                    </td>
                    <td>
                      {s.allowed.length ? (
                        <SelectField
                          label={S.bios.changeSetting({ setting: BIOS_KEY_LABEL[s.key] })}
                          hideLabel
                          value={chosen}
                          disabled={!allowChanges || Boolean(blocked)}
                          onChange={(v) => setChoices((c) => ({ ...c, [s.key]: v }))}
                          options={[
                            { value: '', label: S.bios.keep },
                            ...s.allowed.map((v) => ({
                              value: v,
                              label: s.securityDegrading.includes(v)
                                ? S.bios.weakensValue({ value: v })
                                : v,
                            })),
                          ]}
                        />
                      ) : (
                        <span className="muted">{S.bios.readOnly}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {weakening.length ? (
            <div className="devices-note" data-tone="bad">
              <p className="ws-flush">
                <Icon name="alert" />{' '}
                {allowDegrading
                  ? S.bios.weakens({ settings: weakens })
                  : S.bios.weakensOff({ settings: weakens })}
              </p>
              <label className="nv-radio">
                <input
                  type="checkbox"
                  checked={degrading}
                  onChange={(e) => setDegrading(e.target.checked)}
                />
                <span className="nv-radio-text">
                  <span>{S.bios.include}</span>
                </span>
              </label>
            </div>
          ) : null}
          {planError ? (
            <p role="alert" className="nv-field-error">
              {planError}
            </p>
          ) : null}
          <div className="row">
            <Button
              type="submit"
              variant="primary"
              disabled={!allowChanges || Boolean(blocked) || planning || changes.length === 0}
            >
              {planning ? <Spinner /> : null} {S.bios.plan}
            </Button>
            <span className="muted">{S.bios.nothingYet}</span>
          </div>
        </form>
      ) : null}
      {!view && !error ? <p className="muted ws-flush">{S.notRead}</p> : null}
    </Section>
  );
}

const READS: readonly OobAction[] = ['check', 'power.status', 'sensors', 'bios.read'];

function howAsked(a: OobActionView): string {
  if (READS.includes(a.action)) return S.how.read;
  if (a.action === 'bios.apply') return S.how.plan;
  return S.how.approval;
}

function ActionLog({ items }: { items: OobActionView[] }) {
  return (
    <ul className="ws-list" aria-label={S.log}>
      {items.map((a) => {
        const summary = actionSummary(a);
        return (
          <li key={a.id} className="ws-list-row devices-row" aria-label={ACTION_LABEL[a.action]}>
            <div className="devices-row-main">
              <div className="devices-row-head">
                <strong>{ACTION_LABEL[a.action]}</strong>
                <OobStatusChip status={a.status} />
              </div>
              <span className="muted ws-row-meta">
                <span>{formatWhen(a.createdAt)}</span>
                <span>{howAsked(a)}</span>
              </span>
              {summary ? <span className="ws-row-meta">{summary}</span> : null}
              {a.error ? <span className="ws-warning">{actionErrorText(a.error)}</span> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
