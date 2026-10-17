import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { SOURCE_POLL_MS } from '../src/projects/SourcesPanel.tsx';
import { createHub, thread } from './fakes.ts';
import { captureIntervals, project, source, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const fail = (message: string) => new ApiError(500, { code: 'x', message, retryable: true });

describe('Projects list and New project (FR-034)', () => {
  it('reaches Projects from the sidebar and creates a project with the keyboard', async () => {
    const garden = project({ name: 'Garden plan', threadCount: 2, sourceCount: 1 });
    const hub = createHub({ workspace: workspaceState({ projects: [garden] }) });
    await renderApp({ hub, path: '/chat' });
    const sidebar = screen.getByRole('navigation', { name: 'Sidebar' });
    const recent = await within(sidebar).findByRole('list', { name: 'Recent projects' });
    expect(within(recent).getByRole('link', { name: 'Garden plan' })).toBeTruthy();

    await userEvent.click(within(sidebar).getByRole('link', { name: 'Projects' }));
    expect(window.location.pathname).toBe('/projects');
    expect(
      within(sidebar).getByRole('link', { name: 'Projects' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(await screen.findByRole('heading', { name: 'Projects', level: 1 })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Projects' });
    expect(within(list).getByText(/2 chats · 1 source/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'New project' }));
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox', { name: 'Name' }));
    expect(
      within(dialog).getByText('You cannot change this after the project is created.'),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLInputElement>('radio', { name: 'Shared with my memory' })
        .checked,
    ).toBe(true);
    await userEvent.keyboard('Thesis');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Instructions (optional)' }),
      'Cite sources.',
    );
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Project only' }));
    within(dialog).getByRole('textbox', { name: 'Name' }).focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() =>
      expect(hub.api.createProject).toHaveBeenCalledWith({
        name: 'Thesis',
        memoryScope: 'project_only',
        instructions: 'Cite sources.',
      }),
    );
    const created = hub.state.workspace.projects.find((p) => p.name === 'Thesis')!;
    await waitFor(() => expect(window.location.pathname).toBe(`/projects/${created.id}`));
    expect(await screen.findByRole('heading', { name: 'Thesis', level: 1 })).toBeTruthy();
    expect(screen.getByText(/Memory: Project only\./)).toBeTruthy();
    expect(screen.getByText('Project “Thesis” created.')).toBeTruthy();
    await waitFor(() =>
      expect(
        within(recent).getByRole('link', { name: 'Thesis' }).getAttribute('aria-current'),
      ).toBe('page'),
    );
  });

  it('closes on Escape with focus restored, and keeps input when creating fails', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/projects' });
    expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeTruthy();
    const open = screen.getAllByRole('button', { name: /New project/ })[0]!;
    await userEvent.click(open);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(open));

    await userEvent.click(open);
    const dialog = screen.getByRole('dialog', { name: 'New project' });
    const create = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Create project',
    });
    expect(create.disabled).toBe(true);
    hub.state.failNext.createProject = fail('Disk full');
    await userEvent.keyboard('Trip');
    await userEvent.click(create);
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByText('Disk full')).toBeTruthy();
    expect(within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe(
      'Trip',
    );
    await userEvent.click(create);
    await waitFor(() => expect(window.location.pathname).toMatch(/^\/projects\/p/));
  });

  it('reports a failed list load and retries', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/chat' });
    // The sidebar's recent projects load at start; let that call happen before the failure is
    // armed, or it would take the failure meant for the Projects page.
    await waitFor(() => expect(hub.api.listProjects).toHaveBeenCalled());
    hub.state.failNext.listProjects = fail('Hub busy');
    await userEvent.click(screen.getByRole('link', { name: 'Projects' }));
    expect(await screen.findByText('Hub busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'No projects yet' })).toBeTruthy();
  });
});

