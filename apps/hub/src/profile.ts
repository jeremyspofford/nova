// Profile, usage insights and import from other assistants (FR-113, FR-114, FR-200; hub-api M4).
// The account routes moved here from the M1 chat routes and keep their behaviour: a blank
// display name clears it, `avatar: null` removes the avatar, the response still carries
// `accountId` and `displayName`. Switching the active provider account (FR-115) sits with the
// other provider routes in chat-routes.ts. Every route requires a session and validates its
// input; the services live in @nova/core.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { importApplySchema, importPreviewSchema, updateProfileSchema } from '@nova/shared';
import {
  ImportService,
  MemoryService,
  ProfileService,
  ProjectService,
  UsageService,
  type AuditSink,
  type ImportTargets,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';
import type { HubMcpArea } from './mcp.ts';
import type { PluginsArea } from './plugins.ts';

/** An avatar is at most 2 MB, sent as base64 (about 2.7 MB) inside JSON. */
export const ACCOUNT_BODY_LIMIT = 4 * 1024 * 1024;

export interface ProfileDeps {
  audit: AuditSink;
  mcp: HubMcpArea;
  plugins: PluginsArea;
  /**
   * The workspace area's project folders (FR-035): an imported project gets its folder through
   * them. Without them the project is created without a folder and the import says so.
   */
  folders?: ImportTargets['folders'];
  /** The Hub's memory and project services; the area makes its own when they are not given. */
  memory?: MemoryService;
  projects?: ProjectService;
  /** The user's home folder, for telling user-level instruction files apart (tests). */
  home?: string;
}

export interface ProfileArea extends HubArea {
  profile: ProfileService;
  usage: UsageService;
  imports: ImportService;
}

const usageQuery = z.object({
  from: z.string().min(1).max(40).optional(),
  to: z.string().min(1).max(40).optional(),
});

export function setupProfile(ctx: HubContext & ProfileDeps): Promise<ProfileArea> {
  const { db, events, accountOf, plugins } = ctx;
  const log = ctx.log.child('profile');
  const profile = new ProfileService({ db, dataDir: ctx.dataDir, events });
  const usage = new UsageService({ db });
  const memory =
    ctx.memory ??
    new MemoryService({
      db,
      events,
      log: log.child('memory'),
      enabled: (projectId) => ctx.setting('memory.enabled', projectId),
    });
  const projects = ctx.projects ?? new ProjectService({ db });
  const imports = new ImportService({
    db,
    secrets: ctx.secrets,
    events,
    dataDir: ctx.dataDir,
    memory,
    projects,
    audit: ctx.audit,
    log: log.child('import'),
    ...(ctx.home ? { home: ctx.home } : {}),
    targets: {
      // Imported skills are user skills with an import origin (FR-200, the plugins area's index).
      skills: plugins.index,
      // Imported plugins are installed through the plugins area, disabled until confirmed.
      plugins: {
        installDisabled: async (accountId, folder) => {
          const preview = await plugins.service.preview(accountId, { kind: 'path', path: folder });
          const view = await plugins.service.install(accountId, {
            previewId: preview.previewId,
            enable: false,
            // Choosing the item on the import screen is the sideload confirmation; it stays off.
            confirmSideload: true,
          });
          return { id: view.id, name: view.name };
        },
      },
      ...(ctx.folders ? { folders: ctx.folders } : {}),
    },
  });

  function register(app: FastifyInstance): void {
    // ---- account (FR-113) ---------------------------------------------------------------------
    app.get('/api/v1/account', async (req) => profile.get(await accountOf(req)));

    app.patch('/api/v1/account', { bodyLimit: ACCOUNT_BODY_LIMIT }, async (req) => {
      const accountId = await accountOf(req);
      return profile.update(accountId, updateProfileSchema.parse(req.body));
    });

    app.get('/api/v1/account/avatar', async (req, reply) => {
      const image = await profile.avatar(await accountOf(req));
      if (!image)
        return reply.status(404).send({
          error: { code: 'not_found', message: 'no avatar', retryable: false },
          requestId: req.id,
        });
      void reply
        .header('Content-Type', image.mime)
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .header('Cache-Control', 'private, no-cache');
      return reply.send(image.bytes);
    });

    // ---- usage insights (FR-114): local only ----------------------------------------------------
    app.get('/api/v1/usage', async (req) => {
      const accountId = await accountOf(req);
      const q = usageQuery.parse(req.query);
      return usage.summary(accountId, {
        ...(q.from ? { from: q.from } : {}),
        ...(q.to ? { to: q.to } : {}),
      });
    });

    // ---- import from other assistants (FR-200) ---------------------------------------------
    app.post('/api/v1/import/preview', async (req) => {
      const accountId = await accountOf(req);
      return imports.preview(accountId, importPreviewSchema.parse(req.body));
    });

    app.post('/api/v1/import/apply', async (req) => {
      const accountId = await accountOf(req);
      return imports.apply(accountId, importApplySchema.parse(req.body));
    });

    app.get('/api/v1/import/records', async (req) => ({
      items: await imports.records(await accountOf(req)),
    }));
  }

  return Promise.resolve({
    profile,
    usage,
    imports,
    register,
    close: () => Promise.resolve(),
  });
}
