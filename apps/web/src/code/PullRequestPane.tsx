// The Pull request pane of a Code session (FR-070, docs/10 §8): the pull request with its state,
// branches and link, and its CI status with every check's state, summary and details link. The
// Hub polls CI and announces changes (`code.pr.ci.changed`); Refresh reads the host now. Check
// names and summaries come from the host and are shown as text only.
import { useState } from 'react';
import type { PullRequestView } from '@nova/shared';
import { defineMessages } from '@nova/i18n';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { formatWhen } from '../settings/common.ts';
import { useSettings } from '../settings.tsx';
import { useCodeM6Api } from './api-m6.ts';
import {
  CI_ICON,
  CI_TEXT,
  CI_TONE,
  PR_STATE_TEXT,
  checkIcon,
  checkText,
  checkTone,
  safeHttpUrl,
} from './m6-format.ts';
import { Badge } from './parts.tsx';

export const PR_TEXT = defineMessages('code.pr', {
  title: 'Pull request',
  emptyTitle: 'No pull request yet',
  emptyBody:
    'Push the session’s branch and open a pull request on a connected Git host. Its CI checks show here.',
  open: 'Open a pull request…',
  push: 'Push…',
  readFailed: 'Could not read the pull request: {reason}',
  heading: '#{number} {title}',
  into: '{head} into {base}',
  opened: 'Opened {when}',
  failed: '{failed, plural, one {# check of {total} failed.} other {# checks of {total} failed.}}',
  checks: '{n, plural, one {# check.} other {# checks.}}',
  reading: 'Reading the pull request',
  refresh: 'Refresh',
  checksRead: 'Checks read {when}.',
  notRead: 'Checks not read yet.',
  feedbackOn: 'Failed checks go back to the agent to fix.',
  feedbackOff: 'Failed checks are not sent to the agent (Settings → Code).',
  ciChecks: 'CI checks',
  details: 'Details',
});

export function PullRequestPane({
  sessionId,
  pr,
  unavailable,
  onOpen,
  onPush,
  onRefreshed,
}: {
  sessionId: string;
  pr: PullRequestView | null;
  /** Why pushing and pull requests cannot be used for this session, if they cannot. */
  unavailable: string | null;
  onOpen: () => void;
  onPush: () => void;
  onRefreshed: (pr: PullRequestView) => void;
}) {
  const m6 = useCodeM6Api();
  const toast = useToast();
  const feedback = useSettings().get('code.ciFeedback').value;
  const [refreshing, setRefreshing] = useState(false);

  if (!pr)
    return (
      <section className="code-pr" aria-label={PR_TEXT.title}>
        <EmptyState
          level={3}
          title={PR_TEXT.emptyTitle}
          description={unavailable ?? PR_TEXT.emptyBody}
          icon="branch"
          action={
            unavailable ? undefined : (
              <span className="code-actions">
                <Button variant="primary" onClick={onOpen}>
                  {PR_TEXT.open}
                </Button>
                <Button onClick={onPush}>{PR_TEXT.push}</Button>
              </span>
            )
          }
        />
      </section>
    );

  const url = safeHttpUrl(pr.url);
  const refresh = async () => {
    setRefreshing(true);
    try {
      onRefreshed(await m6.refreshPullRequest(sessionId));
    } catch (err) {
      toast.show(PR_TEXT.readFailed({ reason: errorMessage(err) }), { tone: 'error' });
    } finally {
      setRefreshing(false);
    }
  };
  const failed = pr.ci.checks.filter((c) => checkTone(c) === 'danger').length;

  return (
    <section className="code-pr" aria-label={PR_TEXT.title}>
      <div className="code-pr-head">
        <h3 dir="auto">
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer">
              {PR_TEXT.heading({ number: String(pr.number), title: pr.title })}{' '}
              <Icon name="external" />
            </a>
          ) : (
            PR_TEXT.heading({ number: String(pr.number), title: pr.title })
          )}
        </h3>
        <Badge
          tone={pr.state === 'open' ? 'ok' : 'muted'}
          icon={pr.state === 'merged' ? 'check' : pr.state === 'open' ? 'branch' : 'close'}
        >
          {PR_STATE_TEXT[pr.state]}
        </Badge>
      </div>
      <span className="muted code-row-meta">
        <span className="code-path" dir="ltr">
          {pr.repo}
        </span>
        <span>{PR_TEXT.into({ head: pr.headBranch, base: pr.baseBranch })}</span>
        <span>{PR_TEXT.opened({ when: formatWhen(pr.createdAt) })}</span>
      </span>
      <div className="code-subhead">
        <p aria-live="polite" className="code-ci-line">
          <Badge tone={CI_TONE[pr.ci.status]} icon={CI_ICON[pr.ci.status]}>
            {CI_TEXT[pr.ci.status]}
          </Badge>{' '}
          {pr.ci.checks.length
            ? failed
              ? PR_TEXT.failed({ failed, total: pr.ci.checks.length })
              : PR_TEXT.checks({ n: pr.ci.checks.length })
            : null}
        </p>
        <Button disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? <Spinner label={PR_TEXT.reading} /> : <Icon name="refresh" />}{' '}
          {PR_TEXT.refresh}
        </Button>
      </div>
      <p className="muted ws-flush">
        {pr.polledAt ? PR_TEXT.checksRead({ when: formatWhen(pr.polledAt) }) : PR_TEXT.notRead}{' '}
        {feedback ? PR_TEXT.feedbackOn : PR_TEXT.feedbackOff}
      </p>
      {pr.ci.checks.length ? (
        <ul className="code-checks" aria-label={PR_TEXT.ciChecks}>
          {pr.ci.checks.map((c, i) => {
            const link = safeHttpUrl(c.url);
            return (
              <li key={`${c.name}-${i}`} className="code-ci-check">
                <span className="code-check-name">{c.name}</span>
                <Badge tone={checkTone(c)} icon={checkIcon(c)}>
                  {checkText(c)}
                </Badge>
                {link ? (
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    {PR_TEXT.details} <Icon name="external" />
                  </a>
                ) : null}
                {c.summary ? (
                  <p className="code-check-summary" dir="auto">
                    {c.summary}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
