// The Work list and New run (FR-051, FR-181, FR-182, FR-187, FR-215, FR-220; docs/04 §2.3).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { FakeEventSource, createHub } from './fakes.ts';
import { m5WorkState, runView } from './fakes-m5-work.ts';
import { project, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

/** The shared Work stream (the bell holds another on the same URL). */
const workStream = () => {
  const s = FakeEventSource.all.find((x) => !x.closed && x.listeners.has('run.status.changed'));
  if (!s) throw new Error('no work stream');
  return s;
};

describe('Work list (FR-051, FR-215)', () => {
  it('lists runs with chips, Needs input first, and opens one', async () => {
    const garden = project({ name: 'Garden plan' });
    const hub = createHub({
      workspace: workspaceState({ projects: [garden] }),
      m5work: m5WorkState({
        runs: [
          runView({
            id: 'r-done',
            title: 'Weekly digest',
            status: 'done',
            updatedAt: '2026-10-01T12:30:00.000Z',
          }),
          runView({
            id: 'r-run',
            title: 'Fix the invoices',
            status: 'running',
            projectId: garden.id,
            used: { timeSeconds: 720, tokens: 300_000, costUsd: 0.12 },
          }),
          runView({
            id: 'r-ask',
            title: 'Send the invoice',
            status: 'waiting_approval',
            derived: { status: 'needs_input', reason: 'Approval needed' },
          }),
        ],
      }),
    });
    await renderApp({ hub, path: '/work' });
    expect(screen.getByRole('heading', { name: 'Work', level: 1 })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Work sections' });
    expect(within(nav).getByRole('link', { name: 'Runs' }).getAttribute('aria-current')).toBe(
      'page',
    );
    const list = await screen.findByRole('list', { name: 'Runs' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByRole('link').textContent)).toEqual([
      'Send the invoice',
      'Fix the invoices',
      'Weekly digest',
    ]);
    // Status pairs icon and text; the reason is part of the chip's text.
    expect(within(rows[0]!).getByText('Needs input: Approval needed')).toBeTruthy();
    expect(within(rows[1]!).getByText('Running')).toBeTruthy();
    expect(await within(rows[1]!).findByText('Garden plan')).toBeTruthy();
    expect(within(rows[1]!).getByText('12 / 60 min · 0.3M / 2M tokens · $0.12')).toBeTruthy();
    expect(within(rows[2]!).getByText('Ready')).toBeTruthy();
    expect(within(rows[2]!).getByText('Done')).toBeTruthy();

    await userEvent.click(within(rows[1]!).getByRole('link', { name: 'Fix the invoices' }));
    expect(window.location.pathname).toBe('/work/r-run');
    expect(await screen.findByRole('heading', { name: 'Fix the invoices', level: 1 })).toBeTruthy();
  });

  it('filters active runs, shows empty states, and recovers from a load failure', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/chat' });
    // The sidebar lists active runs at start; the failure is for the Work list's own load.
    await waitFor(() => expect(hub.api.listRuns).toHaveBeenCalledWith({ status: 'active' }));
    hub.state.failNext.listRuns = new ApiError(500, {
      code: 'x',
      message: 'Hub unreachable',
      retryable: true,
    });
    await userEvent.click(screen.getByRole('link', { name: /^Work/ }));
    expect(await screen.findByText('Hub unreachable')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'No runs yet' })).toBeTruthy();

    await userEvent.click(screen.getByRole('radio', { name: 'Active runs' }));
    await waitFor(() => expect(hub.api.listRuns).toHaveBeenLastCalledWith({ status: 'active' }));
    expect(await screen.findByRole('heading', { name: 'No active runs' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show all runs' }));
    expect(await screen.findByRole('heading', { name: 'No runs yet' })).toBeTruthy();
  });

  it('refreshes when a run event arrives, and loads nothing while another mode shows', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/chat' });
    expect(hub.api.listRuns).not.toHaveBeenCalledWith({ status: 'all' });
    await userEvent.click(screen.getByRole('link', { name: /^Work/ }));
    await screen.findByRole('heading', { name: 'No runs yet' });
    hub.state.m5work.runs = [runView({ id: 'r9', title: 'Nightly check' })];
    workStream().emit('run.created', { runId: 'r9', title: 'Nightly check' });
    const list = await screen.findByRole('list', { name: 'Runs' });
    expect(within(list).getByRole('link', { name: 'Nightly check' })).toBeTruthy();
  });
});

describe('New run (FR-051, FR-181, FR-182, FR-220)', () => {
  it('starts a run with the defaults from settings, a goal, an output and a template', async () => {
    const garden = project({ name: 'Garden plan' });
    const hub = createHub({ workspace: workspaceState({ projects: [garden] }) });
    hub.state.settings['runs.autonomy'] = 'ask_first';
    hub.state.settings['runs.defaultBudgets'] = { timeSeconds: 1800, tokens: 500_000, costUsd: 2 };
    await renderApp({ hub, path: '/work' });
    await screen.findByRole('heading', { name: 'No runs yet' });
    await userEvent.click(screen.getByRole('button', { name: 'New run' }));
    const dialog = screen.getByRole('dialog', { name: 'New run' });
    const objective = within(dialog).getByRole('textbox', { name: 'What should the run do?' });
    expect(document.activeElement).toBe(objective);
    expect(within(dialog).getByRole<HTMLInputElement>('radio', { name: 'Ask first' }).checked).toBe(
      true,
    );
    expect(
      within(dialog).getByRole<HTMLInputElement>('spinbutton', { name: 'Time (minutes)' }).value,
    ).toBe('30');
    expect(within(dialog).getByRole<HTMLInputElement>('spinbutton', { name: 'Tokens' }).value).toBe(
      '500000',
    );
    const start = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Start run' });
    expect(start.disabled).toBe(true);

    await userEvent.type(objective, 'Summarize the attached report');
    expect(within(dialog).getByText('29 / 8,000 characters')).toBeTruthy();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Title (optional)' }),
      'Report',
    );
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Deep research' }));
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Project' }),
      garden.id,
    );
    // A time budget outside the bounds is explained and blocks Start.
    const minutes = within(dialog).getByRole('spinbutton', { name: 'Time (minutes)' });
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '0');
    expect(within(dialog).getByRole('alert').textContent).toContain('whole minutes');
    expect(start.disabled).toBe(true);
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '10');
    await userEvent.click(within(dialog).getByText('Goal and expected output (optional)'));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Goal' }), 'A saved summary');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Expected output' }),
      'artifact',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Output name or path (optional)' }),
      'summary.md',
    );
    await userEvent.click(start);

    await waitFor(() =>
      expect(hub.api.createRun).toHaveBeenCalledWith({
        objective: 'Summarize the attached report',
        title: 'Report',
        autonomy: 'ask_first',
        budgets: { timeSeconds: 600, tokens: 500_000, costUsd: 2 },
        projectId: garden.id,
        template: 'deep_research',
        goal: { objective: 'A saved summary' },
        expectedOutput: { kind: 'artifact', ref: 'summary.md' },
      }),
    );
    const created = hub.state.m5work.runs[0]!;
    await waitFor(() => expect(window.location.pathname).toBe(`/work/${created.id}`));
    expect(await screen.findByRole('heading', { name: 'Report', level: 1 })).toBeTruthy();
    expect(await screen.findByText('Run “Report” created.')).toBeTruthy();
  });

  it('keeps the form and says why when the Hub refuses, and opens from /work?new=1', async () => {
    const hub = createHub();
    hub.state.failNext.createRun = new ApiError(400, {
      code: 'validation',
      message: 'Budget above the managed maximum',
      retryable: false,
    });
    await renderApp({ hub, path: '/work?new=1' });
    const dialog = await screen.findByRole('dialog', { name: 'New run' });
    await waitFor(() => expect(window.location.search).toBe(''));
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'What should the run do?' }),
      'Do it',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start run' }));
    expect(await within(dialog).findByText('Budget above the managed maximum')).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: 'What should the run do?' })
        .value,
    ).toBe('Do it');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'New run' })).toBeNull();
  });

  it('asks for a reviewer model before an autonomous run (FR-085)', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/work?new=1' });
    const dialog = await screen.findByRole('dialog', { name: 'New run' });
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'What should the run do?' }),
      'Do it',
    );
    await userEvent.click(within(dialog).getByRole('radio', { name: /Autonomous/ }));
    expect(within(dialog).getByRole('alert').textContent).toMatch(/reviewer model/);
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Start run' }).disabled,
    ).toBe(true);
    expect(hub.api.createRun).not.toHaveBeenCalled();
  });

  it('opens from the palette commands and moves between the Runs and Scheduled tabs', async () => {
    const hub = createHub();
    const { registry } = await renderApp({ hub, path: '/chat' });
    act(() => void registry.run('work.newRun'));
    expect(await screen.findByRole('dialog', { name: 'New run' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('link', { name: 'Scheduled' }));
    expect(window.location.pathname).toBe('/work/scheduled');
    expect(await screen.findByRole('heading', { name: 'Scheduled', level: 1 })).toBeTruthy();
    await userEvent.click(screen.getByRole('link', { name: 'Runs' }));
    expect(await screen.findByRole('heading', { name: 'Work', level: 1 })).toBeTruthy();
    act(() => void registry.run('work.newSchedule'));
    expect(await screen.findByRole('dialog', { name: 'New schedule' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    act(() => void registry.run('work.scheduled'));
    expect(window.location.pathname).toBe('/work/scheduled');
  });
});
