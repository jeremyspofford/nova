// secret-scan: fake-file (fixture tokens, passwords and key headers only)
// The agent browser panel (FR-092, FR-096, FR-098, FR-086, FR-087, FR-208, FR-194): the open page
// as text, its frame from the Hub's route, the recorded actions with before/after screenshots,
// external-agent refusals and downloads called out, private sign-in (typed or a confirmed saved
// login; a late answer shows the Hub's 410 message), taking over the page over the live socket and
// returning control, and closing the session after a confirmation.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { BrowserPanel } from '../src/browser/BrowserPanel.tsx';
import {
  browserActionView,
  emitHub,
  fakeScreen,
  loginView,
  renderWithBrowser,
  sessionView,
  signinView,
  PNG_1X1,
} from './fakes-m6-browser.ts';
import { FakeSocket } from './fakes.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

/** Visible text only: the screen-reader announcer repeats messages in a hidden region. */
const SEEN = { ignore: 'script, style, .nv-vh' };

const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();

describe('the open page', () => {
  it('shows the page as text, the session state, page tools and the frame from the Hub', async () => {
    await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [
          sessionView({
            title: '<b>Cart</b>',
            url: 'https://shop.example.com/cart',
            pageTools: ['page:shop.example.com.checkout'],
          }),
        ],
      },
    });
    expect(await screen.findByText('<b>Cart</b>')).toBeTruthy();
    expect(screen.getByText('https://shop.example.com/cart')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /shop\.example\.com/ })).toBeNull();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('page:shop.example.com.checkout')).toBeTruthy();
    expect(screen.getByText('Cookies are cleared when it closes')).toBeTruthy();
    const img = screen.getByRole('img', { name: /agent browser showing/ });
    expect(img.getAttribute('src')).toMatch(
      /^\/api\/v1\/computers\/pc1\/screen\/frame\?surface=browser/,
    );
    // Refresh asks for a new frame.
    const before = img.getAttribute('src');
    await userEvent.click(screen.getByRole('button', { name: 'Refresh view' }));
    expect(screen.getByRole('img', { name: /agent browser showing/ }).getAttribute('src')).not.toBe(
      before,
    );
  });

  it('says when the frame cannot be shown', async () => {
    await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView()] },
    });
    const img = await screen.findByRole('img', { name: /agent browser showing/ });
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    expect(await screen.findByText('The page cannot be shown right now.')).toBeTruthy();
  });

  it('explains an empty browser, and why it cannot run when the Hub has none', async () => {
    await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: {
        status: {
          available: false,
          detail: 'the egress proxy is not running',
          driver: 'playwright',
          egress: 'missing',
        },
      },
    });
    expect(await screen.findByText('The browser is not open')).toBeTruthy();
    expect(
      screen.getByText(/cannot run on this Hub: The egress proxy is not running\./),
    ).toBeTruthy();
    expect(screen.getByText('Not open')).toBeTruthy();
  });

  it('shows a load error with Retry', async () => {
    const { fake } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView()] },
    });
    await screen.findByText('Your cart');
    fake.failNext.listBrowserSessions = new Error('Failed to fetch');
    emitHub('browser.navigated', { computerId: 'pc1', url: 'https://x', allowed: true });
    expect(await screen.findByText(/Cannot reach the Hub/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Your cart')).toBeTruthy();
  });

  it('refreshes when the page changes, ignoring other computers', async () => {
    const { fake, state } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView()] },
    });
    await screen.findByText('Your cart');
    const calls = fake.api.listBrowserSessions.mock.calls.length;
    emitHub('browser.navigated', { computerId: 'pc2', url: 'https://x', allowed: true });
    await new Promise((r) => setTimeout(r, 500));
    expect(fake.api.listBrowserSessions.mock.calls.length).toBe(calls);
    state.sessions = [sessionView({ title: 'Checkout' })];
    emitHub('browser.navigated', { computerId: 'pc1', url: 'https://x', allowed: true });
    expect(await screen.findByText('Checkout')).toBeTruthy();
  });
});

