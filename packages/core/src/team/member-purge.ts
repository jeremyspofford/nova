// A removed member's data (decision 5 of ADR-095; M8, ADR-097). Removing a member closes their
// account and stops their work but keeps their data, so the owner can export it. After the grace
// period the owner sets (`team.removedMemberPurgeDays`, 0 keeps it) or at once on the owner's
// request, the purge deletes everything the account owned: its chats and everything in them,
// files and blobs, memory, settings, tokens, connectors and the vault entries of those rows, and
// the member's own folder. The account row stays with its personal fields cleared, and so do the
// member's `team_member` row and the audit trail (an append-only chain, docs/12 §11), which name
// it; usage rows stay for the Hub's spend accounting without their thread.
//
// The purge walks the schema rather than a hand-kept list, so a table added later is covered:
// every table with an `account_id` column is the account's, and rows that hang off those rows by
// foreign key go with them, deepest first. Another account's row that only points at one of them
// lets go of the reference. Vault entries go when their reference names a deleted row's id (ids are
// UUIDv7, so no other account's entry can match); a reference merely written in a row (a member
// could type another account's) never deletes anything. The rows go in one transaction (a
// failure leaves the data whole and is recorded; the next sweep tries again), which also records
// the blobs, vault entries and folders left to remove; that cleanup runs after the commit and,
// if it is cut short, the next sweep finishes it.
//
// Their words in other people's shared chats are redacted rather than kept or deleted: the
// message stays so the owner's chat keeps its shape, its text becomes a fixed notice and its files
// go (decision, ADR-097). What the assistant answered there is the chat owner's and stays.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  NovaError,
  uuidv7,
  type MemberPurgeCounts,
  type RemovedMemberStatus,
  type RemovedMemberView,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import { parseAttachments } from '../followups.ts';
import { PLUGIN_DRAFTS_DIR } from '../plugins/authoring.ts';
import { BLOB_REFERENCES, removeUnreferencedBlobs } from '../purge.ts';
import type { AuditSink } from '../tools/types.ts';
import { memberWorkspace } from './access.ts';
import type { TeamService } from './members.ts';

/** Account-scoped tables a purge keeps (see the header). */
export const PURGE_KEEPS: ReadonlySet<string> = new Set([
  'team_member',
  'audit_event',
  'usage_event',
  'member_purge',
]);

/** A failed purge is tried again by a sweep at most this often. */
const RETRY_MS = 24 * 3_600_000;
const MAX_DEPTH = 24;

interface Column {
  name: string;
  notnull: number;
  pk: number;
}

interface ChildFk {
  /** The referencing table and column. */
  table: string;
  from: string;
  /** The referenced column of the parent. */
  to: string;
  onDelete: string;
  notNull: boolean;
}

