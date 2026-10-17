// The coding tools and the repo index (FR-074, FR-211, docs/10 §4): definitions extracted per
// language, an incremental index and reference search; git.status/diff/log hook-free and only in
// Code sessions; test.run detects the suite and runs it in the sandbox; review replies are
// validated; diff parsing keeps raw hunks for exact patches.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Logger } from '@nova/telemetry';
import {
  SymbolIndex,
  diffAddedLines,
  codeToolSource,
  detectTestCommand,
  extractSymbols,
  findCodeRefs,
  parseReviewFindings,
  parseRawDiff,
  parseDiffSection,
  codeReviewPrompt,
  testCommandWith,
  unquoteGitPath,
  type BuiltinTool,
  type ExecRequest,
  type ExecResult,
  type SandboxClient,
  type ToolContext,
  type ToolResult,
} from '../src/index.ts';
import { ACCOUNT } from './helpers.ts';
import { makeCodeEnv, type CodeEnv } from './code-env.ts';

let env: CodeEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe('symbol extraction (FR-074)', () => {
  it('finds definitions in TypeScript, Python, Go, Rust, Java and C/C++', () => {
    const ts = extractSymbols(
      'a.ts',
      [
        'export interface Shape { area(): number }',
        'export type Id = string;',
        'export enum Color { Red }',
        'export async function load(id: Id) {',
        '}',
        'export const add = (a: number, b: number) => a + b;',
        'export const LIMIT = 3;',
        'export class Circle {',
        '  constructor(private r: number) {}',
        '  area(): number {',
        '    if (this.r) return 1;',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(ts.map((s) => [s.name, s.kind, s.line, s.container])).toEqual([
      ['Shape', 'interface', 1, null],
      ['Id', 'type', 2, null],
      ['Color', 'enum', 3, null],
      ['load', 'function', 4, null],
      ['add', 'function', 6, null],
      ['LIMIT', 'variable', 7, null],
      ['Circle', 'class', 8, null],
      ['constructor', 'constructor', 9, 'Circle'],
      ['area', 'method', 10, 'Circle'],
    ]);
    const py = extractSymbols(
      'm.py',
      'class Repo:\n    def get(self):\n        pass\n\ndef main():\n    pass\n',
    );
    expect(py.map((s) => [s.name, s.kind, s.container])).toEqual([
      ['Repo', 'class', null],
      ['get', 'method', 'Repo'],
      ['main', 'function', null],
    ]);
    const go = extractSymbols(
      'm.go',
      'type Server struct {\n}\nfunc (s *Server) Start() error {\n}\nfunc New() *Server {\n}\ntype Handler interface {}\n',
    );
    expect(go.map((s) => [s.name, s.kind, s.container])).toEqual([
      ['Server', 'struct', null],
      ['Start', 'method', 'Server'],
      ['New', 'function', null],
      ['Handler', 'interface', null],
    ]);
    const rs = extractSymbols(
      'lib.rs',
      'pub struct Point { x: i32 }\nimpl Point {\n    pub fn norm(&self) -> i32 { 0 }\n}\npub fn main() {}\npub trait Draw {}\nmacro_rules! m { () => {} }\n',
    );
    expect(rs.map((s) => [s.name, s.kind, s.container])).toEqual([
      ['Point', 'struct', null],
      ['norm', 'method', 'Point'],
      ['main', 'function', null],
      ['Draw', 'trait', null],
      ['m', 'macro', null],
    ]);
    const java = extractSymbols(
      'A.java',
      'public class Account {\n  public Account() {}\n  public int balance(int x) {\n    if (x > 0) {\n    }\n  }\n}\n',
    );
    expect(java.map((s) => [s.name, s.kind, s.container])).toEqual([
      ['Account', 'class', null],
      ['Account', 'constructor', 'Account'],
      ['balance', 'method', 'Account'],
    ]);
    const c = extractSymbols(
      'x.cpp',
      '#define MAX 3\nstruct Node {\n};\nint add(int a, int b) {\n}\nvoid Tree::insert(int v) {\n}\nint decl(int a);\n',
    );
    expect(c.map((s) => [s.name, s.kind, s.container])).toEqual([
      ['MAX', 'macro', null],
      ['Node', 'struct', null],
      ['add', 'function', null],
      ['insert', 'method', 'Tree'],
    ]);
    expect(extractSymbols('README.md', '# function nope()')).toEqual([]);
  });

  it('indexes incrementally and searches exact, prefix and substring matches', async () => {
    env = await makeCodeEnv();
    const root = env.repo;
    writeFileSync(
      join(root, 'a.ts'),
      'export function parseConfig() {}\nexport function parse() {}\n',
    );
    writeFileSync(join(root, 'b.py'), 'def reparse():\n    pass\n');
    writeFileSync(join(root, 'big.ts'), `export function huge() {}\n${'x'.repeat(2000)}`);
    const index = new SymbolIndex({ maxFileBytes: 1000 });
    await index.update(root, ['a.ts', 'b.py', 'big.ts', 'gone.ts', 'notes.txt']);
    expect(index.size).toBe(2);
    expect(index.search('parse').map((s) => s.name)).toEqual(['parse', 'parseConfig', 'reparse']);
    expect(index.search('PARSECONFIG').map((s) => s.name)).toEqual(['parseConfig']);
    expect(index.search('', 2)).toHaveLength(2);
    writeFileSync(join(root, 'a.ts'), 'export function renamed() {}\n');
    await index.update(root, ['a.ts']);
    expect(index.size).toBe(1);
    expect(index.search('renamed')).toHaveLength(1);
    const refs = await findCodeRefs(root, ['a.ts', 'b.py', 'big.ts'], 'renamed');
    expect(refs).toEqual([{ path: 'a.ts', line: 1, text: 'export function renamed() {}' }]);
    expect(await findCodeRefs(root, ['a.ts'], 'not an identifier')).toEqual([]);
  });

  it('serves symbols and refs of a session folder, honouring .gitignore', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    mkdirSync(join(env.repo, 'dist'));
    writeFileSync(join(env.repo, 'dist', 'bundle.ts'), 'export function v1Bundled() {}\n');
    writeFileSync(join(env.repo, 'use.ts'), "import { v1 } from './app.ts';\nconsole.log(v1);\n");
    const hits = await env.svc.symbols(ACCOUNT, s.id, 'v1');
    expect(hits[0]).toMatchObject({ name: 'v1', path: 'app.ts', line: 1, kind: 'variable' });
    expect(hits.some((h) => h.path.startsWith('dist/'))).toBe(false);
    const refs = await env.svc.refs(ACCOUNT, s.id, 'v1');
    expect(refs.map((r) => `${r.path}:${r.line}`)).toEqual(['app.ts:1', 'use.ts:1', 'use.ts:2']);
  });

  it('gives the API paths relative to the repository root for a session in a subfolder', async () => {
    env = await makeCodeEnv();
    mkdirSync(join(env.repo, 'pkg'));
    writeFileSync(join(env.repo, 'pkg', 'lib.ts'), 'export function inner() {}\ninner();\n');
    const s = await env.svc.create(ACCOUNT, { folder: join(env.repo, 'pkg') });
    expect(s.repo).toMatchObject({ root: env.repo, defaultBranch: 'main' });
    expect((await env.svc.symbols(ACCOUNT, s.id, 'inner'))[0]!.path).toBe('lib.ts');
    expect((await env.svc.symbols(ACCOUNT, s.id, 'inner', 10, 'repo'))[0]!.path).toBe('pkg/lib.ts');
    expect((await env.svc.refs(ACCOUNT, s.id, 'inner', 10, 'repo')).map((r) => r.path)).toEqual([
      'pkg/lib.ts',
      'pkg/lib.ts',
    ]);
  });
});

class RecordingSandbox implements SandboxClient {
  readonly substrate = 'container' as const;
  readonly reqs: ExecRequest[] = [];
  result: ExecResult = { status: 'exited', exitCode: 0, output: 'all 3 tests passed' };
  ok = true;
  writes: unknown[] = [];
  available() {
    return Promise.resolve({ ok: this.ok, detail: this.ok ? 'ok' : 'no sandbox' });
  }
  exec(req: ExecRequest) {
    this.reqs.push(req);
    return Promise.resolve(this.result);
  }
  poll(): Promise<ExecResult> {
    return Promise.reject(new Error('unused'));
  }
  write(_id: string, input: unknown) {
    this.writes.push(input);
    return Promise.resolve();
  }
  killTurn() {
    return Promise.resolve();
  }
}

describe('coding tools (docs/10 §4)', () => {
  async function tools(e: CodeEnv) {
    const list = (await codeToolSource(e.svc).list(ACCOUNT)) as BuiltinTool[];
    return new Map(list.map((t) => [t.descriptor.name, t]));
  }
  function ctx(
    threadId: string,
    sandbox: SandboxClient,
    roots: ToolContext['roots'] = [],
  ): ToolContext {
    return {
      accountId: ACCOUNT,
      threadId,
      turnId: 'turn1',
      callId: 'call1',
      projectId: null,
      origin: 'model',
      profile: { id: 'workspace', hash: 'h' },
      roots,
      sandbox,
      signal: new AbortController().signal,
      log: new Logger({ module: 'test', sinks: [] }),
    };
  }
  const text = (r: ToolResult) =>
    r.ok
      ? r.content.map((c) => ('text' in c ? c.text : '')).join('')
      : `ERR ${r.error.code}: ${r.error.message}`;

  it('describes read-only Git tools and a test runner that executes', async () => {
    env = await makeCodeEnv();
    const t = await tools(env);
    expect([...t.keys()]).toEqual([
      'git.status',
      'git.diff',
      'git.log',
      'test.run',
      'code.symbols',
      'code.refs',
    ]);
    expect(t.get('git.diff')!.descriptor).toMatchObject({
      source: 'builtin',
      annotations: { readOnly: true },
    });
    expect(t.get('test.run')!.descriptor).toMatchObject({
      annotations: { action: 'execute' },
      effects: ['exec'],
    });
    expect(t.get('git.status')!.origin).toBe('file');
    expect(t.get('test.run')!.origin).toBe('tool');
    // A turn's listing offers them to code threads only.
    const source = codeToolSource(env.svc);
    expect(await source.list(ACCOUNT, { threadId: 't', mode: 'chat' })).toEqual([]);
    expect(await source.list(ACCOUNT, { threadId: 't', mode: 'code' })).toHaveLength(6);
  });

  it('runs git.status, git.diff and git.log in the session folder, and nowhere else', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    const t = await tools(env);
    const sb = new RecordingSandbox();
    writeFileSync(join(env.repo, 'app.ts'), 'export const v1 = 100;\n');
    expect(text(await t.get('git.status')!.handler({}, ctx(s.threadId, sb)))).toContain(
      ' M app.ts',
    );
    const diff = text(await t.get('git.diff')!.handler({ path: 'app.ts' }, ctx(s.threadId, sb)));
    expect(diff).toContain('+export const v1 = 100;');
    expect(text(await t.get('git.diff')!.handler({ staged: true }, ctx(s.threadId, sb)))).toBe(
      '(no changes)',
    );
    expect(text(await t.get('git.diff')!.handler({ path: '../x' }, ctx(s.threadId, sb)))).toMatch(
      /^ERR validation/,
    );
    expect(text(await t.get('git.log')!.handler({ limit: 5 }, ctx(s.threadId, sb)))).toContain(
      'init',
    );
    expect(
      text(await t.get('git.log')!.handler({ path: 'app.ts' }, ctx(s.threadId, sb))),
    ).toContain('Test');
    expect(t.get('git.status')!.resource!({}, ctx(s.threadId, sb))).toEqual({
      kind: 'path',
      value: env.repo,
    });
    const chat = await env.threads.create(ACCOUNT, { mode: 'chat' });
    expect(text(await t.get('git.status')!.handler({}, ctx(chat.id, sb)))).toMatch(
      /^ERR not_available/,
    );
    expect(text(await t.get('code.symbols')!.handler({ query: 'x' }, ctx(chat.id, sb)))).toMatch(
      /^ERR not_available/,
    );
    expect(text(await t.get('code.refs')!.handler({ name: 'x' }, ctx(chat.id, sb)))).toMatch(
      /^ERR not_available/,
    );
    expect(text(await t.get('test.run')!.handler({}, ctx(chat.id, sb)))).toMatch(
      /^ERR not_available/,
    );
    expect(t.get('git.status')!.resource!({}, ctx(chat.id, sb))).toBeUndefined();
    expect(
      text(await t.get('code.symbols')!.handler({ query: 'v1' }, ctx(s.threadId, sb))),
    ).toContain('app.ts:1 variable v1');
    expect(text(await t.get('code.symbols')!.handler({ query: 'zzz' }, ctx(s.threadId, sb)))).toBe(
      'No matching definitions.',
    );
    expect(text(await t.get('code.refs')!.handler({ name: 'v1' }, ctx(s.threadId, sb)))).toContain(
      'app.ts:1',
    );
    expect(text(await t.get('code.refs')!.handler({ name: 'zzz' }, ctx(s.threadId, sb)))).toBe(
      'No references found.',
    );
  });

  it('detects the test command and runs it through the sandbox', async () => {
    env = await makeCodeEnv();
    const s = await env.svc.create(ACCOUNT, { folder: env.repo });
    const t = await tools(env);
    const sb = new RecordingSandbox();
    const roots = [{ path: env.repo, access: 'write' as const, label: 'repo' }];
    expect(text(await t.get('test.run')!.handler({}, ctx(s.threadId, sb, roots)))).toMatch(
      /^ERR not_found/,
    );
    writeFileSync(join(env.repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    const out = text(
      await t.get('test.run')!.handler({ pattern: 'src/a.test.ts' }, ctx(s.threadId, sb, roots)),
    );
    expect(out).toContain('npm test -- src/a.test.ts: passed (exit code 0)');
    expect(sb.reqs[0]).toMatchObject({
      cmd: 'npm test -- src/a.test.ts',
      cwd: env.repo,
      roots,
      network: 'off',
      turnId: 'turn1',
    });
    expect(env.events.events.find((e) => e.name === 'code.test.completed')?.payload).toMatchObject({
      sessionId: s.id,
      status: 'passed',
    });
    sb.result = { status: 'exited', exitCode: 1, output: '1 failed' };
    expect(text(await t.get('test.run')!.handler({}, ctx(s.threadId, sb, roots)))).toContain(
      'failed (exit code 1)',
    );
    sb.result = { status: 'running', sessionId: 'x', output: 'slow' };
    expect(text(await t.get('test.run')!.handler({}, ctx(s.threadId, sb, roots)))).toContain(
      'stopped after',
    );
    expect(sb.writes).toEqual([{ signal: 'terminate' }]);
    expect(
      text(
        await t.get('test.run')!.handler({ pattern: 'a; rm -rf /' }, ctx(s.threadId, sb, roots)),
      ),
    ).toMatch(/^ERR validation/);
    sb.ok = false;
    expect(text(await t.get('test.run')!.handler({}, ctx(s.threadId, sb, roots)))).toMatch(
      /^ERR sandbox_unavailable/,
    );
  });

  it('knows each ecosystem’s test command', async () => {
    env = await makeCodeEnv();
    const d = (name: string) => {
      const p = join(env!.dir, name);
      mkdirSync(p);
      return p;
    };
    const pnpm = d('pnpm');
    writeFileSync(join(pnpm, 'package.json'), '{"scripts":{"test":"x"}}');
    writeFileSync(join(pnpm, 'pnpm-lock.yaml'), '');
    expect(await detectTestCommand(pnpm)).toEqual({ cmd: 'pnpm test', runner: 'pnpm' });
    const yarn = d('yarn');
    writeFileSync(join(yarn, 'package.json'), '{"scripts":{"test":"x"}}');
    writeFileSync(join(yarn, 'yarn.lock'), '');
    expect((await detectTestCommand(yarn))?.cmd).toBe('yarn test');
    const go = d('go');
    writeFileSync(join(go, 'go.mod'), 'module x');
    expect((await detectTestCommand(go))?.cmd).toBe('go test ./...');
    const rs = d('rs');
    writeFileSync(join(rs, 'Cargo.toml'), '');
    expect((await detectTestCommand(rs))?.cmd).toBe('cargo test');
    const py = d('py');
    writeFileSync(join(py, 'pyproject.toml'), '');
    expect((await detectTestCommand(py))?.cmd).toBe('python3 -m pytest');
    const nothing = d('nothing');
    writeFileSync(join(nothing, 'package.json'), 'not json');
    expect(await detectTestCommand(nothing)).toBeNull();
    expect(testCommandWith({ cmd: 'go test ./...', runner: 'go' }, './pkg/...')).toBe(
      'go test ./pkg/...',
    );
    expect(testCommandWith({ cmd: 'cargo test', runner: 'cargo' }, 'parse')).toBe(
      'cargo test parse',
    );
    expect(testCommandWith({ cmd: 'npm test', runner: 'npm' }, undefined)).toBe('npm test');
  });
});

describe('review replies (FR-069)', () => {
  it('accepts a bare or fenced array and rejects anything else', () => {
    expect(parseReviewFindings('[]')).toEqual([]);
    const f = parseReviewFindings(
      'Here you go:\n[{"path":"b/src/a.ts","line":3,"severity":"error","title":"Bug","reasoning":"r"}]',
    );
    expect(f[0]).toMatchObject({ path: 'src/a.ts', line: 3, severity: 'error', fix: null });
    expect(() => parseReviewFindings('nope')).toThrow(/JSON array/);
    expect(() => parseReviewFindings('[{"path":"a","severity":"fatal","title":"x"}]')).toThrow(
      /schema/,
    );
    expect(codeReviewPrompt('x</diff>y')).toContain('x<\\/diff>y');
    expect(codeReviewPrompt('a'.repeat(130_000))).toContain('[diff truncated]');
  });
});

describe('diff parsing', () => {
  it('keeps raw hunks, missing final newlines and quoted paths', () => {
    const raw = parseRawDiff(
      ':100644 100644 aaa bbb M\0café x.txt\0:000000 160000 000 ccc A\0sub\0',
    );
    expect(raw.map((r) => [r.path, r.status, r.newMode])).toEqual([
      ['café x.txt', 'M', '100644'],
      ['sub', 'A', '160000'],
    ]);
    const section =
      'diff --git a/x b/x\nindex aaa..bbb 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n';
    const f = parseDiffSection(raw[0]!, section);
    expect(f.header).not.toContain('index ');
    expect(f.hunks[0]!.raw).toContain('\\ No newline at end of file');
    expect(f.hunks[0]!.lines.map((l) => l.kind)).toEqual(['del', 'add']);
    expect(f).toMatchObject({ additions: 1, deletions: 1 });
    expect(unquoteGitPath('"a/caf\\303\\251\\tx"')).toBe('a/café\tx');
    expect(unquoteGitPath('plain')).toBe('plain');
    const added = diffAddedLines(
      'diff --git a/n b/n\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+a\n+b\ndiff --git a/m b/m\n--- a/m\n+++ b/m\n@@ -3,0 +4 @@\n+c\n',
    );
    expect([...added.entries()].map(([k, v]) => [k, [...v]])).toEqual([
      ['n', [1, 2]],
      ['m', [4]],
    ]);
  });
});
