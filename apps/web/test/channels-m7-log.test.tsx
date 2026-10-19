// A channel's message log, test notifications and a schedule's webhook secret (FR-110, FR-060,
// FR-055): the log lists messages in and out newest first with what happened and why in plain
// words (no text: it is in the thread), filters by direction and status, pages back with
// `before`, follows the channel's message events, and shows errors with Retry; each notification
// kind sends a test and says where it went (quiet hours included; Telegram and email channels can
// receive notifications); a schedule's signing secret is made again only after asking and shown
// once, with the Hub's refusal for a schedule without a webhook.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { ChannelsPage } from '../src/channels/ChannelsPage.tsx';
import { NotificationRoutingSection } from '../src/channels/NotificationRoutingSection.tsx';
import { ScheduleWebhookSecret } from '../src/channels/WebhookSecret.tsx';
import { FakeEventSource } from './fakes.ts';
import { bindingView, quietView, ruleView } from './fakes-m6-channels.ts';
import { bindingM7, messageView, renderM7 } from './fakes-m7-misc.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 12, min)).toISOString();
const SLACK = bindingView({ id: 'b1', kind: 'slack', label: 'Slack #ops', externalRef: 'C0OPS' });

function emitAll(name: string, payload: Record<string, unknown>) {
  for (const s of FakeEventSource.all.filter((x) => !x.closed))
    act(() => {
      s.emit(name, payload);
    });
}

async function openLog(misc: Parameters<typeof renderM7>[1] = {}) {
  const r = await renderM7(<ChannelsPage />, { channels: { bindings: [SLACK] }, ...misc });
  const row = await screen.findByRole('listitem', { name: 'Slack #ops' });
  await userEvent.click(within(row).getByRole('button', { name: 'Messages of Slack #ops' }));
  return { ...r, row: within(row) };
}

