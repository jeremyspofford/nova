// Extension contributions in the shell (FR-117, docs/14 §4.1): running extensions' commands in the
// command palette (under the extension's name) and the navigation commands; status items in the
// status bar; context menu items on chats, messages and files; the composer's + menu with the chat's
// apps and composer items; shortcuts offered in Settings → Keyboard and themes in Appearance, each
// applied only when chosen; the App frame's allowed domains (FR-198). Contributions follow the
// extension events, and a member's shell gets none.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { UiEntryPointView } from '@nova/shared';
import { ThreadApps } from '../src/apps/AppsView.tsx';
import { MessageItem } from '../src/chat/MessageItem.tsx';
import { CommandPalette } from '../src/CommandPalette.tsx';
import { ComposerPlusMenu } from '../src/extensions/ComposerPlus.tsx';
import { extensionCommandKey } from '../src/extensions/format.ts';
import { ExtensionKeyOffers } from '../src/extensions/Offers.tsx';
import { ExtensionStatusBar, useExtensionShell } from '../src/extensions/shell.tsx';
import { PreviewPane } from '../src/files/PreviewPane.tsx';
import { useServices } from '../src/services.tsx';
import { AppearancePage } from '../src/settings/AppearancePage.tsx';
import { FakeEventSource, createHub, message, thread } from './fakes.ts';
import {
  installed,
  renderWithExtensions,
  withExtensions,
  wordCount,
} from './fakes-m8-extensions.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => resetDom());

const KEY = extensionCommandKey('com.examplelabs.word-count', 'count');
const events = () => FakeEventSource.for('/api/v1/events/stream');

function Shell({ palette = false }: { palette?: boolean }) {
  useExtensionShell();
  return palette ? null : <ExtensionStatusBar />;
}

function entry(over: Partial<UiEntryPointView> = {}): UiEntryPointView {
  return {
    id: 'ep-chart',
    kind: 'thread',
    title: 'Chart',
    serverId: 's1',
    pluginId: null,
    resource: 'ui://chart',
    extensions: [],
    ...over,
  };
}

