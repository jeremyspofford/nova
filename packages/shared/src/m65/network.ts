// M6.5 network API shapes (owned by the network area; clients and the web read them). Transports
// and the Hub's endpoints with their health (FR-135, docs/22 §2), the client's endpoint selection
// (happy eyeballs, docs/22 §2), the network panel and its diagnostics (FR-139, docs/22 §6), the
// change log behind one-click rollback (docs/22 §9.5) and Wake Helpers (FR-138, docs/22 §7).
import { z } from 'zod';
import { idSchema } from '../api.ts';

/** How a client reaches the Hub, in the order clients try them (docs/22 §2). */
export const NETWORK_TRANSPORTS = ['lan', 'mesh', 'relay', 'direct'] as const;
export type NetworkTransport = (typeof NETWORK_TRANSPORTS)[number];

/** Base priority per transport; candidates of one transport take base + their index (< 10). */
export const TRANSPORT_PRIORITY: Readonly<Record<NetworkTransport, number>> = {
  lan: 10,
  mesh: 20,
  relay: 30,
  direct: 40,
};

export type EndpointHealth = 'ok' | 'failing' | 'unknown';

/** One way to reach the Hub. Only `health: ok` candidates are advertised (docs/22 §9.7). */
export interface EndpointCandidate {
  transport: NetworkTransport;
  url: string;
  /** Lower is tried first. */
  priority: number;
  health: EndpointHealth;
  latencyMs: number | null;
  checkedAt: string | null;
  /** Why it is failing, or where it comes from (an interface name, `mdns`, a provider). */
  detail: string | null;
}

export const endpointCandidateSchema = z.object({
  transport: z.enum(NETWORK_TRANSPORTS),
  url: z.string().min(1).max(500),
  priority: z.number().int().min(0).max(1000),
  health: z.enum(['ok', 'failing', 'unknown']),
  latencyMs: z.number().min(0).nullable(),
  checkedAt: z.string().nullable(),
  detail: z.string().max(500).nullable(),
});

// ---- client-side selection (happy eyeballs) ---------------------------------------------------

/** What a probe of one candidate found; a bare boolean means ok or not. */
export interface EndpointProbeOutcome {
  ok: boolean;
  latencyMs?: number | null;
  detail?: string | null;
}

/** Reach one candidate (for example `GET <url>/api/v1/hello`); stop when `signal` aborts. */
export type EndpointProbe = (
  candidate: EndpointCandidate,
  signal: AbortSignal,
) => Promise<boolean | EndpointProbeOutcome>;

export interface EndpointAttempt {
  transport: NetworkTransport;
  url: string;
  /** Milliseconds after the selection started. */
  startedAtMs: number;
  endedAtMs: number;
  outcome: 'ok' | 'failed' | 'timeout' | 'cancelled';
  latencyMs: number | null;
  detail: string | null;
}

export interface EndpointSelection {
  winner: EndpointCandidate | null;
  latencyMs: number | null;
  /** Every attempt in the order it started. */
  attempts: EndpointAttempt[];
}

export interface SelectEndpointOptions {
  /** Start the next candidate after this long without an answer (default 300 ms, docs/22 §2). */
  budgetMs?: number;
  /** Give up on one attempt after this long (default 5 s). */
  timeoutMs?: number;
  /** A millisecond clock (default `performance.now`). */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Abandon the selection: every running attempt is cancelled and there is no winner. */
  signal?: AbortSignal;
}

export const ENDPOINT_BUDGET_MS = 300;

/**
 * Pick the endpoint to use (docs/22 §2): try candidates in priority order (LAN → Mesh → Relay →
 * Direct), starting the next one when the previous has not answered within the budget or as soon
 * as it fails; the first success wins and the others are cancelled. Returns the winner (null when
 * every attempt failed) and the attempts log.
 */
