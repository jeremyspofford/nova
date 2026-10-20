// Spaces and Sites in the pseudo-locale (FR-016): the spaces list, a space (pages with their
// menu and Move to…, recently deleted pages, a proposed new page, the delete confirmation), the
// page editor (comments, history, a proposed edit and a conflict's diff), the sites list, a site
// (versions, preview, publish history, the publish plan, Change source) and the publishing
// targets show every word through messages. Names, titles, page text, comments, folders, file
// paths and addresses are fixture data.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DELETE_PAGE_TEXT } from '../src/spaces/PageDelete.tsx';
import { EDITOR_TEXT } from '../src/spaces/PageEditor.tsx';
import { PUBLISH_TEXT } from '../src/spaces/SitePublish.tsx';
import { SOURCE_TEXT } from '../src/spaces/SiteSource.tsx';
import { SITES_M8_TEXT, SITES_TEXT, SitesView } from '../src/spaces/SitesView.tsx';
import { TARGETS_TEXT } from '../src/spaces/SiteTargets.tsx';
import { SPACE_PAGES_TEXT, SPACE_VIEW_TEXT, SpacesView } from '../src/spaces/SpacesView.tsx';
import {
  commentView,
  pageView,
  proposalView,
  publishView,
  renderWithSpaces,
  siteVersionView,
  siteView,
  spaceView,
  targetView,
} from './fakes-m6-spaces.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

const DATA = [
  'Handbook site',
  'Handbook',
  'Welcome',
  'First',
  'Second',
  'Hello there.',
  'Hello there, friend.',
  'Looks good.',
  'Warmer greeting',
  'Home NAS',
  'handbook',
  'index.html',
  'docs',
  'Old notes',
];

const PAGES = () => [
  pageView({ id: 'pg1', spaceId: 'sp1', title: 'First', slug: 'first', position: 0 }),
  pageView({ id: 'pg2', spaceId: 'sp1', title: 'Second', slug: 'second', position: 1 }),
];

/** The Markdown preview of page text (headings, paragraphs) is the user's own content. */
const PAGE_TEXT = ['.spaces-md', '.spaces-diff'];

