// Memory (contracts/hub-api.md "Memory & import"; FR-032): list, add, correct, pin, dismiss,
// delete and import items. Every route requires a session and validates its input with the
// shared zod schemas.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createMemorySchema, idSchema, importMemorySchema, updateMemorySchema } from '@nova/shared';
import type { MemoryService } from '@nova/core';

export interface MemoryRouteDeps {
  memory: MemoryService;
  /** The authenticated account id; throws `token_required` without a principal. */
  accountOf: (req: FastifyRequest) => Promise<string>;
}

/** An import may carry up to 1 MB of text (importMemorySchema), plus JSON overhead. */
export const MEMORY_IMPORT_BODY_LIMIT = 2 * 1024 * 1024;

const params = z.object({ id: idSchema });

const SCOPE_KINDS = ['global', 'project', 'thread', 'agent'] as const;

const listQuerySchema = z.object({
  scopeKind: z.enum(SCOPE_KINDS).optional(),
  /** The contract's `scope=` filter; same as scopeKind. */
  scope: z.enum(SCOPE_KINDS).optional(),
  scopeRef: idSchema.optional(),
  q: z.string().max(200).optional(),
  status: z.enum(['active', 'dismissed']).optional(),
  category: z.string().max(60).optional(),
});

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRouteDeps): void {
  const { memory, accountOf } = deps;

  app.get('/api/v1/memory/items', async (req) => {
    const accountId = await accountOf(req);
    const q = listQuerySchema.parse(req.query);
    return {
      items: await memory.list(accountId, {
        scopeKind: q.scopeKind ?? q.scope,
        scopeRef: q.scopeRef,
        q: q.q,
        status: q.status,
        category: q.category,
      }),
    };
  });

  app.post('/api/v1/memory/items', async (req, reply) => {
    const accountId = await accountOf(req);
    const view = await memory.create(accountId, createMemorySchema.parse(req.body));
    void reply.status(201);
    return view;
  });

  app.patch('/api/v1/memory/items/:id', async (req) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    return memory.update(accountId, id, updateMemorySchema.parse(req.body));
  });

  app.delete('/api/v1/memory/items/:id', async (req) => {
    const accountId = await accountOf(req);
    await memory.remove(accountId, params.parse(req.params).id);
    return { ok: true };
  });

  app.post('/api/v1/memory/import', { bodyLimit: MEMORY_IMPORT_BODY_LIMIT }, async (req) => {
    const accountId = await accountOf(req);
    return memory.import(accountId, importMemorySchema.parse(req.body));
  });
}
