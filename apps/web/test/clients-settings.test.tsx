import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { configValues, initialConfig } from '../src/settings/BundleInstall.tsx';
import { clientSnippet, scopesText } from '../src/settings/ClientsPage.tsx';
import { oauthRedirect, safeAuthorizeUrl } from '../src/settings/McpAuth.tsx';
import { createHub } from './fakes.ts';
import { m3State } from './fakes-m3.ts';
import { m4State } from './fakes-m4.ts';
import { appAuth, bundlePreview } from './fakes-m4-settings.ts';
import { mcpServer, toolView } from './fakes-settings.ts';
import { project, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const fail = (message: string, status = 500, code = 'x') =>
  new ApiError(status, { code, message, retryable: false });

describe('client and bundle helpers (FR-044, FR-199, FR-047)', () => {
  it('summarizes scopes and writes a client snippet', () => {
    expect(scopesText({ tools: '*', projects: '*', threads: 'read', mode: 'read_only' })).toBe(
      'all allowed tools · all projects · reads chats · read-only',
    );
    expect(
      scopesText({
        tools: ['fs.read'],
        projects: ['p1', 'p2'],
        threads: 'none',
        mode: 'run_allowed',
      }),
    ).toBe('1 tool · 2 projects · no chats · may run tools');
    expect(JSON.parse(clientSnippet('http://hub/mcp', 'nva_x'))).toEqual({
      mcpServers: {
        nova: { type: 'http', url: 'http://hub/mcp', headers: { Authorization: 'Bearer nva_x' } },
      },
    });
  });

  it('starts bundle config from defaults, never for sensitive fields, and types the values', () => {
    const fields = [
      ...bundlePreview().userConfig,
      {
        key: 'dirs',
        type: 'directory' as const,
        title: 'Folders',
        description: null,
        required: false,
        sensitive: false,
        multiple: true,
        default: ['/a', '/b'],
      },
      {
        key: 'verbose',
        type: 'boolean' as const,
        title: 'Verbose',
        description: null,
        required: false,
        sensitive: false,
        multiple: false,
        default: true,
      },
      {
        key: 'pin',
        type: 'string' as const,
        title: 'PIN',
        description: null,
        required: false,
        sensitive: true,
        multiple: false,
        default: '1234',
      },
    ];
    const draft = initialConfig(fields);
    expect(draft).toEqual({
      api_key: '',
      units: 'metric',
      days: '3',
      dirs: '/a\n/b',
      verbose: true,
      pin: '',
    });
    expect(configValues(fields, draft)).toEqual({ errors: { api_key: 'Enter api key.' } });
    expect(configValues(fields, { ...draft, api_key: ' k ', days: 'x' })).toEqual({
      errors: { days: 'Days must be a number.' },
    });
    expect(configValues(fields, { ...draft, api_key: 'k', days: '5', dirs: '/a\n\n /c ' })).toEqual(
      {
        values: { api_key: 'k', units: 'metric', days: 5, dirs: ['/a', '/c'], verbose: true },
      },
    );
  });

  it('opens only https sign-in pages (or http on this machine)', () => {
    expect(safeAuthorizeUrl('https://auth.example.com/a?x=1')).toBe(
      'https://auth.example.com/a?x=1',
    );
    expect(safeAuthorizeUrl('http://localhost:9000/auth')).toBe('http://localhost:9000/auth');
    expect(safeAuthorizeUrl('http://evil.example/auth')).toBeNull();
    expect(safeAuthorizeUrl('javascript:alert(1)')).toBeNull();
    expect(safeAuthorizeUrl('not a url')).toBeNull();
  });
});

describe('Settings → Apps & clients (FR-044)', () => {
  const setup = () =>
    createHub({
      m3: m3State({ tools: [toolView({ name: 'fs.read' }), toolView({ name: 'web.search' })] }),
      workspace: workspaceState({ projects: [project({ id: 'p1', name: 'Garden plan' })] }),
    });

  it('adds a scoped client, shows its token once with a snippet, and turns the server on', async () => {
    const hub = setup();
    await renderApp({ hub, path: '/settings/clients' });
    expect(await screen.findByText('No clients yet')).toBeTruthy();
    const server = screen.getByRole('switch', { name: "Nova's MCP server" });
    expect(server.getAttribute('aria-checked')).toBe('false');

    await userEvent.click(screen.getByRole('button', { name: 'Add a client' }));
    let dialog = screen.getByRole('dialog', { name: 'Add an MCP client' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }));
    expect(within(dialog).getByText('Enter a name for the client.')).toBeTruthy();
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Client name' }), 'Editor');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Only the tools I choose' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }));
    expect(within(dialog).getByText('Choose at least one tool.')).toBeTruthy();
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: 'fs.read' }));
    await userEvent.click(
      within(dialog).getByRole('radio', { name: 'Only the projects I choose' }),
    );
    await userEvent.click(await within(dialog).findByRole('checkbox', { name: 'Garden plan' }));
    await userEvent.click(within(dialog).getByRole('radio', { name: 'No access to chats' }));
    await userEvent.click(within(dialog).getByRole('radio', { name: 'May run tools' }));
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Token expires' }),
      '30',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }));
    await waitFor(() =>
      expect(hub.api.createAppAuthorization).toHaveBeenCalledWith({
        kind: 'mcp_client',
        clientName: 'Editor',
        scopes: { tools: ['fs.read'], projects: ['p1'], threads: 'none', mode: 'run_allowed' },
        expiresInDays: 30,
      }),
    );
    dialog = await screen.findByRole('dialog', { name: 'Editor added' });
    expect(within(dialog).getByText('nva_fake-client-token')).toBeTruthy();
    expect(within(dialog).getByText('http://127.0.0.1:7419/mcp')).toBeTruthy();
    expect(
      within(dialog).getByText(/"Authorization": "Bearer nva_fake-client-token"/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('button', { name: 'Copy token' }),
      ),
    );

    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy token' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('nva_fake-client-token'));
    expect(await screen.findByText('Token copied.')).toBeTruthy();
    writeText.mockImplementationOnce(() => Promise.reject(new Error('denied')));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy configuration' }));
    expect(await screen.findByText(/Could not copy\. The configuration is selected/)).toBeTruthy();

    // The Hub turns its server on with the first client; the switch follows.
    await waitFor(() => expect(hub.state.settings['mcpServer.enabled']).toBe(true));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Shown once: after closing, the token is nowhere in the page.
    expect(document.body.innerHTML).not.toContain('nva_fake-client-token');
    const row = screen.getByRole('listitem', { name: 'Editor' });
    expect(within(row).getByText('1 tool · 1 project · no chats · may run tools')).toBeTruthy();
    expect(within(row).getByText(/last used never · never expires/)).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: "Nova's MCP server" }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('reports a failed add in the form, revokes after confirmation, and turns the server off', async () => {
    const hub = setup();
    hub.state.settings['mcpServer.enabled'] = true;
    hub.state.m4.apps = [
      appAuth({
        id: 'a1',
        clientName: 'Laptop editor',
        lastUsedAt: '2026-10-01T12:00:00.000Z',
        expiresAt: '2027-06-15T12:00:00.000Z',
      }),
    ];
    hub.state.failNext.createAppAuthorization = fail('Too many clients', 409, 'conflict');
    await renderApp({ hub, path: '/settings/clients' });
    const row = await screen.findByRole('listitem', { name: 'Laptop editor' });
    expect(
      within(row).getByText('all allowed tools · all projects · reads chats · read-only'),
    ).toBeTruthy();
    expect(within(row).getByText(/expires Jun 15, 2027/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Add a client' }));
    const dialog = screen.getByRole('dialog', { name: 'Add an MCP client' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Client name' }), 'Second');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add client' }));
    expect(await within(dialog).findByText('Too many clients')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(within(row).getByRole('button', { name: 'Revoke Laptop editor' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Revoke Laptop editor?' })).getByRole('button', {
        name: 'Revoke',
      }),
    );
    expect(
      await screen.findByText('Laptop editor revoked. Its sessions were closed.'),
    ).toBeTruthy();
    expect(hub.state.m4.apps).toEqual([]);

    await userEvent.click(screen.getByRole('switch', { name: "Nova's MCP server" }));
    expect(
      await screen.findByText("Nova's MCP server is off. Clients cannot connect."),
    ).toBeTruthy();
    expect(hub.state.settings['mcpServer.enabled']).toBe(false);
  });

  it('locks the server switch under managed policy and reports a failed revoke', async () => {
    const hub = setup();
    hub.state.managed['mcpServer.enabled'] = false;
    hub.state.m4.apps = [
      appAuth({ id: 'a1', clientName: 'Old', expiresAt: '2026-01-01T00:00:00.000Z' }),
    ];
    hub.state.failNext.revokeAppAuthorization = fail('Hub busy');
    await renderApp({ hub, path: '/settings/clients' });
    const row = await screen.findByRole('listitem', { name: 'Old' });
    expect(within(row).getByText(/expired/)).toBeTruthy();
    const sw = screen.getByRole<HTMLButtonElement>('switch', { name: "Nova's MCP server" });
    expect(sw.disabled).toBe(true);
    expect(screen.getByText('Managed by your organization')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Revoke Old' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Revoke Old?' })).getByRole('button', {
        name: 'Revoke',
      }),
    );
    expect(await screen.findByText('Could not revoke Old: Hub busy')).toBeTruthy();
    expect(screen.getByRole('listitem', { name: 'Old' })).toBeTruthy();
  });

  it('shows a load failure with retry', async () => {
    const hub = setup();
    hub.state.failNext.listAppAuthorizations = fail('Clients unavailable');
    await renderApp({ hub, path: '/settings/clients' });
    expect(await screen.findByText('Clients unavailable')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No clients yet')).toBeTruthy();
  });
});

