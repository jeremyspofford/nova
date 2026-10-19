// A Code session in M7 (FR-213, FR-212, FR-073, FR-108): Hand off… (targets: another environment
// with its folder, a worktree on the Hub; the move followed to its end; a refusal in plain words;
// the Moves history), Best of N… (2-4 attempts with budgets and models; compared side by side;
// applied, with a conflict offering markers; discarded), Merge in… (refused conflicts with their
// three sides; markers resolved or aborted), a session on another machine (diff, review, commit
// and branches work there now; push, pull requests, Best of N do not), and a cloud session (its
// run's usage, its files from the runner). The flagged tabs appear only while their flags are on.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { attemptModels } from '../src/code/AttemptsPane.tsx';
import { folderPlaceholder } from '../src/code/HandoffDialog.tsx';
import { attemptsUnavailable } from '../src/code/SessionM7.tsx';
import { HANDOFF_REASON, codeM7ErrorMessage, handoffReasonText } from '../src/code/m7-format.ts';
import { ApiError } from '../src/api.ts';
import { emitCode } from './code-helpers.tsx';
import { codeSession } from './fakes-m5-code.ts';
import { savedEnvironment, worktreeView } from './fakes-m6-code.ts';
import {
  attemptSet,
  cloudEnv,
  cloudRun,
  conflictView,
  handoffView,
  mergeView,
  openM7Session,
  runnerOn,
  settleHandoff,
} from './fakes-m7-work.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const tab = (name: string | RegExp) => screen.getByRole('tab', { name });
const panel = (name: string) => screen.getByRole('tabpanel', { name });

