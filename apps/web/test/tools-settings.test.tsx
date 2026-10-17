import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import {
  envToHeader,
  formFromServer,
  headerToEnv,
  mcpRequestFromForm,
  type McpFormState,
} from '../src/settings/McpServerForm.tsx';
import { MCP_POLL_MS, groupTools } from '../src/settings/ToolsPage.tsx';
import { createHub } from './fakes.ts';
import { m3State } from './fakes-m3.ts';
import { mcpServer, toolDescriptor, toolView } from './fakes-settings.ts';
import { captureIntervals } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const fail = (message: string, status = 500, code = 'x') =>
  new ApiError(status, { code, message, retryable: false });

const form = (over: Partial<McpFormState> = {}): McpFormState => ({
  ...formFromServer(null),
  name: 'github',
  command: 'npx',
  ...over,
});

describe('MCP server form logic (FR-042)', () => {
  it('builds a create body for stdio and for http with headers stored as env', () => {
    expect(
      mcpRequestFromForm(
        form({
          args: '-y\n gh-mcp \n',
          rows: [{ id: 1, name: 'GITHUB_TOKEN', value: 'ghp_x', saved: false }],
          defaultApproval: 'ask',
          toolTimeout: '30',
        }),
        null,
      ),
    ).toEqual({
      body: {
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'gh-mcp'],
        env: { GITHUB_TOKEN: 'ghp_x' },
        defaultApproval: 'ask',
        toolTimeoutMs: 30_000,
      },
    });
    expect(
      mcpRequestFromForm(
        form({
          transport: 'http',
          url: ' https://mcp.example.com/v1 ',
          rows: [
            { id: 1, name: 'X-Api-Key', value: 'k', saved: false },
            { id: 2, name: '', value: '', saved: false },
          ],
        }),
        null,
      ),
    ).toEqual({
      body: {
        name: 'github',
        transport: 'http',
        url: 'https://mcp.example.com/v1',
        env: { X_Api_Key: 'k' },
      },
    });
    expect(headerToEnv('X-Api-Key')).toBe('X_Api_Key');
    expect(envToHeader('X_Api_Key')).toBe('X-Api-Key');
  });

  it('reports every invalid field and sends nothing', () => {
    const out = mcpRequestFromForm(
      form({
        name: 'Bad Name',
        command: ' ',
        toolTimeout: '0',
        startupTimeout: 'abc',
        rows: [
          { id: 1, name: '1BAD', value: 'v', saved: false },
          { id: 2, name: 'OK', value: '', saved: false },
          { id: 3, name: 'DUP', value: 'a', saved: false },
          { id: 4, name: 'DUP', value: 'b', saved: false },
        ],
      }),
      null,
    );
    expect('errors' in out && out.errors).toMatchObject({
      name: expect.stringMatching(/lowercase/),
      command: expect.stringMatching(/command/),
      toolTimeout: expect.stringMatching(/1 to 600/),
      startupTimeout: expect.stringMatching(/1 to 120/),
      rows: {
        1: { name: expect.stringMatching(/underscores/) },
        2: { value: 'Enter a value for OK.' },
        4: { name: 'DUP is listed twice.' },
      },
    });
    const http = mcpRequestFromForm(
      form({
        transport: 'sse',
        url: 'ftp://x',
        rows: [{ id: 1, name: 'Bad_Header', value: 'v', saved: false }],
      }),
      null,
    );
    expect('errors' in http && http.errors).toMatchObject({
      url: expect.stringMatching(/http/),
      rows: { 1: { name: expect.stringMatching(/hyphens/) } },
    });
  });

  it('sends only what changed on edit, with env as the full set of names', () => {
    const s = mcpServer({ name: 'files', envKeys: ['API_KEY', 'OLD'], defaultApproval: null });
    const f = formFromServer(s);
    // Saved values are never in the form; only their names.
    expect(f.rows.map((r) => [r.name, r.value, r.saved])).toEqual([
      ['API_KEY', '', true],
      ['OLD', '', true],
    ]);
    expect(mcpRequestFromForm(f, s)).toEqual({ body: {} });
    const edited: McpFormState = {
      ...f,
      args: '-y\nother',
      defaultApproval: 'deny',
      rows: [
        { ...f.rows[0]!, value: 'new' },
        { id: 99, name: 'EXTRA', value: 'e', saved: false },
      ],
      toolTimeout: '90',
    };
    expect(mcpRequestFromForm(edited, s)).toEqual({
      body: {
        args: ['-y', 'other'],
        env: { API_KEY: 'new', EXTRA: 'e' },
        defaultApproval: 'deny',
        toolTimeoutMs: 90_000,
      },
    });
    // Removing a name sends the remaining names with empty values: keep their secrets.
    expect(mcpRequestFromForm({ ...f, rows: [f.rows[0]!] }, s)).toEqual({
      body: { env: { API_KEY: '' } },
    });
    // Switching transport carries the new target.
    expect(
      mcpRequestFromForm({ ...f, transport: 'http', url: 'https://h.example', rows: [] }, s),
    ).toEqual({ body: { transport: 'http', url: 'https://h.example', env: {} } });
  });

  it('groups tools by source, one group per MCP server', () => {
    const servers = [mcpServer({ id: 's1', name: 'files' })];
    const groups = groupTools(
      [
        toolView({ name: 'mcp:s1.b', source: 'mcp', serverId: 's1' }),
        toolView({ name: 'web.search' }),
        toolView({ name: 'fs.read' }),
        toolView({ name: 'mcp:s9.a', source: 'mcp', serverId: 's9' }),
      ],
      servers,
    );
    expect(groups.map((g) => [g.label, g.tools.map((t) => t.name)])).toEqual([
      ['Built-in', ['fs.read', 'web.search']],
      ['MCP: files', ['mcp:s1.b']],
      ['MCP: s9', ['mcp:s9.a']],
    ]);
  });
});

