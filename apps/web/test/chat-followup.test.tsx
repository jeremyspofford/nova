// FR-019: messages sent while a reply streams steer it or queue behind it.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { DONE_ONBOARDING, message, streamReply } from './fakes.ts';
import { box, openChat, send } from './chat-helpers.tsx';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const strip = () => screen.queryByRole('region', { name: 'Queued messages' });

async function streaming(over = {}, hubInit = {}) {
  const r = await openChat(over, { hub: hubInit });
  await send('First question');
  const [, assistant] = r.hub.state.messages.get(r.t.id)!;
  streamReply(r.es, r.t.id, assistant!.id, ['Working on it'], null);
  return { ...r, assistant: assistant! };
}

describe('follow-ups while a reply streams (FR-019)', () => {
  it('keeps the composer usable, queues by default and clears the strip as items start', async () => {
    const { hub, t, es, assistant } = await streaming();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    const queueButton = screen.getByRole('button', { name: 'Queue' });
    expect(queueButton.getAttribute('title')).toMatch(/Alt\+Enter steers/);
    await send('Second', 'Queue');
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenLastCalledWith(t.id, {
        text: 'Second',
        attachments: undefined,
        inputMode: 'queue',
      }),
    );
    const region = await screen.findByRole('region', { name: 'Queued messages' });
    expect(within(region).getByText('Queued: 1')).toBeTruthy();
    expect(within(region).getByText('Second')).toBeTruthy();
    // Not in the log: it is not part of any turn yet.
    expect(within(screen.getByRole('log', { name: 'Messages' })).queryByText('Second')).toBeNull();
    await waitFor(() => expect(hub.api.listQueue).toHaveBeenCalledWith(t.id));

    box().focus();
    await userEvent.keyboard('Third{Enter}');
    expect(await within(region).findByText('Queued: 2')).toBeTruthy();
    expect(box().value).toBe('');

    // The running turn ends; the Hub starts the oldest queued message as its own turn.
    hub.persist(t.id, assistant.id, {
      status: 'complete',
      parts: [{ type: 'text', text: 'Working on it' }],
    });
    es.emit(
      'chat.message.completed',
      { threadId: t.id, messageId: assistant.id, status: 'complete', usage: null },
      t.id,
    );
    es.emit('turn.completed', { threadId: t.id }, t.id);
    const started = hub.startQueued(t.id);
    es.emit(
      'chat.followup.started',
      { threadId: t.id, queuedId: started.queuedId, turnId: started.turnId },
      t.id,
    );
    expect(await within(region).findByText('Queued: 1')).toBeTruthy();
    expect(within(region).queryByText('Second')).toBeNull();
    expect(
      await within(screen.getByRole('log', { name: 'Messages' })).findByText('Second'),
    ).toBeTruthy();
    expect(screen.getByTestId('announcer').textContent).toMatch(/queued message started/i);
  });

  it('steers with Alt+Enter: the message joins the running turn marked Steering', async () => {
    const { hub, t, es } = await streaming();
    box().focus();
    await userEvent.keyboard('Use metric units{Alt>}{Enter}{/Alt}');
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenLastCalledWith(t.id, {
        text: 'Use metric units',
        attachments: undefined,
        inputMode: 'steer',
      }),
    );
    const steered = await screen.findByRole('article', { name: 'You, steering' });
    expect(within(steered).getByText('Steering')).toBeTruthy();
    expect(within(steered).getByText('Use metric units')).toBeTruthy();
    expect(strip()).toBeNull();
    // The next model step streams into a new assistant message of the same turn.
    es.emit(
      'chat.message.created',
      { threadId: t.id, messageId: 'next-step', role: 'assistant', turnId: 'turn' },
      t.id,
    );
    es.emit(
      'chat.delta',
      { threadId: t.id, messageId: 'next-step', type: 'text_delta', text: 'In metres:' },
      t.id,
    );
    expect(await screen.findByText('In metres:')).toBeTruthy();
  });

  it('follows the steer setting: Enter steers and Alt+Enter queues', async () => {
    const { hub, t } = await streaming(
      {},
      { settings: { 'onboarding.state': DONE_ONBOARDING, 'general.followUp': 'steer' } },
    );
    expect(screen.getByRole('button', { name: 'Steer' })).toBeTruthy();
    await send('Shorter please', 'Steer');
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenLastCalledWith(
        t.id,
        expect.objectContaining({ inputMode: 'steer' }),
      ),
    );
    box().focus();
    await userEvent.keyboard('Then a summary{Alt>}{Enter}{/Alt}');
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenLastCalledWith(
        t.id,
        expect.objectContaining({ text: 'Then a summary', inputMode: 'queue' }),
      ),
    );
    expect(await screen.findByRole('region', { name: 'Queued messages' })).toBeTruthy();
  });

  it('cancels queued messages, and handles one that already started or a failure', async () => {
    const { hub, t } = await streaming();
    await send('One', 'Queue');
    await send('Two', 'Queue');
    await send('Three', 'Queue');
    const region = await screen.findByRole('region', { name: 'Queued messages' });
    await within(region).findByText('Queued: 3');
    await waitFor(() =>
      expect(within(region).getAllByRole('button', { name: /Cancel queued message/ })).toHaveLength(
        3,
      ),
    );
    const [one, two] = hub.state.queues.get(t.id)!;

    await userEvent.click(
      within(region).getByRole('button', { name: 'Cancel queued message: One' }),
    );
    await waitFor(() => expect(hub.api.cancelQueued).toHaveBeenCalledWith(t.id, one!.id));
    expect(await within(region).findByText('Queued: 2')).toBeTruthy();

    hub.state.failNext.cancelQueued = new ApiError(500, {
      code: 'x',
      message: 'Disk full',
      retryable: true,
    });
    await userEvent.click(
      within(region).getByRole('button', { name: 'Cancel queued message: Two' }),
    );
    expect(await screen.findByText('Could not cancel the queued message: Disk full')).toBeTruthy();
    expect(within(region).getByText('Two')).toBeTruthy();

    hub.state.failNext.cancelQueued = new ApiError(404, {
      code: 'not_found',
      message: 'Not found',
      retryable: false,
    });
    hub.state.queues.set(t.id, [two!]);
    await userEvent.click(
      within(region).getByRole('button', { name: 'Cancel queued message: Three' }),
    );
    expect(await screen.findByText('That message already started.')).toBeTruthy();
    await waitFor(() => expect(within(region).queryByText('Three')).toBeNull());
  });

  it('shows the queue a reload finds and puts text back when queuing fails', async () => {
    const { hub, t } = await openChat(
      { state: 'streaming' },
      {
        messages: (tid) => [
          message(tid, { role: 'user', turnId: 'tu1', parts: [{ type: 'text', text: 'Go' }] }),
          message(tid, { role: 'assistant', turnId: 'tu1', status: 'streaming', parts: [] }),
        ],
      },
    );
    hub.state.queues.set(t.id, [
      {
        id: 'q-old',
        threadId: t.id,
        text: '',
        attachmentCount: 2,
        position: 1,
        createdAt: '2026-10-01T12:00:00.000Z',
      },
    ]);
    hub.api.getThread.mockClear();
    resetDom();
    const { renderApp } = await import('./render.tsx');
    await renderApp({ hub, path: `/chat/${t.id}` });
    const region = await screen.findByRole('region', { name: 'Queued messages' });
    expect(within(region).getByText('2 attachments')).toBeTruthy();

    hub.state.failNext.sendMessage = new ApiError(500, {
      code: 'x',
      message: 'Hub busy.',
      retryable: true,
    });
    await send('Later', 'Queue');
    expect(await screen.findByText(/Message not sent: Hub busy\./)).toBeTruthy();
    expect(box().value).toBe('Later');
    expect(within(region).getByText('Queued: 1')).toBeTruthy();
  });

  it("labels a hook's continuation as the hook's, not the user's (FR-197)", async () => {
    await openChat(
      {},
      {
        messages: (tid) => [
          message(tid, { parts: [{ type: 'text', text: 'Start' }], provenance: 'typed' }),
          message(tid, { role: 'assistant', parts: [{ type: 'text', text: 'Done' }] }),
          message(tid, { parts: [{ type: 'text', text: 'Run the tests' }], provenance: 'hook' }),
        ],
      },
    );
    const fromHook = await screen.findByRole('article', { name: 'Hook' });
    expect(within(fromHook).getByText('Run the tests')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'You' })).toBeTruthy();
  });
});
