// Settings → Authorized apps (FR-222) and Settings → Telemetry export (FR-223): the apps switch and its
// managed state, the authorized apps with Revoke (asks first), apps waiting for approval; the OTLP
// export off by default, its collector address, write-only headers, signals, content (asks first),
// the test and the status, the refusals, and managed policy.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { AppsSettings, redirectLabel } from '../src/appauth/AppsSettings.tsx';
import { APPS_TEXT, OTLP_TEXT, pendingHostLabel } from '../src/appauth/format.ts';
import { OtlpSettings, inactiveWhy } from '../src/appauth/OtlpSettings.tsx';
import { FakeEventSource } from './fakes.ts';
import { appClient, appGrant, m8AppAuthState, renderW11 } from './fakes-m8-appauth.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');

const otlp = (over: Partial<ReturnType<typeof m8AppAuthState>['otlp']> = {}) => ({
  ...m8AppAuthState().otlp,
  ...over,
});

describe('Settings → Authorized apps (FR-222)', () => {
  it('lists the apps you allowed with what they read, where they return and their use', async () => {
    await renderW11(<AppsSettings />, {
      appauth: {
        clients: [appClient({ approved: true })],
        grants: [
          appGrant({
            id: 'auth-1',
            name: 'Notes Desk',
            scopes: ['account:read', 'threads:read'],
            redirectUris: ['http://127.0.0.1/callback', 'com.example.notes:/oauth'],
            sessions: 2,
            lastUsedAt: null,
          }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: APPS_TEXT.listLabel });
    // The page is named as the Settings nav names it (not "Apps & clients", another page).
    expect(screen.getByRole('heading', { level: 2, name: 'Authorized apps' })).toBeTruthy();
    const row = within(list).getByRole('listitem', { name: 'Notes Desk' });
    expect(row.textContent).toContain('May read: See your name and picture · Read your chats');
    expect(within(row).getByText('127.0.0.1 (any port)')).toBeTruthy();
    expect(within(row).getByText('com.example.notes:')).toBeTruthy();
    expect(row.textContent).toContain('Signed in on 2 devices');
    expect(row.textContent).toContain('last used never');
    // An app someone allows is not among the registered ones without access.
    expect(await screen.findByText(APPS_TEXT.pendingNone)).toBeTruthy();
    expect(screen.getByText(APPS_TEXT.pendingHow)).toBeTruthy();
    expect(
      screen.getByText(`${window.location.origin}/.well-known/oauth-authorization-server`),
    ).toBeTruthy();
    const sw = screen.getByRole('switch', { name: APPS_TEXT.switchLabel });
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('revokes an app only after saying what changes', async () => {
    const { api, state } = await renderW11(<AppsSettings />, {
      appauth: { grants: [appGrant({ id: 'auth-1', name: 'Notes Desk', sessions: 1 })] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Notes Desk' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke Notes Desk?' });
    expect(dialog.textContent).toContain(APPS_TEXT.revokeWhat({ name: 'Notes Desk', sessions: 1 }));
    expect(api.revokeApp).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(state.grants).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Notes Desk' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: APPS_TEXT.revoke }),
    );
    await waitFor(() => expect(state.grants).toHaveLength(0));
    expect(api.revokeApp).toHaveBeenCalledWith('auth-1');
    expect(await screen.findByText(APPS_TEXT.revoked({ name: 'Notes Desk' }))).toBeTruthy();
    expect(screen.getByText(APPS_TEXT.emptyTitle)).toBeTruthy();
  });

  it('says why a revoke failed and reloads the list', async () => {
    const { api } = await renderW11(<AppsSettings />, {
      appauth: { grants: [appGrant({ id: 'auth-1', name: 'Notes Desk' })] },
      fail: {
        revokeApp: new ApiError(404, {
          code: 'not_found',
          message: 'app not found',
          retryable: false,
        }),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Notes Desk' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: APPS_TEXT.revoke }),
    );
    expect(
      await screen.findByText(
        APPS_TEXT.revokeFailed({
          name: 'Notes Desk',
          why: 'It is no longer there. Refresh the page.',
        }),
      ),
    ).toBeTruthy();
    await waitFor(() => expect(api.listApps).toHaveBeenCalledTimes(2));
  });

  it('turns app access off and on, and follows authorization changes live', async () => {
    const { hub, state, api } = await renderW11(<AppsSettings />);
    expect(await screen.findByText(APPS_TEXT.emptyTitle)).toBeTruthy();
    expect(screen.getByText(APPS_TEXT.pendingNone)).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: APPS_TEXT.switchLabel }));
    await waitFor(() => expect(hub.state.settings['apps.enabled']).toBe(false));
    expect(await screen.findByText(APPS_TEXT.switchedOff)).toBeTruthy();
    expect(screen.getByText(APPS_TEXT.switchOff)).toBeTruthy();
    state.grants.push(appGrant({ name: 'Calendar Bridge' }));
    stream().emit('app.authorization.changed', { kind: 'app', status: 'active' });
    expect(await screen.findByRole('listitem', { name: 'Calendar Bridge' })).toBeTruthy();
    expect(api.listApps).toHaveBeenCalledTimes(2);
  });

  it('shows a managed lock: the switch is off and disabled, and says why', async () => {
    await renderW11(<AppsSettings />, {
      managed: {
        'managed.restrict': { layers: [{ apps: false }], failClosed: null },
        'apps.enabled': false,
      },
    });
    const sw = await screen.findByRole('switch', { name: APPS_TEXT.switchLabel });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText(APPS_TEXT.managedOff)).toBeTruthy();
    expect(screen.getAllByText(/Managed by your organization/).length).toBeGreaterThan(0);
  });

  it('names where the policy that turned apps off comes from (the shared managed view)', async () => {
    const remote = {
      channel: 'remote' as const,
      location: 'https://policy.example.com/nova.json',
      status: 'active' as const,
      problem: null,
      inForce: true,
      cached: false,
      serial: 4,
      loadedAt: '2026-10-19T08:00:00.000Z',
      checkedAt: '2026-10-19T09:00:00.000Z',
    };
    const { hub } = await renderW11(<AppsSettings />, {
      managed: { 'managed.restrict': { layers: [{ apps: false }], failClosed: null } },
      policy: {
        active: true,
        failClosed: null,
        sources: [remote],
        settings: [],
        restrict: [{ channel: 'remote', restrict: { apps: false } }],
        egress: null,
        ignored: [],
        checkedAt: '2026-10-19T09:00:00.000Z',
      },
    });
    const notes = await screen.findAllByText('(remote policy)');
    // The callout and the switch's lock both name it; the policy is read once.
    expect(notes.length).toBe(2);
    expect(vi.mocked(hub.api.getManagedPolicy)).toHaveBeenCalledTimes(1);
  });

  it('says when the list cannot be read, with Retry', async () => {
    const { api } = await renderW11(<AppsSettings />, {
      fail: {
        listApps: new ApiError(500, { code: 'server_error', message: 'boom', retryable: true }),
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('boom');
    await userEvent.click(screen.getByRole('button', { name: APPS_TEXT.retry }));
    expect(await screen.findByText(APPS_TEXT.emptyTitle)).toBeTruthy();
    expect(api.listApps).toHaveBeenCalledTimes(2);
  });

  it('lists registered apps nobody allows by name, and removes one only after asking', async () => {
    const recent = new Date(Date.now() - 10 * 60_000).toISOString();
    const { api, state } = await renderW11(<AppsSettings />, {
      appauth: {
        clients: [
          appClient({
            id: 'app_cal',
            name: 'Calendar Bridge',
            registeredAt: recent,
            redirectUris: ['http://127.0.0.1:9000/cb', 'http://127.0.0.1:9001/cb'],
            scopes: ['account:read', 'threads:read'],
          }),
          appClient({
            id: 'app_old',
            name: 'Old Notes',
            approved: true,
            redirectUris: ['com.example.notes:/oauth'],
            scopes: ['memory:read'],
          }),
          // Unapproved and older than an hour: the Hub no longer lists it.
          appClient({ id: 'app_gone', name: 'Gone App' }),
        ],
      },
    });
    const list = await screen.findByRole('list', { name: APPS_TEXT.pendingLabel });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['Calendar Bridge', 'Old Notes']);
    const cal = within(list).getByRole('listitem', { name: 'Calendar Bridge' });
    expect(cal.textContent).toContain('Asks to read: See your name and picture · Read your chats');
    expect(within(cal).getAllByText('127.0.0.1 (any port)')).toHaveLength(1);
    expect(cal.textContent).toContain('Waiting for its first approval. It is removed at');
    expect(cal.textContent).toContain('Registered 10 min ago.');
    const old = within(list).getByRole('listitem', { name: 'Old Notes' });
    expect(within(old).getByText('com.example.notes:')).toBeTruthy();
    expect(old.textContent).toContain(APPS_TEXT.notAllowedNow);
    expect(screen.queryByText('Gone App')).toBeNull();

    await userEvent.click(within(old).getByRole('button', { name: 'Remove Old Notes' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Old Notes?' });
    expect(dialog.textContent).toContain(APPS_TEXT.removeWhat({ name: 'Old Notes' }));
    await userEvent.click(within(dialog).getByRole('button', { name: APPS_TEXT.cancel }));
    expect(api.removePendingApp).not.toHaveBeenCalled();
    await userEvent.click(within(old).getByRole('button', { name: 'Remove Old Notes' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: APPS_TEXT.remove }),
    );
    expect(await screen.findByText(APPS_TEXT.removed({ name: 'Old Notes' }))).toBeTruthy();
    expect(api.removePendingApp).toHaveBeenCalledWith('app_old');
    expect(state.clients.map((c) => c.id)).not.toContain('app_old');
    expect(screen.queryByRole('listitem', { name: 'Old Notes' })).toBeNull();
  });

  it('says why a removal was refused, and a revoked app moves to the registered list', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const { api, state } = await renderW11(<AppsSettings />, {
      appauth: {
        clients: [
          appClient({ id: 'app_cal', name: 'Calendar Bridge', registeredAt: recent }),
          appClient({ id: 'app_notes', name: 'Notes Desk', approved: true }),
        ],
        grants: [appGrant({ id: 'auth-1', clientId: 'app_notes', name: 'Notes Desk' })],
      },
    });
    const pending = await screen.findByRole('list', { name: APPS_TEXT.pendingLabel });
    // Someone allowed it in another tab meanwhile: the Hub refuses, the list is read again.
    state.grants.push(appGrant({ id: 'auth-2', clientId: 'app_cal', name: 'Calendar Bridge' }));
    await userEvent.click(within(pending).getByRole('button', { name: 'Remove Calendar Bridge' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: APPS_TEXT.remove }),
    );
    expect(
      await screen.findByText(
        APPS_TEXT.removeFailed({
          name: 'Calendar Bridge',
          why: 'This app is allowed now. Revoke it under “Apps you allowed” first.',
        }),
      ),
    ).toBeTruthy();
    await waitFor(() => expect(api.listPendingApps).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(APPS_TEXT.pendingNone)).toBeTruthy();

    // Revoking keeps the app registered: it shows under the registered apps.
    state.grants = state.grants.filter((g) => g.id !== 'auth-2');
    await userEvent.click(screen.getByRole('button', { name: 'Revoke Notes Desk' }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: APPS_TEXT.revoke }),
    );
    const again = await screen.findByRole('list', { name: APPS_TEXT.pendingLabel });
    expect(await within(again).findByRole('listitem', { name: 'Notes Desk' })).toBeTruthy();
  });

  it('says when the registered apps cannot be read, with Retry', async () => {
    const { api } = await renderW11(<AppsSettings />, {
      fail: {
        listPendingApps: new ApiError(403, {
          code: 'policy_denied',
          message: 'owner only',
          retryable: false,
          details: { reason: 'owner_only' },
        }),
      },
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Only the owner');
    await userEvent.click(within(alert).getByRole('button', { name: APPS_TEXT.retry }));
    expect(await screen.findByText(APPS_TEXT.pendingNone)).toBeTruthy();
    expect(api.listPendingApps).toHaveBeenCalledTimes(2);
  });

  it('labels registered return addresses plainly', () => {
    expect(pendingHostLabel('127.0.0.1')).toBe('127.0.0.1 (any port)');
    expect(pendingHostLabel('[::1]:9000')).toBe('[::1] (any port)');
    expect(pendingHostLabel('com.example.app')).toBe('com.example.app:');
  });

  it('labels redirect URIs plainly', () => {
    expect(redirectLabel('http://127.0.0.1:5000/cb')).toBe('127.0.0.1 (any port)');
    expect(redirectLabel('com.example.app:/cb')).toBe('com.example.app:');
    expect(redirectLabel('nonsense')).toBe('nonsense');
  });
});

describe('Settings → Telemetry export (FR-223)', () => {
  it('is off by default and needs a collector address before it can be turned on', async () => {
    await renderW11(<OtlpSettings />);
    const sw = await screen.findByRole('switch', { name: OTLP_TEXT.switchLabel });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(OTLP_TEXT.needsEndpoint)).toBeTruthy();
    expect(screen.getByText(OTLP_TEXT.inactive)).toBeTruthy();
    expect(screen.getByText(OTLP_TEXT.inactiveWhy.off)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: OTLP_TEXT.test }).disabled).toBe(
      true,
    );
    expect(screen.getByText(OTLP_TEXT.headersNone)).toBeTruthy();
  });

  it('checks the address like the Hub, saves it, turns the export on and shows it running', async () => {
    const { api, state } = await renderW11(<OtlpSettings />);
    const field = await screen.findByLabelText(OTLP_TEXT.endpointLabel);
    await userEvent.type(field, 'http://collector.example.com:4318');
    await userEvent.click(screen.getByRole('button', { name: OTLP_TEXT.save }));
    expect(await screen.findByText(OTLP_TEXT.endpointInvalid)).toBeTruthy();
    expect(api.updateOtlp).not.toHaveBeenCalled();
    await userEvent.clear(field);
    await userEvent.type(field, 'https://collector.example.com:4318/');
    await userEvent.click(screen.getByRole('button', { name: OTLP_TEXT.save }));
    await waitFor(() => expect(state.otlp.endpoint).toBe('https://collector.example.com:4318'));
    expect(api.updateOtlp).toHaveBeenCalledWith({ endpoint: 'https://collector.example.com:4318' });
    expect(await screen.findByText(OTLP_TEXT.endpointSaved)).toBeTruthy();
    const sw = screen.getByRole('switch', { name: OTLP_TEXT.switchLabel });
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(sw);
    await waitFor(() => expect(state.otlp.enabled).toBe(true));
    expect(await screen.findByText(OTLP_TEXT.active)).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: OTLP_TEXT.switchLabel }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('keeps header values write-only: add, replace and remove (asks first)', async () => {
    const { api, state } = await renderW11(<OtlpSettings />, {
      appauth: { otlp: otlp({ endpoint: 'https://c.example', headers: { 'x-api-key': 'k1' } }) },
    });
    const list = await screen.findByRole('list', { name: OTLP_TEXT.headersLabel });
    const row = within(list).getByRole('listitem', { name: 'x-api-key' });
    expect(row.textContent).toContain(OTLP_TEXT.set);
    expect(row.textContent).not.toContain('k1');
    await userEvent.click(screen.getByRole('button', { name: OTLP_TEXT.addHeader }));
    const add = screen.getByRole('form', { name: OTLP_TEXT.addHeader });
    await userEvent.type(within(add).getByLabelText(OTLP_TEXT.headerName), 'bad name');
    await userEvent.click(within(add).getByRole('button', { name: OTLP_TEXT.save }));
    expect(await screen.findByText(OTLP_TEXT.headerNameInvalid)).toBeTruthy();
    expect(screen.getByText(OTLP_TEXT.headerValueMissing)).toBeTruthy();
    await userEvent.clear(within(add).getByLabelText(OTLP_TEXT.headerName));
    await userEvent.type(within(add).getByLabelText(OTLP_TEXT.headerName), 'Authorization');
    await userEvent.type(within(add).getByLabelText(OTLP_TEXT.headerValue), 'Bearer s3cret');
    await userEvent.click(within(add).getByRole('button', { name: OTLP_TEXT.save }));
    await waitFor(() => expect(state.otlp.headers.Authorization).toBe('Bearer s3cret'));
    expect(api.updateOtlp).toHaveBeenCalledWith({ headers: { Authorization: 'Bearer s3cret' } });
    expect(await screen.findByRole('listitem', { name: 'Authorization' })).toBeTruthy();
    expect(document.body.textContent).not.toContain('s3cret');

    await userEvent.click(
      screen.getByRole('button', { name: OTLP_TEXT.replaceLabel({ name: 'x-api-key' }) }),
    );
    const replace = screen.getByRole('form', {
      name: OTLP_TEXT.replaceLabel({ name: 'x-api-key' }),
    });
    await userEvent.type(
      within(replace).getByLabelText(OTLP_TEXT.headerValueNew({ name: 'x-api-key' })),
      'k2',
    );
    await userEvent.click(within(replace).getByRole('button', { name: OTLP_TEXT.save }));
    await waitFor(() => expect(state.otlp.headers['x-api-key']).toBe('k2'));

    await userEvent.click(
      screen.getByRole('button', { name: OTLP_TEXT.removeLabel({ name: 'x-api-key' }) }),
    );
    const dialog = screen.getByRole('dialog', {
      name: OTLP_TEXT.removeTitle({ name: 'x-api-key' }),
    });
    expect(dialog.textContent).toContain(OTLP_TEXT.removeWhat);
    expect(state.otlp.headers['x-api-key']).toBe('k2');
    await userEvent.click(within(dialog).getByRole('button', { name: OTLP_TEXT.remove }));
    await waitFor(() => expect('x-api-key' in state.otlp.headers).toBe(false));
    expect(api.updateOtlp).toHaveBeenLastCalledWith({ headers: { 'x-api-key': null } });
  });

  it('includes content only after a warning that names the collector', async () => {
    const { api, state } = await renderW11(<OtlpSettings />, {
      appauth: { otlp: otlp({ endpoint: 'https://c.example', enabled: true }) },
    });
    await userEvent.click(await screen.findByRole('switch', { name: OTLP_TEXT.contentLabel }));
    const dialog = screen.getByRole('dialog', { name: OTLP_TEXT.contentConfirmTitle });
    expect(dialog.textContent).toContain(OTLP_TEXT.contentConfirm({ where: 'https://c.example' }));
    expect(api.updateOtlp).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: OTLP_TEXT.cancel }));
    expect(state.otlp.includeContent).toBe(false);
    await userEvent.click(screen.getByRole('switch', { name: OTLP_TEXT.contentLabel }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: OTLP_TEXT.contentConfirmButton,
      }),
    );
    await waitFor(() => expect(state.otlp.includeContent).toBe(true));
    expect(await screen.findByText(OTLP_TEXT.contentWarning)).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: OTLP_TEXT.contentLabel }));
    await waitFor(() => expect(state.otlp.includeContent).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('chooses signals and says when none is sent', async () => {
    const { state } = await renderW11(<OtlpSettings />, {
      appauth: {
        otlp: otlp({
          endpoint: 'https://c.example',
          enabled: true,
          signals: { traces: false, metrics: false, logs: true },
        }),
      },
    });
    await userEvent.click(await screen.findByRole('switch', { name: 'Logs' }));
    await waitFor(() => expect(state.otlp.signals.logs).toBe(false));
    expect(await screen.findByText(OTLP_TEXT.inactiveWhy.noSignal)).toBeTruthy();
    expect(await screen.findByText(OTLP_TEXT.signalOff({ signal: 'logs' }))).toBeTruthy();
  });

  it('sends a test and says what the collector answered', async () => {
    const { state } = await renderW11(<OtlpSettings />, {
      appauth: { otlp: otlp({ endpoint: 'https://c.example' }) },
    });
    await userEvent.click(await screen.findByRole('button', { name: OTLP_TEXT.test }));
    expect(await screen.findByText(OTLP_TEXT.testOkStatus({ status: '200' }))).toBeTruthy();
    state.otlpTest = { ok: false, status: 401, error: 'the collector refused the headers' };
    await userEvent.click(screen.getByRole('button', { name: OTLP_TEXT.test }));
    expect(
      await screen.findByText(OTLP_TEXT.testFailed({ why: 'the collector refused the headers' })),
    ).toBeTruthy();
    state.otlpTest = { ok: false, status: null, error: null };
    await userEvent.click(screen.getByRole('button', { name: OTLP_TEXT.test }));
    expect(await screen.findByText(OTLP_TEXT.testFailed({ why: 'no answer' }))).toBeTruthy();
  });

  it('shows the export’s numbers and last error', async () => {
    await renderW11(<OtlpSettings />, {
      appauth: {
        otlp: otlp({
          endpoint: 'https://c.example',
          enabled: true,
          sent: { traces: 5, metrics: 2, logs: 9 },
          dropped: { traces: 0, metrics: 0, logs: 3 },
          failures: 2,
          lastError: 'HTTP 503 from the collector',
          nextAttemptAt: '2026-10-01T12:05:00.000Z',
        }),
      },
    });
    expect(await screen.findByText('Traces 5 · Metrics 2 · Logs 9')).toBeTruthy();
    expect(screen.getByText('Traces 0 · Metrics 0 · Logs 3')).toBeTruthy();
    expect(screen.getByText('HTTP 503 from the collector')).toBeTruthy();
    expect(screen.getByText(OTLP_TEXT.nextAttempt)).toBeTruthy();
  });

  it('respects managed policy: export forbidden, settings locked, the Hub’s refusal named', async () => {
    const { api } = await renderW11(<OtlpSettings />, {
      appauth: { otlp: otlp({ endpoint: 'https://c.example' }) },
      managed: {
        'managed.restrict': { layers: [{ telemetryExport: false }], failClosed: null },
        'telemetry.otlp.enabled': false,
        'telemetry.otlp.endpoint': 'https://c.example',
      },
    });
    expect(await screen.findByText(OTLP_TEXT.managedOff)).toBeTruthy();
    const sw = screen.getByRole('switch', { name: OTLP_TEXT.switchLabel });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>(OTLP_TEXT.endpointLabel).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: OTLP_TEXT.test }).disabled).toBe(
      true,
    );
    expect(screen.getByText(OTLP_TEXT.inactiveWhy.managed)).toBeTruthy();
    expect(screen.getAllByText(/Managed by your organization/).length).toBeGreaterThan(0);
    // The Hub's own refusal, had the request been sent.
    await expect(api.updateOtlp({ enabled: true })).rejects.toMatchObject({
      body: { details: { reason: 'managed' } },
    });
  });

  it('says why a change was refused and keeps what was typed', async () => {
    const { state } = await renderW11(<OtlpSettings />, {
      appauth: { otlp: otlp({ endpoint: 'https://c.example' }) },
      fail: {
        updateOtlp: new ApiError(400, {
          code: 'validation',
          message: 'request failed validation',
          retryable: false,
          details: { issues: [{ path: 'endpoint', message: 'an https:// URL' }] },
        }),
      },
    });
    const field = await screen.findByLabelText(OTLP_TEXT.endpointLabel);
    await userEvent.clear(field);
    await userEvent.type(field, 'https://other.example');
    await userEvent.click(screen.getByRole('button', { name: OTLP_TEXT.save }));
    expect(await screen.findByText(OTLP_TEXT.endpointInvalid)).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('https://other.example');
    expect(state.otlp.endpoint).toBe('https://c.example');
  });

  it('says when it cannot load, with Retry, and is the owner’s alone', async () => {
    await renderW11(<OtlpSettings />, {
      fail: {
        getOtlp: new ApiError(500, { code: 'server_error', message: 'down', retryable: true }),
      },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('down');
    await userEvent.click(screen.getByRole('button', { name: OTLP_TEXT.retry }));
    expect(await screen.findByRole('switch', { name: OTLP_TEXT.switchLabel })).toBeTruthy();
    resetDom();
    await renderW11(<OtlpSettings />, { member: true });
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Only the owner of this Hub can change this.',
    );
  });

  it('explains why it is not exporting', () => {
    const base = {
      ...m8AppAuthState().otlp,
      managedOff: false,
      active: false,
      headers: [],
    };
    expect(inactiveWhy({ ...base, active: true })).toBeNull();
    expect(inactiveWhy({ ...base, managedOff: true })).toBe(OTLP_TEXT.inactiveWhy.managed);
    expect(inactiveWhy({ ...base, enabled: true })).toBe(OTLP_TEXT.inactiveWhy.noEndpoint);
    expect(
      inactiveWhy({
        ...base,
        enabled: true,
        endpoint: 'https://c',
        signals: { traces: true, metrics: false, logs: false },
      }),
    ).toBeNull();
  });
});