describe('Settings → Tools & MCP: bundles (FR-199)', () => {
  const file = (name = 'weather.mcpb') =>
    new File(['PK-zip-bytes'], name, { type: 'application/zip' });

  it('previews a bundle, needs sideload confirmation when unverified, and masks sensitive config', async () => {
    const hub = createHub({
      m3: m3State({ mcpServers: [mcpServer({ id: 's1', name: 'weather', status: 'starting' })] }),
      m4: m4State({ bundlePreview: bundlePreview() }),
    });
    await renderApp({ hub, path: '/settings/tools' });
    await screen.findByRole('listitem', { name: 'weather' });
    await userEvent.upload(screen.getByLabelText('Bundle file'), file());
    await waitFor(() =>
      expect(hub.api.previewBundle).toHaveBeenCalledWith({
        name: 'weather.mcpb',
        data: btoa('PK-zip-bytes'),
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Install Weather 0.3.0?' });
    expect(within(dialog).getByText('Unverified')).toBeTruthy();
    expect(within(dialog).getByText(/Runs with Node.js/)).toBeTruthy();
    expect(within(dialog).getByText('forecast')).toBeTruthy();
    const key = within(dialog).getByLabelText('API key');
    expect(key.getAttribute('type')).toBe('password');
    expect(within(dialog).getByText(/Stored in the vault/)).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLInputElement>('textbox', { name: 'Units (optional)' }).value,
    ).toBe('metric');
    const install = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Install' });
    expect(install.disabled).toBe(true);
    await userEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'I trust where this bundle came from; install it unverified',
      }),
    );
    await userEvent.click(install);
    expect(within(dialog).getByText('Enter api key.')).toBeTruthy();
    expect(hub.api.installBundle).not.toHaveBeenCalled();
    await userEvent.type(key, 'wx-secret');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'api.weather.example' }));
    await userEvent.click(
      within(dialog).getByRole('radio', { name: 'Read the files and folders entered above' }),
    );
    hub.state.failNext.installBundle = fail('The bundle needs Python 3.11', 400, 'validation');
    await userEvent.click(install);
    expect(await within(dialog).findByText('The bundle needs Python 3.11')).toBeTruthy();
    await userEvent.click(install);
    await waitFor(() =>
      expect(hub.api.installBundle).toHaveBeenLastCalledWith({
        previewId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60',
        permissions: { network: [], fs: 'read' },
        userConfig: { api_key: 'wx-secret', units: 'metric', days: 3 },
        confirmSideload: true,
      }),
    );
    expect(
      await screen.findByText('weather installed. It connects in the background.'),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    const row = screen.getByRole('listitem', { name: 'weather' });
    expect(within(row).getByText('Unverified')).toBeTruthy();
    expect(within(row).getByText('bundle weather 0.3.0')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('wx-secret');
  });

  it('installs a verified bundle without a sideload flag; rejects big files and bad bundles', async () => {
    const hub = createHub({
      m3: m3State({ mcpServers: [mcpServer({ id: 's1', name: 'weather' })] }),
      m4: m4State({
        bundlePreview: bundlePreview({
          signature: 'verified',
          userConfig: [],
          permissions: { network: [], fs: 'none' },
        }),
      }),
    });
    await renderApp({ hub, path: '/settings/tools' });
    await screen.findByRole('listitem', { name: 'weather' });
    const big = file('huge.mcpb');
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    await userEvent.upload(screen.getByLabelText('Bundle file'), big);
    expect(
      await screen.findByText(/huge\.mcpb is 51(\.0)? MB; bundles can be at most 50(\.0)? MB\./),
    ).toBeTruthy();
    expect(hub.api.previewBundle).not.toHaveBeenCalled();

    hub.state.failNext.previewBundle = fail(
      'manifest_version 0.1 is not supported',
      400,
      'validation',
    );
    await userEvent.upload(screen.getByLabelText('Bundle file'), file('old.mcpb'));
    expect(
      await screen.findByText('Could not read old.mcpb: manifest_version 0.1 is not supported'),
    ).toBeTruthy();

    await userEvent.upload(screen.getByLabelText('Bundle file'), file());
    const dialog = await screen.findByRole('dialog', { name: 'Install Weather 0.3.0?' });
    expect(within(dialog).getByText('Verified')).toBeTruthy();
    expect(within(dialog).getByText('No network access.')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    await waitFor(() =>
      expect(hub.api.installBundle).toHaveBeenCalledWith({
        previewId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60',
        permissions: { network: [], fs: 'none' },
        userConfig: {},
      }),
    );
  });
});

