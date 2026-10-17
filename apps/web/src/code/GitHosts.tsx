// Git hosts (FR-070, docs/10 §8): the hosts Code sessions push to and open pull requests on.
// Connect takes a personal access token, which goes to the keychain on the Hub and is never shown
// again; the Hub checks it at once (a rejected token is not saved). Each host shows the account
// it signs in as and its last check. Remove is refused while pull requests opened through it are
// still open. GitHub (and GitHub Enterprise) for now.
import { useCallback, useEffect, useId, useState } from 'react';
import type { GitHostView } from '@nova/shared';
import { Button, Dialog, EmptyState, Icon, Spinner, TextField, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { errorReason } from './m6-format.ts';
import { Badge, ConfirmDialog, ErrorBanner } from './parts.tsx';

const STATUS = {
  ok: { text: 'Connected', icon: 'check', tone: 'ok' },
  error: { text: 'Not working', icon: 'stop', tone: 'danger' },
  unknown: { text: 'Not checked', icon: 'clock', tone: 'muted' },
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
        (err: unknown) => setError(errorMessage(err, 'Could not load the Git hosts.')),
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
      announce(`${next.label}: ${STATUS[next.status].text}.`);
    } catch (err) {
      toast.show(`Could not check ${h.label}: ${errorMessage(err)}`, { tone: 'error' });
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
      toast.show(`Removed ${h.label}.`, { tone: 'success' });
    } catch (err) {
      setRemoveError(
        errorReason(err) === 'in_use'
          ? 'Pull requests opened through this host are still open. Close or merge them first.'
          : errorMessage(err, 'Could not remove the host.'),
      );
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <div className="ws-section-header">
        <h3 id={headingId}>Git hosts</h3>
        <Button onClick={() => setConnecting(true)}>
          <Icon name="plus" /> Connect a Git host
        </Button>
      </div>
      <p className="muted">
        Sessions push branches and open pull requests through these hosts, and show their CI checks.
      </p>
      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {items === null && !error ? <Spinner label="Loading the Git hosts" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title="No Git host connected"
          description="Connect GitHub with a personal access token to push and open pull requests from a session."
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Git hosts">
          {items.map((h) => {
            const s = STATUS[h.status];
            const busy = checking.has(h.id);
            return (
              <li key={h.id} className="ws-list-row" aria-label={h.label}>
                <div className="code-env-main">
                  <div className="code-row-title">
                    <span className="code-env-name">{h.label}</span>
                    <Badge tone={s.tone} icon={s.icon}>
                      {s.text}
                    </Badge>
                  </div>
                  <span className="muted code-row-meta">
                    <span className="code-path">{h.webUrl}</span>
                    <span>{h.login ? `Signed in as ${h.login}` : 'Account not known yet'}</span>
                    <span>Token: set</span>
                    <span>Checked {formatWhen(h.checkedAt)}</span>
                  </span>
                  {h.detail ? <span className="muted code-detail">{h.detail}</span> : null}
                </div>
                <div className="ws-row-actions code-actions">
                  <Button disabled={busy} onClick={() => void check(h)}>
                    {busy ? <Spinner label={`Checking ${h.label}`} /> : <Icon name="refresh" />}{' '}
                    Check
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      setRemoveError(null);
                      setRemoving(h);
                    }}
                  >
                    <Icon name="trash" /> Remove…
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
              ? `Connected ${h.label}${h.login ? ` as ${h.login}` : ''}.`
              : `Saved ${h.label}, but it could not be reached: ${h.detail ?? 'unknown error'}.`,
            { tone: h.status === 'ok' ? 'success' : 'error' },
          );
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.label ?? 'this host'}?`}
        description="Its token is deleted from the keychain. Sessions cannot push or open pull requests there until you connect it again."
        confirmLabel="Remove"
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
      setError('Enter the web address and the API address of your GitHub Enterprise server.');
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
          ? 'The host rejected the token. Check that it is current and has the repo scope.'
          : errorMessage(err, 'Could not connect the host.'),
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title="Connect a Git host"
      description="The token is stored in the keychain on the Hub and is never shown again."
      onClose={onClose}
    >
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
          GitHub Enterprise (your own server)
        </label>
        {enterprise ? (
          <>
            <TextField
              label="Web address"
              type="url"
              value={webUrl}
              autoComplete="off"
              placeholder="https://github.example.com"
              onChange={(e) => setWebUrl(e.target.value)}
            />
            <TextField
              label="API address"
              type="url"
              value={apiUrl}
              autoComplete="off"
              placeholder="https://github.example.com/api/v3"
              onChange={(e) => setApiUrl(e.target.value)}
            />
          </>
        ) : null}
        <TextField
          label="Name (optional)"
          value={label}
          maxLength={100}
          autoComplete="off"
          placeholder={enterprise ? 'Work GitHub' : 'github.com'}
          onChange={(e) => setLabel(e.target.value)}
        />
        <TextField
          label="Personal access token"
          type="password"
          value={token}
          required
          autoComplete="off"
          spellCheck={false}
          hint="Needs access to the repositories’ contents, pull requests and checks."
          onChange={(e) => setToken(e.target.value)}
        />
        {error ? (
          <p className="nv-field-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="nv-dialog-footer">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !token.trim()}>
            {busy ? <Spinner /> : null} Connect
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
