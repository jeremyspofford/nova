// Nova Computer hardening (the PR #236 review, items 1, 2 and 5): a workspace's project folder is
// the one that was approved, by its real path, device and inode, and stays that folder; no two
// workspaces' folders overlap; and the project's .git is read-only inside unless the person chose
// otherwise. Everything here works in throwaway folders under the test's own temp dir, with canary
// files standing in for "outside"; the containers carry the test's label and are removed at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerComputer } from '../../src/core/computer/docker.ts';
import { treeDigest, type Machine } from '../../src/core/computer/computer.ts';
import { IMAGE, checkFolder, tierFor } from '../../src/core/computer/policy.ts';
import { TEST_LABELS, docker, dockerSkip, folderIdOf, removeTestContainers, settled } from './computer-support.ts';
import { open } from './resilience-support.ts';

const skip = await dockerSkip();
const none = { mode: 'none' as const, hosts: [] };
const stamp = () => Date.now().toString(36).slice(-6);

test('a project folder never overlaps another workspace’s folder, either way', () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-overlap-'));
  const userHome = join(root, 'user');
  const home = join(root, 'nova');
  const outer = join(userHome, 'code', 'outer');
  const inner = join(outer, 'inner');
  const sibling = join(userHome, 'code', 'sibling');
  for (const d of [home, inner, sibling]) mkdirSync(d, { recursive: true });
  symlinkSync(inner, join(userHome, 'code', 'to-inner'));
  try {
    const o = (others: string[]) => ({ home, userHome, others });
    assert.throws(() => checkFolder(inner, o([outer])), /another workspace/, 'inside another workspace’s folder');
    assert.throws(() => checkFolder(outer, o([inner])), /another workspace/, 'holding another workspace’s folder');
    assert.throws(() => checkFolder(outer, o([outer])), /another workspace/, 'the same folder');
    assert.throws(() => checkFolder(join(userHome, 'code', 'to-inner'), o([outer])), /another workspace/, 'through a link');
    assert.equal(checkFolder(sibling, o([outer])), sibling);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a folder replaced by a link (here by an outer workspace) is never reset, copied or mounted through', { skip: skip ?? false, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-folder-id-'));
  const outer = join(root, 'outer');
  const inner = join(outer, 'inner');
  const outside = join(root, 'outside');
  mkdirSync(inner, { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(inner, 'file.txt'), 'the inner project\n');
  writeFileSync(join(outside, 'keep.txt'), 'canary: outside every workspace\n');
  const c = new DockerComputer({ home: join(root, 'home'), labels: TEST_LABELS });
  const s = stamp();
  // The two are made directly on the adapter, past the overlap rule (tested above), to show that
  // the adapter's own check holds even when two folders do overlap.
  const mo: Machine = { id: `fo${s}`, folder: outer, folderId: folderIdOf(outer), egress: none, container: null, image: IMAGE };
  const mi: Machine = { id: `fi${s}`, folder: inner, folderId: folderIdOf(inner), egress: none, container: null, image: IMAGE };
  try {
    await c.create(mo);
    await c.create(mi);
    const cp = await c.checkpoint(mi, { id: 'a', dir: join(root, 'home', 'cp-a') });

    // From inside the outer workspace, the inner folder becomes a link to the outside.
    const swap = await c.exec(mo, { argv: ['sh', '-c', `rm -rf /workspace/inner && ln -s ${outside} /workspace/inner`], timeoutS: 30 });
    assert.equal(swap.exit, 0, swap.stderr);
    assert.equal(lstatSync(inner).isSymbolicLink(), true);

    await assert.rejects(c.reset(mi, { image: cp.image, dir: join(root, 'home', 'cp-a') }), /isn’t the folder this workspace was made with/);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'canary: outside every workspace\n', 'the reset didn’t empty the outside');
    assert.deepEqual(readdirSync(outside), ['keep.txt'], 'nor copy into it');
    await assert.rejects(c.checkpoint(mi, { id: 'b', dir: join(root, 'home', 'cp-b') }), /isn’t the folder this workspace was made with/);
    assert.equal(existsSync(join(root, 'home', 'cp-b', 'folder', 'keep.txt')), false, 'the outside wasn’t copied');
    // Its machine made again (it went missing): never mounted on the link's target.
    await docker(['rm', '-f', mi.container!]);
    await assert.rejects(c.exec(mi, { argv: ['ls', '/workspace'], timeoutS: 30 }), /isn’t the folder this workspace was made with/);
    assert.notEqual((await docker(['container', 'inspect', `nova-computer-${c.tag}-${mi.id}`])).code, 0, 'no machine was made');

    // A real folder again, but a different one (another inode): refused too.
    unlinkSync(inner);
    mkdirSync(inner);
    await assert.rejects(c.exec(mi, { argv: ['ls', '/workspace'], timeoutS: 30 }), /isn’t the folder this workspace was made with/);
  } finally {
    await c.destroy(mo, []).catch(() => {});
    await c.destroy(mi, []).catch(() => {});
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the approval binds the folder as it was resolved when asked: its real path, device and inode', { skip: skip ?? false, timeout: 240_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-approve-folder-'));
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  const code = join(userHome, 'code');
  const a = join(code, 'a');
  const b = join(code, 'b');
  for (const d of [a, b]) mkdirSync(d, { recursive: true });
  writeFileSync(join(a, 'a.txt'), 'project a\n');
  writeFileSync(join(b, 'keep.txt'), 'canary: never approved\n');
  symlinkSync(a, join(code, 'link'));
  const core = open(home, { computer: { userHome, labels: TEST_LABELS } });
  const ids: string[] = [];
  try {
    core.start();
    const t = core.computer.request('create', { name: 'Linked', folder: join(code, 'link') });
    assert.equal(t.approval_tier, 2);
    assert.equal(t.state, 'waiting');
    // What the person is asked about is the real folder, not the link they typed.
    assert.equal(t.brief.inputs!.folder, a);
    assert.match(`${t.title} ${t.brief.goal}`, new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual({ dev: t.brief.inputs!.folder_dev, ino: t.brief.inputs!.folder_ino }, folderIdOf(a));

    // Before the OK, the link is pointed somewhere else. The approval still means folder a.
    unlinkSync(join(code, 'link'));
    symlinkSync(b, join(code, 'link'));
    core.ledger.approve(t.id);
    const done = await settled(core, t.id);
    assert.equal(done.state, 'done', done.reason ?? '');
    const ws = String(done.brief.inputs!.workspace);
    ids.push(ws);
    assert.equal(core.computer.view(ws).folder, a);
    const tag = (core.computer.computer as unknown as { tag: string }).tag;
    const inspect = JSON.parse((await docker(['container', 'inspect', `nova-computer-${tag}-${ws}`])).out)[0];
    assert.equal(inspect.Mounts.find((x: { Destination: string }) => x.Destination === '/workspace').Source, a);
    assert.equal(readFileSync(join(b, 'keep.txt'), 'utf8'), 'canary: never approved\n');

    // A folder replaced between the ask and the OK (same path, another inode) is refused.
    const c2 = join(code, 'c2');
    mkdirSync(c2);
    const t2 = core.computer.request('create', { name: 'Replaced', folder: c2 });
    rmSync(c2, { recursive: true });
    mkdirSync(c2);
    core.ledger.approve(t2.id);
    const refused = await settled(core, t2.id);
    assert.equal(refused.state, 'failed');
    assert.match(refused.reason!, /isn’t the folder you approved/);

    // Overlap with a workspace that exists, either way, is refused when asked.
    mkdirSync(join(a, 'sub'));
    assert.throws(() => core.computer.request('create', { name: 'Inner', folder: join(a, 'sub') }), /another workspace/);
    assert.throws(() => core.computer.request('create', { name: 'Outer', folder: code }), /another workspace/);
    // A brief made without the identity (not through the computer's own request) can't run.
    assert.throws(() => core.ledger.create({ title: 'raw', owner: 'computer', goal: 'Make it.', origin: { kind: 'user' }, evidence_required: [{ kind: 'confirmation' }], inputs: { op: 'create', workspace: 'w0123456789', name: 'Raw', folder: b } }), /folder_dev/);
  } finally {
    core.profile.set('privacy', 'default', 'cloud-allowed', 'settings');
    for (const id of ids) {
      try { const d = core.computer.request('destroy', {}, id); core.ledger.approve(d.id, { confirm: true }); await settled(core, d.id); } catch { /* best effort */ }
    }
    await core.close();
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the project’s .git is read-only inside unless the person chose otherwise; a .git that is a link is never mounted', { skip: skip ?? false, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-git-ro-'));
  const repo = join(root, 'repo');
  const repo2 = join(root, 'repo2');
  const linked = join(root, 'linked');
  const outside = join(root, 'outside-git');
  for (const d of [repo, repo2, linked, outside]) mkdirSync(d);
  for (const d of [repo, repo2]) execFileSync('git', ['init', '-q', d]);
  writeFileSync(join(outside, 'config'), 'canary: a git folder outside the project\n');
  symlinkSync(outside, join(linked, '.git'));
  const c = new DockerComputer({ home: join(root, 'home'), labels: TEST_LABELS });
  const s = stamp();
  const m: Machine = { id: `g${s}`, folder: repo, folderId: folderIdOf(repo), egress: none, container: null, image: IMAGE };
  const m2: Machine = { id: `h${s}`, folder: repo2, folderId: folderIdOf(repo2), egress: none, container: null, image: IMAGE, gitWritable: true };
  const m3: Machine = { id: `l${s}`, folder: linked, folderId: folderIdOf(linked), egress: none, container: null, image: IMAGE };
  try {
    const before = treeDigest(join(repo, '.git')).digest;
    await c.create(m);
    const sh = (mm: Machine, cmd: string) => c.exec(mm, { argv: ['sh', '-c', cmd], timeoutS: 30 });
    for (const cmd of [
      'printf "[core]\\n\\tfsmonitor = touch /workspace/pwned\\n" >> .git/config',
      'printf "#!/bin/sh\\ntouch /workspace/pwned\\n" > .git/hooks/pre-commit',
      'rm -rf .git',
      'mv .git .git-moved',
    ]) {
      const r = await sh(m, cmd);
      assert.notEqual(r.exit, 0, `${cmd} was refused`);
    }
    assert.equal(treeDigest(join(repo, '.git')).digest, before, 'the host’s .git is as it was');
    assert.equal(existsSync(join(repo, 'pwned')), false);
    // Reading the repository inside still works, and the rest of the folder is writable.
    assert.equal((await c.exec(m, { argv: ['git', '-c', 'safe.directory=*', 'rev-parse', '--git-dir'], timeoutS: 30 })).exit, 0);
    assert.equal((await sh(m, 'echo ok > file.txt')).exit, 0);
    assert.equal(readFileSync(join(repo, 'file.txt'), 'utf8'), 'ok\n');

    // Positive control: with .git writable (the person's explicit choice), the same write lands.
    await c.create(m2);
    assert.equal((await sh(m2, 'printf "[nova]\\n\\tnote = from inside\\n" >> .git/config')).exit, 0);
    assert.match(readFileSync(join(repo2, '.git', 'config'), 'utf8'), /from inside/);

    // A .git that is a link: Docker would follow it, so it is not mounted at all.
    await c.create(m3);
    const seen = await sh(m3, 'cat /workspace/.git/config 2>&1; true');
    assert.doesNotMatch(seen.stdout, /canary/);
    const inspect = JSON.parse((await docker(['container', 'inspect', m3.container!])).out)[0];
    assert.deepEqual(inspect.Mounts.map((x: { Source: string }) => x.Source), [linked]);
  } finally {
    for (const mm of [m, m2, m3]) await c.destroy(mm, []).catch(() => {});
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('tiers: a workspace whose .git is writable inside asks first, even on Nova’s own folder', () => {
  assert.equal(tierFor({ op: 'create', egress: none, ownFolder: true }), 1);
  assert.equal(tierFor({ op: 'create', egress: none, ownFolder: true, gitWritable: true }), 2);
  assert.equal(tierFor({ op: 'create', egress: none, ownFolder: false, gitWritable: true }), 2);
});

test('a command that changes what tools on this computer run by themselves (.git, .envrc, editor settings) is reported', { skip: skip ?? false, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-host-config-'));
  const core = open(join(root, 'home'), { computer: { userHome: join(root, 'user'), labels: TEST_LABELS } });
  let ws = '';
  try {
    core.start();
    const made = await settled(core, core.computer.request('create', { name: 'Fresh' }).id);
    assert.equal(made.state, 'done', made.reason ?? '');
    ws = String(made.brief.inputs!.workspace);
    const plain = await settled(core, core.computer.request('exec', { argv: ['sh', '-c', 'echo hi > notes.txt'] }, ws).id);
    assert.equal(plain.state, 'done', plain.reason ?? '');
    assert.doesNotMatch(plain.report!.summary, /tools on this computer/);
    const w = await settled(core, core.computer.request('exec', { argv: ['sh', '-c', 'git init -q . && echo "export X=1" > .envrc && mkdir -p .vscode && echo {} > .vscode/settings.json'] }, ws).id);
    assert.equal(w.state, 'done', w.reason ?? '');
    assert.match(w.report!.summary, /changed what tools on this computer may run by themselves: \.envrc, \.git, \.vscode/);
  } finally {
    if (ws) {
      try { const d = core.computer.request('destroy', {}, ws); core.ledger.approve(d.id, { confirm: true }); await settled(core, d.id); } catch { /* best effort */ }
    }
    await core.close();
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});
