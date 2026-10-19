// Reads while the Hub is unreachable (FR-112, FR-129, docs/21 §9), through the app's own client:
// with an offline copy the chat list, a chat's messages, projects, spaces and pages come from it
// (with what this page saw for what the copy lacks), a proxy's 502 counts as unreachable, and the
// app can start with no Hub at all; without a copy only what this page loaded comes back,
// read-only, and nothing is kept on the device. The banner says which, and Try again.
import { act, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, errorMessage } from '../src/api.ts';
import { OfflineBanner } from '../src/offline/OfflineBanner.tsx';
import { FakeEventSource, fakeEventSource } from './fakes.ts';
import { FakeSyncHub, offlineSetup, renderOffline, settle } from './fakes-m7-sync.ts';
import { resetDom } from './render.tsx';

afterEach(() => {
  resetDom();
  FakeEventSource.reset();
});

/** The app as it starts: hello, session and settings online, then the offline layer. */
async function online(hub = new FakeSyncHub().seed()) {
  const env = offlineSetup(hub);
  await env.api.hello();
  await env.api.session();
  await env.api.settings();
  const stop = env.runtime.start({ eventSource: fakeEventSource });
  await settle(() => {
    const r = env.runtime.getState().replica;
    return r.granted !== null && r.phase !== 'loading' && !r.syncing;
  });
  return { ...env, stop };
}

describe('offline reads from the copy (FR-129)', () => {
  it('lists chats, opens messages, projects, spaces and pages from the copy', async () => {
    const env = await online();
    // What the page saw online fills in what the copy does not carry.
    await env.api.getThread('t1');
    await env.api.listSpaces();
    await env.api.listSpacePages('s1');
    env.hub.down = true;

    const chats = await env.api.listThreads({ mode: 'chat', limit: 50 });
    expect(chats.items.map((t) => [t.id, t.title, t.projectId])).toEqual([
      ['t1', 'Trip planning', 'p1'],
    ]);
    expect(chats.items[0]!.model).toBe('pa1/mock-smart');
    const archived = await env.api.listThreads({ mode: 'chat', archived: true });
    expect(archived.items.map((t) => t.id)).toEqual(['t2']);
    expect((await env.api.listThreads({ q: 'coast' })).items.map((t) => t.id)).toEqual(['t1']);

    const detail = await env.api.getThread('t1');
    expect(detail.messages.map((m) => [m.role, m.parts[0]])).toEqual([
      ['user', { type: 'text', text: 'Where should we go?' }],
      ['assistant', { type: 'text', text: 'Try the coast.' }],
    ]);
    expect(detail.messages[1]!.parentId).toBe('m1');

    const projects = await env.api.listProjects();
    expect(projects.items).toMatchObject([
      { id: 'p1', name: 'Garden', instructions: 'Answer briefly.', threadCount: 1 },
    ]);
    expect((await env.api.getProject('p1')).memoryScope).toBe('shared');

    expect((await env.api.listSpaces()).items).toMatchObject([
      { id: 's1', name: 'Field notes', pageCount: 1 },
    ]);
    expect((await env.api.listSpacePages('s1')).items).toMatchObject([
      { id: 'pg1', title: 'Packing', version: 3 },
    ]);
    expect(await env.api.getSpacePage('s1', 'pg1')).toMatchObject({ content: 'Boots', version: 3 });

    expect(env.runtime.getState()).toMatchObject({ hub: 'offline', reads: 'replica' });
    // What the copy does not hold fails as before.
    const err = await env.api.listApprovals().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(errorMessage(err)).toMatch(/Cannot reach the Hub/);
    await expect(env.api.getThread('nope')).rejects.toBeInstanceOf(TypeError);
    env.stop();
  });

  it('treats a proxy with no Hub behind it as unreachable', async () => {
    const env = await online();
    env.hub.gateway = 502;
    expect((await env.api.getThread('t1')).thread.title).toBe('Trip planning');
    expect(env.runtime.getState().hub).toBe('offline');
    env.hub.gateway = null;
    // A Hub error with its own body is an answer, not an outage.
    env.hub.failNext.set('GET /api/v1/projects', {
      status: 503,
      body: { code: 'unavailable', message: 'busy', retryable: true },
    });
    await expect(env.api.listProjects()).rejects.toBeInstanceOf(ApiError);
    expect(env.runtime.getState().hub).toBe('online');
    env.stop();
  });

  it('starts with no Hub from the answers kept with the copy', async () => {
    const first = await online();
    first.stop();
    first.hub.down = true;
    const again = offlineSetup(first.hub, first.kv);
    expect(await again.api.hello()).toMatchObject({ name: 'Nova', setupRequired: false });
    expect(await again.api.session()).toMatchObject({ accountId: 'acc1', displayName: 'Sam' });
    // Security-relevant settings stay on the Hub; the rest is kept for the start.
    expect(await again.api.settings()).toEqual({
      settings: [{ key: 'appearance.theme', value: 'light', source: 'global', locked: false }],
    });
    const chats = await again.api.listThreads({ mode: 'chat' });
    expect(chats.items.map((t) => t.title)).toEqual(['Trip planning']);
    // Space names and page versions come from the copy itself.
    expect((await again.api.listSpaces()).items).toMatchObject([{ id: 's1', name: 'Field notes' }]);
    expect(await again.api.getSpacePage('s1', 'pg1')).toMatchObject({
      version: 3,
      content: 'Boots',
    });
    const stop = again.runtime.start({ eventSource: fakeEventSource });
    await settle(() => again.runtime.getState().replica.phase === 'ready');
    expect(again.runtime.getState().hub).toBe('offline');
    stop();
  });
});

