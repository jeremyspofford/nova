// Nova Computer hardening (the PR #236 review, items 4 and 9): a checkpoint is one moment's
// picture, taken without following links out of the folder and without opening FIFOs, sockets or
// devices; and a read is checked by content, on both halves, so a change that keeps a file's size
// and time, or touches a path that had already changed, is still seen. Throwaway folders under the
// test's temp dir with canaries outside them; the containers carry the test's label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DockerComputer } from '../../src/core/computer/docker.ts';
import { treeDigest, type Machine } from '../../src/core/computer/computer.ts';
import { IMAGE } from '../../src/core/computer/policy.ts';
import { TEST_LABELS, docker, dockerSkip, folderIdOf, removeTestContainers, settled } from './computer-support.ts';
import { open } from './resilience-support.ts';

const skip = await dockerSkip();
const none = { mode: 'none' as const, hosts: [] };
const CANARY = 'canary-bytes-from-outside-the-project';

// Every regular file under a copy, read: none may hold the canary's bytes.
function holds(dir: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && readFileSync(p).includes(needle)) found.push(p);
    }
  };
  walk(dir);
  return found;
}

function machine(root: string, id: string): Machine {
  const folder = join(root, id);
  mkdirSync(folder);
  writeFileSync(join(folder, 'README.md'), '# a project\n');
  return { id: `${id}${Date.now().toString(36).slice(-6)}`, folder, folderId: folderIdOf(folder), egress: none, container: null, image: IMAGE };
}

