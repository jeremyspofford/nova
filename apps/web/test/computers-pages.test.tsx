// Computers (FR-080, FR-107, FR-195; docs/11 §1-§2, §8): the list names each computer by its
// agent and says where its commands run (and why they cannot), the Hub's sandbox status, the
// settings every computer shares, and one computer's page: its facts, the browser and screen
// slots, resource limits, snapshots (take, restore with confirmation and a safety snapshot,
// delete), a connected device's limits, stop, live updates and a missing computer.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { ComputersView } from '../src/computers/ComputersView.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  computerView,
  renderWithComputers,
  scopeView,
  snapshotView,
  type M6ComputersState,
} from './fakes-m6-computers.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const AGENTS = [
  { id: 'ag1', name: 'Research' },
  { id: 'ag2', name: 'Ops' },
];

const stream = () => FakeEventSource.for('/api/v1/events/stream');

function openList(computers: Partial<M6ComputersState> = {}, opts = {}) {
  return renderWithComputers(<ComputersView computerId={null} />, {
    computers: { agents: AGENTS, ...computers },
    ...opts,
  });
}

describe('the list of computers (FR-080, FR-107)', () => {
  it('names each computer by its agent and says where its commands run', async () => {
    await openList(
      {
        computers: [
          computerView({ id: 'c1', agentId: 'ag1', snapshotCount: 2 }),
          computerView({
            id: 'c2',
            agentId: 'ag2',
            kind: 'cloud',
            substrate: 'cloud_stub',
            provider: 'mock_cloud',
            state: 'stopped',
            lastUsedAt: null,
          }),
          computerView({
            id: 'c3',
            agentId: null,
            kind: 'local_host',
            deviceId: 'd1',
            substrate: 'host',
            state: 'degraded',
            detail: 'The device is not connected.',
          }),
        ],
      },
      { sandbox: { substrate: 'container', available: true, detail: 'podman 5' } },
    );
    const list = await screen.findByRole('list', { name: 'Computers' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const first = within(rows[0]!).getByRole('link', { name: "Research's computer" });
    expect(first.getAttribute('href')).toBe('/computers/c1');
    expect(rows[0]!.textContent).toContain('Sandbox on this Hub');
    expect(rows[0]!.textContent).toContain('Container');
    expect(rows[0]!.textContent).toContain('2 snapshots');
    expect(within(rows[0]!).getByText('Running')).toBeTruthy();
    expect(within(rows[1]!).getByRole('link', { name: "Ops's computer" })).toBeTruthy();
    expect(rows[1]!.textContent).toContain('Cloud runner (mock on this Hub)');
    expect(rows[1]!.textContent).toContain('Last used never');
    // A degraded computer says why, in the Hub's words.
    expect(within(rows[2]!).getByRole('link', { name: 'Connected device' })).toBeTruthy();
    expect(within(rows[2]!).getByText('Limited')).toBeTruthy();
    expect(within(rows[2]!).getByText('The device is not connected.')).toBeTruthy();
    // The Hub's sandbox.
    const sandbox = screen.getByRole('region', { name: 'Sandbox on this Hub' });
    expect(await within(sandbox).findByText(/Commands run in: Container/)).toBeTruthy();
  });

  it('opens a computer from the list in the app', async () => {
    await openList({ computers: [computerView({ id: 'c1' })] });
    await userEvent.click(await screen.findByRole('link', { name: "Research's computer" }));
    expect(window.location.pathname).toBe('/computers/c1');
  });

  it('says when commands cannot run on this Hub (fails closed)', async () => {
    await openList(
      {},
      {
        sandbox: {
          substrate: null,
          available: false,
          detail: 'Bubblewrap is not installed on this Hub, so commands cannot run.',
        },
      },
    );
    const sandbox = screen.getByRole('region', { name: 'Sandbox on this Hub' });
    expect(await within(sandbox).findByText('Commands cannot run on this Hub.')).toBeTruthy();
    expect(
      within(sandbox).getByText('Bubblewrap is not installed on this Hub, so commands cannot run.'),
    ).toBeTruthy();
    expect(within(sandbox).getByText(/never runs agent commands outside a sandbox/)).toBeTruthy();
  });

  it('starts empty with a way to an agent', async () => {
    await openList();
    expect(await screen.findByRole('heading', { name: 'No computers yet' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Go to Agents' }));
    expect(window.location.pathname).toBe('/agents');
  });

  it('reports a list that cannot load and retries', async () => {
    await openList(
      { computers: [computerView({ id: 'c1' })] },
      { fail: { listComputers: new Error('Hub is restarting') } },
    );
    expect(await screen.findByText('Hub is restarting')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Computers' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('Hub is restarting')).toBeNull());
    expect(screen.getByRole('link', { name: "Research's computer" })).toBeTruthy();
  });

  it('follows state changes live', async () => {
    const { state } = await openList({ computers: [computerView({ id: 'c1' })] });
    const list = await screen.findByRole('list', { name: 'Computers' });
    expect(within(list).getByText('Running')).toBeTruthy();
    state.computers = state.computers.map((c) => ({ ...c, state: 'stopped' }));
    stream().emit('computer.state.changed', { computerId: 'c1', from: 'running', to: 'stopped' });
    expect(await within(list).findByText('Stopped')).toBeTruthy();
  });
});

describe('settings for all computers (FR-080, FR-195, docs/11 §8)', () => {
  it('chooses where new agent computers run and turns on micro-VMs', async () => {
    const { hub } = await openList();
    await screen.findByRole('heading', { name: 'No computers yet' });
    await userEvent.click(screen.getByRole('radio', { name: 'Cloud computer' }));
    await waitFor(() => expect(hub.state.settings['computers.agentComputer']).toBe('cloud'));
    const vm = screen.getByRole('switch', { name: 'Micro-VM sandboxes (experimental)' });
    expect(vm.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(vm);
    await waitFor(() =>
      expect(hub.state.settings['computers.microVm']).toEqual({ enabled: true, runner: null }),
    );
  });

  it('checks and saves the limits of every command', async () => {
    const { hub } = await openList();
    await screen.findByRole('heading', { name: 'No computers yet' });
    const cpu = screen.getByRole('spinbutton', { name: 'CPU cores' });
    expect((cpu as HTMLInputElement).value).toBe('2');
    const save = screen.getByRole('button', { name: 'Save limits' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(cpu);
    await userEvent.type(cpu, '100');
    expect(screen.getByText('Between 0.25 and 64.')).toBeTruthy();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(cpu);
    await userEvent.type(cpu, '4');
    const mem = screen.getByRole('spinbutton', { name: 'Memory (MB)' });
    await userEvent.clear(mem);
    await userEvent.type(mem, '4096.5');
    expect(screen.getByText('Enter a whole number.')).toBeTruthy();
    await userEvent.clear(mem);
    await userEvent.type(mem, '4096');
    await userEvent.click(save);
    await waitFor(() =>
      expect(hub.state.settings['computers.limits']).toEqual({
        cpus: 4,
        memoryMb: 4096,
        wallClockSeconds: 300,
      }),
    );
    expect(await screen.findByText('Limits saved.')).toBeTruthy();
  });

  it('locks settings that managed policy sets', async () => {
    await openList({}, { managed: { 'computers.agentComputer': 'cloud' } });
    await screen.findByRole('heading', { name: 'No computers yet' });
    const radio = screen.getByRole<HTMLInputElement>('radio', { name: 'Cloud computer' });
    expect(radio.checked).toBe(true);
    expect(radio.disabled).toBe(true);
    expect(screen.getAllByText('Managed by your organization').length).toBeGreaterThan(0);
  });
});

describe('one computer (FR-080)', () => {
  const C1 = () =>
    computerView({
      id: 'c1',
      agentId: 'ag1',
      snapshotCount: 1,
      baseImage: 'nova/sandbox:1',
    });

  function openComputer(
    computers: Partial<M6ComputersState> = {},
    panels: Parameters<typeof ComputersView>[0] = { computerId: 'c1' },
    opts = {},
  ) {
    return renderWithComputers(<ComputersView {...panels} />, {
      computers: {
        agents: AGENTS,
        computers: [C1()],
        snapshots: [
          snapshotView({ id: 's1', computerId: 'c1', createdAt: '2026-10-01T08:00:00.000Z' }),
        ],
        ...computers,
      },
      ...opts,
    });
  }

  it('shows its facts, its agent, its limits and mounts the browser and screen panels', async () => {
    const browserPanel = vi.fn(() => <div>Browser panel here</div>);
    const screenPanel = vi.fn(() => <div>Screen panel here</div>);
    await openComputer(
      {},
      { computerId: 'c1', browserPanel, screenPanel },
      { settings: { 'computers.limits': { cpus: 1, memoryMb: 4096, wallClockSeconds: 600 } } },
    );
    expect(
      await screen.findByRole('heading', { name: "Research's computer", level: 1 }),
    ).toBeTruthy();
    const agent = screen.getByRole('link', { name: 'Research' });
    expect(agent.getAttribute('href')).toBe('/agents/ag1');
    expect(screen.getByText('nova/sandbox:1')).toBeTruthy();
    expect(screen.getByText('Container')).toBeTruthy();
    expect(screen.getByText('Browser panel here')).toBeTruthy();
    expect(screen.getByText('Screen panel here')).toBeTruthy();
    expect(browserPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }));
    const limits = screen.getByRole('region', { name: 'Resource limits' });
    expect(limits.textContent).toContain('1 core');
    expect(limits.textContent).toContain('4 GB');
    expect(limits.textContent).toContain('10 min');
    // Its network: the agent's rule is summarized, with a way to the settings.
    const net = screen.getByRole('region', { name: 'Network' });
    expect(await within(net).findByText(/no rule for Research/)).toBeTruthy();
    expect(
      within(net).getByRole('link', { name: 'Network settings and the decision log' }),
    ).toBeTruthy();
  });

  it("summarizes its agent's network rule", async () => {
    await openComputer({
      scopes: [
        scopeView({ kind: 'agent', id: 'ag1', mode: 'limited', allow: ['a.test', 'b.test'] }),
      ],
    });
    const net = await screen.findByRole('region', { name: 'Network' });
    expect(
      await within(net).findByText(/Research has its own rule: read-only, 2 more allowed hosts\./),
    ).toBeTruthy();
  });

  it('takes a labelled snapshot', async () => {
    const { api, state } = await openComputer();
    await screen.findByRole('heading', { name: "Research's computer", level: 1 });
    await userEvent.click(screen.getByRole('button', { name: /Take a snapshot/ }));
    const dialog = screen.getByRole('dialog', { name: 'Take a snapshot' });
    await userEvent.type(within(dialog).getByLabelText('Label (optional)'), 'Clean install');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Take snapshot' }));
    expect(api.createComputerSnapshot).toHaveBeenCalledWith('c1', { label: 'Clean install' });
    expect(await screen.findByText('Snapshot “Clean install” taken.')).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Snapshots' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(state.computers[0]?.snapshotCount).toBe(2);
  });

  it('restores a snapshot after confirming, keeping a snapshot of the current files first', async () => {
    const { api, state } = await openComputer();
    const list = await screen.findByRole('list', { name: 'Snapshots' });
    await userEvent.click(
      within(list).getByRole('button', { name: /^Restore Before the upgrade/ }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Restore this snapshot?' });
    expect(dialog.textContent).toContain('Changes made since then are lost');
    const keep = within(dialog).getByRole<HTMLInputElement>('checkbox', {
      name: 'Take a snapshot of the current files first',
    });
    expect(keep.checked).toBe(true);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(state.restores).toEqual([{ computerId: 'c1', snapshotId: 's1' }]));
    expect(api.createComputerSnapshot).toHaveBeenCalledWith('c1', {
      label: 'Before restoring Before the upgrade',
    });
    // The safety snapshot was taken before the restore.
    expect(api.createComputerSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      api.restoreComputer.mock.invocationCallOrder[0]!,
    );
    expect(await screen.findByText(/Restored the snapshot from/)).toBeTruthy();
  });

  it('restores without a safety snapshot when unticked, and shows a failure in the dialog', async () => {
    const { api, computers } = await openComputer();
    const list = await screen.findByRole('list', { name: 'Snapshots' });
    computers.failNext.restoreComputer = new ApiError(404, {
      code: 'not_found',
      message: 'no such snapshot',
      retryable: false,
    });
    await userEvent.click(
      within(list).getByRole('button', { name: /^Restore Before the upgrade/ }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Restore this snapshot?' });
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect(await within(dialog).findByText('no such snapshot')).toBeTruthy();
    expect(api.createComputerSnapshot).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('deletes a snapshot after confirming', async () => {
    const { api, state } = await openComputer();
    const list = await screen.findByRole('list', { name: 'Snapshots' });
    await userEvent.click(within(list).getByRole('button', { name: /^Delete Before the upgrade/ }));
    const dialog = screen.getByRole('dialog', { name: 'Delete this snapshot?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.deleteComputerSnapshot).not.toHaveBeenCalled();
    await userEvent.click(within(list).getByRole('button', { name: /^Delete Before the upgrade/ }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Delete this snapshot?' })).getByRole('button', {
        name: 'Delete snapshot',
      }),
    );
    await waitFor(() => expect(state.snapshots).toHaveLength(0));
    expect(await screen.findByText(/No snapshots yet/)).toBeTruthy();
  });

  it("a connected device's computer has no snapshots or limits here, and says why", async () => {
    await openComputer({
      computers: [
        computerView({
          id: 'c1',
          kind: 'local_host',
          agentId: null,
          deviceId: 'd1',
          substrate: 'host',
          provider: 'novad',
          state: 'stopped',
          detail: 'The device is not connected.',
        }),
      ],
      snapshots: [],
    });
    expect(await screen.findByRole('heading', { name: 'Connected device', level: 1 })).toBeTruthy();
    expect(screen.getByText('The device is not connected.')).toBeTruthy();
    expect(screen.getByText(/its files are managed on the device/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Take a snapshot/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Resource limits' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Manage in Settings, Devices' })).toBeTruthy();
  });

  it('shows why a degraded computer cannot run commands', async () => {
    await openComputer({
      computers: [
        computerView({
          id: 'c1',
          state: 'degraded',
          detail:
            'Micro-VM sandboxes are turned off. Files can still be read and written; commands are unavailable.',
        }),
      ],
    });
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain('commands are unavailable');
    expect(screen.getByText('Limited')).toBeTruthy();
  });

  it('stops a running computer', async () => {
    const { api } = await openComputer();
    await screen.findByRole('heading', { name: "Research's computer", level: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(api.stopComputer).toHaveBeenCalledWith('c1');
    expect(await screen.findByText('Stopped')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('follows events about this computer only', async () => {
    const { api, state } = await openComputer();
    await screen.findByRole('heading', { name: "Research's computer", level: 1 });
    const calls = api.getComputer.mock.calls.length;
    stream().emit('computer.state.changed', {
      computerId: 'other',
      from: 'running',
      to: 'stopped',
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(api.getComputer.mock.calls.length).toBe(calls);
    state.computers = state.computers.map((c) => ({
      ...c,
      state: 'degraded',
      detail: 'Proxy down.',
    }));
    stream().emit('computer.state.changed', { computerId: 'c1', from: 'running', to: 'degraded' });
    expect(await screen.findByText('Proxy down.')).toBeTruthy();
  });

  it('says when the computer does not exist', async () => {
    await openComputer({ computers: [] }, { computerId: 'gone' });
    expect(await screen.findByRole('heading', { name: 'Computer not found' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'All computers' }));
    expect(window.location.pathname).toBe('/computers');
  });

  it('reports a computer that cannot load and retries', async () => {
    await openComputer(
      {},
      { computerId: 'c1' },
      { fail: { getComputer: new Error('Hub is restarting') } },
    );
    expect(await screen.findByText('Hub is restarting')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('heading', { name: "Research's computer", level: 1 }),
    ).toBeTruthy();
    expect(screen.queryByText('Hub is restarting')).toBeNull();
  });

  it('reloads after a restore event from elsewhere', async () => {
    const { api } = await openComputer();
    await screen.findByRole('heading', { name: "Research's computer", level: 1 });
    const calls = api.listComputerSnapshots.mock.calls.length;
    stream().emit('computer.restored', { computerId: 'c1', snapshotId: 's1' });
    await waitFor(() => expect(api.listComputerSnapshots.mock.calls.length).toBeGreaterThan(calls));
  });
});
