// Suggestions from proactive research (FR-082, FR-189; docs/09 §8): what the agent found while
// idle and proposes. Accepting only records the choice: a suggestion is the agent's words, never
// an instruction, so nothing runs until the user writes to the agent. Dismissing hides it.
// Suggestion text is the agent's: shown as text.
import { useEffect, useId, useState } from 'react';
import type { AgentSuggestionView } from '@nova/shared';
import { Button, RadioGroup, Spinner, useToast } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { formatWhen } from '../settings/common.ts';
import { useAgentsApi } from './api.ts';

const STATUS_TEXT: Record<AgentSuggestionView['status'], string> = {
  open: 'Open',
  accepted: 'Accepted',
  dismissed: 'Dismissed',
};

export function AgentSuggestions({
  agentId,
  version,
  onDecided,
}: {
  agentId: string;
  version: number;
  /** A suggestion was decided: the open count in the header follows. */
  onDecided: () => void;
}) {
  const api = useAgentsApi();
  const toast = useToast();
  const headingId = useId();
  const [filter, setFilter] = useState<'open' | 'all'>('open');
  const [items, setItems] = useState<AgentSuggestionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(0);

  useEffect(() => {
    let alive = true;
    api.listAgentSuggestions(agentId, filter === 'open' ? 'open' : undefined).then(
      ({ items: list }) => {
        if (!alive) return;
        setItems(list);
        setError(null);
      },
      (err: unknown) => alive && setError(errorMessage(err, 'Could not load the suggestions.')),
    );
    return () => {
      alive = false;
    };
  }, [api, agentId, filter, version, manual]);

  const decide = (s: AgentSuggestionView, action: 'accept' | 'dismiss') => {
    api.decideAgentSuggestion(agentId, s.id, action).then(
      (next) => {
        setItems((list) =>
          filter === 'open'
            ? (list ?? []).filter((x) => x.id !== s.id)
            : (list ?? []).map((x) => (x.id === s.id ? next : x)),
        );
        onDecided();
        toast.show(
          action === 'accept'
            ? 'Accepted. To act on it, ask the agent in its conversation.'
            : 'Dismissed.',
          { tone: 'success' },
        );
      },
      (err: unknown) => {
        // Someone decided it already (another device): show it as it is now.
        if (err instanceof ApiError && err.status === 409) setManual((n) => n + 1);
        toast.show(`Could not decide it: ${errorMessage(err)}`, { tone: 'error' });
      },
    );
  };

  return (
    <section className="agent-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Suggestions</h2>
      <p className="muted ws-flush">
        What the agent found during proactive research. Accepting only records your choice; nothing
        happens until you ask the agent to act.
      </p>
      <RadioGroup
        legend="Show"
        name={`sugg${headingId}`}
        className="work-filter"
        value={filter}
        onChange={(v) => setFilter(v === 'all' ? 'all' : 'open')}
        options={[
          { value: 'open', label: 'Open' },
          { value: 'all', label: 'All' },
        ]}
      />
      {error ? (
        <div className="ws-error" role="alert">
          <p>{error}</p>
          <Button onClick={() => setManual((n) => n + 1)}>Retry</Button>
        </div>
      ) : items === null ? (
        <Spinner label="Loading the suggestions" />
      ) : items.length === 0 ? (
        <p className="muted">
          {filter === 'open'
            ? 'No open suggestions. With proactive research on, the agent brings findings here.'
            : 'No suggestions yet.'}
        </p>
      ) : (
        <ul className="ws-list" aria-label="Suggestions">
          {items.map((s) => (
            <li key={s.id} className="ws-list-row agent-suggestion" aria-label={s.title}>
              <div className="work-row-main">
                <span className="ws-card-link" data-untrusted="true">
                  {s.title}
                </span>
                <span className="agent-text" data-untrusted="true">
                  {s.body}
                </span>
                <span className="muted ws-row-meta">
                  <span>{formatWhen(s.createdAt)}</span>
                  {s.status === 'open' ? null : (
                    <span className="ws-badge">{STATUS_TEXT[s.status]}</span>
                  )}
                </span>
              </div>
              {s.status === 'open' ? (
                <div className="ws-row-actions ws-toolbar">
                  <Button aria-label={`Accept: ${s.title}`} onClick={() => decide(s, 'accept')}>
                    Accept
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={`Dismiss: ${s.title}`}
                    onClick={() => decide(s, 'dismiss')}
                  >
                    Dismiss
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
