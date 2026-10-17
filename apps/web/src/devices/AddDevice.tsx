// Add a device (docs/04 §9 flow 1, docs/22 §4, docs/23 §2): choose its roles, create a one-use
// command (creating it is the owner's approval, ADR-089), run it on the device, and watch for the
// device to register (`device.registered`); then the success screen links to its page. The
// command works once, for 15 minutes; an expired one is replaced with a click.
import { useEffect, useId, useRef, useState } from 'react';
import { DEVICE_ENROLL_ROLES, type DeviceEnrollToken, type DeviceView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { formatCountdown } from '../settings/DevicesPage.tsx';
import { useInterval } from '../settings/common.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { useDevicesApi } from './api.ts';
import { eventDeviceId, useDeviceEvents } from './events.ts';
import { DEVICES_PATH, ROLE_LABEL, deviceErrorMessage, devicePath, rolesText } from './format.ts';

type Role = (typeof DEVICE_ENROLL_ROLES)[number];

/** What the success screen shows about the new device. */
type Added = Pick<DeviceView, 'id' | 'name' | 'roles' | 'novadVersion'>;

const ROLE_HELP: Record<Role, string> = {
  client:
    'A computer you use. Agents can work with its files, browser and screen when you allow it.',
  compute: 'Runs models and other heavy work for this Hub.',
  'wake-helper': 'Always on, on the same network as the others, so it can wake them.',
};

export function AddDevicePage() {
  const api = useDevicesApi();
  const toast = useToast();
  const announce = useAnnounce();
  const formId = useId();
  const [roles, setRoles] = useState<Role[]>(['client']);
  const [token, setToken] = useState<DeviceEnrollToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  const [added, setAdded] = useState<Added | null>(null);
  const [checking, setChecking] = useState(false);
  // Devices that existed before the command, so a manual check can tell the new one.
  const known = useRef<Set<string> | null>(null);
  const commandRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const left = token ? Date.parse(token.expiresAt) - now : 0;
  const expired = token !== null && left <= 0;
  useInterval(() => setNow(Date.now()), 1000, token !== null && !expired && !added);

  useEffect(() => {
    if (added) headingRef.current?.focus();
  }, [added]);

  const create = async () => {
    if (!roles.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!known.current) {
        const { items } = await api.listNovadDevices().catch(() => ({ items: [] as DeviceView[] }));
        known.current = new Set(items.map((d) => d.id));
      }
      const t = await api.enrollNovadDevice({ roles });
      setToken(t);
      setNow(Date.now());
      announce('Command ready. Run it on the device.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const found = (d: Added) => {
    setAdded(d);
    announce(`${d.name} is added.`);
  };

  // The device registers on its own; the Hub tells every open client.
  useDeviceEvents(['device.registered'], (env) => {
    if (!token || added) return;
    const id = eventDeviceId(env);
    if (!id) return;
    api.getNovadDevice(id).then(found, () => {
      const name = typeof env.payload.name === 'string' ? env.payload.name : 'The device';
      found({ id, name, roles: [], novadVersion: null });
    });
  });

  const checkNow = async () => {
    setChecking(true);
    try {
      const { items } = await api.listNovadDevices();
      const fresh = items.find((d) => !known.current?.has(d.id) && d.status !== 'revoked');
      if (fresh) found(fresh);
      else announce('Not registered yet.');
    } catch (err) {
      toast.show(deviceErrorMessage(err, 'Could not check.'), { tone: 'error' });
    } finally {
      setChecking(false);
    }
  };

  const copy = async () => {
    if (!token) return;
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(token.command);
      toast.show('Command copied.', { tone: 'success' });
    } catch {
      // Select the text so the user can copy it by hand.
      const el = commandRef.current;
      const sel = window.getSelection();
      if (el && sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      toast.show('Could not copy. The command is selected; copy it with your keyboard.', {
        tone: 'error',
      });
    }
  };

  const restart = () => {
    setToken(null);
    setAdded(null);
    setError(null);
    known.current = null;
  };

  return (
    <div className="ws-page devices-page">
      <nav aria-label="Breadcrumb" className="ws-breadcrumb">
        <a href={DEVICES_PATH} onClick={(e) => followLink(e, DEVICES_PATH)}>
          <Icon name="back" /> Devices
        </a>
      </nav>
      {added ? (
        <section className="devices-success" aria-labelledby={`${formId}-done`}>
          <h1 id={`${formId}-done`} ref={headingRef} tabIndex={-1}>
            <Icon name="check" /> {added.name} is added
          </h1>
          <p className="muted ws-flush">
            {added.roles.length ? `${rolesText(added.roles)}. ` : ''}
            {added.novadVersion ? `novad ${added.novadVersion}. ` : ''}
            Open it to choose which folders it shares and what it may run.
          </p>
          <div className="row">
            <Button variant="primary" onClick={() => navigate(devicePath(added.id))}>
              Open {added.name}
            </Button>
            <Button onClick={restart}>Add another device</Button>
          </div>
        </section>
      ) : (
        <>
          <header className="ws-page-header">
            <h1>Add a device</h1>
          </header>
          {!token ? (
            <form
              id={formId}
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <fieldset className="ws-fieldset devices-roles">
                <legend>What will this device do?</legend>
                {DEVICE_ENROLL_ROLES.map((r) => (
                  <label key={r} className="nv-radio">
                    <input
                      type="checkbox"
                      checked={roles.includes(r)}
                      aria-labelledby={`${formId}-${r}-label`}
                      aria-describedby={`${formId}-${r}`}
                      onChange={(e) =>
                        setRoles((cur) =>
                          e.target.checked ? [...cur, r] : cur.filter((x) => x !== r),
                        )
                      }
                    />
                    <span className="nv-radio-text">
                      <span id={`${formId}-${r}-label`}>{ROLE_LABEL[r]}</span>
                      <span id={`${formId}-${r}`} className="nv-field-hint">
                        {ROLE_HELP[r]}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {!roles.length ? (
                <p className="nv-field-error" role="alert">
                  Choose at least one.
                </p>
              ) : null}
              <p className="muted ws-flush">
                Next you get one command to run on the device. Creating it approves the device; it
                works once, for 15 minutes. The device then reports what it can do, and nothing is
                shared until you allow it.
              </p>
              {error ? (
                <div role="alert" className="ws-error">
                  <p>{deviceErrorMessage(error, 'Could not create the command.')}</p>
                </div>
              ) : null}
              <div className="row">
                <Button type="submit" variant="primary" disabled={!roles.length || busy}>
                  {busy ? <Spinner /> : null} Create command
                </Button>
                <Button onClick={() => navigate(DEVICES_PATH)}>Cancel</Button>
              </div>
            </form>
          ) : (
            <section className="stack" aria-label="Enrollment command">
              <p className="ws-flush">
                Run this on the device, in a terminal with administrator rights. novad installs as a
                service and registers with this Hub.
              </p>
              <pre className="ws-command">
                <code ref={commandRef}>{token.command}</code>
              </pre>
              {token.command.includes('<this-device>') ? (
                <p className="muted ws-flush">
                  Replace &lt;this-device&gt; with the address this Hub can reach the device at.
                </p>
              ) : null}
              <div className="row">
                <Button onClick={() => void copy()} disabled={expired}>
                  <Icon name="copy" /> Copy command
                </Button>
                {expired ? (
                  <Button variant="primary" onClick={() => void create()} disabled={busy}>
                    Create a new command
                  </Button>
                ) : null}
              </div>
              {expired ? (
                <p role="alert" className="nv-field-error">
                  This command has expired. Create a new one to add the device.
                </p>
              ) : (
                <div className="devices-waiting" role="status">
                  <Spinner />
                  <span>
                    Waiting for the device to register. The command expires in{' '}
                    <span role="timer">{formatCountdown(left)}</span>.
                  </span>
                </div>
              )}
              <div className="row">
                <Button onClick={() => void checkNow()} disabled={checking}>
                  {checking ? <Spinner /> : null} Check now
                </Button>
                <Button variant="ghost" onClick={() => navigate(DEVICES_PATH)}>
                  Back to devices
                </Button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
