import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { codeSession } from './fakes-m5-code.ts';
import { renderM6, savedEnvironment, worktreeView } from './fakes-m6-code.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

async function openDialog(opts: Parameters<typeof renderM6>[2] = {}) {
  const r = await renderM6('/code?new=1', [], opts);
  const dialog = await screen.findByRole('dialog', { name: 'New Code session' });
  await within(dialog).findByRole('button', { name: 'Start session' });
  return { ...r, dialog };
}

describe('New Code session in M6 (FR-062, FR-073, docs/09 §2)', () => {
  it('picks a saved environment with its health; another machine takes a folder path there', async () => {
    const local = savedEnvironment({ kind: 'local' });
    const ssh = savedEnvironment({ kind: 'ssh', label: 'Build box' });
    const degraded = savedEnvironment({
      kind: 'container',
      label: 'Node box',
      status: 'degraded',
      detail: 'image is old',
    });
    const { dialog, hub } = await openDialog({
      code: { environments: [local, ssh, degraded] },
      m6: { worktrees: [worktreeView({ repoPath: '/home/me/src/app' })] },
    });
    const env = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Environment' });
    expect(env.value).toBe(local.id);
    expect(within(dialog).getByRole('link', { name: 'Manage environments' })).toHaveProperty(
      'pathname',
      '/code/environments',
    );
    await userEvent.selectOptions(env, degraded.id);
    expect(within(dialog).getByText(/Degraded: image is old\./)).toBeTruthy();

    await userEvent.selectOptions(env, ssh.id);
    // Project folders are on the Hub; on another machine the path is typed.
    expect(within(dialog).queryByRole('combobox', { name: 'Folder' })).toBeNull();
    const path = within(dialog).getByRole('textbox', { name: 'Folder path on Build box' });
    const wt = within(dialog).getByRole('checkbox', { name: 'Work in a new Git worktree' });
    expect(wt).toHaveProperty('disabled', true);
    expect(
      within(dialog).getByText('Worktrees are only available for folders on the Hub.'),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole('combobox', { name: 'Or work in an existing worktree' }),
    ).toBeNull();
    await userEvent.type(path, '/home/me/src/app');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() =>
      expect(hub.api.createCodeSession).toHaveBeenCalledWith({
        folder: '/home/me/src/app',
        environmentId: ssh.id,
        permissionMode: 'manual',
      }),
    );
  });

  it('binds an existing unleased worktree of the folder’s repository', async () => {
    const s = codeSession({ id: 'cs-lease' });
    const free = worktreeView({ branch: 'nova/spike', dirty: true });
    const leased = worktreeView({ branch: 'nova/taken', leasedBy: s.id });
    const elsewhere = worktreeView({ branch: 'nova/api', repoPath: '/srv/api' });
    const r = await renderM6('/code?new=1', [s], {
      code: { environments: [savedEnvironment({ kind: 'local' })] },
      m6: { worktrees: [free, leased, elsewhere] },
    });
    const dialog = await screen.findByRole('dialog', { name: 'New Code session' });
    await userEvent.type(
      await within(dialog).findByRole('textbox', { name: 'Folder path on the Hub' }),
      '/home/me/app/web',
    );
    const pick = await within(dialog).findByRole<HTMLSelectElement>('combobox', {
      name: 'Or work in an existing worktree',
    });
    expect([...pick.options].map((o) => o.textContent)).toEqual([
      'None',
      'nova/spike (uncommitted changes)',
    ]);
    await userEvent.selectOptions(pick, free.id);
    expect(
      within(dialog).getByRole('checkbox', { name: 'Work in a new Git worktree' }),
    ).toHaveProperty('disabled', true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() =>
      expect(r.hub.api.createCodeSession).toHaveBeenCalledWith({
        folder: '/home/me/app/web',
        environmentId: expect.any(String),
        permissionMode: 'manual',
        worktreeId: free.id,
      }),
    );
    const created = r.hub.state.m5code.sessions[0]!;
    expect(r.m6.worktrees.find((w) => w.id === free.id)!.leasedBy).toBe(created.id);
    await waitFor(() => expect(window.location.pathname).toBe(`/code/${created.id}`));
  });

  it('sends budgets only when set, and checks them first', async () => {
    const { dialog, hub, m6 } = await openDialog({
      settings: { 'code.budgets': { timeSeconds: 3600, tokens: null, costUsd: 5 } },
    });
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Folder path on the Hub' }),
      '/srv/api',
    );
    await userEvent.click(within(dialog).getByText('Budgets (optional)'));
    expect(
      within(dialog).getByText(/the defaults from Settings → Code apply: 1 h, \$5\.00/),
    ).toBeTruthy();
    const minutes = within(dialog).getByRole('spinbutton', { name: 'Time limit (minutes)' });
    await userEvent.type(minutes, '0');
    expect(
      within(dialog).getByText('Set the time limit in whole minutes, from 1 to 10,080.'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Start session' })).toHaveProperty(
      'disabled',
      true,
    );
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '90');
    await userEvent.type(within(dialog).getByRole('spinbutton', { name: 'Token limit' }), '500000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() =>
      expect(hub.api.createCodeSession).toHaveBeenCalledWith({
        folder: '/srv/api',
        permissionMode: 'manual',
        budgets: { timeSeconds: 5400, tokens: 500_000 },
      }),
    );
    const id = hub.state.m5code.sessions[0]!.id;
    expect(m6.budgets[id]!.limits).toEqual({ timeSeconds: 5400, tokens: 500_000, costUsd: null });
  });

  it('explains the worktree cap and links to the Worktrees page', async () => {
    const full = Array.from({ length: 15 }, (_, i) =>
      worktreeView({ repoPath: '/srv/api', branch: `nova/w${i}`, leasedBy: `cs-${i}` }),
    );
    const { dialog, hub } = await openDialog({ m6: { worktrees: full } });
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Folder path on the Hub' }),
      '/srv/api',
    );
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Work in a new Git worktree' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    expect(
      await within(dialog).findByText(
        /This repository already has 15 worktrees, the most it can hold/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'Open Worktrees' })).toHaveProperty(
      'pathname',
      '/code/worktrees',
    );
    expect(hub.state.m5code.sessions).toHaveLength(0);
  });
});
