import { afterEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { FileContentView, FileEntryView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import {
  EMPTY_HISTORY,
  clearEditorDrafts,
  pushHistory,
  redo,
  undo,
} from '../src/files/EditorPane.tsx';
import {
  baseName,
  extensionOf,
  hasRichPreview,
  isTextFile,
  lineCount,
  opensIn,
  previewKind,
} from '../src/files/types.ts';
import { defaultLayout, splitPane, type ModeLayout } from '../src/layout/model.ts';
import { createHub, testRegistry } from './fakes.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  clearEditorDrafts();
});

const ROOT = '/data/workspace';

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

function filesHub() {
  const hub = createHub();
  const m4 = hub.state.m4;
  m4.files.set(`${ROOT}::`, [
    entry('README.md', 'file', 'text/markdown', 12),
    entry('src', 'dir'),
    entry('logo.png', 'file', 'image/png', 2048),
  ]);
  m4.files.set(`${ROOT}::src`, [entry('src/main.ts', 'file', 'text/typescript', 20)]);
  m4.contents.set(
    `${ROOT}::README.md`,
    content('README.md', '# Hello\n\nSome text.', { mime: 'text/markdown' }),
  );
  m4.contents.set(`${ROOT}::src/main.ts`, content('src/main.ts', 'const a = 1;\nexport { a };\n'));
  m4.contents.set(`${ROOT}::logo.png`, content('logo.png', null, { mime: 'image/png' }));
  return hub;
}

function layoutWith(kind: 'editor' | 'preview', path: string): Record<string, ModeLayout> {
  return { chat: splitPane(defaultLayout(), 'main', 'row', kind, { root: ROOT, path }).layout };
}

const inspector = () => screen.getByRole('complementary', { name: 'Inspector' });
const titles = () =>
  [...document.querySelectorAll('.mode-pane:not([hidden]) .pane-title')].map((h) => h.textContent);

async function openFilesTab() {
  await userEvent.click(within(inspector()).getByRole('tab', { name: 'Files' }));
  return within(inspector()).findByRole('tree', { name: 'Files in Workspace' });
}

