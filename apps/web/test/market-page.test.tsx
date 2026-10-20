// The marketplace (FR-049; docs/14 §5, docs/08 §7, docs/26 §3): tabs by kind with search; cards with
// author, version, Verified or Unverified and permissions; details with screenshots, changelog, what
// a plugin brings and a local rating; install of a verified item, the sideload confirmation for an
// Unverified one, the permission diff of an update accepted by its hash; refusals in plain words;
// managed policy and the owner's install rules said plainly; remove after a confirmation; the
// demo's third-party theme and plugin installable; a member's owner-only notice.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketplacePage } from '../src/market/MarketplacePage.tsx';
import { useLocation } from '../src/router.ts';
import { FakeEventSource } from './fakes.ts';
import { fakeFingerprint } from './fakes-m8-extensions.ts';
import {
  SAMPLE_KEY,
  item,
  pet,
  renderWithMarket,
  sampleItems,
  type FakeItem,
} from './fakes-m8-market.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

/** The page as the shell routes it: /marketplace and /marketplace/<tab>. */
function Routed() {
  const loc = useLocation();
  const tab = /^\/marketplace\/([^/?]+)/.exec(loc)?.[1] ?? null;
  return <MarketplacePage tab={tab} />;
}

const card = (name: string) => screen.getByRole('listitem', { name });

const loose: FakeItem = {
  detail: item({
    catalogId: 'loose',
    kind: 'plugin',
    id: 'com.test.notes',
    name: 'Notes',
    author: 'Someone',
    publisher: null,
    verified: false,
    permissions: [],
  }),
  reasons: ['catalog_unsigned'],
  details: {
    hooks: [
      {
        id: 'hook:com.test.notes.guard',
        event: 'tool.pre',
        matcher: 'fs.write',
        handler: { type: 'command', command: ['node', 'guard.mjs'] },
        timeoutMs: 5000,
        contentHash: `sha256:${'4'.repeat(64)}`,
      },
    ],
    mcpServers: [],
    skills: [],
    roles: [],
    uiEntryPoints: [],
  },
};

const LOOSE_CATALOG = {
  'plugins.catalogs': [{ id: 'loose', name: 'Loose folder', location: '/srv/loose' }],
};

