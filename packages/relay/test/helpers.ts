// Test plumbing: a Hub/client session pair joined by an in-memory link the test controls (it can
// hold, drop, reorder, duplicate or tamper with frames).
import {
  RelaySession,
  deriveSessionKeys,
  generateX25519,
  type DropReason,
  type RelayEnvelope,
  type RelaySessionOptions,
  type SessionKeys,
} from '../src/index.ts';

export const HUB = 'HUBROUTE00000000';
export const CLIENT = 'CLIENTROUTE00000';
export const CLIENT_ID = 'client-1';

export async function keyPair(): Promise<{ hub: SessionKeys; client: SessionKeys }> {
  const h = await generateX25519();
  const c = await generateX25519();
  const b = {
    hubRoute: HUB,
    clientRoute: CLIENT,
    clientId: CLIENT_ID,
    hubX25519: h.publicKey,
    clientX25519: c.publicKey,
  };
  return {
    hub: await deriveSessionKeys('hub', h.privateKey, b),
    client: await deriveSessionKeys('client', c.privateKey, b),
  };
}

export interface Side {
  session: RelaySession;
  received: { stream: string; data: Uint8Array }[];
  drops: { reason: DropReason; stream?: string; seq?: number }[];
  /** Frames this side sent. */
  sent: RelayEnvelope[];
  failed: string[];
  drained: string[];
}

export interface Link {
  keys: { hub: SessionKeys; client: SessionKeys };
  hub: Side;
  client: Side;
  /** Frames in flight, per direction, until `flush`. */
  toClient: RelayEnvelope[];
  toHub: RelayEnvelope[];
  /** Deliver frames immediately (default) or hold them. */
  auto: boolean;
  /** Drop frames matching this instead of delivering. */
  lose: ((env: RelayEnvelope) => boolean) | null;
  flush(): void;
}

export async function link(opts: Partial<RelaySessionOptions> = {}): Promise<Link> {
  const keys = await keyPair();
  const l: Link = {
    keys,
    hub: null as unknown as Side,
    client: null as unknown as Side,
    toClient: [],
    toHub: [],
    auto: true,
    lose: null,
    flush() {
      while (l.toClient.length || l.toHub.length) {
        const c = l.toClient.splice(0);
        const h = l.toHub.splice(0);
        for (const e of c) l.client.session.receive(structuredClone(e));
        for (const e of h) l.hub.session.receive(structuredClone(e));
      }
    },
  };
  const make = (side: 'hub' | 'client'): Side => {
    const s: Side = {
      session: null as unknown as RelaySession,
      received: [],
      drops: [],
      sent: [],
      failed: [],
      drained: [],
    };
    s.session = new RelaySession({
      clientId: CLIENT_ID,
      localRoute: side === 'hub' ? HUB : CLIENT,
      remoteRoute: side === 'hub' ? CLIENT : HUB,
      keys: side === 'hub' ? keys.hub : keys.client,
      transmit: (env) => {
        s.sent.push(structuredClone(env));
        if (l.lose?.(env)) return true;
        const q = side === 'hub' ? l.toClient : l.toHub;
        q.push(structuredClone(env));
        if (l.auto) l.flush();
        return true;
      },
      onMessage: (stream, data) => s.received.push({ stream, data }),
      onDrop: (reason, info) => s.drops.push({ reason, ...info }),
      onStreamFailed: (stream) => s.failed.push(stream),
      onDrain: (stream) => s.drained.push(stream),
      ...opts,
    });
    return s;
  };
  l.hub = make('hub');
  l.client = make('client');
  l.hub.session.setConnected(true);
  l.client.session.setConnected(true);
  return l;
}

export function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 255;
  return out;
}
