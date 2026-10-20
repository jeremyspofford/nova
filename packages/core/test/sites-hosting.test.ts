// Remote hosting targets for sites (FR-037, M8): target addresses, the egress ceiling and the
// egress-checked fetch, the WebDAV target against a fake server on 127.0.0.1 (one swap per
// publish, its own folders only, failures that change nothing), the target store with its
// credential in the vault, and publishing, planning, rolling back and unpublishing to a target.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NovaError, type SiteView } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import {
  HubFolderTarget,
  SiteTargetService,
  WebDavTarget,
  contentTypeOf,
  egressFetch,
  hostingEgress,
  hostingEgressProblem,
  hostingUrl,
  type HostingEgress,
} from '../src/index.ts';
import { fakeWebDav, folderFiles, type FakeDav } from './fixtures/hosting/fake-webdav.ts';
import { ACCOUNT, OTHER, spacesEnv, type SpacesEnv } from './spaces-env.ts';

async function caught(p: Promise<unknown>): Promise<NovaError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof NovaError) return err;
    throw err;
  }
  throw new Error('expected a NovaError');
}

const OPEN: HostingEgress = { mode: 'allowlist', deny: [], allow: [], failClosed: null };
const enc = (s: string) => new TextEncoder().encode(s);

describe('target addresses', () => {
  it('keeps https and loopback http, ending in a slash', () => {
    expect(hostingUrl('https://dav.example.com/sites', 'url')).toBe(
      'https://dav.example.com/sites/',
    );
    expect(hostingUrl('http://127.0.0.1:8080/dav/', 'url')).toBe('http://127.0.0.1:8080/dav/');
    expect(hostingUrl('http://localhost/x', 'url')).toBe('http://localhost/x/');
    expect(hostingUrl('http://[::1]:9/', 'url')).toBe('http://[::1]:9/');
    // The public address is only shown, never fetched.
    expect(hostingUrl('http://www.example.com/', 'publicUrl')).toBe('http://www.example.com/');
  });

  it('refuses http to another machine, credentials, queries and other schemes', () => {
    const reason = (raw: string, field: 'url' | 'publicUrl' = 'url') => {
      try {
        hostingUrl(raw, field);
      } catch (err) {
        return (err as NovaError).details;
      }
      return null;
    };
    expect(reason('http://dav.example.com/')).toEqual({ reason: 'https_required', field: 'url' });
    expect(reason('https://me:pw@dav.example.com/')).toMatchObject({
      reason: 'credentials_in_url',
    });
    expect(reason('https://dav.example.com/?x=1')).toMatchObject({ reason: 'url_invalid' });
    expect(reason('https://dav.example.com/#a', 'publicUrl')).toMatchObject({
      reason: 'url_invalid',
      field: 'publicUrl',
    });
    expect(reason('ftp://dav.example.com/')).toMatchObject({ reason: 'url_invalid' });
    expect(reason('not a url')).toMatchObject({ reason: 'url_invalid' });
  });
});

