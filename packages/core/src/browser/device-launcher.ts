// The device launcher (FR-209, docs/11 §4.6; ADR-096 D7): the agent browser runs on a connected
// computer. novad's `browser` module launches Chromium there with a fresh temporary profile and
// its own per-session egress filter (`/agent/v1/browser/launch`), and passes the DevTools
// WebSocket through `GET /agent/v1/browser/cdp/<sessionId>` after checking the management token.
// The Hub reaches it through a relay on its own loopback: Playwright connects to
// `ws://127.0.0.1:<port>/<random>` with `connectOverCDP`, and the relay opens the device's
// management connection (plain TCP, or mutual TLS under D1, from the devices area), sends the
// upgrade request rewritten to the session's path with the management token, and then pipes bytes
// both ways. So the token and the TLS client certificate never reach Playwright, and nothing but
// that one upgrade goes through. Closing the session closes the relay and tells novad, which
// deletes the profile and reports its egress counts.
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { NovaError, uuidv7, type DeviceGrantee } from '@nova/shared';
import type { Logger } from '@nova/telemetry';
import type { BrowserDriver, DriverLaunchOptions, DriverSession } from './types.ts';

/** The request head a relay reads at most before refusing the connection. */
const MAX_HEAD_BYTES = 16 * 1024;
/** Headers of the client's upgrade request the relay passes on (nothing else). */
const PASSED_HEADERS = new Set([
  'upgrade',
  'connection',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]);

export interface DeviceBrowserLaunch {
  sessionId: string;
  cdpPath: string;
}

/** What novad's egress filter allowed and refused in a session (D7 close). */
export interface DeviceEgressCounts {
  allowed: number;
  refused: number;
}

/** A connection to a device's management endpoint, ready for one HTTP request. */
export interface DeviceManagementSocket {
  socket: Duplex;
  /** The `Host` header for the request. */
  host: string;
  /** The `Authorization` header (the management token). */
  authorization: string;
}

/** The Hub's side of novad's browser routes (D7). The devices area implements it. */
export interface DeviceBrowserLink {
  launch(input: {
    accountId: string;
    deviceId: string;
    sessionId: string;
    grantee: DeviceGrantee;
    allowHosts: string[];
    headless: boolean;
  }): Promise<DeviceBrowserLaunch>;
  close(input: {
    accountId: string;
    deviceId: string;
    sessionId: string;
  }): Promise<{ egress: DeviceEgressCounts | null }>;
  /** Open the management connection (TCP, or TLS with the Hub's client certificate under D1). */
  open(input: { accountId: string; deviceId: string }): Promise<DeviceManagementSocket>;
  /** `POST /agent/v1/browser/list`: the sessions the device runs now. */
  list(input: { accountId: string; deviceId: string }): Promise<{ sessionId: string }[]>;
}

/** The DevTools path novad must answer for a session (anything else is refused). */
export function deviceCdpPath(sessionId: string): string {
  return `/agent/v1/browser/cdp/${sessionId}`;
}

export interface CdpRelay {
  /** The browser-level WebSocket URL Playwright connects to (loopback, unguessable path). */
  url: string;
  close(): Promise<void>;
}

function headerLine(name: string, value: string): string {
  if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) throw new Error('a header with a line break');
  return `${name}: ${value}\r\n`;
}

/**
 * A one-connection relay on 127.0.0.1 to a device's DevTools pass-through. The first connection
 * that asks for the relay's own path is passed on; every other one is closed.
 */
export async function startCdpRelay(opts: {
  cdpPath: string;
  open: () => Promise<DeviceManagementSocket>;
  log?: Logger;
}): Promise<CdpRelay> {
  const secret = randomBytes(18).toString('base64url');
  const sockets = new Set<Duplex>();
  let used = false;
  const refuse = (c: Socket, status: string) => {
    c.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > MAX_HEAD_BYTES) refuse(client, '431 Request Header Fields Too Large');
        return;
      }
      client.off('data', onData);
      client.pause();
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const rest = head.subarray(end + 4);
      const [method, target] = (lines[0] ?? '').split(' ');
      if (method !== 'GET' || target !== `/${secret}` || used) {
        refuse(client, '404 Not Found');
        return;
      }
      used = true;
      void pass(client, lines.slice(1), rest);
    };
    client.on('data', onData);
  });
  const pass = async (client: Socket, lines: string[], rest: Buffer) => {
    let up: DeviceManagementSocket;
    try {
      up = await opts.open();
    } catch (err) {
      opts.log?.warn('the device browser connection could not be opened', { err });
      refuse(client, '502 Bad Gateway');
      return;
    }
    sockets.add(up.socket);
    up.socket.on('close', () => sockets.delete(up.socket));
    try {
      let req = `GET ${opts.cdpPath} HTTP/1.1\r\n`;
      req += headerLine('Host', up.host);
      req += headerLine('Authorization', up.authorization);
      for (const line of lines) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const name = line.slice(0, i).trim();
        if (PASSED_HEADERS.has(name.toLowerCase()))
          req += headerLine(name, line.slice(i + 1).trim());
      }
      up.socket.write(`${req}\r\n`);
      if (rest.length) up.socket.write(rest);
    } catch (err) {
      opts.log?.warn('the device browser upgrade could not be sent', { err });
      up.socket.destroy();
      refuse(client, '502 Bad Gateway');
      return;
    }
    const down = () => {
      client.destroy();
      up.socket.destroy();
    };
    up.socket.on('error', down);
    up.socket.on('end', down);
    up.socket.on('close', down);
    client.on('end', down);
    client.on('close', down);
    up.socket.pipe(client);
    client.pipe(up.socket);
    client.resume();
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}/${secret}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export interface DeviceBrowserDriverOptions {
  link: DeviceBrowserLink;
  accountId: string;
  deviceId: string;
  deviceName: string;
  /** Who the device's browser session is for (novad logs it). */
  grantee: DeviceGrantee;
  /** Hosts the device's egress filter allows: exact hosts and `*.host`. */
  allowHosts: string[];
  /** Chromium without a window (default); a device without a desktop has no other choice. */
  headless?: boolean;
  /** Connect Playwright to a browser-level DevTools WebSocket (`PlaywrightDriver.connectOverCdp`). */
  connect: (wsUrl: string, opts: DriverLaunchOptions) => Promise<DriverSession>;
  /** Each closed device session, with the egress counts novad reported. */
  onClosed?: (egress: DeviceEgressCounts | null) => void;
  /** The device sessions the Hub runs now (shared across drivers: the orphan sweep reads it). */
  live?: Set<string>;
  log?: Logger;
}

