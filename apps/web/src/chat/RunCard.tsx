// The inline Work run of a chat (FR-186, ADR-077, docs/04 §2.2.1): a `work.start` call renders as
// a run card instead of a tool card. A proposed run shows its plan and budgets with Start run and
// Dismiss; a running one its live progress with Open in Work and Stop; a finished one its result
// summary and a link to the run. The card finds its run by the id in the call's result, or, while
// the call has none yet, by the chat's escalated runs. A failed or denied call keeps its tool card.
import { useEffect, useId, useState } from 'react';
import type { RunView, ToolCallStatus } from '@nova/shared';
import { Button, Icon, Spinner, StatusChip, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { useServices } from '../services.tsx';
import { eventRunId, useDebounced, useWorkEvents } from '../work/events.ts';
import { budgetLine, isFinal, progressLine, RUN_STATUS_TEXT, runPath } from '../work/format.ts';
import { followLink } from '../work/nav.tsx';
import { Markdown } from './Markdown.tsx';
import type { DisplayCall } from './thread-state.ts';
import { previewArgs } from './tool-apps.tsx';
import '../work/work.css';

/** The tool a chat uses to hand a multi-step request to a Work run (FR-186). */
export const RUN_TOOL = 'work.start';

const FAILED: readonly ToolCallStatus[] = ['error', 'denied', 'timeout', 'cancelled'];

/** True when the call should render as a run card (a failed call keeps its tool card). */
export function isRunCall(call: DisplayCall): boolean {
  return call.tool === RUN_TOOL && !FAILED.includes(call.status);
}

/** The run id in a tool result or progress text (JSON, or truncated JSON). */
export function runIdIn(text: string | null | undefined): string | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && typeof (v as { runId?: unknown }).runId === 'string')
      return (v as { runId: string }).runId || null;
  } catch {
    // a truncated preview: look for the field itself
  }
  return /"runId"\s*:\s*"([^"\\]{1,100})"/.exec(text)?.[1] ?? null;
}

/** Step titles from the call's arguments: `plan` as strings or `{title}` objects. */
export function planFromArgs(args: Record<string, unknown>): string[] {
  const plan = args.plan ?? args.steps;
  if (!Array.isArray(plan)) return [];
  return plan
    .map((s: unknown) =>
      typeof s === 'string'
        ? s
        : s && typeof s === 'object' && typeof (s as { title?: unknown }).title === 'string'
          ? (s as { title: string }).title
          : '',
    )
    .filter(Boolean);
}

