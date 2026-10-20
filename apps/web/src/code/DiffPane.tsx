// The Diff pane of a Code session (FR-064, FR-065; docs/10 §5): the changed files with
// `+additions −deletions` and their state, a unified or split view, added and removed lines
// marked by sign and text as well as color, and word-level marks inside a modified line. A line
// number opens a comment box; comments wait in a batch and Ctrl/Cmd+Enter sends them to the
// agent, which revises the diff. Hunks, files and the whole diff are accepted or rejected; a
// file that is partly accepted says so. Review findings show at their line (FR-069).
import { Fragment, useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import type {
  CodeChangeView,
  DiffCommentView,
  DiffHunkView,
  ReviewFindingView,
} from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import {
  Button,
  Dialog,
  EmptyState,
  Icon,
  Spinner,
  VisuallyHidden,
  spokenKey,
  useToast,
} from '@nova/ui';
import { errorMessage } from '../api.ts';
import { formatBinding } from '../keys.ts';
import { useAnnounce, useServices } from '../services.tsx';
import {
  CHANGE_KIND_TEXT,
  CHANGE_STATE_TEXT,
  HUNK_STATE_TEXT,
  anchorKey,
  diffTotals,
  lineAnchor,
  pairLines,
  splitRows,
  wordDiff,
  type DiffLine,
  type Segment,
} from './diff.ts';
import { SEVERITY } from './ReviewPane.tsx';

export const DIFF_TEXT = defineMessages('code.diff', {
  hunkAccepted: 'Hunk {n} of {path} accepted.',
  hunkRejected: 'Hunk {n} of {path} rejected.',
  hunkAcceptFailed: 'Could not accept the hunk: {reason}',
  hunkRejectFailed: 'Could not reject the hunk: {reason}',
  fileAccepted: '{path}: accepted.',
  fileRejected: '{path}: rejected.',
  fileAcceptFailed: 'Could not accept {path}: {reason}',
  fileRejectFailed: 'Could not reject {path}: {reason}',
  allAccepted: 'All pending changes accepted.',
  allRejected: 'All pending changes rejected.',
  allAcceptFailed: 'Could not accept the changes: {reason}',
  allRejectFailed: 'Could not reject the changes: {reason}',
  commentAdded:
    '{n, plural, one {Comment added. # comment ready to send.} other {Comment added. # comments ready to send.}}',
  sent: '{n, plural, one {Sent # comment to the agent.} other {Sent # comments to the agent.}}',
  notSent: 'Comments not sent: {reason}',
  resolvedAnnounce: 'Comment resolved.',
  resolveFailed: 'Could not resolve the comment: {reason}',
  retry: 'Retry',
  loading: 'Loading changes',
  loadingDots: 'Loading changes…',
  emptyTitle: 'No changes yet',
  emptyBody: 'Edits the agent makes in this session show here, file by file.',
  resolved: 'Resolved',
  resolve: 'Resolve',
  pending: 'Pending',
  removePendingOnLine: 'Remove the pending comment on line {line} of {path}',
  removePendingOnRemoved: 'Remove the pending comment on removed line {line} of {path}',
  remove: 'Remove',
  commentOnLine: 'Comment on line {line} of {path}',
  commentOnRemoved: 'Comment on removed line {line} of {path}',
  title: 'Diff',
  layout: 'Diff layout',
  unified: 'Unified',
  split: 'Split',
  files: '{n, plural, one {# file} other {# files}}',
  acceptAll: 'Accept all',
  rejectAll: 'Reject all',
  pendingComments: 'Pending comments',
  ready:
    '{n, plural, one {# comment ready. {keys} sends them to the agent.} other {# comments ready. {keys} sends them to the agent.}}',
  send: '{n, plural, one {Send # comment} other {Send # comments}}',
  discard: 'Discard',
  changedFiles: 'Changed files',
  renamedFrom: '{kind} from {path}',
  acceptFile: 'Accept {path}',
  rejectFile: 'Reject {path}',
  acceptFileButton: 'Accept file',
  rejectFileButton: 'Reject file',
  partial: 'Partly accepted: some hunks of this file are written, others are not.',
  binary: 'Binary file: there is no text diff to show.',
  rejectTitle: 'Reject all pending changes?',
  rejectBody:
    'Every pending hunk is reverted: those files go back to how they were before the agent changed them. Accepted hunks stay.',
  cancel: 'Cancel',
  hunk: 'hunk {n} of {path}',
  acceptHunk: 'Accept hunk {n} of {path}',
  rejectHunk: 'Reject hunk {n} of {path}',
  accept: 'Accept',
  reject: 'Reject',
  linesOf: 'Lines of hunk {n} of {path}',
  added: 'Added: ',
  removed: 'Removed: ',
  commentHint: 'Add it to the batch, or press {keys} to send every pending comment to the agent.',
  addComment: 'Add comment',
  reviewNote: 'Review {severity}',
  counts:
    '{add, plural, one {# addition} other {# additions}}, {del, plural, one {# deletion} other {# deletions}}',
});

export type DiffView = 'unified' | 'split';

/** A comment waiting in the batch until the user sends it. */
export interface DraftComment {
  key: string;
  changeId: string;
  path: string;
  side: 'old' | 'new';
  line: number;
  body: string;
}

export interface DiffPaneProps {
  sessionId: string;
  /** Null while loading. */
  changes: CodeChangeView[] | null;
  loadError?: string | null;
  comments: DiffCommentView[];
  findings: ReviewFindingView[];
  onChanged: (updated: CodeChangeView[]) => void;
  onCommented: (added: DiffCommentView[]) => void;
  onRetry?: () => void;
}

interface Anchor {
  change: CodeChangeView;
  side: 'old' | 'new';
  line: number;
}

export function DiffPane({
  sessionId,
  changes,
  loadError = null,
  comments,
  findings,
  onChanged,
  onCommented,
  onRetry,
}: DiffPaneProps) {
  const { api, registry } = useServices();
  const toast = useToast();
  const announce = useAnnounce();
  const base = useId();
  const mac = registry.platform.mac;
  const [view, setView] = useState<DiffView>('unified');
  const [drafts, setDrafts] = useState<DraftComment[]>([]);
  const [box, setBox] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);

  const list = useMemo(() => changes ?? [], [changes]);
  const totals = diffTotals(list);
  // Key caps with the modifier named in the active locale ("Ctrl+Enter", "⌘Enter").
  const sendKeys = formatBinding('mod+enter', mac)
    .map(spokenKey)
    .join(mac ? '' : '+');

  // ---- decisions (FR-064) -----------------------------------------------------------------------
  const focusLater = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0);

  const decideHunk = async (change: CodeChangeView, hunk: DiffHunkView, i: number, ok: boolean) => {
    const key = `${change.id}:${hunk.id}`;
    setBusy(key);
    try {
      const updated = await api.decideHunks(sessionId, change.id, {
        decisions: [{ hunkId: hunk.id, accept: ok }],
      });
      onChanged([updated]);
      const p = { n: i + 1, path: change.path };
      announce(ok ? DIFF_TEXT.hunkAccepted(p) : DIFF_TEXT.hunkRejected(p));
      // The buttons go away with the decision; keep focus on the hunk.
      focusLater(hunkDomId(base, change.id, hunk.id));
    } catch (err) {
      const p = { reason: errorMessage(err) };
      toast.show(ok ? DIFF_TEXT.hunkAcceptFailed(p) : DIFF_TEXT.hunkRejectFailed(p), {
        tone: 'error',
      });
    } finally {
      setBusy(null);
    }
  };

  const decideFile = async (change: CodeChangeView, ok: boolean) => {
    setBusy(change.id);
    try {
      const { items } = await api.decideAll(sessionId, ok, [change.id]);
      onChanged(items);
      announce(
        ok
          ? DIFF_TEXT.fileAccepted({ path: change.path })
          : DIFF_TEXT.fileRejected({ path: change.path }),
      );
      focusLater(fileDomId(base, change.id));
    } catch (err) {
      const p = { path: change.path, reason: errorMessage(err) };
      toast.show(ok ? DIFF_TEXT.fileAcceptFailed(p) : DIFF_TEXT.fileRejectFailed(p), {
        tone: 'error',
      });
    } finally {
      setBusy(null);
    }
  };

  const decideEverything = async (ok: boolean) => {
    setBusy('all');
    try {
      const { items } = await api.decideAll(sessionId, ok);
      onChanged(items);
      announce(ok ? DIFF_TEXT.allAccepted : DIFF_TEXT.allRejected);
    } catch (err) {
      const p = { reason: errorMessage(err) };
      toast.show(ok ? DIFF_TEXT.allAcceptFailed(p) : DIFF_TEXT.allRejectFailed(p), {
        tone: 'error',
      });
    } finally {
      setBusy(null);
    }
  };

  // ---- comments (FR-065) ------------------------------------------------------------------------
  const openBox = (a: Anchor) => {
    const key = anchorKey(a.change.id, a.side, a.line);
    setBox((b) => (b?.key === key ? b : { key, text: '' }));
  };

  /** The batch with the open box's text added, when there is any. */
  const withBox = (): DraftComment[] => {
    if (!box?.text.trim()) return drafts;
    const a = anchorOf(list, box.key);
    if (!a) return drafts;
    return [
      ...drafts,
      {
        key: `${box.key}:${drafts.length}`,
        changeId: a.change.id,
        path: a.change.path,
        side: a.side,
        line: a.line,
        body: box.text.trim(),
      },
    ];
  };

  const addToBatch = () => {
    const next = withBox();
    if (next === drafts) return;
    setDrafts(next);
    setBox(null);
    announce(DIFF_TEXT.commentAdded({ n: next.length }));
  };

  const sendBatch = async () => {
    const batch = withBox();
    if (!batch.length || sending) return;
    setSending(true);
    try {
      const { items } = await api.addComments(sessionId, {
        comments: batch.map((d) => ({
          changeId: d.changeId,
          line: d.line,
          side: d.side,
          body: d.body,
        })),
        submit: true,
      });
      onCommented(items);
      setDrafts([]);
      setBox(null);
      announce(DIFF_TEXT.sent({ n: batch.length }));
      toast.show(DIFF_TEXT.sent({ n: batch.length }), { tone: 'success' });
    } catch (err) {
      // The batch stays, so nothing typed is lost.
      if (batch !== drafts) {
        setDrafts(batch);
        setBox(null);
      }
      toast.show(DIFF_TEXT.notSent({ reason: errorMessage(err) }), { tone: 'error' });
    } finally {
      setSending(false);
    }
  };

  const isSendKey = (e: KeyboardEvent) =>
    e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;

  const onPaneKey = (e: KeyboardEvent<HTMLElement>) => {
    if (!isSendKey(e) || (!drafts.length && !box?.text.trim())) return;
    e.preventDefault();
    e.stopPropagation();
    void sendBatch();
  };

  const resolve = async (c: DiffCommentView) => {
    try {
      const updated = await api.resolveComment(sessionId, c.id);
      onCommented([updated]);
      announce(DIFF_TEXT.resolvedAnnounce);
    } catch (err) {
      toast.show(DIFF_TEXT.resolveFailed({ reason: errorMessage(err) }), { tone: 'error' });
    }
  };

  // ---- render -----------------------------------------------------------------------------------
  if (loadError)
    return (
      <div className="ws-error" role="alert">
        <p>{loadError}</p>
        {onRetry ? <Button onClick={onRetry}>{DIFF_TEXT.retry}</Button> : null}
      </div>
    );
  if (changes === null)
    return (
      <p className="muted pane-note">
        <Spinner label={DIFF_TEXT.loading} /> {DIFF_TEXT.loadingDots}
      </p>
    );
  if (!changes.length)
    return (
      <EmptyState
        title={DIFF_TEXT.emptyTitle}
        description={DIFF_TEXT.emptyBody}
        icon="compare"
        level={3}
      />
    );

  const commentsAt = groupBy(comments, (c) => anchorKey(c.changeId, c.side, c.line));
  const draftsAt = groupBy(drafts, (d) => anchorKey(d.changeId, d.side, d.line));

  const notes = (change: CodeChangeView, side: 'old' | 'new', line: number | null) => {
    if (line === null) return null;
    const key = anchorKey(change.id, side, line);
    const found =
      side === 'new' ? findings.filter((f) => f.path === change.path && f.line === line) : [];
    const here = commentsAt.get(key) ?? [];
    const mine = draftsAt.get(key) ?? [];
    const open = box?.key === key;
    if (!found.length && !here.length && !mine.length && !open) return null;
    return (
      <div className="code-notes">
        {found.map((f) => (
          <ReviewNote key={f.id} finding={f} />
        ))}
        {here.map((c) => (
          <div key={c.id} className="code-note" data-resolved={c.resolved || undefined}>
            <p dir="auto">{c.body}</p>
            {c.resolved ? (
              <span className="muted">{DIFF_TEXT.resolved}</span>
            ) : (
              <Button variant="ghost" onClick={() => void resolve(c)}>
                {DIFF_TEXT.resolve}
              </Button>
            )}
          </div>
        ))}
        {mine.map((d) => (
          <div key={d.key} className="code-note code-note-draft">
            <span className="code-draft-tag">{DIFF_TEXT.pending}</span> <p dir="auto">{d.body}</p>
            <Button
              variant="ghost"
              aria-label={(d.side === 'old'
                ? DIFF_TEXT.removePendingOnRemoved
                : DIFF_TEXT.removePendingOnLine)({ line: String(d.line), path: d.path })}
              onClick={() => setDrafts((list) => list.filter((x) => x.key !== d.key))}
            >
              {DIFF_TEXT.remove}
            </Button>
          </div>
        ))}
        {open ? (
          <CommentBox
            label={(side === 'old' ? DIFF_TEXT.commentOnRemoved : DIFF_TEXT.commentOnLine)({
              line: String(line),
              path: change.path,
            })}
            text={box.text}
            sendKeys={sendKeys}
            onText={(text) => setBox({ key, text })}
            onAdd={addToBatch}
            onCancel={() => setBox(null)}
            onSend={() => void sendBatch()}
            isSendKey={isSendKey}
          />
        ) : null}
      </div>
    );
  };

  const lineButton = (change: CodeChangeView, line: DiffLine, side: 'old' | 'new') => {
    const no = side === 'old' ? line.oldNo : line.newNo;
    if (no === null) return null;
    // A line takes comments on one side only: removed lines on the old, others on the new.
    if (lineAnchor(line)?.side !== side) return <span>{no}</span>;
    return (
      <button
        type="button"
        className="code-ln-btn"
        aria-label={(side === 'old' ? DIFF_TEXT.commentOnRemoved : DIFF_TEXT.commentOnLine)({
          line: String(no),
          path: change.path,
        })}
        onClick={() => openBox({ change, side, line: no })}
      >
        {no}
      </button>
    );
  };

  return (
    <section className="code-diff" aria-label={DIFF_TEXT.title} onKeyDown={onPaneKey}>
      <div className="code-diff-bar">
        <div className="code-seg" role="group" aria-label={DIFF_TEXT.layout}>
          {(['unified', 'split'] as const).map((v) => (
            <Button
              key={v}
              variant={view === v ? 'primary' : 'default'}
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {v === 'unified' ? DIFF_TEXT.unified : DIFF_TEXT.split}
            </Button>
          ))}
        </div>
        <span className="muted code-totals">
          {DIFF_TEXT.files({ n: totals.files })},{' '}
          <Counts add={totals.additions} del={totals.deletions} />
        </span>
        <span className="code-spacer" />
        <Button
          disabled={!totals.pendingHunks || busy !== null}
          onClick={() => void decideEverything(true)}
        >
          <Icon name="check" /> {DIFF_TEXT.acceptAll}
        </Button>
        <Button
          variant="danger"
          disabled={!totals.pendingHunks || busy !== null}
          onClick={() => setConfirmReject(true)}
        >
          <Icon name="undo" /> {DIFF_TEXT.rejectAll}
        </Button>
      </div>
      {drafts.length ? (
        <div className="code-batch" role="region" aria-label={DIFF_TEXT.pendingComments}>
          <p>{DIFF_TEXT.ready({ n: drafts.length, keys: sendKeys })}</p>
          <Button
            variant="primary"
            disabled={sending}
            aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}
            onClick={() => void sendBatch()}
          >
            {sending ? <Spinner /> : <Icon name="send" />} {DIFF_TEXT.send({ n: drafts.length })}
          </Button>
          <Button onClick={() => setDrafts([])} disabled={sending}>
            {DIFF_TEXT.discard}
          </Button>
        </div>
      ) : null}
      <nav className="code-files" aria-label={DIFF_TEXT.changedFiles}>
        <ul>
          {list.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="link code-file-link"
                dir="ltr"
                onClick={() => {
                  const el = document.getElementById(fileDomId(base, c.id));
                  el?.scrollIntoView?.({ block: 'start' });
                  el?.focus();
                }}
              >
                {c.path}
              </button>{' '}
              <Counts add={c.additions} del={c.deletions} />{' '}
              <span className="code-state" data-state={c.state}>
                {CHANGE_STATE_TEXT[c.state]}
              </span>
            </li>
          ))}
        </ul>
      </nav>
      {list.map((c) => {
        const pendingHunks = c.hunks.some((h) => h.state === 'pending');
        const pending = pendingHunks || (c.binary && c.state === 'pending');
        const fileNotes = findings.filter((f) => f.path === c.path && f.line === null);
        return (
          <section
            key={c.id}
            className="code-file"
            data-state={c.state}
            aria-labelledby={`${fileDomId(base, c.id)}-h`}
          >
            <header className="code-file-head">
              <h3 id={`${fileDomId(base, c.id)}-h`}>
                <span id={fileDomId(base, c.id)} tabIndex={-1} className="code-path">
                  {c.path}
                </span>
              </h3>
              <span className="muted">
                {c.kind === 'rename' && c.oldPath
                  ? DIFF_TEXT.renamedFrom({ kind: CHANGE_KIND_TEXT[c.kind], path: c.oldPath })
                  : CHANGE_KIND_TEXT[c.kind]}
              </span>
              <Counts add={c.additions} del={c.deletions} />
              <span className="code-state" data-state={c.state}>
                {CHANGE_STATE_TEXT[c.state]}
              </span>
              <span className="code-spacer" />
              <Button
                disabled={!pending || busy !== null}
                aria-label={DIFF_TEXT.acceptFile({ path: c.path })}
                onClick={() => void decideFile(c, true)}
              >
                {DIFF_TEXT.acceptFileButton}
              </Button>
              <Button
                disabled={!pending || busy !== null}
                aria-label={DIFF_TEXT.rejectFile({ path: c.path })}
                onClick={() => void decideFile(c, false)}
              >
                {DIFF_TEXT.rejectFileButton}
              </Button>
            </header>
            {c.state === 'partial' ? (
              <p className="code-partial" role="note">
                <Icon name="alert" /> {DIFF_TEXT.partial}
              </p>
            ) : null}
            {fileNotes.map((f) => (
              <ReviewNote key={f.id} finding={f} />
            ))}
            {c.binary ? (
              <p className="muted code-binary">{DIFF_TEXT.binary}</p>
            ) : (
              c.hunks.map((h, i) => (
                <Hunk
                  key={h.id}
                  id={hunkDomId(base, c.id, h.id)}
                  change={c}
                  hunk={h}
                  index={i}
                  view={view}
                  busy={busy !== null}
                  onDecide={(ok) => void decideHunk(c, h, i, ok)}
                  lineButton={(line, side) => lineButton(c, line, side)}
                  notes={(side, line) => notes(c, side, line)}
                />
              ))
            )}
          </section>
        );
      })}
      <Dialog
        open={confirmReject}
        title={DIFF_TEXT.rejectTitle}
        description={DIFF_TEXT.rejectBody}
        onClose={() => setConfirmReject(false)}
        footer={
          <>
            <Button onClick={() => setConfirmReject(false)}>{DIFF_TEXT.cancel}</Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmReject(false);
                void decideEverything(false);
              }}
            >
              {DIFF_TEXT.rejectAll}
            </Button>
          </>
        }
      />
    </section>
  );
}