describe('Settings → Tools & MCP: OAuth for remote servers (FR-047)', () => {
  const remote = (status: 'connected' | 'needs_auth' | 'expired' | 'error') =>
    mcpServer({
      id: 's9',
      name: 'tracker',
      transport: 'http',
      command: null,
      args: [],
      url: 'https://mcp.tracker.example/v1',
      auth: {
        kind: 'oauth',
        status,
        expiresAt: status === 'connected' ? '2026-10-02T12:00:00.000Z' : null,
        scopes: status === 'connected' ? ['read'] : [],
      },
    });

  it('signs in through the authorization page and refuses an unsafe address', async () => {
    const go = vi.spyOn(oauthRedirect, 'go').mockImplementation(() => undefined);
    const hub = createHub({
      m3: m3State({ mcpServers: [remote('needs_auth'), mcpServer({ id: 's1', name: 'files' })] }),
    });
    await renderApp({ hub, path: '/settings/tools' });
    const row = await screen.findByRole('listitem', { name: 'tracker' });
    expect(within(row).getByText('Needs sign-in')).toBeTruthy();
    // stdio servers have no sign-in.
    expect(
      within(screen.getByRole('listitem', { name: 'files' })).queryByText('Needs sign-in'),
    ).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: 'Sign in to tracker' }));
    await waitFor(() =>
      expect(go).toHaveBeenCalledWith('https://auth.example.com/authorize?state=x'),
    );
    expect(hub.api.startMcpOAuth).toHaveBeenCalledWith('s9');

    go.mockClear();
    hub.api.startMcpOAuth.mockImplementationOnce(() =>
      Promise.resolve({ authorizeUrl: 'javascript:alert(1)' }),
    );
    await userEvent.click(within(row).getByRole('button', { name: 'Sign in to tracker' }));
    expect(
      await screen.findByText(/Could not start sign-in for tracker: .*not https/),
    ).toBeTruthy();
    expect(go).not.toHaveBeenCalled();

    hub.state.failNext.startMcpOAuth = fail('The server offers no OAuth metadata');
    await userEvent.click(within(row).getByRole('button', { name: 'Sign in to tracker' }));
    expect(
      await screen.findByText(
        'Could not start sign-in for tracker: The server offers no OAuth metadata',
      ),
    ).toBeTruthy();
  });

  it('shows a signed-in server and signs out', async () => {
    const hub = createHub({ m3: m3State({ mcpServers: [remote('connected')] }) });
    await renderApp({ hub, path: '/settings/tools' });
    const row = await screen.findByRole('listitem', { name: 'tracker' });
    expect(within(row).getByText('Signed in')).toBeTruthy();
    expect(within(row).getByText('scopes: read')).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Reconnect tracker' })).toBeTruthy();
    hub.state.failNext.revokeMcpOAuth = fail('Revocation endpoint unreachable');
    await userEvent.click(within(row).getByRole('button', { name: 'Sign out of tracker' }));
    expect(
      await screen.findByText('Could not sign out of tracker: Revocation endpoint unreachable'),
    ).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Sign out of tracker' }));
    expect(
      await screen.findByText('Signed out of tracker. Its tokens were revoked and deleted.'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('listitem', { name: 'tracker' })).getByText('Needs sign-in'),
    ).toBeTruthy();
  });

  it('reports the result of a sign-in the Hub sent back, then cleans the address', async () => {
    const hub = createHub({ m3: m3State({ mcpServers: [remote('expired')] }) });
    await renderApp({ hub, path: '/settings/tools?oauth=ok' });
    expect(
      await screen.findByText('Signed in. The server reconnects with the new sign-in.'),
    ).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.location.pathname).toBe('/settings/tools');
    expect(
      within(await screen.findByRole('listitem', { name: 'tracker' })).getByText('Sign-in expired'),
    ).toBeTruthy();
    resetDom();
    await renderApp({ hub, path: '/settings/tools?oauth=error' });
    expect(
      await screen.findByText('Sign-in did not finish. Try again from the server below.'),
    ).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});
