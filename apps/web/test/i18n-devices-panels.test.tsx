// A device's tabs in the pseudo-locale (FR-016): every word the Capabilities, Modules and
// services, Power, Updates, Policy, Files (access requests, folders, grants, staged writes) and
// Agents tabs show, an agent's connected computer, and a compute node's panel come from messages,
// including their dialogs and field errors. Fixture data (device, agent and service names, paths,
// versions, what the device reports about itself) is passed as `data`. The panels are rendered
// directly, the way the device page renders them.
import { useState, type ComponentType, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { DeviceView } from '@nova/shared';
import { CAPABILITIES_TEXT, CapabilitiesPanel } from '../src/devices/Capabilities.tsx';
import {
  AgentComputerPanel,
  CONNECTIONS_TEXT,
  DeviceAgentsPanel,
} from '../src/devices/Connections.tsx';
import type { PanelProps } from '../src/devices/DevicePage.tsx';
import { FILES_TEXT, FilesPanel } from '../src/devices/Files.tsx';
import { DEVICES_TEXT, formatBytes, moduleLabel } from '../src/devices/format.ts';
import { MODULES_TEXT, ModulesPanel } from '../src/devices/Modules.tsx';
import { NODE_TEXT, NodePanel } from '../src/devices/NodePanel.tsx';
import { PARTS_TEXT } from '../src/devices/parts.tsx';
import { POLICY_TEXT, PolicyPanel } from '../src/devices/Policy.tsx';
import { POWER_TEXT, PowerPanel } from '../src/devices/Power.tsx';
import { SERVICES_TEXT } from '../src/devices/Services.tsx';
import { STAGED_TEXT } from '../src/devices/StagedWrites.tsx';
import { UPDATES_TEXT, UpdatesPanel } from '../src/devices/Updates.tsx';
import {
  ACCOUNT_ID,
  MAC,
  agentChoice,
  bundle,
  connectionView,
  deviceView,
  grantView,
  moduleView,
  pendingRequest,
  stagedView,
  updateView,
} from './fakes-m6-devices.ts';
import { summaryView } from './fakes-m65-devices.ts';
import { fakeNode, renderWithM75 } from './fakes-m75-devops.ts';
import { resetDom } from './render.tsx';
import { activateTestLocale, expectFullyLocalized, resetTestLocale } from './i18n.ts';

afterEach(() => {
  resetDom();
  resetTestLocale();
});

const SCOUT = agentChoice('ag1', 'Scout');
const SCRIBE = agentChoice('ag2', 'Scribe');

/** What the fixture device reports about itself (its capability document). */
const REPORTED = ['x86_64', 'RTX 4070', 'linux 6.8', 'bubblewrap', 'llama.cpp', 'Europe/Lisbon'];

/** A device tab with the device page's props: the device, kept up to date by the panel. */
function Tab({ of: P, device }: { of: ComponentType<PanelProps>; device: DeviceView }) {
  const [d, setD] = useState(device);
  return <P device={d} onDevice={setD} reload={() => undefined} deviceName={() => null} />;
}

async function show(ui: ReactElement, opts: Parameters<typeof renderWithM75>[1] = {}) {
  await activateTestLocale('en-XA');
  return renderWithM75(ui, opts);
}

const dialog = () => screen.getByRole('dialog');

describe('a device’s tabs in a pseudo-locale', () => {
  it('shows Capabilities localized, with what needs an update and a bad override', async () => {
    const device = deviceView({ id: 'd1', name: 'Desk PC', novadVersion: '0.6.0' });
    const { container } = await show(<Tab of={CapabilitiesPanel} device={device} />, {
      devices: { devices: [device] },
    });
    const C = CAPABILITIES_TEXT;
    expect(C.status.title).toMatch(/^\[/);
    await screen.findByRole('heading', { name: C.status.title });
    await userEvent.type(screen.getByRole('textbox', { name: C.fields.maxConcurrentJobs }), 'x');
    await userEvent.type(screen.getByRole('textbox', { name: C.fields.thermalLimitC }), '200');
    await userEvent.click(screen.getByRole('button', { name: C.overrides.save }));
    expect(screen.getByText(C.invalid.whole)).toBeTruthy();
    expect(screen.getByText(C.invalid.range({ min: 30, max: 120 }))).toBeTruthy();
    expectFullyLocalized(container, { data: [...REPORTED, 'en-GB'] });
  });

  it('shows Modules and services localized, with a crash loop, a roll back and a result', async () => {
    const device = deviceView({
      id: 'd1',
      name: 'Desk PC',
      policy: { allowedModules: ['management', 'storage', 'browser'] },
      modules: [
        moduleView({ name: 'management' }),
        moduleView({
          name: 'storage',
          version: '0.7.1',
          previousVersion: '0.7.0',
          restarts: 3,
          lastExit: 'signal 11',
        }),
        moduleView({ name: 'browser', state: 'disabled', disabledReason: 'crash_loop' }),
        moduleView({ name: 'screen', state: 'stopped' }),
      ],
    });
    const { container } = await show(<Tab of={ModulesPanel} device={device} />, {
      devices: {
        devices: [device],
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
    const M = MODULES_TEXT;
    await screen.findByRole('list', { name: M.title });
    await screen.findByRole('list', { name: SERVICES_TEXT.title });
    const data = ['signal 11', 'ollama.service', 'compute'];
    expectFullyLocalized(container, { data });

    // A module action's toast, and the roll back confirmation.
    await userEvent.click(
      screen.getByRole('button', { name: M.restartModule({ module: moduleLabel('storage') }) }),
    );
    expect(
      await screen.findByText(M.nowState({ module: moduleLabel('storage'), state: 'running' })),
    ).toBeTruthy();
    await userEvent.click(
      screen.getByRole('button', { name: M.rollBackModule({ module: moduleLabel('storage') }) }),
    );
    expectFullyLocalized(dialog());
    await userEvent.click(within(dialog()).getByRole('button', { name: PARTS_TEXT.cancel }));

    // A service by name: the device's own words for its state and kind stay as they are.
    const field = screen.getByRole('combobox', { name: M.services.field });
    await userEvent.type(field, 'compute{Enter}');
    const byName = screen.getByRole('region', { name: M.services.title });
    await within(byName).findByText('compute');
    expectFullyLocalized(byName, { data: ['compute', 'running', 'module'] });
    await userEvent.clear(field);
    await userEvent.type(field, 'bad name!');
    expect(screen.getByText(M.services.badName)).toBeTruthy();
    expectFullyLocalized(container, { data: [...data, 'running', 'module', 'bad name!'] });
  });

  it('shows Power localized, with the Wake-on-LAN steps and a confirmation', async () => {
    const device = deviceView({ id: 'd1', name: 'Desk PC' });
    const { container } = await show(<Tab of={PowerPanel} device={device} />, {
      devices: {
        devices: [device],
        power: { d1: { wakeable: true, macs: [MAC], ac: true, afterPowerLoss: 'last' } },
      },
    });
    const P = POWER_TEXT;
    expect(await screen.findByText(P.afterLoss.last)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: P.showSteps }));
    expect(await screen.findByText(P.elevation)).toBeTruthy();
    const data = [MAC, 'Desk PC'];
    expectFullyLocalized(container, { data });
    await userEvent.click(screen.getByRole('button', { name: P.apply }));
    expectFullyLocalized(dialog(), { data });
    await userEvent.click(within(dialog()).getByRole('button', { name: PARTS_TEXT.cancel }));
    await userEvent.click(screen.getByRole('button', { name: P.actions.shutdown.label }));
    expectFullyLocalized(dialog(), { data });
  });

  it('shows Updates localized, with what needs a newer novad, the history and an install', async () => {
    const device = deviceView({
      id: 'd1',
      name: 'Desk PC',
      novadVersion: '0.6.0',
      modules: [
        moduleView({ name: 'management' }),
        moduleView({ name: 'storage', version: '0.7.1', previousVersion: '0.7.0' }),
      ],
    });
    const { container } = await show(<Tab of={UpdatesPanel} device={device} />, {
      devices: {
        devices: [device],
        updates: [
          updateView({
            deviceId: 'd1',
            target: 'storage',
            status: 'rolled_back',
            detail: 'health check failed',
          }),
        ],
      },
    });
    const U = UPDATES_TEXT;
    await screen.findByRole('list', { name: U.historyList });
    const data = ['health check failed', 'Desk PC'];
    const input = screen.getByLabelText(U.bundles);
    await userEvent.upload(input, new File(['hello'], 'x.json', { type: 'application/json' }));
    expect((await screen.findByRole('alert')).textContent).toBe(U.notJson);
    expectFullyLocalized(container, { data });

    const file = JSON.stringify({
      bundles: [bundle('novad', '0.7.0'), bundle('storage', '0.7.0')],
    });
    await userEvent.upload(input, new File([file], 'u.json', { type: 'application/json' }));
    await screen.findByRole('dialog', { name: U.installTitle({ n: 2, device: 'Desk PC' }) });
    expectFullyLocalized(dialog(), { data });
  });

  it('shows Policy localized, with its field errors', async () => {
    const device = deviceView({ id: 'd1', name: 'Desk PC' });
    const { container } = await show(<Tab of={PolicyPanel} device={device} />, {
      devices: { devices: [device] },
    });
    const P = POLICY_TEXT;
    await screen.findByRole('switch', { name: P.routingLabel });
    await userEvent.click(screen.getByRole('checkbox', { name: P.everyModule }));
    await userEvent.click(screen.getByRole('checkbox', { name: moduleLabel('management') }));
    await userEvent.type(screen.getByRole('textbox', { name: P.quiet }), 'late');
    await userEvent.type(screen.getByRole('textbox', { name: P.memory }), '10');
    await userEvent.click(screen.getByRole('button', { name: P.save }));
    expect(screen.getByText(P.badRange({ text: 'late' }))).toBeTruthy();
    expect(screen.getByText(P.wholeRange({ min: 64, max: 1_048_576 }))).toBeTruthy();
    expectFullyLocalized(container, { data: ['late', 'Desk PC'] });
  });

  it('shows Files localized: a request, a folder, a preview, grants, sharing and a staged write', async () => {
    const device = deviceView({ id: 'd1', name: 'Desk PC' });
    const { container } = await show(<Tab of={FilesPanel} device={device} />, {
      devices: {
        devices: [device],
        agents: [SCOUT, SCRIBE],
        fs: {
          d1: {
            '/home/sam/notes': null,
            '/home/sam/notes/todo.md': '# Todo\nbuy milk\n',
            '/home/sam/notes/drafts': null,
            '/home/sam/notes/photo.bin': 'PNG\u0000\u0001',
          },
        },
        grants: [
          grantView({ deviceId: 'd1', grantee: { kind: 'user', id: ACCOUNT_ID } }),
          grantView({
            deviceId: 'd1',
            grantee: { kind: 'agent', id: 'ag2' },
            kind: 'mcp',
            target: 'notes',
            decidedBy: 'device',
          }),
          pendingRequest({
            deviceId: 'd1',
            target: '/home/sam/projects',
            reason: 'To keep the todo list current',
          }),
        ],
        staged: [stagedView({ id: 'w1', deviceId: 'd1' })],
      },
    });
    const F = FILES_TEXT;
    const data = [
      'Desk PC',
      'Scout',
      'Scribe',
      'notes',
      '/home/sam/notes',
      '/home/sam/notes/todo.md',
      '/home/sam/projects',
      'To keep the todo list current',
      'todo.md',
      'drafts',
      'photo.bin',
    ];
    await screen.findByRole('list', { name: F.requests.title });
    await userEvent.click(await screen.findByRole('button', { name: '/home/sam/notes' }));
    await screen.findByRole('list', { name: F.browse.contents({ path: '/home/sam/notes' }) });
    await userEvent.click(screen.getByRole('button', { name: /photo\.bin/ }));
    expect(await screen.findByText(F.preview.binary({ size: formatBytes(5) }))).toBeTruthy();
    await screen.findByRole('region', {
      name: F.preview.label({ path: '/home/sam/notes/photo.bin' }),
    });
    await screen.findByRole('list', { name: STAGED_TEXT.title });
    expectFullyLocalized(container, { data: [...data, '/home/sam/notes/photo.bin'] });

    // The dialogs: share, add a folder, revoke.
    await userEvent.click(screen.getByRole('button', { name: F.grants.share }));
    await userEvent.click(within(dialog()).getByRole('button', { name: F.share.submit }));
    expect(within(dialog()).getByText(F.share.needAgent)).toBeTruthy();
    expectFullyLocalized(dialog(), { data });
    await userEvent.click(within(dialog()).getByRole('button', { name: PARTS_TEXT.cancel }));
    await userEvent.click(screen.getByRole('button', { name: F.browse.addFolder }));
    await userEvent.type(within(dialog()).getByRole('textbox', { name: F.folder }), 'notes');
    await userEvent.click(within(dialog()).getByRole('button', { name: F.ask.submit }));
    expectFullyLocalized(dialog(), { data });
    await userEvent.click(within(dialog()).getByRole('button', { name: PARTS_TEXT.cancel }));
    const grants = screen.getByRole('list', { name: F.grants.list });
    await userEvent.click(
      within(grants).getByRole('button', {
        name: F.grants.revokeRow({ who: DEVICES_TEXT.grantee.you, target: '/home/sam/notes' }),
      }),
    );
    expectFullyLocalized(dialog(), { data });
    await userEvent.click(within(dialog()).getByRole('button', { name: PARTS_TEXT.cancel }));

    // A staged write's review.
    await userEvent.click(
      screen.getByRole('button', { name: STAGED_TEXT.review({ path: '/home/sam/notes/todo.md' }) }),
    );
    await screen.findByRole('button', { name: STAGED_TEXT.commit });
    expect(screen.getByText(STAGED_TEXT.counts({ added: 1, removed: 1 }))).toBeTruthy();
    expectFullyLocalized(container, { data });
  });

  it('shows Agents localized, with an earlier connection and the connect dialog', async () => {
    const device = deviceView({ id: 'd1', name: 'Desk PC', novadVersion: '0.6.0' });
    const { container } = await show(<Tab of={DeviceAgentsPanel} device={device} />, {
      devices: {
        devices: [device],
        agents: [SCOUT, SCRIBE],
        connections: [
          connectionView({ agentId: 'ag1', deviceId: 'd1' }),
          connectionView({
            agentId: 'ag2',
            deviceId: 'd1',
            status: 'revoked',
            revokedAt: '2026-10-01T13:00:00.000Z',
          }),
        ],
      },
    });
    const C = CONNECTIONS_TEXT;
    await screen.findByRole('list', { name: C.connected });
    await screen.findByText('Scout');
    const data = ['Desk PC', 'Scout', 'Scribe'];
    expectFullyLocalized(container, { data });
    await userEvent.click(screen.getByRole('button', { name: C.connectAgent }));
    expect(
      screen.getByRole('dialog', { name: C.dialog.titleDevice({ device: 'Desk PC' }) }),
    ).toBeTruthy();
    expectFullyLocalized(dialog(), { data });
    await userEvent.click(within(dialog()).getByRole('button', { name: PARTS_TEXT.cancel }));
    await userEvent.click(
      screen.getByRole('button', { name: C.disconnectName({ name: 'Scout' }) }),
    );
    expectFullyLocalized(dialog(), { data });
  });

  it("shows an agent's connected computer localized, and its connect dialog", async () => {
    const device = deviceView({ id: 'd1', name: 'Desk PC' });
    const fenced = deviceView({ id: 'd2', name: 'Fenced', policy: { routingEligible: false } });
    const { container } = await show(<AgentComputerPanel agentId="ag1" agentName="Scout" />, {
      devices: {
        devices: [device, fenced],
        agents: [SCOUT],
        connections: [connectionView({ agentId: 'ag1', deviceId: 'd1' })],
      },
    });
    const C = CONNECTIONS_TEXT;
    await screen.findByRole('link', { name: 'Desk PC' });
    const data = ['Desk PC', 'Scout', 'Fenced'];
    expectFullyLocalized(container, { data });
    await userEvent.click(screen.getByRole('button', { name: C.computer.change }));
    await screen.findByRole('combobox', { name: C.dialog.device });
    expectFullyLocalized(dialog(), { data });
  });

  it("shows a compute node's panel localized, with a bad quiet-hours entry", async () => {
    const gpu = summaryView({
      id: 'c1',
      name: 'GPU box',
      kind: 'compute',
      addedAs: null,
      roles: ['compute'],
      platform: 'linux',
      sessions: 0,
    });
    const { container } = await show(<NodePanel deviceId="c1" />, {
      added: { others: [gpu] },
      ops: { nodes: { c1: fakeNode() } },
    });
    const N = NODE_TEXT;
    await screen.findByRole('list', { name: N.services.list });
    const quiet = screen.getByRole('textbox', { name: N.policy.quiet });
    await userEvent.type(quiet, '25:00-07:00');
    await userEvent.click(screen.getByRole('button', { name: N.policy.save }));
    expect(screen.getByText(N.policy.badRange({ text: '25:00-07:00' }))).toBeTruthy();
    // The time zone picker lists the IANA zone ids, which are data.
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const zones = (intl.supportedValuesOf?.('timeZone') ?? []).map((z) => z.replace(/_/g, ' '));
    expectFullyLocalized(container, {
      data: ['NVIDIA RTX 4090', 'ollama.service', ...zones],
    });
  });
});
