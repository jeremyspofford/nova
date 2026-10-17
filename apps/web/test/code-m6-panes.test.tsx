import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { emitCode } from './code-helpers.tsx';
import { codeSession } from './fakes-m5-code.ts';
import {
  candidate,
  devServer,
  finishVerify,
  openM6Session,
  verifyCheck,
  verifyRun,
} from './fakes-m6-code.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const announcer = () => screen.getByTestId('announcer').textContent ?? '';
const tab = (name: string | RegExp) => screen.getByRole('tab', { name });

describe('Dev servers pane (FR-097, FR-067)', () => {
  it('starts a detected dev server, opens its preview in a new tab, stops it and stops all', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { view, api, s } = await openM6Session(
      { id: 'cs-dev' },
      {
        m6: {
          candidates: {
            'cs-dev': [
              candidate(),
              candidate({
                id: 'django',
                label: 'Django',
                framework: 'Django',
                command: 'python manage.py runserver',
                cwd: 'api',
                port: 8000,
                source: 'manage.py',
              }),
            ],
          },
        },
      },
    );
    await userEvent.click(tab('Dev servers'));
    const pane = within(view).getByRole('region', { name: 'Dev servers' });
    const detected = await within(pane).findByRole('list', { name: 'Detected dev servers' });
    const vite = within(detected).getByRole('listitem', { name: 'npm run dev' });
    expect(within(vite).getByText('Vite')).toBeTruthy();
    expect(within(vite).getByText('From package.json')).toBeTruthy();
    expect(within(detected).getByText('in api')).toBeTruthy();

    await userEvent.click(within(vite).getByRole('button', { name: 'Start' }));
    await waitFor(() =>
      expect(api.startDevServer).toHaveBeenCalledWith(s.id, { candidateId: 'npm:dev' }),
    );
    const started = await within(pane).findByRole('list', { name: 'Started dev servers' });
    const server = within(started).getByRole('listitem', { name: 'npm run dev' });
    expect(within(server).getByText('Serving')).toBeTruthy();
    expect(within(server).getByText('http://127.0.0.1:5173/')).toBeTruthy();
    expect(within(vite).getByRole('button', { name: 'Start' })).toHaveProperty('disabled', true);
    await waitFor(() => expect(announcer()).toMatch(/npm run dev is serving/));
    expect(tab('Dev servers (1)')).toBeTruthy();

    await userEvent.click(within(server).getByRole('button', { name: /Open preview/ }));
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:5173/', '_blank', 'noopener,noreferrer');

    // Start the second one, then Stop all.
    await userEvent.click(
      within(within(detected).getByRole('listitem', { name: 'Django' })).getByRole('button', {
        name: 'Start',
      }),
    );
    await within(started).findByRole('listitem', { name: 'Django' });
    await userEvent.click(within(pane).getByRole('button', { name: /Stop all/ }));
    await waitFor(() => expect(api.stopAllDevServers).toHaveBeenCalledWith(s.id));
    await waitFor(() => expect(within(started).getAllByText('Stopped')).toHaveLength(2));
    expect(within(pane).queryByRole('button', { name: /Stop all/ })).toBeNull();
  });

  it('shows the output of a server that exited at once, and a missing sandbox', async () => {
    const { view, m6 } = await openM6Session(
      { id: 'cs-dev2' },
      { m6: { candidates: { 'cs-dev2': [candidate()] }, devServerExit: 'Error: port in use' } },
    );
    await userEvent.click(tab('Dev servers'));
    const pane = within(view).getByRole('region', { name: 'Dev servers' });
    const start = await within(pane).findByRole('button', { name: 'Start' });
    await userEvent.click(start);
    const alert = await within(pane).findByRole('alert');
    expect(alert.textContent).toMatch(/npm run dev stopped as soon as it started/);
    expect(within(alert).getByText('Error: port in use')).toBeTruthy();
    expect(within(pane).getByText('Failed')).toBeTruthy();

    m6.sandbox = false;
    await userEvent.click(start);
    expect(
      await within(pane).findByText(
        /No sandbox is available on the Hub, so dev servers cannot run/,
      ),
    ).toBeTruthy();
  });

  it('follows dev server events and says when nothing was found', async () => {
    const { view, m6, s } = await openM6Session({ id: 'cs-dev3' });
    await userEvent.click(tab('Dev servers'));
    const pane = within(view).getByRole('region', { name: 'Dev servers' });
    expect(await within(pane).findByRole('heading', { name: 'No dev server found' })).toBeTruthy();
    // The agent started one with devserver.start.
    m6.devServers = [devServer(s.id, { label: 'npm run dev' })];
    emitCode('code.devserver.started', { sessionId: s.id, serverId: 'x', url: 'u' });
    expect(await within(pane).findByRole('listitem', { name: 'npm run dev' })).toBeTruthy();
  });
});