interface SchemaMap {
  columns: Map<string, Column[]>;
  /** Parent table -> the foreign keys that point at it. */
  children: Map<string, ChildFk[]>;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

function readSchema(db: NovaDatabase): SchemaMap {
  const tables = (
    db.raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const columns = new Map<string, Column[]>();
  for (const t of tables)
    columns.set(t, db.raw.prepare(`PRAGMA table_info(${q(t)})`).all() as unknown as Column[]);
  const children = new Map<string, ChildFk[]>();
  for (const t of tables) {
    const fks = db.raw.prepare(`PRAGMA foreign_key_list(${q(t)})`).all() as {
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string | null;
      on_delete: string;
    }[];
    const composite = new Set(fks.filter((f) => f.seq > 0).map((f) => f.id));
    for (const f of fks) {
      // No composite foreign keys exist; one added later would need its own handling.
      if (composite.has(f.id))
        throw new NovaError('server_error', `a composite foreign key on ${t} cannot be purged`);
      const parentPk = columns.get(f.table)?.find((c) => c.pk === 1)?.name ?? 'id';
      const col = columns.get(t)?.find((c) => c.name === f.from);
      const list = children.get(f.table) ?? [];
      list.push({
        table: t,
        from: f.from,
        to: f.to ?? parentPk,
        onDelete: f.on_delete.toUpperCase(),
        notNull: (col?.notnull ?? 0) === 1 || (col?.pk ?? 0) > 0,
      });
      children.set(f.table, list);
    }
  }
  return { columns, children };
}

/** Rows the purge deleted, blobs it may have freed and the ids of the account's rows. */
export interface AccountRowsPurged {
  rows: Record<string, number>;
  blobs: string[];
  ids: Set<string>;
}

/**
 * Delete every row the account owns, children first, and clear the account row's personal
 * fields. Synchronous: call it inside `db.transaction`. Throws (and so rolls back) on anything
 * it cannot purge whole.
 */
export function purgeAccountRows(
  db: NovaDatabase,
  accountId: string,
  at: string,
): AccountRowsPurged {
  const schema = readSchema(db);
  const rows: Record<string, number> = {};
  const blobs = new Set<string>();
  const ids = new Set<string>([accountId]);
  const has = (t: string, c: string) => schema.columns.get(t)?.some((x) => x.name === c) ?? false;
  const blobColumns = (t: string) => BLOB_REFERENCES.filter(([bt]) => bt === t).map(([, c]) => c);

  const collect = (table: string, where: string, params: unknown[]) => {
    for (const c of blobColumns(table))
      for (const r of db.raw
        .prepare(`SELECT ${q(c)} AS p FROM ${q(table)} WHERE (${where}) AND ${q(c)} IS NOT NULL`)
        .all(...(params as string[])) as { p: string }[])
        blobs.add(r.p);
    if (table === 'queued_input')
      for (const r of db.raw
        .prepare(`SELECT attachments FROM queued_input WHERE ${where}`)
        .all(...(params as string[])) as { attachments: string | null }[])
        for (const a of parseAttachments(r.attachments)) blobs.add(a.blobPath);
    if (has(table, 'account_id') && has(table, 'id'))
      for (const r of db.raw
        .prepare(`SELECT id FROM ${q(table)} WHERE ${where}`)
        .all(...(params as string[])) as { id: unknown }[])
        if (typeof r.id === 'string') ids.add(r.id);
  };

  const remove = (table: string, where: string, params: unknown[], stack: string[]): void => {
    if (stack.length > MAX_DEPTH)
      throw new NovaError('server_error', `the purge went too deep at ${stack.join(' > ')}`);
    const path = [...stack, table];
    for (const fk of schema.children.get(table) ?? []) {
      // SQLite clears these references itself when the parent goes.
      if (fk.onDelete === 'SET NULL' || fk.onDelete === 'SET DEFAULT') continue;
      const sub = `SELECT ${q(fk.to)} FROM ${q(table)} WHERE ${where}`;
      const inParents = `${q(fk.from)} IN (${sub})`;
      const clear = (extra = '', extraParams: unknown[] = []) => {
        if (fk.notNull)
          throw new NovaError(
            'server_error',
            `${fk.table}.${fk.from} must name a ${table} row and cannot be cleared`,
          );
        db.raw
          .prepare(`UPDATE ${q(fk.table)} SET ${q(fk.from)} = NULL WHERE ${inParents}${extra}`)
          .run(...([...params, ...extraParams] as string[]));
      };
      // A reference back up the walk (a table pointing at itself, or a cycle) is let go.
      if (path.includes(fk.table)) {
        clear();
        continue;
      }
      if (PURGE_KEEPS.has(fk.table)) {
        clear();
        continue;
      }
      if (fk.onDelete !== 'CASCADE' && has(fk.table, 'account_id') && !fk.notNull) {
        // Another account's row only lets go; the account's own rows go below.
        clear(' AND account_id IS NOT ?', [accountId]);
        remove(fk.table, `${inParents} AND account_id = ?`, [...params, accountId], path);
        continue;
      }
      remove(fk.table, inParents, params, path);
    }
    collect(table, where, params);
    const n = db.raw
      .prepare(`DELETE FROM ${q(table)} WHERE ${where}`)
      .run(...(params as string[])).changes;
    if (n) rows[table] = (rows[table] ?? 0) + Number(n);
  };

  // Their words in other people's shared chats are redacted before their authorship rows go.
  if (schema.columns.has('shared_message')) {
    const n = redactSharedMessages(db, accountId, at, blobs);
    if (n) rows.redacted_messages = n;
  }
  for (const [table, cols] of schema.columns) {
    if (PURGE_KEEPS.has(table) || !cols.some((c) => c.name === 'account_id')) continue;
    remove(table, 'account_id = ?', [accountId], []);
  }
  // The tasks the member gave team agents carry their words; the agent's own work stays.
  if (schema.columns.has('team_task')) remove('team_task', 'requested_by = ?', [accountId], []);
  if (schema.columns.has('usage_event'))
    db.raw
      .prepare('UPDATE usage_event SET thread_id = NULL, turn_id = NULL WHERE account_id = ?')
      .run(accountId);
  const avatar = db.raw
    .prepare('SELECT avatar_path AS p FROM account WHERE id = ?')
    .get(accountId) as { p: string | null } | undefined;
  if (avatar?.p) blobs.add(avatar.p);
  db.raw
    .prepare(
      `UPDATE account SET display_name = NULL, username = NULL, avatar_path = NULL, email = NULL,
         updated_at = ? WHERE id = ?`,
    )
    .run(at, accountId);
  return { rows, blobs: [...blobs], ids };
}

/** What stands in for a purged member's words in someone else's shared chat. */
export const REDACTED_MESSAGE_TEXT = '[Removed: written by a member whose data was purged]';

/**
 * The member's own messages in shared chats they did not own (decision, ADR-097): the message
 * stays where it was, so the chat keeps its turns, replies and branches, but its text becomes
 * `REDACTED_MESSAGE_TEXT` (the search index follows by trigger) and its other parts and the files
 * attached to it go. Their authorship rows go with the account's other rows. What the assistant
 * answered stays: it belongs to the chat's owner. Returns how many messages were redacted.
 */
function redactSharedMessages(
  db: NovaDatabase,
  accountId: string,
  at: string,
  blobs: Set<string>,
): number {
  const ids = (
    db.raw
      .prepare(
        `SELECT s.message_id AS id FROM shared_message s JOIN thread t ON t.id = s.thread_id
         WHERE s.account_id = ? AND t.account_id <> ?`,
      )
      .all(accountId, accountId) as { id: string }[]
  ).map((r) => r.id);
  for (const id of ids) {
    for (const r of db.raw
      .prepare(
        'SELECT blob_path AS p FROM attachment WHERE message_id = ? AND blob_path IS NOT NULL',
      )
      .all(id) as { p: string }[])
      blobs.add(r.p);
    db.raw.prepare('DELETE FROM attachment WHERE message_id = ?').run(id);
    db.raw.prepare("DELETE FROM message_part WHERE message_id = ? AND type <> 'text'").run(id);
    const text = db.raw
      .prepare("UPDATE message_part SET content = ? WHERE message_id = ? AND type = 'text'")
      .run(REDACTED_MESSAGE_TEXT, id).changes;
    if (!text)
      db.raw
        .prepare(
          `INSERT INTO message_part (id, message_id, idx, type, content, created_at)
           VALUES (?, ?, 0, 'text', ?, ?)`,
        )
        .run(uuidv7(), id, REDACTED_MESSAGE_TEXT, at);
    db.raw.prepare('UPDATE message SET updated_at = ? WHERE id = ?').run(at, id);
  }
  return ids.length;
}

/** Vault references that name one of the ids as a path segment. */
export function secretsOfIds(refs: readonly string[], ids: ReadonlySet<string>): string[] {
  return refs.filter((ref) => {
    if (!ref.startsWith('secret://')) return false;
    return ref
      .slice('secret://'.length)
      .split('/')
      .some((seg) => ids.has(seg));
  });
}

/** Where a member's own files live (their workspace's parent, and their plugin drafts). */
export function memberFolders(dataDir: string, accountId: string): string[] {
  return [
    join(memberWorkspace(dataDir, accountId), '..'),
    join(dataDir, PLUGIN_DRAFTS_DIR, accountId.replace(/[^A-Za-z0-9_-]/g, '_')),
  ];
}

export interface MemberPurgeOptions {
  db: NovaDatabase;
  dataDir: string;
  team: TeamService;
  events: EventSink;
  secrets?: Pick<SecretStore, 'list' | 'delete'>;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
  /** `team.removedMemberPurgeDays`. */
  graceDays: () => Promise<number>;
}

interface RemovedRow {
  account_id: string;
  display_name: string | null;
  removed_at: string;
  removed_by: string | null;
  status: 'cleaning' | 'purged' | 'failed' | null;
  cause: 'grace' | 'request' | null;
  attempted_at: string | null;
  purged_at: string | null;
  counts_json: string | null;
  error: string | null;
}

/** What a purge left to remove outside the database, recorded in its transaction. */
interface Cleanup {
  blobs: string[];
  secrets: string[];
  folders: string[];
}

export class MemberPurgeService {
  readonly #o: MemberPurgeOptions;
  readonly #db: NovaDatabase;
  readonly #log: Logger;
  readonly #now: () => Date;
  /** One purge at a time (a sweep and a request may meet). */
  #running: Promise<unknown> = Promise.resolve();

  constructor(opts: MemberPurgeOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#log = opts.log ?? new Logger({ module: 'core.team.purge', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
  }

  #ready(): boolean {
    return (
      this.#db.raw
        .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'member_purge'")
        .get() !== undefined
    );
  }

  #rows(accountId?: string): RemovedRow[] {
    if (!this.#ready()) return [];
    return this.#db.raw
      .prepare(
        `SELECT m.account_id, a.display_name, m.removed_at, m.removed_by, p.status, p.cause,
           p.attempted_at, p.purged_at, p.counts_json, p.error
         FROM team_member m JOIN account a ON a.id = m.account_id
         LEFT JOIN member_purge p ON p.account_id = m.account_id
         WHERE m.role = 'member' AND m.removed_at IS NOT NULL ${accountId ? 'AND m.account_id = ?' : ''}
         ORDER BY m.removed_at DESC`,
      )
      .all(...(accountId ? [accountId] : [])) as unknown as RemovedRow[];
  }

  #view(r: RemovedRow, days: number): RemovedMemberView {
    // `cleaning`: the rows are gone; only files and vault entries are still being removed.
    const purged = r.status === 'purged' || r.status === 'cleaning';
    const purgeAfter =
      purged || days <= 0
        ? null
        : new Date(Date.parse(r.removed_at) + days * 86_400_000).toISOString();
    const status: RemovedMemberStatus = purged
      ? 'purged'
      : r.status === 'failed'
        ? 'failed'
        : purgeAfter
          ? 'scheduled'
          : 'kept';
    let counts: MemberPurgeCounts | null;
    try {
      counts = r.counts_json ? (JSON.parse(r.counts_json) as MemberPurgeCounts) : null;
    } catch {
      counts = null;
    }
    return {
      accountId: r.account_id,
      displayName: r.display_name,
      removedAt: r.removed_at,
      removedBy: r.removed_by,
      status,
      purgeAfter,
      purgedAt: r.purged_at,
      cause: r.cause,
      error: r.error,
      counts,
      exportable: !purged,
      cleanupPending: r.status === 'cleaning',
    };
  }

