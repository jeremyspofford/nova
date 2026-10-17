import { describe, expect, it } from 'vitest';
import {
  canonicalPath,
  isProtectedAncestor,
  matchesLocation,
  pathAccess,
  within,
  withinLoose,
} from '../src/paths.ts';
import { globMatch, hostMatch, isWithinPath } from '../src/match.ts';
import type { FsContext } from '../src/types.ts';

const fs: FsContext = {
  entries: [
    { path: '/work/p1', access: 'write' },
    { path: '/work/p1/vendor', access: 'read' },
    { path: '/work/p1/secret', access: 'deny' },
    { path: '/ref', access: 'read' },
    { path: '/data/nova/workspace', access: 'write' },
  ],
  dataDir: '/data/nova',
  dataDirAllow: ['/data/nova/workspace'],
  home: '/home/u',
};

describe('canonicalPath', () => {
  it('accepts absolute POSIX, Windows and UNC paths and normalizes separators', () => {
    expect(canonicalPath('/a//b/')).toBe('/a/b');
    expect(canonicalPath('/')).toBe('/');
    expect(canonicalPath('c:\\Work\\x')).toBe('C:/Work/x');
    expect(canonicalPath('C:')).toBe('C:/');
    expect(canonicalPath('\\\\srv\\share\\x')).toBe('//srv/share/x');
  });

  it('rejects relative paths, dot segments and NUL bytes', () => {
    for (const p of ['', 'a/b', './a', '/a/../b', '/a/./b', '/a\0b', 'C:..\\x'])
      expect(canonicalPath(p), JSON.stringify(p)).toBeNull();
  });

  it('checks containment exactly and loosely', () => {
    expect(within('/a', '/a/b')).toBe(true);
    expect(within('/a', '/ab')).toBe(false);
    expect(within('/', '/x')).toBe(true);
    expect(within('C:/', 'C:/x')).toBe(true);
    expect(withinLoose('/Data/Nova', '/data/nova./x')).toBe(true);
    expect(withinLoose('/data', '/data::$DATA/x')).toBe(true);
    expect(withinLoose('/a/...', '/a/.../b')).toBe(true);
  });
});