export function RunCard({ call, chatThreadId }: { call: DisplayCall; chatThreadId: string }) {
  const { api } = useServices();
  const toast = useToast();
  const titleId = useId();
  const args = previewArgs(call.argsPreview);
  const fromCall = runIdIn(call.resultPreview) ?? runIdIn(call.progress);
  const [found, setFound] = useState<string | null>(null);
  const runId = fromCall ?? found;
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [lookup, setLookup] = useState(0);
  const objective = typeof args.objective === 'string' ? args.objective : '';

  // Without an id in the call, the newest run this chat escalated (matching the objective first).
  useEffect(() => {
    if (fromCall) return;
    let alive = true;
    api.listRuns({ status: 'all' }).then(
      ({ items }) => {
        if (!alive) return;
        const mine = items
          .filter((r) => r.origin === 'chat_escalation' && r.originRef === chatThreadId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const match = mine.find((r) => objective && r.objective === objective) ?? mine[0];
        if (match) setFound(match.id);
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, chatThreadId, fromCall, objective, call.status, lookup]);

  useEffect(() => {
    if (!runId) return;
    let alive = true;
    api.getRun(runId).then(
      (r) => {
        if (!alive) return;
        setRun(r);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the run.')),
    );
    return () => {
      alive = false;
    };
  }, [api, runId, attempt]);

  const refresh = useDebounced(() => setAttempt((n) => n + 1), 120);
  const relook = useDebounced(() => setLookup((n) => n + 1), 120);
  useWorkEvents(
    (env) => {
      // Still looking for the run: a new one may be it.
      if (!runId) {
        if (env.name === 'run.created') relook();
        return;
      }
      if (eventRunId(env) !== runId) return;
      if (env.name === 'run.budget.usage') {
        const u = env.payload.usage as Partial<RunView['used']> | undefined;
        if (u)
          setRun((r) =>
            r
              ? {
                  ...r,
                  used: {
                    timeSeconds: u.timeSeconds ?? r.used.timeSeconds,
                    tokens: u.tokens ?? r.used.tokens,
                    costUsd: u.costUsd ?? r.used.costUsd,
                  },
                }
              : r,
          );
        return;
      }
      refresh();
    },
    () => {
      if (runId) refresh();
    },
  );

  const act = async (label: string, fn: () => Promise<RunView>, after?: () => void) => {
    setBusy(true);
    try {
      setRun(await fn());
      after?.();
    } catch (err) {
      toast.show(`${label}: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const title =
    run?.title ??
    (typeof args.title === 'string' && args.title ? args.title : objective || 'Work run');
  const proposed = !!run && run.status === 'planning' && !run.planApproved;
  const steps = run?.plan?.length ? run.plan.map((s) => s.title) : planFromArgs(args);
  const link = run ? (
    <a href={runPath(run.id)} className="link" onClick={(e) => followLink(e, runPath(run.id))}>
      Open in Work<span className="nv-vh">: {run.title}</span>
    </a>
  ) : null;

  let body;
  if (!run) {
    body = error ? (
      <div role="alert" className="run-card-actions">
        <p>{error}</p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    ) : (
      <p className="muted">
        <Spinner label="Preparing the run" /> Preparing a Work run…
      </p>
    );
  } else if (dismissed && run.status === 'cancelled') {
    body = <p className="muted">Dismissed. The run did not start.</p>;
  } else if (proposed) {
    body = (
      <>
        <p>This needs several steps. Run it as a Work run?</p>
        {steps.length ? (
          <ol className="run-card-plan" aria-label="Plan">
            {steps.map((s, i) => (
              <li key={`${i}-${s}`}>{s}</li>
            ))}
          </ol>
        ) : (
          <p className="muted">The run writes its plan when it starts.</p>
        )}
        <p className="muted">Budget: {budgetLine(run.budgets)}</p>
        <div className="run-card-actions">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void act('Could not start the run', () => api.startRun(run.id))}
          >
            Start run
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void act(
                'Could not dismiss the run',
                () => api.controlRun(run.id, 'cancel'),
                () => setDismissed(true),
              )
            }
          >
            Dismiss
          </Button>
          {link}
        </div>
      </>
    );
  } else if (!isFinal(run.status)) {
    body = (
      <>
        <p role="status" className="run-card-progress">
          {progressLine(run)}
        </p>
        <div className="run-card-actions">
          {link}
          <Button
            disabled={busy}
            onClick={() =>
              void act('Could not stop the run', () => api.controlRun(run.id, 'cancel'))
            }
          >
            <Icon name="stop" /> Stop
          </Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p role="status">
          {RUN_STATUS_TEXT[run.status]}
          {run.status === 'output_missing'
            ? ': the run could not verify its declared output. Open it to see the trace.'
            : '.'}
        </p>
        {run.result?.summary ? <Markdown text={run.result.summary} /> : null}
        <div className="run-card-actions">{link}</div>
      </>
    );
  }

  return (
    <div
      className="run-card"
      role="group"
      aria-labelledby={titleId}
      data-status={run?.status ?? 'pending'}
      data-call-id={call.callId}
    >
      <div className="run-card-head">
        <Icon name="work" />
        <span id={titleId} className="run-card-title">
          <span className="nv-vh">Work run:</span> {title}
        </span>
        {run ? (
          <StatusChip status={run.derived.status} reason={run.derived.reason ?? undefined} />
        ) : null}
      </div>
      {body}
    </div>
  );
}
