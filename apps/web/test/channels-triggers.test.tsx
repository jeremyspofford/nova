// Settings → Triggers (FR-056, FR-201; docs/09 §7, docs/18 J7 step 5): webhook triggers with a
// token and signing secret shown once, MCP event subscriptions from a connected server's
// advertised events (status, renewal, last delivery, unsubscribe), channel watches of a Slack
// conversation, what each starts, on and off, editing, the delivery log and deleting.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/api.ts';
import { TriggersPage } from '../src/channels/TriggersPage.tsx';
import { FakeEventSource } from './fakes.ts';
import {
  agentChoice,
  bindingView,
  renderWithChannels,
  subscriptionView,
  triggerEventView,
  triggerView,
} from './fakes-m6-channels.ts';
import { project } from './fakes-workspace.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

const AGENT = agentChoice({ id: 'ag1', name: 'Research' });
const SOURCES = [
  {
    serverId: 'srv1',
    name: 'GitHub',
    events: [
      { name: 'issue.created', description: 'A new issue was opened.' },
      { name: 'pr.merged', description: null },
    ],
  },
];
const SLACK = bindingView({ id: 'b1', kind: 'slack', label: 'Slack #ops', externalRef: 'C0OPS' });

const HOOK = triggerView({
  id: 'tr1',
  kind: 'webhook',
  title: 'Deploy hook',
  instructions: 'Check the deploy',
  lastFiredAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
});
const MCP = triggerView({
  id: 'tr2',
  kind: 'mcp_event',
  title: 'New issues',
  action: 'wake',
  agentId: 'ag1',
  instructions: 'Triage it',
  sourceRef: 'sub1',
});
const SUB = subscriptionView({
  id: 'sub1',
  triggerId: 'tr2',
  serverId: 'srv1',
  event: 'issue.created',
  lastDeliveryAt: new Date(Date.now() - 10 * 60_000).toISOString(),
});

const fail = (message: string, status = 500) =>
  new ApiError(status, { code: 'server_error', message, retryable: false });
const row = (name: string) => within(screen.getByRole('listitem', { name }));

