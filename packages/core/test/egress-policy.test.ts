// Egress policy building blocks (FR-193, docs/12 §8): host patterns (a bare `*` and misplaced
// wildcards rejected), address classes for the private-address block, the order of decisions
// (off, deny wins, allowlist, limited methods), dev-server grants and mode narrowing; and the
// per-Hub CA that HTTPS inspection uses.
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { checkHostPattern, egressScopeSchema, hostPatternSchema } from '@nova/shared';
import {
  CertificateAuthority,
  addressAllowed,
  classifyAddress,
  decideHost,
  matchingPattern,
  narrowMode,
  validateEgressPolicy,
} from '../src/computers/index.ts';
import type { EgressPolicy } from '../src/computers/types.ts';

describe('host patterns', () => {
  it('accepts names, leftmost wildcards and IP literals; rejects the rest', () => {
    for (const ok of [
      'example.com',
      '*.example.com',
      'a-b.c_d.example',
      '10.0.0.1',
      '[::1]',
      '::1',
      'localhost',
    ])
      expect(checkHostPattern(ok), ok).toBeNull();
    expect(checkHostPattern('*')).toContain('bare *');
    expect(checkHostPattern('a.*.com')).toContain('leftmost');
    expect(checkHostPattern('*foo.com')).toContain('leftmost');
    expect(checkHostPattern('*.com')).toContain('top-level');
    expect(checkHostPattern('bad host')).toContain('not a host');
    expect(checkHostPattern('')).toBe('empty host');
    expect(checkHostPattern(`${'a'.repeat(250)}.com`)).toContain('too long');
    expect(hostPatternSchema.parse('API.Example.COM.')).toBe('api.example.com');
    expect(egressScopeSchema.safeParse({ allow: ['*'] }).success).toBe(false);
    expect(
      egressScopeSchema.safeParse({ hooks: [{ id: 'h', host: 'x.com', action: 'strip_header' }] })
        .success,
    ).toBe(false);
  });

  it('matches wildcards on subdomains only', () => {
    expect(matchingPattern(['*.example.com'], 'api.example.com')).toBe('*.example.com');
    expect(matchingPattern(['*.example.com'], 'a.b.example.com')).toBe('*.example.com');
    expect(matchingPattern(['*.example.com'], 'example.com')).toBeNull();
    expect(matchingPattern(['example.com'], 'EXAMPLE.com.')).toBe('example.com');
    expect(matchingPattern(['*'], 'anything.com')).toBeNull();
  });
});

describe('address classes', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['127.0.0.1', 'loopback'],
    ['169.254.169.254', 'link_local'],
    ['100.64.0.1', 'cgnat'],
    ['100.128.0.1', 'public'],
    ['224.0.0.1', 'multicast'],
    ['0.0.0.0', 'unspecified'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.1', 'reserved'],
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fd00::1', 'unique_local'],
    ['fe80::1%eth0', 'link_local'],
    ['ff02::1', 'multicast'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:8.8.8.8', 'public'],
    ['64:ff9b::10.0.0.1', 'private'],
    ['2001:db8::1', 'reserved'],
    ['2606:4700::1111', 'public'],
    ['[::1]', 'loopback'],
    ['not-an-ip', 'reserved'],
  ])('%s is %s', (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });
});

const policy = (p: Partial<EgressPolicy> = {}): EgressPolicy => ({
  mode: 'allowlist',
  allow: ['api.example.com', '*.cdn.example.com'],
  deny: ['blocked.cdn.example.com'],
  credentials: [],
  allowLocalBinding: false,
  ...p,
});

