// The cloud runner in the pseudo-locale (FR-016): Settings → Cloud runner (runner, address and
// token, caps, network, environments, runs), the new environment dialog, an environment's page
// (repositories, setup, snapshots, files, its runs, a Work run started there), a run's page with
// its card (near and at a cap, Raise caps, Keep a file, Cancel) and a thread's cloud run show every
// word through messages. Environment names, repository names, paths, host names and the runner's
// own words are fixture data.
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it } from 'vitest';
import { CLOUD_SETTINGS_TEXT, CloudSettings } from '../src/cloud/CloudSettings.tsx';
import { NEW_ENVIRONMENT_TEXT } from '../src/cloud/CloudEnvironmentDialog.tsx';
import { ENVIRONMENT_TEXT } from '../src/cloud/CloudEnvironmentPage.tsx';
import { FILES_TEXT } from '../src/cloud/CloudFiles.tsx';
import { RUN_CARD_TEXT } from '../src/cloud/CloudRunCard.tsx';
import { CLOUD_WORK_TEXT } from '../src/cloud/CloudWorkDialog.tsx';
import { SNAPSHOTS_TEXT } from '../src/cloud/CloudSnapshots.tsx';
import { THREAD_RUN_TEXT } from '../src/cloud/ThreadCloudRun.tsx';
import { ThreadCloudRun } from '../src/cloud/ThreadCloudRun.tsx';
import { CLOUD_TEXT } from '../src/cloud/format.ts';
import {
  cloudEnv,
  cloudRun,
  renderWithWork,
  runnerOn,
  snapshotView,
  type M7WorkState,
} from './fakes-m7-work.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

const DATA = [
  'App in the cloud',
  'App env',
  'app',
  'npm',
  'npm ci',
  'main',
  'abcdef1',
  'added 120 packages',
  'bubblewrap',
  '0.7.0',
  'Before the upgrade',
  'README.md',
  'src',
  'notes.txt',
  '/workspace/app',
  '/workspace/app/report.html',
  'https://runner.example.com',
  // Examples in the new environment form (an address, a command, cache names, an image).
  'https://github.com/team/app.git',
  'npm, pip',
  'node:22',
  // The Hub's own description of the runner's state (English, D9).
  'No runner is set up',
];

async function open(path: string, opts: Parameters<typeof renderWithWork>[1] = {}) {
  await activateTestLocale('en-XA');
  window.history.replaceState(null, '', path);
  return renderWithWork(<CloudSettings />, opts);
}

const settingsPage = () => document.querySelector<HTMLElement>('.cl-settings')!;

