// The joining device's page, /add-device (FR-132; docs/22 §4.1, §4.4; Add Device protocol v2),
// against the fake Hub's public routes with real WebCrypto keys: the code from the link or typed,
// the pin checked against the Hub key, commit then reveal, the six digits shown, the signed poll
// until approved (signed in, install help), denied or expired, and every stop: wrong Hub, a
// missing or bad Hub signature, a confirmation that differs, a Hub that does not answer.
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddDeviceRole } from '@nova/shared';
import { App } from '../src/App.tsx';
import { displayConfirmation } from '../src/join/crypto.ts';
import { JoinPage, type JoinPageProps } from '../src/join/JoinPage.tsx';
import { memoryJoinStore, pageNav, thisDeviceId, type JoinStore } from '../src/join/store.ts';
import { createHub, fakeEventSource } from './fakes.ts';
import { m6DevicesState } from './fakes-m6-devices.ts';
import { createAddDeviceHub, hubIdentity, joinFetch } from './fakes-m65-devices.ts';
import { resetDom } from './render.tsx';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

const realAssign = pageNav.assign;
let assign: ReturnType<typeof vi.fn<(path: string) => void>>;

beforeEach(() => {
  assign = vi.fn<(path: string) => void>();
  pageNav.assign = assign;
});

afterEach(() => {
  pageNav.assign = realAssign;
  resetDom();
  vi.unstubAllGlobals();
  window.localStorage.removeItem('nova.device.id');
  window.history.replaceState(null, '', '/');
});

/** The owner made a code; the device opens the QR link. */
async function pairing(opts: { role?: AddDeviceRole; identity?: boolean } = {}) {
  const owner = createAddDeviceHub(
    { hubKey: opts.identity === false ? null : hubIdentity(), nextCodes: ['ABCDEFGH'] },
    m6DevicesState(),
  );
  const started = await owner.api.startAddDevice({ role: opts.role ?? 'client' });
  const url = new URL(started.qr);
  return {
    owner,
    state: owner.state,
    started,
    search: url.search,
    hash: url.hash,
    fetch: joinFetch(owner.state),
  };
}

function open(
  p: { fetch: typeof fetch; search: string; hash: string },
  over: Partial<JoinPageProps> & { store?: JoinStore } = {},
) {
  return render(
    <JoinPage
      fetchImpl={p.fetch}
      store={memoryJoinStore()}
      search={p.search}
      hash={p.hash}
      userAgent={IPHONE}
      poll={{ minGapMs: 20 }}
      {...over}
    />,
  );
}

