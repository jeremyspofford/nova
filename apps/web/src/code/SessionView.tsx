// One Code session at /code/:id (FR-061..FR-066, FR-069, FR-074; docs/04 §2.4): a header with
// the folder, branch, uncommitted state, status, pull request, symbol search, Review and Commit;
// the session's conversation (the ordinary chat view of its `code` thread, with the permission
// mode selector in its composer); and panes for the Diff, the Review, the Terminal and a File.
// The diff follows `code.*` events and reloads after every turn of the session's thread.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  CodeChangeView,
  CodeReviewView,
  CodeSessionView,
  CodeSymbolView,
  DiffCommentView,
  EnvironmentView,
  PermissionMode,
  ReviewFindingView,
} from '@nova/shared';
import { Button, Icon, Spinner, StatusChip, rovingIndex, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { ChatView } from '../chat/ChatView.tsx';
import { navigate } from '../router.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { useInterval } from '../settings/common.ts';
import { CommitDialog } from './CommitDialog.tsx';
import { diffTotals, mergeChanges } from './diff.ts';
import { DiffPane } from './DiffPane.tsx';
import { eventSessionId, useCodeEvents, useCoalesced, useThreadBusEvents } from './events.ts';
import { FilePane, type FileTarget } from './FilePane.tsx';
import { branchText, environmentLabel, sessionPath, sessionTitle } from './labels.ts';
import { ModeSelect, useModeContext } from './ModeSelect.tsx';
import { MODE_LABEL } from './modes.ts';
import { ReviewPane } from './ReviewPane.tsx';
import { SymbolSearch } from './SymbolSearch.tsx';
import { TerminalPane } from './TerminalPane.tsx';

type PaneTab = 'diff' | 'review' | 'terminal' | 'file';

/** How often a running review is checked, besides its completion event. */
export const REVIEW_POLL_MS = 1500;

export function SessionView({ id, visible }: { id: string; visible: boolean }) {
  const { api, registry } = useServices();
  const toast = useToast();
  const announce = useAnnounce();
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
              ? 'This Code session does not exist.'
              : errorMessage(err, 'Could not load the session.'),
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
        (err: unknown) => setChangesError(errorMessage(err, 'Could not load the changes.')),
      ),
    [api, id],
  );
  const loadReview = useCallback(
    (reviewId: string) =>
      api
        .getReview(id, reviewId)
        .then(setReview, (err: unknown) =>
          setReviewError(errorMessage(err, 'Could not load the review.')),
        ),
    [api, id],
  );
  const reloadSession = useCoalesced(loadSession);
  const reloadChanges = useCoalesced(loadChanges);

  useEffect(() => {
    if (!visible) return;
    reloadSession();
    reloadChanges();
    let alive = true;
    api.listEnvironments().then(
      ({ items }) => alive && setEnvironments(items),
      // Without the list the header leaves the environment out; modes fall back to local rules.
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, reloadChanges, reloadSession, visible]);

  const threadId = session?.threadId ?? null;
  useCodeEvents(visible, (env) => {
    const about = eventSessionId(env);
    if (about && about !== id && about !== threadId) return;
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
    } else if (env.name === 'tool.call.completed') reloadChanges();
  });
  useInterval(
    () => {
      if (review) void loadReview(review.id);
    },
    REVIEW_POLL_MS,
    visible && review?.status === 'running',
  );

  // ---- actions -----------------------------------------------------------------------------------
  const environment = environments.find((e) => e.id === session?.environmentId) ?? null;
  const ctx = useModeContext(environment);

  const changeMode = (mode: PermissionMode) => {
    if (!session || mode === session.permissionMode) return;
    const before = session;
    setSession({ ...session, permissionMode: mode });
    api.updateCodeSession(id, { permissionMode: mode }).then(
      (s) => {
        setSession(s);
        announce(`Permission mode: ${MODE_LABEL[s.permissionMode]}.`);
      },
      (err: unknown) => {
        setSession(before);
        toast.show(`Could not change the permission mode: ${errorMessage(err)}`, {
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
      if (r.status === 'done') announce('Review finished.');
    } catch (err) {
      setReviewError(errorMessage(err, 'Could not start the review.'));
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
    const body = `Apply the fix the code review suggested for “${f.title}”:\n\n${fenced(f.fix)}`;
    const change = (changes ?? []).find((c) => c.path === f.path);
    try {
      if (change && f.line !== null) {
        const { items } = await api.addComments(id, {
          comments: [{ changeId: change.id, line: f.line, side: 'new', body }],
          submit: true,
        });
        setComments((list) => mergeById(list, items));
      } else {
        const where = f.line !== null ? `${f.path}, line ${f.line}` : f.path;
        await api.sendMessage(session.threadId, { text: `${where}: ${body}` });
      }
      announce('Fix sent to the agent.');
      return true;
    } catch (err) {
      toast.show(`Could not send the fix: ${errorMessage(err)}`, { tone: 'error' });
      return false;
    }
  };

  const openSymbol = (s: CodeSymbolView) => {
    setFileTarget((t) => ({ path: s.path, line: s.line, n: (t?.n ?? 0) + 1 }));
    setTab('file');
    announce(`Opened ${s.path} at line ${s.line}.`);
  };

  // ---- render ------------------------------------------------------------------------------------
  if (!session)
    return loadError ? (
      <div className="ws-page">
        <div className="ws-error" role="alert">
          <p>{loadError}</p>
          <Button onClick={reloadSession}>Retry</Button>
          <Button onClick={() => navigate(sessionPath(null))}>All sessions</Button>
        </div>
      </div>
    ) : (
      <p className="muted pane-note">
        <Spinner label="Loading the session" /> Loading…
      </p>
    );

  const title = sessionTitle(session);
  const totals = diffTotals(changes ?? []);
  const prUrl = safeUrl(session.pullRequestUrl);

  return (
    <section className="code-session" aria-label={`Code session: ${title}`}>
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
          <Icon name="back" /> Sessions
        </a>
        <h1 className="code-title">{title}</h1>
        <StatusChip status={session.derived.status} reason={session.derived.reason ?? undefined} />
        <span className="code-header-meta muted">
          <span className="code-path" title={session.folder.path}>
            <Icon name="folder" /> {session.folder.path}
          </span>
          <span data-dirty={session.repo?.dirty || undefined}>
            <Icon name="branch" /> {branchText(session.repo)}
          </span>
          {environment ? <span>{environmentLabel(environment)}</span> : null}
          {prUrl ? (
            <a href={prUrl} target="_blank" rel="noreferrer noopener">
              <Icon name="external" /> Pull request
              {session.ciStatus ? ` (checks: ${session.ciStatus})` : ''}
            </a>
          ) : null}
        </span>
        <span className="code-header-actions">
          <SymbolSearch sessionId={id} onPick={openSymbol} />
          <Button onClick={() => void runReview()} disabled={reviewStarting}>
            <Icon name="eye" /> Review
          </Button>
          <Button
            variant="primary"
            disabled={!session.repo}
            title={session.repo ? undefined : 'This folder is not a Git repository.'}
            onClick={() => setCommitting(true)}
          >
            <Icon name="save" /> Commit…
          </Button>
        </span>
      </header>
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
            label="Session panes"
            value={tab}
            onChange={setTab}
            items={[
              {
                id: 'diff',
                label: totals.files ? `Diff (${totals.files})` : 'Diff',
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
                label: 'Review',
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
                label: 'Terminal',
                panel: <TerminalPane session={session} visible={visible && tab === 'terminal'} />,
              },
              {
                id: 'file',
                label: 'File',
                panel: (
                  <FilePane
                    root={session.repo?.root ?? session.folder.path}
                    target={fileTarget}
                    threadId={session.threadId}
                    mac={registry.platform.mac}
                  />
                ),
              },
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
          announce(`Committed to ${r.branch}.`);
          reloadSession();
          reloadChanges();
        }}
      />
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

/** Only http(s) links from the Hub become links. */
function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}
