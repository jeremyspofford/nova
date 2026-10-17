// Run and question cards in a chat (FR-186, FR-188; docs/04 §2.2.1): a `work.start` call becomes
// an inline run card (propose, start, progress, result); a `user.ask` call becomes a question card
// answered through the server request it belongs to.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ToolCallPartView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { chatLog, openWith, toolPart } from './chat-m3-helpers.tsx';
import { FakeEventSource, message } from './fakes.ts';
import { m5WorkState, planSteps, requestView, runView, type M5WorkState } from './fakes-m5-work.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const workStream = () => {
  const s = FakeEventSource.all.find((x) => !x.closed && x.listeners.has('run.status.changed'));
  if (!s) throw new Error('no work stream');
  return s;
};

/** Open a chat whose reply made one tool call, with the Work state built for that chat. */
async function chatWithCall(
  call: Partial<ToolCallPartView>,
  work: (tid: string) => Partial<M5WorkState>,
) {
  const r = await openWith({
    messages: (tid) => [
      message(tid, {
        role: 'user',
        parts: [{ type: 'text', text: 'Reconcile Q3 and draft a memo' }],
      }),
      message(tid, { role: 'assistant', parts: [toolPart(call)] }),
    ],
    before: (hub, tid) => {
      Object.assign(hub.state.m5work, m5WorkState(work(tid)));
    },
  });
  await screen.findAllByText('Reconcile Q3 and draft a memo');
  return r;
}

const escalateCall = (over: Partial<ToolCallPartView> = {}): Partial<ToolCallPartView> => ({
  callId: 'call-run',
  tool: 'work.start',
  title: 'Start a Work run',
  status: 'ok',
  argsPreview: JSON.stringify({
    objective: 'Reconcile Q3 and draft a memo',
    plan: ['Find Q3 invoices', 'Reconcile totals', 'Draft a memo'],
  }),
  resultPreview: JSON.stringify({ runId: 'esc1', status: 'planning' }),
  ...over,
});

