// M8 spaces and sites carry-ins (FR-036, FR-037): the whole order of a space's pages in one write
// (a stale list is refused), what deleting a page takes with it, deleted pages that come back with
// their history and comments at their old place, and comparing a build from another source with
// the latest version before the source changes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError } from '@nova/shared';
import { ACCOUNT, OTHER, spacesEnv, type SpacesEnv } from './spaces-env.ts';

let env: SpacesEnv;
beforeEach(async () => {
  env = await spacesEnv();
});
afterEach(() => env.close());

async function caught(p: Promise<unknown>): Promise<NovaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return err;
    throw err;
  }
  throw new Error('expected a NovaError');
}

async function spaceWithPages(n = 3) {
  const space = await env.spaces.createSpace(ACCOUNT, { name: 'Handbook' });
  const pages = [];
  for (let i = 1; i <= n; i++) {
    env.clock.tick();
    pages.push(
      await env.spaces.createPage(ACCOUNT, space.id, { title: `Page ${i}`, content: `# ${i}` }),
    );
  }
  return { space, pages };
}

const titles = async (spaceId: string) =>
  (await env.spaces.listPages(ACCOUNT, spaceId)).map((p) => p.title);

describe('page order', () => {
  it('sets the whole order in one write without touching the pages’ own times', async () => {
    const { space, pages } = await spaceWithPages(3);
    const [a, b, c] = pages.map((p) => p.id) as [string, string, string];
    env.clock.tick();
    const out = await env.spaces.reorderPages(ACCOUNT, space.id, [c, a, b]);
    expect(out.map((p) => [p.title, p.position])).toEqual([
      ['Page 3', 0],
      ['Page 1', 1],
      ['Page 2', 2],
    ]);
    expect(out.map((p) => p.updatedAt)).toEqual([
      pages[2]?.updatedAt,
      pages[0]?.updatedAt,
      pages[1]?.updatedAt,
    ]);
    expect(env.events.events.at(-1)).toMatchObject({
      name: 'space.pages.reordered',
      payload: { spaceId: space.id },
    });
    expect((await env.spaces.getSpace(ACCOUNT, space.id)).updatedAt).toBe(
      env.clock.now().toISOString(),
    );
  });

  it('refuses a list that misses, repeats or adds a page', async () => {
    const { space, pages } = await spaceWithPages(2);
    const [a, b] = pages.map((p) => p.id) as [string, string];
    for (const ids of [[a], [a, a], [a, b, 'other'], [a, 'other']]) {
      const err = await caught(env.spaces.reorderPages(ACCOUNT, space.id, ids));
      expect(err.code).toBe('conflict');
      expect(err.details).toEqual({ reason: 'order_stale' });
    }
    // A page deleted meanwhile makes the old list stale too.
    await env.spaces.deletePage(ACCOUNT, space.id, b);
    expect((await caught(env.spaces.reorderPages(ACCOUNT, space.id, [b, a]))).details?.reason).toBe(
      'order_stale',
    );
    expect((await caught(env.spaces.reorderPages(OTHER, space.id, [a]))).code).toBe('not_found');
  });
});

