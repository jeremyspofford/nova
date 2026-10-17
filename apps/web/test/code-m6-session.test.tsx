import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { emitCode } from './code-helpers.tsx';
import {
  budget,
  ciCheck,
  gitHost,
  openM6Session,
  processView,
  pullRequest,
  savedEnvironment,
} from './fakes-m6-code.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const announcer = () => screen.getByTestId('announcer').textContent ?? '';
const tab = (name: string | RegExp) => screen.getByRole('tab', { name });
const button = (name: string | RegExp) => screen.getByRole('button', { name });

describe('Code session budgets (docs/09 §2, docs/04 §2.3.1)', () => {
  it('shows time, tokens and cost against the limits and extends them', async () => {
    const { view, s, m6, api } = await openM6Session({ id: 'cs-budget' });
    // Without limits: what was used, and a way to set limits.
    const bar = await within(view).findByRole('region', { name: 'Budget' });
    expect(
      within(bar).getByText(
        'No limits: this session runs until you stop it. Used so far: 0 min, 0 tokens, $0.00.',
      ),
    ).toBeTruthy();
    expect(within(bar).queryAllByRole('meter')).toHaveLength(0);
    expect(within(bar).getByRole('button', { name: 'Set a budget…' })).toBeTruthy();

    // Usage moves on: a session event refreshes the bar.
    m6.budgets[s.id] = budget({
      limits: { timeSeconds: 3600, tokens: 2_000_000, costUsd: 5 },
      used: { timeSeconds: 42 * 60, tokens: 500_000, costUsd: 1.8 },
    });
    emitCode('code.session.updated', { sessionId: s.id });
    expect(await within(bar).findByText('42 min / 1 h')).toBeTruthy();
    expect(within(bar).getByText('0.5M / 2M')).toBeTruthy();
    expect(within(bar).getByText('$1.80 / $5.00')).toBeTruthy();
    expect(within(bar).getAllByRole('meter')).toHaveLength(3);

    await userEvent.click(within(bar).getByRole('button', { name: 'Extend budget…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Extend budget' });
    const tokens = within(dialog).getByRole('spinbutton', { name: 'Add tokens' });
    await userEvent.type(tokens, '50');
    expect(within(dialog).getByText('Add tokens from 1,000 to 1,000,000,000.')).toBeTruthy();
    await userEvent.clear(tokens);
    await userEvent.type(
      within(dialog).getByRole('spinbutton', { name: 'Add time (minutes)' }),
      '30',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: /Extend/ }));
    await waitFor(() =>
      expect(api.extendCodeBudget).toHaveBeenCalledWith(s.id, { timeSeconds: 1800 }),
    );
    expect(await within(bar).findByText('42 min / 1 h 30 min')).toBeTruthy();
    await waitFor(() => expect(announcer()).toMatch(/Budget extended/));
  });

  it('turns into a decision at a bound: Blocked, Budget reached, Extend 30 min', async () => {
    const { view, api } = await openM6Session(
      { id: 'cs-bound', derived: { status: 'blocked', reason: 'Budget reached' } },
      {
        m6: {
          budgets: {
            'cs-bound': budget({
              limits: { timeSeconds: 3600, tokens: null, costUsd: null },
              used: { timeSeconds: 3600, tokens: 120_000, costUsd: 0.4 },
              reached: 'time',
            }),
          },
        },
      },
    );
    const bar = await within(view).findByRole('region', { name: /Budget reached: time/ });
    expect(
      within(bar).getByText(/Its next turn starts only after you extend the budget/),
    ).toBeTruthy();
    expect(within(bar).getByText('Blocked: Budget reached')).toBeTruthy();
    await userEvent.click(within(bar).getByRole('button', { name: 'Extend 30 min' }));
    await waitFor(() =>
      expect(api.extendCodeBudget).toHaveBeenCalledWith('cs-bound', { timeSeconds: 1800 }),
    );
    await waitFor(() =>
      expect(within(view).queryByRole('region', { name: /Budget reached/ })).toBeNull(),
    );
    expect(within(view).getByRole('region', { name: 'Budget' })).toBeTruthy();
  });
});

