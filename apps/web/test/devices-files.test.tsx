// Device files and sharing (FR-210), agents' connected computers (FR-081) and local MCP servers:
// browsing and previewing the folders shared with you, asking for a folder, answering access
// requests through their approval cards, sharing and revoking, reviewing staged writes (commit,
// a conflict said plainly, discard), connecting an agent (and replacing its other computer), and
// the read-only list of the device's MCP servers.
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentComputerPanel } from '../src/devices/Connections.tsx';
import { DevicesView } from '../src/devices/DevicesView.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  ACCOUNT_ID,
  agentChoice,
  connectionView,
  deviceView,
  grantView,
  pendingRequest,
  renderWithDevices,
  stagedView,
  type M6DevicesState,
} from './fakes-m6-devices.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');

const FS = {
  '/': null,
  '/home': null,
  '/home/sam': null,
  '/home/sam/notes': null,
  '/home/sam/notes/todo.md': '# Todo\nbuy milk\n',
  '/home/sam/notes/drafts': null,
  '/home/sam/notes/drafts/idea.txt': 'An idea.',
  '/home/sam/notes/photo.bin': 'PNG\u0000\u0001',
  '/home/sam/notes/big.log': 'x'.repeat(300 * 1024),
  '/home/sam/projects': null,
};

const SCOUT = agentChoice('ag1', 'Scout');
const SCRIBE = agentChoice('ag2', 'Scribe');

function open(tab: string, devices: Partial<M6DevicesState> = {}, over = {}) {
  window.history.replaceState(null, '', `/devices/d1?tab=${tab}`);
  return renderWithDevices(<DevicesView deviceId="d1" />, {
    devices: {
      devices: [deviceView({ id: 'd1', name: 'Desk PC', ...over })],
      fs: { d1: { ...FS } },
      agents: [SCOUT, SCRIBE],
      ...devices,
    },
  });
}

const mine = (target = '/home/sam/notes', access: 'read' | 'write' = 'read') =>
  grantView({ deviceId: 'd1', grantee: { kind: 'user', id: ACCOUNT_ID }, target, access });

