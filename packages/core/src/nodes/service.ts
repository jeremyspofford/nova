// Compute node registry (FR-126, docs/21 §6-§7, contracts/hub-api.md §2, ADR-089). The Hub issues
// one-use enrollment tokens; a node registers with one, an Ed25519 key and a capability document
// signed with it; the Hub pins the key, keeps the node's job token in the vault and returns a node
// credential for heartbeats and model sync. Only hashes of tokens reach the database.
import { randomBytes } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import {
  NODE_SERVICE_NAMES,
  NovaError,
  nodePolicySchema,
  uuidv7,
  type NodeDetailView,
  type NodeEnrollToken,
  type NodeGpuVram,
  type NodePolicy,
  type NodeServiceAction,
  type NodeServiceView,
  type NodeView,
} from '@nova/shared';
import { contracts } from '@nova/contracts';
import { secretRef, type SecretStore } from '@nova/secrets';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditSink } from '../tools/types.ts';
import { inDeviceQuietHours } from '../devices/service.ts';
import { keyFingerprint, nodeSecretHash, verifyDocument } from './crypto.ts';
import { enrollBindingOf, type EnrollKeyBinding } from '../pairing/binding.ts';
import {
  ENROLL_TOKEN_PREFIX,
  ENROLL_TOKEN_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  MISSED_BEATS,
  NODE_CREDENTIAL_PREFIX,
  heartbeatSchema,
  negotiateProtocol,
  registerNodeSchema,
  syncModelsSchema,
  type RegisterNodeResponse,
} from './protocol.ts';

const { addDeviceRequest, authToken, device, deviceCapability, transportEndpoint } = schema;

type DeviceRow = typeof device.$inferSelect;

/**
 * The compute node a credential (`nvn_…`) belongs to, or null (unknown, revoked or deleted): the
 * check every /node/v1 credential route makes, also used by the device-trust area to tie a client
 * certificate to the credential presented with it (FR-126).
 */
export async function computeNodeForCredential(
  db: NovaDatabase,
  credential: string,
): Promise<DeviceRow | null> {
  if (!credential.startsWith(NODE_CREDENTIAL_PREFIX) || credential.length > 200) return null;
  const rows = await db.orm
    .select({ device })
    .from(authToken)
    .innerJoin(device, eq(device.credentialTokenId, authToken.id))
    .where(
      and(
        eq(authToken.tokenHash, nodeSecretHash(credential)),
        eq(authToken.kind, 'device'),
        isNull(authToken.revokedAt),
        ne(device.status, 'revoked'),
      ),
    )
    .limit(1);
  return rows[0]?.device ?? null;
}
export type NodeStatus = NodeView['status'];
export type NodeLoad = { running: number; queued: number };

/** What routing needs about one node (NodeModelSource). */
export interface NodeRecord {
  id: string;
  accountId: string;
  name: string;
  status: NodeStatus;
  endpoint: string;
  models: string[];
  capabilities: NodeView['capabilities'];
  lastSeenAt: string | null;
  createdAt: string;
}

export type CapabilityValidator = (doc: unknown) => { ok: boolean; errors: string[] };

export interface NodeServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  events: EventSink;
  log?: Logger;
  now?: () => Date;
  heartbeatIntervalMs?: number;
  /** Beats a node may miss before it is marked unreachable (default 3). */
  missedBeats?: number;
  enrollTtlMs?: number;
  /** Defaults to contracts/schemas/device-capability.json via @nova/contracts. */
  validateCapability?: CapabilityValidator;
  audit?: AuditSink;
  /** The Hub's calls to a node's service routes (tests substitute it). */
  fetch?: typeof fetch;
}

const DEFAULT_NODE_POLICY: NodePolicy = {
  quietHours: [],
  timeZone: null,
  routingEligible: true,
  revision: 0,
};

interface NodePolicyRow {
  quiet_hours: string;
  time_zone: string | null;
  routing_eligible: number;
  revision: number;
}

interface LiveReport {
  load: NodeLoad;
  models: string[] | null;
  vram: NodeGpuVram[] | null;
  quiet: boolean | null;
}

/** Where the Hub keeps a node's job token (docs/12 §5: secrets only in the vault). */
export function jobTokenRef(nodeId: string): string {
  return secretRef('devices', nodeId, 'job-token');
}

