// Settings → Extensions (FR-117; docs/14 §4-§5, docs/26 §3-§5): every installed extension with its
// status (running, starting, stopped, off, error), its publisher and Verified or Unverified, what
// it may do in plain words, its hooks with their trust state (an update needs trust again), its
// declared secrets (set or clear; a value is never shown), its app screens, on and off, and
// Uninstall (with "also remove its data"). Install from a `.novax` file (or a bundle or folder on
// the Hub) opens the preview; nothing is installed before Install. The SDK switch, managed policy
// and a "For developers" note about `nova dev` complete the page. Owner-only: a member sees the
// owner-only notice. The list follows the extension events.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type {
  ExtensionHookView,
  ExtensionPreviewView,
  ExtensionView,
  UiEntryPointView,
} from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { navigate } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { StateChip, VerifiedBadge } from '../settings/badges.tsx';
import { SwitchField } from '../settings/controls.tsx';
import { useSettings } from '../settings.tsx';
import { MemberGate } from '../team/role.tsx';
import { MARKET_PATH } from '../market/format.ts';
import {
  ManagedNote,
  POLICY_TEXT,
  extensionsLimited,
  unverifiedForbidden,
  useManagedSources,
  useRestrictions,
} from '../market/policy.tsx';
import { useExtensionsApi, type ExtensionsApi } from './api-m8.ts';
import { ExtensionPreviewDialog, PermissionList } from './ExtensionPreview.tsx';
import { HookTrustDialog } from './HookTrust.tsx';
import {
  EXT_TEXT,
  HOOK_STATUS_TEXT,
  PREVIEW_TEXT,
  SIGNATURE_TEXT,
  STATUS_TEXT,
  extensionErrorMessage,
  publisherText,
  readBundleFile,
  registeredText,
} from './format.ts';
import { useRefreshContributions } from './store.ts';
import './extensions.css';

/** Events after which the list is read again. */
const LIST_EVENTS = [
  'extension.changed',
  'extension.status.changed',
  'hook.trust.changed',
] as const;

export function ExtensionsPage() {
  return (
    <MemberGate ownerOnly what={EXT_TEXT.ownerOnly}>
      <ExtensionsBody />
    </MemberGate>
  );
}

