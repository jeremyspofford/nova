// The shell's M5 parts (FR-215, FR-182, FR-186): status chips and Needs-input sorting in the
// sidebar, live thread status from the shared stream, the next-needs-input key, and Settings →
// General → Work runs.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { NEXT_NEEDS_INPUT } from '../src/shell/SidebarStatus.ts';
import { FakeEventSource, createHub, thread } from './fakes.ts';
import { m5WorkState, runView } from './fakes-m5-work.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const workStream = () => {
  const s = FakeEventSource.all.find((x) => !x.closed && x.listeners.has('thread.status.changed'));
  if (!s) throw new Error('no work stream');
  return s;
};

const recentTitles = () => {
  const sidebar = screen.getByRole('navigation', { name: 'Sidebar' });
  const recent = within(sidebar).getByRole('region', { name: 'Recent' });
  return within(recent)
    .getAllByRole('listitem')
    .map((li) => li.querySelector('.thread-title')?.textContent);
};

describe('sidebar status (FR-215)', () => {
  it('shows derived chips with reasons and sorts Needs input first, then Blocked and Running', async () => {
    const hub = createHub({
      threads: [
        thread({ id: 'a', title: 'Newest idle', updatedAt: '2026-10-01T12:00:09.000Z' }),
        thread({
          id: 'b',
          title: 'Budget hit',
          updatedAt: '2026-10-01T12:00:08.000Z',
          derived: { status: 'blocked', reason: 'Budget reached' },
        }),
        thread({
          id: 'c',
          title: 'Waiting on me',
          updatedAt: '2026-10-01T12:00:01.000Z',
          derived: { status: 'needs_input', reason: 'Approval needed' },
        }),
        thread({
          id: 'd',
          title: 'Child is busy',
          updatedAt: '2026-10-01T12:00:05.000Z',
          derived: { status: 'running', reason: null },
        }),
      ],
    });
    await renderApp({ hub });
    await waitFor(() =>
      expect(recentTitles()).toEqual([
        'Waiting on me',
        'Budget hit',
        'Child is busy',
        'Newest idle',
      ]),
    );
    const sidebar = screen.getByRole('navigation', { name: 'Sidebar' });
    const waiting = within(sidebar).getByRole('link', { name: /Waiting on me/ });
    // Compact chips keep icon and text for assistive tech, with the reason.
    expect(within(waiting).getByText('Needs input: Approval needed')).toBeTruthy();
    expect(
      within(within(sidebar).getByRole('link', { name: /Budget hit/ })).getByText(
        'Blocked: Budget reached',
      ),
    ).toBeTruthy();
    expect(
      within(within(sidebar).getByRole('link', { name: /Newest idle/ })).queryByText(/Ready/),
    ).toBeNull();
  });

  it('follows thread.status.changed for chats that are not open', async () => {
    const hub = createHub({
      threads: [
        thread({ id: 'a', title: 'First', updatedAt: '2026-10-01T12:00:09.000Z' }),
        thread({ id: 'b', title: 'Second', updatedAt: '2026-10-01T12:00:05.000Z' }),
      ],
    });
    await renderApp({ hub });
    await waitFor(() => expect(recentTitles()).toEqual(['First', 'Second']));
    workStream().emit('thread.status.changed', {
      ref: { kind: 'thread', id: 'b' },
      from: 'ready',
      status: 'needs_input',
    });
    await waitFor(() => expect(recentTitles()).toEqual(['Second', 'First']));
    const sidebar = screen.getByRole('navigation', { name: 'Sidebar' });
    expect(
      within(within(sidebar).getByRole('link', { name: /Second/ })).getByText('Needs input'),
    ).toBeTruthy();
    // Other kinds and unknown threads change nothing.
    workStream().emit('thread.status.changed', {
      ref: { kind: 'run', id: 'a' },
      status: 'blocked',
    });
    workStream().emit('thread.status.changed', {
      ref: { kind: 'thread', id: 'zz' },
      status: 'blocked',
    });
    workStream().emit('thread.status.changed', {
      ref: { kind: 'thread', id: 'b' },
      from: 'needs_input',
      status: 'ready',
    });
    await waitFor(() => expect(recentTitles()).toEqual(['First', 'Second']));
  });

  it('jumps to the next item that needs input with Ctrl+Alt+A: chats, then runs', async () => {
    const hub = createHub({
      threads: [
        thread({ id: 'calm', title: 'Calm' }),
        thread({
          id: 'ask',
          title: 'Asks a question',
          derived: { status: 'needs_input', reason: null },
        }),
      ],
      m5work: m5WorkState({
        runs: [
          runView({ id: 'r-wait', status: 'waiting_approval' }),
          runView({ id: 'r-run', status: 'running' }),
        ],
      }),
    });
    const { registry } = await renderApp({ hub, path: '/settings/general' });
    expect(registry.get(NEXT_NEEDS_INPUT)?.title).toBe('Go to the next item that needs input');
    await userEvent.keyboard('{Control>}{Alt>}a{/Alt}{/Control}');
    await waitFor(() => expect(window.location.pathname).toBe('/chat/ask'));
    expect(hub.api.listRuns).toHaveBeenCalledWith({ status: 'active' });
    await userEvent.keyboard('{Control>}{Alt>}a{/Alt}{/Control}');
    await waitFor(() => expect(window.location.pathname).toBe('/work/r-wait'));
    await userEvent.keyboard('{Control>}{Alt>}a{/Alt}{/Control}');
    await waitFor(() => expect(window.location.pathname).toBe('/chat/ask'));
  });

  it('says so when nothing needs input, even if runs cannot be listed', async () => {
    const hub = createHub({ threads: [thread({ title: 'Calm' })] });
    const { registry } = await renderApp({ hub });
    hub.state.failNext.listRuns = new Error('offline');
    registry.run(NEXT_NEEDS_INPUT);
    expect(await screen.findByText('Nothing needs your input right now.')).toBeTruthy();
    expect(window.location.pathname).toBe('/chat');
  });

  it('lists active runs under Work with live chips: Running, Needs input, Running (J5)', async () => {
    const hub = createHub({
      m5work: m5WorkState({
        runs: [
          runView({ id: 'r1', title: 'Summarize the report', status: 'running' }),
          runView({ id: 'r2', title: 'Paused digest', status: 'paused', pauseReason: 'user' }),
          runView({ id: 'r3', title: 'Old one', status: 'done' }),
        ],
      }),
    });
    await renderApp({ hub });
    const sidebar = screen.getByRole('navigation', { name: 'Sidebar' });
    const runs = await within(sidebar).findByRole('list', { name: 'Active runs' });
    const link = () => within(runs).getByRole('link', { name: /Summarize the report/ });
    expect(within(runs).getAllByRole('link')).toHaveLength(2);
    expect(within(link()).getByText('Running')).toBeTruthy();
    expect(within(runs).getByRole('link', { name: /Paused digest, paused/ })).toBeTruthy();

    hub.state.m5work.runs = hub.state.m5work.runs.map((r) =>
      r.id === 'r1'
        ? {
            ...r,
            status: 'waiting_approval',
            derived: { status: 'needs_input', reason: 'Approval needed' },
          }
        : r,
    );
    const es = workStream();
    es.emit('approval.requested', { approvalId: 'ap1' });
    es.emit('run.status.changed', { runId: 'r1', from: 'running', to: 'waiting_approval' });
    expect(await within(runs).findByText('Needs input: Approval needed')).toBeTruthy();
    // Usage ticks alone do not reload the list.
    const calls = hub.api.listRuns.mock.calls.length;
    es.emit('run.budget.usage', { runId: 'r1', usage: { tokens: 10 } });
    hub.state.m5work.runs = hub.state.m5work.runs.map((r) =>
      r.id === 'r1' ? { ...r, status: 'running', derived: { status: 'running', reason: null } } : r,
    );
    es.emit('run.status.changed', { runId: 'r1', from: 'waiting_approval', to: 'running' });
    await waitFor(() => expect(within(link()).getByText('Running')).toBeTruthy());
    expect(hub.api.listRuns.mock.calls.length).toBe(calls + 1);

    await userEvent.click(link());
    expect(window.location.pathname).toBe('/work/r1');
    await waitFor(() => expect(link().getAttribute('aria-current')).toBe('page'));
  });
});

