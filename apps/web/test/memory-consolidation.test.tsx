import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { CONSOLIDATION_POLL_MS } from '../src/settings/MemoryConsolidation.tsx';
import { createHub } from './fakes.ts';
import { m3State } from './fakes-m3.ts';
import { consolidationRun } from './fakes-settings.ts';
import { captureIntervals, memoryItem, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const fail = (message: string) => new ApiError(500, { code: 'x', message, retryable: true });
const summarySection = () =>
  screen.getByRole('heading', { name: 'Summary used in context' }).closest('section')!;

describe('Memory page: consolidation (FR-204)', () => {
  it('shows the summary in use with its size, read-only', async () => {
    const hub = createHub({
      m3: m3State({
        summary: {
          scopeKind: 'global',
          scopeRef: null,
          summary: 'Leads the billing team. Prefers short status updates.',
          summaryTokens: 1840,
          runId: 'run1',
          updatedAt: '2026-10-01T12:00:00Z',
        },
        consolidations: [
          consolidationRun({ id: 'run1', error: null }),
          consolidationRun({
            id: 'run0',
            status: 'failed',
            phase: 'extract',
            error: 'Model unavailable',
            summaryTokens: null,
          }),
        ],
      }),
    });
    await renderApp({ hub, path: '/settings/memory' });
    const s = summarySection();
    expect(await within(s).findByText(/1,840 \/ 2,500 tokens/)).toBeTruthy();
    expect(within(s).getByRole('meter', { name: 'Summary size' })).toBeTruthy();
    await userEvent.click(within(s).getByText('View summary'));
    expect(within(s).getByText(/Leads the billing team/)).toBeTruthy();
    expect(within(s).getByText(/Read-only. To change it/)).toBeTruthy();
    const history = within(s).getByRole('list', { name: 'Consolidation history' });
    const runs = within(history).getAllByRole('listitem');
    expect(within(runs[0]!).getByText('Done')).toBeTruthy();
    expect(
      within(runs[0]!).getByText(
        /4 chats scanned · 2 added · 1 updated · 1 aged · summary 640 tokens/,
      ),
    ).toBeTruthy();
    expect(within(runs[1]!).getByText('Failed')).toBeTruthy();
    expect(within(runs[1]!).getByText('Collecting from idle chats')).toBeTruthy();
    expect(within(runs[1]!).getByText('Model unavailable')).toBeTruthy();
  });

  it('consolidates now and follows the run until it finishes', async () => {
    const polls = captureIntervals(CONSOLIDATION_POLL_MS);
    const hub = createHub();
    await renderApp({ hub, path: '/settings/memory' });
    const s = summarySection();
    expect(await within(s).findByText(/No summary yet/)).toBeTruthy();
    expect(within(s).getByText('No consolidation runs yet.')).toBeTruthy();
    hub.state.failNext.consolidateMemory = fail('Already running');
    const button = within(s).getByRole<HTMLButtonElement>('button', { name: 'Consolidate now' });
    await userEvent.click(button);
    expect(await screen.findByText('Could not start consolidation: Already running')).toBeTruthy();
    await userEvent.click(button);
    expect(
      await screen.findByText('Consolidation started. It runs in the background.'),
    ).toBeTruthy();
    expect(within(s).getByText('Running')).toBeTruthy();
    expect(button.disabled).toBe(true);
    expect(polls.count()).toBe(1);

    hub.state.m3.consolidations = hub.state.m3.consolidations.map((r) => ({
      ...r,
      status: 'completed' as const,
      summaryTokens: 300,
      endedAt: '2026-10-01T12:01:00Z',
    }));
    hub.state.m3.summary = {
      ...hub.state.m3.summary,
      summary: 'Lives in Porto.',
      summaryTokens: 300,
    };
    polls.fire();
    expect(await within(s).findByText(/300 \/ 2,500 tokens/)).toBeTruthy();
    expect(within(s).getByText('Done')).toBeTruthy();
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(polls.count()).toBe(0);
  });

  it('retries a failed summary load and turns background consolidation off', async () => {
    const hub = createHub();
    hub.state.failNext.memorySummary = fail('Summary store offline');
    await renderApp({ hub, path: '/settings/memory' });
    const s = summarySection();
    expect(await within(s).findByText('Summary store offline')).toBeTruthy();
    await userEvent.click(within(s).getByRole('button', { name: 'Retry' }));
    expect(await within(s).findByText(/No summary yet/)).toBeTruthy();
    const bg = within(s).getByRole('switch', { name: 'Consolidate in the background' });
    expect(within(s).getByText(/idle for 60 minutes/)).toBeTruthy();
    await userEvent.click(bg);
    await waitFor(() =>
      expect(hub.state.settings['memory.consolidation']).toEqual({
        enabled: false,
        idleMinutes: 60,
      }),
    );
  });
});

describe('Memory page: history reference and topics (FR-205, FR-204)', () => {
  it('turns reference to past chats off with the 30-day purge note', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/memory' });
    const sw = await screen.findByRole('switch', { name: 'Reference past chats' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByText(/deletes the data derived from your chats within 30 days/),
    ).toBeTruthy();
    await userEvent.click(sw);
    await waitFor(() => expect(hub.state.settings['memory.referencePastChats']).toBe(false));
    expect(
      await screen.findByText(
        'Past chats are no longer used. Derived data is deleted within 30 days.',
      ),
    ).toBeTruthy();
    hub.state.failNext.setSetting = fail('Read-only');
    await userEvent.click(sw);
    expect(await screen.findByText('Could not save: Read-only')).toBeTruthy();
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('locks reference to past chats when managed', async () => {
    const hub = createHub({ managed: { 'memory.referencePastChats': false } });
    await renderApp({ hub, path: '/settings/memory' });
    const sw = await screen.findByRole<HTMLButtonElement>('switch', {
      name: 'Reference past chats',
    });
    expect(sw.disabled).toBe(true);
  });

  it('steers consolidation per category with Remember more and less', async () => {
    const hub = createHub({
      workspace: workspaceState({
        memory: [
          memoryItem({ content: 'Trip to Lisbon', category: 'Travel' }),
          memoryItem({ content: 'Leads billing', category: 'Work' }),
          memoryItem({ content: 'Likes tea', category: null }),
        ],
      }),
      m3: m3State({ topics: [{ topic: 'Work', preference: 'less' }] }),
    });
    await renderApp({ hub, path: '/settings/memory' });
    const work = await screen.findByRole('group', { name: 'How much to remember about Work' });
    await waitFor(() =>
      expect(
        within(work).getByRole('button', { name: 'Remember less' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(screen.queryByRole('group', { name: 'How much to remember about Other' })).toBeNull();

    const travel = screen.getByRole('group', { name: 'How much to remember about Travel' });
    const more = within(travel).getByRole('button', { name: 'Remember more' });
    expect(more.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(more);
    expect(more.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(hub.api.setMemoryTopic).toHaveBeenCalledWith('Travel', 'more'));
    expect(await screen.findByText('Nova will remember more about Travel.')).toBeTruthy();
    await userEvent.click(more);
    await waitFor(() =>
      expect(hub.api.setMemoryTopic).toHaveBeenLastCalledWith('Travel', 'default'),
    );
    expect(await screen.findByText('Back to the usual for Travel.')).toBeTruthy();

    hub.state.failNext.setMemoryTopic = fail('Topic store offline');
    await userEvent.click(within(travel).getByRole('button', { name: 'Remember less' }));
    expect(await screen.findByText('Could not save: Topic store offline')).toBeTruthy();
    expect(
      within(travel).getByRole('button', { name: 'Remember less' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });
});
