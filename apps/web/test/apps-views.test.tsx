// Where MCP Apps open (FR-198): /apps lists global entry points and /apps/<id> shows one as a
// page; the Inspector's Apps tab opens the chat's entry points inline, a message from an app
// lands in the composer without being sent, and a picture-in-picture app stays up across chats;
// file entry points match by extension.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginView, UiEntryPointView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { FileApp, fileAppsFor, fileExtension, useFileApps } from '../src/apps/AppsView.tsx';
import { navigate } from '../src/router.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { box, openChat } from './chat-helpers.tsx';
import { createHub, fakeEventSource, testRegistry, thread } from './fakes.ts';
import { m4State } from './fakes-m4.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(resetDom);

function entry(over: Partial<UiEntryPointView> = {}): UiEntryPointView {
  return {
    id: 'ep-thread',
    kind: 'thread',
    title: 'Sample panel',
    serverId: 's1',
    pluginId: 'com.example.sample',
    resource: 'ui://sample/panel',
    extensions: [],
    ...over,
  };
}

const ENTRIES = [
  entry(),
  entry({ id: 'ep-global', kind: 'global', title: 'Dashboard' }),
  entry({ id: 'ep-file', kind: 'file', title: 'CSV viewer', extensions: ['.csv', '.TSV'] }),
];

const PLUGIN = {
  id: 'com.example.sample',
  name: 'Sample plugin',
  verified: true,
} as PluginView;

const inspector = () => screen.getByRole('complementary', { name: 'Inspector' });

function fromFrame(iframe: HTMLIFrameElement, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data, source: iframe.contentWindow, origin: 'null' }),
    );
  });
}

