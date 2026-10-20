// Code mode in the pseudo-locale (FR-016): the sessions list, a session with every pane, the
// session dialogs, environments and worktrees come from messages. Session titles, paths, branches,
// commands, model and host names are fixture data; the Hub's own words (labels of moves, a dev
// server's framework and source, symbol kinds) are passed as data too.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { CodeSessionView } from '@nova/shared';
import { ATTEMPTS_TEXT } from '../src/code/AttemptsPane.tsx';
import { COMMIT_TEXT } from '../src/code/CommitDialog.tsx';
import { ENV_DIALOG_TEXT } from '../src/code/EnvironmentDialog.tsx';
import { ENV_TEXT } from '../src/code/EnvironmentsPage.tsx';
import { GIT_TEXT } from '../src/code/GitDialogs.tsx';
import { HANDOFF_TEXT } from '../src/code/HandoffDialog.tsx';
import { sessionTitle } from '../src/code/labels.ts';
import { MERGE_TEXT } from '../src/code/MergePane.tsx';
import { NEW_SESSION_TEXT } from '../src/code/NewSessionDialog.tsx';
import { SESSIONS_TEXT } from '../src/code/SessionList.tsx';
import { SESSION_M7_TEXT } from '../src/code/SessionM7.tsx';
import { SESSION_TEXT } from '../src/code/SessionView.tsx';
import { WORKTREES_TEXT } from '../src/code/WorktreesPage.tsx';
import { SIDEBAR_TEXT } from '../src/shell/strings.ts';
import { codeChange, codeSession } from './fakes-m5-code.ts';
import {
  budget,
  candidate,
  devServer,
  m6CodeHub,
  pullRequest,
  savedEnvironment,
  verifyRun,
  worktreeView,
  type M6HubOptions,
} from './fakes-m6-code.ts';
import {
  attemptSet,
  createWorkHub,
  handoffView,
  mergeView,
  type M7WorkState,
} from './fakes-m7-work.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

/** Fixture data the views show as it is. */
const DATA = [
  'Fix the flaky test',
  'Make the parser faster',
  '/home/me/app',
  'feature/x',
  'src/total.ts',
  'This Hub: /home/me/app',
  'Build box: /srv/app',
  'Build box',
  'This Hub',
  'Mock fast',
  'Mock smart',
];

/**
 * Regions other areas own: the chat inside a session (chat, checked in i18n-chat), the bottom
 * panel's terminal (terminal), the key chips (packages/ui), the cloud and flagged panes.
 */
const OTHER_AREAS = ['.code-chat', '.nv-kbds', '.terminal-screen', '.cm7-pane .cl-notice'];

async function renderCode(
  locale: string,
  path: (s: CodeSessionView) => string,
  opts: M6HubOptions & { work?: Partial<M7WorkState> } = {},
) {
  const s = codeSession({ id: 'cs', threadId: 't-cs' });
  const parts = m6CodeHub([s, ...(opts.others ?? [])], opts);
  const work = createWorkHub(parts.hub, opts.work);
  Object.assign(parts.hub.api, work.api);
  await activateTestLocale(locale);
  const r = await renderApp({ hub: parts.hub, path: path(s), ready: false });
  await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });
  return { ...r, ...parts, s };
}

