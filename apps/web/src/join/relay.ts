// Joining through the Relay (FR-137 client, FR-132; docs/22 §3.1 "Pairing", §4.4). When the QR
// code carries a Relay (`r`, `rp`), the owner chose to pair this device through it: the page makes a
// device key it cannot export, claims the Relay's pairing slot with the code (`pairWithRelay`; the
// code never reaches the Relay, only a slow hash of it), and checks the Hub's sealed offer against
// the pin. Both screens then show the same six digits (the v1 confirmation the Relay path keeps).
// The page connects to the Relay and waits for the Hub's sealed `paired` notice; it then polls its
// Add Device status through the tunnel, signed with the device key, and receives its device
// session. The pairing (Relay record and session) is kept encrypted in IndexedDB, so the app can
// reach the Hub through the Relay when the Hub's own address does not answer. The owner's decision
// arrives sealed (`waitForDecision`: approved, denied or expired); a Relay too old to pass the
// Hub's notice only drops the route, and the page then says it cannot tell which it was.
import {
  RelayError,
  isSecureRelayUrl,
  pairWithRelay,
  type PairWithRelayInput,
  type PairWithRelayResult,
} from '@nova/relay';
import { errorMessage } from '../api.ts';
import { relayStore, type PendingRelayJoin, type RelayStore } from '../relaytransport/store.ts';
import {
  connectRelay,
  headerRecord,
  type RelayConnect,
  type RelayLink,
} from '../relaytransport/transport.ts';
import { joinClient } from './client.ts';
import { exportPublicKey, generateDeviceKey, signStatus } from './crypto.ts';
import { pollStatus, sleep, type PollDeps } from './poll.ts';

export interface RelayJoinDeps {
  pair: (input: PairWithRelayInput) => Promise<PairWithRelayResult>;
  connect: RelayConnect;
  store: RelayStore;
}

export function browserRelayJoin(): RelayJoinDeps {
  return { pair: pairWithRelay, connect: connectRelay, store: relayStore() };
}

/** The Relay coordinates of a QR link, when they are well formed and safe to use. */
export function relayParams(
  q: URLSearchParams,
): { relayUrl: string; relayPairingId: string } | null {
  const r = q.get('r');
  const rp = q.get('rp');
  if (!r || !rp || r.length > 500 || !/^[A-Za-z0-9_-]{1,100}$/.test(rp)) return null;
  return isSecureRelayUrl(r) ? { relayUrl: r, relayPairingId: rp } : null;
}

/** The waiting window the Hub gives the owner (docs/22 §4.1). */
const APPROVAL_WINDOW_MS = 10 * 60_000;

