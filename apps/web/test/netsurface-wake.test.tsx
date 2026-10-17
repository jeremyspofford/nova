// Network → Wake helpers (FR-138; docs/22 §7): the devices with the Wake helper role, which ones
// the Hub uses and in what order (saved through PATCH /network, refused for a device that is not a
// helper), the empty state that leads to Add a device, and the recent wakes with the device that
// sent each (from the Hub's list when it gives one, and live `device.wake.sent` events).
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.ts';
import { WakeSection, mergeWakes } from '../src/netsurface/Wake.tsx';
import { FakeEventSource } from './fakes.ts';
import { reachability, renderWithNetwork, wakeHelper } from './fakes-m65-network.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  window.history.replaceState(null, '', '/');
});

const stream = () => FakeEventSource.for('/api/v1/events/stream');

const HELPERS = [
  wakeHelper({ deviceId: 'h1', name: 'Garage NUC' }),
  wakeHelper({ deviceId: 'h2', name: 'NAS', status: 'unreachable', subnets: [], lastSeenAt: null }),
];

async function open(network: NonNullable<Parameters<typeof renderWithNetwork>[1]>['network'] = {}) {
  const r = await renderWithNetwork(<WakeSection />, { network });
  await screen.findByRole('heading', { name: 'Recent wakes' });
  return r;
}

describe('Wake helpers (FR-138)', () => {
  it('lists helpers, and saves which ones to use and in what order', async () => {
    const { api, state } = await open({ availableHelpers: HELPERS });
    expect(screen.getByText(/None chosen: the Hub uses any online Wake helper/)).toBeTruthy();
    const available = screen.getByRole('list', { name: 'Available Wake helpers' });
    const nuc = within(available).getByRole('listitem', { name: 'Garage NUC' });
    expect(within(nuc).getByText('Online')).toBeTruthy();
    expect(nuc.textContent).toContain('networks 192.168.1.0/24');
    const nas = within(available).getByRole('listitem', { name: 'NAS' });
    expect(within(nas).getByText('Offline')).toBeTruthy();
    expect(nas.textContent).toContain('networks not reported yet');

    await userEvent.click(within(nas).getByRole('button', { name: 'Use NAS' }));
    await userEvent.click(
      within(screen.getByRole('list', { name: 'Available Wake helpers' })).getByRole('button', {
        name: 'Use Garage NUC',
      }),
    );
    const used = screen.getByRole('list', { name: 'Wake helpers in use' });
    expect(
      within(used)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['NAS', 'Garage NUC']);
    await userEvent.click(within(used).getByRole('button', { name: 'Move Garage NUC up' }));
    expect(
      within(used)
        .getAllByRole('listitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['Garage NUC', 'NAS']);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(api.updateNetworkPanel).toHaveBeenCalledWith({ wakeHelpers: ['h1', 'h2'] }),
    );
    expect(state.wakeHelpers).toEqual(['h1', 'h2']);
    expect(await screen.findByText(/Wake helpers saved. You can roll this back/)).toBeTruthy();
    expect(screen.getByText(/The Hub tries these in order/)).toBeTruthy();
  });

  it('shows the Hub’s refusal, and a chosen device that is no longer a helper', async () => {
    const { network } = await open({ availableHelpers: HELPERS, wakeHelpers: ['gone1'] });
    const used = screen.getByRole('list', { name: 'Wake helpers in use' });
    const gone = within(used).getByRole('listitem', {
      name: 'A device that is no longer a Wake helper',
    });
    expect(within(gone).getByText('Not available')).toBeTruthy();
    network.failNext.updateNetworkPanel = new ApiError(400, {
      code: 'validation',
      message: 'not a Wake Helper of this account',
      retryable: false,
      details: { field: 'wakeHelpers', reason: 'unknown_device', ids: ['gone1'] },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Use Garage NUC' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'One of the chosen devices is not a Wake helper of this account.',
    );
    await userEvent.click(
      within(gone).getByRole('button', {
        name: 'Stop using A device that is no longer a Wake helper',
      }),
    );
    expect(
      screen.queryByRole('listitem', { name: 'A device that is no longer a Wake helper' }),
    ).toBeNull();
  });

  it('leads to Add a device when there is no helper', async () => {
    await open();
    expect(screen.getByRole('heading', { name: 'No Wake helpers yet' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add a device' }));
    expect(window.location.pathname).toBe('/devices/add');
  });

  it('shows wakes as they go out, with the device that sent each', async () => {
    await open({
      availableHelpers: HELPERS,
      devices: [reachability({ deviceId: 'd1', name: 'Desk PC' })],
    });
    expect(screen.getByText(/No wakes yet/)).toBeTruthy();
    stream().emit('device.wake.sent', {
      deviceId: 'd1',
      wakeRequestId: 'w1',
      mac: 'aa:bb:cc:dd:ee:ff',
      status: 'sent',
      via: 'h1',
    });
    stream().emit('device.wake.sent', {
      deviceId: 'd1',
      wakeRequestId: 'w2',
      mac: 'aa:bb:cc:dd:ee:ff',
      status: 'failed',
      via: 'hub',
    });
    const list = await screen.findByRole('list', { name: 'Recent wakes' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.textContent).join('|')).toContain('sent through Garage NUC');
    expect(items.map((i) => i.textContent).join('|')).toContain('sent by the Hub');
    expect(within(list).getByText('Failed')).toBeTruthy();
  });

  it('reads past wakes from the Hub', async () => {
    await open({
      recentWakes: [
        {
          id: 'w1',
          deviceId: 'd1',
          deviceName: 'Studio',
          mac: '52:54:00:12:34:56',
          status: 'rate_limited',
          via: null,
          viaName: null,
          error: null,
          createdAt: '2026-10-01T12:00:00.000Z',
        },
      ],
    });
    const list = screen.getByRole('list', { name: 'Recent wakes' });
    expect(within(list).getByText('Too many wakes')).toBeTruthy();
    expect(list.textContent).toContain('Studio');
    expect(list.textContent).toContain('not sent: the hourly limit was reached');
  });

  it('says when it cannot load, with Retry', async () => {
    const r = await renderWithNetwork(<WakeSection />);
    await screen.findByRole('heading', { name: 'Recent wakes' });
    r.network.failNext.getNetworkPanel = new ApiError(500, {
      code: 'server_error',
      message: 'internal error',
      retryable: true,
    });
    stream().emit('network.changed', {
      changeId: 'c',
      kind: 'network.settings',
      summary: 's',
      status: 'applied',
    });
    expect((await screen.findByRole('alert')).textContent).toContain('Internal error.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });
});

describe('mergeWakes', () => {
  it('keeps one entry per wake, newest first', () => {
    const w = (id: string, createdAt: string) => ({
      id,
      deviceId: 'd',
      mac: null,
      status: 'sent',
      via: 'hub',
      createdAt,
    });
    expect(
      mergeWakes(
        [w('a', '2026-10-01T10:00:00Z'), w('b', '2026-10-01T11:00:00Z')],
        [w('b', '2026-10-01T11:00:00Z'), w('c', '2026-10-01T12:00:00Z')],
      ).map((x) => x.id),
    ).toEqual(['c', 'b', 'a']);
  });
});
