// M8 spaces and sites routes (FR-036, FR-037): the order of a space's pages, what a deletion takes,
// deleted pages that come back, a preview of a site's new source, the plan of a publish, and remote
// hosting targets (WebDAV, a fake server on 127.0.0.1) with write-only credentials, the egress
// policy (settings and managed policy) and the `sites.remoteTargets` switch.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  DeletedPageView,
  PageDeletionView,
  PageSummaryView,
  PageView,
  SiteHostingTargetView,
  SitePublishPlanView,
  SitePublishResult,
  SiteSourcePreviewView,
  SiteView,
  SpaceView,
} from '@nova/shared';
import {
  fakeWebDav,
  folderFiles,
  type FakeDav,
} from '../../../packages/core/test/fixtures/hosting/fake-webdav.ts';
import { AUTH_OTHER, spacesHub, type SpacesHub } from './spaces-env.ts';

let hub: SpacesHub;
let dav: FakeDav;
beforeEach(async () => {
  hub = await spacesHub();
  dav = await fakeWebDav();
});
afterEach(async () => {
  await dav.close();
  await hub.close();
});

async function spaceWithPages(n: number) {
  const s = (await hub.call('POST', '/api/v1/spaces', { name: 'Docs' })).json<SpaceView>();
  const pages: PageView[] = [];
  for (let i = 1; i <= n; i++)
    pages.push(
      (
        await hub.call('POST', `/api/v1/spaces/${s.id}/pages`, {
          title: `Page ${i}`,
          content: `# ${i}`,
        })
      ).json<PageView>(),
    );
  return { space: s, pages };
}

async function builtSite(): Promise<SiteView> {
  const { space } = await spaceWithPages(2);
  const site = (
    await hub.call('POST', '/api/v1/sites', {
      name: 'Docs site',
      source: { kind: 'space', spaceId: space.id },
    })
  ).json<SiteView>();
  expect((await hub.call('POST', `/api/v1/sites/${site.id}/build`, {})).statusCode).toBe(201);
  return site;
}

async function target(over: Record<string, unknown> = {}): Promise<SiteHostingTargetView> {
  const res = await hub.call('POST', '/api/v1/sites/targets', {
    name: 'NAS',
    kind: 'webdav',
    url: dav.url,
    credential: { kind: 'none' },
    ...over,
  });
  expect(res.statusCode).toBe(201);
  return res.json<SiteHostingTargetView>();
}

