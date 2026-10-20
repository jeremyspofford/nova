// A session's moves (FR-213: the move is recorded in the session history): newest first, each with
// where it came from and went to, its state, the Git state that travelled (branch, commit, the
// state hash the target confirmed), whether the source was kept or cleaned, and for a refused or
// failed move why, in plain words. Follows `session.handedOff`.
import type { SessionHandoffView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, EmptyState, Icon, Spinner } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { formatWhen } from '../settings/common.ts';
import { useLoad } from '../cloud/parts.tsx';
import { useCodeM7Api } from './api-m7.ts';
import { Badge } from './parts.tsx';
import { HANDOFF_STATUS, codeM7ErrorMessage, handoffReasonText, shortHash } from './m7-format.ts';

export const MOVES_TEXT = defineMessages('code.moves', {
  intro:
    'Where this session has worked. A move carries its branch, commits and uncommitted changes; it is refused when the target has other changes.',
  handOff: 'Hand off…',
  loadFailed: 'Could not load the moves.',
  retry: 'Retry',
  loading: 'Loading the moves',
  emptyTitle: 'This session has not moved',
  emptyBody: 'Hand it off to continue on another machine, in the cloud or in a worktree.',
  list: 'Moves',
  move: '{from} to {to}',
  branch: 'Branch {branch}',
  commit: 'Commit {commit}',
  stateHint: 'The hash the target confirmed',
  state: 'State {hash}',
  cleaned: 'Source cleaned',
  kept: 'Source kept',
});

export function HandoffHistory({
  sessionId,
  threadId,
  onMove,
}: {
  sessionId: string;
  threadId: string;
  onMove: () => void;
}) {
  const m7 = useCodeM7Api();
  const list = useLoad(
    () => m7.listCodeHandoffs(sessionId).then((r) => r.items),
    `handoffs:${sessionId}`,
  );
  useHubStream(
    ['session.handedOff'],
    (env) => {
      if (env.payload.sessionId === sessionId || env.payload.threadId === threadId) list.reload();
    },
    list.reload,
  );
  const items = list.data;
  return (
    <div className="cm7-pane">
      <div className="cm7-pane-head">
        <p className="muted ws-flush">{MOVES_TEXT.intro}</p>
        <Button onClick={onMove}>
          <Icon name="forward" /> {MOVES_TEXT.handOff}
        </Button>
      </div>
      {list.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{codeM7ErrorMessage(list.error, MOVES_TEXT.loadFailed)}</p>
          <Button onClick={list.reload}>{MOVES_TEXT.retry}</Button>
        </div>
      ) : null}
      {list.loading ? <Spinner label={MOVES_TEXT.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title={MOVES_TEXT.emptyTitle}
          description={MOVES_TEXT.emptyBody}
          icon="forward"
        />
      ) : null}
      {items?.length ? (
        <ol className="cm7-list" aria-label={MOVES_TEXT.list}>
          {items.map((v) => (
            <MoveRow key={v.id} v={v} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function MoveRow({ v }: { v: SessionHandoffView }) {
  const s = HANDOFF_STATUS[v.status];
  const why = handoffReasonText(v);
  return (
    <li className="cm7-row" aria-label={MOVES_TEXT.move({ from: v.fromLabel, to: v.toLabel })}>
      <span className="cm7-row-title">
        <span className="cm7-move">
          <span>{v.fromLabel}</span> <Icon name="forward" /> <span>{v.toLabel}</span>
        </span>
        <Badge tone={s.tone} icon={s.icon}>
          {s.text}
        </Badge>
      </span>
      <span className="muted ws-row-meta">
        <span>{formatWhen(v.createdAt)}</span>
        {v.git?.branch ? <span>{MOVES_TEXT.branch({ branch: v.git.branch })}</span> : null}
        {v.git ? <span>{MOVES_TEXT.commit({ commit: shortHash(v.git.head, 7) })}</span> : null}
        {v.git ? (
          <span title={MOVES_TEXT.stateHint}>
            {MOVES_TEXT.state({ hash: shortHash(v.git.stateHash) })}
          </span>
        ) : null}
        {v.status === 'completed' ? (
          <span>{v.source === 'clean' ? MOVES_TEXT.cleaned : MOVES_TEXT.kept}</span>
        ) : null}
      </span>
      {why ? <span className="cm7-why">{why}</span> : null}
    </li>
  );
}
