// M8 spaces and sites (FR-036, FR-037): pages reorder by dragging and by Move to… (one write; a
// stale order is refused in plain words), a page's menu deletes it after saying what goes, Undo and
// "Recently deleted pages" bring it back, a site's source changes only after a preview of what
// changes, publishing to a hosting target shows what is uploaded first (and refuses what the
// network policy or the target refuses), the owner manages the targets, and a member is told
// what is the owner's.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { SitesView } from '../src/spaces/SitesView.tsx';
import { SpacesView } from '../src/spaces/SpacesView.tsx';
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
  type M6SpacesState,
} from './fakes-m6-spaces.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const SPACE = () => spaceView({ id: 'sp1', name: 'Handbook' });
const PAGES = () => [
  pageView({ id: 'pg1', spaceId: 'sp1', title: 'First', slug: 'first', position: 0 }),
  pageView({ id: 'pg2', spaceId: 'sp1', title: 'Second', slug: 'second', position: 1 }),
  pageView({ id: 'pg3', spaceId: 'sp1', title: 'Third', slug: 'third', position: 2 }),
];

function openSpace(spaces: Partial<M6SpacesState> = {}) {
  return renderWithSpaces(<SpacesView spaceId="sp1" pageId={null} />, {
    spaces: { spaces: [SPACE()], pages: PAGES(), ...spaces },
  });
}

const ordered = () =>
  within(screen.getByRole('list', { name: 'Pages' }))
    .getAllByRole('link')
    .map((a) => a.textContent);
const row = (title: string) => screen.getByRole('link', { name: title }).closest('li')!;

