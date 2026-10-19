// Three-way merges onto a session's folder (FR-073, docs/10 §9 and §14): another session's work (a
// worker started with task.spawn, a best-of-N attempt) or a patch, onto a branch that may have
// moved since that work started. Each changed file is merged from three sides: the base (the
// commit the work started from), ours (the session's folder as it is now, uncommitted edits
// included) and theirs (the work). A side that did not change takes the other; when both changed,
// `git merge-file` merges the text. A conflict is never resolved silently: by default nothing is
// written and the conflicts come back with their three sides for the three-way view; with
// `onConflict: 'markers'` the merged files are written with diff3-style conflict markers, the
// merge stays `conflicted` until no marker is left (a commit is refused meanwhile), and it can be
// aborted, which puts the files back as they were. Binary files and a delete against a change
// conflict as a whole.
//
// The merge itself runs on the Hub: the three sides are read through the session's workspace
// (this Hub, or another machine's transport) and only the results are written back.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import {
  NovaError,
  uuidv7,
  type CodeMergeView,
  type MergeConflictView,
  type MergeFileView,
} from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditSink } from '../tools/types.ts';
import type { CodeCommitGuard, CodeService, CodeSessionInfo } from './service.ts';
import { ShadowRepo, repoUserExcludes, type ShadowTreeEntry } from './shadow.ts';
import type { CodeWorkspace } from './transport.ts';

/** Characters of each side a conflict view carries. */
const SIDE_CHARS = 24_000;
/** Conflicts listed with their sides at most. */
const MAX_CONFLICT_VIEWS = 50;
/** Bytes a merge may back up and write. */
const MAX_MERGE_BYTES = 256 * 1024 * 1024;
const MARKER = /^(<{7}|>{7}) (ours|theirs)\b/m;

interface MergeRow {
  id: string;
  sessionId: string;
  sourceKind: 'session' | 'attempt' | 'patch';
  sourceRef: string | null;
  baseSha: string | null;
  status: CodeMergeView['status'];
  filesJson: string;
  conflictsJson: string;
  backupPath: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const MERGE_COLUMNS = `id, session_id AS sessionId, source_kind AS sourceKind,
  source_ref AS sourceRef, base_sha AS baseSha, status, files_json AS filesJson,
  conflicts_json AS conflictsJson, backup_path AS backupPath, created_at AS createdAt,
  resolved_at AS resolvedAt`;

/** One file of the work to merge: its content at the base and in the work (null: absent). */
interface Side {
  data: Buffer | null;
  mode: string | null;
}

interface Planned {
  path: string;
  result: MergeFileView['result'];
  conflicts: number;
  /** What to write (null: remove); undefined: leave the file alone. */
  write?: { data: Buffer; mode: string } | null;
  view?: MergeConflictView;
}

export interface MergeServiceOptions {
  db: NovaDatabase;
  code: CodeService;
  events: EventSink;
  audit: AuditSink;
  dataDir: string;
  now?: () => Date;
  log?: Logger;
}

export type MergeConflictMode = 'refuse' | 'markers';

export class MergeService {
  readonly #o: MergeServiceOptions;
  readonly #now: () => Date;
  readonly #log: Logger;

  constructor(opts: MergeServiceOptions) {
    this.#o = opts;
    this.#now = opts.now ?? (() => new Date());
    this.#log = opts.log ?? new Logger({ module: 'core.code.merge', sinks: [] });
  }

