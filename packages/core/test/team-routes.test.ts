// The route classification (ADR-097 D7, R-032) as data: every entry is a method and a Fastify
// pattern, listed once, in a known class; the owner-only rules and the member guard follow it.
// apps/hub/test/routes.test.ts checks it against the fully wired Hub's route table.
import { describe, expect, it } from 'vitest';
import {
  OWNER_ONLY_ROUTES,
  ROUTE_CLASSES,
  ROUTE_GROUPS,
  UNCLASSIFIED_WHY,
  WEB_SHELL_ROUTES,
  ownerOnlyReason,
  routeClass,
  routeEntry,
} from '../src/index.ts';

const ENTRY = /^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9_./:@*-]*$/;

describe('the route classification', () => {
  it('lists each route once, well formed, in a known class', () => {
    const seen = new Map<string, string>();
    const twice: string[] = [];
    for (const g of ROUTE_GROUPS) {
      expect(ROUTE_CLASSES).toContain(g.class);
      expect(g.why.trim().length, g.class).toBeGreaterThan(3);
      expect(g.routes.length, g.why).toBeGreaterThan(0);
      for (const r of g.routes) {
        expect(r, g.why).toMatch(ENTRY);
        if (seen.has(r)) twice.push(r);
        seen.set(r, g.class);
      }
    }
    expect(twice).toEqual([]);
    for (const cls of ROUTE_CLASSES) expect(ROUTE_GROUPS.some((g) => g.class === cls)).toBe(true);
  });

  it('derives the owner-only rules from the owner groups', () => {
    const owner = ROUTE_GROUPS.filter((g) => g.class === 'owner').flatMap((g) => g.routes);
    expect(OWNER_ONLY_ROUTES).toHaveLength(owner.length);
    for (const rule of OWNER_ONLY_ROUTES) {
      expect(rule.methods).toHaveLength(1);
      const m = (rule.methods as string[])[0]!;
      expect(routeClass(m, rule.pattern)).toBe('owner');
      expect(ownerOnlyReason(m, rule.pattern)).toBe(rule.why);
    }
  });

  it('answers by class, with HEAD as GET and the web shell public', () => {
    expect(routeClass('GET', '/api/v1/threads')).toBe('member');
    expect(routeClass('head', '/api/v1/threads')).toBe('member');
    expect(routeClass('PATCH', '/api/v1/settings')).toBe('owner');
    expect(routeClass('POST', '/agent/v1/heartbeat')).toBe('device');
    expect(routeClass('GET', '/boot/ipxe/:token')).toBe('device');
    expect(routeClass('POST', '/node/v1/register')).toBe('node');
    expect(routeClass('POST', '/mcp')).toBe('app');
    expect(routeClass('GET', '/api/v1/hello')).toBe('public');
    expect(routeClass('GET', '/assets/app.js')).toBe('public');
    expect(routeClass('GET', '/assets/sub/app.css')).toBe('public');
    expect(routeClass('HEAD', '/sw.js')).toBe('public');
    expect(routeEntry('GET', '/')).toEqual({ class: 'public', why: "the web shell's files" });
    expect(routeClass('GET', '/api/v1/nothing-here')).toBeNull();
    expect(routeClass('GET', '/boot/other')).toBeNull();
    expect(routeClass('GET', undefined)).toBeNull();
    expect(routeEntry('GET', '/api/v1/settings')).toEqual({
      class: 'owner',
      why: "the Hub's settings",
    });
    expect(routeEntry('GET', '/api/v1/nothing-here')).toBeNull();
    expect(ownerOnlyReason('GET', '/api/v1/nothing-here')).toBe(UNCLASSIFIED_WHY);
  });

  it('treats any unlisted route as unclassified, outside the API too (fail closed)', () => {
    for (const [m, r] of [
      ['GET', '/mcp/x'],
      ['GET', '/robots.txt'],
      ['GET', '/me/threads'],
      ['GET', '/assets/:file'],
      ['GET', '/assets/*'],
      ['GET', '/assets/'],
      ['POST', '/assets/app.js'],
      ['POST', '/'],
      ['GET', '/.well-known/other'],
    ] as const) {
      expect(routeClass(m, r), `${m} ${r}`).toBeNull();
      expect(ownerOnlyReason(m, r), `${m} ${r}`).toBe(UNCLASSIFIED_WHY);
    }
    // The web shell list is GET only and names no API path.
    for (const r of WEB_SHELL_ROUTES) {
      expect(r).toMatch(ENTRY);
      expect(r.startsWith('GET /')).toBe(true);
      expect(r).not.toMatch(/^GET \/(api|node|agent|boot|mcp)\b/);
    }
    expect(ownerOnlyReason('POST', '/mcp')).toBeNull();
  });
});
