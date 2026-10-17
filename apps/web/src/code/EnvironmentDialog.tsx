// New or edit a saved environment (FR-062, docs/10 §2): a container image and setup script; an
// SSH host, user and sign-in (the key or password is write-only: it goes to the keychain and is
// never shown again); a WSL distro on a Windows device; or a device running the Nova device
// agent. The Hub checks the same rules; this form explains them before a request fails.
import { useEffect, useId, useRef, useState } from 'react';
import type { z } from 'zod';
import {
  createEnvironmentSchema,
  type DeviceView,
  type SavedEnvironmentView,
  type WslDistroView,
} from '@nova/shared';
import { Button, Dialog, RadioGroup, SelectField, Spinner, TextField } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useCodeM6Api } from './api-m6.ts';
import { AppLink } from './CodeNav.tsx';
import { CREATABLE_KINDS, KIND_DESCRIPTION, KIND_LABEL, type CreatableKind } from './m6-format.ts';

type CreateBody = z.input<typeof createEnvironmentSchema>;

interface Draft {
  kind: CreatableKind;
  label: string;
  image: string;
  setupScript: string;
  host: string;
  port: string;
  user: string;
  auth: 'key' | 'password';
  privateKey: string;
  passphrase: string;
  password: string;
  hostKey: string;
  root: string;
  deviceId: string;
  distro: string;
}

const EMPTY: Draft = {
  kind: 'container',
  label: '',
  image: '',
  setupScript: '',
  host: '',
  port: '22',
  user: '',
  auth: 'key',
  privateKey: '',
  passphrase: '',
  password: '',
  hostKey: '',
  root: '',
  deviceId: '',
  distro: '',
};

function draftOf(e: SavedEnvironmentView): Draft {
  const c = e.connection;
  const d: Draft = { ...EMPTY, label: e.label };
  switch (c.kind) {
    case 'container':
      return { ...d, kind: 'container', image: c.image, setupScript: c.setupScript ?? '' };
    case 'ssh':
      return {
        ...d,
        kind: 'ssh',
        host: c.host,
        port: String(c.port),
        user: c.user,
        auth: c.auth,
        hostKey: c.hostKey ?? '',
        root: c.root ?? '',
      };
    case 'wsl':
      return { ...d, kind: 'wsl', deviceId: c.deviceId, distro: c.distro };
    case 'device':
      return { ...d, kind: 'device', deviceId: c.deviceId, root: c.root ?? '' };
    case 'local':
      return d;
  }
}

/** Friendly text for each field the schema can refuse. */
const FIELD_TEXT: Record<string, string> = {
  label: 'Enter a name, up to 100 characters.',
  image: 'Enter an image reference in lowercase, such as node:22 or ghcr.io/team/app:1.2.',
  setupScript: 'The setup script can be up to 20,000 characters.',
  host: 'Enter a host name or address.',
  port: 'Enter a port from 1 to 65535.',
  user: 'Enter a user name: letters, digits, dots, hyphens and underscores.',
  root: 'Enter a full path that starts with /.',
  hostKey: 'The host key can be up to 2,000 characters.',
  privateKey: 'Paste the private key.',
  password: 'Enter the password.',
  passphrase: 'The passphrase can be up to 1,000 characters.',
  deviceId: 'Choose a device.',
  distro: 'Enter a distro name: letters, digits, dots, hyphens and underscores.',
};

function connectionOf(d: Draft): CreateBody['connection'] {
  const opt = (v: string) => (v.trim() ? v.trim() : null);
  switch (d.kind) {
    case 'container':
      return { image: d.image.trim(), setupScript: d.setupScript.trim() ? d.setupScript : null };
    case 'ssh':
      return {
        host: d.host.trim(),
        port: Number(d.port),
        user: d.user.trim(),
        auth: d.auth,
        hostKey: opt(d.hostKey),
        root: opt(d.root),
      };
    case 'wsl':
      return { deviceId: d.deviceId, distro: d.distro.trim() };
    case 'device':
      return { deviceId: d.deviceId, root: opt(d.root) };
  }
}

function credentialOf(d: Draft): { privateKey?: string; passphrase?: string; password?: string } {
  if (d.auth === 'key')
    return {
      ...(d.privateKey ? { privateKey: d.privateKey } : {}),
      ...(d.passphrase ? { passphrase: d.passphrase } : {}),
    };
  return d.password ? { password: d.password } : {};
}

