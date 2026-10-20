// The Code review card (FR-069, docs/10 §5): findings grouped by file, errors first, each with
// its severity as an icon and a word (never color alone), the line, the reasoning and, when the
// reviewer suggested one, the fix with an "Apply fix" action that sends it to the agent.
import { useState } from 'react';
import type { CodeReviewView, ReviewFindingView } from '@nova/shared';
import { defineMessages, fmt } from '@nova/i18n';
import { Button, EmptyState, Icon, Spinner, type IconName } from '@nova/ui';

export const REVIEW_TEXT = defineMessages('code.review', {
  severity: { error: 'Error', warn: 'Warning', info: 'Note' },
  /** Counts in the summary: "2 warnings". */
  count: {
    error: '{n, plural, one {# error} other {# errors}}',
    warn: '{n, plural, one {# warning} other {# warnings}}',
    info: '{n, plural, one {# note} other {# notes}}',
  },
  none: 'No findings.',
  summary: '{n, plural, one {# finding: {counts}.} other {# findings: {counts}.}}',
  title: 'Review',
  again: 'Review again',
  run: 'Review changes',
  intro: 'A second model reads the changes and points out problems.',
  emptyTitle: 'No review yet',
  emptyBody: 'Run a review to get findings by file, with fixes you can send to the agent.',
  reviewing: 'Reviewing the changes…',
  failed: 'The review failed. Try again, or check that a model is available.',
  card: 'Code review',
  line: 'Line {line}',
  fixSentLabel: 'Fix sent: {title}',
  applyLabel: 'Apply fix: {title}',
  fixSent: 'Fix sent',
  apply: 'Apply fix',
});

export const SEVERITY: Record<
  ReviewFindingView['severity'],
  { readonly text: string; icon: IconName; rank: number }
> = {
  error: {
    get text() {
      return REVIEW_TEXT.severity.error;
    },
    icon: 'stop',
    rank: 0,
  },
  warn: {
    get text() {
      return REVIEW_TEXT.severity.warn;
    },
    icon: 'alert',
    rank: 1,
  },
  info: {
    get text() {
      return REVIEW_TEXT.severity.info;
    },
    icon: 'eye',
    rank: 2,
  },
};

/** Files in order of their worst finding; findings by severity, then line. */
export function groupFindings(
  findings: readonly ReviewFindingView[],
): { path: string; findings: ReviewFindingView[] }[] {
  const byPath = new Map<string, ReviewFindingView[]>();
  for (const f of findings) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
  const worst = (list: ReviewFindingView[]) =>
    Math.min(...list.map((f) => SEVERITY[f.severity].rank));
  return [...byPath.entries()]
    .map(([path, list]) => ({
      path,
      findings: [...list].sort(
        (a, b) =>
          SEVERITY[a.severity].rank - SEVERITY[b.severity].rank || (a.line ?? 0) - (b.line ?? 0),
      ),
    }))
    .sort((a, b) => worst(a.findings) - worst(b.findings) || a.path.localeCompare(b.path));
}

export function reviewSummary(findings: readonly ReviewFindingView[]): string {
  if (!findings.length) return REVIEW_TEXT.none;
  const parts = (['error', 'warn', 'info'] as const)
    .map((s) => {
      const n = findings.filter((f) => f.severity === s).length;
      return n ? REVIEW_TEXT.count[s]({ n }) : null;
    })
    .filter((x): x is string => x !== null);
  return REVIEW_TEXT.summary({
    n: findings.length,
    counts: fmt.list(parts, { type: 'unit', style: 'short' }),
  });
}

export function ReviewPane({
  review,
  starting,
  error,
  onRun,
  onApplyFix,
}: {
  review: CodeReviewView | null;
  /** A review is being requested. */
  starting: boolean;
  error: string | null;
  onRun: () => void;
  /** Sends the finding's fix to the agent; resolves once it is sent. */
  onApplyFix: (f: ReviewFindingView) => Promise<boolean>;
}) {
  const [sent, setSent] = useState<Set<string>>(() => new Set());
  const [applying, setApplying] = useState<string | null>(null);
  const running = starting || review?.status === 'running';

  const apply = async (f: ReviewFindingView) => {
    setApplying(f.id);
    const ok = await onApplyFix(f);
    setApplying(null);
    if (ok) setSent((s) => new Set([...s, f.id]));
  };

  return (
    <section className="code-review" aria-label={REVIEW_TEXT.title}>
      <div className="code-diff-bar">
        <Button variant="primary" disabled={running} onClick={onRun}>
          {running ? <Spinner /> : <Icon name="eye" />}{' '}
          {review ? REVIEW_TEXT.again : REVIEW_TEXT.run}
        </Button>
        <span className="muted">{REVIEW_TEXT.intro}</span>
      </div>
      {error ? (
        <p className="ws-error" role="alert">
          {error}
        </p>
      ) : null}
      {!review && !running && !error ? (
        <EmptyState
          title={REVIEW_TEXT.emptyTitle}
          description={REVIEW_TEXT.emptyBody}
          icon="eye"
          level={3}
        />
      ) : null}
      {running ? (
        <p className="muted" role="status">
          <Spinner /> {REVIEW_TEXT.reviewing}
        </p>
      ) : null}
      {review && review.status === 'failed' ? (
        <p className="ws-error" role="alert">
          {REVIEW_TEXT.failed}
        </p>
      ) : null}
      {review && review.status === 'done' ? (
        <article className="code-review-card" aria-labelledby={`review-${review.id}`}>
          <h3 id={`review-${review.id}`}>{REVIEW_TEXT.card}</h3>
          <p role="status">{reviewSummary(review.findings)}</p>
          {groupFindings(review.findings).map((g) => (
            <section key={g.path} className="code-review-file" aria-label={g.path}>
              <h4 className="code-path" dir="ltr">
                {g.path}
              </h4>
              <ul className="code-findings">
                {g.findings.map((f) => (
                  <li key={f.id} className="code-finding" data-severity={f.severity}>
                    <div className="code-finding-head">
                      <span className="code-sev" data-severity={f.severity}>
                        <Icon name={SEVERITY[f.severity].icon} /> {SEVERITY[f.severity].text}
                      </span>
                      <strong dir="auto">{f.title}</strong>
                      {f.line !== null ? (
                        <span className="muted">{REVIEW_TEXT.line({ line: String(f.line) })}</span>
                      ) : null}
                    </div>
                    <p dir="auto">{f.reasoning}</p>
                    {f.fix ? (
                      <>
                        <pre className="code-fix">
                          <code>{f.fix}</code>
                        </pre>
                        <Button
                          disabled={sent.has(f.id) || applying !== null}
                          aria-label={
                            sent.has(f.id)
                              ? REVIEW_TEXT.fixSentLabel({ title: f.title })
                              : REVIEW_TEXT.applyLabel({ title: f.title })
                          }
                          onClick={() => void apply(f)}
                        >
                          {applying === f.id ? <Spinner /> : null}
                          {sent.has(f.id) ? REVIEW_TEXT.fixSent : REVIEW_TEXT.apply}
                        </Button>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </article>
      ) : null}
    </section>
  );
}