describe('Hand off (FR-213)', () => {
  it('moves the session to another environment and follows the move to a refusal', async () => {
    const ssh = savedEnvironment({ id: 'env-ssh', kind: 'ssh', label: 'Build box' });
    const local = savedEnvironment({ id: 'env-local', kind: 'local', label: 'This Hub' });
    const { view, workApi, state } = await openM7Session(
      { id: 'cs1', environmentId: 'env-local' },
      { code: { environments: [local, ssh] } },
    );
    await userEvent.click(within(view).getByRole('button', { name: 'Hand off…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hand off this session' });
    expect(within(dialog).getByRole('radio', { name: /A new worktree/ })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move session' }));
    expect(within(dialog).getByText('Choose an environment.')).toBeTruthy();
    expect(workApi.handoffCodeSession).not.toHaveBeenCalled();
    await userEvent.selectOptions(within(dialog).getByLabelText('Environment'), 'env-ssh');
    await userEvent.type(
      within(dialog).getByLabelText('Repository folder on Build box'),
      '/srv/app',
    );
    await userEvent.click(within(dialog).getByRole('radio', { name: /Clean them up here/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move session' }));
    await waitFor(() =>
      expect(workApi.handoffCodeSession).toHaveBeenCalledWith('cs1', {
        to: { environmentId: 'env-ssh', folder: '/srv/app' },
        source: 'clean',
      }),
    );
    const progress = await screen.findByRole('dialog', { name: 'Moving the session' });
    expect(within(progress).getByText('Waiting for the running turn to end.')).toBeTruthy();

    const moved = settleHandoff(state, state.handoffs[0]!.id, 'refused', 'target_dirty');
    emitCode('session.handedOff', { handoffId: moved.id, sessionId: 'cs1', status: 'refused' });
    const done = await screen.findByRole('dialog', { name: 'The session did not move' });
    expect(done.textContent).toContain(HANDOFF_REASON.target_dirty);
    expect(done.textContent).toContain('The session stayed where it was.');
    await userEvent.click(within(done).getByRole('button', { name: 'Close' }));

    await userEvent.click(tab('Moves'));
    const moves = await within(panel('Moves')).findByRole('list', { name: 'Moves' });
    const row = within(moves).getAllByRole('listitem')[0]!;
    expect(within(row).getByText('Refused')).toBeTruthy();
    expect(row.textContent).toContain(HANDOFF_REASON.target_dirty);
  });

  it('says why the Hub refuses the request, and offers worktree moves only on the Hub', async () => {
    const ssh = savedEnvironment({ id: 'env-ssh', kind: 'ssh', label: 'Build box' });
    const { view, workApi } = await openM7Session(
      { id: 'cs2', environmentId: 'env-ssh', folder: { path: '/srv/app', projectFolderId: null } },
      { code: { environments: [ssh] }, work: { remoteSessions: ['cs2'] } },
    );
    await userEvent.click(within(view).getByRole('button', { name: 'Hand off…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hand off this session' });
    expect(within(dialog).queryByRole('radio', { name: /A new worktree/ })).toBeNull();
    await userEvent.selectOptions(within(dialog).getByLabelText('Environment'), 'env-ssh');
    await userEvent.type(
      within(dialog).getByLabelText('Repository folder on Build box'),
      '/srv/app',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move session' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The session already works there.',
    );
    expect(workApi.handoffCodeSession).toHaveBeenCalledTimes(1);
  });

  it('moves into a new worktree and reloads the session when it completed', async () => {
    const { view, workApi, state, hub } = await openM7Session({ id: 'cs3' });
    await userEvent.click(within(view).getByRole('button', { name: 'Hand off…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hand off this session' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /A new worktree/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Move session' }));
    await waitFor(() =>
      expect(workApi.handoffCodeSession).toHaveBeenCalledWith('cs3', {
        to: { worktree: 'new' },
        source: 'keep',
      }),
    );
    const calls = (hub.api.getCodeSession as { mock: { calls: unknown[] } }).mock.calls.length;
    const moved = settleHandoff(state, state.handoffs[0]!.id, 'completed');
    emitCode('session.handedOff', { handoffId: moved.id, sessionId: 'cs3', status: 'completed' });
    const done = await screen.findByRole('dialog', { name: 'Session moved' });
    expect(done.textContent).toContain('Branch feature/x, commit abc1234');
    await waitFor(() =>
      expect(
        (hub.api.getCodeSession as { mock: { calls: unknown[] } }).mock.calls.length,
      ).toBeGreaterThan(calls),
    );
  });
});

describe('Best of N (FR-212)', () => {
  it('starts attempts from the header with budgets and a model for one of them', async () => {
    const { view, workApi } = await openM7Session({ id: 'cs4', model: 'openai/gpt-x' });
    await userEvent.click(within(view).getByRole('button', { name: 'Best of N…' }));
    expect(tab('Attempts').getAttribute('aria-selected')).toBe('true');
    const dialog = await screen.findByRole('dialog', { name: 'Best of N' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Start 2 attempts/ }));
    expect(within(dialog).getByText('Describe the task every attempt works on.')).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('The task'), 'Make the parser faster');
    await userEvent.selectOptions(within(dialog).getByLabelText('Attempts'), '3');
    // The default budget comes from Settings → Code (30 minutes each).
    expect(within(dialog).getByLabelText<HTMLInputElement>('Time (minutes)').value).toBe('30');
    await userEvent.click(within(dialog).getByRole('button', { name: /Start 3 attempts/ }));
    await waitFor(() =>
      expect(workApi.startAttempts).toHaveBeenCalledWith('cs4', {
        objective: 'Make the parser faster',
        count: 3,
        budgets: { timeSeconds: 1800 },
      }),
    );
    const group = await within(panel('Attempts')).findByRole('group', {
      name: 'Attempts side by side',
    });
    expect(
      within(group)
        .getAllByRole('heading')
        .map((h) => h.textContent),
    ).toEqual(['Attempt 1', 'Attempt 2', 'Attempt 3']);
    expect(within(group).getAllByText('Working')).toHaveLength(3);
  });

  it('compares attempts and applies one; a conflict writes nothing and offers markers', async () => {
    const set = attemptSet({ id: 'set1', sessionId: 'cs5' });
    const { view, workApi, state } = await openM7Session(
      { id: 'cs5' },
      { work: { attemptSets: [set], conflicts: [conflictView()] } },
    );
    await userEvent.click(tab('Attempts'));
    const group = await within(panel('Attempts')).findByRole('group', {
      name: 'Attempts side by side',
    });
    const first = within(group).getByRole('region', { name: 'Attempt 1' });
    expect(within(first).getByText('All checks passed')).toBeTruthy();
    expect(within(first).getByText('$0.12, 12K tokens, 5 min')).toBeTruthy();
    expect(
      within(within(group).getByRole('region', { name: 'Attempt 2' })).getByText('Checks failed'),
    ).toBeTruthy();
    await userEvent.click(within(first).getByText('The patch'));
    expect(within(first).getByLabelText('Attempt 1’s patch').textContent).toContain('+new 0');

    await userEvent.click(within(first).getByRole('button', { name: 'Apply…' }));
    const confirm = screen.getByRole('dialog', { name: 'Apply attempt 1?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Apply' }));
    const notice = await within(panel('Attempts')).findByRole('alert');
    expect(notice.textContent).toMatch(
      /Attempt 1 conflicts with this session’s files \(src\/app\.ts\), so nothing was written/,
    );
    expect(state.merges[0]!.status).toBe('refused');
    await userEvent.click(
      within(notice).getByRole('button', { name: 'Apply with conflict markers' }),
    );
    await waitFor(() =>
      expect(workApi.applyAttempt).toHaveBeenLastCalledWith('set1', {
        attemptId: set.attempts[0]!.id,
        onConflict: 'markers',
      }),
    );
    // The conflicts are to be resolved in the Merges tab.
    await waitFor(() => expect(tab('Merges').getAttribute('aria-selected')).toBe('true'));
    expect(await within(panel('Merges')).findByText('Conflicts to resolve')).toBeTruthy();
    expect(view).toBeTruthy();
  });

  it('discards every attempt after asking', async () => {
    const set = attemptSet({ id: 'set2', sessionId: 'cs6' });
    const { workApi } = await openM7Session({ id: 'cs6' }, { work: { attemptSets: [set] } });
    await userEvent.click(tab('Attempts'));
    await userEvent.click(
      await within(panel('Attempts')).findByRole('button', { name: 'Discard all…' }),
    );
    const confirm = screen.getByRole('dialog', { name: 'Discard every attempt?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Discard all' }));
    await waitFor(() => expect(workApi.discardAttempts).toHaveBeenCalledWith('set2'));
    expect((await within(panel('Attempts')).findAllByText('Discarded')).length).toBe(3);
    expect(within(panel('Attempts')).queryByRole('button', { name: 'Apply…' })).toBeNull();
  });
});

describe('Merges (FR-073)', () => {
  it('shows a refused merge with its three sides, then resolves a merge with markers', async () => {
    const other = codeSession({ id: 'cs-w', title: 'Worker', threadId: 't-cs-w' });
    const { workApi, state } = await openM7Session(
      { id: 'cs7' },
      { others: [other], work: { conflicts: [conflictView()], markersLeft: ['src/app.ts'] } },
    );
    await userEvent.click(tab('Merges'));
    const pane = panel('Merges');
    expect(await within(pane).findByText('No merges yet')).toBeTruthy();
    await userEvent.click(within(pane).getByRole('button', { name: 'Merge in…' }));
    let dialog = await screen.findByRole('dialog', { name: 'Merge into this session' });
    await userEvent.selectOptions(await within(dialog).findByLabelText('Session'), 'cs-w');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect((await within(pane).findByRole('status')).textContent).toMatch(
      /Nothing was written: 1 file conflicts with this session \(src\/app\.ts\)/,
    );
    const sides = await within(pane).findByRole('region', { name: 'src/app.ts' });
    expect(within(sides).getByLabelText('src/app.ts: Base').textContent).toBe('const a = 1;\n');
    expect(within(sides).getByLabelText('src/app.ts: This session').textContent).toBe(
      'const a = 2;\n',
    );
    expect(within(sides).getByLabelText('src/app.ts: The work').textContent).toBe('const a = 3;\n');

    await userEvent.click(
      within(pane).getByRole('button', { name: 'Merge with conflict markers' }),
    );
    await waitFor(() =>
      expect(workApi.mergeIntoSession).toHaveBeenLastCalledWith(
        'cs7',
        { sessionId: 'cs-w' },
        'markers',
      ),
    );
    await userEvent.click(await within(pane).findByRole('button', { name: 'Mark resolved' }));
    expect((await within(pane).findByRole('alert')).textContent).toBe(
      'Conflict markers are still in src/app.ts. Edit them out, then try again.',
    );
    state.markersLeft = [];
    await userEvent.click(within(pane).getByRole('button', { name: 'Mark resolved' }));
    expect(await within(pane).findByText('Resolved')).toBeTruthy();
    dialog = pane;
    expect(dialog).toBeTruthy();
  });

  it('aborts a conflicted merge after asking, and asks the agent to resolve', async () => {
    const m = mergeView({
      sessionId: 'cs8',
      status: 'conflicted',
      files: [{ path: 'src/app.ts', result: 'conflict', conflicts: 2 }],
      conflicts: [conflictView()],
    });
    const { workApi, hub } = await openM7Session({ id: 'cs8' }, { work: { merges: [m] } });
    await userEvent.click(tab('Merges'));
    const pane = panel('Merges');
    await userEvent.click(
      await within(pane).findByRole('button', { name: 'Ask the agent to resolve' }),
    );
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenCalledWith('t-cs8', {
        text: expect.stringContaining('Resolve the merge conflicts in src/app.ts') as string,
      }),
    );
    await userEvent.click(within(pane).getByRole('button', { name: 'Abort merge…' }));
    const confirm = screen.getByRole('dialog', { name: 'Abort this merge?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Abort merge' }));
    await waitFor(() => expect(workApi.abortMerge).toHaveBeenCalledWith('cs8', m.id));
    expect(await within(pane).findByText('Aborted')).toBeTruthy();
  });

  it('merges a patch, checking the base commit', async () => {
    const { workApi } = await openM7Session({ id: 'cs9' });
    await userEvent.click(tab('Merges'));
    await userEvent.click(within(panel('Merges')).getByRole('button', { name: 'Merge in…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge into this session' });
    await userEvent.click(within(dialog).getByRole('radio', { name: /A patch/ }));
    await userEvent.type(within(dialog).getByLabelText('Patch'), 'diff --git a/x b/x');
    await userEvent.type(within(dialog).getByLabelText('Made against commit (optional)'), 'xyz');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    expect(within(dialog).getByText(/Enter a commit hash/)).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText('Made against commit (optional)'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() =>
      expect(workApi.mergeIntoSession).toHaveBeenCalledWith(
        'cs9',
        { patch: 'diff --git a/x b/x' },
        'refuse',
      ),
    );
    const merges = await within(panel('Merges')).findByRole('list', { name: 'Merges' });
    expect(within(merges).getByRole('listitem', { name: 'A patch, Merged' })).toBeTruthy();
  });
});

describe('sessions on another machine and in the cloud', () => {
  it('captures diff, review, commit and branches remotely; push, PRs and Best of N stay on the Hub', async () => {
    const ssh = savedEnvironment({ id: 'env-ssh', kind: 'ssh', label: 'Build box' });
    const { view } = await openM7Session(
      { id: 'cs10', environmentId: 'env-ssh' },
      { code: { environments: [ssh] }, work: { remoteSessions: ['cs10'] } },
    );
    const note = await within(view).findByRole('note');
    expect(note.textContent).toMatch(/Go to symbol, push, pull requests, dev servers, Best of N/);
    for (const name of ['Review', 'Commit…', 'Branch…'])
      expect(within(view).getByRole('button', { name })).toHaveProperty('disabled', false);
    for (const name of ['Push…', 'Pull request…', 'Best of N…'])
      expect(within(view).getByRole('button', { name })).toHaveProperty('disabled', true);
    await userEvent.click(tab('Attempts'));
    expect(
      within(panel('Attempts')).getByText(
        'Best of N needs the session’s folder on the Hub, where its worktrees are.',
      ),
    ).toBeTruthy();
  });

  it('shows a cloud session’s run and its files from the runner', async () => {
    const env = savedEnvironment({ id: 'cenv', kind: 'cloud', label: 'App env' });
    const { view } = await openM7Session(
      {
        id: 'cs11',
        environmentId: 'cenv',
        threadId: 't-cs11',
        folder: { path: '/workspace/app', projectFolderId: null },
      },
      {
        code: { environments: [env] },
        work: {
          runner: runnerOn(),
          envs: [cloudEnv({ id: 'cenv', label: 'App env' })],
          runs: [cloudRun({ id: 'r1', environmentId: 'cenv', threadId: 't-cs11', kind: 'code' })],
          files: {
            cenv: {
              '/workspace/app': {
                kind: 'dir',
                path: '/workspace/app',
                entries: [{ name: 'package.json', kind: 'file', size: 300 }],
                truncated: false,
              },
            },
          },
        },
      },
    );
    expect(await within(view).findByRole('heading', { name: 'Cloud run on App env' })).toBeTruthy();
    await userEvent.click(tab('File'));
    expect(
      await within(panel('File')).findByRole('list', { name: 'Files in /workspace/app' }),
    ).toBeTruthy();
  });
});

describe('flagged tabs', () => {
  it('shows Agents and Scripts only while their features are on', async () => {
    await openM7Session({ id: 'cs12' });
    expect(screen.queryByRole('tab', { name: 'Agents' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Scripts' })).toBeNull();
    resetDom();
    await openM7Session(
      { id: 'cs13' },
      { settings: { 'externalAgents.enabled': true, 'scripts.enabled': true } },
    );
    expect(tab('Agents')).toBeTruthy();
    expect(tab('Scripts')).toBeTruthy();
  });
});

describe('units', () => {
  it('words and checks', () => {
    expect(handoffReasonText(handoffView({ status: 'completed' }))).toBeNull();
    expect(handoffReasonText(handoffView({ status: 'failed', reason: null }))).toBe(
      HANDOFF_REASON.failed,
    );
    expect(
      codeM7ErrorMessage(
        new ApiError(409, {
          code: 'conflict',
          message: 'x',
          retryable: false,
          details: { reason: 'attempts_settled' },
        }),
      ),
    ).toBe('These attempts were already applied or discarded.');
    expect(attemptModels(['', 'b'], null)).toEqual({
      error: 'Pick a model for attempt 1 too, or leave every attempt on the session’s model.',
    });
    expect(attemptModels(['', 'b'], 'a')).toEqual({ models: ['a', 'b'] });
    expect(attemptModels(['', ''], null)).toEqual({ models: [] });
    expect(folderPlaceholder('cloud')).toBe('/workspace/app');
    expect(attemptsUnavailable(codeSession({ repo: null }), false)).toBe(
      'This folder is not a Git repository.',
    );
    expect(worktreeView()).toBeTruthy();
  });
});

describe('the M7 Code client', () => {
  it('sends each call to its Hub route', async () => {
    const { codeM7Api } = await import('../src/code/api-m7.ts');
    const calls: string[] = [];
    const api = codeM7Api(<T,>(method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
      return Promise.resolve({} as T);
    });
    await api.handoffCodeSession('s1', { to: { worktree: 'new' } });
    await api.listCodeHandoffs('s1');
    await api.getHandoff('h1');
    await api.handoffThread('t1', 'd1', true);
    await api.mergeIntoSession('s1', { sessionId: 's2' });
    await api.listMerges('s1');
    await api.getMerge('s1', 'm1');
    await api.resolveMerge('s1', 'm1');
    await api.abortMerge('s1', 'm1');
    await api.startAttempts('s1', { objective: 'o' });
    await api.listAttempts('s1');
    await api.getAttempts('a1');
    await api.applyAttempt('a1', { attemptId: 'x' });
    await api.discardAttempts('a1');
    expect(calls).toEqual([
      'POST /api/v1/code/sessions/s1/handoff {"to":{"worktree":"new"}}',
      'GET /api/v1/code/sessions/s1/handoffs',
      'GET /api/v1/handoffs/h1',
      'POST /api/v1/threads/t1/handoff {"to":{"deviceId":"d1"},"interrupt":true}',
      'POST /api/v1/code/sessions/s1/merge {"from":{"sessionId":"s2"},"onConflict":"refuse"}',
      'GET /api/v1/code/sessions/s1/merges',
      'GET /api/v1/code/sessions/s1/merges/m1',
      'POST /api/v1/code/sessions/s1/merges/m1/resolve {}',
      'POST /api/v1/code/sessions/s1/merges/m1/abort {}',
      'POST /api/v1/code/sessions/s1/attempts {"objective":"o"}',
      'GET /api/v1/code/sessions/s1/attempts',
      'GET /api/v1/code/attempts/a1',
      'POST /api/v1/code/attempts/a1/apply {"attemptId":"x"}',
      'POST /api/v1/code/attempts/a1/discard {}',
    ]);
  });
});
