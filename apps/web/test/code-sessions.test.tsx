import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { codeHub, emitCode, openSession } from './code-helpers.tsx';
import { FakeEventSource } from './fakes.ts';
import { codeSession, environment } from './fakes-m5-code.ts';
import { project } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

const announcer = () => screen.getByTestId('announcer').textContent ?? '';
const modeSelect = () =>
  screen.getByRole<HTMLSelectElement>('combobox', { name: 'Permission mode' });
const option = (select: HTMLSelectElement, value: string) =>
  [...select.options].find((o) => o.value === value)!;

describe('Code sessions list (FR-061, FR-215)', () => {
  it('lists sessions Needs input first with folder, branch, mode, status and update time', async () => {
    const ready = codeSession({ title: 'Tidy the README', updatedAt: '2026-10-01T12:00:30Z' });
    const needs = codeSession({
      title: 'Fix the flaky test',
      permissionMode: 'accept_edits',
      repo: { root: '/home/me/app', branch: 'main', head: 'abc', dirty: true },
      derived: { status: 'needs_input', reason: 'Approval needed' },
    });
    const hub = codeHub([ready, needs]);
    await renderApp({ hub, path: '/code' });
    const list = await screen.findByRole('list', { name: 'Code sessions' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Fix the flaky test',
      'Tidy the README',
    ]);
    const first = rows[0]!;
    expect(within(first).getByText('Needs input: Approval needed')).toBeTruthy();
    expect(within(first).getByText('/home/me/app')).toBeTruthy();
    expect(within(first).getByText(/main, uncommitted changes/)).toBeTruthy();
    expect(within(first).getByText('Mode: Accept edits')).toBeTruthy();
    expect(within(rows[1]!).getByText('Ready')).toBeTruthy();
    expect(within(rows[1]!).getByText(/^Updated /)).toBeTruthy();

    // A session event refreshes the list.
    hub.state.m5code.sessions = [
      ...hub.state.m5code.sessions,
      codeSession({ title: 'Third session' }),
    ];
    emitCode('code.session.created', { sessionId: 'x', environmentId: null, mode: 'manual' });
    expect(await within(list).findByRole('listitem', { name: 'Third session' })).toBeTruthy();

    await userEvent.click(within(first).getByRole('link', { name: 'Fix the flaky test' }));
    expect(window.location.pathname).toBe(`/code/${needs.id}`);
  });

  it('shows an empty state, and a load failure with Retry', async () => {
    const hub = codeHub([]);
    hub.state.failNext.listCodeSessions = new Error('boom');
    await renderApp({ hub, path: '/code' });
    expect(await screen.findByText('boom')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'No Code sessions yet' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Start a session' }));
    expect(await screen.findByRole('dialog', { name: 'New Code session' })).toBeTruthy();
  });

  it('loads nothing and opens no stream until Code mode is opened', async () => {
    const hub = codeHub([codeSession()]);
    await renderApp({ hub, path: '/chat' });
    expect(hub.api.listCodeSessions).not.toHaveBeenCalled();
    expect(FakeEventSource.all.some((s) => s.listeners.has('code.changes.updated'))).toBe(false);
    await userEvent.click(
      within(screen.getByRole('list', { name: 'Modes' })).getByRole('link', { name: /Code/ }),
    );
    await waitFor(() => expect(hub.api.listCodeSessions).toHaveBeenCalled());
    expect(FakeEventSource.all.some((s) => s.listeners.has('code.changes.updated'))).toBe(true);
  });
});

describe('New Code session (FR-061, FR-062, FR-063, FR-073)', () => {
  it('starts a session in a project folder with the environment, model, mode and worktree', async () => {
    const p = project({ name: 'Garden app' });
    const local = environment({ label: 'This Hub' });
    const box = environment({ kind: 'container', label: 'Sandbox box' });
    const down = environment({ label: 'Old laptop', status: 'down' });
    const hub = codeHub([], {
      code: { environments: [local, box, down] },
      settings: { 'code.permissionMode': 'accept_edits', 'code.allowBypass': true },
    });
    hub.state.workspace.projects = [p];
    hub.state.m4.folders = [
      {
        id: 'fold1',
        projectId: p.id,
        path: '/home/me/garden',
        access: 'write',
        status: 'ready',
        fileCount: 3,
        error: null,
        indexedAt: null,
      },
    ];
    await renderApp({ hub, path: '/code?new=1' });
    const dialog = await screen.findByRole('dialog', { name: 'New Code session' });
    const folder = await within(dialog).findByRole<HTMLSelectElement>('combobox', {
      name: 'Folder',
    });
    expect(folder.value).toBe('fold1');
    expect(within(dialog).queryByRole('textbox', { name: 'Folder path on the Hub' })).toBeNull();
    const env = within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Environment' });
    expect(env.value).toBe(local.id);
    expect(option(env, down.id).disabled).toBe(true);
    expect(option(env, down.id).textContent).toBe('Old laptop (Unavailable)');

    // The default mode from Settings → Code; Auto needs a reviewer, Bypass a container.
    const mode = within(dialog).getByRole<HTMLSelectElement>('combobox', {
      name: 'Permission mode',
    });
    expect(mode.value).toBe('accept_edits');
    expect(option(mode, 'auto').disabled).toBe(true);
    expect(option(mode, 'auto').textContent).toMatch(/needs a reviewer model/);
    expect(option(mode, 'bypass').disabled).toBe(true);
    expect(option(mode, 'bypass').textContent).toMatch(/needs a VM or container environment/);
    await userEvent.selectOptions(env, box.id);
    expect(option(mode, 'bypass').disabled).toBe(false);
    await userEvent.selectOptions(mode, 'plan');
    expect(within(dialog).getByText(/Reads and explores only/)).toBeTruthy();

    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Model' }),
      'pa1/mock-smart',
    );
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Title (optional)' }), 'Fix');
    await userEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Work in a new Git worktree' }),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start session' }));
    await waitFor(() =>
      expect(hub.api.createCodeSession).toHaveBeenCalledWith({
        folder: '/home/me/garden',
        projectId: p.id,
        environmentId: box.id,
        permissionMode: 'plan',
        model: 'pa1/mock-smart',
        title: 'Fix',
        worktree: true,
      }),
    );
    const created = hub.state.m5code.sessions[0]!;
    await waitFor(() => expect(window.location.pathname).toBe(`/code/${created.id}`));
    expect(await screen.findByRole('region', { name: 'Code session: Fix' })).toBeTruthy();
  });

  it('takes a typed Hub path, remembers the folder’s mode, and keeps the form on failure', async () => {
    const hub = codeHub([], {
      settings: { 'code.folderModes': { '/srv/api': 'accept_edits' } },
    });
    await renderApp({ hub, path: '/code' });
    await userEvent.click(await screen.findByRole('button', { name: 'New session' }));
    const dialog = await screen.findByRole('dialog', { name: 'New Code session' });
    const path = await within(dialog).findByRole('textbox', { name: 'Folder path on the Hub' });
    const start = within(dialog).getByRole('button', { name: 'Start session' });
    expect(start).toHaveProperty('disabled', true);
    expect(within(dialog).getByText('The session runs on the Hub.')).toBeTruthy();
    await userEvent.type(path, '/srv/api');
    const mode = within(dialog).getByRole<HTMLSelectElement>('combobox', {
      name: 'Permission mode',
    });
    expect(mode.value).toBe('accept_edits');
    hub.state.failNext.createCodeSession = new ApiError(400, {
      code: 'validation',
      message: 'That folder does not exist on the Hub',
      retryable: false,
    });
    await userEvent.click(start);
    expect(await within(dialog).findByText('That folder does not exist on the Hub')).toBeTruthy();
    expect(hub.api.createCodeSession).toHaveBeenCalledWith({
      folder: '/srv/api',
      permissionMode: 'accept_edits',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Code session view (FR-061, FR-063)', () => {
  it('shows the header and the session’s conversation with the mode selector in its composer', async () => {
    const env = environment({ label: 'This Hub' });
    const { view, s } = await openSession(
      {
        title: 'Fix the flaky test',
        environmentId: env.id,
        repo: { root: '/home/me/app', branch: 'feature/x', head: 'abc', dirty: true },
        pullRequestUrl: 'https://git.example/pr/7',
        ciStatus: 'passed',
        derived: { status: 'running', reason: null },
      },
      { code: { environments: [env] } },
    );
    expect(
      within(view).getByRole('heading', { level: 1, name: 'Fix the flaky test' }),
    ).toBeTruthy();
    expect(within(view).getByText('Running')).toBeTruthy();
    expect(within(view).getByText(/feature\/x, uncommitted changes/)).toBeTruthy();
    expect(await within(view).findByText('This Hub')).toBeTruthy();
    expect(
      within(view).getByRole('link', { name: /Pull request \(checks: passed\)/ }),
    ).toHaveProperty('href', 'https://git.example/pr/7');
    // The conversation is the session's own thread; its chat header stays hidden.
    expect(within(view).getByRole('textbox', { name: 'Message' })).toBeTruthy();
    expect(within(view).queryByRole('heading', { name: 'A chat' })).toBeNull();
    expect(modeSelect().value).toBe(s.permissionMode);
  });

  it('switches the permission mode and explains the disabled ones', async () => {
    const { hub, s } = await openSession({ permissionMode: 'manual' });
    const select = modeSelect();
    expect(option(select, 'auto').disabled).toBe(true);
    expect(option(select, 'auto').textContent).toBe(
      'Auto (needs a reviewer model in Settings → Code)',
    );
    expect(option(select, 'bypass').textContent).toBe(
      'Bypass (needs a VM or container environment and Allow Bypass in Settings → Code)',
    );
    await userEvent.selectOptions(select, 'accept_edits');
    await waitFor(() =>
      expect(hub.api.updateCodeSession).toHaveBeenCalledWith(s.id, {
        permissionMode: 'accept_edits',
      }),
    );
    await waitFor(() => expect(announcer()).toMatch(/Permission mode: Accept edits/));

    // A refused change goes back, with the reason.
    hub.state.failNext.updateCodeSession = new ApiError(403, {
      code: 'policy_denied',
      message: 'Plan mode is disabled by policy',
      retryable: false,
    });
    await userEvent.selectOptions(select, 'plan');
    expect(await screen.findByText(/Plan mode is disabled by policy/)).toBeTruthy();
    await waitFor(() => expect(modeSelect().value).toBe('accept_edits'));
  });

  it('offers Auto with a reviewer model and Bypass on a container with the setting on', async () => {
    const box = environment({ kind: 'container', label: 'Sandbox box' });
    await openSession(
      { environmentId: box.id },
      {
        code: { environments: [box] },
        settings: { 'review.model': 'pa1/mock-smart', 'code.allowBypass': true },
      },
    );
    await waitFor(() => expect(option(modeSelect(), 'bypass').disabled).toBe(false));
    expect(option(modeSelect(), 'auto').disabled).toBe(false);
  });

  it('says when the session does not exist', async () => {
    const hub = codeHub([]);
    await renderApp({ hub, path: '/code/nope' });
    expect(await screen.findByText('This Code session does not exist.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'All sessions' }));
    expect(window.location.pathname).toBe('/code');
  });
});
