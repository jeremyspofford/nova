// Suggested follow-ups (FR-028) and slash commands (FR-046) in the composer.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { SlashCommandView } from '@nova/shared';
import { applySlash, filterSlash, slashAt } from '../src/chat/slash.ts';
import { message, streamReply } from './fakes.ts';
import { box, openChat } from './chat-helpers.tsx';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const chips = () => screen.queryByRole('list', { name: 'Suggested follow-ups' });

function replied(tid: string) {
  return [
    message(tid, { role: 'user', parts: [{ type: 'text', text: 'Plan a trip' }] }),
    message(tid, {
      role: 'assistant',
      status: 'complete',
      parts: [{ type: 'text', text: 'Here is a plan.' }],
    }),
  ];
}

const SLASH: SlashCommandView[] = [
  {
    name: 'review',
    description: 'Review a pull request',
    skillId: 'skill:user:review',
    source: 'user',
    pluginId: null,
  },
  {
    name: 'summarize',
    description: 'Summarize the chat',
    skillId: 'skill:builtin:summarize',
    source: 'builtin',
    pluginId: null,
  },
  {
    name: 'release-notes',
    description: 'Draft release notes',
    skillId: 'skill:p1:release-notes',
    source: 'plugin',
    pluginId: 'p1',
  },
];

describe('suggested follow-ups (FR-028)', () => {
  async function withSuggestions(items: string[]) {
    const r = await openChat({}, { messages: replied });
    r.hub.state.m4.suggestions.set(r.t.id, items);
    return r;
  }

  it('shows chips after a reply and takes the first with Tab or Right arrow', async () => {
    const { hub, t, es } = await withSuggestions([]);
    hub.state.m4.suggestions.set(t.id, ['Add a budget', 'Make it shorter', 'Translate it', 'Four']);
    // A new reply finishes; the composer asks for follow-ups for it.
    await userEvent.type(box(), 'And hotels?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const assistant = hub.state.messages.get(t.id)!.at(-1)!;
    hub.persist(t.id, assistant.id, {
      status: 'complete',
      parts: [{ type: 'text', text: 'Two hotels.' }],
    });
    streamReply(es, t.id, assistant.id, ['Two hotels.']);
    const list = await screen.findByRole('list', { name: 'Suggested follow-ups' });
    const buttons = within(list).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Add a budget',
      'Make it shorter',
      'Translate it',
      '',
    ]);
    expect(buttons[3]!.getAttribute('aria-label')).toBe('Turn off suggested follow-ups');
    expect(document.getElementById('composer-help')!.textContent).toMatch(
      /Tab or Right arrow takes the first suggested follow-up/,
    );
    box().focus();
    await userEvent.keyboard('{Tab}');
    expect(box().value).toBe('Add a budget');
    expect(document.activeElement).toBe(box());
    // With text in the box, the chips go and Tab is a normal key again.
    expect(chips()).toBeNull();
    await userEvent.clear(box());
    expect(chips()).toBeTruthy();
    await userEvent.keyboard('{ArrowRight}');
    expect(box().value).toBe('Add a budget');
    await userEvent.clear(box());
    await userEvent.click(screen.getByRole('button', { name: 'Translate it' }));
    expect(box().value).toBe('Translate it');
    await waitFor(() => expect(document.activeElement).toBe(box()));
    // Shift+Tab still leaves the box.
    await userEvent.clear(box());
    await userEvent.tab({ shift: true });
    expect(document.activeElement).not.toBe(box());
  });

  it('asks the Hub only when suggestions are on, and the chip button turns them off', async () => {
    const { hub, t, es } = await withSuggestions(['Next step']);
    // The thread opened with a finished reply, so the Hub was asked once.
    await waitFor(() => expect(hub.api.suggestions).toHaveBeenCalledTimes(1));
    // A new reply asks again; its answer has the chips.
    await userEvent.type(box(), 'More');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const a = hub.state.messages.get(t.id)!.at(-1)!;
    hub.persist(t.id, a.id, { status: 'complete', parts: [{ type: 'text', text: 'Done.' }] });
    streamReply(es, t.id, a.id, ['Done.']);
    await screen.findByRole('button', { name: 'Next step' });
    await userEvent.click(screen.getByRole('button', { name: 'Turn off suggested follow-ups' }));
    await waitFor(() => expect(hub.api.setSetting).toHaveBeenCalledWith('chat.suggestions', false));
    expect(chips()).toBeNull();
    expect(screen.getByTestId('announcer').textContent).toMatch(/Suggested follow-ups are off/);
  });

  it('shows nothing when the setting is off or the Hub fails', async () => {
    const r = await openChat(
      {},
      {
        messages: replied,
        hub: {
          settings: {
            'onboarding.state': { step: 'done', completed: true, skipped: false },
            'chat.suggestions': false,
          },
        },
      },
    );
    r.hub.state.m4.suggestions.set(r.t.id, ['Never shown']);
    await screen.findByText('Here is a plan.');
    expect(r.hub.api.suggestions).not.toHaveBeenCalled();
    expect(chips()).toBeNull();
    resetDom();

    const f = await openChat({}, { messages: replied });
    f.hub.state.failNext.suggestions = new Error('no');
    await screen.findByText('Here is a plan.');
    expect(chips()).toBeNull();
  });

  it('does not suggest while a reply is streaming or for a new chat', async () => {
    const { hub } = await openChat(
      {},
      {
        messages: (tid) => [
          message(tid, { role: 'user', parts: [{ type: 'text', text: 'Hi' }] }),
          message(tid, { role: 'assistant', status: 'streaming', parts: [] }),
        ],
      },
    );
    await screen.findByText('Hi');
    expect(hub.api.suggestions).not.toHaveBeenCalled();
  });
});

