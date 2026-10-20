// Memory consolidation and history reference on the Memory page (FR-204, FR-205, docs/04 §2.7):
// the summary Nova puts in context (read-only; correcting items is how it changes, ADR-069),
// "Consolidate now" with the run history, background consolidation, the "Reference past chats"
// switch, and "Remember more / less" per category (memory topics).
import { useEffect, useState } from 'react';
import { defineMessages } from '@nova/i18n';
import type { ConsolidationRunView, MemorySummaryView } from '@nova/shared';
import { Button, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { useSettings } from '../settings.tsx';
import { formatWhen, useInterval } from './common.ts';
import { SwitchField } from './controls.tsx';
import '../workspace.css';

export const CONSOLIDATION_TEXT = defineMessages('settings.memoryConsolidation', {
  pastChats: 'Reference past chats',
  pastChatsHint:
    'Use relevant earlier chats as context, separately from saved memories. Turning it off ' +
    'stops this at once and deletes the data derived from your chats within 30 days.',
  pastChatsOff: 'Past chats are no longer used. Derived data is deleted within 30 days.',
  saveFailed: 'Could not save: {error}',
  phaseExtract: 'Collecting from idle chats',
  phaseConsolidate: 'Consolidating memories',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  loadFailed: 'Could not load the memory summary.',
  started: 'Consolidation started. It runs in the background.',
  startFailed: 'Could not start consolidation: {error}',
  title: 'Summary used in context',
  retry: 'Retry',
  loading: 'Loading the memory summary',
  size: '{tokens} / {budget, plural, one {# token} other {# tokens}}',
  updated: 'updated {when}',
  sizeLabel: 'Summary size',
  view: 'View summary',
  readOnly: 'Read-only. To change it, correct or dismiss the memories it comes from.',
  noSummary: 'No summary yet. Consolidation writes one from your saved memories.',
  background: 'Consolidate in the background',
  backgroundHint:
    'Collect lasting facts from chats idle for {n, plural, one {# minute} other {# minutes}}, merge them into your memories and update the summary.',
  now: 'Consolidate now',
  isRunning: 'A consolidation is running.',
  history: 'Consolidation history',
  run: 'Run {when}',
  startedAt: 'Started {when}',
  runStats:
    '{chats, plural, one {# chat} other {# chats}} scanned · {added} added · {updated} updated · {aged} aged',
  runSummary: 'summary {n, plural, one {# token} other {# tokens}}',
  noRuns: 'No consolidation runs yet.',
  backToUsual: 'Back to the usual for {topic}.',
  willRemember:
    '{preference, select, more {Nova will remember more about {topic}.} other {Nova will remember less about {topic}.}}',
  howMuch: 'How much to remember about {topic}',
  more: 'Remember more',
  less: 'Remember less',
});
const S = CONSOLIDATION_TEXT;

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
        label={S.pastChats}
        description={S.pastChatsHint}
        checked={ref.value}
        locked={ref.locked}
        onChange={(v) =>
          void settings
            .set('memory.referencePastChats', v)
            .then(() => !v && toast.show(S.pastChatsOff, { tone: 'success' }))
            .catch((err: unknown) =>
              toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' }),
            )
        }
      />
    </>
  );
}

function runPhase(r: ConsolidationRunView): string {
  return r.phase === 'extract' ? S.phaseExtract : S.phaseConsolidate;
}

