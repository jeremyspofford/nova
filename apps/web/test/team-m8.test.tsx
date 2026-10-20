// Settings → Members in M8 (ADR-097, decision 5): removed members whose data is kept for a while,
// exported and deleted (Delete now asks for an explicit confirmation and says what goes), the
// purge-days setting with its managed lock, and the removal's confirmation saying what happens to
// what they made.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { MembersPage } from '../src/team/MembersPage.tsx';
import { REMOVED_TEXT, removedErrorMessage } from '../src/team/format.ts';
import { purgeTotals, removedChip, removedName } from '../src/team/RemovedMembers.tsx';
import { FakeEventSource } from './fakes.ts';
import { removedMember, renderW11 } from './fakes-m8-appauth.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const section = async () => {
  const h = await screen.findByRole('heading', { name: REMOVED_TEXT.heading });
  return h.closest('section')!;
};

describe('removed members (ADR-097)', () => {
  it('lists a removed member with when their data goes and an export of it', async () => {
    await renderW11(<MembersPage />, { appauth: { removed: [removedMember()] } });
    const s = within(await section());
    const row = await s.findByRole('listitem', { name: 'Robin' });
    expect(within(row).getByText('Deleted in 23 days')).toBeTruthy();
    const link = within(row).getByRole('link', {
      name: REMOVED_TEXT.exportLabel({ name: 'Robin' }),
    });
    expect(link.getAttribute('href')).toBe('/api/v1/team/removed/acc-robin/export');
    expect(link.hasAttribute('download')).toBe(true);
    expect(s.getByText(REMOVED_TEXT.intro)).toBeTruthy();
  });

  it('deletes now only after an explicit confirmation that says what goes', async () => {
    const { api, state } = await renderW11(<MembersPage />, {
      appauth: { removed: [removedMember()] },
    });
    const s = within(await section());
    await userEvent.click(
      await s.findByRole('button', { name: REMOVED_TEXT.purgeLabel({ name: 'Robin' }) }),
    );
    const dialog = screen.getByRole('dialog', { name: REMOVED_TEXT.purgeTitle({ name: 'Robin' }) });
    expect(dialog.textContent).toContain(REMOVED_TEXT.purgeWhat);
    expect(dialog.textContent).toContain(REMOVED_TEXT.purgeExportFirst);
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: REMOVED_TEXT.purgeButton,
    });
    expect(confirm.disabled).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: REMOVED_TEXT.purgeConfirm({ name: 'Robin' }) }),
    );
    expect(confirm.disabled).toBe(false);
    await userEvent.click(confirm);
    await waitFor(() => expect(api.purgeRemovedMember).toHaveBeenCalledWith('acc-robin'));
    expect(await screen.findByText(REMOVED_TEXT.purged({ name: 'Robin' }))).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    const row = s.getByRole('listitem', { name: REMOVED_TEXT.purgedName });
    expect(within(row).getByText(/^Deleted /)).toBeTruthy();
    expect(within(row).getByText(REMOVED_TEXT.byRequest)).toBeTruthy();
    expect(within(row).getByText(REMOVED_TEXT.counts({ rows: 260, files: 3 }))).toBeTruthy();
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();
    expect(state.removed[0]?.status).toBe('purged');
  });

  it('cancels without deleting anything', async () => {
    const { api } = await renderW11(<MembersPage />, { appauth: { removed: [removedMember()] } });
    const s = within(await section());
    await userEvent.click(
      await s.findByRole('button', { name: REMOVED_TEXT.purgeLabel({ name: 'Robin' }) }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.purgeRemovedMember).not.toHaveBeenCalled();
  });

  it('says when a delete failed (tried again tomorrow) or was already done', async () => {
    await renderW11(<MembersPage />, {
      appauth: { removed: [removedMember()], purgeOutcome: 'failed' },
    });
    let s = within(await section());
    await userEvent.click(
      await s.findByRole('button', { name: REMOVED_TEXT.purgeLabel({ name: 'Robin' }) }),
    );
    let dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('checkbox'));
    await userEvent.click(dialog.getByRole('button', { name: REMOVED_TEXT.purgeButton }));
    expect(await screen.findByText(REMOVED_TEXT.purgeFailed({ name: 'Robin' }))).toBeTruthy();
    const row = s.getByRole('listitem', { name: 'Robin' });
    expect(within(row).getByText(REMOVED_TEXT.status.failed)).toBeTruthy();
    expect(within(row).getByText(/Why: the database was busy/)).toBeTruthy();
    resetDom();
    await renderW11(<MembersPage />, {
      appauth: { removed: [removedMember()] },
      fail: {
        purgeRemovedMember: new ApiError(409, {
          code: 'conflict',
          message: "this member's data was already purged",
          retryable: false,
          details: { reason: 'already_purged' },
        }),
      },
    });
    s = within(await section());
    await userEvent.click(
      await s.findByRole('button', { name: REMOVED_TEXT.purgeLabel({ name: 'Robin' }) }),
    );
    dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('checkbox'));
    await userEvent.click(dialog.getByRole('button', { name: REMOVED_TEXT.purgeButton }));
    expect((await dialog.findByRole('alert')).textContent).toBe('Their data was already deleted.');
  });

  it('says when the export is not available and when data is kept until deleted', async () => {
    await renderW11(<MembersPage />, {
      appauth: {
        removed: [
          removedMember({ exportable: false, status: 'kept', purgeAfter: null }),
          removedMember({
            accountId: 'acc-lee',
            displayName: null,
            status: 'purged',
            purgedAt: new Date().toISOString(),
            cause: 'grace',
            exportable: false,
            cleanupPending: true,
            counts: { rows: { thread: 1 }, blobs: 1, secrets: 0, folders: 0 },
          }),
        ],
      },
    });
    const s = within(await section());
    const robin = await s.findByRole('listitem', { name: 'Robin' });
    expect(within(robin).getByText(REMOVED_TEXT.status.kept)).toBeTruthy();
    expect(within(robin).getByText(REMOVED_TEXT.exportUnavailable)).toBeTruthy();
    expect(within(robin).queryByRole('link')).toBeNull();
    const lee = s.getByRole('listitem', { name: REMOVED_TEXT.purgedName });
    expect(within(lee).getByText(REMOVED_TEXT.afterGrace)).toBeTruthy();
    expect(within(lee).getByText(REMOVED_TEXT.cleanupPending)).toBeTruthy();
    expect(within(lee).getByText(REMOVED_TEXT.counts({ rows: 1, files: 1 }))).toBeTruthy();
  });

  it('follows removals and purges live, and retries a failed load', async () => {
    const { state, api } = await renderW11(<MembersPage />, {
      fail: {
        listRemovedMembers: new ApiError(500, {
          code: 'server_error',
          message: 'down',
          retryable: true,
        }),
      },
    });
    const s = within(await section());
    expect((await s.findByRole('alert')).textContent).toContain('Down.');
    await userEvent.click(s.getByRole('button', { name: 'Retry' }));
    expect(await s.findByText(REMOVED_TEXT.none)).toBeTruthy();
    state.removed = [removedMember()];
    FakeEventSource.for('/api/v1/events/stream').emit('team.member.purged', {
      accountId: 'acc-robin',
    });
    expect(await s.findByRole('listitem', { name: 'Robin' })).toBeTruthy();
    expect(api.listRemovedMembers).toHaveBeenCalledTimes(3);
  });
});

