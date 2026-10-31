// Nova Computer's Docker adapter (M10a gate): a workspace is created on a project folder, a command
// runs in it, and a checkpoint and a reset bring it back byte for byte: the project folder (checked
// on the host) and the container's own filesystem (read from the host with `docker export`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerComputer } from '../../src/core/computer/docker.ts';
import { treeDigest, type Machine } from '../../src/core/computer/computer.ts';
import { IMAGE } from '../../src/core/computer/policy.ts';
import { TEST_LABELS, docker, dockerSkip, exportDigest, folderIdOf, removeTestContainers } from './computer-support.ts';

const skip = await dockerSkip();

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nova-computer-project-'));
  writeFileSync(join(dir, 'README.md'), '# A project\n');
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.js'), 'console.log("hello from the project");\n');
  writeFileSync(join(dir, 'src', 'deep', 'data.bin'), Buffer.from([0, 1, 2, 255, 254, 10, 13]));
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho ran\n');
  chmodSync(join(dir, 'run.sh'), 0o755);
  symlinkSync('src/index.js', join(dir, 'entry.js'));
  return dir;
}

test('a workspace: created, a command runs as Nova’s own user, a checkpoint and a reset return it byte for byte', { skip: skip ?? false, timeout: 240_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-computer-home-'));
  const folder = project();
  const c = new DockerComputer({ home, labels: TEST_LABELS });
  const m: Machine = { id: `t${Date.now().toString(36)}`, folder, folderId: folderIdOf(folder), egress: { mode: 'none', hosts: [] }, container: null, image: IMAGE };
  const images: string[] = [];
  try {
    assert.equal((await c.available()).ok, true);
    m.container = (await c.create(m)).container;

    // A command runs; its output and exit code come back.
    const v = await c.exec(m, { argv: ['node', '--version'], timeoutS: 30 });
    assert.equal(v.exit, 0, v.stderr);
    assert.match(v.stdout, /^v26\./);
    const who = await c.exec(m, { argv: ['id', '-u'], timeoutS: 30 });
    assert.equal(who.stdout.trim(), String(process.getuid!()));
    const ran = await c.exec(m, { argv: ['node', 'entry.js'], timeoutS: 30 });
    assert.equal(ran.stdout, 'hello from the project\n');
    const failed = await c.exec(m, { argv: ['sh', '-c', 'echo oops >&2; exit 3'], timeoutS: 30 });
    assert.deepEqual([failed.exit, failed.stderr], [3, 'oops\n']);
    // A file written inside is the person's on the host.
    await c.exec(m, { argv: ['sh', '-c', 'echo made inside > made.txt'], timeoutS: 30 });
    assert.equal(statSync(join(folder, 'made.txt')).uid, process.getuid!());

    // Limits: a command that runs too long is stopped inside the container; output is capped.
    const slow = await c.exec(m, { argv: ['sleep', '30'], timeoutS: 1 });
    assert.equal(slow.timed_out, true);
    assert.ok(slow.duration_ms < 10_000, `stopped after ${slow.duration_ms} ms`);
    const loud = await c.exec(m, { argv: ['node', '-e', 'process.stdout.write("x".repeat(300000))'], timeoutS: 30, maxBytes: 1000 });
    assert.equal(loud.stdout.length, 1000);
    assert.equal(loud.truncated, true);

    // State A: something in the folder and in the container's own filesystem (its HOME is /tmp).
    await c.exec(m, { argv: ['sh', '-c', 'mkdir -p /tmp/.cache/tool && echo cached > /tmp/.cache/tool/state && echo note > /tmp/note.txt && chmod 600 /tmp/note.txt'], timeoutS: 30 });
    const folderA = treeDigest(folder);
    const fsA = await exportDigest(m.container);
    assert.ok(fsA.entries > 1000, `the export read the whole filesystem (${fsA.entries} entries)`);
    const cpDir = join(home, 'cp-a');
    const saved = await c.checkpoint(m, { id: 'a', dir: cpDir });
    images.push(saved.image);
    assert.equal(saved.digest, folderA.digest, 'the checkpoint’s copy matches the folder');

    // Change everything: edit, delete, add, chmod, a link retargeted, in both places.
    writeFileSync(join(folder, 'README.md'), '# Changed\n');
    unlinkSync(join(folder, 'src', 'deep', 'data.bin'));
    writeFileSync(join(folder, 'new.txt'), 'new');
    chmodSync(join(folder, 'run.sh'), 0o644);
    unlinkSync(join(folder, 'entry.js'));
    symlinkSync('README.md', join(folder, 'entry.js'));
    await c.exec(m, { argv: ['sh', '-c', 'rm -rf /tmp/.cache && echo other > /tmp/note.txt && chmod 644 /tmp/note.txt && echo extra > /tmp/extra'], timeoutS: 30 });
    assert.notEqual(treeDigest(folder).digest, folderA.digest);
    assert.notEqual((await exportDigest(m.container)).digest, fsA.digest);

    // Reset to A: byte for byte, both halves.
    m.container = (await c.reset(m, { image: saved.image, dir: cpDir })).container;
    assert.equal(treeDigest(folder).digest, folderA.digest, 'the folder is back byte for byte');
    assert.equal((await exportDigest(m.container)).digest, fsA.digest, 'the container’s filesystem is back byte for byte');
    assert.equal(readFileSync(join(folder, 'src', 'deep', 'data.bin')).toString('hex'), '000102fffe0a0d');
    assert.equal(statSync(join(folder, 'run.sh')).mode & 0o777, 0o755);
    // And it still runs.
    assert.equal((await c.exec(m, { argv: ['cat', '/tmp/.cache/tool/state'], timeoutS: 30 })).stdout, 'cached\n');

    // What a read check sees: the container's own changes since its image.
    await c.exec(m, { argv: ['touch', '/tmp/after-reset'], timeoutS: 30 });
    assert.ok((await c.changes(m)).some((l) => l.split('\t')[0]!.endsWith('/tmp/after-reset')));
  } finally {
    await c.destroy(m, images).catch(() => {});
    rmSync(folder, { recursive: true, force: true });
  }
  // Destroyed: no container and no checkpoint image is left.
  assert.notEqual((await docker(['container', 'inspect', m.container!])).code, 0);
  for (const i of images) assert.notEqual((await docker(['image', 'inspect', i])).code, 0, i);
  assert.equal(existsSync(join(home, 'cp-a')), true, 'the copy on disk is the caller’s to remove');
  await removeTestContainers();
});

test('a machine that went missing is made again from its image on the next command', { skip: skip ?? false, timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'nova-computer-home-'));
  const folder = project();
  const c = new DockerComputer({ home, labels: TEST_LABELS });
  const m: Machine = { id: `u${Date.now().toString(36)}`, folder, folderId: folderIdOf(folder), egress: { mode: 'none', hosts: [] }, container: null, image: IMAGE };
  try {
    m.container = (await c.create(m)).container;
    await docker(['rm', '-f', m.container]);
    const r = await c.exec(m, { argv: ['cat', 'README.md'], timeoutS: 30 });
    assert.equal(r.stdout, '# A project\n');
  } finally {
    await c.destroy(m, []).catch(() => {});
    await removeTestContainers();
    rmSync(folder, { recursive: true, force: true });
  }
});
