// Settings → Experimental (FR-202, FR-203; flagged, off by default): scripted tool calls and their
// limits, external coding agents and their adapters. Turning either on asks first; managed policy
// locks them; adapters are added with secrets that are never shown again (and refused when they
// point at another adapter's secrets), must route every permission request to Nova, are checked in
// a Code session's sandbox, turned off, edited (saved secrets kept) and removed after asking.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAdapter, buildAdapterUpdate } from '../src/flagged/AdapterDialog.tsx';
import { ExperimentalSettings, parseLimits } from '../src/flagged/ExperimentalSettings.tsx';
import { failureText, flaggedErrorMessage } from '../src/flagged/format.ts';
import { ApiError } from '../src/api.ts';
import { codeSession } from './fakes-m5-code.ts';
import { adapterView, renderWithWork, scriptRun, type M7WorkState } from './fakes-m7-work.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

const section = (name: string) =>
  screen.getByRole('heading', { name }).closest('section') as HTMLElement;

async function open(
  opts: {
    work?: Partial<M7WorkState>;
    settings?: Record<string, unknown>;
    managed?: Record<string, unknown>;
  } = {},
) {
  const r = await renderWithWork(<ExperimentalSettings />, {
    ...opts,
    sessions: [codeSession({ id: 'cs1', title: 'Parser work' })],
  });
  await screen.findByRole('heading', { name: 'Experimental' });
  return r;
}