describe('browsing', () => {
  it('shows each kind in its tab with search, cards and details', async () => {
    window.history.replaceState(null, '', '/marketplace');
    const { market } = await renderWithMarket(<Routed />);
    const plugins = await screen.findByRole('list', { name: 'Plugins' });
    expect(plugins.querySelectorAll(':scope > li')).toHaveLength(3);
    const rn = card('Release notes');
    expect(within(rn).getByText('Verified')).toBeTruthy();
    expect(within(rn).getByText('By Example Labs')).toBeTruthy();
    expect(within(rn).getByText('Use files in ${project}')).toBeTruthy();
    expect(within(rn).getByText('Not rated')).toBeTruthy();
    expect(within(rn).getByRole('img', { name: 'Screenshot 1 of Release notes' })).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Search the marketplace'), 'word');
    await waitFor(() =>
      expect(market.searchMarket).toHaveBeenLastCalledWith({ q: 'word', kind: 'plugin' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'Release notes' })).toBeNull(),
    );
    expect(card('Word count')).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: 'Themes' }));
    expect(window.location.pathname).toBe('/marketplace/themes');
    await waitFor(() =>
      expect(market.searchMarket).toHaveBeenLastCalledWith({ q: 'word', kind: 'theme' }),
    );
    await userEvent.clear(screen.getByLabelText('Search the marketplace'));
    expect(await screen.findByRole('listitem', { name: 'Aurora' })).toBeTruthy();
    expect(screen.getByText(/An installed theme is kept in Settings → Appearance/)).toBeTruthy();

    await userEvent.click(screen.getByRole('tab', { name: 'MCP servers' }));
    expect(
      await screen.findByRole('heading', { name: 'No MCP servers in your catalogs yet.' }),
    ).toBeTruthy();
  });

  it('shows an item’s details: screenshots, changelog, what it brings and a local rating', async () => {
    window.history.replaceState(null, '', '/marketplace');
    const { market } = await renderWithMarket(<Routed />);
    await userEvent.click(await screen.findByRole('button', { name: 'Details of Sample plugin' }));
    let dialog = await screen.findByRole('dialog', { name: 'Sample plugin' });
    expect(await within(dialog).findByText('What it brings')).toBeTruthy();
    expect(dialog.textContent).toContain('hook:com.example.sample.check-fetch: Before tool use');
    expect(dialog.textContent).toContain('Sample panel (in Apps), Sample panel (beside a chat)');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    await userEvent.click(screen.getByRole('button', { name: 'Details of Release notes' }));
    dialog = await screen.findByRole('dialog', { name: 'Release notes' });
    const shot = await within(dialog).findByRole('img', { name: 'Screenshot 1 of Release notes' });
    expect(shot.getAttribute('src')).toBe(
      '/api/v1/market/items/nova-sample/plugin/com.examplelabs.release-notes/screenshots/0',
    );
    expect(dialog.textContent).toContain('1.0.0 (2026-10-01): First release.');
    expect(
      within(dialog)
        .getByRole('link', { name: /examplelabs\.example/ })
        .getAttribute('rel'),
    ).toBe('noopener noreferrer');
    expect(dialog.textContent).toContain('Ratings stay on this Hub. Nothing is sent anywhere.');
    await userEvent.click(within(dialog).getByRole('radio', { name: '4 stars' }));
    await userEvent.type(within(dialog).getByLabelText('Notes (optional)'), 'Handy');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save rating' }));
    expect(market.rateMarketItem).toHaveBeenCalledWith({
      kind: 'plugin',
      itemId: 'com.examplelabs.release-notes',
      stars: 4,
      review: 'Handy',
    });
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Clear rating' }));
    expect(market.unrateMarketItem).toHaveBeenCalledWith('plugin', 'com.examplelabs.release-notes');
  });
});