describe('decisions', () => {
  const d = (p: EgressPolicy, host: string, method: string | null = 'GET', devServer = false) =>
    decideHost(p, { host, port: 443, method, devServer });

  it('applies off, deny, allowlist and limited methods in order', () => {
    expect(d(policy({ mode: 'off' }), 'api.example.com').cause).toBe('policy');
    expect(d(policy(), 'blocked.cdn.example.com')).toMatchObject({
      allow: false,
      cause: 'denylist',
      rule: 'blocked.cdn.example.com',
    });
    expect(d(policy(), 'img.cdn.example.com')).toMatchObject({
      allow: true,
      rule: '*.cdn.example.com',
    });
    expect(d(policy(), 'other.com').cause).toBe('allowlist');
    expect(d(policy({ mode: 'limited' }), 'api.example.com', 'POST').cause).toBe('method');
    expect(d(policy({ mode: 'limited' }), 'api.example.com', 'head').allow).toBe(true);
    // An opaque tunnel's method is unknown: the caller decides about inspection.
    expect(d(policy({ mode: 'limited' }), 'api.example.com', null).allow).toBe(true);
  });

  it('lets a dev-server grant through only with local binding, and never past a deny', () => {
    expect(d(policy(), 'dev.local', 'GET', true).cause).toBe('allowlist');
    const local = policy({ allowLocalBinding: true });
    expect(d(local, 'dev.local', 'GET', true)).toMatchObject({ allow: true, devServer: true });
    expect(
      d(policy({ allowLocalBinding: true, deny: ['dev.local'] }), 'dev.local', 'GET', true).cause,
    ).toBe('denylist');
    expect(addressAllowed(policy(), 'public', false)).toBe(true);
    expect(addressAllowed(policy(), 'private', true)).toBe(false);
    expect(addressAllowed(local, 'loopback', true)).toBe(true);
    expect(addressAllowed(local, 'loopback', false)).toBe(false);
  });

  it('narrows modes and validates a policy as it loads', () => {
    expect(narrowMode('allowlist', 'limited')).toBe('limited');
    expect(narrowMode('limited', 'off')).toBe('off');
    expect(narrowMode('allowlist', 'allowlist')).toBe('allowlist');
    expect(validateEgressPolicy(policy({ allow: ['A.com', 'a.com.'] })).allow).toEqual(['a.com']);
    expect(() => validateEgressPolicy(policy({ allow: ['*'] }))).toThrow('bare *');
    expect(() => validateEgressPolicy(policy({ deny: ['x.*.com'] }))).toThrow('leftmost');
  });
});

describe('the per-Hub CA', () => {
  it('is created once with a private key only the Hub can read, and reloaded after', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nova-ca-'));
    try {
      const a = CertificateAuthority.loadOrCreate(join(dir, 'egress'));
      expect(statSync(join(dir, 'egress', 'ca-key.pem')).mode & 0o777).toBe(0o600);
      const b = CertificateAuthority.loadOrCreate(join(dir, 'egress'));
      expect(b.certPem).toBe(a.certPem);
      const x = new X509Certificate(a.certPem);
      expect(x.ca).toBe(true);
      expect(a.certPem).not.toContain('PRIVATE');
      expect(a.bundlePem()).toContain(a.certPem.trim());
      // An unreadable certificate is replaced.
      writeFileSync(join(dir, 'egress', 'ca-cert.pem'), 'garbage');
      const c = CertificateAuthority.loadOrCreate(join(dir, 'egress'));
      expect(c.certPem).not.toBe(a.certPem);
      // One that expires within 30 days is replaced too.
      const later = CertificateAuthority.loadOrCreate(join(dir, 'egress'), {
        now: () => new Date(Date.now() + 3660 * 86_400_000),
      });
      expect(later.certPem).not.toBe(c.certPem);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('issues leaf certificates a TLS client trusting the CA accepts, cached per host', async () => {
    const { certPem, keyPem } = CertificateAuthority.create();
    const ca = new CertificateAuthority(certPem, keyPem);
    const leaf = ca.leaf('api.example.com');
    expect(ca.leaf('api.example.com').certPem).toBe(leaf.certPem);
    const x = new X509Certificate(leaf.certPem);
    expect(x.subjectAltName).toBe('DNS:api.example.com');
    expect(x.checkIssued(new X509Certificate(certPem))).toBe(true);
    expect(new X509Certificate(ca.leaf('10.0.0.1').certPem).subjectAltName).toBe(
      'IP Address:10.0.0.1',
    );
    expect(new X509Certificate(ca.leaf('::1').certPem).subjectAltName).toContain(
      'IP Address:0:0:0:0:0:0:0:1',
    );
    const server = createServer({ SNICallback: (n, cb) => cb(null, ca.leaf(n).context) }, (s) =>
      s.end('ok'),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    const port = typeof a === 'object' && a ? a.port : 0;
    const got = await new Promise<string>((resolve, reject) => {
      const c = connect(
        { host: '127.0.0.1', port, servername: 'api.example.com', ca: certPem },
        () => {
          c.on('data', (b: Buffer) => resolve(String(b)));
        },
      );
      c.on('error', reject);
    });
    expect(got).toBe('ok');
    // A client that does not trust the CA refuses it.
    const refused = await new Promise<string>((resolve) => {
      const c = connect({ host: '127.0.0.1', port, servername: 'api.example.com' }, () =>
        resolve('accepted'),
      );
      c.on('error', (err) => resolve(err.message));
    });
    expect(refused).not.toBe('accepted');
    await new Promise((r) => server.close(r));
  });
});
