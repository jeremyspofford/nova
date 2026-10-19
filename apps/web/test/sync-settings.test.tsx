// Settings → Sync (FR-109, FR-112, FR-129, docs/13 §2.2): this device's offline copy (on or off as
// the Hub's grant says, encrypted size, what it holds, last sync, Sync now, Load again after
// asking), changes waiting to send, devices with a copy with their status (synced, pending,
// offline, error) and Load again, and History: each conflict's two values, which won, who set
// them, Restore after asking (the Hub's refusals shown in the dialog), older entries and live
// updates.
import { act, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { SyncPage } from '../src/sync/SyncPage.tsx';
import { FakeEventSource, fakeEventSource } from './fakes.ts';
import {
  FakeSyncHub,
  OTHER_DEVICE,
  THIS_DEVICE,
  offlineSetup,
  renderOffline,
  settle,
} from './fakes-m7-sync.ts';
import { resetDom } from './render.tsx';

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  resetDom();
  FakeEventSource.reset();
  window.history.replaceState(null, '', '/');
});

const region = (name: string) => screen.getByRole('region', { name });
const stream = () => FakeEventSource.for('/api/v1/events/stream');

async function open(setup: (hub: FakeSyncHub) => void = () => undefined) {
  const hub = new FakeSyncHub().seed();
  setup(hub);
  const env = offlineSetup(hub);
  await env.api.session();
  const stop = env.runtime.start({ eventSource: fakeEventSource });
  stops.push(stop);
  const ready = () => {
    const r = env.runtime.getState().replica;
    return r.granted !== null && r.phase !== 'loading' && !r.syncing;
  };
  await settle(ready);
  const r = await renderOffline(<SyncPage />, { runtime: env.runtime, hub });
  await screen.findByRole('heading', { name: 'Sync' });
  await act(() => settle(ready));
  // The Hub's events reach the app's stream, as they do live.
  hub.onEvent = (name, payload) => stream().emit(name, payload);
  return { ...r, ...env, stop: () => undefined };
}