/** The tunnel as a `fetch` for the join client (Hub API paths only). */
export function tunnelFetch(link: RelayLink): typeof fetch {
  return (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = raw.startsWith('/') ? raw : new URL(raw).pathname + new URL(raw).search;
    const body = typeof init?.body === 'string' ? init.body : undefined;
    return link.fetch(path, {
      method: init?.method ?? 'GET',
      headers: headerRecord(init?.headers),
      ...(body !== undefined ? { body } : {}),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
  };
}

export interface RelayJoinStart {
  relayUrl: string;
  relayPairingId: string;
  /** The canonical code. */
  code: string;
  name: string;
  platform: string;
  /** The pin from the QR (`fp`), checked against the Hub's signed offer. */
  fingerprint: string | null;
}

export interface PendingJoin {
  join: PendingRelayJoin;
  keys: CryptoKeyPair;
}

/** Claim the Relay slot; resolves with the confirmation both screens show. */
export async function startRelayJoin(
  input: RelayJoinStart,
  deps: RelayJoinDeps,
  now: () => number = Date.now,
): Promise<PendingJoin> {
  const keys = await generateDeviceKey();
  const publicKey = await exportPublicKey(keys.publicKey);
  const res = await deps.pair({
    relayUrl: input.relayUrl,
    relayPairingId: input.relayPairingId,
    code: input.code,
    device: {
      publicKey,
      sign: async (bytes) =>
        new Uint8Array(
          await crypto.subtle.sign({ name: 'Ed25519' }, keys.privateKey, new Uint8Array(bytes)),
        ),
    },
    name: input.name,
    platform: input.platform,
    kind: 'browser',
    pin: input.fingerprint,
  });
  const join: PendingRelayJoin = {
    v: 1,
    paired: res.paired,
    addPairingId: res.addPairingId,
    confirmation: res.confirmation,
    hubFingerprint: res.hubFingerprint,
    name: input.name,
    expiresAt: new Date(now() + APPROVAL_WINDOW_MS).toISOString(),
  };
  await deps.store.savePending(join, keys).catch(() => undefined);
  return { join, keys };
}

export type RelayJoinOutcome =
  | { status: 'approved'; deviceId: string | null }
  | { status: 'denied' | 'expired' | 'stopped' }
  | { status: 'failed'; error: unknown };

export interface RelayWaitOptions {
  poll?: Pick<PollDeps, 'now' | 'wait' | 'minGapMs'>;
  /** Called with true while the Relay cannot be reached. */
  onOffline?: (offline: boolean) => void;
  now?: () => number;
}

/** The Relay dropped the route without the Hub's decision (a Relay older than M7). */
export class RouteDroppedError extends Error {
  constructor() {
    super(
      'The Relay ended this request before the Hub said why: the owner denied it, or it expired. Ask for a new code on the Hub and try again.',
    );
    this.name = 'RouteDroppedError';
  }
}

/** The Hub refused to grant a session (an approval without one). */
export class NoSessionError extends Error {
  constructor() {
    super('The Hub approved this device but did not give it a session.');
    this.name = 'NoSessionError';
  }
}

/**
 * Wait for the owner, then fetch the device session through the tunnel and keep the pairing.
 * Stops (and stops the Relay connection) when `signal` aborts.
 */
export async function waitForRelayApproval(
  pending: PendingJoin,
  deps: RelayJoinDeps,
  signal: AbortSignal,
  opts: RelayWaitOptions = {},
): Promise<RelayJoinOutcome> {
  const now = opts.now ?? Date.now;
  const { join, keys } = pending;
  let hubFloor = 0;
  let dropped: (() => void) | null = null;
  const routeDropped = new Promise<'dropped'>((resolve) => {
    dropped = () => resolve('dropped');
  });
  const link = deps.connect(join.paired, {
    onHubFloor: (f) => {
      hubFloor = Math.max(hubFloor, f);
    },
    onState: (state) => {
      if (state === 'revoked' || state === 'unauthorized') dropped?.();
      else if (state === 'open') opts.onOffline?.(false);
      else if (state === 'closed') opts.onOffline?.(true);
    },
  });
  link.start();
  const stopped = new Promise<'stopped'>((resolve) => {
    if (signal.aborted) resolve('stopped');
    signal.addEventListener('abort', () => resolve('stopped'), { once: true });
  });
  const timeout = new AbortController();
  const expired = sleep(Math.max(0, Date.parse(join.expiresAt) - now()), timeout.signal).then(
    () => 'expired' as const,
  );
  try {
    const first = await Promise.race([link.waitForDecision(), routeDropped, stopped, expired]);
    if (first === 'stopped') return { status: 'stopped' };
    if (first === 'dropped' || first === 'expired' || first.decision !== 'approved') {
      await deps.store.clearPending().catch(() => undefined);
      if (first === 'dropped') return { status: 'failed', error: new RouteDroppedError() };
      return { status: first === 'expired' ? 'expired' : first.decision };
    }
    const requestId = first.requestId;
    if (!requestId) return { status: 'failed', error: new NoSessionError() };
    const client = joinClient(tunnelFetch(link));
    const out = await pollStatus(
      {
        ...opts.poll,
        poll: async (time) =>
          client.status(requestId, time, await signStatus(keys.privateKey, requestId, time)),
      },
      signal,
    );
    if (out.status === 'stopped') return out;
    await deps.store.clearPending().catch(() => undefined);
    if (out.status === 'failed') return out;
    if (out.status !== 'approved') return { status: out.status };
    const grant = out.view.grant;
    if (grant?.type !== 'session') return { status: 'failed', error: new NoSessionError() };
    const deviceId = out.view.deviceId ?? first.deviceId ?? null;
    await deps.store.save(
      {
        v: 1,
        paired: join.paired,
        token: grant.token,
        deviceId,
        hubFingerprint: join.hubFingerprint,
        name: join.name,
        pairedAt: new Date(now()).toISOString(),
        hubFloor,
        endpoints: [],
      },
      keys,
    );
    return { status: 'approved', deviceId };
  } catch (error) {
    return { status: 'failed', error };
  } finally {
    timeout.abort();
    link.stop();
  }
}

/** Errors of the Relay claim, in plain words; `wrongHub` when the offer failed its checks. */
export function relayJoinError(err: unknown): {
  message: string;
  wrongHub: boolean;
  gone: boolean;
} {
  if (err instanceof RelayError) {
    switch (err.code) {
      case 'invalid_code':
        return {
          message: 'That code is not right. Check it on the Hub.',
          wrongHub: false,
          gone: false,
        };
      case 'expired':
        return {
          message: 'This code has expired or was already used. Ask for a new code on the Hub.',
          wrongHub: false,
          gone: true,
        };
      case 'rate_limited':
        return {
          message: 'Too many tries from this network. Wait a minute and try again.',
          wrongHub: false,
          gone: false,
        };
      case 'relay_full':
        return {
          message:
            'The Relay takes no more devices right now. Try again later, or ask the owner to use another Relay.',
          wrongHub: false,
          gone: false,
        };
      default:
        return {
          message: `The Relay refused this device: ${err.message}.`,
          wrongHub: false,
          gone: false,
        };
    }
  }
  if (err instanceof NoSessionError || err instanceof RouteDroppedError)
    return { message: err.message, wrongHub: false, gone: false };
  if (err instanceof Error && /offer|pinned fingerprint|signature/i.test(err.message))
    return { message: err.message, wrongHub: true, gone: false };
  if (err instanceof TypeError)
    return {
      message: 'Cannot reach the Relay. Check your connection and try again.',
      wrongHub: false,
      gone: false,
    };
  return { message: errorMessage(err, 'Something went wrong.'), wrongHub: false, gone: false };
}
