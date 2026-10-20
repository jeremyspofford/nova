// Agents under Agents in the sidebar (FR-079, FR-215; docs/04 §1): each row carries the agent's
// avatar and, unless it is Ready, its status chip; Needs input sorts first. Paused and stopped
// agents are marked. The rows follow agent events and the derived status of their threads.
import { Icon, StatusChip, VisuallyHidden } from '@nova/ui';
import { followLink } from '../work/nav.tsx';
import { AgentAvatar } from './AgentAvatar.tsx';
import { sortAgents, useAgentList } from './AgentList.tsx';
import { AGENTS_TEXT, agentPath, agentStateBadge } from './format.ts';
import './agents.css';

/** At most this many agents show; the Agents list has the rest. */
export const SIDEBAR_AGENTS = 8;

export function SidebarAgents({
  selectedId,
  onOpen,
}: {
  selectedId: string | null;
  onOpen?: () => void;
}) {
  const { agents } = useAgentList();
  // Load failures are reported by the Agents list; the sidebar stays quiet.
  if (!agents?.length) return null;
  const shown = sortAgents(agents).slice(0, SIDEBAR_AGENTS);
  return (
    <ul className="threads sidebar-agents" aria-label={AGENTS_TEXT.agents}>
      {shown.map((a) => {
        const selected = a.id === selectedId;
        const badge = agentStateBadge(a);
        return (
          <li key={a.id} className="thread-row" data-selected={selected || undefined}>
            <a
              href={agentPath(a.id)}
              className="thread-link"
              aria-current={selected ? 'page' : undefined}
              onClick={(e) => {
                followLink(e, agentPath(a.id));
                if (e.defaultPrevented) onOpen?.();
              }}
            >
              <AgentAvatar agent={a} size="sm" />
              <span className="thread-title">{a.name}</span>
              {badge ? (
                <>
                  <span className="thread-mark" title={badge.text}>
                    <Icon name={badge.icon} />
                  </span>
                  <VisuallyHidden>{badge.after}</VisuallyHidden>
                </>
              ) : null}
              {a.derived.status !== 'ready' ? (
                <StatusChip
                  status={a.derived.status}
                  reason={a.derived.reason ?? undefined}
                  compact
                />
              ) : null}
            </a>
          </li>
        );
      })}
    </ul>
  );
}
