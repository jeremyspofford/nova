// Pieces shared by the out-of-band views (FR-147): loaders that stay current with the area's
// events, the on/off switch with its consent dialog, chips for a BMC's kind and certificate pin,
// and a confirmation that shows refusals in plain words.
import { useCallback, useState, type ReactNode } from 'react';
import type { OobActionView, OobEndpointView, OobStatusView } from '@nova/shared';
import { Button, Icon, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { useHubStream } from '../hub-events.ts';
import { useSettings } from '../settings.tsx';
import { ManagedNote } from '../managed/ManagedNote.tsx';
import { formatWhen } from '../settings/common.ts';
import { useDebounced } from '../work/events.ts';
import { Chip, ConfirmDialog, useLoad, type Loaded } from '../devices/parts.tsx';
import type { OobApi } from './api-m75.ts';
import { KIND_LABEL, OOB_TEXT, oobErrorMessage, shortPin } from './format.ts';

export const OOB_PARTS_TEXT = defineMessages('oob.parts', {
  amtUnavailable: 'Intel AMT: not available',
  amtNotBuilt: 'Intel AMT is not available in this version.',
  pin: {
    ipmi: 'None (IPMI has no certificate)',
    notRead: 'Not read yet: the first check reads it',
    confirmed: 'Confirmed',
    unconfirmed: 'Waiting for your confirmation',
  },
  notChecked: 'Not checked yet',
  answered: 'Answered {when}',
  checkFailed: 'Failed {when}',
  consent: {
    connects:
      'The Hub connects to the BMCs you add (the management controller built into a server or a business computer), with the user name and password you give it.',
    allows:
      'Through them it can power a machine on, off, cycle or reset it, pick its next boot device and change its BIOS settings for the next restart, even when its operating system is down or unreachable.',
    approvals:
      'Every change waits for your approval in Nova and cannot be answered from a channel. Reading the power state, the sensors and the BIOS settings does not ask.',
    audit: 'Everything is recorded in the audit log. Only the owner of this Hub can use it.',
  },
  on: 'On',
  off: 'Off',
  onHelp: 'The Hub may reach the BMCs below. Every change still asks for your approval.',
  offHelp:
    'Off by default: a BMC controls the hardware below the operating system, so a mistake can turn a machine off or keep it from starting. Nothing reaches a BMC while it is off.',
  turnOff: 'Turn off',
  turnOn: 'Turn on…',
  enable: {
    title: 'Turn on out-of-band management?',
    description: 'Read what it allows before you turn it on.',
    confirm: 'Turn on out-of-band management',
    done: 'Out-of-band management is on.',
  },
  disable: {
    title: 'Turn off out-of-band management?',
    description:
      'Approvals still waiting are withdrawn. The BMCs and their credentials are kept, but nothing reaches them until you turn it on again.',
    confirm: 'Turn off',
    done: 'Out-of-band management is off.',
  },
  confirmPinFirst:
    'Confirm the BMC’s certificate first (above): the Hub sends it nothing else before that.',
  checkFirst:
    'Check the connection first, then confirm the BMC’s certificate: the Hub sends it nothing else before that.',
});

const S = OOB_PARTS_TEXT;

export const OOB_SETTING = 'devices.oob.enabled';

/** Events after which what the out-of-band views show may have changed. */
export const OOB_EVENTS: readonly string[] = [
  'device.oob.endpoint.changed',
  'device.oob.action.changed',
  'approval.decided',
  'approval.cancelled',
  'settings.changed',
];

/** A refusal as an Error whose message is already plain words (for ConfirmDialog). */
export function plainError(err: unknown, fallback?: string): Error {
  return new Error(oobErrorMessage(err, fallback));
}

/** Runs `fn` and turns a refusal into plain words, so a dialog keeps them and its form. */
export async function plainly<T>(fn: () => Promise<T>, fallback?: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw plainError(err, fallback);
  }
}

/** Loads with `load` and again (debounced) on the out-of-band events that `matches`. */
export function useOobLoad<T>(
  load: () => Promise<T>,
  key: string,
  matches: (payload: Record<string, unknown>, name: string) => boolean = () => true,
): Loaded<T> {
  const loaded = useLoad(load, key);
  const reload = useDebounced(loaded.reload, 150);
  useHubStream(OOB_EVENTS, (env) => {
    if (env.name === 'settings.changed' && env.payload.key !== OOB_SETTING) return;
    if (matches(env.payload, env.name)) reload();
  });
  return loaded;
}

export function useOobStatus(api: OobApi): Loaded<OobStatusView> {
  return useOobLoad(
    () => api.getOobStatus(),
    'oob-status',
    (_p, name) => ['settings.changed', 'device.oob.endpoint.changed'].includes(name),
  );
}

export function useOobEndpoints(api: OobApi): Loaded<OobEndpointView[]> {
  return useOobLoad(
    () => api.listOobEndpoints().then((r) => r.items),
    'oob-endpoints',
    (_p, name) => name === 'device.oob.endpoint.changed' || name === 'settings.changed',
  );
}

/** One BMC's action log, newest first. */
export function useOobActions(api: OobApi, endpointId: string): Loaded<OobActionView[]> {
  return useOobLoad(
    () => api.listOobActions({ endpointId, limit: 50 }).then((r) => r.items),
    `oob-actions:${endpointId}`,
    (p, name) =>
      name.startsWith('approval.') || p.endpointId === endpointId || name === 'settings.changed',
  );
}

