// Approval cards in chat (docs/04 §2.6, docs/12 §4.1, FR-100, FR-189, FR-215): every decision
// path, the scope chooser, deny reason, hand-off, a 409 from another client, API failure,
// focus and announcements, the `?approval=` link, and Needs input in the header and list.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { message } from './fakes.ts';
import { announcer, approvalView, chatLog, openWith, waitingReply } from './chat-m3-helpers.tsx';
import { box } from './chat-helpers.tsx';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const sidebar = () => screen.getByRole('navigation', { name: 'Sidebar' });
const headerChip = () => document.querySelector('.chat-header .nv-chip')?.textContent ?? '';
const approvalCard = (name = 'Approval needed') => screen.findByRole('group', { name });
const decisionButtons = (card: HTMLElement) =>
  within(within(card).getByRole('group', { name: 'Decision' }))
    .getAllByRole('button')
    .map((b) => b.textContent);

async function openWaiting(over: Parameters<typeof approvalView>[1] = {}, opts = {}) {
  return openWith({
    thread: { state: 'waiting_approval' },
    messages: (tid) => [
      message(tid, { role: 'user', parts: [{ type: 'text', text: 'Write the plan' }] }),
      waitingReply(tid),
    ],
    m3: (tid) => ({ approvals: [approvalView(tid, over)] }),
    ...opts,
  });
}

