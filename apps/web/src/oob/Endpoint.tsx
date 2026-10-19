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
import { useAnnounce } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { followLink } from '../work/nav.tsx';
import { Chip, ConfirmDialog, LoadError, Unavailable } from '../devices/parts.tsx';
import { devicePath } from '../devices/format.ts';
import type { OobApi, OobActionBody } from './api-m75.ts';
import { EndpointDialog, RepinDialog } from './EndpointForm.tsx';
import {
  ACTION_LABEL,
  BIOS_KEY_LABEL,
  BIOS_REFUSAL_TEXT,
  BOOT_TARGET_LABEL,
  HEALTH_TEXT,
  POWER_ACTIONS,
  POWER_EFFECT,
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
      announce(`${ACTION_LABEL[action]}: ${actionSummary(a) ?? STATUS_CHIP[a.status].text}`);
      if (action === 'check') onEndpoint(await api.getOobEndpoint(ep.id));
    } catch (err) {
      setErrors((e) => ({ ...e, [action]: oobErrorMessage(err, 'That did not work.') }));
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
      announce(`${ACTION_LABEL[action]} waits for your approval.`);
      toast.show('Approve it below to run it.', { tone: 'success' });
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
          <H>{ep.name}</H>
          <KindChip kind={ep.kind} />
        </div>
        <div className="row">
          {ep.kind !== 'amt' ? (
            <Button
              onClick={() => setEditing(true)}
              disabled={status !== null && !status.enabled}
              title={
                status && !status.enabled ? 'Turn out-of-band management on to edit' : undefined
              }
            >
              <Icon name="edit" /> Edit
            </Button>
          ) : null}
          <Button variant="danger" onClick={() => setPending({ kind: 'delete' })}>
            <Icon name="trash" /> Remove
          </Button>
        </div>
      </header>
      <dl className="devices-facts">
        <div>
          <dt>Address</dt>
          <dd>
            <code className="ws-code-inline">{addressText(ep)}</code>
          </dd>
        </div>
        {ep.kind === 'redfish' ? (
          <div>
            <dt>System</dt>
            <dd>{ep.systemId ?? 'Its only system'}</dd>
          </div>
        ) : null}
        <div>
          <dt>Device</dt>
          <dd>
            {deviceHref ? (
              <a href={deviceHref} onClick={(e) => followLink(e, deviceHref)}>
                {deviceName ?? 'Open the device'}
              </a>
            ) : (
              <span className="muted">Not linked to a device</span>
            )}
          </dd>
        </div>
        <div>
          <dt>Credentials</dt>
          <dd>
            {ep.hasCredentials ? (
              'Stored in the Hub’s vault (never shown)'
            ) : (
              <Chip tone="needs_input" icon="alert" text="Missing: enter them again" />
            )}
          </dd>
        </div>
        <div>
          <dt>Certificate</dt>
          <dd>
            <PinText ep={ep} />
          </dd>
        </div>
        <div>
          <dt>Last check</dt>
          <dd>
            <LastCheck ep={ep} />
          </dd>
        </div>
      </dl>
      {ep.lastError && ep.lastCheckOk === false && !mismatch ? (
        <p className="muted ws-flush">Last error: {ep.lastError}</p>
      ) : null}
      {blocked && !awaitingConfirm ? <Unavailable>{blocked}</Unavailable> : null}

      {awaitingConfirm && ep.tlsPin ? (
        <div className="devices-note oob-confirm" role="status">
          <p className="ws-flush">
            <Icon name="shield" /> <strong>Is this your BMC’s certificate?</strong> The Hub read it
            without sending any credentials. Compare its fingerprint with the one on the BMC’s own
            web page or console, not one sent over this network:
          </p>
          <p className="ws-flush">
            SHA-256 <code className="ws-code-inline oob-pin">{pinPairs(ep.tlsPin)}</code>
          </p>
          <p className="ws-flush">
            Only after you confirm it does the Hub send the BMC its user name and password, and only
            to a BMC presenting this certificate.
          </p>
          <div className="row">
            <Button
              variant="primary"
              disabled={Boolean(checkOff)}
              onClick={() => setPending({ kind: 'confirmPin', pin: ep.tlsPin! })}
            >
              Yes, it is my BMC’s…
            </Button>
            <Button onClick={() => setRepinning(true)}>Enter the fingerprint instead…</Button>
          </div>
        </div>
      ) : null}

      {mismatch && ep.tlsPin ? (
        <div className="devices-note oob-mismatch" data-tone="bad" role="alert">
          <p className="ws-flush">
            <Icon name="alert" /> <strong>This BMC presented a different certificate</strong> than
            the one pinned ({formatWhen(mismatch.createdAt)}). Nova sent it nothing, not even the
            credentials, and refuses it until you decide.
          </p>
          <p className="ws-flush">
            Pinned: <code className="ws-code-inline oob-pin">{pinPairs(ep.tlsPin)}</code>
          </p>
          <p className="ws-flush">
            If you replaced the BMC’s certificate on purpose, read the new fingerprint on the BMC’s
            own page or console and pin it. Otherwise something else may be answering at this
            address: leave the pin as it is.
          </p>
          <div className="row">
            <Button variant="primary" onClick={() => setRepinning(true)}>
              Pin the new certificate…
            </Button>
            <Button onClick={() => setPending({ kind: 'unpin' })}>Clear the pin…</Button>
          </div>
        </div>
      ) : null}

      <Section
        id={`${base}-check`}
        title="Connection"
        actions={
          <Button disabled={Boolean(checkOff) || busy !== null} onClick={() => void read('check')}>
            {busy === 'check' ? <Spinner /> : null} Check the connection
          </Button>
        }
      >
        <p className="muted ws-flush">
          {ep.kind === 'redfish'
            ? 'Reads the BMC’s Redfish service. The first check reads its certificate, without credentials, for you to confirm.'
            : 'Reads the chassis status over IPMI.'}
        </p>

        <ActionError text={errors.check} />
      </Section>

      {open.length ? (
        <Section id={`${base}-open`} title="Waiting for you">
          <ul className="ws-list oob-open" aria-label="Waiting for you">
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

      <Section id={`${base}-power`} title="Power">
        <p className="ws-flush" aria-live="polite">
          {power ? (
            <>
              Power: <strong>{POWER_TEXT[powerOf(power)!]}</strong>{' '}
              <span className="muted">({formatWhen(power.finishedAt ?? power.createdAt)})</span>
            </>
          ) : (
            <span className="muted">Power state not read yet.</span>
          )}
        </p>
        <div className="row">
          <Button
            disabled={Boolean(blocked) || busy !== null}
            onClick={() => void read('power.status')}
          >
            {busy === 'power.status' ? <Spinner /> : null} Read the power state
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
        title="Sensors"
        actions={
          <Button disabled={Boolean(blocked) || busy !== null} onClick={() => void read('sensors')}>
            {busy === 'sensors' ? <Spinner /> : null} Read the sensors
          </Button>
        }
      >
        <ActionError text={errors.sensors} />
        {sensors ? (
          <SensorTable action={sensors} />
        ) : (
          <p className="muted ws-flush">Not read yet.</p>
        )}
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

      <Section id={`${base}-log`} title="Action log">
        {actions.error ? (
          <LoadError
            error={actions.error}
            fallback="Could not load the actions."
            onRetry={actions.reload}
          />
        ) : null}
        {actions.loading ? <Spinner label="Loading the actions" /> : null}
        {actions.data?.length === 0 ? (
          <p className="muted ws-flush">Nothing asked of this BMC yet.</p>
        ) : null}
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
            toast.show(`${next.name} saved.`, { tone: 'success' });
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
            toast.show('The new certificate is pinned.', { tone: 'success' });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={pending?.kind === 'power'}
        title={pending?.kind === 'power' ? `${ACTION_LABEL[pending.action]} ${ep.name}?` : ''}
        description={
          pending?.kind === 'power' ? (
            <ChangeText deviceName={deviceName} effect={POWER_EFFECT[pending.action]} />
          ) : undefined
        }
        confirmLabel={
          pending?.kind === 'power' ? `Ask to ${ACTION_LABEL[pending.action].toLowerCase()}` : 'Ask'
        }
        danger={pending?.kind === 'power' && pending.action !== 'power.on'}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind === 'power') await ask(pending.action, {});
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'boot'}
        title={`Set the next boot of ${ep.name}?`}
        description={
          pending?.kind === 'boot' ? (
            <ChangeText
              deviceName={deviceName}
              effect={`It starts from ${bootText(pending.body)} at its next start, then boots as before. Nothing restarts now.${
                ep.kind === 'ipmi'
                  ? ' Many BMCs drop an IPMI boot override if the machine does not restart within 60 seconds.'
                  : ''
              }`}
            />
          ) : undefined
        }
        confirmLabel="Ask to set the next boot"
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind === 'boot') await ask('boot.next', pending.body);
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'apply'}
        title={`Apply the BIOS change to ${ep.name}?`}
        description={`The BMC stores these values as pending settings; they take effect at the next restart${
          deviceName ? ` of ${deviceName}` : ''
        }. Nothing restarts now.`}
        confirmLabel="Apply at the next restart"
        danger
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== 'apply') return;
          try {
            const a = await ask('bios.apply', { planId: pending.plan.planId });
            toast.show(actionSummary(a) ?? 'Applied.', { tone: 'success' });
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
        title={`Is this the certificate of ${ep.name}?`}
        description="Confirm only if this fingerprint is the one the BMC itself shows. From now on the Hub sends it the credentials, and refuses any other certificate at this address."
        confirmLabel="Confirm the fingerprint"
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending?.kind !== 'confirmPin') return;
          const next = await plainly(() => api.confirmOobPin(ep.id, pending.pin));
          setPending(null);
          onEndpoint(next);
          toast.show('Certificate confirmed. The Hub may now send the BMC its credentials.', {
            tone: 'success',
          });
        }}
      >
        {pending?.kind === 'confirmPin' ? (
          <p className="ws-flush">
            SHA-256 <code className="ws-code-inline oob-pin">{pinPairs(pending.pin)}</code>
          </p>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={pending?.kind === 'delete'}
        title={`Remove ${ep.name}?`}
        description="The Hub forgets this BMC and deletes its credentials from the vault. Approvals still waiting for it are withdrawn. The machine itself is not touched."
        confirmLabel="Remove"
        danger
        onClose={() => setPending(null)}
        onConfirm={async () => {
          await plainly(() => api.deleteOobEndpoint(ep.id));
          setPending(null);
          toast.show(`${ep.name} removed.`, { tone: 'success' });
          onDeleted();
        }}
      />
      <ConfirmDialog
        open={pending?.kind === 'unpin'}
        title={`Clear the pinned certificate of ${ep.name}?`}
        description="The next check reads whatever certificate the BMC presents then, for you to confirm again; until then the Hub sends it no credentials. Do this only if you know its certificate changed."
        confirmLabel="Clear the pin"
        danger
        onClose={() => setPending(null)}
        onConfirm={async () => {
          const next = await plainly(() => api.updateOobEndpoint(ep.id, { tlsPin: null }));
          setPending(null);
          onEndpoint(next);
          toast.show('The pin is cleared. The next connection pins the certificate again.', {
            tone: 'success',
          });
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
      {effect} {deviceName ? `This BMC manages ${deviceName}. ` : ''}It runs only after you approve
      it on the card that appears next, within 10 minutes.
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
    a.action === 'boot.next'
      ? `${ACTION_LABEL[a.action]}: ${bootText(a.params)}`
      : ACTION_LABEL[a.action];
  return (
    <div className="stack">
      <div className="devices-row-head">
        <strong>{what}</strong>
        <OobStatusChip status={a.status} />
      </div>
      <span className="muted ws-row-meta">
        <span>
          {endpointName}
          {deviceName ? ` (${deviceName})` : ''}
        </span>
        <span>Asked {formatWhen(a.createdAt)}</span>
        {a.expiresAt ? <span>Until {new Date(a.expiresAt).toLocaleTimeString()}</span> : null}
      </span>
      {plan ? <DiffTable plan={plan} /> : null}
      {a.status === 'awaiting_approval' && a.approvalId ? (
        <InlineApproval approvalId={a.approvalId} onSettled={onSettled} />
      ) : null}
      {a.status === 'approved' && plan ? (
        <div className="row">
          <Button variant="primary" disabled={Boolean(blocked)} onClick={() => onApply(plan)}>
            Apply at the next restart…
          </Button>
          <span className="muted">Approved. Apply it before it runs out.</span>
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
        <caption>BIOS change ({plan.vendor}): pending until the next restart</caption>
        <thead>
          <tr>
            <th scope="col">Setting</th>
            <th scope="col">Now</th>
            <th scope="col">After the restart</th>
          </tr>
        </thead>
        <tbody>
          {plan.diff.map((d) => (
            <tr key={d.key} data-degrading={d.securityDegrading || undefined}>
              <th scope="row">{BIOS_KEY_LABEL[d.key]}</th>
              <td>{valueText(d.from)}</td>
              <td>
                {d.to}
                {d.securityDegrading ? (
                  <span className="oob-degrading">
                    {' '}
                    <Icon name="alert" /> Weakens security
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {plan.refused.length ? (
        <p className="muted ws-flush">
          Left out:{' '}
          {plan.refused
            .map((r) => `${BIOS_KEY_LABEL[r.key]} (${BIOS_REFUSAL_TEXT[r.reason]})`)
            .join(', ')}
          .
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
    <Section id={`${base}-boot`} title="Next boot">
      <p className="muted ws-flush">
        Start the machine once from another device, for example to reinstall it over the network.
        After that start it boots as before.
      </p>
      <div className="devices-fields">
        <SelectField
          label="Boot from"
          value={target}
          disabled={Boolean(blocked)}
          onChange={(v) => setTarget(v as OobBootTarget)}
          options={OOB_BOOT_TARGETS.map((t) => ({
            value: t,
            label:
              t === 'usb' && usbOff
                ? `${BOOT_TARGET_LABEL[t]} (not over IPMI)`
                : BOOT_TARGET_LABEL[t],
            disabled: t === 'usb' && usbOff,
          }))}
        />
        <SelectField
          label="Boot mode"
          value={mode}
          disabled={Boolean(blocked)}
          onChange={(v) => setMode(v as '' | 'uefi' | 'legacy')}
          options={[
            { value: '', label: 'As the BMC has it' },
            { value: 'uefi', label: 'UEFI' },
            { value: 'legacy', label: 'Legacy' },
          ]}
        />
      </div>
      <div className="row">
        <Button
          disabled={Boolean(blocked)}
          onClick={() => onAsk({ target, ...(mode ? { mode } : {}) })}
        >
          Set the next boot…
        </Button>
      </div>
    </Section>
  );
}

function SensorTable({ action }: { action: OobActionView }) {
  const list = sensorsOf(action);
  if (!list.length) return <p className="muted ws-flush">The BMC reported no sensors.</p>;
  return (
    <table className="ws-table oob-sensors">
      <caption>Read {formatWhen(action.finishedAt ?? action.createdAt)}</caption>
      <thead>
        <tr>
          <th scope="col">Sensor</th>
          <th scope="col">Kind</th>
          <th scope="col">Reading</th>
          <th scope="col">Health</th>
        </tr>
      </thead>
      <tbody>
        {list.map((s, i) => (
          <tr key={`${s.name}-${i}`} data-health={s.health}>
            <th scope="row">{s.name}</th>
            <td>{SENSOR_KIND_LABEL[s.kind]}</td>
            <td>
              {s.reading === null ? 'No reading' : `${s.reading}${s.unit ? ` ${s.unit}` : ''}`}
            </td>
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
      <Section id={`${base}-bios`} title="BIOS settings">
        <Unavailable>
          BIOS settings are not available over IPMI. Add the BMC’s Redfish address to change them.
        </Unavailable>
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
      announce('The BIOS plan waits for your approval. Its diff is on the card.');
    } catch (err) {
      setPlanError(oobErrorMessage(err, 'Could not make the plan.'));
    } finally {
      setPlanning(false);
    }
  };

  return (
    <Section
      id={`${base}-bios`}
      title="BIOS settings"
      actions={
        <Button disabled={Boolean(blocked) || busy} onClick={onRead}>
          {busy ? <Spinner /> : null} Read the BIOS settings
        </Button>
      }
    >
      <p className="muted ws-flush">
        Only the allowlisted settings: Wake-on-LAN, power on after power loss, boot order,
        virtualization, Secure Boot, the TPM and the fan profile. A change is a dry run first: you
        approve its diff, then it is stored as pending settings for the next restart.
      </p>
      {!allowChanges ? (
        <div className="devices-note" role="status">
          <p className="ws-flush">
            <Icon name="shield" /> BIOS and firmware changes are off, as they are by default:
            reading works, plans are refused. Turn on “Allow BIOS/firmware changes” in{' '}
            <a href={FIRMWARE_SETTINGS_PATH} onClick={(e) => followLink(e, FIRMWARE_SETTINGS_PATH)}>
              Settings → Devices
            </a>{' '}
            to change them, here and on devices running novad.
          </p>
        </div>
      ) : null}
      <ActionError text={error} />
      {view && !view.supported ? (
        <Unavailable>
          BIOS settings are not supported on this hardware{view.vendor ? ` (${view.vendor})` : ''}:{' '}
          {view.reason ?? 'unknown hardware'}.
        </Unavailable>
      ) : null}
      {view?.supported ? (
        <form
          className="stack"
          aria-label="Plan a BIOS change"
          onSubmit={(e) => {
            e.preventDefault();
            void plan();
          }}
        >
          <table className="ws-table oob-bios">
            <caption>
              {view.vendor ?? 'BIOS'} settings, read {formatWhen(read?.finishedAt ?? null)}
            </caption>
            <thead>
              <tr>
                <th scope="col">Setting</th>
                <th scope="col">Now</th>
                <th scope="col">Pending</th>
                <th scope="col">Change to</th>
              </tr>
            </thead>
            <tbody>
              {view.settings.map((s) => {
                const chosen = choices[s.key] ?? '';
                return (
                  <tr key={s.key}>
                    <th scope="row">{BIOS_KEY_LABEL[s.key]}</th>
                    <td>{valueText(s.value)}</td>
                    <td>{s.pending ? s.pending : <span className="muted">none</span>}</td>
                    <td>
                      {s.allowed.length ? (
                        <SelectField
                          label={`Change ${BIOS_KEY_LABEL[s.key]} to`}
                          hideLabel
                          value={chosen}
                          disabled={!allowChanges || Boolean(blocked)}
                          onChange={(v) => setChoices((c) => ({ ...c, [s.key]: v }))}
                          options={[
                            { value: '', label: 'Keep' },
                            ...s.allowed.map((v) => ({
                              value: v,
                              label: s.securityDegrading.includes(v)
                                ? `${v} (weakens security)`
                                : v,
                            })),
                          ]}
                        />
                      ) : (
                        <span className="muted">Read-only</span>
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
                <Icon name="alert" /> {weakening.map((s) => BIOS_KEY_LABEL[s.key]).join(' and ')}{' '}
                would weaken the machine’s security. Such a change is refused unless you include it
                here and “Allow changes that weaken security” is on
                {allowDegrading ? ' (it is)' : ' (it is off)'}.
              </p>
              <label className="nv-radio">
                <input
                  type="checkbox"
                  checked={degrading}
                  onChange={(e) => setDegrading(e.target.checked)}
                />
                <span className="nv-radio-text">
                  <span>Include the change that weakens security</span>
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
              {planning ? <Spinner /> : null} Plan the change
            </Button>
            <span className="muted">Nothing changes until you approve the plan and apply it.</span>
          </div>
        </form>
      ) : null}
      {!view && !error ? <p className="muted ws-flush">Not read yet.</p> : null}
    </Section>
  );
}

const READS: readonly OobAction[] = ['check', 'power.status', 'sensors', 'bios.read'];

function howAsked(a: OobActionView): string {
  if (READS.includes(a.action)) return 'A read: no approval needed';
  if (a.action === 'bios.apply') return 'From an approved plan';
  return 'With your approval';
}

function ActionLog({ items }: { items: OobActionView[] }) {
  return (
    <ul className="ws-list" aria-label="Action log">
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
