// Settings → Browser in M7.5 (FR-209, FR-096): the switch that offers to continue a blocked site on
// the agent's computer, the consents (per agent or chat, computer and site; revoked after a
// confirmation, a refusal kept in the dialog, revoked ones on demand), the extension bridge's two
// switches (managed policy locks them), and where history searches are listed. And the browser panel:
// a note while the agent works on a computer's browser, and the trace rows recorded there marked
// with the computer and the profile.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { BrowserPanel } from '../src/browser/BrowserPanel.tsx';
import { BrowserSettings } from '../src/browser/BrowserSettings.tsx';
import { browserActionView, emitHub, sessionView } from './fakes-m6-browser.ts';
import { consentView, fallbackSessionView, renderM75Browser } from './fakes-m75-browser.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const at = (m: number) => new Date(Date.UTC(2026, 9, 2, 9, m, 0)).toISOString();

async function fallbackSection() {
  const h = await screen.findByRole('heading', { name: 'Continue on your computer' });
  return within(h.closest('section')!);
}
async function bridgeSection() {
  const h = await screen.findByRole('heading', { name: 'Your own browser (extension bridge)' });
  return within(h.closest('section')!);
}

describe('continuing on your computer (Settings → Browser)', () => {
  it('lists the consents with their computer, profile and scope, and revokes one after asking', async () => {
    const { api, state } = await renderM75Browser(<BrowserSettings />, {
      agents: [{ id: 'ag1', name: 'Shopper' }],
      m75: {
        consents: [
          consentView({ id: 'c1', site: 'shop.example', createdAt: at(1) }),
          consentView({
            id: 'c2',
            site: 'news.example',
            profile: 'extension',
            scopeKind: 'thread',
            scopeRef: 't9',
            deviceName: null,
            createdAt: at(2),
          }),
        ],
        sessions: [fallbackSessionView({ id: 's1', consentId: 'c1' })],
      },
    });
    const s = await fallbackSection();
    const list = within(
      await s.findByRole('list', { name: 'Sites agents may continue on a computer' }),
    );
    const shop = within(list.getByRole('listitem', { name: 'shop.example on Desk PC' }));
    expect(shop.getByText('Clean profile')).toBeTruthy();
    expect(shop.getByRole('link', { name: 'Shopper' }).getAttribute('href')).toBe('/agents/ag1');
    const news = within(
      list.getByRole('listitem', { name: 'news.example on a computer that left' }),
    );
    expect(news.getByText('Your own browser')).toBeTruthy();
    expect(news.getByRole('link', { name: 'One chat' }).getAttribute('href')).toBe('/chat/t9');

    await userEvent.click(s.getByRole('button', { name: 'Revoke shop.example on Desk PC' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke shop.example on Desk PC?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog.textContent).toContain('A session running on it stops now.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(api.revokeFallbackConsent).toHaveBeenCalledWith('c1');
    await waitFor(() =>
      expect(list.queryByRole('listitem', { name: 'shop.example on Desk PC' })).toBeNull(),
    );
    expect(state.consents.find((c) => c.id === 'c1')!.revokedAt).toBeTruthy();
    // The session on it ended.
    expect(state.sessions[0]!.endReason).toBe('consent_revoked');

    await userEvent.click(s.getByRole('button', { name: 'Show revoked' }));
    const revoked = within(await s.findByRole('list', { name: 'Revoked sites' }));
    expect(revoked.getByText('shop.example')).toBeTruthy();
    expect(api.listFallbackConsents).toHaveBeenLastCalledWith({ all: true });
  });

  it('keeps a refusal in the dialog and says when nothing is agreed yet', async () => {
    const { failNext } = await renderM75Browser(<BrowserSettings />, {
      m75: { consents: [consentView({ id: 'c1' })] },
    });
    const s = await fallbackSection();
    await userEvent.click(await s.findByRole('button', { name: 'Revoke example.com on Desk PC' }));
    failNext.revokeFallbackConsent = new ApiError(404, {
      code: 'not_found',
      message: 'consent not found',
      retryable: false,
    });
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'This consent no longer exists.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    resetDom();
    await renderM75Browser(<BrowserSettings />);
    const empty = await fallbackSection();
    expect(await empty.findByText(/None yet\./)).toBeTruthy();
    await userEvent.click(empty.getByRole('button', { name: 'Show revoked' }));
    expect(await empty.findByText('Nothing revoked.')).toBeTruthy();
  });

  it('shows a failed load with Retry, and follows the fallback events', async () => {
    const { state } = await renderM75Browser(<BrowserSettings />, {
      fail: {
        listFallbackConsents: new ApiError(500, {
          code: 'server_error',
          message: 'Hub is restarting',
          retryable: true,
        }),
      },
    });
    const s = await fallbackSection();
    const alert = await s.findByRole('alert');
    expect(alert.textContent).toContain('Hub is restarting');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await s.findByText(/None yet\./)).toBeTruthy();
    state.consents = [consentView({ id: 'c5', site: 'tickets.example' })];
    act(() => {
      emitHub('browser.fallback.changed', { consentId: 'c5', state: 'consent_granted' });
    });
    expect(await s.findByRole('listitem', { name: 'tickets.example on Desk PC' })).toBeTruthy();
  });

  it('switches the offer and the bridge, and says what managed policy locked', async () => {
    const { hub } = await renderM75Browser(<BrowserSettings />);
    const f = await fallbackSection();
    await userEvent.click(
      f.getByRole('switch', { name: 'Offer to continue on the agent’s computer' }),
    );
    await waitFor(() => expect(hub.state.settings['browser.localFallback']).toBe(false));
    const b = await bridgeSection();
    const bridge = b.getByRole('switch', {
      name: 'Let agents use your own browser through the extension',
    });
    const all = b.getByRole('switch', { name: 'Allow the “all sites” grant' });
    await userEvent.click(all);
    await waitFor(() => expect(hub.state.settings['browser.extensionBridgeAllSites']).toBe(false));
    await userEvent.click(bridge);
    await waitFor(() => expect(hub.state.settings['browser.extensionBridge']).toBe(false));
    // With the bridge off, "all sites" cannot be changed.
    await waitFor(() => expect((all as HTMLButtonElement).disabled).toBe(true));
    expect(b.getByRole('link', { name: 'Devices' }).getAttribute('href')).toBe('/devices');

    resetDom();
    await renderM75Browser(<BrowserSettings />, {
      managed: { 'browser.extensionBridge': false },
    });
    const locked = await bridgeSection();
    expect(
      locked.getByRole('switch', {
        name: 'Let agents use your own browser through the extension',
      }),
    ).toHaveProperty('disabled', true);
    expect(locked.getByText(/the bridge is off on every computer/)).toBeTruthy();
  });

  it('says history searches are asked each time and listed per computer', async () => {
    await renderM75Browser(<BrowserSettings />);
    const b = await bridgeSection();
    expect(
      b.getByText(/each search an agent asks for opens a prompt in your browser/),
    ).toBeTruthy();
    expect(b.getByText(/Each computer’s page lists its recent searches\./)).toBeTruthy();
  });

  it('leaves both sections out for a client without the calls', async () => {
    await renderM75Browser(<BrowserSettings />, { without: true });
    expect(await screen.findByRole('heading', { name: 'Behavior' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Continue on your computer' })).toBeNull();
    expect(
      screen.queryByRole('heading', { name: 'Your own browser (extension bridge)' }),
    ).toBeNull();
  });
});

describe('the browser panel while the agent works on a computer’s browser', () => {
  const marked = (over: Parameters<typeof browserActionView>[0], profile: 'clean' | 'extension') =>
    ({
      ...browserActionView(over),
      localFallback: { sessionId: 's1', deviceId: 'd1', profile },
    }) as ReturnType<typeof browserActionView>;

  it('says where it works and marks the rows recorded there', async () => {
    await renderM75Browser(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [sessionView({ computerId: 'pc1' })],
        actions: [
          browserActionView({ id: 'own', computerId: 'pc1', createdAt: at(1), target: 'home' }),
          marked({ id: 'fb', computerId: 'pc1', createdAt: at(2), target: 'cart' }, 'clean'),
        ],
      },
      m75: {
        consents: [consentView({ id: 'c1', deviceName: 'Desk PC' })],
        sessions: [
          fallbackSessionView({
            id: 's1',
            computerId: 'pc1',
            site: 'shop.example',
            consentId: 'c1',
          }),
        ],
      },
    });
    const note = await screen.findByText(/Working in Desk PC’s browser on shop\.example/);
    expect(note.closest('[role="status"]')).toBeTruthy();
    expect(screen.getByText(/the site showed a block page/)).toBeTruthy();
    const list = within(await screen.findByRole('list', { name: 'Browser actions' }));
    const rows = list.getAllByRole('listitem');
    await waitFor(() => expect(rows[0]!.textContent).toContain('On Desk PC, clean profile'));
    expect(rows[0]!.getAttribute('data-local-fallback')).toBe('clean');
    expect(rows[1]!.textContent).not.toContain('On Desk PC');
    await userEvent.click(within(rows[0]!).getByRole('button'));
    expect(
      within(rows[0]!).getByText(
        'Desk PC’s browser, in a clean profile that reaches only this site and its subdomains',
      ),
    ).toBeTruthy();
  });

  it('marks the user’s own browser, and the note leaves when the session ends', async () => {
    const { state } = await renderM75Browser(<BrowserPanel computerId="pc1" />, {
      browser: {
        sessions: [sessionView({ computerId: 'pc1' })],
        actions: [marked({ id: 'fb', computerId: 'pc1' }, 'extension')],
      },
      m75: {
        sessions: [fallbackSessionView({ id: 's1', computerId: 'pc1', profile: 'extension' })],
      },
    });
    // Without a consent naming it, the computer is "your computer".
    expect(await screen.findByText(/Working in your computer’s browser/)).toBeTruthy();
    expect(screen.getByText(/acts only in a tab it opened or one you shared/)).toBeTruthy();
    expect(screen.getByText(/It stops when the agent leaves example\.com/)).toBeTruthy();
    expect(
      await screen.findByText('On your computer, your own browser', { exact: false }),
    ).toBeTruthy();
    state.sessions = state.sessions.map((x) => ({
      ...x,
      endedAt: at(9),
      endReason: 'left_site' as const,
    }));
    act(() => {
      emitHub('browser.fallback.changed', { sessionId: 's1', computerId: 'pc1', state: 'ended' });
    });
    await waitFor(() => expect(screen.queryByText(/Working in/)).toBeNull());
  });

  it('says how the last session ended, for a while', async () => {
    await renderM75Browser(<BrowserPanel computerId="pc1" />, {
      browser: { sessions: [sessionView({ computerId: 'pc1' })] },
      m75: {
        consents: [consentView({ id: 'c1', deviceName: 'Desk PC' })],
        sessions: [
          fallbackSessionView({
            id: 's2',
            computerId: 'pc1',
            profile: 'extension',
            bridgeUser: 'sam',
            endedAt: new Date().toISOString(),
            endReason: 'consent_revoked',
          }),
        ],
      },
    });
    expect(
      await screen.findByText(
        /The last session in sam’s own browser on Desk PC on example\.com: ended when the consent was revoked, just now\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Working in/)).toBeNull();
  });

  it('shows nothing extra for a client without the calls', async () => {
    await renderM75Browser(<BrowserPanel computerId="pc1" />, {
      without: true,
      browser: {
        sessions: [sessionView({ computerId: 'pc1' })],
        actions: [marked({ id: 'fb', computerId: 'pc1' }, 'clean')],
      },
    });
    const list = within(await screen.findByRole('list', { name: 'Browser actions' }));
    // The mark still shows from the trace row itself, without a name.
    expect(list.getByText('On your computer, clean profile', { exact: false })).toBeTruthy();
    expect(screen.queryByText(/Working in/)).toBeNull();
  });
});
