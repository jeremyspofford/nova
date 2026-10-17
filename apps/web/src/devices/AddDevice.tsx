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
import { LoadError, Unavailable, useCopy } from './parts.tsx';
import { QrCode } from './Qr.tsx';
import { AddRequestCard } from './Requests.tsx';

const TRUST_PATH = '/network/trust';

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
      <nav aria-label="Breadcrumb" className="ws-breadcrumb">
        <a href={DEVICES_PATH} onClick={(e) => followLink(e, DEVICES_PATH)}>
          <Icon name="back" /> Devices
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
      announce('Code ready. Scan it with the device, or type it there.');
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
    announce(`${r.name} asks to join. Type the code it shows to approve it.`);
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
    if (r.status === 'approved') announce(`${r.name} is added.`);
  };

  const again = () => {
    setError(null);
    setStep({ kind: 'choose' });
    if (requestId) navigate(DEVICES_ADD_PATH, { replace: true });
  };

  const header = (
    <header className="ws-page-header">
      <h1>Add a device</h1>
    </header>
  );

  if (step.kind === 'lookup') {
    return (
      <>
        {header}
        {lookupError ? (
          <LoadError
            error={lookupError}
            fallback="Could not load the request."
            onRetry={() => {
              setLookupError(null);
              setLookupTry((n) => n + 1);
            }}
          />
        ) : (
          <Spinner label="Loading the request" />
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
          <Icon name="check" /> {r.name} is added
        </h1>
        <dl className="devices-facts">
          <div>
            <dt>Role</dt>
            <dd>{ROLE_LABEL[r.role] ?? r.role}</dd>
          </div>
          <div>
            <dt>Scopes</dt>
            <dd>{scopesText(r.scopes)}</dd>
          </div>
          <div>
            <dt>Runs</dt>
            <dd>{JOIN_KIND_LABEL[r.kind]}</dd>
          </div>
          <div>
            <dt>Platform</dt>
            <dd>{r.platform}</dd>
          </div>
        </dl>
        <p className="muted ws-flush">
          {registers
            ? 'It finishes joining when it registers with this Hub, usually within a minute.'
            : 'It is signed in now.'}{' '}
          Change its scopes or revoke it from its page.
        </p>
        <div className="row">
          {r.deviceId ? (
            <Button variant="primary" onClick={() => navigate(devicePath(r.deviceId))}>
              Open {r.name}
            </Button>
          ) : null}
          <Button onClick={again}>Add another device</Button>
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
            ? `${step.request.name} was not added. Its code is used up.`
            : step.kind === 'expired'
              ? `The request from ${step.request.name} expired before it was approved.`
              : 'This request is not on this Hub any more.'}
        </p>
        <div className="row">
          <Button variant="primary" onClick={again}>
            Add a device
          </Button>
          <Button onClick={() => navigate(DEVICES_PATH)}>Back to devices</Button>
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
            Back to devices
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
          {ROLE_LABEL[s.role]} · Scopes: {scopesText(s.scopes)}
          {s.transport === 'relay' ? ' · through the Relay' : ''}
        </p>
        {s.role === 'client' && s.transport !== 'relay' && plainHttpOnNetwork(s.pageUrl) ? (
          <p className="ws-flush" role="note">
            <Icon name="alert" /> A phone or browser can join only over a secure connection, and
            this Hub is on plain HTTP. Turn on HTTPS in{' '}
            <a href={TRUST_PATH} onClick={(e) => followLink(e, TRUST_PATH)}>
              Network → Trust
            </a>{' '}
            first, or add the device with the Nova app.
          </p>
        ) : null}
        <div className="devices-pairing">
          <figure className="devices-qr-box">
            <QrCode text={s.qr} label="QR code that adds a device to this Hub" />
            <figcaption className="muted">Scan it with the device’s camera.</figcaption>
          </figure>
          <div className="stack devices-pairing-side">
            <section className="stack devices-code-box" aria-labelledby={`${id}-code`}>
              <h2 id={`${id}-code`}>Or type this code on the device</h2>
              <p className="devices-code" ref={codeRef}>
                {s.code}
              </p>
              <p className="muted ws-flush">
                On the device, open{' '}
                <code className="ws-code-inline devices-break">{s.pageUrl.split('?')[0]}</code> and
                type the code.
              </p>
              <div className="row">
                <Button
                  onClick={() => void copy(s.code, codeRef.current, 'Code')}
                  disabled={codeExpired}
                >
                  <Icon name="copy" /> Copy code
                </Button>
              </div>
            </section>
            {codeExpired ? (
              <div className="stack">
                <p role="alert" className="nv-field-error ws-flush">
                  This code has expired. Make a new one to add the device.
                </p>
                <div className="row">
                  <Button variant="primary" onClick={() => void start()} disabled={busy}>
                    {busy ? <Spinner /> : null} New code
                  </Button>
                </div>
              </div>
            ) : (
              <p className="muted ws-flush devices-expiry">
                <Icon name="clock" />
                <span>
                  Works once. Expires in <span role="timer">{formatCountdown(left)}</span>.
                </span>
              </p>
            )}
            <section className="stack devices-link-box" aria-labelledby={`${id}-link`}>
              <h2 id={`${id}-link`}>Or send the device this link</h2>
              <code ref={linkRef} className="ws-code-inline devices-break">
                {s.qr}
              </code>
              <div className="row">
                <Button
                  onClick={() => void copy(s.qr, linkRef.current, 'Link')}
                  disabled={codeExpired}
                >
                  <Icon name="copy" /> Copy link
                </Button>
              </div>
            </section>
          </div>
        </div>
        {headless ? (
          <section className="ws-section devices-flat" aria-labelledby={`${id}-headless`}>
            <h2 id={`${id}-headless`}>On a computer without a screen</h2>
            {install}
          </section>
        ) : (
          <details className="ws-advanced">
            <summary>Adding a computer without a screen?</summary>
            {install}
          </details>
        )}
        {!codeExpired ? (
          <div className="devices-waiting" role="status">
            <Spinner />
            <span>Waiting for the device to ask to join. You approve it here.</span>
          </div>
        ) : null}
        <div className="row">
          <Button variant="ghost" onClick={again}>
            Start over
          </Button>
          <Button variant="ghost" onClick={() => navigate(DEVICES_PATH)}>
            Cancel
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
          Adding devices with a code is turned off
          {enabled.locked ? ' by your organization' : ''}.{' '}
          {!enabled.locked ? (
            <a href="/settings/devices" onClick={(e) => followLink(e, '/settings/devices')}>
              Turn it on in Settings → Devices
            </a>
          ) : null}
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
          legend="What will this device do?"
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
          <legend>What it may do</legend>
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
            <p className="muted ws-flush">
              A Wake helper only sends wake signals on its network. It has no other scopes.
            </p>
          )}
          {choices.length ? (
            <p className="nv-field-hint ws-flush">You can change these later on its page.</p>
          ) : null}
        </fieldset>
        <TextField
          label="Name (optional)"
          hint="What this Hub calls it. Leave it empty to use the name the device suggests."
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        {relay ? (
          <RadioGroup
            legend="How it connects"
            name={`${id}-transport`}
            value={transport}
            className="ws-fieldset devices-roles"
            options={[
              {
                value: 'direct',
                label: 'Directly',
                description: 'The device reaches this Hub at its own address.',
              },
              {
                value: 'relay',
                label: 'Through the Relay',
                description: 'The device joins from anywhere, through your Relay.',
              },
            ]}
            onChange={(v) => setTransport(v as AddDeviceTransport)}
          />
        ) : null}
        <p className="muted ws-flush">
          Next you get a QR code and a short code for the device. It works once, for 5 minutes. When
          the device asks to join, you approve it here.
        </p>
        {error ? (
          <div role="alert" className="ws-error">
            <p>{deviceErrorMessage(error, 'Could not make a code.')}</p>
          </div>
        ) : null}
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy || !enabled.value}>
            {busy ? <Spinner /> : null} Create code
          </Button>
          <Button onClick={() => navigate(DEVICES_PATH)}>Cancel</Button>
        </div>
      </form>
      <p className="muted ws-flush">
        Installing novad from a script?{' '}
        <a href={ADD_COMMAND_PATH} onClick={(e) => followLink(e, ADD_COMMAND_PATH)}>
          Use a one-use command instead
        </a>
        .
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
  copy: (text: string, el: HTMLElement | null, what: string) => Promise<void>;
}) {
  const shRef = useRef<HTMLElement>(null);
  const psRef = useRef<HTMLElement>(null);
  const { command, powershell } = bootstrap;
  if (!command) {
    return (
      <p className="muted ws-flush">
        {bootstrap.why ?? 'This Hub has no install command for this device.'}
      </p>
    );
  }
  return (
    <div className="stack devices-install">
      <p className="ws-flush">
        Run this in a terminal on the computer. It downloads novad from this Hub, checks its
        signature, and asks to join with this code.
      </p>
      <pre className="ws-command">
        <code ref={shRef}>{command}</code>
      </pre>
      <div className="row">
        <Button onClick={() => void copy(command, shRef.current, 'Command')}>
          <Icon name="copy" /> Copy command
        </Button>
      </div>
      {powershell ? (
        <>
          <h3 className="ws-flush">Windows (PowerShell)</h3>
          <pre className="ws-command">
            <code ref={psRef}>{powershell}</code>
          </pre>
          <div className="row">
            <Button onClick={() => void copy(powershell, psRef.current, 'Windows command')}>
              <Icon name="copy" /> Copy Windows command
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