describe('Settings → Tools & MCP: servers (FR-042, FR-043)', () => {
  const setup = (over: Parameters<typeof m3State>[0] = {}) =>
    createHub({
      m3: m3State({
        mcpServers: [
          mcpServer({ id: 's1', name: 'files', envKeys: ['API_KEY'] }),
          mcpServer({
            id: 's2',
            name: 'tracker',
            transport: 'http',
            command: null,
            args: [],
            url: 'https://mcp.tracker.example/v1',
            envKeys: ['Authorization'],
            status: 'error',
            lastError: 'connect ECONNREFUSED',
            counts: { tools: 0, resources: 0, prompts: 0 },
            serverInfo: null,
          }),
        ],
        ...over,
      }),
    });

  it('lists servers with status, last error, target, counts and masked secrets', async () => {
    const hub = setup();
    await renderApp({ hub, path: '/settings/tools' });
    const files = await screen.findByRole('listitem', { name: 'files' });
    expect(within(files).getByText('Connected')).toBeTruthy();
    expect(within(files).getByText('npx -y some-mcp-server')).toBeTruthy();
    expect(
      within(files).getByText(/2 tools · 0 resources · 1 prompt · files-server 1.2.0/),
    ).toBeTruthy();
    expect(within(files).getByText(/API_KEY/)).toBeTruthy();
    const tracker = screen.getByRole('listitem', { name: 'tracker' });
    expect(within(tracker).getByText('Error')).toBeTruthy();
    expect(within(tracker).getByText('Last error: connect ECONNREFUSED')).toBeTruthy();
    expect(within(tracker).getByText('Headers:')).toBeTruthy();
    expect(within(tracker).getByText('https://mcp.tracker.example/v1')).toBeTruthy();
  });

  it("shows a plugin's server as managed by the plugin: no edit, remove or toggles", async () => {
    const hub = setup({
      mcpServers: [mcpServer({ id: 'p1', name: 'sample', pluginId: 'com.example.sample' })],
    });
    await renderApp({ hub, path: '/settings/tools' });
    const row = await screen.findByRole('listitem', { name: 'sample' });
    expect(within(row).getByText(/From the plugin com\.example\.sample/)).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(within(row).getByRole('switch', { name: 'Enable sample' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('adds a stdio server; the secret goes to the Hub and is never shown', async () => {
    const hub = setup({ mcpServers: [] });
    await renderApp({ hub, path: '/settings/tools' });
    expect(await screen.findByText('No MCP servers yet')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add server' }));
    const dialog = screen.getByRole('dialog', { name: 'Add an MCP server' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'github');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Command' }), 'npx');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Arguments' }),
      '-y{Enter}gh-mcp',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add variable' }));
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Variable 1' }),
      'GITHUB_TOKEN',
    );
    const value = within(dialog).getByLabelText('Value 1');
    expect(value.getAttribute('type')).toBe('password');
    await userEvent.type(value, 'ghp_secret');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add server' }));
    await waitFor(() =>
      expect(hub.api.createMcpServer).toHaveBeenCalledWith({
        name: 'github',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'gh-mcp'],
        env: { GITHUB_TOKEN: 'ghp_secret' },
      }),
    );
    expect(await screen.findByText('github added. It connects in the background.')).toBeTruthy();
    const row = screen.getByRole('listitem', { name: 'github' });
    expect(within(row).getByText('Starting')).toBeTruthy();
    expect(within(row).getByText(/GITHUB_TOKEN/)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('ghp_secret');

    // Editing shows the saved name with a masked, empty value.
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const edit = screen.getByRole('dialog', { name: 'Edit github' });
    const name = within(edit).getByRole<HTMLInputElement>('textbox', { name: 'Variable 1' });
    expect(name.value).toBe('GITHUB_TOKEN');
    expect(name.readOnly).toBe(true);
    const saved = within(edit).getByLabelText<HTMLInputElement>('Value 1');
    expect(saved.value).toBe('');
    expect(saved.placeholder).toBe('••••••••');
    expect(within(edit).getByText('Saved. Type a new value to replace it.')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('ghp_secret');
  });

  it('adds an http server whose headers are stored as env secrets', async () => {
    const hub = setup({ mcpServers: [] });
    await renderApp({ hub, path: '/settings/tools' });
    await userEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    const dialog = screen.getByRole('dialog', { name: 'Add an MCP server' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'notes');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Streamable HTTP' }));
    expect(within(dialog).queryByRole('textbox', { name: 'Command' })).toBeNull();
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Server URL' }),
      'https://notes.example/mcp',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add header' }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Header 1' }), 'X-Api-Key');
    await userEvent.type(within(dialog).getByLabelText('Value 1'), 'k-123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add server' }));
    await waitFor(() =>
      expect(hub.api.createMcpServer).toHaveBeenCalledWith({
        name: 'notes',
        transport: 'http',
        url: 'https://notes.example/mcp',
        env: { X_Api_Key: 'k-123' },
      }),
    );
    const row = await screen.findByRole('listitem', { name: 'notes' });
    expect(within(row).getByText(/X-Api-Key/)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('k-123');
  });

  it('shows field errors and a Hub failure inside the form', async () => {
    const hub = setup({ mcpServers: [] });
    hub.state.failNext.createMcpServer = fail('A server named github exists', 409, 'conflict');
    await renderApp({ hub, path: '/settings/tools' });
    await userEvent.click(await screen.findByRole('button', { name: 'Add server' }));
    const dialog = screen.getByRole('dialog', { name: 'Add an MCP server' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(within(dialog).getByText(/Use 1 to 40 lowercase/)).toBeTruthy();
    expect(within(dialog).getByText('Enter the command that starts the server.')).toBeTruthy();
    expect(hub.api.createMcpServer).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'github');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Command' }), 'npx');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add server' }));
    expect(await within(dialog).findByText('A server named github exists')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Add an MCP server' })).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('replaces one secret and removes another when editing', async () => {
    const hub = setup();
    hub.state.m3.mcpServers[0] = mcpServer({
      id: 's1',
      name: 'files',
      envKeys: ['API_KEY', 'OLD'],
    });
    await renderApp({ hub, path: '/settings/tools' });
    const row = await screen.findByRole('listitem', { name: 'files' });
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit files' });
    // Saving with no change sends nothing.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(hub.api.updateMcpServer).not.toHaveBeenCalled();

    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const again = screen.getByRole('dialog', { name: 'Edit files' });
    await userEvent.type(within(again).getByLabelText('Value 1'), 'rotated');
    await userEvent.click(within(again).getByRole('button', { name: 'Remove OLD' }));
    await userEvent.click(within(again).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(hub.api.updateMcpServer).toHaveBeenCalledWith('s1', { env: { API_KEY: 'rotated' } }),
    );
    // One toast from the unchanged save, one from this one.
    await waitFor(() => expect(screen.getAllByText('files saved.')).toHaveLength(2));
    expect(hub.state.m3.mcpServers[0]?.envKeys).toEqual(['API_KEY']);
    expect(document.body.innerHTML).not.toContain('rotated');
  });

  it('turns a server off and on, restarts it, and reports failures', async () => {
    const hub = setup();
    await renderApp({ hub, path: '/settings/tools' });
    const row = await screen.findByRole('listitem', { name: 'files' });
    const toggle = within(row).getByRole('switch', { name: 'Enable files' });
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(hub.api.updateMcpServer).toHaveBeenCalledWith('s1', { enabled: false }),
    );
    expect(await screen.findByText('files turned off.')).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(within(row).getByText('Off')).toBeTruthy();
    expect(within(row).getByRole<HTMLButtonElement>('button', { name: 'Restart' }).disabled).toBe(
      true,
    );

    hub.state.failNext.updateMcpServer = fail('Hub busy');
    await userEvent.click(toggle);
    expect(await screen.findByText('Could not change files: Hub busy')).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'));

    await userEvent.click(within(row).getByRole('button', { name: 'Restart' }));
    expect(await screen.findByText('Restarting files.')).toBeTruthy();
    expect(hub.api.restartMcpServer).toHaveBeenCalledWith('s1');
    hub.state.failNext.restartMcpServer = fail('No such process');
    await userEvent.click(within(row).getByRole('button', { name: 'Restart' }));
    expect(await screen.findByText('Could not restart files: No such process')).toBeTruthy();
  });

  it('shows a server log and its tools, and turns one tool off', async () => {
    const hub = setup();
    hub.state.m3.mcpLogs.set('s1', [
      { ts: '2026-10-01T12:00:00Z', stream: 'stderr', text: 'server ready' },
    ]);
    hub.state.m3.mcpTools.set('s1', [
      toolDescriptor({
        name: 'mcp:s1.read.file',
        description: 'Reads a file',
        annotations: { readOnly: true },
      }),
      toolDescriptor({ name: 'mcp:s1.delete', annotations: { destructive: true } }),
    ]);
    hub.state.failNext.mcpServerLogs = fail('Log ring unavailable');
    await renderApp({ hub, path: '/settings/tools' });
    const row = await screen.findByRole('listitem', { name: 'files' });
    const logsButton = within(row).getByRole('button', { name: 'Logs' });
    await userEvent.click(logsButton);
    expect(logsButton.getAttribute('aria-expanded')).toBe('true');
    const logs = within(row).getByRole('region', { name: 'Logs for files' });
    expect(await within(logs).findByText('Log ring unavailable')).toBeTruthy();
    await userEvent.click(within(logs).getByRole('button', { name: 'Refresh' }));
    expect(await within(logs).findByText(/server ready/)).toBeTruthy();

    await userEvent.click(within(row).getByRole('button', { name: 'Tools' }));
    const tools = within(row).getByRole('region', { name: 'Tools from files' });
    const read = await within(tools).findByRole('listitem', { name: 'mcp:s1.read.file' });
    expect(within(read).getByText('Read-only')).toBeTruthy();
    expect(
      within(within(tools).getByRole('listitem', { name: 'mcp:s1.delete' })).getByText(
        'Can delete or overwrite',
      ),
    ).toBeTruthy();
    await userEvent.click(within(read).getByRole('switch', { name: 'Use mcp:s1.read.file' }));
    await waitFor(() =>
      expect(hub.api.updateMcpServer).toHaveBeenCalledWith('s1', { disabledTools: ['read.file'] }),
    );
    await waitFor(() =>
      expect(
        within(read)
          .getByRole('switch', { name: 'Use mcp:s1.read.file' })
          .getAttribute('aria-checked'),
      ).toBe('false'),
    );
    hub.state.failNext.updateMcpServer = fail('nope');
    await userEvent.click(within(read).getByRole('switch', { name: 'Use mcp:s1.read.file' }));
    expect(await screen.findByText('Could not change read.file: nope')).toBeTruthy();
  });

  it('lets the owner mark a tool as reading only, with what that means (FR-082)', async () => {
    // The list may hold a tool by its canonical name too.
    const hub = setup({
      mcpServers: [mcpServer({ id: 's1', name: 'files', readOnlyTools: ['mcp:s1.add_event'] })],
    });
    hub.state.m3.mcpTools.set('s1', [
      toolDescriptor({ name: 'mcp:s1.list_events', description: 'Lists events' }),
      toolDescriptor({ name: 'mcp:s1.add_event', description: 'Adds an event' }),
    ]);
    await renderApp({ hub, path: '/settings/tools' });
    const row = await screen.findByRole('listitem', { name: 'files' });
    await userEvent.click(within(row).getByRole('button', { name: 'Tools' }));
    const tools = within(row).getByRole('region', { name: 'Tools from files' });
    const list = await within(tools).findByRole('listitem', { name: 'mcp:s1.list_events' });
    const box = within(list).getByRole('checkbox', { name: 'Reads only' });
    expect((box as HTMLInputElement).checked).toBe(false);
    // The help says what it does, and the box is described by it.
    const help = within(tools).getByText(
      "Nova treats this tool as reading only: agents' research may use it, and it is allowed without asking. Only mark tools that never change anything.",
    );
    expect(box.getAttribute('aria-describedby')).toBe(help.id);

    await userEvent.click(box);
    await waitFor(() =>
      expect(hub.api.updateMcpServer).toHaveBeenCalledWith('s1', {
        readOnlyTools: ['mcp:s1.add_event', 'list_events'],
      }),
    );
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
    expect(hub.state.m3.mcpServers[0]!.readOnlyTools).toEqual(['mcp:s1.add_event', 'list_events']);

    // Unmarking removes it, whichever name the list holds it by.
    const add = within(tools).getByRole('listitem', { name: 'mcp:s1.add_event' });
    const addBox = within(add).getByRole('checkbox', { name: 'Reads only' });
    expect((addBox as HTMLInputElement).checked).toBe(true);
    await userEvent.click(addBox);
    await waitFor(() =>
      expect(hub.api.updateMcpServer).toHaveBeenLastCalledWith('s1', {
        readOnlyTools: ['list_events'],
      }),
    );
    await waitFor(() => expect((addBox as HTMLInputElement).checked).toBe(false));
    // A failure says so and leaves the box as it was.
    hub.state.failNext.updateMcpServer = fail('Hub busy');
    await userEvent.click(box);
    expect(await screen.findByText('Could not change list_events: Hub busy')).toBeTruthy();
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it("does not offer the choice for a plugin's server: it changes only through its plugin", async () => {
    const hub = setup({
      mcpServers: [mcpServer({ id: 's1', name: 'files', pluginId: 'com.example.cal' })],
    });
    hub.state.m3.mcpTools.set('s1', [toolDescriptor({ name: 'mcp:s1.list_events' })]);
    await renderApp({ hub, path: '/settings/tools' });
    const row = await screen.findByRole('listitem', { name: 'files' });
    await userEvent.click(within(row).getByRole('button', { name: 'Tools' }));
    const list = await within(row).findByRole('listitem', { name: 'mcp:s1.list_events' });
    expect(
      within(list).getByRole<HTMLInputElement>('checkbox', { name: 'Reads only' }).disabled,
    ).toBe(true);
  });

  it('removes a server after confirming, and keeps it when removal fails', async () => {
    const hub = setup();
    await renderApp({ hub, path: '/settings/tools' });
    const row = await screen.findByRole('listitem', { name: 'files' });
    hub.state.failNext.deleteMcpServer = fail('Still stopping');
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    let dialog = screen.getByRole('dialog', { name: 'Remove files?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Could not remove files: Still stopping')).toBeTruthy();
    expect(screen.getByRole('listitem', { name: 'files' })).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }));
    dialog = screen.getByRole('dialog', { name: 'Remove files?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('files removed.')).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'files' })).toBeNull();
    expect(hub.state.m3.mcpServers.map((s) => s.name)).toEqual(['tracker']);
  });

  it('refreshes server status every 5 s and retries a failed load', async () => {
    const polls = captureIntervals(MCP_POLL_MS);
    const hub = setup();
    hub.state.failNext.listMcpServers = fail('Hub restarting');
    await renderApp({ hub, path: '/settings/tools' });
    expect(await screen.findByText('Hub restarting')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const row = await screen.findByRole('listitem', { name: 'files' });
    hub.state.m3.mcpServers = hub.state.m3.mcpServers.map((s) =>
      s.id === 's1' ? { ...s, status: 'error', lastError: 'crashed' } : s,
    );
    polls.fire();
    expect(await within(row).findByText('Last error: crashed')).toBeTruthy();
  });
});

describe('Settings → Tools & MCP: tools and web search (FR-048, FR-029)', () => {
  const tools = () =>
    m3State({
      mcpServers: [mcpServer({ id: 's1', name: 'files' })],
      tools: [
        toolView({
          name: 'fs.read',
          title: 'Read files',
          description: 'Reads a file in a granted folder.',
          effective: { effect: 'allow', reason: 'Read-only tools run.', tier: 'pre_approvable' },
        }),
        toolView({ name: 'fs.write', title: 'Write files' }),
        toolView({
          name: 'mcp:s1.search',
          source: 'mcp',
          serverId: 's1',
          effective: {
            effect: 'handoff',
            reason: 'Built-in safety: you do this step.',
            tier: 'handoff_required',
          },
        }),
      ],
    });

  it('shows tools by source with the effective decision, and sets a default', async () => {
    const hub = createHub({ m3: tools() });
    await renderApp({ hub, path: '/settings/tools' });
    expect(await screen.findByRole('heading', { name: 'Built-in' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'MCP: files' })).toBeTruthy();
    const read = screen.getByRole('listitem', { name: 'fs.read' });
    expect(within(read).getByText('Allowed')).toBeTruthy();
    expect(within(read).getByText('Read-only tools run.')).toBeTruthy();
    const search = screen.getByRole('listitem', { name: 'mcp:s1.search' });
    expect(within(search).getByText('Hand off to you')).toBeTruthy();
    expect(within(search).getByText('You need to do this step')).toBeTruthy();

    const write = screen.getByRole('listitem', { name: 'fs.write' });
    const select = within(write).getByRole<HTMLSelectElement>('combobox', {
      name: 'Default for fs.write',
    });
    expect(select.value).toBe('');
    await userEvent.selectOptions(select, 'deny');
    await waitFor(() => expect(hub.api.setToolDefault).toHaveBeenCalledWith('fs.write', 'deny'));
    expect(await within(write).findByText('Your default for fs.write: deny.')).toBeTruthy();
    expect(within(write).getByText('Denied')).toBeTruthy();
    await userEvent.selectOptions(select, '');
    await waitFor(() => expect(hub.api.setToolDefault).toHaveBeenLastCalledWith('fs.write', null));
    expect(await within(write).findByText('Asks first')).toBeTruthy();
  });

  it('reverts a default the Hub rejects, filters tools, and retries a failed list', async () => {
    const hub = createHub({ m3: tools() });
    hub.state.failNext.listTools = fail('Registry offline');
    await renderApp({ hub, path: '/settings/tools' });
    const alert = await screen.findByText('Registry offline');
    await userEvent.click(
      within(alert.closest('[role="alert"]')!).getByRole('button', { name: 'Retry' }),
    );
    const write = await screen.findByRole('listitem', { name: 'fs.write' });
    hub.state.failNext.setToolDefault = fail('Managed policy forbids it', 403, 'policy_denied');
    const select = within(write).getByRole<HTMLSelectElement>('combobox', {
      name: 'Default for fs.write',
    });
    await userEvent.selectOptions(select, 'allow');
    expect(
      await screen.findByText(
        'Could not change the default for fs.write: Managed policy forbids it',
      ),
    ).toBeTruthy();
    expect(select.value).toBe('');

    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter tools' }), 'granted');
    expect(screen.getByRole('listitem', { name: 'fs.read' })).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'fs.write' })).toBeNull();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter tools' }), 'zzz');
    expect(screen.getByText(/No tools match/)).toBeTruthy();
  });

  it('saves, validates and clears the SearXNG address', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/tools' });
    const field = await screen.findByRole('textbox', { name: 'SearXNG address' });
    expect(screen.getByText('Web search is off.')).toBeTruthy();
    await userEvent.type(field, 'not a url');
    await userEvent.tab();
    expect(screen.getByText('Enter an http:// or https:// address.')).toBeTruthy();
    expect(hub.api.setSetting).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, 'http://localhost:8888{Enter}');
    await waitFor(() =>
      expect(hub.state.settings['search.searxngUrl']).toBe('http://localhost:8888'),
    );
    expect(await screen.findByText('Web search address saved.')).toBeTruthy();
    expect(screen.getByText('Web search is on.')).toBeTruthy();
    await userEvent.clear(field);
    await userEvent.tab();
    await waitFor(() => expect(hub.state.settings['search.searxngUrl']).toBeNull());
    expect(await screen.findByText('Web search turned off.')).toBeTruthy();
  });

  it('locks the SearXNG address when managed', async () => {
    const hub = createHub({ managed: { 'search.searxngUrl': 'https://search.corp.example' } });
    await renderApp({ hub, path: '/settings/tools' });
    const field = await screen.findByRole<HTMLInputElement>('textbox', { name: 'SearXNG address' });
    expect(field.disabled).toBe(true);
    expect(field.value).toBe('https://search.corp.example');
    expect(screen.getByText(/Managed by your organization/)).toBeTruthy();
  });
});
