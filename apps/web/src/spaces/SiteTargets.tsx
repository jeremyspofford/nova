// Publishing targets (FR-037, M8; /sites/targets, reached from Sites and from the publish dialog):
// the web hosts the owner publishes sites to besides the Hub's folder and a zip. Nova uploads to
// them over WebDAV; each password or token goes to the Hub's vault and is never shown again. A
// target can be checked, renamed, pointed elsewhere (only while no site is live on it) and removed
// (likewise). The switch `sites.remoteTargets` turns them off; managed policy can lock it. Only
// the owner manages targets; a member sees the owner-only notice.
import { useEffect, useId, useRef, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { HostingAuth, SiteHostingTargetView } from '@nova/shared';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  RadioGroup,
  Spinner,
  TextField,
  useToast,
} from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { useSetting, useSettings } from '../settings.tsx';
import { formatWhen } from '../settings/common.ts';
import { SwitchField } from '../settings/controls.tsx';
import { MemberGate } from '../team/role.tsx';
import { useDebounced } from '../work/events.ts';
import { followLink } from '../work/nav.tsx';
import { useSpacesApi } from './api.ts';
import { SITES_EVENTS, useHubEvents } from './events.ts';
import { reasonOf, reasonText, refusalText, sitePath } from './format.ts';

/** Publishing targets. {name} is a target's name, {user} a user name (data). */
export const TARGETS_TEXT = defineMessages('spaces.targets', {
  back: 'Sites',
  breadcrumb: 'Breadcrumb',
  title: 'Publishing targets',
  ownerOnly: 'Publishing targets',
  intro:
    'Web hosts Nova uploads a site to when you publish, besides a folder on the Hub or a zip. Nova speaks WebDAV to them and keeps each password or token in the Hub’s vault.',
  switchLabel: 'Allow publishing to hosting targets',
  switchHelp:
    'Off, sites publish only to the Hub’s folder or as a zip. Uploads always follow your network policy.',
  off: 'Turned off: sites publish only to the Hub’s folder or as a zip.',
  add: 'Add a target',
  loading: 'Loading publishing targets',
  loadFailed: 'Could not load the publishing targets.',
  retry: 'Retry',
  emptyTitle: 'No publishing targets yet',
  emptyText: 'Add a WebDAV folder on your web host, then publish a site there from its page.',
  list: 'Publishing targets',
  address: 'Upload address',
  visitors: 'Visitors find sites at',
  signIn: {
    none: 'No sign-in',
    basic: 'Signs in as “{user}”',
    bearer: 'Signs in with a token',
  },
  /** {when} is a time, such as "5 minutes ago". */
  connected: 'Connected, checked {when}',
  failedCheck: 'Not working, checked {when}',
  notChecked: 'Not checked yet',
  liveHere: 'Live here:',
  /** A site live on the target: its name, folder and version. */
  liveSite: '“{name}”, folder “{folder}”, version {v}',
  check: 'Check connection',
  checkLabel: 'Check the connection to {name}',
  checked: 'Checked {name}.',
  edit: 'Edit',
  editLabel: 'Edit {name}',
  remove: 'Remove',
  removeLabel: 'Remove {name}',
  removeTitle: 'Remove “{name}”?',
  removeText:
    'Nova forgets this target and removes its password or token from the vault. Files already on the host stay there.',
  removeBlocked: 'Sites are published on this target. Unpublish them first, then remove it.',
  removed: 'Removed “{name}”.',
  cancel: 'Cancel',
  failed: 'Could not save the target.',
});
const T = TARGETS_TEXT;

