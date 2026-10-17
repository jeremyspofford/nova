// The App frame (FR-198): sandbox attributes, message origin filtering, each bridge method with
// malformed input, tool calls through the gate (an approval card in Nova's chrome), private
// context never shared, display modes by keyboard (Escape leaves fullscreen), one
// picture-in-picture app, the height cap, tool input and result notifications, links and close.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolDescriptor, UiEntryPointView } from '@nova/shared';
import type { ToolInvokeResult } from '../src/api.ts';
import { APPS_MOVED_EVENT, McpAppFrame, type McpAppFrameProps } from '../src/apps/McpAppFrame.tsx';
import { RPC } from '../src/apps/bridge.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { approvalView } from './chat-m3-helpers.tsx';
import { createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { resetDom } from './render.tsx';

afterEach(resetDom);

function entryPoint(over: Partial<UiEntryPointView> = {}): UiEntryPointView {
  return {
    id: 'ep-panel',
    kind: 'thread',
    title: 'Sample panel',
    serverId: 's1',
    pluginId: 'com.example.sample',
    resource: 'ui://sample/panel',
    extensions: [],
    ...over,
  };
}

const PANEL_TOOL: ToolDescriptor = {
  name: 'mcp:sample.panel_action',
  title: 'Panel action',
  description: 'Record an action',
  source: 'mcp',
  serverId: 's1',
  inputSchema: { type: 'object' },
};

function setup(props: Partial<McpAppFrameProps> = {}, hub = createHub()) {
  hub.state.m3.mcpTools.set('s1', [PANEL_TOOL]);
  const view = (p: Partial<McpAppFrameProps>) => (
    <AnnouncerProvider>
      <ServicesProvider api={hub.api} eventSource={fakeEventSource} registry={testRegistry()}>
        <McpAppFrame entry={entryPoint()} threadId="t1" approvalPollMs={20} {...p} />
      </ServicesProvider>
    </AnnouncerProvider>
  );
  const utils = render(view(props));
  const iframe = () => document.querySelector<HTMLIFrameElement>('iframe.app-frame-iframe')!;
  const posted: Record<string, unknown>[] = [];
  const watch = () => {
    vi.spyOn(iframe().contentWindow!, 'postMessage').mockImplementation(
      (m: unknown) => void posted.push(m as Record<string, unknown>),
    );
  };
  watch();
  let nextId = 1;
  /** A message from the app (or, with `source`, from another window). */
  const send = (data: unknown, opts: { source?: Window | null; origin?: string } = {}) => {
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data,
          source: opts.source === undefined ? iframe().contentWindow : opts.source,
          origin: opts.origin ?? 'null',
        }),
      );
    });
  };
  const request = (method: string, params: unknown = {}) => {
    const id = nextId++;
    send({ jsonrpc: '2.0', id, method, params });
    return id;
  };
  const answer = (id: number) =>
    waitFor(() => {
      const m = posted.find((p) => p.id === id);
      expect(m).toBeTruthy();
      return m as { result?: Record<string, unknown>; error?: { code: number; message: string } };
    });
  const notes = (method: string) =>
    posted.filter((p) => p.method === method).map((p) => p.params as Record<string, unknown>);
  const rerender = (p: Partial<McpAppFrameProps>) => utils.rerender(view(p));
  return { ...utils, hub, iframe, posted, send, request, answer, notes, rerender, watch };
}

const region = () => screen.getByRole('region', { name: 'Sample panel' });

