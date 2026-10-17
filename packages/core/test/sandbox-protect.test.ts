// Protected paths inside command sandboxes (FR-190, docs/12 §7.2): `.git`, `.nova`, `.agents`
// and shell startup files stay read-only inside writable roots, credential locations and the
// Nova data directory are hidden, and Nova's own Git invocation gets `.git` writable except its
// config, hooks and info. The mount plan is checked everywhere; where bubblewrap or a container
// engine works, a planted hook or config write is refused for real.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BwrapSandbox,
  ContainerSandbox,
  DEFAULT_SANDBOX_IMAGE,
  findOnPath,
  sandboxMounts,
  seccompArch,
  type SandboxMount,
} from '../src/tools/sandbox.ts';
import type { ExecRequest, SandboxClient } from '../src/tools/types.ts';

let dir: string;
let repo: string;
let data: string;
let outside: string;

function layout(): void {
  dir = mkdtempSync(join(tmpdir(), 'nova-protect-'));
  repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  mkdirSync(join(repo, '.git', 'objects'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[core]\n\tbare = false\n');
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(repo, '.nova'));
  writeFileSync(join(repo, '.nova', 'rules.json'), '{}');
  mkdirSync(join(repo, '.AGENTS'));
  writeFileSync(join(repo, '.bashrc'), 'echo hi\n');
  mkdirSync(join(repo, '.ssh'));
  writeFileSync(join(repo, '.ssh', 'id_ed25519'), 'PRIVATE');
  writeFileSync(join(repo, '.netrc'), 'machine x password y');
  mkdirSync(join(repo, '.cargo'));
  writeFileSync(join(repo, '.cargo', 'credentials.toml'), 'token = "x"');
  writeFileSync(join(repo, '.cargo', 'config.toml'), '');
  // A linked worktree in the repo: its `.git` is a file naming a Git directory.
  mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
  writeFileSync(join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  mkdirSync(join(repo, 'wt'));
  writeFileSync(join(repo, 'wt', '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);
  // A nested project on the way to the working directory, and one elsewhere.
  mkdirSync(join(repo, 'pkg', 'sub', '.git'), { recursive: true });
  mkdirSync(join(repo, 'other', '.git'), { recursive: true });
  // The data directory inside the root, with the workspace (itself a root) inside it.
  data = join(repo, 'nova-data');
  mkdirSync(join(data, 'workspace'), { recursive: true });
  writeFileSync(join(data, 'vault.db'), 'VAULT');
  // Links: one to a protected file in the root, one to outside every root.
  outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, '.zshrc'), '');
  symlinkSync(join(outside, '.zshrc'), join(repo, '.zshrc'));
  writeFileSync(join(repo, 'real-profile'), '');
  symlinkSync(join(repo, 'real-profile'), join(repo, '.profile'));
}

beforeAll(layout);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const byKind = (mounts: SandboxMount[], kind: SandboxMount['kind']) =>
  mounts.filter((m) => m.kind === kind).map((m) => m.path);

describe('the mount plan', () => {
  it('keeps protected paths read-only in a writable root and hides credentials', () => {
    const mounts = sandboxMounts({
      roots: [{ path: repo, access: 'write' }],
      cwd: join(repo, 'pkg', 'sub'),
    });
    const ro = byKind(mounts, 'read_only');
    expect(ro).toEqual(
      expect.arrayContaining([
        join(repo, '.git'),
        join(repo, '.nova'),
        join(repo, '.AGENTS'),
        join(repo, '.bashrc'),
        join(repo, 'real-profile'),
        join(repo, 'pkg', 'sub', '.git'),
      ]),
    );
    // Not on the way to the working directory; a link to outside every root mounts nothing.
    expect(ro).not.toContain(join(repo, 'other', '.git'));
    expect(ro.some((p) => p.startsWith(outside))).toBe(false);
    expect(byKind(mounts, 'hide_dir')).toContain(join(repo, '.ssh'));
    expect(byKind(mounts, 'hide_file')).toEqual(
      expect.arrayContaining([join(repo, '.netrc'), join(repo, '.cargo', 'credentials.toml')]),
    );
    expect(byKind(mounts, 'hide_file')).not.toContain(join(repo, '.cargo', 'config.toml'));
    // Parents before children: the root comes first.
    expect(mounts[0]).toEqual({ kind: 'root', path: repo, writable: true });
  });

  it('protects nothing extra in a read-only root but still hides credentials', () => {
    const mounts = sandboxMounts({ roots: [{ path: repo, access: 'read' }], cwd: repo });
    expect(byKind(mounts, 'read_only')).toEqual([]);
    expect(byKind(mounts, 'hide_dir')).toContain(join(repo, '.ssh'));
  });

  it("gives Nova's own Git invocation .git except config, hooks and info", () => {
    const mounts = sandboxMounts({
      roots: [{ path: repo, access: 'write' }],
      cwd: repo,
      gitWrite: true,
    });
    const ro = byKind(mounts, 'read_only');
    expect(ro).not.toContain(join(repo, '.git'));
    expect(ro).toEqual(
      expect.arrayContaining([
        join(repo, '.git', 'config'),
        join(repo, '.git', 'hooks'),
        join(repo, '.git', 'info'),
        join(repo, '.nova'),
      ]),
    );
  });

  it('follows a worktree .git file to its Git directory and common directory', () => {
    const mounts = sandboxMounts({
      roots: [
        { path: join(repo, 'wt'), access: 'write' },
        { path: join(repo, '.git'), access: 'write' },
      ],
      cwd: join(repo, 'wt'),
    });
    const ro = byKind(mounts, 'read_only');
    expect(ro).toEqual(
      expect.arrayContaining([
        join(repo, 'wt', '.git'),
        join(repo, '.git', 'worktrees', 'wt'),
        join(repo, '.git'),
      ]),
    );
  });

  it('hides the data directory but keeps a root inside it, mounted after the hiding', () => {
    const workspace = join(data, 'workspace');
    const mounts = sandboxMounts({
      roots: [
        { path: repo, access: 'write' },
        { path: workspace, access: 'write' },
      ],
      cwd: workspace,
      deniedPaths: [data, join(dir, 'not-in-a-root')],
    });
    const hideAt = mounts.findIndex((m) => m.kind === 'hide_dir' && m.path === data);
    const rootAt = mounts.findIndex((m) => m.kind === 'root' && m.path === workspace);
    expect(hideAt).toBeGreaterThan(0);
    expect(rootAt).toBeGreaterThan(hideAt);
    expect(mounts.some((m) => m.path === join(dir, 'not-in-a-root'))).toBe(false);
  });
});

describe('substrate arguments', () => {
  const req = (over: Partial<ExecRequest> = {}): ExecRequest => ({
    cmd: 'true',
    cwd: repo,
    roots: [{ path: repo, access: 'write', label: 'repo' }],
    network: 'off',
    yieldMs: 1000,
    signal: new AbortController().signal,
    ...over,
  });

  it('bubblewrap binds protected paths read-only after the root', () => {
    const args = new BwrapSandbox({ bin: '/usr/bin/bwrap', deniedPaths: [data] }).bwrapArgs(req());
    const at = (flag: string, path: string) =>
      args.findIndex((a, i) => a === flag && args[i + 1] === path);
    expect(at('--bind', repo)).toBeGreaterThan(0);
    expect(at('--ro-bind', join(repo, '.git'))).toBeGreaterThan(at('--bind', repo));
    expect(at('--tmpfs', join(repo, '.ssh'))).toBeGreaterThan(0);
    expect(at('--tmpfs', data)).toBeGreaterThan(0);
    expect(at('--ro-bind', '/dev/null')).toBeGreaterThan(0);
  });

  it('containers mount protected paths read-only and hide credentials', () => {
    const sb = new ContainerSandbox({ bin: 'docker', deniedPaths: [data] });
    const mounts = sb
      .runArgs(req(), 'n')
      .flatMap((a, i, all) => (a === '--mount' ? [all[i + 1]] : []));
    expect(mounts).toContain(`type=bind,source=${repo},target=${repo}`);
    expect(mounts).toContain(
      `type=bind,source=${join(repo, '.git')},target=${join(repo, '.git')},readonly`,
    );
    expect(mounts).toContain(`type=tmpfs,destination=${join(repo, '.ssh')}`);
    expect(mounts).toContain(`type=tmpfs,destination=${data}`);
    expect(mounts).toContain(`type=bind,source=/dev/null,target=${join(repo, '.netrc')},readonly`);
    const withGit = sb
      .runArgs(req({ gitWrite: true }), 'n')
      .filter((a) => a.includes(join(repo, '.git')));
    expect(withGit.some((a) => a.includes(`target=${join(repo, '.git')},`))).toBe(false);
    expect(withGit).toContain(
      `type=bind,source=${join(repo, '.git', 'config')},target=${join(repo, '.git', 'config')},readonly`,
    );
  });
});

// Real sandboxes: a planted hook, a config write and swapping `.git` out are all refused.
const BWRAP = findOnPath('bwrap');
let bwrapWorks = false;
if (BWRAP && process.platform === 'linux' && seccompArch()) {
  try {
    execFileSync(BWRAP, ['--unshare-all', '--ro-bind', '/', '/', 'true'], { timeout: 5000 });
    bwrapWorks = true;
  } catch {
    bwrapWorks = false;
  }
}
const ENGINE = findOnPath('docker') ?? findOnPath('podman');
let engineReady = false;
if (ENGINE) {
  try {
    execFileSync(ENGINE, ['image', 'inspect', DEFAULT_SANDBOX_IMAGE], {
      timeout: 10_000,
      stdio: 'ignore',
    });
    engineReady = true;
  } catch {
    engineReady = false;
  }
}

const substrates: [string, boolean, () => SandboxClient][] = [
  ['bubblewrap', bwrapWorks, () => new BwrapSandbox({ bin: BWRAP!, deniedPaths: [data] })],
  ['container', engineReady, () => new ContainerSandbox({ bin: ENGINE!, deniedPaths: [data] })],
];

describe.each(substrates)(
  '%s sandboxes refuse protected writes (integration)',
  (_name, ok, make) => {
    it.skipIf(ok)('skipped: the substrate is not available here', () => undefined);

    const run = async (sb: SandboxClient, cmd: string, gitWrite = false) => {
      const r = await sb.exec({
        cmd,
        cwd: repo,
        roots: [{ path: repo, access: 'write', label: 'repo' }],
        network: 'off',
        yieldMs: 60_000,
        signal: new AbortController().signal,
        ...(gitWrite ? { gitWrite } : {}),
      });
      if (r.status !== 'exited') throw new Error('still running');
      return r;
    };

    it.runIf(ok)(
      'refuses a planted hook, a config write and swapping .git out',
      async () => {
        const sb = make();
        const r = await run(
          sb,
          [
            'echo ok > plain.txt && echo plain=$?',
            'echo evil > .git/hooks/pre-commit 2>/dev/null; echo hook=$?',
            'echo "[core] sshCommand = evil" >> .git/config 2>/dev/null; echo config=$?',
            'mv .git moved 2>/dev/null; echo move=$?',
            'echo x >> .nova/rules.json 2>/dev/null; echo nova=$?',
            'echo x >> .bashrc 2>/dev/null; echo startup=$?',
            'cat .ssh/id_ed25519 2>/dev/null; echo ssh=$?',
            'cat .netrc; echo netrc=$?',
            'cat nova-data/vault.db 2>/dev/null; echo vault=$?',
          ].join('; '),
        );
        const out = r.output;
        expect(out).toContain('plain=0');
        for (const k of ['hook', 'config', 'move', 'nova', 'startup', 'ssh', 'vault'])
          expect(out, k).not.toMatch(new RegExp(`${k}=0\\b`));
        expect(out).not.toContain('PRIVATE');
        expect(out).not.toContain('VAULT');
        expect(out).not.toContain('password');
        expect(existsSync(join(repo, '.git', 'hooks', 'pre-commit'))).toBe(false);
        expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('evil');
        expect(existsSync(join(repo, '.git'))).toBe(true);
        expect(readFileSync(join(repo, 'plain.txt'), 'utf8')).toBe('ok\n');
      },
      120_000,
    );

    it.runIf(ok)(
      "lets Nova's own Git invocation write .git but not its config or hooks",
      async () => {
        const sb = make();
        const r = await run(
          sb,
          [
            'echo obj > .git/objects/x && echo objects=$?',
            'echo evil > .git/hooks/post-commit 2>/dev/null; echo hook=$?',
            'echo evil >> .git/config 2>/dev/null; echo config=$?',
          ].join('; '),
          true,
        );
        expect(r.output).toContain('objects=0');
        expect(r.output).not.toMatch(/hook=0\b/);
        expect(r.output).not.toMatch(/config=0\b/);
        expect(readFileSync(join(repo, '.git', 'objects', 'x'), 'utf8')).toBe('obj\n');
        expect(readFileSync(join(repo, '.git', 'config'), 'utf8')).not.toContain('evil');
      },
      120_000,
    );
  },
);
