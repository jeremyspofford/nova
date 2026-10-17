import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { FOLDER_POLL_MS } from '../src/projects/ProjectFolders.tsx';
import { createHub } from './fakes.ts';
import { m4State } from './fakes-m4.ts';
import { folder } from './fakes-m4-settings.ts';
import { captureIntervals, project, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const fail = (message: string, status = 500, code = 'x') =>
  new ApiError(status, { code, message, retryable: false });

const setup = (folders = [folder({ id: 'f1', projectId: 'p1' })]) =>
  createHub({
    workspace: workspaceState({ projects: [project({ id: 'p1', name: 'Garden plan' })] }),
    m4: m4State({ folders }),
  });

describe('Project folders (FR-035)', () => {
  it('lists folders with access and status, adds one and follows its indexing', async () => {
    const timers = captureIntervals(FOLDER_POLL_MS);
    const hub = setup([
      folder({ id: 'f1', projectId: 'p1' }),
      folder({ id: 'f2', projectId: 'other', path: '/elsewhere' }),
      folder({
        id: 'f3',
        projectId: 'p1',
        path: '/home/me/broken',
        status: 'error',
        fileCount: 0,
        error: 'Permission denied',
        indexedAt: null,
      }),
    ]);
    await renderApp({ hub, path: '/projects/p1' });
    const list = await screen.findByRole('list', { name: 'Project folders' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const notes = within(list).getByRole('listitem', { name: '/home/me/notes' });
    expect(within(notes).getByText('Read only')).toBeTruthy();
    expect(within(notes).getByText('Ready')).toBeTruthy();
    expect(within(notes).getByText(/12 files · indexed/)).toBeTruthy();
    const broken = within(list).getByRole('listitem', { name: '/home/me/broken' });
    expect(within(broken).getByText('Could not index')).toBeTruthy();
    expect(within(broken).getByText('Permission denied')).toBeTruthy();
    expect(timers.count()).toBe(0);

    const path = screen.getByRole('textbox', { name: 'Folder on the Hub' });
    await userEvent.type(path, 'docs');
    await userEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(screen.getByText(/Enter the full path of a folder on the Hub/)).toBeTruthy();
    await userEvent.clear(path);
    await userEvent.type(path, '/home/me/notes');
    await userEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(screen.getByText('That folder is already in this project.')).toBeTruthy();
    expect(hub.api.addProjectFolder).not.toHaveBeenCalled();

    await userEvent.clear(path);
    await userEvent.type(path, '/home/me/code');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Access' }), 'write');
    hub.state.failNext.addProjectFolder = fail(
      '/home/me/code is outside the allowed folders',
      403,
      'policy_denied',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    expect(await screen.findByText('/home/me/code is outside the allowed folders')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add folder' }));
    await waitFor(() =>
      expect(hub.api.addProjectFolder).toHaveBeenLastCalledWith('p1', {
        path: '/home/me/code',
        access: 'write',
      }),
    );
    expect(await screen.findByText('/home/me/code added. Indexing it now.')).toBeTruthy();
    const code = screen.getByRole('listitem', { name: '/home/me/code' });
    expect(within(code).getByText('Indexing')).toBeTruthy();
    expect(within(code).getByText('Read and write')).toBeTruthy();
    await waitFor(() => expect(timers.count()).toBe(1));

    hub.state.m4.folders = hub.state.m4.folders.map((f) =>
      f.path === '/home/me/code'
        ? { ...f, status: 'ready', fileCount: 40, indexedAt: '2026-10-01T12:00:00.000Z' }
        : f,
    );
    timers.fire();
    expect(
      await within(screen.getByRole('listitem', { name: '/home/me/code' })).findByText('Ready'),
    ).toBeTruthy();
    expect(screen.getByText(/40 files/)).toBeTruthy();
    await waitFor(() => expect(timers.count()).toBe(0));
  });

  it('removes a folder after confirmation and reports failures', async () => {
    const hub = setup();
    await renderApp({ hub, path: '/projects/p1' });
    const row = await screen.findByRole('listitem', { name: '/home/me/notes' });
    hub.state.failNext.removeProjectFolder = fail('Hub busy');
    await userEvent.click(within(row).getByRole('button', { name: 'Remove /home/me/notes' }));
    let dialog = screen.getByRole('dialog', { name: 'Remove this folder from the project?' });
    expect(within(dialog).getByText(/stays on the Hub/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Could not remove /home/me/notes: Hub busy')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Remove /home/me/notes' }));
    dialog = screen.getByRole('dialog', { name: 'Remove this folder from the project?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('/home/me/notes removed from the project.')).toBeTruthy();
    expect(screen.getByText('No folders in this project yet.')).toBeTruthy();
    expect(hub.state.m4.folders).toEqual([]);
  });

  it('shows a load failure with retry', async () => {
    const hub = setup();
    hub.state.failNext.listProjectFolders = fail('Folders unavailable');
    await renderApp({ hub, path: '/projects/p1' });
    expect(await screen.findByText('Folders unavailable')).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Folders' });
    await userEvent.click(within(region).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('listitem', { name: '/home/me/notes' })).toBeTruthy();
  });
});