describe('the action trace', () => {
  it('lists actions newest first with before/after screenshots and the safety check', async () => {
    await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [sessionView()],
        actions: [
          browserActionView({
            id: 'a1',
            action: 'navigate',
            tool: 'browser.navigate',
            target: null,
            createdAt: at(1),
          }),
          browserActionView({
            id: 'a2',
            createdAt: at(2),
            target: 'button "Buy now"',
            result: 'handoff',
            before: true,
            after: false,
            classification: {
              effects: ['purchase'],
              flagged: true,
              reasons: ['looks like a purchase'],
              handoff: true,
            },
          }),
          browserActionView({ id: 'other', computerId: 'pc2', createdAt: at(3) }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: 'Browser actions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Click');
    expect(rows[0]!.textContent).toContain('Needs you');
    expect(rows[0]!.textContent).toContain('Flagged');
    expect(rows[1]!.textContent).toContain('Open page');
    await userEvent.click(within(rows[0]!).getByRole('button', { expanded: false }));
    expect(within(rows[0]!).getByText('looks like a purchase')).toBeTruthy();
    expect(within(rows[0]!).getByText(/This step needs you/)).toBeTruthy();
    const shot = within(rows[0]!).getByRole('img', { name: /Before: Click/ });
    expect(shot.getAttribute('src')).toBe('/api/v1/browser/actions/a2/screenshots/before');
    expect(within(rows[0]!).queryByRole('img', { name: /After/ })).toBeNull();
  });

  it('calls out refusals for pages written by an external agent, and lists downloads', async () => {
    await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [sessionView()],
        actions: [
          browserActionView({
            id: 'x1',
            result: 'denied',
            host: 'billing.example.net',
            error:
              'This page comes from an external AI agent ("the billing agent"): the user did not name it, so nothing is sent to it.',
          }),
          browserActionView({
            id: 'd1',
            tool: 'browser.download',
            action: 'download',
            target: 'link "invoice.pdf"',
          }),
        ],
      },
    });
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('Pages written by another AI agent');
    expect(note.textContent).toContain('(from “the billing agent”)');
    const downloads = screen.getByRole('list', { name: 'Downloads' });
    expect(downloads.textContent).toContain('link "invoice.pdf" from shop.example.com');
  });

  it('follows browser.action events and shows an empty trace with what it will hold', async () => {
    const { state } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView()] },
    });
    expect(await screen.findByText(/Nothing done in this browser yet/)).toBeTruthy();
    state.actions = [browserActionView({ id: 'n1', computerId: 'pc1' })];
    emitHub('browser.action', { computerId: 'pc1', actionId: 'n1' });
    expect(await screen.findByRole('list', { name: 'Browser actions' })).toBeTruthy();
  });

  it('pages older actions', async () => {
    const actions = Array.from({ length: 35 }, (_, i) =>
      browserActionView({
        id: `p${String(i).padStart(2, '0')}`,
        createdAt: at(i),
        target: `item ${i}`,
      }),
    );
    await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView()], actions },
    });
    const list = await screen.findByRole('list', { name: 'Browser actions' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
    await userEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(35);
  });
});

describe('private sign-in', () => {
  it('sends typed credentials to the browser only, saving the login when asked', async () => {
    const { fake, state } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [sessionView()],
        signins: [signinView({ id: 'si1' }), signinView({ id: 'si-other', computerId: 'pc2' })],
      },
    });
    expect(
      await screen.findByRole('heading', { name: /Sign in to shop.example.com/ }),
    ).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: /Sign in to/ })).toHaveLength(1);
    const submit = screen.getByRole('button', { name: 'Sign in' });
    expect(submit).toHaveProperty('disabled', true);
    await userEvent.type(screen.getByLabelText('Username or email'), 'sam@example.com');
    const pw = screen.getByLabelText('Password');
    expect(pw.getAttribute('type')).toBe('password');
    await userEvent.type(pw, 'hunter2!');
    await userEvent.click(screen.getByRole('checkbox', { name: /Save this login/ }));
    await userEvent.click(submit);
    await waitFor(() =>
      expect(fake.api.submitBrowserSignin).toHaveBeenCalledWith('si1', {
        username: 'sam@example.com',
        password: 'hunter2!',
        save: true,
      }),
    );
    expect(
      await screen.findByText(/Signed in to the site in the agent browser\./, SEEN),
    ).toBeTruthy();
    expect(state.logins).toHaveLength(1);
    expect(document.body.textContent).not.toContain('hunter2!');
    // The outcome stays until dismissed, then goes.
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Signed in to the site/, SEEN)).toBeNull();
  });

  it('reuses a saved login only after the user confirms it', async () => {
    const { fake } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [sessionView()],
        signins: [signinView({ id: 'si1', savedLogins: [{ id: 'lg1', username: 'sam' }] })],
      },
    });
    await userEvent.click(
      await screen.findByRole('radio', { name: 'Use the saved login for sam' }),
    );
    const go = screen.getByRole('button', { name: 'Sign in as sam' });
    expect(go).toHaveProperty('disabled', true);
    await userEvent.click(
      screen.getByRole('checkbox', { name: /Yes, sign in to shop.example.com as sam/ }),
    );
    await userEvent.click(go);
    await waitFor(() =>
      expect(fake.api.submitBrowserSignin).toHaveBeenCalledWith('si1', {
        loginId: 'lg1',
        confirm: true,
      }),
    );
  });

  it('shows the Hub’s message for a late answer (410) and clears the password', async () => {
    const { state } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView()], signins: [signinView({ id: 'si1' })] },
    });
    await userEvent.type(await screen.findByLabelText('Username or email'), 'sam');
    await userEvent.type(screen.getByLabelText('Password'), 'secret');
    state.signins = []; // it expired on the Hub meanwhile
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('This sign-in is no longer waiting.', SEEN)).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('reports a sign-in the site rejected', async () => {
    await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [sessionView()],
        signins: [signinView({ id: 'si1' })],
        signinResult: { state: 'failed', message: 'the site said the password is wrong' },
      },
    });
    await userEvent.type(await screen.findByLabelText('Username or email'), 'sam');
    await userEvent.type(screen.getByLabelText('Password'), 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(
      await screen.findByText(
        'Signing in did not work: The site said the password is wrong.',
        SEEN,
      ),
    ).toBeTruthy();
  });

  it('cancels a sign-in, and an expired form cannot be sent', async () => {
    const { fake } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [sessionView()],
        signins: [
          signinView({ id: 'si1', host: 'a.example.com' }),
          signinView({ id: 'si2', host: 'b.example.com', expiresAt: at(0) }),
        ],
      },
    });
    const late = (await screen.findByRole('heading', { name: /b\.example\.com/ })).closest(
      'section',
    )!;
    expect(within(late).getByText(/This sign-in expired/)).toBeTruthy();
    expect(within(late).getByRole('button', { name: 'Sign in' })).toHaveProperty('disabled', true);
    const a = screen.getByRole('heading', { name: /a\.example\.com/ }).closest('section')!;
    await userEvent.click(within(a).getByRole('button', { name: 'Don’t sign in' }));
    await waitFor(() => expect(fake.api.cancelBrowserSignin).toHaveBeenCalledWith('si1'));
    expect(await screen.findByText(/You did not sign in to a.example.com/, SEEN)).toBeTruthy();
  });

  it('keeps the form and says why when the Hub rejects the answer', async () => {
    const { fake } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [sessionView()],
        signins: [signinView({ id: 'si1' })],
        logins: [loginView()],
      },
    });
    fake.failNext.submitBrowserSignin = new ApiError(400, {
      code: 'validation',
      message: 'that saved login is not for this site',
      retryable: false,
    });
    await userEvent.type(await screen.findByLabelText('Username or email'), 'sam');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('That saved login is not for this site.')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toHaveProperty('value', '');
  });
});

