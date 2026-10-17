// Compute node routes (FR-126; contracts/hub-api.md §1 "Auth & devices" and §2; ADR-089).
// Owner routes under /api/v1/devices need a session. The /node/v1 routes are called by nodes:
// register authenticates with the one-use enrollment token in its body, heartbeat and model sync
// with the node credential, which they check themselves. A node credential never authenticates
// a user route: it is hashed in its own domain, so the session lookup cannot find it.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NovaError, idSchema } from '@nova/shared';
import type { NodeService } from '@nova/core';

/**
 * Devices running `novad` (M6, the devices area): Add Device for the other roles, listing them by
 * role, and revoking one (its id is not a compute node's).
 */
export interface NovadRouteHooks {
  createEnrollToken(accountId: string, role: string, hubUrl: string): Promise<unknown>;
  list(accountId: string, role: string): Promise<unknown[]>;
  revoke(accountId: string, deviceId: string): Promise<void>;
}

export interface NodeRouteDeps {
  nodes: NodeService;
  /** The authenticated account id; throws `token_required` without a session. */
  accountOf: (req: FastifyRequest) => Promise<string>;
  novad?: NovadRouteHooks;
}

const DEVICE_ROLES = ['client', 'compute', 'wake-helper'] as const;

const addStartSchema = z.object({ role: z.enum(DEVICE_ROLES) });
const listQuerySchema = z.object({ role: z.enum(DEVICE_ROLES).optional() });
const params = z.object({ id: idSchema });

function nodeCredential(req: FastifyRequest): string {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new NovaError('token_required', 'a node credential is required');
  return token;
}

export function registerNodeRoutes(app: FastifyInstance, deps: NodeRouteDeps): void {
  const { nodes, accountOf, novad } = deps;

  // ---- owner (session) ------------------------------------------------------------------

  app.post('/api/v1/devices/add/start', async (req, reply) => {
    const accountId = await accountOf(req);
    const body = addStartSchema.parse(req.body ?? {});
    if (body.role !== 'compute' && novad) {
      void reply.status(201);
      return novad.createEnrollToken(accountId, body.role, `${req.protocol}://${req.host}`);
    }
    if (body.role !== 'compute') {
      throw new NovaError('validation', 'only compute nodes can be added in this version', {
        details: { reason: 'role_unsupported', role: body.role },
      });
    }
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
    try {
      await nodes.revoke(accountId, id);
    } catch (err) {
      // Not a compute node: a novad device, when the devices area is wired.
      if (!novad || !(err instanceof NovaError) || err.code !== 'not_found') throw err;
      await novad.revoke(accountId, id);
    }
    return { ok: true };
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