/** A driver session whose `close` also runs `after` (once). */
function closingWith(inner: DriverSession, after: () => Promise<void>): DriverSession {
  let closed: Promise<void> | null = null;
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'close')
        return () => {
          closed ??= target
            .close()
            .catch(() => undefined)
            .then(after);
          return closed;
        };
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** The agent browser on a device (D7): each launch is a new novad session. */
export class DeviceBrowserDriver implements BrowserDriver {
  readonly name = 'device';
  readonly #o: DeviceBrowserDriverOptions;

  constructor(opts: DeviceBrowserDriverOptions) {
    this.#o = opts;
  }

  probe(): Promise<{ ok: boolean; detail: string }> {
    // The device decides when it launches (no browser there is 409 capability_missing).
    return Promise.resolve({ ok: true, detail: `the browser of ${this.#o.deviceName}` });
  }

  async launch(opts: DriverLaunchOptions): Promise<DriverSession> {
    const o = this.#o;
    const ids = { accountId: o.accountId, deviceId: o.deviceId };
    const sessionId = uuidv7();
    o.live?.add(sessionId);
    const r = await o.link
      .launch({
        ...ids,
        sessionId,
        grantee: o.grantee,
        allowHosts: o.allowHosts,
        headless: o.headless ?? true,
      })
      .catch((err: unknown) => {
        o.live?.delete(sessionId);
        throw err;
      });
    const closeDevice = async () => {
      const out = await o.link.close({ ...ids, sessionId }).catch((err: unknown) => {
        o.log?.warn('closing the device browser failed', { err });
        return { egress: null };
      });
      o.live?.delete(sessionId);
      o.onClosed?.(out.egress);
    };
    // novad's answer names the pass-through; it may only be this session's own (fail closed).
    if (r.sessionId !== sessionId || r.cdpPath !== deviceCdpPath(sessionId)) {
      await closeDevice();
      throw new NovaError('server_error', 'the device answered an unexpected browser session');
    }
    const relay = await startCdpRelay({
      cdpPath: r.cdpPath,
      open: () => o.link.open(ids),
      ...(o.log ? { log: o.log } : {}),
    });
    let inner: DriverSession;
    try {
      // Downloads would land on the device, outside the session's profile (review M75 #8).
      inner = await o.connect(relay.url, { ...opts, acceptDownloads: false });
    } catch (err) {
      await relay.close();
      await closeDevice();
      throw err;
    }
    return closingWith(inner, async () => {
      await relay.close();
      await closeDevice();
    });
  }
}

/**
 * Close the browser sessions devices run that this Hub does not know (review M75 #7): left by a
 * Hub that stopped, or a close that never reached the device. Unreachable devices are skipped.
 * Returns the sessions closed.
 */
export async function closeOrphanDeviceSessions(input: {
  link: Pick<DeviceBrowserLink, 'list' | 'close'>;
  targets: readonly { accountId: string; deviceId: string }[];
  live: ReadonlySet<string>;
  onClosed?: (t: { accountId: string; deviceId: string; sessionId: string }) => void;
  log?: Logger;
}): Promise<number> {
  let closed = 0;
  for (const t of input.targets) {
    let sessions: { sessionId: string }[];
    try {
      sessions = await input.link.list(t);
    } catch {
      continue;
    }
    for (const { sessionId } of sessions) {
      if (input.live.has(sessionId)) continue;
      try {
        await input.link.close({ ...t, sessionId });
        closed++;
        input.onClosed?.({ ...t, sessionId });
      } catch (err) {
        input.log?.warn('closing a left-over device browser failed', { err });
      }
    }
  }
  return closed;
}