describe('the Apps page', () => {
  it('lists global apps, opens one as a page and closes back to the list', async () => {
    const hub = createHub({ m4: m4State({ entryPoints: ENTRIES, plugins: [PLUGIN] }) });
    await renderApp({ hub, path: '/apps' });
    const list = await screen.findByRole('list', { name: 'Apps' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('Dashboard')).toBeTruthy();
    expect(await within(list).findByText('Sample plugin')).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Open Dashboard' }));
    expect(window.location.pathname).toBe('/apps/ep-global');
    const page = await screen.findByRole('region', { name: 'Dashboard' });
    expect(page.dataset.mode).toBe('page');
    expect(within(page).getByText('Verified')).toBeTruthy();
    expect(page.querySelector('iframe')!.getAttribute('src')).toBe(
      '/api/v1/ui/resource?entry=ep-global',
    );
    await userEvent.click(within(page).getByRole('button', { name: 'Close Dashboard' }));
    expect(window.location.pathname).toBe('/apps');
    expect(await screen.findByRole('list', { name: 'Apps' })).toBeTruthy();
  });

  it('says when an app is not found, when there are none and when loading fails', async () => {
    const hub = createHub({ m4: m4State({ entryPoints: [entry()] }) });
    await renderApp({ hub, path: '/apps/nope' });
    expect(await screen.findByRole('heading', { name: 'App not found' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'All apps' }));
    expect(await screen.findByRole('heading', { name: 'No apps yet' })).toBeTruthy();
    resetDom();
    const failing = createHub();
    failing.state.failNext.uiEntryPoints = new ApiError(500, {
      code: 'server_error',
      message: 'The Hub is busy.',
      retryable: true,
    });
    await renderApp({ hub: failing, path: '/apps' });
    expect(await screen.findByText('The Hub is busy.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'No apps yet' })).toBeTruthy();
  });
});

describe('the Inspector Apps tab', () => {
  it('opens a chat app inline and puts its message in the composer without sending', async () => {
    const other = thread({ title: 'Other chat' });
    const { hub, t } = await openChat(
      {},
      { hub: { m4: m4State({ entryPoints: ENTRIES }), threads: [other] } },
    );
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Apps' }));
    const list = await within(inspector()).findByRole('list', { name: 'Apps for this chat' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    await userEvent.click(within(list).getByRole('button', { name: 'Open Sample panel' }));
    const app = within(inspector()).getByRole('region', { name: 'Sample panel' });
    expect(app.dataset.mode).toBe('inline');
    expect(within(list).getByRole('button', { name: 'Open Sample panel' })).toHaveProperty(
      'disabled',
      true,
    );

    const iframe = app.querySelector('iframe')!;
    const posted: Record<string, unknown>[] = [];
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(
      (m: unknown) => void posted.push(m as Record<string, unknown>),
    );
    await userEvent.type(box(), 'Draft:');
    fromFrame(iframe, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/message',
      params: { role: 'user', content: { type: 'text', text: 'Summarize the board' } },
    });
    await waitFor(() =>
      expect(posted.find((m) => m.id === 1)).toEqual({ jsonrpc: '2.0', id: 1, result: {} }),
    );
    expect(box().value).toBe('Draft:\n\nSummarize the board');
    expect(hub.api.sendMessage).not.toHaveBeenCalled();
    // Model context goes nowhere without the Hub call, and nothing breaks.
    fromFrame(iframe, {
      jsonrpc: '2.0',
      id: 2,
      method: 'ui/update-model-context',
      params: { content: [{ type: 'text', text: 'Board has 3 cards' }] },
    });
    await waitFor(() => expect(posted.find((m) => m.id === 2)).toMatchObject({ result: {} }));

    // Another chat: the inline app is hidden; back again, it is still running.
    act(() => navigate(`/chat/${other.id}`));
    await waitFor(() => expect(app.hidden).toBe(true));
    act(() => navigate(`/chat/${t.id}`));
    await waitFor(() => expect(app.hidden).toBe(false));
    expect(app.querySelector('iframe')).toBe(iframe);
  });

  it('keeps a picture-in-picture app up in another chat and closes it on request', async () => {
    const other = thread({ title: 'Other chat' });
    await openChat({}, { hub: { m4: m4State({ entryPoints: ENTRIES }), threads: [other] } });
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Apps' }));
    await userEvent.click(
      await within(inspector()).findByRole('button', { name: 'Open Sample panel' }),
    );
    const app = within(inspector()).getByRole('region', { name: 'Sample panel' });
    await userEvent.click(within(app).getByRole('button', { name: 'Picture in picture' }));
    act(() => navigate(`/chat/${other.id}`));
    await waitFor(() =>
      expect(within(inspector()).getByRole('button', { name: 'Open Sample panel' })).toHaveProperty(
        'disabled',
        false,
      ),
    );
    expect(app.hidden).toBe(false);
    expect(app.dataset.mode).toBe('pip');
    // A message from an app of another chat does not go into this chat's composer.
    const iframe = app.querySelector('iframe')!;
    const posted: Record<string, unknown>[] = [];
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(
      (m: unknown) => void posted.push(m as Record<string, unknown>),
    );
    fromFrame(iframe, {
      jsonrpc: '2.0',
      id: 7,
      method: 'ui/message',
      params: { content: { type: 'text', text: 'Wrong chat' } },
    });
    await waitFor(() => expect(posted.find((m) => m.id === 7)).toHaveProperty('error'));
    expect(box().value).toBe('');
    await userEvent.click(within(app).getByRole('button', { name: 'Close Sample panel' }));
    expect(within(inspector()).queryByRole('region', { name: 'Sample panel' })).toBeNull();
  });

  it('asks for a chat first and says when there are no apps', async () => {
    const hub = createHub({ m4: m4State({ entryPoints: [] }) });
    await renderApp({ hub, path: '/chat' });
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Apps' }));
    expect(within(inspector()).getByText('Open a chat to see its apps.')).toBeTruthy();
    resetDom();
    await openChat({}, { hub: { m4: m4State({ entryPoints: [] }) } });
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Apps' }));
    expect(await within(inspector()).findByText(/No apps for chats yet/)).toBeTruthy();
  });
});

describe('file entry points', () => {
  it('match a file by its extension, ignoring case', () => {
    expect(fileExtension('data/report.CSV')).toBe('.csv');
    expect(fileExtension('Makefile')).toBe('');
    expect(fileExtension('.env')).toBe('');
    expect(fileAppsFor(ENTRIES, 'a/b.tsv').map((e) => e.id)).toEqual(['ep-file']);
    expect(fileAppsFor(ENTRIES, 'a/b.md')).toEqual([]);
    expect(fileAppsFor(ENTRIES, 'noext')).toEqual([]);
  });

  it('opens a file in its app with the file in the host context', async () => {
    const hub = createHub({ m4: m4State({ entryPoints: ENTRIES }) });
    function Viewer({ path }: { path: string }) {
      const apps = useFileApps(path);
      if (apps === null) return <p>Loading</p>;
      const app = apps[0];
      return app ? <FileApp entry={app} root="/data/workspace" path={path} /> : <p>No app</p>;
    }
    render(
      <AnnouncerProvider>
        <ServicesProvider api={hub.api} eventSource={fakeEventSource} registry={testRegistry()}>
          <Viewer path="reports/q3.csv" />
        </ServicesProvider>
      </AnnouncerProvider>,
    );
    const app = await screen.findByRole('region', { name: 'CSV viewer' });
    const iframe = app.querySelector('iframe')!;
    const posted: Record<string, unknown>[] = [];
    vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(
      (m: unknown) => void posted.push(m as Record<string, unknown>),
    );
    fromFrame(iframe, { jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {} });
    await waitFor(() => expect(posted[0]).toBeTruthy());
    expect(posted[0]).toMatchObject({
      result: {
        hostContext: {
          'nova/file': { root: '/data/workspace', path: 'reports/q3.csv', name: 'q3.csv' },
        },
      },
    });
  });
});
