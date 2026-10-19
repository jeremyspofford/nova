// Shared threads (FR-217): the owner of a thread shares it with other people of the Hub, and each
// of them reads it and writes in it. The thread stays in its owner's account; a turn runs under
// the account of whoever wrote (their providers, policy, approvals and audit: the ChatService's
// `ChatAccess` seam). Nobody's personal context joins a shared thread: no memory or past chats
// (the loop leaves them out, and the thread is memory opt-out so nothing said there is
// remembered), no user instructions, skills or app context, and none of anyone's files, network or
// private connectors: only content-producing tools (the gate's tool limits). Every message records
// who wrote it, so the thread shows who said what, and only its writer may drop a queued one.
import {
  NovaError,
  type EventEnvelope,
  type EventHandler,
  type MessageView,
  type SharedAuthorView,
  type SharedThreadDetailView,
  type SharedThreadView,
  type TeamPersonView,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { ThreadToolLimits, ToolLimitSource } from '../approvals/limits.ts';
import type { ChatAccess } from '../chat.ts';
import type { EventSink } from '../events.ts';
import type { ThreadService } from '../threads.ts';
import type { AuditSink } from '../tools/types.ts';
import type { TeamService } from './members.ts';

/**
 * What a shared thread may use (finding 6 of the M7 identity review): other participants' messages
 * are not the acting person's instructions, so nothing there reaches the acting person's machine,
 * files, network or private integrations. Only tools that produce content from the conversation
 * itself remain: web search, artifacts and documents it writes, visualizations, images, and the
 * loop's own tools. Everything else (files, commands, Git, the browser, `web.fetch`, connectors,
 * channels, devices, agents) is denied outright and hidden from the listing.
 */
export const SHARED_THREAD_LIMITS: ThreadToolLimits = {
  sources: ['builtin'],
  allow: [
    'web.search',
    'artifact.create',
    'document.create',
    'visualize.create',
    'image.generate',
    'tool.search',
    'context.remaining',
    'context.fresh',
  ],
  reason: "a shared thread does not reach anyone's files, network or private connectors",
};

/** Events of a shared thread every participant receives; others go only to their own account. */
const SHARED_EVENTS = ['chat.', 'turn.', 'thread.', 'tool.call.', 'context.'];

export interface SharedThreadServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  threads: ThreadService;
  team: TeamService;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
}

export interface Sharing {
  ownerAccountId: string;
  participants: string[];
  sharedAt: string;
}

export interface SharedEventSource {
  subscribe(pattern: string, handler: EventHandler): () => void;
}

