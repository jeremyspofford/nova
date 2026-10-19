// File tools for a thread whose folder is on another machine (M7 security fix; docs/10 §2): a
// Code session in an SSH, WSL or device environment. Its folder was checked against that
// machine's rules, not the Hub's, so the Hub's own disk at the same path is never read or
// written: `fs.read`, `fs.list`, `fs.write`, `fs.edit` and `fs.delete` act on the remote folder
// through the session's transport (`RemoteFiles`, which the Code area provides through the
// thread's sandbox), with the same path rules (inside the folder, credential locations never,
// protected paths read-only, links never followed out of it). `fs.search` is not routed: the
// gate hides it there and `exec.run` with grep does the job. A thread on another machine whose
// files cannot be reached now fails closed.
import { posix } from 'node:path';
import { fail, ok } from './builtin.ts';
import { PatchError, parsePatch, planPatch } from './patch.ts';
import { PathDenied, hiddenFromTools, isCredentialRel, isProtectedRel } from './roots.ts';
import { sha256 } from './text.ts';
import type { SandboxClient, ToolResult } from './types.ts';

export interface RemoteFileStat {
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
}

export interface RemoteFileEntry extends RemoteFileStat {
  /** Relative to the listed folder, `/`-separated. */
  rel: string;
}

/**
 * A session's folder on another machine. Paths are relative to `root` and already checked by
 * `resolveRemote`; the implementation still never follows a link out of the folder.
 */
export interface RemoteFiles {
  /** The machine, for messages ("build box (dev@build.example)"). */
  readonly label: string;
  /** The session's folder there (absolute). */
  readonly root: string;
  /** `read` while the session's mode only reads (Plan). */
  readonly access: 'read' | 'write';
  /** What is at the path; a link is reported, never followed. */
  stat(rel: string): Promise<RemoteFileStat | null>;
  /** The first `maxBytes` of a regular file, and its size; refused for a link. */
  read(rel: string, maxBytes: number): Promise<{ data: Buffer; size: number }>;
  /** Entries under a folder up to `depth` levels (sorted folders first), at most `max`. */
  list(rel: string, depth: number, max: number): Promise<RemoteFileEntry[]>;
  write(rel: string, data: Buffer): Promise<void>;
  remove(rel: string, recursive: boolean): Promise<void>;
}

/**
 * Where a thread's files are: undefined for the Hub's own disk, the remote folder for a session on
 * another machine, null when it is on another machine that cannot be reached now (fail closed).
 * The thread's sandbox router knows (`filesFor`).
 */
export function remoteFilesFor(
  sandbox: SandboxClient,
  accountId: string,
  threadId: string,
): RemoteFiles | null | undefined {
  const routed = sandbox as SandboxClient & {
    filesFor?: (accountId: string, threadId: string) => RemoteFiles | null | undefined;
  };
  if (!threadId || typeof routed.filesFor !== 'function') return undefined;
  return routed.filesFor(accountId, threadId);
}

export interface RemotePath {
  /** Absolute on the remote machine. */
  path: string;
  /** Relative to the folder (`''` for the folder itself). */
  rel: string;
}

/**
 * A path inside the remote folder, worked out by name only (the Hub's disk is never consulted):
 * absolute, or relative to the folder; never outside it, never a credential location; writes
 * never touch protected paths (.git, .nova, .agents) and need a writable folder.
 */
export function resolveRemote(
  files: RemoteFiles,
  input: string,
  need: 'read' | 'write',
): RemotePath {
  if (typeof input !== 'string' || input.length > 4096 || input.includes('\0'))
    throw new PathDenied(String(input), 'invalid path');
  const raw = input.trim() === '' ? '.' : input.trim();
  const root = posix.normalize(files.root).replace(/\/+$/, '') || '/';
  const abs = posix
    .normalize(raw.startsWith('/') ? raw : posix.join(root, raw))
    .replace(/\/+$/, '');
  if (abs !== root && !abs.startsWith(`${root}/`))
    throw new PathDenied(input, `outside the session folder on ${files.label}`);
  const rel = abs === root ? '' : abs.slice(root.length + 1);
  const parts = rel ? rel.split('/') : [];
  if (parts.includes('..')) throw new PathDenied(input, 'outside the session folder');
  if (isCredentialRel(parts) || isCredentialRel(abs.split('/').filter(Boolean)))
    throw new PathDenied(input, 'credential files are not available');
  if (need === 'write') {
    if (files.access !== 'write')
      throw new PathDenied(input, 'the session folder is read-only for tools in this mode');
    if (isProtectedRel(parts)) throw new PathDenied(input, 'protected path (read-only)');
  }
  return { path: abs || '/', rel };
}

