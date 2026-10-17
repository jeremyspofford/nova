// Network → Overview (FR-135, FR-139; docs/22 §2, §6, §10): the primary transport and what
// clients are told (only healthy endpoints), Test now, problems with guided fixes, each transport
// with its endpoints and why one was withdrawn, the change list with one-click rollback (and the
// Hub's 409 when there is nothing left), the fallback log in sentences, device reachability, the
// certificate, mesh and Relay status, the settings form checked as the Hub checks it, and live
// updates.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { OverviewSection } from '../src/netsurface/Overview.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  changeView,
  endpoint,
  eventView,
  reachability,
  renderWithNetwork,
  transportView,
} from './fakes-m65-network.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');
const region = (name: string) => screen.getByRole('region', { name });

const MESH_DOWN = [
  transportView({ transport: 'lan', endpoints: [endpoint()] }),
  transportView({
    transport: 'mesh',
    status: 'down',
    endpoints: [
      endpoint({
        transport: 'mesh',
        url: 'https://nova-hub.tail.ts.net:8443',
        priority: 20,
        health: 'failing',
        latencyMs: null,
        detail: 'timed out',
      }),
    ],
  }),
  transportView({ transport: 'relay', status: 'none', detail: 'the Relay is off' }),
  transportView({ transport: 'direct', enabled: false, status: 'off' }),
];

async function open(network: NonNullable<Parameters<typeof renderWithNetwork>[1]>['network'] = {}) {
  const r = await renderWithNetwork(<OverviewSection />, { network });
  await screen.findByRole('heading', { name: 'How clients reach this Hub' });
  return r;
}