describe('file browser (FR-039)', () => {
  it('lists the roots, opens folders on demand and files where they belong', async () => {
    const hub = filesHub();
    await renderApp({ hub });
    const tree = await openFilesTab();
    expect(hub.api.fileRoots).toHaveBeenCalledWith({});
    const items = within(tree).getAllByRole('treeitem');
    // Folders first, then files by name.
    expect(items.map((i) => i.textContent?.trim())).toEqual([
      'src',
      'logo.png2 KB',
      'README.md12 B',
    ]);
    const src = within(tree).getByRole('treeitem', { name: 'src' });
    expect(src.getAttribute('aria-expanded')).toBe('false');
    src.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(hub.api.listFiles).toHaveBeenCalledWith(ROOT, 'src');
    const main = await within(tree).findByRole('treeitem', { name: 'main.ts' });
    expect(src.getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(main);
    await userEvent.keyboard('{Enter}');
    // A text file opens in an editor pane, which takes focus.
    expect(titles()).toEqual(['Chat', 'Editor: main.ts']);
    const box = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Contents of main.ts',
    });
    expect(box.value).toBe('const a = 1;\nexport { a };\n');
    await waitFor(() => expect(document.activeElement).toBe(box));

    // An image opens in a preview pane.
    await userEvent.click(within(tree).getByText('logo.png'));
    expect(titles()).toEqual(['Chat', 'Editor: main.ts', 'Preview: logo.png']);
    const img = await screen.findByRole<HTMLImageElement>('img', { name: 'logo.png' });
    expect(img.getAttribute('src')).toBe(
      `/api/v1/files/raw?root=${encodeURIComponent(ROOT)}&path=logo.png`,
    );

    // Opening another text file reuses the editor.
    await userEvent.click(within(tree).getByText('README.md'));
    expect(titles()).toEqual(['Chat', 'Editor: README.md', 'Preview: logo.png']);

    // Enter on an open folder closes it.
    within(tree).getByRole('treeitem', { name: 'src' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(within(tree).queryByRole('treeitem', { name: 'main.ts' })).toBeNull();
  });

  it('switches between roots and shows empty, failed and read-only folders', async () => {
    const hub = filesHub();
    hub.state.m4.roots = [
      { path: ROOT, label: 'Workspace', access: 'write' },
      { path: '/srv/docs', label: 'Docs', access: 'read' },
    ];
    await renderApp({ hub });
    await openFilesTab();
    const folder = within(inspector()).getByRole('combobox', { name: 'Folder' });
    await userEvent.selectOptions(folder, '/srv/docs');
    expect(await within(inspector()).findByText('This folder is empty.')).toBeTruthy();
    expect(within(inspector()).getByText('Read-only')).toBeTruthy();
    expect(hub.api.listFiles).toHaveBeenLastCalledWith('/srv/docs', '');

    hub.state.failNext.listFiles = new Error('gone');
    await userEvent.click(within(inspector()).getByRole('button', { name: 'Refresh files' }));
    expect(await within(inspector()).findByText('gone')).toBeTruthy();
    hub.state.m4.files.set('/srv/docs::', [entry('guide.md', 'file', 'text/markdown')]);
    await userEvent.click(within(inspector()).getByRole('button', { name: 'Retry' }));
    expect(await within(inspector()).findByRole('treeitem', { name: 'guide.md' })).toBeTruthy();
  });

  it('reports when the roots cannot load, with a retry', async () => {
    const hub = filesHub();
    hub.state.failNext.fileRoots = new Error('Hub down');
    await renderApp({ hub });
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Files' }));
    expect(await within(inspector()).findByText('Hub down')).toBeTruthy();
    await userEvent.click(within(inspector()).getByRole('button', { name: 'Retry' }));
    expect(await within(inspector()).findByRole('tree')).toBeTruthy();
    hub.state.m4.roots = [];
  });

  it('asks for the chat’s and project’s roots and opens from the palette command', async () => {
    const hub = filesHub();
    const t = (await hub.api.createThread({ mode: 'chat', title: 'Work' })) as { id: string };
    hub.state.threads = hub.state.threads.map((x) => ({ ...x, projectId: 'proj1' }));
    const { registry } = await renderApp({ hub, path: `/chat/${t.id}` });
    registry.run('files.show');
    await within(inspector()).findByRole('tree');
    expect(hub.api.fileRoots).toHaveBeenCalledWith({ threadId: t.id, projectId: 'proj1' });
  });
});

describe('editor (FR-039)', () => {
  function editorHub(over: Partial<FileContentView> = {}) {
    const hub = createHub();
    hub.state.settings['workspace.layout'] = layoutWith('editor', 'notes.txt');
    hub.state.m4.contents.set(`${ROOT}::notes.txt`, content('notes.txt', 'hello', over));
    return hub;
  }
  const box = () =>
    screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Contents of notes.txt' });

  it('saves with Ctrl+S, shows unsaved changes, and undoes and redoes', async () => {
    const hub = editorHub();
    await renderApp({ hub });
    const text = await box();
    expect(document.querySelector('.editor-gutter')!.textContent).toBe('1');
    await userEvent.type(text, ' world{Enter}again');
    expect(screen.getByText(/\(unsaved\)/)).toBeTruthy();
    // Line numbers follow the text.
    expect(document.querySelector('.editor-gutter')!.textContent).toBe('12');
    await userEvent.keyboard('{Control>}s{/Control}');
    await waitFor(() =>
      expect(hub.api.saveFile).toHaveBeenCalledWith({
        root: ROOT,
        path: 'notes.txt',
        text: 'hello world\nagain',
        baseSha256: 'sha-notes.txt',
      }),
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(screen.queryByText(/\(unsaved\)/)).toBeNull();

    // Fast typing is one undo step.
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(text.value).toBe('hello');
    await userEvent.keyboard('{Control>}y{/Control}');
    expect(text.value).toBe('hello world\nagain');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(text.value).toBe('hello');
    await userEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(text.value).toBe('hello world\nagain');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Redo' }).disabled).toBe(true);

    // The second save uses the version the first one returned.
    await userEvent.type(text, '!');
    await userEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(hub.api.saveFile).toHaveBeenCalledTimes(2));
    const second = hub.api.saveFile.mock.calls[1]![0] as unknown as { baseSha256: string };
    expect(second.baseSha256).toMatch(/^sha-17-/);
  });

  it('refuses to overwrite a file that changed, then reloads or saves on request', async () => {
    const hub = editorHub();
    await renderApp({ hub });
    const text = await box();
    // Someone else saves the file meanwhile.
    hub.state.m4.contents.set(
      `${ROOT}::notes.txt`,
      content('notes.txt', 'theirs', { sha256: 'v2' }),
    );
    await userEvent.type(text, ' mine');
    await userEvent.keyboard('{Control>}s{/Control}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/changed on the Hub after you opened it/);
    await userEvent.click(within(alert).getByRole('button', { name: 'Save mine anyway' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(hub.state.m4.contents.get(`${ROOT}::notes.txt`)?.text).toBe('hello mine');

    hub.state.m4.contents.set(
      `${ROOT}::notes.txt`,
      content('notes.txt', 'newest', { sha256: 'v3' }),
    );
    await userEvent.type(text, ' again');
    await userEvent.keyboard('{Control>}s{/Control}');
    const again = await screen.findByRole('alert');
    await userEvent.click(
      within(again).getByRole('button', { name: 'Reload and discard my changes' }),
    );
    await waitFor(() => expect(text.value).toBe('newest'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('waits for an approval and checks whether the save went through', async () => {
    const hub = editorHub();
    await renderApp({ hub });
    const text = await box();
    hub.api.saveFile.mockResolvedValueOnce({ approvalId: 'ap1' });
    await userEvent.type(text, '!');
    await userEvent.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(document.querySelector('.editor-alert')).toBeTruthy());
    const block = document.querySelector<HTMLElement>('.editor-alert')!;
    expect(block.textContent).toMatch(/Saving notes.txt needs approval/);
    await userEvent.click(within(block).getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(screen.getByTestId('announcer').textContent).toMatch(/Still waiting/),
    );
    // The approval was granted and the Hub wrote the file.
    hub.state.m4.contents.set(
      `${ROOT}::notes.txt`,
      content('notes.txt', 'hello!', { sha256: 'v9' }),
    );
    await userEvent.click(within(block).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(document.querySelector('.editor-alert')).toBeNull();
  });

  it('reports a failed save and keeps the text', async () => {
    const hub = editorHub();
    await renderApp({ hub });
    const text = await box();
    hub.state.failNext.saveFile = new ApiError(403, {
      code: 'policy_denied',
      message: 'Writing here is not allowed',
      retryable: false,
    });
    await userEvent.type(text, '?');
    await userEvent.keyboard('{Control>}s{/Control}');
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Not saved: Writing here is not allowed/,
    );
    expect(text.value).toBe('hello?');
    // Typing again clears the old error.
    await userEvent.type(text, '?');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps unsaved text when the pane closes and reopens', async () => {
    const hub = editorHub();
    await renderApp({ hub });
    await userEvent.type(await box(), ' draft');
    await userEvent.click(screen.getByRole('button', { name: 'Close Editor: notes.txt' }));
    expect(titles()).toEqual([]);
    hub.state.m4.files.set(`${ROOT}::`, [entry('notes.txt', 'file', 'text/plain')]);
    await openFilesTab();
    await userEvent.click(within(inspector()).getByText('notes.txt'));
    const text = await box();
    await waitFor(() => expect(text.value).toBe('hello draft'));
    expect(screen.getByText(/\(unsaved\)/)).toBeTruthy();
  });

  it('is read-only when the Hub says so', async () => {
    await renderApp({ hub: editorHub({ readOnly: true }) });
    const text = await box();
    expect(text.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull();
    expect(screen.getAllByText('Read-only').length).toBeGreaterThan(0);
  });

  it('offers the preview for non-text files and retries a failed load', async () => {
    const hub = createHub();
    hub.state.settings['workspace.layout'] = layoutWith('editor', 'blob.bin');
    hub.state.failNext.readFile = new ApiError(404, {
      code: 'not_found',
      message: 'Not found',
      retryable: false,
    });
    hub.state.m4.contents.set(
      `${ROOT}::blob.bin`,
      content('blob.bin', null, { mime: 'application/octet-stream' }),
    );
    await renderApp({ hub });
    expect(await screen.findByText('This file no longer exists.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/blob.bin is not a text file/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open the preview' }));
    expect(titles()).toEqual(['Chat', 'Editor: blob.bin', 'Preview: blob.bin']);
    expect(
      await screen.findByText('No preview for this type of file. Download it to open it.'),
    ).toBeTruthy();
    const dl = screen.getByRole('link', { name: 'Download' });
    expect(dl.getAttribute('download')).toBe('blob.bin');
  });

  it('shows an empty editor pane until a file is opened', async () => {
    const hub = createHub();
    hub.state.settings['workspace.layout'] = {
      chat: splitPane(defaultLayout(), 'main', 'row', 'editor').layout,
    };
    await renderApp({ hub });
    expect(screen.getByText('Open a file from the Files panel to edit it.')).toBeTruthy();
  });
});

describe('preview by type (FR-039)', () => {
  async function preview(
    path: string,
    c: FileContentView,
    setup?: (h: ReturnType<typeof createHub>) => void,
  ) {
    const hub = createHub();
    hub.state.settings['workspace.layout'] = layoutWith('preview', path);
    hub.state.m4.contents.set(`${ROOT}::${path}`, c);
    setup?.(hub);
    await renderApp({ hub });
    return { hub, article: await screen.findByRole('article', { name: `Preview: ${path}` }) };
  }

  it('renders Markdown without raw HTML, and opens the editor from it', async () => {
    const { article } = await preview(
      'doc.md',
      content('doc.md', '# Title\n\n<script>alert(1)</script>\n\nBody', { mime: 'text/markdown' }),
    );
    expect(within(article).getByRole('heading', { name: 'Title', level: 1 })).toBeTruthy();
    expect(article.querySelector('script')).toBeNull();
    await userEvent.click(within(article).getByRole('button', { name: 'Edit' }));
    // The editor opens next to the pane it was asked from.
    expect(titles()).toEqual(['Chat', 'Preview: doc.md', 'Editor: doc.md']);
    // The editor's preview button goes back to the existing preview pane.
    await screen.findByRole('textbox', { name: 'Contents of doc.md' });
    await userEvent.click(screen.getByRole('button', { name: 'Open the preview' }));
    expect(titles()).toEqual(['Chat', 'Preview: doc.md', 'Editor: doc.md']);
  });

  it('highlights code, shows text and PDFs, and says when text is too large', async () => {
    const code = await preview('app.ts', content('app.ts', 'const x = 1;'));
    expect(code.article.querySelector('pre.nv-code')?.getAttribute('data-language')).toBeTruthy();
    resetDom();
    const text = await preview('notes.txt', content('notes.txt', 'plain words'));
    expect(within(text.article).getByLabelText('Text: notes.txt').textContent).toBe('plain words');
    resetDom();
    const pdf = await preview('r.pdf', content('r.pdf', null, { mime: 'application/pdf' }));
    expect(pdf.article.querySelector('object')?.getAttribute('type')).toBe('application/pdf');
    resetDom();
    const big = await preview('big.md', content('big.md', null, { mime: 'text/markdown' }));
    expect(within(big.article).getByText(/Too large to preview here/)).toBeTruthy();
  });

  it('opens the file in an app registered for its type, and back', async () => {
    const { article } = await preview('data.csv', content('data.csv', 'a,b'), (hub) => {
      hub.state.m4.entryPoints = [
        {
          id: 'ep1',
          kind: 'file',
          title: 'Table viewer',
          serverId: 's1',
          pluginId: null,
          resource: 'ui://table',
          extensions: ['.csv'],
        },
        {
          id: 'ep2',
          kind: 'file',
          title: 'Image tool',
          serverId: 's1',
          pluginId: null,
          resource: 'ui://img',
          extensions: ['.png'],
        },
      ];
    });
    const open = await within(article).findByRole('button', { name: /Open with Table viewer/ });
    expect(within(article).queryByRole('button', { name: /Image tool/ })).toBeNull();
    expect(within(article).getByLabelText('Text: data.csv')).toBeTruthy();
    await userEvent.click(open);
    expect(open.getAttribute('aria-pressed')).toBe('true');
    expect(await within(article).findByRole('heading', { name: 'Table viewer' })).toBeTruthy();
    expect(within(article).queryByLabelText('Text: data.csv')).toBeNull();
    await userEvent.click(within(article).getByRole('button', { name: 'Close Table viewer' }));
    expect(within(article).getByLabelText('Text: data.csv')).toBeTruthy();
  });

  it('shows a failed load with a retry', async () => {
    const hub = createHub();
    hub.state.settings['workspace.layout'] = layoutWith('preview', 'x.md');
    hub.state.failNext.readFile = new Error('nope');
    hub.state.m4.contents.set(`${ROOT}::x.md`, content('x.md', 'hi', { mime: 'text/markdown' }));
    await renderApp({ hub });
    expect(await screen.findByText('nope')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('article', { name: 'Preview: x.md' })).toBeTruthy();
  });

  it('shows an empty preview pane until a file is opened', async () => {
    const hub = createHub();
    hub.state.settings['workspace.layout'] = {
      chat: splitPane(defaultLayout(), 'main', 'row', 'preview').layout,
    };
    await renderApp({ hub });
    expect(screen.getByText('Open a file from the Files panel to preview it.')).toBeTruthy();
  });
});

describe('file kinds and editor history', () => {
  it('tells text from binary and picks the viewer', () => {
    expect(extensionOf('a/b/Report.PDF')).toBe('pdf');
    expect(extensionOf('Makefile')).toBe('');
    expect(isTextFile('text/plain', 'x')).toBe(true);
    expect(isTextFile('application/json', 'x')).toBe(true);
    expect(isTextFile('application/vnd.api+json', 'x')).toBe(true);
    expect(isTextFile('image/svg+xml', 'icon.svg')).toBe(false);
    expect(isTextFile(null, 'main.rs')).toBe(true);
    expect(isTextFile('application/octet-stream', 'notes.md')).toBe(true);
    expect(isTextFile('application/zip', 'a.zip')).toBe(false);
    expect(previewKind('text/markdown', 'x')).toBe('markdown');
    expect(previewKind(null, 'p.jpeg')).toBe('image');
    expect(previewKind(null, 'p.pdf')).toBe('pdf');
    expect(previewKind(null, 'p.py')).toBe('code');
    expect(previewKind('text/csv', 'p.csv')).toBe('text');
    expect(previewKind('application/zip', 'p.zip')).toBe('binary');
    expect(opensIn(null, 'icon.svg')).toBe('preview');
    expect(opensIn('text/plain', 'a.txt')).toBe('editor');
    expect(opensIn('application/zip', 'a.zip')).toBe('preview');
    expect(hasRichPreview(null, 'a.md')).toBe(true);
    expect(hasRichPreview(null, 'a.txt')).toBe(false);
    expect(lineCount('')).toBe(1);
    expect(lineCount('a\nb\n')).toBe(3);
    expect(baseName('a/b/c.txt')).toBe('c.txt');
  });

  it('groups fast typing into one undo step and keeps redo until the next edit', () => {
    let h = pushHistory(EMPTY_HISTORY, 'a', 1000);
    h = pushHistory(h, 'ab', 1200);
    expect(h.past).toEqual(['a']);
    h = pushHistory(h, 'abc', 5000);
    expect(h.past).toEqual(['a', 'abc']);
    const u = undo(h, 'abcd')!;
    expect(u.text).toBe('abc');
    const r = redo(u.history, u.text)!;
    expect(r.text).toBe('abcd');
    expect(redo(r.history, r.text)).toBeNull();
    expect(undo(EMPTY_HISTORY, 'x')).toBeNull();
    expect(pushHistory(u.history, 'z', 9000).future).toEqual([]);
  });

  it('uses Cmd+S, Cmd+Z and Shift+Cmd+Z on a Mac', async () => {
    const hub = createHub();
    hub.state.settings['workspace.layout'] = layoutWith('editor', 'mac.txt');
    hub.state.m4.contents.set(`${ROOT}::mac.txt`, content('mac.txt', 'one'));
    await renderApp({ hub, registry: testRegistry(true) });
    const text = await screen.findByRole<HTMLTextAreaElement>('textbox', {
      name: 'Contents of mac.txt',
    });
    expect(screen.getByRole('button', { name: /Save/ }).getAttribute('aria-keyshortcuts')).toBe(
      'Meta+S',
    );
    await userEvent.type(text, ' two');
    await userEvent.keyboard('{Meta>}z{/Meta}');
    expect(text.value).toBe('one');
    await userEvent.keyboard('{Meta>}{Shift>}z{/Shift}{/Meta}');
    expect(text.value).toBe('one two');
    // Ctrl+S is not the Mac save key.
    await userEvent.keyboard('{Control>}s{/Control}');
    expect(hub.api.saveFile).not.toHaveBeenCalled();
    await userEvent.keyboard('{Meta>}s{/Meta}');
    await waitFor(() => expect(hub.api.saveFile).toHaveBeenCalledTimes(1));
  });
});
