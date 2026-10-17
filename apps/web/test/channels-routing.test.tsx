// Notification routing and quiet hours (FR-060), the section at the end of Settings →
// Notifications: per kind, unread in Nova, on devices, to Slack, Teams or webhook channels and
// through quiet hours; reset to the default; quiet hours with days and a time zone.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { NotificationsPage } from '../src/settings/NotificationsPage.tsx';
import { bindingView, quietView, renderWithChannels, ruleView } from './fakes-m6-channels.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const SLACK = bindingView({ id: 'b1', kind: 'slack', label: 'Slack #ops' });
const INAPP = bindingView({ id: 'b2', kind: 'inapp', label: 'In-app' });
const fail = (message: string) =>
  new ApiError(500, { code: 'server_error', message, retryable: false });

const group = async (name: string) => within(await screen.findByRole('group', { name }));
const box = (g: { getByRole: (role: string, o: { name: string }) => HTMLElement }, name: string) =>
  g.getByRole('checkbox', { name }) as HTMLInputElement;

describe('where notifications go (FR-060)', () => {
  it('saves a kind’s route at once and resets it to the default', async () => {
    const { api, state } = await renderWithChannels(<NotificationsPage />);
    const errors = await group('Errors');
    expect(errors.getByText(/Using the default/)).toBeTruthy();
    expect(box(errors, 'On your devices').checked).toBe(true);
    await userEvent.click(box(errors, 'On your devices'));
    expect(api.setNotificationRule).toHaveBeenCalledWith('error', {
      inapp: true,
      os: false,
      channels: [],
      bypassQuietHours: false,
    });
    await waitFor(() => expect(state.rules).toHaveLength(1));
    expect(box(errors, 'On your devices').checked).toBe(false);
    await userEvent.click(errors.getByRole('button', { name: 'Reset Errors to the default' }));
    expect(await screen.findByText('Errors: back to the default.')).toBeTruthy();
    expect(box(errors, 'On your devices').checked).toBe(true);
    expect(state.rules).toHaveLength(0);
  });

  it('lets approvals through quiet hours by default and sends a kind to Slack', async () => {
    const { api } = await renderWithChannels(<NotificationsPage />, {
      channels: { bindings: [SLACK, INAPP] },
    });
    const approvals = await group('Approvals');
    expect(box(approvals, 'Also during quiet hours').checked).toBe(true);
    const done = await group('Finished work');
    expect(box(done, 'Also during quiet hours').checked).toBe(false);
    // Only Slack, Teams and webhook channels can receive notifications.
    expect(await done.findByRole('checkbox', { name: 'Slack #ops (Slack)' })).toBeTruthy();
    expect(done.queryByRole('checkbox', { name: /In-app/ })).toBeNull();
    await userEvent.click(box(done, 'Slack #ops (Slack)'));
    expect(api.setNotificationRule).toHaveBeenCalledWith('completion', {
      inapp: true,
      os: true,
      channels: ['b1'],
      bypassQuietHours: false,
    });
    await waitFor(() => expect(box(done, 'Slack #ops (Slack)').checked).toBe(true));
  });

  it('rolls a refused change back', async () => {
    const { channels } = await renderWithChannels(<NotificationsPage />);
    const system = await group('System');
    channels.failNext.setNotificationRule = fail('Read-only database');
    await userEvent.click(box(system, 'Unread in Nova'));
    expect(await screen.findByText('Could not save: Read-only database')).toBeTruthy();
    expect(box(system, 'Unread in Nova').checked).toBe(true);
  });

  it('lists a removed channel so it can be taken off', async () => {
    const { api } = await renderWithChannels(<NotificationsPage />, {
      channels: {
        bindings: [SLACK],
        rules: [ruleView('error', { channels: ['gone'], isDefault: false })],
      },
    });
    const errors = await group('Errors');
    const gone = await errors.findByRole('checkbox', { name: 'A removed channel' });
    await userEvent.click(gone);
    expect(api.setNotificationRule).toHaveBeenCalledWith(
      'error',
      expect.objectContaining({ channels: [] }),
    );
  });

  it('disables a kind turned off above', async () => {
    await renderWithChannels(<NotificationsPage />, {
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
    const system = await group('System');
    expect(system.getByText('Turned off above: not recorded or sent anywhere.')).toBeTruthy();
    expect(box(system, 'Unread in Nova').disabled).toBe(true);
    expect(box(await group('Errors'), 'Unread in Nova').disabled).toBe(false);
  });

  it('points to Channels when there is none, and shows a load error with retry', async () => {
    await renderWithChannels(<NotificationsPage />, {
      fail: { listNotificationRules: fail('Hub is restarting') },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Hub is restarting');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await group('Errors');
    await userEvent.click(screen.getByRole('link', { name: 'Channels' }));
    expect(window.location.pathname).toBe('/settings/channels');
  });
});

describe('quiet hours (FR-060)', () => {
  it('saves a window with days and a time zone', async () => {
    const { api, state } = await renderWithChannels(<NotificationsPage />);
    const form = within(await screen.findByRole('form', { name: 'Quiet hours' }));
    const save = form.getByRole<HTMLButtonElement>('button', { name: 'Save quiet hours' });
    expect(save.disabled).toBe(true);
    await userEvent.click(form.getByRole('switch', { name: 'Use quiet hours' }));
    const from = form.getByLabelText('From');
    await userEvent.clear(from);
    await userEvent.type(from, '21:30');
    await userEvent.click(form.getByRole('checkbox', { name: 'Saturday' }));
    await userEvent.click(form.getByRole('checkbox', { name: 'Sunday' }));
    await userEvent.selectOptions(form.getByLabelText('Time zone'), 'Europe/Paris');
    await userEvent.click(save);
    expect(api.setQuietHours).toHaveBeenCalledWith({
      enabled: true,
      start: '21:30',
      end: '07:00',
      timezone: 'Europe/Paris',
      days: [1, 2, 3, 4, 5],
    });
    expect(await screen.findByText('Quiet hours saved.')).toBeTruthy();
    expect(state.quietHours.timezone).toBe('Europe/Paris');
    expect(form.getByText('Ends the next day.')).toBeTruthy();
  });

  it('checks the window and the days before saving', async () => {
    const { api } = await renderWithChannels(<NotificationsPage />, {
      channels: { quietHours: quietView({ enabled: true }) },
    });
    const form = within(await screen.findByRole('form', { name: 'Quiet hours' }));
    const until = form.getByLabelText('Until');
    await userEvent.clear(until);
    await userEvent.type(until, '22:00');
    for (const d of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])
      await userEvent.click(form.getByRole('checkbox', { name: d }));
    await userEvent.click(form.getByRole('button', { name: 'Save quiet hours' }));
    expect(form.getByText('Start and end must differ.')).toBeTruthy();
    expect(form.getByText('Pick at least one day.')).toBeTruthy();
    expect(api.setQuietHours).not.toHaveBeenCalled();
  });

  it('says when quiet hours are on now', async () => {
    await renderWithChannels(<NotificationsPage />, {
      channels: {
        quietHours: quietView({ enabled: true, active: true, until: '2026-10-02T07:00:00.000Z' }),
      },
    });
    expect((await screen.findByText(/Quiet hours are on now, until/)).getAttribute('role')).toBe(
      'status',
    );
  });

  it('shows the Hub refusing a time zone on its field', async () => {
    const { channels } = await renderWithChannels(<NotificationsPage />);
    const form = within(await screen.findByRole('form', { name: 'Quiet hours' }));
    channels.api.setQuietHours.mockRejectedValueOnce(
      new ApiError(400, {
        code: 'validation',
        message: 'unknown time zone Mars/Base',
        retryable: false,
        details: { field: 'timezone' },
      }),
    );
    await userEvent.click(form.getByRole('switch', { name: 'Use quiet hours' }));
    await userEvent.click(form.getByRole('button', { name: 'Save quiet hours' }));
    expect((await form.findByRole('alert')).textContent).toBe('unknown time zone Mars/Base');
  });
});
