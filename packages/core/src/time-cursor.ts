// An opaque paging cursor for lists ordered newest first by (created_at, id): the position after
// the previous page's last row. Paging by the pair never skips rows that share a timestamp at a
// page boundary, which paging by time alone does.
import { NovaError } from '@nova/shared';

export function encodeTimeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id]), 'utf8').toString('base64url');
}

/** The position a cursor names; `validation` (field `cursor`) for anything that is not one. */
export function decodeTimeCursor(cursor: string): [string, string] {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === 'string' &&
      typeof v[1] === 'string' &&
      !Number.isNaN(Date.parse(v[0])) &&
      v[1].length > 0 &&
      v[1].length <= 100
    )
      return [v[0], v[1]];
  } catch {
    // Not base64url JSON: the error below.
  }
  throw new NovaError('validation', 'the cursor is not valid', { details: { field: 'cursor' } });
}

/** The SQL condition for rows after a cursor, newest first (`created_at`, `id` columns). */
export function afterTimeCursor(
  cursor: string,
  columns: { at: string; id: string } = { at: 'created_at', id: 'id' },
): { sql: string; args: [string, string, string] } {
  const [at, id] = decodeTimeCursor(cursor);
  return {
    sql: `(${columns.at} < ? OR (${columns.at} = ? AND ${columns.id} < ?))`,
    args: [at, at, id],
  };
}
