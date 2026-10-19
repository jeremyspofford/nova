// Environments at /code/environments (FR-062, FR-078; docs/10 §2): every saved environment with
// its kind, where it connects, its health and when it was checked, and the sessions using it.
// New environment, Check, Edit and Delete (refused while active sessions use it); This Hub is
// built in. Environments whose helper runs commands (SSH, WSL, device) list their processes with
// the output buffered while the app was away. Health follows `environment.*` events. M7: an SSH
// row shows its pinned host key with its fingerprint and explains a mismatch; cloud environments
// are created here or in Settings → Cloud runner and managed on their own page there.
import { useCallback, useEffect, useState } from 'react';
import type { DeviceView, SavedEnvironmentView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useAnnounce } from '../services.tsx';
import { formatWhen, plural } from '../settings/common.ts';
import { NewCloudEnvironmentButton } from '../cloud/NewCloudEnvironment.tsx';
import { cloudEnvPath } from '../cloud/format.ts';
import { navigate } from '../router.ts';
import { useCodeM6Api } from './api-m6.ts';
import { CodeNav } from './CodeNav.tsx';
import { EnvironmentDialog } from './EnvironmentDialog.tsx';
import { useCodeEvents, useCoalesced } from './events.ts';
import {
  HEALTH_ICON,
  HEALTH_TEXT,
  HEALTH_TONE,
  KIND_LABEL,
  connectionSummary,
  isRemoteKind,
} from './m6-format.ts';
import { Badge, ConfirmDialog, ErrorBanner } from './parts.tsx';
import { ProcessesPanel } from './ProcessesPanel.tsx';
import { SshHostKey } from './SshHostKey.tsx';
import '../workspace.css';

type DialogState = { editing: SavedEnvironmentView | null } | null;

