// FR-026 side chat, FR-033 branches tree and compare, FR-032 per-chat memory opt-out.
import { afterEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { navigate } from '../src/router.ts';
import { FakeEventSource, message, thread } from './fakes.ts';
import { openChat } from './chat-helpers.tsx';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const inspector = () => screen.getByRole('complementary', { name: 'Inspector' });
const sidebar = () => screen.getByRole('navigation', { name: 'Sidebar' });
const mainLog = () => screen.getByRole('log', { name: 'Messages' });

describe('side chat (FR-026)', () => {
  it('asks with the chat as context, streams the answer, and adds nothing to the chat', async () => {
    const { hub, t } = await openChat(
      {},
      {
        messages: (tid) => [
          message(tid, { role: 'user', parts: [{ type: 'text', text: 'Draft a reply to Ann' }] }),
        ],
      },
    );
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Side chat' }));
    const panel = within(inspector()).getByRole('region', { name: 'Side chat' });
    expect(within(panel).getByText(/add nothing to it/)).toBeTruthy();

    hub.state.failNext.sideChat = new ApiError(500, {
      code: 'x',
      message: 'Model offline.',
      retryable: true,
    });
    const field = within(panel).getByRole('textbox', { name: 'Side question' });
    await userEvent.type(field, 'Who is Ann?{Enter}');
    expect(await within(panel).findByText(/Not sent: Model offline\./)).toBeTruthy();
    expect(within(panel).getByRole<HTMLTextAreaElement>('textbox').value).toBe('Who is Ann?');

    await userEvent.click(within(panel).getByRole('button', { name: 'Ask' }));
    await waitFor(() =>
      expect(hub.api.sideChat).toHaveBeenLastCalledWith(t.id, { text: 'Who is Ann?' }),
    );
    const side = hub.state.threads.find((x) => x.side)!;
    await waitFor(() => expect(within(panel).getByText('Who is Ann?')).toBeTruthy());
    const [, answer] = hub.state.messages.get(side.id)!;
    const es = await waitFor(() => FakeEventSource.for(`/threads/${side.id}/stream`));
    es.emit('turn.started', { threadId: side.id }, side.id);
    es.emit(
      'chat.delta',
      { threadId: side.id, messageId: answer!.id, type: 'text_delta', text: 'Your accountant.' },
      side.id,
    );
    expect(await within(panel).findByText('Your accountant.')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /Stop/ })).toBeTruthy();
    hub.persist(side.id, answer!.id, {
      status: 'complete',
      parts: [{ type: 'text', text: 'Your accountant.' }],
    });
    es.emit(
      'chat.message.completed',
      { threadId: side.id, messageId: answer!.id, status: 'complete', usage: null },
      side.id,
    );
    es.emit('turn.completed', { threadId: side.id }, side.id);
    expect(screen.getByTestId('announcer').textContent).toMatch(/Side chat answer complete/);

    // Nothing reached the main chat, and the side chat is not listed as a chat.
    expect(within(mainLog()).queryByText('Who is Ann?')).toBeNull();
    expect(within(mainLog()).queryByText('Your accountant.')).toBeNull();
    expect(within(sidebar()).queryByRole('link', { name: /Who is Ann/ })).toBeNull();

    // Follow-up questions go to the same side thread.
    await waitFor(() =>
      expect(within(panel).getByRole<HTMLButtonElement>('button', { name: 'Ask' })).toBeTruthy(),
    );
    await userEvent.type(within(panel).getByRole('textbox'), 'Her email?{Enter}');
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenLastCalledWith(side.id, { text: 'Her email?' }),
    );

    // Closing the panel keeps it; opening another chat drops it.
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Files' }));
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Side chat' }));
    expect(await within(inspector()).findByText('Your accountant.')).toBeTruthy();
    const other = thread({ title: 'Other chat' });
    hub.state.threads.push(other);
    hub.state.messages.set(other.id, []);
    act(() => navigate(`/chat/${other.id}`));
    await waitFor(() => expect(within(inspector()).queryByText('Your accountant.')).toBeNull());
  });

  it('opens from the command and focuses the question field', async () => {
    const { registry } = await openChat();
    act(() => {
      registry.run('chat.sideChat');
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Side question' })),
    );
  });
});

