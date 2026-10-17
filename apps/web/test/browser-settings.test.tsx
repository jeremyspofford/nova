// Settings → Browser (FR-094, FR-086, FR-096; docs/11 §4.4, §9): the browser's availability, sign-in
// requests (a notification's ?signin= link focuses one), sites with a level each and a developer-
// protocol mode that asks first and follows the policy setting, blocking and unblocking, the plain
// allow and block lists, saved logins that never show a password, and the browser settings with
// managed locks.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSettings, parseList, patternProblem } from '../src/browser/BrowserSettings.tsx';
import {
  createBrowserHub,
  loginView,
  renderWithBrowser,
  signinView,
  siteView,
} from './fakes-m6-browser.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const SEEN = { ignore: 'script, style, .nv-vh' };

describe('patterns', () => {
  it('accepts hosts and leftmost wildcards, never a bare *', () => {
    expect(patternProblem('example.com')).toBeNull();
    expect(patternProblem('*.example.com')).toBeNull();
    expect(patternProblem('*')).toMatch(/host/);
    expect(patternProblem('https://example.com/x')).toMatch(/host/);
    expect(parseList('a.com\n\n B.com , bad host,a.com')).toEqual({
      patterns: ['a.com', 'b.com'],
      invalid: ['bad host'],
    });
  });
});

describe('the agent browser', () => {
  it('says when it is ready, and why it is not', async () => {
    await renderWithBrowser(<BrowserSettings />);
    expect(await screen.findByText('Ready on this Hub.')).toBeTruthy();
    resetDom();
    await renderWithBrowser(<BrowserSettings />, {
      browser: {
        status: {
          available: false,
          detail: 'chromium was not found',
          driver: 'playwright',
          egress: 'wired',
        },
      },
    });
    expect(await screen.findByText(/Not available: Chromium was not found\./)).toBeTruthy();
  });

  it('shows a status error with Retry', async () => {
    await renderWithBrowser(<BrowserSettings />, {
      fail: { browserStatus: new Error('the Hub restarted') },
    });
    expect(await screen.findByText('the Hub restarted')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);
    expect(await screen.findByText('Ready on this Hub.')).toBeTruthy();
  });

  it('focuses the sign-in a notification links to', async () => {
    window.history.replaceState(null, '', '/settings/browser?signin=si2');
    await renderWithBrowser(<BrowserSettings />, {
      browser: {
        signins: [
          signinView({ id: 'si1', host: 'a.example.com' }),
          signinView({ id: 'si2', host: 'b.example.com' }),
        ],
      },
    });
    const form = (await screen.findByRole('heading', { name: /b\.example\.com/ })).closest(
      'section',
    )!;
    await waitFor(() =>
      expect(document.activeElement).toBe(within(form).getByLabelText('Username or email')),
    );
  });

  it('says when no sign-in waits', async () => {
    await renderWithBrowser(<BrowserSettings />);
    expect(await screen.findByText('No sign-in requests are waiting.')).toBeTruthy();
  });
});

