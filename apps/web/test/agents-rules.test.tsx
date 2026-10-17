// An agent's custom rules (FR-084, FR-191; docs/12 §3): the four effects, scopes, a command prefix
// rule, the Hub's refusals shown next to the field they are about, turning a rule off, the preview
// of recent actions it would have matched, and deleting with a confirmation.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { AgentRules } from '../src/agents/AgentRules.tsx';
import { agentView, renderWithAgents, ruleView } from './fakes-m6-agents.ts';
import { resetDom } from './render.tsx';

afterEach(() => resetDom());

const AG = () => agentView({ id: 'ag1', name: 'Scout' });

describe('agent rules (FR-084)', () => {
  it('lists rules with their effect, scope, command and state', async () => {
    await renderWithAgents(<AgentRules agentId="ag1" version={0} />, {
      agents: {
        agents: [AG()],
        rules: [
          ruleView({ id: 'r1', agentId: 'ag1', priority: 50 }),
          ruleView({
            id: 'r2',
            agentId: 'ag1',
            description: 'Run git status freely',
            effect: 'act',
            match: { tools: ['exec.run'] },
            command: {
              pattern: ['git', ['status', 'diff']],
              matchExamples: ['git status'],
              notMatchExamples: ['git push'],
            },
            enabled: false,
            priority: 10,
          }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: 'Rules' });
    const rows = within(list).getAllByRole('listitem');
    // Ordered by priority.
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Run git status freely',
      'Ask before messaging customers',
    ]);
    const git = rows[0] as HTMLElement;
    expect(within(git).getByText('Take action without asking')).toBeTruthy();
    expect(within(git).getByText('Off')).toBeTruthy();
    expect(within(git).getByText('git status|diff')).toBeTruthy();
    const ask = rows[1] as HTMLElement;
    expect(within(ask).getByText('Ask before taking action')).toBeTruthy();
    expect(
      within(ask).getByText('Applies to: Sending messages · hosts: *.customer.com'),
    ).toBeTruthy();
  });

  it('adds a rule with scopes and a command prefix rule', async () => {
    const r = await renderWithAgents(<AgentRules agentId="ag1" version={0} />, {
      agents: { agents: [AG()] },
    });
    expect(await screen.findByText(/No rules\./)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    const form = screen.getByRole('form', { name: 'New rule' });
    await userEvent.type(within(form).getByRole('textbox', { name: 'Rule' }), 'Hand off payments');
    await userEvent.click(within(form).getByRole('radio', { name: 'Hand off to you' }));
    // A hand-off rule cannot carry a command prefix rule.
    expect(
      within(form).getByRole<HTMLInputElement>('checkbox', {
        name: 'Match commands the agent runs by how they start',
      }).disabled,
    ).toBe(true);
    await userEvent.click(within(form).getByRole('radio', { name: 'Ask before taking action' }));
    await userEvent.click(within(form).getByRole('checkbox', { name: 'Running commands' }));
    await userEvent.click(within(form).getByRole('checkbox', { name: 'Buys something' }));
    await userEvent.type(within(form).getByRole('textbox', { name: 'Tools' }), 'pay.*, exec.run');
    await userEvent.click(
      within(form).getByRole('checkbox', {
        name: 'Match commands the agent runs by how they start',
      }),
    );
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Command starts with' }),
      'stripe charge|refund',
    );
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Commands it should match' }),
      'stripe charge 10',
    );
    await userEvent.type(
      within(form).getByRole('textbox', { name: 'Commands it should not match' }),
      'stripe status',
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(r.state.rules).toHaveLength(1));
    expect(r.api.createAgentRule).toHaveBeenCalledWith('ag1', {
      description: 'Hand off payments',
      effect: 'ask',
      match: { actions: ['execute'], effects: ['purchase'], tools: ['pay.*', 'exec.run'] },
      command: {
        pattern: ['stripe', ['charge', 'refund']],
        matchExamples: ['stripe charge 10'],
        notMatchExamples: ['stripe status'],
      },
      priority: 100,
      enabled: true,
    });
    expect(await screen.findByRole('listitem', { name: 'Hand off payments' })).toBeTruthy();
  });

  it('checks fields itself and shows the Hub refusal by its field', async () => {
    const r = await renderWithAgents(<AgentRules agentId="ag1" version={0} />, {
      agents: { agents: [AG()] },
    });
    await screen.findByText(/No rules\./);
    await userEvent.click(screen.getByRole('button', { name: 'Add a rule' }));
    const form = screen.getByRole('form', { name: 'New rule' });
    await userEvent.click(within(form).getByRole('button', { name: 'Add rule' }));
    expect(within(form).getByText('Say what the rule does, in a few words.')).toBeTruthy();
    await userEvent.type(within(form).getByRole('textbox', { name: 'Rule' }), 'Customers');
    await userEvent.type(within(form).getByRole('textbox', { name: 'Hosts' }), 'bad host!');
    await userEvent.click(within(form).getByRole('button', { name: 'Add rule' }));
    expect(
      within(form).getByText('Use host names such as example.com or *.example.com.'),
    ).toBeTruthy();
    const hosts = within(form).getByRole('textbox', { name: 'Hosts' });
    await userEvent.clear(hosts);
    await userEvent.type(hosts, '*.customer.com');
    await userEvent.click(within(form).getByRole('button', { name: 'Add a channel' }));
    await userEvent.click(within(form).getByRole('button', { name: 'Add rule' }));
    expect(within(form).getByText('A rule names hosts or channels, not both.')).toBeTruthy();
    expect(r.api.createAgentRule).not.toHaveBeenCalled();
    // The Hub's own check, as when the client misses one: shown with the scope.
    await userEvent.click(within(form).getByRole('button', { name: 'Remove channel 1' }));
    r.agents.failNext.createAgentRule = new ApiError(400, {
      code: 'validation',
      message: 'a rule names hosts or channels, not both',
      retryable: false,
      details: { field: 'match', reason: 'hosts_and_channels' },
    });
    await userEvent.click(within(form).getByRole('button', { name: 'Add rule' }));
    expect(await within(form).findByText('a rule names hosts or channels, not both')).toBeTruthy();
    await userEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'New rule' })).toBeNull();
  });

  it('edits a rule, turns it off and on, and clears its command rule', async () => {
    const r = await renderWithAgents(<AgentRules agentId="ag1" version={0} />, {
      agents: {
        agents: [AG()],
        rules: [
          ruleView({
            id: 'r1',
            agentId: 'ag1',
            effect: 'act',
            command: {
              pattern: ['ls'],
              matchExamples: ['ls -la'],
              notMatchExamples: ['rm -rf'],
            },
          }),
        ],
      },
    });
    const row = await screen.findByRole('listitem', { name: 'Ask before messaging customers' });
    await userEvent.click(
      within(row).getByRole('switch', { name: 'Ask before messaging customers: on' }),
    );
    await waitFor(() => expect(r.state.rules[0]?.enabled).toBe(false));
    expect(await screen.findByText('Rule turned off.')).toBeTruthy();

    await userEvent.click(
      within(screen.getByRole('listitem', { name: 'Ask before messaging customers' })).getByRole(
        'button',
        { name: 'Edit Ask before messaging customers' },
      ),
    );
    const form = screen.getByRole('form', { name: 'Edit rule: Ask before messaging customers' });
    const desc = within(form).getByRole('textbox', { name: 'Rule' });
    await userEvent.clear(desc);
    await userEvent.type(desc, 'Ask before customer email');
    await userEvent.click(
      within(form).getByRole('checkbox', {
        name: 'Match commands the agent runs by how they start',
      }),
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(r.state.rules[0]?.description).toBe('Ask before customer email'));
    expect(r.state.rules[0]?.command).toBeNull();
    expect(r.api.updateAgentRule).toHaveBeenLastCalledWith(
      'ag1',
      'r1',
      expect.objectContaining({ command: null, enabled: false }),
    );
  });

  it('previews the recent actions a rule matches', async () => {
    await renderWithAgents(<AgentRules agentId="ag1" version={0} />, {
      agents: {
        agents: [AG()],
        rules: [
          ruleView({ id: 'r1', agentId: 'ag1' }),
          ruleView({ id: 'r2', agentId: 'ag1', description: 'Quiet rule' }),
        ],
        previews: {
          r1: [
            {
              callId: 'c1',
              threadId: 't1',
              tool: 'email.send',
              status: 'done',
              decision: 'ask',
              createdAt: '2026-10-01T10:00:00.000Z',
            },
          ],
        },
      },
    });
    const row = await screen.findByRole('listitem', { name: 'Ask before messaging customers' });
    await userEvent.click(
      within(row).getByRole('button', { name: 'Preview Ask before messaging customers' }),
    );
    expect(await within(row).findByText('email.send')).toBeTruthy();
    const quiet = screen.getByRole('listitem', { name: 'Quiet rule' });
    await userEvent.click(within(quiet).getByRole('button', { name: 'Preview Quiet rule' }));
    expect(
      await within(quiet).findByText("None of the agent's recent actions match this rule."),
    ).toBeTruthy();
  });

  it('deletes after a confirmation, and recovers from a load failure', async () => {
    const r = await renderWithAgents(<AgentRules agentId="ag1" version={0} />, {
      agents: { agents: [AG()], rules: [ruleView({ id: 'r1', agentId: 'ag1' })] },
      failNext: {
        listAgentRules: new ApiError(500, { code: 'x', message: 'Hub is busy', retryable: true }),
      },
    });
    expect(await screen.findByText('Hub is busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const row = await screen.findByRole('listitem', { name: 'Ask before messaging customers' });
    await userEvent.click(
      within(row).getByRole('button', { name: 'Delete Ask before messaging customers' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete this rule?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(r.state.rules).toHaveLength(0));
    expect(screen.queryByRole('list', { name: 'Rules' })).toBeNull();
  });
});
