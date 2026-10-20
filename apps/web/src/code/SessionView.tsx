// One Code session at /code/:id (FR-061..FR-066, FR-069, FR-074; docs/04 §2.4): a header with
// the folder, branch, uncommitted state, status, environment, pull request and CI status, symbol
// search, Review, Commit, and in M6 Branch, Push and Pull request (FR-070); the session's budget
// (docs/09 §2); the session's conversation (the ordinary chat view of its `code` thread, with the
// permission mode selector in its composer); and panes for the Diff, the Review, the Terminal, a
// File, the Pull request with its CI checks, the auto-verify Checks (FR-068), Dev servers
// (FR-097, FR-067) and the other Sessions with side questions (FR-072, Ctrl/Cmd+Alt+S). M7 adds
// Hand off… and Best of N… with the Attempts, Merges and Moves tabs, a cloud session's run usage,
// and the flagged Agents and Scripts tabs (SessionM7.tsx). A session on another machine (SSH, WSL,
// a device, the cloud) has its diff, review, commit and branches captured by the Hub (M7) and says
// plainly which of the rest work only on the Hub. The diff follows `code.*` events and reloads
// after every turn of the session's thread.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  CodeChangeView,
  CodeReviewView,
  CodeSessionExtrasView,
  CodeSessionView,
  CodeSymbolView,
  DiffCommentView,
  EnvironmentView,
  PermissionMode,
  ReviewFindingView,
} from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, Icon, Spinner, StatusChip, rovingIndex, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { ChatView } from '../chat/ChatView.tsx';
import { rich } from '../chat/rich.tsx';
import { CloudFiles } from '../cloud/CloudFiles.tsx';
import { matchesBinding } from '../keys.ts';
import { navigate } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useInterval } from '../settings/common.ts';
import { useCodeM6Api } from './api-m6.ts';
import { BudgetBar } from './BudgetBar.tsx';
import { ChecksPane } from './ChecksPane.tsx';
import { AppLink } from './CodeNav.tsx';
import { CommitDialog } from './CommitDialog.tsx';
import { DevServersPane } from './DevServersPane.tsx';
import { diffTotals, mergeChanges } from './diff.ts';
import { DiffPane } from './DiffPane.tsx';
import {
  EXTRAS_EVENTS,
  eventSessionId,
  useCodeEvents,
  useCoalesced,
  useThreadBusEvents,
} from './events.ts';
import { FilePane, type FileTarget } from './FilePane.tsx';
import { BranchDialog, PullRequestDialog, PushDialog } from './GitDialogs.tsx';
import { branchText, environmentLabel, sessionPath, sessionTitle } from './labels.ts';
import {
  CI_ICON,
  CI_TEXT,
  CI_TONE,
  KIND_LABEL,
  asCiStatus,
  isLive,
  isRemoteKind,
  safeHttpUrl,
} from './m6-format.ts';
import { ModeSelect, useModeContext } from './ModeSelect.tsx';
import { MODE_LABEL } from './modes.ts';
import { Badge } from './parts.tsx';
import { ProcessesPanel } from './ProcessesPanel.tsx';
import { PullRequestPane } from './PullRequestPane.tsx';
import { ReviewPane } from './ReviewPane.tsx';
import { useSessionM7, type M7Tab } from './SessionM7.tsx';
import { SessionsPane, SideQuestionDialog } from './SessionsPane.tsx';
import { SymbolSearch } from './SymbolSearch.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { OpenInWindowButton } from '../shellbridge/OpenInWindow.tsx';

