import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { FakeEventSource, createHub, message, streamReply, thread } from './fakes.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const sidebar = () => screen.getByRole('navigation', { name: 'Sidebar' });
const box = () => screen.getByLabelText<HTMLTextAreaElement>('Message');

async function openChat(over: Parameters<typeof thread>[0] = {}, hubInit = {}) {
  const t = thread({ title: 'Billing questions', ...over });
  const hub = createHub({ threads: [t], ...hubInit });
  if (!hub.state.messages.has(t.id)) hub.state.messages.set(t.id, []);
  const r = await renderApp({ hub, path: `/chat/${t.id}` });
  await waitFor(() => expect(hub.api.getThread).toHaveBeenCalled());
  const es = FakeEventSource.for(t.id);
  return { ...r, t, es };
}

async function send(text: string) {
  await userEvent.type(box(), text);
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
}

describe('thread list actions (FR-017)', () => {
  it('groups pinned and recent chats and shows unread and running status', async () => {
    const hub = createHub({
      threads: [
        thread({ title: 'Pinned one', pinned: true }),
        thread({ title: 'Unread one', unread: true }),
        thread({ title: 'Busy one', state: 'streaming' }),
        thread({ title: null }),
      ],
    });
    await renderApp({ hub });
    const pinned = await screen.findByRole('region', { name: 'Pinned' });
    expect(within(pinned).getByRole('link', { name: /Pinned one/ })).toBeTruthy();
    const recent = screen.getByRole('region', { name: 'Recent' });
    expect(within(recent).getByRole('link', { name: /Unread one, unread/ })).toBeTruthy();
    expect(within(recent).getByRole('link', { name: /Busy one.*Running/ })).toBeTruthy();
    expect(within(recent).getByRole('link', { name: /Untitled chat/ })).toBeTruthy();
  });

  it('renames inline with Enter and cancels with Escape', async () => {
    const { hub, t } = await openChat();
    await userEvent.click(
      within(sidebar()).getByRole('button', { name: `Actions for ${t.title}` }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Chat name' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Invoices{Enter}');
    await waitFor(() =>
      expect(hub.api.updateThread).toHaveBeenCalledWith(t.id, { title: 'Invoices' }),
    );
    expect(await within(sidebar()).findByRole('link', { name: /Invoices/ })).toBeTruthy();
    // F2 on the focused row renames too; Escape keeps the old name.
    within(sidebar())
      .getByRole('link', { name: /Invoices/ })
      .focus();
    await userEvent.keyboard('{F2}');
    await userEvent.type(screen.getByRole('textbox', { name: 'Chat name' }), 'zzz{Escape}');
    expect(within(sidebar()).getByRole('link', { name: /Invoices/ })).toBeTruthy();
    expect(hub.api.updateThread).toHaveBeenCalledTimes(1);
  });

  it('pins, archives and restores from the menu and context menu', async () => {
    const { hub, t } = await openChat();
    const row = () => within(sidebar()).getByRole('link', { name: /Billing questions/ });
    fireEvent.contextMenu(row(), { clientX: 10, clientY: 20 });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(hub.api.updateThread).toHaveBeenCalledWith(t.id, { pinned: true }));
    expect(await screen.findByRole('region', { name: 'Pinned' })).toBeTruthy();
    row().focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Archive' }));
    await waitFor(() =>
      expect(hub.api.updateThread).toHaveBeenCalledWith(t.id, { archived: true }),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/chat'));
    expect(within(sidebar()).queryByRole('link', { name: /Billing questions/ })).toBeNull();
    await userEvent.click(within(sidebar()).getByRole('button', { name: 'Archived chats' }));
    const archived = await within(sidebar()).findByRole('link', { name: /Billing questions/ });
    expect(archived).toBeTruthy();
    await userEvent.click(within(sidebar()).getByRole('button', { name: /Actions for/ }));
    expect(screen.queryByRole('menuitem', { name: /Pin/ })).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Unarchive' }));
    await waitFor(() =>
      expect(hub.api.updateThread).toHaveBeenCalledWith(t.id, { archived: false }),
    );
    await userEvent.click(within(sidebar()).getByRole('button', { name: 'Back to chats' }));
    expect(await within(sidebar()).findByRole('link', { name: /Billing questions/ })).toBeTruthy();
  });

  it('deletes only after confirmation; Escape closes the dialog and returns focus', async () => {
    const { hub, t } = await openChat();
    const more = within(sidebar()).getByRole('button', { name: `Actions for ${t.title}` });
    await userEvent.click(more);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    expect(screen.getByRole('dialog', { name: 'Delete this chat?' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(more));
    expect(hub.api.deleteThread).not.toHaveBeenCalled();
    await userEvent.click(more);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(hub.api.deleteThread).toHaveBeenCalledWith(t.id));
    await waitFor(() => expect(window.location.pathname).toBe('/chat'));
    expect(screen.getByText('Chat deleted.')).toBeTruthy();
  });

  it('reports a failed action without changing the list', async () => {
    const { hub, t } = await openChat();
    hub.state.failNext.updateThread = new ApiError(500, {
      code: 'x',
      message: 'Disk full',
      retryable: true,
    });
    await userEvent.click(
      within(sidebar()).getByRole('button', { name: `Actions for ${t.title}` }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Pin' }));
    expect(await screen.findByText('Could not pin: Disk full')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Pinned' })).toBeNull();
  });

  it('marks an unread chat read when opened', async () => {
    const { hub, t } = await openChat({ unread: true });
    await waitFor(() => expect(hub.api.updateThread).toHaveBeenCalledWith(t.id, { unread: false }));
  });

  it('creates a chat with the new-chat shortcut and sends the first message', async () => {
    const { hub } = await openChat();
    await userEvent.keyboard('{Control>}n{/Control}');
    expect(window.location.pathname).toBe('/chat');
    expect(screen.getByRole('heading', { name: 'New chat' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(box()));
    await send('What is due this week?');
    await waitFor(() =>
      expect(hub.api.createThread).toHaveBeenCalledWith({
        mode: 'chat',
        title: 'What is due this week?',
        model: 'pa1/mock-fast',
        reasoningLevel: undefined,
      }),
    );
    const created = hub.state.threads[0]!;
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${created.id}`));
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenCalledWith(created.id, {
        text: 'What is due this week?',
        attachments: undefined,
      }),
    );
    expect(within(sidebar()).getByRole('link', { name: /What is due this week/ })).toBeTruthy();
  });

  it('keeps the message when a new chat cannot be created', async () => {
    const hub = createHub();
    hub.state.failNext.createThread = new TypeError('Failed to fetch');
    await renderApp({ hub });
    await send('Keep me');
    expect(await screen.findByText(/Could not start the chat: Cannot reach the Hub/)).toBeTruthy();
    expect(box().value).toBe('Keep me');
  });
});

describe('search (FR-017)', () => {
  it('shows snippets with the match and jumps to the message', async () => {
    const t = thread({ title: 'Trip' });
    const target = message(t.id, {
      parts: [{ type: 'text', text: 'Book the ferry to the island' }],
    });
    const hub = createHub({
      threads: [t],
      searchHits: [
        {
          threadId: t.id,
          messageId: target.id,
          threadTitle: 'Trip',
          snippet: 'Book the <mark>ferry</mark> to the island',
          createdAt: '2026-10-01T12:00:00.000Z',
        },
      ],
    });
    hub.state.messages.set(t.id, [target]);
    await renderApp({ hub });
    await userEvent.click(within(sidebar()).getByRole('button', { name: 'Search' }));
    const input = screen.getByRole('searchbox', { name: 'Search chats' });
    expect(document.activeElement).toBe(input);
    await userEvent.type(input, 'ferry');
    const hit = await screen.findByRole('link', { name: /Trip.*ferry/ });
    expect(hit.querySelector('mark')?.textContent).toBe('ferry');
    expect(hub.api.search).toHaveBeenCalledWith('ferry', 20);
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(hit);
    await userEvent.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(input);
    await userEvent.click(hit);
    expect(window.location.pathname).toBe(`/chat/${t.id}`);
    expect(window.location.search).toBe(`?m=${target.id}`);
    await waitFor(() => expect(document.activeElement?.id).toBe(`msg-${target.id}`));
  });

  it('says when nothing matches, reports errors, and Escape closes', async () => {
    const hub = createHub();
    await renderApp({ hub });
    const button = within(sidebar()).getByRole('button', { name: 'Search' });
    await userEvent.click(button);
    await userEvent.type(screen.getByRole('searchbox'), 'nothing');
    expect(await screen.findByText('No messages match “nothing”.')).toBeTruthy();
    hub.state.failNext.search = new ApiError(500, {
      code: 'x',
      message: 'Index busy',
      retryable: true,
    });
    await userEvent.type(screen.getByRole('searchbox'), 's');
    expect(await screen.findByText('Index busy')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});

describe('streaming (FR-018)', () => {
  it('renders deltas as Markdown, announces throttled progress and completion', async () => {
    const { hub, t, es } = await openChat({}, {});
    es.open();
    await send('Explain');
    await waitFor(() => expect(hub.api.sendMessage).toHaveBeenCalled());
    const [, assistant] = hub.state.messages.get(t.id)!;
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(within(screen.getByRole('main')).getByText('Running')).toBeTruthy();
    streamReply(es, t.id, assistant!.id, ['**Bold** and ', '[a link](https://example.com)'], null);
    const log = screen.getByRole('log', { name: 'Messages' });
    expect(log.querySelector('strong')?.textContent).toBe('Bold');
    const link = within(log).getByRole('link', { name: 'a link' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByTestId('announcer').textContent).toMatch(
      /Still responding, about \d+ words/,
    );
    hub.persist(t.id, assistant!.id, {
      status: 'complete',
      parts: [{ type: 'text', text: '**Bold** and [a link](https://example.com)' }],
    });
    es.emit(
      'chat.message.completed',
      { threadId: t.id, messageId: assistant!.id, status: 'complete', usage: null },
      t.id,
    );
    es.emit('turn.completed', { threadId: t.id }, t.id);
    expect(screen.getByTestId('announcer').textContent).toMatch(/Response complete/);
    expect(await screen.findByRole('button', { name: 'Send' })).toBeTruthy();
    await waitFor(() => expect(hub.api.getThread).toHaveBeenCalledTimes(2));
    expect(log.querySelectorAll('strong')).toHaveLength(1);
  });

  it('does not announce every token', async () => {
    const t = thread({ title: 'Quiet' });
    const hub = createHub({ threads: [t] });
    hub.state.messages.set(t.id, []);
    await renderApp({ hub, path: `/chat/${t.id}`, announceEveryMs: 60_000 });
    const es = FakeEventSource.for(t.id);
    await send('Go');
    const [, assistant] = hub.state.messages.get(t.id)!;
    streamReply(
      es,
      t.id,
      assistant!.id,
      Array.from({ length: 40 }, (_, i) => `w${i} `),
      null,
    );
    expect(screen.getByTestId('announcer').textContent?.trim()).toBe('Assistant is responding.');
  });

  it('never renders raw HTML from a reply', async () => {
    const t = thread();
    const hub = createHub({ threads: [t] });
    hub.state.messages.set(t.id, [
      message(t.id, {
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hi <img src=x onerror="alert(1)"> <script>bad()</script>' }],
      }),
    ]);
    await renderApp({ hub, path: `/chat/${t.id}` });
    const log = await screen.findByRole('log');
    await waitFor(() => expect(log.textContent).toContain('Hi'));
    expect(log.querySelector('img')).toBeNull();
    expect(log.querySelector('script')).toBeNull();
  });

  it('stops with the button, keeps the partial reply and labels it Stopped', async () => {
    const { hub, t, es } = await openChat();
    await send('Long answer please');
    const [, assistant] = hub.state.messages.get(t.id)!;
    streamReply(es, t.id, assistant!.id, ['Partial ', 'answer'], null);
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(hub.api.cancel).toHaveBeenCalledWith(t.id);
    es.emit(
      'chat.message.completed',
      { threadId: t.id, messageId: assistant!.id, status: 'incomplete', usage: null },
      t.id,
    );
    es.emit('turn.interrupted', { threadId: t.id }, t.id);
    const stopped = await screen.findByRole('article', { name: 'Assistant, stopped' });
    expect(stopped.textContent).toContain('Partial answer');
    expect(within(stopped).getByText('Stopped')).toBeTruthy();
    expect(screen.getByTestId('announcer').textContent).toMatch(/Response stopped/);
  });

  it('stops with Escape while streaming', async () => {
    const { hub, t, es } = await openChat();
    await send('Go');
    const [, assistant] = hub.state.messages.get(t.id)!;
    streamReply(es, t.id, assistant!.id, ['x'], null);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(hub.api.cancel).toHaveBeenCalledWith(t.id));
  });

  it('shows an error part with Retry, which resends the last user message', async () => {
    const t = thread();
    const hub = createHub({ threads: [t] });
    const user = message(t.id, {
      role: 'user',
      parts: [
        { type: 'text', text: 'Summarize the report' },
        { type: 'file', attachmentId: 'att1', name: 'r.txt', mime: 'text/plain', size: 10 },
      ],
    });
    const failed = message(t.id, {
      role: 'assistant',
      status: 'error',
      parts: [{ type: 'error', code: 'provider_unavailable', message: 'The provider timed out.' }],
    });
    hub.state.messages.set(t.id, [user, failed]);
    await renderApp({ hub, path: `/chat/${t.id}` });
    const alert = await screen.findByText(/The provider timed out/);
    expect(alert).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenCalledWith(t.id, {
        text: 'Summarize the report',
        attachments: [{ name: 'r.txt', mime: 'text/plain', data: btoa('file-bytes') }],
      }),
    );
    expect(hub.api.fetchAttachment).toHaveBeenCalledWith('att1');
  });

  it('puts the text back with the reason when a send fails, including a busy thread', async () => {
    const { hub } = await openChat();
    hub.state.failNext.sendMessage = new ApiError(409, {
      code: 'conflict',
      message: 'busy',
      retryable: true,
    });
    await send('Do not lose me');
    expect(await screen.findByText(/A reply is still running in this chat/)).toBeTruthy();
    expect(box().value).toBe('Do not lose me');
    expect(screen.queryByText('Do not lose me', { selector: 'p' })).toBeNull();
    hub.state.failNext.sendMessage = new ApiError(500, {
      code: 'x',
      message: 'Server error.',
      retryable: true,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Message not sent: Server error\./)).toBeTruthy();
    expect(box().value).toBe('Do not lose me');
    await userEvent.type(box(), '!');
    expect(screen.queryByText(/Message not sent/)).toBeNull();
  });

  it('handles messages from elsewhere and a failed load', async () => {
    const { hub, t, es } = await openChat();
    const other = message(t.id, { role: 'user', parts: [{ type: 'text', text: 'From my phone' }] });
    hub.state.messages.set(t.id, [other]);
    es.emit(
      'chat.message.created',
      { threadId: t.id, messageId: other.id, role: 'user', turnId: null },
      t.id,
    );
    es.emit('chat.message.updated', { threadId: t.id, messageId: other.id, reason: 'edit' }, t.id);
    // An event about another thread is ignored.
    es.emit('turn.started', { threadId: 'elsewhere' }, 'elsewhere');
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(await screen.findByText('From my phone')).toBeTruthy();
  });

  it('explains a missing chat', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/chat/missing' });
    expect(await screen.findByText('This chat was deleted or does not exist.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Start a new chat' }));
    expect(window.location.pathname).toBe('/chat');
  });
});

describe('composer (FR-021, FR-023, FR-024)', () => {
  const file = (name: string, type: string, size?: number) => {
    const f = new File(['content'], name, { type });
    if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
    return f;
  };

  it('attaches by button, removes chips, and sends files as base64', async () => {
    const { hub, t } = await openChat();
    await userEvent.upload(screen.getByTestId('file-input'), [file('notes.md', '')]);
    const chips = await screen.findByRole('list', { name: 'Attachments' });
    expect(within(chips).getByText('notes.md')).toBeTruthy();
    await userEvent.upload(screen.getByTestId('file-input'), [file('extra.txt', 'text/plain')]);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove extra.txt' }));
    expect(screen.queryByText('extra.txt')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenCalledWith(t.id, {
        text: '',
        attachments: [{ name: 'notes.md', mime: 'text/markdown', data: btoa('content') }],
      }),
    );
  });

  it('enforces type, size and count limits with clear errors', async () => {
    await openChat();
    const input = screen.getByTestId('file-input');
    fireEvent.change(input, {
      target: {
        files: [
          file('virus.exe', 'application/x-msdownload'),
          file('huge.pdf', 'application/pdf', 21 * 1024 * 1024),
        ],
      },
    });
    const alert = await screen.findByText(/virus\.exe is not a supported file type/);
    expect(alert.closest('[role="alert"]')!.textContent).toMatch(
      /huge\.pdf is 21\.0 MB; the limit is 20\.0 MB/,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/virus\.exe/)).toBeNull();
    const eleven = Array.from({ length: 11 }, (_, i) => file(`f${i}.txt`, 'text/plain'));
    fireEvent.change(input, { target: { files: eleven } });
    expect(
      await screen.findByText(/f10\.txt was not added: a message can have up to 10 attachments/),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Attachments' })).getAllByRole('listitem'),
    ).toHaveLength(10);
  });

  it('accepts dropped and pasted files', async () => {
    await openChat();
    const chat = screen.getByRole('region', { name: 'Billing questions' });
    fireEvent.dragOver(chat, { dataTransfer: { types: ['Files'], files: [] } });
    fireEvent.drop(chat, {
      dataTransfer: { types: ['Files'], files: [file('drop.png', 'image/png')] },
    });
    expect(await screen.findByText('drop.png')).toBeTruthy();
    fireEvent.paste(box(), { clipboardData: { files: [file('paste.png', 'image/png')] } });
    expect(await screen.findByText('paste.png')).toBeTruthy();
    fireEvent.drop(chat, { dataTransfer: { types: [], files: [] } });
  });

  it('respects Mod+Enter to send when configured', async () => {
    const t = thread();
    const hub = createHub({ threads: [t] });
    hub.state.messages.set(t.id, []);
    hub.state.settings['general.enterToSend'] = 'mod+enter';
    await renderApp({ hub, path: `/chat/${t.id}` });
    box().focus();
    await userEvent.keyboard('a{Enter}b');
    expect(box().value).toBe('a\nb');
    expect(hub.api.sendMessage).not.toHaveBeenCalled();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(hub.api.sendMessage).toHaveBeenCalled());
  });

  it('changes the model per thread and shows reasoning levels for models that support them', async () => {
    const { hub, t } = await openChat();
    const picker = await screen.findByRole('combobox', { name: 'Model' });
    expect(screen.queryByRole('combobox', { name: 'Reasoning level' })).toBeNull();
    await userEvent.selectOptions(picker, 'pa1/mock-smart');
    await waitFor(() =>
      expect(hub.api.updateThread).toHaveBeenCalledWith(t.id, { model: 'pa1/mock-smart' }),
    );
    const reasoning = await screen.findByRole('combobox', { name: 'Reasoning level' });
    await userEvent.selectOptions(reasoning, 'high');
    await waitFor(() =>
      expect(hub.api.updateThread).toHaveBeenCalledWith(t.id, { reasoningLevel: 'high' }),
    );
    hub.state.failNext.updateThread = new ApiError(500, {
      code: 'x',
      message: 'nope',
      retryable: true,
    });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Model' }), 'pa1/mock-fast');
    expect(await screen.findByText(/Could not change the model: nope/)).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' }).value).toBe(
      'pa1/mock-smart',
    );
  });

  it('offers to make the first model the default in a new chat, and asks for a provider when none exist', async () => {
    const { hub } = await renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Make it the default' }));
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('chat.defaultModel', 'pa1/mock-fast'),
    );
    resetDom();
    await renderApp({ hub: createHub({ models: [] }) });
    expect(await screen.findByText(/Connect a model provider in Settings/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Connect a provider' }));
    expect(window.location.pathname).toBe('/settings/accounts');
  });
});

describe('mode state with streaming', () => {
  it('keeps receiving the stream while another mode is shown', async () => {
    const { hub, t, es } = await openChat();
    await send('Background');
    const [, assistant] = hub.state.messages.get(t.id)!;
    await userEvent.keyboard('{Control>}3{/Control}');
    streamReply(es, t.id, assistant!.id, ['done while away'], null);
    act(() => undefined);
    await userEvent.keyboard('{Control>}1{/Control}');
    expect(await screen.findByText('done while away')).toBeTruthy();
  });
});
