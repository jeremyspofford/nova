// Joining through the Relay from the join page (FR-137 client, FR-132; docs/22 §3.1, §4.4): a QR
// link carrying `r` and `rp` claims the Relay slot with the code (kind browser, the pin checked in
// the offer), shows the six digits, waits for the Hub's notice over the Relay, polls its status
// through the tunnel signed with its device key, and keeps the pairing (sealed) for the app. A
// Relay that drops the route means not approved; wrong, used and tampered codes stop with the
// reason; a reload keeps waiting; an unsafe Relay address is ignored.
/* eslint-disable @typescript-eslint/require-await */
import { createPublicKey, verify } from 'node:crypto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayError } from '@nova/relay';
import { JoinPage, readJoinParams, type JoinPageProps } from '../src/join/JoinPage.tsx';
import {
  NoSessionError,
  RouteDroppedError,
  relayJoinError,
  relayParams,
  startRelayJoin,
  tunnelFetch,
  waitForRelayApproval,
  type RelayJoinDeps,
} from '../src/join/relay.ts';
import { memoryJoinStore, pageNav, thisDeviceId } from '../src/join/store.ts';
import { memoryKv, relayStore } from '../src/relaytransport/store.ts';
import { FakeRelayLink, fakeConnect, json, pairedClient } from './fakes-m7-push.ts';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const LINK = '?p=pair1&fp=FP&r=wss%3A%2F%2Frelay.example&rp=rp1';

const realAssign = pageNav.assign;
beforeEach(() => {
  pageNav.assign = vi.fn();
});
afterEach(() => {
  pageNav.assign = realAssign;
  cleanup();
  window.localStorage.removeItem('nova.device.id');
  window.history.replaceState(null, '', '/');
});

/** The Relay and the Hub behind it: the claim, then signed status polls through the tunnel. */
function relayWorld(
  opts: { claim?: (code: string) => Error | null; grant?: boolean; requestId?: string | null } = {},
) {
  const store = relayStore(memoryKv());
  let deviceKey = '';
  let lastTime = 0;
  let granted = false;
  const polls: { time: number; ok: boolean }[] = [];
  const pair = vi.fn<RelayJoinDeps['pair']>(async (input) => {
    const refusal = opts.claim?.(input.code) ?? null;
    if (refusal) throw refusal;
    deviceKey = input.device.publicKey;
    return {
      paired: pairedClient(),
      addPairingId: 'pair1',
      hubFingerprint: 'FP',
      confirmation: '123456',
    };
  });
  const connect = fakeConnect(async (path, init) => {
    const m = /^\/api\/v1\/devices\/add\/status\/([^/?]+)$/.exec(path);
    if (!m) return json({ error: { code: 'not_found', message: 'no' } }, 404);
    const time = Number(init.headers['x-nova-device-time']);
    const sig = init.headers['x-nova-device-signature'] ?? '';
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: deviceKey },
      format: 'jwk',
    });
    const ok = verify(
      null,
      Buffer.from(`nova-add-device-status-v1.${m[1]}.${time}`),
      key,
      Buffer.from(sig, 'base64url'),
    );
    polls.push({ time, ok });
    if (!ok)
      return json(
        { error: { code: 'unauthorized', message: 'bad', details: { reason: 'bad_signature' } } },
        401,
      );
    if (time <= lastTime)
      return json(
        { error: { code: 'unauthorized', message: 'old', details: { reason: 'replayed' } } },
        401,
      );
    lastTime = time;
    const grant =
      opts.grant === false || granted ? undefined : { type: 'session', token: 'nvs_relay' };
    granted = true;
    return json({ status: 'approved', deviceId: 'dev9', ...(grant ? { grant } : {}) });
  });
  const deps: RelayJoinDeps = { pair, connect, store };
  return { deps, pair, connect, store, polls, link: () => connect.links.at(-1)! };
}

function open(
  world: ReturnType<typeof relayWorld>,
  over: Partial<JoinPageProps> = {},
  link = { search: LINK, hash: '#c=ABCD-EFGH' },
) {
  const fetchImpl = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
  const utils = render(
    <JoinPage
      fetchImpl={fetchImpl as unknown as typeof fetch}
      store={memoryJoinStore()}
      search={link.search}
      hash={link.hash}
      userAgent={IPHONE}
      poll={{ minGapMs: 10 }}
      relay={world.deps}
      {...over}
    />,
  );
  return { ...utils, fetchImpl };
}

