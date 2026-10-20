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
import { defineMessages, messageFor } from '@nova/i18n';
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
    // A cloud environment is managed on its own page (CloudEnvironmentDialog), not here.
    case 'local':
    case 'cloud':
      return d;
  }
}

export const ENV_DIALOG_TEXT = defineMessages('code.envDialog', {
  devicesFailed: 'Could not load the devices.',
  distrosFailed: 'Could not list the distros on that device.',
  credentialAgain: 'A new host, user or sign-in method needs the key or password again.',
  saveFailed: 'Could not save the environment.',
  editTitle: 'Edit {name}',
  newTitle: 'New environment',
  editBody: 'Changes reset its health until the next check.',
  newBody: 'Saved environments can be picked for any new Code session.',
  kind: 'Kind',
  name: 'Name',
  image: 'Container image',
  imageExample: 'node:22',
  imageHint: 'Commands of the session run in this image, with the session folder mounted.',
  setup: 'Setup script (optional)',
  setupHint: 'Runs once in the session folder when a session starts, for example npm ci.',
  host: 'Host',
  hostExample: 'build.example.com',
  port: 'Port',
  user: 'User',
  signIn: 'Sign in with',
  aKey: 'A private key',
  aPassword: 'A password',
  signInHint: 'Stored in the keychain on the Hub. It is never shown again.',
  keyIsSet: 'A key is set. Leave the fields below empty to keep it.',
  passwordIsSet: 'A password is set. Leave the fields below empty to keep it.',
  noneSet: 'No key or password is set.',
  changeNeeds: 'Changing the host, user or sign-in method needs them again.',
  replaceKey: 'Replace the private key',
  privateKey: 'Private key',
  passphrase: 'Key passphrase (optional)',
  replacePassword: 'Replace the password',
  password: 'Password',
  hostKey: 'Host key (optional)',
  hostKeyHint: 'The host’s public key, to refuse a different machine at that address.',
  folder: 'Folder for sessions (optional)',
  folderExample: '/home/me/projects',
  folderHint: 'Sessions may work in this folder. Without it, your home folder on the host.',
  loadingDevices: 'Loading the devices',
  loadingDevicesDots: 'Loading devices…',
  device: 'Device',
  chooseDevice: 'Choose a device',
  deviceState: '{name} ({state})',
  noWindows: 'No Windows device runs the Nova device agent yet.',
  noDevice: 'No device runs the Nova device agent yet.',
  addDevice: 'Add a device in Settings → Devices',
  distro: 'Distro',
  chooseDistro: 'Choose a distro',
  distroDefault: '{name} (default)',
  distroVersion: '{name}, WSL {version}',
  distroDefaultVersion: '{name} (default), WSL {version}',
  distroExample: 'Ubuntu',
  noDistros: 'The device listed no distros; type the name.',
  deviceFolderHint: 'Sessions work only where the device’s grants allow.',
  cancel: 'Cancel',
  save: 'Save',
  create: 'Create environment',
  state: {
    unreachable: 'offline',
    pending: 'not set up yet',
    revoked: 'revoked',
  },
  /** Friendly text for each field the schema can refuse. */
  field: {
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
  },
});