/** The create body, or the field errors the Hub would answer with. */
export function buildCreate(d: Draft): { body: CreateBody } | { errors: Record<string, string> } {
  const body = {
    kind: d.kind,
    label: d.label.trim(),
    connection: connectionOf(d),
    ...(d.kind === 'ssh' ? { credential: credentialOf(d) } : {}),
  } as CreateBody;
  const errors: Record<string, string> = {};
  const parsed = createEnvironmentSchema.safeParse(body);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const key = String(issue.path.at(-1) ?? 'label');
      errors[key] ??= FIELD_TEXT[key] ?? issue.message;
    }
  if (d.kind === 'ssh') {
    if (d.auth === 'key' && !d.privateKey) errors.privateKey = FIELD_TEXT.privateKey!;
    if (d.auth === 'password' && !d.password) errors.password = FIELD_TEXT.password!;
  }
  if ((d.kind === 'wsl' || d.kind === 'device') && !d.deviceId)
    errors.deviceId = FIELD_TEXT.deviceId!;
  return Object.keys(errors).length ? { errors } : { body };
}

export function EnvironmentDialog({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The environment to edit, or null for a new one. */
  editing: SavedEnvironmentView | null;
  onClose: () => void;
  onSaved: (e: SavedEnvironmentView, created: boolean) => void;
}) {
  return open ? <EnvironmentForm editing={editing} onClose={onClose} onSaved={onSaved} /> : null;
}