function Hunk({
  id,
  change,
  hunk,
  index,
  view,
  busy,
  onDecide,
  lineButton,
  notes,
}: {
  id: string;
  change: CodeChangeView;
  hunk: DiffHunkView;
  index: number;
  view: DiffView;
  busy: boolean;
  onDecide: (accept: boolean) => void;
  lineButton: (line: DiffLine, side: 'old' | 'new') => ReactNode;
  notes: (side: 'old' | 'new', line: number | null) => ReactNode;
}) {
  const marks = useMemo(() => wordMarks(hunk.lines), [hunk.lines]);
  const at = { n: index + 1, path: change.path };
  const name = DIFF_TEXT.hunk(at);
  const lines = hunk.lines;
  return (
    <div
      id={id}
      role="group"
      className="code-hunk"
      data-state={hunk.state}
      tabIndex={-1}
      aria-label={name}
    >
      <div className="code-hunk-head">
        <code className="code-hunk-header">{hunk.header}</code>
        <span className="code-state" data-state={hunk.state}>
          {HUNK_STATE_TEXT[hunk.state]}
        </span>
        {hunk.state === 'pending' ? (
          <>
            <Button
              disabled={busy}
              aria-label={DIFF_TEXT.acceptHunk(at)}
              onClick={() => onDecide(true)}
            >
              {DIFF_TEXT.accept}
            </Button>
            <Button
              disabled={busy}
              aria-label={DIFF_TEXT.rejectHunk(at)}
              onClick={() => onDecide(false)}
            >
              {DIFF_TEXT.reject}
            </Button>
          </>
        ) : null}
      </div>
      <table className="code-lines" data-view={view} dir="ltr">
        <caption className="nv-vh">{DIFF_TEXT.linesOf(at)}</caption>
        <colgroup>
          {view === 'unified' ? (
            <>
              <col className="code-col-ln" />
              <col className="code-col-ln" />
              <col />
            </>
          ) : (
            <>
              <col className="code-col-ln" />
              <col />
              <col className="code-col-ln" />
              <col />
            </>
          )}
        </colgroup>
        <tbody>
          {view === 'unified'
            ? lines.map((l, i) => {
                const anchor = lineAnchor(l);
                const extra = anchor ? notes(anchor.side, anchor.line) : null;
                return (
                  <Fragment key={i}>
                    <tr data-kind={l.kind}>
                      <td className="code-ln">{lineButton(l, 'old')}</td>
                      <td className="code-ln">{lineButton(l, 'new')}</td>
                      <LineText line={l} segments={marks.get(i)} />
                    </tr>
                    {extra ? (
                      <tr className="code-notes-row">
                        <td colSpan={3}>{extra}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            : splitRows(lines).map((row, i) => {
                const left = row.old === null ? null : lines[row.old]!;
                const right = row.new === null ? null : lines[row.new]!;
                const leftNotes = left && left.kind === 'del' ? notes('old', left.oldNo) : null;
                const rightNotes = right ? notes('new', right.newNo) : null;
                return (
                  <Fragment key={i}>
                    <tr>
                      <td className="code-ln">{left ? lineButton(left, 'old') : null}</td>
                      {left ? (
                        <LineText
                          line={left}
                          segments={row.old === null ? undefined : marks.get(row.old)}
                          side="old"
                        />
                      ) : (
                        <td className="code-text" data-kind="empty" />
                      )}
                      <td className="code-ln">{right ? lineButton(right, 'new') : null}</td>
                      {right ? (
                        <LineText
                          line={right}
                          segments={row.new === null ? undefined : marks.get(row.new)}
                          side="new"
                        />
                      ) : (
                        <td className="code-text" data-kind="empty" />
                      )}
                    </tr>
                    {leftNotes || rightNotes ? (
                      <tr className="code-notes-row">
                        <td colSpan={2}>{leftNotes}</td>
                        <td colSpan={2}>{rightNotes}</td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
        </tbody>
      </table>
    </div>
  );
}

const SIGN: Record<DiffLine['kind'], string> = { add: '+', del: '−', context: ' ' };

function LineText({
  line,
  segments,
  side,
}: {
  line: DiffLine;
  segments: Segment[] | undefined;
  side?: 'old' | 'new';
}) {
  // In the split view a context line shows on both sides; its sign stays blank.
  const kind = side && line.kind === 'context' ? 'context' : line.kind;
  const said = kind === 'add' ? DIFF_TEXT.added : kind === 'del' ? DIFF_TEXT.removed : null;
  return (
    <td className="code-text" data-kind={kind}>
      <span className="code-sign" aria-hidden="true">
        {SIGN[kind]}
      </span>
      {said ? <VisuallyHidden>{said}</VisuallyHidden> : null}
      <code>
        {segments
          ? segments.map((s, i) =>
              s.changed ? (
                <mark key={i} className="code-word">
                  {s.text}
                </mark>
              ) : (
                <Fragment key={i}>{s.text}</Fragment>
              ),
            )
          : line.text}
      </code>
    </td>
  );
}

function CommentBox({
  label,
  text,
  sendKeys,
  onText,
  onAdd,
  onCancel,
  onSend,
  isSendKey,
}: {
  label: string;
  text: string;
  sendKeys: string;
  onText: (text: string) => void;
  onAdd: () => void;
  onCancel: () => void;
  onSend: () => void;
  isSendKey: (e: KeyboardEvent) => boolean;
}) {
  const id = useId();
  return (
    <div className="code-comment-box">
      <label htmlFor={`${id}-text`} className="nv-field-label">
        {label}
      </label>
      <textarea
        id={`${id}-text`}
        className="nv-input ws-textarea"
        rows={3}
        maxLength={8000}
        value={text}
        // The box opens because the user asked for it; typing starts right away.
        autoFocus
        aria-describedby={`${id}-hint`}
        onChange={(e) => onText(e.target.value)}
        onKeyDown={(e) => {
          if (isSendKey(e)) {
            e.preventDefault();
            e.stopPropagation();
            onSend();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <span id={`${id}-hint`} className="nv-field-hint">
        {DIFF_TEXT.commentHint({ keys: sendKeys })}
      </span>
      <div className="code-comment-actions">
        <Button onClick={onAdd} disabled={!text.trim()}>
          {DIFF_TEXT.addComment}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {DIFF_TEXT.cancel}
        </Button>
      </div>
    </div>
  );
}

/** A review finding shown in the diff (FR-069): severity as icon and word, title, reasoning. */
function ReviewNote({ finding: f }: { finding: ReviewFindingView }) {
  return (
    <div className="code-note code-note-review" data-severity={f.severity}>
      <span className="code-sev" data-severity={f.severity}>
        <Icon name={SEVERITY[f.severity].icon} />{' '}
        {DIFF_TEXT.reviewNote({ severity: SEVERITY[f.severity].text })}
      </span>{' '}
      <strong dir="auto">{f.title}</strong>
      <p dir="auto">{f.reasoning}</p>
    </div>
  );
}

function Counts({ add, del }: { add: number; del: number }) {
  return (
    <span className="code-counts">
      <span className="code-add" aria-hidden="true">
        +{add}
      </span>{' '}
      <span className="code-del" aria-hidden="true">
        −{del}
      </span>
      <VisuallyHidden>{DIFF_TEXT.counts({ add, del })}</VisuallyHidden>
    </span>
  );
}

/** Word-level marks for each modified line of a hunk, by line index. */
function wordMarks(lines: readonly DiffLine[]): Map<number, Segment[]> {
  const out = new Map<number, Segment[]>();
  for (const [i, j] of pairLines(lines)) {
    const line = lines[i]!;
    if (line.kind !== 'del') continue;
    const diff = wordDiff(line.text, lines[j]!.text);
    if (!diff) continue;
    out.set(i, diff.old);
    out.set(j, diff.new);
  }
  return out;
}

function anchorOf(list: readonly CodeChangeView[], key: string): Anchor | null {
  const m = /^(.*):(old|new):(\d+)$/.exec(key);
  if (!m) return null;
  const change = list.find((c) => c.id === m[1]);
  return change ? { change, side: m[2] as 'old' | 'new', line: Number(m[3]) } : null;
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    out.set(k, [...(out.get(k) ?? []), it]);
  }
  return out;
}

const domSafe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');

function fileDomId(base: string, changeId: string): string {
  return `${domSafe(base)}-file-${domSafe(changeId)}`;
}

function hunkDomId(base: string, changeId: string, hunkId: string): string {
  return `${domSafe(base)}-hunk-${domSafe(changeId)}-${domSafe(hunkId)}`;
}