function ExtensionsBody() {
  const ext = useExtensionsApi();
  const { api } = useServices();
  const settings = useSettings();
  const toast = useToast();
  const announce = useAnnounce();
  const refreshShell = useRefreshContributions();
  const [items, setItems] = useState<ExtensionView[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<ExtensionPreviewView | null>(null);
  const [apps, setApps] = useState<UiEntryPointView[]>([]);
  const restrictions = useRestrictions();
  const sdk = settings.get('sdk.enabled');
  const anyManaged =
    sdk.locked ||
    unverifiedForbidden(restrictions.layers) ||
    extensionsLimited(restrictions.layers);
  const sources = useManagedSources(anyManaged);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    if (!ext) return;
    let alive = true;
    ext.listExtensions().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setLoadError(null);
      },
      (err: unknown) => alive && setLoadError(err),
    );
    api.uiEntryPoints().then(
      ({ items: list }) => alive && setApps(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [ext, api, attempt]);
  useHubStream(LIST_EVENTS, reload, reload);

  const changed = (msg: string) => {
    toast.show(msg, { tone: 'success' });
    announce(msg);
    reload();
    refreshShell();
  };

  if (!ext)
    return (
      <div className="settings-page">
        <h2>{EXT_TEXT.title}</h2>
        <p className="muted">{EXT_TEXT.loadFailed}</p>
      </div>
    );

  return (
    <div className="settings-page ext-page">
      <h2>{EXT_TEXT.title}</h2>
      <p className="muted">{EXT_TEXT.intro}</p>

      <section className="settings-section" aria-labelledby="ext-switch">
        <h3 id="ext-switch" className="nv-vh">
          {EXT_TEXT.sdkSwitch}
        </h3>
        <SwitchField
          label={EXT_TEXT.sdkSwitch}
          description={EXT_TEXT.sdkSwitchHint}
          checked={sdk.value}
          disabled={sdk.locked}
          onChange={(v) => {
            settings.set('sdk.enabled', v).then(
              () => refreshShell(),
              (err: unknown) =>
                toast.show(extensionErrorMessage(err, EXT_TEXT.settingFailed), {
                  tone: 'error',
                }),
            );
          }}
        />
        {sdk.locked ? <ManagedNote view={sources} sourceKey="sdk.enabled" /> : null}
        {!sdk.value ? (
          <p className="ws-callout" role="note">
            <Icon name="alert" />
            <span>{EXT_TEXT.sdkOff}</span>
          </p>
        ) : null}
        {unverifiedForbidden(restrictions.layers) ? (
          <p className="ext-policy">
            <span>{POLICY_TEXT.unverifiedOff}</span>{' '}
            <ManagedNote view={sources} sourceKey="restrict.unverifiedInstalls" />
          </p>
        ) : null}
        {extensionsLimited(restrictions.layers) ? (
          <p className="ext-policy">
            <span>{POLICY_TEXT.extensionsLimited}</span>{' '}
            <ManagedNote view={sources} sourceKey="restrict.extensions" />
          </p>
        ) : null}
      </section>

      <section className="settings-section" aria-labelledby="ext-installed">
        <h3 id="ext-installed">{EXT_TEXT.installed}</h3>
        {loadError ? (
          <div role="alert" className="ws-error">
            <p>{extensionErrorMessage(loadError, EXT_TEXT.loadFailed)}</p>
            <Button onClick={reload}>{EXT_TEXT.retry}</Button>
          </div>
        ) : items === null ? (
          <Spinner label={EXT_TEXT.loading} />
        ) : items.length === 0 ? (
          <EmptyState
            title={EXT_TEXT.none}
            description={EXT_TEXT.noneHint}
            level={3}
            action={<Button onClick={() => navigate(MARKET_PATH)}>{EXT_TEXT.marketLink}</Button>}
          />
        ) : (
          <ul className="ws-list ext-list" aria-label={EXT_TEXT.installed}>
            {items.map((e) => (
              <ExtensionCard
                key={e.id}
                extension={e}
                ext={ext}
                apps={apps.filter((a) => a.pluginId === e.id)}
                onChanged={changed}
                onReplaced={(v) =>
                  setItems((list) => list?.map((x) => (x.id === v.id ? v : x)) ?? null)
                }
              />
            ))}
          </ul>
        )}
      </section>

      <InstallSection ext={ext} onPreview={setPreview} />

      <details className="ws-advanced ext-dev">
        <summary>{EXT_TEXT.developer}</summary>
        <div className="stack">
          <p>{EXT_TEXT.developerBody}</p>
          <pre className="ws-command" aria-label={EXT_TEXT.devCommands}>
            <code>{DEV_COMMANDS}</code>
          </pre>
          <p className="muted">{EXT_TEXT.developerEnv}</p>
        </div>
      </details>

      {preview ? (
        <ExtensionPreviewDialog
          preview={preview}
          ext={ext}
          unverifiedForbidden={unverifiedForbidden(restrictions.layers)}
          onClose={() => setPreview(null)}
          onInstalled={(view, update) => {
            setPreview(null);
            changed(update ? PREVIEW_TEXT.updated(view.name) : PREVIEW_TEXT.installed(view.name));
          }}
        />
      ) : null}
    </div>
  );
}

const DEV_COMMANDS = [
  'nova dev ./my-extension',
  'nova validate ./my-extension',
  'nova pack ./my-extension --key ~/.config/nova/publisher-key',
].join('\n');

// ---- one extension --------------------------------------------------------------------------

