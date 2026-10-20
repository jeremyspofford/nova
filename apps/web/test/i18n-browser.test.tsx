// The agent browser in the pseudo-locale (FR-016): a computer's browser panel (the open page after
// a crash, page tools, a pending sign-in, the recorded actions opened to their details, an external
// agent's refused page, a download, the page's console and network capture), the closed panel,
// Settings → Browser (status, sites with levels for projects and agents, the list editor, saved
// logins, behavior) and a project's own site levels show every word through messages. Page
// titles, addresses, hosts, targets, usernames, page content and the Hub's words are fixture data.
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it } from 'vitest';
import { BrowserPanel, PANEL_TEXT } from '../src/browser/BrowserPanel.tsx';
import { BROWSER_SETTINGS_TEXT, BrowserSettings } from '../src/browser/BrowserSettings.tsx';
import { CAPTURE_TEXT } from '../src/browser/PageCapture.tsx';
import { SITE_LEVELS_TEXT, ScopedSiteLevels } from '../src/browser/SiteLevels.tsx';
import { TRACE_TEXT } from '../src/browser/BrowserTrace.tsx';
import {
  browserActionView,
  loginView,
  sessionView,
  signinView,
  siteView,
} from './fakes-m6-browser.ts';
import { consoleEntry, networkEntry, renderM7 } from './fakes-m7-misc.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

const DATA = [
  'Your cart',
  'shop.example.com',
  'example.com',
  'button "Add to cart"',
  'link "invoice.pdf"',
  'the billing agent',
  'page:shop.example.com.checkout',
  'the page crashed',
  'The page crashed',
  // Full addresses: listed because their host is data too (data is removed before addresses).
  'https://shop.example.com/login',
  'https://shop.example.com/cart',
  'https://shop.example.com/app.js',
  'https://shop.example.com/item',
  'https://shop.example.com/api/cart',
  'Chromium 140',
  'Website redesign',
  'Research',
  'sam@example.com',
  'loaded',
  'fetch',
  'application/json',
  'accept',
  'content-type',
  'GET',
  '200 OK',
  'Desk PC',
  // The Hub's words for a refused write (English, D9).
  'An external AI agent ("the billing agent") wrote this page.',
  // An example host pattern in the add-site form.
  'example.com, *.example.com',
];

const T = '2026-10-01T12:00:05.000Z';

describe('the agent browser in a pseudo-locale', () => {
  it("shows a computer's open browser with its actions and capture", async () => {
    await activateTestLocale('en-XA');
    const { container } = await renderM7(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [
          sessionView({
            computerId: 'pc1',
            pageTools: ['page:shop.example.com.checkout'],
            crash: { at: T, reason: 'the page crashed' },
            restarts: 2,
          }),
        ],
        signins: [signinView({ computerId: 'pc1' })],
        actions: [
          browserActionView({ id: 'a1', computerId: 'pc1', createdAt: T }),
          browserActionView({
            id: 'a2',
            computerId: 'pc1',
            tool: 'browser.click',
            result: 'denied',
            error: 'An external AI agent ("the billing agent") wrote this page.',
            createdAt: T,
          }),
          browserActionView({
            id: 'a3',
            computerId: 'pc1',
            tool: 'browser.download',
            action: 'download',
            target: 'link "invoice.pdf"',
            createdAt: T,
          }),
          browserActionView({
            id: 'a4',
            computerId: 'pc1',
            tool: 'browser.crash',
            action: 'crash',
            result: 'error',
            target: null,
            host: null,
            createdAt: T,
          }),
        ],
      },
      misc: {
        console: {
          pc1: {
            items: [
              consoleEntry({ seq: 1, at: T }),
              consoleEntry({ seq: 2, level: 'error', source: 'pageerror', at: T }),
            ],
            dropped: 2,
          },
        },
        network: { pc1: { items: [networkEntry({ seq: 1, at: T })], dropped: 0 } },
      },
    });
    const actions = await screen.findByRole('list', { name: TRACE_TEXT.heading });
    await userEvent.click(within(actions).getAllByRole('button')[0]!);
    await screen.findByRole('list', { name: CAPTURE_TEXT.consoleList });
    expectFullyLocalized(container, { data: DATA });

    await userEvent.click(screen.getByRole('tab', { name: CAPTURE_TEXT.network }));
    const requests = await screen.findByRole('list', { name: CAPTURE_TEXT.requestsList });
    await userEvent.click(within(requests).getAllByRole('button')[0]!);
    expectFullyLocalized(container, { data: DATA });

    await userEvent.click(screen.getByRole('button', { name: PANEL_TEXT.close }));
    expectFullyLocalized(screen.getByRole('dialog', { name: PANEL_TEXT.closeTitle }), {
      data: DATA,
    });
  });

  it('shows the browser when it is not open', async () => {
    await activateTestLocale('en-XA');
    const { container } = await renderM7(<BrowserPanel computerId="pc1" />, {});
    await screen.findByRole('heading', { name: PANEL_TEXT.notOpen });
    expectFullyLocalized(container, { data: DATA });
  });

  it('shows Settings → Browser with sites, levels, lists and logins', async () => {
    await activateTestLocale('en-XA');
    const { container } = await renderM7(<BrowserSettings />, {
      projects: [{ id: 'p1', name: 'Website redesign' }],
      agents: [{ id: 'g1', name: 'Research' }],
      browser: {
        sites: [
          siteView({
            pattern: 'shop.example.com',
            scopedLevels: [
              { scopeKind: 'project', scopeRef: 'p1', level: 'always_allow' },
              { scopeKind: 'agent', scopeRef: 'gone', level: 'auto_review' },
            ],
          } as never),
          siteView({ pattern: 'example.com', access: 'block', level: null } as never),
        ],
        logins: [loginView({ username: 'sam@example.com' })],
        signins: [signinView()],
      },
    });
    const allowed = await screen.findByRole('list', {
      name: BROWSER_SETTINGS_TEXT.sites.allowedList,
    });
    await userEvent.click(within(allowed).getByText(SITE_LEVELS_TEXT.summary({ n: 2 })));
    await screen.findByRole('list', { name: BROWSER_SETTINGS_TEXT.logins.list });
    await userEvent.click(
      screen.getByRole('button', { name: BROWSER_SETTINGS_TEXT.sites.editLists }),
    );
    await screen.findByLabelText(BROWSER_SETTINGS_TEXT.lists.allowed);
    expectFullyLocalized(container, { data: DATA });
  });

  it("shows a project's own site levels", async () => {
    await activateTestLocale('en-XA');
    const { container } = await renderM7(
      <ScopedSiteLevels scopeKind="project" scopeRef="p1" scopeName="Website redesign" />,
      { browser: { sites: [siteView({ pattern: 'shop.example.com' })] } },
    );
    await screen.findByRole('list', {
      name: SITE_LEVELS_TEXT.listFor({ name: 'Website redesign' }),
    });
    expectFullyLocalized(container, { data: DATA });
  });
});
