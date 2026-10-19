// Sidebar (FR-001, docs/04 §1): New chat, Search, the four modes (Chat lists its threads),
// Projects with the most recent few (FR-034), and Settings. It is a landmark with a logical tab
// order; the thread list is one roving tab stop. M5: each chat's status chip follows the shared
// event stream, Needs input sorts first, and active Work runs list under Work (FR-215).
import { Icon, IconButton, Kbd, type IconName } from '@nova/ui';
import { ThreadList } from '../chat/ThreadList.tsx';
import { SearchPanel } from '../chat/SearchPanel.tsx';
import { formatBinding } from '../keys.ts';
import { useRecentProjects } from '../projects/events.ts';
import { navigate, projectPath, useRoute, type Mode } from '../router.ts';
import { useServices } from '../services.tsx';
import { SidebarRuns } from './SidebarRuns.tsx';
import { useWorkCommands } from '../work/commands.ts';
import { useSidebarStatus } from './SidebarStatus.ts';
import '../workspace.css';
import { SidebarAgents } from '../agents/SidebarAgents.tsx';
import { surfaceHiddenFor, useTeamRole } from '../team/role.tsx';

export const MODE_INFO: Record<Mode, { label: string; icon: IconName; command: string }> = {
  chat: { label: 'Chat', icon: 'chat', command: 'mode.chat' },
  work: { label: 'Work', icon: 'work', command: 'mode.work' },
  code: { label: 'Code', icon: 'code', command: 'mode.code' },
  agents: { label: 'Agents', icon: 'agents', command: 'mode.agents' },
};

export interface SidebarProps {
  id: string;
  mode: Mode | null;
  selectedThreadId: string | null;
  streamingThreadId: string | null;
  settingsOpen: boolean;
  searchOpen: boolean;
  onSearchOpen: (open: boolean) => void;
  onNewChat: () => void;
  onSwitchMode: (mode: Mode) => void;
  /** Phones: close the menu page after a choice. */
  onNavigated: () => void;
  hidden?: boolean;
}

