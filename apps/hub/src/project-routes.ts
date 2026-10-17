// Projects and their sources (contracts/hub-api.md §1; FR-034, FR-040). Every route requires a
// session and validates its input with the shared zod schemas. Sources are indexed in the
// background; `source.status.changed` events report progress.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { addSourceSchema, createProjectSchema, idSchema, updateProjectSchema } from '@nova/shared';
import type { ProjectService, SourceService } from '@nova/core';

export interface ProjectRouteDeps {
  projects: ProjectService;
  sources: SourceService;
  /** The authenticated account id; throws `token_required` without a principal. */
  accountOf: (req: FastifyRequest) => Promise<string>;
}

/** Source uploads carry base64 content (20 MB raw is about 27 MB encoded). */
export const SOURCE_BODY_LIMIT = 30 * 1024 * 1024;

const params = z.object({ id: idSchema });

export function registerProjectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): void {
  const { projects, sources, accountOf } = deps;

  app.get('/api/v1/projects', async (req) => ({
    items: await projects.list(await accountOf(req)),
  }));

  app.post('/api/v1/projects', async (req, reply) => {
    const accountId = await accountOf(req);
    const view = await projects.create(accountId, createProjectSchema.parse(req.body));
    void reply.status(201);
    return view;
  });

  app.get('/api/v1/projects/:id', async (req) => {
    const accountId = await accountOf(req);
    return projects.get(accountId, params.parse(req.params).id);
  });

  app.patch('/api/v1/projects/:id', async (req) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    return projects.update(accountId, id, updateProjectSchema.parse(req.body));
  });

  app.delete('/api/v1/projects/:id', async (req) => {
    const accountId = await accountOf(req);
    await projects.remove(accountId, params.parse(req.params).id);
    return { ok: true };
  });

  app.get('/api/v1/projects/:id/sources', async (req) => {
    const accountId = await accountOf(req);
    return { items: await sources.list(accountId, params.parse(req.params).id) };
  });

  app.post('/api/v1/projects/:id/sources', { bodyLimit: SOURCE_BODY_LIMIT }, async (req, reply) => {
    const accountId = await accountOf(req);
    const { id } = params.parse(req.params);
    const view = await sources.add(accountId, id, addSourceSchema.parse(req.body));
    void reply.status(201);
    return view;
  });

  app.post('/api/v1/sources/:id/reindex', async (req) => {
    const accountId = await accountOf(req);
    return sources.reindex(accountId, params.parse(req.params).id);
  });

  app.delete('/api/v1/sources/:id', async (req) => {
    const accountId = await accountOf(req);
    await sources.remove(accountId, params.parse(req.params).id);
    return { ok: true };
  });
}
