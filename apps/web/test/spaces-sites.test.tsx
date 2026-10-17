// Sites (FR-037): a site is created from a space or an artifact with connected data, built into
// versions, previewed in a sandboxed frame (scripts only for an HTML artifact, never same-origin),
// published only through a confirming dialog (to a folder, or as a zip the browser downloads),
// unpublished to bring back the previous publish, rolled back by publishing an earlier version,
// and deleted only when it is not published.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SitesView } from '../src/spaces/SitesView.tsx';
import {
  dataSourceView,
  publishView,
  renderWithSpaces,
  siteVersionView,
  siteView,
  spaceView,
  type M6SpacesState,
} from './fakes-m6-spaces.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const BASE: Partial<M6SpacesState> = {
  spaces: [spaceView({ id: 'sp1', name: 'Handbook' })],
  dataSources: [dataSourceView({ id: 'src1', name: 'sales.csv', projectName: 'Reports' })],
  artifacts: [{ id: 'art1', title: 'Landing page', html: true }],
};

/** A site with versions 1 and 2; version 1 was published, then version 2 replaced it. */
function publishedSite(): Partial<M6SpacesState> {
  return {
    ...BASE,
    sites: [
      siteView({
        id: 'site1',
        name: 'Handbook site',
        latestVersion: 2,
        publishedVersion: 2,
        publishedTarget: { kind: 'folder', folder: 'handbook' },
        publishedAt: '2026-10-01T13:00:00.000Z',
      }),
    ],
    siteVersions: [
      siteVersionView({ version: 1, note: 'First' }),
      siteVersionView({ version: 2, note: 'Second' }),
    ],
    publishes: [
      publishView({
        id: 'pub1',
        version: 1,
        target: { kind: 'folder', folder: 'handbook' },
        current: false,
        createdAt: '2026-10-01T12:30:00.000Z',
      }),
      publishView({
        id: 'pub2',
        version: 2,
        target: { kind: 'folder', folder: 'handbook' },
        current: true,
        createdAt: '2026-10-01T13:00:00.000Z',
      }),
    ],
  };
}

/** Record anchor clicks instead of letting jsdom try to navigate. */
function captureDownloads() {
  const clicks: { href: string; download: string }[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.getAttribute('href') ?? '', download: this.download });
  });
  return clicks;
}

const frame = () => document.querySelector('iframe')!;

