// The approvals page for phones (FR-111, FR-077; docs/04 §2.6): every pending approval across
// conversations, each with where it comes from and the same six decisions as the card in its
// conversation; an answer from another device first shows as such; new ones arrive live; a focused
// approval comes first, or says it was already answered or is gone; empty and error states.
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { ApprovalsPage, orderApprovals, whereOf } from '../src/dispatch/ApprovalsPage.tsx';
import { approvalView } from './chat-m3-helpers.tsx';
import { FakeEventSource, createHub } from './fakes.ts';
import { renderWithPush } from './fakes-m7-push.ts';

afterEach(() => {
  cleanup();
  FakeEventSource.reset();
  window.history.replaceState(null, '', '/');
});

function hubWith(approvals: ApprovalView[]) {
  const hub = createHub();
  hub.state.m3.approvals = approvals;
  return hub;
}

const pending = () => [
  approvalView('t-run', {
    id: 'a-run',
    runId: 'run7',
    codeSessionId: null,
    threadTitle: 'Weekly report',
    action: 'Send the report by email',
    createdAt: '2026-10-01T10:00:00.000Z',
  }),
  approvalView('t-chat', {
    id: 'a-chat',
    runId: null,
    codeSessionId: null,
    threadTitle: 'Trip plans',
    action: 'Write notes/plan.md',
    createdAt: '2026-10-01T09:00:00.000Z',
  }),
  approvalView('t-code', {
    id: 'a-code',
    runId: null,
    codeSessionId: 'cs3',
    threadTitle: 'Fix login',
    action: 'Run npm test',
    tier: 'confirm_at_action',
    options: ['allow_once', 'deny_continue', 'deny_stop', 'handoff'],
    createdAt: '2026-10-01T11:00:00.000Z',
  }),
];