describe('how long their data is kept', () => {
  it('saves the number of days, checks it, and 0 keeps it until you delete it', async () => {
    const { hub } = await renderW11(<MembersPage />);
    const field = await screen.findByLabelText(REMOVED_TEXT.keepLabel);
    expect((field as HTMLInputElement).value).toBe('30');
    const form = within(screen.getByRole('form', { name: REMOVED_TEXT.keepFormLabel }));
    await userEvent.clear(field);
    await userEvent.type(field, '4000');
    await userEvent.click(form.getByRole('button', { name: REMOVED_TEXT.save }));
    expect(await screen.findByText(REMOVED_TEXT.keepInvalid)).toBeTruthy();
    expect(hub.state.settings['team.removedMemberPurgeDays']).toBeUndefined();
    await userEvent.clear(field);
    await userEvent.type(field, '0');
    await userEvent.click(form.getByRole('button', { name: REMOVED_TEXT.save }));
    await waitFor(() => expect(hub.state.settings['team.removedMemberPurgeDays']).toBe(0));
    expect(await screen.findByText(REMOVED_TEXT.keepSaved({ days: 0 }))).toBeTruthy();
  });

  it('is disabled and says so when managed policy sets it', async () => {
    await renderW11(<MembersPage />, { managed: { 'team.removedMemberPurgeDays': 7 } });
    const field = await screen.findByLabelText(REMOVED_TEXT.keepLabel);
    expect((field as HTMLInputElement).disabled).toBe(true);
    expect((field as HTMLInputElement).value).toBe('7');
    expect(screen.getAllByText(/Managed by your organization/).length).toBeGreaterThan(0);
  });

  it('says in the removal’s confirmation what happens to what they made', async () => {
    await renderW11(<MembersPage />, { settings: { 'team.removedMemberPurgeDays': 14 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Alex' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Alex from this Hub?' });
    expect(dialog.textContent).toContain(REMOVED_TEXT.removeWhat({ days: 14 }));
    expect(REMOVED_TEXT.removeWhat({ days: 0 })).toContain(
      'until you delete it under Removed members',
    );
  });

  it('is the owner’s: a member sees no removed members', async () => {
    const { api } = await renderW11(<MembersPage />, { member: true });
    expect(await screen.findByRole('heading', { name: 'People' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: REMOVED_TEXT.heading })).toBeNull();
    expect(api.listRemovedMembers).not.toHaveBeenCalled();
  });
});

describe('the words', () => {
  it('names, chips, totals and refusals', () => {
    expect(removedName({ displayName: '  ' })).toBe(REMOVED_TEXT.purgedName);
    expect(removedChip(removedMember({ status: 'scheduled', purgeAfter: null })).text).toBe(
      'Deleted soon',
    );
    expect(removedChip(removedMember({ status: 'weird' as never })).text).toBe('weird');
    expect(purgeTotals(removedMember())).toBeNull();
    const e = (reason: string) =>
      new ApiError(400, { code: 'x', message: 'm', retryable: false, details: { reason } });
    expect(removedErrorMessage(e('export_unavailable'), 'f')).toBe(REMOVED_TEXT.exportUnavailable);
    expect(
      removedErrorMessage(
        new ApiError(404, {
          code: 'not_found',
          message: 'no such removed member',
          retryable: false,
        }),
        'f',
      ),
    ).toBe('This person is no longer listed. Refresh the page.');
  });
});
