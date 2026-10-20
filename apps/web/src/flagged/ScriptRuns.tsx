// Script runs of a thread (FR-202; flagged, `scripts.enabled`): every `script.run` call the model
// made, newest first, with its state, why it stopped, its time and how many tools it called; open
// one to see each nested call with its status and the policy gate's decision on it (each nested
// call is a tool call of its own, gated and audited). Only shown while the feature is on; when it
// is off the view says where to turn it on. The script's code is kept only as a hash.
import { useId, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { ScriptRunView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner } from '@nova/ui';
import { useHubStream } from '../hub-events.ts';
import { rich } from '../i18n/rich.tsx';
import { formatWhen } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import { Badge } from '../code/parts.tsx';
import { InAppLink, useLoad } from '../cloud/parts.tsx';
import { formatDuration } from '../code/m6-format.ts';
import { useFlaggedApi, type ScriptRunSummary } from './api.ts';
import {
  CALL_STATUS,
  EXPERIMENTAL_PATH,
  FLAGGED_EVENTS,
  FLAGGED_TEXT,
  SCRIPT_STATUS,
  decisionText,
  flaggedErrorMessage,
  scriptErrorText,
} from './format.ts';
import './flagged.css';

/** What a flagged feature's view says while the feature is off. */
export const FLAG_OFF_TEXT = defineMessages('flagged.off', {
  scripts: 'Scripted tool calls are off',
  agents: 'External coding agents are off',
  /** {link} is a link to the Settings page, named "Settings → Experimental". */
  turnOn: 'Turn them on in {link}.',
});

/** Where to turn a flagged feature on, for a view shown while it is off. */
export function FlagOff({ feature }: { feature: 'scripts' | 'agents' }) {
  return (
    <div className="nv-empty">
      <span className="nv-empty-icon">
        <Icon name="slash" size="32px" />
      </span>
      <h3 className="nv-empty-title">{FLAG_OFF_TEXT[feature]}</h3>
      <div className="nv-empty-description">
        {rich(FLAG_OFF_TEXT.turnOn, {
          link: <InAppLink to={EXPERIMENTAL_PATH}>{FLAGGED_TEXT.where}</InAppLink>,
        })}
      </div>
    </div>
  );
}

/** The words of the script runs. */
export const SCRIPTS_TEXT = defineMessages('flagged.scripts', {
  introThread:
    'Short scripts the model wrote to call tools. Each call inside a script passed the policy ' +
    'gate on its own, like a direct call.',
  introAll:
    'Every script the model ran, in all chats and sessions, newest first. Each call inside a ' +
    'script passed the policy gate on its own.',
  loadFailed: 'Could not load the script runs.',
  loadMoreFailed: 'Could not load more script runs.',
  loading: 'Loading the script runs',
  empty: 'No script runs yet',
  emptyThread: 'When the model uses script.run here, each run and its tool calls show up.',
  emptyAll: 'When the model uses script.run anywhere, each run and its tool calls show up here.',
  list: 'Script runs',
  loadMore: 'Load more',
  /** A run's name for screen readers: "Script run, 5 minutes ago". */
  runLabel: 'Script run, {when}',
  /** The button that opens a run: "Script run 5 minutes ago". */
  run: 'Script run {when}',
  calls: '{n, plural, one {# tool call} other {# tool calls}}',
  /** "140 ms of script time": the CPU time the script used. */
  cpu: '{duration} of script time',
  /** The first characters of the script's hash: "Code 3f2a9c…". */
  code: 'Code {hash}',
  runLoadFailed: 'Could not load the run.',
  callsLoading: 'Loading the calls',
  nestedHeading: 'Tool calls in this script',
  noCalls: 'It called no tools.',
  nestedList: 'Nested tool calls',
  notFinished: 'Not finished',
  /** A nested call that has not finished and for which an approval was asked. */
  notFinishedAsked: 'Not finished, an approval was asked',
  /** "12 ms, an approval was asked": how long the call took. */
  tookAsked: '{duration}, an approval was asked',
});

export function ScriptRuns({ threadId }: { threadId: string }) {
  const settings = useSettings();
  if (!settings.get('scripts.enabled').value) return <FlagOff feature="scripts" />;
  return <ScriptRunList threadId={threadId} />;
}

/** The account's script runs across chats and sessions, newest first, with Load more. */
export function AllScriptRuns() {
  const settings = useSettings();
  if (!settings.get('scripts.enabled').value) return <FlagOff feature="scripts" />;
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
      setMoreError(flaggedErrorMessage(err, 'scripts', SCRIPTS_TEXT.loadMoreFailed));
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <div className="fl-pane">
      <p className="muted ws-flush">
        {threadId ? SCRIPTS_TEXT.introThread : SCRIPTS_TEXT.introAll}
      </p>
      {runs.error && !items ? (
        <div className="ws-error" role="alert">
          <p>{flaggedErrorMessage(runs.error, 'scripts', SCRIPTS_TEXT.loadFailed)}</p>
          <Button onClick={runs.reload}>{FLAGGED_TEXT.retry}</Button>
        </div>
      ) : null}
      {runs.loading ? <Spinner label={SCRIPTS_TEXT.loading} /> : null}
      {items?.length === 0 ? (
        <EmptyState
          level={3}
          title={SCRIPTS_TEXT.empty}
          description={threadId ? SCRIPTS_TEXT.emptyThread : SCRIPTS_TEXT.emptyAll}
          icon="tool"
        />
      ) : null}
      {items?.length ? (
        <ul className="fl-list" aria-label={SCRIPTS_TEXT.list}>
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
            {loadingMore ? <Spinner /> : null} {SCRIPTS_TEXT.loadMore}
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
  const when = formatWhen(r.createdAt);
  return (
    <li className="fl-row" aria-label={SCRIPTS_TEXT.runLabel({ when })}>
      <span className="fl-row-title">
        <button type="button" className="cl-link" aria-expanded={open} onClick={onToggle}>
          {SCRIPTS_TEXT.run({ when })}
        </button>
        <Badge tone={s.tone} icon={s.icon}>
          {s.text}
        </Badge>
      </span>
      <span className="muted ws-row-meta">
        <span>{SCRIPTS_TEXT.calls({ n: r.calls })}</span>
        <span>{SCRIPTS_TEXT.cpu({ duration: formatDuration(r.cpuMs) })}</span>
        <span>
          {rich(SCRIPTS_TEXT.code, {
            hash: (
              <code title={r.codeSha256} dir="ltr">
                {r.codeSha256.slice(0, 12)}
              </code>
            ),
          })}
        </span>
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
        <p>{flaggedErrorMessage(run.error, 'scripts', SCRIPTS_TEXT.runLoadFailed)}</p>
        <Button onClick={run.reload}>{FLAGGED_TEXT.retry}</Button>
      </div>
    ) : (
      <Spinner label={SCRIPTS_TEXT.callsLoading} />
    );
  return (
    <section className="fl-nested" aria-labelledby={headingId}>
      <h4 id={headingId} className="fl-nested-title">
        {SCRIPTS_TEXT.nestedHeading}
      </h4>
      {r.nested.length === 0 ? (
        <p className="muted cl-small">{SCRIPTS_TEXT.noCalls}</p>
      ) : (
        <ol className="fl-calls" aria-label={SCRIPTS_TEXT.nestedList}>
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
                <span className="muted cl-small">{callTime(c.durationMs, !!c.approvalId)}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** How long a nested call took (or that it has not finished), and whether it asked first. */
function callTime(durationMs: number | null, asked: boolean): string {
  if (durationMs === null) return asked ? SCRIPTS_TEXT.notFinishedAsked : SCRIPTS_TEXT.notFinished;
  const duration = formatDuration(durationMs);
  return asked ? SCRIPTS_TEXT.tookAsked({ duration }) : duration;
}
