// An in-memory Relay for client tests: fake WebSockets whose frames the test routes, answering
// pings itself like the real service.
import { parseEnvelope, type RelayEnvelope, type WebSocketLike } from '../src/index.ts';

export class FakeSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  readonly protocols: string[];
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  /** What the "server" does with each frame. */
  onSend: ((data: string) => void) | null = null;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(data);
    this.onSend?.(data);
  }

  close(code = 1000, reason = ''): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  // ---- the server's side ----
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(env: RelayEnvelope | string): void {
    this.onmessage?.({ data: typeof env === 'string' ? env : JSON.stringify(env) });
  }

  drop(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  sentEnvelopes(): RelayEnvelope[] {
    return this.sent.map((s) => {
      const c = parseEnvelope(s);
      if (!c.ok) throw new Error(c.error);
      return c.envelope;
    });
  }
}

/** Routes data and ack frames between the sockets of two routes; answers pings. */
export class FakeRelay {
  readonly sockets: FakeSocket[] = [];
  readonly byRoute = new Map<string, FakeSocket>();
  /** Hold frames (the peer is offline) or deliver them at once. */
  hold = false;
  answerPings = true;
  /** Fail every new connection as a network error would (close 1006). */
  down = false;
  readonly held: RelayEnvelope[] = [];
  /** route id by bearer token */
  readonly tokens = new Map<string, string>();

  factory = (url: string, protocols: string[]): WebSocketLike => {
    const s = new FakeSocket(url, protocols);
    this.sockets.push(s);
    const token = protocols.find((p) => p.startsWith('bearer.'))?.slice(7) ?? '';
    const route = this.tokens.get(token);
    s.onSend = (data) => {
      const c = parseEnvelope(data);
      if (!c.ok) return;
      const env = c.envelope;
      if (env.kind === 'ping') {
        if (this.answerPings) s.deliver({ v: 1, kind: 'pong', to: env.from, from: env.to });
        return;
      }
      if (this.hold) this.held.push(env);
      else this.route(env);
    };
    queueMicrotask(() => {
      if (this.down) {
        s.drop(1006, '');
        return;
      }
      if (!route) {
        s.drop(4001, 'unauthorized');
        return;
      }
      this.byRoute.set(route, s);
      s.open();
    });
    return s;
  };

  route(env: RelayEnvelope): void {
    const target = this.byRoute.get(env.to);
    if (target && target.readyState === 1) target.deliver(env);
  }

  release(): void {
    for (const e of this.held.splice(0)) this.route(e);
  }
}