describe('browsing the folders shared with you (FR-210)', () => {
  it('lists a folder, opens a subfolder, and previews text, binary and large files', async () => {
    const { api } = await open('files', { grants: [mine()] });
    await userEvent.click(await screen.findByRole('button', { name: '/home/sam/notes' }));
    const list = await screen.findByRole('list', { name: 'Contents of /home/sam/notes' });
    // Folders first.
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      expect.stringContaining('drafts'),
      expect.stringContaining('big.log'),
      expect.stringContaining('photo.bin'),
      expect.stringContaining('todo.md'),
    ]);
    await userEvent.click(within(list).getByRole('button', { name: /todo\.md/ }));
    expect(api.readDeviceFile).toHaveBeenCalledWith('d1', '/home/sam/notes/todo.md', 256 * 1024);
    expect((await screen.findByLabelText('Contents of /home/sam/notes/todo.md')).textContent).toBe(
      '# Todo\nbuy milk\n',
    );

    await userEvent.click(within(list).getByRole('button', { name: /photo\.bin/ }));
    expect(
      await screen.findByText(/This file is not text \(5 B\), so it is not shown\./),
    ).toBeTruthy();

    await userEvent.click(within(list).getByRole('button', { name: /big\.log/ }));
    expect(await screen.findByText('Showing the first 256 KB of 300 KB.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Close preview' }));

    await userEvent.click(within(list).getByRole('button', { name: /drafts/ }));
    const sub = await screen.findByRole('list', { name: 'Contents of /home/sam/notes/drafts' });
    expect(sub.textContent).toContain('idea.txt');
    const crumbs = screen.getByRole('navigation', { name: 'Folder path' });
    expect(within(crumbs).getByText('drafts').getAttribute('aria-current')).toBe('location');
    await userEvent.click(within(crumbs).getByRole('button', { name: '/home/sam/notes' }));
    expect(await screen.findByRole('list', { name: 'Contents of /home/sam/notes' })).toBeTruthy();
  });

  it('adds a folder for yourself (granted at once) and refuses a protected one', async () => {
    const { api } = await open('files');
    expect(
      await screen.findByText(/No folders on this device are shared with you yet/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a folder' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a folder' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Folder' }), 'notes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add folder' }));
    expect(within(dialog).getByText(/Enter a full path/)).toBeTruthy();
    const field = within(dialog).getByRole('textbox', { name: 'Folder' });
    await userEvent.clear(field);
    await userEvent.type(field, '/home/sam/.ssh');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add folder' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'That path is protected and is never shared or written.',
    );
    await userEvent.clear(field);
    await userEvent.type(field, '/home/sam/projects');
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Access' }),
      'write',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add folder' }));
    expect(api.requestDeviceAccess).toHaveBeenLastCalledWith('d1', {
      path: '/home/sam/projects',
      access: 'write',
    });
    expect(await screen.findByText('/home/sam/projects is shared with you.')).toBeTruthy();
    // It opens at once.
    expect(await screen.findByText('This folder is empty.')).toBeTruthy();
  });

  it('is unavailable while the device is offline', async () => {
    await open('files', { grants: [mine()] }, { status: 'unreachable' });
    expect((await screen.findAllByText('The device is offline.')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Add a folder' })).toBeNull();
    expect(await screen.findByRole('button', { name: '/home/sam/notes' })).toHaveProperty(
      'disabled',
      true,
    );
  });
});

describe('access requests (FR-210)', () => {
  it('shows a pending request as a card and allows it through its approval card', async () => {
    const req = pendingRequest({
      deviceId: 'd1',
      target: '/home/sam/notes',
      reason: 'To keep the todo list current',
    });
    const { hub, state } = await open('files', { grants: [req] });
    const card = await screen.findByRole('listitem', {
      name: 'Agent Scout asks for /home/sam/notes',
    });
    expect(card.textContent).toContain('Agent Scout asks to read and change /home/sam/notes');
    // The requester's reason is its words, labelled, shown as text.
    expect(card.textContent).toContain(
      'Reason given by the requester: To keep the todo list current',
    );
    await userEvent.click(
      within(card).getByRole('button', {
        name: 'Allow Agent Scout to read and change /home/sam/notes',
      }),
    );
    expect(hub.api.decideApproval).toHaveBeenCalledWith({
      approvalId: req.approvalId,
      decision: 'allow_once',
    });
    // The grant is now listed; the card is gone.
    const grants = await screen.findByRole('list', { name: 'Grants' });
    expect(within(grants).getByText('/home/sam/notes')).toBeTruthy();
    expect(within(grants).getByText('Agent Scout')).toBeTruthy();
    expect(within(grants).getByText('Read and change')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Access requests' })).toBeNull();
    expect(state.grants[0]!.status).toBe('granted');
  });

  it('denies a request, and says when it was already answered on the device', async () => {
    const a = pendingRequest({ deviceId: 'd1', target: '/home/sam/notes', access: 'read' });
    const b = pendingRequest({
      deviceId: 'd1',
      grantee: { kind: 'run', id: 'run7' },
      target: '/home/sam/projects',
    });
    const noCard = pendingRequest({
      deviceId: 'd1',
      grantee: { kind: 'session', id: 's1' },
      target: '/home',
      approvalId: null,
    });
    const { hub } = await open('files', { grants: [a, b, noCard] });
    const cardA = await screen.findByRole('listitem', {
      name: 'Agent Scout asks for /home/sam/notes',
    });
    await userEvent.click(within(cardA).getByRole('button', { name: /^Deny/ }));
    expect(hub.api.decideApproval).toHaveBeenCalledWith({
      approvalId: a.approvalId,
      decision: 'deny_continue',
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('listitem', { name: 'Agent Scout asks for /home/sam/notes' }),
      ).toBeNull(),
    );

    // Answered on the device first: the card is answered already.
    hub.state.m3.approvals = hub.state.m3.approvals.map((x) =>
      x.id === b.approvalId
        ? { ...x, status: 'decided', decision: null, decidedBy: 'device:d1' }
        : x,
    );
    const cardB = screen.getByRole('listitem', {
      name: 'Work run run7 asks for /home/sam/projects',
    });
    await userEvent.click(within(cardB).getByRole('button', { name: /^Allow/ }));
    expect(
      await screen.findByText('This request was already answered, maybe on the device.'),
    ).toBeTruthy();

    // A request without a Hub card is answered on the device.
    const cardC = screen.getByRole('listitem', { name: 'Code session s1 asks for /home' });
    expect(cardC.textContent).toContain('Answer this on the device (Desk PC).');
  });

  it('follows requests that arrive live', async () => {
    const { state } = await open('files');
    await screen.findByText(/No folders on this device are shared with you yet/);
    state.grants = [pendingRequest({ deviceId: 'd1', target: '/home/sam' })];
    stream().emit('device.access.requested', { deviceId: 'd1', requestId: 'x' });
    expect(await screen.findByRole('list', { name: 'Access requests' })).toBeTruthy();
  });
});

describe('sharing and revoking (FR-210)', () => {
  it('shares a folder with an agent and a server with a run, and revokes after a confirmation', async () => {
    const { api } = await open('files', { grants: [mine()] });
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }));
    let dialog = screen.getByRole('dialog', { name: 'Share on Desk PC' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    expect(within(dialog).getByText('Choose an agent.')).toBeTruthy();
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Agent' }), 'ag2');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Folder' }),
      '/home/sam/projects',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    expect(api.createDeviceGrant).toHaveBeenCalledWith('d1', {
      kind: 'folder',
      grantee: { kind: 'agent', id: 'ag2' },
      path: '/home/sam/projects',
      access: 'read',
    });
    expect(await screen.findByText('/home/sam/projects is shared with Agent Scribe.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Share' }));
    dialog = screen.getByRole('dialog', { name: 'Share on Desk PC' });
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'With' }), 'run');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Work run ID' }), 'run9');
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'What' }), 'mcp');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Server name' }), 'notes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    expect(api.createDeviceGrant).toHaveBeenLastCalledWith('d1', {
      kind: 'mcp',
      grantee: { kind: 'run', id: 'run9' },
      server: 'notes',
    });

    const grants = await screen.findByRole('list', { name: 'Grants' });
    await waitFor(() => expect(within(grants).getAllByRole('listitem')).toHaveLength(3));
    const row = within(grants).getByRole('listitem', { name: 'Agent Scribe: /home/sam/projects' });
    await userEvent.click(within(row).getByRole('button', { name: /^Revoke/ }));
    const confirm = screen.getByRole('dialog', { name: 'Revoke access?' });
    expect(confirm.textContent).toContain(
      'Agent Scribe can no longer reach /home/sam/projects on Desk PC.',
    );
    await userEvent.click(within(confirm).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(within(grants).getAllByRole('listitem')).toHaveLength(2));
  });

  it('shares with yourself using your account, and shows a refusal', async () => {
    const { api } = await open('files', { agents: [] });
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }));
    const dialog = screen.getByRole('dialog', { name: 'Share on Desk PC' });
    // No agents: it starts on You.
    expect(within(dialog).getByRole('combobox', { name: 'With' })).toHaveProperty('value', 'user');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Folder' }), '/nowhere');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Share' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'the folder does not exist on this device',
    );
    expect(api.createDeviceGrant).toHaveBeenCalledWith('d1', {
      kind: 'folder',
      grantee: { kind: 'user', id: ACCOUNT_ID },
      path: '/nowhere',
      access: 'read',
    });
  });
});

