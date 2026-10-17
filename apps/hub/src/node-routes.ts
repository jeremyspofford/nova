// Compute node routes (FR-126; contracts/hub-api.md §1 "Auth & devices" and §2; ADR-089).
// Owner routes under /api/v1/devices need a session; Add Device itself (`add/start` and the rest)
// is the add-device area's (M6.5). The /node/v1 routes are called by nodes:
// register authenticates with the one-use enrollment token in its body, heartbeat and model sync
// with the node credential, which they check themselves. A node credential never authenticates
// a user route: it is hashed in its own domain, so the session lookup cannot find it.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NovaError, idSchema } from '@nova/shared';
import type { NodeService } from '@nova/core';

/**
 * Devices running `novad` (M6, the devices area): listing them by role and revoking one (its id is
 * not a compute node's). `createEnrollToken` served the M6 `add/start`; Add Device (M6.5) replaced
 * it, so it is no longer called.
 */
export interface NovadRouteHooks {
  createEnrollToken?(accountId: string, role: string, hubUrl: string): Promise<unknown>;
  list(accountId: string, role: string): Promise<unknown[]>;
  revoke(accountId: string, deviceId: string): Promise<void>;
}

export interface NodeRouteDeps {
  nodes: NodeService;
  /** The authenticated account id; throws `token_required` without a session. */
  accountOf: (req: FastifyRequest) => Promise<string>;
  novad?: NovadRouteHooks;
  /**
   * Devices that are neither compute nodes nor novad (browsers and apps added with a code, and
   * approved devices that never registered): the add-device area revokes them.
   */
  added?: { revoke(accountId: string, deviceId: string): Promise<void> };
}

const DEVICE_ROLES = ['client', 'compute', 'wake-helper'] as const;

const listQuerySchema = z.object({ role: z.enum(DEVICE_ROLES).optional() });
const params = z.object({ id: idSchema });

function nodeCredential(req: FastifyRequest): string {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new NovaError('token_required', 'a node credential is required');
  return token;
}

export function registerNodeRoutes(app: FastifyInstance, deps: NodeRouteDeps): void {
  const { nodes, accountOf, novad, added } = deps;

  // ---- owner (session) ------------------------------------------------------------------

  // The scripted path for a compute node (ADR-089): a one-use `nve_` token for `nova-compute
  // enroll --token`. Creating it with a session is the owner's approval; Add Device (`add/start`)
  // is the path with a code and a confirmation.
  app.post('/api/v1/devices/compute/enroll', async (req, reply) => {
    const accountId = await accountOf(req);
    void reply.status(201);
    return nodes.createEnrollToken(accountId);
  });

  app.get('/api/v1/devices', async (req) => {
    const accountId = await accountOf(req);
    const q = listQuerySchema.parse(req.query);
    // Compute nodes are listed by NodeService; other roles are novad devices (M6).
    if (q.role && q.role !== 'compute')
      return { items: novad ? await novad.list(accountId, q.role) : [] };
    return { items: await nodes.list(accountId) };
  });

  app.post('/api/v1/devices/:id/revoke', async (req) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    // A compute node, else a novad device (the devices area), else a browser or app added with a
    // code or a device that never registered (the add-device area).
    const revokers = [
      (a: string, d: string) => nodes.revoke(a, d),
      ...(novad ? [(a: string, d: string) => novad.revoke(a, d)] : []),
      ...(added ? [(a: string, d: string) => added.revoke(a, d)] : []),
    ];
    let missing = new NovaError('not_found', 'device not found');
    for (const revoke of revokers) {
      try {
        await revoke(accountId, id);
        return { ok: true };
      } catch (err) {
        if (!(err instanceof NovaError) || err.code !== 'not_found') throw err;
        missing = err;
      }
    }
    throw missing;
  });

  // ---- nodes (no session) ---------------------------------------------------------------

  app.post('/node/v1/register', async (req, reply) => {
    const result = await nodes.register(req.body);
    void reply.status(201);
    return result;
  });

  app.post('/node/v1/heartbeat', async (req) => {
    await nodes.heartbeat(nodeCredential(req), req.body);
    return { ok: true };
  });

  app.post('/node/v1/models/sync', async (req) => {
    await nodes.syncModels(nodeCredential(req), req.body);
    return { ok: true };
  });
}