describe('installing', () => {
  it('installs the demo’s third-party plugin and theme Verified', async () => {
    window.history.replaceState(null, '', '/marketplace');
    const { market, hub } = await renderWithMarket(<Routed />);
    await userEvent.click(await screen.findByRole('button', { name: 'Install Release notes' }));
    let dialog = await screen.findByRole('dialog', { name: 'Install Release notes 1.0.0?' });
    expect(within(dialog).getByText('Verified')).toBeTruthy();
    // The sample catalog pins its key: the dialog says what vouches, not a bare key (J10 #6).
    expect(dialog.textContent).toContain(
      `Verified: listed in Sample catalog, signed with the key this catalog pins (${fakeFingerprint(SAMPLE_KEY)}).`,
    );
    expect(dialog.textContent).not.toContain('Its bundle is signed');
    expect(within(dialog).getByRole('list', { name: 'It can' }).textContent).toContain(
      'Its tools that change data ask you first',
    );
    expect(dialog.textContent).toContain('release-notes: Draft release notes.');
    expect(within(dialog).queryByRole('checkbox', { name: /I trust its source/ })).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect(market.installMarketItem).toHaveBeenCalledWith(
      expect.not.objectContaining({ confirmSideload: expect.anything() }),
    );
    expect((await screen.findAllByText('Release notes installed.')).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(within(card('Release notes')).getByText('Installed: 1.0.0')).toBeTruthy(),
    );

    await userEvent.click(screen.getByRole('tab', { name: 'Themes' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Install Aurora' }));
    dialog = await screen.findByRole('dialog', { name: 'Install Aurora 1.0.0?' });
    expect(within(dialog).getByText('Aurora')).toBeTruthy();
    expect(
      within(dialog).queryByRole('checkbox', { name: 'Turn it on after installing' }),
    ).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(hub.state.settings['appearance.customThemes']).toEqual([
        expect.objectContaining({ id: 'com.examplelabs.aurora' }),
      ]),
    );
  });

  it('installs an Unverified item only after the sideload confirmation, trusting a ticked hook', async () => {
    window.history.replaceState(null, '', '/marketplace');
    const { market } = await renderWithMarket(<Routed />, {
      settings: LOOSE_CATALOG,
      market: {
        catalogStates: { loose: { signature: 'unsigned' } },
        items: [...sampleItems(), loose],
      },
    });
    await userEvent.type(screen.getByLabelText('Search the marketplace'), 'Notes');
    await userEvent.click(await screen.findByRole('button', { name: 'Install Notes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Notes 1.0.0?' });
    expect(within(dialog).getByText('Unverified')).toBeTruthy();
    expect(within(dialog).getByRole('list', { name: 'Why it is Unverified' }).textContent).toBe(
      'Its catalog is not signed.',
    );
    const install = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Install' });
    expect(install.disabled).toBe(true);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /I trust its source/ }));
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Trust hook:com.test.notes.guard now' }),
    );
    expect(install.disabled).toBe(false);
    await userEvent.click(install);
    expect(market.installMarketItem).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmSideload: true,
        enable: true,
        trustHooks: [{ id: 'hook:com.test.notes.guard', contentHash: `sha256:${'4'.repeat(64)}` }],
      }),
    );
    expect(await screen.findByText('Installed: 1.0.0')).toBeTruthy();
  });

  it('shows an update’s permission diff, which must be accepted', async () => {
    window.history.replaceState(null, '', '/marketplace');
    const v2: FakeItem = {
      detail: item({
        kind: 'plugin',
        id: 'com.examplelabs.release-notes',
        name: 'Release notes',
        version: '2.0.0',
        permissions: [],
      }),
      own: [
        { key: 'fs:${project}', kind: 'fs', text: 'Use files in ${project}', detail: null },
        {
          key: 'net:api.github.com',
          kind: 'network',
          text: 'Reach api.github.com on the network',
          detail: null,
        },
        {
          key: 'action:write',
          kind: 'action_default',
          text: 'Its tools that change data',
          detail: 'allow',
        },
      ],
      details: {},
    };
    const { market } = await renderWithMarket(<Routed />, {
      market: {
        items: [...sampleItems(), v2],
        installed: [
          {
            kind: 'plugin',
            itemId: 'com.examplelabs.release-notes',
            name: 'Release notes',
            version: '1.0.0',
            catalogId: 'nova-sample',
            origin: 'nova-sample/com.examplelabs.release-notes@1.0.0',
            verified: true,
            publisherKey: null,
            sha256: null,
            commit: null,
            permissions: [
              { key: 'fs:${project}', kind: 'fs', text: 'Use files in ${project}', detail: null },
              {
                key: 'action:write',
                kind: 'action_default',
                text: 'Its tools that change data',
                detail: 'ask',
              },
              { key: 'secret:token', kind: 'secret', text: 'Read the secret token', detail: null },
            ],
            installedAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Update Release notes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Update Release notes to 2.0.0?' });
    const diff = within(dialog).getByRole('heading', { name: 'Permission changes' }).parentElement!;
    expect(diff.textContent).toContain('New: Reach api.github.com on the network');
    // Worded, never raw: a looser default stands out as sensitive.
    const changed = within(diff).getByText('Its tools that change data', {
      exact: false,
    }).parentElement!;
    expect(changed.getAttribute('data-sensitive')).toBe('true');
    expect(changed.textContent).toContain('Sensitive');
    expect(
      within(changed).getByText('By default it: asks you first → runs without asking').tagName,
    ).toBe('STRONG');
    expect(diff.textContent).toContain('No longer: Read the secret token');
    expect(dialog.textContent).toContain('Replaces version 1.0.0.');
    const update = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Update' });
    expect(update.disabled).toBe(true);
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'I accept these permission changes' }),
    );
    await userEvent.click(update);
    expect(market.installMarketItem).toHaveBeenCalledWith(
      expect.objectContaining({ acceptPermissions: expect.stringMatching(/^diff-/) }),
    );
    expect((await screen.findAllByText('Release notes updated.')).length).toBeGreaterThan(0);
  });

  it('says why something cannot be installed, in plain words', async () => {
    window.history.replaceState(null, '', '/marketplace');
    const { state, market } = await renderWithMarket(<Routed />, {
      settings: {
        'plugins.catalogs': [
          { id: 'bad', name: 'Tampered', location: '/srv/bad' },
          { id: 'loose', name: 'Loose folder', location: '/srv/loose' },
        ],
      },
      market: {
        catalogStates: { bad: { signature: 'invalid' }, loose: { signature: 'unsigned' } },
        installers: ['plugin', 'skill', 'theme', 'pet'],
        items: [
          ...sampleItems(),
          // A tampered catalog lists nothing.
          {
            ...loose,
            detail: { ...loose.detail, catalogId: 'bad', id: 'com.bad.one', name: 'Bad one' },
          },
          // A bundle that does not match its signature is refused at the preview.
          { ...loose, bundleInvalid: true },
          { detail: item({ kind: 'mcp', id: 'weather', name: 'Weather server' }) },
        ],
      },
    });
    await screen.findByRole('listitem', { name: 'Release notes' });
    expect(screen.queryByRole('listitem', { name: 'Bad one' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Install Notes' }));
    let dialog = await screen.findByRole('dialog', { name: 'Install Notes' });
    expect(await within(dialog).findByText(/its files do not match its signature/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(screen.getByRole('tab', { name: 'MCP servers' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Install Weather server' }));
    dialog = await screen.findByRole('dialog', { name: 'Install Weather server' });
    expect(
      await within(dialog).findByText('This Hub cannot install MCP servers yet.'),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // A preview that expired before Install.
    await userEvent.click(screen.getByRole('tab', { name: 'Plugins' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Install Release notes' }));
    dialog = await screen.findByRole('dialog', { name: 'Install Release notes 1.0.0?' });
    state.previews.clear();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect(
      await within(dialog).findByText('This preview expired. Open the item again.'),
    ).toBeTruthy();
    expect(market.installMarketItem).toHaveBeenCalledTimes(1);
  });
});

describe('policy and install rules', () => {
  it('says plainly when the organization forbids Unverified items, with the policy’s source', async () => {
    window.history.replaceState(null, '', '/marketplace');
    await renderWithMarket(<Routed />, {
      settings: LOOSE_CATALOG,
      managed: {
        'managed.restrict': { layers: [{ unverifiedInstalls: false }], failClosed: null },
      },
      market: {
        catalogStates: { loose: { signature: 'unsigned' } },
        items: [...sampleItems(), loose],
      },
      policy: {
        active: true,
        failClosed: null,
        sources: [
          {
            channel: 'local',
            location: '/etc/nova/managed-settings.json',
            status: 'active',
            problem: null,
            inForce: true,
            cached: false,
            serial: 3,
            loadedAt: '2026-10-19T08:00:00.000Z',
            checkedAt: '2026-10-19T09:00:00.000Z',
          },
        ],
        settings: [],
        restrict: [{ channel: 'local', restrict: { unverifiedInstalls: false } }],
        egress: null,
        ignored: [],
        checkedAt: '2026-10-19T09:00:00.000Z',
      },
    });
    expect((await screen.findByText('(policy file)')).parentElement!.textContent).toBe(
      'Managed by your organization(policy file)',
    );
    expect(screen.getByText(/Unverified items cannot be installed/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Search the marketplace'), 'Notes');
    await userEvent.click(await screen.findByRole('button', { name: 'Install Notes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Install Notes 1.0.0?' });
    expect(dialog.textContent).toContain(
      'This cannot be installed. Your organization does not allow installing this.',
    );
    expect(within(dialog).queryByRole('checkbox', { name: /I trust its source/ })).toBeNull();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Install' }).disabled,
    ).toBe(true);
  });

  it('a kind turned off is said in its tab, and its items cannot be installed', async () => {
    window.history.replaceState(null, '', '/marketplace/themes');
    await renderWithMarket(<Routed />, {
      settings: { 'market.allowedKinds': ['plugin', 'skill', 'pet', 'mcp'] },
    });
    expect(await screen.findByText('Installing themes is turned off.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Install Aurora' }).disabled).toBe(
      true,
    );
  });
});

describe('installed items', () => {
  it('lists what is installed and removes after a confirmation; a removed companion pet turns it off', async () => {
    window.history.replaceState(null, '', '/marketplace/installed');
    const p = pet();
    const { market, hub } = await renderWithMarket(<Routed />, {
      settings: { 'appearance.pet': 'market:com.examplelabs.pebble' },
      market: {
        pets: [p],
        installed: [
          {
            kind: 'pet',
            itemId: p.id,
            name: 'Pebble',
            version: '1.0.0',
            catalogId: 'nova-sample',
            origin: 'nova-sample/com.examplelabs.pebble@1.0.0',
            verified: true,
            publisherKey: null,
            sha256: null,
            commit: null,
            permissions: [],
            installedAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      },
    });
    const row = await screen.findByRole('listitem', { name: 'Pebble' });
    expect(row.textContent).toContain('From nova-sample/com.examplelabs.pebble@1.0.0');
    await userEvent.click(within(row).getByRole('button', { name: 'Remove Pebble' }));
    let dialog = screen.getByRole('dialog', { name: 'Remove Pebble?' });
    expect(dialog.textContent).toContain('If it is your companion, the companion turns off.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(market.removeMarketItem).not.toHaveBeenCalled();
    await userEvent.click(within(row).getByRole('button', { name: 'Remove Pebble' }));
    dialog = screen.getByRole('dialog', { name: 'Remove Pebble?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(market.removeMarketItem).toHaveBeenCalledWith('pet', 'com.examplelabs.pebble');
    await waitFor(() => expect(hub.state.settings['appearance.pet']).toBe('off'));
    expect(
      await screen.findByRole('heading', {
        name: 'Nothing is installed from the marketplace yet.',
      }),
    ).toBeTruthy();
  });

  it('follows the marketplace events', async () => {
    window.history.replaceState(null, '', '/marketplace/installed');
    const { state } = await renderWithMarket(<Routed />);
    await screen.findByRole('heading', { name: 'Nothing is installed from the marketplace yet.' });
    state.installed.push({
      kind: 'skill',
      itemId: 'standup',
      name: 'Stand-up update',
      version: '1.0.0',
      catalogId: 'nova-sample',
      origin: 'nova-sample/standup@1.0.0',
      verified: true,
      publisherKey: null,
      sha256: null,
      commit: null,
      permissions: [],
      installedAt: '2026-10-19T09:00:00.000Z',
      updatedAt: '2026-10-19T09:00:00.000Z',
    });
    FakeEventSource.for('/api/v1/events/stream').emit('market.installed', {
      kind: 'skill',
      itemId: 'standup',
      version: '1.0.0',
      verified: true,
      catalogId: 'nova-sample',
    });
    expect(await screen.findByRole('listitem', { name: 'Stand-up update' })).toBeTruthy();
  });
});

describe('members', () => {
  it('shows a member the owner-only notice', async () => {
    window.history.replaceState(null, '', '/marketplace');
    await renderWithMarket(<Routed />, { member: true });
    expect(await screen.findByText('Only the owner of this Hub can change this.')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Plugins' })).toBeNull();
  });
});
