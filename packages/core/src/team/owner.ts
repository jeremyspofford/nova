// Who owns the Hub (decision 5 of ADR-095): one lookup for every area. The owner is the recorded
// `team_member` row with role `owner` (written at setup, or the first time the team area starts on
// a Hub from before M7). Until it is recorded, the first local account that is neither a member
// nor a team agent's identity stands in, so a Hub without the team tables still has its owner.
import type { NovaDatabase } from '@nova/storage';

function hasTable(db: NovaDatabase, name: string): boolean {
  return (
    db.raw
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

/** The recorded owner, else the first local account that is nobody else; null on a fresh Hub. */
export function hubOwnerId(db: NovaDatabase): string | null {
  const team = hasTable(db, 'team_member');
  if (team) {
    const recorded = db.raw
      .prepare(
        `SELECT m.account_id AS id FROM team_member m JOIN account a ON a.id = m.account_id
         WHERE m.role = 'owner' AND a.deleted_at IS NULL LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (recorded) return recorded.id;
  }
  const others = team
    ? `AND NOT EXISTS (SELECT 1 FROM team_member m WHERE m.account_id = a.id)
       AND NOT EXISTS (SELECT 1 FROM team_agent t WHERE t.identity_account_id = a.id)`
    : '';
  const first = db.raw
    .prepare(
      `SELECT a.id AS id FROM account a WHERE a.kind = 'local' AND a.deleted_at IS NULL ${others}
       ORDER BY a.created_at, a.id LIMIT 1`,
    )
    .get() as { id: string } | undefined;
  return first?.id ?? null;
}

/** Whether the account is the Hub's owner (fail closed: a lookup that fails says no). */
export function isHubOwner(db: NovaDatabase, accountId: string): boolean {
  try {
    return hubOwnerId(db) === accountId;
  } catch {
    return false;
  }
}

/**
 * Record the owner row if none is recorded yet (setup, or a Hub from before M7). One statement,
 * so it may run inside a caller's transaction.
 */
export function recordHubOwner(db: NovaDatabase, accountId: string, at: string): void {
  if (!hasTable(db, 'team_member')) return;
  db.raw
    .prepare(
      `INSERT INTO team_member (account_id, role, joined_at)
       SELECT ?, 'owner', ? WHERE NOT EXISTS (SELECT 1 FROM team_member WHERE role = 'owner')
       ON CONFLICT (account_id) DO NOTHING`,
    )
    .run(accountId, at);
}
