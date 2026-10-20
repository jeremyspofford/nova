// Add a device with a one-use command (docs/23 §2, ADR-089), the scripted path kept from M6 for
// installs that cannot show a code: choose its roles, create the command (creating it is the
// owner's approval), run it on the device, and watch for the device to register
// (`device.registered`); then the success screen links to its page. The command works once, for
// 15 minutes; an expired one is replaced with a click. `/devices/add?method=command`.
import { useEffect, useId, useRef, useState } from 'react';
import { DEVICE_ENROLL_ROLES, type DeviceEnrollToken, type DeviceView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { rich } from '../i18n/rich.tsx';
import { formatCountdown } from '../settings/DevicesPage.tsx';
import { useInterval } from '../settings/common.ts';
import { navigate } from '../router.ts';
import { useAnnounce } from '../services.tsx';
import { followLink } from '../work/nav.tsx';
import { useDevicesApi } from './api.ts';
import { eventDeviceId, useDeviceEvents } from './events.ts';
import {
  DEVICES_ADD_PATH,
  DEVICES_PATH,
  ROLE_LABEL,
  deviceErrorMessage,
  devicePath,
  rolesText,
} from './format.ts';
import { useCopy } from './parts.tsx';

type Role = (typeof DEVICE_ENROLL_ROLES)[number];

/** What the success screen shows about the new device. */
type Added = Pick<DeviceView, 'id' | 'name' | 'roles' | 'novadVersion'>;

export const ENROLL_TEXT = defineMessages('devices.enroll', {
  roleHelp: {
    client:
      'A computer you use. Agents can work with its files, browser and screen when you allow it.',
    compute: 'Runs models and other heavy work for this Hub.',
    'wake-helper': 'Always on, on the same network as the others, so it can wake them.',
  },
  ready: 'Command ready. Run it on the device.',
  added: '{name} is added.',
  theDevice: 'The device',
  notYet: 'Not registered yet.',
  checkFailed: 'Could not check.',
  addedTitle: '{name} is added',
  rolesSentence: '{roles}.',
  novadSentence: 'novad {version}.',
  openHint: 'Open it to choose which folders it shares and what it may run.',
  open: 'Open {name}',
  another: 'Add another device',
  title: 'Add a device',
  intro: 'A one-use command, for installs you script. {link}.',
  withCode: 'Add it with a code instead',
  roles: 'What will this device do?',
  chooseOne: 'Choose at least one.',
  next: 'Next you get one command to run on the device. Creating it approves the device; it works once, for 15 minutes. The device then reports what it can do, and nothing is shared until you allow it.',
  createFailed: 'Could not create the command.',
  create: 'Create command',
  cancel: 'Cancel',
  command: 'Enrollment command',
  run: 'Run this on the device, in a terminal with administrator rights. novad installs as a service and registers with this Hub.',
  replace: 'Replace {token} with the address this Hub can reach the device at.',
  copy: 'Copy command',
  createNew: 'Create a new command',
  expired: 'This command has expired. Create a new one to add the device.',
  waiting: 'Waiting for the device to register. The command expires in {time}.',
  checkNow: 'Check now',
  back: 'Back to devices',
});
const S = ENROLL_TEXT;

const ROLE_HELP: Readonly<Record<Role, string>> = S.roleHelp;

export function EnrollCommand() {
  const api = useDevicesApi();
  const toast = useToast();
  const announce = useAnnounce();
  const copy = useCopy();
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
      announce(S.ready);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const found = (d: Added) => {
    setAdded(d);
    announce(S.added({ name: d.name }));
  };

  // The device registers on its own; the Hub tells every open client.
  useDeviceEvents(['device.registered'], (env) => {
    if (!token || added) return;
    const id = eventDeviceId(env);
    if (!id) return;
    api.getNovadDevice(id).then(found, () => {
      const name = typeof env.payload.name === 'string' ? env.payload.name : S.theDevice;
      found({ id, name, roles: [], novadVersion: null });
    });
  });

  const checkNow = async () => {
    setChecking(true);
    try {
      const { items } = await api.listNovadDevices();
      const fresh = items.find((d) => !known.current?.has(d.id) && d.status !== 'revoked');
      if (fresh) found(fresh);
      else announce(S.notYet);
    } catch (err) {
      toast.show(deviceErrorMessage(err, S.checkFailed), { tone: 'error' });
    } finally {
      setChecking(false);
    }
  };

  const restart = () => {
    setToken(null);
    setAdded(null);
    setError(null);
    known.current = null;
  };

  if (added) {
    return (
      <section className="devices-success" aria-labelledby={`${formId}-done`}>
        <h1 id={`${formId}-done`} ref={headingRef} tabIndex={-1}>
          <Icon name="check" /> {S.addedTitle({ name: added.name })}
        </h1>
        <p className="muted ws-flush">
          {added.roles.length ? `${S.rolesSentence({ roles: rolesText(added.roles) })} ` : ''}
          {added.novadVersion ? `${S.novadSentence({ version: added.novadVersion })} ` : ''}
          {S.openHint}
        </p>
        <div className="row">
          <Button variant="primary" onClick={() => navigate(devicePath(added.id))}>
            {S.open({ name: added.name })}
          </Button>
          <Button onClick={restart}>{S.another}</Button>
        </div>
      </section>
    );
  }

  return (
    <>
      <header className="ws-page-header">
        <h1>{S.title}</h1>
      </header>
      <p className="muted ws-flush">
        {rich(S.intro, {
          link: (
            <a href={DEVICES_ADD_PATH} onClick={(e) => followLink(e, DEVICES_ADD_PATH)}>
              {S.withCode}
            </a>
          ),
        })}
      </p>
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
            <legend>{S.roles}</legend>
            {DEVICE_ENROLL_ROLES.map((r) => (
              <label key={r} className="nv-radio">
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  aria-labelledby={`${formId}-${r}-label`}
                  aria-describedby={`${formId}-${r}`}
                  onChange={(e) =>
                    setRoles((cur) => (e.target.checked ? [...cur, r] : cur.filter((x) => x !== r)))
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
              {S.chooseOne}
            </p>
          ) : null}
          <p className="muted ws-flush">{S.next}</p>
          {error ? (
            <div role="alert" className="ws-error">
              <p>{deviceErrorMessage(error, S.createFailed)}</p>
            </div>
          ) : null}
          <div className="row">
            <Button type="submit" variant="primary" disabled={!roles.length || busy}>
              {busy ? <Spinner /> : null} {S.create}
            </Button>
            <Button onClick={() => navigate(DEVICES_PATH)}>{S.cancel}</Button>
          </div>
        </form>
      ) : (
        <section className="stack" aria-label={S.command}>
          <p className="ws-flush">{S.run}</p>
          <pre className="ws-command" dir="ltr">
            <code ref={commandRef}>{token.command}</code>
          </pre>
          {token.command.includes('<this-device>') ? (
            <p className="muted ws-flush">{S.replace({ token: '<this-device>' })}</p>
          ) : null}
          <div className="row">
            <Button
              onClick={() => void copy(token.command, commandRef.current, 'command')}
              disabled={expired}
            >
              <Icon name="copy" /> {S.copy}
            </Button>
            {expired ? (
              <Button variant="primary" onClick={() => void create()} disabled={busy}>
                {S.createNew}
              </Button>
            ) : null}
          </div>
          {expired ? (
            <p role="alert" className="nv-field-error">
              {S.expired}
            </p>
          ) : (
            <div className="devices-waiting" role="status">
              <Spinner />
              <span>
                {rich(S.waiting, { time: <span role="timer">{formatCountdown(left)}</span> })}
              </span>
            </div>
          )}
          <div className="row">
            <Button onClick={() => void checkNow()} disabled={checking}>
              {checking ? <Spinner /> : null} {S.checkNow}
            </Button>
            <Button variant="ghost" onClick={() => navigate(DEVICES_PATH)}>
              {S.back}
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
