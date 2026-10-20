// Add a device (FR-132; docs/04 §9 flow 1; docs/22 §4): choose its role and scopes (and the
// Relay when the Hub has one), then show a QR code made in this browser, the short code, a
// countdown to its expiry, the one-line install command for computers without a screen, and the
// join link. The device scans or types the code and asks to join; its request appears here, and
// the owner types the six digits the device shows (never filled in: comparing the two screens is
// the security step) and approves or denies. The success screen shows the device with its role
// and scopes and links to its page.
//
// `/devices/add?role=<role>` preselects a role; `?request=<id>` opens one request (the
// notification links there); `?method=command` is the M6 one-use command for scripted installs.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  ADD_DEVICE_ROLES,
  type AddDeviceRequestView,
  type AddDeviceRole,
  type AddDeviceTransport,
} from '@nova/shared';
import { Button, Icon, RadioGroup, Spinner, TextField } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { rich } from '../i18n/rich.tsx';
import { formatCountdown } from '../settings/DevicesPage.tsx';
import { useInterval } from '../settings/common.ts';
import { navigate, useLocation } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { useSetting } from '../settings.tsx';
import { followLink } from '../work/nav.tsx';
import { useDevicesApi, type AddDeviceStarted } from './api.ts';
import { EnrollCommand } from './EnrollCommand.tsx';
import { ADD_REQUEST_EVENTS, useDeviceEvents } from './events.ts';
import {
  ADD_COMMAND_PATH,
  DEVICES_ADD_PATH,
  DEVICES_PATH,
  JOIN_KIND_LABEL,
  ROLE_HELP,
  ROLE_LABEL,
  SCOPES_BY_ROLE,
  SCOPE_TEXT,
  deviceErrorMessage,
  devicePath,
  scopesText,
} from './format.ts';
import { LoadError, Unavailable, useCopy, type CopyWhat } from './parts.tsx';
import { QrCode } from './Qr.tsx';
import { AddRequestCard } from './Requests.tsx';

const TRUST_PATH = '/network/trust';

export const ADD_TEXT = defineMessages('devices.add', {
  breadcrumb: 'Breadcrumb',
  devices: 'Devices',
  title: 'Add a device',
  codeReady: 'Code ready. Scan it with the device, or type it there.',
  asksToJoin: '{name} asks to join. Type the code it shows to approve it.',
  added: '{name} is added.',
  lookupFailed: 'Could not load the request.',
  lookingUp: 'Loading the request',
  addedTitle: '{name} is added',
  facts: { role: 'Role', scopes: 'Scopes', runs: 'Runs', platform: 'Platform' },
  registers: 'It finishes joining when it registers with this Hub, usually within a minute.',
  signedIn: 'It is signed in now.',
  changeLater: 'Change its scopes or revoke it from its page.',
  open: 'Open {name}',
  another: 'Add another device',
  denied: '{name} was not added. Its code is used up.',
  expired: 'The request from {name} expired before it was approved.',
  missing: 'This request is not on this Hub any more.',
  addDevice: 'Add a device',
  back: 'Back to devices',
  scopes: 'Scopes: {scopes}',
  throughRelay: 'through the Relay',
  plainHttp:
    'A phone or browser can join only over a secure connection, and this Hub is on plain HTTP. Turn on HTTPS in {link} first, or add the device with the Nova app.',
  networkTrust: 'Network → Trust',
  qr: 'QR code that adds a device to this Hub',
  scan: 'Scan it with the device’s camera.',
  typeCode: 'Or type this code on the device',
  openPage: 'On the device, open {url} and type the code.',
  copyCode: 'Copy code',
  codeExpired: 'This code has expired. Make a new one to add the device.',
  newCode: 'New code',
  worksOnce: 'Works once. Expires in {time}.',
  sendLink: 'Or send the device this link',
  copyLink: 'Copy link',
  headless: 'On a computer without a screen',
  headlessQuestion: 'Adding a computer without a screen?',
  waiting: 'Waiting for the device to ask to join. You approve it here.',
  startOver: 'Start over',
  cancel: 'Cancel',
  off: 'Adding devices with a code is turned off. {link}',
  offLocked: 'Adding devices with a code is turned off by your organization.',
  turnOn: 'Turn it on in Settings → Devices',
  roles: 'What will this device do?',
  mayDo: 'What it may do',
  wakeHelperOnly: 'A Wake helper only sends wake signals on its network. It has no other scopes.',
  changeScopesLater: 'You can change these later on its page.',
  name: 'Name (optional)',
  nameHint: 'What this Hub calls it. Leave it empty to use the name the device suggests.',
  connects: 'How it connects',
  direct: 'Directly',
  directHelp: 'The device reaches this Hub at its own address.',
  relay: 'Through the Relay',
  relayHelp: 'The device joins from anywhere, through your Relay.',
  next: 'Next you get a QR code and a short code for the device. It works once, for 5 minutes. When the device asks to join, you approve it here.',
  makeFailed: 'Could not make a code.',
  create: 'Create code',
  script: 'Installing novad from a script? {link}.',
  useCommand: 'Use a one-use command instead',
  noInstall: 'This Hub has no install command for this device.',
  runThis:
    'Run this in a terminal on the computer. It downloads novad from this Hub, checks its signature, and asks to join with this code.',
  copyCommand: 'Copy command',
  windows: 'Windows (PowerShell)',
  copyWindows: 'Copy Windows command',
});
const S = ADD_TEXT;

