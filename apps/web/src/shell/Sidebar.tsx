// Sidebar (FR-001, docs/04 §1): New chat, Search, the four modes (Chat lists its threads), and
// Settings. It is a landmark with a logical tab order; the thread list is one roving tab stop.
import { Icon, Kbd, type IconName } from '@nova/ui';
import { ThreadList } from '../chat/ThreadList.tsx';
import { SearchPanel } from '../chat/SearchPanel.tsx';
import { formatBinding } from '../keys.ts';
import { navigate, type Mode } from '../router.ts';
import { useServices } from '../services.tsx';

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
        {(Object.keys(MODE_INFO) as Mode[]).map((m) => {
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
            </li>
          );
        })}
      </ul>
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
