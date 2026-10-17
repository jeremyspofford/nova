// The Nova patch format of fs.edit (docs/08 §1.3): grammar and leniency, applying with anchors
// and whitespace levels, all-or-nothing writes, line endings, errors with candidates, and
// unified diffs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PATCH_BYTES,
  PatchError,
  applyPatch,
  newBlock,
  oldBlock,
  parsePatch,
  type FileSection,
} from '../src/index.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nova-patch-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const resolve = (p: string) => {
  if (p.includes('..')) throw new Error('outside the allowed folders');
  return join(dir, p);
};
const apply = (patch: string) => applyPatch(parsePatch(patch), resolve);
const read = (p: string) => readFileSync(join(dir, p), 'utf8');
const write = (p: string, text: string) => {
  mkdirSync(join(dir, p, '..'), { recursive: true });
  writeFileSync(join(dir, p), text);
};
function patchError(fn: () => unknown): PatchError {
  try {
    fn();
  } catch (err) {
    if (err instanceof PatchError) return err;
    throw err;
  }
  throw new Error('expected a PatchError');
}

describe('parsing (docs/08 §1.3 grammar)', () => {
  it('reads add, delete, update with move and several anchored hunks', () => {
    const sections = parsePatch(
      [
        '%%% patch',
        '%%% add docs/notes.md',
        '+# Notes',
        '+',
        '+Release checklist.',
        '%%% update src/server.ts',
        '%%% move-to src/http/server.ts',
        '@@ export function start',
        '   const port = 3000;',
        '-  listen(port);',
        '+  listen(port, host);',
        '@@ class A',
        '@@ method b',
        ' x',
        '%%% eof',
        '%%% delete src/legacy.ts',
        '%%% end',
      ].join('\n'),
    );
    expect(sections.map((s) => s.op)).toEqual(['add', 'update', 'delete']);
    const add = sections[0] as Extract<FileSection, { op: 'add' }>;
    expect(add.lines).toEqual(['# Notes', '', 'Release checklist.']);
    const upd = sections[1] as Extract<FileSection, { op: 'update' }>;
    expect(upd.moveTo).toBe('src/http/server.ts');
    expect(upd.hunks).toHaveLength(2);
    expect(upd.hunks[0]!.anchors).toEqual(['export function start']);
    expect(oldBlock(upd.hunks[0]!)).toEqual(['  const port = 3000;', '  listen(port);']);
    expect(newBlock(upd.hunks[0]!)).toEqual(['  const port = 3000;', '  listen(port, host);']);
    expect(upd.hunks[1]!.anchors).toEqual(['class A', 'method b']);
    expect(upd.hunks[1]!.eof).toBe(true);
  });

  it('is lenient about whitespace around markers, CRLF, blank lines and a missing newline', () => {
    const s = parsePatch(
      '\r\n  %%%  patch \r\n\r\n %%% update\ta.txt\r\n@@\r\n-old\r\n+new\r\n\r\n%%% end',
    );
    expect(s).toHaveLength(1);
    expect(oldBlock((s[0] as Extract<FileSection, { op: 'update' }>).hunks[0]!)).toEqual(['old']);
  });

  it('treats an empty hunk line as empty context and a complete marker as a marker', () => {
    const s = parsePatch('%%% patch\n%%% update a\n@@\n a\n\n b\n%%% end\n');
    const h = (s[0] as Extract<FileSection, { op: 'update' }>).hunks[0]!;
    expect(oldBlock(h)).toEqual(['a', '', 'b']);
  });

  it.each([
    ['no opening line', '%%% update a\n@@\n-x\n%%% end', 'a patch starts with'],
    ['no closing line', '%%% patch\n%%% delete a\n', 'must end with'],
    ['unknown marker', '%%% patch\n%%% rename a\n%%% end', 'unknown marker'],
    ['bad add line', '%%% patch\n%%% add a\nhello\n%%% end', 'starts with "+"'],
    ['bad hunk line', '%%% patch\n%%% update a\n@@\n*x\n%%% end', 'starts with " ", "-" or "+"'],
    ['update without hunks', '%%% patch\n%%% update a\n%%% end', 'at least one hunk'],
    ['empty hunk', '%%% patch\n%%% update a\n@@ anchor\n%%% end', 'at least one line'],
    ['stray move-to', '%%% patch\n%%% move-to a\n%%% end', 'not allowed here'],
    ['text after end', '%%% patch\n%%% delete a\n%%% end\nmore', 'after "%%% end"'],
    ['no sections', '%%% patch\n%%% end', 'changes no files'],
  ])('rejects %s with patch.syntax and the line', (_name, text, msg) => {
    const e = patchError(() => parsePatch(text));
    expect(e.code).toBe('patch.syntax');
    expect(e.message).toContain(msg);
    expect(e.details.line).toEqual(expect.any(Number));
  });

  it('rejects patches over 1 MiB', () => {
    const big = `%%% patch\n%%% add a\n+${'x'.repeat(MAX_PATCH_BYTES)}\n%%% end`;
    expect(patchError(() => parsePatch(big)).code).toBe('patch.too_large');
  });
});

