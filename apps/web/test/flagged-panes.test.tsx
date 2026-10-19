// The flagged panes of a Code session (FR-202, FR-203): script runs with each nested call's status
// and the policy gate's decision, why a script stopped, live refresh; delegations to an external
// agent (delegate, the coalesced live activity, the reply as text, stop after asking, the Hub's
// refusals in plain words). While a feature is off its pane says where to turn it on.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { DelegationsPane, activityLines, mergeLines } from '../src/flagged/DelegationsPane.tsx';
import { ScriptRuns } from '../src/flagged/ScriptRuns.tsx';
import { decisionText, scriptErrorText, stopReasonText } from '../src/flagged/format.ts';
import { FakeEventSource } from './fakes.ts';
import { codeSession } from './fakes-m5-code.ts';
import {
  adapterView,
  delegationView,
  renderWithWork,
  scriptRun,
  type M7WorkState,
} from './fakes-m7-work.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const stream = () => FakeEventSource.for('/api/v1/events/stream');
const session = codeSession({ id: 'cs1', threadId: 't-cs1' });

describe('script runs (FR-202)', () => {
  it('says where to turn them on while they are off', async () => {
    const { api } = await renderWithWork(<ScriptRuns threadId="t-cs1" />, { sessions: [session] });
    expect(screen.getByRole('heading', { name: 'Scripted tool calls are off' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Settings → Experimental' }).getAttribute('href')).toBe(
      '/settings/experimental',
    );
    expect(api.listScriptRuns).not.toHaveBeenCalled();
  });

  it('lists runs and shows each nested call with the gate’s decision', async () => {
    const { state } = await renderWithWork(<ScriptRuns threadId="t-cs1" />, {
      sessions: [session],
      settings: { 'scripts.enabled': true },
      work: {
        scriptRuns: [
          scriptRun({ id: 'sr1', threadId: 't-cs1', createdAt: '2026-10-01T12:00:00.000Z' }),
          scriptRun({ id: 'sr0', threadId: 't-other' }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: 'Script runs' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('2 tool calls')).toBeTruthy();
    expect(within(list).getByText('140 ms of script time')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: /Script run/ }));
    const calls = await screen.findByRole('list', { name: 'Nested tool calls' });
    const items = within(calls).getAllByRole('listitem');
    expect(items[0]!.textContent).toMatch(/fs\.read.*Done.*Allowed by policy/);
    expect(items[1]!.textContent).toMatch(/fs\.write.*Denied.*Denied by policy/);

    state.scriptRuns = [
      scriptRun({
        id: 'sr2',
        threadId: 't-cs1',
        status: 'error',
        errorCode: 'cpu_limit',
        nested: [],
      }),
      ...state.scriptRuns,
    ];
    stream().emit('tool.call.completed', { tool: 'script.run', callId: 'sr2' }, 't-cs1');
    expect(await screen.findByText('It used up its time limit.')).toBeTruthy();
  });

  it('shows the Hub saying the feature is off, and the empty state', async () => {
    const r = await renderWithWork(<ScriptRuns threadId="t-cs1" />, {
      sessions: [session],
      settings: { 'scripts.enabled': true },
    });
    expect(await screen.findByText('No script runs yet')).toBeTruthy();
    r.hub.state.settings = { ...r.hub.state.settings };
    r.work.failNext.listScriptRuns = new (await import('../src/api.ts')).ApiError(404, {
      code: 'not_found',
      message: 'scripted tool calls are turned off',
      retryable: false,
    });
    stream().emit('tool.call.completed', { tool: 'script.run' }, 't-cs1');
    // The list stays; a later reload works again.
    await waitFor(() => expect(r.api.listScriptRuns).toHaveBeenCalledTimes(2));
  });
});

describe('delegations (FR-203)', () => {
  async function open(work: Partial<M7WorkState> = {}) {
    const r = await renderWithWork(<DelegationsPane sessionId="cs1" threadId="t-cs1" />, {
      sessions: [session],
      settings: { 'externalAgents.enabled': true },
      work: { adapters: [adapterView({ id: 'ad1', name: 'Coder' })], ...work },
    });
    return r;
  }

  it('says where to turn them on while off', async () => {
    await renderWithWork(<DelegationsPane sessionId="cs1" threadId="t-cs1" />, {
      sessions: [session],
    });
    expect(screen.getByRole('heading', { name: 'External coding agents are off' })).toBeTruthy();
  });

  it('delegates, streams the coalesced activity, and stops the agent after asking', async () => {
    const { api, state } = await open();
    expect(await screen.findByText('No external agents have worked here')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Delegate…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delegate to an external agent' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delegate' }));
    expect(within(dialog).getByText('Describe the task for the agent.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('The task'), 'Fix the flaky test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delegate' }));
    await waitFor(() =>
      expect(api.startDelegation).toHaveBeenCalledWith('cs1', {
        adapterId: 'ad1',
        prompt: 'Fix the flaky test',
      }),
    );
    const id = state.delegations[0]!.id;
    expect(await screen.findByRole('listitem', { name: 'Coder, Starting' })).toBeTruthy();
    // A second agent cannot start while one works.
    expect(screen.getByRole('button', { name: 'Delegate…' })).toHaveProperty('disabled', true);

    stream().emit(
      'delegation.updated',
      {
        delegationId: id,
        thought: 'Reading ',
        message: 'I will ',
        toolCalls: [{ title: 'Read src/a.ts', status: 'completed' }],
      },
      't-cs1',
    );
    stream().emit(
      'delegation.updated',
      { delegationId: id, message: 'fix it.', droppedToolCalls: 4, plan: true },
      't-cs1',
    );
    const activity = await screen.findByRole('list', { name: 'What the agent is doing' });
    expect(
      within(activity)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Thought Reading ',
      'Said I will ',
      'Tool Read src/a.ts (completed)',
      'Said fix it.',
      'Tool 4 more tool calls, not shown',
      'Plan Updated its plan',
    ]);

    await userEvent.click(screen.getByRole('button', { name: 'Stop…' }));
    const confirm = screen.getByRole('dialog', { name: 'Stop the external agent?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Stop agent' }));
    await waitFor(() => expect(api.cancelDelegation).toHaveBeenCalledWith(id));
    expect(await screen.findByRole('listitem', { name: 'Coder, Cancelled' })).toBeTruthy();
  });

  it('shows a finished delegation’s reply as text and a failure in plain words', async () => {
    await open({
      delegations: [
        delegationView({
          id: 'd1',
          threadId: 't-cs1',
          output: '<img src=x onerror=alert(1)> Done.',
        }),
        delegationView({
          id: 'd2',
          threadId: 't-cs1',
          status: 'failed',
          output: null,
          agent: null,
          adapterName: 'Coder',
          error:
            "this session's sandbox cannot hold an agent to its declared hosts, so the agent cannot have network there",
          stopReason: null,
        }),
      ],
    });
    const done = await screen.findByRole('listitem', { name: 'coder 1.2, Finished' });
    expect(within(done).getByLabelText('The agent’s reply').textContent).toBe(
      '<img src=x onerror=alert(1)> Done.',
    );
    expect(done.querySelector('img')).toBeNull();
    const failed = screen.getByRole('listitem', { name: 'Coder, Failed' });
    expect(within(failed).getByRole('note').textContent).toMatch(
      /declares hosts it may reach, but this session’s sandbox/,
    );
  });

  it('explains the Hub refusing a delegation, and an empty adapter list', async () => {
    const { work } = await open({
      adapters: [adapterView({ id: 'ad1', name: 'Coder', enabled: false })],
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Delegate…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delegate to an external agent' });
    expect(await within(dialog).findByText(/No adapter is ready/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    work.state.adapters = [adapterView({ id: 'ad1', name: 'Coder' })];
    work.failNext.startDelegation = new (await import('../src/api.ts')).ApiError(503, {
      code: 'sandbox_unavailable',
      message: 'no sandbox',
      retryable: false,
      details: { reason: 'no_substrate' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Delegate…' }));
    const again = await screen.findByRole('dialog', { name: 'Delegate to an external agent' });
    await userEvent.type(await within(again).findByLabelText('The task'), 'Go');
    await userEvent.click(within(again).getByRole('button', { name: 'Delegate' }));
    expect((await within(again).findByRole('alert')).textContent).toMatch(
      /runs on an SSH host, in WSL or on a device, where commands have no sandbox/,
    );
  });
});

describe('units', () => {
  it('reads coalesced activity and words', () => {
    expect(activityLines({ delegationId: 'd' })).toEqual([]);
    expect(activityLines({ toolCalls: [{}], droppedToolCalls: 1 })).toEqual([
      { kind: 'tool_call', text: 'A tool call' },
      { kind: 'tool_call', text: '1 more tool call, not shown' },
    ]);
    const many = Array.from({ length: 250 }, (_, i) => ({
      kind: 'tool_call' as const,
      text: String(i),
    }));
    expect(mergeLines([], many)).toHaveLength(200);
    expect(decisionText(null)).toBe('Not decided yet');
    expect(decisionText('handoff')).toBe('Handed to you');
    expect(decisionText('custom_thing')).toBe('custom thing');
    expect(scriptErrorText('call_limit')).toBe('It made more tool calls than a script may.');
    expect(scriptErrorText('weird_stop')).toBe('It stopped: weird stop.');
    expect(stopReasonText('end_turn')).toBeNull();
    expect(stopReasonText('max_tokens')).toBe('It ran out of output tokens.');
  });
});
