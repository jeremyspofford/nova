// Files, terminals, the library and local project folders (FR-005/006 server side, FR-035,
// FR-039, FR-041; contracts/hub-api.md). The file browser and terminals get exactly the roots a
// thread's tools get, plus its project's folders; saves pass the policy gate as `fs.write` from
// the UI and may wait for an approval (202). Terminals run only inside the sandbox (409
// `sandbox_unavailable` without one) and stream over a WebSocket whose handshake needs a session.
// Raw file bytes are served inert: no scripts, no plugins, no sniffing.
import { createReadStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  addProjectFolderSchema,
  createTerminalSchema,
  idSchema,
  isNovaError,
  pageQuerySchema,
  saveFileSchema,
} from '@nova/shared';
import {
  FileService,
  LibraryService,
  ProjectFolderService,
  TerminalManager,
  type AuditSink,
  type SandboxClient,
  type TerminalAttachment,
  type ToolGate,
  type ToolRuntimeOptions,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';
import { settingsScope } from './tools.ts';

/** Raw bytes never run anything, even when opened directly (FR-039). */
export const RAW_FILE_CSP = "default-src 'none'; img-src data:; sandbox";
/** Saved text is at most 5 MB; JSON escaping can grow it severalfold. */
export const SAVE_BODY_LIMIT = 32 * 1024 * 1024;

export interface WorkspaceArea extends HubArea {
  files: FileService;
  folders: ProjectFolderService;
  terminals: TerminalManager;
  library: LibraryService;
  /** Roots of a thread or project, its folders included (file browser and terminals). */
  scope: ToolRuntimeOptions['scope'];
}

export interface WorkspaceDeps {
  audit: AuditSink;
  gate: ToolGate;
  sandbox: () => SandboxClient | null;
  /** Roots of a thread or project; defaults to the tools' own scope (with project folders). */
  scope?: ToolRuntimeOptions['scope'];
  /** The Hub user's home directory (`~` in folder paths); defaults to the real one. */
  home?: string | null;
  terminalIdleMs?: number;
}

const rootsQuery = z.object({ threadId: idSchema.optional(), projectId: idSchema.optional() });
const fileQuery = z.object({
  root: z.string().min(1).max(1000),
  path: z.string().max(1000).default(''),
});
const libraryQuery = pageQuerySchema.extend({
  kind: z.enum(['artifact', 'attachment', 'source', 'image', 'file']).optional(),
  q: z.string().max(200).optional(),
});
const idParams = z.object({ id: idSchema });
const folderParams = z.object({ id: idSchema, fid: idSchema });
const clientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(256 * 1024) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(5).max(200),
  }),
]);

