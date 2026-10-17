// Spaces area (M6): Spaces and Pages (FR-036), Sites (FR-037) and visualizations (FR-076). The
// routes over SpaceService and SiteService, and the tool source with `page.read`, `page.edit`,
// `page.comment` (once the account has a space) and `visualize.create`, which joins the chat
// loop's tool sources so every call passes the policy gate. A site's preview is served sandboxed
// (an opaque origin, never same-origin); publishing needs the user's explicit `confirm`.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  acceptProposalSchema,
  buildSiteSchema,
  createCommentSchema,
  createPageSchema,
  createSiteSchema,
  createSpaceSchema,
  idSchema,
  publishSiteSchema,
  resolveCommentSchema,
  restorePageSchema,
  savePageSchema,
  unpublishSiteSchema,
  updatePageSchema,
  updateSiteSchema,
  updateSpaceSchema,
  type SitePublishResult,
} from '@nova/shared';
import {
  ArtifactService,
  SiteService,
  SpaceService,
  noopAudit,
  spacesToolSource,
  type AuditSink,
  type ToolSourceProvider,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface SpacesArea extends HubArea {
  spaces: SpaceService;
  sites: SiteService;
  /** `visualize.create` and the page tools, for the chat loop's tool sources. */
  tools: ToolSourceProvider;
  /** The ops area's audit log (space edits, proposals, publishes). */
  useAudit(audit: AuditSink): void;
}

export interface SpacesDeps {
  audit?: AuditSink;
  /** The tools area's artifact service; by default the area makes its own over the same tables. */
  artifacts?: ArtifactService;
  now?: () => Date;
}

/** A site preview: no script, nothing loads from elsewhere, framed only by Nova's own pages. */
export const SITE_PREVIEW_CSP =
  "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";
/** A site built from an HTML artifact may run its own inline scripts, in an opaque origin only. */
export const SITE_SCRIPT_PREVIEW_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-ancestors 'self'";

const spaceParams = z.object({ id: idSchema });
const pageParams = z.object({ id: idSchema, pageId: idSchema });
const versionParams = pageParams.extend({ version: z.coerce.number().int().min(1) });
const commentParams = pageParams.extend({ commentId: idSchema });
const proposalParams = z.object({ id: idSchema, proposalId: idSchema });
const proposalsQuery = z.object({
  status: z.enum(['open', 'all']).optional(),
  pageId: idSchema.optional(),
});
const siteParams = z.object({ id: idSchema });
const siteVersionParams = z.object({ id: idSchema, version: z.coerce.number().int().min(1) });

export function setupSpaces(ctx: HubContext, deps: SpacesDeps = {}): Promise<SpacesArea> {
  const audit = deps.audit ?? noopAudit;
  const spaces = new SpaceService({
    db: ctx.db,
    events: ctx.events,
    audit,
    ...(deps.now ? { now: deps.now } : {}),
    defaultAgentEdits: () => ctx.setting('spaces.agentEdits'),
  });
  const artifacts =
    deps.artifacts ?? new ArtifactService({ db: ctx.db, events: ctx.events, dataDir: ctx.dataDir });
  const sites = new SiteService({
    db: ctx.db,
    events: ctx.events,
    dataDir: ctx.dataDir,
    spaces,
    artifacts,
    audit,
    ...(deps.now ? { now: deps.now } : {}),
    publishRoot: () => ctx.setting('sites.publishRoot'),
  });
  const tools = spacesToolSource(spaces, artifacts);

  ctx.diagnostics.add('spaces', async () => {
    const row = ctx.db.raw
      .prepare(
        `SELECT (SELECT count(*) FROM space WHERE deleted_at IS NULL) AS spaces,
                (SELECT count(*) FROM space_page WHERE deleted_at IS NULL) AS pages,
                (SELECT count(*) FROM site WHERE deleted_at IS NULL) AS sites`,
      )
      .get() as { spaces: number; pages: number; sites: number };
    return { ...row, publishRoot: await sites.publishRoot() };
  });

  function register(app: FastifyInstance): void {
    // ---- spaces ------------------------------------------------------------------------------
    app.get('/api/v1/spaces', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await spaces.listSpaces(accountId) };
    });

    app.post('/api/v1/spaces', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const body = createSpaceSchema.parse(req.body);
      const view = await spaces.createSpace(accountId, body);
      void reply.status(201);
      return view;
    });

    app.get('/api/v1/spaces/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = spaceParams.parse(req.params);
      return spaces.getSpace(accountId, id);
    });

    app.patch('/api/v1/spaces/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = spaceParams.parse(req.params);
      return spaces.updateSpace(accountId, id, updateSpaceSchema.parse(req.body));
    });

    app.delete('/api/v1/spaces/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = spaceParams.parse(req.params);
      await spaces.deleteSpace(accountId, id);
      return { ok: true };
    });

    // ---- pages ---------------------------------------------------------------------------------
    app.get('/api/v1/spaces/:id/pages', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = spaceParams.parse(req.params);
      return { items: await spaces.listPages(accountId, id) };
    });

    app.post('/api/v1/spaces/:id/pages', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = spaceParams.parse(req.params);
      const view = await spaces.createPage(accountId, id, createPageSchema.parse(req.body));
      void reply.status(201);
      return view;
    });

    app.get('/api/v1/spaces/:id/pages/:pageId', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId } = pageParams.parse(req.params);
      return spaces.getPage(accountId, id, pageId);
    });

    // A save: 409 `conflict` (details.reason `stale_version`, details.current) on a stale base.
    app.put('/api/v1/spaces/:id/pages/:pageId', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId } = pageParams.parse(req.params);
      return spaces.savePage(accountId, id, pageId, savePageSchema.parse(req.body));
    });

    app.patch('/api/v1/spaces/:id/pages/:pageId', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId } = pageParams.parse(req.params);
      return spaces.updatePageMeta(accountId, id, pageId, updatePageSchema.parse(req.body));
    });

    app.delete('/api/v1/spaces/:id/pages/:pageId', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId } = pageParams.parse(req.params);
      await spaces.deletePage(accountId, id, pageId);
      return { ok: true };
    });

    app.get('/api/v1/spaces/:id/pages/:pageId/versions', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId } = pageParams.parse(req.params);
      return { items: await spaces.listVersions(accountId, id, pageId) };
    });

    app.get('/api/v1/spaces/:id/pages/:pageId/versions/:version', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId, version } = versionParams.parse(req.params);
      return spaces.getVersion(accountId, id, pageId, version);
    });

    app.post('/api/v1/spaces/:id/pages/:pageId/restore', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId } = pageParams.parse(req.params);
      return spaces.restore(accountId, id, pageId, restorePageSchema.parse(req.body));
    });

    // ---- comments ------------------------------------------------------------------------------
    app.get('/api/v1/spaces/:id/pages/:pageId/comments', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId } = pageParams.parse(req.params);
      return { items: await spaces.listComments(accountId, id, pageId) };
    });

    app.post('/api/v1/spaces/:id/pages/:pageId/comments', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId } = pageParams.parse(req.params);
      const view = await spaces.addComment(
        accountId,
        id,
        pageId,
        createCommentSchema.parse(req.body),
      );
      void reply.status(201);
      return view;
    });

    app.post('/api/v1/spaces/:id/pages/:pageId/comments/:commentId/resolve', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId, commentId } = commentParams.parse(req.params);
      const { resolved } = resolveCommentSchema.parse(req.body);
      return spaces.resolveComment(accountId, id, pageId, commentId, resolved);
    });

    app.delete('/api/v1/spaces/:id/pages/:pageId/comments/:commentId', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, pageId, commentId } = commentParams.parse(req.params);
      await spaces.deleteComment(accountId, id, pageId, commentId);
      return { ok: true };
    });

    // ---- proposals -----------------------------------------------------------------------------
    app.get('/api/v1/spaces/:id/proposals', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = spaceParams.parse(req.params);
      return { items: await spaces.listProposals(accountId, id, proposalsQuery.parse(req.query)) };
    });

    // Accepting is the user's decision; a stale proposal needs `force` (409 `stale_proposal`).
    app.post('/api/v1/spaces/:id/proposals/:proposalId/accept', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, proposalId } = proposalParams.parse(req.params);
      const body = acceptProposalSchema.parse(req.body ?? {});
      return spaces.acceptProposal(accountId, id, proposalId, body);
    });

    app.post('/api/v1/spaces/:id/proposals/:proposalId/reject', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id, proposalId } = proposalParams.parse(req.params);
      return spaces.rejectProposal(accountId, id, proposalId);
    });

    // ---- sites ---------------------------------------------------------------------------------
    app.get('/api/v1/sites', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await sites.list(accountId) };
    });

    app.get('/api/v1/sites/data-sources', async (req) => {
      const accountId = await ctx.accountOf(req);
      return { items: await sites.dataSources(accountId) };
    });

    app.post('/api/v1/sites', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const view = await sites.create(accountId, createSiteSchema.parse(req.body));
      void reply.status(201);
      return view;
    });

    app.get('/api/v1/sites/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = siteParams.parse(req.params);
      return sites.get(accountId, id);
    });

    app.patch('/api/v1/sites/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = siteParams.parse(req.params);
      return sites.update(accountId, id, updateSiteSchema.parse(req.body));
    });

    app.delete('/api/v1/sites/:id', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = siteParams.parse(req.params);
      await sites.delete(accountId, id);
      return { ok: true };
    });

    app.post('/api/v1/sites/:id/build', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id } = siteParams.parse(req.params);
      const view = await sites.build(accountId, id, buildSiteSchema.parse(req.body ?? {}));
      void reply.status(201);
      return view;
    });

    app.get('/api/v1/sites/:id/versions', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = siteParams.parse(req.params);
      return { items: await sites.versions(accountId, id) };
    });

    // The preview loads in an iframe with the session cookie; its own CSP sandboxes it into an
    // opaque origin so it can never reach the app or the API (FR-037, like HTML artifacts).
    app.get('/api/v1/sites/:id/versions/:version/preview', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id, version } = siteVersionParams.parse(req.params);
      const { html, scripts } = await sites.preview(accountId, id, version);
      void reply
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Content-Security-Policy', scripts ? SITE_SCRIPT_PREVIEW_CSP : SITE_PREVIEW_CSP)
        .header('X-Frame-Options', 'SAMEORIGIN')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cross-Origin-Resource-Policy', 'same-origin')
        .header('Cache-Control', 'private, no-cache');
      return reply.send(html);
    });

    app.get('/api/v1/sites/:id/versions/:version/zip', async (req, reply) => {
      const accountId = await ctx.accountOf(req);
      const { id, version } = siteVersionParams.parse(req.params);
      const { bytes, name } = await sites.zip(accountId, id, version);
      void reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename="${name}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'private, no-cache');
      return reply.send(bytes);
    });

    app.get('/api/v1/sites/:id/publishes', async (req) => {
      const accountId = await ctx.accountOf(req);
      const { id } = siteParams.parse(req.params);
      return { items: await sites.publishes(accountId, id) };
    });

    // Explicit: the body must carry `confirm: true`; an earlier version is a rollback.
    app.post('/api/v1/sites/:id/publish', async (req): Promise<SitePublishResult> => {
      const accountId = await ctx.accountOf(req);
      const { id } = siteParams.parse(req.params);
      const body = publishSiteSchema.parse(req.body);
      const out = await sites.publish(accountId, id, {
        version: body.version,
        target: body.target,
      });
      return {
        ...out,
        downloadUrl:
          body.target.kind === 'zip'
            ? `/api/v1/sites/${encodeURIComponent(id)}/versions/${body.version}/zip`
            : null,
      };
    });

    app.post('/api/v1/sites/:id/unpublish', async (req): Promise<SitePublishResult> => {
      const accountId = await ctx.accountOf(req);
      const { id } = siteParams.parse(req.params);
      unpublishSiteSchema.parse(req.body);
      const out = await sites.unpublish(accountId, id);
      return {
        ...out,
        downloadUrl:
          out.publish?.target.kind === 'zip'
            ? `/api/v1/sites/${encodeURIComponent(id)}/versions/${out.publish.version}/zip`
            : null,
      };
    });
  }

  return Promise.resolve({
    spaces,
    sites,
    tools,
    useAudit: (a) => {
      spaces.useAudit(a);
      sites.useAudit(a);
    },
    register,
    close: () => Promise.resolve(),
  });
}
