// Every route of the fully wired Hub is classified (ADR-097 D7; closes R-032). The sweep reads the
// live route table, so a route added later without a classification fails here, as does a
// classification whose route is gone. The classes then hold on the wire: session routes need a
// session, a member is refused every owner route before its handler runs, and the routes an app
// token may reach are member routes only.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@nova/shared';
import {
  APP_ROUTE_SCOPES,
  ROUTE_GROUPS,
  WEB_SHELL_ROUTES,
  ownerOnlyReason,
  routeClass,
  routeEntry,
} from '@nova/core';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import { Logger, MemorySink } from '@nova/telemetry';
import { SESSION_COOKIE, buildHub, type Hub } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

const HOST = '127.0.0.1:7419';

let dir: string;
let db: NovaDatabase;
let hub: Hub;
let owner: string;
let member: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-hub-routes-'));
  // The web shell as the build lays it out: the web app's public files at the root, the page,
  // and built files under assets/ (a file added to apps/web/public shows up here).
  const web = join(dir, 'web');
  cpSync(fileURLToPath(new URL('../../web/public/', import.meta.url)), web, { recursive: true });
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>Nova</title>');
  writeFileSync(join(web, 'assets', 'index-abc123.js'), '');
  const config = loadConfig({ NOVA_DATA_DIR: join(dir, 'data'), NOVA_WEB_DIR: web }, []);
  db = openDatabase({ path: ':memory:' });
  await migrate(db);
  hub = await buildHub({
    config,
    db,
    log: new Logger({ module: 'hub', sinks: [new MemorySink()] }),
  });
  const code = await hub.auth.issueSetupCode();
  const setup = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { host: HOST },
    payload: { code },
  });
  owner = setup.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  const inv = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/team/invitations',
    headers: { host: HOST, authorization: `Bearer ${owner}` },
    payload: {},
  });
  const joined = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/team/join',
    headers: { host: HOST },
    payload: { token: inv.json<{ token: string }>().token, displayName: 'Bea' },
  });
  member = joined.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
});

afterAll(async () => {
  await hub.app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Every method and path the Hub registered (HEAD mirrors GET), exactly as registered. */
function routes(): { method: string; path: string }[] {
  const seen = new Set<string>();
  return hub.routes().filter((r) => {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const API = /^\/(api|node|agent|boot)\/|^\/mcp$/;
const concrete = (path: string) =>
  path.replace(/:[A-Za-z]+/g, () => uuidv7()).replace(/\*$/, 'x/y.png');

async function call(method: string, path: string, session?: string) {
  const res = await hub.app.inject({
    method: method as 'GET',
    url: path,
    headers: { host: HOST, ...(session ? { authorization: `Bearer ${session}` } : {}) },
    ...(['POST', 'PUT', 'PATCH'].includes(method) ? { payload: {} } : {}),
  });
  let error: { code?: string; details?: { reason?: string } } | undefined;
  try {
    error = res.json<{ error?: typeof error }>().error;
  } catch {
    error = undefined;
  }
  return { status: res.statusCode, error };
}

describe('the route classification of the fully wired Hub', () => {
  it('classifies every route exactly once and lists no route that is gone', () => {
    const table = routes();
    expect(table.length).toBeGreaterThan(400);
    const keys = new Set(table.map((r) => `${r.method} ${r.path}`));
    // Every route, wherever it is: nothing outside the API is public unless it is listed.
    const unclassified = table
      .filter((r) => !routeEntry(r.method, r.path))
      .map((r) => `${r.method} ${r.path}`);
    expect(unclassified, 'add each to ROUTE_GROUPS in packages/core/src/team/routes.ts').toEqual(
      [],
    );
    const gone = ROUTE_GROUPS.flatMap((g) => g.routes).filter((r) => !keys.has(r));
    expect(gone, 'classified routes the Hub no longer registers').toEqual([]);
    // The web shell's own files are public and GET only, and every listed one is served.
    const statics = table.filter((r) => !API.test(r.path));
    expect(statics.length).toBeGreaterThan(0);
    for (const r of statics) {
      expect(r.method, r.path).toBe('GET');
      expect(routeClass(r.method, r.path), r.path).toBe('public');
    }
    const missing = WEB_SHELL_ROUTES.filter((r) =>
      r.endsWith('/*') ? ![...keys].some((k) => k.startsWith(r.slice(0, -1))) : !keys.has(r),
    );
    expect(missing, 'web shell entries the Hub does not serve').toEqual([]);
  });

  it('requires a session on every owner and member route', async () => {
    const offenders: string[] = [];
    for (const r of routes()) {
      const cls = routeClass(r.method, r.path);
      if ((cls !== 'owner' && cls !== 'member') || r.path === '/api/v1/ws') continue;
      const res = await call(r.method, concrete(r.path));
      if (res.status !== 401 || res.error?.code !== 'token_required')
        offenders.push(`${r.method} ${r.path} -> ${res.status} ${res.error?.code ?? ''}`);
    }
    expect(offenders).toEqual([]);
  });

  it('refuses a member every owner route before its handler runs', async () => {
    const offenders: string[] = [];
    let owners = 0;
    for (const r of routes()) {
      if (routeClass(r.method, r.path) !== 'owner') continue;
      owners++;
      const res = await call(r.method, concrete(r.path), member);
      if (res.status !== 403 || res.error?.details?.reason !== 'owner_only')
        offenders.push(`${r.method} ${r.path} -> ${res.status} ${res.error?.code ?? ''}`);
    }
    expect(owners).toBeGreaterThan(250);
    expect(offenders).toEqual([]);
    // The member still has their session (a refusal ends nothing), and gets the web shell.
    expect((await call('GET', '/api/v1/session', member)).status).toBe(200);
    for (const path of ['/', '/sw.js', '/assets/index-abc123.js'])
      expect((await call('GET', path, member)).status, path).toBe(200);
  });

  it('opens every other route to a member, as the guard decides it', () => {
    const refused = routes()
      .filter((r) => {
        const cls = routeClass(r.method, r.path);
        return cls !== 'owner' && ownerOnlyReason(r.method, r.path) !== null;
      })
      .map((r) => `${r.method} ${r.path}`);
    expect(refused).toEqual([]);
  });

  it('lets an app token reach member routes only', () => {
    const wrong = APP_ROUTE_SCOPES.filter((r) => routeClass(r.method, r.pattern) !== 'member').map(
      (r) => `${r.method} ${r.pattern} (${routeClass(r.method, r.pattern) ?? 'unclassified'})`,
    );
    expect(wrong).toEqual([]);
  });

  it('never refuses the owner', async () => {
    // A sample of owner routes answers the owner with anything but the member refusal.
    for (const path of ['/api/v1/settings', '/api/v1/team/removed', '/api/v1/diagnostics']) {
      const res = await call('GET', path, owner);
      expect(res.error?.details?.reason, path).not.toBe('owner_only');
    }
  });
});
