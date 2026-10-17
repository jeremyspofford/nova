// Sites (FR-037): generate from a space or an artifact, connect JSON/CSV data, keep versions, a
// sandboxable one-document preview, a zip, and explicit, reversible publishing to a folder or a zip.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, uuidv7 } from '@nova/shared';
import { SITE_MARKER, parseCsv, parseData, renderSpaceSite } from '../src/index.ts';
import { writeAttachmentBlob } from '../src/attachments.ts';
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

/** A project source holding `text` (as SourceService stores one). */
function source(name: string, mime: string, text: string): string {
  const now = new Date().toISOString();
  let project = env.db.raw.prepare('SELECT id FROM project WHERE account_id = ?').get(ACCOUNT) as
    { id: string } | undefined;
  if (!project) {
    project = { id: uuidv7() };
    env.db.raw
      .prepare(
        "INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, 'Sales', ?, ?)",
      )
      .run(project.id, ACCOUNT, now, now);
  }
  const blob = writeAttachmentBlob(env.dataDir, Buffer.from(text, 'utf8'));
  const id = uuidv7();
  env.db.raw
    .prepare(
      `INSERT INTO source (id, account_id, project_id, name, mime, size, sha256, blob_path, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`,
    )
    .run(id, ACCOUNT, project.id, name, mime, text.length, blob.sha256, blob.blobPath, now, now);
  return id;
}

async function spaceSite() {
  const space = await env.spaces.createSpace(ACCOUNT, { name: 'Handbook' });
  await env.spaces.createPage(ACCOUNT, space.id, {
    title: 'Home',
    content:
      '# Welcome\n\nSee [the numbers](numbers.html) and [details](#welcome).\n\n```nova-table sales\n```',
  });
  await env.spaces.createPage(ACCOUNT, space.id, {
    title: 'Numbers',
    content:
      '```chart\n{"type":"bar","data":{"source":"sales","x":"month","y":["total"]},"title":"Sales <b>"}\n```\n\n```diagram\nflowchart\na[Plan] --> b[Ship]\n```\n\n```chart\n{"type":"pie"}\n```',
  });
  const sales = source('sales.csv', 'text/csv', 'month,total\nJan,10\nFeb,"1,5"\n');
  const site = await env.sites.create(ACCOUNT, {
    name: 'Team site',
    description: 'Our handbook',
    source: { kind: 'space', spaceId: space.id },
    data: [{ sourceId: sales, name: 'sales' }],
  });
  return { space, site };
}

describe('data', () => {
  it('parses CSV with quotes and numbers, and JSON lists', () => {
    expect(parseCsv('a,b\r\n1,"x, ""y"""\n2.5,\n')).toEqual([
      { a: 1, b: 'x, "y"' },
      { a: 2.5, b: '' },
    ]);
    expect(parseData(Buffer.from('{"rows":[{"a":1,"b":{"c":2}},3]}'), 'json')).toEqual([
      { a: 1, b: '{"c":2}' },
      { value: 3 },
    ]);
    expect(() => parseData(Buffer.from('{"a":1}'), 'json')).toThrow(/list of rows/);
    expect(() => parseData(Buffer.from('nope'), 'json')).toThrow(/not valid JSON/);
  });
});

