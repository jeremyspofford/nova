// Review state of a session's changed files (FR-064, FR-065). A `code_change` row is one file
// in its current review round: the pending part (work tree against the baseline) is a patch blob,
// the hunks already decided are kept as JSON. The state is derived from both, so a file is
// `partial` whenever part of it is decided and part is not, or when some hunks were accepted and
// others rejected: the work tree is never half-applied without that marker.
import type { CodeChangeView, DiffHunkView } from '@nova/shared';
import { parseDiffSection, type ParsedDiffFile, type RawDiffEntry } from './diff.ts';

export interface Decided {
  hunks: DiffHunkView[];
  /** A whole-file decision on a file without hunks (binary, mode only). */
  file: 'accepted' | 'rejected' | null;
}

export interface ChangeRow {
  id: string;
  sessionId: string;
  path: string;
  kind: CodeChangeView['kind'];
  oldPath: string | null;
  additions: number;
  deletions: number;
  binary: number;
  pending: number;
  patchBlobPath: string | null;
  patchSha256: string | null;
  decidedJson: string;
  state: CodeChangeView['state'];
  callId: string | null;
  applied: number;
  createdAt: string;
  updatedAt: string;
}

export const CHANGE_COLUMNS = `id, session_id AS sessionId, path, change_kind AS kind, old_path AS oldPath,
  additions, deletions, binary, pending, patch_blob_path AS patchBlobPath,
  patch_sha256 AS patchSha256, decided_json AS decidedJson, state, call_id AS callId, applied,
  created_at AS createdAt, updated_at AS updatedAt`;

export function emptyDecided(): Decided {
  return { hunks: [], file: null };
}

export function parseDecided(json: string): Decided {
  try {
    const v = JSON.parse(json) as Partial<Decided>;
    return {
      hunks: Array.isArray(v.hunks) ? v.hunks : [],
      file: v.file === 'accepted' || v.file === 'rejected' ? v.file : null,
    };
  } catch {
    return emptyDecided();
  }
}

/** docs/10 §5: the state of a file from its pending part and its decisions. */
export function stateOf(pending: boolean, d: Decided): CodeChangeView['state'] {
  const accepted = d.file === 'accepted' || d.hunks.some((h) => h.state === 'accepted');
  const rejected = d.file === 'rejected' || d.hunks.some((h) => h.state === 'rejected');
  if (pending) return accepted || rejected ? 'partial' : 'pending';
  if (accepted && rejected) return 'partial';
  return rejected ? 'rejected' : 'accepted';
}

/** The patch text stored for a file's pending part. */
export function patchOf(f: ParsedDiffFile): string {
  return f.header + f.hunks.map((h) => h.raw).join('');
}

/** Re-parse a stored patch into the pending file. */
export function pendingFile(row: Pick<ChangeRow, 'path' | 'kind'>, patch: string): ParsedDiffFile {
  const status = row.kind === 'add' ? 'A' : row.kind === 'delete' ? 'D' : 'M';
  const e: RawDiffEntry = {
    oldMode: '',
    newMode: '',
    oldSha: '',
    newSha: '',
    status,
    path: row.path,
  };
  return parseDiffSection(e, patch);
}

/** Lines added and removed by what the change contributes (pending and accepted hunks). */
export function countLines(
  pending: ParsedDiffFile | null,
  d: Decided,
): {
  additions: number;
  deletions: number;
} {
  let additions = pending?.additions ?? 0;
  let deletions = pending?.deletions ?? 0;
  for (const h of d.hunks) {
    if (h.state !== 'accepted') continue;
    for (const l of h.lines) {
      if (l.kind === 'add') additions++;
      else if (l.kind === 'del') deletions++;
    }
  }
  return { additions, deletions };
}

/** A parsed hunk as the view shows it (decided hunks are stored in this shape). */
export function hunkView(
  h: ParsedDiffFile['hunks'][number],
  state: DiffHunkView['state'],
): DiffHunkView {
  return {
    id: h.id,
    header: h.header,
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines,
    state,
  };
}

/** The API view: pending hunks from the live patch plus the round's decided hunks. */
export function changeView(row: ChangeRow, pending: ParsedDiffFile | null): CodeChangeView {
  const d = parseDecided(row.decidedJson);
  const hunks: DiffHunkView[] = [];
  const ids = new Set<string>();
  for (const h of pending?.hunks ?? []) {
    ids.add(h.id);
    hunks.push(hunkView(h, 'pending'));
  }
  for (const h of d.hunks) {
    // Ids are unique within the view: a decided hunk that shares a pending hunk's numbers gets
    // a suffix (only pending ids can be decided).
    let id = h.id;
    for (let n = 2; ids.has(id); n++) id = `${h.id}~${n}`;
    ids.add(id);
    hunks.push({ ...h, id });
  }
  hunks.sort((a, b) => a.newStart - b.newStart || a.oldStart - b.oldStart);
  return {
    id: row.id,
    sessionId: row.sessionId,
    path: row.path,
    kind: row.kind,
    oldPath: row.oldPath,
    additions: row.additions,
    deletions: row.deletions,
    callId: row.callId,
    state: row.state,
    hunks,
    binary: row.binary === 1,
    createdAt: row.createdAt,
  };
}