function EnvironmentForm({
  editing,
  onClose,
  onSaved,
}: {
  editing: SavedEnvironmentView | null;
  onClose: () => void;
  onSaved: (e: SavedEnvironmentView, created: boolean) => void;
}) {
  const m6 = useCodeM6Api();
  const id = `env${useId()}`;
  const first = useRef<HTMLInputElement>(null);
  const before = editing ? draftOf(editing) : null;
  const [d, setD] = useState<Draft>(before ?? EMPTY);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [distros, setDistros] = useState<{
    deviceId: string;
    items: WslDistroView[];
    error: string | null;
  } | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const needsDevice = d.kind === 'wsl' || d.kind === 'device';
  useEffect(() => {
    if (!needsDevice || devices !== null) return;
    let alive = true;
    m6.listEnvironmentDevices().then(
      ({ items }) => alive && setDevices(items),
      (err: unknown) => {
        if (!alive) return;
        setDevices([]);
        setDevicesError(errorMessage(err, 'Could not load the devices.'));
      },
    );
    return () => {
      alive = false;
    };
  }, [devices, m6, needsDevice]);

  // The distros a Windows device reports; typing a name stays possible when it cannot say.
  useEffect(() => {
    if (d.kind !== 'wsl' || !d.deviceId) return;
    let alive = true;
    m6.listWslDistros(d.deviceId).then(
      ({ items }) => alive && setDistros({ deviceId: d.deviceId, items, error: null }),
      (err: unknown) => {
        if (!alive) return;
        setDistros({
          deviceId: d.deviceId,
          items: [],
          error: errorMessage(err, 'Could not list the distros on that device.'),
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [d.deviceId, d.kind, m6]);

  const freshCredential = d.auth === 'key' ? !!d.privateKey : !!d.password;
  const built = buildCreate(
    editing && d.kind === 'ssh' && !freshCredential
      ? // Editing without a new credential: the stored one stays.
        { ...d, ...(d.auth === 'key' ? { privateKey: 'kept' } : { password: 'kept' }) }
      : d,
  );
  const sshIdentityChanged =
    !!editing &&
    d.kind === 'ssh' &&
    !!before &&
    (before.host !== d.host.trim() || before.user !== d.user.trim() || before.auth !== d.auth);
  // A new host, user or sign-in method must not reuse the old host's credential (the Hub's rule).
  const credentialMissing = sshIdentityChanged && !freshCredential;
  const errors: Record<string, string> = {
    ...(tried && 'errors' in built ? built.errors : {}),
    ...(tried && credentialMissing
      ? {
          [d.auth === 'key' ? 'privateKey' : 'password']:
            'A new host, user or sign-in method needs the key or password again.',
        }
      : {}),
  };
  const hasCredential =
    editing?.connection.kind === 'ssh' ? editing.connection.hasCredential : false;

  const submit = async () => {
    setTried(true);
    if ('errors' in built || credentialMissing || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        const cred = d.kind === 'ssh' ? credentialOf(d) : {};
        const saved = await m6.updateEnvironment(editing.id, {
          label: d.label.trim(),
          connection: connectionOf(d),
          ...(Object.keys(cred).length ? { credential: cred } : {}),
        });
        onSaved(saved, false);
      } else {
        onSaved(await m6.createEnvironment(built.body), true);
      }
    } catch (err) {
      setError(errorMessage(err, 'Could not save the environment.'));
      setBusy(false);
    }
  };

  const windows = (devices ?? []).filter((x) => /^win/i.test(x.platform ?? ''));
  const deviceChoices = d.kind === 'wsl' ? windows : (devices ?? []);
  const distroState = distros?.deviceId === d.deviceId ? distros : null;
  const distroList = distroState?.items ?? null;

  return (
    <Dialog
      open
      title={editing ? `Edit ${editing.label}` : 'New environment'}
      description={
        editing
          ? 'Changes reset its health until the next check.'
          : 'Saved environments can be picked for any new Code session.'
      }
      onClose={onClose}
      initialFocusRef={first}
    >
      <form
        id={id}
        className="stack code-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {editing ? null : (
          <RadioGroup
            legend="Kind"
            name={`${id}-kind`}
            value={d.kind}
            onChange={(v) => set('kind', v as CreatableKind)}
            options={CREATABLE_KINDS.map((k) => ({
              value: k,
              label: KIND_LABEL[k],
              description: KIND_DESCRIPTION[k],
            }))}
          />
        )}
        <TextField
          ref={first}
          label="Name"
          value={d.label}
          maxLength={100}
          autoComplete="off"
          required
          error={errors.label}
          onChange={(e) => set('label', e.target.value)}
        />

        {d.kind === 'container' ? (
          <>
            <TextField
              label="Container image"
              value={d.image}
              required
              autoComplete="off"
              spellCheck={false}
              placeholder="node:22"
              hint="Commands of the session run in this image, with the session folder mounted."
              error={errors.image}
              onChange={(e) => set('image', e.target.value)}
            />
            <TextArea
              id={`${id}-setup`}
              label="Setup script (optional)"
              value={d.setupScript}
              maxLength={20_000}
              hint="Runs once in the session folder when a session starts, for example npm ci."
              error={errors.setupScript}
              onChange={(v) => set('setupScript', v)}
            />
          </>
        ) : null}

        {d.kind === 'ssh' ? (
          <>
            <div className="code-form-row">
              <TextField
                label="Host"
                value={d.host}
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="build.example.com"
                error={errors.host}
                onChange={(e) => set('host', e.target.value)}
              />
              <TextField
                label="Port"
                type="number"
                inputMode="numeric"
                className="ws-number"
                min={1}
                max={65_535}
                value={d.port}
                error={errors.port}
                onChange={(e) => set('port', e.target.value)}
              />
            </div>
            <TextField
              label="User"
              value={d.user}
              required
              autoComplete="off"
              spellCheck={false}
              error={errors.user}
              onChange={(e) => set('user', e.target.value)}
            />
            <RadioGroup
              legend="Sign in with"
              name={`${id}-auth`}
              value={d.auth}
              onChange={(v) => set('auth', v as Draft['auth'])}
              options={[
                { value: 'key', label: 'A private key' },
                { value: 'password', label: 'A password' },
              ]}
              hint="Stored in the keychain on the Hub. It is never shown again."
            />
            {editing ? (
              <p className="muted" id={`${id}-cred`}>
                {hasCredential
                  ? `A ${editing.connection.kind === 'ssh' && editing.connection.auth === 'password' ? 'password' : 'key'} is set. Leave the fields below empty to keep it.`
                  : 'No key or password is set.'}{' '}
                Changing the host, user or sign-in method needs them again.
              </p>
            ) : null}
            {d.auth === 'key' ? (
              <>
                <TextArea
                  id={`${id}-key`}
                  label={editing ? 'Replace the private key' : 'Private key'}
                  value={d.privateKey}
                  maxLength={20_000}
                  secret
                  error={errors.privateKey}
                  onChange={(v) => set('privateKey', v)}
                />
                <TextField
                  label="Key passphrase (optional)"
                  type="password"
                  autoComplete="off"
                  value={d.passphrase}
                  error={errors.passphrase}
                  onChange={(e) => set('passphrase', e.target.value)}
                />
              </>
            ) : (
              <TextField
                label={editing ? 'Replace the password' : 'Password'}
                type="password"
                autoComplete="new-password"
                value={d.password}
                error={errors.password}
                onChange={(e) => set('password', e.target.value)}
              />
            )}
            <TextArea
              id={`${id}-hostkey`}
              label="Host key (optional)"
              value={d.hostKey}
              maxLength={2000}
              hint="The host's public key, to refuse a different machine at that address."
              error={errors.hostKey}
              onChange={(v) => set('hostKey', v)}
            />
            <TextField
              label="Folder for sessions (optional)"
              value={d.root}
              autoComplete="off"
              spellCheck={false}
              placeholder="/home/me/projects"
              hint="Sessions may work in this folder. Without it, your home folder on the host."
              error={errors.root}
              onChange={(e) => set('root', e.target.value)}
            />
          </>
        ) : null}

        {needsDevice ? (
          devices === null ? (
            <p className="muted">
              <Spinner label="Loading the devices" /> Loading devices…
            </p>
          ) : deviceChoices.length ? (
            <SelectField
              label="Device"
              value={d.deviceId}
              onChange={(v) => setD((x) => ({ ...x, deviceId: v, distro: '' }))}
              options={[
                { value: '', label: 'Choose a device' },
                ...deviceChoices.map((x) => ({
                  value: x.id,
                  label: x.status === 'active' ? x.name : `${x.name} (${deviceState(x)})`,
                  disabled: x.status === 'revoked',
                })),
              ]}
              error={errors.deviceId}
            />
          ) : (
            <p className="ws-warning" role="note">
              {devicesError ??
                (d.kind === 'wsl'
                  ? 'No Windows device runs the Nova device agent yet.'
                  : 'No device runs the Nova device agent yet.')}{' '}
              <AppLink to="/settings/devices">Add a device in Settings → Devices</AppLink>
            </p>
          )
        ) : null}

        {d.kind === 'wsl' && d.deviceId ? (
          distroList?.length ? (
            <SelectField
              label="Distro"
              value={d.distro}
              onChange={(v) => set('distro', v)}
              options={[
                { value: '', label: 'Choose a distro' },
                ...distroList.map((x) => ({
                  value: x.name,
                  label: `${x.name}${x.default ? ' (default)' : ''}${x.version ? `, WSL ${x.version}` : ''}`,
                })),
              ]}
              error={errors.distro}
            />
          ) : (
            <TextField
              label="Distro"
              value={d.distro}
              autoComplete="off"
              spellCheck={false}
              placeholder="Ubuntu"
              hint={
                distroState?.error ??
                (distroList ? 'The device listed no distros; type the name.' : undefined)
              }
              error={errors.distro}
              onChange={(e) => set('distro', e.target.value)}
            />
          )
        ) : null}

        {d.kind === 'device' ? (
          <TextField
            label="Folder for sessions (optional)"
            value={d.root}
            autoComplete="off"
            spellCheck={false}
            hint="Sessions work only where the device's grants allow."
            error={errors.root}
            onChange={(e) => set('root', e.target.value)}
          />
        ) : null}

        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {editing ? 'Save' : 'Create environment'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function deviceState(x: DeviceView): string {
  if (x.status === 'unreachable') return 'offline';
  if (x.status === 'pending') return 'not set up yet';
  if (x.status === 'revoked') return 'revoked';
  return x.status;
}

/** A labelled textarea in the field style; a secret one is never filled from a saved value. */
function TextArea({
  id,
  label,
  value,
  maxLength,
  hint,
  error,
  secret,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  hint?: string;
  error?: string;
  secret?: boolean;
  onChange: (v: string) => void;
}) {
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-err` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="nv-field">
      <label className="nv-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="nv-input ws-textarea code-mono"
        rows={secret ? 4 : 3}
        maxLength={maxLength}
        spellCheck={false}
        autoComplete="off"
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? (
        <span id={`${id}-hint`} className="nv-field-hint">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-err`} className="nv-field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
