// What the Network Setup assistant needs from the other M6.5 areas, as small interfaces the Hub
// binds late: reachability tests (network area), certificates (trust area), Relay enrollment
// (relay area) and the network change log (network area) that the generic rollback walks. Without
// one, the steps that need it fail with the reason (fail closed).
import type { NetworkSetupRequestTransport, NetworkSetupTransport } from '@nova/shared';
import type { JsonObject } from '../mesh/types.ts';

/** One reachability probe of the Hub's own `GET /api/v1/hello` at a candidate URL. */
export interface SetupReachabilityResult {
  transport: NetworkSetupTransport;
  url: string;
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
}

export interface SetupReachability {
  /** Test every candidate now (the network area's `POST /api/v1/network/test`). */
  test(): Promise<SetupReachabilityResult[]>;
}

export interface SetupTrust {
  /** Create the Hub local CA if missing. */
  ensureLocalCa(): Promise<{ caFingerprint: string }>;
  /** Fetch (through the mesh certificate source) and install a certificate for `host`. */
  requestMeshCert(host: string): Promise<{ host: string; notAfter: string }>;
}

export interface SetupRelayState {
  enabled: boolean;
  url: string | null;
  connected: boolean;
}

export interface SetupRelay {
  state(): Promise<SetupRelayState>;
  /** Change the Relay settings (the relay area audits and applies them). */
  set(next: { enabled: boolean; url: string | null }): Promise<void>;
}

/**
 * The network area's change log (`packages/core/src/network/changes.ts`): every applied setup
 * step is recorded with an undo descriptor so `POST /api/v1/network/rollback` can revert it
 * through the handler registered for its kind.
 */
export interface SetupChangeLog {
  record(input: {
    kind: string;
    summary: string;
    undo: JsonObject;
    accountId?: string;
  }): Promise<{ id: string } | string>;
  registerUndo(kind: string, handler: (undo: JsonObject) => Promise<void>): unknown;
}

/** The change-log kind of an applied setup step. */
export const SETUP_CHANGE_KIND = 'network.setup.step';

/** A mesh endpoint for the network area's registry (`useEndpointSource`, protocol shape). */
export interface MeshEndpointCandidate {
  transport: 'mesh';
  url: string;
  priority: number;
  health: 'ok' | 'failing' | 'unknown';
  latencyMs: number | null;
  checkedAt: string | null;
  detail: string | null;
}

export interface LockoutRefusal {
  reason: 'would_lock_out';
  transport: NetworkSetupRequestTransport;
  affects: NetworkSetupTransport[];
}

/**
 * The lock-out guard (docs/22 §6.8): a change that could cut the transport the owner's request
 * came in on is refused unless another healthy transport, which the change does not touch, is
 * there to come back on. A request from the Hub itself (loopback) cannot be cut; one whose
 * transport is unknown is treated as riding any of the touched ones.
 */
export function lockoutRefusal(
  transport: NetworkSetupRequestTransport,
  affects: readonly NetworkSetupTransport[],
  results: readonly SetupReachabilityResult[] | null,
): LockoutRefusal | null {
  if (!affects.length || transport === 'local') return null;
  if (transport !== 'unknown' && !affects.includes(transport)) return null;
  const other = (results ?? []).some(
    (r) => r.ok && r.transport !== transport && !affects.includes(r.transport),
  );
  return other ? null : { reason: 'would_lock_out', transport, affects: [...affects] };
}

/** Whether a change cost the owner's transport (it answered before and does not now). */
export function transportLost(
  transport: NetworkSetupRequestTransport,
  affects: readonly NetworkSetupTransport[],
  before: readonly SetupReachabilityResult[] | null,
  after: readonly SetupReachabilityResult[] | null,
): NetworkSetupTransport | null {
  if (!before || !after || transport === 'local') return null;
  const ok = (rs: readonly SetupReachabilityResult[], t: NetworkSetupTransport) =>
    rs.some((r) => r.transport === t && r.ok);
  const watch: readonly NetworkSetupTransport[] = transport === 'unknown' ? affects : [transport];
  return watch.find((t) => ok(before, t) && !ok(after, t)) ?? null;
}