describe('Code in a pseudo-locale', () => {
  it('shows the sessions list and the new session dialog localized', async () => {
    await renderCode('en-XA', () => '/code');
    const heading = await screen.findByRole('heading', { name: SESSIONS_TEXT.title, level: 1 });
    const page = heading.closest('.ws-page') as HTMLElement;
    await within(page).findByRole('list', { name: SESSIONS_TEXT.list });
    expectFullyLocalized(page, { data: DATA, skip: OTHER_AREAS });

    await userEvent.click(within(page).getByRole('button', { name: SESSIONS_TEXT.new }));
    const dialog = await screen.findByRole('dialog', { name: NEW_SESSION_TEXT.title });
    await within(dialog).findByText(NEW_SESSION_TEXT.budgets);
    expectFullyLocalized(dialog, { data: DATA, skip: OTHER_AREAS });
  });

  it('shows a session with its panes localized', async () => {
    const { s } = await renderCode('en-XA', (x) => `/code/${x.id}`, {
      code: {
        changes: [codeChange('cs')],
        nextReview: {
          status: 'done',
          findings: [
            {
              id: 'f1',
              path: 'src/total.ts',
              line: 1,
              severity: 'warn',
              title: 'Off by one',
              reasoning: 'The loop stops early.',
              fix: 'i <= n',
            },
          ],
        },
      },
      m6: {
        budgets: { cs: budget({ used: { timeSeconds: 600, tokens: 1500, costUsd: 0.5 } }) },
        pullRequests: [pullRequest('cs')],
        verifyRuns: [verifyRun('cs')],
        candidates: { cs: [candidate()] },
        devServers: [devServer('cs')],
      },
      work: {
        handoffs: [handoffView({ sessionId: 'cs' })],
        merges: [mergeView({ sessionId: 'cs' })],
        attemptSets: [attemptSet({ sessionId: 'cs' })],
      },
    });
    const view = await screen.findByRole('region', {
      name: SESSION_TEXT.label({ title: sessionTitle(s) }),
    });
    await waitFor(() => expect(view.querySelector('.code-budget')).toBeTruthy());
    const data = [
      ...DATA,
      'Off by one',
      'The loop stops early.',
      'i <= n',
      'Add a total',
      'team/app',
      'main',
      'nova/fix',
      'build',
      'test',
      'Vite',
      'package.json',
      'web',
      'npm run dev',
      'f00dfeedbeef',
      'nova/attempt-1',
      'nova/attempt-2',
      'src/f0.ts',
      'src/f1.ts',
      'src/app.ts',
      'abc1234',
    ];
    const panes = view.querySelector('.code-panes') as HTMLElement;
    const tabs = within(panes).getAllByRole('tab');
    for (const tab of tabs) {
      await userEvent.click(tab);
      // Each pane loads on first show; give it a moment, then check the whole view.
      await waitFor(() => expect(tab.getAttribute('aria-selected')).toBe('true'));
      await new Promise((r) => setTimeout(r, 50));
      expectFullyLocalized(view, { data, skip: OTHER_AREAS });
    }
  });

  it('shows the git, commit and hand-off dialogs localized', async () => {
    const env = savedEnvironment({ id: 'env-ssh', kind: 'ssh', label: 'Build box' });
    await renderCode('en-XA', (x) => `/code/${x.id}`, {
      code: { changes: [codeChange('cs')], environments: [env] },
    });
    const view = await screen.findByRole('region', {
      name: SESSION_TEXT.label({ title: 'Fix the flaky test' }),
    });
    const header = view.querySelector('header') as HTMLElement;
    const open = async (button: string, title: string) => {
      await userEvent.click(within(header).getByRole('button', { name: new RegExp(button) }));
      const dialog = await screen.findByRole('dialog', { name: title });
      expectFullyLocalized(dialog, { data: [...DATA, 'fix-the-flaky-test', 'origin'] });
      await userEvent.keyboard('{Escape}');
    };
    await open(escape(SESSION_TEXT.commit), COMMIT_TEXT.title);
    await open(escape(SESSION_TEXT.branch), GIT_TEXT.newBranch);
    await open(escape(SESSION_TEXT.push), GIT_TEXT.pushTitle);
    await open(escape(SESSION_TEXT.prOpen), GIT_TEXT.prTitle);
    await open(escape(SESSION_M7_TEXT.handOff), HANDOFF_TEXT.title);
    await open(escape(SESSION_M7_TEXT.bestOfN), ATTEMPTS_TEXT.dialogTitle);
  });

  it('shows the environments and worktrees pages localized', async () => {
    const env = savedEnvironment({ id: 'env-ssh', kind: 'ssh', label: 'Build box' });
    await renderCode('en-XA', () => '/code/environments', {
      code: { environments: [env] },
      m6: { worktrees: [worktreeView()] },
    });
    const heading = await screen.findByRole('heading', { name: ENV_TEXT.title, level: 1 });
    const page = heading.closest('.ws-page') as HTMLElement;
    await within(page).findByRole('list', { name: ENV_TEXT.title });
    const envData = [
      ...DATA,
      'h.example.com',
      'me@build.example.com',
      'build.example.com',
      'nova/task-7',
      '/home/me/app/.nova/worktrees/00000007',
      'main',
    ];
    expectFullyLocalized(page, { data: envData, skip: OTHER_AREAS });
    await userEvent.click(
      within(page).getByRole('button', { name: new RegExp(escape(ENV_TEXT.new)) }),
    );
    const dialog = await screen.findByRole('dialog', { name: ENV_DIALOG_TEXT.newTitle });
    expectFullyLocalized(dialog, { data: envData });
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('link', { name: /Ŵöŕķţŕéé/ }));
    const wt = await screen.findByRole('heading', { name: WORKTREES_TEXT.title, level: 1 });
    const wtPage = wt.closest('.ws-page') as HTMLElement;
    await waitFor(() => expect(wtPage.querySelector('.code-wt-row')).toBeTruthy());
    expectFullyLocalized(wtPage, { data: envData, skip: OTHER_AREAS });
    await userEvent.click(
      within(wtPage).getByRole('button', { name: new RegExp(escape(WORKTREES_TEXT.new)) }),
    );
    const wtDialog = await screen.findByRole('dialog', { name: WORKTREES_TEXT.dialogTitle });
    expectFullyLocalized(wtDialog, { data: envData });
  });

  it('shows the merge dialog localized', async () => {
    await renderCode('en-XA', (x) => `/code/${x.id}`);
    const view = await screen.findByRole('region', {
      name: SESSION_TEXT.label({ title: 'Fix the flaky test' }),
    });
    await userEvent.click(within(view).getByRole('tab', { name: SESSION_M7_TEXT.tab.merges }));
    await userEvent.click(
      await within(view).findByRole('button', { name: new RegExp(escape(MERGE_TEXT.mergeIn)) }),
    );
    const dialog = await screen.findByRole('dialog', { name: MERGE_TEXT.dialogTitle });
    expectFullyLocalized(dialog, { data: DATA });
  });
});

/** A message as a literal pattern (pseudo text has brackets). */
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