describe('pathAccess (FR-190, docs/12 §7.2)', () => {
  const access = (p: string) => pathAccess(p, fs).access;

  it('takes the most specific entry, deny winning ties', () => {
    expect(access('/work/p1/src/a.ts')).toBe('write');
    expect(access('/work/p1/vendor/lib.js')).toBe('read');
    expect(access('/work/p1/secret/key')).toBe('deny');
    expect(access('/ref/doc.md')).toBe('read');
    expect(access('/elsewhere')).toBe('none');
    const tie = pathAccess('/t/x', {
      entries: [
        { path: '/t', access: 'write' },
        { path: '/t', access: 'deny' },
        { path: '/t', access: 'read' },
      ],
    });
    expect(tie.access).toBe('deny');
    expect(pathAccess('/t/x', { entries: [{ path: 'relative', access: 'write' }] }).access).toBe(
      'none',
    );
  });

  it('keeps .git, .nova, .agents and shell startup files read-only inside writable roots', () => {
    for (const p of [
      '/work/p1/.git/config',
      '/work/p1/sub/.git/hooks/pre-commit',
      '/work/p1/.nova/rules.json',
      '/work/p1/.agents/x',
      '/work/p1/.bashrc',
      '/work/p1/.config/fish/config.fish',
      '/work/p1/Documents/PowerShell/profile.ps1',
    ])
      expect(pathAccess(p, fs), p).toMatchObject({ access: 'read' });
    expect(pathAccess('/work/p1/.git/config', fs).reason).toBe('.git stays read-only');
  });

  it('catches case variants, trailing dots and stream suffixes', () => {
    for (const p of [
      '/work/p1/.GIT/config',
      '/work/p1/.git./config',
      '/work/p1/.git::$INDEX_ALLOCATION/x',
      '/work/p1/.Nova/x',
    ])
      expect(access(p), p).toBe('read');
    expect(access('/work/p1/.SSH/id_rsa')).toBe('deny');
  });

  it('denies traversal and symlink-style tricks that were not canonicalized', () => {
    expect(pathAccess('/work/p1/src/../../../etc/passwd', fs)).toMatchObject({ access: 'deny' });
    expect(access('/work/p1/./.git/config')).toBe('deny');
    expect(access('work/p1/a')).toBe('deny');
  });

  it('denies credential locations anywhere, for reading too', () => {
    for (const p of [
      '/work/p1/.ssh/id_rsa',
      '/home/u/.ssh/authorized_keys',
      '/work/p1/.npmrc',
      '/work/p1/.config/gcloud/creds.json',
      '/work/p1/.cargo/credentials.toml',
      '/work/p1/.docker/config.json',
      '/home/u/Library/Keychains/login.keychain-db',
      '/home/u/.mozilla/firefox/x',
    ])
      expect(pathAccess(p, fs).reason, p).toContain('credential');
    expect(access('/work/p1/.docker/other.json')).toBe('write');
    expect(access('/work/p1/.cargo/config.toml')).toBe('write');
  });

  it('denies the data directory except the workspace inside it', () => {
    expect(pathAccess('/data/nova/vault.db', fs).reason).toBe(
      'the Nova data folder is never available to tools',
    );
    expect(access('/DATA/nova/vault.db')).toBe('deny');
    expect(access('/data/nova/workspace/notes.md')).toBe('write');
    expect(
      pathAccess('/data/nova/x', {
        entries: [{ path: '/', access: 'write' }],
        dataDir: '/data/nova',
      }).access,
    ).toBe('deny');
    expect(
      pathAccess('/data/x', {
        entries: [{ path: '/', access: 'write' }],
        dataDir: 'rel',
        dataDirAllow: ['rel2'],
      }).access,
    ).toBe('write');
  });

  it('protects ancestors of protected locations from deletion', () => {
    expect(isProtectedAncestor('/work/p1', fs)).toBe(true);
    expect(isProtectedAncestor('/work', fs)).toBe(true);
    expect(isProtectedAncestor('/data', fs)).toBe(true);
    expect(isProtectedAncestor('/home/u/.SSH', fs)).toBe(true);
    expect(isProtectedAncestor('/work/p1/build', fs)).toBe(false);
    expect(isProtectedAncestor('../x', fs)).toBe(true);
    expect(isProtectedAncestor('/x', { entries: [{ path: 'rel', access: 'write' }] })).toBe(false);
  });

  it('matches multi-segment locations at any position', () => {
    expect(matchesLocation(['a', '.config', 'gh', 'hosts.yml'], [['.config', 'gh']])).toBe(
      '.config/gh',
    );
    expect(matchesLocation(['.config'], [['.config', 'gh']])).toBeNull();
  });
});

describe('matchers', () => {
  it('globs dotted names', () => {
    expect(globMatch('fs.*', 'fs.read')).toBe(true);
    expect(globMatch('fs.*', 'fs.read.more')).toBe(false);
    expect(globMatch('mcp:**', 'mcp:a.b')).toBe(true);
    expect(globMatch('**', 'anything')).toBe(true);
    expect(globMatch('a+b', 'a+b')).toBe(true);
  });

  it('matches hosts', () => {
    expect(hostMatch('*.example.com', 'api.example.com')).toBe(true);
    expect(hostMatch('*.example.com', 'example.com')).toBe(false);
    expect(hostMatch('Example.com.', 'example.com.')).toBe(true);
    expect(hostMatch('*', 'x')).toBe(true);
  });

  it('checks path containment for POSIX and Windows paths', () => {
    expect(isWithinPath('/a/b', '/a/b/c')).toBe(true);
    expect(isWithinPath('/a/b', '/a/bc')).toBe(false);
    expect(isWithinPath('C:\\work', 'C:\\work\\x.txt')).toBe(true);
    expect(isWithinPath('/', '/etc')).toBe(true);
    expect(isWithinPath('/a', '/a/../etc')).toBe(false);
  });
});
