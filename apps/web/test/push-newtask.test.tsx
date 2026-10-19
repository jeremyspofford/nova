// New task from a phone (FR-077, FR-111): a Work run from instructions and an optional project, a
// Code session in a project folder with the instructions as its first message; a project without
// folders cannot start a Code session (and says how to add one); empty instructions and Hub errors
// keep the sheet open with what was typed.
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { NewTaskSheet } from '../src/dispatch/NewTaskSheet.tsx';
import { createHub } from './fakes.ts';
import { folder } from './fakes-m4-settings.ts';
import { renderWithPush } from './fakes-m7-push.ts';
import { project } from './fakes-workspace.ts';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

function hubWithProjects(opts: { folders?: boolean } = {}) {
  const hub = createHub();
  hub.state.workspace.projects = [
    project({ id: 'p1', name: 'Billing' }),
    project({ id: 'p2', name: 'Website' }),
  ];
  if (opts.folders !== false)
    hub.state.m4.folders = [
      folder({ id: 'f1', projectId: 'p2', path: '/srv/website', access: 'write' }),
      folder({ id: 'f2', projectId: 'p2', path: '/srv/website-docs', access: 'read' }),
    ];
  return hub;
}

async function openSheet(hub = hubWithProjects()) {
  const onClose = vi.fn();
  const onStarted = vi.fn();
  const r = await renderWithPush(<NewTaskSheet open onClose={onClose} onStarted={onStarted} />, {
    hub,
  });
  const dialog = await screen.findByRole('dialog', { name: 'New task' });
  await within(dialog).findByRole('combobox', { name: 'Project' });
  return { ...r, dialog, onClose, onStarted };
}

describe('New task', () => {
  it('starts a Work run with the instructions and the project', async () => {
    const { dialog, hub, onStarted, onClose } = await openSheet();
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Project' }), 'p1');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'What should it do?' }),
      'Summarize this week’s invoices',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    const run = hub.state.m5work.runs.at(-1)!;
    expect(run).toMatchObject({ objective: 'Summarize this week’s invoices', projectId: 'p1' });
    expect(onStarted).toHaveBeenCalledWith({ kind: 'work', id: run.id, path: `/work/${run.id}` });
    expect(window.location.pathname).toBe(`/work/${run.id}`);
    expect(onClose).toHaveBeenCalled();
  });

  it('starts a Code session in a project folder and sends the instructions', async () => {
    const hub = hubWithProjects();
    const sent = hub.api.sendMessage.mockResolvedValue({
      disposition: 'started',
      turnId: 'turn1',
      userMessageId: 'm1',
      assistantMessageId: 'm2',
    });
    const { dialog, onStarted } = await openSheet(hub);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Code session' }));
    // Only projects with a folder can take a Code session.
    const select = within(dialog).getByRole('combobox', { name: 'Project' });
    expect(within(select).queryByRole('option', { name: 'Billing' })).toBeNull();
    await userEvent.selectOptions(select, 'p2');
    // The writable folder is chosen first.
    expect(within(dialog).getByRole<HTMLSelectElement>('combobox', { name: 'Folder' }).value).toBe(
      'f1',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'What should it do?' }),
      'Fix the footer links',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    const started = onStarted.mock.calls[0]![0] as { id: string; path: string };
    expect(started.path).toBe(`/code/${started.id}`);
    expect(sent).toHaveBeenCalledWith(expect.any(String), { text: 'Fix the footer links' });
  });

  it('still opens the session when the instructions could not be sent', async () => {
    const hub = hubWithProjects();
    hub.api.sendMessage.mockRejectedValue(
      new ApiError(503, { code: 'unavailable', message: 'Busy.', retryable: true }),
    );
    const { dialog, onStarted } = await openSheet(hub);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Code session' }));
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Project' }), 'p2');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'What should it do?' }), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(await screen.findByText(/your instructions were not sent: Busy\./)).toBeTruthy();
  });

  it('says how to add a folder when no project has one', async () => {
    const { dialog } = await openSheet(hubWithProjects({ folders: false }));
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Code session' }));
    expect(within(dialog).getByText(/No project has a folder yet/)).toBeTruthy();
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Start' }).disabled).toBe(
      true,
    );
  });

  it('asks for instructions and asks for a project for Code', async () => {
    const { dialog, hub } = await openSheet();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(within(dialog).getByRole('alert').textContent).toBe('Say what the task should do.');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Code session' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'What should it do?' }), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Choose a project with a folder for the Code session.',
    );
    expect(hub.state.m5work.runs).toHaveLength(0);
  });

  it('keeps what was typed when the Hub refuses', async () => {
    const hub = hubWithProjects();
    hub.state.failNext.createRun = new ApiError(429, {
      code: 'rate_limited',
      message: 'Too many runs at once.',
      retryable: true,
    });
    const { dialog } = await openSheet(hub);
    const box = within(dialog).getByRole('textbox', { name: 'What should it do?' });
    await userEvent.type(box, 'Do the thing');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'The task did not start: Too many runs at once.',
    );
    expect((box as HTMLTextAreaElement).value).toBe('Do the thing');
  });

  it('retries when the projects do not load', async () => {
    const hub = hubWithProjects();
    hub.state.failNext.listProjects = new TypeError('Failed to fetch');
    await renderWithPush(<NewTaskSheet open onClose={() => undefined} />, { hub });
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(/Cannot reach the Hub/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(await within(dialog).findByRole('combobox', { name: 'Project' })).toBeTruthy();
  });

  it('renders nothing while closed', async () => {
    await renderWithPush(<NewTaskSheet open={false} onClose={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