  /** The removed members and where their data stands (owner only). */
  async removed(actor: string): Promise<RemovedMemberView[]> {
    this.#o.team.assertOwner(actor);
    const days = await this.#o.graceDays();
    return this.#rows().map((r) => this.#view(r, days));
  }

  /** One removed member (owner only); `not_found` for anyone else. */
  async get(actor: string, accountId: string): Promise<RemovedMemberView> {
    this.#o.team.assertOwner(actor);
    const row = this.#rows(accountId)[0];
    if (!row) throw new NovaError('not_found', 'no such removed member');
    return this.#view(row, await this.#o.graceDays());
  }

  /** Purge a removed member's data at once, on the owner's request. */
  async purge(actor: string, accountId: string): Promise<RemovedMemberView> {
    this.#o.team.assertOwner(actor);
    if (!this.#ready())
      throw new NovaError('capability_missing', 'purging needs migration 0051 (team_m8)');
    const row = this.#rows(accountId)[0];
    if (!row) throw new NovaError('not_found', 'no such removed member');
    if (row.status === 'purged')
      throw new NovaError('conflict', "this member's data was already purged", {
        details: { reason: 'already_purged' },
      });
    // A purge whose cleanup was cut short is finished, not run again.
    if (row.status === 'cleaning') await this.#serial(() => this.#finish(accountId));
    else await this.#serial(() => this.#purgeOne(accountId, 'request', actor));
    return this.get(actor, accountId);
  }

  /**
   * Finish every cleanup a purge left (a crash after its commit), then purge every removed member
   * whose grace period ended (and retry failures once a day).
   */
  async sweep(): Promise<{ purged: string[]; failed: string[] }> {
    const out = { purged: [] as string[], failed: [] as string[] };
    if (!this.#ready()) return out;
    for (const r of this.#rows())
      if (r.status === 'cleaning') await this.#serial(() => this.#finish(r.account_id));
    const days = await this.#o.graceDays();
    if (days <= 0) return out;
    const now = this.#now().getTime();
    for (const r of this.#rows()) {
      if (r.status === 'purged' || r.status === 'cleaning') continue;
      if (Date.parse(r.removed_at) + days * 86_400_000 > now) continue;
      if (r.status === 'failed' && r.attempted_at && Date.parse(r.attempted_at) + RETRY_MS > now)
        continue;
      const ok = await this.#serial(() => this.#purgeOne(r.account_id, 'grace', null));
      (ok ? out.purged : out.failed).push(r.account_id);
    }
    return out;
  }

  async #serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#running.then(fn, fn);
    this.#running = next.catch(() => undefined);
    return next;
  }

  async #purgeOne(
    accountId: string,
    cause: 'grace' | 'request',
    requestedBy: string | null,
  ): Promise<boolean> {
    const at = this.#now().toISOString();
    const actor = requestedBy ?? this.#o.team.ownerId();
    let purged: AccountRowsPurged;
    try {
      // The vault is read first: its entries of the purged rows are chosen by their ids below.
      const refs = this.#o.secrets ? await this.#o.secrets.list('secret://') : [];
      purged = await this.#db.transaction(() => {
        // Checked again inside: only a removed member, never the owner or a team agent.
        const ok = this.#db.raw
          .prepare(
            `SELECT 1 AS x FROM team_member m JOIN account a ON a.id = m.account_id
             WHERE m.account_id = ? AND m.role = 'member' AND m.removed_at IS NOT NULL
               AND a.deleted_at IS NOT NULL`,
          )
          .get(accountId);
        if (!ok) throw new NovaError('not_found', 'no such removed member');
        const out = purgeAccountRows(this.#db, accountId, at);
        // What is left outside the database is recorded with the rows' deletion: a crash before
        // it is removed leaves the next sweep a list to finish, never forgotten files.
        const cleanup: Cleanup = {
          blobs: out.blobs,
          secrets: secretsOfIds(refs, out.ids),
          folders: memberFolders(this.#o.dataDir, accountId),
        };
        this.#upsert(accountId, {
          status: 'cleaning',
          cause,
          requestedBy,
          at,
          purgedAt: at,
          counts: { rows: out.rows, blobs: 0, secrets: 0, folders: 0 },
          cleanup,
          error: null,
        });
        return out;
      });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.#log.error('purging a removed member failed', { err, accountId });
      await this.#db.transaction(() =>
        this.#upsert(accountId, {
          status: 'failed',
          cause,
          requestedBy,
          at,
          purgedAt: null,
          counts: null,
          cleanup: null,
          error: message,
        }),
      );
      await this.#auditPurge(actor, accountId, cause, 'error', { error: message });
      return false;
    }
    const total = Object.values(purged.rows).reduce((a, b) => a + b, 0);
    await this.#auditPurge(actor, accountId, cause, 'ok', {
      rows: total,
      tables: Object.keys(purged.rows).length,
      redactedMessages: purged.rows.redacted_messages ?? 0,
    });
    if (actor)
      await this.#o.events
        .emit({
          name: 'team.member.purged',
          actor: requestedBy ? 'user' : 'system',
          accountId: actor,
          payload: { accountId, cause, rows: total },
        })
        .catch((err: unknown) => this.#log.warn('purge event not recorded', { err }));
    await this.#finish(accountId);
    return true;
  }

  /**
   * Remove what a purge recorded outside the database: blobs nothing names any more, the purged
   * rows' vault entries, the member's folders. Every step can run again; a failure leaves the
   * record `cleaning` for the next sweep.
   */
  async #finish(accountId: string): Promise<void> {
    const row = this.#db.raw
      .prepare('SELECT counts_json, cleanup_json FROM member_purge WHERE account_id = ?')
      .get(accountId) as { counts_json: string | null; cleanup_json: string | null } | undefined;
    if (!row?.cleanup_json) return;
    let cleanup: Cleanup;
    let counts: MemberPurgeCounts;
    try {
      cleanup = JSON.parse(row.cleanup_json) as Cleanup;
      counts = row.counts_json
        ? (JSON.parse(row.counts_json) as MemberPurgeCounts)
        : { rows: {}, blobs: 0, secrets: 0, folders: 0 };
    } catch (err) {
      this.#log.error('a purge cleanup record is unreadable', { err, accountId });
      return;
    }
    try {
      counts.blobs += removeUnreferencedBlobs(this.#db, this.#o.dataDir, cleanup.blobs);
      if (this.#o.secrets)
        for (const ref of cleanup.secrets) if (await this.#o.secrets.delete(ref)) counts.secrets++;
      for (const dir of cleanup.folders) {
        if (!existsSync(dir)) continue;
        rmSync(dir, { recursive: true, force: true });
        counts.folders++;
      }
    } catch (err) {
      this.#log.warn('a purge cleanup was cut short; the next sweep finishes it', {
        err,
        accountId,
      });
      return;
    }
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE member_purge SET status = 'purged', cleanup_json = NULL, counts_json = ?
           WHERE account_id = ? AND status = 'cleaning'`,
        )
        .run(JSON.stringify(counts), accountId);
    });
  }

  #upsert(
    accountId: string,
    r: {
      status: 'cleaning' | 'purged' | 'failed';
      cause: 'grace' | 'request';
      requestedBy: string | null;
      at: string;
      purgedAt: string | null;
      counts: MemberPurgeCounts | null;
      cleanup: Cleanup | null;
      error: string | null;
    },
  ): void {
    this.#db.raw
      .prepare(
        `INSERT INTO member_purge (account_id, status, cause, requested_by, attempted_at,
           purged_at, counts_json, cleanup_json, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id) DO UPDATE SET status = excluded.status,
           cause = excluded.cause, requested_by = excluded.requested_by,
           attempted_at = excluded.attempted_at, purged_at = excluded.purged_at,
           counts_json = excluded.counts_json, cleanup_json = excluded.cleanup_json,
           error = excluded.error`,
      )
      .run(
        accountId,
        r.status,
        r.cause,
        r.requestedBy,
        r.at,
        r.purgedAt,
        r.counts ? JSON.stringify(r.counts) : null,
        r.cleanup ? JSON.stringify(r.cleanup) : null,
        r.error,
      );
  }

  async #auditPurge(
    actor: string | null,
    accountId: string,
    cause: 'grace' | 'request',
    result: 'ok' | 'error',
    detail: Record<string, unknown>,
  ): Promise<void> {
    if (!actor) return;
    try {
      await this.#o.audit?.append({
        accountId: actor,
        actor: cause === 'request' ? 'user' : 'system',
        kind: 'auth',
        action: 'team.member.purge',
        resource: `account:${accountId}`,
        result,
        detail: { cause, ...detail },
      });
    } catch (err) {
      this.#log.warn('purge audit not recorded', { err });
    }
  }
}
