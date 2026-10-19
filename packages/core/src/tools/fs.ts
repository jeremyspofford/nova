// File tools (docs/08 §1.1): fs.read, fs.list, fs.search, fs.write, fs.edit, fs.delete. Every
// path resolves inside the turn's roots (roots.ts); results are capped and, being file content,
// carry the `file` taint into the context (FR-189).
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  argsOf,
  builtinDescriptor,
  extrasOf,
  fail,
  num,
  ok,
  str,
  type BuiltinTool,
} from './builtin.ts';
import {
  remoteDelete,
  remoteEdit,
  remoteFilesFor,
  remoteList,
  remoteRead,
  remoteResource,
  remoteUnavailable,
  remoteWrite,
} from './fs-remote.ts';
import { PatchError, applyPatch, parsePatch } from './patch.ts';
import {
  PathDenied,
  displayPath,
  hiddenFromTools,
  isCredentialRel,
  isProtectedRel,
  resolveInRoots,
  type PathPolicy,
  type ResolvedPath,
} from './roots.ts';
import { CHARS_PER_TOKEN, DEFAULT_OUTPUT_TOKENS, clip, sha256 } from './text.ts';
import type { GateRequest, ToolContext, ToolResult, ToolRoot } from './types.ts';

/** Largest file fs.read opens; larger files are read from the start and marked truncated. */
export const MAX_READ_BYTES = 1024 * 1024;
/** Characters of file text returned to the model per read. */
export const MAX_READ_CHARS = DEFAULT_OUTPUT_TOKENS * CHARS_PER_TOKEN;
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__']);
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SEARCH_MAX_FILES = 20_000;
const SEARCH_BUDGET_MS = 10_000;
/** A repeated group containing a quantifier or an alternation: `(a+)+`, `(\w*)*`, `(a|aa)+`. */
const NESTED_REPEAT = /\([^)]*[+*}|][^)]*\)\s*[+*{]/;

export interface FsToolOptions {
  /** Directories no tool may touch even inside a root (the Nova data folder). */
  paths?: PathPolicy;
}

export function fsTools(opts: FsToolOptions = {}): BuiltinTool[] {
  const base = opts.paths ?? {};
  const resolve = (ctx: ToolContext, p: string, need: 'read' | 'write') =>
    resolveInRoots(ctx.roots, p, need, withDeny(base, ctx));
  // M7: a thread whose folder is on another machine (an SSH, WSL or device session) acts there,
  // through its transport, never on the Hub's disk at the same path (fs-remote.ts).
  const remoteOf = (ctx: ToolContext) => remoteFilesFor(ctx.sandbox, ctx.accountId, ctx.threadId);
  const pathResource =
    (key: string, need: 'read' | 'write') =>
    (args: unknown, ctx: ToolContext): GateRequest['resource'] => {
      const p = str(argsOf(args)[key]) ?? '.';
      const remote = remoteOf(ctx);
      if (remote) return remoteResource(remote, p, need);
      try {
        return { kind: 'path', value: resolve(ctx, p, need).path };
      } catch {
        return { kind: 'path', value: p };
      }
    };

  return [
    {
      descriptor: builtinDescriptor({
        name: 'fs.read',
        title: 'Read a file',
        description:
          'Read a text file. Paths are relative to the workspace folder unless absolute. Use startLine/endLine (1-based) for part of a large file.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 4096 },
            startLine: { type: 'integer', minimum: 1 },
            endLine: { type: 'integer', minimum: 1 },
          },
          required: ['path'],
          additionalProperties: false,
        },
        annotations: { readOnly: true, idempotent: true, action: 'read' },
        timeoutMs: 30_000,
      }),
      origin: 'file',
      resource: pathResource('path', 'read'),
      handler: (args, ctx) => {
        const remote = remoteOf(ctx);
        if (remote === null) return Promise.resolve(remoteUnavailable());
        const a = argsOf(args);
        if (remote)
          return remoteRead(
            remote,
            { path: str(a.path) ?? '', startLine: num(a.startLine), endLine: num(a.endLine) },
            { maxBytes: MAX_READ_BYTES, maxChars: MAX_READ_CHARS },
          );
        return guard(() => {
          const p = resolve(ctx, str(a.path) ?? '', 'read');
          return readText(ctx.roots, p, num(a.startLine), num(a.endLine));
        });
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'fs.list',
        title: 'List a folder',
        description:
          'List the files and folders in a folder (default: the workspace folder), up to 3 levels deep.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', maxLength: 4096 },
            depth: { type: 'integer', minimum: 1, maximum: 3 },
          },
          additionalProperties: false,
        },
        annotations: { readOnly: true, idempotent: true, action: 'read' },
        timeoutMs: 30_000,
      }),
      origin: 'file',
      resource: pathResource('path', 'read'),
      handler: (args, ctx) => {
        const remote = remoteOf(ctx);
        if (remote === null) return Promise.resolve(remoteUnavailable());
        const a = argsOf(args);
        if (remote)
          return remoteList(
            remote,
            { path: str(a.path) ?? '.', depth: Math.min(Math.max(num(a.depth) ?? 1, 1), 3) },
            MAX_LIST_ENTRIES,
          );
        return guard(() => {
          const p = resolve(ctx, str(a.path) ?? '.', 'read');
          return listFolder(ctx.roots, p, num(a.depth) ?? 1);
        });
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'fs.search',
        title: 'Search files',
        description:
          'Search file contents for text (or a regular expression with regex: true) under a folder, by default every allowed folder. Returns matching lines as path:line: text.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 500 },
            path: { type: 'string', maxLength: 4096 },
            regex: { type: 'boolean' },
            caseSensitive: { type: 'boolean' },
            glob: { type: 'string', maxLength: 200 },
            maxResults: { type: 'integer', minimum: 1, maximum: 200 },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: { readOnly: true, idempotent: true, action: 'read' },
        timeoutMs: 30_000,
      }),
      origin: 'file',
      resource: pathResource('path', 'read'),
      handler: (args, ctx) => {
        // Not routed to another machine: the gate hides it there; exec.run with grep searches.
        if (remoteOf(ctx) !== undefined)
          return Promise.resolve(
            fail(
              'not_available',
              'fs.search does not reach a session folder on another machine; use exec.run with grep',
            ),
          );
        return guard(() => {
          const a = argsOf(args);
          const start = str(a.path);
          const bases = start
            ? [resolve(ctx, start, 'read')]
            : ctx.roots.map((r) => resolve(ctx, r.path, 'read'));
          return searchFiles(ctx, bases, withDeny(base, ctx), {
            query: str(a.query) ?? '',
            regex: a.regex === true,
            caseSensitive: a.caseSensitive === true,
            glob: str(a.glob) ?? null,
            max: num(a.maxResults) ?? 50,
          });
        });
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'fs.write',
        title: 'Write a file',
        description:
          'Create a file or replace its contents. Parent folders are created. Prefer fs.edit to change part of an existing file.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 4096 },
            content: { type: 'string', maxLength: MAX_WRITE_BYTES },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
        annotations: { destructive: true, action: 'write' },
        effects: ['file_write'],
        timeoutMs: 30_000,
      }),
      origin: 'tool',
      resource: pathResource('path', 'write'),
      handler: (args, ctx) => {
        const remote = remoteOf(ctx);
        if (remote === null) return Promise.resolve(remoteUnavailable());
        if (remote) {
          const a = argsOf(args);
          return remoteWrite(
            remote,
            { path: str(a.path) ?? '', content: str(a.content) ?? '' },
            MAX_WRITE_BYTES,
          );
        }
        return guard(() => {
          const a = argsOf(args);
          const content = str(a.content) ?? '';
          if (Buffer.byteLength(content) > MAX_WRITE_BYTES)
            return fail('too_large', 'the content is larger than 5 MiB');
          const p = resolve(ctx, str(a.path) ?? '', 'write');
          if (!p.rel) return fail('invalid_path', 'a folder root cannot be written as a file');
          const existed = existsSync(p.path);
          if (existed && statSync(p.path).isDirectory())
            return fail('is_directory', `${displayPath(ctx.roots, p)} is a folder`);
          const before = existed ? sha256(readFileSync(p.path)) : null;
          mkdirSync(dirname(p.path), { recursive: true });
          const tmp = `${p.path}.nova-${randomBytes(4).toString('hex')}.tmp`;
          writeFileSync(tmp, content);
          renameSync(tmp, p.path);
          const bytes = Buffer.byteLength(content);
          const shown = displayPath(ctx.roots, p);
          return ok(`${existed ? 'Replaced' : 'Created'} ${shown} (${bytes} bytes).`, {
            path: shown,
            bytes,
            created: !existed,
            sha256Before: before,
            sha256After: sha256(content),
          });
        });
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'fs.edit',
        title: 'Edit files with a patch',
        description: [
          'Apply a patch in the Nova patch format. It starts with "%%% patch" and ends with "%%% end".',
          'Sections: "%%% add <path>" then every line prefixed with "+"; "%%% delete <path>";',
          '"%%% update <path>" (optionally followed by "%%% move-to <path>") then hunks.',
          'A hunk starts with "@@" plus an optional anchor line that precedes the change; its lines',
          'start with " " (unchanged context), "-" (removed) or "+" (added). Include enough context',
          'to match one place. The whole patch applies or nothing does. A unified diff also works.',
        ].join(' '),
        inputSchema: {
          type: 'object',
          properties: { patch: { type: 'string', minLength: 1, maxLength: 1024 * 1024 } },
          required: ['patch'],
          additionalProperties: false,
        },
        annotations: { destructive: true, action: 'write' },
        effects: ['file_write'],
        timeoutMs: 30_000,
      }),
      origin: 'tool',
      resource: (args, ctx) => {
        try {
          const first = parsePatch(str(argsOf(args).patch) ?? '')[0];
          if (!first) return undefined;
          const remote = remoteOf(ctx);
          if (remote) return remoteResource(remote, first.path, 'write');
          return { kind: 'path', value: resolve(ctx, first.path, 'write').path };
        } catch {
          return undefined;
        }
      },
      handler: (args, ctx) => {
        const remote = remoteOf(ctx);
        if (remote === null) return Promise.resolve(remoteUnavailable());
        if (remote) return remoteEdit(remote, str(argsOf(args).patch) ?? '', MAX_WRITE_BYTES);
        return guard(() => {
          try {
            const sections = parsePatch(str(argsOf(args).patch) ?? '');
            const files = applyPatch(sections, (p) => resolve(ctx, p, 'write').path);
            const lines = files.map((f) => {
              const counts = `+${f.added} -${f.removed}`;
              if (f.op === 'add') return `added ${f.path} (${counts})`;
              if (f.op === 'delete') return `deleted ${f.path}`;
              if (f.op === 'move') return `moved ${f.path} to ${f.movedTo ?? ''} (${counts})`;
              return `updated ${f.path} (${counts})`;
            });
            return ok(`Applied the patch: ${lines.join('; ')}.`, { files });
          } catch (err) {
            if (err instanceof PatchError) return fail(err.code, err.message, err.details);
            throw err;
          }
        });
      },
    },
    {
      descriptor: builtinDescriptor({
        name: 'fs.delete',
        title: 'Delete a file or folder',
        description:
          'Delete a file, or a folder with recursive: true. Allowed folders themselves cannot be deleted.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 4096 },
            recursive: { type: 'boolean' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        annotations: { destructive: true, action: 'delete' },
        effects: ['data_delete'],
        timeoutMs: 30_000,
      }),
      origin: 'tool',
      resource: pathResource('path', 'write'),
      handler: (args, ctx) => {
        const remote = remoteOf(ctx);
        if (remote === null) return Promise.resolve(remoteUnavailable());
        const a = argsOf(args);
        if (remote)
          return remoteDelete(remote, { path: str(a.path) ?? '', recursive: a.recursive === true });
        return guard(() => {
          const p = resolve(ctx, str(a.path) ?? '', 'write');
          const shown = displayPath(ctx.roots, p);
          if (!p.rel) return fail('invalid_path', 'an allowed folder itself cannot be deleted');
          if (!existsSync(p.path)) return fail('not_found', `${shown} does not exist`);
          const st = lstatSync(p.path);
          if (st.isDirectory()) {
            if (a.recursive !== true)
              return fail('is_directory', `${shown} is a folder; pass recursive: true`);
            // Deleting an ancestor of a protected path would swap it out (docs/12 §7.2).
            if (containsProtected(p.path))
              return fail('path_denied', `${shown} contains protected files (.git, .nova, ...)`);
          }
          rmSync(p.path, { recursive: st.isDirectory(), force: true });
          return ok(`Deleted ${shown}.`, { path: shown, folder: st.isDirectory() });
        });
      },
    },
  ];
}

