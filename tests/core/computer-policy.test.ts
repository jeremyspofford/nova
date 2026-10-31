// Nova Computer's rules (M10a), without Docker: how a workspace's container is started, which
// folders may be mounted, what an egress declaration may say, and the tier each action takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreError } from '../../src/core/errors.ts';
import { IMAGE, REGISTRIES, checkFolder, createArgs, declaredHosts, execArgs, runUser, tierFor, validateArgv, validateEgress } from '../../src/core/computer/policy.ts';

const base = { name: 'nova-computer-abc-w1', image: IMAGE, folder: '/srv-placeholder/project', tag: 'abc', ws: 'w1', user: '1000:1000' };

test('the container: no network, no privileges, limits, only the project folder mounted', () => {
  const a = createArgs(base);
  const at = (flag: string) => a.indexOf(flag);
  const value = (flag: string) => a[at(flag) + 1];
  assert.equal(a[0], 'create');
  assert.equal(value('--network'), 'none');
  assert.equal(value('--cap-drop'), 'ALL');
  assert.ok(a.includes('no-new-privileges'), 'no-new-privileges');
  assert.equal(value('--user'), '1000:1000');
  assert.equal(value('--ipc'), 'private');
  assert.equal(value('--pids-limit'), '512');
  assert.equal(value('--memory'), '2g');
  assert.equal(value('--memory-swap'), '2g', 'no swap beyond the memory limit');
  assert.equal(value('--cpus'), '2');
  assert.ok(a.includes('--init'));
  // Exactly one mount, the project folder, and no volume flags at all.
  const mounts = a.filter((x, i) => a[i - 1] === '--mount');
  assert.deepEqual(mounts, ['type=bind,source=/srv-placeholder/project,target=/workspace']);
  for (const f of ['-v', '--volume', '--volumes-from', '--privileged', '-p', '--publish', '-P', '--publish-all', '--cap-add', '--device', '--pid', '--uts', '--userns', '--add-host']) {
    assert.equal(a.includes(f), false, `${f} is never used`);
  }
  assert.equal(a.some((x) => /docker\.sock/.test(x)), false, 'no Docker socket');
  assert.equal(a.some((x) => /^host$|network=host/.test(x)), false, 'no host network');
  // The labels say whose it is, so one Nova never touches another's containers.
  assert.ok(a.includes('nova.computer.home=abc') && a.includes('nova.computer.workspace=w1'));
  // The image is pinned by digest, and the command keeps it running and nothing else.
  assert.match(IMAGE, /^node:26-trixie@sha256:[0-9a-f]{64}$/);
  assert.deepEqual(a.slice(-3), [IMAGE, 'sleep', 'infinity']);
  // A name that could be read as a flag, or a folder with a comma (a second mount option), refused.
  assert.throws(() => createArgs({ ...base, folder: '/srv/a,target=/etc' }), CoreError);
  assert.throws(() => createArgs({ ...base, user: '0:0' }), CoreError);
});

test('a command runs as argv, never a shell string, with a time limit and no outside proxy unless declared', () => {
  const a = execArgs({ container: 'c1', user: '1000:1000', argv: ['ls', '-la'], timeoutS: 30, egress: false });
  assert.deepEqual(a.slice(0, 2), ['exec', '-i']);
  assert.equal(a[a.indexOf('--user') + 1], '1000:1000');
  assert.equal(a[a.indexOf('--workdir') + 1], '/workspace');
  // The time limit is enforced inside the container, so the process itself stops (not just the CLI).
  assert.deepEqual(a.slice(a.indexOf('c1') + 1), ['timeout', '--kill-after=2', '30s', 'ls', '-la']);
  assert.equal(a.some((x) => /proxy/i.test(x)), false);
  const e = execArgs({ container: 'c1', user: '1000:1000', argv: ['npm', 'ci'], timeoutS: 30, egress: true });
  assert.ok(e.includes('HTTPS_PROXY=http://127.0.0.1:3128') && e.includes('https_proxy=http://127.0.0.1:3128'));

  assert.deepEqual(validateArgv(['node', '-e', 'console.log(1)']), ['node', '-e', 'console.log(1)']);
  for (const bad of ['ls -la', [], [''], ['ls', 1], ['a\u0000b'], Array.from({ length: 300 }, () => 'x')]) {
    assert.throws(() => validateArgv(bad), CoreError, JSON.stringify(bad).slice(0, 40));
  }
});