/** Adding or editing a publishing target. */
export const TARGET_FORM_TEXT = defineMessages('spaces.targetForm', {
  addTitle: 'Add a publishing target',
  editTitle: 'Edit “{name}”',
  name: 'Name',
  url: 'WebDAV address',
  urlHint: 'The folder site folders go into, for example https://dav.example.com/sites/.',
  publicUrl: 'Public address (optional)',
  publicUrlHint: 'Where visitors see those folders, when it is another address.',
  signIn: 'Sign-in',
  keep: 'Keep the current sign-in',
  keepHelp: 'The saved password or token stays in the vault.',
  none: 'None',
  noneHelp: 'The host lets Nova write without signing in.',
  basic: 'User name and password',
  basicHelp: 'Sent over https only.',
  bearer: 'Token',
  bearerHelp: 'Sent as a bearer token.',
  username: 'User name',
  password: 'Password',
  token: 'Token',
  secretHint: 'Stored in the Hub’s vault; it is never shown again.',
  save: 'Save',
  add: 'Add target',
  cancel: 'Cancel',
});
const F = TARGET_FORM_TEXT;

export function SiteTargetsView() {
  return (
    <MemberGate ownerOnly what={T.ownerOnly}>
      <TargetsPage />
    </MemberGate>
  );
}