describe('the overview (FR-135, FR-139)', () => {
  it('shows the primary transport, what clients are told and why an endpoint was withdrawn', async () => {
    await open({ checked: MESH_DOWN });
    const summary = region('How clients reach this Hub');
    const primary = within(summary).getByText('Primary transport').closest('div')!;
    expect(primary.textContent).toContain('LAN');
    expect(within(summary).getByText('https://0.0.0.0:8443')).toBeTruthy();
    expect(
      within(summary).getByText(/Only endpoints that pass their reachability test/),
    ).toBeTruthy();
    const advertised = within(summary).getByRole('list', { name: 'Advertised endpoints' });
    expect(within(advertised).getAllByRole('listitem')).toHaveLength(1);
    expect(advertised.textContent).toContain('http://192.168.1.10:8443');

    const transports = screen.getByRole('list', { name: 'Transports' });
    const lan = within(transports).getByRole('listitem', { name: 'LAN' });
    expect(within(lan).getByText('Up')).toBeTruthy();
    expect(within(lan).getByText('Primary')).toBeTruthy();
    expect(within(lan).getByText('Advertised')).toBeTruthy();
    expect(within(lan).getByText(/24 of 24 checks passed/)).toBeTruthy();
    const mesh = within(transports).getByRole('listitem', { name: 'Mesh' });
    expect(within(mesh).getByText('Failing')).toBeTruthy();
    expect(within(mesh).getByText('Withdrawn')).toBeTruthy();
    expect(within(mesh).getByText('Why: timed out')).toBeTruthy();
    const relay = within(transports).getByRole('listitem', { name: 'Relay' });
    expect(within(relay).getByText('Nothing to advertise')).toBeTruthy();
    expect(within(relay).getByText('The Relay is off')).toBeTruthy();
    const direct = within(transports).getByRole('listitem', { name: 'Direct public' });
    expect(within(direct).getByText('Off: not advertised to clients.')).toBeTruthy();
    expect(screen.getByText('No problems found.')).toBeTruthy();
  });

  it('runs Test now, and says why it cannot before the Hub listens', async () => {
    const { api, network } = await open();
    await userEvent.click(screen.getByRole('button', { name: 'Test now' }));
    await waitFor(() => expect(api.testNetwork).toHaveBeenCalled());
    expect(screen.getByTestId('announcer').textContent).toMatch(/1 endpoint advertised, LAN first/);

    network.failNext.testNetwork = new ApiError(400, {
      code: 'capability_missing',
      message: 'the Hub has not reported where it listens',
      retryable: false,
      details: { reason: 'no_listener' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Test now' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The Hub has not reported where it listens yet.',
    );
  });

  it('does not offer Test now before the Hub reports where it listens', async () => {
    await open({ listener: null, checked: [], checkedAt: null });
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Test now' });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Testing starts once the Hub reports where it listens/)).toBeTruthy();
    expect(screen.getByText('Nothing is advertised until the first test.')).toBeTruthy();
    const lan = screen.getByRole('listitem', { name: 'LAN' });
    expect(within(lan).getByText('The Hub has not reported where it listens yet')).toBeTruthy();
  });

  it('turns problems into guided fixes with the actions that help', async () => {
    const { api } = await open({
      checked: MESH_DOWN,
      changes: [changeView({ summary: 'Changed transports' })],
      problems: [
        'Mesh: https://nova-hub.tail.ts.net:8443 timed out',
        'Trust: the Hub certificate expired',
        'No endpoint passes its reachability test, so none is advertised.',
        'something new the page does not know',
      ],
    });
    const list = screen.getByRole('list', { name: 'Problems' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]!.textContent).toContain('Mesh: https://nova-hub.tail.ts.net:8443 timed out');
    expect(items[0]!.textContent).toContain('Clients use the LAN instead');
    expect(within(items[0]!).getByRole('button', { name: 'Open Setup' })).toBeTruthy();
    expect(
      within(items[0]!).getByRole('button', { name: 'Roll back the last change' }),
    ).toBeTruthy();
    expect(items[1]!.textContent).toContain('Certificates: The Hub certificate expired');
    expect(items[1]!.textContent).toContain('Mesh certificates renew on their own');
    expect(items[2]!.textContent).toContain('Clients cannot find the Hub on any path');
    expect(items[3]!.textContent).toContain('Something new the page does not know');

    await userEvent.click(within(items[3]!).getByRole('button', { name: 'Test now' }));
    await waitFor(() => expect(api.testNetwork).toHaveBeenCalled());
    await userEvent.click(within(items[1]!).getByRole('button', { name: 'Open Trust' }));
    expect(window.location.pathname).toBe('/network/trust');
  });

  it('does not offer a rollback fix when nothing can be rolled back', async () => {
    await open({ problems: ['No endpoint passes its reachability test, so none is advertised.'] });
    const list = screen.getByRole('list', { name: 'Problems' });
    expect(within(list).queryByRole('button', { name: 'Roll back the last change' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Roll back/ })).toBeNull();
    expect(region('Changes').textContent).toContain('No changes yet.');
  });

  it('rolls back the last change after asking, and shows the Hub’s refusal in the dialog', async () => {
    const { api, network, state } = await open({
      transports: { lan: true, mesh: false, relay: true, directPublic: false },
      changes: [
        {
          ...changeView({ id: 'c2', summary: 'Changed transports' }),
          undo: { transports: { lan: true, mesh: true, relay: true, directPublic: false } },
        },
        changeView({
          id: 'c1',
          summary: 'Changed healthCheckSeconds',
          status: 'rolled_back',
          rolledBackAt: '2026-10-01T12:05:00.000Z',
        }),
      ],
    });
    const changes = within(region('Changes')).getByRole('list', { name: 'Network changes' });
    const rows = within(changes).getAllByRole('listitem');
    expect(within(rows[0]!).getByText('Applied')).toBeTruthy();
    expect(within(rows[1]!).getByText('Rolled back')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Roll back the last change' }));
    let dialog = screen.getByRole('dialog', { name: 'Roll back the last change?' });
    expect(dialog.textContent).toContain('Changed transports');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.rollbackNetworkChange).toHaveBeenCalledWith();
    expect(state.transports.mesh).toBe(true);
    expect((await screen.findAllByText('Rolled back: Changed transports')).length).toBeGreaterThan(
      0,
    );

    // Another view rolled it back meanwhile: the Hub answers 409 and the dialog says so.
    state.changes = [changeView({ id: 'c3', summary: 'Changed mdns' })];
    stream().emit('network.changed', {
      changeId: 'c3',
      kind: 'network.settings',
      summary: 'Changed mdns',
      status: 'applied',
    });
    await screen.findByText('Changed mdns');
    network.failNext.rollbackNetworkChange = new ApiError(409, {
      code: 'conflict',
      message: 'there is no network change to roll back',
      retryable: false,
      details: { reason: 'nothing_to_roll_back' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Roll back the last change' }));
    dialog = screen.getByRole('dialog', { name: 'Roll back the last change?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'There is nothing to roll back.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  it('shows a failed rollback on the change', async () => {
    await open({
      changes: [
        changeView({
          summary: 'Network setup: Join tailscale',
          kind: 'network.setup.step',
          error: 'tailscale down: exit code 1',
        }),
      ],
    });
    const row = screen.getByRole('listitem', { name: 'Network setup: Join tailscale' });
    expect(within(row).getByText('Rollback failed')).toBeTruthy();
    expect(
      within(row).getByText('The last rollback failed: tailscale down: exit code 1'),
    ).toBeTruthy();
    expect(within(row).getByText('Network setup')).toBeTruthy();
  });

  it('tells the fallback log in sentences', async () => {
    const at = '2026-10-01T12:10:00.000Z';
    await open({
      events: [
        eventView({
          kind: 'primary',
          transport: 'mesh',
          fromTransport: 'lan',
          url: 'https://m',
          createdAt: at,
        }),
        eventView({
          kind: 'down',
          transport: 'lan',
          url: null,
          detail: 'connect ECONNREFUSED',
          createdAt: at,
        }),
        eventView({
          kind: 'withdrawn',
          transport: 'lan',
          url: 'http://192.168.1.10:8443',
          detail: 'timed out',
          createdAt: at,
        }),
        eventView({ kind: 'advertised', transport: 'mesh', url: 'https://m' }),
      ],
    });
    const log = screen.getByRole('list', { name: 'Transport events' });
    const items = within(log).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('LAN failed its check; Mesh is now primary.');
    expect(items[0]!.textContent).toContain('Connect ECONNREFUSED');
    expect(items[1]!.textContent).toContain('Stopped advertising http://192.168.1.10:8443 (LAN).');
    expect(items[2]!.textContent).toContain('Advertised https://m (Mesh).');
  });

  it('says a transport the owner turned off was turned off, not that it failed', async () => {
    const at = '2026-10-01T12:20:00.000Z';
    await open({
      events: [
        eventView({ kind: 'primary', transport: 'relay', fromTransport: 'lan', createdAt: at }),
        eventView({ kind: 'off', transport: 'lan', url: null, detail: null, createdAt: at }),
        eventView({ kind: 'off', transport: 'mesh', url: null, detail: null }),
      ],
    });
    const log = screen.getByRole('list', { name: 'Transport events' });
    const items = within(log).getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('LAN was turned off; Relay is now primary.');
    expect(items[1]!.textContent).toContain('Mesh was turned off.');
    expect(log.textContent).not.toContain('failed its check');
  });

  it('lists every device’s reachability, and the status of certificates, mesh and Relay', async () => {
    await open({
      devices: [
        reachability({
          name: 'Desk PC',
          endpoints: [
            {
              transport: 'lan',
              url: 'http://192.168.1.30:7000',
              healthy: true,
              latencyMs: 2,
              checkedAt: null,
            },
          ],
        }),
        reachability({
          name: 'Phone',
          kind: 'native',
          reachable: false,
          relayPaired: true,
          lastSeenAt: null,
        }),
        reachability({ name: 'Old box', status: 'revoked', reachable: false }),
      ],
      mesh: {
        provider: 'headscale',
        source: 'headscale-policy',
        rules: 4,
        groups: ['group:admins'],
        tagOwners: [],
        tags: ['tag:nova-hub'],
        detail: null,
      },
      relayStatus: {
        state: 'connected',
        url: 'wss://relay.example.com',
        latencyMs: 31,
        detail: null,
      },
    });
    const devices = screen.getByRole('list', { name: 'Device reachability' });
    const desk = within(devices).getByRole('listitem', { name: 'Desk PC' });
    expect(within(desk).getByText('Reachable')).toBeTruthy();
    expect(within(desk).getByRole('list', { name: 'Paths to Desk PC' }).textContent).toContain(
      '2 ms',
    );
    const phone = within(devices).getByRole('listitem', { name: 'Phone' });
    expect(within(phone).getByText('Not reachable')).toBeTruthy();
    expect(within(phone).getByText('Paired through the Relay')).toBeTruthy();
    expect(within(phone).getByText('not seen yet')).toBeTruthy();
    expect(
      within(within(devices).getByRole('listitem', { name: 'Old box' })).getByText('Revoked'),
    ).toBeTruthy();

    const other = region('Certificates, mesh and Relay');
    expect(other.textContent).toContain('Hub local CA');
    expect(other.textContent).toContain('tag:nova-hub');
    expect(other.textContent).toContain('Connected');
    expect(other.textContent).toContain('31 ms');
    expect(other.textContent).toContain('Allowed hosts only');
    await userEvent.click(within(other).getByRole('link', { name: 'Settings → Network' }));
    expect(window.location.pathname).toBe('/settings/network');
  });

  it('says when the mesh rules cannot be read', async () => {
    await open({ mesh: { error: 'headscale policy get: exit code 1' }, relayStatus: null });
    const other = region('Certificates, mesh and Relay');
    expect(other.textContent).toContain('Could not read them: headscale policy get: exit code 1');
    expect(other.textContent).toContain('Not available.');
  });

  it('keeps a status it does not know readable', async () => {
    await open({
      checked: [
        transportView({
          transport: 'lan',
          status: 'degraded' as 'up',
          endpoints: [endpoint({ health: 'probing' as 'ok' })],
        }),
      ],
    });
    const lan = screen.getByRole('listitem', { name: 'LAN' });
    expect(within(lan).getByText('degraded')).toBeTruthy();
    expect(within(lan).getByText('probing')).toBeTruthy();
  });

  it('shows a load error with Retry', async () => {
    const r = await renderWithNetwork(<OverviewSection />);
    r.network.failNext.getNetworkDiagnostics = new ApiError(503, {
      code: 'node_unavailable',
      message: 'The Hub is busy',
      retryable: true,
    });
    // The first load already ran; make the next one fail and reload by an event.
    await screen.findByRole('heading', { name: 'How clients reach this Hub' });
    stream().emit('network.endpoints.changed', { advertised: [], added: [], removed: [] });
    expect((await screen.findByRole('alert')).textContent).toContain('The Hub is busy.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('follows live transport changes and announces a new primary', async () => {
    const { state } = await open();
    state.checked = MESH_DOWN.map((t) =>
      t.transport === 'lan'
        ? {
            ...t,
            status: 'down' as const,
            endpoints: [endpoint({ health: 'failing', detail: 'timed out' })],
          }
        : t.transport === 'mesh'
          ? {
              ...t,
              status: 'up' as const,
              endpoints: [endpoint({ transport: 'mesh', url: 'https://m', priority: 20 })],
            }
          : t,
    );
    stream().emit('network.transport.changed', {
      primary: 'mesh',
      previousPrimary: 'lan',
      transports: [],
      changed: ['lan', 'mesh'],
    });
    expect(screen.getByTestId('announcer').textContent).toMatch(
      /Mesh is now the primary transport/,
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole('listitem', { name: 'Mesh' })).getByText('Primary'),
      ).toBeTruthy(),
    );
  });
});

describe('the settings form (FR-135; docs/22 §8)', () => {
  const form = () => region('Settings');

  it('saves only what changed, all at once, and records it for rollback', async () => {
    const { api, state } = await open();
    const f = form();
    await userEvent.click(within(f).getByRole('switch', { name: 'Mesh' }));
    const secs = within(f).getByLabelText('Test endpoints every (seconds)');
    await userEvent.clear(secs);
    await userEvent.type(secs, '120');
    await userEvent.click(within(f).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateNetworkPanel).toHaveBeenCalledWith({
        transports: { lan: true, mesh: false, relay: true, directPublic: false },
        healthCheckSeconds: 120,
      }),
    );
    expect(await screen.findByText(/Network settings saved. You can roll this back/)).toBeTruthy();
    expect(state.healthCheckSeconds).toBe(120);
    expect(state.changes[0]!.summary).toBe('Changed transports, healthCheckSeconds');
    await waitFor(() =>
      expect(
        screen.getByRole('listitem', { name: 'Changed transports, healthCheckSeconds' }),
      ).toBeTruthy(),
    );
  });

  it('checks what the Hub would refuse before sending it', async () => {
    const { api } = await open();
    const f = form();
    for (const name of ['LAN', 'Mesh', 'Relay'])
      await userEvent.click(within(f).getByRole('switch', { name }));
    await userEvent.type(within(f).getByLabelText('mDNS name'), 'X_bad');
    await userEvent.click(within(f).getByRole('button', { name: 'Save' }));
    expect(
      within(f).getByText('Keep at least one transport on, or clients cannot reach the Hub.'),
    ).toBeTruthy();
    expect(within(f).getByText(/Use lowercase letters, digits and hyphens/)).toBeTruthy();
    expect(api.updateNetworkPanel).not.toHaveBeenCalled();

    await userEvent.click(within(f).getByRole('button', { name: 'Reset' }));
    await userEvent.click(within(f).getByRole('switch', { name: 'Direct public' }));
    await userEvent.click(within(f).getByRole('button', { name: 'Save' }));
    expect(within(f).getByText('Set the public URL to advertise Direct public.')).toBeTruthy();
    await userEvent.type(
      within(f).getByLabelText('Public URL'),
      'https://user:pw@nova.example.com',
    );
    await userEvent.click(within(f).getByRole('button', { name: 'Save' }));
    expect(within(f).getByText(/without a user name, query or fragment/)).toBeTruthy();
    expect(api.updateNetworkPanel).not.toHaveBeenCalled();
  });

  it('shows the Hub’s own refusal on the field it names', async () => {
    const { network } = await open();
    network.failNext.updateNetworkPanel = new ApiError(400, {
      code: 'validation',
      message: 'set the public URL to advertise Direct public',
      retryable: false,
      details: { field: 'directPublic.url', reason: 'url_required' },
    });
    const f = form();
    await userEvent.type(within(f).getByLabelText('Public URL'), 'https://nova.example.com');
    await userEvent.click(within(f).getByRole('button', { name: 'Save' }));
    const alerts = await within(f).findAllByRole('alert');
    expect(alerts.map((a) => a.textContent)).toContain(
      'Set the public URL to advertise Direct public.',
    );
  });

  it('jumps to the settings from a Direct public problem', async () => {
    await open({ problems: ['Direct public: https://nova.example.com timed out'] });
    await userEvent.click(screen.getByRole('button', { name: 'Edit settings' }));
    expect(document.activeElement?.textContent).toBe('Settings');
  });
});
