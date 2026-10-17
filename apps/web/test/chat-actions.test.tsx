// FR-020 message actions, version navigator, inherited branch messages; FR-023 answering model;
// FR-040 citations.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { MessageView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { message } from './fakes.ts';
import { box, clearClipboard, openChat, stubClipboard } from './chat-helpers.tsx';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  clearClipboard();
});

const failure = (status: number, msg: string) =>
  new ApiError(status, { code: status === 409 ? 'conflict' : 'x', message: msg, retryable: true });

function conversation(tid: string): MessageView[] {
  return [
    message(tid, {
      id: 'u1',
      role: 'user',
      turnId: 'tu1',
      parts: [{ type: 'text', text: 'When is the invoice due?' }],
    }),
    message(tid, {
      id: 'a1',
      role: 'assistant',
      turnId: 'tu1',
      parentId: 'u1',
      model: 'pa1/mock-smart',
      parts: [{ type: 'text', text: 'It is due Friday.\nPay by card.' }],
      citations: [
        {
          id: 'c1',
          messageId: 'a1',
          idx: 1,
          url: 'https://example.com/terms',
          sourceId: null,
          title: 'Payment terms',
          snippet: 'Invoices are due in 30 days.',
        },
        {
          id: 'c2',
          messageId: 'a1',
          idx: 2,
          url: 'javascript:alert(1)',
          sourceId: 's1',
          title: null,
          snippet: null,
        },
      ],
    }),
  ];
}

const userMsg = () => screen.getByRole('article', { name: 'You' });
const reply = () => screen.getByRole('article', { name: 'Assistant' });
const tools = (article: HTMLElement) => within(within(article).getByRole('toolbar'));

async function openConversation(hubInit = {}) {
  const r = await openChat({}, { messages: conversation, hub: hubInit });
  await screen.findByText('When is the invoice due?');
  return r;
}

