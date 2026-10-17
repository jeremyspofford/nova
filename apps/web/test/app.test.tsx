import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { App } from '../src/App.tsx';
import { ApiError } from '../src/api.ts';
import { CommandRegistry } from '../src/commands.ts';
import { navigate } from '../src/router.ts';
import { createHub, fakeEventSource, message, testRegistry, thread } from './fakes.ts';
import { clearViewport, renderApp, resetDom, setViewport } from './render.tsx';

afterEach(() => {
  resetDom();
  clearViewport();
});

const unauthorized = new ApiError(401, {
  code: 'token_required',
  message: 'sign in',
  retryable: false,
});

describe('connecting and setup', () => {
  it('finishes setup from a setup link', async () => {
    const hub = createHub();
    let signedIn = false;
    hub.api.session.mockImplementation(() =>
      signedIn
        ? Promise.resolve({ accountId: 'a1', displayName: 'Pat' })
        : Promise.reject(unauthorized),
    );
    hub.api.setup.mockImplementation(() => {
      signedIn = true;
      return Promise.resolve({ accountId: 'a1' });
    });
    window.history.replaceState(null, '', '/chat');
    render(
      <App
        api={hub.api}
        eventSource={fakeEventSource}
        registry={testRegistry()}
        takeSetupCode={() => 'nvs_abcdefghijklmnop'}
      />,
    );
    await screen.findByText(/Setup link detected/);
    await userEvent.type(screen.getByLabelText('Your name (optional)'), 'Pat');
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(hub.api.setup).toHaveBeenCalledWith('nvs_abcdefghijklmnop', 'Pat');
    expect(await screen.findByRole('button', { name: 'Account: Pat' })).toBeTruthy();
  });

  it('asks for a code when there is no link, and reports a bad code', async () => {
    const hub = createHub();
    hub.api.session.mockRejectedValue(unauthorized);
    hub.api.setup.mockRejectedValue(unauthorized);
    render(<App api={hub.api} eventSource={fakeEventSource} takeSetupCode={() => null} />);
    const field = await screen.findByLabelText('Setup code');
    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Finish setup' });
    expect(submit.disabled).toBe(true);
    await userEvent.type(field, 'nvs_wrongwrongwrong');
    await userEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That setup code is invalid or has expired.',
    );
    hub.api.setup.mockRejectedValue(new Error('boom'));
    await userEvent.click(submit);
    expect((await screen.findByRole('alert')).textContent).toBe('Setup failed. Try again.');
  });

  it('shows an actionable error when the Hub is unreachable', async () => {
    const hub = createHub();
    hub.api.hello.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<App api={hub.api} eventSource={fakeEventSource} takeSetupCode={() => null} />);
    expect(await screen.findByRole('heading', { name: 'Cannot reach the Hub' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('navigation', { name: 'Sidebar' })).toBeTruthy();
  });

  it('applies the stored theme and signs out from the account menu', async () => {
    const hub = createHub();
    hub.state.settings['appearance.theme'] = 'light';
    await renderApp({ hub });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('nova.light'));
    await userEvent.click(screen.getByRole('button', { name: 'Account: Sam' }));
    hub.api.session.mockRejectedValue(unauthorized);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(hub.api.logout).toHaveBeenCalled();
    expect(await screen.findByLabelText('Setup code')).toBeTruthy();
  });

  it('reads the setup code from the URL fragment once', async () => {
    const { takeSetupCodeFromLocation } = await import('../src/App.tsx');
    window.history.replaceState(null, '', '/chat#setup=nvs_abc');
    expect(takeSetupCodeFromLocation()).toBe('nvs_abc');
    expect(window.location.hash).toBe('');
    expect(takeSetupCodeFromLocation()).toBeNull();
  });
});

