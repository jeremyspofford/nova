// Git hosts (FR-070, docs/10 §8): the hosts Code sessions push to and open pull requests on.
// Connect takes a personal access token, which goes to the keychain on the Hub and is never shown
// again; the Hub checks it at once (a rejected token is not saved). Each host shows the account
// it signs in as and its last check. Remove is refused while pull requests opened through it are
// still open. GitHub (and GitHub Enterprise) for now.
import { useCallback, useEffect, useId, useState } from 'react';
import type { GitHostView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Dialog, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { errorReason } from './m6-format.ts';
import { Badge, ConfirmDialog, ErrorBanner } from './parts.tsx';

export const HOSTS_TEXT = defineMessages('code.hosts', {
  status: { ok: 'Connected', error: 'Not working', unknown: 'Not checked' },
  loadFailed: 'Could not load the Git hosts.',
  checked: '{name}: {status}.',
  checkFailed: 'Could not check {name}: {reason}',
  removed: 'Removed {name}.',
  inUse: 'Pull requests opened through this host are still open. Close or merge them first.',
  removeFailed: 'Could not remove the host.',
  title: 'Git hosts',
  connect: 'Connect a Git host',
  intro:
    'Sessions push branches and open pull requests through these hosts, and show their CI checks.',
  loading: 'Loading the Git hosts',
  emptyTitle: 'No Git host connected',
  emptyBody:
    'Connect GitHub with a personal access token to push and open pull requests from a session.',
  signedInAs: 'Signed in as {login}',
  unknownAccount: 'Account not known yet',
  tokenSet: 'Token: set',
  checkedAt: 'Checked {when}',
  checking: 'Checking {name}',
  check: 'Check',
  remove: 'Remove…',
  connected: 'Connected {name}.',
  connectedAs: 'Connected {name} as {login}.',
  unreachable: 'Saved {name}, but it could not be reached: {reason}.',
  unknownError: 'unknown error',
  removeTitle: 'Remove {name}?',
  thisHost: 'Remove this host?',
  removeBody:
    'Its token is deleted from the keychain. Sessions cannot push or open pull requests there until you connect it again.',
  removeConfirm: 'Remove',
  enterpriseAddresses:
    'Enter the web address and the API address of your GitHub Enterprise server.',
  tokenRejected: 'The host rejected the token. Check that it is current and has the repo scope.',
  connectFailed: 'Could not connect the host.',
  dialogBody: 'The token is stored in the keychain on the Hub and is never shown again.',
  enterprise: 'GitHub Enterprise (your own server)',
  webUrl: 'Web address',
  webUrlExample: 'https://github.example.com',
  apiUrl: 'API address',
  apiUrlExample: 'https://github.example.com/api/v3',
  name: 'Name (optional)',
  nameEnterprise: 'Work GitHub',
  nameDefault: 'github.com',
  token: 'Personal access token',
  tokenHint: 'Needs access to the repositories’ contents, pull requests and checks.',
  cancel: 'Cancel',
  connectButton: 'Connect',
});

const STATUS = {
  ok: { icon: 'check', tone: 'ok' },
  error: { icon: 'stop', tone: 'danger' },
  unknown: { icon: 'clock', tone: 'muted' },
} as const;

export function GitHostsSection() {
  const m6 = useCodeM6Api();
  const toast = useToast();
  const announce = useAnnounce();
  const headingId = useId();
  const [items, setItems] = useState<GitHostView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [checking, setChecking] = useState<Set<string>>(() => new Set());
  const [removing, setRemoving] = useState<GitHostView | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      m6.listGitHosts().then(
        ({ items: list }) => {
          setItems(list);
          setError(null);
        },
        (err: unknown) => setError(errorMessage(err, HOSTS_TEXT.loadFailed)),
      ),
    [m6],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const check = async (h: GitHostView) => {
    setChecking((s) => new Set([...s, h.id]));
    try {
      const next = await m6.checkGitHost(h.id);
      setItems((list) => list?.map((x) => (x.id === next.id ? next : x)) ?? null);
      announce(HOSTS_TEXT.checked({ name: next.label, status: HOSTS_TEXT.status[next.status] }));
    } catch (err) {
      toast.show(HOSTS_TEXT.checkFailed({ name: h.label, reason: errorMessage(err) }), {
        tone: 'error',
      });
    } finally {
      setChecking((s) => {
        const n = new Set(s);
        n.delete(h.id);
        return n;
      });
    }
  };

  const remove = async () => {
    const h = removing;
    if (!h) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await m6.deleteGitHost(h.id);
      setItems((list) => list?.filter((x) => x.id !== h.id) ?? null);
      setRemoving(null);
      toast.show(HOSTS_TEXT.removed({ name: h.label }), { tone: 'success' });
    } catch (err) {
      setRemoveError(
        errorReason(err) === 'in_use'
          ? HOSTS_TEXT.inUse
          : errorMessage(err, HOSTS_TEXT.removeFailed),
      );
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>{HOSTS_TEXT.title}</h3>
        <Button onClick={() => setConnecting(true)}>
          <Icon name="plus" /> {HOSTS_TEXT.connect}
        </Button>
      </div>
      <p className="muted">{HOSTS_TEXT.intro}</p>
      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {items === null && !error ? <Spinner label={HOSTS_TEXT.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState level={3} title={HOSTS_TEXT.emptyTitle} description={HOSTS_TEXT.emptyBody} />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label={HOSTS_TEXT.title}>
          {items.map((h) => {
            const s = STATUS[h.status];
            const busy = checking.has(h.id);
            return (
              <li key={h.id} className="ws-list-row" aria-label={h.label}>
                <div className="code-env-main">
                  <div className="code-row-title">
                    <span className="code-env-name" dir="auto">
                      {h.label}
                    </span>
                    <Badge tone={s.tone} icon={s.icon}>
                      {HOSTS_TEXT.status[h.status]}
                    </Badge>
                  </div>
                  <span className="muted code-row-meta">
                    <span className="code-path" dir="ltr">
                      {h.webUrl}
                    </span>
                    <span>
                      {h.login
                        ? HOSTS_TEXT.signedInAs({ login: h.login })
                        : HOSTS_TEXT.unknownAccount}
                    </span>
                    <span>{HOSTS_TEXT.tokenSet}</span>
                    <span>{HOSTS_TEXT.checkedAt({ when: formatWhen(h.checkedAt) })}</span>
                  </span>
                  {h.detail ? (
                    <span className="muted code-detail" dir="auto">
                      {h.detail}
                    </span>
                  ) : null}
                </div>
                <div className="ws-row-actions code-actions">
                  <Button disabled={busy} onClick={() => void check(h)}>
                    {busy ? (
                      <Spinner label={HOSTS_TEXT.checking({ name: h.label })} />
                    ) : (
                      <Icon name="refresh" />
                    )}{' '}
                    {HOSTS_TEXT.check}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setRemoveError(null);
                      setRemoving(h);
                    }}
                  >
                    <Icon name="trash" /> {HOSTS_TEXT.remove}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ConnectHostDialog
        open={connecting}
        onClose={() => setConnecting(false)}
        onConnected={(h) => {
          setConnecting(false);
          setItems((list) => [...(list ?? []), h]);
          toast.show(
            h.status === 'ok'
              ? h.login
                ? HOSTS_TEXT.connectedAs({ name: h.label, login: h.login })
                : HOSTS_TEXT.connected({ name: h.label })
              : HOSTS_TEXT.unreachable({
                  name: h.label,
                  reason: h.detail ?? HOSTS_TEXT.unknownError,
                }),
            { tone: h.status === 'ok' ? 'success' : 'error' },
          );
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={removing ? HOSTS_TEXT.removeTitle({ name: removing.label }) : HOSTS_TEXT.thisHost}
        description={HOSTS_TEXT.removeBody}
        confirmLabel={HOSTS_TEXT.removeConfirm}
        danger
        busy={removeBusy}
        error={removeError}
        onConfirm={() => void remove()}
        onClose={() => setRemoving(null)}
      />
    </section>
  );
}

function ConnectHostDialog({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected: (h: GitHostView) => void;
}) {
  return open ? <ConnectHostForm onClose={onClose} onConnected={onConnected} /> : null;
}

function ConnectHostForm({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (h: GitHostView) => void;
}) {
  const m6 = useCodeM6Api();
  const [enterprise, setEnterprise] = useState(false);
  const [label, setLabel] = useState('');
  const [webUrl, setWebUrl] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!token.trim() || busy) return;
    if (enterprise && (!webUrl.trim() || !apiUrl.trim())) {
      setError(HOSTS_TEXT.enterpriseAddresses);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onConnected(
        await m6.createGitHost({
          kind: 'github',
          token: token.trim(),
          ...(label.trim() ? { label: label.trim() } : {}),
          ...(enterprise ? { webUrl: webUrl.trim(), apiUrl: apiUrl.trim() } : {}),
        }),
      );
    } catch (err) {
      setError(
        errorReason(err) === 'token_rejected'
          ? HOSTS_TEXT.tokenRejected
          : errorMessage(err, HOSTS_TEXT.connectFailed),
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open title={HOSTS_TEXT.connect} description={HOSTS_TEXT.dialogBody} onClose={onClose}>
      <form
        className="stack code-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="code-check">
          <input
            type="checkbox"
            checked={enterprise}
            onChange={(e) => setEnterprise(e.target.checked)}
          />
          {HOSTS_TEXT.enterprise}
        </label>
        {enterprise ? (
          <>
            <TextField
              label={HOSTS_TEXT.webUrl}
              type="url"
              value={webUrl}
              autoComplete="off"
              dir="ltr"
              placeholder={HOSTS_TEXT.webUrlExample}
              onChange={(e) => setWebUrl(e.target.value)}
            />
            <TextField
              label={HOSTS_TEXT.apiUrl}
              type="url"
              value={apiUrl}
              autoComplete="off"
              dir="ltr"
              placeholder={HOSTS_TEXT.apiUrlExample}
              onChange={(e) => setApiUrl(e.target.value)}
            />
          </>
        ) : null}
        <TextField
          label={HOSTS_TEXT.name}
          value={label}
          maxLength={100}
          autoComplete="off"
          placeholder={enterprise ? HOSTS_TEXT.nameEnterprise : HOSTS_TEXT.nameDefault}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          label={HOSTS_TEXT.token}
          type="password"
          value={token}
          required
          autoComplete="off"
          spellCheck={false}
          hint={HOSTS_TEXT.tokenHint}
          onChange={(e) => setToken(e.target.value)}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>{HOSTS_TEXT.cancel}</Button>
          <Button type="submit" variant="primary" disabled={busy || !token.trim()}>
            {busy ? <Spinner /> : null} {HOSTS_TEXT.connectButton}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
