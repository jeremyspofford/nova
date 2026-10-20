// Adding or editing a BMC (FR-147; docs/23 §7): its name, kind (Redfish or IPMI; Intel AMT is shown
// as not available), address and port, the Redfish system when the BMC manages several, the
// device it belongs to, and its user name and password, which go to the Hub's vault and are never
// shown again (on edit they are replaced only when asked). A Redfish certificate fingerprint may
// be entered up front (it is then confirmed); otherwise the first check reads the certificate the
// BMC presents, without credentials, for the owner to confirm.
// Refusals keep the form and say what to fix. Also: entering a new fingerprint after a mismatch.
import { useEffect, useId, useRef, useState } from 'react';
import type { DeviceSummaryView, OobEndpointView, OobKind } from '@nova/shared';
import { Button, Dialog, SelectField, Spinner, TextField } from '@nova/ui';
import { defineMessages } from '@nova/i18n';
import { useServices } from '../services.tsx';
import { PARTS_TEXT } from '../devices/parts.tsx';
import type { OobApi } from './api-m75.ts';
import {
  DEFAULT_PORT,
  KIND_HELP,
  KIND_LABEL,
  OOB_TEXT,
  normalizePin,
  oobErrorMessage,
} from './format.ts';

export const ENDPOINT_FORM_TEXT = defineMessages('oob.form', {
  errors: {
    name: 'Enter a name.',
    address: 'Enter the BMC’s host name or IP address.',
    addressSpaces: 'The address cannot contain spaces.',
    port: 'Enter a port from 1 to 65535.',
    systemId: 'Letters, digits, dot, dash and underscore only.',
    username: 'Enter the BMC user name.',
    usernameBad: 'At most {n, plural, one {# character} other {# characters}}, with no colon.',
    password: 'Enter the password.',
    passwordLong: 'At most {n, plural, one {# character} other {# characters}}.',
    pin: 'Enter the SHA-256 fingerprint: 64 hexadecimal digits, colons allowed.',
  },
  addTitle: 'Add a BMC',
  editTitle: 'Edit {name}',
  addDescription:
    "A BMC is the management controller built into a server or a business computer. The Hub talks to it directly, never through the machine's operating system.",
  editDescription:
    'Saving withdraws its approvals still waiting and its approved BIOS plans: an approval names the BMC as it was.',
  editForm: 'Edit the BMC',
  name: 'Name',
  namePlaceholder: 'Rack server BMC',
  kind: 'Kind',
  address: 'Address',
  addressExample: 'bmc.lan or https://10.0.0.20',
  addressHintRedfish: 'A host name or IP address; https:// with a port also works.',
  addressHint: 'A host name or IP address.',
  addressHintRepin: 'A new address is another BMC: its certificate is pinned again.',
  port: 'Port',
  portHint: 'Blank for {port}.',
  systemId: 'System id',
  systemIdHint: 'Only when the BMC manages several systems. Blank picks its only one.',
  device: 'Device',
  deviceHint: 'The machine this BMC manages, so its page offers these actions.',
  noDevice: 'No device',
  unlistedDevice: 'A device not listed',
  credentials: 'Credentials',
  replace: 'Replace the user name and password',
  replaceKeep: 'The stored ones are never shown. Leave this off to keep them.',
  replaceNone: 'The Hub has none stored for this BMC: enter them again.',
  username: 'User name',
  password: 'Password',
  passwordHint: "Kept in the Hub's vault. Nova never shows it again.",
  pin: 'Certificate fingerprint (SHA-256)',
  pinPlaceholder: 'Blank: confirm it after the first check',
  pinHint:
    "Optional. From the BMC's own certificate page; entering it confirms it. Blank: the first check reads the certificate without credentials and you confirm its fingerprint, like an SSH host key. A different certificate later is refused.",
  addFailed: 'Could not add the BMC.',
  saveFailed: 'Could not save.',
  add: 'Add BMC',
  save: 'Save',
  repin: {
    title: 'Pin a new certificate for {name}',
    description:
      "Read the fingerprint on the BMC's own certificate page (or its console), not from this network. Only that certificate will be accepted from now on.",
    label: 'New certificate fingerprint (SHA-256)',
    failed: 'Could not pin it.',
    save: 'Pin this certificate',
  },
});

const S = ENDPOINT_FORM_TEXT;

const SYSTEM_ID = /^[A-Za-z0-9._-]{1,100}$/;
// HTTP Basic and ipmitool take no colon or control characters in a user name.
// eslint-disable-next-line no-control-regex
const BAD_USER = /[:\u0000-\u001f\u007f]/;
const MAX_USER = 64;
const MAX_PASSWORD = 256;

interface Draft {
  name: string;
  kind: OobKind;
  address: string;
  port: string;
  systemId: string;
  deviceId: string;
  username: string;
  password: string;
  replaceCredentials: boolean;
  tlsPin: string;
}

type Errors = Partial<Record<keyof Draft, string>>;