describe('shell and modes (FR-001, FR-002)', () => {
  it('has a sidebar, main area and inspector, with modes switchable by sidebar and keys', async () => {
    const t = thread({ title: 'Trip planning' });
    const hub = createHub({ threads: [t] });
    hub.state.messages.set(t.id, [
      message(t.id, { parts: [{ type: 'text', text: 'Plan a trip' }] }),
    ]);
    await renderApp({ hub, path: `/chat/${t.id}` });
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Inspector' })).toBeTruthy();
    expect(await screen.findByText('Plan a trip')).toBeTruthy();

    // Type a draft, switch away with the keyboard, and come back: the draft and thread remain.
    await userEvent.type(screen.getByLabelText('Message'), 'unsent draft');
    await userEvent.keyboard('{Control>}2{/Control}');
    expect(window.location.pathname).toBe('/work');
    expect(
      screen.getByRole('heading', { name: 'Work runs arrive in a later milestone' }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: /Code/ }));
    expect(screen.getByRole('heading', { name: /Code sessions arrive/ })).toBeTruthy();
    await userEvent.keyboard('{Control>}4{/Control}');
    expect(screen.getByRole('heading', { name: /Always-on agents arrive/ })).toBeTruthy();
    await userEvent.keyboard('{Control>}1{/Control}');
    expect(window.location.pathname).toBe(`/chat/${t.id}`);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe('unsent draft');
    expect(screen.getByText('Plan a trip')).toBeTruthy();
    expect(hub.api.getThread).toHaveBeenCalledTimes(1);

    // "Go to Chat" from an empty mode returns to the same chat too.
    await userEvent.click(screen.getByRole('link', { name: /Agents/ }));
    // Hidden mode panes are out of the accessibility tree, so only the visible button matches.
    await userEvent.click(screen.getByRole('button', { name: 'Go to Chat' }));
    expect(window.location.pathname).toBe(`/chat/${t.id}`);
  });

  it('marks the current mode and follows Back and Forward', async () => {
    await renderApp();
    const chat = screen.getByRole('link', { name: /^Chat/ });
    expect(chat.getAttribute('aria-current')).toBe('page');
    await userEvent.click(screen.getByRole('link', { name: /Work/ }));
    expect(screen.getByRole('link', { name: /Work/ }).getAttribute('aria-current')).toBe('page');
    act(() => {
      window.history.back();
    });
    await waitFor(() => expect(window.location.pathname).toBe('/chat'));
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /^Chat/ }).getAttribute('aria-current')).toBe('page'),
    );
  });

  it('toggles the sidebar and inspector', async () => {
    await renderApp();
    const toggle = screen.getByRole('button', { name: 'Toggle sidebar' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{Control>}b{/Control}');
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
    await userEvent.click(toggle);
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeTruthy();
    const inspector = screen.getByRole('button', { name: 'Toggle inspector' });
    await userEvent.click(inspector);
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
    await userEvent.click(inspector);
    const aside = screen.getByRole('complementary', { name: 'Inspector' });
    await userEvent.click(within(aside).getByRole('tab', { name: 'Files' }));
    expect(within(aside).getByRole('tabpanel').textContent).toMatch(/Files for the open item/);
  });

  it('collapses the sidebar below 1100 px and closes it after a choice', async () => {
    setViewport(1000);
    await renderApp({ ready: false });
    await screen.findByRole('button', { name: 'Toggle sidebar' });
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Toggle sidebar' }));
    await userEvent.click(screen.getByRole('link', { name: /Work/ }));
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
    expect(window.location.pathname).toBe('/work');
  });

  it('on phones shows the sidebar as a full-screen menu page instead of the content', async () => {
    setViewport(390);
    await renderApp({ ready: false });
    const open = await screen.findByRole('button', { name: 'Open menu' });
    expect(screen.getByRole('main')).toBeTruthy();
    await userEvent.click(open);
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeTruthy();
    expect(screen.queryByRole('main')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByRole('link', { name: /Settings/ }));
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Toggle inspector' })).toBeNull();
  });

  it('routes /settings/:section and unknown paths', async () => {
    await renderApp({ path: '/settings/keyboard' });
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeTruthy();
    act(() => navigate('/nowhere'));
    expect(await screen.findByRole('heading', { name: 'New chat' })).toBeTruthy();
  });
});

