// One account's data, for an account-scoped export (FR-105, ADR-097 D5; the team area offers it
// before a removed member's purge). It works on a private copy of the database: the account's
// rows are marked, everything else is deleted from the copy, and the copy is exported like a Hub.
//
// Which rows are the account's, table by table (the schema is walked, so a table added later is
// decided by the same rules):
// - every row of a table with an `account_id` column naming the account: its chats, projects,
//   memory, runs and goals, agents, artifacts, spaces and sites, plugins and skills it installed,
//   MCP servers and connectors (references only), channels, devices, schedules, its own settings
//   (`member_setting`), its profile card, its sessions and tokens (hashes), its usage records, its
//   audit entries and its stored events;
// - the account row itself;
// - rows hanging off those rows by foreign key, at any depth, when they have no `account_id` of
//   their own or name the same account: messages and their parts, attachments, citations, turns,
//   tool calls, artifact versions, run steps, sub-agents, code changes and reviews, page versions,
//   and so on.
// Never included: another account's rows (a row with an `account_id` that names someone else is
// never reached), the Hub's own tables without an `account_id` (Hub settings, feature flags, the
// Hub's identity, CA and certificates, sync state), the purge bookkeeping (`member_purge`), the
// member's words in another account's shared chat (that chat is its owner's; their authorship rows
// come, the messages do not), tasks they gave a team agent (the agent's work), and vault secrets
// (their references are listed to re-enter).
//
// Files: blobs the kept rows name (any blob-path column, queued inputs' attachments), the account's
// own folders (its member workspace, plugin drafts, extension data, agent browser profiles) and the
// folders of kept rows that name one (computers, Code sessions and handoffs, MCP servers, computer
// snapshots), and screenshots of kept browser actions.
import type { DatabaseSync } from 'node:sqlite';
import { parseAttachments } from '../followups.ts';
import { quoteIdent as q, storedTables } from './codec.ts';

/** Tables an account export never carries, whatever names the account. */
export const ACCOUNT_EXPORT_SKIPS: ReadonlySet<string> = new Set(['member_purge']);

const BLOB_COLUMN = /(^|_)(blob_path|avatar_path|blob)$/;

interface Fk {
  child: string;
  from: string;
  parent: string;
  to: string;
}

export interface AccountSelection {
  /** Rows kept per table. */
  rows: Record<string, number>;
  /** Exact data-folder paths of files the kept rows name. */
  files: Set<string>;
  /** Data-folder prefixes (ending in '/') whose files are the account's. */
  folders: string[];
}

function hasColumn(cols: Map<string, string[]>, table: string, column: string): boolean {
  return cols.get(table)?.includes(column) ?? false;
}

/**
 * Keep only the account's rows in `db` (a private, writable copy of the database). Returns what
 * was kept and the files that go with it.
 */
