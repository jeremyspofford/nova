// Settings (docs/14 §1.2): a section nav and one page per section, addressed as /settings/:section.
import { navigate, SETTINGS_SECTIONS, type SettingsSection } from '../router.ts';
import { AccountsPage } from './AccountsPage.tsx';
import { AppearancePage } from './AppearancePage.tsx';
import { GeneralPage } from './GeneralPage.tsx';
import { DevicesPage } from './DevicesPage.tsx';
import { KeyboardPage } from './KeyboardPage.tsx';
import { MemoryPage } from './MemoryPage.tsx';
import { ModelsPage } from './ModelsPage.tsx';

export const SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'General',
  accounts: 'Accounts',
  models: 'Models',
  memory: 'Memory',
  devices: 'Devices',
  appearance: 'Appearance',
  keyboard: 'Keyboard',
};

export function SettingsView({
  section,
  displayName,
  onDisplayName,
}: {
  section: SettingsSection;
  displayName: string | null;
  onDisplayName: (name: string | null) => void;
}) {
  return (
    <div className="settings">
      <h1 className="settings-title">Settings</h1>
      <nav className="settings-nav" aria-label="Settings sections">
        <ul>
          {SETTINGS_SECTIONS.map((s) => (
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
        {section === 'general' ? <GeneralPage /> : null}
        {section === 'accounts' ? (
          <AccountsPage displayName={displayName} onDisplayName={onDisplayName} />
        ) : null}
        {section === 'models' ? <ModelsPage /> : null}
        {section === 'memory' ? <MemoryPage /> : null}
        {section === 'devices' ? <DevicesPage /> : null}
        {section === 'appearance' ? <AppearancePage /> : null}
        {section === 'keyboard' ? <KeyboardPage /> : null}
      </div>
    </div>
  );
}
