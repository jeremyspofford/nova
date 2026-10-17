// Enrollment and the running node (FR-126, docs/21 §7, ADR-089). `enroll` registers this machine
// with a Hub once, using a one-use enrollment token; `ComputeNode` serves the job API, sends a
// heartbeat every interval and re-signs its capability document when the backend's models change.
import { hostname, networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { Logger, stderrSink } from '@nova/telemetry';
import { Backend, guardedFetch, type BackendKind } from './backend.ts';
import { buildCapability, type HardwareFacts, type OsFacts } from './capability.ts';
import { HubClient, HubError } from './hub-client.ts';
import { generateKeys, newDeviceId, newJobToken, signDocument, type NodeKeys } from './identity.ts';
import { JobManager } from './jobs.ts';
import { PROTOCOL_VERSIONS } from './protocol.ts';
import { buildJobServer } from './server.ts';
import { loadState, saveState, statePath, type Enrollment, type NodeState } from './state.ts';

export const DEFAULT_PORT = 7420;

export interface EnrollOptions {
  hubUrl: string;
  token: string;
  backendUrl: string;
  backendKind?: BackendKind;
  name?: string;
  /** `host:port` the job API listens on (default 0.0.0.0:7420). */
  listen?: string;
  /** The URL the Hub calls (default: this machine's LAN address and the listen port). */
  advertise?: string;
  dataDir: string;
  maxConcurrentJobs?: number;
  maxQueue?: number;
  fetch?: typeof fetch;
  hardware?: HardwareFacts;
  os?: OsFacts;
  /** The node's key pair (Add Device approved this key); a new one by default. */
  keys?: NodeKeys;
}

/** `host:port`, `:port` or `port`; IPv6 hosts in brackets. */
export function parseListen(value: string): { host: string; port: number } {
  const v = value.trim();
  let host = '0.0.0.0';
  let portText = v;
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(v);
  if (v6) {
    host = v6[1] ?? host;
    portText = v6[2] ?? '';
  } else if (v.includes(':')) {
    const i = v.lastIndexOf(':');
    host = v.slice(0, i) || host;
    portText = v.slice(i + 1);
  }
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port > 65535)
    throw new TypeError(`invalid listen address: ${value} (use host:port)`);
  return { host, port };
}

/** The job API URL for a listen address: a wildcard host becomes this machine's LAN address. */
export function advertiseUrl(listen: { host: string; port: number }): string {
  let host = listen.host;
  if (host === '0.0.0.0' || host === '::') {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === 'IPv4' && !a.internal);
    host = lan?.address ?? '127.0.0.1';
  }
  return `http://${host.includes(':') ? `[${host}]` : host}:${listen.port}`;
}

export function plainHttpUrl(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${what} is not a URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new TypeError(`${what} must use http or https`);
  return url.href.replace(/\/+$/, '');
}