test('never root inside: Nova’s own user, or the image’s unprivileged one when Nova runs as root', () => {
  assert.equal(runUser(1001, 1001), '1001:1001');
  assert.equal(runUser(0, 0), '1000:1000');
});

test('egress declarations: none, registries or declared hosts; anything else is refused', () => {
  assert.deepEqual(validateEgress(undefined), { mode: 'none', hosts: [] });
  assert.deepEqual(validateEgress({ mode: 'none' }), { mode: 'none', hosts: [] });
  assert.deepEqual(validateEgress({ mode: 'registries' }), { mode: 'registries', hosts: [] });
  assert.deepEqual(declaredHosts(validateEgress({ mode: 'registries' })), REGISTRIES);
  assert.ok(REGISTRIES.includes('registry.npmjs.org:443'));
  assert.deepEqual(validateEgress({ mode: 'hosts', hosts: ['Example.test', '*.example.test:443'] }), { mode: 'hosts', hosts: ['example.test', '*.example.test:443'] });
  for (const bad of [{ mode: 'all' }, { mode: 'hosts' }, { mode: 'hosts', hosts: [] }, { mode: 'hosts', hosts: ['*'] }, { mode: 'hosts', hosts: ['http://x.test/'] }, { mode: 'hosts', hosts: ['a b'] }, { mode: 'none', hosts: ['x.test'] }, 'none']) {
    assert.throws(() => validateEgress(bad), CoreError, JSON.stringify(bad));
  }
});

test('which folders may be a project: never Nova’s home, the person’s home, a hidden folder of theirs or the system', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-folders-'));
  const userHome = join(root, 'user');
  const home = join(userHome, 'Nova');
  const project = join(userHome, 'code', 'project');
  for (const d of [home, join(home, 'workspace'), project, join(userHome, '.ssh'), join(userHome, '.config', 'app')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(userHome, 'file.txt'), 'x');
  symlinkSync(join(userHome, '.ssh'), join(userHome, 'code', 'keys'));
  const o = { home, userHome };
  assert.equal(checkFolder(project, o), project);
  const refused = (p: string, why: RegExp) => assert.throws(() => checkFolder(p, o), (e: Error) => e instanceof CoreError && why.test(e.message), p);
  refused('relative/path', /full path/);
  refused(join(root, 'missing'), /isn’t there/);
  refused(join(userHome, 'file.txt'), /not a folder/);
  refused('/', /whole computer|system/);
  refused('/etc', /system/);
  refused('/var/run', /system/);
  refused(userHome, /your home folder/);
  refused(root, /your home folder/);
  refused(join(userHome, '.ssh'), /hidden/);
  refused(join(userHome, '.config', 'app'), /hidden/);
  refused(join(userHome, 'code', 'keys'), /hidden/);
  refused(home, /Nova’s own home/);
  refused(join(home, 'workspace'), /Nova’s own home/);
  // A folder holding Nova's home would mount it too.
  const outer = join(root, 'outer');
  mkdirSync(join(outer, 'Nova'), { recursive: true });
  assert.throws(() => checkFolder(outer, { home: join(outer, 'Nova'), userHome }), /Nova’s own home/);
});

test('tiers: reads automatic; a write is do, notify, undo; anything reaching outside asks every time', () => {
  const none = { mode: 'none' as const, hosts: [] };
  const out = { mode: 'hosts' as const, hosts: ['example.test'] };
  assert.equal(tierFor({ op: 'exec', access: 'read', egress: none }), 0);
  assert.equal(tierFor({ op: 'exec', access: 'write', egress: none }), 1);
  assert.equal(tierFor({ op: 'exec', access: 'read', egress: out }), 3);
  assert.equal(tierFor({ op: 'exec', access: 'write', egress: { mode: 'registries', hosts: [] } }), 3);
  assert.equal(tierFor({ op: 'create', egress: none, ownFolder: true }), 1);
  assert.equal(tierFor({ op: 'create', egress: none, ownFolder: false }), 2);
  assert.equal(tierFor({ op: 'create', egress: out, ownFolder: true }), 3);
  assert.equal(tierFor({ op: 'checkpoint', egress: none }), 1);
  assert.equal(tierFor({ op: 'reset', egress: none }), 1);
  assert.equal(tierFor({ op: 'reset', egress: out }), 1, 'a reset reaches nothing outside');
  assert.equal(tierFor({ op: 'destroy', egress: none }), 3);
});
