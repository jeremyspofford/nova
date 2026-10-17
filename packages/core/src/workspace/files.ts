// The file browser and editor (FR-039). The roots are exactly those the thread's or project's
// tools get, plus the project's folders (FR-035); every path resolves to a real path inside its
// root with the same containment and protected-path checks as the file tools (FR-190, docs/12
// §7.2). Reading never changes anything. Saving passes the policy gate as `fs.write` with origin
// `ui` and the user's own instruction as provenance (FR-189); an `ask` becomes an approval and
// the save completes once it is granted. A save against a stale base hash is a conflict.
import { randomBytes } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { z } from 'zod';
import {
  NovaError,
  uuidv7,
  type FileContentView,
  type FileEntryView,
  type saveFileSchema,
} from '@nova/shared';
import { isWithin, realpathLenient } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { fsTools } from '../tools/fs.ts';
import {
  PathDenied,
  hiddenFromTools,
  isCredentialPath,
  resolveInRoots,
  type PathPolicy,
  type ResolvedPath,
} from '../tools/roots.ts';
import type { ToolRuntimeOptions, ToolScope } from '../tools/runtime.ts';
import type { AuditSink, GateOutcome, GateRequest, ToolGate, ToolRoot } from '../tools/types.ts';
import { sha256 } from '../tools/text.ts';
import { decodeText, mimeOf, sha256File } from './common.ts';

export type SaveFileRequest = z.infer<typeof saveFileSchema>;

/** Text up to this size is returned for editing; larger files are fetched raw (FR-039). */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** Files larger than this are identified by size and modification time instead of a hash. */
export const MAX_HASH_BYTES = 256 * 1024 * 1024;
const MAX_LIST_ENTRIES = 5_000;
const APPROVAL_POLL_MS = 20;

/** The descriptor saves are evaluated as, so user rules about `fs.write` apply to them too. */
const FS_WRITE = fsTools().find((t) => t.descriptor.name === 'fs.write')!.descriptor;

export interface FileRootView {
  path: string;
  label: string;
  access: 'read' | 'write';
}

export type SaveOutcome =
  | { status: 'saved'; file: FileContentView }
  /** The gate asked: the save runs when the approval is granted (`done` rejects if it is not). */
  | { status: 'pending'; approvalId: string; done: Promise<FileContentView> };

export interface FileServiceOptions {
  db: NovaDatabase;
  gate: ToolGate;
  audit: AuditSink;
  /** Roots of a thread or project: the tools' scope, which includes the project's folders. */
  scope: ToolRuntimeOptions['scope'];
  /** The Hub data directory: never readable through the browser, except the workspace. */
  dataDir: string;
  workspaceDir: string;
  log?: Logger;
}

interface Located {
  root: ToolRoot;
  scope: ToolScope;
  projectId: string | null;
}

interface Target {
  path: string;
  rel: string;
}