async function pageMenu(title: string, item: string) {
  await userEvent.click(screen.getByRole('button', { name: `More actions for ${title}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
}

describe('ordering pages', () => {
  it('moves a page by dragging it onto another, in one write', async () => {
    const { api } = await openSpace();
    await screen.findByRole('list', { name: 'Pages' });
    expect(screen.getByText(/Drag a page to move it/)).toBeTruthy();
    const data = { effectAllowed: '', dropEffect: '', setData: vi.fn() };
    fireEvent.dragStart(row('Third'), { dataTransfer: data });
    fireEvent.dragOver(row('First'), { dataTransfer: data });
    expect(row('First').dataset.drop).toBe('before');
    fireEvent.drop(row('First'), { dataTransfer: data });
    expect(api.reorderSpacePages).toHaveBeenCalledWith('sp1', ['pg3', 'pg1', 'pg2']);
    expect(ordered()).toEqual(['Third', 'First', 'Second']);
    await waitFor(() =>
      expect(screen.getByTestId('announcer').textContent).toContain(
        'Moved “Third” to position 1 of 3.',
      ),
    );
    // Dropping a page where it is changes nothing.
    fireEvent.dragStart(row('First'), { dataTransfer: data });
    fireEvent.dragOver(row('First'), { dataTransfer: data });
    fireEvent.drop(row('First'), { dataTransfer: data });
    expect(api.reorderSpacePages).toHaveBeenCalledTimes(1);
  });

  it('moves a page with Move to… and the menu’s top and bottom', async () => {
    const { api } = await openSpace();
    await screen.findByRole('list', { name: 'Pages' });
    await pageMenu('First', 'Move to…');
    const dialog = screen.getByRole('dialog', { name: 'Move “First”' });
    const select = within(dialog).getByLabelText('New position');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['1 (where it is now)', '2 (now “Second”)', '3 (now “Third”)']);
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Move' }).disabled).toBe(
      true,
    );
    await userEvent.selectOptions(select, '1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(api.reorderSpacePages).toHaveBeenLastCalledWith('sp1', ['pg2', 'pg1', 'pg3']);
    await waitFor(() => expect(ordered()).toEqual(['Second', 'First', 'Third']));
    await pageMenu('Third', 'Move to the top');
    expect(api.reorderSpacePages).toHaveBeenLastCalledWith('sp1', ['pg3', 'pg2', 'pg1']);
    await waitFor(() => expect(ordered()).toEqual(['Third', 'Second', 'First']));
    await pageMenu('Third', 'Move to the bottom');
    await waitFor(() => expect(ordered()).toEqual(['Second', 'First', 'Third']));
  });

  it('says in plain words when the pages changed meanwhile, and shows the Hub’s order', async () => {
    const { spaces } = await openSpace();
    await screen.findByRole('list', { name: 'Pages' });
    spaces.failNext.reorderSpacePages = new ApiError(409, {
      code: 'conflict',
      message: 'the pages of this space changed',
      retryable: false,
      details: { reason: 'order_stale' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Move Third up' }));
    expect(
      await screen.findByText(
        'Could not move it: The pages changed meanwhile. This is the order now.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(ordered()).toEqual(['First', 'Second', 'Third']));
  });
});

describe('deleting and restoring pages', () => {
  it('says what goes, deletes after confirming, and Undo brings the page back', async () => {
    const { api, state } = await openSpace({
      comments: [
        commentView({ id: 'c1', pageId: 'pg2' }),
        commentView({ id: 'c2', pageId: 'pg2', parentId: 'c1' }),
      ],
      proposals: [proposalView({ id: 'x1', pageId: 'pg2', spaceId: 'sp1' })],
      sites: [
        siteView({
          id: 'site1',
          name: 'Team site',
          source: { kind: 'space', spaceId: 'sp1' },
          publishedVersion: 1,
          publishedTarget: { kind: 'zip' },
        }),
      ],
    });
    await screen.findByRole('list', { name: 'Pages' });
    await pageMenu('Second', 'Delete…');
    const dialog = screen.getByRole('dialog', { name: 'Delete “Second”?' });
    await waitFor(() => expect(dialog.textContent).toContain('its saved version'));
    expect(dialog.textContent).toContain('1 comment thread');
    expect(dialog.textContent).toContain('1 reply');
    expect(dialog.textContent).toContain('1 open proposal from an agent');
    expect(dialog.textContent).toContain(
      'Sites built from this space leave it out of their next build: “Team site”.',
    );
    expect(dialog.textContent).toContain('What is published now does not change');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.deleteSpacePage).not.toHaveBeenCalled();

    await pageMenu('Second', 'Delete…');
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete “Second”?' })).getByRole('button', {
        name: 'Delete page',
      }),
    );
    expect(api.deleteSpacePage).toHaveBeenCalledWith('sp1', 'pg2');
    await waitFor(() => expect(ordered()).toEqual(['First', 'Third']));
    const deleted = await screen.findByRole('list', { name: 'Recently deleted pages' });
    expect(deleted.textContent).toContain('Second');
    expect(deleted.textContent).toContain('2 comments');
    expect(state.proposals[0]?.status).toBe('rejected');
    // Undo on the toast restores it at its old place.
    await userEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(api.undeleteSpacePage).toHaveBeenCalledWith('sp1', 'pg2');
    await waitFor(() => expect(ordered()).toEqual(['First', 'Second', 'Third']));
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: 'Recently deleted pages' })).toBeNull(),
    );
  });

  it('restores a page from the deleted list, and says when it cannot', async () => {
    const gone = pageView({
      id: 'pg9',
      spaceId: 'sp1',
      title: 'Old notes',
      slug: 'old',
      position: 1,
    });
    const { api, spaces } = await openSpace({
      trash: [{ page: gone, deletedAt: '2026-10-01T12:00:00.000Z' }],
    });
    const list = await screen.findByRole('list', { name: 'Recently deleted pages' });
    expect(screen.getByText(/Deleted pages keep their history and comments/)).toBeTruthy();
    spaces.failNext.undeleteSpacePage = new ApiError(404, {
      code: 'not_found',
      message: 'deleted page not found',
      retryable: false,
    });
    await userEvent.click(within(list).getByRole('button', { name: 'Restore Old notes' }));
    expect(await screen.findByText('Could not restore it: deleted page not found')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Restore Old notes' }));
    await waitFor(() => expect(ordered()).toEqual(['First', 'Old notes', 'Second', 'Third']));
    expect(api.undeleteSpacePage).toHaveBeenCalledTimes(2);
    expect(await screen.findByText('Restored “Old notes”.')).toBeTruthy();
  });

  it('still deletes when what goes cannot be checked, and keeps a refusal in the dialog', async () => {
    const { spaces } = await openSpace();
    await screen.findByRole('list', { name: 'Pages' });
    spaces.failNext.getPageDeletion = new ApiError(500, {
      code: 'server_error',
      message: 'x',
      retryable: true,
    });
    spaces.failNext.deleteSpacePage = new ApiError(503, {
      code: 'unavailable',
      message: 'The Hub is busy.',
      retryable: true,
    });
    await pageMenu('First', 'Delete…');
    const dialog = screen.getByRole('dialog', { name: 'Delete “First”?' });
    expect(await within(dialog).findByText('Could not check what goes with it.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete page' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('The Hub is busy.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete page' }));
    await waitFor(() => expect(ordered()).toEqual(['Second', 'Third']));
  });
});

// ---- sites ------------------------------------------------------------------------------------

const SITE_BASE = (): Partial<M6SpacesState> => ({
  spaces: [spaceView({ id: 'sp1', name: 'Handbook' }), spaceView({ id: 'sp2', name: 'Guide' })],
  sites: [
    siteView({
      id: 'site1',
      name: 'Handbook site',
      source: { kind: 'space', spaceId: 'sp1' },
      sourceLabel: 'Handbook',
      latestVersion: 1,
    }),
  ],
  siteVersions: [
    siteVersionView({
      version: 1,
      files: [
        { path: 'index.html', size: 1200 },
        { path: 'old.html', size: 300 },
      ],
      size: 1500,
    }),
  ],
  sourceFiles: {
    sp2: [
      { path: 'index.html', size: 900 },
      { path: 'start.html', size: 400 },
    ],
  },
  targets: [targetView({ id: 'tgt1', name: 'Home NAS', publicUrl: 'https://www.example.com/' })],
});

function openSite(over: Partial<M6SpacesState> = {}, opts: { member?: boolean } = {}) {
  return renderWithSpaces(<SitesView siteId="site1" />, {
    spaces: { ...SITE_BASE(), ...over },
    ...opts,
  });
}

describe('a site’s source', () => {
  it('changes the source only after a preview of what changes', async () => {
    const { api, state } = await openSite();
    await userEvent.click(await screen.findByRole('button', { name: 'Change source…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the source' });
    expect(dialog.textContent).toContain('Built now from “Handbook”.');
    const save = () =>
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Change the source' });
    expect(save().disabled).toBe(true);
    const preview = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Preview the change',
    });
    // The current source is not a change.
    await waitFor(() => expect(within(dialog).getByLabelText('Space')).toBeTruthy());
    expect(preview.disabled).toBe(true);
    await userEvent.selectOptions(within(dialog).getByLabelText('Space'), 'sp2');
    await userEvent.click(preview);
    const what = await within(dialog).findByRole('region', { name: 'What changes' });
    expect(what.textContent).toContain('Compared with version 1, a build from the new source:');
    expect(what.textContent).toContain('adds 1 file');
    expect(what.textContent).toContain('changes 1 file');
    expect(what.textContent).toContain('removes 1 file');
    const files = within(what).getByRole('list', { name: 'Files' });
    expect(files.textContent).toContain('start.html');
    expect(files.textContent).toContain('removed');
    expect(api.updateSite).not.toHaveBeenCalled();
    // Choosing again hides the old preview until it is previewed again.
    await userEvent.selectOptions(within(dialog).getByLabelText('Space'), 'sp1');
    expect(within(dialog).queryByRole('region', { name: 'What changes' })).toBeNull();
    await userEvent.selectOptions(within(dialog).getByLabelText('Space'), 'sp2');
    await userEvent.click(preview);
    await within(dialog).findByRole('region', { name: 'What changes' });
    await userEvent.click(save());
    expect(api.updateSite).toHaveBeenCalledWith('site1', {
      source: { kind: 'space', spaceId: 'sp2' },
    });
    // The toast says it, and the announcer reads it out.
    expect(
      await screen.findAllByText('Source changed. Build a new version to use it.'),
    ).toHaveLength(2);
    expect(state.sites[0]!.sourceLabel).toBe('Guide');
  });

  it('says in plain words when the new source is gone', async () => {
    await openSite({ artifacts: [] });
    await userEvent.click(await screen.findByRole('button', { name: 'Change source…' }));
    const dialog = screen.getByRole('dialog', { name: 'Change the source' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'An artifact' }));
    await userEvent.type(within(dialog).getByLabelText('Artifact id'), 'art-gone');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Preview the change' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'That source is gone. Choose another.',
    );
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Change the source' }).disabled,
    ).toBe(true);
  });
});

describe('publishing to a hosting target', () => {
  it('shows what is uploaded where before publishing, then publishes', async () => {
    const { api, state } = await openSite();
    await userEvent.click(await screen.findByRole('button', { name: 'Publish version 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish version 1?' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'A hosting target' }));
    expect(await within(dialog).findByLabelText('Hosting target')).toBeTruthy();
    const folder = within(dialog).getByLabelText('Folder name');
    await userEvent.clear(folder);
    await userEvent.type(folder, 'docs');
    const plan = await within(dialog).findByRole('region', { name: 'What publishing does' });
    await waitFor(() =>
      expect(plan.textContent).toContain('Uploads 2 files (1.5 KB) to “Home NAS” at:'),
    );
    expect(plan.textContent).toContain('https://dav.example.com/sites/docs/');
    expect(within(plan).getByRole('link', { name: 'https://www.example.com/docs/' })).toBeTruthy();
    expect(plan.textContent).toContain('Unpublishing takes it back.');
    await userEvent.click(within(plan).getByRole('button', { name: 'Show the files' }));
    expect(within(plan).getByRole('list', { name: 'Files' }).textContent).toContain('old.html');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish version 1' }));
    expect(api.publishSite).toHaveBeenCalledWith('site1', {
      version: 1,
      target: { kind: 'remote', targetId: 'tgt1', folder: 'docs' },
      confirm: true,
    });
    expect(
      await screen.findByText('Version 1 is published to “Home NAS”, folder “docs”.'),
    ).toBeTruthy();
    const live = screen.getByRole('region', { name: 'Publishing' });
    expect(live.textContent).toContain('Live: version 1, published to “Home NAS”, folder “docs”');
    expect(within(live).getByRole('link', { name: 'https://www.example.com/docs/' })).toBeTruthy();
    expect(state.sites[0]!.publishedRemote?.name).toBe('Home NAS');
  });

  it('keeps Publish off when the network policy refuses the target, and names other refusals', async () => {
    const { api } = await openSite({ egressDenied: ['dav.example.com'] });
    await userEvent.click(await screen.findByRole('button', { name: 'Publish version 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish version 1?' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'A hosting target' }));
    const plan = await within(dialog).findByRole('region', { name: 'What publishing does' });
    expect((await within(plan).findByRole('alert')).textContent).toBe(
      'Nova may not reach dav.example.com: dav.example.com is on the egress deny list.',
    );
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Publish version 1' }).disabled,
    ).toBe(true);
    expect(api.publishSite).not.toHaveBeenCalled();
  });

  it('keeps the form with the reason when the target refuses the upload', async () => {
    await openSite({ targetFailures: { tgt1: 'target_auth_failed' } });
    await userEvent.click(await screen.findByRole('button', { name: 'Publish version 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish version 1?' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'A hosting target' }));
    await within(dialog).findByText(/Uploads 2 files/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish version 1' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The hosting target refused the sign-in. Check the user name, password or token.',
    );
    expect(within(dialog).getByLabelText('Folder name')).toBeTruthy();
  });

  it('points to Publishing targets when there are none, and says a zip cannot be taken back', async () => {
    await openSite({ targets: [] });
    await userEvent.click(await screen.findByRole('button', { name: 'Publish version 1' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish version 1?' });
    await userEvent.click(within(dialog).getByRole('radio', { name: 'A hosting target' }));
    const link = await within(dialog).findByRole('link', {
      name: 'Add one under Publishing targets',
    });
    expect(link.getAttribute('href')).toBe('/sites/targets');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Download as a zip' }));
    expect(dialog.textContent).toContain('A downloaded zip cannot be taken back');
    expect(
      await within(dialog).findByText('A zip you download cannot be taken back.'),
    ).toBeTruthy();
  });

  it('lists remote publishes in the history by target name', async () => {
    await openSite({
      sites: [
        siteView({
          id: 'site1',
          name: 'Handbook site',
          latestVersion: 1,
          publishedVersion: 1,
          publishedTarget: { kind: 'remote', targetId: 'tgt-gone', folder: 'docs' },
          publishedRemote: { targetId: 'tgt-gone', name: null, location: null, publicUrl: null },
        }),
      ],
      publishes: [
        publishView({
          id: 'pub1',
          version: 1,
          target: { kind: 'remote', targetId: 'tgt-gone', folder: 'docs' },
          remote: { targetId: 'tgt-gone', name: null, location: null, publicUrl: null },
        }),
      ],
    });
    const history = await screen.findByRole('list', { name: 'Publish history' });
    expect(history.textContent).toContain(
      'Version 1 published to a removed hosting target, folder “docs”',
    );
  });
});

describe('publishing targets', () => {
  const openTargets = (over: Partial<M6SpacesState> = {}, opts: Record<string, unknown> = {}) =>
    renderWithSpaces(<SitesView siteId="targets" />, {
      spaces: { targets: [], ...over },
      ...opts,
    });

  it('adds a target with a password the page never shows again, and checks it', async () => {
    const { api, state } = await openTargets();
    expect(await screen.findByRole('heading', { name: 'No publishing targets yet' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a target' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a publishing target' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Home NAS');
    await userEvent.type(
      within(dialog).getByLabelText('WebDAV address'),
      'http://nas.example.com/dav',
    );
    await userEvent.click(within(dialog).getByRole('radio', { name: 'User name and password' }));
    await userEvent.type(within(dialog).getByLabelText('User name'), 'nova');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'pa55word');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add target' }));
    // Plain http to another machine is refused on its field; the form stays.
    expect(
      await within(dialog).findByText(
        'Use an https address. Plain http works only for this machine.',
      ),
    ).toBeTruthy();
    const url = within(dialog).getByLabelText('WebDAV address');
    await userEvent.clear(url);
    await userEvent.type(url, 'https://nas.example.com/dav/');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add target' }));
    expect(api.createSiteTarget).toHaveBeenLastCalledWith({
      name: 'Home NAS',
      kind: 'webdav',
      url: 'https://nas.example.com/dav/',
      publicUrl: null,
      // secret-scan: fake
      credential: { kind: 'basic', username: 'nova', password: 'pa55word' },
    });
    const list = await screen.findByRole('list', { name: 'Publishing targets' });
    await waitFor(() => expect(api.checkSiteTarget).toHaveBeenCalled());
    await waitFor(() => expect(list.textContent).toContain('Connected, checked'));
    expect(list.textContent).toContain('Signs in as “nova”');
    expect(document.body.textContent).not.toContain('pa55word');
    expect(state.targets).toHaveLength(1);
  });

  it('shows why a check fails, edits without resending the credential, and refuses removing a target in use', async () => {
    const { api } = await openTargets({
      targets: [targetView({ id: 'tgt1', name: 'Home NAS', auth: 'bearer', hasCredential: true })],
      targetFailures: { tgt1: 'target_unreachable' },
      sites: [
        siteView({
          id: 'site1',
          name: 'Handbook site',
          publishedVersion: 2,
          publishedTarget: { kind: 'remote', targetId: 'tgt1', folder: 'docs' },
        }),
      ],
    });
    const list = await screen.findByRole('list', { name: 'Publishing targets' });
    expect(list.textContent).toContain('“Handbook site”, folder “docs”, version 2');
    await userEvent.click(
      within(list).getByRole('button', { name: 'Check the connection to Home NAS' }),
    );
    await waitFor(() => expect(list.textContent).toContain('Not working, checked'));
    expect(list.textContent).toContain('The hosting target could not be reached.');

    await userEvent.click(within(list).getByRole('button', { name: 'Edit Home NAS' }));
    const edit = screen.getByRole('dialog', { name: 'Edit “Home NAS”' });
    expect(
      within(edit).getByRole<HTMLInputElement>('radio', { name: 'Keep the current sign-in' })
        .checked,
    ).toBe(true);
    const name = within(edit).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Office NAS');
    await userEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    expect(api.updateSiteTarget).toHaveBeenCalledWith('tgt1', {
      name: 'Office NAS',
      publicUrl: null,
    });
    await waitFor(() => expect(list.textContent).toContain('Office NAS'));

    await userEvent.click(within(list).getByRole('button', { name: 'Remove Office NAS' }));
    const remove = screen.getByRole('dialog', { name: 'Remove “Office NAS”?' });
    expect(remove.textContent).toContain(
      'Sites are published on this target. Unpublish them first',
    );
    expect(within(remove).getByRole<HTMLButtonElement>('button', { name: 'Remove' }).disabled).toBe(
      true,
    );
    expect(api.deleteSiteTarget).not.toHaveBeenCalled();
  });

  it('removes a target no site is live on', async () => {
    const { api, state } = await openTargets({
      targets: [targetView({ id: 'tgt1', name: 'Home NAS' })],
    });
    const list = await screen.findByRole('list', { name: 'Publishing targets' });
    await userEvent.click(within(list).getByRole('button', { name: 'Remove Home NAS' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove “Home NAS”?' });
    expect(dialog.textContent).toContain('Files already on the host stay there.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(api.deleteSiteTarget).toHaveBeenCalledWith('tgt1');
    expect(await screen.findByText('Removed “Home NAS”.')).toBeTruthy();
    expect(state.targets).toEqual([]);
  });

  it('turns targets off with the switch, and shows a managed lock', async () => {
    await openTargets({}, { managed: { 'sites.remoteTargets': false } });
    const sw = await screen.findByRole('switch', { name: 'Allow publishing to hosting targets' });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
    expect(screen.getByText(/Turned off: sites publish only/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add a target' }).disabled).toBe(
      true,
    );
  });

  it('is reachable from Sites for the owner', async () => {
    await renderWithSpaces(<SitesView siteId={null} />, { spaces: {} });
    const link = await screen.findByRole('link', { name: 'Publishing targets' });
    expect(link.getAttribute('href')).toBe('/sites/targets');
  });
});

describe('a member', () => {
  it('sees the owner-only notice on targets and no publishing on a site', async () => {
    await renderWithSpaces(<SitesView siteId="targets" />, { spaces: {}, member: true });
    expect(await screen.findByText(/Only the owner of this Hub can change this/)).toBeTruthy();
    resetDom();
    await openSite({}, { member: true });
    expect(
      await screen.findByText(
        'Only the owner of this Hub can publish sites. You can build, preview and download them.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish version 1' })).toBeNull();
    resetDom();
    await renderWithSpaces(<SitesView siteId={null} />, { spaces: {}, member: true });
    await screen.findByRole('heading', { name: 'Sites' });
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Publishing targets' })).toBeNull(),
    );
  });
});