describe('staged writes (FR-210)', () => {
  it('lists waiting writes, shows the diff, and commits one', async () => {
    const w = stagedView({ id: 'w1', deviceId: 'd1' });
    const { api } = await open('files', {
      staged: [
        w,
        stagedView({ id: 'w2', deviceId: 'd1', status: 'committed', path: '/home/sam/old.md' }),
      ],
    });
    const list = await screen.findByRole('list', { name: 'Staged writes' });
    // Waiting only, by default.
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list.textContent).toContain('+1 −1');
    expect(list.textContent).toContain('Agent Scout');
    expect(list.textContent).toContain('Waiting for review');
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Staged writes' })).getAllByRole('listitem'),
      ).toHaveLength(2),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Waiting' }));

    await userEvent.click(
      await screen.findByRole('button', { name: 'Review /home/sam/notes/todo.md' }),
    );
    const diff = await screen.findByLabelText('Changes to /home/sam/notes/todo.md');
    const lines = diff.querySelectorAll('.devices-diff-line');
    expect([...lines].map((l) => [l.getAttribute('data-kind'), l.textContent])).toEqual([
      ['hunk', '@@ -1,2 +1,2 @@'],
      ['same', '  # Todo'],
      ['del', '- Removed: buy milk'],
      ['add', '+ Added: buy oat milk'],
    ]);
    expect(screen.getByText('1 line added, 1 line removed.')).toBeTruthy();
    expect(screen.getByText('Changes an existing file')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Commit' }));
    expect(api.commitStagedWrite).toHaveBeenCalledWith('d1', 'w1');
    expect(await screen.findByText('Written')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Staged writes' }));
    expect(await screen.findByText('Nothing is waiting for review.')).toBeTruthy();
  });

  it('shows a conflict plainly when the file changed on the device', async () => {
    await open('files', {
      staged: [stagedView({ id: 'w1', deviceId: 'd1' })],
      changedOnDevice: ['/home/sam/notes/todo.md'],
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Review /home/sam/notes/todo.md' }),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Commit' }));
    expect(
      await screen.findByText(
        /The file changed on the device after this write was staged, so nothing was written\./,
      ),
    ).toBeTruthy();
    expect(screen.getAllByText('Conflict').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
  });

  it('discards after a confirmation, and cannot commit while the device is offline', async () => {
    const { api } = await open(
      'files',
      {
        staged: [
          stagedView({ id: 'w1', deviceId: 'd1', binary: true, diff: 'binary, 2 KB → 3 KB' }),
        ],
      },
      { status: 'unreachable' },
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Review /home/sam/notes/todo.md' }),
    );
    expect(await screen.findByText(/binary, 2 KB → 3 KB/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Commit' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const dialog = screen.getByRole('dialog', { name: 'Discard this write?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));
    expect(api.discardStagedWrite).toHaveBeenCalledWith('d1', 'w1');
    expect(await screen.findByText('Discarded. Nothing was written.')).toBeTruthy();
  });

  it('says when an expired write was not written, and follows new writes live', async () => {
    const { state } = await open('files', {
      staged: [stagedView({ id: 'w1', deviceId: 'd1', status: 'expired' })],
    });
    expect(await screen.findByText('Nothing is waiting for review.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Review /home/sam/notes/todo.md' }),
    );
    expect(await screen.findByText(/expired on the device before it was committed/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Staged writes' }));
    state.staged = [
      ...state.staged,
      stagedView({ id: 'w2', deviceId: 'd1', path: '/home/sam/new.md' }),
    ];
    stream().emit('device.write.staged', { deviceId: 'd1', stagedId: 'w2' });
    expect(await screen.findByRole('button', { name: 'Review /home/sam/new.md' })).toBeTruthy();
  });
});

describe("agents' connected computers (FR-081)", () => {
  it('connects an agent, offers to replace its other computer, and disconnects', async () => {
    const { api, state } = await open('agents', {
      devices: [
        deviceView({ id: 'd1', name: 'Desk PC', novadVersion: '0.6.0' }),
        deviceView({ id: 'd2', name: 'Laptop' }),
      ],
      connections: [
        connectionView({ id: 'c0', agentId: 'ag2', deviceId: 'd2', deviceName: 'Laptop' }),
      ],
    });
    expect(await screen.findByText('No agent uses this device as its computer.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Connect an agent' }));
    let dialog = screen.getByRole('dialog', { name: 'Connect an agent to Desk PC' });
    // Computer use needs a newer novad on this device.
    const cu = within(dialog).getByRole('checkbox', { name: 'Computer use' });
    expect(cu).toHaveProperty('disabled', true);
    expect(within(dialog).getAllByText('Needs novad 0.7.0').length).toBeGreaterThan(0);
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Agent' }), 'ag1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(api.connectDevice).toHaveBeenCalledWith({
      agentId: 'ag1',
      deviceId: 'd1',
      capabilities: ['files', 'staged_writes', 'exec'],
    });
    const list = await screen.findByRole('list', { name: 'Connected agents' });
    expect(within(list).getByText('Scout')).toBeTruthy();
    expect(list.textContent).toContain('May use: Files, Staged writes, Commands');

    // Scribe already uses the Laptop.
    await userEvent.click(screen.getByRole('button', { name: 'Connect an agent' }));
    dialog = screen.getByRole('dialog', { name: 'Connect an agent to Desk PC' });
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Agent' }), 'ag2');
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Commands' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'This agent already uses another device as its computer.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Replace' }));
    expect(api.connectDevice).toHaveBeenLastCalledWith({
      agentId: 'ag2',
      deviceId: 'd1',
      capabilities: ['files', 'staged_writes'],
      replace: true,
    });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(state.connections.find((c) => c.id === 'c0')!.status).toBe('revoked');

    await userEvent.click(within(list).getByRole('button', { name: 'Disconnect Scout' }));
    const confirm = screen.getByRole('dialog', { name: 'Disconnect Scout?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    await userEvent.click(screen.getByText('Earlier connections (1)'));
    expect(screen.getByRole('list', { name: 'Earlier connections' }).textContent).toContain(
      'Scout',
    );
  });

  it('cannot connect a device kept out of agent work', async () => {
    await open('agents', {}, { policy: { routingEligible: false } });
    expect(
      await screen.findByText('This device is kept out of agent work by its policy.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect an agent' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it("is the agent's computer panel from the agent's side", async () => {
    const { api } = await renderWithDevices(
      <AgentComputerPanel agentId="ag1" agentName="Scout" />,
      {
        devices: {
          devices: [
            deviceView({ id: 'd1', name: 'Desk PC' }),
            deviceView({ id: 'd2', name: 'Fenced', policy: { routingEligible: false } }),
          ],
          agents: [SCOUT],
        },
      },
    );
    expect(await screen.findByRole('heading', { name: 'No computer connected' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Connect a computer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect a computer' });
    const pick = within(dialog).getByRole('combobox', { name: 'Device' });
    expect(
      within(pick).getByRole('option', {
        name: 'Fenced (kept out of agent work)',
      }),
    ).toHaveProperty('disabled', true);
    await userEvent.selectOptions(pick, 'd1');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(api.connectDevice).toHaveBeenCalledWith({
      agentId: 'ag1',
      deviceId: 'd1',
      capabilities: ['files', 'staged_writes', 'exec'],
    });
    expect(await screen.findByRole('link', { name: 'Desk PC' })).toBeTruthy();
    expect(screen.getByText('Scout now uses Desk PC as its computer.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Disconnect Desk PC?' })).getByRole('button', {
        name: 'Disconnect',
      }),
    );
    expect(await screen.findByRole('heading', { name: 'No computer connected' })).toBeTruthy();
  });
});

describe('local MCP servers', () => {
  it('lists the servers shared with you, read-only, with their tools', async () => {
    await open('mcp', {
      mcp: {
        d1: [
          { name: 'notes', tools: [{ name: 'search', description: 'Find <b>notes</b>' }] },
          { name: 'hidden', tools: [] },
        ],
      },
      grants: [grantView({ deviceId: 'd1', kind: 'mcp', target: 'notes', access: 'call' })],
    });
    const list = await screen.findByRole('list', { name: 'Local MCP servers' });
    expect(
      within(list)
        .getAllByRole('listitem', { name: /./ })
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['notes']);
    // Untrusted text stays text.
    expect(within(list).getByText('Find <b>notes</b>')).toBeTruthy();
    expect(list.querySelector('b')).toBeNull();
    expect(screen.queryByRole('button', { name: /call/i })).toBeNull();
  });

  it('says when nothing is shared, and why the list is unavailable', async () => {
    await open('mcp');
    expect(
      await screen.findByText('No local MCP servers are shared with you on this device.'),
    ).toBeTruthy();
    resetDom();
    await open('mcp', {}, { capability: { modules: ['management'] } });
    expect(await screen.findByText('This device has no storage module.')).toBeTruthy();
  });
});