describe('the sandboxed frame', () => {
  it('loads the resource in an iframe sandboxed to scripts only', () => {
    const f = setup();
    const el = f.iframe();
    expect(el.getAttribute('sandbox')).toBe('allow-scripts');
    expect(el.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(el.getAttribute('src')).toBe('/api/v1/ui/resource?entry=ep-panel');
    expect(el.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(el.title).toBe('App: Sample panel');
    // The header names the app; without a known owner it is labelled Unverified.
    expect(within(region()).getByRole('heading', { name: 'Sample panel' })).toBeTruthy();
    expect(within(region()).getByText('Unverified')).toBeTruthy();
  });

  it('shows the owner and a Verified badge when the plugin is verified', () => {
    setup({ owner: { name: 'Sample plugin', verified: true } });
    expect(within(region()).getByText('Sample plugin')).toBeTruthy();
    expect(within(region()).getByText('Verified').dataset.verified).toBe('true');
  });

  it('reads only messages from its own frame on an opaque origin', async () => {
    const f = setup();
    f.send({ jsonrpc: '2.0', id: 1, method: 'ping' }, { source: window });
    f.send({ jsonrpc: '2.0', id: 2, method: 'ping' }, { origin: 'http://localhost:3000' });
    f.send({ jsonrpc: '2.0', id: 3, method: 'ping' }, { source: null });
    await new Promise((r) => setTimeout(r, 20));
    expect(f.posted).toEqual([]);
    const id = f.request('ping');
    expect((await f.answer(id)).result).toEqual({});
  });
});

describe('bridge methods', () => {
  it('initializes with the host context and answers malformed or unknown requests', async () => {
    document.documentElement.style.setProperty('--u-accent', '#6c8cff');
    const f = setup();
    const init = await f.answer(
      f.request('ui/initialize', { protocolVersion: '2026-02-01', appInfo: { name: 'x' } }),
    );
    expect(init.result).toMatchObject({
      protocolVersion: '2026-02-01',
      hostInfo: { name: 'Nova' },
      hostCapabilities: { serverTools: {}, experimental: { 'nova/private': {} } },
      hostContext: {
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen', 'pip'],
        platform: 'web',
        styles: { variables: { '--u-accent': '#6c8cff' } },
      },
    });
    const odd = await f.answer(f.request('ui/initialize', { protocolVersion: 'latest' }));
    expect(odd.result?.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect((await f.answer(f.request('resources/subscribe'))).error?.code).toBe(RPC.methodNotFound);
    f.send({ jsonrpc: '1.0', id: 50, method: 'ping' });
    expect((await f.answer(50)).error?.code).toBe(RPC.invalidRequest);
    f.send({ jsonrpc: '2.0', id: 51, method: 'tools/call', params: ['panel_action'] });
    expect((await f.answer(51)).error?.code).toBe(RPC.invalidParams);
    // Garbage without an id gets no answer and breaks nothing.
    f.send('<script>alert(1)</script>');
    f.send({ jsonrpc: '2.0', method: 42 });
    expect((await f.answer(f.request('ping'))).result).toEqual({});
  });

  it('calls its own server tool through the Hub with origin ui and the thread', async () => {
    const f = setup();
    const id = f.request('tools/call', { name: 'panel_action', arguments: { value: 'hi' } });
    expect((await f.answer(id)).result).toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(f.hub.api.invokeTool).toHaveBeenCalledWith('mcp:sample.panel_action', {
      args: { value: 'hi' },
      threadId: 't1',
    });
    // Another server's or a built-in tool is refused before anything is called.
    const other = await f.answer(f.request('tools/call', { name: 'fs.write', arguments: {} }));
    expect(other.error).toMatchObject({ code: RPC.invalidParams });
    expect(other.error?.message).toMatch(/not a tool of this app's server/);
    const bad = await f.answer(f.request('tools/call', { name: 'panel_action', arguments: [1] }));
    expect(bad.error?.code).toBe(RPC.invalidParams);
    const noName = await f.answer(f.request('tools/call', { arguments: {} }));
    expect(noName.error?.code).toBe(RPC.invalidParams);
    expect(f.hub.api.invokeTool).toHaveBeenCalledTimes(1);
    // A failed call is a tool error the app can show.
    f.hub.api.invokeTool.mockResolvedValueOnce({
      ok: false,
      text: '',
      error: { code: 'policy_denied', message: 'Denied by a rule.' },
    } satisfies ToolInvokeResult);
    const denied = await f.answer(f.request('tools/call', { name: 'panel_action', arguments: {} }));
    expect(denied.result).toEqual({
      content: [{ type: 'text', text: 'Denied by a rule.' }],
      isError: true,
    });
  });

  it('shows the approval a tool call raises in the frame chrome and returns the result', async () => {
    const f = setup();
    let finish: (r: ToolInvokeResult) => void = () => undefined;
    f.hub.api.invokeTool.mockImplementationOnce(() => {
      f.hub.state.m3.approvals.push(
        approvalView('t1', {
          id: 'ap-panel',
          tool: 'mcp:sample.panel_action',
          action: 'Run Panel action',
          userAsked: false,
          options: ['allow_once', 'deny_continue'],
          alwaysScopes: [],
        }),
      );
      return new Promise<ToolInvokeResult>((r) => {
        finish = r;
      });
    });
    const id = f.request('tools/call', { name: 'panel_action', arguments: { value: 'go' } });
    const card = await within(region()).findByRole('group', { name: /Approval needed/ });
    expect(within(card).getByText('Run Panel action')).toBeTruthy();
    // It came from the app, not the user: the card says so.
    expect(within(card).getByText(/cannot authorize actions/)).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: 'Allow once' }));
    expect(f.hub.api.decideApproval).toHaveBeenCalledWith({
      approvalId: 'ap-panel',
      decision: 'allow_once',
    });
    finish({ ok: true, text: 'Panel action recorded: go' });
    expect((await f.answer(id)).result).toEqual({
      content: [{ type: 'text', text: 'Panel action recorded: go' }],
    });
    expect(await within(region()).findByText(/Allowed once/)).toBeTruthy();
  });

  it('tells the app when the call still waits for an approval', async () => {
    const f = setup();
    f.hub.state.m3.approvals.push(
      approvalView('t1', { id: 'ap-late', tool: 'mcp:sample.panel_action', action: 'Late call' }),
    );
    f.hub.api.invokeTool.mockResolvedValueOnce({ approvalId: 'ap-late', callId: 'c1' });
    const res = await f.answer(f.request('tools/call', { name: 'panel_action', arguments: {} }));
    expect(res.result?.isError).toBe(true);
    expect(JSON.stringify(res.result)).toMatch(/waiting for your approval/);
    expect(await within(region()).findByText('Late call')).toBeTruthy();
  });

  it('limits the calls one app runs at once', async () => {
    const f = setup();
    f.hub.api.invokeTool.mockImplementation(() => new Promise(() => undefined));
    const ids = [1, 2, 3, 4, 5].map(() => f.request('tools/call', { name: 'panel_action' }));
    const last = await f.answer(ids[4]!);
    expect(last.error).toMatchObject({ code: RPC.refused });
  });

  it('shares model context without the private parts and keeps it under the cap', async () => {
    const onModelContext = vi.fn();
    const f = setup({ onModelContext });
    const id = f.request('ui/update-model-context', {
      content: [
        { type: 'text', text: 'Selected card: Ship M4' },
        { type: 'text', text: 'draft-token-123', _meta: { 'nova/private': true } },
      ],
    });
    expect((await f.answer(id)).result).toEqual({});
    expect(onModelContext).toHaveBeenLastCalledWith('Selected card: Ship M4');
    const shared = within(region()).getByText('Shared with the model').closest('details')!;
    expect(within(shared).getByText('Selected card: Ship M4')).toBeTruthy();
    expect(document.body.textContent).not.toContain('draft-token-123');
    for (const call of onModelContext.mock.calls)
      expect(String(call[0])).not.toContain('draft-token');

    // A whole update marked private shares nothing and clears what was shared.
    await f.answer(
      f.request('ui/update-model-context', {
        content: [{ type: 'text', text: 'only mine' }],
        _meta: { 'nova/private': true },
      }),
    );
    expect(onModelContext).toHaveBeenLastCalledWith(null);
    expect(within(region()).queryByText('Shared with the model')).toBeNull();
    // The private part comes back to the app on its next initialize, from this window only.
    const init = await f.answer(f.request('ui/initialize'));
    expect(JSON.stringify(init.result)).toContain('only mine');

    const big = await f.answer(
      f.request('ui/update-model-context', {
        content: [{ type: 'text', text: 'x'.repeat(16_001) }],
      }),
    );
    expect(big.error).toMatchObject({ code: RPC.invalidParams });
    expect(big.error?.message).toMatch(/4,000 tokens/);
    expect(onModelContext).toHaveBeenCalledTimes(2);
    const bad = await f.answer(f.request('ui/update-model-context', { content: 'text' }));
    expect(bad.error?.code).toBe(RPC.invalidParams);
  });

  it('puts a message in the composer only, and refuses where there is none', async () => {
    const onMessage = vi.fn(() => true);
    const f = setup({ onMessage });
    const ok = await f.answer(
      f.request('ui/message', { role: 'user', content: { type: 'text', text: 'Summarize it' } }),
    );
    expect(ok.result).toEqual({});
    expect(onMessage).toHaveBeenCalledWith('Summarize it');
    expect(f.hub.api.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId('announcer').textContent).toMatch(/Review it before you send/);
    onMessage.mockReturnValueOnce(false);
    const none = await f.answer(
      f.request('ui/message', { content: { type: 'text', text: 'Hello' } }),
    );
    expect(none.error).toMatchObject({ code: RPC.refused });
    const bad = await f.answer(
      f.request('ui/message', { role: 'assistant', content: { type: 'text', text: 'I agree' } }),
    );
    expect(bad.error?.code).toBe(RPC.invalidParams);
  });

  it('offers a link for the user to open and refuses other schemes', async () => {
    const f = setup();
    expect(
      (await f.answer(f.request('ui/open-link', { url: 'https://example.com/docs' }))).result,
    ).toEqual({});
    const a = within(region()).getByRole('link', { name: /Open link/ });
    expect(a.getAttribute('href')).toBe('https://example.com/docs');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    await userEvent.click(within(region()).getByRole('button', { name: 'Dismiss' }));
    expect(within(region()).queryByRole('link', { name: /Open link/ })).toBeNull();
    const bad = await f.answer(f.request('ui/open-link', { url: 'javascript:alert(1)' }));
    expect(bad.error?.code).toBe(RPC.invalidParams);
  });

  it('sends the tool input and result after the app initializes', async () => {
    const f = setup({ toolCall: { arguments: { value: 'x' } } });
    f.send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    await waitFor(() =>
      expect(f.notes('ui/notifications/tool-input')).toEqual([{ arguments: { value: 'x' } }]),
    );
    expect(f.notes('ui/notifications/tool-result')).toEqual([]);
    const result = {
      content: [{ type: 'text', text: 'recorded' }],
      structuredContent: { value: 'x' },
    };
    f.rerender({ toolCall: { arguments: { value: 'x' }, result } });
    await waitFor(() => expect(f.notes('ui/notifications/tool-result')).toEqual([result]));
  });
});

describe('display modes and size', () => {
  it('caps the reported height', async () => {
    setup();
    const f = { body: () => document.querySelector<HTMLElement>('.app-frame-body')! };
    expect(f.body().style.height).toBe('320px');
    const send = (height: unknown) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height } },
            source: document.querySelector('iframe')!.contentWindow,
            origin: 'null',
          }),
        );
      });
    send(5000);
    await waitFor(() => expect(f.body().style.height).toBe('600px'));
    send(10);
    await waitFor(() => expect(f.body().style.height).toBe('80px'));
    send('tall');
    send(Number.NaN);
    await new Promise((r) => setTimeout(r, 10));
    expect(f.body().style.height).toBe('80px');
  });

  it('enters fullscreen as a dialog and leaves it with Escape, by keyboard', async () => {
    const f = setup();
    const full = within(region()).getByRole('button', { name: 'Full screen' });
    full.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Sample panel' });
    expect(dialog.dataset.mode).toBe('fullscreen');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Exit full screen' }),
    );
    expect(f.notes('ui/notifications/host-context-changed')).toEqual([
      { displayMode: 'fullscreen' },
    ]);
    // Tab stays inside the dialog.
    await userEvent.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(region().dataset.mode).toBe('inline');
    expect(document.activeElement).toBe(
      within(region()).getByRole('button', { name: 'Full screen' }),
    );
    expect(f.notes('ui/notifications/host-context-changed').at(-1)).toEqual({
      displayMode: 'inline',
    });
    // The iframe was never replaced, so the app kept running.
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('floats in picture-in-picture, moves with the arrow keys and lets one app in at a time', async () => {
    const hub = createHub();
    hub.state.m3.mcpTools.set('s1', [PANEL_TOOL]);
    render(
      <AnnouncerProvider>
        <ServicesProvider api={hub.api} eventSource={fakeEventSource} registry={testRegistry()}>
          <McpAppFrame entry={entryPoint()} threadId="t1" />
          <McpAppFrame entry={entryPoint({ id: 'ep-2', title: 'Board' })} threadId="t1" />
        </ServicesProvider>
      </AnnouncerProvider>,
    );
    const first = screen.getByRole('region', { name: 'Sample panel' });
    const second = screen.getByRole('region', { name: 'Board' });
    await userEvent.click(within(first).getByRole('button', { name: 'Picture in picture' }));
    expect(first.dataset.mode).toBe('pip');
    expect(first.style.right).toBe('16px');
    const move = within(first).getByRole('button', { name: /Move panel/ });
    move.focus();
    await userEvent.keyboard('{ArrowLeft}{ArrowUp}');
    expect(first.style.right).toBe('40px');
    expect(first.style.bottom).toBe('40px');
    await userEvent.click(within(second).getByRole('button', { name: 'Picture in picture' }));
    expect(second.dataset.mode).toBe('pip');
    await waitFor(() => expect(first.dataset.mode).toBe('inline'));
  });

  it('switches mode when the app asks, within the modes it may use', async () => {
    const f = setup();
    expect((await f.answer(f.request('ui/request-display-mode', { mode: 'pip' }))).result).toEqual({
      mode: 'pip',
    });
    expect(region().dataset.mode).toBe('pip');
    const bad = await f.answer(f.request('ui/request-display-mode', { mode: 'maximized' }));
    expect(bad.error?.code).toBe(RPC.invalidParams);
    // A page is always full screen.
    f.unmount();
    const p = setup({ placement: 'page' });
    expect(
      (await p.answer(p.request('ui/request-display-mode', { mode: 'inline' }))).result,
    ).toEqual({
      mode: 'fullscreen',
    });
    expect(screen.queryByRole('button', { name: 'Picture in picture' })).toBeNull();
  });

  it('keeps a hidden app running and a picture-in-picture app visible', async () => {
    const f = setup({ inactive: true });
    expect(document.querySelector<HTMLElement>('section.app-frame')!.hidden).toBe(true);
    f.rerender({ inactive: false });
    await userEvent.click(within(region()).getByRole('button', { name: 'Picture in picture' }));
    f.rerender({ inactive: true });
    expect(region().hidden).toBe(false);
  });
});