describe('this device', () => {
  it('shows the copy, syncs now and loads it again after asking', async () => {
    const env = await open();
    const device = region('This device');
    expect(within(device).getByText('Up to date')).toBeTruthy();
    expect(within(device).getByText(/encrypted on this device/)).toBeTruthy();
    expect(
      within(device).getByText('2 chats, 2 messages, 1 project, 1 space, 1 page'),
    ).toBeTruthy();
    // Last synced at the (fake) Hub's time.
    expect(within(device).getByText(/2026/)).toBeTruthy();
    expect(
      within(device).getByRole('link', { name: 'its page in Devices' }).getAttribute('href'),
    ).toBe(`/devices/${THIS_DEVICE}`);

    env.hub.write('thread', 't1', { title: 'Lisbon' });
    await userEvent.click(within(device).getByRole('button', { name: 'Sync now' }));
    await waitFor(() =>
      expect(env.runtime.engine.replica!.value('thread', 't1', 'title')).toBe('Lisbon'),
    );

    const loads = () =>
      env.hub.requests.filter((q) => q.path.startsWith('/api/v1/sync/snapshot')).length;
    const before = loads();
    await userEvent.click(within(device).getByRole('button', { name: 'Load again' }));
    const dialog = screen.getByRole('dialog', { name: "Load this device's offline copy again?" });
    expect(dialog.textContent).toMatch(/Changes waiting to send stay/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Load again' }));
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
    expect(await screen.findByText('Offline copy loaded again.')).toBeTruthy();
    env.stop();
  });

  it('says when the browser is not an added device, or the Hub gives it no copy', async () => {
    let env = await open((hub) => {
      hub.deviceId = null;
      hub.scopes = null;
    });
    let device = region('This device');
    expect(within(device).getByText('Off')).toBeTruthy();
    expect(
      within(device).getByText(/signed in to the Hub directly, not added as a device/),
    ).toBeTruthy();
    expect(within(device).queryByRole('button', { name: 'Load again' })).toBeNull();
    env.stop();
    resetDom();

    env = await open((hub) => {
      hub.scopes = ['local-runtime'];
    });
    device = region('This device');
    expect(within(device).getByText(/has not given this device an offline copy/)).toBeTruthy();
    env.stop();
  });

  it('says syncing waits while the Hub is unreachable', async () => {
    const env = await open();
    env.hub.down = true;
    await act(async () => {
      await env.api.listProjects();
    });
    const device = region('This device');
    expect(within(device).getByText('Offline')).toBeTruthy();
    expect(within(device).getByText(/Syncing starts again when it is back/)).toBeTruthy();
    expect(within(device).queryByRole('button', { name: 'Sync now' })).toBeNull();
    env.stop();
  });
});

describe('devices with a copy', () => {
  it('lists each device with its sync status and loads one again after asking', async () => {
    const env = await open((hub) => {
      const phone = hub.devices.get(OTHER_DEVICE)!;
      phone.lastPullAt = hub.iso(hub.now - 60_000);
      phone.lastError = '2 change(s) refused';
    });
    const list = await within(region('Devices with an offline copy')).findByRole('list', {
      name: 'Devices with an offline copy',
    });
    const laptop = within(list).getByRole('listitem', { name: 'Laptop' });
    expect(laptop.textContent).toMatch(/Laptop \(this device\)/);
    expect(within(laptop).getByText('Synced')).toBeTruthy();
    const phone = within(list).getByRole('listitem', { name: 'Phone' });
    expect(within(phone).getByText('Error')).toBeTruthy();
    expect(within(phone).getByText('2 change(s) refused')).toBeTruthy();

    await userEvent.click(within(phone).getByRole('button', { name: 'Load again' }));
    const dialog = screen.getByRole('dialog', { name: 'Load the copy on Phone again?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Load again' }));
    await waitFor(() => expect(env.sync.api.resetSyncDevice).toHaveBeenCalledWith(OTHER_DEVICE));
    expect(await screen.findByText('Phone will load its offline copy again.')).toBeTruthy();
    expect(within(phone).getByText(/Asked to load its copy again/)).toBeTruthy();
    expect(within(phone).getByRole('link', { name: 'Device page' }).getAttribute('href')).toBe(
      `/devices/${OTHER_DEVICE}`,
    );
    env.stop();
  });

  it('shows pending changes and an error with Retry, and an empty list', async () => {
    const env = await open((hub) => {
      const phone = hub.devices.get(OTHER_DEVICE)!;
      phone.lastPullAt = hub.iso();
    });
    const section = region('Devices with an offline copy');
    const phone = await within(section).findByRole('listitem', { name: 'Phone' });
    expect(within(phone).getByText(/^Pending: \d+ changes to pull$/)).toBeTruthy();
    env.stop();
    resetDom();

    const hub = new FakeSyncHub();
    hub.devices.clear();
    hub.failNext.set('GET /api/v1/sync/devices', {
      status: 500,
      body: { code: 'server_error', message: 'Sync is unavailable.', retryable: true },
    });
    await renderOffline(<SyncPage />, { hub });
    const alert = await within(region('Devices with an offline copy')).findByRole('alert');
    expect(alert.textContent).toMatch(/Sync is unavailable\./);
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No device keeps an offline copy')).toBeTruthy();
  });
});