describe('deleting and restoring pages', () => {
  it('says what a deletion takes: versions, comments, replies, proposals and the sites built from the space', async () => {
    const { space, pages } = await spaceWithPages(1);
    const page = pages[0]!;
    const saved = await env.spaces.savePage(ACCOUNT, space.id, page.id, {
      baseVersion: 1,
      content: '# 1\n\nMore.',
    });
    const c1 = await env.spaces.addComment(ACCOUNT, space.id, page.id, { body: 'One' });
    await env.spaces.addComment(ACCOUNT, space.id, page.id, { body: 'Reply', parentId: c1.id });
    const c2 = await env.spaces.addComment(ACCOUNT, space.id, page.id, { body: 'Two' });
    await env.spaces.resolveComment(ACCOUNT, space.id, page.id, c2.id, true);
    await env.spaces.propose(
      ACCOUNT,
      space.id,
      { pageId: page.id, baseVersion: saved.version, title: 'Page 1', content: 'agent text' },
      { kind: 'agent', threadId: 't', turnId: null },
    );
    const site = await env.sites.create(ACCOUNT, {
      name: 'Team site',
      source: { kind: 'space', spaceId: space.id },
    });
    await env.sites.build(ACCOUNT, site.id);
    await env.sites.publish(ACCOUNT, site.id, { version: 1, target: { kind: 'zip' } });
    expect(await env.spaces.deletionImpact(ACCOUNT, space.id, page.id)).toEqual({
      pageId: page.id,
      spaceId: space.id,
      title: 'Page 1',
      versions: 2,
      comments: 2,
      replies: 1,
      openProposals: 1,
      sites: [{ id: site.id, name: 'Team site', publishedVersion: 1 }],
    });
    expect((await caught(env.spaces.deletionImpact(OTHER, space.id, page.id))).code).toBe(
      'not_found',
    );
  });

  it('keeps a deleted page in the space and brings it back with its history and comments', async () => {
    const { space, pages } = await spaceWithPages(3);
    const [, middle] = pages as [(typeof pages)[0], (typeof pages)[0]];
    await env.spaces.addComment(ACCOUNT, space.id, middle.id, { body: 'Keep me' });
    await env.spaces.savePage(ACCOUNT, space.id, middle.id, { baseVersion: 1, content: 'v2' });
    env.clock.tick();
    await env.spaces.deletePage(ACCOUNT, space.id, middle.id);
    expect(await titles(space.id)).toEqual(['Page 1', 'Page 3']);
    const deleted = await env.spaces.listDeletedPages(ACCOUNT, space.id);
    expect(deleted).toEqual([
      {
        id: middle.id,
        spaceId: space.id,
        title: 'Page 2',
        slug: 'page-2',
        version: 2,
        comments: 1,
        deletedAt: env.clock.now().toISOString(),
      },
    ]);
    env.clock.tick();
    const back = await env.spaces.undeletePage(ACCOUNT, space.id, middle.id);
    expect(back).toMatchObject({ title: 'Page 2', version: 2, content: 'v2', openComments: 1 });
    expect(await titles(space.id)).toEqual(['Page 1', 'Page 2', 'Page 3']);
    expect((await env.spaces.listVersions(ACCOUNT, space.id, middle.id)).length).toBe(2);
    expect(await env.spaces.listDeletedPages(ACCOUNT, space.id)).toEqual([]);
    expect(env.audit.at(-1)).toMatchObject({
      action: 'space.page.undeleted',
      resource: `page:${middle.id}`,
      detail: { spaceId: space.id, title: 'Page 2', slug: 'page-2' },
    });
    expect(env.events.events.at(-1)).toMatchObject({
      name: 'space.page.undeleted',
      payload: { spaceId: space.id, pageId: middle.id, version: 2 },
    });
    // A live page is not in the deleted list.
    expect((await caught(env.spaces.undeletePage(ACCOUNT, space.id, middle.id))).code).toBe(
      'not_found',
    );
  });

  it('gives a restored page a free file name and keeps rejected proposals rejected', async () => {
    const { space, pages } = await spaceWithPages(1);
    const page = pages[0]!;
    const x = await env.spaces.propose(
      ACCOUNT,
      space.id,
      { pageId: page.id, baseVersion: 1, title: 'Page 1', content: 'agent' },
      { kind: 'agent', threadId: 't', turnId: null },
    );
    await env.spaces.deletePage(ACCOUNT, space.id, page.id);
    await env.spaces.createPage(ACCOUNT, space.id, { title: 'Page 1', slug: 'page-1' });
    const back = await env.spaces.undeletePage(ACCOUNT, space.id, page.id);
    expect(back.slug).toBe('page-1-2');
    expect(back.position).toBe(0);
    const all = await env.spaces.listProposals(ACCOUNT, space.id, { status: 'all' });
    expect(all.find((p) => p.id === x.id)?.status).toBe('rejected');
    // Another account, and pages of a deleted space, cannot be restored.
    await env.spaces.deletePage(ACCOUNT, space.id, page.id);
    expect((await caught(env.spaces.undeletePage(OTHER, space.id, page.id))).code).toBe(
      'not_found',
    );
    await env.spaces.deleteSpace(ACCOUNT, space.id);
    expect((await caught(env.spaces.listDeletedPages(ACCOUNT, space.id))).code).toBe('not_found');
    expect((await caught(env.spaces.undeletePage(ACCOUNT, space.id, page.id))).code).toBe(
      'not_found',
    );
  });
});

