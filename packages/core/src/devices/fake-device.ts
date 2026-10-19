// A stand-in `novad` for tests and offline journeys (J7 step 7) when the real binary is not
// built: it speaks the same management protocol (contracts/hub-api.md §3) over HTTP, signs its
// capability document with its own Ed25519 key, keeps folder grants and a staging area, and
// files folder-access requests for writes outside its grants, like novad does. Files are real
// files under the folders it is granted. Commands run only through an injected handler.
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { dirname, join } from 'node:path';
import { canonicalPath, pathAccess, within } from '@nova/policy';
import { canonicalJson } from '../nodes/crypto.ts';
import { MemoryReplayStore, verifyDeviceAuthorization } from '../firmware/authz.ts';
import { MANAGEMENT_TOKEN_PREFIX } from './protocol.ts';

export interface FakeDeviceOptions {
  name?: string;
  roles?: string[];
  novadVersion?: string;
  modules?: string[];
  /** Report Wake-on-LAN with this MAC. */
  wakeMac?: string | null;
  /**
   * The physical LAN subnets (`192.168.1.0/24`) reported as `power.lan` with every heartbeat, as
   * novad reports them with its power status (FR-138). Without it heartbeats carry no power.
   */
  lan?: string[];
  /** The pinned key update bundles must be signed with (raw Ed25519, base64url). */
  updateKey?: string | null;
  /** Commands; without it `exec` is refused like a device without a sandbox. */
  exec?: (
    spec: Record<string, unknown>,
  ) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;
  /**
   * The Hub identity key the device pinned (raw Ed25519, base64url): privileged requests
   * (decommission, D2) must carry an authorization it signed. Without it they are refused.
   */
  hubKey?: string | null;
  /** The device's clock for authorization windows (tests share the Hub's simulated one). */
  now?: () => Date;
  /** Local MCP servers: name -> tools and a call handler. */
  mcp?: Record<
    string,
    {
      tools: { name: string; description?: string }[];
      call: (tool: string, args: unknown) => unknown;
      /** Resources and prompts (M8, `/agent/v1/mcp/request`): method -> result. */
      requests?: Record<string, (params: Record<string, unknown>) => unknown>;
    }
  >;
}

interface Grant {
  id: string;
  grantee: { kind: string; id: string };
  kind: 'folder' | 'mcp';
  target: string;
  access: 'read' | 'write' | 'call';
  grantedBy: 'device' | 'hub';
}

interface Request {
  id: string;
  grantee: { kind: string; id: string };
  kind: 'folder' | 'mcp';
  target: string;
  access: 'read' | 'write' | 'call';
  reason: string | null;
  status: 'pending' | 'granted' | 'denied';
  grantId: string | null;
  decidedBy: 'device' | 'hub' | null;
  decidedAt: string | null;
  reported: boolean;
}

interface Stage {
  id: string;
  grantee: { kind: string; id: string };
  path: string;
  base: string | null;
  content: Buffer;
  sha: string;
  createDirs: boolean;
}

class OpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const id = () => randomBytes(16).toString('hex');

const ipv4Number = (ip: string) =>
  ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
const ipv4Text = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
const prefixMask = (bits: number) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);

/** `192.168.1.0/24` → `192.168.1.255`. */
function ipv4Broadcast(network: string): string {
  const [ip = '', bits = '32'] = network.split('/');
  return ipv4Text((ipv4Number(ip) | ~prefixMask(Number(bits))) >>> 0);
}

function ipv4InSubnet(address: string, network: string): boolean {
  const [ip = '', bits = '32'] = network.split('/');
  const mask = prefixMask(Number(bits));
  return (ipv4Number(address) & mask) >>> 0 === (ipv4Number(ip) & mask) >>> 0;
}

/** Unified line diff (LCS; fine for test-sized files). */
export function fakeDeviceLineDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
): { diff: string; additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n');
  const b = newText === '' ? [] : newText.replace(/\n$/, '').split('\n');
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { t: ' ' | '-' | '+'; s: string; ai: number; bi: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ t: ' ', s: a[i++]!, ai: i, bi: ++j });
    // Removals before additions, as unified diffs show them.
    else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!))
      ops.push({ t: '-', s: a[i++]!, ai: i, bi: j });
    else ops.push({ t: '+', s: b[j++]!, ai: i, bi: j });
  }
  const additions = ops.filter((o) => o.t === '+').length;
  const deletions = ops.filter((o) => o.t === '-').length;
  if (!additions && !deletions) return { diff: '', additions, deletions };
  const lines = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0);
  let start = 0;
  while (start < changed.length) {
    let end = start;
    while (end + 1 < changed.length && changed[end + 1]! - changed[end]! <= 6) end++;
    const from = Math.max(0, changed[start]! - 3);
    const to = Math.min(ops.length - 1, changed[end]! + 3);
    const slice = ops.slice(from, to + 1);
    const oldCount = slice.filter((o) => o.t !== '+').length;
    const newCount = slice.filter((o) => o.t !== '-').length;
    const oldStart = slice.find((o) => o.t !== '+')?.ai ?? 0;
    const newStart = slice.find((o) => o.t !== '-')?.bi ?? 0;
    lines.push(
      `@@ -${oldCount ? oldStart : 0},${oldCount} +${newCount ? newStart : 0},${newCount} @@`,
    );
    for (const o of slice) lines.push(`${o.t}${o.s}`);
    start = end + 1;
  }
  return { diff: `${lines.join('\n')}\n`, additions, deletions };
}