function RunStatus({ run }: { run: ConsolidationRunView }) {
  if (run.status === 'running')
    return (
      <span className="nv-chip" data-status="running">
        <Spinner />
        <span>{S.running}</span>
      </span>
    );
  return run.status === 'completed' ? (
    <span className="nv-chip" data-status="ready">
      <Icon name="check" />
      <span>{S.done}</span>
    </span>
  ) : (
    <span className="nv-chip" data-status="blocked">
      <Icon name="alert" />
      <span>{S.failed}</span>
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
      (err: unknown) => alive && setError(errorMessage(err, S.loadFailed)),
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
      toast.show(S.started, { tone: 'success' });
    } catch (err) {
      toast.show(S.startFailed({ error: errorMessage(err) }), { tone: 'error' });
    } finally {
      setStarting(false);
    }
  };

  const tokens = summary?.summaryTokens ?? 0;
  return (
    <section className="settings-section" aria-labelledby="memory-summary">
      <h3 id="memory-summary">{S.title}</h3>
      {error ? (
        <div role="alert" className="ws-error">
          <p>{error}</p>
          <Button onClick={() => setVersion((v) => v + 1)}>{S.retry}</Button>
        </div>
      ) : null}
      {summary === null && !error ? <Spinner label={S.loading} /> : null}
      {summary ? (
        summary.summary ? (
          <div className="panel-inset">
            <p className="ws-flush">
              {S.size({ tokens, budget: SUMMARY_BUDGET })}
              {summary.updatedAt ? ` · ${S.updated({ when: formatWhen(summary.updatedAt) })}` : ''}
            </p>
            <meter
              className="ws-meter"
              min={0}
              max={SUMMARY_BUDGET}
              value={Math.min(tokens, SUMMARY_BUDGET)}
              aria-label={S.sizeLabel}
            />
            <details className="ws-advanced">
              <summary>{S.view}</summary>
              <p className="ws-summary" dir="auto">
                {summary.summary}
              </p>
            </details>
            <p className="muted ws-flush">{S.readOnly}</p>
          </div>
        ) : (
          <p className="muted">{S.noSummary}</p>
        )
      ) : null}
      <SwitchField
        label={S.background}
        description={S.backgroundHint({ n: background.value.idleMinutes })}
        checked={background.value.enabled}
        locked={background.locked}
        onChange={(v) =>
          void settings
            .set('memory.consolidation', { ...background.value, enabled: v })
            .catch((err: unknown) =>
              toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' }),
            )
        }
      />
      <div className="row">
        <Button disabled={starting || running} onClick={() => void start()}>
          {starting ? <Spinner /> : <Icon name="refresh" />} {S.now}
        </Button>
        {running ? <span className="muted">{S.isRunning}</span> : null}
      </div>
      {runs?.length ? (
        <ul className="ws-list" aria-label={S.history}>
          {runs.map((r) => (
            <li
              key={r.id}
              className="ws-list-row"
              aria-label={S.run({ when: formatWhen(r.startedAt) })}
            >
              <div className="ws-source-main">
                <span className="ws-row-meta">
                  <RunStatus run={r} />
                  <span>{runPhase(r)}</span>
                  <span className="muted">{S.startedAt({ when: formatWhen(r.startedAt) })}</span>
                </span>
                <span className="muted ws-row-meta">
                  {S.runStats({
                    chats: r.threadsScanned,
                    added: r.itemsCreated,
                    updated: r.itemsUpdated,
                    aged: r.itemsAged,
                  })}
                  {r.summaryTokens !== null ? ` · ${S.runSummary({ n: r.summaryTokens })}` : ''}
                </span>
                {r.error ? <span className="nv-field-error">{r.error}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      ) : runs ? (
        <p className="muted">{S.noRuns}</p>
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
              ? S.backToUsual({ topic })
              : S.willRemember({ preference, topic }),
            { tone: 'success' },
          ),
        (err: unknown) => {
          put(topic, before);
          toast.show(S.saveFailed({ error: errorMessage(err) }), { tone: 'error' });
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
    <div className="row ws-topic" role="group" aria-label={S.howMuch({ topic })}>
      <Button
        variant="ghost"
        aria-pressed={preference === 'more'}
        onClick={() => onSet(preference === 'more' ? 'default' : 'more')}
      >
        {S.more}
      </Button>
      <Button
        variant="ghost"
        aria-pressed={preference === 'less'}
        onClick={() => onSet(preference === 'less' ? 'default' : 'less')}
      >
        {S.less}
      </Button>
    </div>
  );
}