describe('commands and the status bar', () => {
  it('lists running extensions’ commands in the palette under their name and runs them', async () => {
    const { ext, state, registry } = await renderWithExtensions(
      <>
        <Shell palette />
        <Palette />
      </>,
      { bundles: [{ bundle: wordCount() }] },
    );
    await waitFor(() => expect(registry.get(KEY)).toBeTruthy());
    expect(registry.get(KEY)).toMatchObject({ title: 'Count words', category: 'Word count' });
    expect(registry.get('marketplace.open')?.title).toBe('Open the marketplace');
    expect(registry.get('extensions.manage')?.title).toBe('Manage extensions');
    state.commandResults['com.examplelabs.word-count/count'] = {
      ok: true,
      result: '342 words',
      error: null,
    };
    await userEvent.click(await screen.findByRole('option', { name: /Word count\s*Count words/ }));
    await waitFor(() =>
      expect(ext.runExtensionCommand).toHaveBeenCalledWith('com.examplelabs.word-count', 'count'),
    );
    // The toast, and for a moment its screen-reader announcement too: either may be found.
    expect((await screen.findAllByText('Count words: 342 words')).length).toBeGreaterThan(0);
  });

  it('says in plain words why a command failed', async () => {
    const { state, registry } = await renderWithExtensions(<Shell />, {
      bundles: [{ bundle: wordCount() }],
    });
    await waitFor(() => expect(registry.get(KEY)).toBeTruthy());
    state.commandResults['com.examplelabs.word-count/count'] = {
      ok: false,
      result: null,
      error: { code: 'timeout', message: 'the extension did not answer within 30 s' },
    };
    act(() => {
      registry.run(KEY);
    });
    expect(
      (await screen.findAllByText('Count words took too long, so Nova stopped waiting for it.'))
        .length,
    ).toBeGreaterThan(0);
    state.commandResults['com.examplelabs.word-count/count'] = {
      ok: false,
      result: null,
      error: { code: 'extension_error', message: 'no text to count' },
    };
    act(() => {
      registry.run(KEY);
    });
    expect(
      (await screen.findAllByText('Count words failed: no text to count')).length,
    ).toBeGreaterThan(0);
  });

  it('shows status items, runs a click, and follows changes', async () => {
    const { ext, state } = await renderWithExtensions(<Shell />, {
      bundles: [{ bundle: wordCount() }],
    });
    const bar = await screen.findByRole('group', { name: 'Extension status' });
    const item = within(bar).getByRole('button', { name: '120 words (from Word count)' });
    await userEvent.click(item);
    expect(ext.clickExtensionStatus).toHaveBeenCalledWith('com.examplelabs.word-count', 'words');
    expect((await screen.findAllByText('120 words: done.')).length).toBeGreaterThan(0);

    // The extension updates its item: the Hub says so, and the bar follows.
    state.installed[0]!.bundle.contributes!.statusItems = [
      { extensionId: '', id: 'words', text: '121 words', command: null, clickable: false },
    ];
    events().emit('extension.contributions.changed', {
      extensionId: 'com.examplelabs.word-count',
    });
    expect(await within(bar).findByText('121 words')).toBeTruthy();
    expect(within(bar).queryByRole('button')).toBeNull();

    // Its own click handler, without a command: still a button, and the Hub runs the handler.
    state.installed[0]!.bundle.contributes!.statusItems = [
      { extensionId: '', id: 'words', text: '122 words', command: null, clickable: true },
    ];
    state.commandResults['com.examplelabs.word-count/status:words'] = {
      ok: true,
      result: 'Counted again',
      error: null,
    };
    events().emit('extension.contributions.changed', {
      extensionId: 'com.examplelabs.word-count',
    });
    await userEvent.click(
      await within(bar).findByRole('button', { name: '122 words (from Word count)' }),
    );
    expect(ext.clickExtensionStatus).toHaveBeenLastCalledWith(
      'com.examplelabs.word-count',
      'words',
    );
    expect((await screen.findAllByText('122 words: Counted again')).length).toBeGreaterThan(0);

    // Turned off: its commands and items go.
    await ext.setExtensionEnabled('com.examplelabs.word-count', false);
    events().emit('extension.status.changed', {
      extensionId: 'com.examplelabs.word-count',
      status: 'disabled',
      error: null,
    });
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Extension status' })).toBeNull(),
    );
  });

  it('gives a member’s shell nothing, without errors', async () => {
    const { registry } = await renderWithExtensions(<Shell />, { member: true });
    await waitFor(() => expect(registry.get('marketplace.open')).toBeTruthy());
    expect(registry.list().filter((c) => c.id.startsWith('ext.'))).toEqual([]);
    expect(screen.queryByRole('group', { name: 'Extension status' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/** The palette over the registry the shell registers into. */
function Palette() {
  const { registry } = useServices();
  return <CommandPalette registry={registry} open onClose={() => undefined} />;
}

describe('context menus', () => {
  it('adds an extension’s items to a chat’s menu in the sidebar', async () => {
    const t = thread({ title: 'Plans' });
    const hub = createHub({ threads: [t] });
    const ext = withExtensions(hub);
    await installed(ext.api, wordCount());
    await renderApp({ hub });
    await userEvent.click(await screen.findByRole('button', { name: 'Actions for Plans' }));
    const item = await screen.findByRole('menuitem', { name: 'Count words in this chat' });
    expect(item.getAttribute('title')).toBe('From Word count');
    await userEvent.click(item);
    await waitFor(() =>
      expect(ext.api.runExtensionCommand).toHaveBeenCalledWith(
        'com.examplelabs.word-count',
        'count',
        { threadId: t.id },
      ),
    );
  });

  it('puts items placed in the sidebar in a menu at its foot, and shows none without them', async () => {
    const plain = createHub();
    const plainExt = withExtensions(plain);
    await installed(plainExt.api, wordCount());
    await renderApp({ hub: plain });
    const nav = await screen.findByRole('navigation', { name: 'Sidebar' });
    // Once the contributions are read (Word count only adds to a chat's menu): no sidebar menu.
    await waitFor(() => expect(plainExt.api.extensionContributions).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    expect(within(nav).queryByRole('button', { name: 'From extensions' })).toBeNull();
    resetDom();

    const b = wordCount();
    b.contributes!.menus = [
      {
        extensionId: '',
        where: 'sidebar',
        items: [{ id: 's', title: 'Word count of today', command: 'count' }],
      },
    ];
    const hub = createHub();
    const ext = withExtensions(hub);
    await installed(ext.api, b);
    await renderApp({ hub });
    const sidebar = await screen.findByRole('navigation', { name: 'Sidebar' });
    const trigger = await within(sidebar).findByRole('button', { name: 'From extensions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    await userEvent.click(trigger);
    const item = screen.getByRole('menuitem', { name: 'Word count of today' });
    expect(item.getAttribute('title')).toBe('From Word count');
    await userEvent.click(item);
    await waitFor(() =>
      expect(ext.api.runExtensionCommand).toHaveBeenCalledWith(
        'com.examplelabs.word-count',
        'count',
        {},
      ),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it('adds message and file items where the extension asked for them', async () => {
    const b = wordCount();
    b.contributes!.menus = [
      {
        extensionId: '',
        where: 'message',
        items: [{ id: 'm', title: 'Count this reply', command: 'count' }],
      },
      {
        extensionId: '',
        where: 'file',
        items: [{ id: 'f', title: 'Count this file', command: 'count' }],
      },
    ];
    const m = message('t1', { role: 'assistant', parts: [{ type: 'text', text: 'Hello there' }] });
    const { ext } = await renderWithExtensions(
      <>
        <MessageItem
          message={m}
          streamed={undefined}
          reasoning={undefined}
          attachmentUrl={(id) => `/a/${id}`}
          actions={{ onCopy: () => undefined, onQuote: () => undefined }}
        />
        <PreviewPane file={{ root: '/data/workspace', path: 'notes.md' }} />
      </>,
      {
        bundles: [{ bundle: b }],
        prepare: (hub) => {
          hub.state.m4.contents.set('/data/workspace::notes.md', {
            root: '/data/workspace',
            path: 'notes.md',
            mime: 'text/markdown',
            size: 5,
            text: 'Hello',
            sha256: 'x',
            readOnly: false,
          });
        },
      },
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'More actions from extensions' }),
    );
    await userEvent.click(screen.getByRole('menuitem', { name: 'Count this reply' }));
    await waitFor(() =>
      expect(ext.runExtensionCommand).toHaveBeenCalledWith('com.examplelabs.word-count', 'count', {
        threadId: 't1',
        messageId: m.id,
      }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'More actions for notes.md' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Count this file' }));
    await waitFor(() =>
      expect(ext.runExtensionCommand).toHaveBeenLastCalledWith(
        'com.examplelabs.word-count',
        'count',
        {
          root: '/data/workspace',
          path: 'notes.md',
        },
      ),
    );
  });
});

describe('the composer’s + menu', () => {
  it('opens a chat’s app in the Apps tab and runs composer items', async () => {
    const b = wordCount();
    b.contributes!.menus = [
      {
        extensionId: '',
        where: 'composer',
        items: [{ id: 'c', title: 'Count my draft', command: 'count' }],
      },
    ];
    const { ext, registry } = await renderWithExtensions(
      <>
        <ComposerPlusMenu threadId="t1" />
        <ThreadApps threadId="t1" />
      </>,
      {
        bundles: [{ bundle: b }],
        prepare: (hub) => {
          hub.state.m4.entryPoints = [entry()];
        },
      },
    );
    let shown = 0;
    registry.register({
      id: 'apps.showPanel',
      title: 'Show apps',
      category: 'Apps',
      run: () => void shown++,
    });
    await userEvent.click(screen.getByRole('button', { name: 'Apps and more' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Open Chart' }));
    expect(shown).toBe(1);
    expect(await screen.findByRole('heading', { name: 'Chart' })).toBeTruthy();
    // The tab's own list marks it as open.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Open Chart' }).disabled).toBe(
      true,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Apps and more' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Count my draft' }));
    await waitFor(() =>
      expect(ext.runExtensionCommand).toHaveBeenCalledWith('com.examplelabs.word-count', 'count', {
        threadId: 't1',
      }),
    );
  });

  it('says where the app opens when the shell cannot show the tab, and points to the marketplace', async () => {
    const { hub } = await renderWithExtensions(<ComposerPlusMenu threadId="t1" />);
    hub.state.m4.entryPoints = [entry()];
    await userEvent.click(screen.getByRole('button', { name: 'Apps and more' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Open Chart' }));
    expect(
      (await screen.findAllByText('Chart opens in the Inspector’s Apps tab.')).length,
    ).toBeGreaterThan(0);
    hub.state.m4.entryPoints = [];
    await userEvent.click(screen.getByRole('button', { name: 'Apps and more' }));
    expect(await screen.findByRole('menuitem', { name: 'No apps for chats yet' })).toBeTruthy();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Find apps in the Marketplace' }));
    expect(window.location.pathname).toBe('/marketplace');
  });
});

describe('shortcuts and themes are offered, never applied by themselves', () => {
  it('binds a suggested shortcut only when chosen', async () => {
    const { hub } = await renderWithExtensions(
      <>
        <Shell palette />
        <ExtensionKeyOffers />
      </>,
      { bundles: [{ bundle: wordCount() }] },
    );
    const row = await screen.findByRole('listitem', { name: 'Word count: Count words' });
    expect(hub.state.settings['keyboard.bindings']).toBeUndefined();
    await userEvent.click(
      within(row).getByRole('button', { name: 'Use Ctrl+Alt+W for Count words' }),
    );
    await waitFor(() =>
      expect(hub.state.settings['keyboard.bindings']).toEqual({ [KEY]: 'mod+alt+w' }),
    );
    expect((await screen.findAllByText('Ctrl+Alt+W now runs Count words.')).length).toBeGreaterThan(
      0,
    );
  });

  it('offers extension themes in Appearance: saved or used only on request', async () => {
    const b = wordCount();
    b.contributes!.themes = [
      {
        schemaVersion: 1,
        id: 'com.examplelabs.paper',
        name: 'Paper',
        variant: 'light',
        tokens: { '--u-bg': '#fbf7ee', '--u-text': '#1f1b14', '--u-accent': '#a14a1c' },
      },
      { schemaVersion: 1, id: 'Bad Id', name: 'Broken', variant: 'dark', tokens: {} },
    ];
    const { hub } = await renderWithExtensions(<AppearancePage />, { bundles: [{ bundle: b }] });
    const offers = await screen.findByRole('list', { name: 'From your extensions' });
    expect(within(offers).getByText(/Word count offers a theme Nova cannot use/)).toBeTruthy();
    const paper = within(offers).getByRole('listitem', { name: 'Paper' });
    expect(within(paper).getByText('From Word count')).toBeTruthy();
    expect(hub.state.settings['appearance.customThemes']).toBeUndefined();
    await userEvent.click(
      within(paper).getByRole('button', { name: 'Save to your themes: Paper' }),
    );
    await waitFor(() =>
      expect(hub.state.settings['appearance.customThemes']).toEqual([
        expect.objectContaining({ id: 'com.examplelabs.paper' }),
      ]),
    );
    expect(hub.state.settings['appearance.theme']).toBeUndefined();
    expect(await within(offers).findByText('In your themes')).toBeTruthy();
  });
});

describe('the App frame (FR-198)', () => {
  it('lists the outside sites an app may reach, or says it reaches none', async () => {
    const hub = createHub();
    hub.state.m4.entryPoints = [
      entry({
        id: 'ep-global',
        kind: 'global',
        title: 'Dashboard',
        domains: ['api.example.com', 'cdn.example.com'],
      }),
      entry({ id: 'ep-quiet', kind: 'global', title: 'Quiet', domains: [] }),
    ];
    await renderApp({ hub, path: '/apps/ep-global' });
    expect(await screen.findByText('Can reach api.example.com, cdn.example.com')).toBeTruthy();
    resetDom();
    await renderApp({ hub, path: '/apps/ep-quiet' });
    expect(await screen.findByText('Reaches no outside sites')).toBeTruthy();
  });
});
