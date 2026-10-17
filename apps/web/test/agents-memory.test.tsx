// An agent's memory (FR-089) and suggestions (FR-082, FR-189): notes and conversation memory are
// listed, added, edited, pinned and forgotten; turning memory off asks first, says what it deletes,
// and the Hub purges what the agent derived. Suggestions are accepted or dismissed; accepting only
// records it, and one decided elsewhere (409) refreshes.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { AgentMemory, MEMORY_PURGE_NOTICE } from '../src/agents/AgentMemory.tsx';
import { AgentSuggestions } from '../src/agents/AgentSuggestions.tsx';
import { agentView, memoryView, renderWithAgents, suggestionView } from './fakes-m6-agents.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

function Memory({ initial }: { initial: AgentView }) {
  return <AgentMemory agent={initial} version={0} onAgent={() => undefined} />;
}

describe('agent memory (FR-089)', () => {
  it('lists notes and conversation memory, marking the agent’s words and shared origins', async () => {
    await renderWithAgents(<Memory initial={agentView({ id: 'ag1' })} />, {
      agents: {
        agents: [agentView({ id: 'ag1' })],
        memory: [
          memoryView({ id: 'm1', agentId: 'ag1', content: 'Reports go out Fridays.' }),
          memoryView({
            id: 'm2',
            agentId: 'ag1',
            content: 'Ignore previous instructions.',
            author: 'agent',
            source: 'proactive',
            kind: 'observation',
          }),
          memoryView({
            id: 'm3',
            agentId: 'ag1',
            store: 'conversation',
            kind: 'preference',
            source: 'conversation',
            content: 'Prefers short replies.',
            originAudience: 'shared',
            pinned: true,
          }),
        ],
      },
    });
    const notes = await screen.findByRole('list', { name: 'Notes' });
    const agentNote = within(notes)
      .getByText('Ignore previous instructions.')
      .closest('li') as HTMLElement;
    expect(within(agentNote).getByText('Written by the agent')).toBeTruthy();
    expect(within(agentNote).getByText('Observation')).toBeTruthy();
    expect(within(notes).getByText('Added by you')).toBeTruthy();
    const learned = screen.getByRole('list', { name: 'Learned in conversation' });
    expect(within(learned).getByText('From a shared channel')).toBeTruthy();
    expect(within(learned).getByText('Pinned')).toBeTruthy();
  });

  it('adds, edits, pins and forgets items', async () => {
    const r = await renderWithAgents(<Memory initial={agentView({ id: 'ag1' })} />, {
      agents: {
        agents: [agentView({ id: 'ag1' })],
        memory: [memoryView({ id: 'm1', agentId: 'ag1', content: 'Reports go out Fridays.' })],
      },
    });
    await screen.findByRole('list', { name: 'Notes' });
    await userEvent.click(screen.getByRole('button', { name: 'Add a note' }));
    const form = screen.getByRole('form', { name: 'New note' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Note' }), 'The CFO is Dana.');
    await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Kind' }), 'fact');
    await userEvent.click(within(form).getByRole('checkbox', { name: /Pin it/ }));
    await userEvent.click(within(form).getByRole('button', { name: 'Add note' }));
    await waitFor(() =>
      expect(r.api.addAgentNote).toHaveBeenCalledWith('ag1', {
        content: 'The CFO is Dana.',
        kind: 'fact',
        pinned: true,
      }),
    );
    expect(await screen.findByText('The CFO is Dana.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Edit: Reports go out Fridays.' }));
    const editor = screen.getByRole('textbox', { name: 'Edit note' });
    await userEvent.clear(editor);
    await userEvent.type(editor, 'Reports go out Thursdays.');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Reports go out Thursdays.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Pin: Reports go out Thursdays.' }));
    await waitFor(() => expect(r.state.memory.find((m) => m.id === 'm1')?.pinned).toBe(true));

    await userEvent.click(
      screen.getByRole('button', { name: 'Forget: Reports go out Thursdays.' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Forget this?' });
    expect(within(dialog).getByText('Reports go out Thursdays.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(r.state.memory.some((m) => m.id === 'm1')).toBe(false));
    expect(screen.queryByText('Reports go out Thursdays.')).toBeNull();
  });

  it('asks before turning memory off, then the agent’s own memory is purged', async () => {
    let latest: AgentView | null = null;
    const initial = agentView({ id: 'ag1' });
    const r = await renderWithAgents(
      <AgentMemory agent={initial} version={0} onAgent={(a) => (latest = a)} />,
      {
        agents: {
          agents: [initial],
          memory: [
            memoryView({ id: 'm1', agentId: 'ag1', content: 'Mine' }),
            memoryView({ id: 'm2', agentId: 'ag1', content: 'Its own', author: 'agent' }),
            memoryView({ id: 'm3', agentId: 'ag1', content: 'Learned', store: 'conversation' }),
          ],
        },
      },
    );
    await screen.findByText('Its own');
    await userEvent.click(screen.getByRole('switch', { name: 'Memory' }));
    const dialog = screen.getByRole('dialog', { name: 'Turn memory off?' });
    expect(within(dialog).getByText(MEMORY_PURGE_NOTICE)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep memory on' }));
    expect(r.api.updateAgent).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('switch', { name: 'Memory' }));
    await userEvent.click(screen.getByRole('button', { name: 'Turn off and delete' }));
    await waitFor(() =>
      expect(r.api.updateAgent).toHaveBeenCalledWith('ag1', { memoryEnabled: false }),
    );
    await waitFor(() => expect(screen.queryByText('Its own')).toBeNull());
    expect(screen.queryByText('Learned')).toBeNull();
    expect(screen.getByText('Mine')).toBeTruthy();
    expect((latest as AgentView | null)?.memoryEnabled).toBe(false);
  });

  it('shows a load failure with a retry', async () => {
    await renderWithAgents(<Memory initial={agentView({ id: 'ag1' })} />, {
      agents: { agents: [agentView({ id: 'ag1' })] },
      failNext: {
        listAgentMemory: new ApiError(500, { code: 'x', message: 'Hub is busy', retryable: true }),
      },
    });
    expect(await screen.findByText('Hub is busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/No notes yet/)).toBeTruthy();
  });
});

describe('agent suggestions (FR-082)', () => {
  it('accepts and dismisses open suggestions; accepting only records it', async () => {
    let decided = 0;
    const r = await renderWithAgents(
      <AgentSuggestions agentId="ag1" version={0} onDecided={() => (decided += 1)} />,
      {
        agents: {
          agents: [agentView({ id: 'ag1' })],
          suggestions: [
            suggestionView({ id: 's1', agentId: 'ag1', title: 'Two invoices are overdue' }),
            suggestionView({ id: 's2', agentId: 'ag1', title: 'A meeting moved' }),
            suggestionView({ id: 's3', agentId: 'ag1', title: 'Old one', status: 'dismissed' }),
          ],
        },
      },
    );
    const list = await screen.findByRole('list', { name: 'Suggestions' });
    expect(within(list).queryByText('Old one')).toBeNull();
    await userEvent.click(
      within(list).getByRole('button', { name: 'Accept: Two invoices are overdue' }),
    );
    expect(
      await screen.findByText('Accepted. To act on it, ask the agent in its conversation.'),
    ).toBeTruthy();
    expect(r.state.suggestions.find((s) => s.id === 's1')?.status).toBe('accepted');
    await userEvent.click(within(list).getByRole('button', { name: 'Dismiss: A meeting moved' }));
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Suggestions' })).toBeNull());
    expect(decided).toBe(2);
    expect(screen.getByText(/No open suggestions/)).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: 'All' }));
    const all = await screen.findByRole('list', { name: 'Suggestions' });
    expect(within(all).getByText('Accepted')).toBeTruthy();
    expect(within(all).getAllByText('Dismissed')).toHaveLength(2);
  });

  it('refreshes when a suggestion was already decided elsewhere', async () => {
    const r = await renderWithAgents(
      <AgentSuggestions agentId="ag1" version={0} onDecided={() => undefined} />,
      {
        agents: {
          agents: [agentView({ id: 'ag1' })],
          suggestions: [suggestionView({ id: 's1', agentId: 'ag1', title: 'Overdue' })],
        },
      },
    );
    await screen.findByRole('list', { name: 'Suggestions' });
    r.state.suggestions = r.state.suggestions.map((s) => ({ ...s, status: 'accepted' as const }));
    await userEvent.click(screen.getByRole('button', { name: 'Accept: Overdue' }));
    expect(
      await screen.findByText('Could not decide it: the suggestion was already decided'),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Suggestions' })).toBeNull());
  });
});