describe('command palette (FR-003)', () => {
  it('opens with both shortcuts, lists real commands with bindings and runs them', async () => {
    await renderApp();
    await userEvent.keyboard('{Control>}{Shift>}p{/Shift}{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    const newChat = within(dialog).getByRole('option', { name: /New chat/ });
    expect(within(newChat).getByLabelText('Ctrl plus N')).toBeTruthy();
    await userEvent.keyboard('appearance');
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.pathname).toBe('/settings/appearance');

    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    await userEvent.keyboard('toggle sidebar');
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Commands' }));
    await userEvent.keyboard('zzzzqq');
    expect(screen.getByRole('option').textContent).toBe('No matching commands');
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape and returns focus, and runs commands by click', async () => {
    const registry = new CommandRegistry({ mac: false, browserTab: false });
    const run = vi.fn();
    registry.register({
      id: 'demo.hello',
      title: 'Say hello',
      category: 'Demo',
      binding: 'mod+shift+h',
      run,
    });
    await renderApp({ registry });
    const button = screen.getByRole('button', { name: 'Commands' });
    await userEvent.click(button);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));
    await userEvent.click(button);
    await userEvent.click(screen.getByRole('option', { name: /Say hello/ }));
    expect(run).toHaveBeenCalledOnce();
    await userEvent.keyboard('{Control>}{Shift>}h{/Shift}{/Control}');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('toggles the theme, opens settings and search from commands', async () => {
    const { hub, registry } = await renderApp();
    act(() => {
      registry.run('view.toggleTheme');
    });
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('appearance.theme', 'light'),
    );
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('nova.light'));
    await userEvent.keyboard('{Control>},{/Control}');
    expect(window.location.pathname).toBe('/settings/general');
    act(() => {
      registry.run('chat.search');
    });
    expect(await screen.findByRole('searchbox', { name: 'Search chats' })).toBeTruthy();
    act(() => {
      registry.run('view.toggleInspector');
    });
    expect(screen.queryByRole('complementary', { name: 'Inspector' })).toBeNull();
    act(() => {
      registry.run('onboarding.open');
    });
    expect(await screen.findByRole('heading', { name: 'Connect a model provider' })).toBeTruthy();
  });

  it('shows Alt variants for browser-reserved keys in a browser tab', async () => {
    await renderApp({ registry: testRegistry(false, true) });
    await userEvent.keyboard('{Control>}k{/Control}');
    const option = screen.getByRole('option', { name: /New chat/ });
    expect(within(option).getByLabelText('Alt plus N')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('link', { name: /Work/ }));
    await userEvent.keyboard('{Alt>}1{/Alt}');
    expect(window.location.pathname).toBe('/chat');
  });
});

describe('global key handling (FR-004)', () => {
  it('leaves character keys to text fields but still runs modifier shortcuts there', async () => {
    const registry = testRegistry();
    const run = vi.fn();
    registry.register({ id: 'demo.slash', title: 'Slash', category: 'Demo', binding: '/', run });
    await renderApp({ registry });
    await userEvent.keyboard('/');
    expect(run).toHaveBeenCalledTimes(1);
    screen.getByLabelText('Message').focus();
    await userEvent.keyboard('/');
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe('/');
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeTruthy();
    // While a dialog is open, other shortcuts wait.
    await userEvent.keyboard('{Control>}b{/Control}');
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeTruthy();
  });
});

describe('keyboard-only navigation (FR-015)', () => {
  it('reaches the sidebar controls, moves through chats with arrows, and opens one', async () => {
    const a = thread({ title: 'Alpha', updatedAt: '2026-10-01T12:00:03.000Z' });
    const b = thread({ title: 'Beta', updatedAt: '2026-10-01T12:00:02.000Z' });
    const c = thread({ title: 'Gamma', updatedAt: '2026-10-01T12:00:01.000Z', pinned: true });
    await renderApp({ hub: createHub({ threads: [a, b, c] }) });
    await screen.findByRole('link', { name: /Alpha/ });
    // Skip link first, then the topbar, then the sidebar.
    await userEvent.tab();
    expect(document.activeElement?.textContent).toBe('Skip to content');
    for (let i = 0; i < 6 && document.activeElement?.textContent?.trim() !== 'New chat'; i++)
      await userEvent.tab();
    expect(document.activeElement?.textContent?.trim()).toBe('New chat');
    await userEvent.tab();
    expect(document.activeElement?.textContent?.trim()).toBe('Search');
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('href')).toBe('/chat');
    await userEvent.tab();
    // The thread list is one tab stop; pinned rows come first.
    expect(document.activeElement?.textContent).toContain('Gamma');
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Alpha'));
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Beta'));
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Gamma'));
    await userEvent.keyboard('{ArrowUp}');
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Beta'));
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Actions for Beta');
    await userEvent.tab({ shift: true });
    await userEvent.keyboard('{Enter}');
    expect(window.location.pathname).toBe(`/chat/${b.id}`);
  });

  it('operates the composer by keyboard: type, newline, send', async () => {
    const t = thread({ title: 'Keys' });
    const { hub } = await renderApp({ hub: createHub({ threads: [t] }), path: `/chat/${t.id}` });
    const box = screen.getByLabelText<HTMLTextAreaElement>('Message');
    box.focus();
    await userEvent.keyboard('line one{Shift>}{Enter}{/Shift}line two');
    expect(box.value).toBe('line one\nline two');
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenCalledWith(t.id, {
        text: 'line one\nline two',
        attachments: undefined,
      }),
    );
    expect(box.value).toBe('');
  });
});
