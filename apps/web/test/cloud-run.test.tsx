// A cloud run (FR-108, FR-116): its usage against its caps, live from `cloud.run.usage`, the
// warning past the warning share, the stop at a cap with Raise caps (checked against what it used;
// a capped run with room is active again), Cancel (asks first), Keep a file in its thread (needs a
// path under /workspace), the Hub refusing caps on an ended run, and a thread's run (none yet).
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCapMinutes } from '../src/cloud/CloudRunCard.tsx';
import { CloudSettings } from '../src/cloud/CloudSettings.tsx';
import { ThreadCloudRun } from '../src/cloud/ThreadCloudRun.tsx';
import { formatBytes, formatSeconds, usageLines } from '../src/cloud/format.ts';
import { FakeEventSource } from './fakes.ts';
import { codeSession } from './fakes-m5-code.ts';
import { cloudEnv, cloudRun, renderWithWork, runnerOn, type M7WorkState } from './fakes-m7-work.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');
const card = () => screen.getByRole('region', { name: /^Cloud run/ });

async function openRun(work: Partial<M7WorkState>, id = 'r1') {
  window.history.replaceState(null, '', `/settings/cloud?run=${id}`);
  const session = codeSession({ id: 'cs1', threadId: 't-cs1', title: 'Parser work' });
  const r = await renderWithWork(<CloudSettings />, {
    work: { runner: runnerOn(), envs: [cloudEnv({ id: 'cenv', label: 'App env' })], ...work },
    sessions: [session],
  });
  await screen.findByRole('heading', { name: /^Cloud run/ });
  return r;
}