function draftOf(ep: OobEndpointView | null, deviceId: string | null): Draft {
  return {
    name: ep?.name ?? '',
    kind: ep?.kind ?? 'redfish',
    address: ep?.address ?? '',
    port: ep?.port ? String(ep.port) : '',
    systemId: ep?.systemId ?? '',
    deviceId: ep?.deviceId ?? deviceId ?? '',
    username: '',
    password: '',
    replaceCredentials: ep === null,
    tlsPin: '',
  };
}

/** The problems with a draft, by field. */
export function endpointDraftErrors(d: Draft, creating: boolean): Errors {
  const e: Errors = {};
  const E = S.errors;
  if (!d.name.trim()) e.name = E.name;
  if (!d.address.trim()) e.address = E.address;
  else if (/\s/.test(d.address.trim())) e.address = E.addressSpaces;
  else if (d.address.includes('@')) e.address = OOB_TEXT.reasons.credentials_in_address;
  if (d.port.trim()) {
    const n = Number(d.port.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) e.port = E.port;
  }
  if (d.kind === 'redfish' && d.systemId.trim() && !SYSTEM_ID.test(d.systemId.trim()))
    e.systemId = E.systemId;
  if (creating || d.replaceCredentials) {
    if (!d.username) e.username = E.username;
    else if (d.username.length > MAX_USER || BAD_USER.test(d.username))
      e.username = E.usernameBad({ n: MAX_USER });
    if (!d.password) e.password = E.password;
    else if (d.password.length > MAX_PASSWORD) e.password = E.passwordLong({ n: MAX_PASSWORD });
  }
  if (creating && d.kind === 'redfish' && d.tlsPin.trim() && !normalizePin(d.tlsPin))
    e.tlsPin = E.pin;
  return e;
}