describe('the trigger list (FR-056)', () => {
  it('shows each trigger, what it starts, its source and when it last fired', async () => {
    await renderWithChannels(<TriggersPage />, {
      channels: {
        triggers: [
          HOOK,
          MCP,
          triggerView({
            id: 'tr3',
            kind: 'connector_event',
            title: 'Ops watch',
            sourceRef: 'b1',
            config: { conversation: 'C0OPS', contains: 'deploy' },
            autonomy: 'ask_first',
          }),
          triggerView({ id: 'tr4', kind: 'fs_change', title: 'Notes folder' }),
        ],
        subscriptions: [SUB],
        sources: SOURCES,
        agents: [AGENT],
        bindings: [SLACK],
      },
    });
    const hook = within(await screen.findByRole('listitem', { name: 'Deploy hook' }));
    expect(hook.getByText('Webhook')).toBeTruthy();
    expect(hook.getByText('On')).toBeTruthy();
    expect(hook.getByText('Starts a Work run')).toBeTruthy();
    expect(hook.getByText('http://localhost:3000/api/v1/triggers/tr1/webhook')).toBeTruthy();
    expect(hook.getByText('Last fired 2 h ago')).toBeTruthy();
    const mcp = row('New issues');
    expect(await mcp.findByText('Wakes Research')).toBeTruthy();
    expect(mcp.getByText('Active')).toBeTruthy();
    expect(mcp.getByText(/^GitHub/)).toBeTruthy();
    expect(mcp.getByText('Last delivery 10 min ago')).toBeTruthy();
    expect(mcp.getByText(/^Renewed before/)).toBeTruthy();
    const watch = row('Ops watch');
    expect(await watch.findByText('Slack #ops')).toBeTruthy();
    expect(watch.getByText('Only messages containing “deploy”')).toBeTruthy();
    expect(watch.getByText(/asks before acting/)).toBeTruthy();
    const fs = row('Notes folder');
    expect(fs.getByText('Not available yet')).toBeTruthy();
    expect(fs.getByText(/File-change triggers need a connected device/)).toBeTruthy();
    expect(fs.getByRole<HTMLButtonElement>('switch', { name: 'Notes folder on' }).disabled).toBe(
      true,
    );
  });

  it('shows the empty state and a load error with retry', async () => {
    const { api } = await renderWithChannels(<TriggersPage />, {
      fail: { listTriggers: fail('Hub is restarting') },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Hub is restarting');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'No triggers yet' })).toBeTruthy();
    expect(api.listTriggers).toHaveBeenCalledTimes(2);
  });

  it('turns a trigger off and on', async () => {
    const { state } = await renderWithChannels(<TriggersPage />, {
      channels: { triggers: [HOOK] },
    });
    const sw = await screen.findByRole('switch', { name: 'Deploy hook on' });
    await userEvent.click(sw);
    expect(await screen.findByText('Deploy hook is off.')).toBeTruthy();
    expect(state.triggers[0]!.enabled).toBe(false);
    expect(row('Deploy hook').getByText('Off')).toBeTruthy();
    await userEvent.click(screen.getByRole('switch', { name: 'Deploy hook on' }));
    expect(await screen.findByText('Deploy hook is on.')).toBeTruthy();
  });

  it('shows the delivery log with what each delivery started', async () => {
    const { state } = await renderWithChannels(<TriggersPage />, {
      channels: {
        triggers: [HOOK],
        triggerEvents: [
          triggerEventView({
            triggerId: 'tr1',
            status: 'started',
            runId: 'run9',
            receivedAt: '2026-10-01T12:00:00.000Z',
          }),
          triggerEventView({
            triggerId: 'tr1',
            status: 'skipped',
            detail: 'rate_limited',
            receivedAt: '2026-10-01T13:00:00.000Z',
          }),
        ],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Deliveries of Deploy hook' }));
    const log = within(await screen.findByRole('list', { name: 'Deliveries of Deploy hook' }));
    const items = log.getAllByRole('listitem');
    expect(items[0]!.textContent).toContain('Skipped');
    expect(items[0]!.textContent).toContain('The hourly limit for this trigger was reached.');
    expect(items[1]!.textContent).toContain('Started');
    // A new delivery arrives live.
    state.triggerEvents = [
      ...state.triggerEvents,
      triggerEventView({
        triggerId: 'tr1',
        status: 'failed',
        detail: 'Work runs are not available',
        receivedAt: '2026-10-01T14:00:00.000Z',
      }),
    ];
    for (const s of FakeEventSource.all.filter((x) => !x.closed))
      s.emit('trigger.fired', { triggerId: 'tr1', kind: 'webhook', dedupeKey: 'x' });
    expect(await log.findByText('Work runs are not available')).toBeTruthy();
    await userEvent.click(log.getByRole('link', { name: 'Open run' }));
    expect(window.location.pathname).toBe('/work/run9');
  });

  it('shows an empty delivery log', async () => {
    await renderWithChannels(<TriggersPage />, { channels: { triggers: [HOOK] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Deliveries of Deploy hook' }));
    expect(await screen.findByText(/No deliveries yet/)).toBeTruthy();
  });

  it('deletes a trigger only after confirming', async () => {
    const { state } = await renderWithChannels(<TriggersPage />, {
      channels: { triggers: [HOOK] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Deploy hook' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete Deploy hook?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('heading', { name: 'No triggers yet' })).toBeTruthy();
    expect(state.triggers).toHaveLength(0);
  });

  it('edits the name, instructions and dedupe field', async () => {
    const { api } = await renderWithChannels(<TriggersPage />, { channels: { triggers: [HOOK] } });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Deploy hook' }));
    const d = within(screen.getByRole('dialog', { name: 'Edit Deploy hook' }));
    const name = d.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Deploys');
    await userEvent.type(d.getByLabelText('Event id field (optional)'), 'event..id');
    await userEvent.click(d.getByRole('button', { name: 'Save' }));
    expect(d.getByRole('alert').textContent).toMatch(/field path/);
    const field = d.getByLabelText('Event id field (optional)');
    await userEvent.clear(field);
    await userEvent.type(field, 'event.id');
    await userEvent.click(d.getByRole('switch', { name: 'Ask before acting' }));
    await userEvent.click(d.getByRole('button', { name: 'Save' }));
    expect(api.updateTrigger).toHaveBeenCalledWith('tr1', {
      title: 'Deploys',
      autonomy: 'ask_first',
      dedupeKey: 'event.id',
    });
    expect(await screen.findByRole('listitem', { name: 'Deploys' })).toBeTruthy();
  });
});

describe('webhook triggers', () => {
  it('creates one; the token and secret are shown once', async () => {
    const { api, state } = await renderWithChannels(<TriggersPage />, {
      projects: [project({ id: 'p1', name: 'Billing' })],
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Webhook' }));
    const d = within(screen.getByRole('dialog', { name: 'New webhook trigger' }));
    await userEvent.click(d.getByRole('button', { name: 'Add trigger' }));
    expect(api.createTrigger).not.toHaveBeenCalled();
    expect(d.getAllByRole('alert').length).toBeGreaterThan(0);
    await userEvent.type(d.getByLabelText('Instructions'), 'Summarize the alert');
    await userEvent.selectOptions(await d.findByLabelText('Project (optional)'), 'p1');
    await userEvent.click(d.getByRole('button', { name: 'Add trigger' }));
    const body = api.createTrigger.mock.lastCall![0] as unknown as {
      credentials: { token: string; secret: string };
    };
    expect(body).toEqual({
      kind: 'webhook',
      instructions: 'Summarize the alert',
      action: 'run',
      projectId: 'p1',
      credentials: { token: expect.any(String), secret: expect.any(String) },
    });
    const done = within(await screen.findByRole('dialog', { name: 'Webhook trigger added' }));
    const id = state.triggers[0]!.id;
    expect(done.getByText(`http://localhost:3000/api/v1/triggers/${id}/webhook`)).toBeTruthy();
    expect(done.getByText(body.credentials.token)).toBeTruthy();
    expect(done.getByText(body.credentials.secret)).toBeTruthy();
    expect(state.secrets[`trigger/${id}/secret`]).toBe(body.credentials.secret);
    await userEvent.click(done.getByRole('button', { name: 'Done' }));
    expect(document.body.textContent).not.toContain(body.credentials.secret);
    expect(
      within(
        await screen.findByRole('listitem', { name: 'Webhook: Summarize the alert' }),
      ).getByText('Starts a Work run in Billing'),
    ).toBeTruthy();
  });

  it('wakes an agent, and needs one', async () => {
    const { api } = await renderWithChannels(<TriggersPage />, {
      channels: { agents: [AGENT] },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Webhook' }));
    const d = within(screen.getByRole('dialog', { name: 'New webhook trigger' }));
    await userEvent.click(d.getByRole('radio', { name: 'Wake an agent' }));
    expect(d.getByLabelText<HTMLSelectElement>('Agent').value).toBe('ag1');
    await userEvent.type(d.getByLabelText('Instructions'), 'Look into it');
    await userEvent.type(d.getByLabelText('Name (optional)'), 'Pager');
    await userEvent.click(d.getByRole('button', { name: 'Add trigger' }));
    expect(api.createTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'wake', agentId: 'ag1', title: 'Pager' }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Webhook trigger added' })).getByRole(
        'button',
        { name: 'Done' },
      ),
    );
    expect(await row('Pager').findByText('Wakes Research')).toBeTruthy();
  });

  it('makes a new token and secret after confirming', async () => {
    const { state } = await renderWithChannels(<TriggersPage />, {
      channels: { triggers: [HOOK] },
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'New token and secret for Deploy hook' }),
    );
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Make a new token and secret?' })).getByRole(
        'button',
        { name: 'Make new ones' },
      ),
    );
    const once = within(await screen.findByRole('region', { name: 'Shown once' }));
    expect(once.getByText(state.secrets['trigger/tr1/token']!)).toBeTruthy();
    expect(once.getByText(state.secrets['trigger/tr1/secret']!)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('region', { name: 'Shown once' })).toBeNull();
  });
});

describe('MCP event subscriptions (FR-201)', () => {
  it('subscribes to an event the server offers', async () => {
    const { api, state } = await renderWithChannels(<TriggersPage />, {
      channels: { sources: SOURCES },
    });
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'MCP event' });
    await waitFor(() => expect(button.disabled).toBe(false));
    await userEvent.click(button);
    const d = within(screen.getByRole('dialog', { name: 'New MCP event trigger' }));
    expect(d.getByLabelText<HTMLSelectElement>('MCP server').value).toBe('srv1');
    expect(d.getByText('A new issue was opened.')).toBeTruthy();
    await userEvent.selectOptions(d.getByLabelText('Event'), 'pr.merged');
    await userEvent.type(d.getByLabelText('Instructions'), 'Write release notes');
    await userEvent.click(d.getByText('Filter (optional)'));
    await userEvent.type(d.getByLabelText('Filter as JSON'), 'nope');
    await userEvent.click(d.getByRole('button', { name: 'Subscribe' }));
    expect(d.getByText('This is not valid JSON.')).toBeTruthy();
    const filter = d.getByLabelText('Filter as JSON');
    await userEvent.clear(filter);
    await userEvent.type(filter, '{{"repo": "nova"}');
    await userEvent.click(d.getByRole('button', { name: 'Subscribe' }));
    expect(api.createMcpSubscription).toHaveBeenCalledWith({
      instructions: 'Write release notes',
      action: 'run',
      serverId: 'srv1',
      event: 'pr.merged',
      filter: { repo: 'nova' },
    });
    expect(await screen.findByText('Subscribed.')).toBeTruthy();
    const r = within(
      await screen.findByRole('listitem', { name: 'MCP event: Write release notes' }),
    );
    expect(r.getByText('Active')).toBeTruthy();
    expect(state.subscriptions[0]!.filter).toEqual({ repo: 'nova' });
  });

  it('says when no connected server offers events', async () => {
    await renderWithChannels(<TriggersPage />);
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'MCP event' });
    await waitFor(() => expect(button.disabled).toBe(false));
    await userEvent.click(button);
    const d = within(screen.getByRole('dialog', { name: 'New MCP event trigger' }));
    expect(d.getByText(/No connected MCP server offers events/)).toBeTruthy();
    expect(d.getByRole<HTMLButtonElement>('button', { name: 'Subscribe' }).disabled).toBe(true);
  });

  it('shows a lapsed subscription with its error, and unsubscribes after confirming', async () => {
    const { state, api } = await renderWithChannels(<TriggersPage />, {
      channels: {
        triggers: [MCP],
        subscriptions: [{ ...SUB, status: 'lapsed', lastError: 'the MCP server is not connected' }],
        mcpServers: [{ id: 'srv1', name: 'GitHub' }],
        agents: [AGENT],
      },
    });
    const r = within(await screen.findByRole('listitem', { name: 'New issues' }));
    expect(r.getByText('Lapsed')).toBeTruthy();
    expect(r.getByText('the MCP server is not connected')).toBeTruthy();
    // The server is not connected now, but its name is still known.
    expect(await r.findByText(/^GitHub/)).toBeTruthy();
    await userEvent.click(r.getByRole('button', { name: 'Unsubscribe New issues' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Unsubscribe from this event?' })).getByRole(
        'button',
        { name: 'Unsubscribe' },
      ),
    );
    expect(api.deleteMcpSubscription).toHaveBeenCalledWith('sub1');
    expect(await r.findByText('Unsubscribed')).toBeTruthy();
    expect(r.getByText('Off')).toBeTruthy();
    expect(state.triggers[0]!.enabled).toBe(false);
    expect(r.queryByRole('button', { name: 'Unsubscribe New issues' })).toBeNull();
    expect(r.getByRole<HTMLButtonElement>('switch', { name: 'New issues on' }).disabled).toBe(true);
  });

  it('follows subscription changes live', async () => {
    const { state } = await renderWithChannels(<TriggersPage />, {
      channels: {
        triggers: [MCP],
        subscriptions: [{ ...SUB, status: 'pending' }],
        sources: SOURCES,
      },
    });
    const r = within(await screen.findByRole('listitem', { name: 'New issues' }));
    expect(r.getByText('Subscribing')).toBeTruthy();
    state.subscriptions = [{ ...SUB, status: 'active' }];
    for (const s of FakeEventSource.all.filter((x) => !x.closed))
      act(() => {
        s.emit('mcp.subscription.changed', { subscriptionId: 'sub1', status: 'active' });
      });
    expect(await r.findByText('Active')).toBeTruthy();
  });
});

describe('channel watches', () => {
  it('watches a Slack conversation for messages containing a word', async () => {
    const { api } = await renderWithChannels(<TriggersPage />, {
      channels: {
        bindings: [SLACK, bindingView({ id: 'b2', kind: 'teams', label: 'Teams' })],
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Channel watch' }));
    const d = within(screen.getByRole('dialog', { name: 'New channel watch' }));
    const select = await d.findByLabelText('Slack channel');
    // Only Slack conversations can be watched.
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Slack #ops']);
    await userEvent.type(d.getByLabelText('Only messages containing (optional)'), 'incident');
    await userEvent.type(d.getByLabelText('Instructions'), 'Open an incident run');
    await userEvent.click(d.getByRole('button', { name: 'Add trigger' }));
    expect(api.createTrigger).toHaveBeenCalledWith({
      kind: 'connector_event',
      bindingId: 'b1',
      contains: 'incident',
      instructions: 'Open an incident run',
      action: 'run',
    });
    expect(await screen.findByText('Channel watch: Open an incident run added.')).toBeTruthy();
  });

  it('needs a Slack channel first', async () => {
    await renderWithChannels(<TriggersPage />);
    await userEvent.click(await screen.findByRole('button', { name: 'Channel watch' }));
    const d = within(screen.getByRole('dialog', { name: 'New channel watch' }));
    expect(d.getByText(/Add a Slack channel first/)).toBeTruthy();
    expect(d.getByRole<HTMLButtonElement>('button', { name: 'Add trigger' }).disabled).toBe(true);
  });
});
