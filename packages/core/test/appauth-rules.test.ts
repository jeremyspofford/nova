// The pure rules of app authorization (FR-222, ADR-097 D6): which routes an app token reaches and
// under which scope (everything else fails closed), the scope helpers and their MCP-shaped storage,
// PKCE S256 against a known answer, and redirect URI matching.
import { describe, expect, it } from 'vitest';
import { APP_SCOPES } from '@nova/shared';
import {
  APP_ROUTE_SCOPES,
  appRouteScope,
  checkRedirectUri,
  formatScopes,
  grantScopesJson,
  isHubPath,
  isCodeVerifier,
  isS256Challenge,
  matchRedirectUri,
  parseScopeParam,
  readGrantScopes,
  readScopeList,
  redirectWith,
  s256Challenge,
  verifyPkce,
} from '../src/index.ts';

describe('app-scoped routes', () => {
  it('maps each listed read to its scope, and HEAD to GET', () => {
    expect(appRouteScope('GET', '/api/v1/threads/:id')).toBe('threads:read');
    expect(appRouteScope('HEAD', '/api/v1/threads/:id')).toBe('threads:read');
    expect(appRouteScope('get', '/api/v1/usage')).toBe('usage:read');
    expect(appRouteScope('GET', '/api/v1/projects')).toBe('projects:read');
  });

  it('refuses writes, owner administration, unknown and unmatched routes', () => {
    expect(appRouteScope('POST', '/api/v1/threads')).toBeNull();
    expect(appRouteScope('POST', '/api/v1/threads/:id/messages')).toBeNull();
    expect(appRouteScope('PATCH', '/api/v1/settings')).toBeNull();
    expect(appRouteScope('GET', '/api/v1/settings')).toBeNull();
    expect(appRouteScope('GET', '/api/v1/app-authorizations')).toBeNull();
    expect(appRouteScope('GET', '/api/v1/apps')).toBeNull();
    expect(appRouteScope('GET', '/api/v1/ws')).toBeNull();
    expect(appRouteScope('GET', undefined)).toBeNull();
    expect(appRouteScope('GET', '/api/v1/threads/:id/stream')).toBeNull();
  });

  it('lets the OAuth routes through without a scope', () => {
    expect(appRouteScope('POST', '/api/v1/oauth/token')).toBe('public');
    expect(appRouteScope('POST', '/api/v1/apps/register')).toBe('public');
    expect(appRouteScope('GET', '/api/v1/oauth/token')).toBeNull();
  });

  it('lists only GET routes under known scopes, each once', () => {
    const keys = APP_ROUTE_SCOPES.map((r) => `${r.method} ${r.pattern}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of APP_ROUTE_SCOPES) {
      expect(r.method).toBe('GET');
      expect(APP_SCOPES).toContain(r.scope);
    }
    // Every scope opens something.
    for (const s of APP_SCOPES)
      expect(
        APP_ROUTE_SCOPES.some((r) => r.scope === s),
        s,
      ).toBe(true);
  });
});

describe('scope helpers', () => {
  it('parses, orders and formats the scope parameter', () => {
    expect(parseScopeParam('threads:read  account:read threads:write')).toEqual({
      scopes: ['account:read', 'threads:read'],
      unknown: ['threads:write'],
    });
    expect(formatScopes(['usage:read', 'account:read', 'usage:read'])).toBe(
      'account:read usage:read',
    );
  });

  it('stores grants MCP-shaped for the M4 list and reads them back', () => {
    expect(JSON.parse(grantScopesJson(['usage:read']))).toEqual({
      tools: [],
      projects: [],
      threads: 'none',
      mode: 'read_only',
      app: ['usage:read'],
    });
    expect(readGrantScopes(grantScopesJson(['threads:read', 'bogus']))).toEqual(['threads:read']);
    for (const bad of ['', '{', '{"app":"x"}', 'null', '[]'])
      expect(readGrantScopes(bad), bad).toEqual([]);
    expect(readScopeList('["runs:read",3,"x"]')).toEqual(['runs:read']);
    for (const bad of [null, '{', '{}']) expect(readScopeList(bad)).toEqual([]);
  });
});

describe('PKCE', () => {
  // The known answer was computed separately (Python hashlib + urlsafe base64, no padding).
  it('matches a known S256 answer and refuses anything else', () => {
    const verifier = 'dBjftJeZ4CVP-mJ92K9qQ5bIGTJ8J1Mm4Ao6LrIovxA';
    expect(s256Challenge(verifier)).toBe('G170l-Mh6xQIrEsVWdT7xV-VNAuo_e88EMjD4BOu3iQ');
    expect(verifyPkce(verifier, 'G170l-Mh6xQIrEsVWdT7xV-VNAuo_e88EMjD4BOu3iQ')).toBe(true);
    expect(verifyPkce(`${verifier}x`, 'G170l-Mh6xQIrEsVWdT7xV-VNAuo_e88EMjD4BOu3iQ')).toBe(false);
    // `plain` (verifier == challenge) never passes.
    expect(verifyPkce(verifier, verifier)).toBe(false);
    expect(verifyPkce('short', s256Challenge('short'))).toBe(false);
    expect(isCodeVerifier('a'.repeat(42))).toBe(false);
    expect(isCodeVerifier('a'.repeat(129))).toBe(false);
    expect(isCodeVerifier('a'.repeat(43))).toBe(true);
    expect(isS256Challenge('a'.repeat(44))).toBe(false);
  });
});

describe('redirect URIs', () => {
  it('classifies what may be registered', () => {
    expect(checkRedirectUri('http://127.0.0.1:4000/cb')).toEqual({ ok: true, kind: 'loopback' });
    expect(checkRedirectUri('com.example.app://cb')).toEqual({ ok: true, kind: 'private_scheme' });
    expect(checkRedirectUri('http://127.0.0.2/cb')).toEqual({
      ok: false,
      reason: 'non_loopback_http',
    });
    expect(checkRedirectUri(`http://127.0.0.1/${'a'.repeat(500)}`)).toEqual({
      ok: false,
      reason: 'invalid_uri',
    });
    expect(checkRedirectUri('data:text/html,x')).toEqual({
      ok: false,
      reason: 'scheme_not_reverse_domain',
    });
  });

  it("refuses loopback paths under the Hub's own routes, however they are spelled", () => {
    for (const p of [
      '/api/v1/channels/oauth/callback',
      '/API/x',
      '//api/x',
      '/%61pi/x',
      '/mcp',
      '/mcp/x',
      '/node/v1',
      '/agent/v1',
      '/boot/ipxe',
      '/.well-known/x',
      '/%E0%A4%A',
    ])
      expect(isHubPath(p), p).toBe(true);
    for (const p of ['/', '/callback', '/apiary', '/oauth/api', '/mcpx'])
      expect(isHubPath(p), p).toBe(false);
    expect(checkRedirectUri('http://127.0.0.1:7/api/v1/x')).toEqual({
      ok: false,
      reason: 'hub_path',
    });
    // A private scheme never reaches the Hub.
    expect(checkRedirectUri('com.example.app:/api/cb')).toEqual({
      ok: true,
      kind: 'private_scheme',
    });
  });

  it('matches loopback on any port only, the rest exactly', () => {
    const reg = ['http://127.0.0.1/cb', 'com.example.app:/cb'];
    expect(matchRedirectUri(reg, 'http://127.0.0.1:61000/cb')).toBe('http://127.0.0.1/cb');
    expect(matchRedirectUri(reg, 'http://[::1]:61000/cb')).toBeNull();
    expect(matchRedirectUri(reg, 'com.example.app:/cb')).toBe('com.example.app:/cb');
    expect(matchRedirectUri(reg, 'com.example.app:/cb2')).toBeNull();
    expect(matchRedirectUri(reg, 'http://127.0.0.1:61000/cb/../x')).toBeNull();
    expect(matchRedirectUri(['com.example.app:/cb'], 'http://127.0.0.1/cb')).toBeNull();
  });

  it('adds parameters to the redirect', () => {
    expect(redirectWith('com.example.app:/cb', { code: 'c d', state: undefined })).toBe(
      'com.example.app:/cb?code=c+d',
    );
  });
});
