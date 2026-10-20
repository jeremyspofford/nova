// Files, the editor, the preview and the terminal in the pseudo-locale (FR-016): every word these
// areas own comes from messages. File names, folder labels and file text are fixture data; the
// panes' titles and the bottom panel around the terminal are the layout area's.
import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { FileContentView, FileEntryView } from '@nova/shared';
import { EDITOR_TEXT, clearEditorDrafts } from '../src/files/EditorPane.tsx';
import { FILES_TEXT } from '../src/files/FileBrowser.tsx';
import { PREVIEW_TEXT } from '../src/files/PreviewPane.tsx';
import { baseName } from '../src/files/types.ts';
import { defaultLayout, splitPane, type ModeLayout } from '../src/layout/model.ts';
import { SHELL_TEXT, SIDEBAR_TEXT } from '../src/shell/strings.ts';
import { TERMINAL_TEXT } from '../src/terminal/session.ts';
import { createHub } from './fakes.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  clearEditorDrafts();
});

const ROOT = '/data/workspace';
/** Fixture names and text, and the key letters of shortcuts ("Ctrl+S"). */
const DATA = [
  ROOT,
  'README.md',
  'src',
  'logo.png',
  'Workspace',
  'notes.txt',
  'hello world',
  'doc.md',
];
const KEY_LETTERS = ['S', 'Z', 'Y'];

function entry(path: string, kind: 'file' | 'dir', mime: string | null = null, size = 10) {
  const v: FileEntryView = {
    path,
    name: baseName(path),
    kind,
    size: kind === 'dir' ? null : size,
    mime,
    modifiedAt: null,
  };
  return v;
}

function content(path: string, text: string | null, over: Partial<FileContentView> = {}) {
  const v: FileContentView = {
    root: ROOT,
    path,
    mime: 'text/plain',
    size: text?.length ?? 4096,
    text,
    sha256: `sha-${path}`,
    readOnly: false,
    ...over,
  };
  return v;
}

function layoutWith(kind: 'editor' | 'preview', path: string): Record<string, ModeLayout> {
  return { chat: splitPane(defaultLayout(), 'main', 'row', kind, { root: ROOT, path }).layout };
}

async function renderIn(locale: string, hub: ReturnType<typeof createHub>) {
  await activateTestLocale(locale);
  const r = await renderApp({ hub, ready: false });
  await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });
  return r;
}

describe('files and the terminal in a pseudo-locale', () => {
  it('shows the file browser localized', async () => {
    const hub = createHub();
    hub.state.m4.files.set(`${ROOT}::`, [
      entry('README.md', 'file', 'text/markdown', 12),
      entry('src', 'dir'),
      entry('logo.png', 'file', 'image/png', 2048),
    ]);
    await renderIn('en-XA', hub);
    const inspector = screen.getByRole('complementary', { name: SHELL_TEXT.inspector });
    await userEvent.click(within(inspector).getByRole('tab', { name: SHELL_TEXT.tabs.files }));
    const tree = await within(inspector).findByRole('tree', {
      name: FILES_TEXT.filesIn({ folder: 'Workspace' }),
    });
    const browser = tree.closest('section')!;
    expect(browser.getAttribute('aria-label')).toBe(FILES_TEXT.title);
    expectFullyLocalized(browser, { data: DATA });
  });

  it('shows the editor localized, with unsaved changes', async () => {
    const hub = createHub();
    hub.state.settings['workspace.layout'] = layoutWith('editor', 'notes.txt');
    hub.state.m4.contents.set(`${ROOT}::notes.txt`, content('notes.txt', 'hello'));
    await renderIn('en-XA', hub);
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: EDITOR_TEXT.contents({ name: 'notes.txt' }),
    });
    await userEvent.type(box, ' world');
    const editor = box.closest('.editor')!;
    expect(editor.textContent).toContain(EDITOR_TEXT.unsaved);
    expectFullyLocalized(editor, { data: [...DATA, ...KEY_LETTERS] });
  });

  it('shows the preview localized', async () => {
    const hub = createHub();
    hub.state.settings['workspace.layout'] = layoutWith('preview', 'doc.md');
    hub.state.m4.contents.set(
      `${ROOT}::doc.md`,
      content('doc.md', '# Title\n\nBody', { mime: 'text/markdown' }),
    );
    await renderIn('en-XA', hub);
    const article = await screen.findByRole('article', {
      name: PREVIEW_TEXT.preview({ name: 'doc.md' }),
    });
    await within(article).findByRole('heading', { name: 'Title' });
    expectFullyLocalized(article, { data: [...DATA, 'Title', 'Body', 'text/markdown'] });
  });

  it('shows the terminal panel localized', async () => {
    const hub = createHub();
    await renderIn('en-XA', hub);
    screen.getByRole('textbox', { name: /./ }).focus();
    await userEvent.keyboard('{Control>}j{/Control}');
    const tab = await screen.findByRole('tab', { name: TERMINAL_TEXT.numbered({ n: 1 }) });
    const panel = tab.closest('.terminal-panel')!;
    await waitFor(() => expect(panel.querySelector('.terminal-status')).toBeTruthy());
    // The screen itself is xterm's (a fake in tests); its text is the shell's output.
    expectFullyLocalized(panel, { skip: ['.terminal-screen'] });
  });
});