export function narrowToAccount(db: DatabaseSync, accountId: string): AccountSelection {
  const { tables } = storedTables(db);
  const cols = new Map<string, string[]>();
  const pks = new Map<string, string>();
  for (const t of tables) {
    const info = db.prepare(`PRAGMA table_info(${q(t)})`).all() as { name: string; pk: number }[];
    cols.set(
      t,
      info.map((c) => c.name),
    );
    pks.set(t, info.find((c) => c.pk === 1)?.name ?? 'rowid');
  }
  const fks: Fk[] = [];
  for (const t of tables)
    for (const f of db.prepare(`PRAGMA foreign_key_list(${q(t)})`).all() as {
      table: string;
      from: string;
      to: string | null;
    }[]) {
      if (!cols.has(f.table)) continue;
      fks.push({ child: t, from: f.from, parent: f.table, to: f.to ?? pks.get(f.table)! });
    }

  const keep = (t: string) => `temp.${q(`keep_${t}`)}`;
  for (const t of tables) db.exec(`CREATE TEMP TABLE ${keep(t)} (rid INTEGER PRIMARY KEY)`);
  // Seeds: the account row and every row naming the account.
  if (cols.has('account'))
    db.prepare(
      `INSERT OR IGNORE INTO ${keep('account')} SELECT rowid FROM account WHERE id = ?`,
    ).run(accountId);
  for (const t of tables) {
    if (ACCOUNT_EXPORT_SKIPS.has(t) || !hasColumn(cols, t, 'account_id')) continue;
    db.prepare(
      `INSERT OR IGNORE INTO ${keep(t)} SELECT rowid FROM ${q(t)} WHERE account_id = ?`,
    ).run(accountId);
  }
  // Rows hanging off kept rows, until nothing more is added. A row naming another account is
  // never taken, however it is reached.
  for (let round = 0; round < 64; round++) {
    let added = 0;
    for (const fk of fks) {
      if (ACCOUNT_EXPORT_SKIPS.has(fk.child)) continue;
      const own = hasColumn(cols, fk.child, 'account_id') ? ' AND c.account_id = ?' : '';
      const sql = `INSERT OR IGNORE INTO ${keep(fk.child)}
        SELECT c.rowid FROM ${q(fk.child)} c
        WHERE c.${q(fk.from)} IN (SELECT p.${q(fk.to)} FROM ${q(fk.parent)} p
                                 WHERE p.rowid IN (SELECT rid FROM ${keep(fk.parent)}))${own}`;
      const stmt = db.prepare(sql);
      added += Number((own ? stmt.run(accountId) : stmt.run()).changes);
    }
    if (!added) break;
  }

  // Everything else leaves the copy (append-only guards and foreign keys do not apply to it).
  db.exec('PRAGMA foreign_keys = OFF');
  for (const g of db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%RAISE(%'")
    .all() as { name: string }[])
    db.exec(`DROP TRIGGER ${q(g.name)}`);
  const rows: Record<string, number> = {};
  for (const t of tables) {
    db.prepare(`DELETE FROM ${q(t)} WHERE rowid NOT IN (SELECT rid FROM ${keep(t)})`).run();
    const n = Number((db.prepare(`SELECT count(*) AS n FROM ${q(t)}`).get() as { n: number }).n);
    if (n) rows[t] = n;
  }

  // The files the kept rows name.
  const files = new Set<string>();
  for (const t of tables)
    for (const c of cols.get(t) ?? [])
      if (BLOB_COLUMN.test(c))
        for (const r of db
          .prepare(`SELECT ${q(c)} AS p FROM ${q(t)} WHERE ${q(c)} IS NOT NULL`)
          .all() as { p: unknown }[])
          if (typeof r.p === 'string') files.add(r.p);
  if (cols.has('queued_input'))
    for (const r of db.prepare('SELECT attachments FROM queued_input').all() as {
      attachments: string | null;
    }[])
      for (const a of parseAttachments(r.attachments)) files.add(a.blobPath);

  const safe = accountId.replace(/[^A-Za-z0-9_-]/g, '_');
  const folders = [
    `members/${accountId}/`,
    `plugins-drafts/${safe}/`,
    `extensions/data/${accountId}/`,
    `extensions/bundles/${accountId}/`,
    `browser/profiles/${accountId}/`,
    `browser/fallback/${accountId}/`,
  ];
  const idsOf = (table: string) =>
    cols.has(table)
      ? (db.prepare(`SELECT id FROM ${q(table)}`).all() as { id: unknown }[])
          .map((r) => r.id)
          .filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_.:-]+$/.test(id))
      : [];
  for (const id of idsOf('computer')) folders.push(`computers/${id}/`, `blobs/snapshots/${id}/`);
  for (const id of idsOf('code_session')) folders.push(`code/${id}/`);
  for (const id of idsOf('session_handoff')) folders.push(`code/handoffs/${id}/`);
  for (const id of idsOf('mcp_server')) folders.push(`mcp/${id}/`);
  // A browser action's screenshots are named after it.
  for (const id of idsOf('browser_action')) folders.push(`blobs/screenshots/*/${id}-`);
  return { rows, files, folders };
}

/** Whether a data-folder file belongs to the selection. */
export function selectedFile(sel: AccountSelection, path: string): boolean {
  if (sel.files.has(path)) return true;
  for (const f of sel.folders) {
    const star = f.indexOf('*');
    if (star < 0) {
      if (path.startsWith(f)) return true;
      continue;
    }
    // `blobs/screenshots/*/<id>-`: one folder level, then a name starting with the rest.
    const head = f.slice(0, star);
    const tail = f.slice(star + 2);
    if (!path.startsWith(head)) continue;
    const rest = path.slice(head.length).split('/');
    if (rest.length === 2 && rest[1]!.startsWith(tail)) return true;
  }
  return false;
}