export function selectEndpoint(
  candidates: readonly EndpointCandidate[],
  probe: EndpointProbe,
  opts: SelectEndpointOptions = {},
): Promise<EndpointSelection> {
  const budgetMs = opts.budgetMs ?? ENDPOINT_BUDGET_MS;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  // A stable sort keeps the caller's order among equal priorities.
  const ordered = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.priority - b.c.priority || a.i - b.i)
    .map((x) => x.c);
  const started = now();
  const attempts: EndpointAttempt[] = [];
  const running = new Map<EndpointAttempt, { ctl: AbortController; timer: unknown }>();

  return new Promise((resolve) => {
    let next = 0;
    let done = false;
    let stagger: unknown = null;

    const finish = (winner: EndpointCandidate | null, latencyMs: number | null) => {
      if (done) return;
      done = true;
      if (stagger !== null) clearTimer(stagger);
      opts.signal?.removeEventListener('abort', onAbort);
      const at = now() - started;
      for (const [attempt, r] of running) {
        clearTimer(r.timer);
        r.ctl.abort();
        attempt.outcome = 'cancelled';
        attempt.endedAtMs = at;
      }
      running.clear();
      resolve({ winner, latencyMs, attempts });
    };

    const onAbort = () => finish(null, null);

    const launch = () => {
      if (done) return;
      if (stagger !== null) {
        clearTimer(stagger);
        stagger = null;
      }
      const c = ordered[next];
      if (!c) {
        if (running.size === 0) finish(null, null);
        return;
      }
      next += 1;
      const startedAtMs = now() - started;
      const attempt: EndpointAttempt = {
        transport: c.transport,
        url: c.url,
        startedAtMs,
        endedAtMs: startedAtMs,
        outcome: 'cancelled',
        latencyMs: null,
        detail: null,
      };
      attempts.push(attempt);
      const ctl = new AbortController();
      const settle = (outcome: EndpointAttempt['outcome'], detail: string | null, ms?: number) => {
        if (done || !running.has(attempt)) return;
        clearTimer(running.get(attempt)?.timer);
        running.delete(attempt);
        attempt.endedAtMs = now() - started;
        attempt.outcome = outcome;
        attempt.detail = detail;
        attempt.latencyMs = ms ?? attempt.endedAtMs - attempt.startedAtMs;
        if (outcome === 'ok') {
          finish(c, attempt.latencyMs);
          return;
        }
        ctl.abort();
        // A failure starts the next candidate at once rather than waiting out the budget.
        launch();
      };
      const timer = setTimer(() => settle('timeout', 'timed out'), timeoutMs);
      running.set(attempt, { ctl, timer });
      probe(c, ctl.signal).then(
        (r) => {
          const o: EndpointProbeOutcome = typeof r === 'boolean' ? { ok: r } : r;
          settle(o.ok ? 'ok' : 'failed', o.detail ?? null, o.latencyMs ?? undefined);
        },
        (err: unknown) => settle('failed', err instanceof Error ? err.message : String(err)),
      );
      if (next < ordered.length && !done) stagger = setTimer(launch, budgetMs);
    };

    if (opts.signal?.aborted) {
      finish(null, null);
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (ordered.length === 0) finish(null, null);
    else launch();
  });
}

// ---- the network panel (FR-135, FR-139) -------------------------------------------------------

/** `up`: something advertised; `down`: candidates, none healthy; `off`: disabled; `none`: no candidates. */
export type TransportStatus = 'up' | 'down' | 'off' | 'none';

export interface NetworkTransportView {
  transport: NetworkTransport;
  enabled: boolean;
  status: TransportStatus;
  endpoints: EndpointCandidate[];
  /** Why there is nothing to advertise, when it can be said (a guided fix). */
  detail: string | null;
}

/** Hub trust paths (the trust area's summary; FR-134, docs/22 §5). */
export interface NetworkTrustSummary {
  mode: string;
  caFingerprint: string | null;
  leafNotAfter: string | null;
  leafSans: string[];
  meshCert: { host: string; notAfter: string } | null;
  problems: string[];
}

export interface NetworkChangeView {
  id: string;
  kind: string;
  summary: string;
  actor: string;
  status: 'applied' | 'rolled_back';
  /** The last failed rollback attempt. */
  error: string | null;
  createdAt: string;
  rolledBackAt: string | null;
}

export interface TransportEventView {
  id: string;
  /** `off`: the owner turned the transport off (not a failure). */
  kind: 'advertised' | 'withdrawn' | 'up' | 'down' | 'off' | 'primary';
  transport: NetworkTransport | null;
  fromTransport: NetworkTransport | null;
  url: string | null;
  detail: string | null;
  createdAt: string;
}

