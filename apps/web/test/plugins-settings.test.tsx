import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { manifestInfo } from '../src/settings/PluginInstall.tsx';
import {
  catalogId,
  componentsText,
  isCatalogLocation,
  newestEntries,
} from '../src/settings/PluginsPage.tsx';
import {
  compareVersions,
  formatSeconds,
  hookHandlerText,
  hookSourceText,
  permissionDiff,
  permissionLines,
  shortHash,
} from '../src/settings/plugin-text.ts';
import { EMPTY_SKILL, skillRequest } from '../src/settings/SkillsSection.tsx';
import { createHub } from './fakes.ts';
import { m4State } from './fakes-m4.ts';
import {
  HASH_A,
  HASH_B,
  catalogEntry,
  hook,
  plugin,
  pluginPreview,
  skill,
} from './fakes-m4-settings.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const fail = (message: string, status = 500, code = 'x') =>
  new ApiError(status, { code, message, retryable: false });

describe('plugin, skill and hook text (FR-045, FR-046, FR-197)', () => {
  it('turns declared permissions into sentences, and diffs them', () => {
    expect(
      permissionLines({
        network: ['api.github.com'],
        fs: ['${pluginRoot}'],
        secrets: ['GH_TOKEN'],
        tools: { 'gh.merge': { action: 'write', default: 'ask' }, 'gh.read': { action: 'read' } },
        actionDefaults: { delete: 'deny', bogus: 7 },
        hooks: { answersAsks: true },
        browserExtensions: ['clipper'],
        ui: {
          connectDomains: ['api.github.com'],
          resourceDomains: ['cdn.example'],
          frameDomains: ['x.example'],
        },
        weird: true,
      }),
    ).toEqual([
      'Reach these hosts on the network: api.github.com',
      'Use files at: ${pluginRoot}',
      'Use these stored secrets: GH_TOKEN',
      'Tool gh.merge can change data; it asks you first',
      'Tool gh.read can read data',
      'Its tools that delete data: is blocked',
      'Its hooks may answer approval questions that your rules or tool defaults raise',
      'Asks to install browser extensions (each needs your consent): clipper',
      'Its app screens may connect to: api.github.com',
      'Its app screens may load files from: cdn.example',
      'Its app screens may embed pages from: x.example',
      'Also asks for: weird',
    ]);
    expect(permissionLines({})).toEqual(['No network access']);
    expect(
      permissionDiff({ network: ['a.example'] }, { network: ['a.example'], secrets: ['K'] }),
    ).toEqual({
      added: ['Use these stored secrets: K'],
      removed: [],
    });
    expect(permissionDiff({ network: ['a.example'] }, {})).toEqual({
      added: ['No network access'],
      removed: ['Reach these hosts on the network: a.example'],
    });
  });

  it('compares versions, counts components and finds the newest catalog entry', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
    expect(compareVersions('2.0.0', '2.0.0-beta.1')).toBe(1);
    expect(compareVersions('2.0.0-alpha', '2.0.0-beta')).toBe(-1);
    expect(compareVersions('2.0.0-beta', '2.0.0')).toBe(-1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('x.y', 'x.z')).toBe(-1);
    expect(
      componentsText({
        skills: 1,
        commands: 2,
        agents: 1,
        hooks: 0,
        mcpServers: 1,
        uiEntryPoints: 3,
      }),
    ).toBe('1 skill · 2 commands · 1 agent role · 1 MCP server · 3 app screens');
    expect(
      componentsText({
        skills: 0,
        commands: 0,
        agents: 0,
        hooks: 0,
        mcpServers: 0,
        uiEntryPoints: 0,
      }),
    ).toBe('No components');
    const newest = newestEntries([
      catalogEntry({ version: '1.0.0' }),
      catalogEntry({ version: '1.5.0', catalogId: 'other' }),
      catalogEntry({ version: '1.2.0' }),
    ]);
    expect(newest.get('com.example.tracker')?.version).toBe('1.5.0');
  });

  it('names hooks, hashes and durations in plain words', () => {
    expect(shortHash(HASH_A)).toBe('sha256:9f2c…41ab');
    expect(shortHash('abc')).toBe('abc');
    expect(formatSeconds(30)).toBe('30 s');
    expect(formatSeconds(90)).toBe('1 min 30 s');
    expect(formatSeconds(120)).toBe('2 min');
    expect(formatSeconds(3600)).toBe('1 h');
    expect(formatSeconds(3720)).toBe('1 h 2 min');
    expect(hookHandlerText(hook({ handler: { type: 'mcp_tool', tool: 'mcp:guard.check' } }))).toBe(
      'MCP tool mcp:guard.check',
    );
    expect(hookSourceText({ source: 'plugin', pluginId: 'p.x' })).toBe('Plugin p.x');
    expect(hookSourceText({ source: 'plugin', pluginId: null })).toBe('A plugin');
    expect(hookSourceText({ source: 'managed', pluginId: null })).toBe(
      'Managed by your organization',
    );
    expect(hookSourceText({ source: 'extension', pluginId: null })).toBe('An extension');
  });

  it('builds a skill and catalog ids, and validates skill fields', () => {
    expect(
      skillRequest({
        ...EMPTY_SKILL,
        name: ' review-pr ',
        description: ' Reviews a diff. ',
        allowedTools: 'fs.read, exec.run\nweb.search',
        body: '## Steps',
      }),
    ).toEqual({
      body: {
        name: 'review-pr',
        description: 'Reviews a diff.',
        body: '## Steps',
        allowedTools: ['fs.read', 'exec.run', 'web.search'],
      },
    });
    const bad = skillRequest({ ...EMPTY_SKILL, name: 'Bad Name', whenToUse: 'x'.repeat(1100) });
    expect('errors' in bad && Object.keys(bad.errors).sort()).toEqual(
      ['body', 'description', 'name', 'whenToUse'].sort(),
    );
    expect(catalogId('Team Catalog!', [])).toBe('team-catalog');
    expect(catalogId('Team Catalog', ['team-catalog'])).toBe('team-catalog-2');
    expect(catalogId('***', [])).toBe('catalog');
    expect(isCatalogLocation('/srv/catalog')).toBe(true);
    expect(isCatalogLocation('https://c.example')).toBe(true);
    expect(isCatalogLocation('http://c.example')).toBe(false);
    expect(isCatalogLocation('nope')).toBe(false);
    expect(manifestInfo({ id: 'a.b', author: 'not an object', version: 3 })).toEqual({
      id: 'a.b',
      name: 'a.b',
      version: null,
      description: null,
      author: null,
    });
  });
});

