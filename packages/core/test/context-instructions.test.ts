// Instruction-file discovery (FR-185, docs/09 §11): the project root from root markers, one file
// per directory from the root down to the working directory (.nova/instructions.md, AGENTS.md,
// then plain fallback names), one byte budget with truncation and a warning, no symlinks out of
// the root, the data folder as a ceiling, and the user's own instructions. In the loop: the
// sections join the system context, a project's first folder is the working directory, side
// chats inherit their parent's, and an overflow is an event and a notice on the reply.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverInstructions, isPlainFileName, readUserInstructions } from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { systemText } from './loop-env.ts';
import { makeM5Env, type M5Env } from './loop-m5-env.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-instr-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function file(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

/** repo/.git, repo/AGENTS.md, repo/pkg/{.nova/instructions.md, AGENTS.md}, repo/pkg/sub/. */
function repo(): { root: string; pkg: string; sub: string } {
  const root = join(dir, 'repo');
  const pkg = join(root, 'pkg');
  const sub = join(pkg, 'sub');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(sub, { recursive: true });
  file(join(root, 'AGENTS.md'), 'root rules');
  file(join(pkg, '.nova', 'instructions.md'), 'pkg nova rules');
  file(join(pkg, 'AGENTS.md'), 'pkg agents rules (shadowed)');
  return { root, pkg, sub };
}

describe('discoverInstructions', () => {
  it('walks from the project root down to the working directory, one file each', () => {
    const r = repo();
    file(join(r.sub, 'RULES.md'), 'sub fallback rules');
    const found = discoverInstructions({ cwd: r.sub, fallbackNames: ['RULES.md'] });
    expect(found.root).toBe(r.root);
    expect(found.files.map((f) => f.path)).toEqual([
      join(r.root, 'AGENTS.md'),
      join(r.pkg, '.nova', 'instructions.md'),
      join(r.sub, 'RULES.md'),
    ]);
    expect(found.text).toBe(
      '### Project root (AGENTS.md)\nroot rules\n\n' +
        '### pkg (.nova/instructions.md)\npkg nova rules\n\n' +
        '### pkg/sub (RULES.md)\nsub fallback rules',
    );
    expect(found.warning).toBeNull();
  });

  it('uses the working directory as the root without a marker, or a configured marker', () => {
    const plain = join(dir, 'plain', 'a');
    file(join(plain, 'AGENTS.md'), 'a rules');
    file(join(dir, 'plain', 'AGENTS.md'), 'not read');
    const found = discoverInstructions({ cwd: plain });
    expect(found.root).toBe(plain);
    expect(found.files).toHaveLength(1);
    file(join(dir, 'plain', 'package.json'), '{}');
    const marked = discoverInstructions({ cwd: plain, rootMarkers: ['package.json'] });
    expect(marked.root).toBe(join(dir, 'plain'));
    expect(marked.files).toHaveLength(2);
  });

  it('ignores fallback names and markers that are not plain file names', () => {
    const r = repo();
    file(join(r.root, 'evil.md'), 'should not load');
    const found = discoverInstructions({
      cwd: r.sub,
      fallbackNames: ['../evil.md', 'a/b.md', 'C:x.md', '..'],
      rootMarkers: ['../.git', '.git'],
    });
    expect(found.text).not.toContain('should not load');
    expect(isPlainFileName('NOTES.md')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'c:d', 'x\u0000y', 'x'.repeat(101)])
      expect(isPlainFileName(bad)).toBe(false);
  });

  it('truncates the file that overflows the budget, drops the rest, and warns', () => {
    const r = repo();
    file(join(r.root, 'AGENTS.md'), 'r'.repeat(600));
    file(join(r.pkg, '.nova', 'instructions.md'), 'p'.repeat(600));
    file(join(r.sub, 'AGENTS.md'), 'sub rules');
    const found = discoverInstructions({ cwd: r.sub, budgetBytes: 1_000 });
    expect(found.files.map((f) => [f.bytes, f.truncated])).toEqual([
      [600, false],
      [400, true],
    ]);
    expect(found.dropped).toEqual([join(r.sub, 'AGENTS.md')]);
    expect(found.text).toContain('[... truncated');
    expect(found.text).not.toContain('sub rules');
    expect(found.warning).toBe(
      'Instruction files exceed their 1000-byte budget: pkg/.nova/instructions.md was truncated; 1 later file was left out (pkg/sub/AGENTS.md).',
    );
  });

  it('never splits a character when truncating', () => {
    const r = repo();
    file(join(r.root, 'AGENTS.md'), 'é'.repeat(10));
    const found = discoverInstructions({ cwd: r.root, budgetBytes: 7 });
    expect(found.files[0]).toMatchObject({ bytes: 6, truncated: true });
    expect(found.text).toContain('ééé\n[... truncated');
  });

  it('skips symlinks that leave the project root; follows those inside it', () => {
    const r = repo();
    file(join(dir, 'outside.md'), 'secret outside');
    rmSync(join(r.root, 'AGENTS.md'));
    symlinkSync(join(dir, 'outside.md'), join(r.root, 'AGENTS.md'));
    file(join(r.root, 'docs', 'rules.md'), 'linked inside');
    symlinkSync(join(r.root, 'docs', 'rules.md'), join(r.sub, 'AGENTS.md'));
    const found = discoverInstructions({ cwd: r.sub });
    expect(found.text).not.toContain('secret outside');
    expect(found.text).toContain('linked inside');
  });

  it('does not walk above a ceiling, and survives a missing folder', () => {
    const r = repo();
    const found = discoverInstructions({ cwd: r.sub, ceilings: [r.pkg] });
    expect(found.root).toBe(r.sub);
    expect(found.files).toHaveLength(0);
    expect(found.text).toBeNull();
    expect(discoverInstructions({ cwd: join(dir, 'missing') }).text).toBeNull();
  });

  it('reads the user instructions of the data folder, capped', () => {
    expect(readUserInstructions(dir, 100)).toBeNull();
    writeFileSync(join(dir, 'instructions.md'), 'Answer in British English.');
    expect(readUserInstructions(dir, 100)).toEqual({
      text: 'Answer in British English.',
      truncated: false,
    });
    expect(readUserInstructions(dir, 6)).toEqual({ text: 'Answer', truncated: true });
    rmSync(join(dir, 'instructions.md'));
    file(join(dir, '..', `${dir.split('/').at(-1)}-out.md`), 'outside');
    symlinkSync(join(dir, '..', `${dir.split('/').at(-1)}-out.md`), join(dir, 'instructions.md'));
    expect(readUserInstructions(dir, 100)).toBeNull();
    rmSync(join(dir, '..', `${dir.split('/').at(-1)}-out.md`));
  });
});

