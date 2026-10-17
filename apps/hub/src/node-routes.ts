// Compute node routes (FR-126; contracts/hub-api.md §1 "Auth & devices" and §2; ADR-089).
// Owner routes under /api/v1/devices need a session. The /node/v1 routes are called by nodes:
// register authenticates with the one-use enrollment token in its body, heartbeat and model sync
// with the node credential, which they check themselves. A node credential never authenticates
// a user route: it is hashed in its own domain, so the session lookup cannot find it.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NovaError, idSchema } from '@nova/shared';
import type { NodeService } from '@nova/core';

export interface NodeRouteDeps {
  nodes: NodeService;
  /** The authenticated account id; throws `token_required` without a session. */
  accountOf: (req: FastifyRequest) => Promise<string>;
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
  const { nodes, accountOf } = deps;

  // ---- owner (session) ------------------------------------------------------------------

  app.post('/api/v1/devices/add/start', async (req, reply) => {
    const accountId = await accountOf(req);
    const body = addStartSchema.parse(req.body ?? {});
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
    // M2 has compute nodes only; other roles list nothing yet.
    if (q.role && q.role !== 'compute') return { items: [] };
    return { items: await nodes.list(accountId) };
  });

  app.post('/api/v1/devices/:id/revoke', async (req) => {
    const accountId = await accountOf(req);
    await nodes.revoke(accountId, params.parse(req.params).id);
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