  /**
   * Merge another session's work onto a session: its commits since the two met and its
   * uncommitted changes. Both work in worktrees of the same repository on this Hub.
   */
  async mergeSession(
    accountId: string,
    sessionId: string,
    fromSessionId: string,
    onConflict: MergeConflictMode = 'refuse',
    kind: 'session' | 'attempt' = 'session',
    actor: 'user' | 'agent' = 'user',
  ): Promise<CodeMergeView> {
    const code = this.#o.code;
    const target = code.info(accountId, sessionId);
    const source = code.info(accountId, fromSessionId);
    if (source.id === target.id)
      throw new NovaError('validation', 'a session cannot merge into itself', {
        details: { reason: 'same_session' },
      });
    if (!target.hubLocal || !source.hubLocal)
      throw new NovaError('capability_missing', 'merging sessions needs both folders on the Hub', {
        details: { reason: 'remote_environment' },
      });
    const ws = await code.workspace(target);
    const git = ws.git;
    const srcTop = await git.text(['rev-parse', '--show-toplevel'], { cwd: source.folder });
    const dstTop = await git.text(['rev-parse', '--show-toplevel'], { cwd: target.folder });
    const [srcCommon, dstCommon] = await Promise.all([
      commonDir(ws, source.folder),
      commonDir(ws, target.folder),
    ]);
    if (srcCommon !== dstCommon)
      throw new NovaError('validation', 'the sessions work in different repositories', {
        details: { reason: 'other_repository' },
      });
    const prefix = relPrefix(dstTop, target.folder);
    if (relPrefix(srcTop, source.folder) !== prefix)
      throw new NovaError(
        'validation',
        'the sessions work in different folders of the repository',
        {
          details: { reason: 'other_folder' },
        },
      );
    const srcHead = await git.text(['rev-parse', 'HEAD'], { cwd: source.folder });
    const dstHead = await git.text(['rev-parse', 'HEAD'], { cwd: target.folder });
    const base = await git.text(['merge-base', srcHead, dstHead], { cwd: target.folder });
    const shadow = await tempShadow(ws, source.folder, srcCommon);
    try {
      const baseTree = await subtree(shadow, base, prefix);
      await shadow.readTree(await subtree(shadow, srcHead, prefix));
      const theirsTree = await shadow.snapshot();
      return await this.#merge(target, ws, shadow, baseTree, theirsTree, {
        kind,
        ref: source.id,
        base,
        onConflict,
        actor,
      });
    } finally {
      await shadow.remove().catch(() => undefined);
    }
  }

  /**
   * Merge a patch (`git diff --binary --full-index` output) made against `base` (default: the
   * session's HEAD) onto the session's folder; the session may be on any machine.
   */
  async mergePatch(
    accountId: string,
    sessionId: string,
    patch: string | Buffer,
    base: string | undefined,
    onConflict: MergeConflictMode = 'refuse',
    actor: 'user' | 'agent' = 'user',
  ): Promise<CodeMergeView> {
    const code = this.#o.code;
    const target = code.info(accountId, sessionId);
    const ws = await code.workspace(target);
    const git = ws.git;
    const top = await git.run(['rev-parse', '--show-toplevel'], {
      cwd: target.folder,
      allowFail: true,
    });
    if (top.code !== 0)
      throw new NovaError('validation', 'the session folder is not a Git repository');
    const prefix = relPrefix(top.stdout.toString('utf8').trim(), target.folder);
    const resolved = await git.run(['rev-parse', '-q', '--verify', `${base ?? 'HEAD'}^{commit}`], {
      cwd: target.folder,
      allowFail: true,
    });
    if (resolved.code !== 0)
      throw new NovaError(
        'validation',
        `the repository does not have the base commit ${base ?? 'HEAD'}`,
        {
          details: { reason: 'missing_base' },
        },
      );
    const baseSha = resolved.stdout.toString('utf8').trim();
    const shadow = await tempShadow(ws, target.folder, await commonDir(ws, target.folder));
    try {
      const baseTree = await subtree(shadow, baseSha, prefix);
      let theirsTree: string;
      try {
        theirsTree = await shadow.applyToTree(baseTree, patch.toString());
      } catch {
        throw new NovaError('validation', 'the patch does not apply to its base commit', {
          details: { reason: 'patch_mismatch' },
        });
      }
      return await this.#merge(target, ws, shadow, baseTree, theirsTree, {
        kind: 'patch',
        ref: sha256(patch).slice(0, 16),
        base: baseSha,
        onConflict,
        actor,
      });
    } finally {
      await shadow.remove().catch(() => undefined);
    }
  }

  list(accountId: string, sessionId: string): CodeMergeView[] {
    const s = this.#o.code.info(accountId, sessionId);
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${MERGE_COLUMNS} FROM code_merge WHERE session_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 100`,
      )
      .all(s.id) as unknown as MergeRow[];
    return rows.map(viewOf);
  }

  get(accountId: string, sessionId: string, mergeId: string): CodeMergeView {
    return viewOf(this.#row(accountId, sessionId, mergeId));
  }

  /** The user resolved a conflicted merge: refused while a conflict marker is left. */
  async resolve(accountId: string, sessionId: string, mergeId: string): Promise<CodeMergeView> {
    const r = this.#row(accountId, sessionId, mergeId);
    if (r.status !== 'conflicted') return viewOf(r);
    const s = this.#o.code.info(accountId, sessionId);
    const left = await this.#markersLeft(s, await this.#o.code.workspace(s), r);
    if (left.length)
      throw new NovaError('conflict', `conflict markers are left in ${left.join(', ')}`, {
        details: { reason: 'merge_conflicts', mergeId, paths: left },
      });
    await this.#settle(s, r, 'resolved', 'user');
    return this.get(accountId, sessionId, mergeId);
  }

  /** Put the files a conflicted merge wrote back as they were before it. */
  async abort(accountId: string, sessionId: string, mergeId: string): Promise<CodeMergeView> {
    const r = this.#row(accountId, sessionId, mergeId);
    if (r.status !== 'conflicted' && r.status !== 'applied')
      throw new NovaError('conflict', `the merge is ${r.status}`, {
        details: { reason: 'merge_settled' },
      });
    if (!r.backupPath) throw new NovaError('conflict', 'this merge kept no copy to restore');
    const s = this.#o.code.info(accountId, sessionId);
    const ws = await this.#o.code.workspace(s);
    const backup = JSON.parse(
      await readFile(join(this.#o.dataDir, r.backupPath), 'utf8'),
    ) as Record<string, { data: string | null; mode: string | null }>;
    await this.#o.code.serialized(s.id, async () => {
      for (const [path, b] of Object.entries(backup)) {
        if (b.data === null) await ws.fs.removeWithin(s.folder, path);
        else
          await ws.fs.writeWithin(s.folder, path, Buffer.from(b.data, 'base64'), fileMode(b.mode));
      }
    });
    await this.#settle(s, r, 'aborted', 'user');
    await this.#o.code.refresh(accountId, s.id).catch(() => []);
    return this.get(accountId, sessionId, mergeId);
  }

  /**
   * The commit guard: a conflicted merge whose markers are gone counts as resolved; one with
   * markers left refuses the commit (docs/10 §14: never resolved silently).
   */
  readonly commitGuard: CodeCommitGuard = async (s, ws) => {
    const rows = this.#o.db.raw
      .prepare(
        `SELECT ${MERGE_COLUMNS} FROM code_merge WHERE session_id = ? AND status = 'conflicted'`,
      )
      .all(s.id) as unknown as MergeRow[];
    for (const r of rows) {
      const left = await this.#markersLeft(s, ws, r);
      if (left.length)
        throw new NovaError(
          'conflict',
          `resolve the merge conflicts first: markers are left in ${left.join(', ')}`,
          { details: { reason: 'merge_conflicts', mergeId: r.id, paths: left } },
        );
      await this.#settle(s, r, 'resolved', 'user');
    }
  };

  // ---- the merge ---------------------------------------------------------------------------

  async #merge(
    target: CodeSessionInfo,
    ws: CodeWorkspace,
    shadow: ShadowRepo,
    baseTree: string,
    theirsTree: string,
    o: {
      kind: 'session' | 'attempt' | 'patch';
      ref: string | null;
      base: string;
      onConflict: MergeConflictMode;
      actor: 'user' | 'agent';
    },
  ): Promise<CodeMergeView> {
    const code = this.#o.code;
    const id = uuidv7();
    const paths = await shadow.changedPaths(baseTree, theirsTree);
    const planned: Planned[] = [];
    const backup: Record<string, { data: string | null; mode: string | null }> = {};
    let bytes = 0;
    const done = await code.serialized(target.id, async () => {
      for (const path of paths) {
        const base = await sideOf(shadow, baseTree, path);
        const theirs = await sideOf(shadow, theirsTree, path);
        const ours = await oursOf(ws, target.folder, path);
        bytes += (base.data?.length ?? 0) + (theirs.data?.length ?? 0) + (ours.data?.length ?? 0);
        if (bytes > MAX_MERGE_BYTES)
          throw new NovaError('validation', 'the work is too large to merge', {
            details: { reason: 'too_large' },
          });
        planned.push(await this.#plan(path, base, ours, theirs));
        backup[path] = {
          data: ours.data ? ours.data.toString('base64') : null,
          mode: ours.mode,
        };
      }
      const conflicts = planned.filter(
        (p) => p.result === 'conflict' || p.result === 'binary_conflict',
      );
      const refuse = conflicts.length > 0 && o.onConflict === 'refuse';
      // Binary conflicts have nothing to mark: they are always left for the user.
      const writes = refuse
        ? []
        : planned.filter((p) => p.write !== undefined && p.result !== 'binary_conflict');
      let backupPath: string | null = null;
      if (writes.length) {
        backupPath = join('code', target.id, 'merges', `${id}.json`);
        await mkdir(join(this.#o.dataDir, 'code', target.id, 'merges'), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(join(this.#o.dataDir, backupPath), JSON.stringify(backup), {
          mode: 0o600,
        });
        for (const p of writes) {
          if (p.write === null) await ws.fs.removeWithin(target.folder, p.path);
          else if (p.write)
            await ws.fs.writeWithin(target.folder, p.path, p.write.data, fileMode(p.write.mode));
        }
      }
      const status: CodeMergeView['status'] = refuse
        ? 'refused'
        : conflicts.length
          ? 'conflicted'
          : 'applied';
      const row: MergeRow = {
        id,
        sessionId: target.id,
        sourceKind: o.kind,
        sourceRef: o.ref,
        baseSha: o.base,
        status,
        filesJson: JSON.stringify(
          planned.map((p) => ({ path: p.path, result: p.result, conflicts: p.conflicts })),
        ),
        conflictsJson: JSON.stringify(
          conflicts.slice(0, MAX_CONFLICT_VIEWS).flatMap((p) => (p.view ? [p.view] : [])),
        ),
        backupPath,
        createdAt: this.#iso(),
        resolvedAt: null,
      };
      await this.#o.db.transaction(() => {
        this.#o.db.raw
          .prepare(
            `INSERT INTO code_merge (id, session_id, source_kind, source_ref, base_sha, status,
               files_json, conflicts_json, backup_path, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            row.id,
            row.sessionId,
            row.sourceKind,
            row.sourceRef,
            row.baseSha,
            row.status,
            row.filesJson,
            row.conflictsJson,
            row.backupPath,
            row.createdAt,
          );
      });
      return row;
    });
    if (done.status !== 'refused') await code.refresh(target.accountId, target.id).catch(() => []);
    const view = viewOf(done);
    await this.#o.audit.append({
      accountId: target.accountId,
      actor: o.actor,
      kind: 'code',
      action: 'code.merge',
      resource: target.folder,
      result: done.status === 'applied' ? 'ok' : done.status === 'refused' ? 'denied' : 'conflict',
      threadId: target.threadId,
      detail: {
        sessionId: target.id,
        mergeId: id,
        source: o.kind,
        sourceRef: o.ref,
        base: o.base,
        files: view.files.length,
        conflicts: view.files.filter(
          (f) => f.result === 'conflict' || f.result === 'binary_conflict',
        ).length,
      },
    });
    await code.announce(target, 'code.merge.completed', {
      sessionId: target.id,
      mergeId: id,
      status: done.status,
      files: view.files.length,
      conflicts: view.conflicts.length,
    });
    if (done.status === 'refused')
      throw new NovaError(
        'conflict',
        "the work conflicts with the session's files; nothing was written",
        {
          details: {
            reason: 'merge_conflict',
            mergeId: id,
            paths: view.files
              .filter((f) => f.result === 'conflict' || f.result === 'binary_conflict')
              .map((f) => f.path),
          },
        },
      );
    return view;
  }

  async #plan(path: string, base: Side, ours: Side, theirs: Side): Promise<Planned> {
    if (same(ours, theirs)) return { path, result: 'unchanged', conflicts: 0 };
    if (same(ours, base)) {
      // Only the work changed it: take the work's side.
      if (!theirs.data) return { path, result: 'deleted', conflicts: 0, write: null };
      return {
        path,
        result: base.data ? 'applied' : 'added',
        conflicts: 0,
        write: { data: theirs.data, mode: theirs.mode ?? '100644' },
      };
    }
    // Only the session changed it (the work did not, or only its mode): keep ours.
    if (same(theirs, base)) return { path, result: 'unchanged', conflicts: 0 };
    const binary = [base, ours, theirs].some((x) => x.data && isBinary(x.data));
    const links = [base, ours, theirs].some((x) => x.mode === '120000');
    if (binary || links || !ours.data || !theirs.data)
      return {
        path,
        result: binary || links ? 'binary_conflict' : 'conflict',
        conflicts: 1,
        view: conflictView(path, base, ours, theirs, null, binary || links),
      };
    const merged = await this.#mergeFile(ours.data, base.data ?? Buffer.alloc(0), theirs.data);
    const mode = theirs.mode !== base.mode ? (theirs.mode ?? '100644') : (ours.mode ?? '100644');
    if (merged.conflicts === 0)
      return { path, result: 'merged', conflicts: 0, write: { data: merged.data, mode } };
    return {
      path,
      result: 'conflict',
      conflicts: merged.conflicts,
      write: { data: merged.data, mode },
      view: conflictView(path, base, ours, theirs, merged.data, false),
    };
  }

  /** `git merge-file` on the Hub over three temporary copies; the count of conflicts. */
  async #mergeFile(
    ours: Buffer,
    base: Buffer,
    theirs: Buffer,
  ): Promise<{ data: Buffer; conflicts: number }> {
    const dir = join(this.#o.dataDir, 'code', 'state', `merge-${uuidv7()}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(dir, 'ours'), ours, { mode: 0o600 });
      await writeFile(join(dir, 'base'), base, { mode: 0o600 });
      await writeFile(join(dir, 'theirs'), theirs, { mode: 0o600 });
      const r = await this.#o.code.git.run(
        [
          'merge-file',
          '-p',
          '--diff3',
          '-L',
          'ours',
          '-L',
          'base',
          '-L',
          'theirs',
          'ours',
          'base',
          'theirs',
        ],
        { cwd: dir, allowFail: true },
      );
      if (r.code < 0 || r.code > 127)
        throw new NovaError('server_error', `merging failed: ${r.stderr.slice(0, 300)}`);
      return { data: r.stdout, conflicts: r.code };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async #markersLeft(s: CodeSessionInfo, ws: CodeWorkspace, r: MergeRow): Promise<string[]> {
    const files = JSON.parse(r.filesJson) as MergeFileView[];
    const left: string[] = [];
    for (const f of files) {
      if (f.result !== 'conflict') continue;
      const st = await ws.fs.stat(join(s.folder, ...f.path.split('/')));
      if (st?.kind !== 'file') continue;
      const data = await ws.fs.readFile(join(s.folder, ...f.path.split('/')), 64 * 1024 * 1024);
      if (MARKER.test(data.toString('utf8'))) left.push(f.path);
    }
    // A binary conflict is the user's to settle: it never blocks once they chose a side.
    return left;
  }

  async #settle(s: CodeSessionInfo, r: MergeRow, status: 'resolved' | 'aborted', actor: string) {
    await this.#o.db.transaction(() => {
      this.#o.db.raw
        .prepare('UPDATE code_merge SET status = ?, resolved_at = ? WHERE id = ?')
        .run(status, this.#iso(), r.id);
    });
    await this.#o.audit.append({
      accountId: s.accountId,
      actor,
      kind: 'code',
      action: status === 'resolved' ? 'code.merge.resolved' : 'code.merge.aborted',
      resource: s.folder,
      result: 'ok',
      threadId: s.threadId,
      detail: { sessionId: s.id, mergeId: r.id },
    });
    await this.#o.code.announce(s, 'code.merge.completed', {
      sessionId: s.id,
      mergeId: r.id,
      status,
    });
    this.#log.debug('merge settled', { mergeId: r.id, status });
  }

  #row(accountId: string, sessionId: string, mergeId: string): MergeRow {
    const s = this.#o.code.info(accountId, sessionId);
    const r = this.#o.db.raw
      .prepare(`SELECT ${MERGE_COLUMNS} FROM code_merge WHERE id = ? AND session_id = ?`)
      .get(mergeId, s.id) as MergeRow | undefined;
    if (!r) throw new NovaError('not_found', 'merge not found');
    return r;
  }

  #iso(): string {
    return this.#now().toISOString();
  }
}