describe('Checks pane (FR-068)', () => {
  it('runs the checks, follows the run to its result, and shows the logs', async () => {
    const { view, api, m6, s } = await openM6Session(
      { id: 'cs-ver' },
      {
        settings: {
          'code.autoVerify': { enabled: true, commands: [], timeoutSeconds: 600, feedbackTurns: 2 },
        },
        m6: {
          verifyRuns: [
            verifyRun('cs-ver', {
              createdAt: '2026-10-01T11:00:00.000Z',
              status: 'passed',
            }),
          ],
          nextVerify: {
            status: 'failed',
            checks: [
              verifyCheck({ name: 'build', command: 'npm run build' }),
              verifyCheck({
                name: 'test',
                status: 'failed',
                exitCode: 1,
                log: 'FAIL src/total.test.ts\n  expected 3, got 4',
                durationMs: 12_400,
              }),
            ],
          },
        },
      },
    );
    await userEvent.click(tab('Checks'));
    const pane = within(view).getByRole('region', { name: 'Checks' });
    expect(
      within(pane).getByText(/Failed checks go back to the agent twice in a row at most/),
    ).toBeTruthy();
    expect(await within(pane).findByRole('article', { name: 'Checks: Latest' })).toBeTruthy();
    expect(within(pane).getByText('All checks passed')).toBeTruthy();

    await userEvent.click(within(pane).getByRole('button', { name: /Run checks/ }));
    await waitFor(() => expect(api.runVerify).toHaveBeenCalledWith(s.id));
    expect(await within(pane).findByText('Checking')).toBeTruthy();
    expect(within(pane).getByRole('button', { name: /Run checks/ })).toHaveProperty(
      'disabled',
      true,
    );
    await waitFor(() => expect(announcer()).toMatch(/Checks started/));

    // The Hub finishes the run and announces it.
    finishVerify(m6, s.id);
    emitCode('code.verify.completed', { sessionId: s.id, verifyId: 'x', status: 'failed' });
    const latest = await within(pane).findByRole('article', { name: 'Checks: Latest' });
    await within(latest).findByText('Checks failed');
    const results = within(latest).getByRole('list', { name: 'Check results' });
    expect(within(results).getByText('npm run build')).toBeTruthy();
    expect(within(results).getByText('exit 1 · 12 s')).toBeTruthy();
    // A failed check's log is open; it is plain text.
    const log = within(results).getByText(/expected 3, got 4/);
    expect(log.tagName).toBe('PRE');
    expect(within(pane).getByText('Earlier runs (1)')).toBeTruthy();
  });

  it('says when checks already run, and when auto-verify is off', async () => {
    const { view, api } = await openM6Session(
      { id: 'cs-ver2' },
      {
        settings: {
          'code.autoVerify': {
            enabled: false,
            commands: ['make check'],
            timeoutSeconds: 60,
            feedbackTurns: 0,
          },
        },
      },
    );
    await userEvent.click(tab('Checks'));
    const pane = within(view).getByRole('region', { name: 'Checks' });
    expect(within(pane).getByText(/Auto-verify is off/)).toBeTruthy();
    expect(await within(pane).findByText('Runs make check.')).toBeTruthy();
    api.runVerify.mockRejectedValueOnce(
      Object.assign(new Error('the checks are already running'), {
        body: {
          code: 'conflict',
          message: 'x',
          retryable: false,
          details: { reason: 'verify_running' },
        },
      }),
    );
    await userEvent.click(within(pane).getByRole('button', { name: /Run checks/ }));
    expect(await screen.findByText('The checks are already running.')).toBeTruthy();
  });
});

