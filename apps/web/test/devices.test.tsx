import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiError } from '../src/api.ts';
import { NODE_POLL_MS, enrollCommand, formatCountdown } from '../src/settings/DevicesPage.tsx';
import { formatWhen } from '../src/settings/common.ts';
import { createHub } from './fakes.ts';
import { captureIntervals, computeNode, workspaceState } from './fakes-workspace.ts';
import { renderApp, resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

const fail = (message: string) => new ApiError(500, { code: 'x', message, retryable: true });

describe('device helpers', () => {
  it('builds the enroll command and formats times', () => {
    expect(enrollCommand('https://hub.local:8443', 'nve_abc')).toBe(
      'nova-compute enroll --hub https://hub.local:8443 --token nve_abc --backend http://127.0.0.1:11434',
    );
    expect(formatCountdown(15 * 60_000)).toBe('15:00');
    expect(formatCountdown(61_000)).toBe('1:01');
    expect(formatCountdown(-5)).toBe('0:00');
    const now = Date.parse('2026-10-17T12:00:00Z');
    expect(formatWhen('2026-10-17T11:59:50Z', now)).toBe('just now');
    expect(formatWhen('2026-10-17T11:55:00Z', now)).toBe('5 min ago');
    expect(formatWhen('2026-10-17T09:00:00Z', now)).toBe('3 h ago');
    expect(formatWhen(null, now)).toBe('never');
    expect(formatWhen('garbage', now)).toBe('unknown');
    expect(formatWhen('2026-09-01T00:00:00Z', now)).toMatch(/2026/);
  });
});

describe('Settings → Devices (FR-126)', () => {
  it('lists compute nodes with status, models and load, and refreshes every 5 s', async () => {
    const polls = captureIntervals(NODE_POLL_MS);
    const hub = createHub({
      workspace: workspaceState({
        nodes: [
          computeNode({ name: 'Desk GPU' }),
          computeNode({
            name: 'Old laptop',
            status: 'unreachable',
            models: [],
            load: null,
            capabilities: { gpus: 0, vramBytes: null, maxConcurrentJobs: 1 },
          }),
        ],
      }),
    });
    await renderApp({ hub, path: '/settings/devices' });
    const desk = await screen.findByRole('listitem', { name: 'Desk GPU' });
    expect(within(desk).getByText('Active')).toBeTruthy();
    expect(within(desk).getByText('http://10.0.0.5:7341')).toBeTruthy();
    expect(within(desk).getByText('1 model: qwen3:14b')).toBeTruthy();
    expect(within(desk).getByText(/1 running, 0 queued · last seen just now/)).toBeTruthy();
    expect(within(desk).getByText(/1 GPU · 24 GB VRAM · up to 2 jobs at once/)).toBeTruthy();
    const old = screen.getByRole('listitem', { name: 'Old laptop' });
    expect(within(old).getByText('Unreachable')).toBeTruthy();
    expect(within(old).getByText('No models reported')).toBeTruthy();
    expect(within(old).getByText(/Load not reported/)).toBeTruthy();

    hub.state.workspace.nodes = hub.state.workspace.nodes.map((n) =>
      n.name === 'Old laptop' ? { ...n, status: 'active' as const } : n,
    );
    expect(polls.count()).toBe(1);
    const calls = hub.api.listNodes.mock.calls.length;
    polls.fire();
    expect(hub.api.listNodes.mock.calls.length).toBe(calls + 1);
    await waitFor(() => expect(within(old).getByText('Active')).toBeTruthy());

    // Leaving the page stops the refresh.
    await userEvent.click(screen.getByRole('link', { name: 'General' }));
    await waitFor(() => expect(polls.count()).toBe(0));
  });

  it('adds a node: shows the exact command with copy and an expiry countdown', async () => {
    const hub = createHub();
    await renderApp({ hub, path: '/settings/devices' });
    expect(await screen.findByText('No compute nodes yet.')).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add compute node' });
    await userEvent.click(add);
    const dialog = screen.getByRole('dialog', { name: 'Add a compute node' });
    const command = `nova-compute enroll --hub ${window.location.origin} --token nve_fake-enroll-token --backend http://127.0.0.1:11434`;
    expect(await within(dialog).findByText(command)).toBeTruthy();
    expect(within(dialog).getByRole('timer').textContent).toMatch(/^1[45]:\d\d$/);
    expect(hub.api.createNodeEnrollToken).toHaveBeenCalledTimes(1);

    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(command));
    expect(await screen.findByText('Command copied.')).toBeTruthy();

    // A failing clipboard selects the command instead.
    writeText.mockImplementationOnce(() => Promise.reject(new Error('denied')));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Copy command' }));
    expect(await screen.findByText(/Could not copy\. The command is selected/)).toBeTruthy();
    expect(window.getSelection()?.toString()).toBe(command);

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it('offers a new token once one expires, and reports a failed token request', async () => {
    const hub = createHub({ workspace: workspaceState({ enrollTtlMs: 0 }) });
    await renderApp({ hub, path: '/settings/devices' });
    hub.state.failNext.createNodeEnrollToken = fail('Policy denied');
    await userEvent.click(screen.getByRole('button', { name: 'Add compute node' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a compute node' });
    expect(await within(dialog).findByText('Policy denied')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByText(/This token has expired/)).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Copy command' }).disabled,
    ).toBe(true);
    hub.state.workspace.enrollTtlMs = 15 * 60_000;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create a new token' }));
    expect(await within(dialog).findByRole('timer')).toBeTruthy();
    expect(within(dialog).queryByText(/This token has expired/)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('revokes a node after confirming, and reports a failed revoke or load', async () => {
    const hub = createHub({
      workspace: workspaceState({ nodes: [computeNode({ name: 'Desk GPU' })] }),
    });
    await renderApp({ hub, path: '/settings/general' });
    hub.state.failNext.listNodes = fail('Hub busy');
    await userEvent.click(screen.getByRole('link', { name: 'Devices' }));
    expect(await screen.findByText('Hub busy')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const row = await screen.findByRole('listitem', { name: 'Desk GPU' });

    hub.state.failNext.revokeNode = fail('Offline');
    await userEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Revoke Desk GPU?' })).getByRole('button', {
        name: 'Revoke',
      }),
    );
    expect(await screen.findByText('Could not revoke Desk GPU: Offline')).toBeTruthy();

    await userEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke Desk GPU?' });
    expect(dialog.textContent).toMatch(/credential stops working at once/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(
      await screen.findByText('Desk GPU revoked. Its models are no longer offered.'),
    ).toBeTruthy();
    expect(within(row).getByText('Revoked')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(hub.api.revokeNode).toHaveBeenCalledTimes(2);
  });
});