const calls = (f: typeof fetch, path: string) =>
  (f as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.filter(
    ([u]) => u === path,
  );

describe('joining from the QR link (FR-132)', () => {
  it('commits, reveals, shows the code, and is signed in once the owner approves', async () => {
    const p = await pairing();
    open(p);
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Name for this device' })).toHaveProperty(
      'value',
      'Safari on iPhone',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    expect(await screen.findByRole('heading', { name: 'Approve on the Hub' })).toBeTruthy();

    // complete carries the commitment and never the nonce; reveal carries the nonce, signed.
    const [, completeInit] = calls(p.fetch, '/api/v1/devices/add/complete')[0]!;
    const complete = JSON.parse(completeInit!.body as string) as Record<string, string>;
    expect(complete).toMatchObject({
      pairingId: p.started.pairingId,
      code: 'ABCD-EFGH',
      kind: 'browser',
      name: 'Safari on iPhone',
      platform: 'iOS',
    });
    expect(complete.commitment).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Object.keys(complete)).not.toContain('nonce');
    const [, revealInit] = calls(p.fetch, '/api/v1/devices/add/reveal')[0]!;
    expect(new Headers(revealInit!.headers).get('x-nova-device-signature')).toMatch(
      /^[A-Za-z0-9_-]{86}$/,
    );

    // The six digits the Hub computed (independently) are the ones on screen.
    const req = p.state.requests[0]!;
    expect(req.phase).toBe('revealed');
    expect(screen.getByText(displayConfirmation(req.view.confirmation))).toBeTruthy();
    expect(screen.getByText('Waiting for the owner to approve this device.')).toBeTruthy();

    await act(() => p.owner.api.approveAddRequest(req.view.id, req.view.confirmation));
    expect(await screen.findByRole('heading', { name: 'This device is added' })).toBeTruthy();
    expect(p.state.sessions).toEqual([`nvs_${req.view.id}`]);
    expect(thisDeviceId()).toBe(req.view.deviceId);
    // Every poll was signed over a later time than the one before.
    const times = p.state.polls.map((x) => x.time);
    expect(times.length).toBeGreaterThan(0);
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);

    expect(screen.getByText(/Add to Home Screen/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open Nova' }));
    expect(assign).toHaveBeenCalledWith('/');
  });

  it('takes the code out of the address at once', async () => {
    const p = await pairing();
    window.history.replaceState(null, '', `/add-device${p.search}${p.hash}`);
    render(<JoinPage fetchImpl={p.fetch} store={memoryJoinStore()} userAgent={IPHONE} />);
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe(p.search);
  });

  it('stops before sending anything when the Hub is not the one in the code', async () => {
    const p = await pairing();
    const other = hubIdentity();
    open({ ...p, search: p.search.replace(/fp=[^&]+/, `fp=${other.fingerprint}`) });
    expect(await screen.findByRole('heading', { name: 'This is not your Hub' })).toBeTruthy();
    expect(calls(p.fetch, '/api/v1/devices/add/complete')).toHaveLength(0);
    // A pin but a Hub without an identity is the same stop.
    const bare = await pairing({ identity: false });
    resetDom();
    open({ ...bare, search: `${bare.search}&fp=${other.fingerprint}` });
    expect(await screen.findByRole('heading', { name: 'This is not your Hub' })).toBeTruthy();
  });

  it('says it needs a secure connection on plain HTTP, instead of blaming the Hub', async () => {
    const p = await pairing();
    // A browser on http://<LAN address> is not a secure context: no crypto.subtle.
    vi.stubGlobal('isSecureContext', false);
    open(p);
    expect(
      await screen.findByRole('heading', { name: 'This page needs a secure connection' }),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Network → Trust');
    expect(screen.queryByRole('heading', { name: 'This is not your Hub' })).toBeNull();
    // Nothing reached the Hub, not even its hello.
    expect((p.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it('stops when the Hub does not sign the confirmation, with a pin', async () => {
    const p = await pairing();
    p.state.tamper = { hubSignature: null };
    open(p);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    expect(await screen.findByRole('heading', { name: 'This is not your Hub' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Approve on the Hub' })).toBeNull();
    // A signature by another key is no better.
    const q = await pairing();
    q.state.tamper = { hubSignature: 'A'.repeat(86) };
    resetDom();
    open(q);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    expect(await screen.findByRole('heading', { name: 'This is not your Hub' })).toBeTruthy();
  });

  it('stops when the Hub’s confirmation differs from its own', async () => {
    const p = await pairing({ identity: false });
    p.state.tamper = { confirmation: '000000' };
    open(p);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    expect(await screen.findByRole('heading', { name: 'The codes do not match' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/Do not approve this request/);
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByRole('textbox', { name: 'Code shown on the Hub' })).toBeTruthy();
  });
});

describe('typing the code', () => {
  it('asks for the code, says how many tries are left, and joins with the right one', async () => {
    const p = await pairing();
    open({ ...p, search: '', hash: '' }, { userAgent: CHROME });
    const code = await screen.findByRole('textbox', { name: 'Code shown on the Hub' });
    expect(screen.getByRole('textbox', { name: 'Name for this device' })).toHaveProperty(
      'value',
      'Chrome on Linux',
    );
    await userEvent.type(code, 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    expect(
      screen.getByText('Enter the 8-character code shown on the Hub, like ABCD-EFGH.'),
    ).toBeTruthy();
    await userEvent.clear(code);
    await userEvent.type(code, 'ZZZZ-ZZZZ');
    await userEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That code is not right. 4 tries left.',
    );
    await userEvent.clear(code);
    await userEvent.type(code, 'abcd efgh');
    await userEvent.click(screen.getByRole('button', { name: 'Ask to join' }));
    expect(await screen.findByRole('heading', { name: 'Approve on the Hub' })).toBeTruthy();
    const body = JSON.parse(
      calls(p.fetch, '/api/v1/devices/add/complete').at(-1)![1]!.body as string,
    ) as Record<string, unknown>;
    expect(body.pairingId).toBeUndefined();
  });

  it('says a compute node’s code is not for a browser, and a used code has expired', async () => {
    const p = await pairing({ role: 'compute' });
    open(p);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /This code is for a compute node or a Wake helper/,
    );
    // The link's code cannot work: the page asks for a new one.
    expect(screen.getByRole('textbox', { name: 'Code shown on the Hub' })).toBeTruthy();

    const q = await pairing();
    q.state.pairings[0]!.status = 'used';
    resetDom();
    open(q);
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired or was already used/);
  });

  it('says when the Hub does not answer, and retries', async () => {
    const p = await pairing();
    p.state.offline = 1;
    open(p);
    expect(await screen.findByRole('heading', { name: 'Cannot reach the Hub' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Ask to join' })).toBeTruthy();
  });
});

describe('waiting for the owner', () => {
  async function waiting(over: Partial<JoinPageProps> = {}, store = memoryJoinStore()) {
    const p = await pairing();
    const utils = open(p, { store, ...over });
    await userEvent.click(await screen.findByRole('button', { name: 'Ask to join' }));
    await screen.findByRole('heading', { name: 'Approve on the Hub' });
    return { ...p, ...utils, store, req: p.state.requests[0]! };
  }

  it('says when the owner denies it, and starts over with a new code', async () => {
    const w = await waiting();
    await act(() => w.owner.api.denyAddRequest(w.req.view.id));
    expect(await screen.findByRole('heading', { name: 'Not approved' })).toBeTruthy();
    expect(await w.store.load()).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Use a new code' }));
    expect(screen.getByRole('textbox', { name: 'Code shown on the Hub' })).toBeTruthy();
  });

  it('says when the request expires', async () => {
    const w = await waiting();
    w.req.view = { ...w.req.view, expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(await screen.findByRole('heading', { name: 'The request expired' })).toBeTruthy();
  });

  it('keeps trying while the Hub is unreachable', async () => {
    const w = await waiting();
    w.state.offline = 3;
    expect(await screen.findByText('Cannot reach the Hub. Trying again…')).toBeTruthy();
    expect(await screen.findByText('Waiting for the owner to approve this device.')).toBeTruthy();
    await act(() => w.owner.api.approveAddRequest(w.req.view.id, w.req.view.confirmation));
    expect(await screen.findByRole('heading', { name: 'This device is added' })).toBeTruthy();
  });

  it('keeps waiting after a reload, with the same key', async () => {
    const store = memoryJoinStore();
    const w = await waiting({}, store);
    const saved = await store.load();
    expect(saved?.requestId).toBe(w.req.view.id);
    w.unmount();
    open(w, { store });
    expect(await screen.findByRole('heading', { name: 'Approve on the Hub' })).toBeTruthy();
    expect(calls(w.fetch, '/api/v1/devices/add/complete')).toHaveLength(1);
    await act(() => w.owner.api.approveAddRequest(w.req.view.id, w.req.view.confirmation));
    expect(await screen.findByRole('heading', { name: 'This device is added' })).toBeTruthy();
  });

  it('offers the browser’s install prompt, or says it cannot install', async () => {
    const w = await waiting({ userAgent: CHROME });
    const prompt = vi.fn(() => Promise.resolve());
    const ev = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
    act(() => {
      window.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    await act(() => w.owner.api.approveAddRequest(w.req.view.id, w.req.view.confirmation));
    await userEvent.click(await screen.findByRole('button', { name: 'Install Nova' }));
    expect(prompt).toHaveBeenCalled();
    expect(await screen.findByText('Nova is installed. Open it from your apps.')).toBeTruthy();

    resetDom();
    const f = await waiting({ userAgent: FIREFOX });
    await act(() => f.owner.api.approveAddRequest(f.req.view.id, f.req.view.confirmation));
    expect(await screen.findByText(/This browser cannot install Nova as an app/)).toBeTruthy();
  });
});

describe('the app at /add-device', () => {
  it('shows the join page without a session', async () => {
    const p = await pairing();
    vi.stubGlobal('fetch', p.fetch);
    window.history.replaceState(null, '', `/add-device${p.search}`);
    const hub = createHub();
    render(<App api={hub.api} eventSource={fakeEventSource} takeSetupCode={() => null} />);
    expect(await screen.findByRole('heading', { name: 'Add this device' })).toBeTruthy();
    await waitFor(() => expect(calls(p.fetch, '/api/v1/hello')).toHaveLength(1));
    expect(hub.api.session).not.toHaveBeenCalled();
    expect(hub.api.hello).not.toHaveBeenCalled();
    // No code in the link: it asks for one.
    expect(await screen.findByRole('textbox', { name: 'Code shown on the Hub' })).toBeTruthy();
  });
});