describe('instruction files in the loop', () => {
  let env: M5Env;
  afterEach(() => env.close());

  it('adds the user instructions and the working folder files to the system context', async () => {
    env = await makeM5Env();
    const dataDir = join(env.dir, 'data');
    writeFileSync(join(dataDir, 'instructions.md'), 'Use metric units.');
    writeFileSync(join(env.workspace, 'AGENTS.md'), 'Workspace rule: be brief.');
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    const sys = systemText(env.mock.requests[0]);
    expect(sys).toContain('## User instructions\nThe user wrote these for every conversation.');
    expect(sys).toContain('Use metric units.');
    expect(sys).toContain('## Instruction files');
    expect(sys).toContain('### Project root (AGENTS.md)\nWorkspace rule: be brief.');
    // User instructions come before the files.
    expect(sys.indexOf('metric')).toBeLessThan(sys.indexOf('Workspace rule'));
  });

  it("reads a project's first folder; a side chat inherits it", async () => {
    const r = repo();
    env = await makeM5Env({
      context: { projectFolders: () => Promise.resolve([{ path: r.sub }]) },
    });
    const project = await env.projects.create(ACCOUNT, { name: 'P' });
    const t = await env.threads.create(ACCOUNT, { projectId: project.id });
    await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    const sys = systemText(env.mock.requests[0]);
    expect(sys).toContain(`From the project folder ${r.root}`);
    expect(sys.indexOf('root rules')).toBeLessThan(sys.indexOf('pkg nova rules'));
    await env.chat.sideChat(ACCOUNT, t.id, { text: 'aside' });
    await env.chat.idle();
    expect(systemText(env.mock.requests.at(-1))).toContain('pkg nova rules');
  });

  it('warns with an event and a notice when the files exceed the budget', async () => {
    env = await makeM5Env({
      context: {
        instructionFiles: () => Promise.resolve({ budgetBytes: 1_024 }),
      },
    });
    writeFileSync(join(env.workspace, 'AGENTS.md'), 'x'.repeat(2_000));
    const t = await env.threads.create(ACCOUNT, {});
    const sent = await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    const ev = env.events.events.find((e) => e.name === 'context.instructions.truncated');
    expect(ev?.payload).toMatchObject({
      threadId: t.id,
      turnId: sent.turnId,
      messageId: sent.assistantMessageId,
      truncated: [join(env.workspace, 'AGENTS.md')],
      dropped: [],
    });
    const notice = env.db.raw
      .prepare("SELECT content FROM message_part WHERE message_id = ? AND type = 'notice'")
      .get(sent.assistantMessageId) as { content: string };
    expect(JSON.parse(notice.content)).toMatchObject({ code: 'instructions_truncated' });
    expect(systemText(env.mock.requests[0])).toContain('x'.repeat(1_024));
    expect(systemText(env.mock.requests[0])).not.toContain('x'.repeat(1_025));
  });

  it('a turn without tools has no working folder but still reads the user instructions', async () => {
    env = await makeM5Env({ noTools: true });
    mkdirSync(join(env.dir, 'data'), { recursive: true });
    writeFileSync(join(env.dir, 'data', 'instructions.md'), 'Call me Sam.');
    const t = await env.threads.create(ACCOUNT, {});
    await env.chat.send(ACCOUNT, t.id, { text: 'hi' });
    await env.chat.idle();
    const sys = systemText(env.mock.requests[0]);
    expect(sys).toContain('Call me Sam.');
    expect(sys).not.toContain('## Instruction files');
  });
});