describe('joining through the Relay (FR-137 client)', () => {
  it('claims the slot, shows the code, and keeps the pairing once the owner approves', async () => {
    const w = relayWorld();
    const { fetchImpl } = open(w);
    // The Hub's own address is not needed: the offer carries the Hub's signed key.
    expect(await screen.findByText(/pairs through the Relay/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    expect(await screen.findByRole('heading', { name: 'Approve on the Hub' })).toBeTruthy();
    expect(screen.getByText('123 456')).toBeTruthy();
    expect(
      screen.getByText('Waiting for the owner to approve this device, through the Relay.'),
    ).toBeTruthy();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(w.pair).toHaveBeenCalledWith(
      expect.objectContaining({
        relayUrl: 'wss://relay.example',
        relayPairingId: 'rp1',
        code: 'ABCDEFGH',
        kind: 'browser',
        pin: 'FP',
        name: 'Safari on iPhone',
        platform: 'iOS',
      }),
    );
    // The join waits across a reload.
    expect((await w.store.loadPending())?.join.confirmation).toBe('123456');

    const link = w.link();
    expect(link.started).toBe(1);
    act(() => link.notifyPaired({ requestId: 'req1', deviceId: 'dev9' }));
    expect(await screen.findByRole('heading', { name: 'This device is added' })).toBeTruthy();
    expect(screen.getByText(/reaches it through the Relay/)).toBeTruthy();
    // Every poll went through the tunnel, signed with the device key.
    expect(w.polls.length).toBeGreaterThan(0);
    expect(w.polls.every((p) => p.ok)).toBe(true);
    const pairing = await w.store.loadPending();
    expect(pairing).toBeNull();
    const kept = await w.store.load();
    expect(kept).toMatchObject({
      token: 'nvs_relay',
      deviceId: 'dev9',
      hubFingerprint: 'FP',
      hubFloor: 1234,
      name: 'Safari on iPhone',
    });
    expect(thisDeviceId()).toBe('dev9');
    await waitFor(() => expect(link.stopped).toBeGreaterThan(0));
    await userEvent.click(screen.getByRole('button', { name: 'Open Nova' }));
    expect(pageNav.assign).toHaveBeenCalledWith('/');
  });

  it('says so when the owner denies it', async () => {
    const w = relayWorld();
    open(w);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    await screen.findByText('123 456');
    act(() => w.link().setState('closed'));
    expect(await screen.findByText('Cannot reach the Relay. Trying again…')).toBeTruthy();
    act(() => w.link().setState('open'));
    // The Hub's sealed decision comes first; the Relay drops the route after it.
    act(() => w.link().notifyDecided('denied'));
    act(() => w.link().setState('revoked'));
    expect(await screen.findByRole('heading', { name: 'Not approved' })).toBeTruthy();
    expect(await w.store.loadPending()).toBeNull();
    expect(await w.store.load()).toBeNull();
  });

  it('says so when the request expired on the Hub', async () => {
    const w = relayWorld();
    open(w);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    await screen.findByText('123 456');
    act(() => w.link().notifyDecided('expired'));
    expect(await screen.findByRole('heading', { name: 'The request expired' })).toBeTruthy();
    expect(await w.store.loadPending()).toBeNull();
  });

  it('says it cannot tell when an older Relay only drops the route', async () => {
    const w = relayWorld();
    open(w);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    await screen.findByText('123 456');
    act(() => w.link().setState('revoked'));
    expect(await screen.findByRole('heading', { name: 'This device was not added' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(
      /before the Hub said why: the owner denied it, or it expired/,
    );
    expect(await w.store.loadPending()).toBeNull();
  });

  it('keeps the form with the reason for a wrong code', async () => {
    const w = relayWorld({
      claim: () => new RelayError('invalid_code', 'the code does not match', 401),
    });
    open(w);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That code is not right. Check it on the Hub.',
    );
    expect(screen.getByRole('button', { name: 'Ask to join' })).toBeTruthy();
  });

  it('asks for a new code when the slot is gone', async () => {
    const w = relayWorld({
      claim: () => new RelayError('expired', 'this pairing has expired', 410),
    });
    open(w);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired or was already used/);
    expect(screen.getByRole('textbox', { name: 'Code shown on the Hub' })).toBeTruthy();
  });

  it('stops when the offer does not match the pin', async () => {
    const w = relayWorld({
      claim: () => new Error('the Hub identity does not match the pinned fingerprint'),
    });
    open(w);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    expect(await screen.findByRole('heading', { name: 'This is not your Hub' })).toBeTruthy();
  });

  it('keeps waiting after a reload, and Start over drops the join', async () => {
    const w = relayWorld();
    const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    await w.store.savePending(
      {
        v: 1,
        paired: pairedClient(),
        addPairingId: 'pair1',
        confirmation: '654321',
        hubFingerprint: 'FP',
        name: 'Phone',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      keys,
    );
    open(w);
    expect(await screen.findByText('654 321')).toBeTruthy();
    expect(w.link().started).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(await screen.findByRole('textbox', { name: 'Code shown on the Hub' })).toBeTruthy();
    await waitFor(async () => expect(await w.store.loadPending()).toBeNull());
  });

  it('joins directly when the Relay address is not a safe one', async () => {
    const w = relayWorld();
    const { fetchImpl } = open(
      w,
      {},
      {
        search: '?p=pair1&r=http%3A%2F%2Frelay.example&rp=rp1',
        hash: '#c=ABCD-EFGH',
      },
    );
    // The page asked the Hub directly (and here it does not answer).
    expect(await screen.findByRole('heading', { name: 'Cannot reach the Hub' })).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalled();
    expect(w.pair).not.toHaveBeenCalled();
  });
});

describe('the Relay join, step by step', () => {
  it('reads only safe Relay coordinates', () => {
    expect(relayParams(new URLSearchParams('r=wss://relay.example&rp=a1'))).toEqual({
      relayUrl: 'wss://relay.example',
      relayPairingId: 'a1',
    });
    expect(relayParams(new URLSearchParams('r=ws://127.0.0.1:9&rp=a1'))).not.toBeNull();
    expect(relayParams(new URLSearchParams('r=ws://relay.example&rp=a1'))).toBeNull();
    expect(relayParams(new URLSearchParams('r=wss://relay.example&rp=bad id'))).toBeNull();
    expect(relayParams(new URLSearchParams('rp=a1'))).toBeNull();
    expect(readJoinParams(LINK, '#c=ABCDEFGH').relay).toEqual({
      relayUrl: 'wss://relay.example',
      relayPairingId: 'rp1',
    });
  });

  it('explains every refusal', () => {
    expect(relayJoinError(new RelayError('rate_limited', 'x', 429)).message).toMatch(/Too many/);
    expect(relayJoinError(new RelayError('relay_full', 'x', 503)).message).toMatch(/no more/);
    expect(relayJoinError(new RelayError('pairing_failed', 'no answer')).message).toBe(
      'The Relay refused this device: no answer.',
    );
    expect(relayJoinError(new TypeError('Failed to fetch')).message).toMatch(
      /Cannot reach the Relay/,
    );
    expect(relayJoinError(new NoSessionError()).message).toMatch(/did not give it a session/);
    expect(relayJoinError(new RouteDroppedError()).message).toMatch(/before the Hub said why/);
    expect(relayJoinError(new Error('the Hub offer is malformed')).wrongHub).toBe(true);
    expect(relayJoinError('odd').message).toBe('Something went wrong.');
  });

  it('turns tunnel calls into relative Hub paths', async () => {
    const link = new FakeRelayLink({}, (path, init) => json({ path, method: init.method }));
    const f = tunnelFetch(link);
    await f('/api/v1/a', { method: 'POST', body: '{}', headers: { 'x-a': '1' } });
    await f(new URL('https://hub/api/v1/b?x=1'));
    await f(new Request('https://hub/api/v1/c'));
    expect(link.calls.map((c) => [c.method, c.path, c.body ?? null])).toEqual([
      ['POST', '/api/v1/a', '{}'],
      ['GET', '/api/v1/b?x=1', null],
      ['GET', '/api/v1/c', null],
    ]);
  });

  it('fails an approval without a session, a notice without a request, and runs out of time', async () => {
    const start = {
      relayUrl: 'wss://relay.example',
      relayPairingId: 'rp1',
      code: 'ABCDEFGH',
      name: 'Phone',
      platform: 'iOS',
      fingerprint: null,
    };
    const noGrant = relayWorld({ grant: false });
    const pending = await startRelayJoin(start, noGrant.deps);
    const ctl = new AbortController();
    const out = waitForRelayApproval(pending, noGrant.deps, ctl.signal, { poll: { minGapMs: 5 } });
    await vi.waitFor(() => expect(noGrant.connect.links).toHaveLength(1));
    noGrant.link().notifyPaired({ requestId: 'r1', deviceId: null });
    expect(await out).toMatchObject({ status: 'failed', error: expect.any(NoSessionError) });

    const noRequest = relayWorld();
    const p2 = await startRelayJoin(start, noRequest.deps);
    const out2 = waitForRelayApproval(p2, noRequest.deps, ctl.signal);
    await vi.waitFor(() => expect(noRequest.connect.links).toHaveLength(1));
    noRequest.link().notifyPaired({ requestId: null, deviceId: null });
    expect((await out2).status).toBe('failed');

    const late = relayWorld();
    const p3 = await startRelayJoin(start, late.deps, () => Date.now() - 11 * 60_000);
    expect(await waitForRelayApproval(p3, late.deps, ctl.signal)).toEqual({ status: 'expired' });

    const stopped = relayWorld();
    const p4 = await startRelayJoin(start, stopped.deps);
    const ctl2 = new AbortController();
    const out4 = waitForRelayApproval(p4, stopped.deps, ctl2.signal);
    ctl2.abort();
    expect(await out4).toEqual({ status: 'stopped' });
    expect(stopped.link().stopped).toBe(1);
  });
});
