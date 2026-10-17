// The browser's Activity trace (FR-098, docs/11 §9): every action is a `browser_action` row with
// its before/after screenshots stored under `blobs/screenshots/<yyyymmdd>/<id>.png`, and a
// persisted `browser.action` event with the call's correlation so the trace can link it. Targets
// and errors are redacted and clipped (typed text is never stored, only its length). Screenshots
// are kept for `browser.screenshotRetentionDays` (default 30) and then deleted by `sweep`.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  NovaError,
  uuidv7,
  type BrowserActionResult,
  type BrowserActionView,
  type BrowserClassificationView,
} from '@nova/shared';
import { defaultRedactor, resolveWithin } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { readSealedFile, writeSealedFile } from '../attachments.ts';
import type { EventSink } from '../events.ts';

export interface RecordInput {
  accountId: string;
  computerId: string;
  threadId: string | null;
  turnId: string | null;
  callId: string | null;
  tool: string;
  action: string;
  target: string | null;
  url: string | null;
  host: string | null;
  result: BrowserActionResult;
  error?: string | null;
  classification?: BrowserClassificationView | null;
  before?: Uint8Array | null;
  after?: Uint8Array | null;
  approvalId?: string | null;
}

interface ActionRow {
  id: string;
  account_id: string;
  computer_id: string;
  thread_id: string | null;
  turn_id: string | null;
  call_id: string | null;
  tool: string;
  action: string;
  target: string | null;
  url: string | null;
  host: string | null;
  result: BrowserActionResult;
  error: string | null;
  classification_json: string | null;
  before_path: string | null;
  after_path: string | null;
  approval_id: string | null;
  created_at: string;
}

function clip(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const t = defaultRedactor.redactString(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A URL without its query and fragment (they often carry tokens). */
export function traceUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return clip(`${u.origin}${u.pathname}`, 500);
  } catch {
    return clip(url, 500);
  }
}

function view(r: ActionRow): BrowserActionView {
  let classification: BrowserClassificationView | null = null;
  if (r.classification_json) {
    try {
      classification = JSON.parse(r.classification_json) as BrowserClassificationView;
    } catch {
      classification = null;
    }
  }
  return {
    id: r.id,
    computerId: r.computer_id,
    threadId: r.thread_id,
    turnId: r.turn_id,
    callId: r.call_id,
    tool: r.tool,
    action: r.action,
    target: r.target,
    url: r.url,
    host: r.host,
    result: r.result,
    error: r.error,
    classification,
    before: r.before_path !== null,
    after: r.after_path !== null,
    approvalId: r.approval_id,
    createdAt: r.created_at,
  };
}

export interface BrowserRecorderOptions {
  db: NovaDatabase;
  dataDir: string;
  events: EventSink;
  now?: () => Date;
}

export class BrowserRecorder {
  readonly #db: NovaDatabase;
  readonly #dataDir: string;
  readonly #events: EventSink;
  readonly #now: () => Date;

  constructor(opts: BrowserRecorderOptions) {
    this.#db = opts.db;
    this.#dataDir = opts.dataDir;
    this.#events = opts.events;
    this.#now = opts.now ?? (() => new Date());
  }

  /** Store a PNG; returns its path relative to the data directory. */
  #save(id: string, which: 'before' | 'after', bytes: Uint8Array, at: Date): string {
    const day = at.toISOString().slice(0, 10).replace(/-/g, '');
    const rel = `blobs/screenshots/${day}/${id}-${which}.png`;
    // Sealed with the data key like every blob (docs/12 §5); the path is the label.
    writeSealedFile(this.#dataDir, join(this.#dataDir, rel), rel, Buffer.from(bytes));
    return rel;
  }