describe('history (the merge log)', () => {
  it('shows both values with who won, and restores the replaced one after asking', async () => {
    const env = await open((hub) => {
      hub.conflict('thread', 't1', 'title', 'Holiday', 'Trip planning');
    });
    const history = region('History');
    const entry = await within(history).findByRole('listitem', {
      name: 'Chat “Trip planning” · Title',
    });
    expect(entry.textContent).toMatch(/Changed in two places at about the same time/);
    const kept = within(entry).getByText('Kept').closest('.sy-side')!;
    expect(kept.textContent).toMatch(/Trip planning.*By the Hub/);
    const replaced = within(entry).getByText('Replaced').closest('.sy-side')!;
    expect(replaced.textContent).toMatch(/Holiday.*By Phone/);

    await userEvent.click(
      within(entry).getByRole('button', { name: 'Restore the replaced value' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Restore the replaced value?' });
    expect(dialog.textContent).toMatch(/Puts backHoliday/);
    expect(dialog.textContent).toMatch(/In place ofTrip planning/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(env.hub.value('thread', 't1', 'title')).toBe('Holiday');
    // The value the restore replaced is in the history in turn, and can be restored.
    const back = await within(history).findByRole('listitem', { name: 'Chat “Holiday” · Title' });
    expect(back.textContent).toMatch(/A restore from the merge log replaced this value/);
    expect(within(back).getByText('Replaced').closest('.sy-side')!.textContent).toMatch(
      /Trip planning/,
    );
    expect(within(history).getAllByRole('listitem')).toHaveLength(1);

    await userEvent.selectOptions(within(history).getByLabelText('Show'), 'all');
    const all = await within(history).findAllByRole('listitem');
    expect(all.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/A restore from the merge log replaced this value/),
      expect.stringMatching(/Restored/),
    ]);
    env.stop();
  });

  it('shows the Hub’s refusal in the dialog', async () => {
    const env = await open((hub) => {
      hub.conflict('page', 'pg1', 'content', 'Boots and socks', 'Boots');
    });
    const history = region('History');
    const entry = await within(history).findByRole('listitem', {
      name: 'Page “Packing” · Content',
    });
    env.hub.remove('page', 'pg1');
    env.hub.merge.push({ ...env.hub.conflict('page', 'pg1', 'content', 'x', 'y') });
    await userEvent.click(
      within(entry).getByRole('button', { name: 'Restore the replaced value' }),
    );
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect((await within(dialog).findByRole('alert')).textContent).toMatch(
      /It is gone|deleted, so there is nothing to restore/,
    );
    env.stop();
  });

  it('is empty with an explanation, and follows conflicts live', async () => {
    const env = await open();
    const history = region('History');
    expect(await within(history).findByText('No conflicts')).toBeTruthy();
    env.hub.conflict('project', 'p1', 'instructions', 'Answer at length.', 'Answer briefly.');
    stream().emit('sync.conflict', {
      entryId: 'me-0001',
      kind: 'project',
      id: 'p1',
      field: 'instructions',
    });
    expect(
      await within(history).findByRole('listitem', { name: 'Project “Garden” · Instructions' }),
    ).toBeTruthy();
    env.stop();
  });

  it('pages to older entries', async () => {
    const env = await open((hub) => {
      for (let i = 0; i < 51; i++)
        hub.conflict('thread', 't1', 'title', `Old ${i}`, 'Trip planning');
    });
    const history = region('History');
    await within(history).findByRole('button', { name: 'Show older' });
    expect(within(history).getAllByRole('listitem')).toHaveLength(50);
    await userEvent.click(within(history).getByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(51));
    expect(within(history).queryByRole('button', { name: 'Show older' })).toBeNull();
    env.stop();
  });
});

describe('waiting changes on the page', () => {
  it('shows the queue section, empty when nothing waits', async () => {
    const env = await open();
    expect(
      within(region('Changes waiting to send')).getByText(/Nothing waits to send/),
    ).toBeTruthy();
    env.hub.down = true;
    await act(async () => {
      await env.api.updateThread('t1', { title: 'Lisbon' });
    });
    expect(
      within(region('Changes waiting to send')).getByRole('listitem', {
        name: 'Rename “Trip planning” to “Lisbon”',
      }),
    ).toBeTruthy();
    expect(within(region('This device')).getByText('1 change')).toBeTruthy();
    env.stop();
  });
});