/**
 * Whether a join link is plain HTTP at an address other than this computer: browsers give the
 * join page no Web Crypto there (not a secure context), so a phone cannot join from it.
 */
export function plainHttpOnNetwork(pageUrl: string): boolean {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return (
      u.protocol === 'http:' &&
      host !== 'localhost' &&
      !host.endsWith('.localhost') &&
      !/^127\./.test(host) &&
      host !== '::1'
    );
  } catch {
    return false;
  }
}

function parseRole(v: string | null): AddDeviceRole | null {
  return (ADD_DEVICE_ROLES as readonly string[]).includes(v ?? '') ? (v as AddDeviceRole) : null;
}

export function AddDevicePage() {
  const loc = useLocation();
  const q = new URLSearchParams(loc.includes('?') ? loc.slice(loc.indexOf('?')) : '');
  const request = q.get('request');
  return (
    <div className="ws-page devices-page">
      <nav aria-label={S.breadcrumb} className="ws-breadcrumb">
        <a href={DEVICES_PATH} onClick={(e) => followLink(e, DEVICES_PATH)}>
          <Icon name="back" /> {S.devices}
        </a>
      </nav>
      {q.get('method') === 'command' ? (
        <EnrollCommand />
      ) : (
        <PairingFlow
          key={request ?? 'new'}
          initialRole={parseRole(q.get('role'))}
          requestId={request}
        />
      )}
    </div>
  );
}

type Step =
  | { kind: 'choose' }
  | { kind: 'lookup'; requestId: string }
  | { kind: 'code'; started: AddDeviceStarted }
  | { kind: 'request'; request: AddDeviceRequestView }
  | { kind: 'approved'; request: AddDeviceRequestView }
  | { kind: 'denied'; request: AddDeviceRequestView }
  | { kind: 'expired'; request: AddDeviceRequestView }
  | { kind: 'missing' };

/** How often the page looks for the device's request besides the live event. */
export const REQUEST_CHECK_MS = 5_000;

function stepFor(r: AddDeviceRequestView): Step {
  if (r.status === 'pending') return { kind: 'request', request: r };
  return { kind: r.status, request: r };
}