export function EndpointDialog({
  api,
  endpoint,
  deviceId = null,
  onClose,
  onSaved,
}: {
  api: OobApi;
  /** The BMC to edit, or null to add one. */
  endpoint: OobEndpointView | null;
  /** The device to link a new BMC to (from a device's page). */
  deviceId?: string | null;
  onClose: () => void;
  onSaved: (ep: OobEndpointView) => void;
}) {
  const { api: hub } = useServices();
  const base = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const creating = endpoint === null;
  const [draft, setDraft] = useState<Draft>(() => draftOf(endpoint, deviceId));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceSummaryView[] | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  // The devices a BMC can belong to (when the client can list them).
  useEffect(() => {
    const list = (
      hub as unknown as { listAllDevices?: () => Promise<{ items: DeviceSummaryView[] }> }
    ).listAllDevices;
    if (typeof list !== 'function') return;
    let alive = true;
    list().then(
      (r) => alive && setDevices(r.items.filter((x) => x.status !== 'revoked' && x.kind !== 'hub')),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [hub]);

  const save = async () => {
    const found = endpointDraftErrors(draft, creating);
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    setError(null);
    const port = draft.port.trim() ? Number(draft.port.trim()) : null;
    const pin = draft.tlsPin.trim() ? normalizePin(draft.tlsPin) : null;
    const credentials = { username: draft.username, password: draft.password };
    try {
      let saved: OobEndpointView;
      if (creating) {
        saved = await api.createOobEndpoint({
          name: draft.name.trim(),
          kind: draft.kind,
          address: draft.address.trim(),
          ...(port ? { port } : {}),
          ...(draft.kind === 'redfish' && draft.systemId.trim()
            ? { systemId: draft.systemId.trim() }
            : {}),
          credentials,
          deviceId: draft.deviceId || null,
          ...(draft.kind === 'redfish' && pin ? { tlsPin: pin } : {}),
        });
      } else {
        const ep = endpoint;
        const patch: Parameters<OobApi['updateOobEndpoint']>[1] = {};
        if (draft.name.trim() !== ep.name) patch.name = draft.name.trim();
        if (draft.address.trim() !== ep.address) patch.address = draft.address.trim();
        if (port !== ep.port) patch.port = port;
        if (ep.kind === 'redfish' && (draft.systemId.trim() || null) !== ep.systemId)
          patch.systemId = draft.systemId.trim() || null;
        if ((draft.deviceId || null) !== ep.deviceId) patch.deviceId = draft.deviceId || null;
        if (draft.replaceCredentials) patch.credentials = credentials;
        saved = Object.keys(patch).length ? await api.updateOobEndpoint(ep.id, patch) : ep;
      }
      onSaved(saved);
    } catch (err) {
      setError(oobErrorMessage(err, creating ? S.addFailed : S.saveFailed));
      setBusy(false);
    }
  };

  const kind = draft.kind;
  return (
    <Dialog
      open
      title={creating ? S.addTitle : S.editTitle({ name: endpoint.name })}
      description={creating ? S.addDescription : S.editDescription}
      onClose={onClose}
      initialFocusRef={nameRef}
      className="oob-dialog"
    >
      <form
        className="stack"
        aria-label={creating ? S.addTitle : S.editForm}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          ref={nameRef}
          label={S.name}
          value={draft.name}
          maxLength={100}
          dir="auto"
          placeholder={S.namePlaceholder}
          error={errors.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        {creating ? (
          <fieldset className="nv-radios">
            <legend className="nv-field-label">{S.kind}</legend>
            {(['redfish', 'ipmi', 'amt'] as const).map((k) => (
              <label key={k} className="nv-radio">
                <input
                  type="radio"
                  name={`${base}-kind`}
                  value={k}
                  checked={kind === k}
                  disabled={k === 'amt'}
                  aria-describedby={`${base}-kind-${k}`}
                  onChange={() => set({ kind: k })}
                />
                <span className="nv-radio-text">
                  <span>{KIND_LABEL[k]}</span>
                  <span id={`${base}-kind-${k}`} className="nv-field-hint">
                    {KIND_HELP[k]}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="devices-fields">
          <TextField
            label={S.address}
            value={draft.address}
            maxLength={300}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            placeholder={kind === 'redfish' ? S.addressExample : '10.0.0.20'}
            hint={[
              kind === 'redfish' ? S.addressHintRedfish : S.addressHint,
              !creating && kind === 'redfish' ? S.addressHintRepin : '',
            ]
              .filter(Boolean)
              .join(' ')}
            error={errors.address}
            onChange={(e) => set({ address: e.target.value })}
          />
          <TextField
            label={S.port}
            value={draft.port}
            inputMode="numeric"
            className="ws-number"
            placeholder={String(DEFAULT_PORT[kind])}
            hint={S.portHint({ port: String(DEFAULT_PORT[kind]) })}
            error={errors.port}
            onChange={(e) => set({ port: e.target.value })}
          />
        </div>
        {kind === 'redfish' ? (
          <TextField
            label={S.systemId}
            value={draft.systemId}
            maxLength={100}
            spellCheck={false}
            dir="ltr"
            hint={S.systemIdHint}
            error={errors.systemId}
            onChange={(e) => set({ systemId: e.target.value })}
          />
        ) : null}
        {devices ? (
          <SelectField
            label={S.device}
            value={draft.deviceId}
            onChange={(v) => set({ deviceId: v })}
            hint={S.deviceHint}
            options={[
              { value: '', label: S.noDevice },
              ...devices.map((d) => ({ value: d.id, label: d.name })),
              ...(draft.deviceId && !devices.some((d) => d.id === draft.deviceId)
                ? [{ value: draft.deviceId, label: S.unlistedDevice }]
                : []),
            ]}
          />
        ) : null}
        <fieldset className="ws-fieldset">
          <legend>{S.credentials}</legend>
          {!creating ? (
            <label className="nv-radio">
              <input
                type="checkbox"
                checked={draft.replaceCredentials}
                onChange={(e) => set({ replaceCredentials: e.target.checked })}
              />
              <span className="nv-radio-text">
                <span>{S.replace}</span>
                <span className="nv-field-hint">
                  {endpoint.hasCredentials ? S.replaceKeep : S.replaceNone}
                </span>
              </span>
            </label>
          ) : null}
          {draft.replaceCredentials ? (
            <div className="devices-fields">
              <TextField
                label={S.username}
                value={draft.username}
                autoComplete="off"
                spellCheck={false}
                error={errors.username}
                onChange={(e) => set({ username: e.target.value })}
              />
              <TextField
                label={S.password}
                type="password"
                value={draft.password}
                autoComplete="new-password"
                hint={S.passwordHint}
                error={errors.password}
                onChange={(e) => set({ password: e.target.value })}
              />
            </div>
          ) : null}
        </fieldset>
        {kind === 'redfish' && creating ? (
          <TextField
            label={S.pin}
            value={draft.tlsPin}
            spellCheck={false}
            autoComplete="off"
            dir="ltr"
            placeholder={S.pinPlaceholder}
            hint={S.pinHint}
            error={errors.tlsPin}
            onChange={(e) => set({ tlsPin: e.target.value })}
          />
        ) : null}
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{PARTS_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {creating ? S.add : S.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** After a mismatch: pin the fingerprint the owner read on the BMC itself. */
export function RepinDialog({
  api,
  endpoint,
  onClose,
  onSaved,
}: {
  api: OobApi;
  endpoint: OobEndpointView;
  onClose: () => void;
  onSaved: (ep: OobEndpointView) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const pin = normalizePin(text);
    if (!pin) {
      setError(S.errors.pin);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateOobEndpoint(endpoint.id, { tlsPin: pin }));
    } catch (err) {
      setError(oobErrorMessage(err, S.repin.failed));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={S.repin.title({ name: endpoint.name })}
      description={S.repin.description}
      onClose={onClose}
      initialFocusRef={ref}
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          ref={ref}
          label={S.repin.label}
          value={text}
          spellCheck={false}
          autoComplete="off"
          dir="ltr"
          error={error ?? undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{PARTS_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {S.repin.save}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