describe('sites', () => {
  it('builds versions from a space: pages, data, charts, diagrams and a one-document preview', async () => {
    const { site } = await spaceSite();
    expect(site).toMatchObject({
      sourceLabel: 'Handbook',
      latestVersion: null,
      publishedVersion: null,
    });
    expect((await env.sites.dataSources(ACCOUNT)).map((d) => d.name)).toEqual(['sales.csv']);
    const v1 = await env.sites.build(ACCOUNT, site.id, { note: 'first' });
    expect(v1).toMatchObject({ version: 1, note: 'first', scripts: false, published: false });
    expect(v1.files.map((f) => f.path)).toEqual(['data/sales.json', 'index.html', 'numbers.html']);
    const { bytes } = await env.sites.zip(ACCOUNT, site.id, 1);
    const files = unzipSync(new Uint8Array(bytes));
    const index = strFromU8(files['index.html']!);
    const numbers = strFromU8(files['numbers.html']!);
    expect(index).toContain('<title>Home · Team site</title>');
    expect(index).toContain('<a href="numbers.html">the numbers</a>');
    expect(index).toContain('<td>Jan</td><td>10</td>');
    expect(index).not.toMatch(/<script/i);
    expect(numbers).toContain('<svg xmlns="http://www.w3.org/2000/svg" class="nv-viz"');
    expect(numbers).toContain('aria-label="Sales &lt;b&gt;. Bar chart of total over 2 categories"');
    expect(numbers).toContain('Flowchart with 2 steps');
    expect(numbers).toContain('The chart could not be drawn');
    expect(JSON.parse(strFromU8(files['data/sales.json']!))).toEqual([
      { month: 'Jan', total: 10 },
      { month: 'Feb', total: '1,5' },
    ]);
    const preview = (await env.sites.preview(ACCOUNT, site.id, 1)).html.toString('utf8');
    expect(preview).toContain('<section class="page" id="page-home"');
    expect(preview).toContain('<a href="#page-numbers">the numbers</a>');
    expect(preview).toContain('<a href="#p-home--welcome">details</a>');
    expect(preview).toContain('.page:target');
    const v2 = await env.sites.build(ACCOUNT, site.id);
    expect(v2.version).toBe(2);
    expect(v2.sha256).toBe(v1.sha256);
    expect((await env.sites.versions(ACCOUNT, site.id)).map((v) => v.version)).toEqual([2, 1]);
    expect((await env.sites.get(ACCOUNT, site.id)).latestVersion).toBe(2);
    expect(env.events.names()).toEqual(
      expect.arrayContaining(['site.created', 'site.version.created']),
    );
  });

  it('refuses sources that are not JSON or CSV, unknown spaces, and other accounts', async () => {
    const space = await env.spaces.createSpace(ACCOUNT, { name: 'S' });
    const txt = source('notes.txt', 'text/plain', 'hello');
    expect(
      (
        await caught(
          env.sites.create(ACCOUNT, {
            name: 'x',
            source: { kind: 'space', spaceId: space.id },
            data: [{ sourceId: txt, name: 'n' }],
          }),
        )
      ).details,
    ).toMatchObject({ reason: 'data_format' });
    expect(
      (
        await caught(
          env.sites.create(ACCOUNT, { name: 'x', source: { kind: 'space', spaceId: 'nope' } }),
        )
      ).code,
    ).toBe('not_found');
    const site = await env.sites.create(ACCOUNT, {
      name: 'x',
      source: { kind: 'space', spaceId: space.id },
    });
    expect((await caught(env.sites.get(OTHER, site.id))).code).toBe('not_found');
    expect((await caught(env.sites.build(OTHER, site.id))).code).toBe('not_found');
    expect((await caught(env.sites.preview(ACCOUNT, site.id, 1))).code).toBe('not_found');
    // A deleted space: building says so.
    await env.spaces.deleteSpace(ACCOUNT, space.id);
    expect((await caught(env.sites.build(ACCOUNT, site.id))).details).toMatchObject({
      reason: 'source_missing',
    });
  });

  it('builds from an HTML artifact (its scripts run only in the sandboxed preview) or a Markdown one', async () => {
    const html = await env.artifacts.save({
      accountId: ACCOUNT,
      threadId: null,
      messageId: null,
      kind: 'html',
      title: 'Landing',
      content: '<!doctype html><h1>Hi</h1><script>console.log(1)</script>',
    });
    const site = await env.sites.create(ACCOUNT, {
      name: 'Landing',
      source: { kind: 'artifact', artifactId: html.id },
    });
    expect(site.sourceLabel).toBe('Landing');
    const v = await env.sites.build(ACCOUNT, site.id);
    expect(v).toMatchObject({ scripts: true, files: [{ path: 'index.html' }] });
    expect((await env.sites.preview(ACCOUNT, site.id, 1)).scripts).toBe(true);
    const md = await env.artifacts.save({
      accountId: ACCOUNT,
      threadId: null,
      messageId: null,
      kind: 'markdown',
      title: 'Doc',
      content: '# Doc',
    });
    const mdSite = await env.sites.create(ACCOUNT, {
      name: 'Doc',
      source: { kind: 'artifact', artifactId: md.id },
    });
    expect((await env.sites.build(ACCOUNT, mdSite.id)).scripts).toBe(false);
    const code = await env.artifacts.save({
      accountId: ACCOUNT,
      threadId: null,
      messageId: null,
      kind: 'code',
      title: 'x.ts',
      content: 'x',
    });
    expect(
      (
        await caught(
          env.sites.create(ACCOUNT, {
            name: 'x',
            source: { kind: 'artifact', artifactId: code.id },
          }),
        )
      ).details,
    ).toMatchObject({
      reason: 'source_kind',
    });
  });

  it('publishes to a folder, rolls back, and unpublishing restores the previous publish', async () => {
    const { space, site } = await spaceSite();
    const root = join(env.dir, 'published');
    env.publishRoot.value = root;
    await env.sites.build(ACCOUNT, site.id);
    const [page] = await env.spaces.listPages(ACCOUNT, space.id);
    await env.spaces.savePage(ACCOUNT, space.id, page!.id, {
      baseVersion: 1,
      content: 'Version two text',
    });
    await env.sites.build(ACCOUNT, site.id);

    const p1 = await env.sites.publish(ACCOUNT, site.id, {
      version: 1,
      target: { kind: 'folder', folder: 'team' },
    });
    const dir = join(root, 'team');
    expect(p1.folderPath).toBe(dir);
    expect(readFileSync(join(dir, SITE_MARKER), 'utf8').trim()).toBe(site.id);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('Welcome');
    env.clock.tick();
    const p2 = await env.sites.publish(ACCOUNT, site.id, {
      version: 2,
      target: { kind: 'folder', folder: 'team' },
    });
    expect(p2.site).toMatchObject({
      publishedVersion: 2,
      publishedTarget: { kind: 'folder', folder: 'team' },
    });
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('Version two text');
    expect((await env.sites.versions(ACCOUNT, site.id)).find((v) => v.published)?.version).toBe(2);

    env.clock.tick();
    const back = await env.sites.unpublish(ACCOUNT, site.id);
    expect(back.site.publishedVersion).toBe(1);
    expect(back.publish).toMatchObject({ version: 1, current: true });
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('Welcome');
    const history = await env.sites.publishes(ACCOUNT, site.id);
    expect(history.map((h) => [h.version, h.current, h.revertedAt !== null])).toEqual([
      [2, false, true],
      [1, true, false],
    ]);
    // Deleting a published site is refused; unpublishing the last one removes the folder.
    expect((await caught(env.sites.delete(ACCOUNT, site.id))).details).toMatchObject({
      reason: 'published',
    });
    const none = await env.sites.unpublish(ACCOUNT, site.id);
    expect(none.site.publishedVersion).toBeNull();
    expect(existsSync(dir)).toBe(false);
    expect((await caught(env.sites.unpublish(ACCOUNT, site.id))).details).toMatchObject({
      reason: 'not_published',
    });
    await env.sites.delete(ACCOUNT, site.id);
    expect(await env.sites.list(ACCOUNT)).toEqual([]);
    expect(env.audit.map((r) => r.action)).toEqual(
      expect.arrayContaining(['site.published', 'site.unpublished', 'site.deleted']),
    );
    expect(env.events.names()).toEqual(
      expect.arrayContaining(['site.published', 'site.unpublished', 'site.deleted']),
    );
  });

  it('never replaces a folder Nova did not publish, and moves between folders and zip targets', async () => {
    const { site } = await spaceSite();
    const root = join(env.dir, 'published');
    env.publishRoot.value = root;
    await env.sites.build(ACCOUNT, site.id);
    mkdirSync(join(root, 'taken'), { recursive: true });
    writeFileSync(join(root, 'taken', 'index.html'), 'someone else');
    expect(
      (
        await caught(
          env.sites.publish(ACCOUNT, site.id, {
            version: 1,
            target: { kind: 'folder', folder: 'taken' },
          }),
        )
      ).details,
    ).toMatchObject({ reason: 'folder_in_use' });
    expect(readFileSync(join(root, 'taken', 'index.html'), 'utf8')).toBe('someone else');
    expect(
      (await caught(env.sites.publish(ACCOUNT, site.id, { version: 9, target: { kind: 'zip' } })))
        .code,
    ).toBe('not_found');

    await env.sites.publish(ACCOUNT, site.id, {
      version: 1,
      target: { kind: 'folder', folder: 'a' },
    });
    env.clock.tick();
    const zip = await env.sites.publish(ACCOUNT, site.id, { version: 1, target: { kind: 'zip' } });
    expect(zip.folderPath).toBeNull();
    expect(zip.site.publishedTarget).toEqual({ kind: 'zip' });
    // Moving off folder "a" took the site out of it; unpublishing the zip puts it back.
    expect(existsSync(join(root, 'a'))).toBe(false);
    env.clock.tick();
    await env.sites.unpublish(ACCOUNT, site.id);
    expect(existsSync(join(root, 'a', 'index.html'))).toBe(true);
  });

  it('uses <data>/sites when no publish root is set', async () => {
    expect(await env.sites.publishRoot()).toBe(join(env.dataDir, 'sites'));
  });

  it('renders an empty space as a one-page site and keeps a page named index from overwriting home', () => {
    const empty = renderSpaceSite({ name: 'Empty', description: null, pages: [], data: {} });
    expect([...empty.files.keys()]).toEqual(['index.html']);
    const two = renderSpaceSite({
      name: 'S',
      description: null,
      pages: [
        { slug: 'home', title: 'Home', content: '[Home](home.html)' },
        { slug: 'index', title: 'Index', content: 'x' },
      ],
      data: {},
    });
    expect([...two.files.keys()].sort()).toEqual(['index-page.html', 'index.html']);
    expect(two.files.get('index.html')!.toString()).toContain('<a href="index.html">Home</a>');
  });
});
