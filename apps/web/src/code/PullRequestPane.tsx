// The Pull request pane of a Code session (FR-070, docs/10 §8): the pull request with its state,
// branches and link, and its CI status with every check's state, summary and details link. The
// Hub polls CI and announces changes (`code.pr.ci.changed`); Refresh reads the host now. Check
// names and summaries come from the host and are shown as text only.
import { useState } from 'react';
import type { PullRequestView } from '@nova/shared';
import { Button, EmptyState, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { formatWhen, plural } from '../settings/common.ts';
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
      <section className="code-pr" aria-label="Pull request">
        <EmptyState
          level={3}
          title="No pull request yet"
          description={
            unavailable ??
            'Push the session’s branch and open a pull request on a connected Git host. Its CI checks show here.'
          }
          icon="branch"
          action={
            unavailable ? undefined : (
              <span className="code-actions">
                <Button variant="primary" onClick={onOpen}>
                  Open a pull request…
                </Button>
                <Button onClick={onPush}>Push…</Button>
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
      toast.show(`Could not read the pull request: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setRefreshing(false);
    }
  };
  const failed = pr.ci.checks.filter((c) => checkTone(c) === 'danger').length;

  return (
    <section className="code-pr" aria-label="Pull request">
      <div className="code-pr-head">
        <h3>
          {url ? (
            <a href={url} target="_blank" rel="noopener noreferrer">
              #{pr.number} {pr.title} <Icon name="external" />
            </a>
          ) : (
            <>
              #{pr.number} {pr.title}
            </>
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
        <span className="code-path">{pr.repo}</span>
        <span>
          {pr.headBranch} into {pr.baseBranch}
        </span>
        <span>Opened {formatWhen(pr.createdAt)}</span>
      </span>
      <div className="code-subhead">
        <p aria-live="polite" className="code-ci-line">
          <Badge tone={CI_TONE[pr.ci.status]} icon={CI_ICON[pr.ci.status]}>
            {CI_TEXT[pr.ci.status]}
          </Badge>{' '}
          {pr.ci.checks.length
            ? failed
              ? `${plural(failed, 'check')} of ${pr.ci.checks.length} failed.`
              : `${plural(pr.ci.checks.length, 'check')}.`
            : null}
        </p>
        <Button disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? <Spinner label="Reading the pull request" /> : <Icon name="refresh" />}{' '}
          Refresh
        </Button>
      </div>
      <p className="muted ws-flush">
        {pr.polledAt ? `Checks read ${formatWhen(pr.polledAt)}.` : 'Checks not read yet.'}{' '}
        {feedback
          ? 'Failed checks go back to the agent to fix.'
          : 'Failed checks are not sent to the agent (Settings → Code).'}
      </p>
      {pr.ci.checks.length ? (
        <ul className="code-checks" aria-label="CI checks">
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
                    Details <Icon name="external" />
                  </a>
                ) : null}
                {c.summary ? <p className="code-check-summary">{c.summary}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