export function Sidebar({
  id,
  mode,
  selectedThreadId,
  streamingThreadId,
  settingsOpen,
  searchOpen,
  onSearchOpen,
  onNewChat,
  onSwitchMode,
  onNavigated,
  hidden,
}: SidebarProps) {
  const { registry } = useServices();
  const route = useRoute();
  // A member sees only the surfaces that are theirs (M7, decision 5).
  const { role } = useTeamRole();
  const shown = (surface: string) => !surfaceHiddenFor(role, surface);
  // Chips stay live for every chat, and Ctrl/Cmd+Alt+A jumps to what needs input (FR-215).
  useSidebarStatus();
  useWorkCommands();
  const recentProjects = useRecentProjects();
  const openProjectId = route.name === 'projects' ? route.projectId : null;
  const mac = registry.platform.mac;
  const keys = (cmd: string) => {
    const b = registry.primaryBinding(cmd);
    return b ? <Kbd keys={formatBinding(b, mac)} /> : null;
  };

  return (
    <nav id={id} className="sidebar" aria-label="Sidebar" hidden={hidden}>
      <div className="sidebar-top">
        <button
          type="button"
          className="nv-btn sidebar-new"
          data-variant="primary"
          onClick={onNewChat}
        >
          <Icon name="plus" /> New chat
        </button>
        <IconButton
          label="New temporary chat"
          icon={<Icon name="clock" />}
          variant="ghost"
          onClick={() => {
            registry.run('chat.newTemporary');
            onNavigated();
          }}
        />
        <button
          type="button"
          className="nv-btn sidebar-search"
          data-variant="ghost"
          aria-expanded={searchOpen}
          onClick={() => onSearchOpen(!searchOpen)}
        >
          <Icon name="search" /> Search
        </button>
      </div>
      {searchOpen ? (
        <SearchPanel
          onClose={() => {
            onSearchOpen(false);
            queueMicrotask(() => document.querySelector<HTMLElement>('.sidebar-search')?.focus());
          }}
          onOpen={onNavigated}
        />
      ) : null}
      <ul className="modes" aria-label="Modes">
        {(Object.keys(MODE_INFO) as Mode[])
          .filter((m) => shown(m))
          .map((m) => {
            const info = MODE_INFO[m];
            const current = mode === m && !settingsOpen;
            return (
              <li key={m} className="mode-item">
                <a
                  href={m === 'chat' ? '/chat' : `/${m}`}
                  className="mode-link"
                  aria-current={current ? 'page' : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    onSwitchMode(m);
                    onNavigated();
                  }}
                >
                  <Icon name={info.icon} />
                  <span className="mode-label">{info.label}</span>
                  <span className="mode-keys">{keys(info.command)}</span>
                </a>
                {m === 'chat' ? (
                  <ThreadList
                    selectedId={mode === 'chat' && !settingsOpen ? selectedThreadId : null}
                    streamingId={streamingThreadId}
                    onOpen={onNavigated}
                  />
                ) : null}
                {m === 'work' ? (
                  <SidebarRuns
                    selectedId={route.name === 'mode' && route.mode === 'work' ? route.id : null}
                    onOpen={onNavigated}
                  />
                ) : null}
                {m === 'agents' ? (
                  <SidebarAgents
                    selectedId={
                      route.name === 'mode' && route.mode === 'agents' && route.id !== 'new'
                        ? route.id
                        : null
                    }
                    onOpen={onNavigated}
                  />
                ) : null}
              </li>
            );
          })}
      </ul>
      <div className="sidebar-projects">
        <a
          href={projectPath(null)}
          className="mode-link"
          aria-current={route.name === 'projects' && !openProjectId ? 'page' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate(projectPath(null));
            onNavigated();
          }}
        >
          <Icon name="folder" />
          <span className="mode-label">Projects</span>
        </a>
        {recentProjects.length ? (
          <ul className="threads" aria-label="Recent projects">
            {recentProjects.map((p) => (
              <li
                key={p.id}
                className="thread-row"
                data-selected={p.id === openProjectId || undefined}
              >
                <a
                  href={projectPath(p.id)}
                  className="thread-link"
                  aria-current={p.id === openProjectId ? 'page' : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                    e.preventDefault();
                    navigate(projectPath(p.id));
                    onNavigated();
                  }}
                >
                  <span className="thread-title">{p.name}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : null}
        {shown('library') ? (
          <a
            href="/library"
            className="mode-link"
            aria-current={route.name === 'library' ? 'page' : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate('/library');
              onNavigated();
            }}
          >
            <Icon name="file" />
            <span className="mode-label">Library</span>
          </a>
        ) : null}
        <a
          href="/spaces"
          className="mode-link"
          aria-current={route.name === 'spaces' ? 'page' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate('/spaces');
            onNavigated();
          }}
        >
          <Icon name="edit" />
          <span className="mode-label">Spaces</span>
        </a>
        <a
          href="/sites"
          className="mode-link"
          aria-current={route.name === 'sites' ? 'page' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate('/sites');
            onNavigated();
          }}
        >
          <Icon name="external" />
          <span className="mode-label">Sites</span>
        </a>
        <a
          href="/apps"
          className="mode-link"
          aria-current={route.name === 'apps' ? 'page' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate('/apps');
            onNavigated();
          }}
        >
          <Icon name="server" />
          <span className="mode-label">Apps</span>
        </a>
        {shown('marketplace') ? (
          <a
            href="/marketplace"
            className="mode-link"
            aria-current={route.name === 'marketplace' ? 'page' : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate('/marketplace');
              onNavigated();
            }}
          >
            <Icon name="download" />
            <span className="mode-label">Marketplace</span>
          </a>
        ) : null}
        <a
          href="/computers"
          className="mode-link"
          aria-current={route.name === 'computers' ? 'page' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate('/computers');
            onNavigated();
          }}
        >
          <Icon name="terminal" />
          <span className="mode-label">Computers</span>
        </a>
        {shown('devices') ? (
          <a
            href="/devices"
            className="mode-link"
            aria-current={route.name === 'devices' ? 'page' : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate('/devices');
              onNavigated();
            }}
          >
            <Icon name="server" />
            <span className="mode-label">Devices</span>
          </a>
        ) : null}
        {shown('network') ? (
          <a
            href="/network"
            className="mode-link"
            aria-current={route.name === 'network' ? 'page' : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              navigate('/network');
              onNavigated();
            }}
          >
            <Icon name="network" />
            <span className="mode-label">Network</span>
          </a>
        ) : null}
        <a
          href="/approvals"
          className="mode-link"
          aria-current={route.name === 'approvals' ? 'page' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate('/approvals');
            onNavigated();
          }}
        >
          <Icon name="shield" />
          <span className="mode-label">Approvals</span>
        </a>
        <a
          href="/team"
          className="mode-link"
          aria-current={route.name === 'team' ? 'page' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate('/team');
            onNavigated();
          }}
        >
          <Icon name="at" />
          <span className="mode-label">Team</span>
        </a>
      </div>
      <div className="sidebar-bottom">
        <a
          href="/settings/general"
          className="mode-link"
          aria-current={settingsOpen ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate('/settings/general');
            onNavigated();
          }}
        >
          <Icon name="settings" />
          <span className="mode-label">Settings</span>
          <span className="mode-keys">{keys('settings.open')}</span>
        </a>
      </div>
    </nav>
  );
}
