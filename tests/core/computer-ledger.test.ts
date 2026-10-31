// Nova Computer through the Work Ledger (M10a): every action is a task with its tier, a command's
// output is kept as evidence that Nova checks itself and is screened by the ingest gate, a write is
// undone through the checkpoint before it, a read that writes is caught, and egress is refused while
// Nova is local-only and outside the declaration. With the real Docker adapter, in process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreError } from '../../src/core/errors.ts';
import { treeDigest } from '../../src/core/computer/computer.ts';
import { docker, dockerSkip } from './computer-support.ts';
import { open } from './resilience-support.ts';
import type { Core } from '../../src/core/index.ts';
import type { Task } from '../../src/core/ledger.ts';

const skip = await dockerSkip();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settled(core: Core, id: string, states = ['done', 'failed', 'waiting', 'cancelled']): Promise<Task> {
  for (let i = 0; i < 2400; i++) {
    const t = core.ledger.get(id);
    if (states.includes(t.state)) return t;
    await sleep(25);
  }
  throw new Error(`task ${id} never settled: ${core.ledger.get(id).state}`);
}

const listen = (reply: string) => new Promise<Server>((ok) => { const s = createServer((c) => c.end(reply)); s.listen(0, '127.0.0.1', () => ok(s)); });

test('the computer through the ledger: tiers, evidence, screening, undo, a read that writes, egress and local-only', { skip: skip ?? false, timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'nova-computer-ledger-'));
  const home = join(root, 'home');
  const userHome = join(root, 'user');
  const project = join(userHome, 'code', 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'notes.txt'), 'a placeholder project\n');
  const declared = await listen('hello from a declared host\n');
  const port = (declared.address() as { port: number }).port;
  // The stand-in host is on loopback, which the real rule never reaches; for this test only, it counts.
  const core = open(home, { computer: { userHome, egressAllow: (a) => a === '127.0.0.1' } });
  const ids: string[] = [];
  try {
    core.start();
    assert.equal(core.profile.privacyDefault(), 'local-only');
    assert.equal(core.health().checks.computer.ok, true);

    // A workspace on Nova's own empty folder: tier 1, runs at once, evidence checked by Nova.
    let t = core.computer.request('create', { name: 'Scratch' });
    assert.equal(t.approval_tier, 1);
    t = await settled(core, t.id);
    assert.equal(t.state, 'done', t.reason ?? '');
    assert.equal(t.verification!.ok, true);
    assert.match(t.verification!.checks[0]!.why, /read checkpoint c[0-9a-f]+’s copy back itself/);
    const ws = String(t.brief.inputs!.workspace);
    ids.push(ws);
    assert.equal(core.computer.view(ws).state, 'ready');

    // On a folder of the person's: asks first.
    const mine = core.computer.request('create', { name: 'Project', folder: project });
    assert.equal(mine.approval_tier, 2);
    assert.equal(mine.state, 'waiting');
    // A folder that is theirs but not a project's is refused before anything runs.
    assert.throws(() => core.computer.request('create', { name: 'Home', folder: userHome }), /your home folder/);
    assert.throws(() => core.computer.request('create', { name: 'Nova', folder: home }), /Nova’s own home/);
    core.ledger.approve(mine.id);
    const made = await settled(core, mine.id);
    assert.equal(made.state, 'done', made.reason ?? '');
    const pws = String(made.brief.inputs!.workspace);
    ids.push(pws);

    // A read: tier 0, automatic. Its output is evidence (Nova re-reads the file by its hash) and was
    // screened as tool output before any model could read it.
    let read = core.computer.request('exec', { argv: ['cat', 'notes.txt'], access: 'read' }, pws);
    assert.equal(read.approval_tier, 0);
    read = await settled(core, read.id);
    assert.equal(read.state, 'done', read.reason ?? '');
    assert.match(read.verification!.checks[0]!.why, /read the command’s output back itself/);
    const rec = core.computer.run(read.id) as { record: { stdout: string; screen: { id: string; verdict: string } } };
    assert.equal(rec.record.stdout, 'a placeholder project\n');
    const screen = core.ingest.get(rec.record.screen.id);
    assert.ok(screen, 'the ingest gate kept its record');
    assert.equal(screen!.kind, 'tool');
    assert.equal(screen!.origin, 'computer:Project');

    // A write: tier 1 (do, notify, undo). A checkpoint first; the task shows as handling.
    const before = treeDigest(project).digest;
    let write = core.computer.request('exec', { argv: ['sh', '-c', 'echo changed > notes.txt && echo new > new.txt'] }, pws);
    assert.equal(write.approval_tier, 1);
    write = await settled(core, write.id);
    assert.equal(write.state, 'done', write.reason ?? '');
    assert.equal(write.user_visibility, 'handling');
    assert.match(write.report!.summary, /Undo: reset to checkpoint c[0-9a-f]+, taken just before/);
    assert.equal(readFileSync(join(project, 'notes.txt'), 'utf8'), 'changed\n');
    // Undo: back to the checkpoint before it, byte for byte, verified by Nova reading the folder.
    let undo = core.computer.undo(write.id);
    assert.equal(undo.approval_tier, 1);
    undo = await settled(core, undo.id);
    assert.equal(undo.state, 'done', undo.reason ?? '');
    assert.match(undo.verification!.checks[0]!.why, /matches checkpoint .* byte for byte/);
    assert.equal(treeDigest(project).digest, before);
    assert.equal(existsSync(join(project, 'new.txt')), false);

    // A "read" that writes is caught, and fails saying what it changed.
    const sly = await settled(core, core.computer.request('exec', { argv: ['sh', '-c', 'echo sly > sly.txt'], access: 'read' }, pws).id);
    assert.equal(sly.state, 'failed');
    assert.match(sly.reason!, /run as a read but it changed the workspace \(in the project folder/);
    const sly2 = await settled(core, core.computer.request('exec', { argv: ['sh', '-c', 'echo sly > /tmp/sly'], access: 'read' }, pws).id);
    assert.match(sly2.reason!, /in the machine: A \/tmp\/sly/);
    // A failing command is kept as evidence too, and fails plainly.
    const bad = await settled(core, core.computer.request('exec', { argv: ['sh', '-c', 'exit 7'], access: 'read' }, pws).id);
    assert.equal(bad.state, 'failed');
    assert.match(bad.reason!, /exited with 7/);

    // Reset to the clean state: tier 1, and what was there is checkpointed first.
    const reset = await settled(core, core.computer.request('reset', {}, pws).id);
    assert.equal(reset.state, 'done', reset.reason ?? '');
    assert.deepEqual(readFileSync(join(project, 'notes.txt'), 'utf8'), 'a placeholder project\n');
    assert.equal(existsSync(join(project, 'sly.txt')), false);

    // Egress while local-only: refused by the ledger before anything runs.
    const hosts = { mode: 'hosts', hosts: [`127.0.0.1:${port}`] };
    assert.throws(() => core.computer.request('create', { name: 'Out', egress: hosts }), (e: Error) => e instanceof CoreError && /local-only/.test(e.message));
    assert.throws(() => core.computer.request('create', { name: 'Out', egress: { mode: 'registries' } }), /local-only/);

    // With the person's OK to use the cloud: a workspace that may reach outside asks every time.
    core.profile.set('privacy', 'default', 'cloud-allowed', 'person');
    const out = core.computer.request('create', { name: 'Out', egress: hosts });
    assert.equal(out.approval_tier, 3);
    assert.equal(out.state, 'waiting');
    core.ledger.approve(out.id, { confirm: true });
    const outDone = await settled(core, out.id);
    assert.equal(outDone.state, 'done', outDone.reason ?? '');
    const ows = String(outDone.brief.inputs!.workspace);
    ids.push(ows);
    // Even a read there asks: it can reach outside.
    const reach = core.computer.request('exec', { argv: ['sh', '-c', `curl -sS --http0.9 --proxytunnel http://127.0.0.1:${port}/; curl -sS --proxytunnel https://undeclared.example.test/ 2>&1; true`], access: 'read' }, ows);
    assert.equal(reach.approval_tier, 3);
    assert.equal(reach.state, 'waiting');
    core.ledger.approve(reach.id, { confirm: true });
    const reached = await settled(core, reach.id);
    assert.equal(reached.state, 'done', reached.reason ?? '');
    const r2 = core.computer.run(reached.id) as { record: { stdout: string; egress: { host: string; allowed: boolean; why: string }[] } };
    assert.match(r2.record.stdout, /hello from a declared host/);
    assert.match(r2.record.stdout, /403/);
    assert.deepEqual(r2.record.egress.map((a) => [a.host, a.allowed]), [['127.0.0.1', true], ['undeclared.example.test', false]]);
    assert.match(reached.report!.summary, /refused: undeclared\.example\.test:443 \(not declared for this workspace\)/);

    // Back to local-only: a command there is refused by the ledger, and by the computer for one
    // already approved.
    core.profile.set('privacy', 'default', 'local-only', 'person');
    assert.throws(() => core.computer.request('exec', { argv: ['true'] }, ows), /local-only/);
    const sneaky = core.ledger.create({ title: 'cloud-allowed by its brief', owner: 'computer', goal: 'Run true.', origin: { kind: 'user' }, privacy_mode: 'cloud-allowed', evidence_required: [{ kind: 'confirmation' }], inputs: { op: 'exec', workspace: ows, argv: ['true'] } });
    assert.equal(sneaky.approval_tier, 3);
    core.ledger.approve(sneaky.id, { confirm: true });
    const refused = await settled(core, sneaky.id);
    assert.equal(refused.state, 'failed');
    assert.match(refused.reason!, /your Nova is local-only: nothing leaves this machine/);

    // Destroying a workspace deletes its checkpoints: tier 3, every time.
    const del = core.computer.request('destroy', {}, ws);
    assert.equal(del.approval_tier, 3);
    core.ledger.approve(del.id, { confirm: true });
    const gone = await settled(core, del.id);
    assert.equal(gone.state, 'done', gone.reason ?? '');
    assert.throws(() => core.computer.view(ws), /no workspace/);
    assert.notEqual((await docker(['container', 'inspect', `nova-computer-${core.computer.computer instanceof Object ? (core.computer.computer as { tag: string }).tag : ''}-${ws}`])).code, 0);
    ids.shift();
  } finally {
    for (const id of ids) {
      core.profile.set('privacy', 'default', 'cloud-allowed', 'person');
      try {
        const d = core.computer.request('destroy', {}, id);
        core.ledger.approve(d.id, { confirm: true });
        await settled(core, d.id);
      } catch { /* best effort */ }
    }
    declared.close();
    await core.close();
  }
});