export class FileService {
  readonly #o: FileServiceOptions;
  readonly #log: Logger;
  readonly #policy: PathPolicy;
  readonly #stop = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(opts: FileServiceOptions) {
    this.#o = opts;
    this.#log = opts.log ?? new Logger({ module: 'core.files', sinks: [] });
    this.#policy = { denied: [opts.dataDir], allowed: [opts.workspaceDir] };
  }

  /** The roots of a thread (its project's when it has one), a project, or the account. */
  async roots(
    accountId: string,
    q: { threadId?: string | null; projectId?: string | null } = {},
  ): Promise<FileRootView[]> {
    let projectId = q.projectId ?? null;
    const threadId = q.threadId ?? null;
    if (threadId) {
      const t = this.#o.db.raw
        .prepare(
          'SELECT project_id AS projectId FROM thread WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
        )
        .get(threadId, accountId) as { projectId: string | null } | undefined;
      if (!t) throw new NovaError('not_found', 'thread not found');
      projectId = t.projectId;
    } else if (projectId) this.#assertProject(accountId, projectId);
    const scope = await this.#o.scope({ accountId, threadId, projectId });
    return scope.roots.map((r) => ({ path: r.path, label: r.label, access: r.access }));
  }

  async list(accountId: string, root: string, path = ''): Promise<FileEntryView[]> {
    const loc = await this.#locate(accountId, root);
    const dir = this.#resolve(loc, path, 'read');
    const st = await fsCall(() => stat(dir.path));
    if (!st.isDirectory()) throw new NovaError('validation', `${dir.rel || '.'} is not a folder`);
    const entries = await fsCall(() => readdir(dir.path, { withFileTypes: true }));
    const data = realpathLenient(this.#o.dataDir);
    const ws = realpathLenient(this.#o.workspaceDir);
    const prefix = dir.rel ? dir.rel.split('/') : [];
    const out: FileEntryView[] = [];
    for (const e of entries) {
      if (out.length >= MAX_LIST_ENTRIES) break;
      const full = join(dir.path, e.name);
      if (hiddenFromTools([...prefix, e.name]) || isCredentialPath(full)) continue;
      let real = full;
      if (e.isSymbolicLink()) {
        // A link is listed only when it points inside the roots, as the tools would allow.
        try {
          real = await realpath(full);
        } catch {
          continue;
        }
        if (!loc.scope.roots.some((r) => isWithin(realpathLenient(r.path), real))) continue;
        if (isCredentialPath(real)) continue;
      }
      if (isWithin(data, real) && !isWithin(ws, real)) continue;
      let info;
      try {
        info = await stat(real);
      } catch {
        continue;
      }
      const kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null;
      if (!kind) continue;
      out.push({
        path: dir.rel ? `${dir.rel}/${e.name}` : e.name,
        name: e.name,
        kind,
        size: kind === 'file' ? info.size : null,
        mime: kind === 'file' ? mimeOf(e.name) : null,
        modifiedAt: info.mtime.toISOString(),
      });
    }
    out.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
    );
    return out;
  }

  /** A file's text (up to 5 MB; null for binaries and larger files) and its hash for saving. */
  async read(accountId: string, root: string, path: string): Promise<FileContentView> {
    const loc = await this.#locate(accountId, root);
    const file = this.#resolve(loc, path, 'read');
    const st = await fsCall(() => stat(file.path));
    if (st.isDirectory()) throw new NovaError('validation', `${file.rel || '.'} is a folder`);
    let text: string | null = null;
    let hash: string;
    if (st.size <= MAX_TEXT_BYTES) {
      const bytes = await fsCall(() => readFile(file.path));
      hash = sha256(bytes);
      text = decodeText(bytes);
    } else hash = await this.#version(file.path, st.size, st.mtimeMs);
    return {
      root: loc.root.path,
      path: file.rel,
      mime: mimeOf(file.path, text !== null),
      size: st.size,
      text,
      sha256: hash,
      readOnly: !this.#writable(loc, file.rel),
    };
  }

  /** Where a file's bytes are, for GET /files/raw. */
  async raw(
    accountId: string,
    root: string,
    path: string,
  ): Promise<{ path: string; name: string; mime: string; size: number }> {
    const loc = await this.#locate(accountId, root);
    const file = this.#resolve(loc, path, 'read');
    const st = await fsCall(() => stat(file.path));
    if (!st.isFile()) throw new NovaError('validation', `${file.rel || '.'} is not a file`);
    const name = file.rel.split('/').at(-1) ?? 'file';
    return { path: file.path, name, mime: mimeOf(name), size: st.size };
  }

  /**
   * Save text through the policy gate. Returns at once with the saved file, or with the approval
   * the gate is waiting on; a stale `baseSha256` is `conflict` (checked again before writing).
   */
  async save(accountId: string, req: SaveFileRequest): Promise<SaveOutcome> {
    const bytes = Buffer.byteLength(req.text);
    if (bytes > MAX_TEXT_BYTES)
      throw new NovaError('validation', 'files larger than 5 MB cannot be saved here', {
        details: { reason: 'size' },
      });
    const loc = await this.#locate(accountId, req.root);
    const file = this.#resolve(loc, req.path, 'write');
    if (!file.rel) throw new NovaError('validation', 'a folder cannot be saved as a file');
    await this.#checkBase(file, req.baseSha256);

    const callId = uuidv7();
    const gateReq: GateRequest = {
      accountId,
      threadId: '',
      turnId: '',
      callId,
      projectId: loc.projectId,
      mode: 'chat',
      tool: FS_WRITE,
      args: { path: file.path, content: req.text },
      argsPreview: `Save ${file.path} (${bytes} bytes) from the file editor`,
      // The signed-in user pressed Save in a Nova client: their own instruction (FR-189).
      provenance: { userInstruction: { messageId: `ui:${callId}`, accountId }, taint: [] },
      resource: { kind: 'path', value: file.path },
      profile: loc.scope.profile,
      origin: 'ui',
      roots: loc.scope.roots,
    };
    const outcome = this.#o.gate.check(gateReq, this.#stop.signal);
    let settled = false;
    void outcome.finally(() => (settled = true)).catch(() => undefined);
    const first = await Promise.race([
      outcome.then((o) => ({ kind: 'outcome' as const, o })),
      this.#approvalOf(callId, () => settled).then((id) => ({ kind: 'approval' as const, id })),
    ]);
    if (first.kind === 'approval' && first.id) {
      const done = outcome.then((o) => this.#afterGate(accountId, loc, file, req, o, first.id));
      this.#track(done);
      done.catch((err: unknown) =>
        this.#log.warn('approved save did not complete', { err, path: file.path }),
      );
      return { status: 'pending', approvalId: first.id, done };
    }
    const o = first.kind === 'outcome' ? first.o : await outcome;
    return { status: 'saved', file: await this.#afterGate(accountId, loc, file, req, o, null) };
  }

  /** Cancel saves waiting for an approval (Hub shutdown). */
  async close(): Promise<void> {
    this.#stop.abort();
    await Promise.allSettled([...this.#pending]);
  }

  // ---- internals ----------------------------------------------------------------------------

  async #afterGate(
    accountId: string,
    loc: Located,
    file: Target,
    req: SaveFileRequest,
    o: GateOutcome,
    approvalId: string | null,
  ): Promise<FileContentView> {
    if (o.effect !== 'allow') {
      const details: Record<string, unknown> = {
        reason: o.effect === 'deny' && o.timeout ? 'timeout' : 'denied',
      };
      if (approvalId) details.approvalId = approvalId;
      throw new NovaError('policy_denied', o.reason || 'saving this file is not allowed', {
        details,
      });
    }
    // The file may have changed while the approval waited.
    await this.#checkBase(file, req.baseSha256);
    let mode: number | null;
    try {
      mode = (await stat(file.path)).mode & 0o7777;
    } catch {
      mode = null;
    }
    await fsCall(() => mkdir(dirname(file.path), { recursive: true }));
    const tmp = `${file.path}.nova-${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, req.text);
      if (mode !== null) await chmod(tmp, mode);
      await rename(tmp, file.path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      return fsFailure(err);
    }
    const hash = sha256(req.text);
    await this.#o.audit.append({
      accountId,
      actor: 'user',
      kind: 'fs',
      action: 'fs.write',
      resource: file.path,
      inputHash: hash,
      decision: 'allow',
      result: 'ok',
      detail: { origin: 'ui', bytes: Buffer.byteLength(req.text), approvalId },
    });
    return {
      root: loc.root.path,
      path: file.rel,
      mime: mimeOf(file.path, true),
      size: Buffer.byteLength(req.text),
      text: req.text,
      sha256: hash,
      readOnly: false,
    };
  }

  /** `conflict` unless the file is still what the editor opened (or still absent). */
  async #checkBase(file: Target, base: string | null): Promise<void> {
    let st;
    try {
      st = await lstat(file.path);
    } catch {
      st = null;
    }
    if (!st) {
      if (base !== null)
        throw new NovaError('conflict', `${file.rel} was deleted since it was opened`, {
          details: { reason: 'deleted', sha256: null },
        });
      return;
    }
    if (st.isDirectory()) throw new NovaError('validation', `${file.rel} is a folder`);
    const current =
      st.size <= MAX_TEXT_BYTES
        ? sha256(await fsCall(() => readFile(file.path)))
        : await this.#version(file.path, st.size, st.mtimeMs);
    if (base === null)
      throw new NovaError('conflict', `${file.rel} already exists`, {
        details: { reason: 'exists', sha256: current },
      });
    if (current !== base)
      throw new NovaError('conflict', `${file.rel} changed since it was opened`, {
        details: { reason: 'changed', sha256: current },
      });
  }

  async #version(path: string, size: number, mtimeMs: number): Promise<string> {
    if (size > MAX_HASH_BYTES) return `stat:${size}:${Math.floor(mtimeMs)}`;
    return fsCall(() => sha256File(path));
  }

  /** The approval the gate created for a call, polled until the gate has decided. */
  async #approvalOf(callId: string, settled: () => boolean): Promise<string | null> {
    const stmt = this.#o.db.raw.prepare(
      'SELECT id FROM approval WHERE tool_call_id = ? ORDER BY rowid DESC LIMIT 1',
    );
    while (!settled()) {
      let row: { id: string } | undefined;
      try {
        row = stmt.get(callId) as { id: string } | undefined;
      } catch {
        return null;
      }
      if (row) return row.id;
      await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS));
    }
    return null;
  }

  #track(p: Promise<unknown>): void {
    this.#pending.add(p);
    void p.catch(() => undefined).finally(() => this.#pending.delete(p));
  }

  /**
   * Which of the account's roots `root` names: one of the account-wide roots, else a project
   * folder (with that project's roots). Anything else is not a root.
   */
  async #locate(accountId: string, root: string): Promise<Located> {
    if (!isAbsolute(root)) throw new NovaError('not_found', 'no such folder');
    const want = realpathLenient(resolve(root));
    const pick = (s: ToolScope) => s.roots.find((r) => realpathLenient(r.path) === want);
    const global = await this.#o.scope({ accountId, threadId: null, projectId: null });
    const hit = pick(global);
    if (hit) return { root: hit, scope: global, projectId: null };
    const projects = this.#o.db.raw
      .prepare(
        `SELECT DISTINCT f.project_id AS projectId FROM project_folder f
         JOIN project p ON p.id = f.project_id
         WHERE p.account_id = ? AND p.deleted_at IS NULL AND f.path = ?`,
      )
      .all(accountId, want) as { projectId: string }[];
    for (const { projectId } of projects) {
      const scope = await this.#o.scope({ accountId, threadId: null, projectId });
      const r = pick(scope);
      if (r) return { root: r, scope, projectId };
    }
    throw new NovaError('not_found', 'no such folder');
  }

  /** Resolve `path` inside the located root, as the file tools would (FR-190). */
  #resolve(loc: Located, path: string, need: 'read' | 'write'): Target {
    const others = loc.scope.roots.filter((r) => r !== loc.root);
    const policy: PathPolicy = { ...this.#policy, deny: loc.scope.deny ?? [] };
    let p: ResolvedPath;
    try {
      p = resolveInRoots([loc.root, ...others], path, need, policy);
      const base = realpathLenient(loc.root.path);
      if (!isWithin(base, p.path)) throw new PathDenied(path, 'outside this folder');
      return { path: p.path, rel: relative(base, p.path).split(sep).join('/') };
    } catch (err) {
      if (err instanceof PathDenied)
        throw new NovaError('policy_denied', err.message, { details: { reason: 'path_denied' } });
      throw err;
    }
  }

  #writable(loc: Located, rel: string): boolean {
    try {
      this.#resolve(loc, rel, 'write');
      return true;
    } catch {
      return false;
    }
  }

  #assertProject(accountId: string, projectId: string): void {
    const row = this.#o.db.raw
      .prepare('SELECT 1 AS x FROM project WHERE id = ? AND account_id = ? AND deleted_at IS NULL')
      .get(projectId, accountId);
    if (!row) throw new NovaError('not_found', 'project not found');
  }
}

/** Map filesystem errors to API errors. */
async function fsCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    return fsFailure(err);
  }
}

function fsFailure(err: unknown): never {
  if (err instanceof NovaError) throw err;
  const code = (err as { code?: unknown }).code;
  if (code === 'ENOENT') throw new NovaError('not_found', 'no such file or folder');
  if (code === 'EACCES' || code === 'EPERM')
    throw new NovaError('policy_denied', 'the Hub cannot access this file', {
      details: { reason: 'permission' },
    });
  if (code === 'ENOTDIR') throw new NovaError('validation', 'a path component is not a folder');
  if (code === 'EISDIR') throw new NovaError('validation', 'the path is a folder');
  throw err;
}
