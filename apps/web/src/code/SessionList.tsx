// Code sessions at /code (FR-061, FR-215): every session with its folder, branch and whether it
// has uncommitted changes, its permission mode, status chip and last update; Needs input first.
// A session on another environment than This Hub names it (FR-062). "New session" opens the
// dialog; `/code?new=1` opens it too. The Code tabs lead to Environments and Worktrees (M6).
import { useCallback, useEffect, useState } from 'react';
import type { CodeSessionView, EnvironmentView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, StatusChip, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import { useServices } from '../services.tsx';
import { formatWhen } from '../settings/common.ts';
import { CodeNav } from './CodeNav.tsx';
import { useCodeEvents, useCoalesced } from './events.ts';
import { branchText, sessionPath, sessionTitle, sortSessions } from './labels.ts';
import { MODE_LABEL } from './modes.ts';
import { NewSessionDialog } from './NewSessionDialog.tsx';

export function SessionList({ visible }: { visible: boolean }) {
  const { api } = useServices();
  const toast = useToast();
  const loc = useLocation();
  const [sessions, setSessions] = useState<CodeSessionView[] | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // `?new=1` opens the dialog once, then the URL goes back to /code.
  const wantsNew =
    visible && new URLSearchParams(loc.slice(loc.indexOf('?') + 1)).get('new') === '1';
  if (wantsNew && loc.includes('?') && !creating) setCreating(true);
  useEffect(() => {
    if (wantsNew) navigate(sessionPath(null), { replace: true });
  }, [wantsNew]);

  const load = useCallback(
    () =>
      api.listCodeSessions().then(
        ({ items }) => {
          setSessions(sortSessions(items));
          setError(null);
        },
        (err: unknown) => setError(errorMessage(err, 'Could not load Code sessions.')),
      ),
    [api],
  );
  const reload = useCoalesced(load);
  useEffect(() => {
    if (visible) reload();
  }, [reload, visible]);
  // Environment names for sessions that do not run on the Hub itself.
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    api.listEnvironments().then(
      ({ items }) => alive && setEnvironments(items),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, visible]);
  useCodeEvents(visible, (env) => {
    if (env.name.startsWith('code.session.') || env.name === 'thread.status.changed') reload();
  });
  const envOf = (s: CodeSessionView) =>
    environments.find((e) => e.id === s.environmentId && e.kind !== 'local') ?? null;

  return (
    <div className="ws-page code-sessions-page">
      <header className="ws-page-header">
        <h1>Code</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> New session
        </Button>
      </header>
      <CodeNav current="sessions" />
      <p className="muted">
        A Code session works in one folder on the Hub with a permission mode you choose. Its edits
        show as diffs you accept or reject.
      </p>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={reload}>Retry</Button>
        </div>
      ) : null}
      {sessions === null && !error ? <Spinner label="Loading Code sessions" /> : null}
      {sessions?.length === 0 ? (
        <EmptyState
          title="No Code sessions yet"
          description="Start a session in a project folder or any folder on the Hub."
          icon="code"
          level={2}
          action={<Button onClick={() => setCreating(true)}>Start a session</Button>}
        />
      ) : null}
      {sessions?.length ? (
        <ul className="code-session-list" aria-label="Code sessions">
          {sessions.map((s) => {
            const title = sessionTitle(s);
            const env = envOf(s);
            return (
              <li key={s.id} className="code-session-row" aria-label={title}>
                <div className="code-session-main">
                  <a
                    href={sessionPath(s.id)}
                    className="code-session-link"
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      navigate(sessionPath(s.id));
                    }}
                  >
                    {title}
                  </a>
                  <StatusChip status={s.derived.status} reason={s.derived.reason ?? undefined} />
                </div>
                <span className="muted code-session-meta">
                  <span className="code-path">{s.folder.path}</span>
                  <span>
                    <Icon name="branch" /> {branchText(s.repo)}
                  </span>
                  <span>Mode: {MODE_LABEL[s.permissionMode]}</span>
                  {env ? (
                    <span>
                      <Icon name="server" /> On {env.label}
                    </span>
                  ) : null}
                  <span>Updated {formatWhen(s.updatedAt)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <NewSessionDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(s) => {
          setCreating(false);
          toast.show(`Session “${sessionTitle(s)}” started.`, { tone: 'success' });
          navigate(sessionPath(s.id));
        }}
      />
    </div>
  );
}