describe('Sessions pane and side questions (FR-072)', () => {
  it('lists the other sessions to open, message, ask about and archive', async () => {
    const other = codeSession({
      id: 'cs-other',
      title: 'Update the docs',
      derived: { status: 'needs_input', reason: 'Approval needed' },
    });
    const { view, hub, m6 } = await openM6Session({ id: 'cs-main' }, { others: [other] });
    await userEvent.click(tab('Sessions'));
    const pane = within(view).getByRole('region', { name: 'Sessions' });
    const list = await within(pane).findByRole('list', { name: 'Other sessions' });
    const row = within(list).getByRole('listitem', { name: 'Update the docs' });
    expect(within(row).getByText('Needs input: Approval needed')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Update the docs' })).toHaveProperty(
      'pathname',
      '/code/cs-other',
    );

    await userEvent.click(within(row).getByRole('button', { name: /Message/ }));
    const msg = await screen.findByRole('dialog', { name: 'Message “Update the docs”' });
    await userEvent.type(within(msg).getByRole('textbox', { name: 'Message' }), 'Rebase on main');
    await userEvent.click(within(msg).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(hub.api.sendMessage).toHaveBeenCalledWith(other.threadId, { text: 'Rebase on main' }),
    );
    await waitFor(() => expect(announcer()).toMatch(/Message sent to Update the docs/));

    await userEvent.click(within(row).getByRole('button', { name: /Ask/ }));
    const ask = await screen.findByRole('dialog', { name: 'Side question: Update the docs' });
    await userEvent.type(within(ask).getByRole('textbox', { name: 'Question' }), 'What is left?');
    await userEvent.click(within(ask).getByRole('button', { name: 'Ask' }));
    expect(
      await within(ask).findByText('It is fixing the flaky test in src/total.test.ts.'),
    ).toBeTruthy();
    expect(within(ask).getByText('You asked: What is left?')).toBeTruthy();
    expect(m6.asks).toEqual([{ sessionId: 'cs-other', question: 'What is left?' }]);
    await userEvent.click(within(ask).getByRole('button', { name: 'Close' }));

    await userEvent.click(within(row).getByRole('button', { name: /Archive/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Archive “Update the docs”?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Archive' }));
    await waitFor(() =>
      expect(hub.api.updateThread).toHaveBeenCalledWith(other.threadId, { archived: true }),
    );
    await waitFor(() =>
      expect(within(pane).queryByRole('list', { name: 'Other sessions' })).toBeNull(),
    );
    expect(within(pane).getByRole('heading', { name: 'No other sessions' })).toBeTruthy();
  });

  it('asks a side question about this session with Ctrl+Alt+S; a failure keeps the question', async () => {
    const { api, s } = await openM6Session({ id: 'cs-ask', title: 'Fix the parser' });
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', code: 'KeyS', ctrlKey: true, altKey: true });
      await Promise.resolve();
    });
    const ask = await screen.findByRole('dialog', { name: 'Side question: Fix the parser' });
    const q = within(ask).getByRole('textbox', { name: 'Question' });
    expect(document.activeElement).toBe(q);
    api.askCodeSession.mockRejectedValueOnce(new Error('choose a model for this session first'));
    await userEvent.type(q, 'Why did the test fail?');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(await within(ask).findByText('choose a model for this session first')).toBeTruthy();
    expect((q as HTMLTextAreaElement).value).toBe('Why did the test fail?');
    await userEvent.click(within(ask).getByRole('button', { name: 'Ask' }));
    expect(
      await within(ask).findByText('It is fixing the flaky test in src/total.test.ts.'),
    ).toBeTruthy();
    expect(api.askCodeSession).toHaveBeenLastCalledWith(s.id, 'Why did the test fail?');
    expect(within(ask).getByText('Answered by pa1/mock-smart')).toBeTruthy();
  });
});
