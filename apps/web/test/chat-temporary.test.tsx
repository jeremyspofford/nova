// FR-027: temporary chats are marked, excluded from memory, and deleted when left.
import { afterEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { navigate } from '../src/router.ts';
import { createHub, message, thread } from './fakes.ts';
import { box, openChat } from './chat-helpers.tsx';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const BANNER = 'Temporary chat: not saved to memory or search, deleted when you leave';
const sidebar = () => screen.getByRole('navigation', { name: 'Sidebar' });

describe('temporary chats (FR-027)', () => {
  it('starts from the sidebar button next to New chat', async () => {
    await renderApp({ hub: createHub() });
    await userEvent.click(within(sidebar()).getByRole('button', { name: 'New temporary chat' }));
    expect(window.location.pathname + window.location.search).toBe('/chat?temporary=1');
    expect(await screen.findByRole('heading', { name: 'New temporary chat' })).toBeTruthy();
  });

  it('starts from the command, is marked, and is created as temporary', async () => {
    const other = thread({ title: 'Kept chat' });
    const hub = createHub({ threads: [other] });
    hub.state.messages.set(other.id, []);
    const { registry } = await renderApp({ hub });
    act(() => {
      registry.run('chat.newTemporary');
    });
    expect(window.location.pathname + window.location.search).toBe('/chat?temporary=1');
    expect(await screen.findByRole('heading', { name: 'New temporary chat' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(BANNER);
    expect(
      screen.getByRole('switch', { name: 'Temporary chat' }).getAttribute('aria-checked'),
    ).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(box()));
    await userEvent.type(box(), 'Quick math');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(hub.api.createThread).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Quick math', temporary: true }),
      ),
    );
    const temp = hub.state.threads.find((x) => x.temporary)!;
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${temp.id}`));
    expect(await screen.findByRole('heading', { name: 'Quick math' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(BANNER);
    expect(within(sidebar()).getByRole('link', { name: /Quick math, temporary/ })).toBeTruthy();
    // Memory never uses a temporary chat, so the opt-out is not offered.
    await userEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: /memory/ })).toBeNull();
  });

  it('toggles a new chat between temporary and normal', async () => {
    await renderApp();
    const toggle = screen.getByRole('switch', { name: 'Temporary chat' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('note')).toBeNull();
    await userEvent.click(toggle);
    expect(window.location.search).toBe('?temporary=1');
    expect(await screen.findByRole('note')).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Temporary chat' }));
    expect(window.location.search).toBe('');
    await waitFor(() => expect(screen.queryByRole('note')).toBeNull());
  });

  it('deletes the chat when the user opens another one', async () => {
    const other = thread({ title: 'Kept chat' });
    const { hub, t } = await openChat(
      { temporary: true, title: 'Scratch' },
      { hub: { threads: [other] } },
    );
    hub.state.messages.set(other.id, []);
    await screen.findByRole('note');
    await userEvent.click(within(sidebar()).getByRole('link', { name: /Kept chat/ }));
    await waitFor(() => expect(hub.api.deleteThread).toHaveBeenCalledWith(t.id));
    await waitFor(() =>
      expect(within(sidebar()).queryByRole('link', { name: /Scratch/ })).toBeNull(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks first when a reply is streaming: going back keeps it, deleting stops and removes it', async () => {
    const { hub, t } = await openChat(
      { temporary: true, title: 'Scratch', state: 'streaming' },
      {
        messages: (tid) => [
          message(tid, { role: 'user', turnId: 'tu', parts: [{ type: 'text', text: 'Go' }] }),
          message(tid, { role: 'assistant', turnId: 'tu', status: 'streaming', parts: [] }),
        ],
      },
    );
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();
    act(() => navigate('/chat'));
    const dialog = await screen.findByRole('dialog', { name: 'Delete the temporary chat?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Go back to it' }));
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${t.id}`));
    expect(hub.api.deleteThread).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();

    act(() => navigate('/chat'));
    const again = await screen.findByRole('dialog', { name: 'Delete the temporary chat?' });
    await userEvent.click(within(again).getByRole('button', { name: 'Delete chat' }));
    await waitFor(() => expect(hub.api.deleteThread).toHaveBeenCalledWith(t.id));
    expect(hub.api.cancel).toHaveBeenCalledWith(t.id);
  });

  it('deletes on page close and explains a failed delete', async () => {
    const other = thread({ title: 'Kept chat' });
    const { hub, t } = await openChat(
      { temporary: true, title: 'Scratch' },
      { hub: { threads: [other] } },
    );
    hub.state.messages.set(other.id, []);
    await screen.findByRole('note');
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(hub.api.deleteThread).toHaveBeenCalledWith(t.id));

    // Back in the app (a cached page), leaving again tries to delete and reports a failure.
    hub.state.threads.push({ ...t });
    hub.state.failNext.deleteThread = new ApiError(500, {
      code: 'x',
      message: 'Disk full',
      retryable: true,
    });
    await userEvent.click(within(sidebar()).getByRole('link', { name: /Kept chat/ }));
    expect(
      await screen.findByText(
        'Could not delete the temporary chat: Disk full It is removed automatically later.',
      ),
    ).toBeTruthy();
  });

  it('keeps a normal chat when the user leaves it', async () => {
    const { hub } = await openChat();
    act(() => navigate('/chat'));
    await screen.findByRole('heading', { name: 'New chat' });
    expect(hub.api.deleteThread).not.toHaveBeenCalled();
  });
});