describe('offline reads without a copy', () => {
  it('shows only what this page loaded, read-only, and keeps nothing on the device', async () => {
    const hub = new FakeSyncHub().seed();
    hub.deviceId = null;
    hub.scopes = null;
    const env = await online(hub);
    expect(env.runtime.getState().replica).toMatchObject({ phase: 'off', granted: false });
    await env.api.listThreads({ mode: 'chat' });
    await env.api.getThread('t1');
    hub.down = true;
    expect((await env.api.listThreads({ mode: 'chat' })).items.map((t) => t.id)).toEqual(['t1']);
    expect((await env.api.getThread('t1')).messages).toHaveLength(2);
    await expect(env.api.listProjects()).rejects.toBeInstanceOf(TypeError);
    await expect(env.api.updateThread('t1', { title: 'Lisbon' })).rejects.toBeInstanceOf(TypeError);
    expect(env.runtime.getState()).toMatchObject({ reads: 'memory', queue: [] });
    for (const store of env.kv.raw.values()) expect(store.size).toBe(0);
    env.stop();
  });
});

describe('the offline banner', () => {
  it('says the views come from the copy, counts what waits, and tries again', async () => {
    const env = await online();
    await renderOffline(<OfflineBanner />, { runtime: env.runtime, hub: env.hub });
    expect(screen.getByRole('status', { name: 'Connection to the Hub' }).textContent).toBe('');
    env.hub.down = true;
    await act(async () => {
      await env.api.updateThread('t1', { title: 'Lisbon' });
    });
    const banner = await screen.findByText('Offline: showing what this device has.');
    expect(banner.closest('[role="status"]')!.textContent).toMatch(
      /offline copy was last updated .*1 change waiting to send\./,
    );
    expect(screen.getByRole('link', { name: 'Review' }).getAttribute('href')).toBe(
      '/settings/sync',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Offline: showing what this device has.')).toBeTruthy();
    env.hub.down = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/Offline: showing/)).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole('status', { name: 'Connection to the Hub' }).textContent).toBe(''),
    );
    expect(env.hub.value('thread', 't1', 'title')).toBe('Lisbon');
    env.stop();
  });

  it('says only loaded views show and changes cannot be saved without a copy', async () => {
    const hub = new FakeSyncHub().seed();
    hub.deviceId = null;
    hub.scopes = null;
    const env = await online(hub);
    await renderOffline(<OfflineBanner />, { runtime: env.runtime, hub });
    hub.down = true;
    await act(async () => {
      await env.api.listThreads().catch(() => undefined);
    });
    expect(
      await screen.findByText(
        /Only what this page already loaded is shown, and changes cannot be saved/,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Review' })).toBeNull();
    env.stop();
  });

  it('tells once that the copy was removed', async () => {
    const env = await online();
    await renderOffline(<OfflineBanner />, { runtime: env.runtime, hub: env.hub });
    env.hub.signedIn = false;
    await act(async () => {
      await env.runtime.engine.pull();
    });
    expect(
      await screen.findByText(/signed out of the Hub, so its offline copy was removed/),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/offline copy was removed/)).toBeNull();
    env.stop();
  });

  it('renders nothing without the offline layer', async () => {
    const { container } = await renderOffline(<OfflineBanner />);
    expect(container.textContent).toBe('');
  });
});