/** A recent wake (FR-138): `via` is the helper's device id, `hub` when the Hub sent it, else null. */
export interface WakeLogView {
  id: string;
  deviceId: string;
  deviceName: string | null;
  mac: string;
  status: 'pending' | 'sent' | 'failed' | 'rate_limited';
  via: string | null;
  viaName: string | null;
  error: string | null;
  createdAt: string;
}

export interface WakeHelperView {
  deviceId: string;
  name: string;
  status: string;
  /** The addresses the Hub last saw for it (from its registered endpoints). */
  addresses: string[];
  /** The physical LAN subnets it reported with its power status (`192.168.1.0/24`). */
  subnets: string[];
  lastSeenAt: string | null;
}

export interface NetworkListenerView {
  host: string;
  port: number;
  protocol: 'http' | 'https';
}

export interface NetworkView {
  transports: NetworkTransportView[];
  /** What clients are told, best first. */
  advertised: EndpointCandidate[];
  /** The transport of the best advertised endpoint. */
  primary: NetworkTransport | null;
  listener: NetworkListenerView | null;
  lan: {
    mdns: { enabled: boolean; running: boolean; name: string | null };
    includeLoopback: boolean;
    includeLinkLocal: boolean;
  };
  directPublic: { url: string | null };
  healthCheckSeconds: number;
  trust: NetworkTrustSummary | null;
  /** The sandbox egress policy is edited under /api/v1/egress (FR-193). */
  egress: { mode: string; href: string };
  wakeHelpers: { configured: string[]; available: WakeHelperView[]; recent: WakeLogView[] };
  lastChange: NetworkChangeView | null;
}

const dnsLabel = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, 'a DNS label: a-z, 0-9 and hyphens');

/** A plain http(s) base URL: no credentials, query or fragment. */
export const networkBaseUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(500)
  .refine((u) => {
    const url = new URL(u);
    return !url.username && !url.password && !url.search && !url.hash;
  }, 'a plain http(s) URL without credentials, query or fragment');

export const updateNetworkSchema = z
  .object({
    transports: z
      .object({
        lan: z.boolean(),
        mesh: z.boolean(),
        relay: z.boolean(),
        directPublic: z.boolean(),
      })
      .partial()
      .strict()
      .optional(),
    lan: z
      .object({
        mdns: z.boolean(),
        mdnsName: dnsLabel.nullable(),
        includeLoopback: z.boolean(),
        includeLinkLocal: z.boolean(),
      })
      .partial()
      .strict()
      .optional(),
    directPublic: z.object({ url: networkBaseUrlSchema.nullable() }).strict().optional(),
    wakeHelpers: z.array(idSchema).max(50).optional(),
    healthCheckSeconds: z.number().int().min(10).max(3_600).optional(),
  })
  .strict();
export type UpdateNetworkRequest = z.infer<typeof updateNetworkSchema>;

export const networkRollbackSchema = z.object({ changeId: idSchema.optional() }).strict();

export interface NetworkTestResult {
  checkedAt: string;
  transports: NetworkTransportView[];
  advertised: EndpointCandidate[];
  primary: NetworkTransport | null;
}

export interface DeviceReachabilityView {
  deviceId: string;
  name: string;
  kind: string;
  roles: string[];
  status: string;
  lastSeenAt: string | null;
  /** Active and heard from within its heartbeat window. */
  reachable: boolean;
  /** Paired through the Relay (M7 routes it there). */
  relayPaired: boolean;
  endpoints: {
    transport: NetworkTransport;
    url: string;
    healthy: boolean;
    latencyMs: number | null;
    checkedAt: string | null;
  }[];
}

export interface NetworkDiagnosticsView {
  checkedAt: string | null;
  primary: NetworkTransport | null;
  transports: NetworkTransportView[];
  /** Each candidate with its last 24 hours of checks. */
  endpoints: (EndpointCandidate & { uptime24h: { checks: number; ok: number } })[];
  /** The trust area's certificate status, or null when it is not set up. */
  trust: NetworkTrustSummary | null;
  /** The mesh area's ACL and tag summary, or null. */
  mesh: Record<string, unknown> | null;
  /** The Relay connector's status, or null. */
  relay: Record<string, unknown> | null;
  devices: DeviceReachabilityView[];
  /** Newest first. */
  events: TransportEventView[];
  /** Newest first; the first applied one is what rollback reverts. */
  changes: NetworkChangeView[];
  problems: string[];
}