export class SharedThreadService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #threads: ThreadService;
  readonly #team: TeamService;
  #audit: AuditSink | undefined;
  readonly #log: Logger;
  readonly #now: () => Date;
  #off: (() => void) | null = null;

  /** For the ChatService (`chat.useAccess`). */
  readonly access: ChatAccess;
  /** For the gate (`gate.useToolLimits`): no private connectors in a shared thread. */
  readonly toolLimits: ToolLimitSource;

  constructor(opts: SharedThreadServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#threads = opts.threads;
    this.#team = opts.team;
    this.#audit = opts.audit;
    this.#log = opts.log ?? new Logger({ module: 'core.team.shared', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.access = {
      sharing: (threadId) => Promise.resolve(this.sharing(threadId)),
      readsUserInstructions: (accountId) => Promise.resolve(this.#team.isOwner(accountId)),
    };
    this.toolLimits = {
      forThread: (_accountId, threadId) =>
        Promise.resolve(this.sharing(threadId) ? SHARED_THREAD_LIMITS : null),
    };
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  /**
   * Record who wrote each user message of a shared thread, whatever path it took (the team
   * routes, the thread routes, a queued message, a steer): the loop's event names the account.
   */
  start(bus: SharedEventSource): () => void {
    this.#off?.();
    this.#off = bus.subscribe('chat.message.created', (e) => this.#onMessage(e));
    return () => this.stop();
  }

  stop(): void {
    this.#off?.();
    this.#off = null;
  }

  #onMessage(e: EventEnvelope): void {
    const p = e.payload as { threadId?: unknown; messageId?: unknown; role?: unknown };
    if (p.role !== 'user' || typeof p.threadId !== 'string' || typeof p.messageId !== 'string')
      return;
    if (!e.accountId || !this.sharing(p.threadId)) return;
    try {
      this.#db.raw
        .prepare(
          `INSERT INTO shared_message (message_id, thread_id, account_id, created_at)
           VALUES (?, ?, ?, ?) ON CONFLICT (message_id) DO NOTHING`,
        )
        .run(p.messageId, p.threadId, e.accountId, e.ts);
    } catch (err) {
      this.#log.warn('could not record who wrote a shared message', { err });
    }
  }

  /** The thread's owner and the others it is shared with; null when it is not shared. */
  sharing(threadId: string): Sharing | null {
    const rows = this.#db.raw
      .prepare(
        `SELECT s.account_id, s.owner_account_id, s.created_at FROM thread_share s
         JOIN account a ON a.id = s.account_id
         WHERE s.thread_id = ? AND a.deleted_at IS NULL ORDER BY s.created_at`,
      )
      .all(threadId) as { account_id: string; owner_account_id: string; created_at: string }[];
    const first = rows[0];
    if (!first) return null;
    return {
      ownerAccountId: first.owner_account_id,
      participants: rows.map((r) => r.account_id),
      sharedAt: first.created_at,
    };
  }

  /** The sharing of a thread the account owns or takes part in; `not_found` otherwise. */
  #access(accountId: string, threadId: string): Sharing {
    const s = this.sharing(threadId);
    if (!s || (s.ownerAccountId !== accountId && !s.participants.includes(accountId)))
      throw new NovaError('not_found', 'thread not found');
    return s;
  }

  canSee(accountId: string, threadId: string): boolean {
    const s = this.sharing(threadId);
    return !!s && (s.ownerAccountId === accountId || s.participants.includes(accountId));
  }

  /** The thread's owner shares it with other people of the Hub. */
  async share(
    actor: string,
    threadId: string,
    accountIds: readonly string[],
  ): Promise<SharedThreadView> {
    this.#team.assertPerson(actor);
    const row = await this.#threads.row(actor, threadId);
    if (row.mode !== 'chat' || row.temporary || row.side || row.projectId)
      throw new NovaError('validation', 'only a chat outside a project can be shared', {
        details: { reason: 'not_shareable' },
      });
    const ids = [...new Set(accountIds)].filter((id) => id !== actor);
    if (!ids.length) throw new NovaError('validation', 'name someone to share the thread with');
    const unknown = ids.filter((id) => !this.#team.roleOf(id));
    if (unknown.length)
      throw new NovaError('validation', 'these accounts are not people of this Hub', {
        details: { reason: 'not_a_person', accountIds: unknown },
      });
    // Nothing said in a shared thread becomes anyone's memory (FR-217).
    if (!row.memoryOptOut) await this.#threads.update(actor, threadId, { memoryOptOut: true });
    const at = this.#now().toISOString();
    const added = await this.#db.transaction(() => {
      let n = 0;
      const ins = this.#db.raw.prepare(
        `INSERT INTO thread_share (thread_id, account_id, owner_account_id, shared_by, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (thread_id, account_id) DO NOTHING`,
      );
      for (const id of ids) n += Number(ins.run(threadId, id, actor, actor, at).changes);
      // What was said before sharing was said by the owner.
      this.#db.raw
        .prepare(
          `INSERT INTO shared_message (message_id, thread_id, account_id, created_at)
           SELECT id, thread_id, ?, created_at FROM message WHERE thread_id = ? AND role = 'user'
           ON CONFLICT (message_id) DO NOTHING`,
        )
        .run(actor, threadId);
      return n;
    });
    const s = this.sharing(threadId)!;
    if (added) {
      for (const accountId of new Set([actor, ...s.participants]))
        await this.#emit(accountId, threadId, s);
      await this.#auditShare(actor, 'thread.share', threadId, { with: ids });
    }
    return this.view(actor, threadId);
  }

  /** The owner takes someone out of the thread, or a participant leaves it. */
  async unshare(actor: string, threadId: string, accountId: string): Promise<void> {
    const s = this.#access(actor, threadId);
    if (actor !== s.ownerAccountId && actor !== accountId)
      throw new NovaError('policy_denied', "only the thread's owner can take others out of it", {
        details: { reason: 'owner_only' },
      });
    if (!s.participants.includes(accountId)) throw new NovaError('not_found', 'not a participant');
    await this.#db.transaction(() =>
      this.#db.raw
        .prepare('DELETE FROM thread_share WHERE thread_id = ? AND account_id = ?')
        .run(threadId, accountId),
    );
    const after = this.sharing(threadId) ?? { ...s, participants: [] };
    for (const id of new Set([s.ownerAccountId, accountId, ...after.participants]))
      await this.#emit(id, threadId, after);
    await this.#auditShare(actor, 'thread.unshare', threadId, { removed: accountId });
  }

  async #emit(accountId: string, threadId: string, s: Sharing): Promise<void> {
    try {
      await this.#events.emit({
        name: 'thread.shared',
        actor: 'user',
        accountId,
        correlation: { threadId },
        payload: { threadId, ownerAccountId: s.ownerAccountId, participants: s.participants },
      });
    } catch (err) {
      this.#log.warn('thread.shared not recorded', { err, threadId });
    }
  }

  #person(accountId: string): TeamPersonView {
    return (
      this.#team.person(accountId) ?? {
        accountId,
        displayName: null,
        username: null,
        role: 'member',
        hasAvatar: false,
      }
    );
  }

  async view(accountId: string, threadId: string): Promise<SharedThreadView> {
    const s = this.#access(accountId, threadId);
    return {
      thread: await this.#threads.view(s.ownerAccountId, threadId),
      owner: this.#person(s.ownerAccountId),
      participants: s.participants.map((id) => this.#person(id)),
      you: accountId === s.ownerAccountId ? 'owner' : 'participant',
      sharedAt: s.sharedAt,
    };
  }

  /** Threads shared with the account and threads it shares, newest activity first. */
  async list(accountId: string): Promise<SharedThreadView[]> {
    const rows = this.#db.raw
      .prepare(
        `SELECT DISTINCT s.thread_id FROM thread_share s JOIN thread t ON t.id = s.thread_id
         WHERE (s.account_id = ? OR s.owner_account_id = ?) AND t.deleted_at IS NULL
         ORDER BY t.updated_at DESC LIMIT 200`,
      )
      .all(accountId, accountId) as { thread_id: string }[];
    const out: SharedThreadView[] = [];
    for (const r of rows) {
      try {
        out.push(await this.view(accountId, r.thread_id));
      } catch {
        // its owner left meanwhile
      }
    }
    return out;
  }

  /** The thread with its messages and who wrote each (a reply names who asked for it). */
  async detail(accountId: string, threadId: string): Promise<SharedThreadDetailView> {
    const view = await this.view(accountId, threadId);
    const d = await this.#threads.detail(view.owner.accountId, threadId);
    return {
      ...view,
      messages: d.messages,
      authors: this.#authors(view.owner.accountId, d.messages),
    };
  }

  #authors(ownerId: string, messages: readonly MessageView[]): Record<string, SharedAuthorView> {
    const out: Record<string, SharedAuthorView> = {};
    if (!messages.length) return out;
    const ids = messages.map((m) => m.id);
    const turnIds = [...new Set(messages.flatMap((m) => (m.turnId ? [m.turnId] : [])))];
    const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ');
    const by = new Map(
      (
        this.#db.raw
          .prepare(
            `SELECT message_id, account_id FROM shared_message WHERE message_id IN (${marks(ids.length)})`,
          )
          .all(...ids) as { message_id: string; account_id: string }[]
      ).map((r) => [r.message_id, r.account_id]),
    );
    // A turn was asked for by whoever wrote its first user message.
    const askedBy = new Map<string, string>();
    if (turnIds.length) {
      const rows = this.#db.raw
        .prepare(
          `SELECT m.turn_id, s.account_id FROM message m JOIN shared_message s ON s.message_id = m.id
           WHERE m.turn_id IN (${marks(turnIds.length)}) AND m.role = 'user'
           ORDER BY m.created_at DESC`,
        )
        .all(...turnIds) as { turn_id: string; account_id: string }[];
      for (const r of rows) askedBy.set(r.turn_id, r.account_id);
    }
    const names = new Map<string, string | null>();
    const nameOf = (id: string) => {
      if (!names.has(id)) names.set(id, this.#team.person(id)?.displayName ?? null);
      return names.get(id) ?? null;
    };
    for (const m of messages) {
      if (m.role === 'user') {
        const id = by.get(m.id) ?? ownerId;
        out[m.id] = { accountId: id, displayName: nameOf(id), as: 'wrote' };
      } else if (m.role === 'assistant') {
        const id = (m.turnId && askedBy.get(m.turnId)) ?? ownerId;
        out[m.id] = { accountId: id, displayName: nameOf(id), as: 'asked' };
      }
    }
    return out;
  }

  /**
   * A live event of a shared thread the account may receive: what happens in the conversation
   * goes to everyone in it; approvals, requests and the like only to the person they are for.
   */
  visible(accountId: string, threadId: string, e: EventEnvelope): boolean {
    if (e.correlation?.threadId !== threadId) return false;
    if (e.accountId === accountId) return true;
    return SHARED_EVENTS.some((p) => e.name.startsWith(p));
  }

  async #auditShare(
    actor: string,
    action: string,
    threadId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#audit?.append({
        accountId: actor,
        actor: 'user',
        kind: 'auth',
        action,
        resource: `thread:${threadId}`,
        threadId,
        detail,
      });
    } catch (err) {
      this.#log.warn('share audit not recorded', { err, action });
    }
  }
}
