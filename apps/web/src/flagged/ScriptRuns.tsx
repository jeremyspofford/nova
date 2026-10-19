// Script runs of a thread (FR-202; flagged, `scripts.enabled`): every `script.run` call the model
// made, newest first, with its state, why it stopped, its time and how many tools it called; open
// one to see each nested call with its status and the policy gate's decision on it (each nested
// call is a tool call of its own, gated and audited). Only shown while the feature is on; when it
// is off the view says where to turn it on. The script's code is kept only as a hash.
import { useId, useState } from 'react';
import type { ScriptRunView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { formatWhen, plural } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import { Badge } from '../code/parts.tsx';
import { InAppLink, useLoad } from '../cloud/parts.tsx';
import { formatDuration } from '../code/m6-format.ts';
import { useFlaggedApi, type ScriptRunSummary } from './api.ts';
import {
  CALL_STATUS,
  EXPERIMENTAL_LABEL,
  EXPERIMENTAL_PATH,
  FLAGGED_EVENTS,
  SCRIPT_STATUS,
  decisionText,
  flaggedErrorMessage,
  scriptErrorText,
} from './format.ts';
import './flagged.css';

/** Where to turn a flagged feature on, for a view shown while it is off. */
export function FlagOff({ what }: { what: string }) {
  return (
    <div className="nv-empty">
      <span className="nv-empty-icon">
        <Icon name="slash" size="32px" />
      </span>
      <h3 className="nv-empty-title">{what} are off</h3>
      <div className="nv-empty-description">
        Turn them on in <InAppLink to={EXPERIMENTAL_PATH}>{EXPERIMENTAL_LABEL}</InAppLink>.
      </div>
    </div>
  );
}

export function ScriptRuns({ threadId }: { threadId: string }) {
  const settings = useSettings();
  if (!settings.get('scripts.enabled').value) return <FlagOff what="Scripted tool calls" />;
  return <ScriptRunList threadId={threadId} />;
}

/** The account's script runs across chats and sessions, newest first, with Load more. */
export function AllScriptRuns() {
  const settings = useSettings();
  if (!settings.get('scripts.enabled').value) return <FlagOff what="Scripted tool calls" />;
  return <ScriptRunList threadId={null} />;
}

/** Runs a page at a time (`nextCursor`); events refresh the first page. */
function ScriptRunList({ threadId }: { threadId: string | null }) {
  const api = useFlaggedApi();
  const runs = useLoad(
    () => api.listScriptRuns(threadId ? { threadId } : {}),
    `scripts:${threadId ?? '*'}`,
  );
  const [more, setMore] = useState<{ items: ScriptRunSummary[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const reload = () => {
    setMore(null);
    runs.reload();
  };
  useHubStream(
    FLAGGED_EVENTS.scripts,
    (env) => {
      const about = env.correlation?.threadId ?? env.payload.threadId;
      if (
        env.name === 'settings.changed' ||
        ((threadId === null || about === threadId) && env.payload.tool === 'script.run')
      )
        reload();
    },
    reload,
  );
  const page = runs.data;
  const items = page ? [...page.items, ...(more?.items ?? [])] : null;
  const next = more ? more.next : (page?.nextCursor ?? null);
  const loadMore = async () => {
    if (!next) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const r = await api.listScriptRuns({ ...(threadId ? { threadId } : {}), cursor: next });
      setMore((m) => ({ items: [...(m?.items ?? []), ...r.items], next: r.nextCursor }));
    } catch (err) {
      setMoreError(flaggedErrorMessage(err, 'scripts', 'Could not load more script runs.'));
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <div className="fl-pane">
      <p className="muted ws-flush">
        {threadId
          ? 'Short scripts the model wrote to call tools. Each call inside a script passed the policy gate on its own, like a direct call.'
          : 'Every script the model ran, in all chats and sessions, newest first. Each call inside a script passed the policy gate on its own.'}
      </p>
      {runs.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{flaggedErrorMessage(runs.error, 'scripts', 'Could not load the script runs.')}</p>
          <Button onClick={runs.reload}>Retry</Button>
        </div>
      ) : null}
      {runs.loading ? <Spinner label="Loading the script runs" /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title="No script runs yet"
          description={
            threadId
              ? 'When the model uses script.run here, each run and its tool calls show up.'
              : 'When the model uses script.run anywhere, each run and its tool calls show up here.'
          }
          icon="tool"
        />
      ) : null}
      {items?.length ? (
        <ul className="fl-list" aria-label="Script runs">
          {items.map((r) => (
            <ScriptRunRow
              key={r.id}
              r={r}
              open={open === r.id}
              onToggle={() => setOpen(open === r.id ? null : r.id)}
            />
          ))}
        </ul>
      ) : null}
      {moreError ? (
        <p className="nv-field-error" role="alert">
          {moreError}
        </p>
      ) : null}
      {next ? (
        <div>
          <Button disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? <Spinner /> : null} Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function ScriptRunRow({
  r,
  open,
  onToggle,
}: {
  r: ScriptRunSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const s = SCRIPT_STATUS[r.status];
  const why = scriptErrorText(r.errorCode);
  return (
    <li className="fl-row" aria-label={`Script run, ${formatWhen(r.createdAt)}`}>
      <span className="fl-row-title">
        <button type="button" className="cl-link" aria-expanded={open} onClick={onToggle}>
          Script run {formatWhen(r.createdAt)}
        </button>
        <Badge tone={s.tone} icon={s.icon}>
          {s.text}
        </Badge>
      </span>
      <span className="muted ws-row-meta">
        <span>{plural(r.calls, 'tool call')}</span>
        <span>{formatDuration(r.cpuMs)} of script time</span>
        <span title={r.codeSha256}>Code {r.codeSha256.slice(0, 12)}</span>
      </span>
      {why ? <span className="fl-why">{why}</span> : null}
      {open ? <NestedCalls id={r.id} /> : null}
    </li>
  );
}

function NestedCalls({ id }: { id: string }) {
  const api = useFlaggedApi();
  const headingId = useId();
  const run = useLoad<ScriptRunView>(() => api.getScriptRun(id), `script:${id}`);
  const r = run.data;
  if (!r)
    return run.error ? (
      <div className="ws-error" role="alert">
        <p>{flaggedErrorMessage(run.error, 'scripts', 'Could not load the run.')}</p>
        <Button onClick={run.reload}>Retry</Button>
      </div>
    ) : (
      <Spinner label="Loading the calls" />
    );
  return (
    <section className="fl-nested" aria-labelledby={headingId}>
      <h4 id={headingId} className="fl-nested-title">
        Tool calls in this script
      </h4>
      {r.nested.length === 0 ? (
        <p className="muted cl-small">It called no tools.</p>
      ) : (
        <ol className="fl-calls" aria-label="Nested tool calls">
          {r.nested.map((c) => {
            const st = CALL_STATUS[c.status];
            return (
              <li key={c.callId} className="fl-call">
                <code>{c.tool}</code>
                <Badge tone={st.tone} icon={st.icon}>
                  {st.text}
                </Badge>
                <span className="fl-decision">
                  <Icon name="shield" /> {decisionText(c.decision)}
                </span>
                <span className="muted cl-small">
                  {c.durationMs !== null ? formatDuration(c.durationMs) : 'Not finished'}
                  {c.approvalId ? ', an approval was asked' : ''}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