/** What a remote thread's file tool reports for the gate (the path on that machine). */
export function remoteResource(
  files: RemoteFiles,
  input: string,
  need: 'read' | 'write',
): { kind: 'path'; value: string } {
  try {
    return { kind: 'path', value: resolveRemote(files, input, need).path };
  } catch {
    return { kind: 'path', value: input };
  }
}

/** The tool result for a thread on another machine that cannot be reached now. */
export function remoteUnavailable(): ToolResult {
  return fail(
    'remote_unavailable',
    "this session's folder is on another machine that cannot be reached now; nothing was read or written on the Hub",
  );
}

const shown = (p: RemotePath) => p.rel || '.';

async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PathDenied) return fail('path_denied', err.message);
    if (err instanceof PatchError) return fail(err.code, err.message, err.details);
    const e = err as { code?: unknown; message?: unknown };
    if (e.code === 'not_found') return fail('not_found', 'no such file or folder');
    if (e.code === 'policy_denied') return fail('path_denied', String(e.message));
    return fail('remote_failed', err instanceof Error ? err.message : String(err));
  }
}

/** `fs.read` on the remote folder (the same output as on the Hub). */
export function remoteRead(
  files: RemoteFiles,
  a: { path: string; startLine?: number | undefined; endLine?: number | undefined },
  limits: { maxBytes: number; maxChars: number },
): Promise<ToolResult> {
  return guard(async () => {
    const p = resolveRemote(files, a.path, 'read');
    const st = await files.stat(p.rel);
    if (!st) return fail('not_found', `${shown(p)} does not exist`);
    if (st.kind === 'dir') return fail('is_directory', `${shown(p)} is a folder; use fs.list`);
    if (st.kind !== 'file') return fail('path_denied', `${shown(p)} is not a regular file`);
    const { data, size } = await files.read(p.rel, limits.maxBytes);
    if (data.subarray(0, 8192).includes(0)) return fail('binary', `${shown(p)} is a binary file`);
    let text = data.toString('utf8');
    const all = text.split(/\r?\n/);
    const total = all.length;
    let notes: string[] = [];
    if (a.startLine !== undefined || a.endLine !== undefined) {
      const from = Math.max(1, a.startLine ?? 1);
      const to = Math.min(total, a.endLine ?? total);
      text = all.slice(from - 1, to).join('\n');
      notes.push(`lines ${from}-${to} of ${total}`);
    }
    let truncated = size > data.length;
    if (text.length > limits.maxChars) {
      text = text.slice(0, limits.maxChars);
      truncated = true;
    }
    if (truncated) notes = [...notes, 'truncated; read later parts with startLine'];
    const header = notes.length ? `[${shown(p)}: ${notes.join('; ')}]\n` : '';
    return ok(header + text, {
      path: shown(p),
      size,
      sha256: size <= limits.maxBytes ? sha256(data) : null,
      truncated,
    });
  });
}

/** `fs.list` on the remote folder. */
export function remoteList(
  files: RemoteFiles,
  a: { path: string; depth: number },
  max: number,
): Promise<ToolResult> {
  return guard(async () => {
    const p = resolveRemote(files, a.path, 'read');
    const st = await files.stat(p.rel);
    if (!st) return fail('not_found', `${shown(p)} does not exist`);
    if (st.kind !== 'dir') return fail('not_a_folder', `${shown(p)} is not a folder`);
    const entries = await files.list(p.rel, a.depth, max + 1);
    const out: string[] = [];
    let more = false;
    for (const e of entries) {
      const parts = [...p.rel.split('/').filter(Boolean), ...e.rel.split('/')];
      if (hiddenFromTools(parts)) continue;
      if (out.length >= max) {
        more = true;
        break;
      }
      const segs = e.rel.split('/');
      const indent = '  '.repeat(segs.length - 1);
      const name = segs.at(-1) ?? e.rel;
      if (e.kind === 'dir') out.push(`${indent}${name}/`);
      else if (e.kind === 'symlink') out.push(`${indent}${name} -> (link)`);
      else out.push(`${indent}${name} (${e.size} bytes)`);
    }
    if (more) out.push(`[... more than ${max} entries; list a subfolder]`);
    return ok(out.length ? `${shown(p)}/\n${out.join('\n')}` : `${shown(p)}/ is empty`, {
      path: shown(p),
      entries: out.length,
    });
  });
}

