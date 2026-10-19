// A session's moves (FR-213: the move is recorded in the session history): newest first, each with
// where it came from and went to, its state, the Git state that travelled (branch, commit, the
// state hash the target confirmed), whether the source was kept or cleaned, and for a refused or
// failed move why, in plain words. Follows `session.handedOff`.
import type { SessionHandoffView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { formatWhen } from '../settings/common.ts';
import { useLoad } from '../cloud/parts.tsx';
import { useCodeM7Api } from './api-m7.ts';
import { Badge } from './parts.tsx';
import { HANDOFF_STATUS, codeM7ErrorMessage, handoffReasonText, shortHash } from './m7-format.ts';

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
        <p className="muted ws-flush">
          Where this session has worked. A move carries its branch, commits and uncommitted changes;
          it is refused when the target has other changes.
        </p>
        <Button onClick={onMove}>
          <Icon name="forward" /> Hand off…
        </Button>
      </div>
      {list.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{codeM7ErrorMessage(list.error, 'Could not load the moves.')}</p>
          <Button onClick={list.reload}>Retry</Button>
        </div>
      ) : null}
      {list.loading ? <Spinner label="Loading the moves" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title="This session has not moved"
          description="Hand it off to continue on another machine, in the cloud or in a worktree."
          icon="forward"
        />
      ) : null}
      {items?.length ? (
        <ol className="cm7-list" aria-label="Moves">
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
    <li className="cm7-row" aria-label={`${v.fromLabel} to ${v.toLabel}`}>
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
        {v.git?.branch ? <span>Branch {v.git.branch}</span> : null}
        {v.git ? <span>Commit {shortHash(v.git.head, 7)}</span> : null}
        {v.git ? (
          <span title="The hash the target confirmed">State {shortHash(v.git.stateHash)}</span>
        ) : null}
        {v.status === 'completed' ? (
          <span>{v.source === 'clean' ? 'Source cleaned' : 'Source kept'}</span>
        ) : null}
      </span>
      {why ? <span className="cm7-why">{why}</span> : null}
    </li>
  );
}