function PairingFlow({
  initialRole,
  requestId,
}: {
  initialRole: AddDeviceRole | null;
  requestId: string | null;
}) {
  const api = useDevicesApi();
  const announce = useAnnounce();
  const copy = useCopy();
  const id = useId();
  const relay = useSetting('relay.enabled').value;
  const enabled = useSetting('devices.add.enabled');
  const [role, setRole] = useState<AddDeviceRole>(initialRole ?? 'client');
  const [scopes, setScopes] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<AddDeviceTransport>('direct');
  const [step, setStep] = useState<Step>(
    requestId ? { kind: 'lookup', requestId } : { kind: 'choose' },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lookupError, setLookupError] = useState<unknown>(null);
  const [lookupTry, setLookupTry] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const codeRef = useRef<HTMLParagraphElement>(null);
  const linkRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const started = step.kind === 'code' ? step.started : null;
  const left = started ? Date.parse(started.expiresAt) - now : 0;
  const codeExpired = started !== null && left <= 0;
  useInterval(() => setNow(Date.now()), 1000, started !== null && !codeExpired);

  useEffect(() => {
    if (step.kind === 'approved') headingRef.current?.focus();
  }, [step.kind]);

  // A request named in the address (from a notification), or one decided elsewhere.
  const lookupId = step.kind === 'lookup' ? step.requestId : null;
  useEffect(() => {
    if (!lookupId) return;
    let alive = true;
    api.listAddRequests('all').then(
      ({ items }) => {
        if (!alive) return;
        const r = items.find((x) => x.id === lookupId);
        setLookupError(null);
        setStep(r ? stepFor(r) : { kind: 'missing' });
      },
      (err: unknown) => alive && setLookupError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, lookupId, lookupTry]);

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.startAddDevice({
        role,
        scopes,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(transport === 'relay' ? { transport } : {}),
      });
      setNow(Date.now());
      setStep({ kind: 'code', started: out });
      announce(S.codeReady);
    } catch (err) {
      setError(err);
      setStep({ kind: 'choose' });
    } finally {
      setBusy(false);
    }
  };

  // The device's request: from the live event, and checked every few seconds as well.
  const pairingId = started?.pairingId ?? null;
  const findRequest = useCallback(async () => {
    if (!pairingId) return;
    const { items } = await api.listAddRequests('pending');
    const r = items.find((x) => x.pairingId === pairingId);
    if (!r) return;
    setStep((s) => (s.kind === 'code' && s.started.pairingId === pairingId ? stepFor(r) : s));
    announce(S.asksToJoin({ name: r.name }));
  }, [api, pairingId, announce]);
  const watchedRequest = step.kind === 'request' ? step.request.id : null;
  useDeviceEvents(ADD_REQUEST_EVENTS, (env) => {
    if (env.name === 'device.add.requested' && pairingId) void findRequest().catch(() => undefined);
    if (
      env.name === 'device.add.decided' &&
      watchedRequest &&
      env.payload.requestId === watchedRequest
    )
      setStep({ kind: 'lookup', requestId: watchedRequest });
  });
  useInterval(
    () => void findRequest().catch(() => undefined),
    REQUEST_CHECK_MS,
    pairingId !== null && !codeExpired,
  );

  const decided = (r: AddDeviceRequestView) => {
    if (r.status === 'approved' && !r.deviceId) setStep({ kind: 'lookup', requestId: r.id });
    else setStep(stepFor(r));
    if (r.status === 'approved') announce(S.added({ name: r.name }));
  };

  const again = () => {
    setError(null);
    setStep({ kind: 'choose' });
    if (requestId) navigate(DEVICES_ADD_PATH, { replace: true });
  };

  const header = (
    <header className="ws-page-header">
      <h1>{S.title}</h1>
    </header>
  );

  if (step.kind === 'lookup') {
    return (
      <>
        {header}
        {lookupError ? (
          <LoadError
            error={lookupError}
            fallback={S.lookupFailed}
            onRetry={() => {
              setLookupError(null);
              setLookupTry((n) => n + 1);
            }}
          />
        ) : (
          <Spinner label={S.lookingUp} />
        )}
      </>
    );
  }

  if (step.kind === 'approved') {
    const r = step.request;
    const registers = r.kind === 'novad' || r.kind === 'compute';
    return (
      <section className="devices-success" aria-labelledby={`${id}-done`}>
        <h1 id={`${id}-done`} ref={headingRef} tabIndex={-1}>
          <Icon name="check" /> {S.addedTitle({ name: r.name })}
        </h1>
        <dl className="devices-facts">
          <div>
            <dt>{S.facts.role}</dt>
            <dd>{ROLE_LABEL[r.role] ?? r.role}</dd>
          </div>
          <div>
            <dt>{S.facts.scopes}</dt>
            <dd>{scopesText(r.scopes)}</dd>
          </div>
          <div>
            <dt>{S.facts.runs}</dt>
            <dd>{JOIN_KIND_LABEL[r.kind]}</dd>
          </div>
          <div>
            <dt>{S.facts.platform}</dt>
            <dd>{r.platform}</dd>
          </div>
        </dl>
        <p className="muted ws-flush">
          {registers ? S.registers : S.signedIn} {S.changeLater}
        </p>
        <div className="row">
          {r.deviceId ? (
            <Button variant="primary" onClick={() => navigate(devicePath(r.deviceId))}>
              {S.open({ name: r.name })}
            </Button>
          ) : null}
          <Button onClick={again}>{S.another}</Button>
        </div>
      </section>
    );
  }

  if (step.kind === 'denied' || step.kind === 'expired' || step.kind === 'missing') {
    return (
      <>
        {header}
        <p className="devices-note" role="status">
          <Icon name={step.kind === 'denied' ? 'stop' : 'clock'} />{' '}
          {step.kind === 'denied'
            ? S.denied({ name: step.request.name })
            : step.kind === 'expired'
              ? S.expired({ name: step.request.name })
              : S.missing}
        </p>
        <div className="row">
          <Button variant="primary" onClick={again}>
            {S.addDevice}
          </Button>
          <Button onClick={() => navigate(DEVICES_PATH)}>{S.back}</Button>
        </div>
      </>
    );
  }

  if (step.kind === 'request') {
    return (
      <>
        {header}
        <AddRequestCard request={step.request} onDecided={decided} />
        <div className="row">
          <Button variant="ghost" onClick={() => navigate(DEVICES_PATH)}>
            {S.back}
          </Button>
        </div>
      </>
    );
  }

  if (step.kind === 'code') {
    const s = step.started;
    const headless = s.role !== 'client';
    const install = <InstallCommands bootstrap={s.bootstrap} copy={copy} />;
    return (
      <>
        {header}
        <p className="muted ws-flush">
          {ROLE_LABEL[s.role]} · {S.scopes({ scopes: scopesText(s.scopes) })}
          {s.transport === 'relay' ? ` · ${S.throughRelay}` : ''}
        </p>
        {s.role === 'client' && s.transport !== 'relay' && plainHttpOnNetwork(s.pageUrl) ? (
          <p className="ws-flush" role="note">
            <Icon name="alert" />{' '}
            {rich(S.plainHttp, {
              link: (
                <a href={TRUST_PATH} onClick={(e) => followLink(e, TRUST_PATH)}>
                  {S.networkTrust}
                </a>
              ),
            })}
          </p>
        ) : null}
        <div className="devices-pairing">
          <figure className="devices-qr-box">
            <QrCode text={s.qr} label={S.qr} />
            <figcaption className="muted">{S.scan}</figcaption>
          </figure>
          <div className="stack devices-pairing-side">
            <section className="stack devices-code-box" aria-labelledby={`${id}-code`}>
              <h2 id={`${id}-code`}>{S.typeCode}</h2>
              <p className="devices-code" ref={codeRef} dir="ltr">
                {s.code}
              </p>
              <p className="muted ws-flush">
                {rich(S.openPage, {
                  url: (
                    <code className="ws-code-inline devices-break" dir="ltr">
                      {s.pageUrl.split('?')[0]}
                    </code>
                  ),
                })}
              </p>
              <div className="row">
                <Button
                  onClick={() => void copy(s.code, codeRef.current, 'code')}
                  disabled={codeExpired}
                >
                  <Icon name="copy" /> {S.copyCode}
                </Button>
              </div>
            </section>
            {codeExpired ? (
              <div className="stack">
                <p role="alert" className="nv-field-error ws-flush">
                  {S.codeExpired}
                </p>
                <div className="row">
                  <Button variant="primary" onClick={() => void start()} disabled={busy}>
                    {busy ? <Spinner /> : null} {S.newCode}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="muted ws-flush devices-expiry">
                <Icon name="clock" />
                <span>
                  {rich(S.worksOnce, { time: <span role="timer">{formatCountdown(left)}</span> })}
                </span>
              </p>
            )}
            <section className="stack devices-link-box" aria-labelledby={`${id}-link`}>
              <h2 id={`${id}-link`}>{S.sendLink}</h2>
              <code ref={linkRef} className="ws-code-inline devices-break" dir="ltr">
                {s.qr}
              </code>
              <div className="row">
                <Button
                  onClick={() => void copy(s.qr, linkRef.current, 'link')}
                  disabled={codeExpired}
                >
                  <Icon name="copy" /> {S.copyLink}
                </Button>
              </div>
            </section>
          </div>
        </div>
        {headless ? (
          <section className="ws-section devices-flat" aria-labelledby={`${id}-headless`}>
            <h2 id={`${id}-headless`}>{S.headless}</h2>
            {install}
          </section>
        ) : (
          <details className="ws-advanced">
            <summary>{S.headlessQuestion}</summary>
            {install}
          </details>
        )}
        {!codeExpired ? (
          <div className="devices-waiting" role="status">
            <Spinner />
            <span>{S.waiting}</span>
          </div>
        ) : null}
        <div className="row">
          <Button variant="ghost" onClick={again}>
            {S.startOver}
          </Button>
          <Button variant="ghost" onClick={() => navigate(DEVICES_PATH)}>
            {S.cancel}
          </Button>
        </div>
      </>
    );
  }

  const choices = SCOPES_BY_ROLE[role];
  return (
    <>
      {header}
      {!enabled.value ? (
        <Unavailable>
          {enabled.locked
            ? S.offLocked
            : rich(S.off, {
                link: (
                  <a href="/settings/devices" onClick={(e) => followLink(e, '/settings/devices')}>
                    {S.turnOn}
                  </a>
                ),
              })}
        </Unavailable>
      ) : null}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <RadioGroup
          legend={S.roles}
          name={`${id}-role`}
          value={role}
          className="ws-fieldset devices-roles"
          options={ADD_DEVICE_ROLES.map((r) => ({
            value: r,
            label: ROLE_LABEL[r] ?? r,
            description: ROLE_HELP[r],
          }))}
          onChange={(v) => {
            const next = v as AddDeviceRole;
            setRole(next);
            setScopes((cur) => cur.filter((x) => SCOPES_BY_ROLE[next].includes(x)));
          }}
        />
        <fieldset className="ws-fieldset devices-roles">
          <legend>{S.mayDo}</legend>
          {choices.length ? (
            choices.map((sc) => (
              <label key={sc} className="nv-radio">
                <input
                  type="checkbox"
                  checked={scopes.includes(sc)}
                  aria-labelledby={`${id}-${sc}-label`}
                  aria-describedby={`${id}-${sc}`}
                  onChange={(e) =>
                    setScopes((cur) =>
                      e.target.checked ? [...cur, sc] : cur.filter((x) => x !== sc),
                    )
                  }
                />
                <span className="nv-radio-text">
                  <span id={`${id}-${sc}-label`}>{SCOPE_TEXT[sc]?.label ?? sc}</span>
                  <span id={`${id}-${sc}`} className="nv-field-hint">
                    {SCOPE_TEXT[sc]?.help}
                  </span>
                </span>
              </label>
            ))
          ) : (
            <p className="muted ws-flush">{S.wakeHelperOnly}</p>
          )}
          {choices.length ? <p className="nv-field-hint ws-flush">{S.changeScopesLater}</p> : null}
        </fieldset>
        <TextField
          label={S.name}
          hint={S.nameHint}
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        {relay ? (
          <RadioGroup
            legend={S.connects}
            name={`${id}-transport`}
            value={transport}
            className="ws-fieldset devices-roles"
            options={[
              { value: 'direct', label: S.direct, description: S.directHelp },
              { value: 'relay', label: S.relay, description: S.relayHelp },
            ]}
            onChange={(v) => setTransport(v as AddDeviceTransport)}
          />
        ) : null}
        <p className="muted ws-flush">{S.next}</p>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{deviceErrorMessage(error, S.makeFailed)}</p>
          </div>
        ) : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy || !enabled.value}>
            {busy ? <Spinner /> : null} {S.create}
          </Button>
          <Button onClick={() => navigate(DEVICES_PATH)}>{S.cancel}</Button>
        </div>
      </form>
      <p className="muted ws-flush">
        {rich(S.script, {
          link: (
            <a href={ADD_COMMAND_PATH} onClick={(e) => followLink(e, ADD_COMMAND_PATH)}>
              {S.useCommand}
            </a>
          ),
        })}
      </p>
    </>
  );
}