// ---- helpers -------------------------------------------------------------------------------------

function viewOf(r: MergeRow): CodeMergeView {
  return {
    id: r.id,
    sessionId: r.sessionId,
    source: { kind: r.sourceKind, ref: r.sourceRef },
    status: r.status,
    baseSha: r.baseSha,
    files: JSON.parse(r.filesJson) as MergeFileView[],
    conflicts: JSON.parse(r.conflictsJson) as MergeConflictView[],
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  };
}

/** A short-lived shadow over a folder, borrowing its repository's objects (the three sides). */
export async function tempShadow(
  ws: CodeWorkspace,
  work: string,
  common: string,
): Promise<ShadowRepo> {
  const shadow = new ShadowRepo({
    git: ws.git,
    gitDir: join(await ws.stateDir(), `merge-${uuidv7()}.git`),
    workTree: work,
    fs: ws.fs,
  });
  await shadow.init(await repoUserExcludes(ws.git, work, ws.fs), {
    alternates: join(common, 'objects'),
  });
  return shadow;
}

/** The repository's common Git folder (shared by its worktrees), absolute. */
export async function commonDir(ws: CodeWorkspace, work: string): Promise<string> {
  const p = await ws.git.text(['rev-parse', '--git-common-dir'], { cwd: work });
  // Relative to the folder the command ran in (`../.git` from a subfolder).
  return (isAbsolute(p) ? p : join(work, p)).replace(/\/+$/, '');
}

