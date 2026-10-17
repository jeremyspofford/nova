// Spaces and Pages (FR-036): Markdown pages the user and agents co-edit. Every save is a version
// (restorable); a save names the version it was based on and a stale base is a conflict that hands
// back the newer page, never a silent overwrite. Comments anchor to the page, a range or a block
// and move forward with every save. Agent edits follow the space's setting: a proposal the user
// accepts or rejects, or a direct version (still restorable). Agent text never authorizes anything
// (FR-189); it is content.
import {
  NovaError,
  uuidv7,
  type CommentAnchor,
  type PageAuthorKind,
  type PageCommentView,
  type PageProposalView,
  type PageSummaryView,
  type PageVersionView,
  type PageView,
  type SpaceAgentEdits,
  type SpaceView,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import type { EventSink } from '../events.ts';
import { noopAudit, type AuditSink } from '../tools/types.ts';
import { checkAnchor, reanchor } from './anchors.ts';

/** Who made a change: the signed-in user, or an agent in a thread (its provenance). */
export type Author =
  { kind: 'user' } | { kind: 'agent'; threadId: string | null; turnId: string | null };

export const USER: Author = { kind: 'user' };

export interface SpaceServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  audit?: AuditSink;
  now?: () => Date;
  /** How agent edits land in a new space when the request does not say (setting). */
  defaultAgentEdits?: () => Promise<SpaceAgentEdits>;
}

interface SpaceRow {
  id: string;
  account_id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  agent_edits: SpaceAgentEdits;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface PageRow {
  id: string;
  space_id: string;
  account_id: string;
  title: string;
  slug: string;
  position: number;
  version: number;
  content: string;
  updated_by: PageAuthorKind;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface VersionRow {
  page_id: string;
  version: number;
  title: string;
  content: string;
  author_kind: PageAuthorKind;
  author_ref: string | null;
  turn_id: string | null;
  summary: string | null;
  restored_from: number | null;
  proposal_id: string | null;
  created_at: string;
}

interface CommentRow {
  id: string;
  page_id: string;
  account_id: string;
  parent_id: string | null;
  author_kind: PageAuthorKind;
  author_ref: string | null;
  body: string;
  anchor_json: string;
  version: number;
  detached: number;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ProposalRow {
  id: string;
  space_id: string;
  page_id: string | null;
  account_id: string;
  base_version: number | null;
  title: string;
  content: string;
  summary: string | null;
  author_ref: string | null;
  turn_id: string | null;
  status: 'open' | 'accepted' | 'rejected';
  decided_at: string | null;
  created_at: string;
}

export interface CreateSpaceInput {
  name: string;
  description?: string | null | undefined;
  projectId?: string | null | undefined;
  agentEdits?: SpaceAgentEdits | undefined;
}

export interface SavePageInput {
  baseVersion: number;
  title?: string | undefined;
  content?: string | undefined;
  summary?: string | undefined;
}

export interface ProposeInput {
  pageId: string | null;
  baseVersion: number | null;
  title: string;
  content: string;
  summary?: string | null | undefined;
}

/** A URL-safe file name from a title. */
export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/, '');
  return s || 'page';
}

export class SpaceService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  #audit: AuditSink;
  readonly #now: () => Date;
  readonly #defaultEdits: () => Promise<SpaceAgentEdits>;

  constructor(opts: SpaceServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#audit = opts.audit ?? noopAudit;
    this.#now = opts.now ?? (() => new Date());
    this.#defaultEdits = opts.defaultAgentEdits ?? (() => Promise.resolve('propose'));
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  // ---- spaces ------------------------------------------------------------------------------------

  /** Whether the account has any space (the page tools are offered only then). */
  hasSpaces(accountId: string): boolean {
    return (
      this.#get<{ id: string }>(
        'SELECT id FROM space WHERE account_id = ? AND deleted_at IS NULL LIMIT 1',
        accountId,
      ) !== undefined
    );
  }

