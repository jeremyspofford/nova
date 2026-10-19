// Three-way merges (FR-073, docs/10 §9 and §14): a patch or another session's work lands on a
// branch that moved; clean merges are written, conflicts are refused with their three sides by
// default, or written with markers that block a commit until resolved; a conflicted merge can be
// aborted; binary conflicts are never merged.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNovaError } from '@nova/shared';
import { ACCOUNT } from './helpers.ts';
import { makeCodeM7Env, type CodeM7Env } from './code-m7-env.ts';

// Remote-side work spawns many short processes; under a loaded full run they need time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
let e: CodeM7Env;
afterEach(async () => {
  await e.close();
});

const LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
const text = (lines: string[]) => `${lines.join('\n')}\n`;
const withLine = (i: number, v: string) => LINES.map((l, j) => (j === i ? v : l));

/** A repository whose `main` moved after `base`: the patch edits line `patchLine`. */
async function moved(patchLine: number, movedLine: number) {
  e = await makeCodeM7Env();
  writeFileSync(join(e.repo, 'doc.txt'), text(LINES));
  e.git(['add', '-A']);
  e.git(['commit', '-qm', 'doc']);
  const base = e.git(['rev-parse', 'HEAD']).trim();
  writeFileSync(join(e.repo, 'doc.txt'), text(withLine(patchLine, 'theirs')));
  writeFileSync(join(e.repo, 'added.txt'), 'new from the patch\n');
  e.git(['add', '-A']);
  const patch = e.git(['diff', '--cached', '--binary', '--full-index']);
  e.git(['reset', '-q', '--hard', base]);
  writeFileSync(join(e.repo, 'doc.txt'), text(withLine(movedLine, 'ours')));
  e.git(['commit', '-qam', 'moved']);
  const s = await e.svc.create(ACCOUNT, { folder: e.repo });
  return { base, patch, s };
}

async function reasonOf(
  p: Promise<unknown>,
): Promise<{ reason: string; details: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    if (isNovaError(err)) {
      const details: Record<string, unknown> = { ...(err.details as object | undefined) };
      const reason = typeof details.reason === 'string' ? details.reason : err.code;
      return { reason, details };
    }
    throw err;
  }
  throw new Error('expected a failure');
}