describe('Project page (FR-034)', () => {
  it('renames, edits instructions, lists its chats and starts a chat in it', async () => {
    const p = project({ name: 'Garden plan', instructions: 'Be brief.' });
    const inProject = thread({ title: 'Seed list', projectId: p.id });
    const elsewhere = thread({ title: 'Unrelated' });
    const hub = createHub({
      threads: [inProject, elsewhere],
      workspace: workspaceState({ projects: [p] }),
    });
    await renderApp({ hub, path: `/projects/${p.id}` });
    expect(await screen.findByRole('heading', { name: 'Garden plan', level: 1 })).toBeTruthy();

    // Rename: Escape cancels, Enter saves; focus returns to Rename.
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Project name' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('heading', { name: 'Garden plan', level: 1 })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const nameBox = screen.getByRole('textbox', { name: 'Project name' });
    await userEvent.clear(nameBox);
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('Enter a name.')).toBeTruthy();
    await userEvent.type(nameBox, 'Garden 2027{Enter}');
    expect(await screen.findByRole('heading', { name: 'Garden 2027', level: 1 })).toBeTruthy();
    expect(hub.api.updateProject).toHaveBeenCalledWith(p.id, { name: 'Garden 2027' });
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Rename' })),
    );

    // Instructions: save and cancel follow the draft.
    const box = screen.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Instructions for every chat in this project',
    });
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save instructions' });
    expect(box.value).toBe('Be brief.');
    expect(save.disabled).toBe(true);
    await userEvent.type(box, ' Use metric.');
    expect(save.disabled).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(box.value).toBe('Be brief.');
    await userEvent.type(box, ' Use metric.');
    await userEvent.click(save);
    await waitFor(() =>
      expect(hub.api.updateProject).toHaveBeenLastCalledWith(p.id, {
        instructions: 'Be brief. Use metric.',
      }),
    );
    expect(await screen.findByText(/Instructions saved/)).toBeTruthy();
    expect(save.disabled).toBe(true);

    // Chats in this project only.
    const chats = await screen.findByRole('list', { name: 'Chats in this project' });
    expect(within(chats).getByRole('link', { name: 'Seed list' })).toBeTruthy();
    expect(within(chats).queryByRole('link', { name: 'Unrelated' })).toBeNull();
    expect(hub.api.listThreads).toHaveBeenCalledWith(expect.objectContaining({ projectId: p.id }));

    await userEvent.click(screen.getByRole('button', { name: 'New chat in project' }));
    await waitFor(() =>
      expect(hub.api.createThread).toHaveBeenCalledWith({ mode: 'chat', projectId: p.id }),
    );
    const created = hub.state.threads[0]!;
    expect(created.projectId).toBe(p.id);
    await waitFor(() => expect(window.location.pathname).toBe(`/chat/${created.id}`));
  });

  it('reports failures to save instructions and to start a chat', async () => {
    const p = project({ name: 'Garden plan' });
    const hub = createHub({ workspace: workspaceState({ projects: [p] }) });
    await renderApp({ hub, path: `/projects/${p.id}` });
    expect(await screen.findByText('No chats in this project yet.')).toBeTruthy();
    hub.state.failNext.updateProject = fail('Read-only');
    const box = screen.getByRole('textbox', {
      name: 'Instructions for every chat in this project',
    });
    await userEvent.type(box, 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Save instructions' }));
    expect(await screen.findByText('Read-only')).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe('Hello');
    hub.state.failNext.createThread = fail('No model');
    await userEvent.click(screen.getByRole('button', { name: 'New chat in project' }));
    expect(await screen.findByText('Could not start a chat: No model')).toBeTruthy();
    expect(window.location.pathname).toBe(`/projects/${p.id}`);
  });

  it('deletes after confirming; Escape cancels; chats are kept', async () => {
    const p = project({ name: 'Old', threadCount: 1, sourceCount: 2 });
    const t = thread({ title: 'Keep me', projectId: p.id });
    const hub = createHub({ threads: [t], workspace: workspaceState({ projects: [p] }) });
    await renderApp({ hub, path: `/projects/${p.id}` });
    await within(screen.getByRole('main')).findByRole('link', { name: 'Keep me' });
    const del = screen.getByRole('button', { name: 'Delete project' });
    await userEvent.click(del);
    const dialog = screen.getByRole('dialog', { name: 'Delete this project?' });
    expect(dialog.textContent).toMatch(/2 sources are removed\. Its 1 chat are kept/);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(hub.api.deleteProject).not.toHaveBeenCalled();
    await userEvent.click(del);
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete project' }),
    );
    await waitFor(() => expect(window.location.pathname).toBe('/projects'));
    expect(hub.api.deleteProject).toHaveBeenCalledWith(p.id);
    expect(await screen.findByText('Project “Old” deleted. Its chats are kept.')).toBeTruthy();
    expect(hub.state.threads.map((x) => x.id)).toContain(t.id);
  });

  it('shows a missing project with a way back', async () => {
    await renderApp({ path: '/projects/nope' });
    expect(
      await screen.findByRole('heading', { name: 'This project no longer exists' }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'All projects' }));
    expect(window.location.pathname).toBe('/projects');
  });
});