describe('frame lifecycle', () => {
  it('stops an app that navigates its frame away and can reload it', async () => {
    setup();
    // jsdom may fire the first load itself; the next one is a navigation.
    for (let i = 0; i < 2; i++) {
      const el = document.querySelector('iframe');
      if (el) act(() => void el.dispatchEvent(new Event('load')));
    }
    expect(await within(region()).findByText(/left its page/)).toBeTruthy();
    expect(document.querySelector('iframe')).toBeNull();
    await userEvent.click(within(region()).getByRole('button', { name: /Reload app/ }));
    expect(document.querySelector('iframe')).toBeTruthy();
  });

  it('restarts the app in a fresh frame when its host moves with a reload, and still stops navigations', async () => {
    const hub = createHub();
    hub.state.m3.mcpTools.set('s1', [PANEL_TOOL]);
    const host = document.createElement('div');
    host.className = 'apps-host';
    document.body.appendChild(host);
    render(
      <AnnouncerProvider>
        <ServicesProvider api={hub.api} eventSource={fakeEventSource} registry={testRegistry()}>
          <McpAppFrame entry={entryPoint()} threadId="t1" approvalPollMs={20} />
        </ServicesProvider>
      </AnnouncerProvider>,
      { container: host },
    );
    const load = () => {
      const el = document.querySelector('iframe');
      if (el) act(() => void el.dispatchEvent(new Event('load')));
    };
    load();
    const before = document.querySelector('iframe');
    // The shell is about to move the host in a way that reloads frames (no moveBefore).
    act(() => void host.dispatchEvent(new Event(APPS_MOVED_EVENT)));
    const after = document.querySelector('iframe');
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    load();
    expect(screen.queryByText(/left its page/)).toBeNull();
    // A load after that is the app navigating away again: stopped.
    load();
    expect(await screen.findByText(/left its page/)).toBeTruthy();
    host.remove();
  });

  it('tears the app down on Close and withdraws what it shared', async () => {
    const onClose = vi.fn();
    const onModelContext = vi.fn();
    const f = setup({ onClose, onModelContext });
    await f.answer(
      f.request('ui/update-model-context', { content: [{ type: 'text', text: 'context' }] }),
    );
    await userEvent.click(within(region()).getByRole('button', { name: 'Close Sample panel' }));
    expect(f.posted.some((m) => m.method === 'ui/resource-teardown')).toBe(true);
    expect(onModelContext).toHaveBeenLastCalledWith(null);
    expect(onClose).toHaveBeenCalled();
  });
});