describe('Settings → Plugins & skills: plugins (FR-045)', () => {
  it('lists installed plugins and turns one off, reporting a failure', async () => {
    const hub = createHub({
      m4: m4State({
        plugins: [
          plugin(),
          plugin({
            id: 'com.example.local',
            name: 'Local helper',
            verified: false,
            status: 'error',
            error: 'Its MCP server did not start.',
            source: 'local',
            origin: '/home/me/plugins/helper',
          }),
        ],
      }),
    });
    await renderApp({ hub, path: '/settings/plugins' });
    const notes = await screen.findByRole('listitem', { name: 'Notes' });
    expect(within(notes).getByText('Ready')).toBeTruthy();
    expect(within(notes).getByText('Verified')).toBeTruthy();
    expect(within(notes).getByText(/2 skills · 1 hook · 1 MCP server · by Example/)).toBeTruthy();
    expect(
      within(notes).getByText('Reach these hosts on the network: api.example.com'),
    ).toBeTruthy();
    const local = screen.getByRole('listitem', { name: 'Local helper' });
    expect(within(local).getByText('Unverified')).toBeTruthy();
    expect(within(local).getByText('Its MCP server did not start.')).toBeTruthy();

    await userEvent.click(within(notes).getByRole('switch', { name: 'Turn on Notes' }));
    expect(
      await screen.findByText('Notes turned off. Its servers and hooks stopped.'),
    ).toBeTruthy();
    expect(hub.state.m4.plugins[0]?.enabled).toBe(false);
    expect(within(notes).getByText('Off')).toBeTruthy();

    hub.state.failNext.updatePlugin = fail('Hub busy');
    await userEvent.click(within(notes).getByRole('switch', { name: 'Turn on Notes' }));
    expect(await screen.findByText('Could not change Notes: Hub busy')).toBeTruthy();
  });

  it('uninstalls only after confirmation', async () => {
    const hub = createHub({ m4: m4State({ plugins: [plugin()] }) });
    await renderApp({ hub, path: '/settings/plugins' });
    const row = await screen.findByRole('listitem', { name: 'Notes' });
    await userEvent.click(within(row).getByRole('button', { name: 'Uninstall' }));
    const dialog = screen.getByRole('dialog', { name: 'Uninstall Notes?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(hub.api.uninstallPlugin).not.toHaveBeenCalled();
    await userEvent.click(within(row).getByRole('button', { name: 'Uninstall' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Uninstall Notes?' })).getByRole('button', {
        name: 'Uninstall',
      }),
    );
    expect(await screen.findByText('Notes uninstalled.')).toBeTruthy();
    expect(await screen.findByText('No plugins installed')).toBeTruthy();
  });

  it('installs from a catalog after a preview of permissions, hooks and servers', async () => {
    const hub = createHub({
      m4: m4State({
        catalogs: [
          {
            id: 'sample',
            name: 'Sample catalog',
            location: '/repo/examples/catalog',
            kind: 'local',
          },
        ],
        catalog: [catalogEntry(), catalogEntry({ pluginId: 'com.example.other', name: 'Other' })],
        pluginPreview: pluginPreview({
          hooks: [
            hook({ id: 'tracker-guard', source: 'plugin', contentHash: HASH_A }),
            hook({ id: 'tracker-log', source: 'plugin', event: 'tool.post', contentHash: HASH_B }),
          ],
        }),
      }),
    });
    await renderApp({ hub, path: '/settings/plugins' });
    expect(await screen.findByText(/Sample catalog \(folder on the Hub\)/)).toBeTruthy();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search plugins' }), 'oth');
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Tracker' })).toBeNull());
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search plugins' }));
    const entry = await screen.findByRole('listitem', { name: 'Tracker' });
    await userEvent.click(within(entry).getByRole('button', { name: 'Install Tracker' }));
    await waitFor(() =>
      expect(hub.api.previewPlugin).toHaveBeenCalledWith({
        kind: 'catalog',
        catalogId: 'sample',
        pluginId: 'com.example.tracker',
        version: '2.0.0',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Install Tracker 2.0.0?' });
    expect(within(dialog).getByText('Tracks issues.')).toBeTruthy();
    expect(within(dialog).getByText('By Example Labs.')).toBeTruthy();
    expect(
      within(dialog).getByText('Reach these hosts on the network: api.tracker.example'),
    ).toBeTruthy();
    expect(within(dialog).getByText('Use these stored secrets: TRACKER_TOKEN')).toBeTruthy();
    expect(
      within(dialog).getByText('Tool tracker.create can change data; it asks you first'),
    ).toBeTruthy();
    expect(within(dialog).getByText('node server.js')).toBeTruthy();
    expect(within(dialog).getByText('triage')).toBeTruthy();
    const guard = within(dialog).getByRole('listitem', { name: 'Hook tracker-guard' });
    expect(within(guard).getByText(/Before tool use/)).toBeTruthy();
    expect(within(guard).getByText('./scripts/check-branch.sh')).toBeTruthy();
    expect(within(guard).getByText(HASH_A)).toBeTruthy();
    // Nothing is installed by previewing.
    expect(hub.api.installPlugin).not.toHaveBeenCalled();
    await userEvent.click(within(guard).getByRole('checkbox', { name: 'Trust tracker-guard now' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(hub.api.installPlugin).toHaveBeenCalledWith({
        previewId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
        enable: true,
        trustHooks: [{ id: 'tracker-guard', contentHash: HASH_A }],
      }),
    );
    expect(await screen.findByText('Tracker 2.0.0 installed.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    const installed = await screen.findByRole('list', { name: 'Installed plugins' });
    expect(within(installed).getByRole('listitem', { name: 'Tracker' })).toBeTruthy();
  });

  it('offers an update with the permission diff', async () => {
    const hub = createHub({
      m4: m4State({
        plugins: [
          plugin({
            id: 'com.example.tracker',
            name: 'Tracker',
            version: '1.0.0',
            permissions: { network: ['api.tracker.example'] },
          }),
        ],
        catalog: [catalogEntry({ installedVersion: '1.0.0' })],
        pluginPreview: pluginPreview({ replaces: { version: '1.0.0' }, hooks: [] }),
      }),
    });
    await renderApp({ hub, path: '/settings/plugins' });
    const installed = await screen.findByRole('list', { name: 'Installed plugins' });
    const row = within(installed).getByRole('listitem', { name: 'Tracker' });
    await userEvent.click(
      await within(row).findByRole('button', { name: 'Update Tracker to 2.0.0' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Update Tracker 2.0.0?' });
    expect(within(dialog).getByText('Replaces version 1.0.0.')).toBeTruthy();
    expect(within(dialog).getByText('New: Use these stored secrets: TRACKER_TOKEN')).toBeTruthy();
    expect(
      within(dialog).getByText('New: Tool tracker.create can change data; it asks you first'),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Turn it on after updating' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Update' }));
    await waitFor(() =>
      expect(hub.api.installPlugin).toHaveBeenCalledWith({
        previewId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
        enable: false,
        trustHooks: [],
      }),
    );
    expect(await screen.findByText('Tracker 2.0.0 updated.')).toBeTruthy();
  });

  it('installs from a folder only after confirming an unverified plugin; errors stay in place', async () => {
    const hub = createHub({
      m4: m4State({
        pluginPreview: pluginPreview({ verified: false, warnings: ['No license file.'] }),
      }),
    });
    await renderApp({ hub, path: '/settings/plugins' });
    const folder = await screen.findByRole('textbox', { name: 'Plugin folder' });
    await userEvent.type(folder, 'plugins/tracker');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText(/Enter the full path of the plugin folder/)).toBeTruthy();
    expect(hub.api.previewPlugin).not.toHaveBeenCalled();

    await userEvent.clear(folder);
    await userEvent.type(folder, '/home/me/plugins/tracker');
    hub.state.failNext.previewPlugin = fail(
      'No .nova-plugin/plugin.json in that folder',
      400,
      'validation',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('No .nova-plugin/plugin.json in that folder')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(hub.api.previewPlugin).toHaveBeenLastCalledWith({
      kind: 'path',
      path: '/home/me/plugins/tracker',
    });
    const dialog = await screen.findByRole('dialog', { name: 'Install Tracker 2.0.0?' });
    expect(within(dialog).getByText('Unverified')).toBeTruthy();
    expect(within(dialog).getByText('No license file.')).toBeTruthy();
    const install = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Install' });
    expect(install.disabled).toBe(true);
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'I trust its source; install it unverified' }),
    );
    expect(install.disabled).toBe(false);
    hub.state.failNext.installPlugin = fail('Preview not found', 404, 'not_found');
    await userEvent.click(install);
    expect(await within(dialog).findByText(/This preview has expired/)).toBeTruthy();
    hub.state.failNext.installPlugin = fail('Disk full');
    await userEvent.click(install);
    expect(await within(dialog).findByText('Disk full')).toBeTruthy();
    await userEvent.click(install);
    expect(
      await screen.findByText('Tracker 2.0.0 installed. Some hooks still need your trust.'),
    ).toBeTruthy();
    expect(hub.api.installPlugin).toHaveBeenLastCalledWith(
      expect.objectContaining({ confirmSideload: true }),
    );
  });

  it('previews from a Git address and refuses a non-https one', async () => {
    const hub = createHub({ m4: m4State({ pluginPreview: pluginPreview() }) });
    await renderApp({ hub, path: '/settings/plugins' });
    await userEvent.selectOptions(
      await screen.findByRole('combobox', { name: 'Where the plugin is' }),
      'git',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Git address' }),
      'http://git.example/p.git',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(screen.getByText('Enter an https:// Git address.')).toBeTruthy();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Git address' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Git address' }),
      'https://git.example/p.git',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Branch, tag or commit (optional)' }),
      'v2',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(hub.api.previewPlugin).toHaveBeenCalledWith({
        kind: 'git',
        url: 'https://git.example/p.git',
        ref: 'v2',
      }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds and removes a catalog of your own', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/plugins' });
    await userEvent.click(await screen.findByText('Your catalogs'));
    await userEvent.type(screen.getByRole('textbox', { name: 'Catalog name' }), 'Team');
    await userEvent.type(screen.getByRole('textbox', { name: 'Catalog location' }), 'catalog');
    await userEvent.click(screen.getByRole('button', { name: 'Add catalog' }));
    expect(screen.getByText(/Enter a full folder path/)).toBeTruthy();
    await userEvent.clear(screen.getByRole('textbox', { name: 'Catalog location' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Catalog location' }),
      'https://c.example/team',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add catalog' }));
    expect(await screen.findByText('Team added.')).toBeTruthy();
    expect(hub.state.settings['plugins.catalogs']).toEqual([
      { id: 'team', name: 'Team', location: 'https://c.example/team' },
    ]);
    await userEvent.click(screen.getByRole('button', { name: 'Remove Team' }));
    expect(await screen.findByText('Team removed.')).toBeTruthy();
    expect(hub.state.settings['plugins.catalogs']).toEqual([]);
  });
});

describe('Settings → Plugins & skills: skills (FR-046)', () => {
  it('lists skills with source and shadowing, shows a body, and toggles', async () => {
    const hub = createHub({
      m4: m4State({
        skills: [
          skill({
            name: 'review',
            source: 'user',
            body: '## Review steps',
            whenToUse: 'Before a merge.',
            files: ['scripts/diff.sh'],
          }),
          skill({
            id: 'skill:com.example.notes:review',
            name: 'review',
            source: 'plugin',
            pluginId: 'com.example.notes',
            shadowedBy: 'skill:user:review',
          }),
        ],
      }),
    });
    await renderApp({ hub, path: '/settings/plugins' });
    const list = await screen.findByRole('list', { name: 'Skills' });
    const rows = within(list).getAllByRole('listitem');
    expect(
      within(rows[1]!).getByText(/Shadowed by review \(yours\); this one is not used/),
    ).toBeTruthy();
    expect(within(rows[1]!).queryByRole('button', { name: 'Delete review' })).toBeNull();
    expect(within(rows[0]!).getByRole('button', { name: 'Delete review' })).toBeTruthy();

    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'View review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Skill review' });
    expect(await within(dialog).findByText('## Review steps')).toBeTruthy();
    expect(within(dialog).getByText('Before a merge.')).toBeTruthy();
    expect(within(dialog).getByText('scripts/diff.sh')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    hub.state.failNext.updateSkill = fail('Locked');
    await userEvent.click(within(rows[0]!).getByRole('switch', { name: 'Use review' }));
    expect(await screen.findByText('Could not change review: Locked')).toBeTruthy();
    await userEvent.click(within(rows[0]!).getByRole('switch', { name: 'Use review' }));
    await waitFor(() => expect(hub.state.m4.skills[0]?.enabled).toBe(false));
  });

  it('creates a user skill after field checks, and deletes it after confirmation', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/plugins' });
    expect(await screen.findByText('No skills yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'New skill' }));
    const dialog = screen.getByRole('dialog', { name: 'New skill' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Bad');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create skill' }));
    expect(within(dialog).getByText(/Use 1 to 64 lowercase/)).toBeTruthy();
    expect(within(dialog).getByText('Write the instructions the skill gives.')).toBeTruthy();
    expect(hub.api.createSkill).not.toHaveBeenCalled();
    await userEvent.clear(within(dialog).getByRole('textbox', { name: 'Name' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'standup');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Description' }),
      'Write my standup.',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Instructions' }),
      'List what I did.',
    );
    hub.state.failNext.createSkill = fail('A skill named standup exists', 409, 'conflict');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create skill' }));
    expect(await within(dialog).findByText('A skill named standup exists')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create skill' }));
    expect(await screen.findByText('Skill standup created. Use it with /standup.')).toBeTruthy();
    expect(hub.api.createSkill).toHaveBeenLastCalledWith({
      name: 'standup',
      description: 'Write my standup.',
      body: 'List what I did.',
    });
    const row = await screen.findByRole('listitem', { name: 'standup' });
    await userEvent.click(within(row).getByRole('button', { name: 'Delete standup' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete the skill standup?' })).getByRole(
        'button',
        {
          name: 'Delete',
        },
      ),
    );
    expect(await screen.findByText('Skill standup deleted.')).toBeTruthy();
    expect(hub.state.m4.skills).toEqual([]);
  });
});

describe('Settings → Plugins & skills: hooks (FR-197, docs/04 §2.10)', () => {
  it('trusts a hook by the hash shown, and re-reviews it when it changed (409)', async () => {
    const hub = createHub({
      m4: m4State({ hooks: [hook({ id: 'check-branch', contentHash: HASH_A })] }),
    });
    await renderApp({ hub, path: '/settings/plugins' });
    const row = await screen.findByRole('listitem', { name: 'check-branch' });
    expect(within(row).getByText('Needs trust')).toBeTruthy();
    expect(within(row).getByText('A project hook file')).toBeTruthy();
    expect(within(row).getByText('Hash sha256:9f2c…41ab')).toBeTruthy();
    expect(within(row).getByText('Not run yet')).toBeTruthy();
    // No switch: only hooks from your own hooks file can be turned off here.
    expect(within(row).queryByRole('switch')).toBeNull();

    // The hook changes on disk after the list loaded.
    hub.state.m4.hooks = [hook({ id: 'check-branch', contentHash: HASH_B, matcher: 'exec.*' })];
    await userEvent.click(within(row).getByRole('button', { name: 'Trust check-branch' }));
    const dialog = screen.getByRole('dialog', { name: 'Trust this hook?' });
    expect(within(dialog).getByTestId('trust-hash').textContent).toBe(HASH_A);
    expect(within(dialog).getByText('block this tool call, add context')).toBeTruthy();
    expect(within(dialog).getByText(/override built-in safety/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Trust' }));
    expect(await within(dialog).findByText(/This hook changed since it was shown/)).toBeTruthy();
    expect(hub.api.trustHook).toHaveBeenCalledWith('check-branch', HASH_A);
    expect(within(dialog).getByTestId('trust-hash').textContent).toBe(HASH_B);
    expect(hub.state.m4.hooks[0]?.status).toBe('needs_trust');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Trust' }));
    expect(await screen.findByText('check-branch is trusted. It runs from now on.')).toBeTruthy();
    expect(hub.api.trustHook).toHaveBeenLastCalledWith('check-branch', HASH_B);
    const trusted = screen.getByRole('listitem', { name: 'check-branch' });
    expect(within(trusted).getByText('Trusted')).toBeTruthy();

    await userEvent.click(within(trusted).getByRole('button', { name: 'Untrust check-branch' }));
    expect(
      await screen.findByText('Trust for check-branch revoked. It stopped at once.'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('listitem', { name: 'check-branch' })).getByText('Trust revoked'),
    ).toBeTruthy();
  });

  it('keeps a hook disabled, reports a trust failure, and toggles a user hook', async () => {
    const hub = createHub({
      m4: m4State({
        hooks: [
          hook({
            id: 'mine',
            source: 'user',
            status: 'trusted',
            lastRun: { at: '2026-10-01T12:00:00.000Z', effect: 'blocked' },
          }),
          hook({ id: 'org', source: 'managed', status: 'trusted' }),
          hook({ id: 'other' }),
        ],
      }),
    });
    await renderApp({ hub, path: '/settings/plugins' });
    const org = await screen.findByRole('listitem', { name: 'org' });
    expect(within(org).getByText('Trusted by your organization')).toBeTruthy();
    expect(within(org).queryByRole('button', { name: /trust/i })).toBeNull();
    const mine = screen.getByRole('listitem', { name: 'mine' });
    expect(within(mine).getByText(/Last run .*: blocked/)).toBeTruthy();
    await userEvent.click(within(mine).getByRole('switch', { name: 'Turn on mine' }));
    await waitFor(() => expect(hub.state.m4.hooks[0]?.enabled).toBe(false));
    hub.state.failNext.updateHook = fail('Hooks file is read-only');
    await userEvent.click(within(mine).getByRole('switch', { name: 'Turn on mine' }));
    expect(await screen.findByText('Could not change mine: Hooks file is read-only')).toBeTruthy();

    const other = screen.getByRole('listitem', { name: 'other' });
    await userEvent.click(within(other).getByRole('button', { name: 'Trust other' }));
    let dialog = screen.getByRole('dialog', { name: 'Trust this hook?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep disabled' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(hub.api.trustHook).not.toHaveBeenCalled();
    hub.state.failNext.trustHook = fail('Hub busy');
    await userEvent.click(within(other).getByRole('button', { name: 'Trust other' }));
    dialog = screen.getByRole('dialog', { name: 'Trust this hook?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Trust' }));
    expect(await within(dialog).findByText('Hub busy')).toBeTruthy();
  });

  it('shows a load failure with retry', async () => {
    const hub = createHub({ m4: m4State({ hooks: [hook({ id: 'later' })] }) });
    hub.state.failNext.listHooks = fail('Hooks unavailable');
    await renderApp({ hub, path: '/settings/plugins' });
    expect(await screen.findByText('Hooks unavailable')).toBeTruthy();
    const section = screen.getByRole('region', { name: 'Hooks' });
    await userEvent.click(within(section).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('listitem', { name: 'later' })).toBeTruthy();
  });
});
