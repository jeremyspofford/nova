// Sites routes (FR-037): sessions, the data sources a site can connect, builds and versions, the
// preview served sandboxed (no script for page sites, an opaque origin always), the zip download,
// publishing that needs an explicit confirm, rollback and unpublish, and refusing to delete a
// published site.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  uuidv7,
  type SitePublishResult,
  type SiteVersionView,
  type SiteView,
  type SpaceView,
} from '@nova/shared';
import { ArtifactService, writeAttachmentBlob } from '@nova/core';
import { SITE_PREVIEW_CSP, SITE_SCRIPT_PREVIEW_CSP } from '../src/spaces.ts';
import { ACCOUNT, AUTH_OTHER, spacesHub, type SpacesHub } from './spaces-env.ts';

let hub: SpacesHub;
beforeEach(async () => {
  hub = await spacesHub();
});
afterEach(() => hub.close());

function jsonSource(name: string, text: string): string {
  const now = new Date().toISOString();
  const projectId = uuidv7();
  hub.db.raw
    .prepare(
      "INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, 'Data', ?, ?)",
    )
    .run(projectId, ACCOUNT, now, now);
  const blob = writeAttachmentBlob(hub.dataDir, Buffer.from(text));
  const id = uuidv7();
  hub.db.raw
    .prepare(
      `INSERT INTO source (id, account_id, project_id, name, mime, size, sha256, blob_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'application/json', ?, ?, ?, 'ready', ?, ?)`,
    )
    .run(id, ACCOUNT, projectId, name, text.length, blob.sha256, blob.blobPath, now, now);
  return id;
}

async function siteFromSpace(): Promise<SiteView> {
  const s = (await hub.call('POST', '/api/v1/spaces', { name: 'Docs' })).json<SpaceView>();
  await hub.call('POST', `/api/v1/spaces/${s.id}/pages`, {
    title: 'Home',
    content: '# Hello\n\n```nova-table items\n```',
  });
  const items = jsonSource('items.json', '[{"name":"a","n":1}]');
  const res = await hub.call('POST', '/api/v1/sites', {
    name: 'Docs site',
    source: { kind: 'space', spaceId: s.id },
    data: [{ sourceId: items, name: 'items' }],
  });
  expect(res.statusCode).toBe(201);
  return res.json<SiteView>();
}