describe('the message log (FR-110)', () => {
  it('lists messages newest first with what happened and why, and opens the thread', async () => {
    const { row } = await openLog({
      misc: {
        messages: [
          messageView({ id: 'm1', createdAt: at(1), sender: 'U0SAM', status: 'started' }),
          messageView({
            id: 'm2',
            createdAt: at(2),
            sender: '<img src=x onerror=alert(1)>',
            status: 'ignored',
            reason: 'unknown_sender',
            threadId: null,
          }),
          messageView({
            id: 'm3',
            createdAt: at(3),
            direction: 'out',
            status: 'withheld',
            reason: 'denied',
            sender: null,
          }),
          messageView({ id: 'other', bindingId: 'b9', createdAt: at(4) }),
        ],
      },
    });
    const list = await row.findByRole('list', { name: 'Messages of Slack #ops, newest first' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('Held back');
    expect(items[0]!.textContent).toContain('To C0OPS');
    expect(items[0]!.textContent).toContain('You declined to share a private detail here.');
    // An external name is text, never markup.
    expect(items[1]!.textContent).toContain('From <img src=x onerror=alert(1)>');
    expect(items[1]!.querySelector('img')).toBeNull();
    expect(items[1]!.textContent).toContain('From someone not listed under People.');
    expect(within(items[1]!).queryByRole('button', { name: /Open the thread/ })).toBeNull();
    expect(items[2]!.textContent).toContain('Started a turn');
    await userEvent.click(within(items[2]!).getByRole('button', { name: /Open the thread/ }));
    expect(window.location.pathname).toBe('/chat/t-ops');
  });

  it('filters by direction and status, and says when nothing matches', async () => {
    const { row, api } = await openLog({
      misc: {
        messages: [
          messageView({ id: 'm1', createdAt: at(1) }),
          messageView({ id: 'm2', createdAt: at(2), direction: 'out', status: 'sent' }),
        ],
      },
    });
    await row.findByRole('list', { name: /Messages of Slack #ops/ });
    await userEvent.selectOptions(row.getByLabelText('Direction'), 'out');
    await waitFor(() =>
      expect(api.listChannelMessages).toHaveBeenLastCalledWith('b1', {
        direction: 'out',
        limit: 50,
      }),
    );
    await waitFor(() =>
      expect(
        within(row.getByRole('list', { name: /Messages of/ })).getAllByRole('listitem'),
      ).toHaveLength(1),
    );
    await userEvent.selectOptions(row.getByLabelText('What happened'), 'failed');
    expect(await row.findByText('No message matches these filters.')).toBeTruthy();
  });

  it('pages back with the Hub’s cursor, never skipping messages that share a time', async () => {
    // Ten messages share the minute where the first page ends.
    const many = Array.from({ length: 55 }, (_, i) =>
      messageView({ id: `p${String(i).padStart(2, '0')}`, createdAt: at(i < 10 ? 0 : i) }),
    );
    const { row, api, state } = await openLog({ misc: { messages: many } });
    const list = await row.findByRole('list', { name: /Messages of Slack #ops/ });
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    const first = (await api.listChannelMessages.mock.results[0]!.value) as {
      nextCursor: string | null;
    };
    expect(first.nextCursor).toBeTruthy();
    await userEvent.click(row.getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(55));
    expect(api.listChannelMessages).toHaveBeenLastCalledWith('b1', {
      cursor: first.nextCursor,
      limit: 50,
    });
    // Never both cursor and before.
    for (const call of api.listChannelMessages.mock.calls as unknown[][])
      expect(call[1]).not.toHaveProperty('before');
    expect(row.queryByRole('button', { name: 'Show older' })).toBeNull();
    // Empty log.
    state.messages = [];
    await userEvent.click(row.getByRole('button', { name: 'Refresh the messages of Slack #ops' }));
    expect(
      await row.findByText(/Each message in or out of this channel is listed here/),
    ).toBeTruthy();
  });

  it('follows the channel’s message events, and shows an error with Retry', async () => {
    const { row, state, failNext } = await openLog();
    expect(
      await row.findByText(/Each message in or out of this channel is listed here/),
    ).toBeTruthy();
    state.messages = [messageView({ id: 'n1', createdAt: at(9) })];
    emitAll('channel.message.received', { bindingId: 'other', threadId: 't' });
    emitAll('channel.message.received', { bindingId: 'b1', threadId: 't-ops' });
    expect(await row.findByRole('list', { name: /Messages of Slack #ops/ })).toBeTruthy();
    failNext.listChannelMessages = new ApiError(503, {
      code: 'unavailable',
      message: 'The Hub is busy',
      retryable: true,
    });
    await userEvent.click(row.getByRole('button', { name: 'Refresh the messages of Slack #ops' }));
    expect((await row.findByRole('alert')).textContent).toContain('The Hub is busy');
    await userEvent.click(row.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(row.queryByRole('alert')).toBeNull());
  });

  it('shows a refused cursor with Retry', async () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      messageView({ id: `q${String(i).padStart(2, '0')}`, createdAt: at(i) }),
    );
    const { row, failNext } = await openLog({ misc: { messages: many } });
    const list = await row.findByRole('list', { name: /Messages of Slack #ops/ });
    failNext.listChannelMessages = new ApiError(400, {
      code: 'validation',
      message: 'that cursor is not one the Hub made',
      retryable: false,
    });
    await userEvent.click(row.getByRole('button', { name: 'Show older' }));
    const alert = await row.findByRole('alert');
    expect(alert.textContent).toContain('that cursor is not one the Hub made');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(51));
    expect(row.queryByRole('alert')).toBeNull();
  });

  it('is not offered for the in-app channel', async () => {
    await renderM7(<ChannelsPage />, {
      channels: { bindings: [bindingView({ id: 'ia', kind: 'inapp', label: 'In-app' })] },
    });
    const row = await screen.findByRole('listitem', { name: 'In-app' });
    expect(within(row).queryByRole('button', { name: /Messages of/ })).toBeNull();
  });
});

describe('test notifications (FR-060)', () => {
  const TG = bindingM7({ id: 'tg1', label: 'Telegram family' });

  it('sends a test and says where it went, Telegram channels included', async () => {
    const { state, api } = await renderM7(<NotificationRoutingSection />, {
      channels: { bindings: [SLACK, TG], rules: [ruleView('approval', { channels: ['tg1'] })] },
    });
    const approvals = await screen.findByRole('group', { name: 'Approvals' });
    // Telegram channels can receive notifications now.
    expect(
      within(approvals).getByRole('checkbox', { name: 'Telegram family (Telegram)' }),
    ).toBeTruthy();
    await userEvent.click(
      within(approvals).getByRole('button', { name: 'Send a test approvals notification' }),
    );
    const result = await within(approvals).findByRole('status');
    expect(result.textContent).toBe(
      'Test sent. Unread in Nova: yes. On your devices: yes. To Telegram family (Telegram): sent.',
    );
    expect(state.notified).toEqual(['approval']);
    expect(api.testNotification).toHaveBeenCalledWith('approval');
  });

  it('says quiet hours held the device copy and when the channel copies go', async () => {
    await renderM7(<NotificationRoutingSection />, {
      channels: {
        bindings: [SLACK],
        rules: [ruleView('completion', { channels: ['b1'] })],
        quietHours: quietView({ enabled: true, active: true, until: '2026-10-02T07:00:00.000Z' }),
      },
    });
    const done = await screen.findByRole('group', { name: 'Finished work' });
    await userEvent.click(
      within(done).getByRole('button', { name: 'Send a test finished work notification' }),
    );
    const text = (await within(done).findByRole('status')).textContent ?? '';
    expect(text).toContain('On your devices: no, it is quiet hours.');
    expect(text).toMatch(/To Slack #ops \(Slack\): waiting until quiet hours end at/);
  });

  it('shows the Hub’s refusal when notifications are not available', async () => {
    await renderM7(<NotificationRoutingSection />, { misc: { notifier: false } });
    const errors = await screen.findByRole('group', { name: 'Errors' });
    await userEvent.click(
      within(errors).getByRole('button', { name: 'Send a test errors notification' }),
    );
    expect((await within(errors).findByRole('alert')).textContent).toBe(
      'notifications are not available',
    );
  });

  it('is off for a kind turned off in “What to notify you about”', async () => {
    await renderM7(<NotificationRoutingSection />, {
      settings: {
        'notifications.categories': {
          approval: true,
          completion: true,
          error: true,
          attention: true,
          system: false,
        },
      },
    });
    const system = await screen.findByRole('group', { name: 'System' });
    expect(
      within(system).getByRole<HTMLButtonElement>('button', {
        name: 'Send a test system notification',
      }).disabled,
    ).toBe(true);
  });
});

describe('a schedule’s webhook signing secret (FR-055)', () => {
  it('makes a new secret only after asking, and shows it once', async () => {
    const { state, api } = await renderM7(<ScheduleWebhookSecret scheduleId="sch1" />, {
      misc: { schedules: { sch1: { webhook: true } } },
    });
    const group = screen.getByRole('group', { name: 'Signing secret' });
    expect(group.textContent).toContain('x-nova-signature: sha256=<hex>');
    await userEvent.click(within(group).getByRole('button', { name: 'Make a new secret' }));
    const ask = within(group).getByRole('group', { name: /Make a new secret\?/ });
    expect(document.activeElement).toBe(within(ask).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(api.rotateScheduleWebhookSecret).not.toHaveBeenCalled();
    await userEvent.click(within(group).getByRole('button', { name: 'Make a new secret' }));
    await userEvent.click(
      within(within(group).getByRole('group', { name: /Make a new secret\?/ })).getByRole(
        'button',
        { name: 'Make a new secret' },
      ),
    );
    const once = await within(group).findByRole('region', { name: 'Shown once' });
    expect(once.textContent).toContain(state.webhookSecrets.sch1);
    expect(within(group).getByRole('button', { name: 'Make another secret' })).toBeTruthy();
  });

  it('explains a schedule without a webhook, and other failures', async () => {
    const { failNext } = await renderM7(<ScheduleWebhookSecret scheduleId="sch2" />, {
      misc: { schedules: { sch2: { webhook: false } } },
    });
    const group = screen.getByRole('group', { name: 'Signing secret' });
    const confirm = async () => {
      await userEvent.click(within(group).getByRole('button', { name: 'Make a new secret' }));
      await userEvent.click(
        within(within(group).getByRole('group', { name: /Make a new secret\?/ })).getByRole(
          'button',
          { name: 'Make a new secret' },
        ),
      );
    };
    await confirm();
    expect((await within(group).findByRole('alert')).textContent).toBe(
      'This schedule does not deliver to a webhook yet. Save it with a webhook address first.',
    );
    failNext.rotateScheduleWebhookSecret = new ApiError(404, {
      code: 'not_found',
      message: 'schedule not found',
      retryable: false,
    });
    // The question stays open after a failure, to try again or cancel.
    await userEvent.click(
      within(within(group).getByRole('group', { name: /Make a new secret\?/ })).getByRole(
        'button',
        { name: 'Make a new secret' },
      ),
    );
    await waitFor(() =>
      expect(within(group).getByRole('alert').textContent).toBe('schedule not found'),
    );
    expect(within(group).queryByRole('region', { name: 'Shown once' })).toBeNull();
  });
});
