// Regressions the J9 journey (sync across devices, outages) found in the web UI:
// 1. The chat list follows chats made, renamed and deleted on other devices without a reload
//    (`thread.created/.updated/.deleted`, a status for a chat it has not seen, a reconnect).
// 2. An open chat catches up on every reconnect of its stream: messages sent meanwhile (from
//    another device or the offline queue) appear once, the stale queue strip goes, and an
//    approval answered elsewhere closes.
// 3. A message sent before the model list arrives is held visibly and sent once a model is known;
//    loading never reads as "no provider"; with no model at all, Enter says why and keeps the text.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueuedInputView } from '@nova/shared';
import { MODELS, FakeEventSource, createHub, message, thread } from './fakes.ts';
import { box } from './chat-helpers.tsx';
import { approvalView, chatLog, openWith, toolPart, waitingReply } from './chat-m3-helpers.tsx';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const sidebar = () => screen.getByRole('navigation', { name: 'Sidebar' });
const events = () => FakeEventSource.for('/api/v1/events/stream');

describe('the chat list follows other devices (J9 bug 1)', () => {
  it('shows a chat made elsewhere, drops one deleted elsewhere, and catches up on reconnect', async () => {
    const hub = createHub();
    await renderApp({ hub });
    expect(await within(sidebar()).findByText('No chats yet.')).toBeTruthy();

    // Made on device A: this device hears `thread.created` and lists again.
    const trip = thread({ title: 'Trip planning' });
    hub.state.threads = [trip];
    events().emit('thread.created', { threadId: trip.id });
    expect(await within(sidebar()).findByRole('link', { name: /Trip planning/ })).toBeTruthy();

    // Renamed elsewhere.
    hub.state.threads = [{ ...trip, title: 'Lisbon trip' }];
    events().emit('thread.updated', { threadId: trip.id });
    expect(await within(sidebar()).findByRole('link', { name: /Lisbon trip/ })).toBeTruthy();

    // Deleted elsewhere: gone at once.
    hub.state.threads = [];
    events().emit('thread.deleted', { threadId: trip.id });
    await waitFor(() =>
      expect(within(sidebar()).queryByRole('link', { name: /Lisbon trip/ })).toBeNull(),
    );

    // A status for a chat this list has never seen: it lists again.
    const notes = thread({ title: 'Notes from the road' });
    hub.state.threads = [notes];
    events().emit('thread.status.changed', {
      ref: { kind: 'thread', id: notes.id },
      status: 'running',
    });
    expect(
      await within(sidebar()).findByRole('link', { name: /Notes from the road/ }),
    ).toBeTruthy();

    // Made while the stream was down: listed again when it reconnects.
    const budget = thread({ title: 'Budget' });
    hub.state.threads = [notes, budget];
    const stream = events();
    act(() => stream.fail(false));
    act(() => stream.open());
    expect(await within(sidebar()).findByRole('link', { name: /Budget/ })).toBeTruthy();
  });
});

