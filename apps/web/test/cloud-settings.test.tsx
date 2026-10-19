// Settings → Cloud runner (FR-108, FR-071, FR-116): the runner's address and write-only token (the
// URL and token checked as the Hub checks them; a stored token is kept unless replaced), turning it
// on only after asking (and the Hub's refusal when its test fails), Test, Forget (asks first), the
// caps, the cloud environments with New (only while the runner is usable) and the runs with their
// usage, near-cap and capped states; live runner events.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { CloudSettings, checkRunnerForm, parseCaps } from '../src/cloud/CloudSettings.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  GOOD_TOKEN,
  cloudEnv,
  cloudRun,
  renderWithWork,
  runnerOn,
  runnerTest,
} from './fakes-m7-work.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const section = (name: string) => screen.getByRole('region', { name });
const stream = () => FakeEventSource.for('/api/v1/events/stream');

async function open(opts: Parameters<typeof renderWithWork>[1] = {}) {
  window.history.replaceState(null, '', '/settings/cloud');
  const r = await renderWithWork(<CloudSettings />, opts);
  await screen.findByRole('heading', { name: 'Runner' });
  return r;
}

describe('the runner (FR-108)', () => {
  it('sets it up with a write-only token, then turns it on only after asking', async () => {
    const { api, state } = await open();
    const runner = section('Runner');
    expect(within(runner).getByText('Not set up')).toBeTruthy();
    expect(within(runner).getByText('Not set')).toBeTruthy();
    expect(within(runner).getByRole('switch', { name: 'Use the cloud runner' })).toHaveProperty(
      'disabled',
      true,
    );
    const form = section('Address and token');
    await userEvent.type(
      within(form).getByLabelText('Runner address'),
      'http://runner.example.com',
    );
    await userEvent.type(within(form).getByLabelText('Runner token'), 'nope');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(within(form).getByText(/http:\/\/ only for a runner on this computer/)).toBeTruthy();
    expect(within(form).getByText(/That is not a runner token/)).toBeTruthy();
    expect(api.configureCloudRunner).not.toHaveBeenCalled();

    await userEvent.click(within(form).getByRole('button', { name: 'Use the hosted runner' }));
    await userEvent.clear(within(form).getByLabelText('Runner token'));
    await userEvent.type(within(form).getByLabelText('Runner token'), GOOD_TOKEN);
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.configureCloudRunner).toHaveBeenCalledWith({
        url: 'https://runner.arialabs.ai',
        token: GOOD_TOKEN,
      }),
    );
    expect(await within(section('Runner')).findByText('Off')).toBeTruthy();
    expect(within(section('Runner')).getByText('Set')).toBeTruthy();
    // The token field is empty again and never shows what was stored.
    expect(
      within(section('Address and token')).getByLabelText<HTMLInputElement>('Replace the token')
        .value,
    ).toBe('');

    await userEvent.click(
      within(section('Runner')).getByRole('switch', { name: 'Use the cloud runner' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Turn on the cloud runner?' });
    expect(dialog.textContent).toContain('https://runner.arialabs.ai');
    expect(api.setCloudRunnerEnabled).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(state.runner.enabled).toBe(true);
    expect(within(section('Runner')).getByText('Ready')).toBeTruthy();
  });

  it('says why a runner that fails its test stays off, and tests on request', async () => {
    const { state } = await open({
      work: {
        runner: { ...runnerOn(), enabled: false },
        test: runnerTest({
          ok: false,
          version: '0.7.0',
          detail: 'the runner has no sandbox: no bubblewrap',
        }),
      },
    });
    await userEvent.click(
      within(section('Runner')).getByRole('switch', { name: 'Use the cloud runner' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Turn on the cloud runner?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The runner did not pass its test, so it was not turned on: the runner has no sandbox: no bubblewrap.',
    );
    expect(state.runner.enabled).toBe(false);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    state.test = runnerTest();
    await userEvent.click(within(section('Runner')).getByRole('button', { name: 'Test' }));
    expect(
      await within(section('Runner')).findByText(/The runner answers in 42 ms: runner 0.7.0/),
    ).toBeTruthy();
  });

  it('forgets the runner only after asking, and keeps a stored token when only the URL changes', async () => {
    const { api, state } = await open({ work: { runner: runnerOn() } });
    const form = section('Address and token');
    const url = within(form).getByLabelText('Runner address');
    await userEvent.clear(url);
    await userEvent.type(url, 'https://runner2.example.com');
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.configureCloudRunner).toHaveBeenCalledWith({ url: 'https://runner2.example.com' }),
    );
    await userEvent.click(within(form).getByRole('button', { name: 'Forget this runner…' }));
    const dialog = screen.getByRole('dialog', { name: 'Forget this runner?' });
    expect(dialog.textContent).toContain('token leaves the vault');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Forget runner' }));
    await waitFor(() => expect(state.runner.hasToken).toBe(false));
    expect(await within(section('Runner')).findByText('Not set up')).toBeTruthy();
  });

  it('follows runner events and retries a failed load', async () => {
    const { work } = await open({ work: { runner: runnerOn() } });
    expect(within(section('Runner')).getByText('Ready')).toBeTruthy();
    work.state.runner = { ...work.state.runner, enabled: false };
    stream().emit('cloud.runner.updated', { enabled: false, state: 'disabled' });
    expect(await within(section('Runner')).findByText('Off')).toBeTruthy();
  });

  it('shows a failed load with Retry', async () => {
    window.history.replaceState(null, '', '/settings/cloud');
    await renderWithWork(<CloudSettings />, {
      fail: { getCloudRunner: new Error('Failed to fetch') },
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(
      'Cannot reach the Hub. Check your connection and try again.',
    );
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Runner' })).toBeTruthy();
  });
});

describe('caps (FR-116)', () => {
  it('saves caps within the bounds the Hub takes', async () => {
    const { hub } = await open({ work: { runner: runnerOn() } });
    const caps = section('Caps');
    const cpu = within(caps).getByLabelText('CPU time per run (minutes)');
    await userEvent.clear(cpu);
    await userEvent.type(cpu, '0');
    await userEvent.click(within(caps).getByRole('button', { name: 'Save caps' }));
    expect(within(caps).getByRole('alert').textContent).toMatch(/from 1 to 10,080/);
    await userEvent.clear(cpu);
    await userEvent.type(cpu, '120');
    await userEvent.click(within(caps).getByRole('button', { name: 'Save caps' }));
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('cloud.runner.caps', {
        cpuSeconds: 7200,
        wallSeconds: 14_400,
        diskMb: 10_240,
        warnAt: 0.8,
      }),
    );
  });

  it('locks the caps managed policy sets', async () => {
    await open({
      work: { runner: runnerOn() },
      managed: {
        'cloud.runner.caps': { cpuSeconds: 600, wallSeconds: 600, diskMb: 1024, warnAt: 0.9 },
      },
    });
    const caps = section('Caps');
    expect(
      within(caps).getByLabelText<HTMLInputElement>('CPU time per run (minutes)').disabled,
    ).toBe(true);
    expect(within(caps).getByText('Your organization manages these caps.')).toBeTruthy();
    expect(within(caps).queryByRole('button', { name: 'Save caps' })).toBeNull();
  });
});

describe('environments and runs (FR-071, FR-116)', () => {
  it('lists environments and runs with their usage, near-cap and capped states', async () => {
    const env = cloudEnv({ id: 'cenv', label: 'App env' });
    await open({
      work: {
        runner: runnerOn(),
        envs: [env],
        runs: [
          cloudRun({
            id: 'r1',
            environmentId: 'cenv',
            usage: { cpuSeconds: 3000, wallSeconds: 100, commands: 2 },
          }),
          cloudRun({
            id: 'r2',
            environmentId: 'cenv',
            kind: 'code',
            status: 'capped',
            reason: 'wall',
            usage: { cpuSeconds: 10, wallSeconds: 14_400, commands: 9 },
          }),
          cloudRun({
            id: 'r3',
            environmentId: 'gone',
            status: 'completed',
            createdAt: '2026-09-01T00:00:00.000Z',
          }),
        ],
      },
    });
    const envs = await screen.findByRole('list', { name: 'Cloud environments' });
    const row = within(envs).getByRole('listitem', { name: 'App env' });
    expect(within(row).getByText('Ready')).toBeTruthy();
    expect(within(row).getByText('app')).toBeTruthy();
    expect(within(row).getByText('No network')).toBeTruthy();
    const runs = await screen.findByRole('list', { name: 'Runs' });
    const items = within(runs).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual([
      'Work run on App env',
      'Code session on App env',
      'Work run on A removed environment',
    ]);
    expect(within(items[0]!).getByText('Near its CPU time cap')).toBeTruthy();
    expect(within(items[1]!).getByText('Stopped at its running time cap')).toBeTruthy();
    expect(within(items[1]!).getByText('Stopped at a cap')).toBeTruthy();
  });

  it('offers New cloud environment only while the runner is usable, and says why', async () => {
    await open({ work: { runner: { ...runnerOn(), enabled: false } } });
    const envs = section('Cloud environments');
    expect(within(envs).getByRole('button', { name: 'New cloud environment' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(envs).getByText('Set up and turn on the runner first.')).toBeTruthy();
    expect(within(envs).getByText('No cloud environments yet')).toBeTruthy();
  });

  it('creates an environment, checking repositories and disk as the Hub does', async () => {
    const { api, state } = await open({ work: { runner: runnerOn() } });
    await userEvent.click(
      within(section('Cloud environments')).getByRole('button', { name: 'New cloud environment' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'New cloud environment' });
    // Without unrestricted network there is no network choice, and the form says why.
    expect(within(dialog).queryByRole('radio', { name: /Network on/ })).toBeNull();
    expect(
      within(dialog).getByText(/cloud commands on this Hub never reach the network/),
    ).toBeTruthy();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Shop');
    await userEvent.type(
      within(dialog).getByLabelText('Repositories'),
      'https://me:secret@github.com/team/shop.git',
    );
    await userEvent.click(within(dialog).getByText('More options'));
    await userEvent.type(within(dialog).getByLabelText('Disk (MB)'), '999999');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    expect(within(dialog).getByText(/Leave user names and passwords out/)).toBeTruthy();
    expect(within(dialog).getByText(/At most 10,240 MB, the cap/)).toBeTruthy();
    expect(api.createCloudEnvironment).not.toHaveBeenCalled();

    const repos = within(dialog).getByLabelText('Repositories');
    await userEvent.clear(repos);
    await userEvent.type(
      repos,
      'https://github.com/team/shop.git{enter}https://github.com/team/lib.git#dev',
    );
    await userEvent.clear(within(dialog).getByLabelText('Disk (MB)'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    await waitFor(() =>
      expect(api.createCloudEnvironment).toHaveBeenCalledWith('Shop', {
        repoUrls: ['https://github.com/team/shop.git', 'https://github.com/team/lib.git#dev'],
        network: 'off',
      }),
    );
    // It opens on its own page.
    await waitFor(() => expect(window.location.search).toBe(`?env=${state.envs[0]!.id}`));
  });

  it('offers network only with unrestricted network on, and explains the Hub refusing it', async () => {
    const { api, work, hub } = await open({
      work: { runner: runnerOn() },
      settings: { 'cloud.runner.unrestrictedNetwork': true },
    });
    await userEvent.click(
      within(section('Cloud environments')).getByRole('button', { name: 'New cloud environment' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'New cloud environment' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Net');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Network on' }));
    // The owner turns it off elsewhere; the Hub refuses the request in plain words.
    hub.state.settings = { ...hub.state.settings, 'cloud.runner.unrestrictedNetwork': false };
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create environment' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(
      /Cloud environments get no network on this Hub, because their traffic would not pass/,
    );
    expect(api.createCloudEnvironment).toHaveBeenCalledWith('Net', { repoUrls: [], network: 'on' });
    expect(work.state.envs).toHaveLength(0);
  });

  it('turns unrestricted network on only after asking, with the setting’s own description', async () => {
    const { hub } = await open({ work: { runner: runnerOn() } });
    const net = section('Network');
    expect(within(net).getByText(/without the Hub's egress proxy/)).toBeTruthy();
    await userEvent.click(within(net).getByRole('switch', { name: 'Unrestricted network' }));
    const dialog = screen.getByRole('dialog', { name: 'Allow unrestricted network?' });
    expect(hub.api.setSetting).not.toHaveBeenCalledWith('cloud.runner.unrestrictedNetwork', true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Allow' }));
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('cloud.runner.unrestrictedNetwork', true),
    );
    expect(await within(section('Network')).findByText(/including private ones/)).toBeTruthy();
    await userEvent.click(
      within(section('Network')).getByRole('switch', { name: 'Unrestricted network' }),
    );
    await waitFor(() =>
      expect(hub.api.setSetting).toHaveBeenCalledWith('cloud.runner.unrestrictedNetwork', false),
    );
  });
});

describe('units', () => {
  it('checks the runner form and the caps', () => {
    expect(checkRunnerForm('', '', false)).toEqual({
      url: 'Enter the runner’s address, or use the hosted runner.',
      token: 'Enter the token the runner gave you (nvrun_…).',
    });
    expect(checkRunnerForm('http://127.0.0.1:7000', '', true)).toEqual({});
    expect(parseCaps({ cpu: '60', wall: '240', disk: '1024', warn: '80' })).toEqual({
      caps: { cpuSeconds: 3600, wallSeconds: 14_400, diskMb: 1024, warnAt: 0.8 },
    });
    expect(parseCaps({ cpu: '60', wall: '240', disk: '8', warn: '80' })).toEqual({
      error: 'Set the disk cap in whole MB, from 16 to 1,048,576.',
    });
    expect(parseCaps({ cpu: '60', wall: '240', disk: '64', warn: '40' })).toEqual({
      error: 'Warn at a share from 50 to 99 percent.',
    });
    expect(new ApiError(400, { code: 'x', message: 'y', retryable: false })).toBeTruthy();
  });
});