function ExtensionCard({
  extension: e,
  ext,
  apps,
  onChanged,
  onReplaced,
}: {
  extension: ExtensionView;
  ext: ExtensionsApi;
  apps: UiEntryPointView[];
  onChanged: (msg: string) => void;
  onReplaced: (view: ExtensionView) => void;
}) {
  const toast = useToast();
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [trusting, setTrusting] = useState<ExtensionHookView | null>(null);
  const [removing, setRemoving] = useState(false);
  const status = STATUS_TEXT[e.status];

  const toggle = (on: boolean) => {
    setBusy(true);
    ext.setExtensionEnabled(e.id, on).then(
      (view) => {
        setBusy(false);
        onReplaced(view);
        onChanged(on ? EXT_TEXT.turnedOn(e.name) : EXT_TEXT.turnedOff(e.name));
      },
      (err: unknown) => {
        setBusy(false);
        toast.show(extensionErrorMessage(err, EXT_TEXT.changeFailed(e.name)), { tone: 'error' });
      },
    );
  };

  return (
    <li className="ws-card ext-card" aria-labelledby={headingId} data-extension={e.id}>
      <div className="ext-card-head">
        <div className="ws-source-main">
          <h4 id={headingId} className="ext-name">
            {e.name} <span className="muted">{e.version}</span>
          </h4>
          <span className="ws-row-meta">
            <VerifiedBadge verified={e.verified} />
            <StateChip text={status.text} tone={status.tone} icon={status.icon} />
            <code className="ws-code-inline">{e.id}</code>
          </span>
        </div>
        <SwitchField
          label={EXT_TEXT.runSwitch(e.name)}
          checked={e.enabled}
          disabled={busy}
          onChange={toggle}
        />
      </div>
      {e.description ? <p className="ext-desc">{e.description}</p> : null}
      {e.status === 'error' && e.error ? (
        <p role="alert" className="ws-warning">
          <Icon name="alert" />
          <span>
            {EXT_TEXT.error}: {e.error}
          </span>
        </p>
      ) : null}

      <dl className="ws-dl ext-facts">
        <dt>{EXT_TEXT.publisher}</dt>
        <dd>
          {publisherText(e.publisher)} · {SIGNATURE_TEXT[e.signature]}
        </dd>
        {e.publisher.fingerprint ? (
          <>
            <dt>{EXT_TEXT.fingerprint}</dt>
            <dd>
              <code className="ws-code-inline">{e.publisher.fingerprint}</code>
            </dd>
          </>
        ) : null}
        <dt>{EXT_TEXT.registered}</dt>
        <dd>{e.status === 'running' ? registeredText(e.registered) : EXT_TEXT.notRunning}</dd>
      </dl>

      <details className="ws-advanced ext-more">
        <summary>{EXT_TEXT.permissions}</summary>
        <PermissionList lines={e.permissions} label={EXT_TEXT.permissionsOf(e.name)} />
      </details>

      {e.hooks.length ? (
        <section className="ext-sub" aria-label={EXT_TEXT.hooksOf(e.name)}>
          <h5 className="ws-subhead">{EXT_TEXT.hooks}</h5>
          <p className="muted">{EXT_TEXT.hooksHint}</p>
          <ul className="ws-list">
            {e.hooks.map((h) => {
              const st = HOOK_STATUS_TEXT[h.status];
              return (
                <li key={h.id} className="ws-list-row" aria-label={h.id}>
                  <span className="ws-row-meta">
                    <code className="ws-code-inline">{h.id}</code>
                    <span>{h.event}</span>
                    <StateChip text={st.text} tone={st.tone} icon={st.icon} />
                  </span>
                  {h.status === 'needs_trust' || h.status === 'revoked' ? (
                    <Button aria-label={EXT_TEXT.trustHook(h.id)} onClick={() => setTrusting(h)}>
                      {EXT_TEXT.trust}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {e.secrets.length ? <Secrets extension={e} ext={ext} onChanged={onChanged} /> : null}

      {apps.length ? (
        <section className="ext-sub" aria-label={EXT_TEXT.appsOf(e.name)}>
          <h5 className="ws-subhead">{EXT_TEXT.apps}</h5>
          <ul className="ws-plain-list">
            {apps.map((a) => (
              <li key={a.id}>
                {a.title}{' '}
                {a.kind === 'global' ? (
                  <a
                    href={`/apps/${encodeURIComponent(a.id)}`}
                    className="link"
                    aria-label={EXT_TEXT.openAppOf(a.title)}
                    onClick={(ev) => {
                      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                      ev.preventDefault();
                      navigate(`/apps/${encodeURIComponent(a.id)}`);
                    }}
                  >
                    {EXT_TEXT.openApp}
                  </a>
                ) : (
                  <span className="muted">{EXT_TEXT.appKind[a.kind]}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="row ws-row-actions">
        <Button
          variant="danger"
          onClick={() => setRemoving(true)}
          aria-label={EXT_TEXT.uninstallOf(e.name)}
        >
          {EXT_TEXT.uninstall}
        </Button>
      </div>

      {trusting ? (
        <HookTrustDialog
          extension={e}
          hook={trusting}
          ext={ext}
          onClose={() => setTrusting(null)}
          onTrusted={(id) => {
            setTrusting(null);
            onChanged(EXT_TEXT.hookTrusted(id));
          }}
        />
      ) : null}
      {removing ? (
        <UninstallDialog
          extension={e}
          ext={ext}
          onClose={() => setRemoving(false)}
          onDone={() => {
            setRemoving(false);
            onChanged(EXT_TEXT.uninstalled(e.name));
          }}
        />
      ) : null}
    </li>
  );
}

function UninstallDialog({
  extension: e,
  ext,
  onClose,
  onDone,
}: {
  extension: ExtensionView;
  ext: ExtensionsApi;
  onClose: () => void;
  onDone: () => void;
}) {
  const [removeData, setRemoveData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = () => {
    setBusy(true);
    setError(null);
    ext.uninstallExtension(e.id, { removeData }).then(onDone, (err: unknown) => {
      setBusy(false);
      setError(extensionErrorMessage(err, EXT_TEXT.uninstallFailed(e.name)));
    });
  };
  return (
    <Dialog
      open
      title={EXT_TEXT.uninstallTitle(e.name)}
      description={EXT_TEXT.uninstallBody}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{EXT_TEXT.cancel}</Button>
          <Button variant="danger" disabled={busy} onClick={go}>
            {busy ? <Spinner /> : null} {EXT_TEXT.uninstallConfirm}
          </Button>
        </>
      }
    >
      <div className="stack">
        <label className="ws-check">
          <input
            type="checkbox"
            checked={removeData}
            onChange={(ev) => setRemoveData(ev.target.checked)}
          />
          <span>{EXT_TEXT.removeData}</span>
        </label>
        {!removeData ? <p className="muted">{EXT_TEXT.keepData}</p> : null}
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// ---- secrets ----------------------------------------------------------------------------------

function Secrets({
  extension: e,
  ext,
  onChanged,
}: {
  extension: ExtensionView;
  ext: ExtensionsApi;
  onChanged: (msg: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  return (
    <section className="ext-sub" aria-label={EXT_TEXT.secretsOf(e.name)}>
      <h5 className="ws-subhead">{EXT_TEXT.secrets}</h5>
      <p className="muted">{EXT_TEXT.secretsHint}</p>
      <ul className="ws-list">
        {e.secrets.map((s) => (
          <li key={s.name} className="ws-list-row" aria-label={EXT_TEXT.secretRow(s.name)}>
            <span className="ws-row-meta">
              <code className="ws-code-inline">{s.name}</code>
              <span className="muted">{s.set ? EXT_TEXT.secretSet : EXT_TEXT.secretUnset}</span>
            </span>
            {editing === s.name ? (
              <SecretForm
                name={s.name}
                onCancel={() => setEditing(null)}
                onSave={async (value) => {
                  await ext.setExtensionSecret(e.id, s.name, value);
                  setEditing(null);
                  onChanged(EXT_TEXT.secretSaved(s.name));
                }}
              />
            ) : (
              <span className="row ws-row-actions">
                <Button
                  aria-label={
                    s.set ? EXT_TEXT.replaceSecretOf(s.name) : EXT_TEXT.setSecretOf(s.name)
                  }
                  onClick={() => setEditing(s.name)}
                >
                  {s.set ? EXT_TEXT.replaceSecret : EXT_TEXT.setSecret}
                </Button>
                {s.set ? (
                  <Button
                    variant="ghost"
                    aria-label={EXT_TEXT.clearSecretOf(s.name)}
                    onClick={() => setClearing(s.name)}
                  >
                    {EXT_TEXT.clearSecret}
                  </Button>
                ) : null}
              </span>
            )}
          </li>
        ))}
      </ul>
      {clearing ? (
        <ClearSecretDialog
          name={clearing}
          extensionName={e.name}
          onClose={() => setClearing(null)}
          onClear={async () => {
            await ext.clearExtensionSecret(e.id, clearing);
            setClearing(null);
            onChanged(EXT_TEXT.secretCleared(clearing));
          }}
        />
      ) : null}
    </section>
  );
}

function SecretForm({
  name,
  onSave,
  onCancel,
}: {
  name: string;
  onSave: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!value) return;
    setBusy(true);
    setError(null);
    onSave(value).catch((err: unknown) => {
      setBusy(false);
      setError(extensionErrorMessage(err, EXT_TEXT.storeFailed(name)));
    });
  };
  return (
    <form className="ext-secret-form" onSubmit={submit}>
      <TextField
        label={EXT_TEXT.secretValue(name)}
        type="password"
        autoComplete="off"
        autoFocus
        value={value}
        error={error ?? undefined}
        onChange={(ev) => setValue(ev.target.value)}
      />
      <span className="row">
        <Button type="submit" variant="primary" disabled={busy || !value}>
          {EXT_TEXT.saveSecret}
        </Button>
        <Button onClick={onCancel}>{EXT_TEXT.cancel}</Button>
      </span>
    </form>
  );
}

function ClearSecretDialog({
  name,
  extensionName,
  onClose,
  onClear,
}: {
  name: string;
  extensionName: string;
  onClose: () => void;
  onClear: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      title={EXT_TEXT.clearTitle(name)}
      description={EXT_TEXT.clearBody(extensionName)}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{EXT_TEXT.cancel}</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              onClear().catch((err: unknown) => {
                setBusy(false);
                setError(extensionErrorMessage(err, EXT_TEXT.clearFailed(name)));
              });
            }}
          >
            {EXT_TEXT.clearSecret}
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

// ---- install ----------------------------------------------------------------------------------

function InstallSection({
  ext,
  onPreview,
}: {
  ext: ExtensionsApi;
  onPreview: (p: ExtensionPreviewView) => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState('');

  const run = (load: () => Promise<ExtensionPreviewView>) => {
    setBusy(true);
    setError(null);
    load().then(
      (p) => {
        setBusy(false);
        onPreview(p);
      },
      (err: unknown) => {
        setBusy(false);
        setError(extensionErrorMessage(err, EXT_TEXT.checkFailed));
      },
    );
  };

  const choose = async (f: File) => {
    const read = await readBundleFile(f);
    if (!read.ok) {
      setError(read.error);
      return;
    }
    run(() =>
      ext.previewExtension({ kind: 'upload', bundle: read.bundle, fileName: read.fileName }),
    );
  };

  return (
    <section className="settings-section" aria-labelledby="ext-install">
      <h3 id="ext-install">{EXT_TEXT.installTitle}</h3>
      <p className="muted">{EXT_TEXT.installHint}</p>
      <div className="row">
        <Button onClick={() => file.current?.click()} disabled={busy}>
          <Icon name="attach" /> {EXT_TEXT.chooseFile}
        </Button>
        <input
          ref={file}
          type="file"
          accept=".novax"
          hidden
          aria-label={EXT_TEXT.chooseFile}
          data-testid="novax-input"
          onChange={(ev) => {
            const f = ev.target.files?.[0];
            ev.target.value = '';
            if (f) void choose(f);
          }}
        />
        {busy ? <Spinner label={EXT_TEXT.checking} /> : null}
      </div>
      <details className="ws-advanced">
        <summary>{EXT_TEXT.fromHub}</summary>
        <form
          className="stack"
          onSubmit={(ev) => {
            ev.preventDefault();
            const p = path.trim();
            if (!p.startsWith('/')) {
              setError(EXT_TEXT.pathError);
              return;
            }
            run(() => ext.previewExtension({ kind: 'path', path: p }));
          }}
        >
          <TextField
            label={EXT_TEXT.pathLabel}
            hint={EXT_TEXT.pathHint}
            value={path}
            spellCheck={false}
            onChange={(ev) => setPath(ev.target.value)}
          />
          <div className="row">
            <Button type="submit" disabled={busy || !path.trim()}>
              {EXT_TEXT.pathCheck}
            </Button>
          </div>
        </form>
      </details>
      {error ? (
        <p role="alert" className="nv-field-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