describe('message actions (FR-020)', () => {
  it('has one-tab-stop toolbars per message that the arrow keys move through', async () => {
    await openConversation();
    const bar = within(userMsg()).getByRole('toolbar', { name: 'Actions for your message' });
    const buttons = within(bar).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Copy',
      'Edit',
      'Branch from here',
      'Quote',
      'Delete',
    ]);
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    buttons[0]!.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(buttons[1]);
    await userEvent.keyboard('{End}');
    expect(document.activeElement).toBe(buttons[4]);
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(buttons[0]);
    const replyBar = within(reply()).getByRole('toolbar', { name: 'Actions for this reply' });
    expect(within(replyBar).getByRole('button', { name: 'Regenerate' })).toBeTruthy();
    expect(within(replyBar).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('copies text with a confirmation, and reports a blocked or missing clipboard', async () => {
    await openConversation();
    const calls = stubClipboard();
    await userEvent.click(tools(reply()).getByRole('button', { name: 'Copy' }));
    expect(calls).toEqual(['It is due Friday.\nPay by card.']);
    expect(await screen.findByText('Copied.')).toBeTruthy();
    stubClipboard(() => Promise.reject(new Error('denied')));
    await userEvent.click(tools(userMsg()).getByRole('button', { name: 'Copy' }));
    expect(
      await screen.findByText('Could not copy: the browser blocked clipboard access.'),
    ).toBeTruthy();
    clearClipboard();
    await userEvent.click(tools(userMsg()).getByRole('button', { name: 'Copy' }));
    expect(
      await screen.findByText('Could not copy: the clipboard is not available here.'),
    ).toBeTruthy();
  });

  it('edits inline: Cancel restores, Save sends a new version and runs it', async () => {
    const { hub, t } = await openConversation();
    await userEvent.click(tools(userMsg()).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('textbox', { name: 'Edited message' });
    expect(document.activeElement).toBe(editor);
    await userEvent.type(editor, ' Exactly?');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Edited message' })).toBeNull();
    expect(within(userMsg()).getByText('When is the invoice due?')).toBeTruthy();

    await userEvent.click(tools(userMsg()).getByRole('button', { name: 'Edit' }));
    const again = screen.getByRole('textbox', { name: 'Edited message' });
    await userEvent.clear(again);
    await userEvent.type(again, 'When is the March invoice due?');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(hub.api.editMessage).toHaveBeenCalledWith(t.id, 'u1', {
        text: 'When is the March invoice due?',
      }),
    );
    expect(await screen.findByText('When is the March invoice due?')).toBeTruthy();
    expect(screen.queryByText(/It is due Friday/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    // The new version lists both versions once the Hub returns it.
    expect(await screen.findByText('Version 2 of 2')).toBeTruthy();
  });

  it('keeps the editor open with the reason when an edit fails', async () => {
    const { hub } = await openConversation();
    hub.state.failNext.editMessage = failure(409, 'busy');
    await userEvent.click(tools(userMsg()).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('textbox', { name: 'Edited message' });
    await userEvent.type(editor, '!');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(await screen.findByText(/A reply is still running/)).toBeTruthy();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Edited message' }).value).toBe(
      'When is the invoice due?!',
    );
    hub.state.failNext.editMessage = failure(500, 'Disk full');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save the edit: Disk full')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Edited message' })).toBeNull();
  });

  it('regenerates with the same or another model, and reports a failure', async () => {
    const { hub, t } = await openConversation();
    hub.state.failNext.regenerate = failure(500, 'Provider down');
    await userEvent.click(tools(reply()).getByRole('button', { name: 'Regenerate' }));
    expect(await screen.findByText('Could not regenerate: Provider down')).toBeTruthy();
    expect(screen.getByText(/It is due Friday/)).toBeTruthy();

    await userEvent.click(
      tools(reply()).getByRole('button', { name: 'Regenerate with another model' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Regenerate with Mock fast' }));
    await waitFor(() =>
      expect(hub.api.regenerate).toHaveBeenLastCalledWith(t.id, 'a1', { model: 'pa1/mock-fast' }),
    );
    await waitFor(() => expect(screen.queryByText(/It is due Friday/)).toBeNull());
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    // While the new reply runs, history-changing actions wait.
    const edit = tools(userMsg()).getByRole('button', { name: 'Edit' });
    expect(edit.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(edit);
    expect(screen.queryByRole('textbox', { name: 'Edited message' })).toBeNull();
  });

  it('regenerates with the current model by default', async () => {
    const { hub, t } = await openConversation();
    await userEvent.click(tools(reply()).getByRole('button', { name: 'Regenerate' }));
    await waitFor(() => expect(hub.api.regenerate).toHaveBeenCalledWith(t.id, 'a1', {}));
  });

  it('quotes a message into the composer', async () => {
    await openConversation();
    await userEvent.type(box(), 'About this:');
    await userEvent.click(tools(reply()).getByRole('button', { name: 'Quote' }));
    await waitFor(() => expect(document.activeElement).toBe(box()));
    expect(box().value).toBe('About this:\n\n> It is due Friday.\n> Pay by card.\n\n');
  });

  it('deletes after confirmation, removing the reply with a user message', async () => {
    const { hub, t } = await openConversation();
    await userEvent.click(tools(userMsg()).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this message?' });
    expect(dialog.textContent).toMatch(/the reply to it/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(hub.api.deleteMessage).not.toHaveBeenCalled();

    hub.state.failNext.deleteMessage = failure(500, 'Locked');
    await userEvent.click(tools(userMsg()).getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(await screen.findByText('Could not delete the message: Locked')).toBeTruthy();
    expect(screen.getByText('When is the invoice due?')).toBeTruthy();

    await userEvent.click(tools(userMsg()).getByRole('button', { name: 'Delete' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }),
    );
    await waitFor(() => expect(hub.api.deleteMessage).toHaveBeenLastCalledWith(t.id, 'u1'));
    await waitFor(() => expect(screen.queryByText('When is the invoice due?')).toBeNull());
    expect(screen.queryByText(/It is due Friday/)).toBeNull();
    expect(screen.getByText('Message deleted.')).toBeTruthy();
  });

  it('branches from a message and shows the inherited part read-only with a link back', async () => {
    const { hub, t } = await openConversation();
    hub.state.failNext.branch = failure(500, 'No space');
    await userEvent.click(tools(reply()).getByRole('button', { name: 'Branch from here' }));
    expect(await screen.findByText('Could not branch: No space')).toBeTruthy();

    await userEvent.click(tools(reply()).getByRole('button', { name: 'Branch from here' }));
    await waitFor(() => expect(hub.api.branch).toHaveBeenLastCalledWith(t.id, 'a1'));
    const branch = hub.state.threads.find((x) => x.parentThreadId === t.id)!;
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${branch.id}`));
    expect(screen.getByText('Branch created.')).toBeTruthy();
    const sidebar = screen.getByRole('navigation', { name: 'Sidebar' });
    expect(
      within(sidebar).getByRole('link', { name: /Branch of Billing questions, branch/ }),
    ).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'Branch of Billing questions' }),
    ).toBeTruthy();
    const log = screen.getByRole('log', { name: 'Messages' });
    const from = await within(log).findByRole('link', { name: 'Billing questions' });
    expect(from.closest('.msg-divider')?.textContent).toMatch(/From Billing questions/);
    // Inherited messages can be copied or quoted, not changed here.
    const inheritedReply = within(log).getByRole('article', { name: 'Assistant' });
    expect(
      within(within(inheritedReply).getByRole('toolbar'))
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Copy', 'Quote']);
    await userEvent.click(from);
    expect(window.location.pathname).toBe(`/chat/${t.id}`);
  });

  it('switches between versions with the navigator and reports a failure', async () => {
    const { hub, t } = await openChat(
      {},
      {
        messages: (tid) => [
          message(tid, {
            id: 'u2',
            role: 'user',
            siblingIds: ['u1', 'u2'],
            parts: [{ type: 'text', text: 'Second wording' }],
          }),
        ],
      },
    );
    hub.state.paths.set('u1', [
      message(t.id, {
        id: 'u1',
        role: 'user',
        siblingIds: ['u1', 'u2'],
        parts: [{ type: 'text', text: 'First wording' }],
      }),
    ]);
    const versions = await screen.findByRole('group', { name: 'Versions' });
    expect(within(versions).getByText('Version 2 of 2')).toBeTruthy();
    expect(
      within(versions).getByRole<HTMLButtonElement>('button', { name: 'Next version' }).disabled,
    ).toBe(true);
    hub.state.failNext.selectVersion = failure(500, 'Gone');
    await userEvent.click(within(versions).getByRole('button', { name: 'Previous version' }));
    expect(await screen.findByText('Could not switch versions: Gone')).toBeTruthy();
    await userEvent.click(within(versions).getByRole('button', { name: 'Previous version' }));
    await waitFor(() => expect(hub.api.selectVersion).toHaveBeenLastCalledWith(t.id, 'u1'));
    expect(await screen.findByText('First wording')).toBeTruthy();
    expect(screen.getByText('Version 1 of 2')).toBeTruthy();
  });
});

describe('answering model and sources (FR-023, FR-040)', () => {
  it('shows the model that answered and the cited sources', async () => {
    await openConversation();
    expect(within(reply()).getByText('Mock smart')).toBeTruthy();
    const sources = within(reply()).getByRole('group', { name: 'Sources' });
    const link = within(sources).getByRole('link', { name: 'Payment terms' });
    expect(link.getAttribute('href')).toBe('https://example.com/terms');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(sources).getByText('Invoices are due in 30 days.')).toBeTruthy();
    // An unsafe URL is shown as text, never linked.
    expect(within(sources).getByText('javascript:alert(1)').tagName).toBe('SPAN');
    expect(within(userMsg()).queryByText('Mock smart')).toBeNull();
  });
});