describe('sites routes', () => {
  it('requires a session on every route', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/v1/sites'],
      ['GET', '/api/v1/sites/data-sources'],
      ['POST', '/api/v1/sites'],
      ['GET', '/api/v1/sites/x'],
      ['PATCH', '/api/v1/sites/x'],
      ['DELETE', '/api/v1/sites/x'],
      ['POST', '/api/v1/sites/x/build'],
      ['GET', '/api/v1/sites/x/versions'],
      ['GET', '/api/v1/sites/x/versions/1/preview'],
      ['GET', '/api/v1/sites/x/versions/1/zip'],
      ['GET', '/api/v1/sites/x/publishes'],
      ['POST', '/api/v1/sites/x/publish'],
      ['POST', '/api/v1/sites/x/unpublish'],
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

  it('builds, previews sandboxed and downloads a version', async () => {
    const site = await siteFromSpace();
    expect(
      (await hub.call('GET', '/api/v1/sites/data-sources'))
        .json<{ items: { name: string }[] }>()
        .items.map((d) => d.name),
    ).toEqual(['items.json']);
    const built = await hub.call('POST', `/api/v1/sites/${site.id}/build`, { note: 'first' });
    expect(built.statusCode).toBe(201);
    expect(built.json<SiteVersionView>()).toMatchObject({
      version: 1,
      note: 'first',
      scripts: false,
    });
    const preview = await hub.call('GET', `/api/v1/sites/${site.id}/versions/1/preview`);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(preview.headers['content-security-policy']).toBe(SITE_PREVIEW_CSP);
    expect(SITE_PREVIEW_CSP).toMatch(/^sandbox;/);
    expect(SITE_PREVIEW_CSP).not.toMatch(/allow-same-origin|allow-scripts/);
    expect(preview.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(preview.body).toContain('<td>a</td><td>1</td>');
    const zip = await hub.call('GET', `/api/v1/sites/${site.id}/versions/1/zip`);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.headers['content-disposition']).toBe('attachment; filename="Docs-site-v1.zip"');
    const files = unzipSync(new Uint8Array(zip.rawPayload));
    expect(Object.keys(files).sort()).toEqual(['data/items.json', 'index.html']);
    expect(strFromU8(files['index.html']!)).toContain('<h1 id="hello">Hello</h1>');
    expect((await hub.call('GET', `/api/v1/sites/${site.id}/versions/2/preview`)).statusCode).toBe(
      404,
    );
    expect(
      (await hub.call('GET', `/api/v1/sites/${site.id}/versions/1/preview`, undefined, AUTH_OTHER))
        .statusCode,
    ).toBe(404);
    expect(
      (await hub.call('GET', `/api/v1/sites/${site.id}/versions`)).json<{
        items: SiteVersionView[];
      }>().items,
    ).toHaveLength(1);
  });

  it('lets an HTML artifact keep its scripts only inside the opaque-origin preview', async () => {
    const artifacts = new ArtifactService({ db: hub.db, events: hub.events, dataDir: hub.dataDir });
    const view = await artifacts.save({
      accountId: ACCOUNT,
      threadId: null,
      messageId: null,
      kind: 'html',
      title: 'Page',
      content: '<h1>x</h1><script>1</script>',
    });
    const site = (
      await hub.call('POST', '/api/v1/sites', {
        name: 'Art',
        source: { kind: 'artifact', artifactId: view.id },
      })
    ).json<SiteView>();
    await hub.call('POST', `/api/v1/sites/${site.id}/build`, {});
    const preview = await hub.call('GET', `/api/v1/sites/${site.id}/versions/1/preview`);
    expect(preview.headers['content-security-policy']).toBe(SITE_SCRIPT_PREVIEW_CSP);
    expect(SITE_SCRIPT_PREVIEW_CSP).toMatch(/^sandbox allow-scripts;/);
    expect(SITE_SCRIPT_PREVIEW_CSP).not.toMatch(/allow-same-origin/);
  });

  it('publishes only with confirm, rolls back, unpublishes and refuses to delete while published', async () => {
    const site = await siteFromSpace();
    hub.settings['sites.publishRoot'] = join(hub.dir, 'www');
    await hub.call('POST', `/api/v1/sites/${site.id}/build`, {});
    await hub.call('POST', `/api/v1/sites/${site.id}/build`, {});
    const target = { kind: 'folder', folder: 'docs' };
    expect(
      (await hub.call('POST', `/api/v1/sites/${site.id}/publish`, { version: 1, target }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await hub.call('POST', `/api/v1/sites/${site.id}/publish`, {
          version: 1,
          target,
          confirm: false,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await hub.call('POST', `/api/v1/sites/${site.id}/publish`, {
          version: 1,
          target: { kind: 'folder', folder: '../x' },
          confirm: true,
        })
      ).statusCode,
    ).toBe(400);
    const p2 = await hub.call('POST', `/api/v1/sites/${site.id}/publish`, {
      version: 2,
      target,
      confirm: true,
    });
    expect(p2.statusCode).toBe(200);
    const r2 = p2.json<SitePublishResult>();
    expect(r2).toMatchObject({
      site: { publishedVersion: 2 },
      downloadUrl: null,
      folderPath: join(hub.dir, 'www', 'docs'),
    });
    expect(existsSync(join(hub.dir, 'www', 'docs', 'index.html'))).toBe(true);
    // Rollback: publish the earlier version, as a zip download this time.
    const p1 = (
      await hub.call('POST', `/api/v1/sites/${site.id}/publish`, {
        version: 1,
        target: { kind: 'zip' },
        confirm: true,
      })
    ).json<SitePublishResult>();
    expect(p1).toMatchObject({
      site: { publishedVersion: 1, publishedTarget: { kind: 'zip' } },
      downloadUrl: `/api/v1/sites/${site.id}/versions/1/zip`,
    });
    expect(existsSync(join(hub.dir, 'www', 'docs'))).toBe(false);
    expect((await hub.call('DELETE', `/api/v1/sites/${site.id}`)).statusCode).toBe(409);
    expect((await hub.call('POST', `/api/v1/sites/${site.id}/unpublish`, {})).statusCode).toBe(400);
    const back = (
      await hub.call('POST', `/api/v1/sites/${site.id}/unpublish`, { confirm: true })
    ).json<SitePublishResult>();
    expect(back).toMatchObject({
      site: { publishedVersion: 2 },
      folderPath: join(hub.dir, 'www', 'docs'),
    });
    expect(readFileSync(join(hub.dir, 'www', 'docs', '.nova-site'), 'utf8').trim()).toBe(site.id);
    const history = (await hub.call('GET', `/api/v1/sites/${site.id}/publishes`)).json<{
      items: { version: number; current: boolean }[];
    }>();
    expect(history.items.map((h) => [h.version, h.current])).toEqual([
      [1, false],
      [2, true],
    ]);
    await hub.call('POST', `/api/v1/sites/${site.id}/unpublish`, { confirm: true });
    expect((await hub.call('DELETE', `/api/v1/sites/${site.id}`)).json()).toEqual({ ok: true });
    expect(hub.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['site.published', 'site.unpublished', 'site.deleted']),
    );
    const names = (await hub.events.since(null, 100, {})).map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'site.created',
        'site.version.created',
        'site.published',
        'site.unpublished',
        'site.deleted',
      ]),
    );
  });

  it('edits a site and validates its source and data', async () => {
    const site = await siteFromSpace();
    const renamed = await hub.call('PATCH', `/api/v1/sites/${site.id}`, {
      name: 'Renamed',
      data: [],
    });
    expect(renamed.json<SiteView>()).toMatchObject({ name: 'Renamed', data: [] });
    expect(
      (
        await hub.call('PATCH', `/api/v1/sites/${site.id}`, {
          data: [{ sourceId: 'x', name: 'Bad Name' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await hub.call('PATCH', `/api/v1/sites/${site.id}`, {
          source: { kind: 'space', spaceId: 'missing' },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await hub.call('POST', '/api/v1/sites', { name: 'x', source: { kind: 'web' } })).statusCode,
    ).toBe(400);
    expect(
      (await hub.call('GET', `/api/v1/sites/${site.id}`, undefined, AUTH_OTHER)).statusCode,
    ).toBe(404);
    expect(
      (await hub.call('GET', '/api/v1/sites'))
        .json<{ items: SiteView[] }>()
        .items.map((s) => s.name),
    ).toEqual(['Renamed']);
  });
});