describe('a cloud run (FR-116)', () => {
  it('follows usage live, warns near a cap, and stops at one with Raise caps', async () => {
    const { api } = await openRun({
      runs: [
        cloudRun({
          id: 'r1',
          environmentId: 'cenv',
          kind: 'code',
          threadId: 't-cs1',
          sessionId: 'cs1',
        }),
      ],
    });
    expect(await screen.findByRole('heading', { name: 'Cloud run on App env' })).toBeTruthy();
    expect(within(card()).getByText('10 min of 1 h')).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Parser work' })).toBeTruthy();
    stream().emit(
      'cloud.run.usage',
      {
        cloudRunId: 'r1',
        usage: { cpuSeconds: 3000, wallSeconds: 1300, commands: 9 },
        caps: { cpuSeconds: 3600, wallSeconds: 14_400 },
      },
      't-cs1',
    );
    expect(await within(card()).findByText('Near the cap (83 %)')).toBeTruthy();
    expect(within(card()).getByRole('status').textContent).toMatch(/Near its CPU time cap/);
    expect(within(card()).getByText('9 commands')).toBeTruthy();
    expect(api.getCloudRun).toHaveBeenCalledTimes(1);
  });

  it('raises the caps of a capped run, checking them against what it used', async () => {
    const { api, state } = await openRun({
      runs: [
        cloudRun({
          id: 'r1',
          environmentId: 'cenv',
          status: 'capped',
          reason: 'cpu',
          usage: { cpuSeconds: 3600, wallSeconds: 4000, commands: 3 },
        }),
      ],
    });
    expect(within(card()).getByRole('alert').textContent).toMatch(
      /Stopped at its CPU time cap\. Its work is kept/,
    );
    expect(within(card()).getByText('Stopped at this cap')).toBeTruthy();
    await userEvent.click(within(card()).getByRole('button', { name: 'Raise caps…' }));
    const dialog = screen.getByRole('dialog', { name: 'Raise the caps of this run' });
    const cpu = within(dialog).getByLabelText('CPU time cap (minutes)');
    await userEvent.clear(cpu);
    await userEvent.type(cpu, '30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Raise caps' }));
    expect(
      within(dialog).getByText(/The run has used 1 h of CPU time; set a cap above that\./),
    ).toBeTruthy();
    expect(api.setCloudRunCaps).not.toHaveBeenCalled();
    await userEvent.clear(cpu);
    await userEvent.type(cpu, '120');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Raise caps' }));
    await waitFor(() =>
      expect(api.setCloudRunCaps).toHaveBeenCalledWith('r1', {
        cpuSeconds: 7200,
        wallSeconds: 28_800,
      }),
    );
    expect(state.runs[0]!.status).toBe('active');
    expect(await within(card()).findByText('Running')).toBeTruthy();
  });

  it('cancels after asking; the Hub refuses caps on an ended run', async () => {
    const { api, state } = await openRun({
      runs: [cloudRun({ id: 'r1', environmentId: 'cenv', threadId: 't-x' })],
    });
    await userEvent.click(within(card()).getByRole('button', { name: 'Raise caps…' }));
    state.runs = state.runs.map((r) => ({ ...r, status: 'completed' }));
    const dialog = screen.getByRole('dialog', { name: 'Raise the caps of this run' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Raise caps' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe('This run has ended.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    state.runs = state.runs.map((r) => ({ ...r, status: 'active' }));

    await userEvent.click(within(card()).getByRole('button', { name: 'Cancel run…' }));
    const confirm = screen.getByRole('dialog', { name: 'Cancel this cloud run?' });
    expect(api.cancelCloudRun).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(api.cancelCloudRun).toHaveBeenCalledWith('r1'));
    expect(await within(card()).findByText('Cancelled')).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: 'Cancel run…' })).toBeNull();
  });

  it('keeps a file of the run in its thread', async () => {
    const { api, hub } = await openRun({
      runs: [cloudRun({ id: 'r1', environmentId: 'cenv', threadId: 't-x' })],
    });
    await userEvent.click(within(card()).getByRole('button', { name: 'Keep a file…' }));
    const dialog = screen.getByRole('dialog', { name: 'Keep a file from the runner' });
    await userEvent.type(within(dialog).getByLabelText('File on the runner'), '/etc/passwd');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep file' }));
    expect(within(dialog).getByText('Files on the runner are under /workspace.')).toBeTruthy();
    const path = within(dialog).getByLabelText('File on the runner');
    await userEvent.clear(path);
    await userEvent.type(path, '/workspace/app/report.html');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Keep file' }));
    await waitFor(() =>
      expect(api.collectCloudArtifact).toHaveBeenCalledWith('r1', {
        path: '/workspace/app/report.html',
      }),
    );
    expect(await screen.findByText('Kept report.html in the thread’s artifacts.')).toBeTruthy();
    expect(hub.state.m3.artifacts.map((a) => a.title)).toEqual(['report.html']);
  });

  it('shows a run that cannot be loaded with Retry', async () => {
    window.history.replaceState(null, '', '/settings/cloud?run=nope');
    await renderWithWork(<CloudSettings />, { work: { runner: runnerOn() } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('It no longer exists.');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

describe('a thread’s cloud run', () => {
  it('says when there is none yet, then shows the run once one starts', async () => {
    const { state } = await renderWithWork(
      <ThreadCloudRun threadId="t1" environmentLabel="App env" />,
      {
        work: { runner: runnerOn() },
      },
    );
    expect(await screen.findByText(/No cloud run yet\. The first command starts one/)).toBeTruthy();
    state.runs = [cloudRun({ id: 'r9', threadId: 't1', environmentId: 'cenv' })];
    stream().emit('cloud.run.started', { cloudRunId: 'r9' }, 't1');
    expect(await screen.findByRole('heading', { name: 'Cloud run on App env' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the run’s page' }).getAttribute('href')).toBe(
      '/settings/cloud?run=r9',
    );
  });
});

describe('units', () => {
  it('formats and measures usage', () => {
    expect(formatSeconds(45)).toBe('45 s');
    expect(formatSeconds(125)).toBe('2 min 5 s');
    expect(formatSeconds(3900)).toBe('1 h 5 min');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    const lines = usageLines(
      cloudRun({ warnings: ['wall'], usage: { cpuSeconds: 10, wallSeconds: 20, commands: 1 } }),
    );
    expect(lines.map((l) => [l.resource, l.warn, l.capped])).toEqual([
      ['cpu', false, false],
      ['wall', true, false],
    ]);
    expect(parseCapMinutes('abc', 0, 'CPU time')).toEqual({
      error: 'Set the CPU time cap in whole minutes, from 1 to 10,080.',
    });
  });
});

describe('the cloud client', () => {
  it('sends each call to its Hub route', async () => {
    const { cloudApi } = await import('../src/cloud/api.ts');
    const calls: string[] = [];
    const api = cloudApi(<T,>(method: string, path: string, body?: unknown) => {
      calls.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
      return Promise.resolve({} as T);
    });
    await api.getCloudRunner();
    await api.configureCloudRunner({ url: 'https://r.example.com' });
    await api.setCloudRunnerEnabled(true);
    await api.testCloudRunner();
    await api.forgetCloudRunner();
    await api.listCloudEnvironments();
    await api.getCloudEnvironment('e 1');
    await api.createCloudEnvironment('L', { repoUrls: [] });
    await api.deleteCloudEnvironment('e1');
    await api.rebuildCloudEnvironment('e1');
    await api.readCloudFile('e1', '/workspace/a b');
    await api.listCloudSnapshots('e1');
    await api.createCloudSnapshot('e1');
    await api.restoreCloudSnapshot('s1', false);
    await api.deleteCloudSnapshot('s1');
    await api.listCloudRuns({ threadId: 't1', status: 'active' });
    await api.getCloudRun('r1');
    await api.setCloudRunCaps('r1', { cpuSeconds: 60 });
    await api.cancelCloudRun('r1');
    await api.collectCloudArtifact('r1', { path: '/workspace/x' });
    await api.startCloudWork({ environmentId: 'e1', objective: 'o' });
    expect(calls).toEqual([
      'GET /api/v1/cloud/runner',
      'PUT /api/v1/cloud/runner {"url":"https://r.example.com"}',
      'PATCH /api/v1/cloud/runner {"enabled":true}',
      'POST /api/v1/cloud/runner/test {}',
      'DELETE /api/v1/cloud/runner',
      'GET /api/v1/cloud/environments',
      'GET /api/v1/cloud/environments/e%201',
      'POST /api/v1/environments {"kind":"cloud","label":"L","connection":{"repoUrls":[]}}',
      'DELETE /api/v1/environments/e1',
      'POST /api/v1/cloud/environments/e1/rebuild {}',
      'GET /api/v1/cloud/environments/e1/files?path=%2Fworkspace%2Fa+b',
      'GET /api/v1/cloud/environments/e1/snapshots',
      'POST /api/v1/cloud/environments/e1/snapshots {}',
      'POST /api/v1/cloud/snapshots/s1/restore {"keepCurrent":false}',
      'DELETE /api/v1/cloud/snapshots/s1',
      'GET /api/v1/cloud/runs?threadId=t1&status=active',
      'GET /api/v1/cloud/runs/r1',
      'PATCH /api/v1/cloud/runs/r1 {"cpuSeconds":60}',
      'POST /api/v1/cloud/runs/r1/cancel {}',
      'POST /api/v1/cloud/runs/r1/artifacts {"path":"/workspace/x"}',
      'POST /api/v1/cloud/work {"environmentId":"e1","objective":"o"}',
    ]);
  });
});

describe('entry points for other views', () => {
  it('shows nothing for a thread without a cloud run when quiet', async () => {
    const { api } = await renderWithWork(<ThreadCloudRun threadId="t-none" quiet />, {
      work: { runner: runnerOn() },
    });
    await waitFor(() => expect(api.listCloudRuns).toHaveBeenCalledWith({ threadId: 't-none' }));
    expect(screen.queryByText(/No cloud run yet/)).toBeNull();
    expect(screen.queryByRole('heading', { name: /Cloud run/ })).toBeNull();
  });

  it('starts a Work run in the cloud from a button, or leads to the settings without environments', async () => {
    const { NewCloudWorkButton } = await import('../src/cloud/NewCloudWork.tsx');
    const { api } = await renderWithWork(<NewCloudWorkButton />, {
      work: { runner: runnerOn(), envs: [cloudEnv({ id: 'cenv', label: 'App env' })] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'New run in the cloud…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Work run in the cloud' });
    await userEvent.type(within(dialog).getByLabelText('What should the run get done?'), 'Go');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(api.startCloudWork).toHaveBeenCalled());
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/work\//));
    resetDom();
    await renderWithWork(<NewCloudWorkButton />, { work: { runner: runnerOn() } });
    await userEvent.click(screen.getByRole('button', { name: 'New run in the cloud…' }));
    await waitFor(() => expect(window.location.pathname).toBe('/settings/cloud'));
  });
});

describe('a Work run’s cloud run (RunView.environmentId)', () => {
  it('asks nothing for a run on the Hub, and names the environment of a cloud run', async () => {
    const r = await renderWithWork(<ThreadCloudRun threadId="t-hub" environmentId={null} />, {
      work: { runner: runnerOn() },
    });
    expect(r.api.listCloudRuns).not.toHaveBeenCalled();
    resetDom();
    const { api } = await renderWithWork(<ThreadCloudRun threadId="t-w" environmentId="cenv" />, {
      work: {
        runner: runnerOn(),
        envs: [cloudEnv({ id: 'cenv', label: 'App env' })],
        runs: [cloudRun({ id: 'r5', threadId: 't-w', environmentId: 'cenv' })],
      },
    });
    expect(await screen.findByRole('heading', { name: 'Cloud run on App env' })).toBeTruthy();
    expect(api.getCloudEnvironment).toHaveBeenCalledWith('cenv');
  });
});
