// Team (FR-217, FR-091; decision 5 of ADR-095): what the people of this Hub do together, at
// /team and /team/:section. Shared chats (/team/shared, a chat at /team/shared/:threadId) and team
// agents (/team/agents, one at /team/agents/:id, a new one at /team/agents/new). On desktop the
// sections are tabs; on phones /team lists them and each one is a full page with a way back
// (docs/04 §4.3). The people themselves and their invitations live in Settings → Members.
import { Icon, Tabs } from '@nova/ui';
import { useLayout } from '../hooks.ts';
import { navigate } from '../router.ts';
import { followLink } from '../work/nav.tsx';
import {
  MEMBERS_SETTINGS_PATH,
  NEW_TEAM_AGENT_ID,
  TEAM_PATH,
  TEAM_SECTIONS,
  TEAM_SECTION_INFO,
  teamPath,
  teamSectionFrom,
  type TeamSection,
} from './format.ts';
import { SharedList } from './SharedList.tsx';
import { SharedThreadPage } from './SharedThreadPage.tsx';
import { TeamAgentPage } from './TeamAgentPage.tsx';
import { NewTeamAgent, TeamAgentsList } from './TeamAgentsList.tsx';
import '../workspace.css';
import './team.css';

function panel(section: TeamSection) {
  return section === 'shared' ? <SharedList /> : <TeamAgentsList />;
}

function MembersLink() {
  return (
    <p className="muted ws-flush">
      The people of this Hub and their invitations are in{' '}
      <a href={MEMBERS_SETTINGS_PATH} onClick={(e) => followLink(e, MEMBERS_SETTINGS_PATH)}>
        Settings → Members
      </a>
      .
    </p>
  );
}

export function TeamSurface({ section, id }: { section: string | null; id?: string | null }) {
  const { layout } = useLayout();
  const current = teamSectionFrom(section);

  if (current === 'shared' && id) return <SharedThreadPage threadId={id} />;
  if (current === 'agents' && id === NEW_TEAM_AGENT_ID) return <NewTeamAgent />;
  if (current === 'agents' && id) return <TeamAgentPage agentId={id} />;

  if (layout === 'phone') {
    if (!current) {
      return (
        <div className="ws-page team-page">
          <header className="ws-page-header">
            <h1>Team</h1>
          </header>
          <p className="muted ws-flush">What the people of this Hub do together.</p>
          <nav aria-label="Team sections">
            <ul className="team-menu">
              {TEAM_SECTIONS.map((s) => (
                <li key={s}>
                  <a href={teamPath(s)} onClick={(e) => followLink(e, teamPath(s))}>
                    <span className="team-menu-text">
                      <span className="team-strong">{TEAM_SECTION_INFO[s].label}</span>
                      <span className="muted team-small">{TEAM_SECTION_INFO[s].description}</span>
                    </span>
                    <Icon name="forward" />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <MembersLink />
        </div>
      );
    }
    return (
      <div className="ws-page team-page">
        <nav aria-label="Breadcrumb" className="ws-breadcrumb">
          <a href={TEAM_PATH} onClick={(e) => followLink(e, TEAM_PATH)}>
            <Icon name="back" /> Team
          </a>
        </nav>
        <header className="ws-page-header">
          <h1>{TEAM_SECTION_INFO[current].label}</h1>
        </header>
        {panel(current)}
      </div>
    );
  }

  const value = current ?? 'shared';
  return (
    <div className="ws-page team-page">
      <header className="ws-page-header">
        <h1>Team</h1>
      </header>
      <MembersLink />
      <Tabs
        label="Team sections"
        className="team-tabs"
        value={value}
        onChange={(t) => navigate(teamPath(teamSectionFrom(t)), { replace: true })}
        items={TEAM_SECTIONS.map((s) => ({
          id: s,
          label: TEAM_SECTION_INFO[s].label,
          panel: s === value ? panel(s) : null,
        }))}
      />
    </div>
  );
}
