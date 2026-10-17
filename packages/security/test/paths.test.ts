import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PathEscapeError,
  isCredentialPath,
  isProtectedPath,
  isWithin,
  realpathLenient,
  resolveWithin,
} from '../src/paths.ts';
import { hashToken, newToken, safeEqual, tokenKind } from '../src/tokens.ts';

let base: string;
let root: string;
let outside: string;
beforeEach(() => {
  base = realpathLenient(mkdtempSync(join(tmpdir(), 'nova-paths-')));
  root = join(base, 'project');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'x');
  symlinkSync(outside, join(root, 'link-out'));
  symlinkSync(join(root, 'src'), join(root, 'link-in'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('resolveWithin', () => {
  it('accepts paths inside a root, including not-yet-existing files', () => {
    expect(resolveWithin([root], 'src')).toBe(join(root, 'src'));
    expect(resolveWithin([root], 'src/new/file.ts')).toBe(join(root, 'src/new/file.ts'));
    expect(resolveWithin([root], join(root, 'link-in'))).toBe(join(root, 'src'));
  });

  it('rejects .. traversal, symlink escapes, absolute escapes and NUL bytes', () => {
    expect(() => resolveWithin([root], '../outside/secret.txt')).toThrow(PathEscapeError);
    expect(() => resolveWithin([root], 'link-out/secret.txt')).toThrow(PathEscapeError);
    expect(() => resolveWithin([root], 'link-out/new-file')).toThrow(PathEscapeError);
    expect(() => resolveWithin([root], '/etc/passwd')).toThrow(PathEscapeError);
    expect(() => resolveWithin([root], 'src\0/x')).toThrow(/nul byte/);
    expect(() => resolveWithin([], 'x')).toThrow(/no allowed roots/);
  });

  it('accepts any of several roots', () => {
    expect(resolveWithin([root, outside], join(outside, 'secret.txt'))).toBe(
      join(outside, 'secret.txt'),
    );
  });

  it('does not treat a sibling with a shared prefix as inside', () => {
    expect(isWithin('/a/project', '/a/project-2/x')).toBe(false);
    expect(isWithin('/a/project', '/a/project')).toBe(true);
  });
});

describe('protected and credential paths (FR-190)', () => {
  it('flags VCS and Nova folders inside a writable root', () => {
    expect(isProtectedPath(join(root, '.git/config'), root)).toBe(true);
    expect(isProtectedPath(join(root, 'pkg/.nova/state'), root)).toBe(true);
    expect(isProtectedPath(join(root, 'src/git.ts'), root)).toBe(false);
    expect(isProtectedPath(join(outside, '.git'), root)).toBe(false);
  });

  it('flags credential locations under home', () => {
    const home = '/home/u';
    expect(isCredentialPath('/home/u/.ssh/id_ed25519', home)).toBe(true);
    expect(isCredentialPath('/home/u/.config/gh/hosts.yml', home)).toBe(true);
    expect(isCredentialPath('/home/u/.npmrc', home)).toBe(true);
    expect(isCredentialPath('/home/u/projects/.sshx', home)).toBe(false);
    expect(isCredentialPath('/etc/ssh/sshd_config', home)).toBe(false);
  });
});

describe('tokens (FR-192)', () => {
  it('creates prefixed high-entropy tokens and hashes them', () => {
    const t = newToken('session');
    expect(t).toMatch(/^nvx_[A-Za-z0-9_-]{43}$/);
    expect(tokenKind(t)).toBe('session');
    expect(tokenKind('zzz_abc')).toBeNull();
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(newToken('session')).not.toBe(t);
  });

  it('compares in constant time and handles length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