const FIELD_TEXT = ENV_DIALOG_TEXT.field;

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
      errors[key] ??= messageFor(FIELD_TEXT, key) ?? issue.message;
    }
  if (d.kind === 'ssh') {
    if (d.auth === 'key' && !d.privateKey) errors.privateKey = FIELD_TEXT.privateKey;
    if (d.auth === 'password' && !d.password) errors.password = FIELD_TEXT.password;
  }
  if ((d.kind === 'wsl' || d.kind === 'device') && !d.deviceId)
    errors.deviceId = FIELD_TEXT.deviceId;
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
        setDevicesError(errorMessage(err, ENV_DIALOG_TEXT.devicesFailed));
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
          error: errorMessage(err, ENV_DIALOG_TEXT.distrosFailed),
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
          [d.auth === 'key' ? 'privateKey' : 'password']: ENV_DIALOG_TEXT.credentialAgain,
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
      setError(errorMessage(err, ENV_DIALOG_TEXT.saveFailed));
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
      title={
        editing ? ENV_DIALOG_TEXT.editTitle({ name: editing.label }) : ENV_DIALOG_TEXT.newTitle
      }
      description={editing ? ENV_DIALOG_TEXT.editBody : ENV_DIALOG_TEXT.newBody}
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
            legend={ENV_DIALOG_TEXT.kind}
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
          label={ENV_DIALOG_TEXT.name}
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
              label={ENV_DIALOG_TEXT.image}
              value={d.image}
              required
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              placeholder={ENV_DIALOG_TEXT.imageExample}
              hint={ENV_DIALOG_TEXT.imageHint}
              error={errors.image}
              onChange={(e) => set('image', e.target.value)}
            />
            <TextArea
              id={`${id}-setup`}
              label={ENV_DIALOG_TEXT.setup}
              value={d.setupScript}
              maxLength={20_000}
              hint={ENV_DIALOG_TEXT.setupHint}
              error={errors.setupScript}
              onChange={(v) => set('setupScript', v)}
            />
          </>
        ) : null}

        {d.kind === 'ssh' ? (
          <>
            <div className="code-form-row">
              <TextField
                label={ENV_DIALOG_TEXT.host}
                value={d.host}
                required
                autoComplete="off"
                spellCheck={false}
                dir="ltr"
                placeholder={ENV_DIALOG_TEXT.hostExample}
                error={errors.host}
                onChange={(e) => set('host', e.target.value)}
              />
              <TextField
                label={ENV_DIALOG_TEXT.port}
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
              label={ENV_DIALOG_TEXT.user}
              value={d.user}
              required
              autoComplete="off"
              spellCheck={false}
              error={errors.user}
              onChange={(e) => set('user', e.target.value)}
            />
            <RadioGroup
              legend={ENV_DIALOG_TEXT.signIn}
              name={`${id}-auth`}
              value={d.auth}
              onChange={(v) => set('auth', v as Draft['auth'])}
              options={[
                { value: 'key', label: ENV_DIALOG_TEXT.aKey },
                { value: 'password', label: ENV_DIALOG_TEXT.aPassword },
              ]}
              hint={ENV_DIALOG_TEXT.signInHint}
            />
            {editing ? (
              <p className="muted" id={`${id}-cred`}>
                {hasCredential
                  ? editing.connection.kind === 'ssh' && editing.connection.auth === 'password'
                    ? ENV_DIALOG_TEXT.passwordIsSet
                    : ENV_DIALOG_TEXT.keyIsSet
                  : ENV_DIALOG_TEXT.noneSet}{' '}
                {ENV_DIALOG_TEXT.changeNeeds}
              </p>
            ) : null}
            {d.auth === 'key' ? (
              <>
                <TextArea
                  id={`${id}-key`}
                  label={editing ? ENV_DIALOG_TEXT.replaceKey : ENV_DIALOG_TEXT.privateKey}
                  value={d.privateKey}
                  maxLength={20_000}
                  secret
                  error={errors.privateKey}
                  onChange={(v) => set('privateKey', v)}
                />
                <TextField
                  label={ENV_DIALOG_TEXT.passphrase}
                  type="password"
                  autoComplete="off"
                  value={d.passphrase}
                  error={errors.passphrase}
                  onChange={(e) => set('passphrase', e.target.value)}
                />
              </>
            ) : (
              <TextField
                label={editing ? ENV_DIALOG_TEXT.replacePassword : ENV_DIALOG_TEXT.password}
                type="password"
                autoComplete="new-password"
                value={d.password}
                error={errors.password}
                onChange={(e) => set('password', e.target.value)}
              />
            )}
            <TextArea
              id={`${id}-hostkey`}
              label={ENV_DIALOG_TEXT.hostKey}
              value={d.hostKey}
              maxLength={2000}
              hint={ENV_DIALOG_TEXT.hostKeyHint}
              error={errors.hostKey}
              onChange={(v) => set('hostKey', v)}
            />
            <TextField
              label={ENV_DIALOG_TEXT.folder}
              value={d.root}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              placeholder={ENV_DIALOG_TEXT.folderExample}
              hint={ENV_DIALOG_TEXT.folderHint}
              error={errors.root}
              onChange={(e) => set('root', e.target.value)}
            />
          </>
        ) : null}

        {needsDevice ? (
          devices === null ? (
            <p className="muted">
              <Spinner label={ENV_DIALOG_TEXT.loadingDevices} />{' '}
              {ENV_DIALOG_TEXT.loadingDevicesDots}
            </p>
          ) : deviceChoices.length ? (
            <SelectField
              label={ENV_DIALOG_TEXT.device}
              value={d.deviceId}
              onChange={(v) => setD((x) => ({ ...x, deviceId: v, distro: '' }))}
              options={[
                { value: '', label: ENV_DIALOG_TEXT.chooseDevice },
                ...deviceChoices.map((x) => ({
                  value: x.id,
                  label:
                    x.status === 'active'
                      ? x.name
                      : ENV_DIALOG_TEXT.deviceState({ name: x.name, state: deviceState(x) }),
                  disabled: x.status === 'revoked',
                })),
              ]}
              error={errors.deviceId}
            />
          ) : (
            <p className="ws-warning" role="note">
              {devicesError ??
                (d.kind === 'wsl' ? ENV_DIALOG_TEXT.noWindows : ENV_DIALOG_TEXT.noDevice)}{' '}
              <AppLink to="/settings/devices">{ENV_DIALOG_TEXT.addDevice}</AppLink>
            </p>
          )
        ) : null}

        {d.kind === 'wsl' && d.deviceId ? (
          distroList?.length ? (
            <SelectField
              label={ENV_DIALOG_TEXT.distro}
              value={d.distro}
              onChange={(v) => set('distro', v)}
              options={[
                { value: '', label: ENV_DIALOG_TEXT.chooseDistro },
                ...distroList.map((x) => ({
                  value: x.name,
                  label: x.version
                    ? (x.default
                        ? ENV_DIALOG_TEXT.distroDefaultVersion
                        : ENV_DIALOG_TEXT.distroVersion)({
                        name: x.name,
                        version: String(x.version),
                      })
                    : x.default
                      ? ENV_DIALOG_TEXT.distroDefault({ name: x.name })
                      : x.name,
                })),
              ]}
              error={errors.distro}
            />
          ) : (
            <TextField
              label={ENV_DIALOG_TEXT.distro}
              value={d.distro}
              autoComplete="off"
              spellCheck={false}
              placeholder={ENV_DIALOG_TEXT.distroExample}
              hint={distroState?.error ?? (distroList ? ENV_DIALOG_TEXT.noDistros : undefined)}
              error={errors.distro}
              onChange={(e) => set('distro', e.target.value)}
            />
          )
        ) : null}

        {d.kind === 'device' ? (
          <TextField
            label={ENV_DIALOG_TEXT.folder}
            value={d.root}
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            hint={ENV_DIALOG_TEXT.deviceFolderHint}
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
          <Button onClick={onClose}>{ENV_DIALOG_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? <Spinner /> : null} {editing ? ENV_DIALOG_TEXT.save : ENV_DIALOG_TEXT.create}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function deviceState(x: DeviceView): string {
  return messageFor(ENV_DIALOG_TEXT.state, x.status) ?? x.status;
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