export const SESSION_TEXT = defineMessages('code.session', {
  missing: 'This Code session does not exist.',
  loadFailed: 'Could not load the session.',
  changesFailed: 'Could not load the changes.',
  reviewFailed: 'Could not load the review.',
  prStatus: 'Pull request: {status}.',
  modeChanged: 'Permission mode: {mode}.',
  modeFailed: 'Could not change the permission mode: {reason}',
  reviewFinished: 'Review finished.',
  reviewStartFailed: 'Could not start the review.',
  /** Sent to the agent when the user applies a review finding's fix. */
  applyFix: 'Apply the fix the code review suggested for “{title}”:',
  fileLine: '{path}, line {line}',
  fixSent: 'Fix sent to the agent.',
  fixFailed: 'Could not send the fix: {reason}',
  openedSymbol: 'Opened {path} at line {line}.',
  retry: 'Retry',
  allSessions: 'All sessions',
  loading: 'Loading the session',
  loadingDots: 'Loading…',
  remote:
    'This session runs on {environment} ({kind}). Go to symbol, push, pull requests, dev servers, Best of N and merging other sessions work only for folders on the Hub; the agent, the terminal, the diff, review, commits and branches work there.',
  anotherMachine: 'another machine',
  noRepo: 'This folder is not a Git repository.',
  gitRemote: 'Not available for a session on another machine.',
  label: 'Code session: {title}',
  sessions: 'Sessions',
  workerOf: 'Worker of {parent}',
  workerRoleOf: 'Worker ({role}) of {parent}',
  parent: 'its parent session',
  prNumber: 'Pull request #{number}',
  showChecks: '{status}: show the checks',
  pr: 'Pull request',
  prChecks:
    '{status, select, none {Pull request (checks: none)} queued {Pull request (checks: queued)} running {Pull request (checks: running)} passed {Pull request (checks: passed)} failed {Pull request (checks: failed)} other {Pull request (checks: {status})}}',
  review: 'Review',
  commit: 'Commit…',
  branch: 'Branch…',
  push: 'Push…',
  prOpen: 'Pull request…',
  setupRunning: 'Setting up the environment: the setup script is running.',
  setupFailed: 'The environment’s setup script failed.',
  setupFailedBecause: 'The environment’s setup script failed: {detail}',
  panes: 'Session panes',
  tab: {
    diff: 'Diff',
    diffCount: 'Diff ({n})',
    review: 'Review',
    terminal: 'Terminal',
    file: 'File',
    pr: 'Pull request',
    checks: 'Checks',
    servers: 'Dev servers',
    serversCount: 'Dev servers ({n})',
    sessions: 'Sessions',
  },
  processesOn: 'Processes on {environment}',
  prRemote: 'Pushing and pull requests work only for sessions whose folder is on the Hub.',
  serversRemote: 'Dev servers run only for sessions whose folder is on the Hub.',
  committed: 'Committed to {branch}.',
  switched: 'Switched to the new branch {branch}.',
  nowOn: 'Now on {branch}.',
  pushed: 'Pushed {branch} to {remote}.',
  prOpened: 'Opened pull request #{number}.',
});

type PaneTab =
  'diff' | 'review' | 'terminal' | 'file' | 'pr' | 'checks' | 'servers' | 'sessions' | M7Tab;

/** How often a running review is checked, besides its completion event. */
export const REVIEW_POLL_MS = 1500;
/** The side question key (FR-072); remappable once the palette has a command for it. */
export const SIDE_QUESTION_KEY = 'mod+alt+s';

type GitDialog = 'branch' | 'push' | 'pr' | null;

