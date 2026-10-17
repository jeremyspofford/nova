import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { emitCode } from './code-helpers.tsx';
import { codeSession } from './fakes-m5-code.ts';
import { renderM6, worktreeView } from './fakes-m6-code.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const toastText = async (text: RegExp) => expect(await screen.findByText(text)).toBeTruthy();

describe('Worktrees page (FR-073)', () => {
  it('lists worktrees by repository with branch, changes and lease', async () => {
    const s = codeSession({ title: 'Parser fix' });
    const leased = worktreeView({
      branch: 'nova/parser',
      leasedBy: s.id,
      leaseExpiresAt: '2099-01-01T14:05:00.000Z',
    });
    const forever = worktreeView({ branch: 'nova/forever', leasedBy: s.id });
    const dirty = worktreeView({ branch: 'nova/dirty', dirty: true, included: 3 });
    const other = worktreeView({ repoPath: '/srv/api', branch: 'nova/api' });
    const removed = worktreeView({ branch: 'nova/old', status: 'removed' });
    await renderM6('/code/worktrees', [s], {
      m6: { worktrees: [leased, forever, dirty, other, removed] },
    });
    const app = await screen.findByRole('region', { name: '/home/me/app' });
    expect(within(app).getByText('3 of 15 worktrees')).toBeTruthy();
    const parser = within(app).getByRole('listitem', { name: 'nova/parser' });
    expect(within(parser).getByText(/Leased to “Parser fix” until/)).toBeTruthy();
    expect(within(parser).getByRole('link', { name: 'Open the session' })).toHaveProperty(
      'pathname',
      `/code/${s.id}`,
    );
    expect(within(parser).getByRole('button', { name: /Renew 1 h/ })).toBeTruthy();
    // A lease until release has no expiry to renew.
    const f = within(app).getByRole('listitem', { name: 'nova/forever' });
    expect(within(f).getByText(/until it is released or archived/)).toBeTruthy();
    expect(within(f).queryByRole('button', { name: /Renew/ })).toBeNull();
    expect(within(f).getByRole('button', { name: /Remove/ })).toHaveProperty('disabled', true);
    const d = within(app).getByRole('listitem', { name: 'nova/dirty' });
    expect(within(d).getByText('Uncommitted changes')).toBeTruthy();
    expect(within(d).getByText('Not leased')).toBeTruthy();
    expect(within(d).getByText('3 ignored files copied in')).toBeTruthy();
    expect(screen.getByRole('region', { name: '/srv/api' })).toBeTruthy();
    // Removed ones show only when asked.
    expect(screen.queryByRole('listitem', { name: 'nova/old' })).toBeNull();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'all');
    expect(await screen.findByRole('listitem', { name: 'nova/old' })).toBeTruthy();
  });

  it('renews a lease, and refuses to release one a session works in', async () => {
    const s = codeSession({ title: 'Parser fix' });
    const w = worktreeView({
      branch: 'nova/parser',
      leasedBy: s.id,
      leaseExpiresAt: '2026-10-02T09:30:00.000Z',
    });
    const r = await renderM6('/code/worktrees', [s], { m6: { worktrees: [w], inUse: [w.id] } });
    const item = await screen.findByRole('listitem', { name: 'nova/parser' });
    await userEvent.click(within(item).getByRole('button', { name: /Renew/ }));
    await waitFor(() => expect(r.api.renewWorktree).toHaveBeenCalledWith(w.id, 60));
    await waitFor(() =>
      expect(r.m6.worktrees[0]!.leaseExpiresAt).not.toBe('2026-10-02T09:30:00.000Z'),
    );
    await userEvent.click(within(item).getByRole('button', { name: 'Release' }));
    await toastText(/A Code session works in nova\/parser\. Archive the session first\./);
    expect(r.m6.worktrees[0]!.leasedBy).toBe(s.id);
  });

  it('releases a lease, then removes a dirty worktree only after a warning', async () => {
    const s = codeSession({ title: 'Parser fix' });
    const w = worktreeView({ branch: 'nova/parser', leasedBy: s.id, dirty: true });
    const r = await renderM6('/code/worktrees', [s], { m6: { worktrees: [w] } });
    const item = await screen.findByRole('listitem', { name: 'nova/parser' });
    await userEvent.click(within(item).getByRole('button', { name: 'Release' }));
    await waitFor(() => expect(within(item).getByText('Not leased')).toBeTruthy());

    await userEvent.click(within(item).getByRole('button', { name: /Remove/ }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Remove the worktree of nova/parser?',
    });
    expect(
      within(dialog).getByText(/It has uncommitted changes\. Removing it deletes them/),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Remove and delete changes' }),
    );
    await waitFor(() => expect(r.api.removeWorktree).toHaveBeenCalledWith(w.id, true));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'nova/parser' })).toBeNull());
    expect(r.m6.worktrees[0]!.status).toBe('removed');
  });

  it('says why a removal was refused', async () => {
    const w = worktreeView({ branch: 'nova/busy' });
    await renderM6('/code/worktrees', [], { m6: { worktrees: [w], inUse: [w.id] } });
    const item = await screen.findByRole('listitem', { name: 'nova/busy' });
    await userEvent.click(within(item).getByRole('button', { name: /Remove/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the worktree of nova/busy?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(
      await within(dialog).findByText(
        'A Code session works in this worktree. Archive the session first.',
      ),
    ).toBeTruthy();
  });

  it('at the cap of 15, offers to remove the oldest unused clean worktree', async () => {
    const full = Array.from({ length: 15 }, (_, i) =>
      worktreeView({ branch: `nova/w${i}`, dirty: i > 0 }),
    );
    const r = await renderM6('/code/worktrees', [], { m6: { worktrees: full } });
    expect(await screen.findByText(/This repository is at the cap of 15 worktrees/)).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: /New worktree/ })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'New worktree' });
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Repository folder on the Hub' }),
      '/home/me/app',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Branch name (optional)' }),
      'spike',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create worktree' }));
    expect(
      await within(dialog).findByText(/This repository already has 15 worktrees\./),
    ).toBeTruthy();
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Remove the oldest and create' }),
    );
    await waitFor(() =>
      expect(r.api.createWorktree).toHaveBeenLastCalledWith({
        repo: '/home/me/app',
        branch: 'spike',
        removeOldest: true,
      }),
    );
    expect(await screen.findByRole('listitem', { name: 'nova/spike' })).toBeTruthy();
    expect(r.m6.worktrees.find((w) => w.branch === 'nova/w0')!.status).toBe('removed');
  });

  it('at the cap with nothing removable, says to remove one first', async () => {
    const full = Array.from({ length: 15 }, (_, i) =>
      worktreeView({ branch: `nova/w${i}`, dirty: true }),
    );
    await renderM6('/code/worktrees', [], { m6: { worktrees: full } });
    await userEvent.click((await screen.findAllByRole('button', { name: /New worktree/ }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'New worktree' });
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Repository folder on the Hub' }),
      '/home/me/app',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create worktree' }));
    expect(await within(dialog).findByText(/none can be removed for you/)).toBeTruthy();
    expect(
      within(dialog).queryByRole('button', { name: 'Remove the oldest and create' }),
    ).toBeNull();
  });

  it('shows an empty state and follows worktree events', async () => {
    const r = await renderM6('/code/worktrees', [], { m6: { worktrees: [] } });
    expect(await screen.findByRole('heading', { name: 'No worktrees' })).toBeTruthy();
    r.m6.worktrees = [worktreeView({ branch: 'nova/new' })];
    emitCode('worktree.leased', { worktreeId: 'x', sessionId: 'cs-1' });
    expect(await screen.findByRole('listitem', { name: 'nova/new' })).toBeTruthy();
  });
});
