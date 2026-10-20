// Approvals and New task in the pseudo-locale (FR-016): every word the dispatch area owns comes
// from messages. The approval cards themselves are the chat area's (skipped); thread titles, project
// names and folder paths are fixture data.
import { cleanup, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalView } from '@nova/shared';
import { APPROVALS_TEXT, ApprovalsPage } from '../src/dispatch/ApprovalsPage.tsx';
import { NEW_TASK_TEXT, NewTaskSheet } from '../src/dispatch/NewTaskSheet.tsx';
import { approvalView } from './chat-m3-helpers.tsx';
import { FakeEventSource, createHub } from './fakes.ts';
import { folder } from './fakes-m4-settings.ts';
import { renderWithPush } from './fakes-m7-push.ts';
import { project } from './fakes-workspace.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';

afterEach(() => {
  cleanup();
  FakeEventSource.reset();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

const TITLES = ['Weekly report', 'Trip plans', 'Fix login'];

function hubWith(approvals: ApprovalView[]) {
  const hub = createHub();
  hub.state.m3.approvals = approvals;
  return hub;
}

const pending = () => [
  approvalView('t-run', { id: 'a-run', runId: 'run7', threadTitle: 'Weekly report' }),
  approvalView('t-chat', {
    id: 'a-chat',
    runId: null,
    codeSessionId: null,
    threadTitle: 'Trip plans',
  }),
  approvalView('t-code', {
    id: 'a-code',
    runId: null,
    codeSessionId: 'cs3',
    threadTitle: 'Fix login',
  }),
  approvalView('t-none', { id: 'a-none', runId: null, codeSessionId: null, threadTitle: null }),
];

describe('dispatch in a pseudo-locale', () => {
  it('shows the Approvals page localized in en-XA', async () => {
    await activateTestLocale('en-XA');
    await renderWithPush(<ApprovalsPage />, { hub: hubWith(pending()) });
    const list = await screen.findByRole('list', { name: APPROVALS_TEXT.title });
    expect(APPROVALS_TEXT.title).toMatch(/^\[/);
    const page = list.closest('.dispatch-page')!;
    await screen.findByText(APPROVALS_TEXT.waiting({ n: 4 }));
    expectFullyLocalized(page, { skip: ['.approval'], data: TITLES });
    expect(
      within(list)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toContain(APPROVALS_TEXT.where.run({ title: 'Weekly report' }));
    expect(screen.getByText(APPROVALS_TEXT.where.conversation)).toBeTruthy();
  });

  it('shows the empty Approvals page localized in en-XA', async () => {
    await activateTestLocale('en-XA');
    await renderWithPush(<ApprovalsPage />, { hub: hubWith([]) });
    const empty = await screen.findByText(APPROVALS_TEXT.emptyTitle);
    expectFullyLocalized(empty.closest('.dispatch-page')!);
  });

  it('shows the New task sheet localized in en-XA, for a run and a Code session', async () => {
    const hub = createHub();
    hub.state.workspace.projects = [project({ id: 'p2', name: 'Website' })];
    hub.state.m4.folders = [
      folder({ id: 'f1', projectId: 'p2', path: '/srv/website', access: 'write' }),
    ];
    await activateTestLocale('en-XA');
    await renderWithPush(<NewTaskSheet open onClose={() => undefined} />, { hub });
    const dialog = await screen.findByRole('dialog', { name: NEW_TASK_TEXT.title });
    await within(dialog).findByRole('combobox', { name: NEW_TASK_TEXT.project });
    expectFullyLocalized(dialog, { data: ['Website'] });

    await userEvent.click(within(dialog).getByRole('radio', { name: NEW_TASK_TEXT.code.label }));
    await userEvent.selectOptions(within(dialog).getByRole('combobox'), 'p2');
    expect(within(dialog).getByText(NEW_TASK_TEXT.codeHint)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: NEW_TASK_TEXT.start }));
    expect(within(dialog).getByText(NEW_TASK_TEXT.needText)).toBeTruthy();
    expectFullyLocalized(dialog, { data: ['Website'] });
  });

  it('says how to add a folder, localized, when no project has one', async () => {
    const hub = createHub();
    hub.state.workspace.projects = [project({ id: 'p1', name: 'Billing' })];
    await activateTestLocale('en-XA');
    await renderWithPush(<NewTaskSheet open onClose={() => undefined} />, { hub });
    const dialog = await screen.findByRole('dialog', { name: NEW_TASK_TEXT.title });
    await within(dialog).findByRole('combobox', { name: NEW_TASK_TEXT.project });
    await userEvent.click(within(dialog).getByRole('radio', { name: NEW_TASK_TEXT.code.label }));
    expect(within(dialog).getByText(NEW_TASK_TEXT.noFolder)).toBeTruthy();
    expectFullyLocalized(dialog, { data: ['Billing'] });
  });
});