describe('applying', () => {
  it('adds, updates through anchors, moves and deletes, all at once', () => {
    write(
      'src/server.ts',
      'export function start() {\n  const port = 3000;\n  listen(port);\n}\nexport function stop() {\n  flush();\n  close();\n}\n',
    );
    write('src/legacy.ts', 'old\n');
    const files = apply(
      [
        '%%% patch',
        '%%% add docs/notes.md',
        '+# Notes',
        '%%% update src/server.ts',
        '%%% move-to src/http/server.ts',
        '@@ export function start',
        '   const port = 3000;',
        '-  listen(port);',
        '+  listen(port, host);',
        '@@ export function stop',
        '   flush();',
        '-  close();',
        '+  close({ graceful: true });',
        ' }',
        '%%% eof',
        '%%% delete src/legacy.ts',
        '%%% end',
      ].join('\n'),
    );
    expect(read('docs/notes.md')).toBe('# Notes\n');
    expect(existsSync(join(dir, 'src/server.ts'))).toBe(false);
    expect(read('src/http/server.ts')).toBe(
      'export function start() {\n  const port = 3000;\n  listen(port, host);\n}\nexport function stop() {\n  flush();\n  close({ graceful: true });\n}\n',
    );
    expect(existsSync(join(dir, 'src/legacy.ts'))).toBe(false);
    expect(files.map((f) => [f.op, f.path, f.added, f.removed])).toEqual([
      ['add', 'docs/notes.md', 1, 0],
      ['move', 'src/server.ts', 2, 2],
      ['delete', 'src/legacy.ts', 0, 1],
    ]);
    expect(files[1]).toMatchObject({
      movedTo: 'src/http/server.ts',
      sha256Before: expect.stringMatching(/^[0-9a-f]{64}$/),
      sha256After: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(files[0]!.sha256Before).toBeNull();
    expect(files[2]!.sha256After).toBeNull();
  });

  it('matches ignoring trailing, then surrounding whitespace, keeping the file text of context', () => {
    write('a.py', 'def f():  \n    return 1\n');
    apply('%%% patch\n%%% update a.py\n@@\n def f():\n-  return 1\n+    return 2\n%%% end');
    expect(read('a.py')).toBe('def f():  \n    return 2\n');
  });

  it('keeps CRLF line endings and a missing final newline', () => {
    write('w.txt', 'one\r\ntwo\r\nthree');
    apply('%%% patch\n%%% update w.txt\n@@\n one\n-two\n+TWO\n%%% end');
    expect(read('w.txt')).toBe('one\r\nTWO\r\nthree');
  });

  it('inserts with an anchor and appends at the end with eof', () => {
    write('list.txt', 'a\nb\n');
    apply('%%% patch\n%%% update list.txt\n@@ a\n+a2\n@@\n+z\n%%% eof\n%%% end');
    expect(read('list.txt')).toBe('a\na2\nb\nz\n');
  });

  it('refuses an ambiguous block, listing where it matched', () => {
    write('dup.txt', 'x\ny\nx\ny\n');
    const e = patchError(() => apply('%%% patch\n%%% update dup.txt\n@@\n-x\n+X\n%%% end'));
    expect(e.code).toBe('patch.context_ambiguous');
    expect(e.details).toMatchObject({ path: 'dup.txt', hunk: 0 });
    expect(e.details.candidates!.map((c) => c.line)).toEqual([1, 3]);
    expect(read('dup.txt')).toBe('x\ny\nx\ny\n');
  });

  it('refuses context that is not found, with nearby candidates', () => {
    write('c.ts', 'const a = 1;\nconst b = 2;\n');
    const e = patchError(() =>
      apply('%%% patch\n%%% update c.ts\n@@\n-const b = 3;\n+const b = 4;\n%%% end'),
    );
    expect(e.code).toBe('patch.context_not_found');
    expect(e.details.candidates).toEqual([]);
    const anchor = patchError(() =>
      apply('%%% patch\n%%% update c.ts\n@@ function nope\n-const a = 1;\n%%% end'),
    );
    expect(anchor.code).toBe('patch.context_not_found');
    expect(anchor.message).toContain('anchor not found');
    const near = patchError(() =>
      apply('%%% patch\n%%% update c.ts\n@@\n const a = 1;\n-const c = 2;\n%%% end'),
    );
    expect(near.details.candidates![0]).toEqual({ line: 1, preview: 'const a = 1;' });
  });

  it('is all-or-nothing: a failing later section leaves earlier files untouched', () => {
    write('one.txt', 'keep\n');
    const e = patchError(() =>
      apply(
        '%%% patch\n%%% update one.txt\n@@\n-keep\n+changed\n%%% update missing.txt\n@@\n-x\n%%% end',
      ),
    );
    expect(e.code).toBe('patch.file_missing');
    expect(read('one.txt')).toBe('keep\n');
  });

  it.each([
    ['patch.file_exists', 'exists.txt', '%%% patch\n%%% add exists.txt\n+x\n%%% end'],
    ['patch.file_missing', null, '%%% patch\n%%% delete gone.txt\n%%% end'],
    ['patch.binary', 'bin.dat', '%%% patch\n%%% update bin.dat\n@@\n-x\n%%% end'],
    ['patch.path_denied', null, '%%% patch\n%%% add ../escape.txt\n+x\n%%% end'],
    ['patch.syntax', null, '%%% patch\n%%% delete a.txt\n%%% delete a.txt\n%%% end'],
  ])('reports %s', (code, existing, text) => {
    if (existing === 'bin.dat') writeFileSync(join(dir, existing), Buffer.from([1, 0, 2]));
    else if (existing) write(existing, 'x\n');
    if (code === 'patch.syntax') write('a.txt', 'x\n');
    expect(patchError(() => apply(text)).code).toBe(code);
  });

  it('refuses a move onto an existing file', () => {
    write('from.txt', 'x\n');
    write('to.txt', 'y\n');
    const e = patchError(() =>
      apply('%%% patch\n%%% update from.txt\n%%% move-to to.txt\n%%% end'),
    );
    expect(e.code).toBe('patch.file_exists');
  });
});

describe('unified diffs', () => {
  it('applies --- / +++ hunks, treating line numbers as hints', () => {
    write('u.txt', 'alpha\nbeta\ngamma\n');
    apply(
      [
        'diff --git a/u.txt b/u.txt',
        'index 000..111 100644',
        '--- a/u.txt\t2026-01-01',
        '+++ b/u.txt',
        '@@ -99,3 +99,3 @@ context',
        ' alpha',
        '-beta',
        '+BETA',
        ' gamma',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    expect(read('u.txt')).toBe('alpha\nBETA\ngamma\n');
  });

  it('creates and deletes through /dev/null, and renames', () => {
    write('old.txt', 'bye\n');
    write('r1.txt', 'same\n');
    apply(
      [
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,2 @@',
        '+hello',
        '+world',
        '--- a/old.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-bye',
        '--- a/r1.txt',
        '+++ b/r2.txt',
        '@@ -1 +1 @@',
        ' same',
      ].join('\n'),
    );
    expect(read('new.txt')).toBe('hello\nworld\n');
    expect(existsSync(join(dir, 'old.txt'))).toBe(false);
    expect(read('r2.txt')).toBe('same\n');
  });

  it('rejects a header without +++', () => {
    expect(patchError(() => parsePatch('--- a/x\n@@ -1 +1 @@\n-a\n+b')).code).toBe('patch.syntax');
  });
});
