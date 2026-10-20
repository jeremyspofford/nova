import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import {
  LOG_POLL_MS,
  auditChange,
  auditValue,
  formatUptime,
} from '../src/settings/DiagnosticsPage.tsx';
import { createHub } from './fakes.ts';
import { m3State } from './fakes-m3.ts';
import { auditEntry, logEntry } from './fakes-settings.ts';
import { captureIntervals } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const fail = (message: string) => new ApiError(500, { code: 'x', message, retryable: true });
const section = (name: string) => screen.getByRole('heading', { name }).closest('section')!;

describe('diagnostics helpers', () => {
  it('formats uptime', () => {
    expect(formatUptime(12)).toBe('12 s');
    expect(formatUptime(125)).toBe('2 min');
    expect(formatUptime(3 * 3600 + 120)).toBe('3 h 2 min');
    expect(formatUptime(2 * 86_400 + 5 * 3600)).toBe('2 d 5 h');
    expect(formatUptime(-4)).toBe('0 s');
  });

  it('shortens audit values and finds a change only in settings and device entries', () => {
    expect([true, false, null, undefined, 3, 'LanOnly'].map(auditValue)).toEqual([
      'on',
      'off',
      'none',
      'none',
      '3',
      'LanOnly',
    ]);
    expect(auditValue({ wol: 'Disabled' })).toBe('{"wol":"Disabled"}');
    expect(auditValue('x'.repeat(200))).toHaveLength(120);
    const detail = { before: false, after: true, confirmed: true };
    expect(auditChange(auditEntry({ kind: 'settings', detail }))).toEqual({
      before: 'off',
      after: 'on',
      confirmed: true,
    });
    expect(auditChange(auditEntry({ kind: 'device', detail: { before: 1, after: 2 } }))).toEqual({
      before: '1',
      after: '2',
      confirmed: false,
    });
    expect(auditChange(auditEntry({ kind: 'approval', detail }))).toBeNull();
    expect(auditChange(auditEntry({ kind: 'settings', detail: { scope: 'global' } }))).toBeNull();
    expect(auditChange(auditEntry({ kind: 'settings' }))).toBeNull();
  });
});

describe('Settings → Diagnostics: health (FR-043, FR-118)', () => {
  it('shows the snapshot cards and warnings, and refreshes', async () => {
    const m3 = m3State();
    m3.diagnostics = {
      hub: {
        version: '0.3.0',
        uptimeSeconds: 3700,
        dataDir: '/var/lib/nova',
        encryptedAtRest: { blobs: true, volume: 'unencrypted' },
      },
      providers: [{ id: 'pa1', label: 'Mock', status: 'active' }],
      nodes: [{ id: 'n1', name: 'Desk GPU', status: 'unreachable' }],
      mcp: [{ id: 's1', name: 'files', status: 'error', lastError: 'spawn ENOENT' }],
      sandbox: { substrate: 'os_sandbox', available: true, detail: 'bubblewrap 0.9' },
      secrets: { backend: 'keychain', detail: 'Secret Service' },
      warnings: ['Project “Billing” sets tools.permissionProfile, which is ignored.'],
    };
    const hub = createHub({ m3 });
    await renderApp({ hub, path: '/settings/diagnostics' });
    const health = section('Health');
    const card = (name: string) => within(health).getByRole('region', { name });
    expect(await within(health).findByText('0.3.0')).toBeTruthy();
    expect(within(card('Hub')).getByText('1 h 1 min')).toBeTruthy();
    expect(within(card('Hub')).getByText('/var/lib/nova')).toBeTruthy();
    expect(within(card('Encryption at rest')).getByText('Encrypted with the Hub key')).toBeTruthy();
    expect(within(card('Encryption at rest')).getByText('Not encrypted')).toBeTruthy();
    expect(within(card('Secrets')).getByText('System keychain')).toBeTruthy();
    expect(within(card('Sandbox')).getByText('Available (os sandbox)')).toBeTruthy();
    expect(within(card('Providers')).getByText(/active/)).toBeTruthy();
    expect(within(card('Compute nodes')).getByText(/unreachable/)).toBeTruthy();
    expect(within(card('MCP servers')).getByText(/Error/)).toBeTruthy();
    expect(within(card('MCP servers')).getByText(/spawn ENOENT/)).toBeTruthy();
    expect(
      within(within(health).getByRole('group', { name: 'Warnings' })).getByText(/Billing/),
    ).toBeTruthy();

    hub.state.m3.diagnostics = { ...m3.diagnostics, warnings: [] };
    await userEvent.click(within(health).getByRole('button', { name: 'Refresh' }));
    expect(await within(health).findByText('No warnings.')).toBeTruthy();
  });

  it('shows an empty Hub and retries a failed snapshot', async () => {
    const hub = createHub();
    hub.state.failNext.diagnostics = fail('Diagnostics timed out');
    await renderApp({ hub, path: '/settings/diagnostics' });
    const health = section('Health');
    expect(await within(health).findByText('Diagnostics timed out')).toBeTruthy();
    await userEvent.click(within(health).getByRole('button', { name: 'Retry' }));
    expect(await within(health).findByText('No providers connected.')).toBeTruthy();
    expect(within(health).getByText('No compute nodes.')).toBeTruthy();
    expect(within(health).getByText('No MCP servers.')).toBeTruthy();
    // The backend name and the fake's detail text.
    expect(within(health).getAllByText('Encrypted vault')).toHaveLength(2);
    expect(within(health).getByText('Not available')).toBeTruthy();
    expect(within(health).getByText('Cannot tell')).toBeTruthy();
  });
});