test('a link in the folder to a file outside it is kept as a link: the outside’s bytes never enter a checkpoint or its digest', { skip: skip ?? false, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-snap-link-'));
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, `${CANARY}\n`);
  const c = new DockerComputer({ home: join(root, 'home'), labels: TEST_LABELS });
  const m = machine(root, 'p');
  try {
    await c.create(m);
    // Made from inside: links to the host's path of the canary, as a file and as a folder.
    assert.equal((await c.exec(m, { argv: ['sh', '-c', `ln -s ${outside} out-file && ln -s ${root} out-dir`], timeoutS: 30 })).exit, 0);
    const before = treeDigest(m.folder).digest;
    const saved = await c.checkpoint(m, { id: 'a', dir: join(root, 'home', 'cp-a') });
    const copy = join(root, 'home', 'cp-a', 'folder');
    assert.equal(lstatSync(join(copy, 'out-file')).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(copy, 'out-file')), outside);
    assert.deepEqual(holds(copy, CANARY), [], 'no file in the copy holds the outside’s bytes');
    // The digest reads the link, not what it points at: changing the outside changes nothing.
    writeFileSync(outside, `${CANARY} changed\n`);
    assert.equal(treeDigest(m.folder).digest, before);
    assert.equal(saved.digest, treeDigest(copy).digest);
  } finally {
    await c.destroy(m, []).catch(() => {});
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a process racing a checkpoint (swapping files for links to the outside) can’t pull the outside into it', { skip: skip ?? false, timeout: 240_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-snap-race-'));
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, `${CANARY}\n`);
  const c = new DockerComputer({ home: join(root, 'home'), labels: TEST_LABELS });
  const m = machine(root, 'r');
  try {
    await c.create(m);
    // A detached loop that keeps turning 200 files into links to the canary and back.
    const loop = `i=0; while :; do for n in $(seq 1 200); do rm -f f$n; ln -s ${outside} f$n; rm -f f$n; printf x > f$n; done; done`;
    assert.equal((await c.exec(m, { argv: ['sh', '-c', `for n in $(seq 1 200); do printf x > f$n; done; setsid sh -c '${loop}' >/dev/null 2>&1 </dev/null &`], timeoutS: 30 })).exit, 0);
    for (let k = 0; k < 8; k++) {
      const dir = join(root, 'home', `cp-${k}`);
      await c.checkpoint(m, { id: `k${k}`, dir }).catch((e: Error) => { assert.doesNotMatch(e.message, /EAGAIN|blocked/); });
      assert.deepEqual(holds(join(dir), CANARY), [], `checkpoint ${k}: no file in the copy holds the outside’s bytes`);
    }
  } finally {
    await c.destroy(m, []).catch(() => {});
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a FIFO or a socket in the folder never blocks or breaks a checkpoint, a digest or a reset', { skip: skip ?? false, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-snap-fifo-'));
  const c = new DockerComputer({ home: join(root, 'home'), labels: TEST_LABELS });
  const m = machine(root, 'f');
  try {
    await c.create(m);
    const made = await c.exec(m, { argv: ['sh', '-c', 'mkfifo pipe && mkdir deep && mkfifo deep/pipe2 && node -e "require(\'net\').createServer().listen(\'/workspace/sock\', () => process.exit(0))"'], timeoutS: 30 });
    assert.equal(made.exit, 0, made.stderr);
    assert.equal(lstatSync(join(m.folder, 'pipe')).isFIFO(), true);
    assert.equal(lstatSync(join(m.folder, 'sock')).isSocket(), true);
    const started = Date.now();
    const d = treeDigest(m.folder);
    assert.equal(d.files, 1);
    const saved = await c.checkpoint(m, { id: 'a', dir: join(root, 'home', 'cp-a') });
    assert.ok(Date.now() - started < 30_000, 'nothing waited on a FIFO');
    assert.deepEqual(readdirSync(join(root, 'home', 'cp-a', 'folder')).sort(), ['README.md', 'deep']);
    writeFileSync(join(m.folder, 'README.md'), 'changed\n');
    await c.reset(m, { image: saved.image, dir: join(root, 'home', 'cp-a') });
    assert.equal(readFileSync(join(m.folder, 'README.md'), 'utf8'), '# a project\n');
    assert.equal(treeDigest(m.folder).digest, saved.digest);
  } finally {
    await c.destroy(m, []).catch(() => {});
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a read is checked by content: same size and time, or a path that had already changed, is still seen', { skip: skip ?? false, timeout: 240_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-read-content-'));
  const core = open(join(root, 'home'), { computer: { userHome: join(root, 'user'), labels: TEST_LABELS } });
  let ws = '';
  try {
    core.start();
    const made = await settled(core, core.computer.request('create', { name: 'Reads' }).id);
    assert.equal(made.state, 'done', made.reason ?? '');
    ws = String(made.brief.inputs!.workspace);
    const w = await settled(core, core.computer.request('exec', { argv: ['sh', '-c', 'echo aaaa > notes.txt && echo cccc > /tmp/state.txt'] }, ws).id);
    assert.equal(w.state, 'done', w.reason ?? '');
    // A real read passes.
    const fine = await settled(core, core.computer.request('exec', { argv: ['cat', 'notes.txt', '/tmp/state.txt'], access: 'read' }, ws).id);
    assert.equal(fine.state, 'done', fine.reason ?? '');

    // The folder: new bytes, the same size, the old modification time put back.
    const folderSly = await settled(core, core.computer.request('exec', { argv: ['sh', '-c', 'm=$(stat -c %y notes.txt); printf "bbbb\\n" > notes.txt; touch -d "$m" notes.txt'], access: 'read' }, ws).id);
    assert.equal(folderSly.state, 'failed');
    assert.match(folderSly.reason!, /run as a read but it changed the workspace \(in the project folder/);

    // The machine: a file that was already in its change list since the image, changed again.
    const machineSly = await settled(core, core.computer.request('exec', { argv: ['sh', '-c', 'm=$(stat -c %y /tmp/state.txt); printf "dddd\\n" > /tmp/state.txt; touch -d "$m" /tmp/state.txt'], access: 'read' }, ws).id);
    assert.equal(machineSly.state, 'failed');
    assert.match(machineSly.reason!, /in the machine: A \/tmp\/state\.txt/);
  } finally {
    if (ws) {
      try { const d = core.computer.request('destroy', {}, ws); core.ledger.approve(d.id, { confirm: true }); await settled(core, d.id); } catch { /* best effort */ }
    }
    await core.close();
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a checkpoint whose copy stops part way leaves nothing on disk', { skip: skip ?? (process.getuid?.() === 0 ? 'as root every file is readable, so the copy can’t be made to fail' : false), timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-snap-partial-'));
  const c = new DockerComputer({ home: join(root, 'home'), labels: TEST_LABELS });
  const m = machine(root, 'q');
  try {
    await c.create(m);
    // A file Nova can't read (its owner made it so from inside): the copy stops at it.
    assert.equal((await c.exec(m, { argv: ['sh', '-c', 'mkdir -p a && echo one > a/one && echo two > z-unreadable && chmod 000 z-unreadable'], timeoutS: 30 })).exit, 0);
    const dir = join(root, 'home', 'cp-a');
    await assert.rejects(c.checkpoint(m, { id: 'a', dir }), /couldn’t read z-unreadable/);
    assert.equal(existsSync(dir), false, 'the part-made copy is gone');
    assert.notEqual((await docker(['image', 'inspect', `nova-computer:${c.tag}-${m.id}-a`])).code, 0, 'and its image');
  } finally {
    await c.destroy(m, []).catch(() => {});
    await removeTestContainers();
    rmSync(root, { recursive: true, force: true });
  }
});