describe('Approvals', () => {
  it('lists every pending approval, oldest first, with where it comes from', async () => {
    await renderWithPush(<ApprovalsPage />, { hub: hubWith(pending()) });
    const list = await screen.findByRole('list', { name: 'Approvals' });
    const items = within(list).getAllByRole('listitem');
    await waitFor(() =>
      expect(within(items[0]!).getByRole('link').textContent).toBe('Chat: Trip plans'),
    );
    expect(items.map((li) => within(li).getByRole('link').textContent)).toEqual([
      'Chat: Trip plans',
      'Work run: Weekly report',
      'Code session: Fix login',
    ]);
    expect(within(items[0]!).getByRole('link').getAttribute('href')).toBe(
      '/chat/t-chat?approval=a-chat',
    );
    expect(within(items[1]!).getByRole('link').getAttribute('href')).toBe('/work/run7');
    expect(within(items[2]!).getByRole('link').getAttribute('href')).toBe('/code/cs3');
    expect(screen.getByText('3 approvals are waiting.')).toBeTruthy();
    // The same decisions as the card in the conversation (a confirm-at-action card has four).
    expect(
      within(items[0]!)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Allow once',
      'Allow for this session',
      'Always allow…',
      'Deny and continue…',
      'Deny and stop',
      'Hand off',
    ]);
    expect(within(items[2]!).getAllByRole('button')).toHaveLength(4);
  });

  it('answers from the page and keeps the outcome in view', async () => {
    const hub = hubWith(pending());
    await renderWithPush(<ApprovalsPage />, { hub });
    const list = await screen.findByRole('list', { name: 'Approvals' });
    const first = within(list).getAllByRole('listitem')[0]!;
    await userEvent.click(within(first).getByRole('button', { name: 'Allow once' }));
    expect(await within(first).findByText(/Allowed once/)).toBeTruthy();
    expect(hub.state.m3.approvals.find((a) => a.id === 'a-chat')).toMatchObject({
      status: 'decided',
      decision: 'allow_once',
    });
    expect(await screen.findByText('2 approvals are waiting.')).toBeTruthy();
    // A refetch keeps the card answered here.
    act(() => {
      FakeEventSource.for('/events').emit('approval.decided', { approvalId: 'a-chat' });
    });
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(within(screen.getAllByRole('listitem')[0]!).getByText(/Allowed once/)).toBeTruthy();
  });

  it('shows an answer from another device instead of an error', async () => {
    const hub = hubWith(pending());
    await renderWithPush(<ApprovalsPage />, { hub });
    const list = await screen.findByRole('list', { name: 'Approvals' });
    const first = within(list).getAllByRole('listitem')[0]!;
    hub.state.m3.approvals = hub.state.m3.approvals.map((a) =>
      a.id === 'a-chat' ? { ...a, status: 'decided', decision: 'deny_stop', decidedBy: 'user' } : a,
    );
    await userEvent.click(within(first).getByRole('button', { name: 'Allow once' }));
    expect(await within(first).findByText('(answered on another device)')).toBeTruthy();
    expect(within(first).queryByRole('alert')).toBeNull();
  });

  it('follows new approvals live', async () => {
    const hub = hubWith([]);
    await renderWithPush(<ApprovalsPage />, { hub });
    expect(await screen.findByRole('heading', { name: 'Nothing is waiting for you' })).toBeTruthy();
    hub.state.m3.approvals = [approvalView('t-chat', { id: 'a-new', action: 'Delete old.txt' })];
    act(() => {
      FakeEventSource.for('/events').emit('approval.requested', { approvalId: 'a-new' }, 't-chat');
    });
    expect(await screen.findByText('Delete old.txt')).toBeTruthy();
    expect(screen.getByText('1 approval is waiting.')).toBeTruthy();
    expect(screen.getByTestId('announcer').textContent).toContain('New approval: Delete old.txt.');
  });

  it('puts a focused approval first and focuses it', async () => {
    window.history.replaceState(null, '', '/approvals?focus=a-code');
    await renderWithPush(<ApprovalsPage />, { hub: hubWith(pending()) });
    const list = await screen.findByRole('list', { name: 'Approvals' });
    const first = within(list).getAllByRole('listitem')[0]!;
    expect(within(first).getByText('Run npm test')).toBeTruthy();
    expect(first.getAttribute('data-focused')).toBe('true');
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Approval needed'));
  });

  it('says when a focused approval was answered or is gone', async () => {
    const hub = hubWith([
      approvalView(null as unknown as string, {
        id: 'a-done',
        threadId: null,
        status: 'decided',
        decision: 'allow_once',
      }),
    ]);
    window.history.replaceState(null, '', '/approvals?focus=a-done');
    await renderWithPush(<ApprovalsPage />, { hub });
    expect(await screen.findByText('That approval was already answered.')).toBeTruthy();
    cleanup();
    window.history.replaceState(null, '', '/approvals?focus=nope');
    await renderWithPush(<ApprovalsPage />, { hub: hubWith([]) });
    expect(await screen.findByText('That approval no longer exists.')).toBeTruthy();
  });

  it('shows a focused approval with no conversation that the list did not have', async () => {
    const lone = approvalView('x', { id: 'a-lone', threadId: null, action: 'Read ~/.ssh' });
    const hub = hubWith([lone]);
    // The list loaded before it arrived.
    hub.api.listApprovals.mockResolvedValue({ items: [] });
    window.history.replaceState(null, '', '/approvals?focus=a-lone');
    await renderWithPush(<ApprovalsPage />, { hub });
    expect(await screen.findByText('Read ~/.ssh')).toBeTruthy();
    expect(screen.getByText('Not part of a conversation')).toBeTruthy();
  });

  it('retries a failed load', async () => {
    const hub = hubWith(pending());
    hub.state.failNext.listApprovals = new ApiError(500, {
      code: 'server_error',
      message: 'The Hub had a problem.',
      retryable: true,
    });
    await renderWithPush(<ApprovalsPage />, { hub });
    expect((await screen.findByRole('alert')).textContent).toContain('The Hub had a problem.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Approvals' })).toBeTruthy();
  });

  it('opens New task from the empty state', async () => {
    await renderWithPush(<ApprovalsPage />, { hub: hubWith([]) });
    await userEvent.click(await screen.findByRole('button', { name: 'Start a task' }));
    expect(await screen.findByRole('dialog', { name: 'New task' })).toBeTruthy();
  });
});

describe('approval helpers', () => {
  it('orders oldest first with the focused one on top, and names the place', () => {
    const [run, chat, code] = pending();
    expect(orderApprovals([run!, chat!, code!], null).map((a) => a.id)).toEqual([
      'a-chat',
      'a-run',
      'a-code',
    ]);
    expect(orderApprovals([run!, chat!, code!], 'a-code')[0]!.id).toBe('a-code');
    expect(whereOf({ ...chat!, threadId: null })).toEqual({
      icon: 'shield',
      text: 'Not part of a conversation',
      href: null,
    });
    // A deleted (or unnamed) conversation, or a Hub that does not say.
    expect(whereOf({ ...chat!, threadTitle: null })).toEqual({
      icon: 'chat',
      text: 'In a conversation',
      href: '/chat/t-chat?approval=a-chat',
    });
    expect(whereOf({ ...chat!, threadTitle: undefined }).text).toBe('In a conversation');
    expect(whereOf({ ...run!, threadTitle: '  ' })).toMatchObject({
      icon: 'work',
      text: 'Work run: Untitled',
      href: '/work/run7',
    });
  });
});