describe('Settings → Diagnostics: logs (FR-118)', () => {
  const logs = () => [
    logEntry({ level: 'debug', module: 'router', msg: 'picked mock' }),
    logEntry({ level: 'info', module: 'hub', msg: 'listening', fields: { port: 7340 } }),
    logEntry({ level: 'warn', module: 'mcp', msg: 'server slow' }),
    logEntry({ level: 'error', module: 'mcp', msg: 'server crashed' }),
  ];

  it('filters by level and module, refreshes automatically, and links the export', async () => {
    const polls = captureIntervals(LOG_POLL_MS);
    const hub = createHub({ m3: m3State({ logs: logs() }) });
    await renderApp({ hub, path: '/settings/diagnostics' });
    const s = section('Logs');
    const list = await within(s).findByRole('list', { name: 'Log entries' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(within(list).getByText('{"port":7340}')).toBeTruthy();
    expect(hub.api.logs).toHaveBeenCalledWith({ limit: 200 });

    await userEvent.selectOptions(within(s).getByRole('combobox', { name: 'Level' }), 'warn');
    await waitFor(() =>
      expect(hub.api.logs).toHaveBeenLastCalledWith({ limit: 200, level: 'warn' }),
    );
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    // Modules seen before filtering stay choosable.
    const module = within(s).getByRole('combobox', { name: 'Module' });
    expect(within(module).getByRole('option', { name: 'router' })).toBeTruthy();
    await userEvent.selectOptions(within(s).getByRole('combobox', { name: 'Level' }), '');
    await userEvent.selectOptions(module, 'mcp');
    await waitFor(() =>
      expect(hub.api.logs).toHaveBeenLastCalledWith({ limit: 200, module: 'mcp' }),
    );
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));

    expect(polls.count()).toBe(0);
    await userEvent.click(within(s).getByRole('switch', { name: 'Refresh automatically' }));
    expect(polls.count()).toBe(1);
    hub.state.m3.logs = [
      ...hub.state.m3.logs,
      logEntry({ level: 'info', module: 'mcp', msg: 'server restarted' }),
    ];
    polls.fire();
    expect(await within(list).findByText('server restarted')).toBeTruthy();
    await userEvent.click(within(s).getByRole('switch', { name: 'Refresh automatically' }));
    expect(polls.count()).toBe(0);

    const link = within(s).getByRole('link', { name: 'Export logs' });
    expect(link.getAttribute('href')).toBe('/api/v1/diagnostics/logs/export');
    expect(link.hasAttribute('download')).toBe(true);
  });

  it('reports a failed load and an empty result', async () => {
    const hub = createHub();
    hub.state.failNext.logs = fail('Ring buffer locked');
    await renderApp({ hub, path: '/settings/diagnostics' });
    const s = section('Logs');
    expect(await within(s).findByText('Ring buffer locked')).toBeTruthy();
    await userEvent.click(within(s).getByRole('button', { name: 'Retry' }));
    expect(await within(s).findByText('No log entries match.')).toBeTruthy();
  });
});

