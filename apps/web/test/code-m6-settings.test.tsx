import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { gitHost, pullRequest, renderM6 } from './fakes-m6-code.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const hosts = () => screen.getByRole('region', { name: 'Git hosts' });

describe('Settings → Code: Git hosts (FR-070)', () => {
  it('connects GitHub with a write-only token and shows who it signs in as', async () => {
    const r = await renderM6('/settings/code');
    expect(
      await within(hosts()).findByRole('heading', { name: 'No Git host connected' }),
    ).toBeTruthy();
    await userEvent.click(within(hosts()).getByRole('button', { name: /Connect a Git host/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect a Git host' });
    const token = within(dialog).getByLabelText('Personal access token');
    expect(token.getAttribute('type')).toBe('password');
    await userEvent.type(token, 'ghp_secret123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    await waitFor(() =>
      expect(r.api.createGitHost).toHaveBeenCalledWith({ kind: 'github', token: 'ghp_secret123' }),
    );
    const list = await within(hosts()).findByRole('list', { name: 'Git hosts' });
    const row = within(list).getByRole('listitem', { name: 'github.com' });
    expect(within(row).getByText('Connected')).toBeTruthy();
    expect(within(row).getByText('Signed in as octo')).toBeTruthy();
    expect(within(row).getByText('Token: set')).toBeTruthy();
    expect(document.body.textContent).not.toContain('ghp_secret123');
    expect(Object.values(r.m6.hostTokens)).toEqual(['ghp_secret123']);
  });

  it('says when the host rejects the token, and connects GitHub Enterprise', async () => {
    const r = await renderM6('/settings/code', [], {
      m6: { rejectedTokens: ['ghp_old'], gitHosts: [gitHost()] },
    });
    await userEvent.click(
      await within(hosts()).findByRole('button', { name: /Connect a Git host/ }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Connect a Git host' });
    await userEvent.type(within(dialog).getByLabelText('Personal access token'), 'ghp_old');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    // github.com is connected already.
    expect(await within(dialog).findByText('https://github.com is already connected')).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('checkbox', { name: /GitHub Enterprise/ }));
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Web address' }),
      'https://git.example.com',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(
      await within(dialog).findByText(
        'Enter the web address and the API address of your GitHub Enterprise server.',
      ),
    ).toBeTruthy();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'API address' }),
      'https://git.example.com/api/v3',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(
      await within(dialog).findByText(
        'The host rejected the token. Check that it is current and has the repo scope.',
      ),
    ).toBeTruthy();
    expect(r.m6.gitHosts).toHaveLength(1);
    const token = within(dialog).getByLabelText('Personal access token');
    await userEvent.clear(token);
    await userEvent.type(token, 'ghp_new');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(await within(hosts()).findByRole('listitem', { name: 'git.example.com' })).toBeTruthy();
  });

  it('checks a host, and refuses to remove one with open pull requests', async () => {
    const h = gitHost({ status: 'error', detail: 'the Git host could not be reached' });
    const r = await renderM6('/settings/code', [], {
      m6: { gitHosts: [h], pullRequests: [pullRequest('cs-1', { hostId: h.id })] },
    });
    const row = await within(hosts()).findByRole('listitem', { name: 'github.com' });
    expect(within(row).getByText('Not working')).toBeTruthy();
    expect(within(row).getByText('the Git host could not be reached')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Check' }));
    expect(await within(row).findByText('Connected')).toBeTruthy();

    await userEvent.click(within(row).getByRole('button', { name: /Remove/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove github.com?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(
      await within(dialog).findByText(/Pull requests opened through this host are still open/),
    ).toBeTruthy();
    r.m6.pullRequests = [];
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(hosts()).queryByRole('listitem')).toBeNull());
  });
});

describe('Settings → Code: M6 settings (FR-068, FR-070, FR-073, docs/09 §2)', () => {
  it('sets auto-verify, its commands and feedback turns', async () => {
    const r = await renderM6('/settings/code');
    const sw = await screen.findByRole('switch', { name: 'Run the checks after edits' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await userEvent.click(sw);
    await waitFor(() =>
      expect(r.hub.api.setSetting).toHaveBeenCalledWith('code.autoVerify', {
        enabled: false,
        commands: [],
        timeoutSeconds: 600,
        feedbackTurns: 1,
      }),
    );
    const cmds = screen.getByRole('textbox', { name: 'Check commands' });
    await userEvent.type(cmds, 'npm run build{Enter}npm test');
    cmds.blur();
    await waitFor(() =>
      expect(r.hub.state.settings['code.autoVerify']).toEqual({
        enabled: false,
        commands: ['npm run build', 'npm test'],
        timeoutSeconds: 600,
        feedbackTurns: 1,
      }),
    );
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Failed checks sent back to the agent in a row' }),
      '3',
    );
    await waitFor(() =>
      expect(r.hub.state.settings['code.autoVerify']).toMatchObject({ feedbackTurns: 3 }),
    );
    const timeout = screen.getByRole('spinbutton', { name: 'Stop a check after (seconds)' });
    await userEvent.clear(timeout);
    await userEvent.type(timeout, '10');
    expect(screen.getByText('Enter a whole number from 30 to 3,600.')).toBeTruthy();
    await userEvent.clear(timeout);
    await userEvent.type(timeout, '120{Enter}');
    await waitFor(() =>
      expect(r.hub.state.settings['code.autoVerify']).toMatchObject({ timeoutSeconds: 120 }),
    );
  });

  it('sets default budgets, CI polling and feedback, and worktree cleanup', async () => {
    const r = await renderM6('/settings/code');
    const time = await screen.findByRole('spinbutton', { name: 'Time limit (minutes)' });
    expect(time.getAttribute('placeholder')).toBe('No limit');
    await userEvent.type(time, '60{Enter}');
    await waitFor(() =>
      expect(r.hub.state.settings['code.budgets']).toEqual({
        timeSeconds: 3600,
        tokens: null,
        costUsd: null,
      }),
    );
    await userEvent.type(
      screen.getByRole('spinbutton', { name: 'Cost limit (US dollars)' }),
      '2.5{Enter}',
    );
    await waitFor(() =>
      expect(r.hub.state.settings['code.budgets']).toMatchObject({ costUsd: 2.5 }),
    );
    await userEvent.clear(time);
    time.blur();
    await waitFor(() =>
      expect(r.hub.state.settings['code.budgets']).toMatchObject({ timeSeconds: null }),
    );

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Check CI of open pull requests every' }),
      '300',
    );
    await waitFor(() => expect(r.hub.state.settings['code.ciPollSeconds']).toBe(300));
    await userEvent.click(
      screen.getByRole('switch', { name: 'Send failed CI checks to the agent' }),
    );
    await waitFor(() => expect(r.hub.state.settings['code.ciFeedback']).toBe(false));
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'When a session is archived' }),
      'keep',
    );
    await waitFor(() => expect(r.hub.state.settings['code.worktreeCleanup']).toBe('keep'));
  });

  it('links to the environments and worktrees, and shows managed values locked', async () => {
    await renderM6('/settings/code', [], {
      hub: {
        managed: {
          'code.autoVerify': { enabled: true, commands: [], timeoutSeconds: 600, feedbackTurns: 0 },
        },
      },
    });
    expect(await screen.findByRole('link', { name: 'Manage environments' })).toHaveProperty(
      'pathname',
      '/code/environments',
    );
    expect(screen.getByRole('link', { name: 'Manage worktrees' })).toHaveProperty(
      'pathname',
      '/code/worktrees',
    );
    expect(screen.getByRole('switch', { name: 'Run the checks after edits' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('textbox', { name: 'Check commands' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