describe('run card (FR-186)', () => {
  it('proposes the run with its plan and budget, starts it, follows it and shows the result', async () => {
    const { hub } = await chatWithCall(escalateCall(), (tid) => ({
      runs: [
        runView({
          id: 'esc1',
          title: 'Reconcile Q3',
          status: 'planning',
          origin: 'chat_escalation',
          originRef: tid,
          budgets: { timeSeconds: 3600, tokens: 2_000_000, costUsd: null },
        }),
      ],
    }));
    const card = await within(chatLog()).findByRole('group', { name: 'Work run: Reconcile Q3' });
    expect(within(card).getByText('This needs several steps. Run it as a Work run?')).toBeTruthy();
    expect(
      within(within(card).getByRole('list', { name: 'Plan' }))
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Find Q3 invoices', 'Reconcile totals', 'Draft a memo']);
    expect(within(card).getByText('Budget: 1 h · 2M tokens · provider spend cap')).toBeTruthy();
    expect(within(chatLog()).queryByRole('group', { name: /Tool call/ })).toBeNull();

    await userEvent.click(within(card).getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(hub.api.startRun).toHaveBeenCalledWith('esc1'));
    expect(await within(card).findByRole('status')).toBeTruthy();
    expect(within(card).getByRole('status').textContent).toBe('Running · 0 min · 0 tokens');

    // Live progress from the shared stream.
    const run = hub.state.m5work.runs[0]!;
    hub.state.m5work.runs = [
      {
        ...run,
        plan: planSteps(['Find Q3 invoices', 'Reconcile totals', 'Draft a memo'], (i) =>
          i === 0 ? 'done' : i === 1 ? 'running' : 'pending',
        ),
      },
    ];
    workStream().emit('run.step.started', {
      runId: 'esc1',
      stepId: 's2',
      idx: 1,
      title: 'Reconcile totals',
    });
    await waitFor(() =>
      expect(within(card).getByRole('status').textContent).toBe(
        'Running · step 2 of 3 · 0 min · 0 tokens',
      ),
    );
    workStream().emit('run.budget.usage', {
      runId: 'esc1',
      usage: { tokens: 300_000, timeSeconds: 720, costUsd: 0 },
    });
    await waitFor(() =>
      expect(within(card).getByRole('status').textContent).toBe(
        'Running · step 2 of 3 · 12 min · 0.3M tokens',
      ),
    );

    hub.state.m5work.runs = [
      {
        ...hub.state.m5work.runs[0]!,
        status: 'done',
        derived: { status: 'ready', reason: null },
        result: { summary: 'Totals match. Memo **drafted**.', artifactIds: [], evidence: [] },
      },
    ];
    workStream().emit('run.completed', {
      runId: 'esc1',
      status: 'done',
      resultSummary: 'x',
      outputVerified: true,
    });
    expect(await within(card).findByText('drafted')).toBeTruthy();
    expect(within(card).getByRole('status').textContent).toBe('Done.');
    await userEvent.click(within(card).getByRole('link', { name: 'Open in Work: Reconcile Q3' }));
    expect(window.location.pathname).toBe('/work/esc1');
  });

  it('dismisses a proposed run, and stops a running one', async () => {
    const { hub } = await chatWithCall(escalateCall(), (tid) => ({
      runs: [
        runView({
          id: 'esc1',
          title: 'Reconcile Q3',
          status: 'planning',
          origin: 'chat_escalation',
          originRef: tid,
        }),
      ],
    }));
    const card = await within(chatLog()).findByRole('group', { name: 'Work run: Reconcile Q3' });
    await userEvent.click(within(card).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(hub.api.controlRun).toHaveBeenCalledWith('esc1', 'cancel'));
    expect(await within(card).findByText('Dismissed. The run did not start.')).toBeTruthy();
  });

  it('stops a running run from the card', async () => {
    const { hub } = await chatWithCall(escalateCall(), (tid) => ({
      runs: [
        runView({ id: 'esc1', title: 'Reconcile Q3', origin: 'chat_escalation', originRef: tid }),
      ],
    }));
    const card = await within(chatLog()).findByRole('group', { name: 'Work run: Reconcile Q3' });
    hub.state.failNext.controlRun = new Error('Hub busy');
    await userEvent.click(await within(card).findByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Could not stop the run: Hub busy')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Stop' }));
    expect(await within(card).findByText('Cancelled.')).toBeTruthy();
  });

  it('finds the run by the chat while the call has no result yet', async () => {
    await chatWithCall(escalateCall({ status: 'running', resultPreview: null }), (tid) => ({
      runs: [
        runView({
          id: 'old',
          title: 'Older run',
          origin: 'chat_escalation',
          originRef: tid,
          objective: 'Something else',
          createdAt: '2026-09-01T00:00:00.000Z',
        }),
        runView({
          id: 'esc2',
          title: 'Reconcile Q3',
          origin: 'chat_escalation',
          originRef: tid,
          objective: 'Reconcile Q3 and draft a memo',
        }),
        runView({
          id: 'elsewhere',
          title: 'Other chat',
          origin: 'chat_escalation',
          originRef: 'other',
        }),
      ],
    }));
    const card = await within(chatLog()).findByRole('group', { name: 'Work run: Reconcile Q3' });
    expect(
      within(card).getByRole('link', { name: 'Open in Work: Reconcile Q3' }).getAttribute('href'),
    ).toBe('/work/esc2');
  });

  it('binds to the run once it is created, while the call is still running', async () => {
    const { hub, t } = await chatWithCall(
      escalateCall({ status: 'running', resultPreview: null }),
      () => ({ runs: [] }),
    );
    const card = await within(chatLog()).findByRole('group', {
      name: 'Work run: Reconcile Q3 and draft a memo',
    });
    expect(within(card).getByText('Preparing a Work run…')).toBeTruthy();
    hub.state.m5work.runs = [
      runView({
        id: 'esc3',
        title: 'Reconcile Q3',
        origin: 'chat_escalation',
        originRef: t.id,
        objective: 'Reconcile Q3 and draft a memo',
      }),
    ];
    workStream().emit('run.created', {
      runId: 'esc3',
      title: 'Reconcile Q3',
      origin: 'chat_escalation',
    });
    expect(
      await within(chatLog()).findByRole('group', { name: 'Work run: Reconcile Q3' }),
    ).toBeTruthy();
  });

  it('keeps the tool card when the call failed, and says when the run cannot load', async () => {
    await chatWithCall(
      escalateCall({ status: 'denied', resultPreview: 'Escalation is off' }),
      () => ({}),
    );
    expect(
      within(chatLog()).getByRole('group', { name: 'Tool call: Start a Work run' }),
    ).toBeTruthy();
    resetDom();

    const { hub } = await chatWithCall(escalateCall(), () => ({ runs: [] }));
    const card = await within(chatLog()).findByRole('group', { name: /Work run/ });
    expect(await within(card).findByText('Not found')).toBeTruthy();
    hub.state.m5work.runs = [runView({ id: 'esc1', title: 'Reconcile Q3', status: 'planning' })];
    await userEvent.click(within(card).getByRole('button', { name: 'Retry' }));
    expect(await within(card).findByRole('button', { name: 'Start run' })).toBeTruthy();
  });
});

const askCall = (over: Partial<ToolCallPartView> = {}): Partial<ToolCallPartView> => ({
  callId: 'call-ask',
  tool: 'user.ask',
  title: 'Ask the user',
  status: 'running',
  argsPreview: JSON.stringify({ question: 'Which quarter?', choices: ['Q3', 'Q4'] }),
  resultPreview: null,
  ...over,
});