/** The static path policy plus what the turn's profile denies (FR-190). */
export function withDeny(policy: PathPolicy, ctx: ToolContext): PathPolicy {
  const deny = extrasOf(ctx)?.deny ?? [];
  if (!deny.length) return policy;
  return { ...policy, deny: [...(policy.deny ?? []), ...deny] };
}

/** Run a handler, turning path refusals and filesystem errors into tool errors. */
function guard(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return Promise.resolve(fn()).catch(toFailure);
  } catch (err) {
    return Promise.resolve(toFailure(err));
  }
}

function toFailure(err: unknown): ToolResult {
  if (err instanceof PathDenied) return fail('path_denied', err.message);
  const code = (err as { code?: unknown }).code;
  if (code === 'ENOENT') return fail('not_found', 'no such file or folder');
  if (code === 'EACCES' || code === 'EPERM') return fail('permission_denied', 'permission denied');
  if (code === 'ENOTDIR') return fail('not_a_folder', 'a path component is not a folder');
  if (code === 'EISDIR') return fail('is_directory', 'the path is a folder');
  throw err;
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

function readText(
  roots: readonly ToolRoot[],
  p: ResolvedPath,
  startLine: number | undefined,
  endLine: number | undefined,
): ToolResult {
  const shown = displayPath(roots, p);
  const st = statSync(p.path);
  if (st.isDirectory()) return fail('is_directory', `${shown} is a folder; use fs.list`);
  const size = st.size;
  const fd = openSync(p.path, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.alloc(Math.min(size, MAX_READ_BYTES));
    const n = readSync(fd, buf, 0, buf.length, 0);
    buf = buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
  if (isBinary(buf)) return fail('binary', `${shown} is a binary file`);
  let text = buf.toString('utf8');
  const all = text.split(/\r?\n/);
  const total = all.length;
  let notes: string[] = [];
  if (startLine !== undefined || endLine !== undefined) {
    const from = Math.max(1, startLine ?? 1);
    const to = Math.min(total, endLine ?? total);
    text = all.slice(from - 1, to).join('\n');
    notes.push(`lines ${from}-${to} of ${total}`);
  }
  let truncated = size > buf.length;
  if (text.length > MAX_READ_CHARS) {
    text = text.slice(0, MAX_READ_CHARS);
    truncated = true;
  }
  if (truncated) notes = [...notes, 'truncated; read later parts with startLine'];
  const header = notes.length ? `[${shown}: ${notes.join('; ')}]\n` : '';
  return ok(header + text, {
    path: shown,
    size,
    sha256: size <= MAX_READ_BYTES ? sha256(buf) : null,
    truncated,
  });
}

function listFolder(roots: readonly ToolRoot[], p: ResolvedPath, depth: number): ToolResult {
  const shown = displayPath(roots, p);
  if (!statSync(p.path).isDirectory()) return fail('not_a_folder', `${shown} is not a folder`);
  const out: string[] = [];
  let more = false;
  const walk = (abs: string, rel: string[], level: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) =>
      a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
    );
    for (const e of entries) {
      const parts = [...p.rel.split('/').filter(Boolean), ...rel, e.name];
      if (hiddenFromTools(parts)) continue;
      if (out.length >= MAX_LIST_ENTRIES) {
        more = true;
        return;
      }
      const indent = '  '.repeat(level - 1);
      const full = join(abs, e.name);
      if (e.isDirectory()) {
        out.push(`${indent}${e.name}/`);
        if (level < depth && !SEARCH_SKIP_DIRS.has(e.name)) walk(full, [...rel, e.name], level + 1);
      } else if (e.isSymbolicLink()) {
        out.push(`${indent}${e.name} -> (link)`);
      } else {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          // vanished while listing
        }
        out.push(`${indent}${e.name} (${size} bytes)`);
      }
    }
  };
  walk(p.path, [], 1);
  if (more) out.push(`[... more than ${MAX_LIST_ENTRIES} entries; list a subfolder]`);
  return ok(out.length ? `${shown}/\n${out.join('\n')}` : `${shown}/ is empty`, {
    path: shown,
    entries: out.length,
  });
}