describe('an open chat after an outage (J9 bug 2)', () => {
  it('catches up on every reconnect: new messages once, no stale queue, answered approvals close', async () => {
    const queued = (tid: string, n: number, text: string): QueuedInputView => ({
      id: `q${n}`,
      threadId: tid,
      text,
      attachmentCount: 0,
      position: n,
      createdAt: '2026-10-01T12:00:05.000Z',
    });
    const texts = ['Book the train', 'Find a hotel', 'Pack light'];
    const { hub, t, es } = await openWith({
      thread: { state: 'waiting_approval' },
      messages: (tid) => [
        message(tid, { role: 'user', parts: [{ type: 'text', text: 'Write the plan' }] }),
        waitingReply(tid),
      ],
      m3: (tid) => ({ approvals: [approvalView(tid)] }),
      before: (h, tid) =>
        h.state.queues.set(
          tid,
          texts.map((x, i) => queued(tid, i + 1, x)),
        ),
    });
    act(() => es.open());
    expect(await screen.findByRole('group', { name: 'Approval needed' })).toBeTruthy();
    const strip = await screen.findByRole('region', { name: 'Queued messages' });
    expect(within(strip).getByText('Queued: 3')).toBeTruthy();

    // An outage before any event arrived: the stream reconnects with no cursor. Meanwhile the
    // approval was answered on another device and the three messages reached the Hub.
    const stream = es;
    act(() => stream.fail(false));
    hub.state.m3.approvals = hub.state.m3.approvals.map((a) => ({
      ...a,
      status: 'decided' as const,
      decision: 'allow_once' as const,
      decidedBy: 'user',
    }));
    hub.state.queues.set(t.id, []);
    const before = hub.state.messages.get(t.id)!;
    hub.state.messages.set(t.id, [
      ...before.map((m) =>
        m.id === 'm-reply'
          ? {
              ...m,
              status: 'complete' as const,
              parts: [
                { type: 'text' as const, text: 'Done.' },
                toolPart({
                  callId: 'call1',
                  tool: 'fs.write',
                  title: 'Write file',
                  status: 'ok',
                  approvalId: 'ap1',
                }),
              ],
            }
          : m,
      ),
      ...texts.map((x) =>
        message(t.id, { role: 'user', provenance: 'sync', parts: [{ type: 'text', text: x }] }),
      ),
    ]);
    hub.state.threads = hub.state.threads.map((x) =>
      x.id === t.id ? { ...x, state: 'idle' as const } : x,
    );
    act(() => stream.open());

    for (const x of texts) expect(await within(chatLog()).findByText(x)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Queued messages' })).toBeNull(),
    );
    // The card closes on the decision made elsewhere; the call shows how it was answered.
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Approval needed' })).toBeNull(),
    );
    expect(await within(chatLog()).findByText(/Allowed once/)).toBeTruthy();
    expect(hub.api.getApproval).toHaveBeenCalledWith('ap1');

    // Another reconnect changes nothing: every message is shown once.
    act(() => stream.fail(false));
    act(() => stream.open());
    await waitFor(() => expect(hub.api.getThread.mock.calls.length).toBeGreaterThanOrEqual(3));
    for (const x of texts) expect(within(chatLog()).getAllByText(x)).toHaveLength(1);
    expect(within(chatLog()).getAllByText('Written offline')).toHaveLength(3);
  });
});

describe('sending before the model list arrives (J9 bug 3)', () => {
  it('holds the first message visibly and sends it once a model is known', async () => {
    const hub = createHub();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    hub.api.listModels.mockImplementation(async () => {
      await gate;
      return { items: MODELS };
    });
    await renderApp({ hub });
    // Loading is not "no provider".
    expect(screen.queryByText(/Connect a model provider/)).toBeNull();
    expect(box().placeholder).toBe('Loading models…');

    await userEvent.type(box(), 'Plan a weekend{Enter}');
    expect(await screen.findByText(/Waiting for the model list/)).toBeTruthy();
    expect(box().value).toBe('Plan a weekend');
    expect(hub.api.createThread).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ text: 'Plan a weekend' }),
      ),
    );
    expect(hub.api.createThread).toHaveBeenCalledTimes(1);
    expect(hub.api.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: MODELS[0]!.ref }),
    );
    expect(screen.queryByText(/Waiting for the model list/)).toBeNull();
  });

  it('lets a held message be called off, and says why when no model exists', async () => {
    const hub = createHub();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    hub.api.listModels.mockImplementation(async () => {
      await gate;
      return { items: [] };
    });
    await renderApp({ hub });
    await userEvent.type(box(), 'Hello{Enter}');
    expect(await screen.findByText(/Waiting for the model list/)).toBeTruthy();
    await act(async () => {
      release();
      await gate;
    });
    // The list came back empty: no send, the reason, and the text still in the box.
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /No model is available, so this cannot be sent yet.*your message stays here/,
    );
    expect(box().value).toBe('Hello');
    expect(hub.api.createThread).not.toHaveBeenCalled();
    expect(
      await screen.findByText('Connect a model provider in Settings → Accounts to start chatting.'),
    ).toBeTruthy();

    resetDom();
    const slow = createHub();
    slow.api.listModels.mockImplementation(() => new Promise(() => undefined));
    await renderApp({ hub: slow });
    await userEvent.type(box(), 'Later{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: "Don't send" }));
    expect(screen.queryByText(/Waiting for the model list/)).toBeNull();
    expect(box().value).toBe('Later');
  });
});
