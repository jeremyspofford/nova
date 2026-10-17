// The Code review card (FR-069, docs/10 §5): findings grouped by file, errors first, each with
// its severity as an icon and a word (never color alone), the line, the reasoning and, when the
// reviewer suggested one, the fix with an "Apply fix" action that sends it to the agent.
import { useState } from 'react';
import type { CodeReviewView, ReviewFindingView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, type IconName } from '@nova/ui';
import { plural } from '../settings/common.ts';

export const SEVERITY: Record<
  ReviewFindingView['severity'],
  { text: string; plural: string; icon: IconName; rank: number }
> = {
  error: { text: 'Error', plural: 'errors', icon: 'stop', rank: 0 },
  warn: { text: 'Warning', plural: 'warnings', icon: 'alert', rank: 1 },
  info: { text: 'Note', plural: 'notes', icon: 'eye', rank: 2 },
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
  if (!findings.length) return 'No findings.';
  const parts = (['error', 'warn', 'info'] as const)
    .map((s) => {
      const n = findings.filter((f) => f.severity === s).length;
      return n ? `${n} ${n === 1 ? SEVERITY[s].text.toLowerCase() : SEVERITY[s].plural}` : null;
    })
    .filter(Boolean);
  return `${plural(findings.length, 'finding')}: ${parts.join(', ')}.`;
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
    <section className="code-review" aria-label="Review">
      <div className="code-diff-bar">
        <Button variant="primary" disabled={running} onClick={onRun}>
          {running ? <Spinner /> : <Icon name="eye" />} {review ? 'Review again' : 'Review changes'}
        </Button>
        <span className="muted">A second model reads the changes and points out problems.</span>
      </div>
      {error ? (
        <p className="ws-error" role="alert">
          {error}
        </p>
      ) : null}
      {!review && !running && !error ? (
        <EmptyState
          title="No review yet"
          description="Run a review to get findings by file, with fixes you can send to the agent."
          icon="eye"
          level={3}
        />
      ) : null}
      {running ? (
        <p className="muted" role="status">
          <Spinner /> Reviewing the changes…
        </p>
      ) : null}
      {review && review.status === 'failed' ? (
        <p className="ws-error" role="alert">
          The review failed. Try again, or check that a model is available.
        </p>
      ) : null}
      {review && review.status === 'done' ? (
        <article className="code-review-card" aria-labelledby={`review-${review.id}`}>
          <h3 id={`review-${review.id}`}>Code review</h3>
          <p role="status">{reviewSummary(review.findings)}</p>
          {groupFindings(review.findings).map((g) => (
            <section key={g.path} className="code-review-file" aria-label={g.path}>
              <h4 className="code-path">{g.path}</h4>
              <ul className="code-findings">
                {g.findings.map((f) => (
                  <li key={f.id} className="code-finding" data-severity={f.severity}>
                    <div className="code-finding-head">
                      <span className="code-sev" data-severity={f.severity}>
                        <Icon name={SEVERITY[f.severity].icon} /> {SEVERITY[f.severity].text}
                      </span>
                      <strong>{f.title}</strong>
                      {f.line !== null ? <span className="muted">Line {f.line}</span> : null}
                    </div>
                    <p>{f.reasoning}</p>
                    {f.fix ? (
                      <>
                        <pre className="code-fix">
                          <code>{f.fix}</code>
                        </pre>
                        <Button
                          disabled={sent.has(f.id) || applying !== null}
                          aria-label={
                            sent.has(f.id) ? `Fix sent: ${f.title}` : `Apply fix: ${f.title}`
                          }
                          onClick={() => void apply(f)}
                        >
                          {applying === f.id ? <Spinner /> : null}
                          {sent.has(f.id) ? 'Fix sent' : 'Apply fix'}
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