export function KindChip({ kind }: { kind: OobEndpointView['kind'] }) {
  return kind === 'amt' ? (
    <Chip tone="blocked" icon="stop" text={S.amtUnavailable} />
  ) : (
    <span className="ws-badge">{KIND_LABEL[kind]}</span>
  );
}

/** The certificate a Redfish BMC is held to; IPMI has none. */
export function PinText({ ep }: { ep: OobEndpointView }) {
  if (ep.kind !== 'redfish') return <span className="muted">{S.pin.ipmi}</span>;
  if (!ep.tlsPin) return <span>{S.pin.notRead}</span>;
  return (
    <span>
      {ep.tlsPinConfirmed ? S.pin.confirmed : S.pin.unconfirmed}{' '}
      <code className="ws-code-inline" dir="ltr">
        {shortPin(ep.tlsPin)}
      </code>
      {ep.tlsPinConfirmed && ep.tlsPinConfirmedAt ? (
        <span className="muted"> {formatWhen(ep.tlsPinConfirmedAt)}</span>
      ) : null}
    </span>
  );
}

/** "Last check: OK, 5 min ago". */
export function LastCheck({ ep }: { ep: OobEndpointView }) {
  if (!ep.lastCheckAt) return <span className="muted">{S.notChecked}</span>;
  return ep.lastCheckOk ? (
    <Chip tone="ready" icon="check" text={S.answered({ when: formatWhen(ep.lastCheckAt) })} />
  ) : (
    <Chip tone="blocked" icon="alert" text={S.checkFailed({ when: formatWhen(ep.lastCheckAt) })} />
  );
}

/** What turning it on allows, said before the owner consents. */
export function ConsentList() {
  return (
    <ul className="oob-consent">
      <li>{S.consent.connects}</li>
      <li>{S.consent.allows}</li>
      <li>{S.consent.approvals}</li>
      <li>{S.consent.audit}</li>
    </ul>
  );
}

/**
 * Out-of-band management on or off. Turning it on opens the consent dialog and sends
 * `{confirm: true}` only from its button; turning it off asks first too.
 */
export function OobSwitch({
  api,
  status,
  onChange,
}: {
  api: OobApi;
  status: OobStatusView;
  onChange: (s: OobStatusView) => void;
}) {
  const settings = useSettings();
  const toast = useToast();
  const locked = settings.get(OOB_SETTING).locked;
  const [asking, setAsking] = useState<'on' | 'off' | null>(null);
  const close = useCallback(() => setAsking(null), []);
  return (
    <div className="oob-switch">
      <div className="devices-row-head">
        <strong>{OOB_TEXT.title}</strong>
        {status.enabled ? (
          <Chip tone="ready" icon="check" text={S.on} />
        ) : (
          <Chip tone="neutral" icon="stop" text={S.off} />
        )}
      </div>
      <p className="muted ws-flush">{status.enabled ? S.onHelp : S.offHelp}</p>
      {locked ? <ManagedNote as="p" id="oob-lock" setting={OOB_SETTING} /> : null}
      <div className="row">
        {status.enabled ? (
          <Button
            disabled={locked}
            aria-describedby={locked ? 'oob-lock' : undefined}
            onClick={() => setAsking('off')}
          >
            {S.turnOff}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={locked}
            aria-describedby={locked ? 'oob-lock' : undefined}
            onClick={() => setAsking('on')}
          >
            <Icon name="shield" /> {S.turnOn}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={asking === 'on'}
        title={S.enable.title}
        description={S.enable.description}
        confirmLabel={S.enable.confirm}
        danger
        onClose={close}
        onConfirm={async () => {
          const next = await plainly(() => api.enableOob({ confirm: true }));
          setAsking(null);
          onChange(next);
          toast.show(S.enable.done, { tone: 'success' });
        }}
      >
        <ConsentList />
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === 'off'}
        title={S.disable.title}
        description={S.disable.description}
        confirmLabel={S.disable.confirm}
        onClose={close}
        onConfirm={async () => {
          const next = await plainly(() => api.disableOob());
          setAsking(null);
          onChange(next);
          toast.show(S.disable.done, { tone: 'success' });
        }}
      />
    </div>
  );
}

/** Why the connection check cannot run now, or null. */
export function checkBlocked(
  status: OobStatusView | null,
  ep: Pick<OobEndpointView, 'kind'>,
): string | null {
  if (ep.kind === 'amt') return S.amtNotBuilt;
  if (status && !status.enabled) return OOB_TEXT.reasons.oob_disabled;
  return null;
}

/**
 * Why the other out-of-band actions cannot be asked for now, or null: besides the above, the
 * credentials must be stored and a Redfish BMC's certificate confirmed (nothing else is sent to it
 * before that).
 */
export function actionBlocked(
  status: OobStatusView | null,
  ep: Pick<OobEndpointView, 'kind' | 'hasCredentials' | 'tlsPin' | 'tlsPinConfirmed'>,
): string | null {
  const off = checkBlocked(status, ep);
  if (off) return off;
  if (!ep.hasCredentials) return OOB_TEXT.reasons.credentials_missing;
  if (ep.kind === 'redfish' && !(ep.tlsPin && ep.tlsPinConfirmed))
    return ep.tlsPin ? S.confirmPinFirst : S.checkFirst;
  return null;
}

export function Section({
  id,
  title,
  children,
  actions,
}: {
  id: string;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="ws-section devices-flat" aria-labelledby={id}>
      <div className="ws-section-header">
        <h2 id={id}>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