export function setupWorkspace(ctx: HubContext & WorkspaceDeps): Promise<WorkspaceArea> {
  const log = ctx.log.child('workspace');
  const workspaceDir = join(ctx.dataDir, 'workspace');
  mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  // Exactly the roots the thread's tools get, project folders included (FR-035, FR-190).
  const scope = ctx.scope ?? settingsScope(ctx, workspaceDir);
  const files = new FileService({
    db: ctx.db,
    gate: ctx.gate,
    audit: ctx.audit,
    scope,
    dataDir: ctx.dataDir,
    workspaceDir,
    log: log.child('files'),
  });
  const folders = new ProjectFolderService({
    db: ctx.db,
    events: ctx.events,
    dataDir: ctx.dataDir,
    ...(ctx.home !== undefined ? { home: ctx.home } : {}),
    log: log.child('folders'),
  });
  const terminals = new TerminalManager({
    db: ctx.db,
    sandbox: ctx.sandbox,
    scope,
    events: ctx.events,
    audit: ctx.audit,
    log: log.child('terminals'),
    ...(ctx.terminalIdleMs !== undefined ? { idleMs: ctx.terminalIdleMs } : {}),
  });
  const library = new LibraryService({ db: ctx.db });
  folders
    .recover()
    .catch((err: unknown) => log.warn('re-queueing folder indexing failed', { err }));
  // The account a WebSocket handshake authenticated as (checked before the upgrade).
  const socketAccounts = new WeakMap<FastifyRequest, string>();

  return Promise.resolve({
    files,
    folders,
    terminals,
    library,
    scope,
    register(app: FastifyInstance) {
      // ---- files (FR-039) ---------------------------------------------------------------
      app.get('/api/v1/files/roots', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = rootsQuery.parse(req.query);
        return { items: await files.roots(accountId, q) };
      });

      app.get('/api/v1/files/list', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = fileQuery.parse(req.query);
        return { items: await files.list(accountId, q.root, q.path) };
      });

      app.get('/api/v1/files/content', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = fileQuery.parse(req.query);
        return files.read(accountId, q.root, q.path);
      });

      app.get('/api/v1/files/raw', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const q = fileQuery.parse(req.query);
        const f = await files.raw(accountId, q.root, q.path);
        void reply
          .header('Content-Type', f.mime)
          .header('Content-Length', String(f.size))
          .header('Content-Security-Policy', RAW_FILE_CSP)
          .header('X-Content-Type-Options', 'nosniff')
          .header('Cross-Origin-Resource-Policy', 'same-origin')
          .header('Cache-Control', 'private, no-cache')
          .header('Content-Disposition', `inline; filename="${safeName(f.name)}"`);
        return reply.send(createReadStream(f.path));
      });

      app.put('/api/v1/files/content', { bodyLimit: SAVE_BODY_LIMIT }, async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const body = saveFileSchema.parse(req.body);
        const out = await files.save(accountId, body);
        if (out.status === 'pending') {
          void reply.status(202);
          return { approvalId: out.approvalId };
        }
        return out.file;
      });

      // ---- terminals (FR-006) -----------------------------------------------------------
      app.post('/api/v1/terminals', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const body = createTerminalSchema.parse(req.body ?? {});
        try {
          const view = await terminals.create(accountId, body);
          void reply.status(201);
          return view;
        } catch (err) {
          // Without a sandbox nothing can run here: a state conflict, not an outage (hub-api).
          if (isNovaError(err) && err.code === 'sandbox_unavailable')
            return reply.status(409).send({ error: err.toJSON(), requestId: req.id });
          throw err;
        }
      });

      app.get('/api/v1/terminals', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: terminals.list(accountId) };
      });

      app.delete('/api/v1/terminals/:id', async (req) => {
        const accountId = await ctx.accountOf(req);
        await terminals.close(accountId, idParams.parse(req.params).id);
        return { ok: true };
      });

      app.get(
        '/api/v1/terminals/:id/ws',
        {
          websocket: true,
          // The session is checked before the upgrade: without one the handshake gets 401.
          preValidation: async (req: FastifyRequest) => {
            socketAccounts.set(req, await ctx.accountOf(req));
          },
        },
        (socket, req) => {
          const accountId = socketAccounts.get(req);
          const params = idParams.safeParse(req.params);
          if (!accountId || !params.success) {
            socket.close(4400, 'validation');
            return;
          }
          let attached: TerminalAttachment;
          try {
            attached = terminals.attach(accountId, params.data.id, {
              send: (frame) => {
                if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
              },
            });
          } catch {
            socket.close(4404, 'not_found');
            return;
          }
          socket.on('message', (raw: Buffer) => {
            let frame;
            try {
              frame = clientFrame.parse(JSON.parse(raw.toString('utf8')));
            } catch {
              socket.send(
                JSON.stringify({
                  type: 'error',
                  error: { code: 'validation', message: 'unknown terminal frame' },
                }),
              );
              return;
            }
            if (frame.type === 'input') attached.input(frame.data);
            else attached.resize(frame.cols, frame.rows);
          });
          socket.on('close', () => attached.detach());
        },
      );

      // ---- the library (FR-041) ---------------------------------------------------------
      app.get('/api/v1/library', async (req) => {
        const accountId = await ctx.accountOf(req);
        const q = libraryQuery.parse(req.query);
        return library.list(accountId, q);
      });

      // ---- project folders (FR-035) -----------------------------------------------------
      app.get('/api/v1/projects/:id/folders', async (req) => {
        const accountId = await ctx.accountOf(req);
        return { items: await folders.list(accountId, idParams.parse(req.params).id) };
      });

      app.post('/api/v1/projects/:id/folders', async (req, reply) => {
        const accountId = await ctx.accountOf(req);
        const { id } = idParams.parse(req.params);
        const view = await folders.add(accountId, id, addProjectFolderSchema.parse(req.body));
        void reply.status(201);
        return view;
      });

      app.post('/api/v1/projects/:id/folders/:fid/reindex', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = folderParams.parse(req.params);
        return folders.reindex(accountId, p.id, p.fid);
      });

      app.delete('/api/v1/projects/:id/folders/:fid', async (req) => {
        const accountId = await ctx.accountOf(req);
        const p = folderParams.parse(req.params);
        await folders.remove(accountId, p.id, p.fid);
        return { ok: true };
      });
    },
    async close() {
      await files.close();
      await terminals.closeAll();
      await folders.stop();
    },
  });
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, 100) || 'file';
}