/** Register this machine with a Hub and write the state file. Prints nothing. */
export async function enroll(opts: EnrollOptions): Promise<NodeState> {
  const existing = loadState(opts.dataDir);
  if (existing?.enrollment) {
    throw new Error(
      `this node is already enrolled (node ${existing.enrollment.nodeId}); ` +
        `remove ${statePath(opts.dataDir)} to enroll again`,
    );
  }
  if (!opts.token.startsWith('nve_')) throw new TypeError('the enrollment token starts with nve_');
  const hubUrl = plainHttpUrl(opts.hubUrl, 'the Hub URL');
  const backendUrl = plainHttpUrl(opts.backendUrl, 'the backend URL');
  const backendKind = opts.backendKind ?? 'ollama';
  const listen = parseListen(opts.listen ?? `0.0.0.0:${DEFAULT_PORT}`);
  // The Hub must know where to call: an ephemeral port is only usable with an explicit URL.
  if (listen.port === 0 && !opts.advertise)
    throw new TypeError('listening on port 0 needs an advertised URL (--advertise)');
  const endpoint = plainHttpUrl(opts.advertise ?? advertiseUrl(listen), 'the advertised URL');
  const name = (opts.name ?? hostname()).trim().slice(0, 100) || 'compute node';
  const maxConcurrentJobs = Math.max(1, opts.maxConcurrentJobs ?? 1);

  const backend = new Backend({ url: backendUrl, kind: backendKind, ...fetchOpt(opts.fetch) });
  let models: string[];
  try {
    models = await backend.models();
  } catch (err) {
    throw new Error(
      `the model backend at ${backendUrl} did not answer: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const keys = opts.keys ?? generateKeys();
  const jobToken = newJobToken();
  const deviceId = existing?.deviceId ?? newDeviceId();
  const capability = buildCapability({
    deviceId,
    name,
    backendKind,
    models,
    maxConcurrentJobs,
    ...(opts.hardware ? { hardware: opts.hardware } : {}),
    ...(opts.os ? { os: opts.os } : {}),
  });
  const hub = new HubClient({ hubUrl, fetch: guardedFetch([hubUrl], opts.fetch) });
  const result = await hub.register({
    enrollToken: opts.token,
    name,
    endpoint,
    publicKey: keys.publicKey,
    capability,
    signature: signDocument(capability, keys.privateKeyPem),
    jobToken,
    protocolVersions: PROTOCOL_VERSIONS,
  });
  const state: NodeState = {
    version: 1,
    deviceId,
    name,
    hubUrl,
    backend: { url: backendUrl, kind: backendKind },
    listen,
    endpoint,
    maxConcurrentJobs,
    maxQueue: Math.max(0, opts.maxQueue ?? 4),
    enrollment: {
      nodeId: result.nodeId,
      credential: result.credential,
      jobToken,
      privateKeyPem: keys.privateKeyPem,
      publicKey: keys.publicKey,
      heartbeatIntervalMs: result.heartbeatIntervalMs,
      protocolVersion: result.protocolVersion,
      enrolledAt: new Date().toISOString(),
    },
    revokedAt: null,
  };
  saveState(opts.dataDir, state);
  return state;
}

function fetchOpt(f: typeof fetch | undefined): { fetch?: typeof fetch } {
  return f ? { fetch: f } : {};
}

export interface RunOptions {
  dataDir: string;
  log?: Logger;
  fetch?: typeof fetch;
  /** Override the stored listen address (tests use port 0). */
  listen?: { host: string; port: number };
  heartbeatIntervalMs?: number;
  keepAliveMs?: number;
  hardware?: HardwareFacts;
  os?: OsFacts;
}

export type StopReason = 'stopped' | 'revoked';

export class ComputeNode {
  readonly jobs: JobManager;
  readonly done: Promise<StopReason>;
  readonly #opts: RunOptions;
  readonly #state: NodeState;
  #enrollment: Enrollment | null;
  readonly #backend: Backend;
  readonly #hub: HubClient;
  readonly #server: FastifyInstance;
  readonly #log: Logger;
  #synced: string[] | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #beating: Promise<void> | null = null;
  #stopped = false;
  #resolve!: (r: StopReason) => void;
  #url = '';

  private constructor(opts: RunOptions, state: NodeState, enrollment: Enrollment) {
    this.#opts = opts;
    this.#state = state;
    this.#enrollment = enrollment;
    this.#log = opts.log ?? new Logger({ module: 'compute', sinks: [stderrSink] });
    this.#backend = new Backend({
      url: state.backend.url,
      kind: state.backend.kind,
      ...fetchOpt(opts.fetch),
    });
    this.#hub = new HubClient({
      hubUrl: state.hubUrl,
      fetch: guardedFetch([state.hubUrl], opts.fetch),
    });
    this.jobs = new JobManager({
      run: (req) => this.#backend.stream(req),
      maxConcurrentJobs: state.maxConcurrentJobs,
      maxQueue: state.maxQueue,
    });
    this.#server = buildJobServer({
      jobs: this.jobs,
      jobToken: () => this.#enrollment?.jobToken ?? null,
      log: this.#log.child('jobs'),
      ...(opts.keepAliveMs ? { keepAliveMs: opts.keepAliveMs } : {}),
    });
    this.done = new Promise((resolve) => (this.#resolve = resolve));
  }

  /** Load the state file, listen, and start heartbeats (the first one is sent at once). */
  static async start(opts: RunOptions): Promise<ComputeNode> {
    const state = loadState(opts.dataDir);
    if (!state?.enrollment) {
      throw new Error(
        state?.revokedAt
          ? 'this node was revoked by its Hub; enroll it again with a new token'
          : 'this node is not enrolled; run `nova-compute enroll` first',
      );
    }
    const node = new ComputeNode(opts, state, state.enrollment);
    const listen = opts.listen ?? state.listen;
    node.#url = await node.#server.listen({ host: listen.host, port: listen.port });
    node.#log.info('compute node listening', {
      nodeId: state.enrollment.nodeId,
      url: node.#url,
      hub: state.hubUrl,
    });
    await node.beat();
    node.#schedule();
    return node;
  }

  get url(): string {
    return this.#url;
  }

  get nodeId(): string | null {
    return this.#enrollment?.nodeId ?? null;
  }

  /**
   * One heartbeat cycle: list the backend's models, re-sign and sync the capability document if
   * they changed, then report load and models. A 401 means the Hub revoked this node.
   */
  async beat(): Promise<void> {
    if (this.#beating) return this.#beating;
    this.#beating = this.#beat().finally(() => (this.#beating = null));
    return this.#beating;
  }

  async #beat(): Promise<void> {
    const enrollment = this.#enrollment;
    if (!enrollment || this.#stopped) return;
    let models: string[] | null;
    try {
      models = await this.#backend.models();
    } catch (err) {
      models = null;
      this.#log.warn('the model backend did not answer', { err: String(err) });
    }
    try {
      if (models && (this.#synced === null || models.join('\n') !== this.#synced.join('\n'))) {
        const capability = buildCapability({
          deviceId: this.#state.deviceId,
          name: this.#state.name,
          backendKind: this.#state.backend.kind,
          models,
          maxConcurrentJobs: this.#state.maxConcurrentJobs,
          ...(this.#opts.hardware ? { hardware: this.#opts.hardware } : {}),
          ...(this.#opts.os ? { os: this.#opts.os } : {}),
        });
        await this.#hub.syncModels(enrollment.credential, {
          capability,
          signature: signDocument(capability, enrollment.privateKeyPem),
        });
        this.#synced = models;
        this.#log.info('models synced with the Hub', { models: models.length });
      }
      // A backend that does not answer serves nothing: report no models until it is back.
      await this.#hub.heartbeat(enrollment.credential, {
        load: this.jobs.load(),
        models: models ?? [],
      });
    } catch (err) {
      if (err instanceof HubError && err.status === 401) {
        await this.#revoked();
        return;
      }
      this.#log.warn('heartbeat failed', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  #schedule(): void {
    if (this.#stopped) return;
    const every = this.#opts.heartbeatIntervalMs ?? this.#enrollment?.heartbeatIntervalMs ?? 10_000;
    this.#timer = setTimeout(() => {
      void this.beat().finally(() => this.#schedule());
    }, every);
  }

  /** The Hub refused the credential: wipe the secrets (keys and tokens) and stop serving. */
  async #revoked(): Promise<void> {
    this.#log.warn('the Hub revoked this node; credentials wiped', { nodeId: this.nodeId });
    this.#enrollment = null;
    saveState(this.#opts.dataDir, {
      ...this.#state,
      enrollment: null,
      revokedAt: new Date().toISOString(),
    });
    await this.#shutdown('revoked');
  }

  async stop(): Promise<void> {
    await this.#shutdown('stopped');
  }

  async #shutdown(reason: StopReason): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.jobs.close();
    await this.#server.close();
    this.#resolve(reason);
  }
}