interface SearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  glob: string | null;
  max: number;
}

function searchFiles(
  ctx: ToolContext,
  bases: ResolvedPath[],
  policy: PathPolicy,
  o: SearchOptions,
): ToolResult {
  let test: (line: string) => boolean;
  if (o.regex) {
    // Matching runs on the Hub's event loop and cannot be interrupted, so patterns that can
    // backtrack exponentially (a repeated group that itself repeats) are refused.
    if (NESTED_REPEAT.test(o.query) || /\\[1-9]/.test(o.query))
      return fail(
        'invalid_regex',
        'nested repetition and backreferences are not supported; simplify the pattern',
      );
    let re: RegExp;
    try {
      re = new RegExp(o.query, o.caseSensitive ? 'u' : 'iu');
    } catch (err) {
      return fail(
        'invalid_regex',
        err instanceof Error ? err.message : 'invalid regular expression',
      );
    }
    test = (l) => re.test(l.slice(0, 500));
  } else {
    const q = o.caseSensitive ? o.query : o.query.toLowerCase();
    test = (l) => (o.caseSensitive ? l : l.toLowerCase()).includes(q);
  }
  const globRe = o.glob ? globToRegExp(o.glob) : null;
  const hits: string[] = [];
  const started = Date.now();
  let files = 0;
  let stopped = null as string | null;
  const seen = new Set<string>();

  const visit = (abs: string, base: ResolvedPath, rel: string) => {
    if (stopped || hits.length >= o.max) return;
    if (Date.now() - started > SEARCH_BUDGET_MS) {
      stopped = 'time limit reached';
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (stopped || hits.length >= o.max) return;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const parts = [...base.rel.split('/').filter(Boolean), ...relPath.split('/')];
      if (hiddenFromTools(parts)) continue;
      const full = join(abs, e.name);
      if (e.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(e.name)) visit(full, base, relPath);
        continue;
      }
      if (!e.isFile()) continue;
      if (globRe && !globRe.test(relPath) && !globRe.test(e.name)) continue;
      if (++files > SEARCH_MAX_FILES) {
        stopped = 'file limit reached';
        return;
      }
      let resolved: ResolvedPath;
      try {
        resolved = resolveInRoots(ctx.roots, full, 'read', policy);
      } catch {
        continue;
      }
      if (seen.has(resolved.path)) continue;
      seen.add(resolved.path);
      let buf: Buffer;
      try {
        if (statSync(full).size > SEARCH_MAX_FILE_BYTES) continue;
        buf = readFileSync(full);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const shown = displayPath(ctx.roots, resolved);
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < o.max; i++) {
        // Long lines are clipped before matching so a pattern cannot run away on them.
        const line = lines[i]!.slice(0, 2000);
        if (test(line)) hits.push(`${shown}:${i + 1}: ${clip(line.trim(), 300)}`);
      }
    }
  };

  for (const b of bases) {
    if (statSync(b.path).isDirectory()) visit(b.path, b, '');
    else {
      const parent = { ...b, rel: b.rel.split('/').slice(0, -1).join('/') };
      visit(dirname(b.path), parent, '');
    }
  }
  const notes: string[] = [];
  if (hits.length >= o.max) notes.push(`showing the first ${o.max} matches`);
  if (stopped) notes.push(`search stopped early: ${stopped}`);
  const body = hits.length ? hits.join('\n') : 'No matches.';
  return ok(notes.length ? `${body}\n[${notes.join('; ')}]` : body, {
    matches: hits.length,
    files,
  });
}

/** `*` within a segment, `**` across segments, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Whether a folder holds a protected or credential location (docs/12 §7.2). */
function containsProtected(dir: string): boolean {
  let budget = 50_000;
  const walk = (abs: string, rel: string[]): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (--budget < 0) return true;
      const parts = [...rel, e.name];
      if (isProtectedRel(parts) || isCredentialRel(parts)) return true;
      if (e.isDirectory() && walk(join(abs, e.name), parts)) return true;
    }
    return false;
  };
  return walk(dir, []);
}
