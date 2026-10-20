// Settings and the provider setup in the pseudo-locale (FR-016): the settings navigation and every
// settings page this area owns show only words from messages. Sections other areas render on a
// page (spend caps, Git hosts, notification routing and the like) are skipped by heading: they
// are those areas' to check. Fixture names, model and preset labels, Hub details and the examples
// typed into fields are data. And the navigation in Arabic, right to left.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { fmt } from '@nova/i18n';
import type { ProviderAccountView } from '@nova/shared';
import { App } from '../src/App.tsx';
import { PROVIDER_TEXT } from '../src/providers/strings.ts';
import { SIDEBAR_TEXT } from '../src/shell/strings.ts';
import { ACCOUNTS_TEXT } from '../src/settings/AccountsPage.tsx';
import { APPEARANCE_TEXT } from '../src/settings/AppearancePage.tsx';
import { CLIENTS_TEXT } from '../src/settings/ClientsPage.tsx';
import { CODE_TEXT } from '../src/settings/CodePage.tsx';
import { COMMAND_RULES_TEXT } from '../src/settings/CommandRules.tsx';
import { DEVICES_TEXT } from '../src/settings/DevicesPage.tsx';
import { DIAGNOSTICS_TEXT } from '../src/settings/DiagnosticsPage.tsx';
import { GENERAL_TEXT } from '../src/settings/GeneralPage.tsx';
import { HOOKS_TEXT } from '../src/settings/HooksSection.tsx';
import { IMPORT_TEXT } from '../src/settings/ImportPage.tsx';
import { KEYBOARD_TEXT } from '../src/settings/KeyboardPage.tsx';
import { MCP_FORM_TEXT } from '../src/settings/McpServerForm.tsx';
import { CONSOLIDATION_TEXT } from '../src/settings/MemoryConsolidation.tsx';
import { MEMORY_TEXT } from '../src/settings/MemoryPage.tsx';
import { MODELS_TEXT } from '../src/settings/ModelsPage.tsx';
import { NOTIFICATIONS_TEXT } from '../src/settings/NotificationsPage.tsx';
import { PERMISSIONS_TEXT } from '../src/settings/PermissionsPage.tsx';
import { PLUGINS_TEXT } from '../src/settings/PluginsPage.tsx';
import { POLICY_RULES_TEXT } from '../src/settings/PolicyRules.tsx';
import { PROFILE_TEXT } from '../src/settings/ProfilePage.tsx';
import { SECTION_LABELS, SETTINGS_TEXT } from '../src/settings/SettingsView.tsx';
import { SKILLS_TEXT } from '../src/settings/SkillsSection.tsx';
import { THEME_TEXT } from '../src/settings/ThemeShare.tsx';
import { TOOLS_TEXT } from '../src/settings/ToolsPage.tsx';
import { USAGE_TEXT } from '../src/settings/UsageSection.tsx';
import { AUTONOMY_TEXT } from '../src/work/format.ts';
import {
  createHub,
  fakeEventSource,
  fakeTerminalScreen,
  fakeWebSocket,
  testRegistry,
} from './fakes.ts';
import { m3State } from './fakes-m3.ts';
import { m4State } from './fakes-m4.ts';
import { appAuth, hook, plugin } from './fakes-m4-settings.ts';
import { commandRule, grant, mcpServer, policyRule } from './fakes-settings.ts';
import { computeNode, memoryItem, workspaceState } from './fakes-workspace.ts';
import { expectFullyLocalized, renderInLocale, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

/** Model and preset labels of the fake Hub, and its Hub-side details. */
const SUNRISE = {
  schemaVersion: 1,
  id: 'com.example.sunrise',
  name: 'Sunrise',
  variant: 'light',
  tokens: { '--u-bg': '#fff8f0', '--u-accent': '#b34700', '--u-text': '#201810' },
};

const HUB_DATA = ['Mock fast', 'Mock smart', 'Faster', 'Balanced', 'Smarter'];

const provider = (over: Partial<ProviderAccountView> = {}): ProviderAccountView => ({
  id: 'pa-1',
  provider: 'openai',
  label: 'Work key',
  authKind: 'api_key',
  baseUrl: null,
  status: 'active',
  hasSecret: true,
  lastCheckAt: null,
  createdAt: '2026-10-01T12:00:00.000Z',
  ...over,
});

async function renderSettings(
  section: string,
  hub = createHub(),
  locale = 'en-XA',
): Promise<HTMLElement> {
  window.history.replaceState(null, '', `/settings/${section}`);
  await renderInLocale(
    locale,
    <App
      api={hub.api}
      registry={testRegistry()}
      eventSource={fakeEventSource}
      takeSetupCode={() => null}
      announceEveryMs={0}
      webSocket={fakeWebSocket}
      terminalScreen={fakeTerminalScreen}
    />,
  );
  await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });
  await screen.findByRole('heading', { level: 1, name: SETTINGS_TEXT.title });
  const page = document.querySelector<HTMLElement>('.settings-page');
  expect(page).toBeTruthy();
  // Wait for every list on the page to load.
  await waitFor(() => expect(page!.querySelector('.nv-spinner-wrap')).toBeNull());
  return page!;
}

