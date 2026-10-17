// secret-scan: fake-file (fixture tokens, passwords and key headers only)
// The owner's share decision in a thread (docs/13 §4, FR-088): a `user_input` request with no
// tool call behind it, which the chat's question card does not show, answered from the thread.
// Also the fake Hub's channels rules, checked against the Hub's (status codes and refusals).
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { isShareAsk, isStandaloneQuestion, ThreadQuestions } from '../src/channels/ShareAsks.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  bindingView,
  createChannelsHub,
  renderWithChannels,
  shareAsk,
  triggerView,
  subscriptionView,
} from './fakes-m6-channels.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

describe('a thread’s pending share decision', () => {
  it('shows only this thread’s standalone questions and answers one', async () => {
    const { hub } = await renderWithChannels(<ThreadQuestions threadId="t-ops" />, {
      requests: [
        shareAsk('t-ops', { id: 'rq1' }),
        shareAsk('t-other', { id: 'rq2' }),
        // A question behind an ask_user call is the chat card's, not this one's.
        shareAsk('t-ops', { id: 'rq3', correlation: { threadId: 't-ops', callId: 'c1' } }),
      ],
    });
    const card = within(await screen.findByRole('article', { name: 'Share a private detail?' }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    // Inside the thread there is no link back to it, and no answer button has focus.
    expect(card.queryByRole('button', { name: /Open the channel/ })).toBeNull();
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    await userEvent.click(card.getByRole('button', { name: 'Share' }));
    expect(await screen.findByText('Answered: Share.')).toBeTruthy();
    expect(hub.state.m5work.requests.find((r) => r.id === 'rq1')?.status).toBe('resolved');
    await waitFor(() => expect(screen.queryByRole('article')).toBeNull());
  });

  it('says when the decision expired, and keeps other errors on the card', async () => {
    const { hub } = await renderWithChannels(<ThreadQuestions threadId="t-ops" />, {
      requests: [shareAsk('t-ops', { id: 'rq1' })],
    });
    const card = within(await screen.findByRole('article', { name: 'Share a private detail?' }));
    hub.state.failNext.respondRequest = new ApiError(500, {
      code: 'server_error',
      message: 'Hub is restarting',
      retryable: true,
    });
    await userEvent.click(card.getByRole('button', { name: 'Do not share' }));
    expect((await card.findByRole('alert')).textContent).toBe('Hub is restarting');
    hub.state.m5work.requests = hub.state.m5work.requests.map((r) => ({
      ...r,
      status: 'expired' as const,
    }));
    await userEvent.click(card.getByRole('button', { name: 'Do not share' }));
    expect(await screen.findByText('This expired before your answer arrived.')).toBeTruthy();
  });

  it('appears when a request is created', async () => {
    const { hub } = await renderWithChannels(<ThreadQuestions threadId="t-ops" />);
    expect(screen.queryByRole('article')).toBeNull();
    hub.state.m5work.requests = [
      shareAsk('t-ops', {
        id: 'rq9',
        payload: { question: 'Which label?', choices: ['bug', 'feature'] },
      }),
    ];
    await waitFor(() => expect(FakeEventSource.all.some((s) => !s.closed)).toBe(true));
    for (const s of FakeEventSource.all.filter((x) => !x.closed))
      s.emit('request.created', { requestId: 'rq9', kind: 'user_input' });
    const card = within(await screen.findByRole('article', { name: 'Nova has a question' }));
    expect(card.getByText('Which label?')).toBeTruthy();
    expect(card.getByRole('button', { name: 'feature' })).toBeTruthy();
  });

  it('tells share asks and standalone questions apart', () => {
    const ask = shareAsk('t1');
    expect(isShareAsk(ask)).toBe(true);
    expect(isStandaloneQuestion(ask)).toBe(true);
    expect(isStandaloneQuestion({ ...ask, status: 'resolved' })).toBe(false);
    expect(isStandaloneQuestion({ ...ask, payload: { question: 'Free text?' } })).toBe(false);
    expect(isShareAsk({ ...ask, payload: { choices: ['Yes', 'No'] } })).toBe(false);
  });
});

/** The status code of the call's rejection. */
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    return (err as ApiError).status;
  }
}

