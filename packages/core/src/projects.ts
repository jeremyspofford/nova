// Projects (FR-034): group chats, sources and instructions. Instructions apply to every chat in
// the project (the conversation engine adds them to the system prompt). The memory scope is set
// at creation and never changes (FR-205). Deleting a project soft-deletes it and its sources;
// its chats stay, detached.
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import {
  NovaError,
  uuidv7,
  type createProjectSchema,
  type ProjectView,
  type updateProjectSchema,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import type { EventSink } from './events.ts';

const { project } = schema;

export type ProjectRow = typeof project.$inferSelect;
export type CreateProjectRequest = z.input<typeof createProjectSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectSchema>;

export interface ProjectServiceOptions {
  db: NovaDatabase;
  now?: () => Date;
  /** `project.created`, `.updated`, `.deleted` (contracts/events.md); sync's change feed listens. */
  events?: EventSink;
}

export class ProjectService {
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  readonly #events: EventSink | undefined;

  constructor(opts: ProjectServiceOptions) {
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
    this.#events = opts.events;
  }

  async list(accountId: string): Promise<ProjectView[]> {
    const rows = await this.#db.orm
      .select()
      .from(project)
      .where(and(eq(project.accountId, accountId), isNull(project.deletedAt)))
      .orderBy(desc(project.updatedAt), desc(project.id));
    return rows.map((r) => this.#view(r));
  }

  /** The live project, scoped to the account; `not_found` otherwise. */
  async row(accountId: string, id: string): Promise<ProjectRow> {
    const rows = await this.#db.orm
      .select()
      .from(project)
      .where(and(eq(project.id, id), eq(project.accountId, accountId), isNull(project.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NovaError('not_found', 'project not found');
    return row;
  }

  async get(accountId: string, id: string): Promise<ProjectView> {
    return this.#view(await this.row(accountId, id));
  }

  async create(accountId: string, req: CreateProjectRequest): Promise<ProjectView> {
    const now = this.#now().toISOString();
    const row: ProjectRow = {
      id: uuidv7(),
      accountId,
      name: req.name.trim(),
      kind: 'chat',
      instructions: cleanInstructions(req.instructions),
      memoryScope: req.memoryScope ?? 'shared',
      upstreamProjectRef: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await this.#db.transaction(() => this.#db.orm.insert(project).values(row));
    await this.#changed('project.created', accountId, row.id);
    return this.#view(row);
  }

  async update(accountId: string, id: string, req: UpdateProjectRequest): Promise<ProjectView> {
    await this.row(accountId, id);
    const set: Partial<ProjectRow> = { updatedAt: this.#now().toISOString() };
    if (req.name !== undefined) set.name = req.name.trim();
    if (req.instructions !== undefined) set.instructions = cleanInstructions(req.instructions);
    await this.#db.transaction(() =>
      this.#db.orm.update(project).set(set).where(eq(project.id, id)),
    );
    await this.#changed('project.updated', accountId, id);
    return this.get(accountId, id);
  }

  async remove(accountId: string, id: string): Promise<void> {
    await this.row(accountId, id);
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      const raw = this.#db.raw;
      raw
        .prepare('UPDATE project SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(now, now, id);
      // Sources leave retrieval at once; their blobs stay for the recovery window (docs/06 §5).
      raw
        .prepare(
          `DELETE FROM source_chunk WHERE source_id IN
             (SELECT id FROM source WHERE project_id = ? AND deleted_at IS NULL)`,
        )
        .run(id);
      raw
        .prepare(
          'UPDATE source SET deleted_at = ?, updated_at = ? WHERE project_id = ? AND deleted_at IS NULL',
        )
        .run(now, now, id);
      raw.prepare('UPDATE thread SET project_id = NULL WHERE project_id = ?').run(id);
    });
    await this.#changed('project.deleted', accountId, id);
  }

  async #changed(name: string, accountId: string, projectId: string): Promise<void> {
    await this.#events?.emit({ name, actor: 'system', accountId, payload: { projectId } });
  }

  #view(r: ProjectRow): ProjectView {
    const counts = this.#db.raw
      .prepare(
        `SELECT
           (SELECT count(*) FROM thread WHERE project_id = ? AND deleted_at IS NULL AND side = 0) AS threads,
           (SELECT count(*) FROM source s WHERE s.project_id = ? AND s.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM project_folder_file f WHERE f.source_id = s.id)) AS sources`,
      )
      .get(r.id, r.id) as { threads: number; sources: number };
    return {
      id: r.id,
      name: r.name,
      instructions: r.instructions,
      memoryScope: r.memoryScope,
      threadCount: counts.threads,
      sourceCount: counts.sources,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

function cleanInstructions(text: string | null | undefined): string | null {
  if (text === undefined || text === null) return null;
  return text.trim() ? text : null;
}
