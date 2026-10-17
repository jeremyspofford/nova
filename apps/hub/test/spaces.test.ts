// Spaces and Pages routes (FR-036): sessions on every route, validation, CRUD, versions with a 409
// on a stale base that hands back the newer page, restore, comments, proposals made by the page
// tools and decided by the user, events in the event log, audit, the tool source and diagnostics.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  PageCommentView,
  PageProposalView,
  PageVersionView,
  PageView,
  SpaceView,
} from '@nova/shared';
import { AUTH_OTHER, spacesHub, type SpacesHub } from './spaces-env.ts';

let hub: SpacesHub;
beforeEach(async () => {
  hub = await spacesHub();
});
afterEach(() => hub.close());

async function space(body: Record<string, unknown> = { name: 'Handbook' }): Promise<SpaceView> {
  const res = await hub.call('POST', '/api/v1/spaces', body);
  expect(res.statusCode).toBe(201);
  return res.json<SpaceView>();
}

async function page(spaceId: string, body: Record<string, unknown>): Promise<PageView> {
  const res = await hub.call('POST', `/api/v1/spaces/${spaceId}/pages`, body);
  expect(res.statusCode).toBe(201);
  return res.json<PageView>();
}

describe('spaces routes', () => {
  it('requires a session on every route', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/v1/spaces'],
      ['POST', '/api/v1/spaces'],
      ['GET', '/api/v1/spaces/s'],
      ['PATCH', '/api/v1/spaces/s'],
      ['DELETE', '/api/v1/spaces/s'],
      ['GET', '/api/v1/spaces/s/pages'],
      ['POST', '/api/v1/spaces/s/pages'],
      ['GET', '/api/v1/spaces/s/pages/p'],
      ['PUT', '/api/v1/spaces/s/pages/p'],
      ['PATCH', '/api/v1/spaces/s/pages/p'],
      ['DELETE', '/api/v1/spaces/s/pages/p'],
      ['GET', '/api/v1/spaces/s/pages/p/versions'],
      ['GET', '/api/v1/spaces/s/pages/p/versions/1'],
      ['POST', '/api/v1/spaces/s/pages/p/restore'],
      ['GET', '/api/v1/spaces/s/pages/p/comments'],
      ['POST', '/api/v1/spaces/s/pages/p/comments'],
      ['POST', '/api/v1/spaces/s/pages/p/comments/c/resolve'],
      ['DELETE', '/api/v1/spaces/s/pages/p/comments/c'],
      ['GET', '/api/v1/spaces/s/proposals'],
      ['POST', '/api/v1/spaces/s/proposals/x/accept'],
      ['POST', '/api/v1/spaces/s/proposals/x/reject'],
    ];
    for (const [method, url] of routes) {
      const res = await hub.app.inject({
        method: method as 'GET',
        url,
        payload: method === 'GET' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('creates, lists, edits and deletes spaces, validating bodies', async () => {
    expect((await hub.call('POST', '/api/v1/spaces', { name: '' })).statusCode).toBe(400);
    expect((await hub.call('POST', '/api/v1/spaces', { name: 'x', extra: 1 })).statusCode).toBe(
      400,
    );
    hub.settings['spaces.agentEdits'] = 'direct';
    const s = await space({ name: 'Handbook', description: 'Notes' });
    expect(s).toMatchObject({ name: 'Handbook', agentEdits: 'direct', pageCount: 0 });
    expect(
      (await hub.call('GET', '/api/v1/spaces')).json<{ items: SpaceView[] }>().items,
    ).toHaveLength(1);
    expect(
      (await hub.call('GET', '/api/v1/spaces', undefined, AUTH_OTHER)).json<{
        items: SpaceView[];
      }>().items,
    ).toEqual([]);
    expect(
      (await hub.call('GET', `/api/v1/spaces/${s.id}`, undefined, AUTH_OTHER)).statusCode,
    ).toBe(404);
    const patched = await hub.call('PATCH', `/api/v1/spaces/${s.id}`, { agentEdits: 'propose' });
    expect(patched.json<SpaceView>().agentEdits).toBe('propose');
    expect(
      (await hub.call('PATCH', `/api/v1/spaces/${s.id}`, { agentEdits: 'sometimes' })).statusCode,
    ).toBe(400);
    expect((await hub.call('DELETE', `/api/v1/spaces/${s.id}`)).json()).toEqual({ ok: true });
    expect((await hub.call('GET', `/api/v1/spaces/${s.id}`)).statusCode).toBe(404);
    expect(hub.audit.map((a) => a.action)).toContain('space.deleted');
    const logged = await hub.events.since(null, 50, {});
    expect(logged.map((e) => e.name)).toEqual(
      expect.arrayContaining(['space.created', 'space.updated', 'space.deleted']),
    );
  });

  it('saves versions, answers a stale base with 409 and the newer page, and restores', async () => {
    const s = await space();
    const p = await page(s.id, { title: 'Welcome', content: 'v1' });
    expect(p).toMatchObject({ version: 1, slug: 'welcome' });
    const saved = await hub.call('PUT', `/api/v1/spaces/${s.id}/pages/${p.id}`, {
      baseVersion: 1,
      content: 'v2',
      summary: 'edit',
    });
    expect(saved.json<PageView>()).toMatchObject({ version: 2, content: 'v2' });
    const stale = await hub.call('PUT', `/api/v1/spaces/${s.id}/pages/${p.id}`, {
      baseVersion: 1,
      content: 'mine',
    });
    expect(stale.statusCode).toBe(409);
    expect(
      stale.json<{ error: { code: string; details: { reason: string; current: PageView } } }>()
        .error,
    ).toMatchObject({
      code: 'conflict',
      details: { reason: 'stale_version', current: { version: 2, content: 'v2' } },
    });
    expect(
      (await hub.call('PUT', `/api/v1/spaces/${s.id}/pages/${p.id}`, { baseVersion: 2 }))
        .statusCode,
    ).toBe(400);
    const versions = (await hub.call('GET', `/api/v1/spaces/${s.id}/pages/${p.id}/versions`)).json<{
      items: PageVersionView[];
    }>();
    expect(versions.items.map((v) => v.version)).toEqual([2, 1]);
    const one = await hub.call('GET', `/api/v1/spaces/${s.id}/pages/${p.id}/versions/1`);
    expect(one.json<PageVersionView>().content).toBe('v1');
    expect(
      (await hub.call('GET', `/api/v1/spaces/${s.id}/pages/${p.id}/versions/x`)).statusCode,
    ).toBe(400);
    const restored = await hub.call('POST', `/api/v1/spaces/${s.id}/pages/${p.id}/restore`, {
      version: 1,
      baseVersion: 2,
    });
    expect(restored.json<PageView>()).toMatchObject({ version: 3, content: 'v1' });
    const meta = await hub.call('PATCH', `/api/v1/spaces/${s.id}/pages/${p.id}`, {
      slug: 'home',
      position: 2,
    });
    expect(meta.json()).toMatchObject({ slug: 'home', position: 2, version: 3 });
    expect(
      (await hub.call('PATCH', `/api/v1/spaces/${s.id}/pages/${p.id}`, { slug: 'Bad Slug' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await hub.call('GET', `/api/v1/spaces/${s.id}/pages/${p.id}`, undefined, AUTH_OTHER))
        .statusCode,
    ).toBe(404);
    expect((await hub.call('DELETE', `/api/v1/spaces/${s.id}/pages/${p.id}`)).json()).toEqual({
      ok: true,
    });
    expect((await hub.call('GET', `/api/v1/spaces/${s.id}/pages`)).json()).toEqual({ items: [] });
  });

  it('comments on a range, resolves and deletes', async () => {
    const s = await space();
    const p = await page(s.id, { title: 'P', content: 'Alpha beta.' });
    const bad = await hub.call('POST', `/api/v1/spaces/${s.id}/pages/${p.id}/comments`, {
      body: 'x',
      anchor: { kind: 'range', start: 3, end: 1, quote: 'a' },
    });
    expect(bad.statusCode).toBe(400);
    const c = await hub.call('POST', `/api/v1/spaces/${s.id}/pages/${p.id}/comments`, {
      body: 'Check',
      anchor: { kind: 'range', start: 6, end: 10, quote: 'beta' },
    });
    expect(c.statusCode).toBe(201);
    const comment = c.json<PageCommentView>();
    const list = (await hub.call('GET', `/api/v1/spaces/${s.id}/pages/${p.id}/comments`)).json<{
      items: PageCommentView[];
    }>();
    expect(list.items).toHaveLength(1);
    const r = await hub.call(
      'POST',
      `/api/v1/spaces/${s.id}/pages/${p.id}/comments/${comment.id}/resolve`,
      { resolved: true },
    );
    expect(r.json<PageCommentView>().resolved).toBe(true);
    expect(
      (
        await hub.call(
          'POST',
          `/api/v1/spaces/${s.id}/pages/${p.id}/comments/${comment.id}/resolve`,
          {},
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await hub.call('DELETE', `/api/v1/spaces/${s.id}/pages/${p.id}/comments/${comment.id}`)
      ).json(),
    ).toEqual({ ok: true });
    expect(
      (await hub.call('DELETE', `/api/v1/spaces/${s.id}/pages/${p.id}/comments/${comment.id}`))
        .statusCode,
    ).toBe(404);
  });

  it('lets the user accept or reject proposals the page tools made; a stale one needs force', async () => {
    const s = await space({ name: 'S', agentEdits: 'propose' });
    const p = await page(s.id, { title: 'P', content: 'draft' });
    const agent = { kind: 'agent' as const, threadId: 'thread-9', turnId: 'turn-9' };
    const prop = await hub.area.spaces.propose(
      '01920000-0000-7000-8000-0000000000e1',
      s.id,
      { pageId: p.id, baseVersion: 1, title: 'P', content: 'better' },
      agent,
    );
    const open = (await hub.call('GET', `/api/v1/spaces/${s.id}/proposals`)).json<{
      items: PageProposalView[];
    }>();
    expect(open.items.map((x) => x.id)).toEqual([prop.id]);
    expect(
      (await hub.call('GET', `/api/v1/spaces/${s.id}/proposals?pageId=${p.id}&status=all`)).json<{
        items: unknown[];
      }>().items,
    ).toHaveLength(1);
    expect(
      (await hub.call('GET', `/api/v1/spaces/${s.id}/proposals?status=closed`)).statusCode,
    ).toBe(400);
    await hub.call('PUT', `/api/v1/spaces/${s.id}/pages/${p.id}`, {
      baseVersion: 1,
      content: 'user edit',
    });
    const stale = await hub.call('POST', `/api/v1/spaces/${s.id}/proposals/${prop.id}/accept`, {});
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'stale_proposal',
    );
    const forced = await hub.call('POST', `/api/v1/spaces/${s.id}/proposals/${prop.id}/accept`, {
      force: true,
    });
    expect(forced.json<PageView>()).toMatchObject({
      version: 3,
      content: 'better',
      updatedBy: 'agent',
    });
    const other = await hub.area.spaces.propose(
      '01920000-0000-7000-8000-0000000000e1',
      s.id,
      { pageId: null, baseVersion: null, title: 'New', content: '' },
      agent,
    );
    const rejected = await hub.call(
      'POST',
      `/api/v1/spaces/${s.id}/proposals/${other.id}/reject`,
      {},
    );
    expect(rejected.json<PageProposalView>().status).toBe('rejected');
    expect(hub.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['space.proposal.accepted', 'space.proposal.rejected']),
    );
  });

  it('offers the page tools once a space exists and reports diagnostics', async () => {
    const names = async () =>
      (await hub.area.tools.list('01920000-0000-7000-8000-0000000000e1')).map(
        (t) => t.descriptor.name,
      );
    expect(await names()).toEqual(['visualize.create']);
    await space();
    expect(await names()).toEqual(['visualize.create', 'page.read', 'page.edit', 'page.comment']);
    const diag = await hub.diagnostics.collect();
    expect(diag.spaces).toMatchObject({
      spaces: 1,
      pages: 0,
      sites: 0,
      publishRoot: expect.stringContaining('sites'),
    });
  });
});
