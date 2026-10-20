// MCP Apps in the pseudo-locale (FR-016, FR-198): the Apps page (list, an app as a page, not
// found, none, a load failure), the Inspector's Apps tab, and the frame's chrome in each display
// mode with a link notice, shared context and a stopped app show every word through messages.
// App titles, plugin names, host names and Hub messages are fixture data.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginView, UiEntryPointView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { APPS_TEXT, ThreadApps } from '../src/apps/AppsView.tsx';
import { FRAME_TEXT, McpAppFrame } from '../src/apps/McpAppFrame.tsx';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SIDEBAR_TEXT } from '../src/shell/strings.ts';
import { createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { m4State } from './fakes-m4.ts';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  resetTestLocale();
  window.history.replaceState(null, '', '/');
});

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

const PLUGIN = { id: 'com.example.sample', name: 'Sample plugin', verified: true } as PluginView;
const GLOBAL = entry({
  id: 'ep-global',
  kind: 'global',
  title: 'Dashboard',
  domains: ['api.example.com', 'cdn.example.com'],
});
const DATA = ['Dashboard', 'Sample panel', 'Sample plugin', 'api.example.com', 'cdn.example.com'];

/** The whole app at `path` in en-XA, ready once the (pseudo-localized) sidebar is up. */
async function renderPseudoApp(hub: ReturnType<typeof createHub>, path: string) {
  await activateTestLocale('en-XA');
  const utils = await renderApp({ hub, path, ready: false });
  await screen.findByRole('navigation', { name: SIDEBAR_TEXT.sidebar });
  return utils;
}

function frame(ui: React.ReactNode, hub = createHub()) {
  return render(
    <AnnouncerProvider>
      <ServicesProvider api={hub.api} eventSource={fakeEventSource} registry={testRegistry()}>
        {ui}
      </ServicesProvider>
    </AnnouncerProvider>,
  );
}

describe('MCP Apps in a pseudo-locale', () => {
  it('shows the Apps page and an app opened as a page', async () => {
    const hub = createHub({ m4: m4State({ entryPoints: [entry(), GLOBAL], plugins: [PLUGIN] }) });
    await renderPseudoApp(hub, '/apps');
    const list = await screen.findByRole('list', { name: APPS_TEXT.title });
    await within(list).findByText('Sample plugin');
    expectFullyLocalized(document.querySelector('.apps-view')!, { data: DATA });

    await userEvent.click(
      within(list).getByRole('button', { name: APPS_TEXT.openApp({ title: 'Dashboard' }) }),
    );
    const page = await screen.findByRole('region', { name: 'Dashboard' });
    expect(within(page).getByText(FRAME_TEXT.verified)).toBeTruthy();
    expectFullyLocalized(page, { data: DATA });
  });

  it('says when an app is not found, when there are none and when loading fails', async () => {
    await renderPseudoApp(createHub({ m4: m4State({ entryPoints: [entry()] }) }), '/apps/nope');
    await screen.findByRole('heading', { name: APPS_TEXT.notFound });
    expectFullyLocalized(document.querySelector('.apps-view')!);
    await userEvent.click(screen.getByRole('button', { name: APPS_TEXT.allApps }));
    await screen.findByRole('heading', { name: APPS_TEXT.none });
    expectFullyLocalized(document.querySelector('.apps-view')!);
    resetDom();

    const failing = createHub();
    failing.state.failNext.uiEntryPoints = new ApiError(500, {
      code: 'server_error',
      message: 'The Hub is busy.',
      retryable: true,
    });
    await renderPseudoApp(failing, '/apps');
    await screen.findByText('The Hub is busy.');
    expectFullyLocalized(document.querySelector('.apps-view')!, { data: ['The Hub is busy.'] });
  });

  it('shows the Inspector Apps tab without a chat, empty and with apps', async () => {
    await activateTestLocale('en-XA');
    const none = frame(<ThreadApps threadId={null} />);
    expect(screen.getByText(APPS_TEXT.openChat)).toBeTruthy();
    expectFullyLocalized(none.container);
    none.unmount();

    const empty = frame(
      <ThreadApps threadId="t1" />,
      createHub({ m4: m4State({ entryPoints: [] }) }),
    );
    await screen.findByText(APPS_TEXT.noneForChats);
    expectFullyLocalized(empty.container);
    empty.unmount();

    const hub = createHub({ m4: m4State({ entryPoints: [entry()], plugins: [PLUGIN] }) });
    const some = frame(<ThreadApps threadId="t1" />, hub);
    const list = await screen.findByRole('list', { name: APPS_TEXT.forThisChat });
    await userEvent.click(
      within(list).getByRole('button', { name: APPS_TEXT.openApp({ title: 'Sample panel' }) }),
    );
    expect(within(list).getByRole('button', { name: /Sample panel/ }).textContent).toBe(
      APPS_TEXT.opened,
    );
    expectFullyLocalized(some.container, { data: DATA });
  });

  it("shows the frame's chrome in every mode, with a link, shared context and a stop", async () => {
    await activateTestLocale('en-XA');
    const { container } = frame(
      <McpAppFrame
        entry={entry({ domains: [] })}
        threadId="t1"
        owner={{ name: 'Sample plugin', verified: false }}
      />,
    );
    const region = screen.getByRole('region', { name: 'Sample panel' });
    expect(within(region).getByText(FRAME_TEXT.unverified)).toBeTruthy();
    const iframe = container.querySelector<HTMLIFrameElement>('iframe.app-frame-iframe')!;
    const send = (data: unknown) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', { data, source: iframe.contentWindow, origin: 'null' }),
        );
      });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/open-link',
      params: { url: 'https://example.com/docs' },
    });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'ui/update-model-context',
      params: { content: [{ type: 'text', text: 'Board has 3 cards' }] },
    });
    await screen.findByText(FRAME_TEXT.shared);
    expectFullyLocalized(region, { data: DATA });

    await userEvent.click(screen.getByRole('button', { name: FRAME_TEXT.mode.fullscreen }));
    await screen.findByRole('button', { name: FRAME_TEXT.exitFullscreen });
    expectFullyLocalized(region, { data: DATA });
    await userEvent.click(screen.getByRole('button', { name: FRAME_TEXT.exitFullscreen }));

    await userEvent.click(screen.getByRole('button', { name: FRAME_TEXT.mode.pip }));
    expect(region.dataset.mode).toBe('pip');
    expectFullyLocalized(region, { data: DATA });

    // A second load means the app navigated away: Nova stops it and offers a reload.
    act(() => {
      iframe.dispatchEvent(new Event('load'));
      iframe.dispatchEvent(new Event('load'));
    });
    await waitFor(() => expect(screen.getByText(FRAME_TEXT.stopped)).toBeTruthy());
    expectFullyLocalized(region, { data: DATA });
  });
});