describe('egress ceiling', () => {
  it('narrows the mode, adds deny lists and keeps every managed allow list', () => {
    const e = hostingEgress(
      { mode: 'allowlist', deny: ['bad.example'] },
      {
        failClosed: null,
        layers: [
          { egress: { mode: 'limited', deny: ['worse.example'], allow: ['*.corp.example'] } },
          { egress: { allow: ['dav.corp.example'] } },
          {},
        ] as never,
      },
    );
    expect(e).toEqual({
      mode: 'limited',
      deny: ['bad.example', 'worse.example'],
      allow: [['*.corp.example'], ['dav.corp.example']],
      failClosed: null,
    });
    expect(
      hostingEgress({ mode: 'allowlist', deny: [] }, { failClosed: 'bad file', layers: [] }),
    ).toMatchObject({ mode: 'off', failClosed: 'bad file' });
  });

  it('says why a write is refused', () => {
    expect(hostingEgressProblem(OPEN, 'dav.example.com', 'PUT')).toBeNull();
    expect(hostingEgressProblem({ ...OPEN, mode: 'off' }, 'h', 'PUT')).toMatch(/egress off/);
    expect(hostingEgressProblem({ ...OPEN, mode: 'limited' }, 'h', 'PUT')).toMatch(/limited/);
    expect(hostingEgressProblem({ ...OPEN, mode: 'limited' }, 'h', 'GET')).toBeNull();
    expect(
      hostingEgressProblem({ ...OPEN, deny: ['*.example.com'] }, 'dav.example.com', 'PUT'),
    ).toMatch(/deny list/);
    expect(
      hostingEgressProblem(
        { ...OPEN, allow: [['dav.example.com'], ['other']] },
        'dav.example.com',
        'PUT',
      ),
    ).toMatch(/managed policy allows/);
    expect(hostingEgressProblem({ ...OPEN, failClosed: 'unsigned' }, 'h', 'GET')).toMatch(
      /could not be read \(unsigned\)/,
    );
  });

  it('stops a refused request before it leaves, and reports it', async () => {
    const inner = vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok')));
    const denied = vi.fn(() => Promise.resolve());
    const f = egressFetch(() => Promise.resolve({ ...OPEN, deny: ['127.0.0.1'] }), inner, denied);
    const err = await caught(f('http://127.0.0.1:9/dav/', { method: 'PUT' }));
    expect(err.code).toBe('policy_denied');
    expect(err.details).toEqual({ reason: 'egress_denied', host: '127.0.0.1' });
    expect(inner).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledWith('127.0.0.1', 'PUT', expect.stringMatching(/deny list/));
    // An unreadable policy refuses too.
    const broken = egressFetch(() => Promise.reject(new Error('x')), inner);
    expect((await caught(broken('http://127.0.0.1:9/'))).code).toBe('policy_denied');
    await egressFetch(() => Promise.resolve(OPEN), inner)('http://127.0.0.1:9/');
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('the egress-checked fetch with a Request', () => {
  it('reads the method and host of a Request object', async () => {
    const inner = vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok')));
    const f = egressFetch(() => Promise.resolve({ ...OPEN, mode: 'limited' }), inner);
    expect((await caught(f(new Request('http://127.0.0.1:9/x', { method: 'PUT' })))).code).toBe(
      'policy_denied',
    );
    await f(new Request('http://127.0.0.1:9/x'));
    expect(inner).toHaveBeenCalledTimes(1);
  });
});

describe('the Hub folder target', () => {
  it('refuses bad folder names, writes in one swap and leaves other folders alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-hub-target-'));
    try {
      const t = new HubFolderTarget(() => Promise.resolve(root));
      expect((await caught(t.location('Bad Name'))).code).toBe('validation');
      mkdirSync(join(root, 'theirs'));
      writeFileSync(join(root, 'theirs', 'x'), 'y');
      await t.remove('site-1', 'theirs');
      expect(existsSync(join(root, 'theirs', 'x'))).toBe(true);
      expect((await caught(t.claim('site-1', 'theirs'))).details).toEqual({
        reason: 'folder_in_use',
      });
      expect(await t.claim('site-1', 'free')).toBe(false);
      const dir = await t.put('site-1', 'mine', [
        { path: 'a/b.html', bytes: enc('x') },
        { path: 'skipped/', bytes: enc('') },
      ]);
      expect(readFileSync(join(dir, 'a', 'b.html'), 'utf8')).toBe('x');
      expect(existsSync(join(dir, 'skipped'))).toBe(false);
      expect(await t.claim('site-1', 'mine')).toBe(true);
      await t.remove('site-1', 'mine');
      expect(existsSync(dir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('WebDAV target', () => {
  let dav: FakeDav;
  beforeEach(async () => {
    dav = await fakeWebDav();
  });
  afterEach(() => dav.close());

  const target = (over: Partial<ConstructorParameters<typeof WebDavTarget>[0]> = {}) =>
    new WebDavTarget({
      url: dav.url,
      authorization: () => Promise.resolve(null),
      fetch,
      timeoutMs: 2000,
      ...over,
    });

  it('uploads into a temporary collection and swaps it in with one MOVE', async () => {
    const t = target();
    const files = [
      { path: 'index.html', bytes: enc('<h1>v1</h1>') },
      { path: 'data/sales.json', bytes: enc('[1]') },
    ];
    expect(await t.claim('site-1', 'docs')).toBe(false);
    expect(await t.put('site-1', 'docs', files)).toBe(`${dav.url}docs/`);
    expect(folderFiles(dav, 'docs')).toEqual({
      'index.html': '<h1>v1</h1>',
      'data/sales.json': '[1]',
      '.nova-site': 'site-1\n',
    });
    const methods = dav.log.map((l) => l.method);
    expect(methods.indexOf('MOVE')).toBeGreaterThan(methods.lastIndexOf('PUT'));
    expect(dav.log.find((l) => l.path.endsWith('index.html'))?.type).toBe(
      'text/html; charset=utf-8',
    );
    expect([...dav.dirs].filter((d) => d.includes('.tmp-'))).toEqual([]);
    // A new version replaces the folder whole: files it no longer has go.
    await t.put('site-1', 'docs', [{ path: 'index.html', bytes: enc('<h1>v2</h1>') }]);
    expect(folderFiles(dav, 'docs')).toEqual({
      'index.html': '<h1>v2</h1>',
      '.nova-site': 'site-1\n',
    });
    expect(await t.claim('site-1', 'docs')).toBe(true);
    await t.remove('site-1', 'docs');
    expect(folderFiles(dav, 'docs')).toEqual({});
    expect(dav.dirs.has('docs')).toBe(false);
  });

  it('never replaces or removes a folder that is not this site’s', async () => {
    const t = target();
    dav.dirs.add('mine');
    dav.files.set('mine/index.html', Buffer.from('hand made'));
    expect((await caught(t.put('site-1', 'mine', []))).details).toEqual({
      reason: 'folder_in_use',
    });
    dav.files.set('taken.html', Buffer.from('a file'));
    expect((await caught(t.claim('site-1', 'taken.html'))).details?.reason).toBe('folder_in_use');
    await t.put('site-2', 'other', [{ path: 'index.html', bytes: enc('x') }]);
    expect((await caught(t.put('site-1', 'other', []))).details?.reason).toBe('folder_in_use');
    await t.remove('site-1', 'other');
    await t.remove('site-1', 'mine');
    expect(dav.files.get('other/index.html')?.toString()).toBe('x');
    expect(dav.files.get('mine/index.html')?.toString()).toBe('hand made');
    await t.remove('site-1', 'nothing-here');
  });

  it('sends the credential and names the target’s refusals', async () => {
    dav.auth = 'Basic dTpw';
    const anon = target();
    expect((await caught(anon.check())).details).toMatchObject({
      reason: 'target_auth_failed',
      status: 401,
    });
    const t = target({ authorization: () => Promise.resolve('Basic dTpw') });
    await t.check();
    expect(dav.log.at(-1)).toMatchObject({ method: 'PROPFIND', auth: 'Basic dTpw' });
    dav.fail = { method: 'PROPFIND', status: 500 };
    expect((await caught(t.check())).details).toMatchObject({
      reason: 'target_refused',
      status: 500,
    });
    const missing = target({
      url: `${dav.url}nope/`,
      authorization: () => Promise.resolve('Basic dTpw'),
    });
    expect((await caught(missing.check())).details?.reason).toBe('target_not_found');
    // MKCOL under a collection that does not exist is 409 from the server.
    expect((await caught(missing.put('s', 'docs', []))).details?.reason).toBe('target_not_found');
    dav.redirect = true;
    expect((await caught(t.check())).details?.reason).toBe('target_redirected');
  });

  it('cleans up after a failed upload and leaves the live folder as it was', async () => {
    const t = target();
    await t.put('site-1', 'docs', [{ path: 'index.html', bytes: enc('v1') }]);
    dav.fail = { method: 'PUT', path: /about\.html$/, status: 507 };
    const err = await caught(
      t.put('site-1', 'docs', [
        { path: 'about.html', bytes: enc('a') },
        { path: 'index.html', bytes: enc('v2') },
      ]),
    );
    expect(err.details).toMatchObject({ reason: 'target_refused', status: 507 });
    expect(folderFiles(dav, 'docs')).toEqual({ 'index.html': 'v1', '.nova-site': 'site-1\n' });
    expect([...dav.dirs].filter((d) => d.includes('.tmp-'))).toEqual([]);
    dav.fail = { method: 'MOVE', status: 500 };
    expect((await caught(t.put('site-1', 'docs', []))).details?.reason).toBe('target_refused');
    expect([...dav.dirs].filter((d) => d.includes('.tmp-'))).toEqual([]);
  });

  it('times out on a target that does not answer, and names one that is not there', async () => {
    dav.hang = true;
    const slow = target({ timeoutMs: 150 });
    expect((await caught(slow.check())).details?.reason).toBe('target_timeout');
    const port = dav.port;
    await dav.close();
    const gone = new WebDavTarget({
      url: `http://127.0.0.1:${port}/dav/`,
      authorization: () => Promise.resolve(null),
      fetch,
    });
    const err = await caught(gone.check());
    expect(err.details?.reason).toBe('target_unreachable');
    expect(err.retryable).toBe(true);
    dav = await fakeWebDav();
  });

  it('refuses paths that would leave the folder and a base without a slash', async () => {
    const t = target();
    expect((await caught(t.put('s', 'docs', [{ path: '../x', bytes: enc('') }]))).code).toBe(
      'validation',
    );
    expect(() => target({ url: dav.url.slice(0, -1) })).toThrow(NovaError);
    expect(contentTypeOf('a/b.svg')).toBe('image/svg+xml');
    expect(contentTypeOf('README')).toBe('application/octet-stream');
  });
});

describe('hosting targets and publishing', () => {
  let env: SpacesEnv;
  let dav: FakeDav;
  let targets: SiteTargetService;
  let secrets: MemorySecretStore;
  let egress: HostingEgress;
  let enabled: boolean;

  beforeEach(async () => {
    env = await spacesEnv();
    dav = await fakeWebDav();
    secrets = new MemorySecretStore();
    egress = { ...OPEN };
    enabled = true;
    targets = new SiteTargetService({
      db: env.db,
      secrets,
      events: env.events,
      audit: { append: (r) => Promise.resolve(void env.audit.push(r)) },
      now: env.clock.now,
      egress: () => Promise.resolve(egress),
      enabled: () => Promise.resolve(enabled),
      timeoutMs: 2000,
    });
    env.sites.useTargets(targets);
  });
  afterEach(async () => {
    await dav.close();
    env.close();
  });

  async function builtSite(): Promise<SiteView> {
    const space = await env.spaces.createSpace(ACCOUNT, { name: 'Handbook' });
    await env.spaces.createPage(ACCOUNT, space.id, { title: 'Home', content: '# One' });
    const site = await env.sites.create(ACCOUNT, {
      name: 'Team site',
      source: { kind: 'space', spaceId: space.id },
    });
    await env.sites.build(ACCOUNT, site.id);
    await env.spaces.createPage(ACCOUNT, space.id, { title: 'More', content: '# Two' });
    await env.sites.build(ACCOUNT, site.id);
    return site;
  }

  it('keeps the credential in the vault and only its reference in the row', async () => {
    dav.auth = `Basic ${Buffer.from('nova:s3cret-pass').toString('base64')}`;
    const t = await targets.create(ACCOUNT, {
      name: 'NAS',
      kind: 'webdav',
      url: dav.url,
      publicUrl: 'https://www.example.com/sites',
      // secret-scan: fake
      credential: { kind: 'basic', username: 'nova', password: 's3cret-pass' },
    });
    expect(t).toMatchObject({
      name: 'NAS',
      url: dav.url,
      publicUrl: 'https://www.example.com/sites/',
      auth: 'basic',
      username: 'nova',
      hasCredential: true,
      sites: [],
      lastCheck: null,
    });
    const row = env.db.raw.prepare('SELECT * FROM site_target WHERE id = ?').get(t.id) as Record<
      string,
      unknown
    >;
    expect(row.secret_ref).toBe(`secret://sites/target/${t.id}/credential`);
    expect(JSON.stringify(row)).not.toContain('s3cret-pass');
    expect(await secrets.get(`secret://sites/target/${t.id}/credential`)).toBe('s3cret-pass');
    expect(JSON.stringify(env.audit)).not.toContain('s3cret-pass');
    expect(env.audit.at(-1)).toMatchObject({ action: 'site.target.created', kind: 'space' });
    expect(env.events.events.at(-1)).toMatchObject({
      name: 'site.target.changed',
      payload: { targetId: t.id, change: 'created' },
    });
    const ok = await targets.check(ACCOUNT, t.id);
    expect(ok.lastCheck).toMatchObject({ ok: true, reason: null });
    // A new credential replaces the stored one; a wrong one fails the check and says why.
    await targets.update(ACCOUNT, t.id, {
      credential: { kind: 'basic', username: 'nova', password: 'wrong' },
    });
    const bad = await targets.check(ACCOUNT, t.id);
    expect(bad.lastCheck).toMatchObject({ ok: false, reason: 'target_auth_failed' });
    await targets.update(ACCOUNT, t.id, { credential: { kind: 'bearer', token: 'tok-1' } });
    expect((await targets.get(ACCOUNT, t.id)).username).toBeNull();
    await targets.update(ACCOUNT, t.id, { credential: { kind: 'none' } });
    expect(await secrets.list('secret://sites/')).toEqual([]);
    expect((await targets.get(ACCOUNT, t.id)).hasCredential).toBe(false);
    // Another account sees nothing.
    expect(await targets.list(OTHER)).toEqual([]);
    expect((await caught(targets.get(OTHER, t.id))).code).toBe('not_found');
  });

  it('publishes to a target, rolls back, and unpublishing puts the earlier version back', async () => {
    const site = await builtSite();
    const t = await targets.create(ACCOUNT, {
      name: 'NAS',
      kind: 'webdav',
      url: dav.url,
      publicUrl: 'https://www.example.com/',
      credential: { kind: 'none' },
    });
    const target = { kind: 'remote' as const, targetId: t.id, folder: 'team' };
    const plan = await env.sites.plan(ACCOUNT, site.id, { version: 2, target });
    expect(plan).toMatchObject({
      version: 2,
      location: `${dav.url}team/`,
      remote: { targetId: t.id, name: 'NAS', publicUrl: 'https://www.example.com/team/' },
      live: null,
      takesDown: null,
      reversible: true,
      egress: { host: '127.0.0.1', allowed: true, message: null },
    });
    expect(plan.files.map((f) => f.path)).toEqual(['index.html', 'more.html']);
    expect(plan.size).toBe(plan.files.reduce((n, f) => n + f.size, 0));
    expect(dav.log).toEqual([]);

    const p2 = await env.sites.publish(ACCOUNT, site.id, { version: 2, target });
    expect(p2.publish).toMatchObject({
      version: 2,
      target,
      remote: { name: 'NAS', location: `${dav.url}team/` },
    });
    expect(p2.site).toMatchObject({ publishedVersion: 2, publishedTarget: target });
    expect(Object.keys(folderFiles(dav, 'team')).sort()).toEqual([
      '.nova-site',
      'index.html',
      'more.html',
    ]);
    expect((await targets.get(ACCOUNT, t.id)).sites).toEqual([
      { siteId: site.id, name: 'Team site', folder: 'team', version: 2 },
    ]);
    expect(env.audit.at(-1)).toMatchObject({
      action: 'site.published',
      resource: `${dav.url}team/`,
      detail: { target: 'remote', targetId: t.id, folder: 'team', version: 2 },
    });
    // The address cannot move and the target cannot go while the site is live on it.
    expect((await caught(targets.update(ACCOUNT, t.id, { url: `${dav.url}x/` }))).details).toEqual({
      reason: 'target_in_use',
    });
    expect((await caught(targets.delete(ACCOUNT, t.id))).details?.reason).toBe('target_in_use');

    env.clock.tick();
    await env.sites.publish(ACCOUNT, site.id, { version: 1, target });
    expect(Object.keys(folderFiles(dav, 'team')).sort()).toEqual(['.nova-site', 'index.html']);

    env.clock.tick();
    const back = await env.sites.unpublish(ACCOUNT, site.id);
    expect(back.publish).toMatchObject({ version: 2, current: true });
    expect(Object.keys(folderFiles(dav, 'team')).sort()).toContain('more.html');
    env.clock.tick();
    const none = await env.sites.unpublish(ACCOUNT, site.id);
    expect(none.publish).toBeNull();
    expect(none.leftBehind).toBeNull();
    expect(dav.dirs.has('team')).toBe(false);
    await targets.delete(ACCOUNT, t.id);
    expect(await targets.list(ACCOUNT)).toEqual([]);
    // History keeps naming the removed target, without its name.
    const hist = await env.sites.publishes(ACCOUNT, site.id);
    expect(hist[0]?.remote).toMatchObject({ targetId: t.id, name: null });
  });

  it('moves between the Hub folder and a target, and says what an unreachable target kept', async () => {
    const site = await builtSite();
    env.publishRoot.value = `${env.dir}/pub`;
    const t = await targets.create(ACCOUNT, {
      name: 'NAS',
      kind: 'webdav',
      url: dav.url,
      credential: { kind: 'none' },
    });
    const remote = { kind: 'remote' as const, targetId: t.id, folder: 'team' };
    await env.sites.publish(ACCOUNT, site.id, { version: 2, target: remote });
    const plan = await env.sites.plan(ACCOUNT, site.id, {
      version: 2,
      target: { kind: 'folder', folder: 'team' },
    });
    expect(plan.takesDown).toMatchObject({ target: remote, remote: { name: 'NAS' } });
    expect(plan.live).toMatchObject({ version: 2, target: remote });
    expect(plan.egress).toBeNull();
    env.clock.tick();
    const moved = await env.sites.publish(ACCOUNT, site.id, {
      version: 2,
      target: { kind: 'folder', folder: 'team' },
    });
    expect(moved.leftBehind).toBeNull();
    expect(moved.folderPath).toBe(`${env.dir}/pub/team`);
    expect(dav.dirs.has('team')).toBe(false);
    // Back to the target, then away while the target is down: the publish goes on and says so.
    env.clock.tick();
    await env.sites.publish(ACCOUNT, site.id, { version: 2, target: remote });
    dav.fail = { status: 503, sticky: true };
    env.clock.tick();
    const zip = await env.sites.publish(ACCOUNT, site.id, { version: 2, target: { kind: 'zip' } });
    expect(zip.leftBehind).toMatchObject({
      target: remote,
      location: `${dav.url}team/`,
      reason: expect.stringMatching(/503/),
    });
    expect(zip.site.publishedTarget).toEqual({ kind: 'zip' });
    const zipPlan = await env.sites.plan(ACCOUNT, site.id, { version: 1, target: { kind: 'zip' } });
    expect(zipPlan).toMatchObject({ reversible: false, location: null, takesDown: null });
  });

  it('refuses a publish the egress policy or the setting does not allow, and records nothing', async () => {
    const site = await builtSite();
    const t = await targets.create(ACCOUNT, {
      name: 'NAS',
      kind: 'webdav',
      url: dav.url,
      credential: { kind: 'none' },
    });
    const target = { kind: 'remote' as const, targetId: t.id, folder: 'team' };
    egress = { ...OPEN, deny: ['127.0.0.1'] };
    const plan = await env.sites.plan(ACCOUNT, site.id, { version: 1, target });
    expect(plan.egress).toEqual({
      host: '127.0.0.1',
      allowed: false,
      message: '127.0.0.1 is on the egress deny list',
    });
    const err = await caught(env.sites.publish(ACCOUNT, site.id, { version: 1, target }));
    expect(err.code).toBe('policy_denied');
    expect(err.details).toEqual({ reason: 'egress_denied', host: '127.0.0.1' });
    expect(dav.log).toEqual([]);
    expect(await env.sites.publishes(ACCOUNT, site.id)).toEqual([]);
    expect(env.audit.find((a) => a.action === 'site.egress.denied')).toMatchObject({
      kind: 'network',
      decision: 'deny',
      detail: { host: '127.0.0.1', method: 'GET' },
    });
    const checked = await targets.check(ACCOUNT, t.id);
    expect(checked.lastCheck).toMatchObject({ ok: false, reason: 'egress_denied' });

    egress = { ...OPEN, mode: 'limited' };
    expect((await caught(env.sites.publish(ACCOUNT, site.id, { version: 1, target }))).code).toBe(
      'policy_denied',
    );
    egress = { ...OPEN };
    enabled = false;
    for (const p of [
      env.sites.publish(ACCOUNT, site.id, { version: 1, target }),
      env.sites.plan(ACCOUNT, site.id, { version: 1, target }),
      targets.check(ACCOUNT, t.id),
      targets.create(ACCOUNT, {
        name: 'X',
        kind: 'webdav',
        url: dav.url,
        credential: { kind: 'none' },
      }),
    ])
      expect((await caught(p)).details).toEqual({ reason: 'remote_targets_off' });
    // A site still comes down from a target with targets turned off.
    enabled = true;
    await env.sites.publish(ACCOUNT, site.id, { version: 1, target });
    enabled = false;
    const down = await env.sites.unpublish(ACCOUNT, site.id);
    expect(down.leftBehind).toBeNull();
    expect(dav.dirs.has('team')).toBe(false);
  });

  it('refuses unknown targets and a remote target without the hosting service', async () => {
    const site = await builtSite();
    const target = { kind: 'remote' as const, targetId: 'nope', folder: 'team' };
    expect(
      (await caught(env.sites.publish(ACCOUNT, site.id, { version: 1, target }))).details,
    ).toEqual({ reason: 'target_missing' });
    const t = await targets.create(ACCOUNT, {
      name: 'NAS',
      kind: 'webdav',
      url: dav.url,
      credential: { kind: 'none' },
    });
    // Another account's target is not this account's.
    const other = await env.sites.create(OTHER, {
      name: 'Other',
      source: { kind: 'space', spaceId: (await env.spaces.createSpace(OTHER, { name: 'S' })).id },
    });
    await env.sites.build(OTHER, other.id);
    expect(
      (
        await caught(
          env.sites.publish(OTHER, other.id, { version: 1, target: { ...target, targetId: t.id } }),
        )
      ).code,
    ).toBe('not_found');
    const bare = await spacesEnv();
    try {
      const space = await bare.spaces.createSpace(ACCOUNT, { name: 'S' });
      const s = await bare.sites.create(ACCOUNT, {
        name: 'S',
        source: { kind: 'space', spaceId: space.id },
      });
      await bare.sites.build(ACCOUNT, s.id);
      expect((await caught(bare.sites.publish(ACCOUNT, s.id, { version: 1, target }))).code).toBe(
        'capability_missing',
      );
    } finally {
      bare.close();
    }
    // A target whose credential left the vault says so.
    await targets.update(ACCOUNT, t.id, { credential: { kind: 'bearer', token: 'abc' } });
    await secrets.delete(`secret://sites/target/${t.id}/credential`);
    expect((await targets.check(ACCOUNT, t.id)).lastCheck).toMatchObject({
      ok: false,
      reason: 'target_auth_failed',
    });
  });
});