describe('three-way merges', () => {
  it('merges a patch onto a branch that moved', async () => {
    const { base, patch, s } = await moved(1, 9);
    const m = await e.merges.mergePatch(ACCOUNT, s.id, patch, base);
    expect(m.status).toBe('applied');
    expect(m.files).toEqual([
      { path: 'added.txt', result: 'added', conflicts: 0 },
      { path: 'doc.txt', result: 'merged', conflicts: 0 },
    ]);
    const doc = readFileSync(join(e.repo, 'doc.txt'), 'utf8');
    expect(doc).toContain('theirs');
    expect(doc).toContain('ours');
    // The merged work shows as pending changes of the session.
    expect((await e.svc.changes(ACCOUNT, s.id)).map((c) => c.path).sort()).toEqual([
      'added.txt',
      'doc.txt',
    ]);
    expect(e.audit.find((a) => a.action === 'code.merge')).toMatchObject({ result: 'ok' });
    expect(e.events.events.some((x) => x.name === 'code.merge.completed')).toBe(true);
    expect(e.merges.list(ACCOUNT, s.id)).toHaveLength(1);
    // A patch that does not fit its base.
    await expect(
      reasonOf(e.merges.mergePatch(ACCOUNT, s.id, 'diff --git a/x b/x\nnot a patch\n', base)),
    ).resolves.toMatchObject({ reason: 'patch_mismatch' });
  });

  it('refuses a conflict by default and writes nothing, with the three sides', async () => {
    const { base, patch, s } = await moved(4, 4);
    const before = readFileSync(join(e.repo, 'doc.txt'), 'utf8');
    const r = await reasonOf(e.merges.mergePatch(ACCOUNT, s.id, patch, base));
    expect(r.reason).toBe('merge_conflict');
    expect(r.details.paths).toEqual(['doc.txt']);
    expect(readFileSync(join(e.repo, 'doc.txt'), 'utf8')).toBe(before);
    const [m] = e.merges.list(ACCOUNT, s.id);
    expect(m).toMatchObject({ status: 'refused', baseSha: base });
    expect(m?.conflicts[0]).toMatchObject({ path: 'doc.txt', binary: false });
    expect(m?.conflicts[0]?.base).toContain('line 5');
    expect(m?.conflicts[0]?.ours).toContain('ours');
    expect(m?.conflicts[0]?.theirs).toContain('theirs');
    expect(m?.conflicts[0]?.merged).toContain('<<<<<<< ours');
  });

  it('writes markers on request; a commit waits until they are resolved; an abort restores', async () => {
    const { base, patch, s } = await moved(4, 4);
    const before = readFileSync(join(e.repo, 'doc.txt'), 'utf8');
    const m = await e.merges.mergePatch(ACCOUNT, s.id, patch, base, 'markers');
    expect(m.status).toBe('conflicted');
    const doc = readFileSync(join(e.repo, 'doc.txt'), 'utf8');
    expect(doc).toMatch(/<<<<<<< ours[\s\S]*\|\|\|\|\|\|\| base[\s\S]*>>>>>>> theirs/);
    // The non-conflicting file of the same merge was written.
    expect(readFileSync(join(e.repo, 'added.txt'), 'utf8')).toBe('new from the patch\n');
    await expect(
      reasonOf(e.svc.commit(ACCOUNT, s.id, { message: 'x', branch: 'x', acceptPending: true })),
    ).resolves.toMatchObject({ reason: 'merge_conflicts' });
    await expect(reasonOf(e.merges.resolve(ACCOUNT, s.id, m.id))).resolves.toMatchObject({
      reason: 'merge_conflicts',
    });
    // The user settles it; the commit then resolves the merge and goes through.
    writeFileSync(join(e.repo, 'doc.txt'), text(withLine(4, 'both')));
    const c = await e.svc.commit(ACCOUNT, s.id, {
      message: 'merged',
      branch: 'merged',
      acceptPending: true,
    });
    expect(c.files).toBe(2);
    expect(e.merges.get(ACCOUNT, s.id, m.id).status).toBe('resolved');
    expect(e.audit.some((a) => a.action === 'code.merge.resolved')).toBe(true);
    expect(before).toContain('ours');
  });

  it('aborts a conflicted merge: the files are as they were', async () => {
    const { base, patch, s } = await moved(4, 4);
    const before = readFileSync(join(e.repo, 'doc.txt'), 'utf8');
    const m = await e.merges.mergePatch(ACCOUNT, s.id, patch, base, 'markers');
    const aborted = await e.merges.abort(ACCOUNT, s.id, m.id);
    expect(aborted.status).toBe('aborted');
    expect(readFileSync(join(e.repo, 'doc.txt'), 'utf8')).toBe(before);
    await expect(reasonOf(e.merges.abort(ACCOUNT, s.id, m.id))).resolves.toMatchObject({
      reason: 'merge_settled',
    });
    expect(e.audit.some((a) => a.action === 'code.merge.aborted')).toBe(true);
  });

  it("merges a worker's work, commits and uncommitted, and never merges binary files", async () => {
    e = await makeCodeM7Env();
    writeFileSync(join(e.repo, 'doc.txt'), text(LINES));
    writeFileSync(join(e.repo, 'pic.bin'), Buffer.from([0, 1, 2, 3]));
    e.git(['add', '-A']);
    e.git(['commit', '-qm', 'doc']);
    const parent = await e.svc.create(ACCOUNT, { folder: e.repo });
    const worker = await e.svc.create(ACCOUNT, { folder: e.repo, worktree: true, title: 'worker' });
    const wf = e.svc.info(ACCOUNT, worker.id).folder;
    // The worker commits one change and leaves another uncommitted; the parent moved meanwhile.
    writeFileSync(join(wf, 'doc.txt'), text(withLine(0, 'worker')));
    e.gitIn(wf, ['commit', '-qam', 'worker edit']);
    writeFileSync(join(wf, 'extra.txt'), 'worker file\n');
    writeFileSync(join(wf, 'pic.bin'), Buffer.from([0, 9, 9, 9]));
    writeFileSync(join(e.repo, 'doc.txt'), text(withLine(11, 'parent')));
    writeFileSync(join(e.repo, 'pic.bin'), Buffer.from([0, 7, 7, 7]));
    const r = await reasonOf(e.merges.mergeSession(ACCOUNT, parent.id, worker.id));
    expect(r.reason).toBe('merge_conflict');
    expect(r.details.paths).toEqual(['pic.bin']);
    const m = await e.merges.mergeSession(ACCOUNT, parent.id, worker.id, 'markers');
    expect(m.status).toBe('conflicted');
    expect(m.files).toEqual(
      expect.arrayContaining([
        { path: 'doc.txt', result: 'merged', conflicts: 0 },
        { path: 'extra.txt', result: 'added', conflicts: 0 },
        { path: 'pic.bin', result: 'binary_conflict', conflicts: 1 },
      ]),
    );
    // The binary file keeps the session's side; the text ones merged.
    expect([...readFileSync(join(e.repo, 'pic.bin'))]).toEqual([0, 7, 7, 7]);
    const doc = readFileSync(join(e.repo, 'doc.txt'), 'utf8');
    expect(doc).toContain('worker');
    expect(doc).toContain('parent');
    expect(m.conflicts[0]).toMatchObject({ path: 'pic.bin', binary: true, base: null });
    // Merging into itself, or across repositories, is refused.
    await expect(
      reasonOf(e.merges.mergeSession(ACCOUNT, parent.id, parent.id)),
    ).resolves.toMatchObject({
      reason: 'same_session',
    });
    const other = join(e.dir, 'other-repo');
    mkdirSync(other);
    e.gitIn(other, ['init', '-q', '-b', 'main']);
    writeFileSync(join(other, 'doc.txt'), 'another project\n');
    e.gitIn(other, ['add', '-A']);
    e.gitIn(other, ['commit', '-qm', 'theirs']);
    const stranger = await e.svc.create(ACCOUNT, { folder: other });
    const merges = e.merges.list(ACCOUNT, parent.id).length;
    await expect(
      reasonOf(e.merges.mergeSession(ACCOUNT, parent.id, stranger.id)),
    ).resolves.toMatchObject({ reason: 'other_repository' });
    // Nothing was written or recorded.
    expect(e.merges.list(ACCOUNT, parent.id)).toHaveLength(merges);
    expect(readFileSync(join(other, 'doc.txt'), 'utf8')).toBe('another project\n');
  });
});