describe('sites', () => {
  it('adds an allowed site with a level, rejecting a bad pattern first', async () => {
    const { fake, state } = await renderWithBrowser(<BrowserSettings />);
    expect(await screen.findByText(/No sites allowed yet/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Site'), '*');
    await userEvent.click(screen.getByRole('button', { name: 'Add site' }));
    expect(await screen.findByText(/Enter a host such as/)).toBeTruthy();
    expect(fake.api.putBrowserSite).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText('Site'));
    await userEvent.type(screen.getByLabelText('Site'), 'Shop.Example.com');
    await userEvent.selectOptions(screen.getByLabelText('Level'), 'auto_review');
    await userEvent.click(screen.getByRole('button', { name: 'Add site' }));
    await waitFor(() =>
      expect(fake.api.putBrowserSite).toHaveBeenCalledWith({
        pattern: 'Shop.Example.com',
        access: 'allow',
        level: 'auto_review',
      }),
    );
    const list = await screen.findByRole('list', { name: 'Allowed sites' });
    const row = within(list).getByRole('listitem', { name: 'shop.example.com' });
    expect(within(row).getByLabelText<HTMLSelectElement>('Level for shop.example.com').value).toBe(
      'auto_review',
    );
    expect(state.sites[0]!.level).toBe('auto_review');
  });

  it('changes a level, blocks a site, and unblocks it after a confirmation', async () => {
    const { fake, state } = await renderWithBrowser(<BrowserSettings />, {
      browser: { sites: [siteView({ pattern: 'example.com' })] },
    });
    await userEvent.selectOptions(
      await screen.findByLabelText('Level for example.com'),
      'always_allow',
    );
    await waitFor(() =>
      expect(fake.api.patchBrowserSite).toHaveBeenCalledWith('example.com', {
        level: 'always_allow',
      }),
    );
    await userEvent.type(screen.getByLabelText('Site'), 'ads.example.net');
    await userEvent.selectOptions(screen.getByLabelText('Access'), 'block');
    expect(screen.queryByLabelText('Level')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Add site' }));
    const blocked = await screen.findByRole('list', { name: 'Blocked sites' });
    await userEvent.click(within(blocked).getByRole('button', { name: 'Unblock ads.example.net' }));
    const dialog = screen.getByRole('dialog', { name: 'Unblock ads.example.net?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unblock' }));
    await waitFor(() => expect(fake.api.deleteBrowserSite).toHaveBeenCalledWith('ads.example.net'));
    expect(state.sites.map((s) => s.pattern)).toEqual(['example.com']);
    expect(await screen.findByText('No sites blocked.')).toBeTruthy();
  });

  it('removes an allowed site after a confirmation', async () => {
    const { state } = await renderWithBrowser(<BrowserSettings />, {
      browser: { sites: [siteView({ pattern: 'example.com' })] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove example.com' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove example.com?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(/No sites allowed yet/)).toBeTruthy();
    expect(state.sites).toHaveLength(0);
  });

  it('asks before turning on developer protocol, and turns it off directly', async () => {
    const { fake } = await renderWithBrowser(<BrowserSettings />, {
      browser: { sites: [siteView({ pattern: 'dev.example.com' })] },
    });
    const sw = await screen.findByRole('switch', {
      name: 'Developer protocol for dev.example.com',
    });
    await userEvent.click(sw);
    const dialog = screen.getByRole('dialog', { name: /Turn on developer protocol/ });
    expect(dialog.textContent).toContain('run scripts');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(fake.api.patchBrowserSite).toHaveBeenCalledWith('dev.example.com', {
        devProtocol: true,
      }),
    );
    await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe('true'));
    await userEvent.click(sw);
    await waitFor(() =>
      expect(fake.api.patchBrowserSite).toHaveBeenLastCalledWith('dev.example.com', {
        devProtocol: false,
      }),
    );
  });

  it('cannot turn on developer protocol while the setting is off', async () => {
    await renderWithBrowser(<BrowserSettings />, {
      browser: { sites: [siteView({ pattern: 'dev.example.com' })] },
      managed: { 'browser.devProtocol': false },
    });
    const sw = await screen.findByRole('switch', {
      name: 'Developer protocol for dev.example.com',
    });
    expect(sw).toHaveProperty('disabled', true);
    expect(
      screen.getByText(/Developer protocol is turned off for every site/).textContent,
    ).toContain('managed by your organization');
  });

  it('follows the Hub’s refusals (the fake mirrors them)', async () => {
    const { api, state } = createBrowserHub({}, () => ({ 'browser.devProtocol': false }));
    await expect(api.putBrowserSite({ pattern: '*' })).rejects.toMatchObject({ status: 400 });
    await expect(
      api.putBrowserSite({ pattern: 'a.com', access: 'block', devProtocol: true }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(api.putBrowserSite({ pattern: 'a.com', devProtocol: true })).rejects.toMatchObject(
      {
        status: 403,
        body: { code: 'policy_denied' },
      },
    );
    await api.putBrowserSite({ pattern: 'b.com', access: 'block' });
    await expect(api.patchBrowserSite('b.com', { level: 'always_allow' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(api.patchBrowserSite('zzz.com', { level: 'always_allow' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(api.deleteBrowserLogin('nope')).rejects.toMatchObject({ status: 404 });
    await expect(api.closeBrowserSession('pc1')).rejects.toMatchObject({ status: 404 });
    // Deny wins when a host is on both lists.
    expect(await api.setBrowserDomains({ allow: ['x.com', 'b.com'], deny: ['b.com'] })).toEqual({
      allow: ['x.com'],
      deny: ['b.com'],
    });
    expect(state.sites.find((s) => s.pattern === 'x.com')!.level).toBe('always_ask');
  });

  it('edits the lists as plain text, refusing lines that are not hosts', async () => {
    const { fake } = await renderWithBrowser(<BrowserSettings />, {
      browser: {
        sites: [
          siteView({ pattern: 'example.com', level: 'always_allow' }),
          siteView({ pattern: 'ads.example.net', access: 'block', level: null }),
        ],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit as lists' }));
    const allow = await screen.findByLabelText<HTMLTextAreaElement>('Allowed, one per line');
    expect(allow.value).toBe('example.com');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Blocked, one per line').value).toBe(
      'ads.example.net',
    );
    await userEvent.type(allow, '\nnot a host');
    expect(await screen.findByText(/Not a host: not a host/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save lists' })).toHaveProperty('disabled', true);
    await userEvent.clear(allow);
    await userEvent.type(allow, 'example.com\nnews.example.org');
    await userEvent.click(screen.getByRole('button', { name: 'Save lists' }));
    await waitFor(() =>
      expect(fake.api.setBrowserDomains).toHaveBeenCalledWith({
        allow: ['example.com', 'news.example.org'],
        deny: ['ads.example.net'],
      }),
    );
    const list = await screen.findByRole('list', { name: 'Allowed sites' });
    expect(within(list).getByRole('listitem', { name: 'news.example.org' })).toBeTruthy();
    // The site that stayed keeps its level.
    expect(within(list).getByLabelText<HTMLSelectElement>('Level for example.com').value).toBe(
      'always_allow',
    );
  });

  it('shows a load error with Retry', async () => {
    await renderWithBrowser(<BrowserSettings />, {
      browser: { sites: [siteView()] },
      fail: { listBrowserSites: new Error('Failed to fetch') },
    });
    const alert = await screen.findByText(/Cannot reach the Hub/);
    await userEvent.click(within(alert.closest('div')!).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Allowed sites' })).toBeTruthy();
  });

  it('says why a change was refused and reloads the sites', async () => {
    const { fake } = await renderWithBrowser(<BrowserSettings />, {
      browser: { sites: [siteView({ pattern: 'example.com' })] },
    });
    fake.failNext.patchBrowserSite = new Error('the site is gone');
    await userEvent.selectOptions(
      await screen.findByLabelText('Level for example.com'),
      'always_allow',
    );
    expect(
      await screen.findByText('Could not change example.com: The site is gone.', SEEN),
    ).toBeTruthy();
    await waitFor(() => expect(fake.api.listBrowserSites).toHaveBeenCalledTimes(2));
  });
});

describe('saved logins', () => {
  it('lists logins without passwords and deletes one after a confirmation', async () => {
    const { fake, state } = await renderWithBrowser(<BrowserSettings />, {
      browser: { logins: [loginView({ id: 'lg1', username: 'sam', host: 'shop.example.com' })] },
    });
    const row = await screen.findByRole('listitem', { name: 'sam on shop.example.com' });
    expect(row.textContent).toContain('Password saved');
    expect(within(row).queryByLabelText(/password/i)).toBeNull();
    await userEvent.click(
      within(row).getByRole('button', { name: 'Delete the login for sam on shop.example.com' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete the login for sam?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fake.api.deleteBrowserLogin).toHaveBeenCalledWith('lg1'));
    expect(await screen.findByText('No saved logins.')).toBeTruthy();
    expect(state.logins).toHaveLength(0);
  });

  it('says when a login could not be deleted', async () => {
    const { fake } = await renderWithBrowser(<BrowserSettings />, {
      browser: { logins: [loginView({ id: 'lg1', username: 'sam' })] },
    });
    fake.failNext.deleteBrowserLogin = new Error('the vault is locked');
    await userEvent.click(await screen.findByRole('button', { name: /Delete the login for sam/ }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(
      await screen.findByText('Could not delete the login: The vault is locked.', SEEN),
    ).toBeTruthy();
  });
});

describe('behavior', () => {
  it('saves the browser settings and shows managed locks', async () => {
    const { hub } = await renderWithBrowser(<BrowserSettings />, {
      managed: { 'browser.allowLocalSites': false },
    });
    await userEvent.click(
      await screen.findByRole('switch', { name: 'Keep the agent browser’s cookies' }),
    );
    await waitFor(() => expect(hub.state.settings['browser.persistCookies']).toBe(true));
    expect(
      screen.getByRole('switch', { name: 'Allow local and private-network sites' }),
    ).toHaveProperty('disabled', true);
    await userEvent.selectOptions(screen.getByLabelText('Browsers open at once'), '4');
    await waitFor(() => expect(hub.state.settings['browser.maxConcurrent']).toBe(4));
    const days = screen.getByLabelText('Keep action screenshots for (days)');
    await userEvent.clear(days);
    await userEvent.type(days, '0');
    expect(await screen.findByText('From 1 to 3650 days')).toBeTruthy();
    await userEvent.clear(days);
    await userEvent.type(days, '7');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(hub.state.settings['browser.screenshotRetentionDays']).toBe(7));
    await userEvent.click(
      screen.getByRole('switch', { name: 'Allow developer protocol per site' }),
    );
    await waitFor(() => expect(hub.state.settings['browser.devProtocol']).toBe(false));
  });
});
