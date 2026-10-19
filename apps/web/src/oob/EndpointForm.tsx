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
import { useServices } from '../services.tsx';
import type { OobApi } from './api-m75.ts';
import { DEFAULT_PORT, KIND_HELP, KIND_LABEL, normalizePin, oobErrorMessage } from './format.ts';

const SYSTEM_ID = /^[A-Za-z0-9._-]{1,100}$/;
// HTTP Basic and ipmitool take no colon or control characters in a user name.
// eslint-disable-next-line no-control-regex
const BAD_USER = /[:\u0000-\u001f\u007f]/;

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
  if (!d.name.trim()) e.name = 'Enter a name.';
  if (!d.address.trim()) e.address = 'Enter the BMC’s host name or IP address.';
  else if (/\s/.test(d.address.trim())) e.address = 'The address cannot contain spaces.';
  else if (d.address.includes('@'))
    e.address = 'Put the user name and password in their own fields, never in the address.';
  if (d.port.trim()) {
    const n = Number(d.port.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) e.port = 'Enter a port from 1 to 65535.';
  }
  if (d.kind === 'redfish' && d.systemId.trim() && !SYSTEM_ID.test(d.systemId.trim()))
    e.systemId = 'Letters, digits, dot, dash and underscore only.';
  if (creating || d.replaceCredentials) {
    if (!d.username) e.username = 'Enter the BMC user name.';
    else if (d.username.length > 64 || BAD_USER.test(d.username))
      e.username = 'At most 64 characters, with no colon.';
    if (!d.password) e.password = 'Enter the password.';
    else if (d.password.length > 256) e.password = 'At most 256 characters.';
  }
  if (creating && d.kind === 'redfish' && d.tlsPin.trim() && !normalizePin(d.tlsPin))
    e.tlsPin = 'Enter the SHA-256 fingerprint: 64 hexadecimal digits, colons allowed.';
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
      setError(oobErrorMessage(err, creating ? 'Could not add the BMC.' : 'Could not save.'));
      setBusy(false);
    }
  };

  const kind = draft.kind;
  return (
    <Dialog
      open
      title={creating ? 'Add a BMC' : `Edit ${endpoint.name}`}
      description={
        creating
          ? "A BMC is the management controller built into a server or a business computer. The Hub talks to it directly, never through the machine's operating system."
          : 'Saving withdraws its approvals still waiting and its approved BIOS plans: an approval names the BMC as it was.'
      }
      onClose={onClose}
      initialFocusRef={nameRef}
      className="oob-dialog"
    >
      <form
        className="stack"
        aria-label={creating ? 'Add a BMC' : 'Edit the BMC'}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          ref={nameRef}
          label="Name"
          value={draft.name}
          maxLength={100}
          placeholder="Rack server BMC"
          error={errors.name}
          onChange={(e) => set({ name: e.target.value })}
        />
        {creating ? (
          <fieldset className="nv-radios">
            <legend className="nv-field-label">Kind</legend>
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
            label="Address"
            value={draft.address}
            maxLength={300}
            autoComplete="off"
            spellCheck={false}
            placeholder={kind === 'redfish' ? 'bmc.lan or https://10.0.0.20' : '10.0.0.20'}
            hint={[
              kind === 'redfish'
                ? 'A host name or IP address; https:// with a port also works.'
                : 'A host name or IP address.',
              !creating && kind === 'redfish'
                ? 'A new address is another BMC: its certificate is pinned again.'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            error={errors.address}
            onChange={(e) => set({ address: e.target.value })}
          />
          <TextField
            label="Port"
            value={draft.port}
            inputMode="numeric"
            className="ws-number"
            placeholder={String(DEFAULT_PORT[kind])}
            hint={`Blank for ${DEFAULT_PORT[kind]}.`}
            error={errors.port}
            onChange={(e) => set({ port: e.target.value })}
          />
        </div>
        {kind === 'redfish' ? (
          <TextField
            label="System id"
            value={draft.systemId}
            maxLength={100}
            spellCheck={false}
            hint="Only when the BMC manages several systems. Blank picks its only one."
            error={errors.systemId}
            onChange={(e) => set({ systemId: e.target.value })}
          />
        ) : null}
        {devices ? (
          <SelectField
            label="Device"
            value={draft.deviceId}
            onChange={(v) => set({ deviceId: v })}
            hint="The machine this BMC manages, so its page offers these actions."
            options={[
              { value: '', label: 'No device' },
              ...devices.map((d) => ({ value: d.id, label: d.name })),
              ...(draft.deviceId && !devices.some((d) => d.id === draft.deviceId)
                ? [{ value: draft.deviceId, label: 'A device not listed' }]
                : []),
            ]}
          />
        ) : null}
        <fieldset className="ws-fieldset">
          <legend>Credentials</legend>
          {!creating ? (
            <label className="nv-radio">
              <input
                type="checkbox"
                checked={draft.replaceCredentials}
                onChange={(e) => set({ replaceCredentials: e.target.checked })}
              />
              <span className="nv-radio-text">
                <span>Replace the user name and password</span>
                <span className="nv-field-hint">
                  {endpoint.hasCredentials
                    ? 'The stored ones are never shown. Leave this off to keep them.'
                    : 'The Hub has none stored for this BMC: enter them again.'}
                </span>
              </span>
            </label>
          ) : null}
          {draft.replaceCredentials ? (
            <div className="devices-fields">
              <TextField
                label="User name"
                value={draft.username}
                autoComplete="off"
                spellCheck={false}
                error={errors.username}
                onChange={(e) => set({ username: e.target.value })}
              />
              <TextField
                label="Password"
                type="password"
                value={draft.password}
                autoComplete="new-password"
                hint="Kept in the Hub's vault. Nova never shows it again."
                error={errors.password}
                onChange={(e) => set({ password: e.target.value })}
              />
            </div>
          ) : null}
        </fieldset>
        {kind === 'redfish' && creating ? (
          <TextField
            label="Certificate fingerprint (SHA-256)"
            value={draft.tlsPin}
            spellCheck={false}
            autoComplete="off"
            placeholder="Blank: confirm it after the first check"
            hint="Optional. From the BMC's own certificate page; entering it confirms it. Blank: the first check reads the certificate without credentials and you confirm its fingerprint, like an SSH host key. A different certificate later is refused."
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
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {creating ? 'Add BMC' : 'Save'}
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
      setError('Enter the SHA-256 fingerprint: 64 hexadecimal digits, colons allowed.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.updateOobEndpoint(endpoint.id, { tlsPin: pin }));
    } catch (err) {
      setError(oobErrorMessage(err, 'Could not pin it.'));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Pin a new certificate for ${endpoint.name}`}
      description="Read the fingerprint on the BMC's own certificate page (or its console), not from this network. Only that certificate will be accepted from now on."
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
          label="New certificate fingerprint (SHA-256)"
          value={text}
          spellCheck={false}
          autoComplete="off"
          error={error ?? undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} Pin this certificate
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