/** The tree of a commit at the session folder (`<commit>:<prefix>`). */
export async function subtree(shadow: ShadowRepo, commit: string, prefix: string): Promise<string> {
  const r = await shadow.git([
    'rev-parse',
    '--verify',
    prefix ? `${commit}:${prefix}` : `${commit}^{tree}`,
  ]);
  return r.stdout.toString('utf8').trim();
}

function relPrefix(top: string, work: string): string {
  return relative(top, work).split(sep).filter(Boolean).join('/');
}

async function sideOf(shadow: ShadowRepo, tree: string, path: string): Promise<Side> {
  const e: ShadowTreeEntry | null = await shadow.entry(tree, path);
  if (!e || e.mode === '160000') return { data: null, mode: null };
  return { data: await shadow.blob(e.sha), mode: e.mode };
}

async function oursOf(ws: CodeWorkspace, folder: string, path: string): Promise<Side> {
  const abs = join(folder, ...path.split('/'));
  const st = await ws.fs.stat(abs);
  if (!st) return { data: null, mode: null };
  if (st.kind === 'symlink') return { data: Buffer.from('(a symbolic link)'), mode: '120000' };
  if (st.kind !== 'file') return { data: Buffer.from('(not a file)'), mode: '040000' };
  const data = await ws.fs.readFile(abs, MAX_MERGE_BYTES);
  const exec = await ws.git.run(['ls-files', '-s', '--', path], { cwd: folder, allowFail: true });
  const mode = /^(\d{6}) /.exec(exec.stdout.toString('utf8'))?.[1] ?? '100644';
  return { data, mode };
}

