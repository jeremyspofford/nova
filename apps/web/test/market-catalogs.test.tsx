// The marketplace's Catalogs tab (FR-049; docs/14 §5 and §7, docs/08 §7): catalogs with their kind,
// signature state, key, commit and items, or why they were refused; adding a folder, web or Git
// catalog with a pinned key and commit (checked before saving); trusted publishers (adding one is
// confirmed); the install rules; managed locks with their source.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { MarketplacePage } from '../src/market/MarketplacePage.tsx';
import { PUBLISHER_KEY } from './fakes-m8-extensions.ts';
import { renderWithMarket } from './fakes-m8-market.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

describe('catalogs', () => {
  it('lists each catalog with its kind, signature state, commit and why it was refused', async () => {
    await renderWithMarket(<MarketplacePage tab="catalogs" />, {
      settings: {
        'plugins.catalogs': [
          {
            id: 'team',
            name: 'Team catalog',
            location: 'https://git.example.com/team/catalog.git',
            publisherKey: PUBLISHER_KEY,
            commit: COMMIT,
          },
          { id: 'bad', name: 'Tampered', location: '/srv/bad' },
        ],
      },
      market: {
        catalogStates: { team: { signature: 'verified' }, bad: { signature: 'invalid' } },
      },
    });
    const list = await screen.findByRole('list', { name: 'Catalogs' });
    const sample = within(list).getByRole('listitem', { name: 'Sample catalog' });
    expect(within(sample).getByText('Built in')).toBeTruthy();
    expect(within(sample).getByText('Signed by a key you trust')).toBeTruthy();
    expect(
      within(sample).getByText('The sample catalog ships with Nova and works offline.'),
    ).toBeTruthy();
    // The built-in one cannot be removed.
    expect(within(sample).queryByRole('button', { name: /Remove/ })).toBeNull();
    const team = within(list).getByRole('listitem', { name: 'Team catalog' });
    expect(within(team).getByText('Git repository')).toBeTruthy();
    expect(within(team).getByText('Read at commit 0123456789ab')).toBeTruthy();
    const bad = within(list).getByRole('listitem', { name: 'Tampered' });
    expect(within(bad).getByText('Refused: its signature does not match')).toBeTruthy();
    expect(within(bad).getByText('0 items')).toBeTruthy();
    expect(within(bad).getByText('Could not be read: bad signature')).toBeTruthy();
  });

  it('adds a catalog with a pinned key and commit after checking them, and removes it', async () => {
    const { hub } = await renderWithMarket(<MarketplacePage tab="catalogs" />);
    await screen.findByRole('list', { name: 'Catalogs' });
    await userEvent.click(screen.getByText('Add a catalog'));
    const add = screen.getByRole('button', { name: 'Add catalog' });
    await userEvent.click(add);
    expect(screen.getByText('Enter a name for the catalog.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Name'), 'Team catalog');
    await userEvent.type(screen.getByLabelText('Location'), 'ftp://example.com/x');
    await userEvent.type(screen.getByLabelText('Publisher key (optional)'), 'short');
    await userEvent.type(screen.getByLabelText('Commit (Git only, optional)'), COMMIT);
    await userEvent.click(add);
    expect(screen.getByText(/Enter a full folder path on the Hub/)).toBeTruthy();
    expect(screen.getByText(/A publisher key is 43 characters/)).toBeTruthy();
    expect(hub.state.settings['plugins.catalogs']).toBeUndefined();

    await userEvent.clear(screen.getByLabelText('Location'));
    await userEvent.type(screen.getByLabelText('Location'), '/srv/catalog');
    await userEvent.clear(screen.getByLabelText('Publisher key (optional)'));
    await userEvent.type(screen.getByLabelText('Publisher key (optional)'), PUBLISHER_KEY);
    await userEvent.click(add);
    // A commit pins only a Git catalog.
    expect(screen.getByText('Only a Git catalog can be pinned to a commit.')).toBeTruthy();

    await userEvent.clear(screen.getByLabelText('Location'));
    await userEvent.type(
      screen.getByLabelText('Location'),
      'https://git.example.com/team/catalog.git',
    );
    await userEvent.click(add);
    await waitFor(() =>
      expect(hub.state.settings['plugins.catalogs']).toEqual([
        {
          id: 'team-catalog',
          name: 'Team catalog',
          location: 'https://git.example.com/team/catalog.git',
          publisherKey: PUBLISHER_KEY,
          commit: COMMIT,
        },
      ]),
    );
    expect((await screen.findAllByText('Team catalog added.')).length).toBeGreaterThan(0);
    const row = await screen.findByRole('listitem', { name: 'Team catalog' });
    await userEvent.click(within(row).getByRole('button', { name: 'Remove Team catalog' }));
    await waitFor(() => expect(hub.state.settings['plugins.catalogs']).toEqual([]));
  });

  it('locks the catalogs under managed policy and says so', async () => {
    await renderWithMarket(<MarketplacePage tab="catalogs" />, {
      managed: { 'plugins.catalogs': [] },
    });
    await screen.findByRole('list', { name: 'Catalogs' });
    expect(screen.getAllByText('Managed by your organization').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByText('Add a catalog'));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add catalog' }).disabled).toBe(
      true,
    );
  });
});