function defaultValidator(): CapabilityValidator {
  const validate = contracts().validator('device-capability.json');
  return (doc) => {
    const r = validate(doc);
    return { ok: r.ok, errors: r.errors.map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`) };
  };
}

export class NodeService {
  readonly heartbeatIntervalMs: number;
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #events: EventSink;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #missedBeats: number;
  readonly #enrollTtlMs: number;
  readonly #validate: CapabilityValidator;
  /** Last heartbeat per node: load, the backend's models, VRAM and quiet (memory only). */
  readonly #live = new Map<string, LiveReport>();
  #audit: AuditSink | null;
  readonly #fetch: typeof fetch;
  readonly #revokeListeners = new Set<(nodeId: string) => void>();
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: NodeServiceOptions) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#events = opts.events;
    this.#log = opts.log ?? new Logger({ module: 'core.nodes', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.#missedBeats = opts.missedBeats ?? MISSED_BEATS;
    this.#enrollTtlMs = opts.enrollTtlMs ?? ENROLL_TOKEN_TTL_MS;
    this.#validate = opts.validateCapability ?? defaultValidator();
    this.#audit = opts.audit ?? null;
    this.#fetch = opts.fetch ?? ((...a) => fetch(...a));
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  // ---- enrollment -------------------------------------------------------------------------

  /**
   * A one-use enrollment token for a compute node. Creating it is the owner's approval. Add Device
   * binds it to the node's key and the pending record its approval created (FR-132): register
   * must then present that key and activates that record.
   */
  async createEnrollToken(accountId: string, bind?: EnrollKeyBinding): Promise<NodeEnrollToken> {
    const token = ENROLL_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + this.#enrollTtlMs).toISOString();
    await this.#db.transaction(() =>
      this.#db.orm.insert(addDeviceRequest).values({
        id: uuidv7(),
        accountId,
        role: 'compute',
        codeHash: nodeSecretHash(token),
        ...(bind ? { scopes: JSON.stringify({ bind }) } : {}),
        status: 'pending',
        expiresAt,
        createdAt: now.toISOString(),
      }),
    );
    return { token, expiresAt };
  }

  /**
   * Register a node. The enrollment token is burned once presented, whether or not the rest of
   * the registration succeeds (a refused document marks the request denied).
   */
  async register(input: unknown): Promise<RegisterNodeResponse> {
    const body = registerNodeSchema.parse(input);
    const protocolVersion = negotiateProtocol(body.protocolVersions);
    const request = await this.#consumeEnrollToken(body.enrollToken);
    const bind = enrollBindingOf(request.scopes);
    const nowIso = this.#now().toISOString();
    const nodeId = bind?.deviceId ?? uuidv7();
    const fingerprint = keyFingerprint(body.publicKey);
    const credential = NODE_CREDENTIAL_PREFIX + randomBytes(32).toString('base64url');
    const ref = jobTokenRef(nodeId);
    let name = body.name;
    try {
      // A token from Add Device works only with the key the owner approved (FR-132).
      if (bind && bind.publicKey !== body.publicKey) {
        throw new NovaError('policy_denied', 'this enrollment token belongs to another node key', {
          details: { reason: 'key_mismatch' },
          action: 'Register with the key you added the node with',
        });
      }
      this.#checkDocument(body.capability, body.signature, body.publicKey);
      await this.#secrets.put(ref, body.jobToken);
      await this.#db.transaction(async () => {
        const taken = await this.#db.orm
          .select()
          .from(device)
          .where(eq(device.certFingerprint, fingerprint))
          .limit(1);
        const pending = taken[0];
        if (bind) {
          // The record approval created waits for exactly this key; a revoked one stays dead.
          if (
            !pending ||
            pending.id !== bind.deviceId ||
            pending.accountId !== request.accountId ||
            pending.kind !== 'compute' ||
            pending.status !== 'pending'
          ) {
            throw new NovaError('conflict', 'the node this token was made for is not waiting', {
              details: { reason: 'device_not_pending' },
              action: 'Add the node again',
            });
          }
          name = pending.name;
        } else if (pending) {
          throw new NovaError('conflict', 'this node key is already registered', {
            details: { reason: 'key_in_use' },
            action: 'Enroll with a new key',
          });
        }
        const tokenId = uuidv7();
        await this.#db.orm.insert(authToken).values({
          id: tokenId,
          kind: 'device',
          tokenHash: nodeSecretHash(credential),
          accountId: request.accountId,
          label: body.name,
          scopes: JSON.stringify(['node']),
          createdAt: nowIso,
        });
        if (bind) {
          // The name and scopes the owner approved stay.
          await this.#db.orm
            .update(device)
            .set({
              platform: platformOf(body.capability),
              status: 'active',
              credentialTokenId: tokenId,
              lastSeenAt: nowIso,
              updatedAt: nowIso,
            })
            .where(eq(device.id, nodeId));
        } else {
          await this.#db.orm.insert(device).values({
            id: nodeId,
            accountId: request.accountId,
            name: body.name,
            kind: 'compute',
            platform: platformOf(body.capability),
            certFingerprint: fingerprint,
            publicKey: body.publicKey,
            roles: JSON.stringify(['compute']),
            status: 'active',
            credentialTokenId: tokenId,
            lastSeenAt: nowIso,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        }
        await this.#db.orm.insert(deviceCapability).values({
          deviceId: nodeId,
          document: JSON.stringify(body.capability),
          updatedAt: nowIso,
        });
        await this.#db.orm.insert(transportEndpoint).values({
          id: uuidv7(),
          deviceId: nodeId,
          net: 'lan',
          url: body.endpoint.replace(/\/+$/, ''),
          healthy: true,
          lastCheckedAt: nowIso,
          createdAt: nowIso,
        });
      });
    } catch (err) {
      await this.#secrets.delete(ref).catch(() => false);
      await this.#setRequestStatus(request.id, 'denied').catch((e: unknown) =>
        this.#log.warn('could not mark the enrollment request denied', { err: e }),
      );
      throw err;
    }
    await this.#events.emit({
      name: 'node.registered',
      accountId: request.accountId,
      payload: { nodeId, name, models: modelsOf(body.capability) },
    });
    this.#log.info('compute node registered', { nodeId, name });
    return { nodeId, credential, heartbeatIntervalMs: this.heartbeatIntervalMs, protocolVersion };
  }

  async #consumeEnrollToken(token: string) {
    return this.#db.transaction(async () => {
      const rows = await this.#db.orm
        .select()
        .from(addDeviceRequest)
        .where(eq(addDeviceRequest.codeHash, nodeSecretHash(token)))
        .limit(1);
      const row = rows[0];
      const nowIso = this.#now().toISOString();
      if (!row || row.status !== 'pending' || row.role !== 'compute' || row.expiresAt <= nowIso) {
        throw new NovaError('auth_missing', 'the enrollment token is invalid, used or expired', {
          action: 'Create a new enrollment token on the Hub',
        });
      }
      await this.#db.orm
        .update(addDeviceRequest)
        .set({ status: 'approved' })
        .where(eq(addDeviceRequest.id, row.id));
      return row;
    });
  }

  async #setRequestStatus(id: string, status: 'approved' | 'denied'): Promise<void> {
    await this.#db.transaction(() =>
      this.#db.orm.update(addDeviceRequest).set({ status }).where(eq(addDeviceRequest.id, id)),
    );
  }

  /** Schema, role and signature checks shared by register and model sync. */
  #checkDocument(doc: Record<string, unknown>, signature: string, publicKey: string): void {
    const v = this.#validate(doc);
    if (!v.ok) {
      throw new NovaError('validation', 'the capability document is not valid', {
        details: { reason: 'invalid_capability', errors: v.errors.slice(0, 20) },
      });
    }
    const roles = Array.isArray(doc.roles) ? doc.roles : [];
    if (!roles.includes('compute')) {
      throw new NovaError(
        'validation',
        'the capability document does not declare the compute role',
        {
          details: { reason: 'invalid_capability' },
        },
      );
    }
    if (!verifyDocument(doc, signature, publicKey)) {
      throw new NovaError('policy_denied', 'the capability document signature does not verify', {
        details: { reason: 'bad_signature' },
      });
    }
  }

  // ---- node credential routes -------------------------------------------------------------

  /** The node a credential belongs to, or null (unknown, revoked or deleted). */
  authenticate(credential: string): Promise<DeviceRow | null> {
    return computeNodeForCredential(this.#db, credential);
  }

  async #requireNode(credential: string): Promise<DeviceRow> {
    const node = await this.authenticate(credential);
    if (!node) {
      throw new NovaError('auth_missing', 'this node credential is not valid', {
        action: 'Enroll the node again',
      });
    }
    return node;
  }

  /**
   * Record a heartbeat; an unreachable node becomes active again. The answer carries the owner's
   * policy for the node (quiet hours, routing eligibility), which the node honors (M7.5).
   */
  async heartbeat(credential: string, input: unknown): Promise<{ ok: true; policy: NodePolicy }> {
    // Authenticate before validating, so an unauthenticated caller learns nothing.
    const node = await this.#requireNode(credential);
    const body = heartbeatSchema.parse(input);
    const nowIso = this.#now().toISOString();
    const from = await this.#db.transaction(async () => {
      const rows = await this.#db.orm
        .select({ status: device.status })
        .from(device)
        .where(eq(device.id, node.id))
        .limit(1);
      const status = rows[0]?.status;
      if (!status || status === 'revoked') return null;
      await this.#db.orm
        .update(device)
        .set({ status: 'active', lastSeenAt: nowIso, updatedAt: nowIso })
        .where(eq(device.id, node.id));
      await this.#db.orm
        .update(transportEndpoint)
        .set({ healthy: true, lastCheckedAt: nowIso })
        .where(eq(transportEndpoint.deviceId, node.id));
      if (node.credentialTokenId) {
        await this.#db.orm
          .update(authToken)
          .set({ lastUsedAt: nowIso })
          .where(eq(authToken.id, node.credentialTokenId));
      }
      return status;
    });
    if (from === null) throw new NovaError('auth_missing', 'this node credential is not valid');
    const vram = body.vram
      ? body.vram.map((g) => ({
          index: g.index,
          vendor: g.vendor ?? null,
          name: g.name ?? null,
          totalBytes: g.totalBytes ?? null,
          usedBytes: g.usedBytes ?? null,
        }))
      : null;
    this.#live.set(node.id, {
      load: body.load,
      models: body.models ?? null,
      vram,
      quiet: body.quiet ?? null,
    });
    if (from !== 'active') await this.#statusChanged(node, from, 'active');
    return { ok: true, policy: this.#policy(node.id) };
  }

  // ---- the owner's policy for a node (FR-126, FR-150; M7.5) ----------------------------------

  #policy(nodeId: string): NodePolicy {
    const row = this.#db.raw
      .prepare(
        'SELECT quiet_hours, time_zone, routing_eligible, revision FROM node_policy WHERE device_id = ?',
      )
      .get(nodeId) as NodePolicyRow | undefined;
    if (!row) return { ...DEFAULT_NODE_POLICY, quietHours: [] };
    let quiet: unknown;
    try {
      quiet = JSON.parse(row.quiet_hours);
    } catch {
      quiet = [];
    }
    return {
      quietHours: Array.isArray(quiet)
        ? quiet.filter((q): q is string => typeof q === 'string')
        : [],
      timeZone: row.time_zone,
      routingEligible: row.routing_eligible === 1,
      revision: row.revision,
    };
  }

  async #node(accountId: string, nodeId: string): Promise<DeviceRow> {
    const rows = await this.#db.orm
      .select()
      .from(device)
      .where(
        and(eq(device.id, nodeId), eq(device.accountId, accountId), eq(device.kind, 'compute')),
      )
      .limit(1);
    const node = rows[0];
    if (!node) throw new NovaError('not_found', 'node not found');
    return node;
  }

  /** The node's policy (defaults until the owner sets one). */
  async policy(accountId: string, nodeId: string): Promise<NodePolicy> {
    await this.#node(accountId, nodeId);
    return this.#policy(nodeId);
  }

  /** Merge a change into the node's policy; the node takes it with its next heartbeat. */
  async setPolicy(accountId: string, nodeId: string, input: unknown): Promise<NodePolicy> {
    const node = await this.#node(accountId, nodeId);
    if (node.status === 'revoked')
      throw new NovaError('conflict', 'the node was revoked', { details: { reason: 'revoked' } });
    const patch = nodePolicySchema.parse(input);
    const before = this.#policy(nodeId);
    const next: NodePolicy = {
      quietHours: patch.quietHours ?? before.quietHours,
      timeZone: patch.timeZone === undefined ? before.timeZone : patch.timeZone,
      routingEligible: patch.routingEligible ?? before.routingEligible,
      revision: before.revision + 1,
    };
    const nowIso = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO node_policy (device_id, quiet_hours, time_zone, routing_eligible, revision, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (device_id) DO UPDATE SET quiet_hours = excluded.quiet_hours,
             time_zone = excluded.time_zone, routing_eligible = excluded.routing_eligible,
             revision = excluded.revision, updated_at = excluded.updated_at`,
        )
        .run(
          nodeId,
          JSON.stringify(next.quietHours),
          next.timeZone,
          next.routingEligible ? 1 : 0,
          next.revision,
          nowIso,
        );
    });
    await this.#events.emit({
      name: 'node.policy.changed',
      accountId,
      payload: { nodeId, revision: next.revision, routingEligible: next.routingEligible },
    });
    await this.#audit
      ?.append({
        accountId,
        actor: 'user',
        kind: 'device',
        action: 'node.policy.update',
        resource: nodeId,
        detail: { before, after: next },
      })
      .catch((err: unknown) => this.#log.warn('node policy audit failed', { err }));
    return next;
  }

  /**
   * Whether the node is quiet now: in the quiet hours of the owner's policy (in its zone, else
   * the zone the node declares, else UTC), or the node said so in its last heartbeat.
   */
  #quietNow(nodeId: string, doc: Record<string, unknown>, policy: NodePolicy): boolean {
    if (this.#live.get(nodeId)?.quiet === true) return true;
    const locale = isRecord(doc.locale) ? doc.locale : {};
    const zone =
      policy.timeZone ?? (typeof locale.timezone === 'string' ? locale.timezone : undefined);
    return inDeviceQuietHours(policy.quietHours, this.#now(), zone);
  }

  /** `GET /api/v1/devices/:id/node`: policy, quiet, VRAM and load. */
  async detail(accountId: string, nodeId: string): Promise<NodeDetailView> {
    const node = await this.#node(accountId, nodeId);
    const policy = this.#policy(nodeId);
    const live = this.#live.get(nodeId);
    const doc = (await this.#document(nodeId)) ?? {};
    return {
      id: node.id,
      name: node.name,
      status: node.status,
      policy,
      quietNow: node.status !== 'revoked' && this.#quietNow(nodeId, doc, policy),
      reportedQuiet: live?.quiet ?? null,
      vram: live?.vram ?? null,
      load: node.status === 'active' ? this.load(nodeId) : null,
      lastSeenAt: node.lastSeenAt,
    };
  }

  // ---- the node's managed services (`/node/v1/services/*`, M7.5) -----------------------------

  async #callNode(
    accountId: string,
    nodeId: string,
    method: 'GET' | 'POST',
    path: string,
  ): Promise<Record<string, unknown>> {
    const [record] = await this.#records(accountId, nodeId);
    if (!record) throw new NovaError('not_found', 'node not found');
    if (record.status === 'revoked') throw new NovaError('not_found', 'node not found');
    if (record.status !== 'active' || !record.endpoint)
      throw new NovaError('node_unavailable', 'the node is not reachable', {
        details: { reason: 'unreachable', status: record.status },
      });
    const token = await this.jobToken(nodeId);
    if (!token) throw new NovaError('auth_missing', 'the Hub has no job token for this node');
    let res: Response;
    try {
      res = await this.#fetch(`${record.endpoint.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new NovaError('node_unavailable', 'the node is not reachable', {
        details: { reason: 'unreachable' },
        cause: err,
      });
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      body = null;
    }
    if (res.ok) return isRecord(body) ? body : {};
    const err = isRecord(body) && isRecord(body.error) ? body.error : {};
    const message =
      typeof err.message === 'string' ? err.message.slice(0, 300) : `HTTP ${res.status}`;
    const details = isRecord(err.details) ? err.details : undefined;
    if (res.status === 404)
      throw new NovaError(
        path.endsWith('/services') ? 'capability_missing' : 'not_found',
        path.endsWith('/services') ? 'this node cannot list its services yet' : message,
        path.endsWith('/services') ? { details: { reason: 'update_required' } } : {},
      );
    if (res.status === 401)
      throw new NovaError('auth_missing', 'the node refused the Hub’s job token', {
        details: { reason: 'job_token_rejected' },
      });
    const code =
      res.status === 409
        ? 'conflict'
        : res.status === 400
          ? 'validation'
          : res.status === 503
            ? 'node_unavailable'
            : 'server_error';
    throw new NovaError(code, message, details ? { details } : {});
  }

  /** The node's services: `jobs` and, when it manages one, the model `backend`. */
  async services(accountId: string, nodeId: string): Promise<NodeServiceView[]> {
    const out = await this.#callNode(accountId, nodeId, 'GET', '/node/v1/services');
    const list = Array.isArray(out.services) ? out.services : [];
    return list.filter(isRecord).flatMap((x): NodeServiceView[] => {
      const name = (NODE_SERVICE_NAMES as readonly unknown[]).includes(x.name)
        ? (x.name as NodeServiceView['name'])
        : null;
      if (!name) return [];
      return [
        {
          name,
          kind: x.kind === 'systemd' ? 'systemd' : 'builtin',
          state: x.state === 'running' || x.state === 'stopped' ? x.state : 'unknown',
          unit: typeof x.unit === 'string' ? x.unit.slice(0, 200) : null,
        },
      ];
    });
  }

  /** Start, stop, restart or read one of the node's services; changes are audited. */
  async serviceAction(
    accountId: string,
    nodeId: string,
    name: string,
    action: NodeServiceAction,
  ): Promise<NodeServiceView> {
    const out = await this.#callNode(
      accountId,
      nodeId,
      'POST',
      `/node/v1/services/${encodeURIComponent(name)}/${action}`,
    );
    const svc = isRecord(out.service) ? out.service : {};
    const view: NodeServiceView = {
      name: (NODE_SERVICE_NAMES as readonly unknown[]).includes(svc.name)
        ? (svc.name as NodeServiceView['name'])
        : (name as NodeServiceView['name']),
      kind: svc.kind === 'systemd' ? 'systemd' : 'builtin',
      state: svc.state === 'running' || svc.state === 'stopped' ? svc.state : 'unknown',
      unit: typeof svc.unit === 'string' ? svc.unit.slice(0, 200) : null,
    };
    if (action !== 'status') {
      await this.#events.emit({
        name: 'node.service.changed',
        accountId,
        payload: { nodeId, service: view.name, action, state: view.state },
      });
      await this.#audit
        ?.append({
          accountId,
          actor: 'user',
          kind: 'device',
          action: `node.service.${action}`,
          resource: nodeId,
          detail: { service: view.name, state: view.state },
        })
        .catch((err: unknown) => this.#log.warn('node service audit failed', { err }));
    }
    return view;
  }

  /** Replace the capability document; it must verify against the key pinned at registration. */
  async syncModels(credential: string, input: unknown): Promise<void> {
    const node = await this.#requireNode(credential);
    const body = syncModelsSchema.parse(input);
    this.#checkDocument(body.capability, body.signature, node.publicKey);
    const current = await this.#document(node.id);
    if (current && current.deviceId !== body.capability.deviceId) {
      throw new NovaError('validation', 'the capability document names a different device', {
        details: { reason: 'device_mismatch' },
      });
    }
    const before = current ? modelsOf(current) : [];
    const after = modelsOf(body.capability);
    const nowIso = this.#now().toISOString();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(deviceCapability)
        .set({ document: JSON.stringify(body.capability), updatedAt: nowIso })
        .where(eq(deviceCapability.deviceId, node.id));
      await this.#db.orm
        .update(device)
        .set({ platform: platformOf(body.capability), lastSeenAt: nowIso, updatedAt: nowIso })
        .where(eq(device.id, node.id));
    });
    // A re-signed document supersedes the heartbeat's unsigned filter.
    const live = this.#live.get(node.id);
    if (live) live.models = null;
    if (before.join('\n') !== after.join('\n')) {
      await this.#events.emit({
        name: 'node.models.changed',
        accountId: node.accountId,
        payload: { nodeId: node.id, models: after },
      });
    }
  }

  // ---- owner routes -----------------------------------------------------------------------

  /** Every compute node of the account, revoked ones included (oldest first). */
  async list(accountId: string): Promise<NodeView[]> {
    return (await this.#records(accountId, null)).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      endpoint: r.endpoint,
      models: r.models,
      capabilities: r.capabilities,
      load: r.status === 'active' ? this.load(r.id) : null,
      lastSeenAt: r.lastSeenAt,
      createdAt: r.createdAt,
    }));
  }

  /**
   * Revoke a node: its credential row and job token are deleted, so its calls get 401 at once and
   * the Hub can no longer call it; its models leave routing. Idempotent.
   */
  async revoke(accountId: string, nodeId: string): Promise<void> {
    const rows = await this.#db.orm
      .select()
      .from(device)
      .where(
        and(eq(device.id, nodeId), eq(device.accountId, accountId), eq(device.kind, 'compute')),
      )
      .limit(1);
    const node = rows[0];
    if (!node) throw new NovaError('not_found', 'node not found');
    if (node.status === 'revoked') return;
    const nowIso = this.#now().toISOString();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(device)
        .set({ status: 'revoked', credentialTokenId: null, updatedAt: nowIso })
        .where(eq(device.id, nodeId));
      if (node.credentialTokenId)
        await this.#db.orm.delete(authToken).where(eq(authToken.id, node.credentialTokenId));
      await this.#db.orm
        .update(transportEndpoint)
        .set({ healthy: false, lastCheckedAt: nowIso })
        .where(eq(transportEndpoint.deviceId, nodeId));
    });
    await this.#secrets.delete(jobTokenRef(nodeId));
    this.#live.delete(nodeId);
    await this.#statusChanged(node, node.status, 'revoked');
    for (const fn of this.#revokeListeners) {
      try {
        fn(nodeId);
      } catch (err) {
        this.#log.warn('revoke listener failed', { err });
      }
    }
  }

  /** Called with a node id once it is revoked (in-flight jobs on it are stopped). */
  onRevoked(fn: (nodeId: string) => void): () => void {
    this.#revokeListeners.add(fn);
    return () => this.#revokeListeners.delete(fn);
  }

  // ---- liveness ---------------------------------------------------------------------------

  /**
   * Mark nodes that missed `missedBeats` heartbeats unreachable and expire unused enrollment
   * tokens. Returns the ids that became unreachable.
   */
  async sweep(): Promise<string[]> {
    const now = this.#now();
    const cutoff = new Date(
      now.getTime() - this.#missedBeats * this.heartbeatIntervalMs,
    ).toISOString();
    const stale = await this.#db.transaction(async () => {
      const rows = await this.#db.orm
        .select()
        .from(device)
        .where(
          and(
            eq(device.kind, 'compute'),
            eq(device.status, 'active'),
            or(isNull(device.lastSeenAt), lt(device.lastSeenAt, cutoff)),
          ),
        );
      if (rows.length) {
        await this.#db.orm
          .update(device)
          .set({ status: 'unreachable', updatedAt: now.toISOString() })
          .where(
            inArray(
              device.id,
              rows.map((r) => r.id),
            ),
          );
        await this.#db.orm
          .update(transportEndpoint)
          .set({ healthy: false, lastCheckedAt: now.toISOString() })
          .where(
            inArray(
              transportEndpoint.deviceId,
              rows.map((r) => r.id),
            ),
          );
      }
      await this.#db.orm
        .update(addDeviceRequest)
        .set({ status: 'expired' })
        .where(
          and(
            eq(addDeviceRequest.status, 'pending'),
            lt(addDeviceRequest.expiresAt, now.toISOString()),
          ),
        );
      return rows;
    });
    for (const node of stale) {
      this.#live.delete(node.id);
      await this.#statusChanged(node, 'active', 'unreachable');
    }
    return stale.map((n) => n.id);
  }

  /** Sweep once per heartbeat interval until `stop()`. */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.sweep().catch((err: unknown) => this.#log.warn('node sweep failed', { err }));
    }, this.heartbeatIntervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // ---- routing accessors ------------------------------------------------------------------

  /**
   * Active nodes of an account (or one node), with the models they serve now. A node the owner
   * took out of routing, or one in its quiet hours, is left out (FR-150, M7.5).
   */
  async activeNodes(accountId: string, nodeId?: string): Promise<NodeRecord[]> {
    const out: NodeRecord[] = [];
    for (const r of await this.#records(accountId, nodeId ?? null)) {
      if (r.status !== 'active') continue;
      const policy = this.#policy(r.id);
      if (!policy.routingEligible) continue;
      if (this.#quietNow(r.id, (await this.#document(r.id)) ?? {}, policy)) continue;
      out.push(r);
    }
    return out;
  }

  /** The node's last reported load; null when unknown (no heartbeat since the Hub started). */
  load(nodeId: string): NodeLoad | null {
    const l = this.#live.get(nodeId)?.load;
    return l ? { ...l } : null;
  }

  /** The job token the node expects on its job API, from the vault. */
  jobToken(nodeId: string): Promise<string | null> {
    return this.#secrets.get(jobTokenRef(nodeId));
  }

  async #records(accountId: string, nodeId: string | null): Promise<NodeRecord[]> {
    const where = [eq(device.accountId, accountId), eq(device.kind, 'compute')];
    if (nodeId) where.push(eq(device.id, nodeId));
    const rows = await this.#db.orm
      .select({
        id: device.id,
        accountId: device.accountId,
        name: device.name,
        status: device.status,
        lastSeenAt: device.lastSeenAt,
        createdAt: device.createdAt,
        document: deviceCapability.document,
        endpoint: transportEndpoint.url,
      })
      .from(device)
      .leftJoin(deviceCapability, eq(deviceCapability.deviceId, device.id))
      .leftJoin(
        transportEndpoint,
        and(eq(transportEndpoint.deviceId, device.id), eq(transportEndpoint.net, 'lan')),
      )
      .where(and(...where))
      .orderBy(asc(device.createdAt), asc(device.id));
    return rows.map((r) => {
      const doc = parseDocument(r.document);
      const signed = modelsOf(doc);
      const reported = this.#live.get(r.id)?.models;
      // The heartbeat list is unsigned: it may hide a model the backend dropped, never add one.
      const models = reported ? signed.filter((m) => reported.includes(m)) : signed;
      return {
        id: r.id,
        accountId: r.accountId,
        name: r.name,
        status: r.status,
        endpoint: r.endpoint ?? '',
        models: r.status === 'revoked' ? [] : models,
        capabilities: capabilitiesOf(doc),
        lastSeenAt: r.lastSeenAt,
        createdAt: r.createdAt,
      };
    });
  }

  async #document(nodeId: string): Promise<Record<string, unknown> | null> {
    const rows = await this.#db.orm
      .select({ document: deviceCapability.document })
      .from(deviceCapability)
      .where(eq(deviceCapability.deviceId, nodeId))
      .limit(1);
    return rows[0] ? parseDocument(rows[0].document) : null;
  }

  async #statusChanged(node: DeviceRow, from: NodeStatus, status: NodeStatus): Promise<void> {
    await this.#events.emit({
      name: 'node.status.changed',
      accountId: node.accountId,
      payload: { nodeId: node.id, from, status },
    });
  }
}