export function SessionView({ id, visible }: { id: string; visible: boolean }) {
  const { api, registry } = useServices();
  const m6 = useCodeM6Api();
  const toast = useToast();
  const announce = useAnnounce();
  const remoteNoteId = useId();
  const [session, setSession] = useState<CodeSessionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<EnvironmentView[]>([]);
  const [changes, setChanges] = useState<CodeChangeView[] | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [comments, setComments] = useState<DiffCommentView[]>([]);
  const [review, setReview] = useState<CodeReviewView | null>(null);
  const [reviewStarting, setReviewStarting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [tab, setTab] = useState<PaneTab>('diff');
  const [fileTarget, setFileTarget] = useState<FileTarget | null>(null);
  const [committing, setCommitting] = useState(false);
  // ---- M6 ----
  const [extras, setExtras] = useState<CodeSessionExtrasView | null>(null);
  const [gitDialog, setGitDialog] = useState<GitDialog>(null);
  const [asking, setAsking] = useState<CodeSessionView | null>(null);
  const [verifyVersion, setVerifyVersion] = useState(0);
  const [serverVersion, setServerVersion] = useState(0);
  const [sessionsVersion, setSessionsVersion] = useState(0);

  // ---- loading -----------------------------------------------------------------------------------
  const loadSession = useCallback(
    () =>
      api.getCodeSession(id).then(
        (s) => {
          setSession(s);
          setLoadError(null);
        },
        (err: unknown) =>
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? SESSION_TEXT.missing
              : errorMessage(err, SESSION_TEXT.loadFailed),
          ),
      ),
    [api, id],
  );
  const loadChanges = useCallback(
    () =>
      Promise.all([api.listChanges(id), api.listComments(id)]).then(
        ([c, m]) => {
          setChanges(c.items);
          setComments(m.items);
          setChangesError(null);
        },
        (err: unknown) => setChangesError(errorMessage(err, SESSION_TEXT.changesFailed)),
      ),
    [api, id],
  );
  const loadReview = useCallback(
    (reviewId: string) =>
      api
        .getReview(id, reviewId)
        .then(setReview, (err: unknown) =>
          setReviewError(errorMessage(err, SESSION_TEXT.reviewFailed)),
        ),
    [api, id],
  );
  // The M6 facts (environment, budget, pull request, last checks, dev servers). Without them
  // (an older Hub) the M5 header stays as it was.
  const loadExtras = useCallback(
    () =>
      m6.getCodeSessionExtras(id).then(
        (x) => setExtras(x),
        () => undefined,
      ),
    [id, m6],
  );
  const reloadSession = useCoalesced(loadSession);
  const reloadChanges = useCoalesced(loadChanges);
  const reloadExtras = useCoalesced(loadExtras);

  useEffect(() => {
    if (!visible) return;
    reloadSession();
    reloadChanges();
    reloadExtras();
    let alive = true;
    api.listEnvironments().then(
      ({ items }) => alive && setEnvironments(items),
      // Without the list the header leaves the environment out; modes fall back to local rules.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, reloadChanges, reloadExtras, reloadSession, visible]);

  const threadId = session?.threadId ?? null;
  useCodeEvents(visible, (env) => {
    // Other sessions' changes matter to the Sessions pane.
    if (env.name.startsWith('code.session.') || env.name === 'thread.status.changed')
      setSessionsVersion((v) => v + 1);
    const about = eventSessionId(env);
    if (about && about !== id && about !== threadId) return;
    if (EXTRAS_EVENTS.has(env.name)) reloadExtras();
    if (env.name.startsWith('code.verify.')) setVerifyVersion((v) => v + 1);
    if (env.name.startsWith('code.devserver.')) setServerVersion((v) => v + 1);
    if (env.name === 'code.pr.ci.changed') {
      const status = asCiStatus(env.payload.status);
      if (status) announce(SESSION_TEXT.prStatus({ status: CI_TEXT[status] }));
    }
    switch (env.name) {
      case 'code.changes.updated':
      case 'code.change.applied':
      case 'code.change.reverted':
      case 'code.commit.created':
        reloadChanges();
        reloadSession();
        break;
      case 'code.diff.commented':
        reloadChanges();
        break;
      case 'code.review.completed':
        if (review) void loadReview(review.id);
        break;
      default:
        reloadSession();
    }
  });
  // After each turn of the session's thread, and after each tool call, the diff may have moved.
  useThreadBusEvents(visible ? threadId : null, (env) => {
    if (env.name === 'turn.completed' || env.name === 'turn.interrupted') {
      reloadChanges();
      reloadSession();
      // Budget use is written per step; the bar catches up when a turn ends.
      reloadExtras();
    } else if (env.name === 'tool.call.completed') reloadChanges();
  });
  useInterval(
    () => {
      if (review) void loadReview(review.id);
    },
    REVIEW_POLL_MS,
    visible && review?.status === 'running',
  );

  // Ctrl/Cmd+Alt+S asks a side question about this session (FR-072).
  const mac = registry.platform.mac;
  useEffect(() => {
    if (!visible || !session) return;
    const s = session;
    const onKey = (e: KeyboardEvent) => {
      if (!matchesBinding(e, SIDE_QUESTION_KEY, mac)) return;
      e.preventDefault();
      setAsking(s);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mac, session, visible]);

  // ---- actions -----------------------------------------------------------------------------------
  const environment = environments.find((e) => e.id === session?.environmentId) ?? null;
  const ctx = useModeContext(environment);
  // ---- M7: handoff, best-of-N, merges, cloud runs, flagged panes ----
  const m7 = useSessionM7({
    session,
    extras,
    environment,
    tab,
    onTab: setTab,
    onMoved: () => {
      reloadSession();
      reloadChanges();
      reloadExtras();
      api.listEnvironments().then(
        ({ items }) => setEnvironments(items),
        () => undefined,
      );
    },
  });

  const changeMode = (mode: PermissionMode) => {
    if (!session || mode === session.permissionMode) return;
    const before = session;
    setSession({ ...session, permissionMode: mode });
    api.updateCodeSession(id, { permissionMode: mode }).then(
      (s) => {
        setSession(s);
        announce(SESSION_TEXT.modeChanged({ mode: MODE_LABEL[s.permissionMode] }));
      },
      (err: unknown) => {
        setSession(before);
        toast.show(SESSION_TEXT.modeFailed({ reason: errorMessage(err) }), {
          tone: 'error',
        });
      },
    );
  };

  const runReview = async () => {
    setTab('review');
    setReviewStarting(true);
    setReviewError(null);
    try {
      const r = await api.startReview(id);
      setReview(r);
      if (r.status === 'done') announce(SESSION_TEXT.reviewFinished);
    } catch (err) {
      setReviewError(errorMessage(err, SESSION_TEXT.reviewStartFailed));
    } finally {
      setReviewStarting(false);
    }
  };

  /**
   * "Apply fix" sends the reviewer's suggestion to the agent: as a diff comment at the finding's
   * line when it is on a changed file (so it shows in the diff too), else as a message in the
   * session's thread. The user's click is what makes it an instruction; the text says it is a
   * suggestion from the review.
   */
  const applyFix = async (f: ReviewFindingView): Promise<boolean> => {
    if (!session || !f.fix) return false;
    const body = `${SESSION_TEXT.applyFix({ title: f.title })}\n\n${fenced(f.fix)}`;
    const change = (changes ?? []).find((c) => c.path === f.path);
    try {
      if (change && f.line !== null) {
        const { items } = await api.addComments(id, {
          comments: [{ changeId: change.id, line: f.line, side: 'new', body }],
          submit: true,
        });
        setComments((list) => mergeById(list, items));
      } else {
        const where =
          f.line !== null ? SESSION_TEXT.fileLine({ path: f.path, line: String(f.line) }) : f.path;
        await api.sendMessage(session.threadId, { text: `${where}: ${body}` });
      }
      announce(SESSION_TEXT.fixSent);
      return true;
    } catch (err) {
      toast.show(SESSION_TEXT.fixFailed({ reason: errorMessage(err) }), { tone: 'error' });
      return false;
    }
  };

  const openSymbol = (s: CodeSymbolView) => {
    setFileTarget((t) => ({ path: s.path, line: s.line, n: (t?.n ?? 0) + 1 }));
    setTab('file');
    announce(SESSION_TEXT.openedSymbol({ path: s.path, line: String(s.line) }));
  };

  // ---- render ------------------------------------------------------------------------------------
  if (!session)
    return loadError ? (
      <div className="ws-page">
        <div className="ws-error" role="alert">
          <p>{loadError}</p>
          <Button onClick={reloadSession}>{SESSION_TEXT.retry}</Button>
          <Button onClick={() => navigate(sessionPath(null))}>{SESSION_TEXT.allSessions}</Button>
        </div>
      </div>
    ) : (
      <p className="muted pane-note">
        <Spinner label={SESSION_TEXT.loading} /> {SESSION_TEXT.loadingDots}
      </p>
    );

  const title = sessionTitle(session);
  const totals = diffTotals(changes ?? []);
  const prUrl = safeHttpUrl(session.pullRequestUrl);
  const pr = extras?.pullRequest ?? null;
  const prLink = pr ? safeHttpUrl(pr.url) : null;
  const envKind = extras?.environment?.kind ?? environment?.kind ?? null;
  const envName = extras?.environment?.label ?? environment?.label ?? null;
  const remote = isRemoteKind(envKind);
  const remoteText = remote
    ? SESSION_TEXT.remote({
        environment: envName ?? SESSION_TEXT.anotherMachine,
        kind: KIND_LABEL[envKind ?? 'device'],
      })
    : null;
  const noRepo = !session.repo ? SESSION_TEXT.noRepo : null;
  // Push and pull requests still need the folder on the Hub (M7 captures the rest remotely).
  const gitUnavailable = noRepo ?? (remote ? SESSION_TEXT.gitRemote : null);
  const liveServers = (extras?.devServers ?? []).filter(isLive).length;
  const setup = extras?.setup ?? null;

  return (
    <section className="code-session" aria-label={SESSION_TEXT.label({ title })}>
      <header className="code-header">
        <a
          href={sessionPath(null)}
          className="code-back"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate(sessionPath(null));
          }}
        >
          <Icon name="back" /> {SESSION_TEXT.sessions}
        </a>
        <h1 className="code-title" dir="auto">
          {title}
        </h1>
        <OpenInWindowButton path={`/code/${encodeURIComponent(id)}`} what={title} compact />
        <StatusChip status={session.derived.status} reason={session.derived.reason ?? undefined} />
        <span className="code-header-meta muted">
          <span className="code-path" title={session.folder.path}>
            <Icon name="folder" /> <span dir="ltr">{session.folder.path}</span>
          </span>
          <span data-dirty={session.repo?.dirty || undefined}>
            <Icon name="branch" /> {branchText(session.repo)}
          </span>
          {environment ? (
            <span>{environmentLabel(environment)}</span>
          ) : envName ? (
            <span>{envName}</span>
          ) : null}
          {extras?.parentSessionId ? (
            <span>
              {rich(extras.role ? SESSION_TEXT.workerRoleOf : SESSION_TEXT.workerOf, {
                role: extras.role ?? '',
                parent: (
                  <AppLink to={sessionPath(extras.parentSessionId)}>{SESSION_TEXT.parent}</AppLink>
                ),
              })}
            </span>
          ) : null}
          {pr ? (
            <span className="code-pr-chip">
              {prLink ? (
                <a href={prLink} target="_blank" rel="noopener noreferrer">
                  <Icon name="external" /> {SESSION_TEXT.prNumber({ number: String(pr.number) })}
                </a>
              ) : (
                <span>{SESSION_TEXT.prNumber({ number: String(pr.number) })}</span>
              )}{' '}
              <button
                type="button"
                className="code-chip-button"
                onClick={() => setTab('pr')}
                aria-label={SESSION_TEXT.showChecks({ status: CI_TEXT[pr.ci.status] })}
              >
                <Badge tone={CI_TONE[pr.ci.status]} icon={CI_ICON[pr.ci.status]}>
                  {CI_TEXT[pr.ci.status]}
                </Badge>
              </button>
            </span>
          ) : prUrl ? (
            <a href={prUrl} target="_blank" rel="noreferrer noopener">
              <Icon name="external" />{' '}
              {session.ciStatus
                ? SESSION_TEXT.prChecks({ status: session.ciStatus })
                : SESSION_TEXT.pr}
            </a>
          ) : null}
        </span>
        <span className="code-header-actions">
          {remote ? null : <SymbolSearch sessionId={id} onPick={openSymbol} />}
          <Button onClick={() => void runReview()} disabled={reviewStarting}>
            <Icon name="eye" /> {SESSION_TEXT.review}
          </Button>
          <Button
            variant="primary"
            disabled={!session.repo}
            title={noRepo ?? undefined}
            onClick={() => setCommitting(true)}
          >
            <Icon name="save" /> {SESSION_TEXT.commit}
          </Button>
          <Button
            disabled={!!noRepo}
            title={noRepo ?? undefined}
            onClick={() => setGitDialog('branch')}
          >
            <Icon name="branch" /> {SESSION_TEXT.branch}
          </Button>
          <Button
            disabled={!!gitUnavailable}
            title={gitUnavailable ?? undefined}
            onClick={() => setGitDialog('push')}
          >
            <Icon name="forward" /> {SESSION_TEXT.push}
          </Button>
          <Button
            disabled={!!gitUnavailable}
            title={gitUnavailable ?? undefined}
            onClick={() => (pr && pr.state === 'open' ? setTab('pr') : setGitDialog('pr'))}
          >
            <Icon name="compare" />{' '}
            {pr && pr.state === 'open' ? SESSION_TEXT.pr : SESSION_TEXT.prOpen}
          </Button>
          {m7.actions}
        </span>
      </header>
      {remoteText ? (
        <p id={remoteNoteId} className="code-remote-note" role="note">
          <Icon name="server" /> {remoteText}
        </p>
      ) : null}
      {setup?.status === 'running' ? (
        <p className="code-remote-note" role="status">
          <Spinner /> {SESSION_TEXT.setupRunning}
        </p>
      ) : setup?.status === 'failed' ? (
        <p className="code-remote-note" data-tone="danger" role="alert">
          <Icon name="alert" />{' '}
          {setup.detail
            ? SESSION_TEXT.setupFailedBecause({ detail: setup.detail })
            : SESSION_TEXT.setupFailed}
        </p>
      ) : null}
      {extras ? (
        <BudgetBar
          sessionId={id}
          budget={extras.budget}
          onChanged={(budget) => setExtras((x) => (x ? { ...x, budget } : x))}
        />
      ) : null}
      {m7.banner}
      <div className="code-body">
        <div className="code-chat">
          <ChatView
            key={session.threadId}
            threadId={session.threadId}
            active={visible}
            embedded
            composerAccessory={
              <ModeSelect
                className="composer-mode"
                hideLabel
                value={session.permissionMode}
                onChange={changeMode}
                ctx={ctx}
              />
            }
          />
        </div>
        <div className="code-panes">
          <PaneTabs
            label={SESSION_TEXT.panes}
            value={tab}
            onChange={setTab}
            items={[
              {
                id: 'diff',
                label: totals.files
                  ? SESSION_TEXT.tab.diffCount({ n: totals.files })
                  : SESSION_TEXT.tab.diff,
                panel: (
                  <DiffPane
                    sessionId={id}
                    changes={changes}
                    loadError={changes === null ? changesError : null}
                    comments={comments}
                    findings={review?.status === 'done' ? review.findings : []}
                    onChanged={(updated) => setChanges((list) => mergeChanges(list ?? [], updated))}
                    onCommented={(added) => setComments((list) => mergeById(list, added))}
                    onRetry={reloadChanges}
                  />
                ),
              },
              {
                id: 'review',
                label: SESSION_TEXT.tab.review,
                panel: (
                  <ReviewPane
                    review={review}
                    starting={reviewStarting}
                    error={reviewError}
                    onRun={() => void runReview()}
                    onApplyFix={applyFix}
                  />
                ),
              },
              {
                id: 'terminal',
                label: SESSION_TEXT.tab.terminal,
                panel: (
                  <>
                    <TerminalPane session={session} visible={visible && tab === 'terminal'} />
                    {remote && extras?.environment ? (
                      <ProcessesPanel
                        environmentId={extras.environment.id}
                        sessionId={id}
                        title={SESSION_TEXT.processesOn({
                          environment: extras.environment.label,
                        })}
                        visible={visible && tab === 'terminal'}
                      />
                    ) : null}
                  </>
                ),
              },
              {
                id: 'file',
                label: SESSION_TEXT.tab.file,
                // A cloud session's files are on the runner (the Hub's file tools are hidden there).
                panel:
                  envKind === 'cloud' && extras?.environment ? (
                    <CloudFiles
                      environmentId={extras.environment.id}
                      start={session.folder.path}
                      disabled={null}
                    />
                  ) : (
                    <FilePane
                      root={session.repo?.root ?? session.folder.path}
                      target={fileTarget}
                      threadId={session.threadId}
                      mac={registry.platform.mac}
                    />
                  ),
              },
              {
                id: 'pr',
                label: SESSION_TEXT.tab.pr,
                panel: (
                  <PullRequestPane
                    sessionId={id}
                    pr={pr}
                    unavailable={noRepo ? noRepo : remote ? SESSION_TEXT.prRemote : null}
                    onOpen={() => setGitDialog('pr')}
                    onPush={() => setGitDialog('push')}
                    onRefreshed={(next) => setExtras((x) => (x ? { ...x, pullRequest: next } : x))}
                  />
                ),
              },
              {
                id: 'checks',
                label: SESSION_TEXT.tab.checks,
                panel: (
                  <ChecksPane
                    sessionId={id}
                    visible={visible && tab === 'checks'}
                    version={verifyVersion}
                  />
                ),
              },
              {
                id: 'servers',
                label: liveServers
                  ? SESSION_TEXT.tab.serversCount({ n: liveServers })
                  : SESSION_TEXT.tab.servers,
                panel: (
                  <DevServersPane
                    sessionId={id}
                    visible={visible && tab === 'servers'}
                    version={serverVersion}
                    onChanged={reloadExtras}
                    unavailable={remote ? SESSION_TEXT.serversRemote : null}
                  />
                ),
              },
              {
                id: 'sessions',
                label: SESSION_TEXT.tab.sessions,
                panel: (
                  <SessionsPane
                    session={session}
                    visible={visible && tab === 'sessions'}
                    version={sessionsVersion}
                    onAsk={setAsking}
                  />
                ),
              },
              ...m7.panes,
            ]}
          />
        </div>
      </div>
      <CommitDialog
        open={committing}
        session={session}
        pending={totals.pendingHunks}
        onClose={() => setCommitting(false)}
        onCommitted={(r) => {
          announce(SESSION_TEXT.committed({ branch: r.branch }));
          reloadSession();
          reloadChanges();
        }}
      />
      <BranchDialog
        open={gitDialog === 'branch'}
        session={session}
        onClose={() => setGitDialog(null)}
        onCreated={(r) => {
          setGitDialog(null);
          announce(SESSION_TEXT.switched({ branch: r.branch }));
          toast.show(SESSION_TEXT.nowOn({ branch: r.branch }), { tone: 'success' });
          reloadSession();
        }}
      />
      <PushDialog
        open={gitDialog === 'push'}
        session={session}
        onClose={() => setGitDialog(null)}
        onPushed={(r) => {
          announce(SESSION_TEXT.pushed({ branch: r.branch, remote: r.remote }));
          reloadExtras();
        }}
      />
      <PullRequestDialog
        open={gitDialog === 'pr'}
        session={session}
        onClose={() => setGitDialog(null)}
        onNewBranch={() => setGitDialog('branch')}
        onOpened={(next) => {
          setGitDialog(null);
          setExtras((x) => (x ? { ...x, pullRequest: next } : x));
          setTab('pr');
          announce(SESSION_TEXT.prOpened({ number: String(next.number) }));
          reloadSession();
        }}
      />
      <SideQuestionDialog target={asking} onClose={() => setAsking(null)} />
      {m7.dialogs}
    </section>
  );
}

/**
 * Tabs whose panels all stay mounted (hidden when not selected), so a pending comment, the diff
 * layout or a terminal survive switching panes. One tab stop; arrows, Home and End move.
 */
function PaneTabs({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: PaneTab;
  onChange: (id: PaneTab) => void;
  items: { id: PaneTab; label: string; panel: ReactNode }[];
}) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const current = Math.max(
    0,
    items.findIndex((t) => t.id === value),
  );
  return (
    <div className="nv-tabs code-pane-tabs">
      <div
        ref={list}
        role="tablist"
        aria-label={label}
        className="nv-tablist"
        onKeyDown={(e) => {
          const next = rovingIndex(e.key, current, items.length, 'horizontal');
          if (next === null) return;
          e.preventDefault();
          const item = items[next];
          if (!item) return;
          onChange(item.id);
          list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {items.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-selected={i === current}
            aria-controls={`${base}-panel-${t.id}`}
            tabIndex={i === current ? 0 : -1}
            className="nv-tab"
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {items.map((t, i) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${base}-panel-${t.id}`}
          aria-labelledby={`${base}-tab-${t.id}`}
          tabIndex={0}
          hidden={i !== current}
          className="nv-tabpanel code-pane-panel"
        >
          {t.panel}
        </div>
      ))}
    </div>
  );
}

function mergeById<T extends { id: string }>(list: readonly T[], updated: readonly T[]): T[] {
  const byId = new Map(updated.map((x) => [x.id, x]));
  const next = list.map((x) => byId.get(x.id) ?? x);
  for (const x of updated) if (!list.some((y) => y.id === x.id)) next.push(x);
  return next;
}

/** A fenced block that the text inside cannot close. */
export function fenced(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}
