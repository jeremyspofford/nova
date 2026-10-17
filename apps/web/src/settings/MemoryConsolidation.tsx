// Memory consolidation and history reference on the Memory page (FR-204, FR-205, docs/04 §2.7):
// the summary Nova puts in context (read-only; correcting items is how it changes, ADR-069),
// "Consolidate now" with the run history, background consolidation, the "Reference past chats"
// switch, and "Remember more / less" per category (memory topics).
import { useEffect, useState } from 'react';
import type { ConsolidationRunView, MemorySummaryView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen, plural, useInterval } from './common.ts';
import { SwitchField } from './controls.tsx';
import '../workspace.css';

/** The summary budget (FR-204). */
export const SUMMARY_BUDGET = 2500;
export const CONSOLIDATION_POLL_MS = 3000;

export type TopicPreference = 'more' | 'less' | 'default';

export function PastChatsSwitch() {
  const settings = useSettings();
  const toast = useToast();
  const ref = settings.get('memory.referencePastChats');
  return (
    <>
      <SwitchField
        label="Reference past chats"
        description="Use relevant earlier chats as context, separately from saved memories. Turning it off stops this at once and deletes the data derived from your chats within 30 days."
        checked={ref.value}
        locked={ref.locked}
        onChange={(v) =>
          void settings
            .set('memory.referencePastChats', v)
            .then(
              () =>
                !v &&
                toast.show(
                  'Past chats are no longer used. Derived data is deleted within 30 days.',
                  {
                    tone: 'success',
                  },
                ),
            )
            .catch((err: unknown) =>
              toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
            )
        }
      />
    </>
  );
}

function runPhase(r: ConsolidationRunView): string {
  return r.phase === 'extract' ? 'Collecting from idle chats' : 'Consolidating memories';
}

function RunStatus({ run }: { run: ConsolidationRunView }) {
  if (run.status === 'running')
    return (
      <span className="nv-chip" data-status="running">
        <Spinner />
        <span>Running</span>
      </span>
    );
  return run.status === 'completed' ? (
    <span className="nv-chip" data-status="ready">
      <Icon name="check" />
      <span>Done</span>
    </span>
  ) : (
    <span className="nv-chip" data-status="blocked">
      <Icon name="alert" />
      <span>Failed</span>
    </span>
  );
}

