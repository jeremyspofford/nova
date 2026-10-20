// The marketplace in the pseudo-locale (FR-016): every word of /marketplace (tabs, search, cards,
// details, ratings), the install and update dialogs (what an item can do, hooks, the permission
// diff, Unverified and the sideload confirmation), the Catalogs tab (catalogs, trusted publishers,
// install rules) and the Installed tab comes from messages; and the page in Arabic, right to left.
// Item names, descriptions, authors, catalog names, the permission lines the catalog lists and the
// Hub's own words are data.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { MarketplacePage } from '../src/market/MarketplacePage.tsx';
import { INSTALL_TEXT, TAB_LABEL, MARKET_TEXT, REMOVE_BODY_TEXT } from '../src/market/format.ts';
import { fakeFingerprint } from './fakes-m8-extensions.ts';
import {
  EXAMPLE_LABS_KEY,
  SAMPLE_KEY,
  item,
  renderWithMarket,
  sampleItems,
  type FakeItem,
} from './fakes-m8-market.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

/** What the sample catalog says about its items (names, descriptions, authors, lines). */
const CATALOG_DATA = [
  'Sample catalog',
  'Release notes',
  'Sample plugin',
  'Word count',
  'Stand-up update',
  'Aurora',
  'Example Labs',
  'Nova examples',
  'Drafts release notes and a changelog entry from the changes in your project.',
  'A skill, a slash command, a hook, an MCP server and an MCP App panel.',
  'Counts the words, sentences and reading time of a text: a tool and a command.',
  'Turns what you did, plan and are blocked on into a short stand-up update.',
  'A deep blue dark theme with a mint accent.',
  'Use files in ${project}',
  'Reach api.example.com on the network',
  'Sample panel',
  'First release.',
  'Writing',
  'Developer tools',
  'Extensions',
  'Dark',
  // Key fingerprints in the publisher lines.
  fakeFingerprint(SAMPLE_KEY),
  fakeFingerprint(EXAMPLE_LABS_KEY),
];