function same(a: Side, b: Side): boolean {
  if (!a.data || !b.data) return !a.data && !b.data;
  return a.data.equals(b.data);
}

function isBinary(b: Buffer): boolean {
  return b.subarray(0, 8000).includes(0);
}

function fileMode(mode: string | null): number {
  return mode === '100755' ? 0o755 : 0o644;
}

function textSide(b: Buffer | null): { text: string | null; cut: boolean } {
  if (!b) return { text: null, cut: false };
  const t = defaultRedactor.redactString(b.toString('utf8'));
  return t.length > SIDE_CHARS
    ? { text: t.slice(0, SIDE_CHARS), cut: true }
    : { text: t, cut: false };
}

function conflictView(
  path: string,
  base: Side,
  ours: Side,
  theirs: Side,
  merged: Buffer | null,
  binary: boolean,
): MergeConflictView {
  if (binary)
    return {
      path,
      binary: true,
      base: null,
      ours: null,
      theirs: null,
      merged: null,
      truncated: false,
    };
  const b = textSide(base.data);
  const o = textSide(ours.data);
  const t = textSide(theirs.data);
  const m = textSide(merged);
  return {
    path,
    binary: false,
    base: b.text,
    ours: o.text,
    theirs: t.text,
    merged: m.text,
    truncated: b.cut || o.cut || t.cut || m.cut,
  };
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
