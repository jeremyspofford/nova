// Change capture and review (FR-064, FR-065, FR-069, FR-211, docs/10 §5 and §8): edits made by
// tools and by commands are captured against the session baseline; single hunks are accepted
// (baseline advances) or rejected (reverse-applied); a file shows `partial` while half decided;
// comments go to the agent as one user turn; a structured review returns validated findings
// that become comments; commits take only accepted content, refuse the default branch and
// secrets, and run the repository's hooks only in the sandbox.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StartTurnInput, TurnStarter } from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { HostSandbox, makeCodeEnv, type CodeEnv } from './code-env.ts';

let env: CodeEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const lines = (edit: (l: string[]) => void): string => {
  const l = Array.from({ length: 30 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
  edit(l);
  return `${l.join('\n')}\n`;
};

describe('change capture (FR-064)', () => {
  it('captures tool edits and command output alike, with hunks and the call that made them', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    expect(await env.svc.changes(ACCOUNT, s.id)).toEqual([]);
    // An edit the agent made with fs.edit (call c1)…
    writeFileSync(
      join(env.repo, 'app.ts'),
      lines((l) => (l[1] = 'export const v2 = 20;')),
    );
    expect(await env.svc.refreshThread(ACCOUNT, s.threadId, 'c1')).toEqual(['app.ts']);
    // …and files a command wrote (exec.run, call c2); ignored output stays out.
    writeFileSync(join(env.repo, 'gen.ts'), 'export const generated = true;\n');
    mkdirSync(join(env.repo, 'dist'));
    writeFileSync(join(env.repo, 'dist', 'out.js'), 'x');
    expect(await env.svc.refreshThread(ACCOUNT, s.threadId, 'c2')).toEqual(['gen.ts']);
    expect(await env.svc.refreshThread(ACCOUNT, 'not-a-code-thread', 'c3')).toEqual([]);
    const changes = await env.svc.changes(ACCOUNT, s.id);
    expect(
      changes.map((c) => [c.path, c.kind, c.callId, c.state, c.additions, c.deletions]),
    ).toEqual([
      ['app.ts', 'modify', 'c1', 'pending', 1, 1],
      ['gen.ts', 'add', 'c2', 'pending', 1, 0],
    ]);
    const hunk = changes[0]!.hunks[0]!;
    expect(hunk).toMatchObject({ id: '1-1', state: 'pending', oldStart: 1, newStart: 1 });
    expect(hunk.lines.filter((l) => l.kind !== 'context')).toEqual([
      { kind: 'del', text: 'export const v2 = 2;', oldNo: 2, newNo: null },
      { kind: 'add', text: 'export const v2 = 20;', oldNo: null, newNo: 2 },
    ]);
    // The pending patch is stored as a blob under the data folder.
    const row = env.db.raw
      .prepare('SELECT patch_blob_path AS p FROM code_change WHERE id = ?')
      .get(changes[0]!.id) as { p: string };
    expect(readFileSync(join(env.dataDir, row.p), 'utf8')).toContain('+export const v2 = 20;');
    // Nothing changed: no event, no update.
    const before = env.events.names().length;
    expect(await env.svc.refresh(ACCOUNT, s.id)).toEqual([]);
    expect(env.events.names().length).toBe(before);
  });

  it('drops a change the agent undid itself', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    const original = readFileSync(join(env.repo, 'app.ts'), 'utf8');
    writeFileSync(join(env.repo, 'app.ts'), 'changed\n');
    expect(await env.svc.changes(ACCOUNT, s.id)).toHaveLength(1);
    writeFileSync(join(env.repo, 'app.ts'), original);
    expect(await env.svc.changes(ACCOUNT, s.id)).toEqual([]);
  });
});