describe('takeover and closing', () => {
  it('takes over the page over the live socket and returns control', async () => {
    const { fake, state } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView()] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Take over the browser' }));
    await waitFor(() => expect(fake.api.startTakeover).toHaveBeenCalledWith('pc1', 'browser'));
    expect(await screen.findByText('You have the agent browser.')).toBeTruthy();
    const ws = FakeSocket.for('/api/v1/computers/pc1/screen/live?surface=browser');
    ws.open();
    ws.frame({
      type: 'frame',
      surface: 'browser',
      mime: 'image/png',
      image: PNG_1X1,
      takenAt: at(5),
    });
    const img = await screen.findByRole('img', { name: 'Live view of the agent browser' });
    vi.spyOn(img, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 200,
      height: 100,
      right: 200,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(img, 'naturalWidth', { value: 1000 });
    Object.defineProperty(img, 'naturalHeight', { value: 500 });
    await userEvent.pointer({
      target: img,
      coords: { clientX: 50, clientY: 20 },
      keys: '[MouseLeft]',
    });
    expect(ws.sent).toContainEqual({ type: 'input', browser: { kind: 'click', x: 250, y: 100 } });
    await userEvent.type(screen.getByLabelText('Type text'), 'hello{Enter}');
    expect(ws.sent).toContainEqual({ type: 'input', browser: { kind: 'type', text: 'hello' } });
    await userEvent.click(screen.getByRole('button', { name: 'Return control' }));
    await waitFor(() => expect(fake.api.endTakeover).toHaveBeenCalledWith('pc1'));
    expect(state.screens.pc1!.takeover).toBeNull();
    expect(await screen.findByRole('button', { name: 'Take over the browser' })).toBeTruthy();
  });

  it('says why a takeover was refused', async () => {
    await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView()], screens: { pc1: fakeScreen({ browser: false }) } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Take over the browser' }));
    expect(
      await screen.findByText(/This computer has no browser the user can take over\./),
    ).toBeTruthy();
  });

  it('closes the session after a confirmation, and tells when it was already closed', async () => {
    const { fake, state } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView()] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Close browser' }));
    const dialog = screen.getByRole('dialog', { name: 'Close the agent browser?' });
    expect(dialog.textContent).toContain('cookies are cleared');
    state.sessions = []; // closed meanwhile
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close browser' }));
    await waitFor(() => expect(fake.api.closeBrowserSession).toHaveBeenCalledWith('pc1'));
    expect(await screen.findByText('The browser was already closed.')).toBeTruthy();
    expect(screen.getByText('The browser is not open')).toBeTruthy();
  });

  it('closes an open session', async () => {
    const { state } = await renderWithBrowser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView({ persistCookies: true })] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Close browser' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('Its cookies are kept');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close browser' }));
    expect(await screen.findByText('Browser closed.')).toBeTruthy();
    expect(state.sessions).toHaveLength(0);
  });
});