/** `fs.write` on the remote folder. */
export function remoteWrite(
  files: RemoteFiles,
  a: { path: string; content: string },
  maxBytes: number,
): Promise<ToolResult> {
  return guard(async () => {
    const bytes = Buffer.byteLength(a.content);
    if (bytes > maxBytes) return fail('too_large', 'the content is larger than 5 MiB');
    const p = resolveRemote(files, a.path, 'write');
    if (!p.rel) return fail('invalid_path', 'a folder root cannot be written as a file');
    const st = await files.stat(p.rel);
    if (st?.kind === 'dir') return fail('is_directory', `${shown(p)} is a folder`);
    if (st && st.kind !== 'file') return fail('path_denied', `${shown(p)} is not a regular file`);
    const before = st ? sha256((await files.read(p.rel, maxBytes + 1)).data) : null;
    await files.write(p.rel, Buffer.from(a.content));
    return ok(`${st ? 'Replaced' : 'Created'} ${shown(p)} (${bytes} bytes).`, {
      path: shown(p),
      bytes,
      created: !st,
      sha256Before: before,
      sha256After: sha256(a.content),
    });
  });
}

/** `fs.edit` on the remote folder: the patch is planned in full, then written file by file. */
export function remoteEdit(
  files: RemoteFiles,
  patch: string,
  maxBytes: number,
): Promise<ToolResult> {
  return guard(async () => {
    const sections = parsePatch(patch);
    const relOf = new Map<string, string>();
    const { results, writes } = await planPatch(
      sections,
      (path) => {
        const p = resolveRemote(files, path, 'write');
        if (!p.rel) throw new PathDenied(path, 'a folder root cannot be written as a file');
        relOf.set(p.path, p.rel);
        return p.path;
      },
      {
        exists: async (abs) => (await files.stat(relOf.get(abs) ?? '')) !== null,
        read: async (abs) => {
          const rel = relOf.get(abs) ?? '';
          const st = await files.stat(rel);
          if (st?.kind !== 'file') return null;
          return (await files.read(rel, maxBytes)).data;
        },
      },
    );
    // New content first, removals last (a move writes the new place before the old one goes).
    for (const w of writes)
      if (w.content !== null) await files.write(relOf.get(w.abs) ?? '', Buffer.from(w.content));
    for (const w of writes) {
      if (w.content !== null) continue;
      if (writes.some((x) => x.abs === w.abs && x.content !== null)) continue;
      await files.remove(relOf.get(w.abs) ?? '', false);
    }
    const lines = results.map((f) => {
      const counts = `+${f.added} -${f.removed}`;
      if (f.op === 'add') return `added ${f.path} (${counts})`;
      if (f.op === 'delete') return `deleted ${f.path}`;
      if (f.op === 'move') return `moved ${f.path} to ${f.movedTo ?? ''} (${counts})`;
      return `updated ${f.path} (${counts})`;
    });
    return ok(`Applied the patch: ${lines.join('; ')}.`, { files: results });
  });
}

/** `fs.delete` on the remote folder. */
export function remoteDelete(
  files: RemoteFiles,
  a: { path: string; recursive: boolean },
): Promise<ToolResult> {
  return guard(async () => {
    const p = resolveRemote(files, a.path, 'write');
    if (!p.rel) return fail('invalid_path', 'an allowed folder itself cannot be deleted');
    const st = await files.stat(p.rel);
    if (!st) return fail('not_found', `${shown(p)} does not exist`);
    if (st.kind === 'dir') {
      if (!a.recursive)
        return fail('is_directory', `${shown(p)} is a folder; pass recursive: true`);
      // Deleting an ancestor of a protected path would swap it out (docs/12 §7.2).
      const inside = await files.list(p.rel, 64, 50_001);
      if (
        inside.length > 50_000 ||
        inside.some((e) => {
          const parts = e.rel.split('/');
          return isProtectedRel(parts) || isCredentialRel(parts);
        })
      )
        return fail('path_denied', `${shown(p)} contains protected files (.git, .nova, ...)`);
    }
    await files.remove(p.rel, st.kind === 'dir');
    return ok(`Deleted ${shown(p)}.`, { path: shown(p), folder: st.kind === 'dir' });
  });
}