export function ConsolidationSection() {
  const { api } = useServices();
  const settings = useSettings();
  const toast = useToast();
  const background = settings.get('memory.consolidation');
  const [summary, setSummary] = useState<MemorySummaryView | null>(null);
  const [runs, setRuns] = useState<ConsolidationRunView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([api.memorySummary(), api.listConsolidations()]).then(
      ([s, r]) => {
        if (!alive) return;
        setSummary(s);
        setRuns(r.items);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the memory summary.')),
    );
    return () => {
      alive = false;
    };
  }, [api, version]);

  const running = runs?.some((r) => r.status === 'running') ?? false;
  // While a run is going, check on it; the summary refreshes with it.
  useInterval(() => setVersion((v) => v + 1), CONSOLIDATION_POLL_MS, running);

  const start = async () => {
    setStarting(true);
    try {
      const run = await api.consolidateMemory();
      setRuns((list) => [run, ...(list ?? []).filter((r) => r.id !== run.id)]);
      toast.show('Consolidation started. It runs in the background.', { tone: 'success' });
    } catch (err) {
      toast.show(`Could not start consolidation: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setStarting(false);
    }
  };

  const tokens = summary?.summaryTokens ?? 0;
  return (
    <section className="settings-section" aria-labelledby="memory-summary">
      <h3 id="memory-summary">Summary used in context</h3>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>Retry</Button>
        </div>
      ) : null}
      {summary === null && !error ? <Spinner label="Loading the memory summary" /> : null}
      {summary ? (
        summary.summary ? (
          <div className="panel-inset">
            <p className="ws-flush">
              {tokens.toLocaleString('en-US')} / {SUMMARY_BUDGET.toLocaleString('en-US')} tokens
              {summary.updatedAt ? ` · updated ${formatWhen(summary.updatedAt)}` : ''}
            </p>
            <meter
              className="ws-meter"
              min={0}
              max={SUMMARY_BUDGET}
              value={Math.min(tokens, SUMMARY_BUDGET)}
              aria-label="Summary size"
            />
            <details className="ws-advanced">
              <summary>View summary</summary>
              <p className="ws-summary">{summary.summary}</p>
            </details>
            <p className="muted ws-flush">
              Read-only. To change it, correct or dismiss the memories it comes from.
            </p>
          </div>
        ) : (
          <p className="muted">
            No summary yet. Consolidation writes one from your saved memories.
          </p>
        )
      ) : null}
      <SwitchField
        label="Consolidate in the background"
        description={`Collect lasting facts from chats idle for ${plural(background.value.idleMinutes, 'minute')}, merge them into your memories and update the summary.`}
        checked={background.value.enabled}
        locked={background.locked}
        onChange={(v) =>
          void settings
            .set('memory.consolidation', { ...background.value, enabled: v })
            .catch((err: unknown) =>
              toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' }),
            )
        }
      />
      <div className="row">
        <Button disabled={starting || running} onClick={() => void start()}>
          {starting ? <Spinner /> : <Icon name="refresh" />} Consolidate now
        </Button>
        {running ? <span className="muted">A consolidation is running.</span> : null}
      </div>
      {runs?.length ? (
        <ul className="ws-list" aria-label="Consolidation history">
          {runs.map((r) => (
            <li key={r.id} className="ws-list-row" aria-label={`Run ${formatWhen(r.startedAt)}`}>
              <div className="ws-source-main">
                <span className="ws-row-meta">
                  <RunStatus run={r} />
                  <span>{runPhase(r)}</span>
                  <span className="muted">Started {formatWhen(r.startedAt)}</span>
                </span>
                <span className="muted ws-row-meta">
                  {plural(r.threadsScanned, 'chat')} scanned · {r.itemsCreated} added ·{' '}
                  {r.itemsUpdated} updated · {r.itemsAged} aged
                  {r.summaryTokens !== null
                    ? ` · summary ${r.summaryTokens.toLocaleString('en-US')} tokens`
                    : ''}
                </span>
                {r.error ? <span className="nv-field-error">{r.error}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : runs ? (
        <p className="muted">No consolidation runs yet.</p>
      ) : null}
    </section>
  );
}

/** Memory topics: "Remember more / less" steers consolidation per category (FR-204). */
export function useMemoryTopics(): {
  preference: (topic: string) => TopicPreference;
  set: (topic: string, preference: TopicPreference) => void;
} {
  const { api } = useServices();
  const toast = useToast();
  const [topics, setTopics] = useState<Map<string, TopicPreference>>(new Map());

  useEffect(() => {
    let alive = true;
    api.listMemoryTopics().then(
      ({ items }) => alive && setTopics(new Map(items.map((t) => [t.topic, t.preference]))),
      () => undefined, // the controls still work; they start from the default
    );
    return () => {
      alive = false;
    };
  }, [api]);

  const put = (topic: string, p: TopicPreference) =>
    setTopics((m) => {
      const next = new Map(m);
      next.set(topic, p);
      return next;
    });

  return {
    preference: (topic) => topics.get(topic) ?? 'default',
    set: (topic, preference) => {
      const before = topics.get(topic) ?? 'default';
      put(topic, preference);
      api.setMemoryTopic(topic, preference).then(
        () =>
          toast.show(
            preference === 'default'
              ? `Back to the usual for ${topic}.`
              : `Nova will remember ${preference} about ${topic}.`,
            { tone: 'success' },
          ),
        (err: unknown) => {
          put(topic, before);
          toast.show(`Could not save: ${errorMessage(err)}`, { tone: 'error' });
        },
      );
    },
  };
}

export function TopicControls({
  topic,
  preference,
  onSet,
}: {
  topic: string;
  preference: TopicPreference;
  onSet: (p: TopicPreference) => void;
}) {
  return (
    <div className="row ws-topic" role="group" aria-label={`How much to remember about ${topic}`}>
      <Button
        variant="ghost"
        aria-pressed={preference === 'more'}
        onClick={() => onSet(preference === 'more' ? 'default' : 'more')}
      >
        Remember more
      </Button>
      <Button
        variant="ghost"
        aria-pressed={preference === 'less'}
        onClick={() => onSet(preference === 'less' ? 'default' : 'less')}
      >
        Remember less
      </Button>
    </div>
  );
}
