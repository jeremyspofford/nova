// M7.5 device operations (ADR-096 D1, D9; FR-126, FR-142, FR-145, FR-148, FR-150): the
// management channel on a device's page (mutual TLS, plain HTTP, a refused call); the managed
// services novad lists, with their actions and an older novad's fallback; the novad build the Hub
// serves; the overrides as the device has them with Push now; decommissioning with the typed
// confirmation, the purge option, its approval card and the outcome; and a compute node's state,
// policy (quiet hours in a time zone, routing) and services, reachable from Settings → Devices.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { availableText, channelText, opsErrorMessage, renewalText } from '../src/devices/ops.tsx';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { decommissionResultText } from '../src/devices/Decommission.tsx';
import { vramText } from '../src/devices/NodePanel.tsx';
import { serviceChip } from '../src/devices/Services.tsx';
import { ApiError } from '../src/api.ts';
import { FakeEventSource, createHub } from './fakes.ts';
import { deviceView } from './fakes-m6-devices.ts';
import { summaryView } from './fakes-m65-devices.ts';
import { decommissionView, fakeNode, renderWithM75 } from './fakes-m75-devops.ts';
import { computeNode, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');

const DESK = () => deviceView({ id: 'd1', name: 'Desk PC' });
const LAB = () => deviceView({ id: 'd2', name: 'Lab PC', endpoint: 'https://10.0.0.8:7420' });
const GPU = () =>
  summaryView({
    id: 'c1',
    name: 'GPU box',
    kind: 'compute',
    addedAs: null,
    roles: ['compute'],
    platform: 'linux',
    sessions: 0,
  });

function open(path: string, opts: Parameters<typeof renderWithM75>[1] = {}) {
  window.history.replaceState(null, '', path);
  const deviceId = path.split('?')[0]!.split('/')[2] ?? null;
  return renderWithM75(<DevicesView deviceId={deviceId} />, {
    devices: { devices: [DESK(), LAB()] },
    ...opts,
  });
}

const dialog = (name: string | RegExp) => screen.getByRole('dialog', { name });

describe('the management channel (D1)', () => {
  it('says whether the Hub reaches the device over mutual TLS or plain HTTP', async () => {
    await open('/devices/d1');
    expect(await screen.findByText('Plain HTTP')).toBeTruthy();
    expect(screen.getByText(/Calls are not encrypted. Add the device again/)).toBeTruthy();
    resetDom();
    await open('/devices/d2');
    expect(await screen.findByText('Mutual TLS')).toBeTruthy();
    expect(screen.getByText(/check each other’s certificates on every call/)).toBeTruthy();
  });

  it('says why the last call was refused, and follows the device live', async () => {
    const { ops } = await open('/devices/d2', {
      ops: {
        lastCalls: {
          d2: { ok: false, at: '2026-10-02T09:00:00.000Z', failure: 'unsupported_purpose' },
        },
      },
    });
    expect(await screen.findByText('Channel refused')).toBeTruthy();
    expect(
      screen.getByText(/still presents its old certificate; it installs the renewed one/),
    ).toBeTruthy();
    ops.state.lastCalls = {};
    stream().emit('device.endpoint.changed', { deviceId: 'd2', channel: 'mutual_tls' });
    expect(await screen.findByText('Mutual TLS')).toBeTruthy();
  });
});

describe('certificate renewal (D1)', () => {
  it('says in one line that a renewal was offered, and that it is in use once presented', async () => {
    const { ops } = await open('/devices/d2', {
      ops: {
        renewals: {
          d2: {
            renewal: {
              state: 'offered',
              offeredAt: '2026-10-02T11:58:00.000Z',
              notAfter: '2027-10-02T11:58:00.000Z',
              reason: 'missing_server_auth',
            },
            legacyCertificate: true,
            legacyGraceEndsAt: '2026-10-02T12:08:00.000Z',
          },
        },
      },
    });
    expect(
      await screen.findByText(
        /Certificate renewal offered; the device switches at its next check-in \(its old certificate is accepted until/,
      ),
    ).toBeTruthy();
    ops.state.renewals = {
      d2: {
        renewal: {
          state: 'presented',
          offeredAt: '2026-10-02T11:58:00.000Z',
          notAfter: '2027-10-02T11:58:00.000Z',
          reason: 'missing_server_auth',
        },
        legacyCertificate: false,
        legacyGraceEndsAt: null,
      },
    };
    stream().emit('device.tls.changed', { deviceId: 'd2' });
    expect(
      await screen.findByText(/Certificate renewed for the encrypted management channel/),
    ).toBeTruthy();
  });

  it('says nothing about renewal when there is none to tell', async () => {
    await open('/devices/d2');
    expect(await screen.findByText('Mutual TLS')).toBeTruthy();
    expect(screen.queryByText(/Certificate renew/)).toBeNull();
  });
});

describe('managed services (FR-145)', () => {
  it('lists the services novad declares and acts on each', async () => {
    const { api } = await open('/devices/d1?tab=modules', {
      devices: {
        devices: [DESK()],
        services: { d1: { compute: 'running', 'ollama.service': 'stopped' } },
      },
      ops: {
        serviceMeta: {
          d1: {
            compute: { kind: 'module', module: 'compute', unit: null },
            'ollama.service': { kind: 'systemd', module: null, unit: 'ollama.service' },
          },
        },
      },
    });
    const list = await screen.findByRole('list', { name: 'Managed services' });
    const ollama = await within(list).findByRole('listitem', { name: 'ollama.service' });
    expect(within(ollama).getByText('Stopped')).toBeTruthy();
    expect(within(ollama).getByText('systemd unit ollama.service')).toBeTruthy();
    expect(
      within(within(list).getByRole('listitem', { name: 'compute' })).getByText('Compute module'),
    ).toBeTruthy();
    await userEvent.click(within(ollama).getByRole('button', { name: 'Start ollama.service' }));
    expect(api.deviceServiceAction).toHaveBeenCalledWith('d1', 'ollama.service', 'start');
    expect(await within(ollama).findByText('Running')).toBeTruthy();
    // The by-name form stays below.
    expect(screen.getByRole('combobox', { name: 'Service' })).toBeTruthy();
  });

  it('says an older novad cannot list them, and when the device is offline', async () => {
    await open('/devices/d1?tab=modules', { ops: { oldNovad: ['d1'] } });
    expect(
      await screen.findByText(
        /This device’s novad cannot list its services yet. Update novad on it/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Managed services' })).toBeNull();
    resetDom();
    await open('/devices/d1?tab=modules', {
      devices: { devices: [deviceView({ id: 'd1', name: 'Desk PC', status: 'unreachable' })] },
    });
    const section = await screen.findByRole('region', { name: 'Managed services' });
    expect(within(section).getByText('The device is offline.')).toBeTruthy();
  });
});

describe('available builds (FR-148)', () => {
  it('shows the novad build the Hub serves for the device', async () => {
    await open('/devices/d1?tab=updates', {
      ops: {
        available: {
          d1: {
            deviceId: 'd1',
            current: { novad: '0.7.0' },
            platform: { os: 'linux', arch: 'amd64' },
            novad: {
              version: '0.8.0',
              file: 'novad-linux-amd64',
              sha256: 'f'.repeat(64),
              size: 9 * 1024 ** 2,
            },
            newer: true,
            reason: 'newer_available',
          },
        },
      },
    });
    expect(
      await screen.findByText(
        'This Hub serves novad 0.8.0 for Linux amd64; the device has novad 0.7.0.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/novad-linux-amd64 · 9 MB · SHA-256/)).toBeTruthy();
    expect(screen.getByText(/The Hub does not install it by itself/)).toBeTruthy();
  });

  it('says when the Hub serves none', async () => {
    await open('/devices/d1?tab=updates');
    expect(await screen.findByText('This Hub serves no novad builds.')).toBeTruthy();
  });
});

describe('overrides on the device (FR-142, FR-150)', () => {
  it('says the device has not taken the change yet, and pushes it now', async () => {
    const { api } = await open('/devices/d1?tab=policy', {
      devices: { devices: [deviceView({ id: 'd1', name: 'Desk PC', configPending: true })] },
    });
    expect(await screen.findByText('Waiting for the device: change 3, it has 2')).toBeTruthy();
    await userEvent.click(screen.getByText('In force on the device'));
    expect(screen.getByText('Compute')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Push now' }));
    expect(api.pushDeviceOverrides).toHaveBeenCalledWith('d1');
    expect(await screen.findByText('The device has the latest (change 3)')).toBeTruthy();
  });

  it('cannot push to an offline device', async () => {
    await open('/devices/d1?tab=policy', {
      devices: { devices: [deviceView({ id: 'd1', name: 'Desk PC', status: 'unreachable' })] },
    });
    const section = await screen.findByRole('region', { name: 'On the device' });
    expect(within(section).getByText('The device is offline.')).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Push now' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('decommission (D9)', () => {
  it('needs the name typed, explains purge, files the card and shows the outcome', async () => {
    const { api, hub } = await open('/devices/d1');
    await userEvent.click(await screen.findByRole('button', { name: 'Decommission…' }));
    const d = dialog('Decommission Desk PC?');
    expect(
      within(d).getByText(/stops its modules, deletes its key, credentials and certificate/),
    ).toBeTruthy();
    expect(within(d).getByText(/It cannot be undone/)).toBeTruthy();
    expect(within(d).getByText(/deletes its data folder on that computer/)).toBeTruthy();
    const go = within(d).getByRole('button', { name: 'Ask to decommission Desk PC' });
    expect(go).toHaveProperty('disabled', true);
    await userEvent.type(
      within(d).getByRole('textbox', { name: 'Type Desk PC to confirm' }),
      'Desk',
    );
    expect(go).toHaveProperty('disabled', true);
    await userEvent.type(
      within(d).getByRole('textbox', { name: 'Type Desk PC to confirm' }),
      ' PC',
    );
    await userEvent.click(within(d).getByRole('checkbox', { name: /Also delete its Nova data/ }));
    await userEvent.click(go);
    expect(api.requestDecommission).toHaveBeenCalledWith('d1', { purge: true });

    const section = await screen.findByRole('region', { name: 'Decommission' });
    expect(within(section).getByText('Waiting for your approval')).toBeTruthy();
    expect(within(section).getByText(/its Nova data is deleted too/)).toBeTruthy();
    expect(
      await within(section).findByText(
        /Only you can answer this, in Nova: here or on the Approvals page/,
      ),
    ).toBeTruthy();
    const card = hub.state.m3.approvals[0]!;
    expect(card).toMatchObject({ tool: 'device.decommission', risk: 'high', answerIn: 'hub' });
    await userEvent.click(within(section).getByRole('button', { name: 'Allow once' }));
    expect(await within(section).findByText('Decommissioned')).toBeTruthy();
    expect(
      within(section).getByText(
        'The device wiped its credentials, deleted its Nova data and removed its service, then was revoked.',
      ),
    ).toBeTruthy();
    expect(await screen.findByText(/it can no longer reach this Hub/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Decommission…' })).toBeNull();
  });

  it('revokes an offline device at once, and refuses a second request in plain words', async () => {
    const offline = deviceView({ id: 'd1', name: 'Desk PC', status: 'unreachable' });
    await open('/devices/d1', { devices: { devices: [offline] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Decommission…' }));
    const d = dialog('Decommission Desk PC?');
    expect(
      within(d).getByText(/The device is offline: it wipes its key and credentials/),
    ).toBeTruthy();
    await userEvent.type(
      within(d).getByRole('textbox', { name: 'Type Desk PC to confirm' }),
      'Desk PC',
    );
    await userEvent.click(within(d).getByRole('button', { name: 'Ask to decommission Desk PC' }));
    const section = await screen.findByRole('region', { name: 'Decommission' });

    // A second request while this one waits.
    await userEvent.click(screen.getByRole('button', { name: 'Decommission…' }));
    const again = dialog('Decommission Desk PC?');
    await userEvent.type(
      within(again).getByRole('textbox', { name: 'Type Desk PC to confirm' }),
      'Desk PC',
    );
    await userEvent.click(
      within(again).getByRole('button', { name: 'Ask to decommission Desk PC' }),
    );
    expect((await within(again).findByRole('alert')).textContent).toBe(
      'A decommission of this device is already waiting for your approval.',
    );
    await userEvent.click(within(again).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(await within(section).findByRole('button', { name: 'Allow once' }));
    expect(
      await within(section).findByText(
        'The device did not answer. It is revoked, and wipes its credentials the next time it reaches the Hub.',
      ),
    ).toBeTruthy();
  });

  it('shows a denied request and a refusal by the device', async () => {
    await open('/devices/d2', {
      ops: {
        decommissions: [
          decommissionView({
            id: 'dc9',
            deviceId: 'd2',
            deviceName: 'Lab PC',
            status: 'denied',
            approvalId: null,
          }),
        ],
      },
    });
    const section = await screen.findByRole('region', { name: 'Decommission' });
    expect(within(section).getByText('Denied')).toBeTruthy();
    expect(within(section).getByText(/its Nova data stays on the computer/)).toBeTruthy();
    expect(decommissionResultText('refused', false)).toBe(
      'The device refused. It was revoked anyway.',
    );
    expect(decommissionResultText('not_told', true)).toContain('revoked without being told');
    expect(decommissionResultText(null, true)).toBeNull();
  });
});

describe('compute nodes (FR-126, FR-150)', () => {
  it('shows the node’s state with its GPU memory, and saves its policy', async () => {
    const { api, ops } = await open('/devices/c1', {
      added: { others: [GPU()] },
      ops: { nodes: { c1: fakeNode() } },
    });
    const state = await screen.findByRole('region', { name: 'Compute node' });
    expect(within(state).getByText('Takes jobs')).toBeTruthy();
    expect(within(state).getByText('GPU 0, NVIDIA RTX 4090: 6 GB of 24 GB in use')).toBeTruthy();
    expect(within(state).getByRole('meter', { name: 'GPU 0 memory in use' })).toBeTruthy();
    expect(within(state).getByText('1 running, 0 queued')).toBeTruthy();

    const form = screen.getByRole('form', { name: 'Policy' });
    const save = within(form).getByRole('button', { name: 'Save policy' });
    expect(save).toHaveProperty('disabled', true);
    const quiet = within(form).getByRole('textbox', { name: 'Quiet hours' });
    await userEvent.type(quiet, '25:00-07:00');
    await userEvent.click(save);
    expect(
      within(form).getByText('“25:00-07:00” is not a time range like 22:00-07:00.'),
    ).toBeTruthy();
    expect(api.setNodePolicy).not.toHaveBeenCalled();
    await userEvent.clear(quiet);
    await userEvent.type(quiet, '12:00-14:00');
    await userEvent.selectOptions(
      within(form).getByRole('combobox', { name: 'Time zone' }),
      'Europe/Lisbon',
    );
    await userEvent.click(
      within(form).getByRole('switch', { name: 'Send model work to this node' }),
    );
    await userEvent.click(save);
    expect(api.setNodePolicy).toHaveBeenCalledWith('c1', {
      routingEligible: false,
      quietHours: ['12:00-14:00'],
      timeZone: 'Europe/Lisbon',
    });
    expect(await screen.findByText('Change 1')).toBeTruthy();
    expect(ops.state.nodes.c1?.policy.revision).toBe(1);
    // The Hub announces it; the node is quiet now (13:00 in Lisbon).
    stream().emit('node.policy.changed', { nodeId: 'c1', revision: 1, routingEligible: false });
    expect(await within(state).findByText('Quiet now: no new jobs')).toBeTruthy();
  });

  it('acts on the node’s services, and says when it cannot list them or is offline', async () => {
    const { api } = await open('/devices/c1', {
      added: { others: [GPU()] },
      ops: { nodes: { c1: fakeNode() } },
    });
    const list = await screen.findByRole('list', { name: 'Node services' });
    const jobs = within(list).getByRole('listitem', { name: 'Job API' });
    expect(within(jobs).getByText('Running')).toBeTruthy();
    expect(
      within(within(list).getByRole('listitem', { name: 'Model server' })).getByText(
        'systemd unit ollama.service',
      ),
    ).toBeTruthy();
    await userEvent.click(within(jobs).getByRole('button', { name: 'Stop Job API' }));
    expect(api.nodeServiceAction).toHaveBeenCalledWith('c1', 'jobs', 'stop');
    expect(await within(jobs).findByText('Stopped')).toBeTruthy();

    resetDom();
    await open('/devices/c1', {
      added: { others: [GPU()] },
      ops: { nodes: { c1: fakeNode({ services: 'old' }) } },
    });
    expect(
      await screen.findByText(
        'This node’s nova-compute cannot list its services yet. Update it on the node.',
      ),
    ).toBeTruthy();

    resetDom();
    await open('/devices/c1', {
      added: { others: [{ ...GPU(), status: 'unreachable' }] },
      ops: { nodes: { c1: fakeNode() } },
    });
    expect(await screen.findByText('The node is offline.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Node services' })).toBeNull();
  });

  it('links each node in Settings → Devices to its policy and services', async () => {
    const hub = createHub({
      workspace: workspaceState({ nodes: [computeNode({ id: 'c1', name: 'Desk GPU' })] }),
    });
    await renderApp({ hub, path: '/settings/devices' });
    const link = await screen.findByRole('link', { name: 'Policy and services of Desk GPU' });
    expect(link.getAttribute('href')).toBe('/devices/c1');
  });
});

describe('words', () => {
  it('reads channels, builds, services, VRAM and refusals', () => {
    const v = {
      deviceId: 'd1',
      name: 'Desk PC',
      status: 'active' as const,
      endpoint: null,
      channel: null,
      lastCall: null,
      renewal: null,
      legacyCertificate: false,
      legacyGraceEndsAt: null,
    };
    expect(channelText(v, true)).toBe('The device has not told the Hub where to reach it.');
    expect(renewalText(v)).toBeNull();
    const none = { state: 'none' as const, offeredAt: null, notAfter: null, reason: null };
    expect(renewalText({ ...v, renewal: none })).toBeNull();
    expect(renewalText({ ...v, renewal: none, legacyCertificate: true })).toContain(
      'offers a new one at its next check-in',
    );
    expect(
      renewalText({
        ...v,
        renewal: { state: 'offered', offeredAt: null, notAfter: null, reason: 'expiring' },
      }),
    ).toBe('Certificate renewal offered; the device switches at its next check-in.');
    expect(
      renewalText({
        ...v,
        renewal: {
          state: 'presented',
          offeredAt: null,
          notAfter: '2027-01-01T00:00:00.000Z',
          reason: 'expiring',
        },
      }),
    ).toMatch(/^Certificate renewed; valid until /);
    expect(channelText({ ...v, channel: 'mutual_tls' }, false)).toContain('no client certificate');
    expect(
      availableText({
        deviceId: 'd1',
        current: { novad: null },
        platform: null,
        novad: null,
        newer: false,
        reason: 'unknown_platform',
      }),
    ).toContain('has not said which platform');
    expect(serviceChip('active').text).toBe('Running');
    expect(serviceChip('crash_loop').text).toBe('Failed');
    expect(serviceChip('activating').text).toBe('Activating');
    expect(serviceChip(null).text).toBe('State unknown');
    expect(
      vramText({ index: 1, vendor: null, name: null, totalBytes: null, usedBytes: null }),
    ).toBe('GPU 1: memory not reported');
    const e = (details: Record<string, unknown>) =>
      new ApiError(403, { code: 'policy_denied', message: 'raw', retryable: false, details });
    expect(opsErrorMessage(e({ reason: 'device_tls_failed', tls: 'wrong_device' }))).toBe(
      'The Hub could not reach the device securely: the device’s certificate names another device.',
    );
    expect(opsErrorMessage(e({ reason: 'job_token_rejected' }))).toContain('Add the node again');
    expect(opsErrorMessage(e({ reason: 'owner_only' }))).toBe(
      'Only the owner of this Hub can do that.',
    );
  });
});

it('a member gets the owner-only notice on Devices pages', async () => {
  await open('/devices/d1', { as: 'member' });
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Decommission…' })).toBeNull());
});
