// Project folders as tool roots (FR-035, FR-190). The tool runtime's scope and the policy gate
// both add a project's folders to its roots through this (approvals/roots.ts), so the roots a
// project's chats, file browser and terminals get and the roots the engine checks agree; the
// permission profile caps their access like any project root.
import { basename } from 'node:path';
import type { NovaDatabase } from '@nova/storage';
import type { ToolRoot } from '../tools/types.ts';

/**
 * The folders bound to a project, as `tools.roots`-shaped entries (canonical paths, the access
 * the user chose). Folders of a deleted project are not roots.
 */
export function listProjectFolderRoots(db: NovaDatabase, projectId: string): Promise<ToolRoot[]> {
  try {
    const rows = db.raw
      .prepare(
        `SELECT f.path AS path, f.access AS access FROM project_folder f
         JOIN project p ON p.id = f.project_id
         WHERE f.project_id = ? AND p.deleted_at IS NULL
         ORDER BY f.created_at, f.id`,
      )
      .all(projectId) as { path: string; access: 'read' | 'write' }[];
    return Promise.resolve(
      rows.map((r) => ({ path: r.path, access: r.access, label: basename(r.path) || r.path })),
    );
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}
