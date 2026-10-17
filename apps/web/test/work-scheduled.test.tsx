// Scheduled (FR-055, FR-187, FR-206, ADR-079; docs/09 §6): the list with next run, last run and
// outcome, create and edit with the friendly picker, pause, delete, Run now and history.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { browserTimezone } from '../src/work/schedule-when.ts';
import { FakeEventSource, createHub } from './fakes.ts';
import { fireView, m5WorkState, scheduleView, type M5WorkState } from './fakes-m5-work.ts';
import { project, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

async function openScheduled(work: Partial<M5WorkState> = {}, path = '/work/scheduled') {
  const garden = project({ name: 'Garden plan' });
  const hub = createHub({
    m5work: m5WorkState(work),
    workspace: workspaceState({ projects: [garden] }),
  });
  const r = await renderApp({ hub, path });
  await screen.findByRole('heading', { name: 'Scheduled', level: 1 });
  return { ...r, hub, garden };
}

const row = async (name: string) =>
  within(await screen.findByRole('list', { name: 'Schedules' })).getByRole('listitem', { name });

describe('Scheduled list (FR-055, FR-187, FR-206)', () => {
  it('shows each rule, next and last run, outcomes and who set it', async () => {
    await openScheduled({
      schedules: [
        scheduleView({
          id: 's1',
          title: 'Morning digest',
          lastRunAt: '2026-10-01T09:00:00.000Z',
          lastOutcome: 'no_news',
        }),
        scheduleView({
          id: 's2',
          title: 'Ship the newsletter',
          when: { cron: '30 8 * * 1' },
          timezone: 'Europe/Paris',
          lastOutcome: 'output_missing',
          enabled: false,
        }),
        scheduleView({
          id: 's3',
          title: 'Check back on the build',
          when: { at: '2026-10-20T09:00:00.000Z' },
          origin: 'agent_self',
        }),
      ],
    });
    const digest = await row('Morning digest');
    expect(within(digest).getByText('Every day at 09:00 (UTC)')).toBeTruthy();
    expect(within(digest).getByText(/^Next run: /).textContent).not.toContain('Paused');
    expect(within(digest).getByText('No news')).toBeTruthy();
    const news = await row('Ship the newsletter');
    expect(within(news).getByText('Every Monday at 08:30 (Europe/Paris)')).toBeTruthy();
    expect(within(news).getByText('Output missing')).toBeTruthy();
    expect(within(news).getByText('Next run: Paused')).toBeTruthy();
    expect(within(news).getByRole('button', { name: 'Resume Ship the newsletter' })).toBeTruthy();
    const wake = await row('Check back on the build');
    expect(within(wake).getByText('Set by agent')).toBeTruthy();
    expect(within(wake).getByText(/^Once on /)).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Work sections' });
    expect(within(nav).getByRole('link', { name: 'Scheduled' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('shows an empty state and recovers from a load failure', async () => {
    const hub = createHub();
    hub.state.failNext.listSchedules = new ApiError(500, {
      code: 'x',
      message: 'Scheduler offline',
      retryable: true,
    });
    await renderApp({ hub, path: '/work/scheduled' });
    expect(await screen.findByText('Scheduler offline')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Nothing scheduled' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Schedule a task' }));
    expect(screen.getByRole('dialog', { name: 'New schedule' })).toBeTruthy();
  });
});

describe('create and edit (FR-055)', () => {
  it('creates a weekday schedule in the browser timezone with delivery, output and catch-up', async () => {
    const { hub, garden } = await openScheduled();
    await userEvent.click(screen.getByRole('button', { name: 'New schedule' }));
    const dialog = screen.getByRole('dialog', { name: 'New schedule' });
    expect(document.activeElement).toBe(
      within(dialog).getByRole('textbox', { name: 'Title (optional)' }),
    );
    await userEvent.keyboard('Standup notes');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Instructions' }),
      'Summarize yesterday’s commits',
    );
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Repeat' }),
      'weekdays',
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('Time').value).toBe('09:00');
    expect(
      within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Timezone' }).value,
    ).toBe(browserTimezone());
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Notify only when (optional)' }),
      'a test fails',
    );
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'System notification on this device' }),
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Webhook' }));
    const hook = within(dialog).getByRole('textbox', { name: 'Webhook address' });
    await userEvent.type(hook, 'http://insecure');
    expect(
      within(dialog).getByText('Enter the webhook address, starting with https://.'),
    ).toBeTruthy();
    const create = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Create schedule',
    });
    expect(create.disabled).toBe(true);
    await userEvent.clear(hook);
    await userEvent.type(hook, 'https://hooks.example.com/x');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Expected output' }),
      'artifact',
    );
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Skip them' }));
    const days = within(dialog).getByRole('spinbutton', { name: 'Catch up on the last (days)' });
    await userEvent.clear(days);
    await userEvent.type(days, '2');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Project' }),
      garden.id,
    );
    await userEvent.click(create);

    await waitFor(() =>
      expect(hub.api.createSchedule).toHaveBeenCalledWith({
        title: 'Standup notes',
        instructions: 'Summarize yesterday’s commits',
        when: { cron: '0 9 * * 1-5' },
        timezone: browserTimezone(),
        notifyCondition: 'a test fails',
        deliveryTargets: [
          { kind: 'inapp' },
          { kind: 'os' },
          { kind: 'webhook', ref: 'https://hooks.example.com/x' },
        ],
        output: { kind: 'artifact' },
        catchUp: { policy: 'skip', lookbackSeconds: 172_800 },
        projectId: garden.id,
      }),
    );
    const created = await row('Standup notes');
    expect(within(created).getByText(/^Weekdays at 09:00/)).toBeTruthy();
    expect(screen.getByText('Scheduled “Standup notes”.')).toBeTruthy();
  });

  it('uses intervals and refuses an advanced rule it cannot read', async () => {
    const { hub } = await openScheduled();
    await userEvent.click(screen.getByRole('button', { name: 'New schedule' }));
    const dialog = screen.getByRole('dialog', { name: 'New schedule' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Instructions' }), 'Ping');
    const repeat = within(dialog).getByRole('combobox', { name: 'Repeat' });
    await userEvent.selectOptions(repeat, 'advanced');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Cron expression or RRULE' }),
      'every day',
    );
    expect(within(dialog).getByRole('alert').textContent).toContain('five fields');
    await userEvent.selectOptions(repeat, 'interval');
    const every = within(dialog).getByRole('spinbutton', { name: 'Every' });
    await userEvent.clear(every);
    await userEvent.type(every, '30');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Unit' }),
      'minutes',
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'In-app notification' }));
    expect(within(dialog).getByText('Choose at least one place for the results.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'In-app notification' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create schedule' }));
    await waitFor(() =>
      expect(hub.api.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ when: { intervalSeconds: 1800 }, instructions: 'Ping' }),
      ),
    );
    expect(await row('Ping')).toBeTruthy();
  });

  it('edits a weekly schedule, keeping its rule in the picker, and reports a refusal', async () => {
    const { hub } = await openScheduled({
      schedules: [
        scheduleView({
          id: 's1',
          title: 'Ship the newsletter',
          when: { cron: '30 8 * * 1' },
          timezone: 'Europe/Paris',
          notifyCondition: 'there is news',
        }),
      ],
    });
    await userEvent.click(
      within(await row('Ship the newsletter')).getByRole('button', {
        name: 'Edit Ship the newsletter',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Edit schedule' });
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Repeat' }).value).toBe(
      'weekly',
    );
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Day' }).value).toBe(
      '1',
    );
    expect(within(dialog).getByLabelText<HTMLInputElement>('Time').value).toBe('08:30');
    expect(
      within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Timezone' }).value,
    ).toBe('Europe/Paris');
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Day' }), '5');
    await userEvent.clear(
      within(dialog).getByRole('textbox', { name: 'Notify only when (optional)' }),
    );
    hub.state.failNext.updateSchedule = new ApiError(400, {
      code: 'validation',
      message: 'Unknown timezone',
      retryable: false,
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
    expect(await within(dialog).findByText('Unknown timezone')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
    await waitFor(() =>
      expect(hub.api.updateSchedule).toHaveBeenLastCalledWith(
        's1',
        expect.objectContaining({ when: { cron: '30 8 * * 5' }, notifyCondition: '' }),
      ),
    );
    expect(await screen.findByText('Every Friday at 08:30 (Europe/Paris)')).toBeTruthy();
  });
});

describe('pause, run now, history and delete (FR-055, ADR-079)', () => {
  it('pauses and resumes, runs now, and shows fires, catch-up windows and skips', async () => {
    const { hub } = await openScheduled({
      schedules: [scheduleView({ id: 's1', title: 'Morning digest' })],
      fires: [
        fireView({
          scheduleId: 's1',
          kind: 'catch_up',
          runId: 'run-c',
          outcome: 'done',
          window: { first: '2026-09-28T09:00:00.000Z', last: '2026-09-30T09:00:00.000Z', count: 3 },
          firedAt: '2026-10-01T08:00:00.000Z',
        }),
        fireView({
          scheduleId: 's1',
          kind: 'skipped',
          window: { first: '2026-09-01T09:00:00.000Z', last: '2026-09-01T09:00:00.000Z', count: 1 },
          outcome: null,
          firedAt: '2026-09-29T08:00:00.000Z',
        }),
        fireView({
          scheduleId: 's1',
          kind: 'fire',
          runId: 'run-x',
          outcome: 'output_missing',
          firedAt: '2026-10-01T09:00:00.000Z',
        }),
      ],
    });
    const digest = await row('Morning digest');
    await userEvent.click(within(digest).getByRole('button', { name: 'Pause Morning digest' }));
    await waitFor(() =>
      expect(hub.api.updateSchedule).toHaveBeenCalledWith('s1', { enabled: false }),
    );
    expect(await within(digest).findByText('Paused')).toBeTruthy();
    await userEvent.click(within(digest).getByRole('button', { name: 'Resume Morning digest' }));
    await waitFor(() =>
      expect(hub.api.updateSchedule).toHaveBeenCalledWith('s1', { enabled: true }),
    );

    const history = within(digest).getByRole('button', { name: 'History of Morning digest' });
    await userEvent.click(history);
    expect(history.getAttribute('aria-expanded')).toBe('true');
    const section = await within(digest).findByRole('region', { name: 'History' });
    const items = await within(section).findAllByRole('listitem');
    expect(items).toHaveLength(3);
    // Newest first: the fire, the catch-up run, then the recorded skip.
    expect(items[0]!.textContent).toMatch(/^Ran .*Output missing.*Open run and its trace$/);
    expect(items[1]!.textContent).toMatch(/^Catch-up run: 3 missed times, .* to .*Done/);
    expect(items[2]!.textContent).toMatch(/^Skipped: 1 missed time, /);

    await userEvent.click(within(digest).getByRole('button', { name: 'Run now: Morning digest' }));
    await waitFor(() => expect(hub.api.runScheduleNow).toHaveBeenCalledWith('s1'));
    expect(await screen.findByText('“Morning digest” started a run.')).toBeTruthy();
    expect(await within(section).findByText('In progress')).toBeTruthy();
    const runId = hub.state.m5work.runs[0]!.id;
    await userEvent.click(screen.getByRole('button', { name: 'Open run' }));
    expect(window.location.pathname).toBe(`/work/${runId}`);
  });

  it('deletes after confirming, and refreshes on schedule events', async () => {
    const { hub } = await openScheduled({
      schedules: [scheduleView({ id: 's1', title: 'Morning digest' })],
    });
    const digest = await row('Morning digest');
    await userEvent.click(within(digest).getByRole('button', { name: 'Delete Morning digest' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete this schedule?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(hub.api.deleteSchedule).not.toHaveBeenCalled();
    await userEvent.click(within(digest).getByRole('button', { name: 'Delete Morning digest' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete this schedule?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(hub.api.deleteSchedule).toHaveBeenCalledWith('s1'));
    expect(await screen.findByRole('heading', { name: 'Nothing scheduled' })).toBeTruthy();

    hub.state.m5work.schedules = [
      scheduleView({ id: 's2', title: 'Agent wake', origin: 'agent_self' }),
    ];
    const es = FakeEventSource.all.find((x) => !x.closed && x.listeners.has('schedule.created'))!;
    es.emit('schedule.wake.set', { scheduleId: 's2', agentId: 'ag1', at: '', reason: 'check' });
    expect(await row('Agent wake')).toBeTruthy();
  });

  it('says when a pause or a run now fails', async () => {
    const { hub } = await openScheduled({
      schedules: [scheduleView({ id: 's1', title: 'Morning digest' })],
    });
    const digest = await row('Morning digest');
    hub.state.failNext.updateSchedule = new Error('Locked');
    await userEvent.click(within(digest).getByRole('button', { name: 'Pause Morning digest' }));
    expect(await screen.findByText('Could not change the schedule: Locked')).toBeTruthy();
    hub.state.failNext.runScheduleNow = new Error('Busy');
    await userEvent.click(within(digest).getByRole('button', { name: 'Run now: Morning digest' }));
    expect(await screen.findByText('Could not start the run: Busy')).toBeTruthy();
  });

  it('opens New schedule from /work/scheduled?new=1', async () => {
    await openScheduled({}, '/work/scheduled?new=1');
    expect(await screen.findByRole('dialog', { name: 'New schedule' })).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});