describe('scripted tool calls (FR-202)', () => {
  it('turns them on only after asking, then saves limits within bounds', async () => {
    const { hub } = await open();
    const scripts = section('Scripted tool calls');
    expect(within(scripts).queryByLabelText('Time limit (seconds)')).toBeNull();
    await userEvent.click(
      within(scripts).getByRole('switch', { name: 'Let the model call tools from a short script' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Turn on scripted tool calls?' });
    expect(dialog.textContent).toMatch(/nothing a script calls skips the policy/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(hub.api.setSetting).toHaveBeenCalledWith('scripts.enabled', true));
    const seconds = await within(section('Scripted tool calls')).findByLabelText(
      'Time limit (seconds)',
    );
    await userEvent.clear(seconds);
    await userEvent.type(seconds, '60');
    await userEvent.click(
      within(section('Scripted tool calls')).getByRole('button', { name: 'Save limits' }),
    );
    expect(within(section('Scripted tool calls')).getByRole('alert').textContent).toBe(
      'Set the time limit from 0.1 to 30 seconds.',
    );
    await userEvent.clear(seconds);
    await userEvent.type(seconds, '2.5');
    await userEvent.click(
      within(section('Scripted tool calls')).getByRole('button', { name: 'Save limits' }),
    );
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('scripts.limits', {
        cpuMs: 2500,
        memoryMb: 32,
        maxCalls: 20,
        logChars: 20_000,
      }),
    );
  });

  it('locks the switch managed policy sets', async () => {
    await open({ managed: { 'scripts.enabled': false } });
    expect(
      within(section('Scripted tool calls')).getByRole('switch', {
        name: 'Let the model call tools from a short script',
      }),
    ).toHaveProperty('disabled', true);
  });
});

describe('the account’s script runs (FR-202)', () => {
  it('lists every chat’s script runs newest first, a page at a time', async () => {
    const runs = Array.from({ length: 105 }, (_, i) =>
      scriptRun({
        id: `sr${i}`,
        threadId: i % 2 ? 't-a' : 't-b',
        createdAt: new Date(Date.UTC(2026, 9, 1, 12, 0, 0) + i * 60_000).toISOString(),
        errorCode: i === 104 ? 'call_limit' : null,
        status: i === 104 ? 'error' : 'ok',
      }),
    );
    const { api } = await open({
      settings: { 'scripts.enabled': true },
      work: { scriptRuns: runs },
    });
    const list = await screen.findByRole('list', { name: 'Script runs' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(100);
    // Newest first: the last run stopped at the call limit.
    expect(within(list).getAllByRole('listitem')[0]!.textContent).toContain(
      'It made more tool calls than a script may.',
    );
    expect(api.listScriptRuns).toHaveBeenCalledWith({});
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(105));
    expect(api.listScriptRuns).toHaveBeenLastCalledWith({ cursor: 'o:100' });
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says when more runs cannot be loaded', async () => {
    const runs = Array.from({ length: 101 }, (_, i) =>
      scriptRun({
        id: `sr${i}`,
        createdAt: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
      }),
    );
    const { work } = await open({
      settings: { 'scripts.enabled': true },
      work: { scriptRuns: runs },
    });
    await screen.findByRole('list', { name: 'Script runs' });
    work.failNext.listScriptRuns = new Error('Failed to fetch');
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Cannot reach the Hub. Check your connection and try again.',
    );
  });
});

describe('external coding agents (FR-203)', () => {
  it('turns them on only after asking; adapters appear only then', async () => {
    const { hub } = await open();
    const agents = section('External coding agents');
    expect(within(agents).getByText('Turn this on to add adapters.')).toBeTruthy();
    await userEvent.click(
      within(agents).getByRole('switch', { name: 'Let Code sessions delegate to external agents' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Turn on external coding agents?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('externalAgents.enabled', true),
    );
    expect(
      await within(section('External coding agents')).findByText('No adapters yet'),
    ).toBeTruthy();
  });

  it('adds an adapter with a write-only secret, refusing a secret it does not own', async () => {
    const { api, state } = await open({ settings: { 'externalAgents.enabled': true } });
    await userEvent.click(await screen.findByRole('button', { name: 'Add adapter' }));
    const dialog = screen.getByRole('dialog', { name: 'Add an agent adapter' });
    expect(dialog.textContent).toMatch(/An adapter whose agent decides on its own cannot be added/);
    await userEvent.type(within(dialog).getByLabelText('Program'), 'coder acp; rm -rf /');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add adapter' }));
    expect(within(dialog).getByText('Enter a name, up to 64 characters.')).toBeTruthy();
    expect(within(dialog).getByText(/without spaces or shell syntax/)).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Coder');
    await userEvent.clear(within(dialog).getByLabelText('Program'));
    await userEvent.type(within(dialog).getByLabelText('Program'), 'coder-acp');
    await userEvent.type(within(dialog).getByLabelText('Arguments (optional)'), '--acp');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add a variable' }));
    await userEvent.type(within(dialog).getByLabelText('Variable 1 name'), 'CODER_KEY');
    await userEvent.type(
      within(dialog).getByLabelText('Variable 1 value'),
      'secret://agent-adapter/other/env/KEY',
    );
    await userEvent.type(
      within(dialog).getByLabelText('Hosts it may reach (optional)'),
      'api.coder.example',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add adapter' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(
      /A variable points at a secret this adapter does not own/,
    );
    await userEvent.clear(within(dialog).getByLabelText('Variable 1 value'));
    await userEvent.type(within(dialog).getByLabelText('Variable 1 value'), 'sk-live-123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add adapter' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.createAgentAdapter).toHaveBeenLastCalledWith({
      name: 'Coder',
      command: 'coder-acp',
      args: ['--acp'],
      env: { CODER_KEY: 'sk-live-123' },
      network: ['api.coder.example'],
      permissionRouting: 'client',
    });
    const row = await screen.findByRole('listitem', { name: 'Coder' });
    expect(within(row).getByText('Secrets: CODER_KEY')).toBeTruthy();
    // The secret itself never shows.
    expect(document.body.textContent).not.toContain('sk-live-123');
    expect(state.adapters).toHaveLength(1);
  });

  it('checks an adapter in a session’s sandbox and says why a check failed', async () => {
    const a = adapterView({ id: 'ad1', name: 'Coder' });
    const { api, state } = await open({
      settings: { 'externalAgents.enabled': true },
      work: { adapters: [a] },
    });
    const row = await screen.findByRole('listitem', { name: 'Coder' });
    await userEvent.click(within(row).getByRole('button', { name: 'Check…' }));
    let dialog = screen.getByRole('dialog', { name: 'Check Coder' });
    expect(await within(dialog).findByLabelText('In the sandbox of')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Check' }));
    expect((await within(dialog).findByRole('status')).textContent).toBe(
      'The agent answered as coder 1.2, protocol version 1.',
    );
    expect(api.checkAgentAdapter).toHaveBeenCalledWith('ad1', 'cs1');
    state.check = {
      ok: false,
      agent: null,
      protocolVersion: null,
      reason: "this session's environment runs commands without a sandbox (SSH, WSL or a device)",
    };
    await userEvent.click(within(dialog).getByRole('button', { name: 'Check' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('status').textContent).toMatch(
        /where commands have no sandbox/,
      ),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(
      within(screen.getByRole('listitem', { name: 'Coder' })).getByText('Check failed'),
    ).toBeTruthy();
    dialog = screen.getByRole('listitem', { name: 'Coder' });
    expect(within(dialog).getByText(/where commands have no sandbox/)).toBeTruthy();
  });

  it('turns an adapter off, edits it keeping its secret, and removes it after asking', async () => {
    const a = adapterView({ id: 'ad1', name: 'Coder' });
    const { api, state } = await open({
      settings: { 'externalAgents.enabled': true },
      work: { adapters: [a] },
    });
    const row = await screen.findByRole('listitem', { name: 'Coder' });
    await userEvent.click(within(row).getByRole('button', { name: 'Turn off' }));
    await waitFor(() =>
      expect(api.updateAgentAdapter).toHaveBeenCalledWith('ad1', { enabled: false }),
    );
    expect(await within(row).findByText('Off')).toBeTruthy();

    await userEvent.click(within(row).getByRole('button', { name: 'Edit…' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Coder' });
    expect(within(dialog).getByLabelText('Program')).toHaveProperty('disabled', true);
    expect(within(dialog).getByText('Set. Leave empty to keep it.')).toBeTruthy();
    await userEvent.clear(within(dialog).getByLabelText('Name'));
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Coder 2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateAgentAdapter).toHaveBeenLastCalledWith('ad1', { name: 'Coder 2' }),
    );
    expect(state.adapters[0]!.env).toEqual(a.env);

    await userEvent.click(
      within(await screen.findByRole('listitem', { name: 'Coder 2' })).getByRole('button', {
        name: 'Remove…',
      }),
    );
    const confirm = screen.getByRole('dialog', { name: 'Remove Coder 2?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(state.adapters).toHaveLength(0));
    expect(await screen.findByText('No adapters yet')).toBeTruthy();
  });
});

describe('units', () => {
  it('builds adapter bodies and limits as the Hub checks them', () => {
    expect(
      buildAdapter({ name: 'A', command: 'a', args: '', env: [], network: 'bad host!' }),
    ).toEqual({
      errors: { network: 'Enter host names such as api.example.com or *.example.com (up to 20).' },
    });
    const a = adapterView({ id: 'x', env: { K: 'secret://agent-adapter/x/env/K' } });
    expect(
      buildAdapterUpdate(a, {
        name: a.name,
        command: a.command,
        args: a.args.join('\n'),
        env: [{ key: 1, name: 'K', value: '', saved: true }],
        network: a.network.join('\n'),
      }),
    ).toEqual({ body: {} });
    expect(
      buildAdapterUpdate(a, {
        name: a.name,
        command: a.command,
        args: '',
        env: [
          { key: 1, name: 'K', value: '', saved: true },
          { key: 2, name: 'J', value: 'v', saved: false },
        ],
        network: '',
      }),
    ).toEqual({ body: { args: [], env: { K: '', J: 'v' }, network: [] } });
    expect(parseLimits({ seconds: '5', memory: '200', calls: '5', log: '1000' })).toEqual({
      error: 'Set the memory limit from 8 to 128 MB.',
    });
    expect(
      flaggedErrorMessage(
        new ApiError(400, {
          code: 'validation',
          message: 'x',
          retryable: false,
          details: { reason: 'permission_routing' },
        }),
        'agents',
      ),
    ).toMatch(/cannot send its permission requests to Nova/);
    expect(
      flaggedErrorMessage(
        new ApiError(404, {
          code: 'not_found',
          message: 'scripted tool calls are turned off',
          retryable: false,
        }),
        'scripts',
      ),
    ).toBe('Scripted tool calls are off. Turn them on in Settings → Experimental.');
    expect(failureText('refused: something odd')).toBe('Refused: something odd.');
    expect(failureText(null)).toBeNull();
  });
});

describe('the flagged client', () => {
  it('sends each call to its Hub route', async () => {
    const { flaggedApi } = await import('../src/flagged/api.ts');
    const calls: string[] = [];
    const api = flaggedApi(<T,>(method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
      return Promise.resolve({} as T);
    });
    await api.listScriptRuns({ threadId: 't1' });
    await api.listScriptRuns({ limit: 50, cursor: 'c 1' });
    await api.getScriptRun('r1');
    await api.listAgentAdapters();
    await api.createAgentAdapter({ name: 'a', command: 'a', permissionRouting: 'client' });
    await api.updateAgentAdapter('a1', { enabled: false });
    await api.deleteAgentAdapter('a1');
    await api.checkAgentAdapter('a1', 's1');
    await api.listDelegations('s1');
    await api.startDelegation('s1', { adapterId: 'a1', prompt: 'p' });
    await api.getDelegation('d1');
    await api.cancelDelegation('d1');
    expect(calls).toEqual([
      'GET /api/v1/scripts/runs?threadId=t1',
      'GET /api/v1/scripts/runs?limit=50&cursor=c+1',
      'GET /api/v1/scripts/runs/r1',
      'GET /api/v1/agent-adapters',
      'POST /api/v1/agent-adapters {"name":"a","command":"a","permissionRouting":"client"}',
      'PATCH /api/v1/agent-adapters/a1 {"enabled":false}',
      'DELETE /api/v1/agent-adapters/a1',
      'POST /api/v1/agent-adapters/a1/check {"sessionId":"s1"}',
      'GET /api/v1/code/sessions/s1/delegations',
      'POST /api/v1/code/sessions/s1/delegations {"adapterId":"a1","prompt":"p"}',
      'GET /api/v1/delegations/d1',
      'POST /api/v1/delegations/d1/cancel {}',
    ]);
  });
});