function TargetsPage() {
  const api = useSpacesApi();
  const toast = useToast();
  const announce = useAnnounce();
  const enabled = useSetting('sites.remoteTargets');
  const settings = useSettings();
  const [items, setItems] = useState<SiteHostingTargetView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<
    { kind: 'add' } | { kind: 'edit' | 'remove'; target: SiteHostingTargetView } | null
  >(null);
  const [checking, setChecking] = useState<string | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    api.listSiteTargets().then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, T.loadFailed)),
    );
    return () => {
      alive = false;
    };
  }, [api, attempt]);

  const reload = useDebounced(() => setAttempt((n) => n + 1), 150);
  // Targets change, and publishes move sites on and off them.
  useHubEvents(SITES_EVENTS, reload);

  const check = (t: SiteHostingTargetView) => {
    setChecking(t.id);
    api
      .checkSiteTarget(t.id)
      .then(
        (next) => {
          setItems((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? null);
          announce(T.checked({ name: t.name }));
        },
        (err: unknown) => toast.show(refusalText(err, T.failed), { tone: 'error' }),
      )
      .finally(() => setChecking(null));
  };

  const on = enabled.value;
  return (
    <div className="ws-page sites-page">
      <nav aria-label={T.breadcrumb} className="ws-breadcrumb">
        <a href={sitePath()} onClick={(e) => followLink(e, sitePath())}>
          <Icon name="back" /> {T.back}
        </a>
      </nav>
      <header className="ws-page-header">
        <h1>{T.title}</h1>
        <Button
          ref={addButton}
          variant="primary"
          disabled={!on}
          onClick={() => setDialog({ kind: 'add' })}
        >
          <Icon name="plus" /> {T.add}
        </Button>
      </header>
      <p className="muted ws-flush">{T.intro}</p>
      <SwitchField
        label={T.switchLabel}
        description={T.switchHelp}
        checked={on}
        locked={enabled.locked}
        setting="sites.remoteTargets"
        onChange={(next) => {
          settings
            .set('sites.remoteTargets', next)
            .catch((err: unknown) => toast.show(errorMessage(err), { tone: 'error' }));
        }}
      />
      {!on ? <p className="muted ws-flush">{T.off}</p> : null}
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setAttempt((n) => n + 1)}>{T.retry}</Button>
        </div>
      ) : null}
      {items === null && !error ? <Spinner label={T.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState title={T.emptyTitle} description={T.emptyText} icon="server" level={2} />
      ) : null}
      {items?.length ? (
        <ul className="sites-targets" aria-label={T.list}>
          {items.map((t) => (
            <li key={t.id} className="ws-card sites-target">
              <span className="ws-card-link" dir="auto">
                {t.name}
              </span>
              <p>
                {T.address}: <code dir="ltr">{t.url}</code>
              </p>
              {t.publicUrl ? (
                <p>
                  {T.visitors}{' '}
                  <a href={t.publicUrl} target="_blank" rel="noopener noreferrer" dir="ltr">
                    {t.publicUrl}
                  </a>
                </p>
              ) : null}
              <p className="muted">
                {t.auth === 'basic'
                  ? T.signIn.basic({ user: t.username ?? '' })
                  : t.auth === 'bearer'
                    ? T.signIn.bearer
                    : T.signIn.none}
              </p>
              <CheckStatus target={t} />
              {t.sites.length ? (
                <div>
                  <p>{T.liveHere}</p>
                  <ul className="sites-plan-list">
                    {t.sites.map((s) => (
                      <li key={s.siteId}>
                        <a
                          href={sitePath(s.siteId)}
                          onClick={(e) => followLink(e, sitePath(s.siteId))}
                        >
                          {T.liveSite({ name: s.name, folder: s.folder, v: s.version })}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="spaces-actions">
                <Button
                  aria-label={T.checkLabel({ name: t.name })}
                  disabled={!on || checking === t.id}
                  onClick={() => check(t)}
                >
                  {checking === t.id ? <Spinner /> : <Icon name="refresh" />} {T.check}
                </Button>
                <Button
                  aria-label={T.editLabel({ name: t.name })}
                  onClick={() => setDialog({ kind: 'edit', target: t })}
                >
                  <Icon name="edit" /> {T.edit}
                </Button>
                <Button
                  variant="danger"
                  aria-label={T.removeLabel({ name: t.name })}
                  onClick={() => setDialog({ kind: 'remove', target: t })}
                >
                  <Icon name="trash" /> {T.remove}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {dialog?.kind === 'add' || dialog?.kind === 'edit' ? (
        <TargetDialog
          editing={dialog.kind === 'edit' ? dialog.target : undefined}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null);
            setItems((list) => [...(list ?? []).filter((x) => x.id !== saved.id), saved]);
            // A new or moved target is tried at once, so the list says whether it works.
            if (on) check(saved);
            reload();
          }}
        />
      ) : null}
      {dialog?.kind === 'remove' ? (
        <RemoveTargetDialog
          target={dialog.target}
          onClose={() => setDialog(null)}
          fallbackFocus={() => addButton.current}
          onRemoved={() => {
            const name = dialog.target.name;
            setDialog(null);
            setItems((list) => list?.filter((x) => x.id !== dialog.target.id) ?? null);
            toast.show(T.removed({ name }), { tone: 'success' });
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

function CheckStatus({ target: t }: { target: SiteHostingTargetView }) {
  const c = t.lastCheck;
  if (!c)
    return (
      <p className="muted">
        <span className="ws-badge">{T.notChecked}</span>
      </p>
    );
  const why = c.reason ? (reasonText(c.reason) ?? c.message) : c.message;
  return (
    <p>
      <span className="ws-badge" data-tone={c.ok ? 'ok' : 'warn'}>
        <Icon name={c.ok ? 'check' : 'alert'} />{' '}
        {c.ok ? T.connected({ when: formatWhen(c.at) }) : T.failedCheck({ when: formatWhen(c.at) })}
      </span>
      {!c.ok && why ? <span className="muted"> {why}</span> : null}
    </p>
  );
}

type AuthChoice = HostingAuth | 'keep';

/** Add a target, or change one (`editing`); a refusal keeps the form. */
function TargetDialog({
  editing,
  onClose,
  onSaved,
}: {
  editing?: SiteHostingTargetView;
  onClose: () => void;
  onSaved: (t: SiteHostingTargetView) => void;
}) {
  const api = useSpacesApi();
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(editing?.name ?? '');
  const [url, setUrl] = useState(editing?.url ?? '');
  const [publicUrl, setPublicUrl] = useState(editing?.publicUrl ?? '');
  const [auth, setAuth] = useState<AuthChoice>(editing ? 'keep' : 'none');
  const [username, setUsername] = useState(editing?.username ?? '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; text: string } | null>(null);

  const credentialReady =
    auth === 'keep' ||
    auth === 'none' ||
    (auth === 'basic' ? !!username.trim() && !!secret : !!secret.trim());
  const valid = !!name.trim() && !!url.trim() && credentialReady;

  const credential = () =>
    auth === 'basic'
      ? { kind: 'basic' as const, username: username.trim(), password: secret }
      : auth === 'bearer'
        ? { kind: 'bearer' as const, token: secret.trim() }
        : { kind: 'none' as const };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    setFieldError(null);
    try {
      const pub = publicUrl.trim() || null;
      onSaved(
        editing
          ? await api.updateSiteTarget(editing.id, {
              name: name.trim(),
              ...(url.trim() !== editing.url ? { url: url.trim() } : {}),
              publicUrl: pub,
              ...(auth !== 'keep' ? { credential: credential() } : {}),
            })
          : await api.createSiteTarget({
              name: name.trim(),
              kind: 'webdav',
              url: url.trim(),
              publicUrl: pub,
              credential: credential(),
            }),
      );
    } catch (err) {
      const text = refusalText(err, T.failed);
      const field = err instanceof ApiError ? err.body.details?.field : undefined;
      // An address the Hub refused shows on its field; anything else under the form.
      if (reasonOf(err) && (field === 'url' || field === 'publicUrl'))
        setFieldError({ field, text });
      else setError(text);
      setBusy(false);
    }
  };

  const options = [
    ...(editing ? [{ value: 'keep', label: F.keep, description: F.keepHelp }] : []),
    { value: 'none', label: F.none, description: F.noneHelp },
    { value: 'basic', label: F.basic, description: F.basicHelp },
    { value: 'bearer', label: F.bearer, description: F.bearerHelp },
  ];

  return (
    <Dialog
      open
      title={editing ? F.editTitle({ name: editing.name }) : F.addTitle}
      onClose={onClose}
      initialFocusRef={nameRef}
      className="ws-wide-dialog"
    >
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          ref={nameRef}
          label={F.name}
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label={F.url}
          hint={F.urlHint}
          value={url}
          maxLength={2000}
          inputMode="url"
          dir="ltr"
          error={fieldError?.field === 'url' ? fieldError.text : undefined}
          onChange={(e) => setUrl(e.target.value)}
        />
        <TextField
          label={F.publicUrl}
          hint={F.publicUrlHint}
          value={publicUrl}
          maxLength={2000}
          inputMode="url"
          dir="ltr"
          error={fieldError?.field === 'publicUrl' ? fieldError.text : undefined}
          onChange={(e) => setPublicUrl(e.target.value)}
        />
        <RadioGroup
          legend={F.signIn}
          name={`${formId}-auth`}
          value={auth}
          options={options}
          onChange={(v) => setAuth(v === 'basic' || v === 'bearer' || v === 'keep' ? v : 'none')}
        />
        {auth === 'basic' ? (
          <>
            <TextField
              label={F.username}
              value={username}
              maxLength={200}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
            <TextField
              label={F.password}
              hint={F.secretHint}
              type="password"
              value={secret}
              maxLength={1000}
              autoComplete="new-password"
              onChange={(e) => setSecret(e.target.value)}
            />
          </>
        ) : null}
        {auth === 'bearer' ? (
          <TextField
            label={F.token}
            hint={F.secretHint}
            type="password"
            value={secret}
            maxLength={4000}
            autoComplete="off"
            onChange={(e) => setSecret(e.target.value)}
          />
        ) : null}
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{F.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !valid}>
            {busy ? <Spinner /> : null} {editing ? F.save : F.add}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveTargetDialog({
  target,
  onClose,
  onRemoved,
  fallbackFocus,
}: {
  target: SiteHostingTargetView;
  onClose: () => void;
  onRemoved: () => void;
  fallbackFocus: () => HTMLElement | null;
}) {
  const api = useSpacesApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = target.sites.length > 0;
  return (
    <Dialog
      open
      title={T.removeTitle({ name: target.name })}
      description={blocked ? T.removeBlocked : T.removeText}
      onClose={onClose}
      fallbackFocus={fallbackFocus}
      footer={
        <>
          <Button onClick={onClose}>{T.cancel}</Button>
          <Button
            variant="danger"
            disabled={busy || blocked}
            onClick={() => {
              setBusy(true);
              setError(null);
              api.deleteSiteTarget(target.id).then(onRemoved, (err: unknown) => {
                setError(refusalText(err, T.failed));
                setBusy(false);
              });
            }}
          >
            {T.remove}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="nv-field-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
