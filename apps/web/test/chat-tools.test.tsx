// Tool cards in chat (docs/04 §2.2, FR-099): stored calls, live updates from tool.call.* events,
// untrusted results shown as text, and web citations with title and host (FR-029).
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { message } from './fakes.ts';
import { announcer, chatLog, openWith, toolPart } from './chat-m3-helpers.tsx';
import { box } from './chat-helpers.tsx';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const card = (name: RegExp | string) => screen.getByRole('group', { name });

describe('tool cards (FR-099)', () => {
  it('renders a stored call collapsed, and expands to arguments and a plain-text result', async () => {
    await openWith({
      messages: (tid) => [
        message(tid, { role: 'user', parts: [{ type: 'text', text: 'Read my notes' }] }),
        message(tid, {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Reading them now.' },
            toolPart({ resultPreview: '<img src=x onerror="alert(1)"> **not bold**' }),
            { type: 'text', text: 'They say hello.' },
            toolPart({
              callId: 'call2',
              tool: 'mcp:files.search',
              title: null,
              source: 'mcp',
              status: 'error',
              resultPreview: 'Server crashed',
              durationMs: 65_000,
            }),
          ],
        }),
      ],
    });
    const read = await screen.findByRole('group', { name: 'Tool call: Read file' });
    const head = within(read).getByRole('button', { name: /Read file/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(head.textContent).toContain('fs.read');
    expect(head.textContent).toContain('Built-in');
    expect(head.textContent).toContain('Done');
    expect(head.textContent).toContain('120 ms');
    await userEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(within(read).getByText('{"path":"notes/a.md"}')).toBeTruthy();
    const result = within(read).getByText(/not bold/);
    expect(result.tagName).toBe('PRE');
    expect(result.textContent).toBe('<img src=x onerror="alert(1)"> **not bold**');
    expect(read.querySelector('img, strong')).toBeNull();

    // Text, card, text, card: in the order the reply wrote them.
    const article = read.closest('article')!;
    const order = [...article.querySelectorAll('.md, .tool-card')].map((el) =>
      el.classList.contains('md') ? el.textContent : el.getAttribute('aria-label'),
    );
    expect(order).toEqual([
      'Reading them now.',
      'Tool call: Read file',
      'They say hello.',
      'Tool call: mcp:files.search',
    ]);

    // An MCP call names its server; a failure shows its error without expanding.
    const mcp = card('Tool call: mcp:files.search');
    expect(mcp.textContent).toContain('MCP server files');
    expect(mcp.textContent).toContain('Failed');
    expect(mcp.textContent).toContain('1 min 5 s');
    expect(within(mcp).getByText('Server crashed')).toBeTruthy();
  });

  it('follows a call live: started, progress, completed, between streamed text', async () => {
    const { hub, t, es } = await openWith();
    await userEvent.type(box(), 'Check the file');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(hub.api.sendMessage).toHaveBeenCalled());
    const reply = hub.state.messages.get(t.id)!.at(-1)!;
    es.emit('turn.started', { threadId: t.id, turnId: reply.turnId }, t.id);
    es.emit(
      'chat.delta',
      { threadId: t.id, messageId: reply.id, type: 'text_delta', text: 'Looking. ' },
      t.id,
    );
    es.emit(
      'tool.call.started',
      { callId: 'c9', tool: 'fs.read', source: 'builtin', argsPreview: '{"path":"x.md"}' },
      t.id,
    );
    const live = await screen.findByRole('group', { name: 'Tool call: fs.read' });
    expect(live.textContent).toContain('Running');
    expect(announcer()).toBe('Running fs.read.');

    es.emit('tool.call.progress', { callId: 'c9', chunk: 'partial output' }, t.id);
    await userEvent.click(within(live).getByRole('button', { name: /fs\.read/ }));
    expect(within(live).getByText('Output so far')).toBeTruthy();
    expect(within(live).getByText('partial output')).toBeTruthy();

    es.emit(
      'chat.delta',
      { threadId: t.id, messageId: reply.id, type: 'text_delta', text: 'Found it.' },
      t.id,
    );
    es.emit(
      'tool.call.completed',
      { callId: 'c9', status: 'ok', durationMs: 1200, resultPreview: 'file text' },
      t.id,
    );
    await waitFor(() => expect(live.textContent).toContain('Done'));
    expect(live.textContent).toContain('1.2 s');
    expect(within(live).queryByText('Output so far')).toBeNull();
    expect(within(live).getByText('file text')).toBeTruthy();
    const article = live.closest('article')!;
    const order = [...article.querySelectorAll('.md, .tool-card')].map((el) =>
      el.classList.contains('md') ? el.textContent?.trim() : 'card',
    );
    expect(order).toEqual(['Looking.', 'card', 'Found it.']);

    // A replayed start never moves a finished call back to running.
    es.emit(
      'tool.call.started',
      { callId: 'c9', tool: 'fs.read', source: 'builtin', argsPreview: '{}' },
      t.id,
    );
    expect(live.textContent).toContain('Done');

    // Once the Hub stores the reply, the stored part takes the card's place, once.
    hub.persist(t.id, reply.id, {
      status: 'complete',
      parts: [
        { type: 'text', text: 'Looking. ' },
        toolPart({ callId: 'c9', title: null, tool: 'fs.read', resultPreview: 'file text' }),
        { type: 'text', text: 'Found it.' },
      ],
    });
    es.emit(
      'chat.message.completed',
      { threadId: t.id, messageId: reply.id, status: 'complete', usage: null },
      t.id,
    );
    es.emit('turn.completed', { threadId: t.id }, t.id);
    await waitFor(() => expect(hub.api.getThread).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(within(chatLog()).getAllByRole('group', { name: 'Tool call: fs.read' })).toHaveLength(
        1,
      ),
    );
  });

  it('shows a policy denial and announces failed calls', async () => {
    const { hub, t, es } = await openWith();
    await userEvent.type(box(), 'Delete it');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(hub.api.sendMessage).toHaveBeenCalled());
    es.emit(
      'tool.call.started',
      { callId: 'd1', tool: 'fs.delete', source: 'builtin', argsPreview: '{}' },
      t.id,
    );
    es.emit(
      'policy.denied',
      { callId: 'd1', tool: 'fs.delete', reason: 'Deleting outside the project is blocked.' },
      t.id,
    );
    const denied = await screen.findByRole('group', { name: 'Tool call: fs.delete' });
    await waitFor(() => expect(denied.textContent).toContain('Denied'));
    expect(within(denied).getByText('Deleting outside the project is blocked.')).toBeTruthy();
    es.emit(
      'tool.call.started',
      { callId: 'd2', tool: 'web.fetch', source: 'builtin', argsPreview: '{}' },
      t.id,
    );
    es.emit(
      'tool.call.completed',
      {
        callId: 'd2',
        tool: 'web.fetch',
        status: 'timeout',
        durationMs: 60_000,
        resultPreview: null,
      },
      t.id,
    );
    await waitFor(() => expect(announcer()).toBe('web.fetch: Timed out.'));
    // Events for another chat are ignored.
    es.emit(
      'tool.call.started',
      { callId: 'x1', tool: 'other.tool', source: 'builtin', argsPreview: '{}' },
      'someone-else',
    );
    expect(screen.queryByRole('group', { name: 'Tool call: other.tool' })).toBeNull();
  });
});

