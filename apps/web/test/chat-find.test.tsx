// FR-025: find in chat (Mod+F) and the role shown on global search results.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createHub, message, testRegistry, thread } from './fakes.ts';
import { box, openChat } from './chat-helpers.tsx';
import { renderApp, resetDom } from './render.tsx';

const scrolled: Element[] = [];
beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
});
afterEach(() => {
  resetDom();
  // @ts-expect-error jsdom has no scrollIntoView; the test adds and removes it
  delete Element.prototype.scrollIntoView;
});

const conversation = (tid: string) => [
  message(tid, { role: 'user', parts: [{ type: 'text', text: 'When is the invoice due?' }] }),
  message(tid, {
    role: 'assistant',
    parts: [{ type: 'text', text: '**Due** on Friday. Overdue invoices cost extra.' }],
  }),
];

const findBox = () => screen.getByRole('searchbox', { name: 'Find in chat' });
const marks = () => [...document.querySelectorAll<HTMLElement>('.chat-log mark[data-find]')];
const current = () => document.querySelector<HTMLElement>('.chat-log mark[data-current="true"]');

describe('find in chat (FR-025)', () => {
  it('opens with Mod+F, marks matches, steps with Enter and Shift+Enter, and closes with Esc', async () => {
    await openChat({}, { messages: conversation });
    await screen.findByText('When is the invoice due?');
    box().focus();
    await userEvent.keyboard('{Control>}f{/Control}');
    expect(document.activeElement).toBe(findBox());
    await userEvent.type(findBox(), 'due');
    const status = await screen.findByText('1 of 3');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(marks().map((m) => m.textContent)).toEqual(['due', 'Due', 'due']);
    // Matches inside Markdown formatting are found in the rendered text.
    expect(marks()[1]!.closest('strong')).toBeTruthy();
    expect(current()).toBe(marks()[0]);
    expect(scrolled.at(-1)).toBe(marks()[0]);

    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('2 of 3')).toBeTruthy();
    expect(current()).toBe(marks()[1]);
    await userEvent.keyboard('{Enter}{Enter}');
    expect(screen.getByText('1 of 3')).toBeTruthy();
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(screen.getByText('3 of 3')).toBeTruthy();
    expect(scrolled.at(-1)).toBe(marks()[2]);
    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }));
    expect(screen.getByText('2 of 3')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('3 of 3')).toBeTruthy();

    // Mod+F again goes back to the field instead of opening a second bar.
    box().focus();
    await userEvent.keyboard('{Control>}f{/Control}');
    expect(document.activeElement).toBe(findBox());
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('searchbox', { name: 'Find in chat' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(marks()).toHaveLength(0);
  });

  it('says when nothing matches and disables stepping', async () => {
    await openChat({}, { messages: conversation });
    await screen.findByText('When is the invoice due?');
    await userEvent.click(screen.getByRole('button', { name: 'Chat options' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Find in chat' }));
    await userEvent.type(findBox(), 'zebra');
    expect(await screen.findByText('No matches')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next match' }).disabled).toBe(
      true,
    );
    await userEvent.keyboard('{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Close find' }));
    expect(screen.queryByRole('search', { name: 'Find in chat' })).toBeNull();
  });

  it('uses the Alt variant in a browser tab, where the browser keeps Ctrl+F', async () => {
    const t = thread({ title: 'Trip' });
    const hub = createHub({ threads: [t] });
    hub.state.messages.set(t.id, conversation(t.id));
    await renderApp({ hub, path: `/chat/${t.id}`, registry: testRegistry(false, true) });
    await screen.findByText('When is the invoice due?');
    await userEvent.keyboard('{Control>}k{/Control}');
    const option = screen.getByRole('option', { name: /Find in chat/ });
    expect(within(option).getByLabelText('Alt plus F')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await userEvent.keyboard('{Alt>}f{/Alt}');
    expect(await screen.findByRole('searchbox', { name: 'Find in chat' })).toBeTruthy();
  });
});

describe('global search results (FR-025)', () => {
  it('shows who wrote each hit, in the order the Hub ranks them', async () => {
    const t = thread({ title: 'Trip' });
    const hub = createHub({
      threads: [t],
      searchHits: [
        {
          threadId: t.id,
          messageId: 'm2',
          threadTitle: 'Trip',
          snippet: 'Take the <mark>ferry</mark> at 9',
          createdAt: '2026-10-01T12:00:00.000Z',
          role: 'assistant',
        },
        {
          threadId: t.id,
          messageId: 'm1',
          threadTitle: 'Trip',
          snippet: 'Is there a <mark>ferry</mark>?',
          createdAt: '2026-10-02T12:00:00.000Z',
          role: 'user',
        },
      ],
    });
    await renderApp({ hub });
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search chats' }), 'ferry');
    const hits = await screen.findAllByRole('link', { name: /Trip.*ferry/ });
    expect(hits.map((h) => h.querySelector('.search-hit-role')?.textContent)).toEqual([
      'Assistant',
      'You',
    ]);
  });
});