  async record(input: RecordInput): Promise<BrowserActionView> {
    const id = uuidv7();
    const at = this.#now();
    const before = input.before?.length ? this.#save(id, 'before', input.before, at) : null;
    const after = input.after?.length ? this.#save(id, 'after', input.after, at) : null;
    const row: ActionRow = {
      id,
      account_id: input.accountId,
      computer_id: input.computerId,
      thread_id: input.threadId,
      turn_id: input.turnId,
      call_id: input.callId,
      tool: input.tool,
      action: input.action,
      target: clip(input.target, 300),
      url: traceUrl(input.url),
      host: input.host,
      result: input.result,
      error: clip(input.error, 1000),
      classification_json: input.classification ? JSON.stringify(input.classification) : null,
      before_path: before,
      after_path: after,
      approval_id: input.approvalId ?? null,
      created_at: at.toISOString(),
    };
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO browser_action (id, account_id, computer_id, thread_id, turn_id, call_id, tool,
             action, target, url, host, result, error, classification_json, before_path, after_path,
             approval_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.account_id,
          row.computer_id,
          row.thread_id,
          row.turn_id,
          row.call_id,
          row.tool,
          row.action,
          row.target,
          row.url,
          row.host,
          row.result,
          row.error,
          row.classification_json,
          row.before_path,
          row.after_path,
          row.approval_id,
          row.created_at,
        );
    });
    const correlation: Record<string, string> = {};
    if (input.threadId) correlation.threadId = input.threadId;
    if (input.turnId) correlation.turnId = input.turnId;
    if (input.callId) correlation.callId = input.callId;
    await this.#events.emit({
      name: 'browser.action',
      accountId: input.accountId,
      actor: 'system',
      ...(Object.keys(correlation).length ? { correlation } : {}),
      payload: {
        computerId: input.computerId,
        actionId: id,
        tool: input.tool,
        action: input.action,
        target: row.target,
        result: input.result,
        before: before !== null,
        after: after !== null,
      },
    });
    return view(row);
  }

  list(
    accountId: string,
    q: { threadId?: string; callId?: string; computerId?: string; limit?: number } = {},
  ): BrowserActionView[] {
    const where = ['account_id = ?'];
    const args: (string | number)[] = [accountId];
    if (q.threadId) {
      where.push('thread_id = ?');
      args.push(q.threadId);
    }
    if (q.callId) {
      where.push('call_id = ?');
      args.push(q.callId);
    }
    if (q.computerId) {
      where.push('computer_id = ?');
      args.push(q.computerId);
    }
    args.push(q.limit ?? 100);
    const rows = this.#db.raw
      .prepare(
        `SELECT * FROM browser_action WHERE ${where.join(' AND ')} ORDER BY created_at, id LIMIT ?`,
      )
      .all(...args) as unknown as ActionRow[];
    return rows.map(view);
  }

  /** A recorded screenshot's bytes; `not_found` for another account or a swept file. */
  screenshot(accountId: string, id: string, which: 'before' | 'after'): Buffer {
    const row = this.#db.raw
      .prepare('SELECT before_path, after_path FROM browser_action WHERE id = ? AND account_id = ?')
      .get(id, accountId) as { before_path: string | null; after_path: string | null } | undefined;
    const rel = which === 'before' ? row?.before_path : row?.after_path;
    if (!rel) throw new NovaError('not_found', 'no such screenshot');
    try {
      return readSealedFile(this.#dataDir, resolveWithin([this.#dataDir], rel), rel);
    } catch {
      throw new NovaError('not_found', 'the screenshot is no longer stored');
    }
  }

  /** Delete screenshots older than the retention; the trace rows stay. Returns files removed. */
  async sweep(retentionDays: number): Promise<number> {
    const cutoff = new Date(this.#now().getTime() - retentionDays * 86_400_000).toISOString();
    const rows = this.#db.raw
      .prepare(
        `SELECT id, before_path, after_path FROM browser_action
         WHERE created_at < ? AND (before_path IS NOT NULL OR after_path IS NOT NULL)`,
      )
      .all(cutoff) as { id: string; before_path: string | null; after_path: string | null }[];
    let removed = 0;
    for (const r of rows) {
      for (const rel of [r.before_path, r.after_path]) {
        if (!rel) continue;
        try {
          rmSync(resolveWithin([this.#dataDir], rel), { force: true });
          removed++;
        } catch {
          // A path that escapes the data directory is never touched.
        }
      }
    }
    if (rows.length)
      await this.#db.transaction(() => {
        const stmt = this.#db.raw.prepare(
          'UPDATE browser_action SET before_path = NULL, after_path = NULL WHERE id = ?',
        );
        for (const r of rows) stmt.run(r.id);
      });
    return removed;
  }
}
