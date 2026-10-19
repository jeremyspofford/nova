// Settings (docs/14 §1.2): a section nav and one page per section, addressed as /settings/:section.
import { navigate, SETTINGS_SECTIONS, type SettingsSection } from '../router.ts';
import { AccountsPage } from './AccountsPage.tsx';
import { AppearancePage } from './AppearancePage.tsx';
import { GeneralPage } from './GeneralPage.tsx';
import { DevicesPage } from './DevicesPage.tsx';
import { ClientsPage } from './ClientsPage.tsx';
import { DiagnosticsPage } from './DiagnosticsPage.tsx';
import { ImportPage } from './ImportPage.tsx';
import { PluginsPage } from './PluginsPage.tsx';
import { ProfilePage } from './ProfilePage.tsx';
import { NotificationsPage } from './NotificationsPage.tsx';
import { PermissionsPage } from './PermissionsPage.tsx';
import { CodePage } from './CodePage.tsx';
import { AgentsSettings } from '../agents/AgentsSettings.tsx';
import { BrowserSettings } from '../browser/BrowserSettings.tsx';
import { ChannelsPage } from '../channels/ChannelsPage.tsx';
import { TriggersPage } from '../channels/TriggersPage.tsx';
import { NetworkPage } from '../network/NetworkPage.tsx';
import { ComputerUseSettings } from '../screen/ComputerUseSettings.tsx';
import { ToolsPage } from './ToolsPage.tsx';
import { KeyboardPage } from './KeyboardPage.tsx';
import { MemoryPage } from './MemoryPage.tsx';
import { ModelsPage } from './ModelsPage.tsx';
import { AccountPage } from '../team/AccountPage.tsx';
import { MembersPage } from '../team/MembersPage.tsx';
import { MemberSettingsGate, useTeamRole, visibleSettingsSections } from '../team/role.tsx';
import { SyncPage } from '../sync/SyncPage.tsx';
import { CloudSettings } from '../cloud/CloudSettings.tsx';
import { ExperimentalSettings } from '../flagged/ExperimentalSettings.tsx';

export const SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'General',
  account: 'Account',
  members: 'Members',
  profile: 'Profile & usage',
  accounts: 'Accounts',
  models: 'Models',
  memory: 'Memory',
  tools: 'Tools & MCP',
  code: 'Code',
  cloud: 'Cloud runner',
  plugins: 'Plugins & skills',
  clients: 'Apps & clients',
  permissions: 'Permissions',
  'computer-use': 'Computer use',
  agents: 'Agents',
  notifications: 'Notifications',
  channels: 'Channels',
  triggers: 'Triggers',
  devices: 'Devices',
  network: 'Network',
  sync: 'Sync',
  browser: 'Browser',
  appearance: 'Appearance',
  keyboard: 'Keyboard',
  import: 'Import',
  experimental: 'Experimental',
  diagnostics: 'Diagnostics',
};

export function SettingsView({
  section,
  onDisplayName,
}: {
  section: SettingsSection;
  /** The shell passes it; Profile & usage loads the full profile itself. */
  displayName?: string | null;
  onDisplayName: (name: string | null) => void;
}) {
  // A member sees only the sections that are theirs (M7, decision 5).
  const { role } = useTeamRole();
  return (
    <div className="settings">
      <h1 className="settings-title">Settings</h1>
      <nav className="settings-nav" aria-label="Settings sections">
        <ul>
          {visibleSettingsSections(SETTINGS_SECTIONS, role).map((s) => (
            <li key={s}>
              <a
                href={`/settings/${s}`}
                aria-current={s === section ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/settings/${s}`);
                }}
              >
                {SECTION_LABELS[s]}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-body">
        <MemberSettingsGate section={section} label={SECTION_LABELS[section]}>
          {section === 'general' ? <GeneralPage /> : null}
          {section === 'account' ? <AccountPage /> : null}
          {section === 'members' ? <MembersPage /> : null}
          {section === 'sync' ? <SyncPage /> : null}
          {section === 'cloud' ? <CloudSettings /> : null}
          {section === 'experimental' ? <ExperimentalSettings /> : null}
          {section === 'accounts' ? <AccountsPage /> : null}
          {section === 'models' ? <ModelsPage /> : null}
          {section === 'memory' ? <MemoryPage /> : null}
          {section === 'profile' ? <ProfilePage onDisplayName={onDisplayName} /> : null}
          {section === 'tools' ? <ToolsPage /> : null}
          {section === 'code' ? <CodePage /> : null}
          {section === 'plugins' ? <PluginsPage /> : null}
          {section === 'clients' ? <ClientsPage /> : null}
          {section === 'import' ? <ImportPage /> : null}
          {section === 'permissions' ? <PermissionsPage /> : null}
          {section === 'computer-use' ? <ComputerUseSettings /> : null}
          {section === 'agents' ? <AgentsSettings /> : null}
          {section === 'notifications' ? <NotificationsPage /> : null}
          {section === 'channels' ? <ChannelsPage /> : null}
          {section === 'triggers' ? <TriggersPage /> : null}
          {section === 'diagnostics' ? <DiagnosticsPage /> : null}
          {section === 'devices' ? <DevicesPage /> : null}
          {section === 'network' ? <NetworkPage /> : null}
          {section === 'browser' ? <BrowserSettings /> : null}
          {section === 'appearance' ? <AppearancePage /> : null}
          {section === 'keyboard' ? <KeyboardPage /> : null}
        </MemberSettingsGate>
      </div>
    </div>
  );
}