describe('approval card (FR-100)', () => {
  it('shows the waiting approval inside its tool call with every fact and option', async () => {
    const { hub, t } = await openWaiting();
    const card = await approvalCard();
    const call = screen.getByRole('group', { name: 'Tool call: Write file' });
    expect(call.contains(card)).toBe(true);
    expect(call.textContent).toContain('Waiting for approval');
    const facts = card.querySelector('.approval-facts')!;
    expect(facts.textContent).toContain('Write notes/plan.md');
    expect(facts.textContent).toContain('fs.write');
    expect(facts.textContent).toContain('{"path":"notes/plan.md"}');
    expect(facts.textContent).toContain('Writing files asks first.');
    expect(facts.textContent).toContain('You asked for this');
    expect(facts.textContent).toContain('Pre-approvable');
    expect(facts.textContent).toContain('Medium');
    expect(facts.textContent).toContain('Tool default');
    expect(card.textContent).toMatch(/Expires in 2 h 30 min|Expires in 2 h 29 min/);
    expect(decisionButtons(card)).toEqual([
      'Allow once',
      'Allow for this session',
      'Always allow…',
      'Deny and continue…',
      'Deny and stop',
      'Hand off',
    ]);
    // Needs input in the header and the chat list (FR-215), and a note by the composer.
    expect(headerChip()).toBe('Needs input');
    expect(
      within(sidebar()).getByRole('link', { name: /Billing questions.*Needs input/ }),
    ).toBeTruthy();
    expect(screen.getByRole('note').textContent).toContain('An approval is waiting for you.');
    expect(hub.api.listApprovals).toHaveBeenCalledWith({ status: 'pending', threadId: t.id });
  });

  it('allows once, then shows the outcome and leaves Needs input', async () => {
    const { hub, t } = await openWaiting();
    const card = await approvalCard();
    await userEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    await waitFor(() =>
      expect(hub.api.decideApproval).toHaveBeenCalledWith({
        approvalId: 'ap1',
        decision: 'allow_once',
      }),
    );
    const outcome = await screen.findByText(/Approval: Allowed once/);
    expect(outcome.textContent).not.toContain('another device');
    expect(announcer()).toBe('Allowed once.');
    await waitFor(() => expect(headerChip()).toBe('Running'));
    expect(screen.queryByRole('note')).toBeNull();
    expect(hub.state.m3.approvals[0]!.status).toBe('decided');
    expect(t.id).toBeTruthy();
  });

  it.each([
    ['Allow for this session', 'allow_session', 'Allowed for this session'],
    ['Deny and stop', 'deny_stop', 'Denied and stopped'],
  ] as const)('%s sends %s', async (button, decision, outcome) => {
    const { hub } = await openWaiting();
    const card = await approvalCard();
    await userEvent.click(within(card).getByRole('button', { name: button }));
    await waitFor(() =>
      expect(hub.api.decideApproval).toHaveBeenCalledWith({ approvalId: 'ap1', decision }),
    );
    expect(await screen.findByText(new RegExp(`Approval: ${outcome}`))).toBeTruthy();
  });

  it('chooses an Always allow scope, showing a prefix rule and its examples first', async () => {
    const { hub } = await openWaiting();
    const card = await approvalCard();
    const always = within(card).getByRole('button', { name: 'Always allow…' });
    await userEvent.click(always);
    const form = within(card).getByRole('form', { name: 'Always allow' });
    const radios = within(form).getAllByRole('radio');
    expect(radios.map((r) => r.closest('label')?.textContent)).toEqual([
      'This tool (fs.write) in this project',
      'Commands starting with npm test',
      'Network host api.example.com',
    ]);
    await waitFor(() => expect(document.activeElement).toBe(radios[0]));
    // Escape goes back to the buttons with focus on the one that opened the chooser.
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(card).getByRole('button', { name: 'Always allow…' }),
      ),
    );
    expect(hub.api.cancel).not.toHaveBeenCalled();
    await userEvent.click(within(card).getByRole('button', { name: 'Always allow…' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Commands starting with npm test' }));
    const rule = within(card).getByRole('group', { name: 'Rule to add' });
    expect(rule.textContent).toContain('npm {test|t}');
    expect(rule.textContent).toContain('npm t -- --watch');
    expect(rule.textContent).toContain('npm publish');
    await userEvent.click(within(card).getByRole('button', { name: 'Always allow' }));
    await waitFor(() =>
      expect(hub.api.decideApproval).toHaveBeenCalledWith({
        approvalId: 'ap1',
        decision: 'allow_always',
        alwaysScope: {
          kind: 'prefix_rule',
          rule: {
            pattern: ['npm', ['test', 't']],
            matchExamples: ['npm test', 'npm t -- --watch'],
            notMatchExamples: ['npm publish'],
          },
        },
      }),
    );
    expect(await screen.findByText(/Approval: Always allowed/)).toBeTruthy();
  });

  it('sends a host scope without its label', async () => {
    const { hub } = await openWaiting();
    const card = await approvalCard();
    await userEvent.click(within(card).getByRole('button', { name: 'Always allow…' }));
    await userEvent.click(screen.getByRole('radio', { name: 'Network host api.example.com' }));
    expect(within(card).queryByRole('group', { name: 'Rule to add' })).toBeNull();
    await userEvent.click(within(card).getByRole('button', { name: 'Always allow' }));
    await waitFor(() =>
      expect(hub.api.decideApproval).toHaveBeenCalledWith({
        approvalId: 'ap1',
        decision: 'allow_always',
        alwaysScope: { kind: 'host', host: 'api.example.com' },
      }),
    );
  });

  it('denies and continues with an optional reason for the agent', async () => {
    const { hub } = await openWaiting();
    const card = await approvalCard();
    await userEvent.click(within(card).getByRole('button', { name: 'Deny and continue…' }));
    const reason = within(card).getByRole('textbox', { name: 'Reason (optional)' });
    await waitFor(() => expect(document.activeElement).toBe(reason));
    await userEvent.type(reason, '  Use the drafts folder instead.  ');
    await userEvent.click(within(card).getByRole('button', { name: 'Deny and continue' }));
    await waitFor(() =>
      expect(hub.api.decideApproval).toHaveBeenCalledWith({
        approvalId: 'ap1',
        decision: 'deny_continue',
        reason: 'Use the drafts folder instead.',
      }),
    );
    expect(await screen.findByText(/Approval: Denied/)).toBeTruthy();
  });

  it('denies and continues without a reason when none is given; Cancel goes back', async () => {
    const { hub } = await openWaiting();
    const card = await approvalCard();
    await userEvent.click(within(card).getByRole('button', { name: 'Deny and continue…' }));
    await userEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(card).getByRole('button', { name: 'Deny and continue…' }),
      ),
    );
    await userEvent.click(within(card).getByRole('button', { name: 'Deny and continue…' }));
    await userEvent.click(within(card).getByRole('button', { name: 'Deny and continue' }));
    await waitFor(() =>
      expect(hub.api.decideApproval).toHaveBeenCalledWith({
        approvalId: 'ap1',
        decision: 'deny_continue',
      }),
    );
  });

  it('offers only the tier decisions for confirm_at_action and says why', async () => {
    await openWaiting({
      tier: 'confirm_at_action',
      options: ['allow_once', 'deny_continue', 'deny_stop', 'handoff'],
      alwaysScopes: [],
    });
    const card = await approvalCard();
    expect(card.textContent).toContain('Asked every time; cannot be pre-approved');
    expect(decisionButtons(card)).toEqual([
      'Allow once',
      'Deny and continue…',
      'Deny and stop',
      'Hand off',
    ]);
  });

  it('hands off a handoff_required step and resumes when it is marked done', async () => {
    const { hub } = await openWaiting({
      tier: 'handoff_required',
      action: 'Change the account password',
      options: ['handoff', 'deny_continue', 'deny_stop'],
      alwaysScopes: [],
    });
    const card = await approvalCard('You need to do this step');
    expect(decisionButtons(card)).toEqual(['Deny and continue…', 'Deny and stop', 'Hand off']);
    await userEvent.click(within(card).getByRole('button', { name: 'Hand off' }));
    await waitFor(() =>
      expect(hub.api.decideApproval).toHaveBeenCalledWith({
        approvalId: 'ap1',
        decision: 'handoff',
      }),
    );
    const step = await approvalCard('Your step');
    expect(headerChip()).toBe('Needs input');
    expect(announcer()).toBe('Handed off. Do the step, then mark it done.');
    hub.state.failNext.handoffDone = new ApiError(503, {
      code: 'unavailable',
      message: 'Hub busy.',
      retryable: true,
    });
    await userEvent.click(within(step).getByRole('button', { name: 'Mark done' }));
    expect((await within(step).findByRole('alert')).textContent).toContain(
      'Could not mark it done: Hub busy.',
    );
    await userEvent.click(within(step).getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(hub.api.handoffDone).toHaveBeenCalledWith('ap1'));
    expect(await screen.findByText(/Approval: Handed off, marked done/)).toBeTruthy();
    await waitFor(() => expect(headerChip()).toBe('Running'));
  });

  it('refreshes quietly on a 409 when another client answered first', async () => {
    const { hub } = await openWaiting();
    const card = await approvalCard();
    hub.state.m3.approvals = hub.state.m3.approvals.map((a) => ({
      ...a,
      status: 'decided' as const,
      decision: 'deny_stop' as const,
      decidedBy: 'user',
    }));
    await userEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    const outcome = await screen.findByText(/Approval: Denied and stopped/);
    expect(outcome.textContent).toContain('answered on another device');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(hub.api.getApproval).toHaveBeenCalledWith('ap1');
  });

  it('keeps the card and says so when the answer cannot be sent', async () => {
    const { hub } = await openWaiting();
    const card = await approvalCard();
    hub.state.failNext.decideApproval = new ApiError(500, {
      code: 'server_error',
      message: 'Database locked.',
      retryable: true,
    });
    await userEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    expect((await within(card).findByRole('alert')).textContent).toContain(
      'Your answer was not sent: Database locked.',
    );
    expect(headerChip()).toBe('Needs input');
    await userEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    expect(await screen.findByText(/Approval: Allowed once/)).toBeTruthy();
  });

  it('shows an answer from another device as it arrives', async () => {
    const { t, es } = await openWaiting();
    await approvalCard();
    es.emit(
      'approval.decided',
      { approvalId: 'ap1', decision: 'allow_session', decidedBy: 'user', override: false },
      t.id,
    );
    const outcome = await screen.findByText(/Approval: Allowed for this session/);
    expect(outcome.textContent).toContain('answered on another device');
    expect(announcer()).toBe('Approval answered on another device: Allowed for this session.');
    await waitFor(() => expect(headerChip()).not.toBe('Needs input'));
  });

  it('labels an action that did not come from the user (FR-189)', async () => {
    await openWaiting({ userAsked: false, ruleId: 'rule-7', risk: null });
    const card = await approvalCard();
    expect(card.textContent).toContain('Not from your message');
    expect(card.textContent).toContain('rule-7');
    expect(card.textContent).not.toContain('Risk');
  });
});