/** A fake novad device. */
export class FakeDevice {
  readonly name: string;
  readonly localId = id();
  readonly managementToken = `${MANAGEMENT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  readonly publicKey: string;
  readonly #privateKey: KeyObject;
  readonly #opts: FakeDeviceOptions;
  readonly grants: Grant[] = [];
  readonly requests: Request[] = [];
  readonly stages = new Map<string, Stage>();
  readonly procs = new Map<
    string,
    {
      grantee: { kind: string; id: string };
      cmd: string;
      cwd: string;
      tag: string | null;
      out: string;
      running: boolean;
      exitCode: number | null;
      startedAt: string;
    }
  >();
  readonly calls: { path: string; body: Record<string, unknown> }[] = [];
  /** Wake packets sent for other devices as a Wake Helper (`POST /agent/v1/power/wake-other`). */
  readonly wakes: { mac: string; broadcast: string; port: number }[] = [];
  readonly events: Record<string, unknown>[] = [];
  readonly modules: Map<
    string,
    {
      version: string;
      state: 'running' | 'stopped' | 'backoff' | 'disabled';
      restarts: number;
      lastExit: string | null;
      disabledReason: string | null;
    }
  >;
  novadVersion: string;
  roles: string[];
  hubConfig: {
    capabilityOverrides: Record<string, unknown>;
    policy: Record<string, unknown>;
    updateChannel: string;
    revision: number;
  } = {
    capabilityOverrides: {},
    policy: {},
    updateChannel: 'stable',
    revision: 0,
  };
  hubUrl: string | null = null;
  deviceId: string | null = null;
  credential: string | null = null;
  revoked = false;
  /**
   * The device-side toggles (`policy.json`, D3): from heartbeat answers and `/agent/v1/config`;
   * only `true` turns one on, an absent one keeps its value.
   */
  privileged = { firmwareChanges: false, lowLevelBoot: false };
  /** Set by an accepted `/agent/v1/decommission` (D9): what it was told to do. */
  decommissioned: { purge: boolean } | null = null;
  /** The client certificates seen on the HTTPS listener (D1), newest last. */
  readonly clientCerts: string[] = [];
  readonly #replay = new MemoryReplayStore();
  #server: Server | null = null;
  #endpoint: string | null = null;

  constructor(opts: FakeDeviceOptions = {}) {
    this.#opts = opts;
    this.name = opts.name ?? 'fake-device';
    this.roles = opts.roles ?? ['client'];
    this.novadVersion = opts.novadVersion ?? '0.6.0';
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.#privateKey = privateKey;
    this.publicKey = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    this.modules = new Map(
      (opts.modules ?? ['management', 'storage']).map((m) => [
        m,
        {
          version: this.novadVersion,
          state: 'running' as const,
          restarts: 0,
          lastExit: null,
          disabledReason: null,
        },
      ]),
    );
  }

  get endpoint(): string {
    if (!this.#endpoint) throw new Error('the fake device is not listening');
    return this.#endpoint;
  }

  // ---- the capability document ---------------------------------------------------------------

  capability(): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      schemaVersion: 1,
      deviceId: this.localId,
      name: this.name,
      roles: this.roles,
      modules: [...this.modules.keys()].sort(),
      hardware: {
        arch: 'x86_64',
        cores: 4,
        ...(this.#opts.wakeMac ? { nic: { wol: true, macs: [this.#opts.wakeMac] } } : {}),
      },
      os: { family: 'linux', sandbox: { bubblewrap: Boolean(this.#opts.exec) } },
      power: { wakeable: Boolean(this.#opts.wakeMac) },
      data: { updateChannel: this.hubConfig.updateChannel, telemetryAllowed: false },
      access: { fsScopes: this.grants.filter((g) => g.kind === 'folder').map((g) => g.target) },
    };
    for (const [section, fields] of Object.entries(this.hubConfig.capabilityOverrides)) {
      if (typeof fields !== 'object' || fields === null) continue;
      const prev = doc[section];
      doc[section] = { ...(typeof prev === 'object' && prev !== null ? prev : {}), ...fields };
    }
    return doc;
  }

  sign(doc: unknown): string {
    return sign(null, Buffer.from(canonicalJson(doc), 'utf8'), this.#privateKey).toString(
      'base64url',
    );
  }

  // ---- novad → Hub -------------------------------------------------------------------------------

  async listen(): Promise<string> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((r) => this.#server!.listen(0, '127.0.0.1', r));
    const addr = this.#server.address() as { port: number };
    this.#endpoint = `http://127.0.0.1:${addr.port}`;
    return this.#endpoint;
  }

  /** The device's own key, for a device certificate test (PKCS#8 PEM). */
  privateKeyPem(): string {
    return this.#privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }

  /**
   * Serve the management API over HTTPS with a device certificate (ADR-096 D1), as novad does
   * once it holds one: the Hub must present a client certificate chaining to `caPem`. The
   * endpoint becomes `https://127.0.0.1:<port>`.
   */
  async listenTls(opts: { certPem: string; caPem: string }): Promise<string> {
    await this.close();
    const server = createHttpsServer(
      {
        key: this.privateKeyPem(),
        cert: opts.certPem,
        ca: opts.caPem,
        requestCert: true,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.3',
      },
      (req, res) => {
        const peer = (req.socket as TLSSocket).getPeerX509Certificate?.();
        if (peer) this.clientCerts.push(peer.toString());
        void this.#handle(req, res);
      },
    );
    this.#server = server;
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    this.#endpoint = `https://127.0.0.1:${addr.port}`;
    return this.#endpoint;
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server!.close(() => r()));
    this.#server = null;
  }

  async #post(
    path: string,
    body: unknown,
    auth?: string,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${this.hubUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  /** `novad enroll`: register with a one-use token. */
  async enroll(hubUrl: string, token: string): Promise<Record<string, unknown>> {
    if (!this.#endpoint) await this.listen();
    this.hubUrl = hubUrl.replace(/\/+$/, '');
    const capability = this.capability();
    const r = await this.#post('/agent/v1/register', {
      enrollToken: token,
      name: this.name,
      endpoint: this.endpoint,
      publicKey: this.publicKey,
      capability,
      signature: this.sign(capability),
      managementToken: this.managementToken,
      novadVersion: this.novadVersion,
      protocolVersions: [1],
    });
    if (r.status !== 201) throw new Error(`enroll failed (${r.status}): ${JSON.stringify(r.json)}`);
    this.deviceId = r.json.deviceId as string;
    this.credential = r.json.credential as string;
    return r.json;
  }

  /**
   * One heartbeat with module reports, queued events and device-side decisions; `endpoint`
   * reports the management endpoint (D1: novad sends its https endpoint once it holds a
   * certificate).
   */
  async heartbeat(
    opts: { endpoint?: string } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    if (!this.credential) throw new Error('not enrolled');
    const decisions = this.requests.filter((r) => r.status !== 'pending' && !r.reported);
    const r = await this.#post(
      '/agent/v1/heartbeat',
      {
        novadVersion: this.novadVersion,
        ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
        modules: this.moduleReports(),
        events: this.events.splice(0),
        accessDecisions: decisions.map((d) => ({ ...d })),
        ...(this.#opts.lan ? { power: this.#powerStatus() } : {}),
      },
      this.credential,
    );
    if (r.status === 200) for (const d of decisions) d.reported = true;
    if (r.status === 200) this.#takeToggles(r.json.policy);
    if (r.status === 401) this.revoked = true;
    return r;
  }

  async sendCapabilities(): Promise<number> {
    if (!this.credential) throw new Error('not enrolled');
    const capability = this.capability();
    const r = await this.#post(
      '/agent/v1/capabilities',
      { capability, signature: this.sign(capability), novadVersion: this.novadVersion },
      this.credential,
    );
    return r.status;
  }

  #takeToggles(p: unknown): void {
    if (typeof p !== 'object' || p === null) return;
    const v = p as Record<string, unknown>;
    if (v.firmwareChanges !== undefined && v.firmwareChanges !== null)
      this.privileged.firmwareChanges = v.firmwareChanges === true;
    if (v.lowLevelBoot !== undefined && v.lowLevelBoot !== null)
      this.privileged.lowLevelBoot = v.lowLevelBoot === true;
  }

  moduleReports(): Record<string, unknown>[] {
    return [...this.modules.entries()].map(([name, m]) => ({
      name,
      ...m,
      pid: m.state === 'running' ? 4242 : null,
      startedAt: null,
      previousVersion: null,
    }));
  }

  /** A module crashes on the device: reported as an event and a state on the next heartbeat. */
  crashModule(name: string, disable = false): void {
    const m = this.modules.get(name);
    if (!m) throw new Error(`no module ${name}`);
    m.restarts += 1;
    m.lastExit = 'killed by signal 9';
    m.state = disable ? 'disabled' : 'running';
    if (disable) m.disabledReason = 'crash_loop';
    const at = new Date().toISOString();
    this.events.push({ module: name, kind: 'crashed', at, exit: m.lastExit });
    this.events.push(
      disable
        ? { module: name, kind: 'disabled', at, reason: 'crash_loop' }
        : { module: name, kind: 'restarted', at, restarts: m.restarts },
    );
  }

  /** `novad access approve|deny` on the device. */
  decideLocally(requestId: string, grant: boolean): Request {
    return this.#decide(requestId, grant, 'device');
  }

  /** Grant a folder on the device directly (setup for tests). */
  grantFolder(
    grantee: { kind: string; id: string },
    folder: string,
    access: 'read' | 'write',
  ): Grant {
    const g: Grant = {
      id: id(),
      grantee,
      kind: 'folder',
      target: realpathSync(folder),
      access,
      grantedBy: 'device',
    };
    this.grants.push(g);
    return g;
  }

  // ---- Hub → novad -------------------------------------------------------------------------------

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify(body));
    };
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      if (req.headers.authorization !== `Bearer ${this.managementToken}` || this.revoked) {
        send(401, {
          error: { code: 'token_required', message: 'a valid management token is required' },
        });
        return;
      }
      const body = (
        chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      ) as Record<string, unknown>;
      const path = (req.url ?? '').split('?')[0] ?? '';
      this.calls.push({ path, body });
      send(200, await this.#route(path, body));
    } catch (err) {
      if (err instanceof OpError)
        send(err.status, {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
          },
        });
      else if ((err as { code?: unknown }).code === 'ENOENT')
        // Like novad: a missing file is `not_found`.
        send(404, { error: { code: 'not_found', message: (err as Error).message } });
      else
        send(500, {
          error: { code: 'server_error', message: err instanceof Error ? err.message : 'error' },
        });
    }
  }

  #module(name: string) {
    const m = this.modules.get(name);
    if (!m)
      throw new OpError(404, 'not_found', `the ${name} module is not installed on this device`);
    return m;
  }

  #status(name: string): Record<string, unknown> {
    const m = this.#module(name);
    return {
      name,
      ...m,
      pid: m.state === 'running' ? 4242 : null,
      startedAt: null,
      previousVersion: null,
    };
  }

  async #route(path: string, body: Record<string, unknown>): Promise<unknown> {
    const parts = path.replace(/^\/agent\/v1\//, '').split('/');
    const g = body.grantee as { kind: string; id: string } | undefined;
    const allowed = this.hubConfig.policy.allowedModules as string[] | null | undefined;
    switch (parts[0]) {
      case 'status':
        return {
          novadVersion: this.novadVersion,
          deviceId: this.deviceId,
          localDeviceId: this.localId,
          modules: this.moduleReports(),
          sandbox: Boolean(this.#opts.exec),
          hardened: true,
        };
      case 'capabilities': {
        const capability = this.capability();
        return { capability, signature: this.sign(capability), novadVersion: this.novadVersion };
      }
      case 'modules': {
        const [, name = '', action] = parts;
        const m = this.#module(name);
        if (action === 'stop') m.state = 'stopped';
        else if (action === 'start' || action === 'restart') {
          if (allowed && !allowed.includes(name))
            throw new OpError(403, 'policy_denied', 'not allowed', {
              reason: 'module_not_allowed',
            });
          m.state = 'running';
          m.disabledReason = null;
        } else if (action === 'rollback') return { status: 'rolled_back', target: name };
        else throw new OpError(404, 'not_found', 'unknown module action');
        return { module: this.#status(name) };
      }
      case 'services': {
        const [, name = '', action] = parts;
        // `POST /agent/v1/services`: the declared services (M7.5).
        if (!name)
          return {
            services: this.modules.has('compute')
              ? [
                  {
                    name: 'compute',
                    kind: 'module',
                    module: 'compute',
                    state: this.#module('compute').state,
                  },
                ]
              : [],
          };
        if (name !== 'compute')
          throw new OpError(404, 'not_found', `no managed service named ${name}`);
        const m = this.#module('compute');
        if (action === 'stop') m.state = 'stopped';
        else if (action === 'start' || action === 'restart') m.state = 'running';
        return { service: { name, kind: 'module', state: m.state } };
      }
      case 'power': {
        if (parts[1] === 'wake-other') return this.#wakeOther(body);
        const action = body.action as string;
        if (action === 'status') return this.#powerStatus();
        if (action === 'wol-plan')
          return {
            plan: [{ kind: 'command', argv: ['ethtool', '-s', 'eth0', 'wol', 'g'] }],
            needsElevation: true,
          };
        if (action === 'wol-enable') {
          if (body.apply !== true)
            return {
              applied: false,
              plan: [{ kind: 'command', argv: ['ethtool', '-s', 'eth0', 'wol', 'g'] }],
            };
          throw new OpError(
            403,
            'policy_denied',
            'enabling WoL needs novad to run with elevation',
            { reason: 'elevation_required' },
          );
        }
        throw new OpError(
          403,
          'policy_denied',
          'power actions are off in this device’s novad config',
          { reason: 'power_actions_disabled' },
        );
      }
      case 'update':
        return this.#update(body.bundle as Record<string, unknown>);
      case 'config': {
        if (body.capabilityOverrides)
          this.hubConfig.capabilityOverrides = body.capabilityOverrides as Record<string, unknown>;
        if (body.policy && typeof body.policy === 'object') {
          // Like novad (M7.5): the two toggles are taken from `policy`; any other field replaces
          // the per-device policy, so toggles sent alone leave it as it was.
          const { firmwareChanges, lowLevelBoot, ...rest } = body.policy as Record<string, unknown>;
          this.#takeToggles({ firmwareChanges, lowLevelBoot });
          if (Object.keys(rest).length) this.hubConfig.policy = rest;
        }
        if (typeof body.updateChannel === 'string')
          this.hubConfig.updateChannel = body.updateChannel;
        this.hubConfig.revision =
          typeof body.revision === 'number' ? body.revision : this.hubConfig.revision + 1;
        const list = this.hubConfig.policy.allowedModules as string[] | null | undefined;
        if (list) for (const [n, m] of this.modules) if (!list.includes(n)) m.state = 'stopped';
        const capability = this.capability();
        return {
          capability,
          signature: this.sign(capability),
          revision: this.hubConfig.revision,
          modules: this.moduleReports(),
          policy: { ...this.privileged },
        };
      }
      case 'fs':
        return this.#fs(parts[1] ?? '', body, g);
      case 'exec': {
        this.#resolve(g, body.cwd, 'read');
        if (!this.#opts.exec)
          throw new OpError(
            409,
            'sandbox_unavailable',
            'no sandbox on this device; commands are refused (FR-107)',
          );
        return this.#opts.exec(body);
      }
      case 'proc':
        return this.#proc(parts[1] ?? '', body, g);
      case 'mcp': {
        const servers = this.#opts.mcp ?? {};
        const granted = (name: string) =>
          this.grants.some(
            (x) => x.kind === 'mcp' && x.target === name && sameGrantee(x.grantee, g),
          );
        if (parts[1] === 'list')
          return {
            servers: Object.entries(servers)
              .filter(([n]) => granted(n))
              .map(([name, s]) => ({ name, tools: s.tools })),
          };
        const name = body.server as string;
        const srv = servers[name];
        if (!srv) throw new OpError(404, 'not_found', `no local MCP server named ${name}`);
        if (!granted(name))
          throw new OpError(403, 'policy_denied', 'not granted', { reason: 'mcp_grant_required' });
        if (parts[1] === 'request') {
          // novad passes only these read-only methods (services/novad/src/mcp.rs PASS_METHODS).
          const method = typeof body.method === 'string' ? body.method : '';
          const pass = [
            'resources/list',
            'resources/templates/list',
            'resources/read',
            'prompts/list',
            'prompts/get',
          ];
          if (!pass.includes(method))
            throw new OpError(400, 'validation', `${method} cannot be passed`);
          const handler = srv.requests?.[method];
          if (!handler)
            throw new OpError(502, 'server_error', 'MCP error: Method not found', {
              reason: 'mcp_error',
              mcpCode: -32601,
            });
          const params =
            body.params && typeof body.params === 'object'
              ? (body.params as Record<string, unknown>)
              : {};
          return { result: handler(params), untrusted: true };
        }
        return {
          content: [
            { type: 'text', text: JSON.stringify(srv.call(body.tool as string, body.arguments)) },
          ],
          isError: false,
          untrusted: true,
        };
      }
      case 'firmware':
        throw new OpError(403, 'firmware_disabled', 'firmware changes are off (FR-146)');
      case 'decommission': {
        // D9 with D2: only with an authorization the pinned Hub key signed for this device.
        const verdict = this.#opts.hubKey
          ? verifyDeviceAuthorization({
              authorization: body.authorization,
              publicKey: this.#opts.hubKey,
              deviceId: this.deviceId ?? '',
              kind: 'device.decommission',
              body,
              replay: this.#replay,
              ...(this.#opts.now ? { now: this.#opts.now() } : {}),
            })
          : ({ ok: false, reason: 'authorization_invalid', message: 'no pinned Hub key' } as const);
        if (!verdict.ok)
          throw new OpError(
            verdict.reason === 'replayed' ? 409 : 403,
            verdict.reason === 'replayed' ? 'conflict' : 'policy_denied',
            verdict.message,
            { reason: verdict.reason },
          );
        this.decommissioned = { purge: body.purge === true };
        for (const m of this.modules.values()) m.state = 'stopped';
        return { decommissioned: true, purge: body.purge === true };
      }
      default:
        throw new OpError(404, 'not_found', 'unknown management route');
    }
  }

  /** The power status novad reports (FR-144), with its LAN subnets when it has them (FR-138). */
  #powerStatus(): Record<string, unknown> {
    return {
      wakeable: Boolean(this.#opts.wakeMac),
      macs: this.#opts.wakeMac ? [this.#opts.wakeMac] : [],
      ac: true,
      afterPowerLoss: 'unknown',
      ...(this.#opts.lan
        ? {
            lan: this.#opts.lan.map((network) => ({
              interface: 'eth0',
              network,
              broadcast: ipv4Broadcast(network),
            })),
          }
        : {}),
    };
  }

  /**
   * Wake another device on this LAN, like novad's Wake Helper (FR-138): only with the
   * wake-helper role; `{mac, broadcast?, port?}`, the broadcast address on one of its subnets
   * (else every subnet's). Nothing is sent; the wake is recorded in `wakes`.
   */
  #wakeOther(body: Record<string, unknown>): unknown {
    if (!this.roles.includes('wake-helper'))
      throw new OpError(403, 'policy_denied', 'this device does not have the wake-helper role', {
        reason: 'not_wake_helper',
      });
    const mac = typeof body.mac === 'string' ? body.mac : '';
    if (!/^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(mac) || /^(ff[:-]?){5}ff$/i.test(mac))
      throw new OpError(400, 'validation', 'mac must be a unicast MAC address');
    const port =
      body.port === undefined || body.port === null || body.port === 9
        ? 9
        : body.port === 7
          ? 7
          : null;
    if (port === null) throw new OpError(400, 'validation', 'port must be 9 or 7');
    const subnets = (this.#opts.lan ?? []).map((network) => ({
      network,
      broadcast: ipv4Broadcast(network),
    }));
    if (!subnets.length)
      throw new OpError(
        409,
        'conflict',
        'this device has no LAN interface to send a wake packet on',
        {
          reason: 'no_lan',
        },
      );
    const given = typeof body.broadcast === 'string' ? body.broadcast : null;
    const targets = given
      ? subnets.some((s) => ipv4InSubnet(given, s.network))
        ? [given]
        : []
      : subnets.map((s) => s.broadcast);
    if (!targets.length)
      throw new OpError(403, 'policy_denied', `${given} is not on one of this device's subnets`, {
        reason: 'not_on_lan',
      });
    for (const broadcast of targets) this.wakes.push({ mac: mac.toLowerCase(), broadcast, port });
    return {
      sent: true,
      mac: mac.toLowerCase(),
      port,
      targets: targets.map((broadcast) => ({ broadcast, interface: 'eth0' })),
    };
  }

  /** Processes kept on the device: the injected `exec` runs them; output is kept for reads. */
  #proc(
    op: string,
    body: Record<string, unknown>,
    g: { kind: string; id: string } | undefined,
  ): unknown {
    if (!g) throw new OpError(400, 'validation', 'grantee is required');
    const own = (id: unknown) => {
      const p = typeof id === 'string' ? this.procs.get(id) : undefined;
      if (!p || !sameGrantee(p.grantee, g)) throw new OpError(404, 'not_found', 'no such process');
      return p;
    };
    switch (op) {
      case 'spawn': {
        this.#resolve(g, body.cwd, 'read');
        const exec = this.#opts.exec;
        if (!exec)
          throw new OpError(
            409,
            'sandbox_unavailable',
            'no sandbox on this device; commands are refused (FR-107)',
          );
        const pid = id();
        const p = {
          grantee: g,
          cmd: String(body.cmd),
          cwd: String(body.cwd),
          tag: typeof body.tag === 'string' ? body.tag : null,
          out: '',
          running: true,
          exitCode: null as number | null,
          startedAt: new Date().toISOString(),
        };
        this.procs.set(pid, p);
        void exec({ cmd: '/bin/sh', args: ['-c', p.cmd], cwd: p.cwd }).then(
          (r) => {
            if (!p.running) return;
            p.out += r.stdout + r.stderr;
            p.exitCode = r.exitCode;
            p.running = false;
          },
          (err: unknown) => {
            p.out += err instanceof Error ? err.message : 'failed';
            p.exitCode = -1;
            p.running = false;
          },
        );
        return { id: pid };
      }
      case 'read': {
        const p = own(body.id);
        const offset = typeof body.offset === 'number' ? body.offset : 0;
        return {
          data: p.out.slice(offset),
          offset: p.out.length,
          dropped: 0,
          running: p.running,
          exitCode: p.exitCode,
        };
      }
      case 'write': {
        const p = own(body.id);
        if (body.signal === 'terminate' || body.signal === 'interrupt') {
          p.running = false;
          p.exitCode = null;
        }
        return { ok: true };
      }
      case 'list':
        return {
          processes: [...this.procs.entries()]
            .filter(([, p]) => sameGrantee(p.grantee, g))
            .map(([pid, p]) => ({
              id: pid,
              cmd: p.cmd,
              cwd: p.cwd,
              tag: p.tag,
              running: p.running,
              exitCode: p.exitCode,
              outputBytes: p.out.length,
              startedAt: p.startedAt,
            })),
        };
      default:
        throw new OpError(404, 'not_found', 'unknown process operation');
    }
  }

  #update(bundle: Record<string, unknown>): Record<string, unknown> {
    const key = this.#opts.updateKey;
    if (!key)
      throw new OpError(403, 'policy_denied', 'this device has no pinned update key', {
        reason: 'no_trust_key',
      });
    const manifest = bundle.manifest as Record<string, unknown>;
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
    const ok = verify(
      null,
      Buffer.from(canonicalJson(manifest), 'utf8'),
      pub,
      Buffer.from(String(bundle.signature), 'base64url'),
    );
    if (!ok)
      throw new OpError(403, 'policy_denied', 'the update bundle is not signed by the pinned key', {
        reason: 'bad_signature',
      });
    const payload = Buffer.from(String(bundle.payload), 'base64');
    if (sha(payload) !== manifest.sha256)
      throw new OpError(403, 'policy_denied', 'the payload does not match', {
        reason: 'checksum_mismatch',
      });
    const target = String(manifest.target);
    const version = String(manifest.version);
    if (target === 'novad') {
      this.novadVersion = version;
      return { status: 'staged', target, to: version, restart: true };
    }
    const m = this.#module(target);
    if (payload.toString('utf8').includes('fail-health-check'))
      return {
        status: 'rolled_back',
        reason: 'health_check_failed',
        target,
        from: m.version,
        to: version,
      };
    const from = m.version;
    m.version = version;
    return { status: 'applied', target, from, to: version };
  }

  /** Canonical on disk (symlinks resolved, a missing tail appended). */
  #canonical(p: unknown): string {
    const c = typeof p === 'string' ? canonicalPath(p) : null;
    if (!c)
      throw new OpError(400, 'validation', 'the path must be absolute, with no . or .. segments');
    let cur = c;
    const tail: string[] = [];
    while (!existsSync(cur)) {
      tail.unshift(cur.slice(cur.lastIndexOf('/') + 1));
      cur = dirname(cur);
    }
    return join(realpathSync(cur), ...tail);
  }

  #resolve(
    g: { kind: string; id: string } | undefined,
    raw: unknown,
    need: 'read' | 'write',
  ): { path: string } {
    if (!g?.kind || !g.id) throw new OpError(400, 'validation', 'grantee is required');
    const path = this.#canonical(raw);
    const entries = this.grants
      .filter((x) => x.kind === 'folder' && sameGrantee(x.grantee, g))
      .map((x) => ({
        path: x.target,
        access: x.access === 'write' ? ('write' as const) : ('read' as const),
      }));
    const check = pathAccess(path, { entries });
    if (
      check.access === 'deny' ||
      (need === 'write' && check.access === 'read' && check.reason.includes('read-only'))
    ) {
      throw new OpError(403, 'policy_denied', check.reason || 'protected path', {
        reason: 'protected_path',
        path,
      });
    }
    if (check.access === 'none' || (need === 'write' && check.access !== 'write')) {
      throw new OpError(
        403,
        'policy_denied',
        `${path} is outside the folders granted to this session`,
        { reason: 'folder_access_required', path, access: need },
      );
    }
    return { path };
  }

  #request(
    g: { kind: string; id: string },
    kind: 'folder' | 'mcp',
    target: string,
    access: 'read' | 'write' | 'call',
    reason: string | null,
  ): Request {
    const covered = this.grants.find(
      (x) =>
        x.kind === kind &&
        sameGrantee(x.grantee, g) &&
        (kind === 'mcp'
          ? x.target === target
          : within(x.target, target) && (x.access === 'write' || access === 'read')),
    );
    if (covered)
      return {
        id: `covered-${covered.id}`,
        grantee: g,
        kind,
        target,
        access,
        reason,
        status: 'granted',
        grantId: covered.id,
        decidedBy: covered.grantedBy,
        decidedAt: null,
        reported: true,
      };
    const pending = this.requests.find(
      (r) =>
        r.status === 'pending' &&
        sameGrantee(r.grantee, g) &&
        r.kind === kind &&
        r.target === target &&
        r.access === access,
    );
    if (pending) return pending;
    const r: Request = {
      id: id(),
      grantee: g,
      kind,
      target,
      access,
      reason,
      status: 'pending',
      grantId: null,
      decidedBy: null,
      decidedAt: null,
      reported: false,
    };
    this.requests.push(r);
    return r;
  }

  #decide(requestId: string, grant: boolean, by: 'device' | 'hub'): Request {
    const r = this.requests.find((x) => x.id === requestId);
    if (!r) throw new OpError(404, 'not_found', 'no such access request');
    const status = grant ? 'granted' : 'denied';
    if (r.status !== 'pending') {
      if (r.status === status) return r;
      throw new OpError(409, 'conflict', 'the request was already decided');
    }
    if (grant) {
      const existing = this.grants.find(
        (x) => x.kind === r.kind && sameGrantee(x.grantee, r.grantee) && x.target === r.target,
      );
      if (existing) {
        if (r.access === 'write') existing.access = 'write';
        r.grantId = existing.id;
      } else {
        const g: Grant = {
          id: id(),
          grantee: r.grantee,
          kind: r.kind,
          target: r.target,
          access: r.access,
          grantedBy: by,
        };
        this.grants.push(g);
        r.grantId = g.id;
      }
    }
    r.status = status;
    r.decidedBy = by;
    r.decidedAt = new Date().toISOString();
    r.reported = by === 'hub';
    return r;
  }

  #fs(
    op: string,
    body: Record<string, unknown>,
    g: { kind: string; id: string } | undefined,
  ): unknown {
    switch (op) {
      case 'list': {
        const { path } = this.#resolve(g, body.path, 'read');
        const entries = readdirSync(path)
          .filter(
            (name) =>
              pathAccess(join(path, name), { entries: [{ path: '/', access: 'read' }] }).access !==
              'deny',
          )
          .sort()
          .flatMap((name) => {
            // An entry can vanish between the listing and its stat (as novad tolerates).
            let st;
            try {
              st = lstatSync(join(path, name));
            } catch {
              return [];
            }
            return {
              name,
              kind: st.isSymbolicLink()
                ? 'symlink'
                : st.isDirectory()
                  ? 'dir'
                  : st.isFile()
                    ? 'file'
                    : 'other',
              size: st.isFile() ? st.size : null,
            };
          });
        return { path, entries, truncated: false };
      }
      case 'read': {
        const { path } = this.#resolve(g, body.path, 'read');
        const data = readFileSync(path);
        const max = typeof body.maxBytes === 'number' ? body.maxBytes : 1024 * 1024;
        return {
          path,
          contentBase64: data.subarray(0, max).toString('base64'),
          size: data.length,
          sha256: sha(data),
          truncated: data.length > max,
        };
      }
      case 'stat': {
        const { path } = this.#resolve(g, body.path, 'read');
        const st = statSync(path);
        return {
          path,
          kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
          size: st.size,
          mtimeMs: Math.floor(st.mtimeMs),
        };
      }
      case 'request-access': {
        if (!g) throw new OpError(400, 'validation', 'grantee is required');
        const kind = body.kind === 'mcp' ? 'mcp' : 'folder';
        const target =
          kind === 'folder' ? this.#canonical(body.path) : String(body.target ?? body.path);
        if (kind === 'folder') {
          if (
            pathAccess(target, { entries: [{ path: target, access: 'write' }] }).access === 'deny'
          )
            throw new OpError(403, 'policy_denied', 'protected', { reason: 'protected_path' });
          if (!existsSync(target))
            throw new OpError(404, 'not_found', 'the folder does not exist on this device');
        }
        return {
          request: this.#request(
            g,
            kind,
            target,
            kind === 'mcp' ? 'call' : body.access === 'write' ? 'write' : 'read',
            typeof body.reason === 'string' ? body.reason : null,
          ),
        };
      }
      case 'grant': {
        if (!g) throw new OpError(400, 'validation', 'grantee is required');
        const kind = body.kind === 'mcp' ? 'mcp' : 'folder';
        const target = kind === 'folder' ? this.#canonical(body.target) : String(body.target);
        const r = this.#request(
          g,
          kind,
          target,
          kind === 'mcp' ? 'call' : body.access === 'write' ? 'write' : 'read',
          null,
        );
        return { request: r.status === 'granted' ? r : this.#decide(r.id, true, 'hub') };
      }
      case 'decide':
        return { request: this.#decide(String(body.requestId), body.decision === 'grant', 'hub') };
      case 'grants':
        return { grants: this.grants, requests: this.requests };
      case 'revoke': {
        if (typeof body.grantId === 'string') {
          const i = this.grants.findIndex((x) => x.id === body.grantId);
          if (i >= 0) this.grants.splice(i, 1);
          return { revoked: i >= 0 };
        }
        const before = this.grants.length;
        for (let i = this.grants.length - 1; i >= 0; i--)
          if (sameGrantee(this.grants[i]!.grantee, g)) this.grants.splice(i, 1);
        return { revoked: this.grants.length !== before };
      }
      case 'stage': {
        let path: string;
        try {
          path = this.#resolve(g, body.path, 'write').path;
        } catch (err) {
          if (err instanceof OpError && err.details?.reason === 'folder_access_required' && g) {
            const target = this.#canonical(body.path);
            let folder = target;
            while (!existsSync(folder) || !statSync(folder).isDirectory()) folder = dirname(folder);
            const request = this.#request(
              g,
              'folder',
              folder,
              'write',
              'a write outside the granted folders',
            );
            throw new OpError(403, 'policy_denied', err.message, { ...err.details, request });
          }
          throw err;
        }
        const content = Buffer.from(
          typeof body.contentBase64 === 'string' ? body.contentBase64 : '',
          'base64',
        );
        const old = existsSync(path) ? readFileSync(path) : null;
        const base = old ? sha(old) : null;
        if (typeof body.baseSha256 === 'string' && body.baseSha256 !== base)
          throw new OpError(409, 'conflict', 'the file changed since it was read', {
            reason: 'base_mismatch',
          });
        if (!existsSync(dirname(path)) && body.createDirs !== true)
          throw new OpError(404, 'not_found', 'the parent folder does not exist (set createDirs)');
        const binary = content.includes(0) || (old?.includes(0) ?? false);
        const d = binary
          ? {
              diff: `Binary file ${path} ${old ? 'changed' : 'added'}\n`,
              additions: 0,
              deletions: 0,
            }
          : fakeDeviceLineDiff(
              old?.toString('utf8') ?? '',
              content.toString('utf8'),
              old ? `a${path}` : '/dev/null',
              `b${path}`,
            );
        const s: Stage = {
          id: id(),
          grantee: g!,
          path,
          base,
          content,
          sha: sha(content),
          createDirs: body.createDirs === true,
        };
        this.stages.set(s.id, s);
        return {
          staged: {
            id: s.id,
            path,
            baseSha256: base,
            newSha256: s.sha,
            size: content.length,
            ...d,
            binary,
            diffTruncated: false,
            createdAt: new Date().toISOString(),
          },
        };
      }
      case 'commit': {
        const s = this.stages.get(String(body.stagedId));
        if (!s || !sameGrantee(s.grantee, g))
          throw new OpError(
            404,
            'not_found',
            'no such staged write (committed, discarded or expired)',
          );
        this.#resolve(g, s.path, 'write');
        const current = existsSync(s.path) ? sha(readFileSync(s.path)) : null;
        if (current !== s.base) {
          this.stages.delete(s.id);
          throw new OpError(
            409,
            'conflict',
            'the file changed since the write was staged; nothing was written',
            { reason: 'base_mismatch' },
          );
        }
        if (s.createDirs) mkdirSync(dirname(s.path), { recursive: true });
        const tmp = `${s.path}.${id()}.tmp`;
        writeFileSync(tmp, s.content);
        renameSync(tmp, s.path);
        this.stages.delete(s.id);
        return { path: s.path, sha256: s.sha, size: s.content.length };
      }
      case 'discard': {
        const s = this.stages.get(String(body.stagedId));
        if (!s || !sameGrantee(s.grantee, g))
          throw new OpError(404, 'not_found', 'no such staged write');
        this.stages.delete(s.id);
        return { ok: true };
      }
      case 'delete': {
        const { path } = this.#resolve(g, body.path, 'write');
        rmSync(path);
        return { ok: true };
      }
      case 'move': {
        const from = this.#resolve(g, body.from, 'write').path;
        const to = this.#resolve(g, body.to, 'write').path;
        if (existsSync(to)) throw new OpError(409, 'conflict', 'the destination exists');
        renameSync(from, to);
        return { ok: true, path: to };
      }
      default:
        throw new OpError(404, 'not_found', 'unknown file operation');
    }
  }
}

function sameGrantee(
  a: { kind: string; id: string },
  b: { kind: string; id: string } | undefined,
): boolean {
  return !!b && a.kind === b.kind && a.id === b.id;
}