describe('slash commands (FR-046)', () => {
  const listbox = () => screen.findByRole('listbox', { name: 'Slash commands' });

  it('opens on / at the start, filters, moves with arrows and inserts the command', async () => {
    const { hub } = await openChat();
    hub.state.m4.slash = SLASH;
    await userEvent.type(box(), '/');
    const list = await listbox();
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(3));
    expect(hub.api.slashCommands).toHaveBeenCalledWith({});
    const input = screen.getByRole('combobox', { name: 'Message' });
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    // Sorted by name when nothing is typed.
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.querySelector('.slash-name')?.textContent),
    ).toEqual(['/release-notes', '/review', '/summarize']);
    await userEvent.type(box(), 're');
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('option')
          .map((o) => o.querySelector('.slash-name')?.textContent),
      ).toEqual(['/release-notes', '/review']),
    );
    expect(within(list.parentElement!).getByRole('status').textContent).toBe('2 commands');
    await userEvent.keyboard('{ArrowDown}');
    const options = within(list).getAllByRole('option');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1]!.id);
    await userEvent.keyboard('{Enter}');
    expect(box().value).toBe('/review ');
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull();
    expect(screen.getByLabelText('Message').getAttribute('role')).toBeNull();
    // Enter now sends the message with the command.
    await userEvent.type(box(), 'PR 12{Enter}');
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenLastCalledWith(expect.any(String), {
        text: '/review PR 12',
      }),
    );
  });

  it('closes with Escape, ignores / later in the text, and offers a button', async () => {
    const { hub } = await openChat();
    hub.state.m4.slash = SLASH;
    await userEvent.type(box(), 'see a/b ');
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull();
    await userEvent.clear(box());
    await userEvent.type(box(), '/sum');
    await listbox();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).toBeNull();
    expect(box().value).toBe('/sum');
    await userEvent.clear(box());
    await userEvent.type(box(), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Use a slash command' }));
    const list = await listbox();
    expect(box().value).toBe('/hello');
    // Nothing matches "hello"; Enter falls through to send.
    expect(await within(list.parentElement!).findByText('No matching commands')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Use a slash command' }));
    expect(box().value).toBe('/hello');
  });

  it('chooses with a click or Tab, and says when the list is unavailable', async () => {
    const { hub, t } = await openChat({ projectId: 'proj1' });
    hub.state.m4.slash = SLASH;
    await userEvent.type(box(), '/rev');
    const list = await listbox();
    expect(hub.api.slashCommands).toHaveBeenCalledWith({ projectId: 'proj1' });
    await userEvent.click(await within(list).findByRole('option', { name: /review/ }));
    expect(box().value).toBe('/review ');
    await userEvent.clear(box());
    await userEvent.type(box(), '/summ{Tab}');
    await waitFor(() => expect(box().value).toBe('/summarize '));
    void t;

    hub.state.failNext.slashCommands = new Error('down');
    await userEvent.clear(box());
    await userEvent.type(box(), '/');
    expect(await screen.findByText('Commands are unavailable right now.')).toBeTruthy();
  });

  it('finds the token, ranks names before descriptions, and inserts the command', () => {
    expect(slashAt('/rev', 4)).toEqual({ query: 'rev', end: 4 });
    expect(slashAt('/rev more', 4)).toEqual({ query: 'rev', end: 4 });
    expect(slashAt('/rev more', 9)).toBeNull();
    expect(slashAt('/a/b', 2)).toBeNull();
    expect(slashAt('x /rev', 6)).toBeNull();
    expect(slashAt('/', 0)).toBeNull();
    expect(filterSlash(SLASH, 'pull').map((c) => c.name)).toEqual(['review']);
    expect(filterSlash(SLASH, 'zzz')).toEqual([]);
    expect(filterSlash(SLASH, 'sum').map((c) => c.name)).toEqual(['summarize']);
    expect(applySlash('/re  tail', 'review', 3)).toEqual({ text: '/review tail', caret: 8 });
  });
});
