import { afterEach, describe, expect, it } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import {
  defaultLayout,
  setBottom,
  splitPane,
  type ModeLayout,
  type PaneSplit,
} from '../src/layout/model.ts';
import { navigate } from '../src/router.ts';
import { FakeEventSource, createHub, message, thread } from './fakes.ts';
import { clearViewport, renderApp, resetDom, setViewport } from './render.tsx';

afterEach(() => {
  resetDom();
  clearViewport();
});

/** Pane titles in the mode on screen. */
const titles = () =>
  [...document.querySelectorAll('.mode-pane:not([hidden]) .pane-title')].map((h) => h.textContent);
const pane = (title: string) => {
  const h = [
    ...document.querySelectorAll<HTMLElement>('.mode-pane:not([hidden]) .pane-title'),
  ].find((x) => x.textContent === title);
  if (!h) throw new Error(`no pane ${title}`);
  return h.closest<HTMLElement>('section.pane')!;
};

async function chooseLayout(item: string) {
  await userEvent.click(screen.getByRole('button', { name: 'Layout' }));
  await userEvent.click(screen.getByRole('menuitem', { name: item }));
}

function savedLayouts(hub: ReturnType<typeof createHub>): Record<string, ModeLayout> {
  const calls = hub.api.setSetting.mock.calls.filter((c) => c[0] === 'workspace.layout');
  return calls.at(-1)?.[1] as unknown as Record<string, ModeLayout>;
}

function withPanes(): ModeLayout {
  let l = splitPane(defaultLayout(), 'main', 'row', 'editor').layout;
  l = splitPane(l, 'p1', 'row', 'preview').layout;
  return { ...l, active: 'main' };
}