/**
 * Marks the page's sections whose heading is not one of `mine` (sections other areas render on
 * the page), so the check skips them; returns the selector to skip.
 */
function otherAreas(page: Element, mine: readonly string[]): string {
  for (const s of page.querySelectorAll(':scope > section, :scope > .settings-section')) {
    const h = s.querySelector('h3');
    if (h && !mine.includes(h.textContent ?? '')) s.setAttribute('data-other-area', '');
  }
  return '[data-other-area]';
}

describe('Settings in en-XA', () => {
  it('shows the navigation and the page title localized', async () => {
    const page = await renderSettings('general');
    const nav = screen.getByRole('navigation', { name: SETTINGS_TEXT.navLabel });
    expect(within(nav).getByRole('link', { name: SECTION_LABELS.appearance })).toBeTruthy();
    expectFullyLocalized(nav);
    expectFullyLocalized(screen.getByRole('heading', { level: 1, name: SETTINGS_TEXT.title }));
    // General: the work run defaults list the autonomy levels, the Work area's words.
    const autonomy = Object.values(AUTONOMY_TEXT).flatMap((a) => [a.label, a.description]);
    expect(within(page).getByRole('heading', { name: GENERAL_TEXT.workRuns })).toBeTruthy();
    expectFullyLocalized(page, {
      data: [...HUB_DATA, ...autonomy, 'Ctrl+Enter'],
      skip: [otherAreas(page, [GENERAL_TEXT.setupGuide, GENERAL_TEXT.workRuns])],
    });
  });

  it('shows Accounts with a provider, and the provider setup', async () => {
    const hub = createHub({ providers: [provider(), provider({ id: 'pa-2', label: 'Home key' })] });
    const page = await renderSettings('accounts', hub);
    await within(page).findAllByText('Work key');
    const skip = otherAreas(page, [
      ACCOUNTS_TEXT.providers,
      ACCOUNTS_TEXT.activeAccounts,
      ACCOUNTS_TEXT.tools,
    ]);
    expectFullyLocalized(page, { data: ['Work key', 'Home key'], skip: [skip] });
    await userEvent.click(within(page).getByRole('button', { name: ACCOUNTS_TEXT.add }));
    const setup = within(page).getByRole('group', { name: PROVIDER_TEXT.provider });
    expectFullyLocalized(setup);
    await userEvent.click(within(setup).getByRole('radio', { name: /Åñţĥŕöþîç/ }));
    expectFullyLocalized(page, { data: ['Work key', 'Home key'], skip: [skip] });
  });

  it('shows Models, Memory and Profile & usage', async () => {
    let page = await renderSettings('models');
    expectFullyLocalized(page, {
      data: HUB_DATA,
      skip: [otherAreas(page, [MODELS_TEXT.presets, MODELS_TEXT.local, MODELS_TEXT.routing])],
    });
    resetDom();

    const memories = workspaceState({
      memory: [
        memoryItem({ id: 'm1', content: 'Lives in Lisbon', category: 'Home' }),
        memoryItem({ id: 'm2', content: 'Prefers tea', category: null, pinned: true }),
      ],
    });
    page = await renderSettings('memory', createHub({ workspace: memories }));
    await within(page).findByText('Lives in Lisbon');
    expectFullyLocalized(page, {
      data: ['Lives in Lisbon', 'Prefers tea', 'Home'],
      skip: [otherAreas(page, [MEMORY_TEXT.saved, CONSOLIDATION_TEXT.title])],
    });
    resetDom();

    page = await renderSettings('profile');
    await within(page).findByRole('heading', { name: USAGE_TEXT.title });
    expectFullyLocalized(page, {
      // The avatar's initial is the user's name.
      data: ['S'],
      skip: [otherAreas(page, [PROFILE_TEXT.profile, USAGE_TEXT.title])],
    });
  });

  it('shows Tools & MCP with a server, and its add form', async () => {
    const hub = createHub({
      m3: m3State({ mcpServers: [mcpServer({ id: 's1', name: 'files', envKeys: ['API_KEY'] })] }),
    });
    const page = await renderSettings('tools', hub);
    await within(page).findByRole('listitem', { name: 'files' });
    const data = ['files', 'files-server', 'npx -y some-mcp-server', 'API_KEY'];
    const skip = otherAreas(page, [TOOLS_TEXT.servers, TOOLS_TEXT.tools, TOOLS_TEXT.webSearch]);
    expectFullyLocalized(page, { data, skip: [skip] });
    await userEvent.click(within(page).getByRole('button', { name: TOOLS_TEXT.addServer }));
    const dialog = screen.getByRole('dialog', { name: MCP_FORM_TEXT.add });
    await userEvent.click(within(dialog).getByRole('button', { name: MCP_FORM_TEXT.addVariable }));
    await userEvent.click(within(dialog).getByRole('button', { name: MCP_FORM_TEXT.addServer }));
    expectFullyLocalized(dialog, { data: ['API_KEY'] });
  });

  it('shows Code, Apps & clients and Devices', async () => {
    let page = await renderSettings('code');
    expectFullyLocalized(page, {
      data: [...HUB_DATA, 'npm run build\nnpm test'],
      skip: [
        otherAreas(page, [
          CODE_TEXT.environments,
          CODE_TEXT.autoVerify,
          CODE_TEXT.budgets,
          CODE_TEXT.pullRequests,
          CODE_TEXT.worktrees,
        ]),
      ],
    });
    resetDom();

    const clients = createHub({
      m4: m4State({ apps: [appAuth({ clientName: 'Laptop editor' })] }),
    });
    page = await renderSettings('clients', clients);
    await within(page).findByRole('listitem', { name: 'Laptop editor' });
    expectFullyLocalized(page, {
      data: ['Laptop editor'],
      skip: [otherAreas(page, [CLIENTS_TEXT.server, CLIENTS_TEXT.clients])],
    });
    await userEvent.click(within(page).getByRole('button', { name: CLIENTS_TEXT.add }));
    expectFullyLocalized(screen.getByRole('dialog', { name: CLIENTS_TEXT.addTitle }));
    resetDom();

    const nodes = createHub({
      workspace: workspaceState({ nodes: [computeNode({ name: 'Desk GPU' })] }),
    });
    page = await renderSettings('devices', nodes);
    await within(page).findByRole('listitem', { name: 'Desk GPU' });
    expectFullyLocalized(page, {
      data: ['Desk GPU', ...HUB_DATA, 'qwen3:8b'],
      skip: [
        otherAreas(page, [
          DEVICES_TEXT.yourDevices,
          DEVICES_TEXT.adding,
          DEVICES_TEXT.rules,
          DEVICES_TEXT.nodes,
        ]),
      ],
    });
  });

  it('shows Plugins & skills with a plugin, a skill and a hook', async () => {
    const hub = createHub({
      m4: m4State({
        plugins: [plugin({ name: 'Notes', author: 'Example' })],
        hooks: [hook({ id: 'guard' })],
      }),
    });
    const page = await renderSettings('plugins', hub);
    await within(page).findByRole('listitem', { name: 'Notes' });
    await within(page).findByRole('listitem', { name: 'guard' });
    expectFullyLocalized(page, {
      // Names, descriptions, origins and hosts come from the plugin's manifest.
      data: [
        'Notes',
        'Example',
        'guard',
        'Keeps notes in a folder.',
        'api.example.com',
        'sha256:9f2c…41ab',
      ],
      skip: [
        otherAreas(page, [
          PLUGINS_TEXT.installed,
          PLUGINS_TEXT.catalog,
          PLUGINS_TEXT.local,
          SKILLS_TEXT.title,
          HOOKS_TEXT.title,
        ]),
      ],
    });
  });

  it('shows Permissions with rules, command rules and approvals', async () => {
    const hub = createHub({
      m3: m3State({
        rules: [policyRule({ label: 'Ask before mail' })],
        commandRules: [commandRule()],
        grants: [grant({ label: 'Tool fs.write' })],
      }),
    });
    const page = await renderSettings('permissions', hub);
    await within(page).findByRole('listitem', { name: 'Ask before mail' });
    expectFullyLocalized(page, {
      data: [
        'Ask before mail',
        'Tool fs.write',
        // The command rule: its pattern, examples and justification.
        'git status|diff',
        'git status',
        'git push',
        'Read-only Git inspection.',
        'read-only',
        'workspace',
        'project',
        'git push origin main',
        'fs.write',
      ],
      skip: [
        otherAreas(page, [
          PERMISSIONS_TEXT.folders,
          PERMISSIONS_TEXT.whatToolsMayDo,
          POLICY_RULES_TEXT.title,
          COMMAND_RULES_TEXT.title,
          PERMISSIONS_TEXT.grants,
          PERMISSIONS_TEXT.preview,
        ]),
      ],
    });
  });

  it('shows Notifications, Keyboard, Import and Diagnostics', async () => {
    let page = await renderSettings('notifications');
    expectFullyLocalized(page, {
      skip: [otherAreas(page, [NOTIFICATIONS_TEXT.whatToNotify, NOTIFICATIONS_TEXT.whileOpen])],
    });
    resetDom();

    page = await renderSettings('keyboard');
    expect(within(page).getByRole('heading', { name: KEYBOARD_TEXT.title })).toBeTruthy();
    // Rows of commands other areas register carry those areas' words.
    expectFullyLocalized(page, {
      skip: ['.nv-kbds', 'tr[data-command^="work."]', '[data-other-area]'],
    });
    resetDom();

    page = await renderSettings('import');
    expect(within(page).getByRole('heading', { name: IMPORT_TEXT.records })).toBeTruthy();
    expectFullyLocalized(page, {
      data: ['/home/me/.config/assistant', '/home/me/Downloads/chat-export.zip'],
    });
    resetDom();

    page = await renderSettings('diagnostics');
    expect(within(page).getByRole('heading', { name: DIAGNOSTICS_TEXT.health })).toBeTruthy();
    // The secrets and sandbox details are the Hub's own words.
    expectFullyLocalized(page, { data: ['Encrypted vault', 'No sandbox in the fake Hub'] });
  });
  it('shows Appearance with a saved theme and a theme to import', async () => {
    const hub = createHub();
    hub.state.settings['appearance.customThemes'] = [SUNRISE];
    const page = await renderSettings('appearance', hub);
    await within(page).findByRole('listitem', { name: 'Sunrise' });
    const skip = otherAreas(page, [
      APPEARANCE_TEXT.themeLabel,
      APPEARANCE_TEXT.colors,
      APPEARANCE_TEXT.textSection,
      APPEARANCE_TEXT.motion,
      THEME_TEXT.title,
    ]);
    // The theme link and the theme's id are code; its name is the user's.
    const data = ['Sunrise', 'com.example.sunrise'];
    expectFullyLocalized(page, { data, skip: [skip] });
    await userEvent.type(
      within(page).getByRole('textbox', { name: THEME_TEXT.importText }),
      'not a theme',
    );
    await userEvent.click(within(page).getByRole('button', { name: THEME_TEXT.check }));
    await within(page).findByText(THEME_TEXT.cannotImport);
    expectFullyLocalized(page, { data: [...data, 'not a theme'], skip: [skip] });
  });
});

describe('Settings in Arabic', () => {
  it('shows the navigation in Arabic, right to left', async () => {
    await renderSettings('general', createHub(), 'ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(SETTINGS_TEXT.title).toBe('الإعدادات');
    const nav = screen.getByRole('navigation', { name: SETTINGS_TEXT.navLabel });
    expect(within(nav).getByRole('link', { name: 'المظهر' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'الحسابات' })).toBeTruthy();
    // Every section name of the navigation has an Arabic translation.
    for (const link of within(nav).getAllByRole('link'))
      expect(link.textContent, link.getAttribute('href') ?? '').toMatch(/[؀-ۿ]/);
  });
  it('shows Appearance in Arabic', async () => {
    const page = await renderSettings('appearance', createHub(), 'ar');
    expect(within(page).getByRole('heading', { level: 2 }).textContent).toBe('المظهر');
    expect(within(page).getByRole('radio', { name: 'داكن' })).toBeTruthy();
    expect(within(page).getByRole('group', { name: 'السمة' })).toBeTruthy();
    // The size is a percentage formatted the Arabic way.
    expect(within(page).getByText(APPEARANCE_TEXT.textSize({ size: fmt.percent(1) }))).toBeTruthy();
  });
});