describe('per-hunk review (FR-065)', () => {
  async function twoHunks(e: CodeEnv) {
    const s = await e.svc.create(ACCOUNT, { folder: e.repo });
    writeFileSync(
      join(e.repo, 'app.ts'),
      lines((l) => {
        l[1] = 'export const v2 = 20;';
        l[25] = 'export const v26 = 260;';
      }),
    );
    const [change] = await e.svc.changes(ACCOUNT, s.id);
    return { s, change: change! };
  }

  it('accepts one hunk and rejects another; the file is partial until decided', async () => {
    env = await makeCodeEnv();
    const { s, change } = await twoHunks(env);
    expect(change.hunks.map((h) => h.id)).toEqual(['1-1', '23-23']);
    const half = await env.svc.decideHunks(ACCOUNT, s.id, change.id, {
      decisions: [{ hunkId: '1-1', accept: true }],
    });
    expect(half.state).toBe('partial');
    expect(half.hunks.map((h) => [h.id, h.state])).toEqual([
      ['1-1', 'accepted'],
      ['23-23', 'pending'],
    ]);
    const done = await env.svc.decideHunks(ACCOUNT, s.id, change.id, {
      decisions: [{ hunkId: '23-23', accept: false }],
    });
    expect(done.state).toBe('partial');
    expect(done.hunks.map((h) => h.state)).toEqual(['accepted', 'rejected']);
    const text = readFileSync(join(env.repo, 'app.ts'), 'utf8');
    expect(text).toContain('v2 = 20;');
    expect(text).toContain('v26 = 26;');
    expect(env.events.names()).toEqual(
      expect.arrayContaining(['code.change.applied', 'code.change.reverted']),
    );
    expect(env.audit.some((a) => a.action === 'code.change.rejected')).toBe(true);
    // The file is fully decided; a later edit starts a fresh round.
    writeFileSync(join(env.repo, 'app.ts'), `${text}export const extra = 1;\n`);
    const [again] = await env.svc.changes(ACCOUNT, s.id);
    expect(again!.state).toBe('pending');
    expect(again!.hunks.every((h) => h.state === 'pending')).toBe(true);
  });

  it('refuses stale or unknown hunks', async () => {
    env = await makeCodeEnv();
    const { s, change } = await twoHunks(env);
    await expect(
      env.svc.decideHunks(ACCOUNT, s.id, change.id, {
        decisions: [{ hunkId: '9-9', accept: true }],
      }),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'stale_hunk' } });
    await expect(
      env.svc.decideHunks(ACCOUNT, s.id, 'nope', { decisions: [{ hunkId: '1-1', accept: true }] }),
    ).rejects.toMatchObject({ code: 'not_found' });
    // The user reverted the file meanwhile: nothing is pending.
    env.git(['checkout', '--', 'app.ts']);
    await expect(
      env.svc.decideHunks(ACCOUNT, s.id, change.id, {
        decisions: [{ hunkId: '1-1', accept: true }],
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('accepts or rejects whole files, binary ones included', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    writeFileSync(join(env.repo, 'logo.png'), Buffer.from([0x89, 0x50, 0, 1, 2, 3]));
    writeFileSync(join(env.repo, 'notes.md'), '# notes\n');
    writeFileSync(join(env.repo, 'app.ts'), 'replaced\n');
    const changes = await env.svc.changes(ACCOUNT, s.id);
    const logo = changes.find((c) => c.path === 'logo.png')!;
    expect(logo).toMatchObject({ binary: true, hunks: [], kind: 'add' });
    const rejected = await env.svc.decideAll(ACCOUNT, s.id, false, [logo.id]);
    expect(rejected[0]).toMatchObject({ state: 'rejected' });
    expect(existsSync(join(env.repo, 'logo.png'))).toBe(false);
    const accepted = await env.svc.decideAll(ACCOUNT, s.id, true);
    expect(accepted.map((c) => [c.path, c.state]).sort()).toEqual([
      ['app.ts', 'accepted'],
      ['logo.png', 'rejected'],
      ['notes.md', 'accepted'],
    ]);
    expect(readFileSync(join(env.repo, 'app.ts'), 'utf8')).toBe('replaced\n');
    await expect(env.svc.decideAll(ACCOUNT, s.id, true, ['missing'])).rejects.toMatchObject({
      code: 'not_found',
    });
    // Rejecting everything restores the baseline content.
    writeFileSync(join(env.repo, 'notes.md'), '# changed again\n');
    await env.svc.decideAll(ACCOUNT, s.id, false);
    expect(readFileSync(join(env.repo, 'notes.md'), 'utf8')).toBe('# notes\n');
  });
});

describe('comments (FR-065)', () => {
  it('sends a submitted batch to the agent as one user turn and resolves comments', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    writeFileSync(
      join(env.repo, 'app.ts'),
      lines((l) => (l[1] = 'export const v2 = 20;')),
    );
    const [change] = await env.svc.changes(ACCOUNT, s.id);
    await expect(
      env.svc.addComments(ACCOUNT, s.id, {
        comments: [{ changeId: change!.id, line: 2, side: 'new', body: 'why 20?' }],
        submit: true,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const first = await env.svc.addComments(ACCOUNT, s.id, {
      comments: [{ changeId: change!.id, line: 2, side: 'new', body: 'Use 21 instead' }],
    });
    expect(first).toEqual([
      expect.objectContaining({
        path: 'app.ts',
        line: 2,
        side: 'new',
        body: 'Use 21 instead',
        resolved: false,
        author: 'user',
        submittedAt: null,
      }),
    ]);
    const started: StartTurnInput[] = [];
    const starter: TurnStarter = {
      startTurn: (input) => {
        started.push(input);
        return Promise.resolve({ turnId: 't', messageId: 'm', done: new Promise(() => undefined) });
      },
      cancel: () => Promise.resolve(),
    };
    env.svc.useTurns(starter);
    await env.svc.addComments(ACCOUNT, s.id, {
      comments: [{ changeId: change!.id, line: 1, side: 'old', body: 'keep the header' }],
      submit: true,
    });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      threadId: s.threadId,
      trigger: 'user',
      authorKind: 'user',
      authority: { kind: 'user', source: `code:${s.id}:comments` },
    });
    expect(started[0]!.text).toContain('app.ts line 2 (new side): Use 21 instead');
    expect(started[0]!.text).toContain('app.ts line 1 (old side): keep the header');
    // Sent comments are not sent twice.
    await env.svc.addComments(ACCOUNT, s.id, {
      comments: [{ changeId: change!.id, line: 3, side: 'new', body: 'one more' }],
      submit: true,
    });
    expect(started[1]!.text).not.toContain('Use 21 instead');
    const resolved = await env.svc.resolveComment(ACCOUNT, s.id, first[0]!.id);
    expect(resolved.resolved).toBe(true);
    expect(env.svc.comments(ACCOUNT, s.id)).toHaveLength(3);
    await expect(env.svc.resolveComment(ACCOUNT, s.id, 'nope')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      env.svc.addComments(ACCOUNT, s.id, {
        comments: [{ changeId: 'nope', line: 1, side: 'new', body: 'x' }],
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(env.events.names().filter((n) => n === 'code.diff.commented')).toHaveLength(3);
  });
});

describe('structured review (FR-069)', () => {
  const findings = JSON.stringify([
    {
      path: 'app.ts',
      line: 2,
      severity: 'warn',
      title: 'Magic number',
      reasoning: 'Name the constant.',
      fix: 'export const v2 = TWENTY;',
    },
    { path: 'other.ts', line: null, severity: 'info', title: 'Elsewhere', reasoning: '' },
  ]);

  it('validates findings and adds them as diff comments', async () => {
    env = await makeCodeEnv({
      mock: {
        scripts: [
          { when: 'Review this diff', steps: [{ textChunks: ['```json\n', findings, '\n```'] }] },
        ],
      },
    });
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    await expect(env.svc.startReview(ACCOUNT, s.id)).rejects.toMatchObject({ code: 'validation' });
    writeFileSync(
      join(env.repo, 'app.ts'),
      lines((l) => (l[1] = 'export const v2 = 20;')),
    );
    const { view, done } = await env.svc.startReview(ACCOUNT, s.id);
    expect(view.status).toBe('running');
    const result = await done;
    expect(result.status).toBe('done');
    expect(result.findings.map((f) => [f.path, f.line, f.severity, f.title])).toEqual([
      ['app.ts', 2, 'warn', 'Magic number'],
      ['other.ts', null, 'info', 'Elsewhere'],
    ]);
    expect(env.svc.review(ACCOUNT, s.id, view.id).findings).toHaveLength(2);
    const comments = env.svc.comments(ACCOUNT, s.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: 'review',
      reviewId: view.id,
      line: 2,
      side: 'new',
    });
    expect(comments[0]!.body).toContain('[warn] Magic number');
    expect(env.audit.find((a) => a.action === 'code.review')).toMatchObject({
      kind: 'code',
      result: 'ok',
      detail: { reviewId: view.id, findings: 2 },
    });
    expect(comments[0]!.body).toContain('Suggested fix:');
    expect(
      env.events.events.find((e) => e.name === 'code.review.completed')?.payload,
    ).toMatchObject({
      sessionId: s.id,
      status: 'done',
      findings: 2,
    });
    // The diff reached the model as delimited data.
    const req = env.mock.requests.at(-1)!;
    const user = req.messages.find((m) => m.role === 'user')!;
    expect(JSON.stringify(user.content)).toContain('<diff>');
    expect(() => env!.svc.review(ACCOUNT, s.id, 'nope')).toThrow(/not found/);
  });

  it('retries once on an invalid reply, then fails', async () => {
    env = await makeCodeEnv({
      mock: {
        scripts: [
          { when: 'Review this diff', once: true, steps: [{ textChunks: ['not json'] }] },
          { when: 'not valid', once: true, steps: [{ textChunks: ['[]'] }] },
          { when: 'Review this diff', steps: [{ textChunks: ['[{"path": 3}]'] }] },
          { when: 'not valid', steps: [{ textChunks: ['still no'] }] },
        ],
      },
    });
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    writeFileSync(join(env.repo, 'app.ts'), 'x\n');
    const ok = await (await env.svc.startReview(ACCOUNT, s.id)).done;
    expect(ok).toMatchObject({ status: 'done', findings: [] });
    const bad = await (await env.svc.startReview(ACCOUNT, s.id)).done;
    expect(bad.status).toBe('failed');
    // The stored review says why it failed and which model ran it.
    const stored = env.svc.review(ACCOUNT, s.id, bad.id);
    expect(stored.status).toBe('failed');
    expect(stored.error).toEqual(expect.any(String));
    expect(stored.model).toEqual(expect.any(String));
  });
});

describe('commit (docs/10 §8, FR-211)', () => {
  function hook(e: CodeEnv, name: string, marker: string, exit = 0) {
    const p = join(e.repo, '.git', 'hooks', name);
    writeFileSync(p, `#!/bin/sh\necho ${name} >> "${marker}"\nexit ${exit}\n`);
    chmodSync(p, 0o755);
  }

  it('refuses the default branch, then commits accepted content on nova/<slug> without hooks', async () => {
    env = await makeCodeEnv();
    const marker = join(env.dir, 'hook-ran');
    hook(env, 'pre-commit', marker);
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    writeFileSync(
      join(env.repo, 'app.ts'),
      lines((l) => {
        l[1] = 'export const v2 = 20;';
        l[25] = 'export const v26 = 260;';
      }),
    );
    const [change] = await env.svc.changes(ACCOUNT, s.id);
    await env.svc.decideHunks(ACCOUNT, s.id, change!.id, {
      decisions: [{ hunkId: '1-1', accept: true }],
    });
    await expect(env.svc.commit(ACCOUNT, s.id, { message: 'Tune v2' })).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'default_branch' },
    });
    const result = await env.svc.commit(ACCOUNT, s.id, {
      message: 'Tune v2',
      branch: 'Tune values',
    });
    expect(result).toMatchObject({ branch: 'nova/tune-values', files: 1, hooksRan: false });
    expect(result.hooksNote).toMatch(/hooks did not run/);
    expect(existsSync(marker)).toBe(false);
    // Only the accepted hunk is committed; the pending one stays in the work tree.
    const committed = env.git(['show', 'HEAD:app.ts']);
    expect(committed).toContain('v2 = 20;');
    expect(committed).toContain('v26 = 26;');
    expect(readFileSync(join(env.repo, 'app.ts'), 'utf8')).toContain('v26 = 260;');
    expect(env.git(['rev-parse', 'HEAD'])).toContain(result.sha);
    expect(env.git(['log', '-1', '--format=%s'])).toBe('Tune v2\n');
    expect(env.git(['status', '--porcelain'])).toBe(' M app.ts\n');
    const after = await env.svc.changes(ACCOUNT, s.id);
    expect(after.map((c) => [c.path, c.state])).toEqual([['app.ts', 'pending']]);
    expect(env.audit.find((a) => a.action === 'code.commit')?.detail).toMatchObject({
      sha: result.sha,
      branch: 'nova/tune-values',
    });
    expect(env.events.names()).toContain('code.commit.created');
    // On a non-default branch no new branch is needed.
    await env.svc.decideAll(ACCOUNT, s.id, true);
    const second = await env.svc.commit(ACCOUNT, s.id, { message: 'Tune v26' });
    expect(second.branch).toBe('nova/tune-values');
    expect(await env.svc.changes(ACCOUNT, s.id)).toEqual([]);
    await expect(env.svc.commit(ACCOUNT, s.id, { message: 'Nothing' })).rejects.toMatchObject({
      code: 'validation',
    });
  });

  it('accepts pending changes first when asked, and refuses when other changes are staged', async () => {
    env = await makeCodeEnv();
    env.git(['checkout', '-q', '-b', 'feature']);
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    writeFileSync(join(env.repo, 'new.ts'), 'export const n = 1;\n');
    writeFileSync(join(env.repo, '.gitignore'), 'dist/\nstaged.txt\n');
    writeFileSync(join(env.home, 'unrelated.txt'), 'x');
    await env.svc.changes(ACCOUNT, s.id);
    writeFileSync(join(env.repo, 'README.md'), 'staged by the user\n');
    env.git(['add', 'README.md']);
    await expect(
      env.svc.commit(ACCOUNT, s.id, { message: 'Add n', acceptPending: true }),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'staged_changes' } });
    env.git(['reset', '-q', 'README.md']);
    const r = await env.svc.commit(ACCOUNT, s.id, { message: 'Add n', acceptPending: true });
    expect(r).toMatchObject({ branch: 'feature', hooksRan: false, hooksNote: null });
    expect(env.git(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort()).toEqual(
      ['.gitignore', 'README.md', 'new.ts'],
    );
  });

  it('refuses a commit with secrets and leaves the index as it was', async () => {
    env = await makeCodeEnv();
    env.git(['checkout', '-q', '-b', 'feature']);
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    // A private key block (assembled so this file itself holds none).
    const key = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
    writeFileSync(
      join(env.repo, 'config.ts'),
      `export const k = \`${key}\nMIIEowIBAAKCAQEA7bq8n2kq9Xz4\n-----END RSA PRIVATE KEY-----\`;\n`,
    );
    await env.svc.changes(ACCOUNT, s.id);
    const err = await env.svc
      .commit(ACCOUNT, s.id, { message: 'Add key', acceptPending: true })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'policy_denied', details: { reason: 'secrets_found' } });
    const details = (err as { details: { findings: { path: string; preview: string }[] } }).details;
    expect(details.findings[0]!.path).toBe('config.ts');
    expect(JSON.stringify(details)).not.toContain('MIIEowIBAAKCAQEA7bq8n2kq9Xz4');
    expect(env.git(['diff', '--cached', '--name-only'])).toBe('');
    expect(env.git(['log', '-1', '--format=%s'])).toBe('init\n');
  });

  it("runs the repository's hooks inside the sandbox when it has Git", async () => {
    const sandbox = new HostSandbox();
    env = await makeCodeEnv({ sandbox });
    env.git(['checkout', '-q', '-b', 'feature']);
    const marker = join(env.dir, 'hook-ran');
    hook(env, 'pre-commit', marker);
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    writeFileSync(join(env.repo, 'a.ts'), 'export const a = 1;\n');
    await env.svc.changes(ACCOUNT, s.id);
    const r = await env.svc.commit(ACCOUNT, s.id, {
      message: 'With "quotes" and $HOME',
      acceptPending: true,
    });
    expect(r).toMatchObject({ hooksRan: true, hooksNote: null });
    expect(readFileSync(marker, 'utf8')).toBe('pre-commit\n');
    expect(env.git(['log', '-1', '--format=%s'])).toBe('With "quotes" and $HOME\n');
    expect(sandbox.reqs.at(-1)).toMatchObject({
      cwd: env.repo,
      network: 'off',
      roots: [{ path: env.repo, access: 'write' }],
    });
    // A failing hook refuses the commit and unstages.
    rmMarker(marker);
    hook(env, 'pre-commit', marker, 1);
    writeFileSync(join(env.repo, 'b.ts'), 'export const b = 1;\n');
    await env.svc.changes(ACCOUNT, s.id);
    await expect(
      env.svc.commit(ACCOUNT, s.id, { message: 'Blocked', acceptPending: true }),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'commit_failed' } });
    expect(env.git(['diff', '--cached', '--name-only'])).toBe('');
    // Without Git in the sandbox, the Hub commits without hooks and says so.
    sandbox.hasGit = false;
    const r2 = await env.svc.commit(ACCOUNT, s.id, { message: 'No hooks' });
    expect(r2).toMatchObject({ hooksRan: false });
    expect(r2.hooksNote).toMatch(/did not run/);
  });

  it('refuses outside a repository and with a detached HEAD', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    writeFileSync(join(env.repo, 'x.ts'), 'x\n');
    env.git(['checkout', '-q', '--detach']);
    await expect(
      env.svc.commit(ACCOUNT, s.id, { message: 'x', acceptPending: true }),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'detached_head' } });
  });
});

function rmMarker(p: string) {
  if (existsSync(p)) writeFileSync(p, '');
}