describe('Spaces and Sites in a pseudo-locale', () => {
  it('shows the spaces list and a space with its pages, deleted pages and a proposal', async () => {
    await activateTestLocale('en-XA');
    const list = await renderWithSpaces(<SpacesView spaceId={null} pageId={null} />, {
      spaces: { spaces: [spaceView({ id: 'sp1' })] },
    });
    await screen.findByRole('list', { name: SPACE_VIEW_TEXT.spaces });
    expectFullyLocalized(list.container, { data: DATA });
    await userEvent.click(screen.getByRole('button', { name: SPACE_VIEW_TEXT.newSpace }));
    expectFullyLocalized(screen.getByRole('dialog', { name: SPACE_VIEW_TEXT.newSpace }), {
      data: DATA,
    });
    resetDom();

    const one = await renderWithSpaces(<SpacesView spaceId="sp1" pageId={null} />, {
      spaces: {
        spaces: [spaceView({ id: 'sp1' })],
        pages: PAGES(),
        comments: [commentView({ pageId: 'pg1' })],
        proposals: [proposalView({ pageId: null, title: 'Old notes', summary: 'Warmer greeting' })],
        trash: [
          {
            page: pageView({ id: 'pg9', spaceId: 'sp1', title: 'Old notes' }),
            deletedAt: '2026-10-01T12:00:00.000Z',
          },
        ],
      },
    });
    await screen.findByRole('list', { name: SPACE_VIEW_TEXT.pages });
    await screen.findByRole('list', { name: SPACE_PAGES_TEXT.deletedTitle });
    expectFullyLocalized(one.container, { data: DATA, skip: PAGE_TEXT });

    await userEvent.click(
      screen.getByRole('button', { name: SPACE_PAGES_TEXT.more({ title: 'First' }) }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: SPACE_PAGES_TEXT.moveTo }));
    expectFullyLocalized(
      screen.getByRole('dialog', { name: SPACE_PAGES_TEXT.moveTitle({ title: 'First' }) }),
      { data: DATA },
    );
    await userEvent.click(screen.getByRole('button', { name: SPACE_PAGES_TEXT.cancel }));
    await userEvent.click(
      screen.getByRole('button', { name: SPACE_PAGES_TEXT.more({ title: 'First' }) }),
    );
    await userEvent.click(await screen.findByRole('menuitem', { name: SPACE_PAGES_TEXT.delete }));
    const del = screen.getByRole('dialog', { name: DELETE_PAGE_TEXT.title({ title: 'First' }) });
    await waitFor(() => expect(within(del).queryByRole('status')).toBeNull());
    expectFullyLocalized(del, { data: DATA });
  });

  it('shows the page editor with comments, history, a proposal and a conflict', async () => {
    await activateTestLocale('en-XA');
    const page = pageView({ id: 'pg1', spaceId: 'sp1', title: 'Welcome', version: 2 });
    const { container } = await renderWithSpaces(<SpacesView spaceId="sp1" pageId="pg1" />, {
      spaces: {
        spaces: [spaceView({ id: 'sp1' })],
        pages: [page],
        comments: [
          commentView({ pageId: 'pg1' }),
          commentView({
            pageId: 'pg1',
            anchor: { kind: 'range', start: 0, end: 9, quote: 'Hello there.' },
            detached: true,
          } as never),
        ],
        proposals: [proposalView({ pageId: 'pg1', baseVersion: 1, title: 'First' })],
      },
    });
    await screen.findByRole('heading', { name: 'Welcome', level: 1 });
    expectFullyLocalized(container, { data: DATA, skip: PAGE_TEXT });

    await userEvent.click(screen.getByRole('tab', { name: EDITOR_TEXT.history }));
    await screen.findByRole('list', { name: EDITOR_TEXT.versions });
    expectFullyLocalized(container, { data: DATA, skip: PAGE_TEXT });

    await userEvent.click(screen.getByRole('tab', { name: EDITOR_TEXT.proposalsTab({ n: 1 }) }));
    await screen.findByRole('list', { name: EDITOR_TEXT.proposedEdits });
    expectFullyLocalized(container, { data: DATA, skip: PAGE_TEXT });
  });

  it('shows the sites list, a site with versions and history, and its dialogs', async () => {
    await activateTestLocale('en-XA');
    const sites = {
      spaces: [spaceView({ id: 'sp1' })],
      sites: [
        siteView({
          id: 'site1',
          latestVersion: 2,
          publishedVersion: 1,
          publishedTarget: { kind: 'folder', folder: 'handbook' },
          publishedAt: '2026-10-01T12:00:00.000Z',
        } as never),
      ],
      siteVersions: [
        siteVersionView({ siteId: 'site1', version: 1 }),
        siteVersionView({ siteId: 'site1', version: 2 }),
      ],
      publishes: [
        publishView({ siteId: 'site1', version: 1, current: true }),
        publishView({ siteId: 'site1', version: 1, current: false }),
      ],
      targets: [targetView({ id: 't1' })],
    };
    const list = await renderWithSpaces(<SitesView siteId={null} />, { spaces: sites });
    await screen.findByRole('list', { name: SITES_TEXT.sites });
    expectFullyLocalized(list.container, { data: DATA });
    resetDom();

    const one = await renderWithSpaces(<SitesView siteId="site1" />, { spaces: sites });
    await screen.findByRole('list', { name: SITES_TEXT.history });
    expectFullyLocalized(one.container, { data: DATA });

    await userEvent.click(screen.getByRole('button', { name: SITES_TEXT.publishOf({ v: 2 }) }));
    const publish = screen.getByRole('dialog', { name: PUBLISH_TEXT.title({ v: 2 }) });
    await within(publish).findByRole('region', { name: PUBLISH_TEXT.planLabel });
    await waitFor(() => expect(within(publish).queryByRole('status')).toBeNull());
    expectFullyLocalized(publish, { data: DATA });
    await userEvent.click(within(publish).getByRole('button', { name: PUBLISH_TEXT.cancel }));

    await userEvent.click(screen.getByRole('button', { name: SITES_M8_TEXT.changeSource }));
    expectFullyLocalized(screen.getByRole('dialog', { name: SOURCE_TEXT.title }), { data: DATA });
  });

  it('shows the publishing targets', async () => {
    await activateTestLocale('en-XA');
    const { container } = await renderWithSpaces(<SitesView siteId="targets" />, {
      spaces: { targets: [targetView({ id: 't1' })] },
    });
    await screen.findByRole('list', { name: TARGETS_TEXT.list });
    expectFullyLocalized(container, { data: [...DATA, 'https://dav.example.com/sites/'] });
  });
});