// ---- capability document helpers ----------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseDocument(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const doc: unknown = JSON.parse(text);
    return isRecord(doc) ? doc : {};
  } catch {
    return {};
  }
}

/** Model ids in `services.modelsPresent`, de-duplicated and sorted. */
export function modelsOf(doc: Record<string, unknown>): string[] {
  const services = isRecord(doc.services) ? doc.services : {};
  const present = Array.isArray(services.modelsPresent) ? services.modelsPresent : [];
  const ids = present.flatMap((m) =>
    isRecord(m) && typeof m.id === 'string' && m.id ? [m.id] : [],
  );
  return [...new Set(ids)].sort();
}

function capabilitiesOf(doc: Record<string, unknown>): NodeView['capabilities'] {
  const hardware = isRecord(doc.hardware) ? doc.hardware : {};
  const gpus = Array.isArray(hardware.gpus) ? hardware.gpus.filter(isRecord) : [];
  const vram = gpus.flatMap((g) => (typeof g.vramBytes === 'number' ? [g.vramBytes] : []));
  const policy = isRecord(doc.computePolicy) ? doc.computePolicy : {};
  const max = policy.maxConcurrentJobs;
  return {
    gpus: gpus.length,
    vramBytes: vram.length ? vram.reduce((a, b) => a + b, 0) : null,
    maxConcurrentJobs: typeof max === 'number' && Number.isInteger(max) && max >= 0 ? max : 1,
  };
}

function platformOf(doc: Record<string, unknown>): string | null {
  const os = isRecord(doc.os) ? doc.os : {};
  return typeof os.family === 'string' ? os.family.slice(0, 50) : null;
}