describe('Branch and push from the session header (FR-070, docs/10 §8)', () => {
  it('creates a nova/ branch at the current commit', async () => {
    const { s, api, view } = await openM6Session({ title: 'Fix the parser' });
    await userEvent.click(button('Branch…'));
    const dialog = await screen.findByRole('dialog', { name: 'New branch' });
    const name = within(dialog).getByRole('textbox', { name: 'Branch name' });
    expect((name as HTMLInputElement).value).toBe('fix-the-parser');
    expect(within(dialog).getByText(/The branch will be nova\/fix-the-parser/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create branch' }));
    await waitFor(() => expect(api.createCodeBranch).toHaveBeenCalledWith(s.id, 'fix-the-parser'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('Now on nova/fix-the-parser.')).toBeTruthy();
    // The header follows the session's new branch.
    expect(await within(view).findByText(/^\s*nova\/fix-the-parser$/)).toBeTruthy();
    await waitFor(() =>
      expect(announcer()).toMatch(/Switched to the new branch nova\/fix-the-parser/),
    );
  });

  it('pushes the default branch only after its name is typed, and never force-pushes it', async () => {
    const { s, api, m6 } = await openM6Session({
      repo: { root: '/home/me/app', branch: 'main', head: 'abc', dirty: false },
    });
    await userEvent.click(button('Push…'));
    const dialog = await screen.findByRole('dialog', { name: 'Push branch' });
    expect(within(dialog).getByText(/main is the repository’s default branch/)).toBeTruthy();
    const push = within(dialog).getByRole('button', { name: 'Push' });
    expect(push).toHaveProperty('disabled', true);
    expect(within(dialog).getByRole('checkbox', { name: /Force push/ })).toHaveProperty(
      'disabled',
      true,
    );
    const confirm = within(dialog).getByRole('textbox', { name: 'Type main to confirm' });
    await userEvent.type(confirm, 'mai');
    expect(within(dialog).getByText('The name does not match.')).toBeTruthy();
    expect(push).toHaveProperty('disabled', true);
    await userEvent.type(confirm, 'n');
    expect(push).toHaveProperty('disabled', false);
    await userEvent.click(push);
    await waitFor(() =>
      expect(api.pushCodeSession).toHaveBeenCalledWith(s.id, { confirmBranch: 'main' }),
    );
    expect(await within(dialog).findByText(/Pushed main to origin at/)).toBeTruthy();
    expect(within(dialog).getByText('1f2e3d4')).toBeTruthy();
    expect(m6.pushes).toHaveLength(1);
    await waitFor(() => expect(announcer()).toMatch(/Pushed main to origin/));
  });

  it('learns a protected branch from the Hub and asks for its name; lists secrets that block a push', async () => {
    const { s, api, m6 } = await openM6Session(
      { repo: { root: '/home/me/app', branch: 'release', head: 'abc', dirty: false } },
      { m6: { protectedBranches: ['release'] } },
    );
    await userEvent.click(button('Push…'));
    const dialog = await screen.findByRole('dialog', { name: 'Push branch' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push' }));
    expect(await within(dialog).findByText(/release is a protected branch/)).toBeTruthy();
    expect(m6.pushes).toHaveLength(0);

    m6.secretFindings = [
      { path: 'config/dev.env', line: 3, rule: 'aws-access-key', preview: 'AKIA************' },
    ];
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Type release to confirm' }),
      'release',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push' }));
    const blocked = await within(dialog).findByRole('list', { name: 'Possible secrets' });
    expect(within(blocked).getByText('config/dev.env, line 3')).toBeTruthy();
    expect(within(blocked).getByText('(aws-access-key)')).toBeTruthy();
    expect(within(blocked).getByText('AKIA************')).toBeTruthy();
    expect(within(dialog).getByText(/Nothing was pushed/)).toBeTruthy();
    expect(api.pushCodeSession).toHaveBeenLastCalledWith(s.id, { confirmBranch: 'release' });
    expect(m6.pushes).toHaveLength(0);
  });

  it('refuses a force push the Hub calls protected and unticks it', async () => {
    const { api } = await openM6Session(
      { repo: { root: '/home/me/app', branch: 'feature/x', head: 'abc', dirty: false } },
      { m6: { protectedBranches: ['feature/x'] } },
    );
    await userEvent.click(button('Push…'));
    const dialog = await screen.findByRole('dialog', { name: 'Push branch' });
    const force = within(dialog).getByRole('checkbox', { name: /Force push/ });
    await userEvent.click(force);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push' }));
    expect(
      await within(dialog).findByText(/Force-pushing feature\/x is never allowed/),
    ).toBeTruthy();
    expect(api.pushCodeSession).toHaveBeenCalledWith(expect.any(String), { force: true });
    expect(force).toHaveProperty('checked', false);
    expect(force).toHaveProperty('disabled', true);
  });
});

describe('Pull requests and CI (FR-070)', () => {
  it('asks for a Git host first', async () => {
    await openM6Session();
    await userEvent.click(button('Pull request…'));
    const dialog = await screen.findByRole('dialog', { name: 'Open a pull request' });
    expect(await within(dialog).findByText('No Git host is connected yet.')).toBeTruthy();
    expect(
      within(dialog).getByRole('link', { name: 'Connect a Git host in Settings → Code' }),
    ).toHaveProperty('pathname', '/settings/code');
  });

  it('will not open one from the default branch and offers a new branch', async () => {
    await openM6Session(
      { repo: { root: '/home/me/app', branch: 'main', head: 'abc', dirty: false } },
      { m6: { gitHosts: [gitHost()] } },
    );
    await userEvent.click(button('Pull request…'));
    const dialog = await screen.findByRole('dialog', { name: 'Open a pull request' });
    expect(
      await within(dialog).findByText(/the default branch\. A pull request needs its own branch/),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Push and open' })).toHaveProperty(
      'disabled',
      true,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: /New branch/ }));
    expect(await screen.findByRole('dialog', { name: 'New branch' })).toBeTruthy();
  });

  it('opens a pull request, shows it with its checks, and follows CI as it changes', async () => {
    const { s, api, m6, view } = await openM6Session(
      {
        title: 'Fix the parser',
        repo: { root: '/home/me/app', branch: 'nova/fix', head: 'abc', dirty: false },
      },
      { m6: { gitHosts: [gitHost()] } },
    );
    await userEvent.click(button('Pull request…'));
    const dialog = await screen.findByRole('dialog', { name: 'Open a pull request' });
    const title = await within(dialog).findByRole('textbox', { name: 'Title' });
    expect((title as HTMLInputElement).value).toBe('Fix the parser');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Description (optional)' }),
      'Fixes the off-by-one.',
    );
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Open it as a draft' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push and open' }));
    await waitFor(() =>
      expect(api.openPullRequest).toHaveBeenCalledWith(s.id, {
        title: 'Fix the parser',
        body: 'Fixes the off-by-one.',
        draft: true,
      }),
    );
    // The Pull request tab shows it.
    await waitFor(() => expect(tab('Pull request').getAttribute('aria-selected')).toBe('true'));
    const pane = within(view).getByRole('region', { name: 'Pull request' });
    expect(within(pane).getByRole('link', { name: /#12 Fix the parser/ })).toHaveProperty(
      'href',
      'https://github.com/team/app/pull/12',
    );
    expect(
      within(pane)
        .getByRole('link', { name: /#12 Fix the parser/ })
        .getAttribute('rel'),
    ).toBe('noopener noreferrer');
    expect(within(pane).getByText('nova/fix into main')).toBeTruthy();
    await waitFor(() => expect(announcer()).toMatch(/Opened pull request #12/));

    // CI changes on the host: the event refreshes the pane and is announced.
    m6.pullRequests = m6.pullRequests.map((p) => ({
      ...p,
      ci: {
        status: 'failed' as const,
        checks: [
          ciCheck({ name: 'build', conclusion: 'success' }),
          ciCheck({
            name: 'test',
            conclusion: 'failure',
            summary: '2 tests failed',
            url: 'javascript:alert(1)',
          }),
          ciCheck({ name: 'lint', status: 'queued', conclusion: null, url: null }),
        ],
      },
    }));
    emitCode('code.pr.ci.changed', { sessionId: s.id, status: 'failed', checks: [] });
    const checks = await within(pane).findByRole('list', { name: 'CI checks' });
    const items = within(checks).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]!).getByText('Passed')).toBeTruthy();
    expect(within(items[1]!).getByText('Failed')).toBeTruthy();
    expect(within(items[1]!).getByText('2 tests failed')).toBeTruthy();
    // A details link that is not http(s) is not a link.
    expect(within(items[1]!).queryByRole('link')).toBeNull();
    expect(within(items[2]!).getByText('Queued')).toBeTruthy();
    expect(within(pane).getByText('1 check of 3 failed.')).toBeTruthy();
    await waitFor(() => expect(announcer()).toMatch(/Pull request: Checks failed/));
    // The header shows the CI state, and opens the checks.
    expect(
      within(view).getByRole('button', { name: 'Checks failed: show the checks' }),
    ).toBeTruthy();
  });

  it('shows an existing pull request with Refresh, and the header chip opens it', async () => {
    const { view, api, s } = await openM6Session(
      { id: 'cs-pr' },
      {
        m6: {
          pullRequests: [pullRequest('cs-pr', { ci: { status: 'passed', checks: [ciCheck()] } })],
        },
      },
    );
    const chip = await within(view).findByRole('button', {
      name: 'Checks passed: show the checks',
    });
    expect(within(view).getByRole('link', { name: /Pull request #12/ })).toBeTruthy();
    await userEvent.click(chip);
    expect(tab('Pull request').getAttribute('aria-selected')).toBe('true');
    const pane = within(view).getByRole('region', { name: 'Pull request' });
    await userEvent.click(within(pane).getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(api.refreshPullRequest).toHaveBeenCalledWith(s.id));
    // An open pull request: the header button goes to it instead of opening another.
    await userEvent.click(within(view).getByRole('tab', { name: 'Diff' }));
    await userEvent.click(within(view).getByRole('button', { name: 'Pull request' }));
    expect(tab('Pull request').getAttribute('aria-selected')).toBe('true');
  });
});

describe('Pull request details the Hub asks for (FR-070)', () => {
  it('asks for the repository when the remote does not name one, and picks among hosts', async () => {
    const work = gitHost({
      id: 'gh-work',
      label: 'Work GitHub',
      webUrl: 'https://git.example.com',
    });
    const { api, s } = await openM6Session(
      { repo: { root: '/home/me/app', branch: 'nova/x', head: 'abc', dirty: false } },
      { m6: { gitHosts: [gitHost(), work], remoteRepo: null } },
    );
    await userEvent.click(button('Pull request…'));
    const dialog = await screen.findByRole('dialog', { name: 'Open a pull request' });
    await userEvent.selectOptions(
      await within(dialog).findByRole('combobox', { name: 'Git host' }),
      'gh-work',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push and open' }));
    expect(
      await within(dialog).findByText(/The remote does not say which repository it is/),
    ).toBeTruthy();
    const repo = within(dialog).getByRole('textbox', { name: 'Repository (owner/name)' });
    await userEvent.type(repo, 'nope');
    expect(within(dialog).getByText('Use owner/name, for example team/app.')).toBeTruthy();
    await userEvent.clear(repo);
    await userEvent.type(repo, 'team/web');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Push and open' }));
    await waitFor(() =>
      expect(api.openPullRequest).toHaveBeenLastCalledWith(s.id, {
        title: 'Fix the flaky test',
        hostId: 'gh-work',
        repo: 'team/web',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('A session on another machine (FR-062, FR-078)', () => {
  it('says plainly what works only on the Hub, and shows the processes there', async () => {
    const ssh = savedEnvironment({ kind: 'ssh', label: 'Build box' });
    const { view, api } = await openM6Session(
      { id: 'cs-remote', environmentId: ssh.id },
      {
        code: { environments: [ssh] },
        m6: {
          processes: [
            processView(ssh.id, { sessionId: 'cs-remote', cmd: 'npm test' }),
            processView(ssh.id, { sessionId: 'someone-else', cmd: 'make all' }),
          ],
          outputs: {},
        },
      },
    );
    const note = await within(view).findByRole('note');
    expect(note.textContent).toMatch(/This session runs on Build box \(SSH host\)/);
    expect(note.textContent).toMatch(/work only for folders on the Hub/);
    for (const name of ['Review', 'Commit…', 'Branch…', 'Push…', 'Pull request…'])
      expect(within(view).getByRole('button', { name })).toHaveProperty('disabled', true);
    expect(within(view).queryByRole('combobox', { name: /symbol/i })).toBeNull();
    expect(
      within(view).getByRole('heading', { name: 'The diff is not available for this session' }),
    ).toBeTruthy();
    await userEvent.click(tab('Dev servers'));
    expect(
      within(view).getByRole('heading', { name: 'Dev servers are not available here' }),
    ).toBeTruthy();
    expect(api.listDevServers).not.toHaveBeenCalled();
    await userEvent.click(tab('Terminal'));
    const procs = await within(view).findByRole('list', { name: 'Processes on Build box' });
    expect(
      within(procs)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['npm test']);
  });

  it('says when the environment setup script failed', async () => {
    const box = savedEnvironment({ kind: 'container', label: 'Node box' });
    const { view } = await openM6Session(
      { id: 'cs-setup', environmentId: box.id },
      {
        code: { environments: [box] },
        m6: { setup: { 'cs-setup': { status: 'failed', detail: 'npm ci exited 1' } } },
      },
    );
    expect(
      await within(view).findByText(/The environment’s setup script failed: npm ci exited 1/),
    ).toBeTruthy();
    // A container is on the Hub: nothing is marked unavailable.
    expect(within(view).getByRole('button', { name: 'Commit…' })).toHaveProperty('disabled', false);
  });
});