describe('question card (FR-188)', () => {
  it('answers with a choice through the request, and shows the answer', async () => {
    const { hub } = await chatWithCall(askCall(), (tid) => ({
      requests: [
        requestView({
          id: 'req1',
          correlation: { threadId: tid, callId: 'call-ask' },
          payload: { question: 'Which quarter should I reconcile?', choices: ['Q3', 'Q4'] },
        }),
      ],
    }));
    const card = await within(chatLog()).findByRole('group', {
      name: 'Question from the assistant: Which quarter should I reconcile?',
    });
    const choices = await within(card).findByRole('group', { name: 'Choices' });
    expect(within(card).getByRole('textbox', { name: 'Your answer' })).toBeTruthy();
    await userEvent.click(within(choices).getByRole('button', { name: 'Q4' }));
    await waitFor(() =>
      expect(hub.api.respondRequest).toHaveBeenCalledWith('req1', { choice: 'Q4' }),
    );
    expect(await within(card).findByText('Q4')).toBeTruthy();
    expect(within(card).getByText(/Answered:/)).toBeTruthy();
    expect(within(card).queryByRole('group', { name: 'Choices' })).toBeNull();
    expect(screen.getByTestId('announcer').textContent).toContain('Answer sent.');
  });

  it('answers in words, and says when another device answered first', async () => {
    const { hub } = await chatWithCall(
      askCall({ argsPreview: JSON.stringify({ question: 'What should the memo say?' }) }),
      (tid) => ({
        requests: [
          requestView({
            id: 'req2',
            correlation: { threadId: tid, callId: 'call-ask' },
            payload: { question: 'What should the memo say?', multiline: true },
          }),
        ],
      }),
    );
    const card = await within(chatLog()).findByRole('group', {
      name: /What should the memo say\?/,
    });
    const box = await within(card).findByRole('textbox', { name: 'Your answer' });
    expect(box.tagName).toBe('TEXTAREA');
    expect(within(card).queryByRole('group', { name: 'Choices' })).toBeNull();
    const send = within(card).getByRole<HTMLButtonElement>('button', { name: 'Send answer' });
    expect(send.disabled).toBe(true);
    await userEvent.type(box, 'Totals match');
    // Another device answers before this one does.
    hub.state.m5work.requests = hub.state.m5work.requests.map((r) => ({
      ...r,
      status: 'resolved' as const,
      resolution: { by: 'user', at: '2026-10-01T12:00:00.000Z', result: { text: 'Use the draft' } },
    }));
    await userEvent.click(send);
    expect(
      await within(card).findByText('This question was already answered on another device.'),
    ).toBeTruthy();
    expect(await within(card).findByText('Use the draft')).toBeTruthy();
  });

  it('loads a question that arrives later, and shows an expired one', async () => {
    const { hub, t } = await chatWithCall(askCall(), () => ({ requests: [] }));
    const card = await within(chatLog()).findByRole('group', { name: /Which quarter\?/ });
    expect(await within(card).findByText('Waiting for the question…')).toBeTruthy();
    hub.state.m5work.requests = [
      requestView({
        id: 'req3',
        correlation: { threadId: t.id, callId: 'call-ask' },
        payload: { question: 'Which quarter?', choices: ['Q3'] },
      }),
    ];
    workStream().emit('request.created', {
      requestId: 'req3',
      kind: 'user_input',
      correlation: { callId: 'call-ask' },
      payload: {},
      expiresAt: '',
    });
    expect(await within(card).findByRole('button', { name: 'Q3' })).toBeTruthy();
    hub.state.failNext.respondRequest = new ApiError(410, {
      code: 'request_expired',
      message: 'Expired',
      retryable: false,
    });
    hub.state.m5work.requests = hub.state.m5work.requests.map((r) => ({
      ...r,
      status: 'expired' as const,
    }));
    await userEvent.click(within(card).getByRole('button', { name: 'Q3' }));
    expect(
      await within(card).findByText('This question expired before your answer arrived.'),
    ).toBeTruthy();
    expect(await within(card).findByText('This question expired without an answer.')).toBeTruthy();
  });

  it('shows the recorded answer of a finished call', async () => {
    await chatWithCall(askCall({ tool: 'ask_user', status: 'ok', resultPreview: 'Q3' }), () => ({
      requests: [],
    }));
    const card = await within(chatLog()).findByRole('group', { name: /Which quarter\?/ });
    expect(await within(card).findByText('Q3')).toBeTruthy();
    expect(within(card).getByText(/Answered:/)).toBeTruthy();
  });
});