describe('a site’s new source', () => {
  it('compares a build from another space with the latest version, file by file', async () => {
    const a = await env.spaces.createSpace(ACCOUNT, { name: 'Handbook' });
    await env.spaces.createPage(ACCOUNT, a.id, { title: 'Home', content: '# Home' });
    await env.spaces.createPage(ACCOUNT, a.id, { title: 'Old', content: '# Old' });
    const b = await env.spaces.createSpace(ACCOUNT, { name: 'Guide' });
    await env.spaces.createPage(ACCOUNT, b.id, { title: 'Home', content: '# Home' });
    await env.spaces.createPage(ACCOUNT, b.id, { title: 'New', content: '# New' });
    const site = await env.sites.create(ACCOUNT, {
      name: 'Site',
      source: { kind: 'space', spaceId: a.id },
    });
    const before = await env.sites.previewSource(ACCOUNT, site.id, {
      source: { kind: 'space', spaceId: b.id },
    });
    expect(before.comparedWith).toBeNull();
    expect(before.files.every((f) => f.change === 'added')).toBe(true);
    await env.sites.build(ACCOUNT, site.id);
    const p = await env.sites.previewSource(ACCOUNT, site.id, {
      source: { kind: 'space', spaceId: b.id },
    });
    expect(p.current).toEqual({
      source: { kind: 'space', spaceId: a.id },
      sourceLabel: 'Handbook',
      data: [],
    });
    expect(p.next).toMatchObject({
      source: { kind: 'space', spaceId: b.id },
      sourceLabel: 'Guide',
    });
    expect(p.comparedWith).toBe(1);
    expect(p.files.map((f) => [f.path, f.change])).toEqual([
      ['index.html', 'changed'],
      ['new.html', 'added'],
      ['old.html', 'removed'],
    ]);
    expect(p.size).toBe(
      p.files.filter((f) => f.change !== 'removed').reduce((n, f) => n + f.size, 0),
    );
    expect(p.scripts).toBe(false);
    // The same source compares as the same files; nothing was stored or changed.
    const same = await env.sites.previewSource(ACCOUNT, site.id, {});
    expect(same.files.every((f) => f.change === 'same')).toBe(true);
    expect((await env.sites.get(ACCOUNT, site.id)).source).toEqual({
      kind: 'space',
      spaceId: a.id,
    });
    expect((await env.sites.versions(ACCOUNT, site.id)).length).toBe(1);
  });

  it('refuses a source that is not there or not HTML or Markdown', async () => {
    const a = await env.spaces.createSpace(ACCOUNT, { name: 'Handbook' });
    const site = await env.sites.create(ACCOUNT, {
      name: 'Site',
      source: { kind: 'space', spaceId: a.id },
    });
    expect(
      (
        await caught(
          env.sites.previewSource(ACCOUNT, site.id, { source: { kind: 'space', spaceId: 'nope' } }),
        )
      ).code,
    ).toBe('not_found');
    expect(
      (
        await caught(
          env.sites.previewSource(ACCOUNT, site.id, {
            source: { kind: 'artifact', artifactId: 'nope' },
          }),
        )
      ).details,
    ).toEqual({ reason: 'source_missing' });
    expect(
      (
        await caught(
          env.sites.previewSource(ACCOUNT, site.id, { data: [{ sourceId: 'x', name: 'x' }] }),
        )
      ).code,
    ).toBe('not_found');
    expect((await caught(env.sites.previewSource(OTHER, site.id, {}))).code).toBe('not_found');
  });
});