describe('Settings → Diagnostics: audit log (FR-104 partial)', () => {
  it('lists entries with paging, verifies integrity and links the export', async () => {
    const audit = Array.from({ length: 55 }, (_, i) =>
      auditEntry({ id: `a${i}`, action: `Action ${i}`, result: i === 0 ? 'ok' : null }),
    );
    const hub = createHub({ m3: m3State({ audit }) });
    await renderApp({ hub, path: '/settings/diagnostics' });
    const s = section('Audit log');
    const list = await within(s).findByRole('list', { name: 'Audit entries' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    const first = within(list).getByRole('listitem', { name: 'approval: Action 0' });
    expect(within(first).getByText('By user:a1')).toBeTruthy();
    expect(within(first).getByText('On notes/plan.md')).toBeTruthy();
    expect(within(first).getByText('Decision: allow_once')).toBeTruthy();
    expect(within(first).getByText('Result: ok')).toBeTruthy();
    hub.state.failNext.listAudit = fail('Page lost');
    await userEvent.click(within(s).getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Could not load more: Page lost')).toBeTruthy();
    await userEvent.click(within(s).getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(55));
    expect(within(s).queryByRole('button', { name: 'Load more' })).toBeNull();

    await userEvent.click(within(s).getByRole('button', { name: 'Verify integrity' }));
    expect(await within(s).findByText(/The audit log is intact \(55 entries/)).toBeTruthy();
    hub.api.verifyAudit.mockResolvedValueOnce({ ok: false, checked: 12, brokenAt: 'a11' });
    await userEvent.click(within(s).getByRole('button', { name: 'Verify integrity' }));
    expect(await within(s).findByText(/chain breaks at entry a11/)).toBeTruthy();
    hub.state.failNext.verifyAudit = fail('Chain unreadable');
    await userEvent.click(within(s).getByRole('button', { name: 'Verify integrity' }));
    expect(await screen.findByText('Could not check the audit log: Chain unreadable')).toBeTruthy();

    expect(within(s).getByRole('link', { name: 'Export audit log' }).getAttribute('href')).toBe(
      '/api/v1/audit/export',
    );
  });

  it('shows each entry’s detail: a change as before → after, else the JSON (M7.5)', async () => {
    const audit = [
      auditEntry({
        id: 's1',
        kind: 'settings',
        action: 'setting.changed',
        resource: 'devices.firmware.allowChanges',
        decision: null,
        detail: { scope: 'global', before: false, after: true, confirmed: true },
      }),
      auditEntry({
        id: 'd1',
        kind: 'device',
        action: 'device.firmware.apply',
        decision: null,
        detail: { before: { wol: 'Disabled' }, after: { wol: 'LanOnly' } },
      }),
      auditEntry({
        id: 'p1',
        kind: 'policy',
        action: 'deny',
        decision: null,
        detail: { reason: 'protected_path', path: '[REDACTED]' },
      }),
      auditEntry({
        id: 't1',
        kind: 'device',
        action: 'device.big',
        detail: { truncated: true, chars: 9001 },
      }),
      auditEntry({ id: 'n1', kind: 'auth', action: 'session.created', detail: null }),
    ];
    const hub = createHub({ m3: m3State({ audit }) });
    await renderApp({ hub, path: '/settings/diagnostics' });
    const list = await within(section('Audit log')).findByRole('list', { name: 'Audit entries' });
    const row = (name: string) => within(list).getByRole('listitem', { name });
    const setting = row('settings: setting.changed');
    expect(setting.querySelector('.ws-audit-change')?.textContent).toBe(
      'off → changed to  onConfirmed',
    );
    expect(within(setting).getByText('Confirmed')).toBeTruthy();
    expect(
      row('device: device.firmware.apply').querySelector('.ws-audit-change')?.textContent,
    ).toBe('{"wol":"Disabled"} → changed to  {"wol":"LanOnly"}');
    const policy = row('policy: deny');
    expect(policy.querySelector('.ws-audit-change')).toBeNull();
    await userEvent.click(within(policy).getByText('Details'));
    expect(policy.querySelector('pre')?.textContent).toBe(
      JSON.stringify({ reason: 'protected_path', path: '[REDACTED]' }, null, 2),
    );
    expect(
      within(row('device: device.big')).getByText(/too long to show here \(9,001 characters\)/),
    ).toBeTruthy();
    const plain = row('auth: session.created');
    expect(plain.querySelector('.ws-audit-change, details')).toBeNull();
  });

  it('shows an empty audit log and retries a failed load', async () => {
    const hub = createHub();
    hub.state.failNext.listAudit = fail('Audit offline');
    await renderApp({ hub, path: '/settings/diagnostics' });
    const s = section('Audit log');
    expect(await within(s).findByText('Audit offline')).toBeTruthy();
    await userEvent.click(within(s).getByRole('button', { name: 'Retry' }));
    expect(await within(s).findByText('The audit log is empty.')).toBeTruthy();
  });
});