describe('pages', () => {
  it('sets the order in one write and refuses a stale list', async () => {
    const { space, pages } = await spaceWithPages(3);
    const ids = pages.map((p) => p.id).reverse();
    const res = await hub.call('PUT', `/api/v1/spaces/${space.id}/order`, { pageIds: ids });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: PageSummaryView[] }>().items.map((p) => p.title)).toEqual([
      'Page 3',
      'Page 2',
      'Page 1',
    ]);
    const stale = await hub.call('PUT', `/api/v1/spaces/${space.id}/order`, {
      pageIds: ids.slice(1),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<{ error: { details: unknown } }>().error.details).toEqual({
      reason: 'order_stale',
    });
    for (const body of [{ pageIds: [ids[0], ids[0]] }, { pageIds: [] }, { pageIds: ids, x: 1 }])
      expect((await hub.call('PUT', `/api/v1/spaces/${space.id}/order`, body)).statusCode).toBe(
        400,
      );
    expect(
      (await hub.call('PUT', `/api/v1/spaces/${space.id}/order`, { pageIds: ids }, AUTH_OTHER))
        .statusCode,
    ).toBe(404);
    expect(
      (await hub.call('PUT', `/api/v1/spaces/${space.id}/order`, { pageIds: ids }, {})).statusCode,
    ).toBe(401);
  });

  it('says what a deletion takes, and brings a deleted page back', async () => {
    const { space, pages } = await spaceWithPages(2);
    const page = pages[0]!;
    await hub.call('POST', `/api/v1/spaces/${space.id}/pages/${page.id}/comments`, { body: 'Hi' });
    const impact = (
      await hub.call('GET', `/api/v1/spaces/${space.id}/pages/${page.id}/deletion`)
    ).json<PageDeletionView>();
    expect(impact).toMatchObject({ title: 'Page 1', versions: 1, comments: 1, replies: 0 });
    await hub.call('DELETE', `/api/v1/spaces/${space.id}/pages/${page.id}`);
    const list = (await hub.call('GET', `/api/v1/spaces/${space.id}/deleted-pages`)).json<{
      items: DeletedPageView[];
    }>();
    expect(list.items).toMatchObject([{ id: page.id, title: 'Page 1', comments: 1 }]);
    const back = await hub.call('POST', `/api/v1/spaces/${space.id}/pages/${page.id}/undelete`);
    expect(back.statusCode).toBe(200);
    expect(back.json<PageView>()).toMatchObject({ id: page.id, position: 0, openComments: 1 });
    expect(hub.audit.at(-1)).toMatchObject({ action: 'space.page.undeleted' });
    expect(
      (await hub.call('POST', `/api/v1/spaces/${space.id}/pages/${page.id}/undelete`)).statusCode,
    ).toBe(404);
    expect(
      (
        await hub.call(
          'GET',
          `/api/v1/spaces/${space.id}/pages/${page.id}/deletion`,
          undefined,
          AUTH_OTHER,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('a site’s source', () => {
  it('previews a build from another source, then the change itself is a PATCH', async () => {
    const site = await builtSite();
    const other = (await hub.call('POST', '/api/v1/spaces', { name: 'Guide' })).json<SpaceView>();
    await hub.call('POST', `/api/v1/spaces/${other.id}/pages`, { title: 'Start', content: 'x' });
    const res = await hub.call('POST', `/api/v1/sites/${site.id}/source-preview`, {
      source: { kind: 'space', spaceId: other.id },
    });
    expect(res.statusCode).toBe(200);
    const p = res.json<SiteSourcePreviewView>();
    expect(p).toMatchObject({ comparedWith: 1, next: { sourceLabel: 'Guide' } });
    expect(p.files.map((f) => f.change)).toContain('removed');
    expect(
      (await hub.call('POST', `/api/v1/sites/${site.id}/source-preview`, { source: { kind: 'x' } }))
        .statusCode,
    ).toBe(400);
    const patched = await hub.call('PATCH', `/api/v1/sites/${site.id}`, {
      source: { kind: 'space', spaceId: other.id },
    });
    expect(patched.json<SiteView>()).toMatchObject({ sourceLabel: 'Guide' });
  });
});

describe('hosting targets', () => {
  it('stores the credential write-only and checks the connection', async () => {
    dav.auth = `Bearer tok-123`;
    const res = await hub.call('POST', '/api/v1/sites/targets', {
      name: 'NAS',
      kind: 'webdav',
      url: dav.url,
      credential: { kind: 'bearer', token: 'tok-123' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).not.toContain('tok-123');
    const t = res.json<SiteHostingTargetView>();
    expect(t).toMatchObject({ auth: 'bearer', hasCredential: true });
    expect(await hub.area.targets.list('nobody')).toEqual([]);
    const checked = await hub.call('POST', `/api/v1/sites/targets/${t.id}/check`);
    expect(checked.json<SiteHostingTargetView>().lastCheck).toMatchObject({ ok: true });
    expect(dav.log.at(-1)?.auth).toBe('Bearer tok-123');
    const listed = (await hub.call('GET', '/api/v1/sites/targets')).json<{
      items: SiteHostingTargetView[];
    }>();
    expect(listed.items.map((x) => x.id)).toEqual([t.id]);
    const renamed = await hub.call('PATCH', `/api/v1/sites/targets/${t.id}`, { name: 'Home NAS' });
    expect(renamed.json<SiteHostingTargetView>().name).toBe('Home NAS');
    expect(
      (await hub.call('GET', `/api/v1/sites/targets/${t.id}`, undefined, AUTH_OTHER)).statusCode,
    ).toBe(404);
    expect((await hub.call('DELETE', `/api/v1/sites/targets/${t.id}`)).json()).toEqual({
      ok: true,
    });
    expect((await hub.call('GET', `/api/v1/sites/targets/${t.id}`)).statusCode).toBe(404);
    expect((await hub.diagnostics.collect()).spaces).toMatchObject({ targets: 0 });
  });

  it('refuses plain http to another machine and bodies with unknown fields', async () => {
    const http = await hub.call('POST', '/api/v1/sites/targets', {
      name: 'X',
      kind: 'webdav',
      url: 'http://dav.example.com/',
      credential: { kind: 'none' },
    });
    expect(http.statusCode).toBe(400);
    expect(http.json<{ error: { details: unknown } }>().error.details).toEqual({
      reason: 'https_required',
      field: 'url',
    });
    for (const body of [
      { name: 'X', kind: 'ftp', url: dav.url, credential: { kind: 'none' } },
      {
        name: 'X',
        kind: 'webdav',
        url: dav.url,
        credential: { kind: 'basic', username: 'a:b', password: 'p' },
      },
      {
        name: 'X',
        kind: 'webdav',
        url: dav.url,
        credential: { kind: 'none' },
        secretRef: 'secret://x/y',
      },
    ])
      expect((await hub.call('POST', '/api/v1/sites/targets', body)).statusCode).toBe(400);
  });

  it('plans, publishes with an explicit confirm, and unpublishes', async () => {
    const site = await builtSite();
    const t = await target({ publicUrl: 'https://www.example.com/' });
    const tgt = { kind: 'remote', targetId: t.id, folder: 'docs' };
    const plan = await hub.call('POST', `/api/v1/sites/${site.id}/publish-plan`, {
      version: 1,
      target: tgt,
    });
    expect(plan.json<SitePublishPlanView>()).toMatchObject({
      location: `${dav.url}docs/`,
      reversible: true,
      egress: { allowed: true },
      remote: { publicUrl: 'https://www.example.com/docs/' },
    });
    expect(
      (await hub.call('POST', `/api/v1/sites/${site.id}/publish`, { version: 1, target: tgt }))
        .statusCode,
    ).toBe(400);
    const pub = await hub.call('POST', `/api/v1/sites/${site.id}/publish`, {
      version: 1,
      target: tgt,
      confirm: true,
    });
    expect(pub.statusCode).toBe(200);
    const r = pub.json<SitePublishResult>();
    expect(r).toMatchObject({ downloadUrl: null, folderPath: null, leftBehind: null });
    expect(r.site.publishedRemote).toMatchObject({ name: 'NAS', location: `${dav.url}docs/` });
    expect(Object.keys(folderFiles(dav, 'docs'))).toContain('index.html');
    const busy = await hub.call('DELETE', `/api/v1/sites/targets/${t.id}`);
    expect(busy.statusCode).toBe(409);
    const down = await hub.call('POST', `/api/v1/sites/${site.id}/unpublish`, { confirm: true });
    expect(down.json<SitePublishResult>().publish).toBeNull();
    expect(dav.dirs.has('docs')).toBe(false);
  });

  it('applies the egress settings, managed policy and the remote targets switch', async () => {
    const site = await builtSite();
    const t = await target();
    const body = { version: 1, target: { kind: 'remote', targetId: t.id, folder: 'docs' } };
    hub.settings['network.egressDeny'] = ['127.0.0.1'];
    const denied = await hub.call('POST', `/api/v1/sites/${site.id}/publish`, {
      ...body,
      confirm: true,
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: { code: string; details: unknown } }>().error).toMatchObject({
      code: 'policy_denied',
      details: { reason: 'egress_denied', host: '127.0.0.1' },
    });
    expect(dav.log).toEqual([]);
    expect(hub.audit.some((a) => a.action === 'site.egress.denied')).toBe(true);
    delete hub.settings['network.egressDeny'];
    hub.settings['managed.restrict'] = {
      layers: [{ egress: { allow: ['dav.corp.example'] } }],
      failClosed: null,
    };
    const plan = (
      await hub.call('POST', `/api/v1/sites/${site.id}/publish-plan`, body)
    ).json<SitePublishPlanView>();
    expect(plan.egress).toMatchObject({
      allowed: false,
      message: expect.stringMatching(/managed policy/),
    });
    hub.settings['managed.restrict'] = { layers: [], failClosed: 'the policy file is unreadable' };
    expect(
      (await hub.call('POST', `/api/v1/sites/${site.id}/publish`, { ...body, confirm: true }))
        .statusCode,
    ).toBe(403);
    delete hub.settings['managed.restrict'];
    hub.settings['sites.remoteTargets'] = false;
    const off = await hub.call('POST', `/api/v1/sites/${site.id}/publish-plan`, body);
    expect(off.statusCode).toBe(403);
    expect(off.json<{ error: { details: unknown } }>().error.details).toEqual({
      reason: 'remote_targets_off',
    });
    expect(
      (
        await hub.call('POST', '/api/v1/sites/targets', {
          name: 'Y',
          kind: 'webdav',
          url: dav.url,
          credential: { kind: 'none' },
        })
      ).statusCode,
    ).toBe(403);
    // Listing stays, so the owner can still see and remove what is there.
    expect((await hub.call('GET', '/api/v1/sites/targets')).statusCode).toBe(200);
  });
});