/** The one-line install command(s) for a computer without a screen, or why there is none. */
function InstallCommands({
  bootstrap,
  copy,
}: {
  bootstrap: AddDeviceStarted['bootstrap'];
  copy: (text: string, el: HTMLElement | null, what: CopyWhat) => Promise<void>;
}) {
  const shRef = useRef<HTMLElement>(null);
  const psRef = useRef<HTMLElement>(null);
  const { command, powershell } = bootstrap;
  if (!command) {
    return <p className="muted ws-flush">{bootstrap.why ?? S.noInstall}</p>;
  }
  return (
    <div className="stack devices-install">
      <p className="ws-flush">{S.runThis}</p>
      <pre className="ws-command" dir="ltr">
        <code ref={shRef}>{command}</code>
      </pre>
      <div className="row">
        <Button onClick={() => void copy(command, shRef.current, 'command')}>
          <Icon name="copy" /> {S.copyCommand}
        </Button>
      </div>
      {powershell ? (
        <>
          <h3 className="ws-flush">{S.windows}</h3>
          <pre className="ws-command" dir="ltr">
            <code ref={psRef}>{powershell}</code>
          </pre>
          <div className="row">
            <Button onClick={() => void copy(powershell, psRef.current, 'windowsCommand')}>
              <Icon name="copy" /> {S.copyWindows}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
