// Enrollment and the running node (FR-126, docs/21 §7, ADR-089). `enroll` registers this machine
// with a Hub once, using a one-use enrollment token; `ComputeNode` serves the job API, sends a
// heartbeat every interval and re-signs its capability document when the backend's models change.
// An https:// Hub is trusted through the pinned fingerprint and the node presents the device
// certificate Add Device granted (mutual TLS, hub-tls.ts); a node on http:// with a pin moves to
// https:// once the Hub serves it, never back.
//
// M7.5 (FR-126 leftovers): GPU memory from a VRAM probe goes into the capability document and every
// heartbeat; quiet hours (the operator's own `--quiet-hours` and the owner's policy from the
// heartbeat answer) refuse new jobs; the Hub manages the `jobs` service and, when the operator
// named its unit, the model server (`/node/v1/services/*`).
import { hostname, networkInterfaces } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { NovaError, quietHoursActive } from '@nova/shared';
import { Logger, stderrSink } from '@nova/telemetry';
import { Backend, guardedFetch, type BackendKind } from './backend.ts';
import { buildCapability, type HardwareFacts, type OsFacts } from './capability.ts';
import { HubClient, HubError } from './hub-client.ts';
import { HubTls, learnCaOverHttp, type HubTrust } from './hub-tls.ts';
import { generateKeys, newDeviceId, newJobToken, signDocument, type NodeKeys } from './identity.ts';
import { JobManager } from './jobs.ts';
import { PROTOCOL_VERSIONS, type HubNodePolicy } from './protocol.ts';
import { buildJobServer } from './server.ts';
import { NodeServices, UNIT_NAME, type UnitController } from './services.ts';
import { loadState, saveState, statePath, type Enrollment, type NodeState } from './state.ts';
import type { GpuMemory, VramProbe } from './vram.ts';

export const DEFAULT_PORT = 7420;

const QUIET_RANGE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/** `HH:MM-HH:MM` ranges (`--quiet-hours`, comma separated), checked. */
export function parseQuietHours(value: string | string[]): string[] {
  const list = (Array.isArray(value) ? value : value.split(','))
    .map((r) => r.trim())
    .filter(Boolean);
  for (const r of list)
    if (!QUIET_RANGE.test(r)) throw new TypeError(`quiet hours look like 22:00-07:00, not ${r}`);
  if (list.length > 10) throw new TypeError('at most 10 quiet-hour ranges');
  return list;
}

/** This machine's IANA time zone. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

async function readVram(probe: VramProbe | undefined): Promise<GpuMemory[] | null> {
  if (!probe) return null;
  try {
    return await probe.read();
  } catch {
    return null;
  }
}

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
  /** The Hub fingerprint to pin (`--pin`): required to trust an https:// Hub's own CA. */
  pin?: string;
  /** What a verified identity statement already vouched for (Add Device passes it on). */
  trust?: HubTrust;
  /** The device certificate Add Device granted for `keys` (local-CA mode). */
  certificatePem?: string | null;
  /** The operator's quiet hours (`--quiet-hours`): no new jobs then (M7.5). */
  quietHours?: string[];
  /** The systemd unit running the model server, which the Hub may then manage. */
  backendUnit?: string | null;
  /** Reads GPU memory for the capability document (main.ts detects one; none by default). */
  vram?: VramProbe;
  /** Defaults to this machine's zone. */
  timeZone?: string;
}

/**
 * The `fetch` for the Hub: through the pinned trust (presenting the device certificate) when
 * there is one, else the platform's (an https:// Hub without a pin is checked against the
 * system's roots, e.g. a mesh certificate).
 */