  listSpaces(accountId: string): Promise<SpaceView[]> {
    return this.#sync(() => {
      const rows = this.#all<SpaceRow>(
        'SELECT * FROM space WHERE account_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC, id',
        accountId,
      );
      return rows.map((r) => this.#spaceView(r));
    });
  }

  async createSpace(accountId: string, input: CreateSpaceInput): Promise<SpaceView> {
    if (input.projectId) {
      const p = this.#get<{ id: string }>(
        'SELECT id FROM project WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
        input.projectId,
        accountId,
      );
      if (!p) throw new NovaError('not_found', 'project not found');
    }
    const id = uuidv7();
    const now = this.#stamp();
    const edits = input.agentEdits ?? (await this.#defaultEdits());
    await this.#db.transaction(() => {
      this.#run(
        `INSERT INTO space (id, account_id, project_id, name, description, agent_edits, created_at,
           updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        accountId,
        input.projectId ?? null,
        input.name.trim(),
        input.description ?? null,
        edits,
        now,
        now,
      );
    });
    await this.#emit('space.created', accountId, { spaceId: id }, USER);
    return this.getSpace(accountId, id);
  }

  getSpace(accountId: string, id: string): Promise<SpaceView> {
    return this.#sync(() => {
      return this.#spaceView(this.#space(accountId, id));
    });
  }

  async updateSpace(
    accountId: string,
    id: string,
    patch: {
      name?: string | undefined;
      description?: string | null | undefined;
      agentEdits?: SpaceAgentEdits | undefined;
    },
  ): Promise<SpaceView> {
    const row = this.#space(accountId, id);
    const now = this.#stamp();
    await this.#db.transaction(() => {
      this.#run(
        'UPDATE space SET name = ?, description = ?, agent_edits = ?, updated_at = ? WHERE id = ?',
        patch.name?.trim() ?? row.name,
        patch.description === undefined ? row.description : patch.description,
        patch.agentEdits ?? row.agent_edits,
        now,
        id,
      );
    });
    await this.#emit('space.updated', accountId, { spaceId: id }, USER);
    return this.getSpace(accountId, id);
  }

  /** Soft-delete a space and its pages; open proposals end as rejected. */
  async deleteSpace(accountId: string, id: string): Promise<void> {
    const row = this.#space(accountId, id);
    const now = this.#stamp();
    await this.#db.transaction(() => {
      this.#run('UPDATE space SET deleted_at = ?, updated_at = ? WHERE id = ?', now, now, id);
      this.#run(
        'UPDATE space_page SET deleted_at = ?, updated_at = ? WHERE space_id = ? AND deleted_at IS NULL',
        now,
        now,
        id,
      );
      this.#run(
        "UPDATE space_proposal SET status = 'rejected', decided_at = ? WHERE space_id = ? AND status = 'open'",
        now,
        id,
      );
    });
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: 'space.deleted',
      resource: `space:${id}`,
      result: 'ok',
      detail: { name: row.name },
    });
    await this.#emit('space.deleted', accountId, { spaceId: id }, USER);
  }

  // ---- pages -------------------------------------------------------------------------------------

  listPages(accountId: string, spaceId: string): Promise<PageSummaryView[]> {
    return this.#sync(() => {
      this.#space(accountId, spaceId);
      const rows = this.#all<PageRow>(
        'SELECT * FROM space_page WHERE space_id = ? AND deleted_at IS NULL ORDER BY position, created_at, id',
        spaceId,
      );
      return rows.map((r) => this.#summary(r));
    });
  }

  async createPage(
    accountId: string,
    spaceId: string,
    input: { title: string; content?: string | undefined; slug?: string | undefined },
    author: Author = USER,
    proposalId: string | null = null,
  ): Promise<PageView> {
    this.#space(accountId, spaceId);
    const id = uuidv7();
    const now = this.#stamp();
    const title = input.title.trim();
    const content = input.content ?? '';
    await this.#db.transaction(() => {
      const slug = this.#freeSlug(spaceId, input.slug ?? slugify(title), input.slug !== undefined);
      const pos = this.#get<{ p: number | null }>(
        'SELECT max(position) AS p FROM space_page WHERE space_id = ? AND deleted_at IS NULL',
        spaceId,
      );
      this.#run(
        `INSERT INTO space_page (id, space_id, account_id, title, slug, position, version, content,
           updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        id,
        spaceId,
        accountId,
        title,
        slug,
        (pos?.p ?? -1) + 1,
        content,
        author.kind,
        now,
        now,
      );
      this.#insertVersion(id, 1, title, content, author, null, null, proposalId, now);
      this.#touchSpace(spaceId, now);
    });
    await this.#emit(
      'space.page.created',
      accountId,
      { spaceId, pageId: id, version: 1, authorKind: author.kind },
      author,
    );
    return this.getPage(accountId, spaceId, id);
  }

  /** A page by id; `spaceId` null looks it up in any of the account's spaces (agent tools). */
  getPage(accountId: string, spaceId: string | null, pageId: string): Promise<PageView> {
    return this.#sync(() => {
      return this.#pageView(this.#page(accountId, spaceId, pageId));
    });
  }

  /**
   * Save a new version. The base must be the current version; otherwise `conflict` with the newer
   * page in `details.current`. A save that changes nothing returns the page as it is.
   */
  async savePage(
    accountId: string,
    spaceId: string | null,
    pageId: string,
    input: SavePageInput,
    author: Author = USER,
    extra: { restoredFrom?: number; proposalId?: string } = {},
  ): Promise<PageView> {
    const page = this.#page(accountId, spaceId, pageId);
    if (input.baseVersion !== page.version) throw this.#stale(page);
    const title = input.title?.trim() ?? page.title;
    const content = input.content ?? page.content;
    if (
      title === page.title &&
      content === page.content &&
      !extra.restoredFrom &&
      !extra.proposalId
    )
      return this.#pageView(page);
    const version = page.version + 1;
    const now = this.#stamp();
    await this.#db.transaction(() => {
      // Re-check inside the write: another save may have landed since the read.
      const cur = this.#get<{ version: number }>(
        'SELECT version FROM space_page WHERE id = ?',
        pageId,
      );
      if (cur?.version !== input.baseVersion)
        throw this.#stale(this.#page(accountId, null, pageId));
      this.#run(
        'UPDATE space_page SET title = ?, content = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?',
        title,
        content,
        version,
        author.kind,
        now,
        pageId,
      );
      this.#insertVersion(
        pageId,
        version,
        title,
        content,
        author,
        input.summary ?? null,
        extra.restoredFrom ?? null,
        extra.proposalId ?? null,
        now,
      );
      this.#moveAnchors(pageId, content, version, now);
      this.#touchSpace(page.space_id, now);
    });
    await this.#emit(
      'space.page.updated',
      accountId,
      { spaceId: page.space_id, pageId, version, authorKind: author.kind },
      author,
    );
    return this.getPage(accountId, page.space_id, pageId);
  }

  /** Order and site file name; not versioned. */
  async updatePageMeta(
    accountId: string,
    spaceId: string,
    pageId: string,
    patch: { position?: number | undefined; slug?: string | undefined },
  ): Promise<PageSummaryView> {
    const page = this.#page(accountId, spaceId, pageId);
    const now = this.#stamp();
    await this.#db.transaction(() => {
      const slug =
        patch.slug !== undefined && patch.slug !== page.slug
          ? this.#freeSlug(page.space_id, patch.slug, true)
          : page.slug;
      this.#run(
        'UPDATE space_page SET position = ?, slug = ?, updated_at = ? WHERE id = ?',
        patch.position ?? page.position,
        slug,
        now,
        pageId,
      );
    });
    await this.#emit(
      'space.page.updated',
      accountId,
      { spaceId, pageId, version: page.version, authorKind: 'user' },
      USER,
    );
    return this.#summary(this.#page(accountId, spaceId, pageId));
  }

  async deletePage(accountId: string, spaceId: string, pageId: string): Promise<void> {
    const page = this.#page(accountId, spaceId, pageId);
    const now = this.#stamp();
    await this.#db.transaction(() => {
      this.#run(
        'UPDATE space_page SET deleted_at = ?, updated_at = ? WHERE id = ?',
        now,
        now,
        pageId,
      );
      this.#run(
        "UPDATE space_proposal SET status = 'rejected', decided_at = ? WHERE page_id = ? AND status = 'open'",
        now,
        pageId,
      );
      this.#touchSpace(spaceId, now);
    });
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: 'space.page.deleted',
      resource: `page:${pageId}`,
      result: 'ok',
      detail: { spaceId, title: page.title, version: page.version },
    });
    await this.#emit(
      'space.page.deleted',
      accountId,
      { spaceId, pageId, version: page.version, authorKind: 'user' },
      USER,
    );
  }

  // ---- versions ----------------------------------------------------------------------------------

  listVersions(accountId: string, spaceId: string, pageId: string): Promise<PageVersionView[]> {
    return this.#sync(() => {
      this.#page(accountId, spaceId, pageId);
      const rows = this.#all<VersionRow>(
        'SELECT * FROM space_page_version WHERE page_id = ? ORDER BY version DESC',
        pageId,
      );
      return rows.map((r) => versionView(r, false));
    });
  }

  getVersion(
    accountId: string,
    spaceId: string | null,
    pageId: string,
    version: number,
  ): Promise<PageVersionView> {
    return this.#sync(() => {
      this.#page(accountId, spaceId, pageId);
      const row = this.#get<VersionRow>(
        'SELECT * FROM space_page_version WHERE page_id = ? AND version = ?',
        pageId,
        version,
      );
      if (!row) throw new NovaError('not_found', `version ${version} does not exist`);
      return versionView(row, true);
    });
  }

  /** Restore an earlier version as a new one (history keeps everything). */
  async restore(
    accountId: string,
    spaceId: string,
    pageId: string,
    input: { version: number; baseVersion: number },
  ): Promise<PageView> {
    const old = await this.getVersion(accountId, spaceId, pageId, input.version);
    const page = await this.savePage(
      accountId,
      spaceId,
      pageId,
      {
        baseVersion: input.baseVersion,
        title: old.title,
        content: old.content ?? '',
        summary: `Restored version ${input.version}`,
      },
      USER,
      { restoredFrom: input.version },
    );
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: 'space.page.restored',
      resource: `page:${pageId}`,
      result: 'ok',
      detail: { spaceId, from: input.version, version: page.version },
    });
    return page;
  }

  // ---- comments ----------------------------------------------------------------------------------

  listComments(
    accountId: string,
    spaceId: string | null,
    pageId: string,
  ): Promise<PageCommentView[]> {
    return this.#sync(() => {
      this.#page(accountId, spaceId, pageId);
      const rows = this.#all<CommentRow>(
        'SELECT * FROM space_comment WHERE page_id = ? AND deleted_at IS NULL ORDER BY created_at, id',
        pageId,
      );
      return rows.map(commentView);
    });
  }

  async addComment(
    accountId: string,
    spaceId: string | null,
    pageId: string,
    input: {
      body: string;
      anchor?: CommentAnchor | undefined;
      version?: number | undefined;
      parentId?: string | undefined;
    },
    author: Author = USER,
  ): Promise<PageCommentView> {
    const page = this.#page(accountId, spaceId, pageId);
    let anchor: CommentAnchor = input.anchor ?? { kind: 'page' };
    // The anchor is checked against the version it was taken from, then moved to the current one.
    const from = input.version ?? page.version;
    let detached = false;
    if (anchor.kind !== 'page') {
      const base =
        from === page.version
          ? page.content
          : this.#get<{ content: string }>(
              'SELECT content FROM space_page_version WHERE page_id = ? AND version = ?',
              pageId,
              from,
            )?.content;
      if (base === undefined) throw new NovaError('not_found', `version ${from} does not exist`);
      anchor = checkAnchor(anchor, base);
      if (from !== page.version) ({ anchor, detached } = reanchor(anchor, page.content));
    }
    if (input.parentId) {
      const parent = this.#get<{ id: string; parent_id: string | null }>(
        'SELECT id, parent_id FROM space_comment WHERE id = ? AND page_id = ? AND deleted_at IS NULL',
        input.parentId,
        pageId,
      );
      if (!parent) throw new NovaError('not_found', 'the comment you reply to is gone');
      if (parent.parent_id)
        throw new NovaError('validation', 'reply to the first comment of a thread');
    }
    const id = uuidv7();
    const now = this.#stamp();
    await this.#db.transaction(() => {
      this.#run(
        `INSERT INTO space_comment (id, page_id, account_id, parent_id, author_kind, author_ref,
           body, anchor_json, version, detached, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        pageId,
        accountId,
        input.parentId ?? null,
        author.kind,
        author.kind === 'agent' ? author.threadId : null,
        input.body.trim(),
        JSON.stringify(anchor),
        page.version,
        detached ? 1 : 0,
        now,
        now,
      );
    });
    await this.#emit(
      'space.comment.created',
      accountId,
      { spaceId: page.space_id, pageId, commentId: id },
      author,
    );
    return commentView(this.#comment(pageId, id));
  }

  async resolveComment(
    accountId: string,
    spaceId: string,
    pageId: string,
    commentId: string,
    resolved: boolean,
  ): Promise<PageCommentView> {
    this.#page(accountId, spaceId, pageId);
    this.#comment(pageId, commentId);
    const now = this.#stamp();
    await this.#db.transaction(() => {
      this.#run(
        'UPDATE space_comment SET resolved_at = ?, updated_at = ? WHERE id = ?',
        resolved ? now : null,
        now,
        commentId,
      );
    });
    await this.#emit('space.comment.updated', accountId, { spaceId, pageId, commentId }, USER);
    return commentView(this.#comment(pageId, commentId));
  }

  async deleteComment(
    accountId: string,
    spaceId: string,
    pageId: string,
    commentId: string,
  ): Promise<void> {
    this.#page(accountId, spaceId, pageId);
    this.#comment(pageId, commentId);
    const now = this.#stamp();
    await this.#db.transaction(() => {
      // Replies go with the comment they answer.
      this.#run(
        'UPDATE space_comment SET deleted_at = ?, updated_at = ? WHERE (id = ? OR parent_id = ?) AND deleted_at IS NULL',
        now,
        now,
        commentId,
        commentId,
      );
    });
    await this.#emit('space.comment.deleted', accountId, { spaceId, pageId, commentId }, USER);
  }

  // ---- proposals ---------------------------------------------------------------------------------

  listProposals(
    accountId: string,
    spaceId: string,
    q: { status?: 'open' | 'all' | undefined; pageId?: string | undefined } = {},
  ): Promise<PageProposalView[]> {
    return this.#sync(() => {
      this.#space(accountId, spaceId);
      const rows = this.#all<ProposalRow>(
        `SELECT * FROM space_proposal WHERE space_id = ?${q.status === 'all' ? '' : " AND status = 'open'"}
         ${q.pageId ? 'AND page_id = ?' : ''} ORDER BY created_at DESC, id`,
        ...(q.pageId ? [spaceId, q.pageId] : [spaceId]),
      );
      return rows.map((r) => this.#proposalView(r));
    });
  }

  /** An agent's edit (or new page) waiting for the user. */
  async propose(
    accountId: string,
    spaceId: string,
    input: ProposeInput,
    author: Author,
  ): Promise<PageProposalView> {
    this.#space(accountId, spaceId);
    if (input.pageId) {
      const page = this.#page(accountId, spaceId, input.pageId);
      if (input.baseVersion !== page.version) throw this.#stale(page);
    }
    const id = uuidv7();
    const now = this.#stamp();
    await this.#db.transaction(() => {
      this.#run(
        `INSERT INTO space_proposal (id, space_id, page_id, account_id, base_version, title, content,
           summary, author_ref, turn_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        id,
        spaceId,
        input.pageId,
        accountId,
        input.pageId ? input.baseVersion : null,
        input.title.trim(),
        input.content,
        input.summary ?? null,
        author.kind === 'agent' ? author.threadId : null,
        author.kind === 'agent' ? author.turnId : null,
        now,
      );
    });
    await this.#emit(
      'space.proposal.created',
      accountId,
      { spaceId, pageId: input.pageId, proposalId: id, status: 'open' },
      author,
    );
    return this.#proposalView(this.#proposal(spaceId, id));
  }

  /** Accept: the proposal becomes a new version (or a new page). A stale base needs `force`. */
  async acceptProposal(
    accountId: string,
    spaceId: string,
    proposalId: string,
    opts: { force?: boolean | undefined } = {},
  ): Promise<PageView> {
    this.#space(accountId, spaceId);
    const p = this.#proposal(spaceId, proposalId);
    if (p.status !== 'open')
      throw new NovaError('conflict', `this proposal was already ${p.status}`, {
        details: { reason: 'decided' },
      });
    const author: Author = { kind: 'agent', threadId: p.author_ref, turnId: p.turn_id };
    let page: PageView;
    if (p.page_id) {
      const cur = this.#page(accountId, spaceId, p.page_id);
      if (cur.version !== p.base_version && !opts.force)
        throw new NovaError('conflict', 'the page changed since this proposal was made', {
          details: { reason: 'stale_proposal', current: this.#pageView(cur) },
        });
      page = await this.savePage(
        accountId,
        spaceId,
        p.page_id,
        {
          baseVersion: cur.version,
          title: p.title,
          content: p.content,
          ...(p.summary ? { summary: p.summary } : {}),
        },
        author,
        { proposalId },
      );
    } else {
      page = await this.createPage(
        accountId,
        spaceId,
        { title: p.title, content: p.content },
        author,
        proposalId,
      );
    }
    await this.#decide(accountId, p, 'accepted');
    return page;
  }

  async rejectProposal(
    accountId: string,
    spaceId: string,
    proposalId: string,
  ): Promise<PageProposalView> {
    this.#space(accountId, spaceId);
    const p = this.#proposal(spaceId, proposalId);
    if (p.status !== 'open')
      throw new NovaError('conflict', `this proposal was already ${p.status}`, {
        details: { reason: 'decided' },
      });
    await this.#decide(accountId, p, 'rejected');
    return this.#proposalView(this.#proposal(spaceId, proposalId));
  }

  async #decide(accountId: string, p: ProposalRow, status: 'accepted' | 'rejected'): Promise<void> {
    const now = this.#stamp();
    await this.#db.transaction(() => {
      this.#run(
        'UPDATE space_proposal SET status = ?, decided_at = ? WHERE id = ?',
        status,
        now,
        p.id,
      );
    });
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: `space.proposal.${status}`,
      resource: p.page_id ? `page:${p.page_id}` : `space:${p.space_id}`,
      decision: status === 'accepted' ? 'allow' : 'deny',
      result: 'ok',
      threadId: p.author_ref,
      detail: { proposalId: p.id, spaceId: p.space_id },
    });
    await this.#emit(
      'space.proposal.decided',
      accountId,
      { spaceId: p.space_id, pageId: p.page_id, proposalId: p.id, status },
      USER,
    );
  }

  /** How agent edits land in a space. */
  agentEditsOf(accountId: string, spaceId: string): SpaceAgentEdits {
    return this.#space(accountId, spaceId).agent_edits;
  }

  /** Record an agent's direct edit in the audit log (the gate already decided the call). */
  async auditAgentEdit(accountId: string, page: PageView, author: Author): Promise<void> {
    await this.#audit.append({
      accountId,
      actor: 'agent',
      kind: 'space',
      action: 'space.page.edited',
      resource: `page:${page.id}`,
      result: 'ok',
      threadId: author.kind === 'agent' ? author.threadId : null,
      turnId: author.kind === 'agent' ? author.turnId : null,
      detail: { spaceId: page.spaceId, version: page.version },
    });
  }

  // ---- internals ---------------------------------------------------------------------------------

  #stale(page: PageRow): NovaError {
    const who = page.updated_by === 'agent' ? 'an agent' : 'you or another window';
    return new NovaError(
      'conflict',
      `this page changed since you opened it (version ${page.version} by ${who})`,
      {
        details: { reason: 'stale_version', current: this.#pageView(page) },
      },
    );
  }

  #insertVersion(
    pageId: string,
    version: number,
    title: string,
    content: string,
    author: Author,
    summary: string | null,
    restoredFrom: number | null,
    proposalId: string | null,
    now: string,
  ): void {
    this.#run(
      `INSERT INTO space_page_version (page_id, version, title, content, author_kind, author_ref,
         turn_id, summary, restored_from, proposal_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pageId,
      version,
      title,
      content,
      author.kind,
      author.kind === 'agent' ? author.threadId : null,
      author.kind === 'agent' ? author.turnId : null,
      summary?.slice(0, 500) ?? null,
      restoredFrom,
      proposalId,
      now,
    );
  }

  /** Move every comment of the page to the new text (FR-036 anchors survive edits). */
  #moveAnchors(pageId: string, content: string, version: number, now: string): void {
    const rows = this.#all<CommentRow>(
      'SELECT * FROM space_comment WHERE page_id = ? AND deleted_at IS NULL',
      pageId,
    );
    for (const r of rows) {
      const anchor = parseAnchor(r.anchor_json);
      if (anchor.kind === 'page') {
        this.#run('UPDATE space_comment SET version = ? WHERE id = ?', version, r.id);
        continue;
      }
      // A detached comment stays detached; its old anchor is kept for the record.
      if (r.detached) {
        this.#run('UPDATE space_comment SET version = ? WHERE id = ?', version, r.id);
        continue;
      }
      const moved = reanchor(anchor, content);
      this.#run(
        'UPDATE space_comment SET anchor_json = ?, version = ?, detached = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(moved.anchor),
        version,
        moved.detached ? 1 : 0,
        moved.detached ? now : r.updated_at,
        r.id,
      );
    }
  }

  #freeSlug(spaceId: string, want: string, explicit: boolean): string {
    const taken = (s: string) =>
      this.#get<{ id: string }>(
        'SELECT id FROM space_page WHERE space_id = ? AND slug = ? AND deleted_at IS NULL',
        spaceId,
        s,
      ) !== undefined;
    if (!taken(want)) return want;
    if (explicit)
      throw new NovaError('conflict', `another page already uses the file name ${want}`, {
        details: { reason: 'slug_taken' },
      });
    for (let i = 2; i < 1000; i++) {
      const s = `${want.slice(0, 58)}-${i}`;
      if (!taken(s)) return s;
    }
    return `${want.slice(0, 40)}-${uuidv7().slice(-8)}`;
  }

  #touchSpace(spaceId: string, now: string): void {
    this.#run('UPDATE space SET updated_at = ? WHERE id = ?', now, spaceId);
  }

  #space(accountId: string, id: string): SpaceRow {
    const r = this.#get<SpaceRow>(
      'SELECT * FROM space WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
      id,
      accountId,
    );
    if (!r) throw new NovaError('not_found', 'space not found');
    return r;
  }

  #page(accountId: string, spaceId: string | null, pageId: string): PageRow {
    const r = this.#get<PageRow>(
      `SELECT p.* FROM space_page p JOIN space s ON s.id = p.space_id
       WHERE p.id = ? AND p.account_id = ? AND p.deleted_at IS NULL AND s.deleted_at IS NULL`,
      pageId,
      accountId,
    );
    if (!r || (spaceId !== null && r.space_id !== spaceId))
      throw new NovaError('not_found', 'page not found');
    return r;
  }

  #comment(pageId: string, id: string): CommentRow {
    const r = this.#get<CommentRow>(
      'SELECT * FROM space_comment WHERE id = ? AND page_id = ? AND deleted_at IS NULL',
      id,
      pageId,
    );
    if (!r) throw new NovaError('not_found', 'comment not found');
    return r;
  }

  #proposal(spaceId: string, id: string): ProposalRow {
    const r = this.#get<ProposalRow>(
      'SELECT * FROM space_proposal WHERE id = ? AND space_id = ?',
      id,
      spaceId,
    );
    if (!r) throw new NovaError('not_found', 'proposal not found');
    return r;
  }

  #spaceView(r: SpaceRow): SpaceView {
    const n = this.#get<{ n: number }>(
      'SELECT count(*) AS n FROM space_page WHERE space_id = ? AND deleted_at IS NULL',
      r.id,
    );
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      projectId: r.project_id,
      agentEdits: r.agent_edits,
      pageCount: n?.n ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  #summary(r: PageRow): PageSummaryView {
    const c = this.#get<{ n: number }>(
      `SELECT count(*) AS n FROM space_comment WHERE page_id = ? AND deleted_at IS NULL
         AND resolved_at IS NULL AND parent_id IS NULL`,
      r.id,
    );
    const p = this.#get<{ n: number }>(
      "SELECT count(*) AS n FROM space_proposal WHERE page_id = ? AND status = 'open'",
      r.id,
    );
    return {
      id: r.id,
      spaceId: r.space_id,
      title: r.title,
      slug: r.slug,
      position: r.position,
      version: r.version,
      updatedBy: r.updated_by,
      openComments: c?.n ?? 0,
      openProposals: p?.n ?? 0,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  #pageView(r: PageRow): PageView {
    return { ...this.#summary(r), content: r.content };
  }

  #proposalView(r: ProposalRow): PageProposalView {
    let stale = false;
    if (r.status === 'open' && r.page_id) {
      const cur = this.#get<{ version: number; deleted_at: string | null }>(
        'SELECT version, deleted_at FROM space_page WHERE id = ?',
        r.page_id,
      );
      stale = !cur || cur.deleted_at !== null || cur.version !== r.base_version;
    }
    return {
      id: r.id,
      spaceId: r.space_id,
      pageId: r.page_id,
      baseVersion: r.base_version,
      title: r.title,
      content: r.content,
      summary: r.summary,
      authorKind: 'agent',
      authorRef: r.author_ref,
      status: r.status,
      stale,
      createdAt: r.created_at,
      decidedAt: r.decided_at,
    };
  }

  async #emit(
    name: string,
    accountId: string,
    payload: Record<string, unknown>,
    author: Author,
  ): Promise<void> {
    await this.#events.emit({
      name,
      accountId,
      actor: author.kind === 'user' ? 'user' : 'system',
      ...(author.kind === 'agent' && author.threadId
        ? {
            correlation: {
              threadId: author.threadId,
              ...(author.turnId ? { turnId: author.turnId } : {}),
            },
          }
        : {}),
      payload,
    });
  }

  /** Run a synchronous read as a promise, so a throw becomes a rejection. */
  #sync<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.#db.raw.prepare(sql).get(...params) as T | undefined;
  }

  #all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.#db.raw.prepare(sql).all(...params) as T[];
  }

  #run(sql: string, ...params: (string | number | null)[]): void {
    this.#db.raw.prepare(sql).run(...params);
  }
}

function parseAnchor(json: string): CommentAnchor {
  try {
    const a = JSON.parse(json) as CommentAnchor;
    if (a.kind === 'range' || a.kind === 'block' || a.kind === 'page') return a;
  } catch {
    // fall through
  }
  return { kind: 'page' };
}

function versionView(r: VersionRow, withContent: boolean): PageVersionView {
  const v: PageVersionView = {
    pageId: r.page_id,
    version: r.version,
    title: r.title,
    authorKind: r.author_kind,
    authorRef: r.author_ref,
    summary: r.summary,
    restoredFrom: r.restored_from,
    proposalId: r.proposal_id,
    size: Buffer.byteLength(r.content, 'utf8'),
    createdAt: r.created_at,
  };
  if (withContent) v.content = r.content;
  return v;
}

function commentView(r: CommentRow): PageCommentView {
  return {
    id: r.id,
    pageId: r.page_id,
    parentId: r.parent_id,
    authorKind: r.author_kind,
    authorRef: r.author_ref,
    body: r.body,
    anchor: parseAnchor(r.anchor_json),
    version: r.version,
    detached: r.detached === 1,
    resolved: r.resolved_at !== null,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
