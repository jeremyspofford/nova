// Spaces and Pages (FR-036): spaces, pages with every save a version, base-version conflicts,
// restore, comments anchored to ranges and blocks that move (or detach) with edits, proposals for
// agent edits, account isolation, events and audit.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, type PageView } from '@nova/shared';
import { ACCOUNT, OTHER, spacesEnv, type SpacesEnv } from './spaces-env.ts';
import { slugify, type SpaceAuthor } from '../src/index.ts';

let env: SpacesEnv;
beforeEach(async () => {
  env = await spacesEnv();
});
afterEach(() => env.close());

const AGENT: SpaceAuthor = { kind: 'agent', threadId: 'thread-1', turnId: 'turn-1' };

async function caught(p: Promise<unknown>): Promise<NovaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return err;
    throw err;
  }
  throw new Error('expected a NovaError');
}

async function spaceWithPage(content = 'Hello world.\n\nSecond paragraph here.') {
  const space = await env.spaces.createSpace(ACCOUNT, { name: 'Handbook' });
  const page = await env.spaces.createPage(ACCOUNT, space.id, { title: 'Welcome', content });
  return { space, page };
}

describe('spaces', () => {
  it('creates, lists, renames and deletes spaces; the default for agent edits comes from the setting', async () => {
    const a = await env.spaces.createSpace(ACCOUNT, {
      name: ' Handbook ',
      description: 'Team notes',
    });
    expect(a).toMatchObject({
      name: 'Handbook',
      description: 'Team notes',
      agentEdits: 'propose',
      pageCount: 0,
    });
    env.defaultEdits.value = 'direct';
    env.clock.tick();
    const b = await env.spaces.createSpace(ACCOUNT, { name: 'Drafts' });
    expect(b.agentEdits).toBe('direct');
    const c = await env.spaces.createSpace(ACCOUNT, { name: 'Explicit', agentEdits: 'propose' });
    expect(c.agentEdits).toBe('propose');
    env.clock.tick();
    await env.spaces.updateSpace(ACCOUNT, c.id, { description: 'touched' });
    // Most recently changed first.
    expect((await env.spaces.listSpaces(ACCOUNT)).map((s) => s.name)).toEqual([
      'Explicit',
      'Drafts',
      'Handbook',
    ]);
    expect(await env.spaces.listSpaces(OTHER)).toEqual([]);
    const renamed = await env.spaces.updateSpace(ACCOUNT, a.id, {
      name: 'Team handbook',
      agentEdits: 'direct',
    });
    expect(renamed).toMatchObject({
      name: 'Team handbook',
      description: 'Team notes',
      agentEdits: 'direct',
    });
    expect(env.spaces.hasSpaces(ACCOUNT)).toBe(true);
    expect(env.spaces.hasSpaces(OTHER)).toBe(false);
    await env.spaces.deleteSpace(ACCOUNT, a.id);
    expect((await env.spaces.listSpaces(ACCOUNT)).map((s) => s.id)).not.toContain(a.id);
    expect((await caught(env.spaces.getSpace(ACCOUNT, a.id))).code).toBe('not_found');
    expect(env.audit.map((r) => r.action)).toContain('space.deleted');
    expect(env.events.names()).toEqual(
      expect.arrayContaining(['space.created', 'space.updated', 'space.deleted']),
    );
  });

  it('refuses another account and an unknown project', async () => {
    const s = await env.spaces.createSpace(ACCOUNT, { name: 'Mine' });
    expect((await caught(env.spaces.getSpace(OTHER, s.id))).code).toBe('not_found');
    expect((await caught(env.spaces.createPage(OTHER, s.id, { title: 'x' }))).code).toBe(
      'not_found',
    );
    expect(
      (await caught(env.spaces.createSpace(ACCOUNT, { name: 'P', projectId: 'nope' }))).code,
    ).toBe('not_found');
  });
});