export function hubFetchFor(
  hubUrl: string,
  tls: HubTls | null,
  base: typeof fetch | undefined,
): typeof fetch {
  return guardedFetch([hubUrl], tls ? tls.fetch(base) : base);
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
  const quietHours = parseQuietHours(opts.quietHours ?? []);
  const backendUnit = opts.backendUnit ?? null;
  if (backendUnit !== null && !UNIT_NAME.test(backendUnit))
    throw new TypeError(`not a systemd unit name: ${backendUnit}`);

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
  let trust: HubTrust | null =
    opts.trust ?? (opts.pin ? { pin: opts.pin, caPem: null, listed: [] } : null);
  const certificatePem = opts.certificatePem ?? null;
  if (trust && new URL(hubUrl).protocol === 'http:')
    // The Hub local CA from the signed statement, so a later move to HTTPS is trusted.
    trust = await learnCaOverHttp(hubUrl, trust, guardedFetch([hubUrl], opts.fetch));
  const tls = trust
    ? new HubTls({
        trust,
        client: certificatePem ? { certPem: certificatePem, keyPem: keys.privateKeyPem } : null,
        onTrust: (t) => (trust = t),
      })
    : null;
  const deviceId = existing?.deviceId ?? newDeviceId();
  const vram = await readVram(opts.vram);
  const capability = buildCapability({
    deviceId,
    name,
    backendKind,
    models,
    maxConcurrentJobs,
    ...(opts.hardware ? { hardware: opts.hardware } : {}),
    ...(opts.os ? { os: opts.os } : {}),
    ...(vram?.length ? { vram } : {}),
    timeZone: opts.timeZone ?? localTimeZone(),
    quietHours,
  });
  const hub = new HubClient({ hubUrl, fetch: hubFetchFor(hubUrl, tls, opts.fetch) });
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
      certificatePem,
    },
    revokedAt: null,
    hubTrust: trust,
    quietHours,
    backendUnit,
    hubPolicy: null,
    jobsStopped: false,
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
  /** Reads GPU memory for the document and heartbeats (main.ts detects one; none by default). */
  vram?: VramProbe;
  /** Controls the model server's unit (`systemctl` by default). */
  units?: UnitController;
  /** The clock quiet hours are read with (tests). */
  now?: () => Date;
  /** Defaults to this machine's zone. */
  timeZone?: string;
}

export type StopReason = 'stopped' | 'revoked';