describe('multi-pane layout (FR-005)', () => {
  it('splits, chooses a kind, resizes with the keyboard, and saves the layout', async () => {
    const { hub } = await renderApp();
    // One pane needs no header; the chat looks as it did.
    expect(titles()).toEqual([]);
    await chooseLayout('Split right');
    const chooser = await screen.findByText('Choose what this pane shows');
    await waitFor(() => expect(document.activeElement?.textContent?.trim()).toBe('Editor'));
    expect(titles()).toEqual(['Chat', 'New pane']);
    await userEvent.click(
      within(chooser.closest('.pane-chooser') as HTMLElement).getByRole('button', {
        name: 'Preview',
      }),
    );
    expect(titles()).toEqual(['Chat', 'Preview']);
    expect(screen.getByText('Open a file from the Files panel to preview it.')).toBeTruthy();

    const splitter = screen.getByRole('separator', { name: 'Resize Chat and Preview' });
    expect(splitter.getAttribute('aria-valuenow')).toBe('50');
    splitter.focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(splitter.getAttribute('aria-valuenow')).toBe('40');

    await waitFor(() => {
      const chat = savedLayouts(hub)?.chat;
      expect(chat?.root.type).toBe('split');
      const sizes = (chat!.root as PaneSplit).sizes;
      expect(sizes[0]).toBeCloseTo(0.4);
    });
    expect(savedLayouts(hub).code).toEqual(defaultLayout());
  });

  it('restores the saved layout on start, file and bottom panel included', async () => {
    const hub = createHub();
    const l = splitPane(defaultLayout(), 'main', 'column', 'editor', {
      root: '/data/workspace',
      path: 'notes.txt',
    }).layout;
    hub.state.settings['workspace.layout'] = { chat: setBottom(l, { open: true, size: 0.25 }) };
    hub.state.m4.contents.set('/data/workspace::notes.txt', {
      root: '/data/workspace',
      path: 'notes.txt',
      mime: 'text/plain',
      size: 5,
      text: 'hello',
      sha256: 'h1',
      readOnly: false,
    });
    await renderApp({ hub });
    expect(titles()).toEqual(['Chat', 'Editor: notes.txt']);
    expect(
      await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Contents of notes.txt' }),
    ).toHaveProperty('value', 'hello');
    expect(screen.getByRole('region', { name: 'Bottom panel' })).toBeTruthy();
    expect(screen.getByRole('separator', { name: 'Resize the bottom panel' })).toBeTruthy();
    // Nothing changed, so nothing is written back.
    await new Promise((r) => setTimeout(r, 400));
    expect(hub.api.setSetting).not.toHaveBeenCalledWith('workspace.layout', expect.anything());
  });

  it('moves panes with the keyboard and by drag, maximizes, restores, closes and resets', async () => {
    const hub = createHub();
    hub.state.settings['workspace.layout'] = { chat: withPanes() };
    await renderApp({ hub });
    expect(titles()).toEqual(['Chat', 'Editor', 'Preview']);

    // Keyboard: the pane's menu moves it.
    await userEvent.click(
      within(pane('Editor')).getByRole('button', { name: 'More actions for Editor' }),
    );
    expect(screen.getByRole('menuitem', { name: 'Move right' })).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Move left' }));
    expect(titles()).toEqual(['Editor', 'Chat', 'Preview']);

    // Drag a pane's header onto another pane to swap them.
    const data = new Map<string, string>();
    const dataTransfer = {
      types: ['application/x-nova-pane'],
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
      effectAllowed: 'all',
      dropEffect: 'none',
    };
    const head = pane('Preview').querySelector('.pane-head')!;
    fireEvent.dragStart(head, { dataTransfer });
    const target = pane('Editor');
    fireEvent.dragOver(target, { dataTransfer });
    expect(target.dataset.drop).toBe('true');
    fireEvent.drop(target, { dataTransfer });
    expect(titles()).toEqual(['Preview', 'Chat', 'Editor']);
    // Other drags (files) are left to the pane's contents.
    fireEvent.drop(pane('Chat'), { dataTransfer: { types: ['Files'], files: [] } });
    expect(titles()).toEqual(['Preview', 'Chat', 'Editor']);

    // Maximize one pane, then restore.
    await userEvent.click(within(pane('Editor')).getByRole('button', { name: 'Maximize Editor' }));
    expect(titles()).toEqual(['Editor']);
    expect(screen.queryByLabelText('Message')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Restore Editor' }));
    expect(titles()).toEqual(['Preview', 'Chat', 'Editor']);
    expect(screen.getByLabelText('Message')).toBeTruthy();

    // Close a pane; the chat cannot be closed.
    expect(within(pane('Chat')).queryByRole('button', { name: 'Close Chat' })).toBeNull();
    await userEvent.click(within(pane('Preview')).getByRole('button', { name: 'Close Preview' }));
    expect(titles()).toEqual(['Chat', 'Editor']);

    await chooseLayout('Reset layout');
    expect(titles()).toEqual([]);
    expect(screen.getByLabelText('Message')).toBeTruthy();
    await waitFor(() => expect(savedLayouts(hub).chat).toEqual(defaultLayout()));
  });

  it('keeps the chat mounted while panes change around it', async () => {
    const t = thread({ title: 'Kept' });
    const hub = createHub({ threads: [t] });
    hub.state.messages.set(t.id, [message(t.id, { parts: [{ type: 'text', text: 'Hi there' }] })]);
    await renderApp({ hub, path: `/chat/${t.id}` });
    expect(await screen.findByText('Hi there')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Message'), 'draft text');
    await chooseLayout('Add preview pane');
    await chooseLayout('Split down');
    await userEvent.click(within(pane('Chat')).getByRole('button', { name: 'Maximize Chat' }));
    await chooseLayout('Reset layout');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Message').value).toBe('draft text');
    expect(screen.getByText('Hi there')).toBeTruthy();
    // Moving between slots never reloads the chat or reopens its stream.
    expect(hub.api.getThread).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.all.filter((e) => e.url.includes(t.id))).toHaveLength(1);
  });

  it('runs pane commands from the palette registry, also from another page', async () => {
    const { hub, registry } = await renderApp();
    act(() => {
      registry.run('pane.add.editor');
    });
    expect(titles()).toEqual(['Chat', 'Editor']);
    act(() => {
      registry.run('pane.splitDown');
    });
    expect(titles()).toEqual(['Chat', 'Editor', 'New pane']);
    act(() => {
      registry.run('pane.moveEarlier');
    });
    act(() => {
      registry.run('pane.maximize');
    });
    expect(titles()).toEqual(['New pane']);
    act(() => {
      registry.run('pane.maximize');
    });
    act(() => {
      registry.run('pane.close');
    });
    expect(titles()).toEqual(['Chat', 'Editor']);
    // The diff and browser keys show their pane, adding it once.
    await userEvent.keyboard('{Control>}{Shift>}d{/Shift}{/Control}');
    expect(titles()).toContain('Diff');
    expect(screen.getByRole('heading', { name: 'Diffs arrive with Code sessions' })).toBeTruthy();
    await userEvent.keyboard('{Control>}{Shift>}d{/Shift}{/Control}');
    expect(titles().filter((t) => t === 'Diff')).toHaveLength(1);
    act(() => {
      registry.run('pane.browser');
    });
    expect(titles()).toContain('Browser');

    // From Settings, a pane command returns to the mode it acts on.
    act(() => navigate('/settings/general'));
    await screen.findByRole('heading', { name: 'Settings', level: 1 });
    act(() => {
      registry.run('layout.reset');
    });
    expect(window.location.pathname).toBe('/chat');
    expect(titles()).toEqual([]);
    expect(hub.api.setSetting).toBeDefined();
  });

  it('gives each mode its own layout', async () => {
    await renderApp();
    await chooseLayout('Add preview pane');
    expect(titles()).toEqual(['Chat', 'Preview']);
    await userEvent.click(screen.getByRole('link', { name: /Code/ }));
    expect(screen.getByRole('heading', { name: /Code sessions arrive/ })).toBeTruthy();
    expect(titles()).toEqual([]);
    await chooseLayout('Add editor pane');
    const code = screen.getByRole('region', { name: 'Code workspace' });
    expect([...code.querySelectorAll('.pane-title')].map((h) => h.textContent)).toEqual([
      'Code',
      'Editor',
    ]);
  });

  it('shows one pane at a time on phones, with a pane switcher', async () => {
    setViewport(390);
    const hub = createHub();
    hub.state.settings['workspace.layout'] = { chat: withPanes() };
    await renderApp({ hub, ready: false });
    const tabs = await screen.findByRole('tablist', { name: 'Panes' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((t) => t.textContent?.trim()),
    ).toEqual(['Chat', 'Editor', 'Preview']);
    expect(screen.getByLabelText('Message')).toBeTruthy();
    expect(screen.queryByRole('separator')).toBeNull();
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Editor' }));
    expect(screen.queryByLabelText('Message')).toBeNull();
    expect(screen.getByText('Open a file from the Files panel to edit it.')).toBeTruthy();
    // Arrow keys move between panes.
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByText('Open a file from the Files panel to preview it.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close Preview' }));
    expect(within(tabs).getAllByRole('tab')).toHaveLength(2);
    await userEvent.click(within(tabs).getByRole('tab', { name: 'Chat' }));
    expect(screen.getByLabelText('Message')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Close Chat' })).toBeNull();
  });

  it('keeps working when the layout cannot be saved', async () => {
    const hub = createHub();
    const { api } = hub;
    const real = api.setSetting.getMockImplementation()! as unknown as (
      key: string,
      value: unknown,
    ) => Promise<unknown>;
    api.setSetting.mockImplementation((key: string, value: unknown) =>
      key === 'workspace.layout' ? Promise.reject(new Error('offline')) : real(key, value),
    );
    await renderApp({ hub });
    await chooseLayout('Add editor pane');
    await waitFor(() =>
      expect(api.setSetting).toHaveBeenCalledWith('workspace.layout', expect.anything()),
    );
    expect(titles()).toEqual(['Chat', 'Editor']);
  });
});
