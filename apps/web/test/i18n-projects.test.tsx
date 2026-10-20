// Projects in the pseudo-locale (FR-016): the list, New project, a project's page with its chats,
// sources and folders, and the delete confirmation. Project, chat, source and folder names are
// fixture data; the agent browser's site levels on the page are the browser area's.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { NEW_PROJECT_TEXT } from '../src/projects/NewProjectDialog.tsx';
import { PROJECT_TEXT } from '../src/projects/ProjectDetail.tsx';
import { FOLDERS_TEXT } from '../src/projects/ProjectFolders.tsx';
import { PROJECTS_TEXT } from '../src/projects/ProjectsView.tsx';
import { SOURCES_TEXT } from '../src/projects/SourcesPanel.tsx';
import { SIDEBAR_TEXT } from '../src/shell/strings.ts';
import { createHub, thread } from './fakes.ts';
import { m4State } from './fakes-m4.ts';
import { folder } from './fakes-m4-settings.ts';
import { project, source, workspaceState } from './fakes-workspace.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

const DATA = ['Garden plan', 'Seed order', 'notes.md', '/home/me/notes', 'Grow tomatoes.'];
/** The agent browser's per-project site levels (browser area). */
const OTHER_AREAS = ['.brw-scope-levels'];

function gardenHub() {
  const garden = project({
    id: 'p1',
    name: 'Garden plan',
    threadCount: 2,
    sourceCount: 1,
    instructions: 'Grow tomatoes.',
  });
  return createHub({
    threads: [thread({ title: 'Seed order', projectId: 'p1' })],
    workspace: workspaceState({
      projects: [garden],
      sources: [
        source('p1'),
        source('p1', { name: 'notes.md', status: 'error', error: null, chunkCount: 0 }),
      ],
    }),
    m4: m4State({ folders: [folder({ projectId: 'p1' })] }),
  });
}

async function renderIn(locale: string, path: string) {
  await activateTestLocale(locale);
  const r = await renderApp({ hub: gardenHub(), path, ready: false });
  await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });
  return r;
}

describe('projects in a pseudo-locale', () => {
  it('shows the list and the New project dialog localized', async () => {
    await renderIn('en-XA', '/projects');
    const heading = await screen.findByRole('heading', { name: PROJECTS_TEXT.title, level: 1 });
    const page = heading.closest('.ws-page')!;
    await within(page as HTMLElement).findByRole('list', { name: PROJECTS_TEXT.title });
    expectFullyLocalized(page, { data: DATA });

    await userEvent.click(screen.getAllByRole('button', { name: PROJECTS_TEXT.new })[0]!);
    const dialog = screen.getByRole('dialog', { name: NEW_PROJECT_TEXT.title });
    expectFullyLocalized(dialog, { data: DATA });
  });

  it('shows a project page with chats, sources, folders and the delete dialog localized', async () => {
    await renderIn('en-XA', '/projects/p1');
    const heading = await screen.findByRole('heading', { name: 'Garden plan', level: 1 });
    const page = heading.closest('.ws-page') as HTMLElement;
    await within(page).findByRole('list', { name: PROJECT_TEXT.chatList });
    await within(page).findByRole('list', { name: SOURCES_TEXT.title });
    await within(page).findByRole('list', { name: FOLDERS_TEXT.list });
    expectFullyLocalized(page, { data: DATA, skip: OTHER_AREAS });

    await userEvent.click(within(page).getByRole('button', { name: SOURCES_TEXT.paste }));
    expect(within(page).getByRole('form', { name: SOURCES_TEXT.pasteForm })).toBeTruthy();
    expectFullyLocalized(page, { data: DATA, skip: OTHER_AREAS });

    await userEvent.click(within(page).getAllByRole('button', { name: PROJECT_TEXT.delete })[0]!);
    const dialog = screen.getByRole('dialog', { name: PROJECT_TEXT.deleteTitle });
    expectFullyLocalized(dialog, { data: DATA });
  });
});