describe('Project sources (FR-040)', () => {
  const setup = async () => {
    const polls = captureIntervals(SOURCE_POLL_MS);
    const p = project({ name: 'Research' });
    const ready = source(p.id, { name: 'notes.md', chunkCount: 3 });
    const broken = source(p.id, {
      name: 'scan.pdf',
      mime: 'application/pdf',
      status: 'error',
      chunkCount: 0,
      error: 'This file type cannot be indexed yet',
    });
    const hub = createHub({
      workspace: workspaceState({ projects: [p], sources: [ready, broken] }),
    });
    await renderApp({ hub, path: `/projects/${p.id}` });
    const list = await screen.findByRole('list', { name: 'Sources' });
    return { hub, p, list, polls };
  };
  const row = (name: string) => screen.getByRole('listitem', { name });

  it('shows status, uploads, polls while indexing, re-indexes and removes', async () => {
    const { hub, p, polls } = await setup();
    expect(within(row('notes.md')).getByText('Ready')).toBeTruthy();
    expect(within(row('notes.md')).getByText(/3 chunks/)).toBeTruthy();
    expect(within(row('scan.pdf')).getByText('Could not index')).toBeTruthy();
    expect(within(row('scan.pdf')).getByText('This file type cannot be indexed yet')).toBeTruthy();
    expect(polls.count()).toBe(0); // nothing is indexing, so no polling

    await userEvent.upload(
      screen.getByLabelText('Upload source files'),
      new File(['# Plan\n'], 'plan.md', { type: 'text/markdown' }),
    );
    await waitFor(() =>
      expect(hub.api.addSource).toHaveBeenCalledWith(p.id, {
        kind: 'file',
        name: 'plan.md',
        mime: 'text/markdown',
        data: btoa('# Plan\n'),
      }),
    );
    expect(await screen.findByText('1 source added. Indexing has started.')).toBeTruthy();
    expect(within(row('plan.md')).getByText('Waiting to index')).toBeTruthy();

    // A source is waiting, so the list polls; the Hub finishes indexing; the next poll shows it.
    await waitFor(() => expect(polls.count()).toBe(1));
    hub.state.workspace.sources = hub.state.workspace.sources.map((s) =>
      s.name === 'plan.md' ? { ...s, status: 'ready', chunkCount: 2 } : s,
    );
    const calls = hub.api.listSources.mock.calls.length;
    polls.fire();
    expect(hub.api.listSources.mock.calls.length).toBe(calls + 1);
    await waitFor(() => expect(within(row('plan.md')).getByText('Ready')).toBeTruthy());
    expect(within(row('plan.md')).getByText(/2 chunks/)).toBeTruthy();
    // Once nothing is waiting or indexing, polling stops.
    await waitFor(() => expect(polls.count()).toBe(0));

    await userEvent.click(within(row('scan.pdf')).getByRole('button', { name: 'Re-index' }));
    await waitFor(() => expect(within(row('scan.pdf')).getByText('Waiting to index')).toBeTruthy());
    expect(hub.api.reindexSource).toHaveBeenCalled();

    await userEvent.click(within(row('notes.md')).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove this source?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'notes.md' })).toBeNull());
    expect(hub.state.workspace.sources.map((s) => s.name)).not.toContain('notes.md');
  });

  it('adds pasted text, accepts dropped files, and rejects oversized files', async () => {
    const { hub, p } = await setup();
    await userEvent.click(screen.getByRole('button', { name: 'Paste text' }));
    const form = screen.getByRole('form', { name: 'Paste text as a source' });
    expect(document.activeElement).toBe(within(form).getByRole('textbox', { name: 'Source name' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('form', { name: 'Paste text as a source' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Paste text' }));
    await userEvent.keyboard('Minutes');
    await userEvent.type(screen.getByRole('textbox', { name: 'Text' }), 'We agreed on tulips.');
    await userEvent.click(screen.getByRole('button', { name: 'Add source' }));
    await waitFor(() =>
      expect(hub.api.addSource).toHaveBeenCalledWith(p.id, {
        kind: 'text',
        name: 'Minutes',
        text: 'We agreed on tulips.',
      }),
    );
    expect(await screen.findByRole('listitem', { name: 'Minutes' })).toBeTruthy();

    const zone = screen.getByRole('region', { name: 'Sources' });
    const dropped = new File(['a,b\n1,2\n'], 'table.csv', { type: 'text/csv' });
    fireEvent.dragOver(zone, { dataTransfer: { types: ['Files'], files: [] } });
    expect(zone.dataset.dragging).toBe('true');
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [dropped] } });
    expect(zone.dataset.dragging).toBeUndefined();
    expect(await screen.findByRole('listitem', { name: 'table.csv' })).toBeTruthy();

    const big = new File(['x'], 'huge.txt', { type: 'text/plain' });
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 });
    await userEvent.upload(screen.getByLabelText('Upload source files'), big);
    expect(
      await screen.findByText(/huge\.txt is 20\.0 MB; a source can be at most 20\.0 MB/),
    ).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'huge.txt' })).toBeNull();
  });

  it('reports a failed upload and a failed load', async () => {
    const { hub } = await setup();
    hub.state.failNext.addSource = fail('Quota reached');
    await userEvent.upload(
      screen.getByLabelText('Upload source files'),
      new File(['x'], 'a.txt', { type: 'text/plain' }),
    );
    expect(await screen.findByText('Could not add a.txt: Quota reached')).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'a.txt' })).toBeNull();

    hub.state.failNext.deleteSource = fail('Locked');
    await userEvent.click(within(row('notes.md')).getByRole('button', { name: 'Remove' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    expect(await screen.findByText('Could not remove notes.md: Locked')).toBeTruthy();
    expect(row('notes.md')).toBeTruthy();
  });
});