describe('web citations (FR-029)', () => {
  it('shows each source title and host and opens it in a new tab without an opener', async () => {
    await openWith({
      messages: (tid) => [
        message(tid, {
          role: 'assistant',
          parts: [{ type: 'text', text: 'Rates went up [1].' }],
          citations: [
            {
              id: 'c1',
              messageId: 'm',
              idx: 1,
              url: 'https://www.example.com/rates?q=1',
              sourceId: null,
              title: 'Rate update',
              snippet: 'Rates rose by 0.25 points.',
            },
            {
              id: 'c2',
              messageId: 'm',
              idx: 2,
              url: 'https://news.example.org/a',
              sourceId: null,
              title: null,
              snippet: null,
            },
            {
              id: 'c3',
              messageId: 'm',
              idx: 3,
              url: 'javascript:alert(1)',
              sourceId: null,
              title: 'Sneaky',
              snippet: null,
            },
          ],
        }),
      ],
    });
    const sources = await screen.findByRole('group', { name: 'Sources' });
    const link = within(sources).getByRole('link', { name: 'Rate update' });
    expect(link.getAttribute('href')).toBe('https://www.example.com/rates?q=1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(sources).getByText('example.com')).toBeTruthy();
    // No title: the host names the source.
    expect(within(sources).getByRole('link', { name: 'news.example.org' })).toBeTruthy();
    // Unsafe schemes never become links.
    expect(within(sources).queryByRole('link', { name: 'Sneaky' })).toBeNull();
    expect(within(sources).getByText('Sneaky')).toBeTruthy();
  });
});