describe('the marketplace in en-XA', () => {
  it('shows the tabs, search and the plugin cards', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/marketplace');
    await renderWithMarket(<MarketplacePage tab={null} />);
    await screen.findByRole('listitem', { name: 'Release notes' });
    expect(screen.getByRole('tab', { name: TAB_LABEL.plugins })).toBeTruthy();
    expectFullyLocalized(document.body, { data: CATALOG_DATA });
  });

  it('shows the other kinds’ tabs', async () => {
    await activateTestLocale('en-XA');
    for (const tab of ['skills', 'themes', 'pets', 'mcp']) {
      window.history.replaceState(null, '', `/marketplace/${tab}`);
      const r = await renderWithMarket(<MarketplacePage tab={tab} />);
      await waitFor(() => expect(screen.queryByText(MARKET_TEXT.loading)).toBeNull());
      expectFullyLocalized(document.body, { data: CATALOG_DATA });
      r.unmount();
    }
  });

  it('shows an item’s details and rating', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/marketplace');
    await renderWithMarket(<MarketplacePage tab={null} />);
    await userEvent.click(
      await screen.findByRole('button', { name: MARKET_TEXT.detailsOf({ name: 'Sample plugin' }) }),
    );
    let dialog = await screen.findByRole('dialog', { name: 'Sample plugin' });
    await within(dialog).findByText(MARKET_TEXT.brings);
    expectFullyLocalized(dialog, {
      data: [
        ...CATALOG_DATA,
        'hook:com.example.sample.check-fetch',
        'greet',
        'Say hello.',
        'sample',
      ],
    });
    await userEvent.click(within(dialog).getByRole('button', { name: MARKET_TEXT.close }));
    await userEvent.click(
      screen.getByRole('button', { name: MARKET_TEXT.detailsOf({ name: 'Release notes' }) }),
    );
    dialog = await screen.findByRole('dialog', { name: 'Release notes' });
    await within(dialog).findAllByText(MARKET_TEXT.rating);
    expectFullyLocalized(dialog, {
      data: [...CATALOG_DATA, 'release-notes', 'Draft release notes.'],
    });
  });

  it('shows the install dialog of an Unverified item with a hook', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/marketplace');
    const loose: FakeItem = {
      detail: item({
        catalogId: 'loose',
        kind: 'plugin',
        id: 'com.test.notes',
        name: 'Notes',
        author: null,
        publisher: null,
        verified: false,
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
    await renderWithMarket(<MarketplacePage tab={null} />, {
      settings: {
        'plugins.catalogs': [{ id: 'loose', name: 'Loose folder', location: '/srv/loose' }],
      },
      market: {
        catalogStates: { loose: { signature: 'unsigned' } },
        items: [...sampleItems(), loose],
      },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: MARKET_TEXT.installOf({ name: 'Notes' }) }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: INSTALL_TEXT.install({ name: 'Notes', version: '1.0.0' }),
    });
    expectFullyLocalized(dialog, {
      data: [...CATALOG_DATA, 'Notes', 'Loose folder', 'fs.write', 'node guard.mjs'],
    });
  });

  it('shows an update’s permission diff', async () => {
    await activateTestLocale('en-XA');
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
    await renderWithMarket(<MarketplacePage tab={null} />, {
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
    await userEvent.click(
      await screen.findByRole('button', { name: MARKET_TEXT.updateOf({ name: 'Release notes' }) }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: INSTALL_TEXT.update({ name: 'Release notes', version: '2.0.0' }),
    });
    expectFullyLocalized(dialog, {
      data: [
        ...CATALOG_DATA,
        'Reach api.github.com on the network',
        'Its tools that change data',
        'Read the secret token',
      ],
    });
  });

  it('shows the Catalogs tab and the Installed tab', async () => {
    await activateTestLocale('en-XA');
    window.history.replaceState(null, '', '/marketplace/catalogs');
    const r = await renderWithMarket(<MarketplacePage tab="catalogs" />, {
      settings: {
        'plugins.catalogs': [{ id: 'loose', name: 'Loose folder', location: '/srv/loose' }],
        'plugins.trustedPublishers': [{ name: 'Example Labs', key: EXAMPLE_LABS_KEY }],
      },
      market: { catalogStates: { loose: { signature: 'unsigned' } } },
    });
    await screen.findByText('Loose folder');
    expectFullyLocalized(document.body, {
      data: [...CATALOG_DATA, 'Loose folder', '/srv/loose'],
    });
    r.unmount();
    window.history.replaceState(null, '', '/marketplace/installed');
    await renderWithMarket(<MarketplacePage tab="installed" />, {
      market: {
        installed: [
          {
            kind: 'theme',
            itemId: 'com.examplelabs.aurora',
            name: 'Aurora',
            version: '1.0.0',
            catalogId: 'nova-sample',
            origin: 'nova-sample/com.examplelabs.aurora@1.0.0',
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
    const row = await screen.findByRole('listitem', { name: 'Aurora' });
    // Where it was installed from: catalog/id@version.
    expectFullyLocalized(document.body, {
      data: [...CATALOG_DATA, 'nova-sample/com.examplelabs.aurora@1.0.0'],
    });
    await userEvent.click(
      within(row).getByRole('button', { name: MARKET_TEXT.removeOf({ name: 'Aurora' }) }),
    );
    const dialog = screen.getByRole('dialog', {
      name: MARKET_TEXT.removeTitle({ name: 'Aurora' }),
    });
    expect(dialog.textContent).toContain(REMOVE_BODY_TEXT.theme);
    expectFullyLocalized(dialog, { data: CATALOG_DATA });
  });
});

describe('the marketplace in Arabic', () => {
  it('shows the page in Arabic, right to left', async () => {
    await activateTestLocale('ar');
    window.history.replaceState(null, '', '/marketplace');
    await renderWithMarket(<MarketplacePage tab={null} />);
    await screen.findByRole('listitem', { name: 'Release notes' });
    expect(document.documentElement.dir).toBe('rtl');
    expect(MARKET_TEXT.title).toBe('المتجر');
    expect(screen.getByRole('tab', { name: 'المكوّنات الإضافية' })).toBeTruthy();
    expect(screen.getByLabelText('البحث في المتجر')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: MARKET_TEXT.detailsOf({ name: 'Release notes' }) }),
    ).toBeTruthy();
    expect(MARKET_TEXT.detailsOf({ name: 'Release notes' })).toBe('تفاصيل Release notes');
  });
});