describe('the fake Hub follows the channels area’s rules', () => {
  it('refuses what the Hub refuses for bindings', async () => {
    const { api, state } = createChannelsHub({
      bindings: [bindingView({ id: 'b1', kind: 'slack', externalRef: 'C1' })],
    });
    expect(await status(api.createChannel({ kind: 'email', externalRef: 'me@example.com' }))).toBe(
      400,
    );
    expect(await status(api.createChannel({ kind: 'slack', externalRef: 'C2' }))).toBe(400);
    expect(
      await status(
        api.createChannel({ kind: 'slack', externalRef: 'C1', shareCredentialsWith: 'b1' }),
      ),
    ).toBe(409);
    expect(
      await status(
        api.createChannel({
          kind: 'slack',
          externalRef: 'C3',
          audience: 'shared',
          sharePrimaryThread: true,
          shareCredentialsWith: 'b1',
        }),
      ),
    ).toBe(400);
    expect(
      await status(
        api.createChannel({
          kind: 'webhook',
          externalRef: 'w',
          credentials: { token: 'short', secret: 'short' },
        }),
      ),
    ).toBe(400);
    const inapp = await api.createChannel({ kind: 'inapp' });
    expect(inapp.audience).toBe('private');
    expect(await status(api.updateChannel(inapp.id, { audience: 'shared' }))).toBe(400);
    expect(await status(api.updateChannel('b1', { credentials: { password: 'whatever1' } }))).toBe(
      400,
    );
    expect(await status(api.updateChannel('b1', { config: { appId: 'x' } }))).toBe(400);
    await api.disconnectChannel('b1');
    expect(await status(api.testChannel('b1'))).toBe(409);
    expect(await status(api.getChannel('nope'))).toBe(404);
    // A binding sharing another's app keeps its secrets until the last one goes.
    const twin = await api.createChannel({
      kind: 'slack',
      externalRef: 'C4',
      shareCredentialsWith: 'b1',
    });
    expect(twin.sharesCredentialsWith).toBe('b1');
    await api.deleteChannel('b1');
    expect(Object.keys(state.secrets).filter((k) => k.startsWith('b1/'))).toHaveLength(2);
    await api.deleteChannel(twin.id);
    expect(Object.keys(state.secrets).filter((k) => k.startsWith('b1/'))).toHaveLength(0);
  });

  it('refuses what the Hub refuses for triggers, subscriptions and routes', async () => {
    const { api, state } = createChannelsHub({
      bindings: [
        bindingView({ id: 'b1', kind: 'teams' }),
        bindingView({ id: 'b2', kind: 'inapp' }),
      ],
      sources: [
        { serverId: 'srv1', name: 'GitHub', events: [{ name: 'push', description: null }] },
      ],
      triggers: [triggerView({ id: 'tr1', kind: 'mcp_event' })],
      subscriptions: [subscriptionView({ id: 'sub1', triggerId: 'tr1' })],
    });
    const base = { instructions: 'Do it', action: 'run' as const };
    expect(
      await status(api.createTrigger({ ...base, kind: 'connector_event', bindingId: 'b1' })),
    ).toBe(400);
    expect(
      await status(
        api.createTrigger({ ...base, kind: 'mcp_event', serverId: 'srv1', event: 'nope' }),
      ),
    ).toBe(400);
    expect(
      await status(
        api.createTrigger({ ...base, kind: 'mcp_event', serverId: 'srv9', event: 'push' }),
      ),
    ).toBe(400);
    expect(
      await status(
        api.createTrigger({
          ...base,
          kind: 'webhook',
          projectId: 'p-missing',
          credentials: { token: 'x'.repeat(24), secret: 'y'.repeat(32) },
        }),
      ),
    ).toBe(400);
    expect(
      await status(
        api.createTrigger({
          ...base,
          action: 'wake',
          kind: 'webhook',
          credentials: { token: 'x'.repeat(24), secret: 'y'.repeat(32) },
        }),
      ),
    ).toBe(400);
    expect(await status(api.updateTrigger('tr1', { dedupeKey: 'id' }))).toBe(400);
    expect(await status(api.updateTrigger('tr1', { contains: 'x' }))).toBe(400);
    const removed = await api.deleteMcpSubscription('sub1');
    expect(removed.status).toBe('removed');
    expect(state.triggers[0]!.enabled).toBe(false);
    expect(
      await status(api.setNotificationRule('error', { inapp: true, os: true, channels: ['b2'] })),
    ).toBe(400);
    expect(
      (await api.setNotificationRule('error', { inapp: true, os: false, channels: ['b1'] }))
        .channels,
    ).toEqual(['b1']);
    expect(
      await status(
        api.setQuietHours({ enabled: true, start: '22:00', end: '07:00', timezone: 'Mars/Base' }),
      ),
    ).toBe(400);
    expect(
      await status(
        api.setQuietHours({ enabled: true, start: '22:00', end: '22:00', timezone: 'UTC' }),
      ),
    ).toBe(400);
    expect((await api.getQuietHours()).enabled).toBe(false);
  });
});