describe('pages and versions', () => {
  it('makes a slug, keeps slugs unique and orders pages', async () => {
    expect(slugify('Hello, Wörld!  Again')).toBe('hello-world-again');
    expect(slugify('***')).toBe('page');
    const s = await env.spaces.createSpace(ACCOUNT, { name: 'S' });
    const p1 = await env.spaces.createPage(ACCOUNT, s.id, { title: 'Getting started' });
    const p2 = await env.spaces.createPage(ACCOUNT, s.id, { title: 'Getting started' });
    expect([p1.slug, p2.slug]).toEqual(['getting-started', 'getting-started-2']);
    expect([p1.position, p2.position]).toEqual([0, 1]);
    expect(
      (await caught(env.spaces.createPage(ACCOUNT, s.id, { title: 'X', slug: 'getting-started' })))
        .details,
    ).toMatchObject({ reason: 'slug_taken' });
    await env.spaces.updatePageMeta(ACCOUNT, s.id, p1.id, { position: 5 });
    expect((await env.spaces.listPages(ACCOUNT, s.id)).map((p) => p.id)).toEqual([p2.id, p1.id]);
    expect((await env.spaces.getSpace(ACCOUNT, s.id)).pageCount).toBe(2);
  });

  it('saves every change as a version and returns the page unchanged for a no-op save', async () => {
    const { space, page } = await spaceWithPage('one');
    expect(page.version).toBe(1);
    env.clock.tick();
    const v2 = await env.spaces.savePage(ACCOUNT, space.id, page.id, {
      baseVersion: 1,
      content: 'two',
      summary: 'second',
    });
    expect(v2).toMatchObject({ version: 2, content: 'two', updatedBy: 'user' });
    const same = await env.spaces.savePage(ACCOUNT, space.id, page.id, {
      baseVersion: 2,
      content: 'two',
    });
    expect(same.version).toBe(2);
    const v3 = await env.spaces.savePage(ACCOUNT, space.id, page.id, {
      baseVersion: 2,
      title: 'Renamed',
    });
    expect(v3).toMatchObject({ version: 3, title: 'Renamed', content: 'two' });
    const versions = await env.spaces.listVersions(ACCOUNT, space.id, page.id);
    expect(versions.map((v) => [v.version, v.summary, v.authorKind])).toEqual([
      [3, null, 'user'],
      [2, 'second', 'user'],
      [1, null, 'user'],
    ]);
    expect(versions[0]!.content).toBeUndefined();
    expect((await env.spaces.getVersion(ACCOUNT, space.id, page.id, 1)).content).toBe('one');
    expect((await caught(env.spaces.getVersion(ACCOUNT, space.id, page.id, 9))).code).toBe(
      'not_found',
    );
  });

  it('answers a stale base with a conflict carrying the newer page (concurrent edits)', async () => {
    const { space, page } = await spaceWithPage('base');
    await env.spaces.savePage(
      ACCOUNT,
      space.id,
      page.id,
      { baseVersion: 1, content: 'from the agent' },
      AGENT,
    );
    const err = await caught(
      env.spaces.savePage(ACCOUNT, space.id, page.id, { baseVersion: 1, content: 'from the user' }),
    );
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/version 2 by an agent/);
    const current = (err.details as { reason: string; current: PageView }).current;
    expect(err.details).toMatchObject({ reason: 'stale_version' });
    expect(current).toMatchObject({ version: 2, content: 'from the agent', updatedBy: 'agent' });
    // Two saves racing on the same base: exactly one wins.
    const results = await Promise.allSettled([
      env.spaces.savePage(ACCOUNT, space.id, page.id, { baseVersion: 2, content: 'a' }),
      env.spaces.savePage(ACCOUNT, space.id, page.id, { baseVersion: 2, content: 'b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await env.spaces.getPage(ACCOUNT, space.id, page.id)).version).toBe(3);
  });

  it('restores an earlier version as a new version', async () => {
    const { space, page } = await spaceWithPage('original');
    await env.spaces.savePage(ACCOUNT, space.id, page.id, { baseVersion: 1, content: 'changed' });
    const restored = await env.spaces.restore(ACCOUNT, space.id, page.id, {
      version: 1,
      baseVersion: 2,
    });
    expect(restored).toMatchObject({ version: 3, content: 'original' });
    const [latest] = await env.spaces.listVersions(ACCOUNT, space.id, page.id);
    expect(latest).toMatchObject({ version: 3, restoredFrom: 1, summary: 'Restored version 1' });
    expect(env.audit.find((r) => r.action === 'space.page.restored')).toMatchObject({
      kind: 'space',
      detail: { from: 1, version: 3 },
    });
    expect(
      (await caught(env.spaces.restore(ACCOUNT, space.id, page.id, { version: 1, baseVersion: 1 })))
        .code,
    ).toBe('conflict');
  });

  it('deletes a page and closes its open proposals', async () => {
    const { space, page } = await spaceWithPage();
    const p = await env.spaces.propose(
      ACCOUNT,
      space.id,
      { pageId: page.id, baseVersion: 1, title: 'Welcome', content: 'x' },
      AGENT,
    );
    await env.spaces.deletePage(ACCOUNT, space.id, page.id);
    expect(await env.spaces.listPages(ACCOUNT, space.id)).toEqual([]);
    expect(
      (await env.spaces.listProposals(ACCOUNT, space.id, { status: 'all' })).find(
        (x) => x.id === p.id,
      )?.status,
    ).toBe('rejected');
    expect((await caught(env.spaces.getPage(ACCOUNT, space.id, page.id))).code).toBe('not_found');
  });
});

describe('comments', () => {
  it('anchors to a range, follows the text through edits and detaches when it is gone', async () => {
    const { space, page } = await spaceWithPage('Alpha beta gamma.');
    const c = await env.spaces.addComment(ACCOUNT, space.id, page.id, {
      body: 'Is beta right?',
      anchor: { kind: 'range', start: 6, end: 10, quote: 'beta' },
    });
    expect(c).toMatchObject({
      anchor: { kind: 'range', start: 6, end: 10 },
      version: 1,
      detached: false,
      resolved: false,
    });
    await env.spaces.savePage(ACCOUNT, space.id, page.id, {
      baseVersion: 1,
      content: 'Intro. Alpha beta gamma.',
    });
    let [moved] = await env.spaces.listComments(ACCOUNT, space.id, page.id);
    expect(moved).toMatchObject({
      anchor: { kind: 'range', start: 13, end: 17, quote: 'beta' },
      version: 2,
      detached: false,
    });
    await env.spaces.savePage(ACCOUNT, space.id, page.id, {
      baseVersion: 2,
      content: 'Alpha delta gamma.',
    });
    [moved] = await env.spaces.listComments(ACCOUNT, space.id, page.id);
    expect(moved).toMatchObject({ detached: true, version: 3 });
    // A detached comment stays detached even if the words come back.
    await env.spaces.savePage(ACCOUNT, space.id, page.id, {
      baseVersion: 3,
      content: 'Alpha beta.',
    });
    [moved] = await env.spaces.listComments(ACCOUNT, space.id, page.id);
    expect(moved!.detached).toBe(true);
  });

  it('checks an anchor against the version it was taken from', async () => {
    const { space, page } = await spaceWithPage('First block.\n\nSecond block text.');
    const bad = await caught(
      env.spaces.addComment(ACCOUNT, space.id, page.id, {
        body: 'x',
        anchor: { kind: 'range', start: 0, end: 5, quote: 'Nope!' },
      }),
    );
    expect(bad.details).toMatchObject({ reason: 'anchor_mismatch' });
    const block = await env.spaces.addComment(ACCOUNT, space.id, page.id, {
      body: 'About this block',
      anchor: { kind: 'block', index: 1, quote: 'ignored' },
    });
    expect(block.anchor).toEqual({ kind: 'block', index: 1, quote: 'Second block text.' });
    expect(
      (
        await caught(
          env.spaces.addComment(ACCOUNT, space.id, page.id, {
            body: 'x',
            anchor: { kind: 'block', index: 7, quote: 'q' },
          }),
        )
      ).code,
    ).toBe('validation');
    // Taken from version 1 while the page is at version 2: moved forward on the way in.
    await env.spaces.savePage(ACCOUNT, space.id, page.id, {
      baseVersion: 1,
      content: 'New first.\n\nFirst block.\n\nSecond block text.',
    });
    const old = await env.spaces.addComment(ACCOUNT, space.id, page.id, {
      body: 'old view',
      anchor: { kind: 'range', start: 0, end: 5, quote: 'First' },
      version: 1,
    });
    expect(old).toMatchObject({
      version: 2,
      anchor: { kind: 'range', start: 12, end: 17 },
      detached: false,
    });
    expect(
      (
        await caught(
          env.spaces.addComment(ACCOUNT, space.id, page.id, {
            body: 'x',
            anchor: { kind: 'range', start: 0, end: 1, quote: 'F' },
            version: 9,
          }),
        )
      ).code,
    ).toBe('not_found');
    const blockNow = (await env.spaces.listComments(ACCOUNT, space.id, page.id)).find(
      (c) => c.id === block.id,
    );
    expect(blockNow!.anchor).toMatchObject({ kind: 'block', index: 2 });
  });

  it('replies, resolves, reopens and deletes a thread with its replies', async () => {
    const { space, page } = await spaceWithPage();
    const root = await env.spaces.addComment(ACCOUNT, space.id, page.id, { body: 'Question' });
    const reply = await env.spaces.addComment(
      ACCOUNT,
      space.id,
      page.id,
      { body: 'Answer', parentId: root.id },
      AGENT,
    );
    expect(reply).toMatchObject({ parentId: root.id, authorKind: 'agent', authorRef: 'thread-1' });
    expect(
      (
        await caught(
          env.spaces.addComment(ACCOUNT, space.id, page.id, { body: 'x', parentId: reply.id }),
        )
      ).code,
    ).toBe('validation');
    expect(
      (
        await caught(
          env.spaces.addComment(ACCOUNT, space.id, page.id, { body: 'x', parentId: 'gone' }),
        )
      ).code,
    ).toBe('not_found');
    expect((await env.spaces.listPages(ACCOUNT, space.id))[0]!.openComments).toBe(1);
    const resolved = await env.spaces.resolveComment(ACCOUNT, space.id, page.id, root.id, true);
    expect(resolved).toMatchObject({ resolved: true, resolvedAt: expect.any(String) });
    expect((await env.spaces.listPages(ACCOUNT, space.id))[0]!.openComments).toBe(0);
    expect(
      (await env.spaces.resolveComment(ACCOUNT, space.id, page.id, root.id, false)).resolved,
    ).toBe(false);
    await env.spaces.deleteComment(ACCOUNT, space.id, page.id, root.id);
    expect(await env.spaces.listComments(ACCOUNT, space.id, page.id)).toEqual([]);
    expect(env.events.names()).toEqual(
      expect.arrayContaining([
        'space.comment.created',
        'space.comment.updated',
        'space.comment.deleted',
      ]),
    );
  });
});

describe('proposals', () => {
  it('lands an agent edit as a version authored by the agent when the user accepts it', async () => {
    const { space, page } = await spaceWithPage('draft');
    const p = await env.spaces.propose(
      ACCOUNT,
      space.id,
      {
        pageId: page.id,
        baseVersion: 1,
        title: 'Welcome',
        content: 'improved',
        summary: 'tightened',
      },
      AGENT,
    );
    expect(p).toMatchObject({
      status: 'open',
      stale: false,
      authorRef: 'thread-1',
      baseVersion: 1,
    });
    expect((await env.spaces.listPages(ACCOUNT, space.id))[0]!.openProposals).toBe(1);
    const accepted = await env.spaces.acceptProposal(ACCOUNT, space.id, p.id);
    expect(accepted).toMatchObject({ version: 2, content: 'improved', updatedBy: 'agent' });
    const [v] = await env.spaces.listVersions(ACCOUNT, space.id, page.id);
    expect(v).toMatchObject({
      authorKind: 'agent',
      authorRef: 'thread-1',
      proposalId: p.id,
      summary: 'tightened',
    });
    expect(await env.spaces.listProposals(ACCOUNT, space.id)).toEqual([]);
    expect(
      (await caught(env.spaces.acceptProposal(ACCOUNT, space.id, p.id))).details,
    ).toMatchObject({ reason: 'decided' });
    expect(env.audit.find((r) => r.action === 'space.proposal.accepted')).toMatchObject({
      decision: 'allow',
      threadId: 'thread-1',
    });
    const created = env.events.events.find((e) => e.name === 'space.proposal.created');
    expect(created).toMatchObject({ correlation: { threadId: 'thread-1', turnId: 'turn-1' } });
  });

  it('marks a proposal stale when the page moved on; accepting it needs force', async () => {
    const { space, page } = await spaceWithPage('v1');
    const p = await env.spaces.propose(
      ACCOUNT,
      space.id,
      { pageId: page.id, baseVersion: 1, title: 'Welcome', content: 'agent text' },
      AGENT,
    );
    await env.spaces.savePage(ACCOUNT, space.id, page.id, { baseVersion: 1, content: 'user text' });
    expect((await env.spaces.listProposals(ACCOUNT, space.id))[0]!.stale).toBe(true);
    const err = await caught(env.spaces.acceptProposal(ACCOUNT, space.id, p.id));
    expect(err.details).toMatchObject({
      reason: 'stale_proposal',
      current: { version: 2, content: 'user text' },
    });
    const forced = await env.spaces.acceptProposal(ACCOUNT, space.id, p.id, { force: true });
    expect(forced).toMatchObject({ version: 3, content: 'agent text' });
    // Proposing on a stale base is refused outright.
    expect(
      (
        await caught(
          env.spaces.propose(
            ACCOUNT,
            space.id,
            { pageId: page.id, baseVersion: 1, title: 'W', content: 'x' },
            AGENT,
          ),
        )
      ).code,
    ).toBe('conflict');
  });

  it('proposes a new page; accepting creates it, rejecting leaves nothing', async () => {
    const space = await env.spaces.createSpace(ACCOUNT, { name: 'S' });
    const p = await env.spaces.propose(
      ACCOUNT,
      space.id,
      { pageId: null, baseVersion: null, title: 'FAQ', content: '# FAQ' },
      AGENT,
    );
    const page = await env.spaces.acceptProposal(ACCOUNT, space.id, p.id);
    expect(page).toMatchObject({ title: 'FAQ', version: 1, updatedBy: 'agent', slug: 'faq' });
    const q = await env.spaces.propose(
      ACCOUNT,
      space.id,
      { pageId: null, baseVersion: null, title: 'Other', content: '' },
      AGENT,
    );
    const rejected = await env.spaces.rejectProposal(ACCOUNT, space.id, q.id);
    expect(rejected).toMatchObject({ status: 'rejected', decidedAt: expect.any(String) });
    expect((await env.spaces.listPages(ACCOUNT, space.id)).map((x) => x.title)).toEqual(['FAQ']);
    expect((await caught(env.spaces.rejectProposal(ACCOUNT, space.id, q.id))).code).toBe(
      'conflict',
    );
    expect((await caught(env.spaces.rejectProposal(ACCOUNT, space.id, 'nope'))).code).toBe(
      'not_found',
    );
    expect(
      (await env.spaces.listProposals(ACCOUNT, space.id, { status: 'all' }))
        .map((x) => x.status)
        .sort(),
    ).toEqual(['accepted', 'rejected']);
  });
});