describe('Settings → General → Work runs (FR-182, FR-186)', () => {
  it('saves default budgets, autonomy and chat escalation', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/general' });
    const section = await screen.findByRole('region', { name: 'Work runs' });
    const time = within(section).getByRole<HTMLInputElement>('spinbutton', {
      name: 'Time budget (minutes)',
    });
    expect(time.value).toBe('60');
    await userEvent.clear(time);
    await userEvent.type(time, '90{Enter}');
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('runs.defaultBudgets', {
        timeSeconds: 5400,
        tokens: 2_000_000,
        costUsd: null,
      }),
    );

    const cost = within(section).getByRole<HTMLInputElement>('spinbutton', {
      name: 'Cost limit (US dollars)',
    });
    expect(cost.value).toBe('');
    await userEvent.type(cost, '2.5');
    cost.blur();
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenLastCalledWith('runs.defaultBudgets', {
        timeSeconds: 5400,
        tokens: 2_000_000,
        costUsd: 2.5,
      }),
    );
    await waitFor(() => expect(cost.value).toBe('2.5'));
    // Blank goes back to the provider spend cap.
    await userEvent.clear(cost);
    cost.blur();
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenLastCalledWith('runs.defaultBudgets', {
        timeSeconds: 5400,
        tokens: 2_000_000,
        costUsd: null,
      }),
    );

    const tokens = within(section).getByRole('spinbutton', { name: 'Token budget' });
    await userEvent.clear(tokens);
    await userEvent.type(tokens, '10{Enter}');
    expect(
      within(section).getByText('Enter a whole number from 1,000 to 100,000,000.'),
    ).toBeTruthy();
    expect(hub.api.setSetting).toHaveBeenCalledTimes(3);

    await userEvent.click(within(section).getByRole('radio', { name: 'Ask first' }));
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('runs.autonomy', 'ask_first'),
    );
    const escalation = within(section).getByRole('group', {
      name: 'Turn multi-step chat requests into runs',
    });
    expect(
      within(escalation).getByRole<HTMLInputElement>('radio', { name: 'Propose a run' }).checked,
    ).toBe(true);
    await userEvent.click(within(escalation).getByRole('radio', { name: 'Never' }));
    await waitFor(() => expect(hub.api.setSetting).toHaveBeenCalledWith('chat.escalation', 'off'));
  });

  it('locks managed values', async () => {
    const hub = createHub();
    hub.state.managed['runs.defaultBudgets'] = { timeSeconds: 600, tokens: 100_000, costUsd: 1 };
    hub.state.managed['chat.escalation'] = 'off';
    await renderApp({ hub, path: '/settings/general' });
    const section = await screen.findByRole('region', { name: 'Work runs' });
    const time = within(section).getByRole<HTMLInputElement>('spinbutton', {
      name: 'Time budget (minutes)',
    });
    expect(time.value).toBe('10');
    expect(time.disabled).toBe(true);
    expect(within(section).getByRole<HTMLInputElement>('radio', { name: 'Never' }).disabled).toBe(
      true,
    );
  });
});