describe('branches (FR-033)', () => {
  async function family() {
    const root = thread({ title: 'Trip' });
    const branch = thread({
      title: 'Branch: Trip',
      parentThreadId: root.id,
      branchFromMessageId: 'm1',
    });
    const side = thread({ title: 'Quick question', parentThreadId: root.id, side: true });
    const r = await openChat(
      { id: root.id, title: 'Trip' },
      {
        hub: { threads: [branch, side] },
        messages: (tid) => [
          message(tid, { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Plan Lisbon' }] }),
          message(tid, { role: 'assistant', parts: [{ type: 'text', text: 'Day one: Alfama' }] }),
        ],
      },
    );
    r.hub.state.messages.set(branch.id, [
      message(root.id, { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Plan Lisbon' }] }),
      message(branch.id, { role: 'assistant', parts: [{ type: 'text', text: 'Day one: Belém' }] }),
    ]);
    r.hub.state.messages.set(side.id, []);
    return { ...r, root, branch, side };
  }

  it('shows the lineage as a keyboard tree that opens chats', async () => {
    const { hub, root, branch } = await family();
    hub.state.failNext.threadTree = new ApiError(500, {
      code: 'x',
      message: 'Tree unavailable',
      retryable: true,
    });
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Branches' }));
    expect(await within(inspector()).findByText('Tree unavailable')).toBeTruthy();
    await userEvent.click(within(inspector()).getByRole('button', { name: 'Retry' }));
    const tree = await within(inspector()).findByRole('tree', { name: 'Branches' });
    const rootItem = within(tree).getByRole('treeitem', { name: 'Trip' });
    expect(rootItem.getAttribute('aria-current')).toBe('page');
    expect(
      within(tree).getByRole('treeitem', { name: 'Branch: Trip' }).getAttribute('aria-level'),
    ).toBe('2');
    expect(within(tree).getByRole('treeitem', { name: 'Side chat: Quick question' })).toBeTruthy();
    expect(within(tree).getAllByText('2 messages')).toHaveLength(2);
    expect(within(tree).getByText('0 messages')).toBeTruthy();
    rootItem.focus();
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${branch.id}`));
    expect(hub.api.threadTree).toHaveBeenCalledWith(root.id);
    await waitFor(() => expect(hub.api.threadTree).toHaveBeenLastCalledWith(branch.id));
  });

  it('compares two selected chats side by side, read-only', async () => {
    const { root, branch } = await family();
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Branches' }));
    const tree = await within(inspector()).findByRole('tree');
    const compare = within(inspector()).getByRole<HTMLButtonElement>('button', {
      name: 'Compare selected',
    });
    expect(compare.disabled).toBe(true);
    within(tree).getByRole('treeitem', { name: 'Trip' }).focus();
    await userEvent.keyboard(' {ArrowDown} ');
    expect(
      within(tree).getByRole('treeitem', { name: 'Branch: Trip' }).getAttribute('aria-selected'),
    ).toBe('true');
    await userEvent.click(compare);
    expect(window.location.pathname + window.location.search).toBe(
      `/chat/${root.id}?compare=${branch.id}`,
    );
    const view = await screen.findByRole('region', { name: 'Compare chats' });
    const first = within(view).getByRole('region', { name: 'First chat' });
    const second = within(view).getByRole('region', { name: 'Second chat' });
    expect(await within(first).findByText('Day one: Alfama')).toBeTruthy();
    expect(await within(second).findByText('Day one: Belém')).toBeTruthy();
    expect(within(view).queryByRole('toolbar')).toBeNull();
    await userEvent.click(within(view).getByRole('button', { name: 'Close compare' }));
    expect(window.location.search).toBe('');
    expect(screen.queryByRole('region', { name: 'Compare chats' })).toBeNull();
  });

  it('reports a chat that cannot be loaded for compare', async () => {
    const { root } = await family();
    act(() => navigate(`/chat/${root.id}?compare=gone`));
    expect(await screen.findByText('This chat was deleted or does not exist.')).toBeTruthy();
  });
});

describe('memory opt-out per chat (FR-032)', () => {
  it('toggles from the chat options with its state shown, and rolls back a failure', async () => {
    const { hub, t } = await openChat();
    await userEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    const item = screen.getByRole('menuitemcheckbox', { name: /Don't use for memory/ });
    expect(item.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(item);
    await waitFor(() =>
      expect(hub.api.updateThread).toHaveBeenCalledWith(t.id, { memoryOptOut: true }),
    );
    expect(await screen.findByText('Not used for memory')).toBeTruthy();
    expect(screen.getByText('This chat will not be used for memory.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    expect(
      screen
        .getByRole('menuitemcheckbox', { name: /Don't use for memory/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
    await userEvent.keyboard('{Escape}');

    hub.state.failNext.updateThread = new ApiError(500, {
      code: 'x',
      message: 'Locked',
      retryable: true,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /Don't use for memory/ }));
    expect(await screen.findByText('Could not change memory use: Locked')).toBeTruthy();
    expect(screen.getByText('Not used for memory')).toBeTruthy();
  });

  it('toggles from the chat list menu too', async () => {
    const { hub, t } = await openChat();
    await userEvent.click(
      within(sidebar()).getByRole('button', { name: `Actions for ${t.title}` }),
    );
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: /Don't use for memory/ }));
    await waitFor(() =>
      expect(hub.api.updateThread).toHaveBeenCalledWith(t.id, { memoryOptOut: true }),
    );
    expect(await screen.findByText('This chat will not be used for memory.')).toBeTruthy();
  });
});