export function EnvironmentsPage({ visible = true }: { visible?: boolean }) {
  const m6 = useCodeM6Api();
  const toast = useToast();
  const announce = useAnnounce();
  const [items, setItems] = useState<SavedEnvironmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [checking, setChecking] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [deleting, setDeleting] = useState<SavedEnvironmentView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      m6.listSavedEnvironments().then(
        ({ items: list }) => {
          setItems(list);
          setError(null);
        },
        (err: unknown) => setError(errorMessage(err, 'Could not load the environments.')),
      ),
    [m6],
  );
  const reload = useCoalesced(load);
  useEffect(() => {
    if (visible) reload();
  }, [reload, visible]);
  useCodeEvents(visible, (env) => {
    if (env.name.startsWith('environment.') || env.name.startsWith('code.session.')) reload();
  });

  // Device names for WSL and device environments; without them the id is shown.
  const needsDevices = (items ?? []).some((e) => e.kind === 'wsl' || e.kind === 'device');
  useEffect(() => {
    if (!visible || !needsDevices) return;
    let alive = true;
    m6.listEnvironmentDevices().then(
      ({ items: list }) => alive && setDevices(list),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [m6, needsDevices, visible]);
  const deviceName = (id: string) => devices.find((x) => x.id === id)?.name ?? `device ${id}`;

  const replace = (e: SavedEnvironmentView) =>
    setItems((list) =>
      list?.some((x) => x.id === e.id)
        ? list.map((x) => (x.id === e.id ? e : x))
        : [...(list ?? []), e],
    );

  const check = async (e: SavedEnvironmentView) => {
    setChecking((s) => new Set([...s, e.id]));
    try {
      const next = await m6.checkEnvironment(e.id);
      replace(next);
      announce(`${next.label}: ${HEALTH_TEXT[next.status]}.`);
    } catch (err) {
      toast.show(`Could not check ${e.label}: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setChecking((s) => {
        const n = new Set(s);
        n.delete(e.id);
        return n;
      });
    }
  };

  const remove = async () => {
    const e = deleting;
    if (!e) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await m6.deleteEnvironment(e.id);
      setItems((list) => list?.filter((x) => x.id !== e.id) ?? null);
      setDeleting(null);
      toast.show(`Deleted ${e.label}.`, { tone: 'success' });
    } catch (err) {
      setDeleteError(errorMessage(err, 'Could not delete the environment.'));
    } finally {
      setDeleteBusy(false);
    }
  };

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="ws-page code-m6-page">
      <header className="ws-page-header">
        <h1>Environments</h1>
        <span className="ws-row-actions code-actions">
          <NewCloudEnvironmentButton />
          <Button variant="primary" onClick={() => setDialog({ editing: null })}>
            <Icon name="plus" /> New environment
          </Button>
        </span>
      </header>
      <CodeNav current="environments" />
      <p className="muted">
        Where Code sessions run: the Hub itself, a container image, an SSH host, a WSL distro, a
        device with the Nova device agent, or the cloud runner. Pick one when you start a session.
      </p>
      {error ? <ErrorBanner message={error} onRetry={reload} /> : null}
      {items === null && !error ? <Spinner label="Loading the environments" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          title="No environments yet"
          description="Sessions run on the Hub until you add another environment."
          icon="server"
          action={<Button onClick={() => setDialog({ editing: null })}>New environment</Button>}
        />
      ) : null}
      {items?.length ? (
        <ul className="ws-list" aria-label="Environments">
          {items.map((e) => {
            const busy = checking.has(e.id);
            const remote = isRemoteKind(e.kind);
            const c = e.connection;
            return (
              <li key={e.id} className="code-env-row" aria-label={e.label}>
                <div className="code-env-main">
                  <div className="code-row-title">
                    <span className="code-env-name">{e.label}</span>
                    <span className="code-kind">{e.builtIn ? 'Built in' : KIND_LABEL[e.kind]}</span>
                    <Badge tone={HEALTH_TONE[e.status]} icon={HEALTH_ICON[e.status]}>
                      {HEALTH_TEXT[e.status]}
                    </Badge>
                  </div>
                  <span className="code-path">{connectionSummary(c, deviceName)}</span>
                  {e.detail ? <span className="muted code-detail">{e.detail}</span> : null}
                  <span className="muted code-row-meta">
                    <span>Checked {formatWhen(e.checkedAt)}</span>
                    <span>
                      {e.sessions ? plural(e.sessions, 'active session') : 'No active sessions'}
                    </span>
                    {c.kind === 'ssh' ? (
                      <span>
                        {c.auth === 'key' ? 'Key' : 'Password'}:{' '}
                        {c.hasCredential ? 'set' : 'not set'}
                      </span>
                    ) : null}
                    {c.kind === 'ssh' && c.hostKey ? <span>Host key pinned</span> : null}
                  </span>
                  {c.kind === 'ssh' ? <SshHostKey env={e} onChanged={replace} /> : null}
                </div>
                <div className="ws-row-actions code-actions">
                  <Button disabled={busy} onClick={() => void check(e)}>
                    {busy ? <Spinner label={`Checking ${e.label}`} /> : <Icon name="refresh" />}{' '}
                    Check
                  </Button>
                  {remote ? (
                    <Button aria-expanded={open.has(e.id)} onClick={() => toggle(e.id)}>
                      <Icon name="terminal" /> Processes
                    </Button>
                  ) : null}
                  {e.builtIn ? null : (
                    <>
                      {e.kind === 'cloud' ? (
                        <Button onClick={() => navigate(cloudEnvPath(e.id))}>
                          <Icon name="settings" /> Manage
                        </Button>
                      ) : (
                        <Button onClick={() => setDialog({ editing: e })}>
                          <Icon name="edit" /> Edit…
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        onClick={() => {
                          setDeleteError(null);
                          setDeleting(e);
                        }}
                      >
                        <Icon name="trash" /> Delete…
                      </Button>
                    </>
                  )}
                </div>
                {remote && open.has(e.id) ? (
                  <div className="code-env-procs">
                    <ProcessesPanel
                      environmentId={e.id}
                      title={`Processes on ${e.label}`}
                      visible={visible}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <EnvironmentDialog
        open={dialog !== null}
        editing={dialog?.editing ?? null}
        onClose={() => setDialog(null)}
        onSaved={(e, created) => {
          setDialog(null);
          replace(e);
          toast.show(created ? `Created ${e.label}.` : `Saved ${e.label}.`, { tone: 'success' });
          // A new or changed environment is checked at once, so its health is not a guess.
          void check(e);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete ${deleting?.label ?? 'this environment'}?`}
        description={
          deleting?.kind === 'cloud'
            ? 'Sessions that used it keep their history. It is removed from the cloud runner with its files and snapshots.'
            : 'Sessions that used it keep their history. Its stored key or password is removed from the keychain.'
        }
        confirmLabel="Delete"
        danger
        busy={deleteBusy}
        error={deleteError}
        onConfirm={() => void remove()}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}
