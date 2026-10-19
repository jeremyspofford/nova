// A cloud environment's page (FR-071, FR-108; Settings → Cloud runner ?env=): what the runner
// reports (repositories, setup and its log, disk), Rebuild and Delete (both ask first; the Hub's
// refusals while commands run or sessions use it), snapshots (take, restore with the current state
// kept first, delete; busy refusal), the files (folders, text, binary, a missing path), its runs,
// and a Work run started here (only on a ready environment; it opens the run).
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { CloudSettings, cloudSubPage } from '../src/cloud/CloudSettings.tsx';
import { parentPath } from '../src/cloud/CloudFiles.tsx';
import { buildCloudEnvironment, EMPTY_CLOUD_DRAFT } from '../src/cloud/CloudEnvironmentDialog.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  cloudEnv,
  cloudRun,
  renderWithWork,
  runnerOn,
  snapshotView,
  type M7WorkState,
} from './fakes-m7-work.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const section = (name: string) =>
  screen.getByRole('heading', { name }).closest('section') as HTMLElement;

async function openEnv(work: Partial<M7WorkState> = {}, id = 'cenv') {
  window.history.replaceState(null, '', `/settings/cloud?env=${id}`);
  const r = await renderWithWork(<CloudSettings />, {
    work: { runner: runnerOn(), envs: [cloudEnv({ id, label: 'App env' })], ...work },
  });
  await screen.findByRole('heading', { name: 'App env' });
  return r;
}