describe('approval arriving live', () => {
  it('moves focus to the new card heading and announces it; Enter does not approve', async () => {
    const { hub, t, es } = await openWith({
      messages: (tid) => [waitingReply(tid, { parts: [{ type: 'text', text: 'Working.' }] })],
    });
    hub.state.m3.approvals = [approvalView(t.id)];
    es.emit(
      'tool.call.started',
      { callId: 'call1', tool: 'fs.write', source: 'builtin', argsPreview: '{}' },
      t.id,
    );
    es.emit(
      'approval.requested',
      {
        approvalId: 'ap1',
        action: 'Write notes/plan.md',
        reason: 'Writing files asks first.',
        scope: 'call',
        risk: 'medium',
        tier: 'pre_approvable',
      },
      t.id,
    );
    const heading = await screen.findByRole('heading', { name: 'Approval needed' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(announcer()).toBe('Approval needed: Write notes/plan.md.');
    const call = screen.getByRole('group', { name: 'Tool call: fs.write' });
    expect(call.contains(heading)).toBe(true);
    expect(call.textContent).toContain('Waiting for approval');
    await waitFor(() => expect(headerChip()).toBe('Needs input'));
    await userEvent.keyboard('{Enter}');
    expect(hub.api.decideApproval).not.toHaveBeenCalled();
  });

  it('does not pull focus out of a message being typed, and finds the card from the note', async () => {
    const { hub, t, es } = await openWith();
    hub.state.m3.approvals = [approvalView(t.id, { callId: null })];
    await userEvent.type(box(), 'half a thought');
    es.emit('approval.requested', { approvalId: 'ap1', action: 'Send the invoice' }, t.id);
    const heading = await screen.findByRole('heading', { name: 'Approval needed' });
    expect(document.activeElement).toBe(box());
    expect(announcer()).toBe(
      'Approval needed: Send the invoice. It is in the chat, above the message box.',
    );
    // A card with no call on screen sits at the end of the log.
    expect(chatLog().querySelector('.approval-orphans')?.contains(heading)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Go to it' }));
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('lists the approvals again when a refetch says the chat waits but none are known', async () => {
    const { hub, t, es } = await openWith();
    hub.state.m3.approvals = [approvalView(t.id, { callId: null })];
    hub.state.threads = hub.state.threads.map((x) => ({ ...x, state: 'waiting_approval' }));
    es.emit('chat.message.updated', { threadId: t.id, messageId: 'm1', reason: 'x' }, t.id);
    expect(await approvalCard()).toBeTruthy();
    expect(hub.api.listApprovals).toHaveBeenCalledTimes(2);
  });

  it('maps thread.status.changed onto the chat status', async () => {
    const { t, es } = await openWith();
    es.emit(
      'thread.status.changed',
      { ref: { kind: 'thread', id: t.id }, from: 'ready', status: 'needs_input' },
      t.id,
    );
    await waitFor(() => expect(headerChip()).toBe('Needs input'));
    expect(
      within(sidebar()).getByRole('link', { name: /Billing questions.*Needs input/ }),
    ).toBeTruthy();
    es.emit(
      'thread.status.changed',
      { ref: { kind: 'thread', id: t.id }, from: 'needs_input', status: 'blocked' },
      t.id,
    );
    await waitFor(() => expect(headerChip()).toBe('Blocked'));
    // Another thread's status is not ours.
    es.emit(
      'thread.status.changed',
      { ref: { kind: 'thread', id: 'other' }, from: 'blocked', status: 'ready' },
      t.id,
    );
    expect(headerChip()).toBe('Blocked');
  });
});

describe('approval links (?approval=)', () => {
  it('scrolls to and focuses the linked card', async () => {
    await openWaiting({}, { path: (tid: string) => `/chat/${tid}?approval=ap1` });
    const heading = await screen.findByRole('heading', { name: 'Approval needed' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('fetches a linked approval the list did not return, and opens the right chat', async () => {
    const { hub, t } = await openWith({
      path: (tid) => `/chat/${tid}?approval=ap9`,
      m3: () => ({ approvals: [] }),
    });
    hub.state.m3.approvals = [approvalView('other-thread', { id: 'ap9' })];
    await waitFor(() => expect(hub.api.getApproval).toHaveBeenCalledWith('ap9'));
    await waitFor(() => expect(window.location.pathname).toBe('/chat/other-thread'));
    expect(window.location.search).toBe('?approval=ap9');
    expect(t.id).not.toBe('other-thread');
  });

  it('says so when the linked approval was already answered or is gone', async () => {
    const { hub, t } = await openWith({
      path: (tid) => `/chat/${tid}?approval=ap1`,
      m3: (tid) => ({
        approvals: [approvalView(tid, { status: 'decided', decision: 'allow_once' })],
      }),
    });
    expect(await screen.findByText('That approval was already answered.')).toBeTruthy();
    expect(t.id).toBeTruthy();
    expect(hub.api.getApproval).toHaveBeenCalledWith('ap1');
  });

  it('reports a link to an approval that does not exist', async () => {
    await openWith({ path: (tid) => `/chat/${tid}?approval=nope` });
    expect(await screen.findByText('That approval no longer exists.')).toBeTruthy();
  });

  it('shows a linked pending approval fetched by id', async () => {
    const { hub, t } = await openWith({ path: (tid) => `/chat/${tid}?approval=ap5` });
    // Not in the first listing (created after it), but pending when fetched.
    hub.state.m3.approvals = [approvalView(t.id, { id: 'ap5', callId: null })];
    const heading = await screen.findByRole('heading', { name: 'Approval needed' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('resolves /approvals/<id> to the chat that waits on it', async () => {
    const { hub, t } = await openWaiting({}, { path: () => '/approvals/ap1' });
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${t.id}`));
    expect(window.location.search).toBe('?approval=ap1');
    const heading = await screen.findByRole('heading', { name: 'Approval needed' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(hub.api.getApproval).toHaveBeenCalledWith('ap1');
  });

  it('falls back to the chat list for an unknown /approvals/<id>', async () => {
    const { hub } = await renderApp({ path: '/approvals/missing' });
    await waitFor(() => expect(window.location.pathname).toBe('/chat'));
    expect(hub.api.getApproval).toHaveBeenCalledWith('missing');
  });
});
