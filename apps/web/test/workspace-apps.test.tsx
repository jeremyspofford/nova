// MCP Apps in the workspace (FR-198): a tool's app under its card, the chat's apps surviving
// Inspector tab switches, and "Open app…" in the palette.
import { afterEach, describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { UiEntryPointView } from '@nova/shared';
import { previewArgs, toolAppEntry } from '../src/chat/tool-apps.tsx';
import { message } from './fakes.ts';
import { inspector, openWith, toolPart } from './chat-m3-helpers.tsx';
import { toolView } from './fakes-settings.ts';
import { renderApp, resetDom } from './render.tsx';
import { createHub } from './fakes.ts';
import { m4State } from './fakes-m4.ts';

afterEach(resetDom);

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

describe('tool apps under tool cards (FR-198)', () => {
  it('renders the app of a tool that declares a UI, and closes it', async () => {
    const { hub } = await openWith({
      messages: (tid) => [
        message(tid, {
          role: 'assistant',
          parts: [
            toolPart({
              callId: 'c1',
              tool: 'mcp:s1.chart',
              title: 'Draw chart',
              source: 'mcp',
              argsPreview: '{"series":[1,2]}',
              resultPreview: 'ok',
            }),
            toolPart({ callId: 'c2', tool: 'fs.read', title: 'Read file' }),
            toolPart({
              callId: 'c3',
              tool: 'mcp:s1.chart',
              title: 'Pending chart',
              source: 'mcp',
              status: 'awaiting_approval',
            }),
          ],
        }),
      ],
      m3: () => ({
        tools: [
          toolView({
            name: 'mcp:s1.chart',
            source: 'mcp',
            serverId: 's1',
            ui: { resourceUri: 'ui://chart' },
          }),
          toolView({ name: 'fs.read' }),
        ],
      }),
      hub: {
        m4: m4State({ entryPoints: [entry(), entry({ id: 'ep-other', resource: 'ui://other' })] }),
      },
    });
    const frame = await screen.findByRole('heading', { name: 'Chart' });
    const section = frame.closest('.app-frame')!;
    // The app sits right after the card of the call it renders.
    const card = screen.getByRole('group', { name: 'Tool call: Draw chart' });
    expect(card.nextElementSibling).toBe(section);
    expect(screen.getAllByRole('heading', { name: 'Chart' })).toHaveLength(1);
    expect(hub.api.listTools).toHaveBeenCalledTimes(1);
    expect(hub.api.uiEntryPoints).toHaveBeenCalledWith('thread');
    await userEvent.click(
      within(section as HTMLElement).getByRole('button', { name: 'Close Chart' }),
    );
    expect(screen.queryByRole('heading', { name: 'Chart' })).toBeNull();
  });

  it('loads nothing for replies without tool calls', async () => {
    const { hub } = await openWith({
      messages: (tid) => [
        message(tid, { role: 'assistant', parts: [{ type: 'text', text: 'Hi' }] }),
      ],
    });
    await screen.findByText('Hi');
    expect(hub.api.listTools).not.toHaveBeenCalled();
  });

  it('matches by server and resource, or by plugin, and reads the arguments preview', () => {
    const data = {
      tools: [
        toolView({ name: 'a', serverId: 's1', ui: { resourceUri: 'ui://x' } }),
        toolView({ name: 'b', pluginId: 'p1', ui: { resourceUri: 'ui://y' } }),
        toolView({ name: 'c', ui: { resourceUri: 'ui://z' } }),
        toolView({ name: 'd', serverId: 's1' }),
      ],
      entries: [
        entry({ id: 'e1', serverId: 's2', resource: 'ui://x' }),
        entry({ id: 'e2', serverId: 's1', resource: 'ui://x' }),
        entry({ id: 'e3', serverId: 's9', pluginId: 'p1', resource: 'ui://y' }),
        entry({ id: 'e4', resource: 'ui://z' }),
      ],
    };
    expect(toolAppEntry(data, 'a')?.id).toBe('e2');
    expect(toolAppEntry(data, 'b')?.id).toBe('e3');
    expect(toolAppEntry(data, 'c')).toBeNull();
    expect(toolAppEntry(data, 'd')).toBeNull();
    expect(toolAppEntry(data, 'missing')).toBeNull();
    expect(previewArgs('{"a":1}')).toEqual({ a: 1 });
    expect(previewArgs('{"a":1, "b": "trunc')).toEqual({});
    expect(previewArgs('[1]')).toEqual({});
    expect(previewArgs('')).toEqual({});
  });
});

describe('the chat’s apps in the Inspector (FR-198)', () => {
  it('keeps an open app running when another Inspector tab is shown', async () => {
    const { hub } = await openWith();
    hub.state.m4.entryPoints = [entry({ id: 'ep-notes', title: 'Notes board' })];
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Apps' }));
    await userEvent.click(
      await within(inspector()).findByRole('button', { name: 'Open Notes board' }),
    );
    const frame = (
      await within(inspector()).findByRole('heading', { name: 'Notes board' })
    ).closest('.app-frame')!;
    const iframe = frame.querySelector('iframe');
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Files' }));
    // Still mounted, out of the Inspector and out of sight.
    expect(frame.isConnected).toBe(true);
    expect(frame.closest('.apps-park')).toBeTruthy();
    expect(inspector().contains(frame)).toBe(false);
    // Hiding the Inspector parks it too.
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Apps' }));
    expect(inspector().contains(frame)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Toggle inspector' }));
    expect(frame.closest('.apps-park')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Toggle inspector' }));
    await userEvent.click(within(inspector()).getByRole('tab', { name: 'Apps' }));
    // The same app, never reloaded.
    expect(inspector().contains(frame)).toBe(true);
    expect(frame.querySelector('iframe')).toBe(iframe);
  });

  it('opens a global app from the palette command', async () => {
    const hub = createHub();
    hub.state.m4.entryPoints = [
      entry({ id: 'ep-g1', kind: 'global', title: 'Kanban' }),
      entry({ id: 'ep-g2', kind: 'global', title: 'Calendar' }),
      entry(),
    ];
    const { registry } = await renderApp({ hub });
    act(() => {
      registry.run('apps.open');
    });
    const dialog = await screen.findByRole('dialog', { name: 'Open app' });
    await waitFor(() => expect(within(dialog).getAllByRole('option')).toHaveLength(2));
    expect(hub.api.uiEntryPoints).toHaveBeenCalledWith('global');
    await userEvent.keyboard('cal');
    expect(
      within(dialog)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Calendar']);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(window.location.pathname).toBe('/apps/ep-g2'));
    expect(screen.queryByRole('dialog', { name: 'Open app' })).toBeNull();
  });

  it('says when there are no apps, and closes with Escape', async () => {
    const { registry } = await renderApp();
    act(() => {
      registry.run('apps.open');
    });
    const dialog = await screen.findByRole('dialog', { name: 'Open app' });
    expect(await within(dialog).findByText(/No apps yet/)).toBeTruthy();
    await userEvent.keyboard('zz');
    await userEvent.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Open app' })).toBeNull();
  });
});
