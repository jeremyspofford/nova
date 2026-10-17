import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { codeM6Api, codeM6With, fetchCall } from '../src/code/api-m6.ts';
import { parseCodeExtension } from '../src/code/BudgetBar.tsx';
import { buildCreate } from '../src/code/EnvironmentDialog.tsx';
import { readRefusal } from '../src/code/GitDialogs.tsx';
import {
  checkIcon,
  checkText,
  checkTone,
  connectionSummary,
  costText,
  formatDuration,
  inRepo,
  isBindable,
  isRemoteKind,
  leaseText,
  safeHttpUrl,
  timeText,
  tokensText,
} from '../src/code/m6-format.ts';
import { parseBudgets } from '../src/code/NewSessionDialog.tsx';
import { budget, worktreeView } from './fakes-m6-code.ts';

describe('the M6 Code client (codeM6Api)', () => {
  it('sends each call to its Hub route with its body', async () => {
    const calls: [string, string, unknown][] = [];
    const call = <T,>(method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return Promise.resolve({} as T);
    };
    const api = codeM6Api(call);
    await api.listSavedEnvironments();
    await api.createEnvironment({
      kind: 'container',
      label: 'Box',
      connection: { image: 'node:22' },
    });
    await api.getEnvironment('e 1');
    await api.updateEnvironment('e1', { label: 'B' });
    await api.deleteEnvironment('e1');
    await api.checkEnvironment('e1');
    await api.listEnvironmentProcesses('e1');
    await api.readEnvironmentOutput('e1', 'p/1', 40);
    await api.listWslDistros('d1');
    await api.listEnvironmentDevices();
    await api.listGitHosts();
    await api.createGitHost({ kind: 'github', token: 't' });
    await api.checkGitHost('h1');
    await api.deleteGitHost('h1');
    await api.listWorktrees({ status: 'all' });
    await api.createWorktree({ repo: '/r' });
    await api.renewWorktree('w1');
    await api.renewWorktree('w1', 30);
    await api.releaseWorktree('w1');
    await api.removeWorktree('w1');
    await api.removeWorktree('w1', true);
    await api.getCodeSessionExtras('s1');
    await api.extendCodeBudget('s1', { tokens: 1000 });
    await api.createCodeBranch('s1', 'fix');
    await api.pushCodeSession('s1');
    await api.openPullRequest('s1', { title: 'T' });
    await api.getPullRequest('s1');
    await api.refreshPullRequest('s1');
    await api.listDevServers('s1');
    await api.startDevServer('s1');
    await api.stopDevServer('s1', 'ds1');
    await api.stopAllDevServers('s1');
    await api.listVerifyRuns('s1');
    await api.runVerify('s1');
    await api.getVerifyRun('s1', 'v1');
    await api.askCodeSession('s1', 'why?');
    expect(calls).toEqual([
      ['GET', '/api/v1/environments', undefined],
      [
        'POST',
        '/api/v1/environments',
        { kind: 'container', label: 'Box', connection: { image: 'node:22' } },
      ],
      ['GET', '/api/v1/environments/e%201', undefined],
      ['PATCH', '/api/v1/environments/e1', { label: 'B' }],
      ['DELETE', '/api/v1/environments/e1', undefined],
      ['POST', '/api/v1/environments/e1/check', {}],
      ['GET', '/api/v1/environments/e1/processes', undefined],
      ['GET', '/api/v1/environments/e1/processes/p%2F1/output?offset=40', undefined],
      ['GET', '/api/v1/environments/wsl/distros?deviceId=d1', undefined],
      ['GET', '/api/v1/devices?role=client', undefined],
      ['GET', '/api/v1/code/githosts', undefined],
      ['POST', '/api/v1/code/githosts', { kind: 'github', token: 't' }],
      ['POST', '/api/v1/code/githosts/h1/check', {}],
      ['DELETE', '/api/v1/code/githosts/h1', undefined],
      ['GET', '/api/v1/code/worktrees?status=all', undefined],
      ['POST', '/api/v1/code/worktrees', { repo: '/r' }],
      ['POST', '/api/v1/code/worktrees/w1/renew', {}],
      ['POST', '/api/v1/code/worktrees/w1/renew', { ttlMinutes: 30 }],
      ['POST', '/api/v1/code/worktrees/w1/release', {}],
      ['DELETE', '/api/v1/code/worktrees/w1', undefined],
      ['DELETE', '/api/v1/code/worktrees/w1?force=true', undefined],
      ['GET', '/api/v1/code/sessions/s1/extras', undefined],
      ['POST', '/api/v1/code/sessions/s1/budget/extend', { tokens: 1000 }],
      ['POST', '/api/v1/code/sessions/s1/branch', { name: 'fix' }],
      ['POST', '/api/v1/code/sessions/s1/push', {}],
      ['POST', '/api/v1/code/sessions/s1/pr', { title: 'T' }],
      ['GET', '/api/v1/code/sessions/s1/pr', undefined],
      ['POST', '/api/v1/code/sessions/s1/pr/refresh', {}],
      ['GET', '/api/v1/code/sessions/s1/devservers', undefined],
      ['POST', '/api/v1/code/sessions/s1/devservers', {}],
      ['POST', '/api/v1/code/sessions/s1/devservers/ds1/stop', {}],
      ['POST', '/api/v1/code/sessions/s1/devservers/stop-all', {}],
      ['GET', '/api/v1/code/sessions/s1/verify', undefined],
      ['POST', '/api/v1/code/sessions/s1/verify', {}],
      ['GET', '/api/v1/code/sessions/s1/verify/v1', undefined],
      ['POST', '/api/v1/code/sessions/s1/ask', { question: 'why?' }],
    ]);
  });

  it('sends requests itself until the app client has the methods, with ApiError on failure', async () => {
    const fetchImpl = vi.fn((path: string, init?: RequestInit) =>
      Promise.resolve(
        path.endsWith('/environments')
          ? new Response(JSON.stringify({ items: [] }), { status: 200 })
          : new Response(
              JSON.stringify({
                error: { code: 'conflict', message: 'in use', retryable: false },
              }),
              { status: 409, statusText: 'Conflict' },
            ),
      ).then((r) => {
        void init;
        return r;
      }),
    );
    const own = { listGitHosts: vi.fn(() => Promise.resolve({ items: ['own'] })) };
    const api = codeM6With(own, fetchImpl as unknown as typeof fetch);
    expect(await api.listGitHosts()).toEqual({ items: ['own'] });
    expect(await api.listSavedEnvironments()).toEqual({ items: [] });
    const err = await api.deleteEnvironment('e1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).body.message).toBe('in use');
    const [, init] = fetchImpl.mock.calls[1]!;
    expect(init).toMatchObject({ method: 'DELETE', credentials: 'same-origin' });

    // A failed response without a body still becomes an ApiError.
    const bare = fetchCall(() =>
      Promise.resolve(new Response('oops', { status: 502, statusText: 'Bad Gateway' })),
    );
    const e2 = await bare('GET', '/x').catch((e: unknown) => e);
    expect((e2 as ApiError).body).toMatchObject({ code: 'server_error', message: 'Bad Gateway' });
    // A body is sent as JSON.
    const seen: RequestInit[] = [];
    const json = fetchCall((_p, init) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    await json('POST', '/y', { a: 1 });
    expect(seen[0]).toMatchObject({
      body: '{"a":1}',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
    });
  });
});

describe('M6 Code wording and rules', () => {
  it('says where an environment connects, never a secret', () => {
    const name = (id: string) => (id === 'd1' ? 'Gaming PC' : id);
    expect(connectionSummary({ kind: 'local' }, name)).toBe('The Hub itself');
    expect(
      connectionSummary({ kind: 'container', image: 'node:22', setupScript: 'npm ci' }, name),
    ).toBe('Image node:22, with a setup script');
    expect(
      connectionSummary(
        {
          kind: 'ssh',
          host: 'h',
          port: 22,
          user: 'u',
          auth: 'key',
          hostKey: null,
          root: null,
          hasCredential: true,
        },
        name,
      ),
    ).toBe('u@h');
    expect(connectionSummary({ kind: 'wsl', deviceId: 'd1', distro: 'Ubuntu' }, name)).toBe(
      'Ubuntu on Gaming PC',
    );
    expect(connectionSummary({ kind: 'device', deviceId: 'd1', root: '/src' }, name)).toBe(
      'Gaming PC in /src',
    );
    expect(isRemoteKind('ssh')).toBe(true);
    expect(isRemoteKind('container')).toBe(false);
    expect(isRemoteKind(null)).toBe(false);
  });

  it('names CI check states', () => {
    expect(checkText({ status: 'queued', conclusion: null })).toBe('Queued');
    expect(checkText({ status: 'completed', conclusion: 'timed_out' })).toBe('Timed out');
    expect(checkText({ status: 'completed', conclusion: 'weird_thing' })).toBe('weird thing');
    expect(checkTone({ status: 'completed', conclusion: 'skipped' })).toBe('ok');
    expect(checkTone({ status: 'running', conclusion: null })).toBe('warn');
    expect(checkIcon({ status: 'queued', conclusion: null })).toBe('clock');
    expect(checkIcon({ status: 'completed', conclusion: 'failure' })).toBe('stop');
  });

  it('describes leases and which worktrees a session can bind', () => {
    const now = Date.parse('2026-10-02T10:00:00Z');
    const who = () => '“S”';
    expect(leaseText(worktreeView({ status: 'removed' }), who, now)).toBe('Removed from disk');
    expect(
      leaseText(worktreeView({ leasedBy: 's', leaseExpiresAt: '2026-10-02T09:00:00Z' }), who, now),
    ).toBe('Lease to “S” has ended');
    expect(isBindable(worktreeView(), now)).toBe(true);
    expect(isBindable(worktreeView({ leasedBy: 's' }), now)).toBe(false);
    expect(
      isBindable(worktreeView({ leasedBy: 's', leaseExpiresAt: '2026-10-02T09:00:00Z' }), now),
    ).toBe(true);
    expect(isBindable(worktreeView({ status: 'removed' }), now)).toBe(false);
    expect(inRepo('/a/b/c', '/a/b/')).toBe(true);
    expect(inRepo('/a/bc', '/a/b')).toBe(false);
  });

  it('formats budgets, durations and links', () => {
    const b = budget({ used: { timeSeconds: 600, tokens: 1500, costUsd: 0.5 } });
    expect([timeText(b), tokensText(b), costText(b)]).toEqual([
      '10 min used',
      '1.5K used',
      '$0.50 used',
    ]);
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(4200)).toBe('4.2 s');
    expect(formatDuration(65_000)).toBe('1 min 5 s');
    expect(formatDuration(120_000)).toBe('2 min');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl('https://x.test/a')).toBe('https://x.test/a');
  });

  it('checks budget amounts the Hub would refuse', () => {
    expect(parseCodeExtension({ minutes: '', tokens: '', cost: '' })).toEqual({
      error: 'Add time, tokens or cost.',
    });
    expect(parseCodeExtension({ minutes: '1.5', tokens: '', cost: '' })).toHaveProperty('error');
    expect(parseCodeExtension({ minutes: '', tokens: '', cost: '0.001' })).toHaveProperty('error');
    expect(parseCodeExtension({ minutes: '5', tokens: '2000', cost: '1.5' })).toEqual({
      body: { timeSeconds: 300, tokens: 2000, costUsd: 1.5 },
    });
    expect(parseBudgets({ minutes: '', tokens: '', cost: '' })).toEqual({ budgets: null });
    expect(parseBudgets({ minutes: '', tokens: '999', cost: '' })).toHaveProperty('error');
    expect(parseBudgets({ minutes: '', tokens: '', cost: 'x' })).toHaveProperty('error');
    expect(parseBudgets({ minutes: '', tokens: '', cost: '2' })).toEqual({
      budgets: { costUsd: 2 },
    });
  });

  it('builds environment requests and names each refused field', () => {
    const base = {
      kind: 'container' as const,
      label: '',
      image: 'Not An Image!',
      setupScript: '',
      host: '',
      port: '22',
      user: '',
      auth: 'key' as const,
      privateKey: '',
      passphrase: '',
      password: '',
      hostKey: '',
      root: '',
      deviceId: '',
      distro: '',
    };
    const bad = buildCreate(base);
    expect('errors' in bad && bad.errors).toMatchObject({
      label: 'Enter a name, up to 100 characters.',
      image: expect.stringMatching(/lowercase/),
    });
    const ssh = buildCreate({
      ...base,
      kind: 'ssh',
      label: 'B',
      host: 'h',
      user: 'u',
      auth: 'password',
      port: '0',
      root: 'rel',
    });
    expect('errors' in ssh && ssh.errors).toMatchObject({
      port: 'Enter a port from 1 to 65535.',
      root: 'Enter a full path that starts with /.',
      password: 'Enter the password.',
    });
    const dev = buildCreate({ ...base, kind: 'device', label: 'D' });
    expect('errors' in dev && dev.errors).toMatchObject({ deviceId: 'Choose a device.' });
    expect(buildCreate({ ...base, label: 'Box', image: 'node:22', setupScript: 'npm ci' })).toEqual(
      {
        body: {
          kind: 'container',
          label: 'Box',
          connection: { image: 'node:22', setupScript: 'npm ci' },
        },
      },
    );
  });

  it('reads what a refused push said', () => {
    const e = (details: Record<string, unknown>, message = 'refused') =>
      new ApiError(403, { code: 'policy_denied', message, retryable: false, details });
    expect(
      readRefusal(e({ reason: 'confirmation_required', branch: 'main', default: true }), 'x'),
    ).toEqual({
      kind: 'confirm',
      guard: { branch: 'main', protected: false, default: true },
    });
    expect(
      readRefusal(
        e({
          reason: 'secrets_found',
          findings: [{ path: 'a', line: 2, rule: 'r', preview: 'p' }, null],
        }),
        'x',
      ),
    ).toEqual({
      kind: 'secrets',
      findings: [
        { path: 'a', line: 2, rule: 'r', preview: 'p' },
        { path: '', line: 0, rule: '', preview: '' },
      ],
    });
    expect(
      readRefusal(e({ reason: 'push_failed', output: 'rejected' }, 'the push failed'), 'x'),
    ).toEqual({
      kind: 'failed',
      message: 'the push failed',
      output: 'rejected',
    });
    expect(readRefusal(e({ reason: 'remote_environment' }), 'x')).toMatchObject({ kind: 'other' });
    expect(readRefusal(e({ reason: 'detached_head' }), 'x')).toEqual({
      kind: 'other',
      message: 'HEAD is detached. Commit on a branch first.',
    });
    expect(readRefusal(new Error('boom'), 'x')).toEqual({ kind: 'other', message: 'boom' });
  });
});
