// Settings → Sync in the pseudo-locale (FR-016): this device's copy, the changes waiting to send,
// the devices with a copy and the merge log show only localized words, including the reasons the
// copy gives and the restore dialog. Device names and platforms, chat titles, values and the
// Hub's own words are fixture data.
import { act, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { REMOVAL_TEXT } from '../src/replica/engine.ts';
import { DEVICES_TEXT, HISTORY_TEXT, SYNC_TEXT, SyncPage } from '../src/sync/SyncPage.tsx';
import { FakeEventSource, fakeEventSource } from './fakes.ts';
import { FakeSyncHub, OTHER_DEVICE, offlineSetup, renderOffline, settle } from './fakes-m7-sync.ts';
import {
  activateTestLocale,
  expectFullyLocalized,
  findUnlocalized,
  resetTestLocale,
} from './i18n.ts';
import { resetDom } from './render.tsx';

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  resetDom();
  FakeEventSource.reset();
  resetTestLocale();
});

const DATA = ['Laptop', 'Phone', 'linux', 'ios', 'Trip planning', 'Holiday'];

async function open(setup: (hub: FakeSyncHub) => void = () => undefined) {
  await activateTestLocale('en-XA');
  const hub = new FakeSyncHub().seed();
  setup(hub);
  const env = offlineSetup(hub);
  await env.api.session();
  stops.push(env.runtime.start({ eventSource: fakeEventSource }));
  const ready = () => {
    const r = env.runtime.getState().replica;
    return r.granted !== null && r.phase !== 'loading' && !r.syncing;
  };
  await settle(ready);
  const r = await renderOffline(<SyncPage />, { runtime: env.runtime, hub });
  await screen.findByRole('heading', { name: SYNC_TEXT.title });
  await act(() => settle(ready));
  return { ...r, ...env };
}

describe('Settings → Sync in en-XA', () => {
  it('words this device, the devices with a copy, the history and the restore dialog', async () => {
    const env = await open((hub) => {
      hub.devices.get(OTHER_DEVICE)!.lastPullAt = hub.iso();
      hub.conflict('thread', 't1', 'title', 'Holiday', 'Trip planning');
    });
    const devices = screen.getByRole('region', { name: SYNC_TEXT.devices });
    const phone = await within(devices).findByRole('listitem', { name: 'Phone' });
    expect(within(phone).getByText(/:/).textContent).toMatch(/^\[/);
    const history = screen.getByRole('region', { name: SYNC_TEXT.history });
    await within(history).findByRole('list', { name: HISTORY_TEXT.list });
    // The check sees the page: without the fixture data, the names stand out.
    expect(findUnlocalized(env.container).join('\n')).toMatch(/Laptop/);
    expectFullyLocalized(env.container, { data: DATA });

    await userEvent.click(within(history).getByRole('button', { name: HISTORY_TEXT.restore }));
    const dialog = screen.getByRole('dialog', { name: HISTORY_TEXT.restoreTitle });
    expectFullyLocalized(dialog, { data: DATA });
  });

  it('words a browser that is not a device, and a copy that was removed', async () => {
    let env = await open((hub) => {
      hub.deviceId = null;
      hub.scopes = null;
    });
    expectFullyLocalized(env.container, { data: DATA });
    resetDom();

    env = await open();
    env.hub.signedIn = false;
    await act(async () => {
      await env.runtime.engine.pull();
    });
    expect(await screen.findByText(REMOVAL_TEXT.signed_out)).toBeTruthy();
    // The device list asks the Hub, which no longer answers this device: its words are the Hub's.
    expectFullyLocalized(screen.getByRole('region', { name: SYNC_TEXT.thisDevice }));
  });

  it('words a failed device list around the Hub’s own message', async () => {
    await activateTestLocale('en-XA');
    const hub = new FakeSyncHub();
    hub.devices.clear();
    hub.failNext.set('GET /api/v1/sync/devices', {
      status: 500,
      body: { code: 'server_error', message: 'Sync is unavailable.', retryable: true },
    });
    const { container } = await renderOffline(<SyncPage />, { hub });
    const devices = screen.getByRole('region', { name: SYNC_TEXT.devices });
    await within(devices).findByRole('alert');
    expectFullyLocalized(container, { data: ['Sync is unavailable.'] });
    await userEvent.click(within(devices).getByRole('button', { name: DEVICES_TEXT.retry }));
    expect(await within(devices).findByText(DEVICES_TEXT.emptyTitle)).toBeTruthy();
    expectFullyLocalized(container);
  });
});