describe('a cloud environment (FR-071)', () => {
  it('shows what the runner reports, and the setup log when the setup failed', async () => {
    const base = cloudEnv({ id: 'cenv', label: 'App env' });
    await openEnv({
      envs: [
        {
          ...base,
          runner: {
            ...base.runner!,
            status: 'failed',
            setup: {
              status: 'failed',
              exitCode: 1,
              log: 'npm ERR! missing script',
              startedAt: null,
              endedAt: null,
            },
          },
        },
      ],
    });
    expect(screen.getByText('Setup failed')).toBeTruthy();
    const setup = section('Setup');
    expect(within(setup).getByRole('alert').textContent).toMatch(
      /The setup script failed \(exit code 1\)\. Fix the script or the repositories, then rebuild\./,
    );
    expect(within(setup).getByLabelText('The end of the setup log').textContent).toBe(
      'npm ERR! missing script',
    );
    const repos = section('Repositories');
    expect(within(repos).getByText('Branch main')).toBeTruthy();
    expect(within(repos).getByText('At abcdef1')).toBeTruthy();
    expect(screen.getByText('512 MB of 10 GB')).toBeTruthy();
    // Not ready: no Work run here.
    expect(screen.getByRole('button', { name: 'New Work run here…' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('rebuilds after asking, and says why the runner refuses while commands run', async () => {
    const { api, state } = await openEnv({ busy: ['cenv'] });
    await userEvent.click(screen.getByRole('button', { name: 'Rebuild…' }));
    let dialog = screen.getByRole('dialog', { name: 'Rebuild App env?' });
    expect(dialog.textContent).toContain('clones the repositories again');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rebuild' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Commands are running in this environment. Wait for them to finish, or cancel its runs first.',
    );
    state.busy = [];
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.rebuildCloudEnvironment).toHaveBeenCalledWith('cenv');
    expect(await screen.findByText('Setting up')).toBeTruthy();
    // While it sets up, snapshots and rebuild wait.
    expect(screen.getByRole('button', { name: 'Rebuild…' })).toHaveProperty('disabled', true);
    dialog = section('Snapshots');
    expect(
      within(dialog).getByText('The runner is still setting this environment up.'),
    ).toBeTruthy();
  });

  it('deletes after asking, and keeps it while sessions use it', async () => {
    const { state } = await openEnv({
      envs: [cloudEnv({ id: 'cenv', label: 'App env', sessions: 2 })],
    });
    expect(screen.getByText('2 active Code sessions')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete App env?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Sessions still use this environment. Archive them first.',
    );
    state.envs = state.envs.map((e) => ({ ...e, sessions: 0 }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(state.envs).toHaveLength(0);
  });

  it('says when the runner is off, and loads nothing from it', async () => {
    const { api } = await openEnv({ runner: { ...runnerOn(), enabled: false } });
    expect(
      screen.getByText(
        'The cloud runner is off or not set up, so this environment cannot be used now.',
      ),
    ).toBeTruthy();
    expect(
      within(section('Files')).getByText('Not available while the runner cannot be used.'),
    ).toBeTruthy();
    expect(api.readCloudFile).not.toHaveBeenCalled();
  });

  it('shows a missing environment with a way back', async () => {
    window.history.replaceState(null, '', '/settings/cloud?env=gone');
    await renderWithWork(<CloudSettings />, { work: { runner: runnerOn() } });
    expect((await screen.findByRole('alert')).textContent).toContain('It no longer exists.');
    expect(screen.getByRole('link', { name: /Cloud runner/ }).getAttribute('href')).toBe(
      '/settings/cloud',
    );
  });
});

describe('snapshots (docs/13 §3)', () => {
  it('takes, restores (keeping the current state first) and deletes snapshots', async () => {
    const { api, state } = await openEnv({
      snapshots: [snapshotView({ id: 's1', environmentId: 'cenv', label: 'Known good' })],
    });
    const snaps = section('Snapshots');
    await userEvent.type(within(snaps).getByLabelText('Label (optional)'), 'Before upgrade');
    await userEvent.click(within(snaps).getByRole('button', { name: 'Take a snapshot' }));
    await waitFor(() =>
      expect(api.createCloudSnapshot).toHaveBeenCalledWith('cenv', 'Before upgrade'),
    );
    const list = await within(snaps).findByRole('list', { name: 'Snapshots' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['Before upgrade', 'Known good']);

    await userEvent.click(
      within(within(list).getByRole('listitem', { name: 'Known good' })).getByRole('button', {
        name: 'Restore…',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Restore this snapshot?' });
    const keep = within(dialog).getByRole('checkbox', { name: /Snapshot the current state first/ });
    expect((keep as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.restoreCloudSnapshot).toHaveBeenCalledWith('s1', true));
    expect(state.snapshots.some((s) => s.reason === 'before_restore')).toBe(true);

    const row = await within(snaps).findByRole('listitem', { name: 'Before upgrade' });
    await userEvent.click(within(row).getByRole('button', { name: 'Delete…' }));
    const del = screen.getByRole('dialog', { name: 'Delete this snapshot?' });
    await userEvent.click(within(del).getByRole('button', { name: 'Delete' }));
    await waitFor(() =>
      expect(within(snaps).queryByRole('listitem', { name: 'Before upgrade' })).toBeNull(),
    );
  });

  it('refuses a restore while commands run, and shows the empty state', async () => {
    const { state } = await openEnv({
      snapshots: [snapshotView({ id: 's1', environmentId: 'cenv', label: 'Known good' })],
      busy: ['cenv'],
    });
    const snaps = section('Snapshots');
    await userEvent.click(await within(snaps).findByRole('button', { name: 'Restore…' }));
    const dialog = screen.getByRole('dialog', { name: 'Restore this snapshot?' });
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: /Snapshot the current state/ }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/Commands are running/);
    expect(state.snapshots).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    state.snapshots = [];
    FakeEventSource.for('/api/v1/events/stream').emit('cloud.snapshot.deleted', {
      snapshotId: 's1',
      environmentId: 'cenv',
    });
    expect(await within(snaps).findByText('No snapshots yet')).toBeTruthy();
  });
});

describe('files (FR-108)', () => {
  it('browses folders and shows text and binary files as the runner reads them', async () => {
    await openEnv({
      files: {
        cenv: {
          '/workspace/app': {
            kind: 'dir',
            path: '/workspace/app',
            entries: [
              { name: 'src', kind: 'dir', size: 0 },
              { name: 'README.md', kind: 'file', size: 2048 },
              { name: 'logo.png', kind: 'file', size: 9000 },
              { name: 'latest', kind: 'link', size: 0 },
            ],
            truncated: true,
          },
          '/workspace/app/README.md': {
            kind: 'file',
            path: '/workspace/app/README.md',
            size: 2048,
            text: '<script>alert(1)</script> # App',
            truncated: false,
          },
          '/workspace/app/logo.png': {
            kind: 'file',
            path: '/workspace/app/logo.png',
            size: 9000,
            text: null,
            truncated: false,
          },
        },
      },
    });
    const files = section('Files');
    const list = await within(files).findByRole('list', { name: 'Files in /workspace/app' });
    expect(within(list).getByText('2.0 KB')).toBeTruthy();
    expect(within(list).getByText('link')).toBeTruthy();
    expect(within(list).getByText('More entries are not shown.')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: /README\.md/ }));
    const text = await within(files).findByLabelText('Contents of /workspace/app/README.md');
    // Untrusted text stays text.
    expect(text.textContent).toBe('<script>alert(1)</script> # App');
    expect(files.querySelector('script')).toBeNull();
    await userEvent.click(within(files).getByRole('button', { name: 'Up one folder' }));
    await userEvent.click(await within(files).findByRole('button', { name: /logo\.png/ }));
    expect(await within(files).findByText(/A binary file of 8.8 KB/)).toBeTruthy();
    await userEvent.click(within(files).getByRole('button', { name: 'Up one folder' }));
    await userEvent.click(await within(files).findByRole('button', { name: /src/ }));
    expect((await within(files).findByRole('alert')).textContent).toContain(
      'There is nothing at that path on the runner now.',
    );
    await userEvent.click(within(files).getByRole('button', { name: 'Open /workspace' }));
    expect(await within(files).findByText('/workspace')).toBeTruthy();
  });
});

describe('a Work run on a cloud environment (FR-108)', () => {
  it('starts one with optional caps and a snapshot first, then opens it', async () => {
    const { api } = await openEnv({
      runs: [cloudRun({ id: 'r1', environmentId: 'cenv' })],
    });
    expect(
      await within(section('Runs here')).findByRole('listitem', { name: 'Work run on App env' }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'New Work run here…' }));
    const dialog = screen.getByRole('dialog', { name: 'New Work run in the cloud' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start run' }));
    expect(within(dialog).getByText('Describe what the run should get done.')).toBeTruthy();
    await userEvent.type(
      within(dialog).getByLabelText('What should the run get done?'),
      'Upgrade the dependencies',
    );
    await userEvent.click(within(dialog).getByText('Caps for this run (optional)'));
    await userEvent.type(within(dialog).getByLabelText('CPU time cap (minutes)'), '30');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start run' }));
    await waitFor(() =>
      expect(api.startCloudWork).toHaveBeenCalledWith({
        environmentId: 'cenv',
        objective: 'Upgrade the dependencies',
        autonomy: 'standard',
        snapshot: true,
        caps: { cpuSeconds: 1800 },
      }),
    );
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/work\/run-m7w-/));
  });
});

describe('units', () => {
  it('reads the sub-page and the parent folder', () => {
    expect(cloudSubPage('/settings/cloud?env=a')).toEqual({ env: 'a', run: null });
    expect(cloudSubPage('/settings/cloud')).toEqual({ env: null, run: null });
    expect(parentPath('/workspace/app/src')).toBe('/workspace/app');
    expect(parentPath('/workspace')).toBe('/workspace');
    expect(parentPath('/etc')).toBe('/workspace');
  });

  it('builds the create body as the Hub checks it', () => {
    expect(
      buildCloudEnvironment({ ...EMPTY_CLOUD_DRAFT, label: 'X', folder: '/tmp' }, 100),
    ).toEqual({ errors: { folder: 'Enter a folder under /workspace, such as /workspace/app.' } });
    expect(
      buildCloudEnvironment({ ...EMPTY_CLOUD_DRAFT, label: 'X', network: 'on' }, 100, false),
    ).toMatchObject({ errors: { network: expect.stringContaining('no network') as string } });
    expect(
      buildCloudEnvironment(
        {
          ...EMPTY_CLOUD_DRAFT,
          label: 'X',
          caches: 'npm, pip',
          baseImage: 'node:22',
          diskMb: '64',
        },
        100,
      ),
    ).toEqual({
      label: 'X',
      connection: {
        repoUrls: [],
        network: 'off',
        baseImage: 'node:22',
        caches: ['npm', 'pip'],
        diskMb: 64,
      },
    });
  });
});