describe('trusted publishers', () => {
  it('trusts a publisher only after a confirmation that says what changes, and stops trusting', async () => {
    const { hub } = await renderWithMarket(<MarketplacePage tab="catalogs" />);
    expect(await screen.findByText('You trust no publishers yet.')).toBeTruthy();
    await userEvent.click(screen.getByText('Trust a publisher'));
    await userEvent.type(screen.getByLabelText('Publisher name'), 'Example Labs');
    await userEvent.type(screen.getByLabelText('Publisher key'), 'not-a-key');
    await userEvent.click(screen.getByRole('button', { name: 'Trust this publisher' }));
    expect(screen.getByText(/A publisher key is 43 characters/)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('Publisher key'));
    await userEvent.type(screen.getByLabelText('Publisher key'), PUBLISHER_KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Trust this publisher' }));
    const dialog = screen.getByRole('dialog', { name: 'Trust Example Labs?' });
    expect(dialog.textContent).toContain('install as Verified, without the sideload confirmation');
    expect(dialog.textContent).toContain(PUBLISHER_KEY);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(hub.state.settings['plugins.trustedPublishers']).toBeUndefined();

    await userEvent.click(screen.getByRole('button', { name: 'Trust this publisher' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Trust Example Labs?' })).getByRole('button', {
        name: 'Trust this publisher',
      }),
    );
    await waitFor(() =>
      expect(hub.state.settings['plugins.trustedPublishers']).toEqual([
        { name: 'Example Labs', key: PUBLISHER_KEY },
      ]),
    );
    const row = await screen.findByRole('listitem', { name: 'Example Labs' });
    await userEvent.click(within(row).getByRole('button', { name: 'Stop trusting Example Labs' }));
    const stop = screen.getByRole('dialog', { name: 'Stop trusting Example Labs?' });
    expect(stop.textContent).toContain('shows as Unverified');
    await userEvent.click(within(stop).getByRole('button', { name: 'Stop trusting' }));
    await waitFor(() => expect(hub.state.settings['plugins.trustedPublishers']).toEqual([]));
  });
});

describe('install rules', () => {
  it('turns unverified items and kinds on and off', async () => {
    const { hub } = await renderWithMarket(<MarketplacePage tab="catalogs" />);
    const sw = await screen.findByRole('switch', { name: 'Allow unverified items' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(sw);
    await waitFor(() => expect(hub.state.settings['market.allowSideload']).toBe(false));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Pets' }));
    await waitFor(() =>
      expect(hub.state.settings['market.allowedKinds']).toEqual([
        'plugin',
        'skill',
        'theme',
        'mcp',
      ]),
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Pets' }));
    await waitFor(() =>
      expect(hub.state.settings['market.allowedKinds']).toEqual([
        'plugin',
        'skill',
        'theme',
        'pet',
        'mcp',
      ]),
    );
  });

  it('shows rules the organization sets as locked, with where they come from', async () => {
    await renderWithMarket(<MarketplacePage tab="catalogs" />, {
      managed: {
        'market.allowedKinds': ['plugin'],
        'managed.restrict': { layers: [{ unverifiedInstalls: false }], failClosed: null },
      },
      policy: {
        active: true,
        failClosed: null,
        sources: [
          {
            channel: 'remote',
            location: 'https://policy.example.com/nova.json',
            status: 'active',
            problem: null,
            inForce: true,
            cached: false,
            serial: 7,
            loadedAt: '2026-10-19T08:00:00.000Z',
            checkedAt: '2026-10-19T09:00:00.000Z',
          },
        ],
        settings: [
          { key: 'market.allowedKinds', value: ['plugin'], channel: 'remote', derivedFrom: null },
        ],
        restrict: [{ channel: 'remote', restrict: { unverifiedInstalls: false } }],
        egress: null,
        ignored: [],
        checkedAt: '2026-10-19T09:00:00.000Z',
      },
    });
    const sw = await screen.findByRole('switch', { name: 'Allow unverified items' });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Themes' }).disabled).toBe(true);
    // The shared lock note, with the source the managed policy client read.
    const sources = await screen.findAllByText('(remote policy)');
    expect(sources.length).toBeGreaterThanOrEqual(2);
    for (const s of sources)
      expect(s.parentElement!.textContent).toBe('Managed by your organization(remote policy)');
  });
});