describe('the cloud runner in a pseudo-locale', () => {
  it('shows Settings → Cloud runner, unset and set up, and the new environment dialog', async () => {
    await open('/settings/cloud');
    await screen.findByRole('heading', { name: CLOUD_SETTINGS_TEXT.runner.heading });
    expectFullyLocalized(settingsPage(), { data: DATA });
    resetDom();

    const work: Partial<M7WorkState> = {
      runner: runnerOn(),
      envs: [cloudEnv({ id: 'cenv', label: 'App env' })],
      runs: [
        cloudRun({ environmentId: 'cenv', warnings: ['wall'] }),
        cloudRun({ environmentId: 'gone', kind: 'code', status: 'capped', reason: 'cpu' }),
      ],
    };
    await open('/settings/cloud', {
      work,
      settings: { 'cloud.runner.unrestrictedNetwork': true },
    });
    await screen.findByRole('list', { name: CLOUD_SETTINGS_TEXT.environments.heading });
    await screen.findByRole('list', { name: CLOUD_SETTINGS_TEXT.runs });
    expectFullyLocalized(settingsPage(), { data: DATA });

    await userEvent.click(
      screen.getByRole('button', { name: CLOUD_SETTINGS_TEXT.environments.create }),
    );
    const dialog = screen.getByRole('dialog', { name: NEW_ENVIRONMENT_TEXT.title });
    await userEvent.click(within(dialog).getByText(NEW_ENVIRONMENT_TEXT.more));
    expectFullyLocalized(dialog, { data: DATA });
  });

  it("shows an environment's page with snapshots, files, runs and a Work run dialog", async () => {
    const env = cloudEnv({ id: 'cenv', label: 'App env' });
    await open('/settings/cloud?env=cenv', {
      work: {
        runner: runnerOn(),
        envs: [env],
        snapshots: [snapshotView({ environmentId: 'cenv' })],
        runs: [cloudRun({ environmentId: 'cenv' })],
        files: {
          cenv: {
            '/workspace/app': {
              kind: 'dir',
              path: '/workspace/app',
              entries: [
                { name: 'src', kind: 'dir', size: 0 },
                { name: 'README.md', kind: 'file', size: 2048 },
              ],
              truncated: false,
            },
          },
        } as never,
      },
    });
    await screen.findByRole('heading', { name: 'App env' });
    await screen.findByRole('list', { name: SNAPSHOTS_TEXT.heading });
    await screen.findByRole('list', { name: FILES_TEXT.list({ path: '/workspace/app' }) });
    expectFullyLocalized(settingsPage(), { data: DATA });

    await userEvent.click(screen.getByRole('button', { name: ENVIRONMENT_TEXT.newWork }));
    const dialog = screen.getByRole('dialog', { name: CLOUD_WORK_TEXT.title });
    await userEvent.click(within(dialog).getByText(CLOUD_WORK_TEXT.caps));
    expectFullyLocalized(dialog, { data: DATA });
  });

  it("shows a run's page at a cap with Raise caps and Keep a file", async () => {
    const run = cloudRun({
      id: 'crun1',
      environmentId: 'cenv',
      status: 'capped',
      reason: 'cpu',
      threadId: 't1',
    });
    await open('/settings/cloud?run=crun1', {
      work: { runner: runnerOn(), envs: [cloudEnv({ id: 'cenv', label: 'App env' })], runs: [run] },
    });
    await screen.findByRole('button', { name: RUN_CARD_TEXT.raise });
    expectFullyLocalized(settingsPage(), { data: DATA });

    await userEvent.click(screen.getByRole('button', { name: RUN_CARD_TEXT.raise }));
    expectFullyLocalized(screen.getByRole('dialog', { name: RUN_CARD_TEXT.raiseTitle }), {
      data: DATA,
    });
    await userEvent.click(screen.getByRole('button', { name: CLOUD_TEXT.cancel }));
    await userEvent.click(screen.getByRole('button', { name: RUN_CARD_TEXT.keep }));
    expectFullyLocalized(screen.getByRole('dialog', { name: RUN_CARD_TEXT.keepTitle }), {
      data: DATA,
    });
    await userEvent.click(screen.getByRole('button', { name: CLOUD_TEXT.cancel }));
    await userEvent.click(screen.getByRole('button', { name: RUN_CARD_TEXT.cancel }));
    expectFullyLocalized(screen.getByRole('dialog', { name: RUN_CARD_TEXT.cancelTitle }), {
      data: DATA,
    });
  });

  it("shows a thread's cloud run before and after its first command", async () => {
    await activateTestLocale('en-XA');
    const none = await renderWithWork(<ThreadCloudRun threadId="t1" />, {
      work: { runner: runnerOn() },
    });
    await screen.findByRole('link', { name: CLOUD_TEXT.settingsLink });
    expectFullyLocalized(none.container, { data: DATA });
    resetDom();

    const some = await renderWithWork(<ThreadCloudRun threadId="t1" environmentLabel="App env" />, {
      work: {
        runner: runnerOn(),
        runs: [
          cloudRun({ threadId: 't1', usage: { cpuSeconds: 3000, wallSeconds: 1200, commands: 1 } }),
        ],
      },
    });
    await screen.findByRole('link', { name: THREAD_RUN_TEXT.open });
    expectFullyLocalized(some.container, { data: DATA });
  });
});
