// What an app token may reach (FR-222, ADR-097 D6, D7). An app token reaches only the routes listed
// here, each under one scope; every other route (owner administration, writes, anything added
// later) is refused, so the list fails closed. The scope vocabulary is APP_SCOPES in
// packages/shared/src/m8/appauth.ts.
import { APP_SCOPES, isAppScope, type AppAuthorizationView, type AppScope } from '@nova/shared';

export interface AppRouteRule {
  method: 'GET';
  /** A Fastify route pattern, matched exactly against the matched route. */
  pattern: string;
  scope: AppScope;
}

const get = (pattern: string, scope: AppScope): AppRouteRule => ({ method: 'GET', pattern, scope });

/** The app-scoped routes (D7's `app-scoped` class): reads of the authorizing account's data. */
export const APP_ROUTE_SCOPES: readonly AppRouteRule[] = [
  get('/api/v1/account', 'account:read'),
  get('/api/v1/account/avatar', 'account:read'),
  get('/api/v1/projects', 'projects:read'),
  get('/api/v1/projects/:id', 'projects:read'),
  get('/api/v1/threads', 'threads:read'),
  get('/api/v1/threads/:id', 'threads:read'),
  get('/api/v1/threads/:id/tree', 'threads:read'),
  get('/api/v1/search', 'threads:read'),
  get('/api/v1/attachments/:id', 'threads:read'),
  get('/api/v1/artifacts', 'threads:read'),
  get('/api/v1/artifacts/:id', 'threads:read'),
  get('/api/v1/artifacts/:id/preview', 'threads:read'),
  get('/api/v1/artifacts/:id/content', 'threads:read'),
  get('/api/v1/runs', 'runs:read'),
  get('/api/v1/runs/:id', 'runs:read'),
  get('/api/v1/runs/:id/activity', 'runs:read'),
  get('/api/v1/runs/:id/goal', 'runs:read'),
  get('/api/v1/runs/:id/subagents', 'runs:read'),
  get('/api/v1/goals', 'runs:read'),
  get('/api/v1/goals/:id', 'runs:read'),
  get('/api/v1/memory/items', 'memory:read'),
  get('/api/v1/notifications', 'notifications:read'),
  get('/api/v1/usage', 'usage:read'),
];

/**
 * The OAuth routes themselves: public, authenticated another way (contracts/hub-api.md §1). An app
 * that sends its bearer token to them anyway is not refused for it.
 */
export const APP_OAUTH_PUBLIC_ROUTES: readonly string[] = [
  'POST /api/v1/apps/register',
  'POST /api/v1/oauth/token',
  'POST /api/v1/oauth/revoke',
  'GET /.well-known/oauth-authorization-server',
];

/**
 * The scope a route needs from an app token, `'public'` for the OAuth routes, or null when no app
 * token may call it. HEAD is GET's.
 */
export function appRouteScope(
  method: string,
  route: string | undefined,
): AppScope | 'public' | null {
  if (!route) return null;
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  if (APP_OAUTH_PUBLIC_ROUTES.includes(`${m} ${route}`)) return 'public';
  return APP_ROUTE_SCOPES.find((r) => r.method === m && r.pattern === route)?.scope ?? null;
}

/** APP_SCOPES order, without duplicates. */
export function sortScopes(scopes: Iterable<string>): AppScope[] {
  const set = new Set(scopes);
  return APP_SCOPES.filter((s) => set.has(s));
}

/** An OAuth `scope` parameter (space-separated). */
export function parseScopeParam(value: string): { scopes: AppScope[]; unknown: string[] } {
  const words = value.split(' ').filter(Boolean);
  return {
    scopes: sortScopes(words.filter(isAppScope)),
    unknown: words.filter((w) => !isAppScope(w)),
  };
}

export function formatScopes(scopes: Iterable<string>): string {
  return sortScopes(scopes).join(' ');
}

/** A JSON array of scope names; anything unreadable grants nothing (fail closed). */
export function readScopeList(json: string | null | undefined): AppScope[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? sortScopes(v.filter((x): x is string => typeof x === 'string')) : [];
  } catch {
    return [];
  }
}

/**
 * An app authorization's `scopes` column: the MCP-shaped scopes the M4 list shows
 * (AppAuthorizationView.scopes: no tools, read only) plus `app`, the granted scope names.
 */
export function grantScopesJson(scopes: Iterable<string>): string {
  const app = sortScopes(scopes);
  const shape: AppAuthorizationView['scopes'] & { app: AppScope[] } = {
    tools: [],
    projects: app.includes('projects:read') ? '*' : [],
    threads: app.includes('threads:read') ? 'read' : 'none',
    mode: 'read_only',
    app,
  };
  return JSON.stringify(shape);
}

/** The granted scope names of an app authorization's `scopes` column. */
export function readGrantScopes(json: string | null | undefined): AppScope[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as { app?: unknown };
    return Array.isArray(v.app)
      ? sortScopes(v.app.filter((x): x is string => typeof x === 'string'))
      : [];
  } catch {
    return [];
  }
}