describe('the list of sites (FR-037)', () => {
  it('creates a site from a space with connected data, checking data names', async () => {
    const { api } = await renderWithSpaces(<SitesView siteId={null} />, { spaces: BASE });
    expect(await screen.findByRole('heading', { name: 'No sites yet' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Create a site' }));
    const dialog = screen.getByRole('dialog', { name: 'New site' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Team handbook');
    expect(await within(dialog).findByRole('combobox', { name: 'Space' })).toHaveProperty(
      'value',
      'sp1',
    );
    await userEvent.click(
      await within(dialog).findByRole('checkbox', { name: 'Connect sales.csv (Reports)' }),
    );
    const dataName = within(dialog).getByLabelText('Name for sales.csv (Reports)');
    expect((dataName as HTMLInputElement).value).toBe('sales');
    await userEvent.clear(dataName);
    await userEvent.type(dataName, 'Sales!');
    expect(within(dialog).getByRole('alert').textContent).toContain('lowercase letters');
    const create = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Create site' });
    expect(create.disabled).toBe(true);
    await userEvent.clear(dataName);
    await userEvent.type(dataName, 'sales_2026');
    await userEvent.click(create);
    expect(api.createSite).toHaveBeenCalledWith({
      name: 'Team handbook',
      source: { kind: 'space', spaceId: 'sp1' },
      data: [{ sourceId: 'src1', name: 'sales_2026' }],
    });
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/sites\/site-\d+$/));
  });

  it('creates a site from an artifact and shows a Hub refusal', async () => {
    const { api } = await renderWithSpaces(<SitesView siteId={null} />, { spaces: BASE });
    await userEvent.click(await screen.findByRole('button', { name: 'New site' }));
    const dialog = screen.getByRole('dialog', { name: 'New site' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Landing');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'An artifact' }));
    await userEvent.type(within(dialog).getByLabelText('Artifact id'), 'missing');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create site' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'No artifact with that id.',
    );
    const id = within(dialog).getByLabelText('Artifact id');
    await userEvent.clear(id);
    await userEvent.type(id, 'art1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create site' }));
    expect(api.createSite).toHaveBeenLastCalledWith({
      name: 'Landing',
      source: { kind: 'artifact', artifactId: 'art1' },
      data: [],
    });
  });

  it('lists sites with their source, latest version and where they are published', async () => {
    await renderWithSpaces(<SitesView siteId={null} />, {
      spaces: {
        ...publishedSite(),
        sites: [
          ...publishedSite().sites!,
          siteView({ id: 'site2', name: 'Draft', sourceLabel: null }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: 'Sites' });
    const [a, b] = within(list).getAllByRole('listitem');
    expect(a!.textContent).toContain('From the space “Handbook”');
    expect(a!.textContent).toContain('Version 2');
    expect(a!.textContent).toContain('Version 2 published to the folder “handbook”');
    expect(b!.textContent).toContain('From a space that is gone');
    expect(b!.textContent).toContain('Not built yet');
    expect(b!.textContent).toContain('Not published');
  });
});

describe('a site (FR-037)', () => {
  it('builds a version and previews it in a frame without scripts or same-origin', async () => {
    const { api } = await renderWithSpaces(<SitesView siteId="site1" />, {
      spaces: { ...BASE, sites: [siteView({ id: 'site1' })] },
    });
    expect(await screen.findByText(/Not built yet/)).toBeTruthy();
    expect(screen.getByText(/Not published\. Publishing is always your choice/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Note for the new version (optional)'), 'First');
    await userEvent.click(screen.getByRole('button', { name: 'Build new version' }));
    expect(api.buildSite).toHaveBeenCalledWith('site1', { note: 'First' });
    const versions = await screen.findByRole('list', { name: 'Versions' });
    expect(within(versions).getByText('First')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Preview of version 1' })).toBeTruthy();
    const f = frame();
    expect(f.getAttribute('src')).toBe('/api/v1/sites/site1/versions/1/preview');
    expect(f.getAttribute('sandbox')).toBe('');
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(f.getAttribute('title')).toBe('Preview of Handbook site, version 1');
    const zip = within(versions).getByRole('link', { name: 'Download version 1 as a zip' });
    expect(zip.getAttribute('href')).toBe('/api/v1/sites/site1/versions/1/zip');
    expect(zip.hasAttribute('download')).toBe(true);
  });

  it('lets an HTML artifact’s own scripts run in the preview, still never same-origin', async () => {
    await renderWithSpaces(<SitesView siteId="site1" />, {
      spaces: {
        ...BASE,
        sites: [siteView({ id: 'site1', source: { kind: 'artifact', artifactId: 'art1' } })],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Build new version' }));
    await screen.findByRole('heading', { name: 'Preview of version 1' });
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame().getAttribute('sandbox')).not.toContain('same-origin');
    expect(screen.getByText(/its own scripts run in the preview/)).toBeTruthy();
  });

  it('publishes only after the confirming dialog, to a folder', async () => {
    const { api, state } = await renderWithSpaces(<SitesView siteId="site1" />, {
      spaces: {
        ...BASE,
        sites: [siteView({ id: 'site1', name: 'Team Handbook', latestVersion: 1 })],
        siteVersions: [siteVersionView({ version: 1 })],
        foreignFolders: ['taken'],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Publish version 1' }));
    let dialog = screen.getByRole('dialog', { name: 'Publish version 1?' });
    expect(dialog.textContent).toContain('You can unpublish to bring back what was there before.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.publishSite).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Publish version 1' }));
    dialog = screen.getByRole('dialog', { name: 'Publish version 1?' });
    const folder = within(dialog).getByLabelText('Folder name');
    expect((folder as HTMLInputElement).value).toBe('team-handbook');
    await userEvent.clear(folder);
    await userEvent.type(folder, 'Bad Name');
    expect(within(dialog).getByRole('alert').textContent).toContain('lowercase letters');
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Publish version 1' }).disabled,
    ).toBe(true);
    await userEvent.clear(folder);
    await userEvent.type(folder, 'taken');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish version 1' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'That folder holds files Nova did not put there',
    );
    await userEvent.clear(folder);
    await userEvent.type(folder, 'handbook');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish version 1' }));
    expect(api.publishSite).toHaveBeenLastCalledWith('site1', {
      version: 1,
      target: { kind: 'folder', folder: 'handbook' },
      confirm: true,
    });
    expect((await screen.findByRole('status')).textContent).toBe(
      'Version 1 is published in the folder /data/sites/handbook.',
    );
    const live = screen.getByRole('region', { name: 'Publishing' });
    expect(live.textContent).toContain('Live: version 1, published to the folder “handbook”');
    expect(state.sites[0]!.publishedVersion).toBe(1);
    expect(await screen.findByRole('list', { name: 'Publish history' })).toBeTruthy();
  });

  it('publishes as a zip and starts the download', async () => {
    const clicks = captureDownloads();
    await renderWithSpaces(<SitesView siteId="site1" />, {
      spaces: {
        ...BASE,
        sites: [siteView({ id: 'site1', name: 'Handbook site', latestVersion: 1 })],
        siteVersions: [siteVersionView({ version: 1 })],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Publish version 1' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Download as a zip' }));
    expect(within(dialog).queryByLabelText('Folder name')).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish version 1' }));
    await waitFor(() =>
      expect(clicks).toEqual([
        { href: '/api/v1/sites/site1/versions/1/zip', download: 'handbook-site-v1.zip' },
      ]),
    );
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Version 1 is published as a zip.');
    expect(
      within(status).getByRole('link', { name: 'Download it again' }).getAttribute('href'),
    ).toBe('/api/v1/sites/site1/versions/1/zip');
  });

  it('unpublishes to bring back the previous publish, then nothing', async () => {
    const { api } = await renderWithSpaces(<SitesView siteId="site1" />, {
      spaces: publishedSite(),
    });
    const live = await screen.findByRole('region', { name: 'Publishing' });
    expect(live.textContent).toContain('Live: version 2');
    await userEvent.click(within(live).getByRole('button', { name: 'Unpublish' }));
    const dialog = screen.getByRole('dialog', { name: 'Unpublish version 2?' });
    expect(dialog.textContent).toContain('What was published before comes back');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unpublish' }));
    expect(api.unpublishSite).toHaveBeenCalledWith('site1');
    expect(await screen.findByText('Unpublished. Version 1 is live again.')).toBeTruthy();
    const history = await screen.findByRole('list', { name: 'Publish history' });
    await waitFor(() => expect(history.textContent).toContain('Undone'));
    expect(live.textContent).toContain('Live: version 1');

    await userEvent.click(within(live).getByRole('button', { name: 'Unpublish' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Unpublish version 1?' })).getByRole('button', {
        name: 'Unpublish',
      }),
    );
    expect(await screen.findByText('Unpublished. Nothing is published now.')).toBeTruthy();
    expect(live.textContent).toContain('Not published');
  });

  it('rolls back by publishing an earlier version', async () => {
    const { api } = await renderWithSpaces(<SitesView siteId="site1" />, {
      spaces: publishedSite(),
    });
    const versions = await screen.findByRole('list', { name: 'Versions' });
    const [v2, v1] = within(versions).getAllByRole('listitem');
    expect(within(v2!).getByText('Live')).toBeTruthy();
    await userEvent.click(within(v1!).getByRole('button', { name: 'Preview version 1' }));
    expect(frame().getAttribute('src')).toBe('/api/v1/sites/site1/versions/1/preview');
    await userEvent.click(within(v1!).getByRole('button', { name: 'Publish this version (1)' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish version 1?' });
    expect(dialog.textContent).toContain('publishing it rolls the site back');
    // The folder it is published in is the default.
    expect(within(dialog).getByLabelText<HTMLInputElement>('Folder name').value).toBe('handbook');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Publish version 1' }));
    expect(api.publishSite).toHaveBeenCalledWith('site1', {
      version: 1,
      target: { kind: 'folder', folder: 'handbook' },
      confirm: true,
    });
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Publishing' }).textContent).toContain(
        'Live: version 1',
      ),
    );
  });

  it('refuses to delete a published site, and deletes one that is not', async () => {
    const { api, state } = await renderWithSpaces(<SitesView siteId="site1" />, {
      spaces: publishedSite(),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this site?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete site' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This site is published. Unpublish it first, then delete it.',
    );
    expect(state.sites).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // Unpublish both publishes, then delete.
    state.sites = state.sites.map((s) => ({ ...s, publishedVersion: null, publishedTarget: null }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete site' }));
    await waitFor(() => expect(window.location.pathname).toBe('/sites'));
    expect(api.deleteSite).toHaveBeenCalledTimes(2);
    expect(state.sites).toEqual([]);
  });

  it('edits the name and the connected data', async () => {
    const { api } = await renderWithSpaces(<SitesView siteId="site1" />, {
      spaces: publishedSite(),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit site' });
    expect(dialog.textContent).toContain('From the space “Handbook”');
    const name = within(dialog).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Public handbook');
    await userEvent.click(
      await within(dialog).findByRole('checkbox', { name: 'Connect sales.csv (Reports)' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(api.updateSite).toHaveBeenCalledWith('site1', {
      name: 'Public handbook',
      data: [{ sourceId: 'src1', name: 'sales' }],
    });
    expect(await screen.findByRole('heading', { name: 'Public handbook', level: 1 })).toBeTruthy();
    expect(screen.getByText('Data: sales')).toBeTruthy();
  });

  it('says when the site is gone', async () => {
    await renderWithSpaces(<SitesView siteId="nope" />, { spaces: BASE });
    expect(await screen.findByRole('heading', { name: 'Site not found' })).toBeTruthy();
  });
});