export class ComputeNode {
  readonly jobs: JobManager;
  readonly services: NodeServices;
  readonly done: Promise<StopReason>;
  readonly #opts: RunOptions;
  #state: NodeState;
  #enrollment: Enrollment | null;
  readonly #backend: Backend;
  #hub: HubClient;
  #httpsTriedAt = -Infinity;
  readonly #server: FastifyInstance;
  readonly #log: Logger;
  #synced: string | null = null;
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
    this.#hub = this.#hubClient(state.hubUrl);
    this.jobs = new JobManager({
      run: (req) => this.#backend.stream(req),
      maxConcurrentJobs: state.maxConcurrentJobs,
      maxQueue: state.maxQueue,
      gate: () => this.#refusal(),
    });
    this.services = new NodeServices({
      jobs: {
        stopped: () => this.#state.jobsStopped === true,
        setStopped: (stopped) => {
          this.#state = { ...this.#state, jobsStopped: stopped };
          saveState(this.#opts.dataDir, { ...this.#state, enrollment: this.#enrollment });
          this.#log.info(stopped ? 'jobs stopped by the Hub' : 'jobs started by the Hub');
        },
        cancelAll: () => this.jobs.cancelAll(),
      },
      backendUnit: state.backendUnit ?? null,
      ...(opts.units ? { units: opts.units } : {}),
    });
    this.#server = buildJobServer({
      jobs: this.jobs,
      jobToken: () => this.#enrollment?.jobToken ?? null,
      log: this.#log.child('jobs'),
      services: this.services,
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

  /** The Hub this node reports to now (it moves to https:// once the Hub serves it). */
  get hubUrl(): string {
    return this.#state.hubUrl;
  }

  #tls(): HubTls | null {
    const trust = this.#state.hubTrust;
    const e = this.#enrollment;
    if (!trust) return null;
    return new HubTls({
      trust,
      client: e?.certificatePem ? { certPem: e.certificatePem, keyPem: e.privateKeyPem } : null,
      onTrust: (t) => {
        this.#state = { ...this.#state, hubTrust: t };
        saveState(this.#opts.dataDir, { ...this.#state, enrollment: this.#enrollment });
      },
    });
  }

  #hubClient(hubUrl: string): HubClient {
    return new HubClient({ hubUrl, fetch: hubFetchFor(hubUrl, this.#tls(), this.#opts.fetch) });
  }

  /**
   * The Hub stopped answering at its http:// address: if it now serves HTTPS there and the pinned
   * identity vouches for it, report there from now on (at most one try a minute). Never back.
   */
  async #tryHttps(): Promise<void> {
    const url = new URL(this.#state.hubUrl);
    if (url.protocol !== 'http:' || !this.#state.hubTrust?.pin) return;
    if (Date.now() - this.#httpsTriedAt < 60_000) return;
    this.#httpsTriedAt = Date.now();
    url.protocol = 'https:';
    const https = url.href.replace(/\/+$/, '');
    const hub = this.#hubClient(https);
    try {
      await hub.hello();
    } catch {
      return;
    }
    this.#hub = hub;
    this.#state = { ...this.#state, hubUrl: https };
    saveState(this.#opts.dataDir, { ...this.#state, enrollment: this.#enrollment });
    this.#log.info('the Hub now serves HTTPS', { hub: https });
  }

  get nodeId(): string | null {
    return this.#enrollment?.nodeId ?? null;
  }

  /** The owner's policy from the last heartbeat answer, if any. */
  get hubPolicy(): HubNodePolicy | null {
    return this.#state.hubPolicy ?? null;
  }

  #zone(): string {
    return this.#opts.timeZone ?? localTimeZone();
  }

  /** In the operator's quiet hours, or the owner's (in the owner's zone, else this one). */
  quietNow(): boolean {
    const now = this.#opts.now?.() ?? new Date();
    const zone = this.#zone();
    if (quietHoursActive(this.#state.quietHours ?? [], now, zone)) return true;
    const p = this.#state.hubPolicy;
    return p ? quietHoursActive(p.quietHours, now, p.timeZone ?? zone) : false;
  }

  /** Why a new job is refused now, or null. */
  #refusal(): NovaError | null {
    if (this.#state.jobsStopped)
      return new NovaError('node_unavailable', 'the node’s jobs service is stopped', {
        details: { reason: 'jobs_stopped' },
      });
    if (this.quietNow())
      return new NovaError('node_unavailable', 'the node is in its quiet hours', {
        details: { reason: 'quiet_hours' },
      });
    return null;
  }

  /** Keep a newer policy from a heartbeat answer (the node honors it at once and after restarts). */
  #takePolicy(policy: HubNodePolicy | undefined): void {
    if (!policy || policy.revision === this.#state.hubPolicy?.revision) return;
    const ranges = Array.isArray(policy.quietHours)
      ? policy.quietHours.filter((r) => typeof r === 'string' && QUIET_RANGE.test(r)).slice(0, 10)
      : [];
    this.#state = {
      ...this.#state,
      hubPolicy: {
        quietHours: ranges,
        timeZone: typeof policy.timeZone === 'string' ? policy.timeZone : null,
        routingEligible: policy.routingEligible !== false,
        revision: Number.isInteger(policy.revision) ? policy.revision : 0,
      },
    };
    saveState(this.#opts.dataDir, { ...this.#state, enrollment: this.#enrollment });
    this.#log.info('the Hub’s policy for this node changed', { revision: policy.revision });
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
    const vram = await readVram(this.#opts.vram);
    try {
      // The signed document changes with the models and the GPUs' total memory.
      const key = models
        ? JSON.stringify([models, (vram ?? []).map((g) => [g.name, g.totalBytes])])
        : null;
      if (models && key !== this.#synced) {
        const capability = buildCapability({
          deviceId: this.#state.deviceId,
          name: this.#state.name,
          backendKind: this.#state.backend.kind,
          models,
          maxConcurrentJobs: this.#state.maxConcurrentJobs,
          ...(this.#opts.hardware ? { hardware: this.#opts.hardware } : {}),
          ...(this.#opts.os ? { os: this.#opts.os } : {}),
          ...(vram?.length ? { vram } : {}),
          timeZone: this.#zone(),
          quietHours: this.#state.quietHours ?? [],
        });
        await this.#hub.syncModels(enrollment.credential, {
          capability,
          signature: signDocument(capability, enrollment.privateKeyPem),
        });
        this.#synced = key;
        this.#log.info('models synced with the Hub', { models: models.length });
      }
      // A backend that does not answer serves nothing: report no models until it is back.
      const answer = await this.#hub.heartbeat(enrollment.credential, {
        load: this.jobs.load(),
        models: models ?? [],
        ...(vram ? { vram } : {}),
        quiet: this.quietNow(),
      });
      this.#takePolicy(answer.policy);
    } catch (err) {
      if (err instanceof HubError && err.status === 401) {
        await this.#revoked();
        return;
      }
      if (err instanceof HubError && err.status === 403 && err.reason?.startsWith('certificate_')) {
        // Mutual TLS (FR-126): the Hub wants this node's certificate, or refused it.
        this.#log.warn('the Hub refused this node over HTTPS', { reason: err.reason });
        return;
      }
      this.#log.warn('heartbeat failed', { err: err instanceof Error ? err.message : String(err) });
      if (err instanceof HubError && err.status === 0) await this.#tryHttps();
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
