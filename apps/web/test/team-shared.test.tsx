// Shared threads (FR-217): the share dialog says plainly what is not shared and that each message
// runs as its writer, shares with chosen people, lists who is in and lets the chat's owner take
// someone out; only a plain chat outside a project can be shared. Team → Shared chats lists them
// live. A shared chat shows who wrote each message and who asked for each reply, sends as the
// writer, streams replies, lets anyone stop one, lets a participant leave, and says so when a
// person is no longer in it.
import { render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ThreadView } from '@nova/shared';
import { Menu } from '@nova/ui';
import { ShareDialog, notShareableReason, useShareMenu } from '../src/team/ShareDialog.tsx';
import { SharedList } from '../src/team/SharedList.tsx';
import { SharedThreadPage, authorLine } from '../src/team/SharedThreadPage.tsx';
import { FakeEventSource, createHub, thread } from './fakes.ts';
import { MEMBER_ID, OWNER_ID, person, renderWithTeam, sharedThread } from './fakes-m7-team.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const events = () => FakeEventSource.for('/api/v1/events/stream');
const threadStream = (id: string) => FakeEventSource.for(`/api/v1/team/threads/${id}/stream`);

describe('the share dialog', () => {
  it('says what is not shared, shares with chosen people and lists who is in', async () => {
    const hub = createHub();
    const t = thread({ id: 'th-1', title: 'Trip planning' });
    hub.state.threads = [t];
    const { api, state } = await renderWithTeam(
      <ShareDialog thread={t} onClose={() => undefined} />,
      {
        hub,
        team: {
          people: [
            person({ accountId: OWNER_ID, displayName: 'Sam', role: 'owner' }),
            person({ accountId: MEMBER_ID, displayName: 'Alex' }),
            person({ accountId: 'acc-kim', displayName: 'Kim' }),
          ],
        },
      },
    );
    const dialog = await screen.findByRole('dialog', { name: 'Share this chat' });
    expect(dialog.textContent).toContain('Nobody’s memory or past chats');
    expect(dialog.textContent).toContain(
      'MCP servers, plugins, channels, devices, agents or spaces',
    );
    expect(dialog.textContent).toContain('No projects or instructions of yours');
    expect(dialog.textContent).toContain('runs under the account of the person who wrote it');
    await within(dialog).findByRole('group', { name: 'Share with' });
    // You are never offered to yourself.
    expect(within(dialog).queryByRole('checkbox', { name: 'Sam' })).toBeNull();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Alex' }));
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Kim' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    await waitFor(() =>
      expect(api.shareThread).toHaveBeenCalledWith('th-1', [MEMBER_ID, 'acc-kim']),
    );
    const toasts = screen.getByRole('region', { name: 'Notifications' });
    expect(await within(toasts).findByText('Shared with Alex and Kim.')).toBeTruthy();
    expect(state.threads['th-1']?.participants).toEqual([MEMBER_ID, 'acc-kim']);
    const inside = within(dialog).getByRole('region', { name: 'In this chat' });
    expect(inside.textContent).toContain('Sam (started it)');
    await userEvent.click(
      within(inside).getByRole('button', { name: 'Take Kim out of this chat' }),
    );
    await waitFor(() => expect(api.unshareThread).toHaveBeenCalledWith('th-1', 'acc-kim'));
    await waitFor(() => expect(inside.textContent).not.toContain('Kim'));
    expect(within(dialog).getByRole('button', { name: 'Open the shared view' })).toBeTruthy();
  });

  it('asks for at least one person, and shows the Hub’s refusal', async () => {
    const hub = createHub();
    const t = thread({ id: 'th-2' });
    hub.state.threads = [t];
    const { team } = await renderWithTeam(<ShareDialog thread={t} onClose={() => undefined} />, {
      hub,
    });
    const dialog = await screen.findByRole('dialog', { name: 'Share this chat' });
    await within(dialog).findByRole('group', { name: 'Share with' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Choose at least one person.');
    team.state.people = team.state.people.map((p) =>
      p.accountId === MEMBER_ID ? { ...p, removed: true } : p,
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Alex' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Someone you chose is no longer on this Hub. Refresh and choose again.',
    );
  });

  it('says why a chat cannot be shared and offers no controls', async () => {
    const t = thread({ id: 'th-3', temporary: true });
    await renderWithTeam(<ShareDialog thread={t} onClose={() => undefined} />);
    const dialog = await screen.findByRole('dialog', { name: 'Share this chat' });
    expect(dialog.textContent).toContain('A temporary chat cannot be shared.');
    expect(within(dialog).queryByRole('button', { name: 'Share' })).toBeNull();
    expect(notShareableReason(thread({ projectId: 'p1' }))).toContain('in a project');
    expect(notShareableReason(thread({ side: true }))).toContain('side chat');
    expect(notShareableReason(thread({ mode: 'code' }))).toContain('Only chats');
    expect(notShareableReason(thread())).toBeNull();
  });

  it('offers invitations when nobody else uses the Hub', async () => {
    const t = thread({ id: 'th-4' });
    await renderWithTeam(<ShareDialog thread={t} onClose={() => undefined} />, {
      team: { people: [person({ accountId: OWNER_ID, displayName: 'Sam', role: 'owner' })] },
    });
    expect(await screen.findByText('Nobody else uses this Hub yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings → Members' })).toBeTruthy();
  });

  it('gives the chat menu a Share item, disabled with the reason when it cannot be shared', async () => {
    function Harness({ t }: { t: ThreadView }) {
      const share = useShareMenu(t);
      return (
        <>
          <Menu label="Chat options" items={share.items} />
          {share.dialog}
        </>
      );
    }
    await renderWithTeam(<Harness t={thread({ id: 'th-5', projectId: 'p1' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    const item = screen.getByRole('menuitem', { name: 'Share with people…' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    resetDom();
    await renderWithTeam(<Harness t={thread({ id: 'th-6' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Share with people…' }));
    expect(await screen.findByRole('dialog', { name: 'Share this chat' })).toBeTruthy();
  });
});

describe('Team → Shared chats', () => {
  it('starts empty with a way to Chat, then shows a chat shared live', async () => {
    const { state } = await renderWithTeam(<SharedList />, { as: 'member' });
    expect(await screen.findByText('No shared chats')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Chat' })).toBeTruthy();
    state.threads['st-1'] = sharedThread({
      thread: thread({ id: 'st-1', title: 'Trip planning' }),
    });
    events().emit('thread.shared', {
      threadId: 'st-1',
      ownerAccountId: OWNER_ID,
      participants: [MEMBER_ID],
    });
    const list = await screen.findByRole('list', { name: 'Shared chats' });
    expect(within(list).getByRole('link', { name: 'Trip planning' }).getAttribute('href')).toBe(
      '/team/shared/st-1',
    );
    expect(list.textContent).toContain('Sam shares it with you');
  });

  it('tells the owner who they share with, and retries a failed load', async () => {
    await renderWithTeam(<SharedList />, {
      team: {
        threads: { 'st-2': sharedThread({ thread: thread({ id: 'st-2', title: 'Budget' }) }) },
      },
      prepare: (team) => {
        team.failNext.listSharedThreads = new TypeError('Failed to fetch');
      },
    });
    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    const list = await screen.findByRole('list', { name: 'Shared chats' });
    expect(list.textContent).toContain('You share it with Alex');
  });
});

describe('a shared chat', () => {
  function seeded() {
    const rec = sharedThread({ thread: thread({ id: 'st-9', title: 'Trip planning' }) });
    return { rec, team: { threads: { 'st-9': rec } } };
  }

  it('shows who wrote each message and who asked for each reply', async () => {
    const { team } = seeded();
    await renderWithTeam(<SharedThreadPage threadId="st-9" />, { as: 'member', team });
    expect(await screen.findByRole('heading', { name: 'Trip planning', level: 1 })).toBeTruthy();
    expect(screen.getByText('Sam shares this chat with you.', { exact: false })).toBeTruthy();
    const messages = screen.getByRole('list', { name: 'Messages' });
    await waitFor(() => expect(messages.textContent).toContain('Nova, asked by you'));
    const items = within(messages).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('You');
    expect(items[0]!.textContent).toContain('Where should we go in May?');
    // Replies are Markdown; people's messages are plain text.
    expect(within(items[1]!).getByText('warm').tagName).toBe('STRONG');
    const people = screen.getByRole('list', { name: 'People in this chat' });
    expect(people.textContent).toContain('Sam, started it');
    expect(people.textContent).toContain('Alex (you)');
    expect(screen.queryByRole('button', { name: 'Add people' })).toBeNull();
  });

  it('sends as the writer, streams the reply and lets anyone stop it', async () => {
    const { team } = seeded();
    const { api, state } = await renderWithTeam(<SharedThreadPage threadId="st-9" />, {
      as: 'member',
      team,
    });
    await screen.findByRole('list', { name: 'Messages' });
    await userEvent.type(
      screen.getByLabelText('Message everyone in this chat'),
      'Book flights{Enter}',
    );
    await waitFor(() =>
      expect(api.sendSharedMessage).toHaveBeenCalledWith('st-9', { text: 'Book flights' }),
    );
    const stop = await screen.findByRole('button', { name: 'Stop' });
    const reply = state.threads['st-9']!.messages.at(-1)!;
    threadStream('st-9').emit(
      'chat.delta',
      { threadId: 'st-9', messageId: reply.id, type: 'text_delta', text: 'Looking at flights' },
      'st-9',
    );
    expect(await screen.findByText('Looking at flights')).toBeTruthy();
    await userEvent.click(stop);
    expect(api.cancelSharedThread).toHaveBeenCalledWith('st-9');
    threadStream('st-9').emit('turn.interrupted', { threadId: 'st-9' }, 'st-9');
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
  });

  it('keeps the draft and says why when sending fails', async () => {
    const { team } = seeded();
    const r = await renderWithTeam(<SharedThreadPage threadId="st-9" />, { as: 'member', team });
    await screen.findByRole('list', { name: 'Messages' });
    r.team.failNext.sendSharedMessage = new TypeError('Failed to fetch');
    const box = screen.getByLabelText<HTMLTextAreaElement>('Message everyone in this chat');
    await userEvent.type(box, 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Cannot reach the Hub');
    expect(box.value).toBe('Hello');
  });

  it('lets a participant leave after asking', async () => {
    const { team } = seeded();
    const { api } = await renderWithTeam(<SharedThreadPage threadId="st-9" />, {
      as: 'member',
      team,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Leave this chat' }));
    const dialog = screen.getByRole('dialog', { name: 'Leave this chat?' });
    expect(dialog.textContent).toContain('Sam can share it with you again');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(api.unshareThread).toHaveBeenCalledWith('st-9', MEMBER_ID));
    await waitFor(() => expect(window.location.pathname).toBe('/team/shared'));
  });

  it('lets the owner add people and take someone out', async () => {
    const { team } = seeded();
    const { api } = await renderWithTeam(<SharedThreadPage threadId="st-9" />, { team });
    await screen.findByRole('list', { name: 'Messages' });
    expect(screen.getByText(/You share this chat/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Take Alex out of this chat' }));
    const dialog = screen.getByRole('dialog', { name: 'Take Alex out of this chat?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Take out' }));
    await waitFor(() => expect(api.unshareThread).toHaveBeenCalledWith('st-9', MEMBER_ID));
    await userEvent.click(screen.getByRole('button', { name: 'Add people' }));
    expect(await screen.findByRole('dialog', { name: 'Share this chat' })).toBeTruthy();
  });

  it('says so when the chat is no longer shared with you', async () => {
    const { rec, team } = seeded();
    const { state } = await renderWithTeam(<SharedThreadPage threadId="st-9" />, {
      as: 'member',
      team,
    });
    await screen.findByRole('list', { name: 'Messages' });
    state.threads['st-9'] = { ...rec, participants: [] };
    threadStream('st-9').emit(
      'thread.shared',
      { threadId: 'st-9', ownerAccountId: OWNER_ID, participants: [] },
      'st-9',
    );
    expect(await screen.findByText('This chat is not shared with you')).toBeTruthy();
  });

  it('retries a failed load', async () => {
    const { team } = seeded();
    await renderWithTeam(<SharedThreadPage threadId="st-9" />, {
      as: 'member',
      team,
      prepare: (t) => {
        t.failNext.getSharedThread = new TypeError('Failed to fetch');
      },
    });
    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Messages' })).toBeTruthy();
  });

  it('words the author lines', () => {
    const a = { accountId: 'x', displayName: 'Kim', as: 'wrote' as const };
    expect(authorLine({ role: 'user' }, a, 'y')).toBe('Kim');
    expect(authorLine({ role: 'user' }, a, 'x')).toBe('You');
    expect(authorLine({ role: 'assistant' }, { ...a, as: 'asked' }, 'y')).toBe(
      'Nova, asked by Kim',
    );
    expect(authorLine({ role: 'assistant' }, undefined, 'y')).toBe('Nova');
    expect(authorLine({ role: 'user' }, undefined, 'y')).toBe('Someone');
  });
});

describe('render sanity', () => {
  it('renders nothing for a missing thread menu', () => {
    function Harness() {
      const share = useShareMenu(null);
      return <span data-testid="n">{share.items.length}</span>;
    }
    render(<Harness />);
    expect(screen.getByTestId('n').textContent).toBe('0');
  });
});
