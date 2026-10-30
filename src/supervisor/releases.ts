// Code releases (ADR-9: "every deploy is a tagged, reversible version"). A release is a git tag;
// its slot is a worktree of that tag's commit in <dir>/releases/<version>/, and `current` points
// at the one running. Slots are never edited: a new version is a new slot.
//
// The database side of going back. An upgrade's pre-migration backup (db.ts, M1) is kept. Going
// back across a migration restores it only when nothing was written since the newer release
// started: the sync log (migration 0006) records every write to the person's data with a rising
// sequence, so "nothing since" is a number that didn't move. Problems (Nova's own diagnostics) are
// set aside from that count and carried over into the restored database, so none are lost either.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Names the supervisor uses itself: `current` is the link to the running slot, `base` the code it
// started from. A tag with either name is never a release: deploying it would replace the link
// with a folder, or stand in for the base.
export const RESERVED: ReadonlySet<string> = new Set(['current', 'base']);
export const isRelease = (v: unknown): v is string => typeof v === 'string' && VERSION.test(v) && !RESERVED.has(v.toLowerCase());

export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((done) => {
    execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (e, out, err) => done({ ok: !e, out: String(out).trim(), err: String(err).trim() }));
  });
}

export class Slots {
  readonly dir: string;
  readonly repo: string;

  constructor(o: { dir: string; repo: string }) {
    this.dir = join(o.dir, 'releases');
    this.repo = o.repo;
  }

  path(version: string): string {
    return join(this.dir, version);
  }

  // The tag's commit, or null when there is no such tag (a branch name is not a release).
  async commit(version: string): Promise<string | null> {
    if (!isRelease(version)) return null;
    const r = await git(this.repo, ['rev-parse', '--verify', '--quiet', `refs/tags/${version}^{commit}`]);
    return r.ok && /^[0-9a-f]{40}$/.test(r.out) ? r.out : null;
  }

  // The slot for a version: made once from its tag, checked to still be that commit.
  async ensure(version: string): Promise<{ path: string; commit: string }> {
    if (!isRelease(version)) throw new Error(`${version} can’t be a release’s name: the supervisor uses it itself.`);
    const commit = await this.commit(version);
    if (!commit) throw new Error(`There is no release tagged ${version} in ${this.repo}.`);
    return this.#at(this.path(version), commit, `release ${version}`);
  }

  // The code "base" runs: the repository's HEAD commit when the supervisor started, in a slot of
  // its own, so editing the checkout (or Nova's change pipeline working there) never changes what
  // runs. Null when there is no commit to pin (not a git checkout).
  async pinBase(): Promise<{ path: string; commit: string } | null> {
    const head = await git(this.repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (!head.ok || !/^[0-9a-f]{40}$/.test(head.out)) return null;
    const name = `.base-${head.out.slice(0, 12)}`;
    const slot = await this.#at(join(this.dir, name), head.out, 'the base');
    // Older pins are run by nothing any more.
    for (const e of readdirSync(this.dir)) {
      if (!/^\.base-[0-9a-f]{12}$/.test(e) || e === name) continue;
      await git(this.repo, ['worktree', 'remove', '--force', join(this.dir, e)]);
      rmSync(join(this.dir, e), { recursive: true, force: true });
    }
    await git(this.repo, ['worktree', 'prune']);
    return slot;
  }

  async #at(path: string, commit: string, what: string): Promise<{ path: string; commit: string }> {
    mkdirSync(this.dir, { recursive: true });
    if (existsSync(path)) {
      const head = await git(path, ['rev-parse', 'HEAD']);
      const clean = await git(path, ['status', '--porcelain']);
      if (head.ok && head.out === commit && clean.ok && !clean.out) return { path, commit };
      // A slot that isn't exactly its tag any more is not trusted: it is made again.
      await git(this.repo, ['worktree', 'remove', '--force', path]);
      rmSync(path, { recursive: true, force: true });
      await git(this.repo, ['worktree', 'prune']);
    }
    const add = await git(this.repo, ['worktree', 'add', '--detach', path, commit], 120_000);
    if (!add.ok) throw new Error(`The slot for ${what} couldn’t be made: ${add.err}`);
    return { path, commit };
  }

  // Where `current` points (a version), or null for none.
  current(): string | null {
    const link = join(this.dir, 'current');
    try { return lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null; } catch { return null; }
  }

  // Points `current` at a version, all at once (a new link renamed over the old).
  point(version: string | null): void {
    mkdirSync(this.dir, { recursive: true });
    const link = join(this.dir, 'current');
    if (version === null) { rmSync(link, { force: true }); return; }
    if (!isRelease(version)) throw new Error(`${version} can’t be a release’s name: the supervisor uses it itself.`);
    const tmp = join(this.dir, `.current-${process.pid}`);
    rmSync(tmp, { force: true });
    symlinkSync(version, tmp);
    renameSync(tmp, link);
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((e) => isRelease(e) && statSync(join(this.dir, e)).isDirectory());
  }
}

// Whether a release's code can be run as a sandbox (it knows NOVA_SANDBOX: no work, no peers).
// Releases from before M7b don't, and are never started on a copy of the home.
export function sandboxable(root: string): boolean {
  return existsSync(join(root, 'src', 'core', 'resilience', 'sandbox.ts'));
}

export function packageVersion(root: string): string | null {
  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? null; } catch { return null; }
}

// ---- the database across a release ------------------------------------------------------------

const openDb = (home: string) => {
  const db = new DatabaseSync(join(home, 'nova.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
};
const tableExists = (db: DatabaseSync, name: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

export function schemaVersion(home: string): number {
  if (!existsSync(join(home, 'nova.db'))) return 0;
  const db = openDb(home);
  try {
    if (!tableExists(db, 'schema_migrations')) return 0;
    return (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
  } finally {
    db.close();
  }
}

// Where the person's data stands: the sync log's newest sequence, and the newest problem.
export interface Mark { seq: number; problem: number }
export function mark(home: string): Mark {
  const db = openDb(home);
  try {
    const seq = tableExists(db, 'sync_log') ? (db.prepare('SELECT IFNULL(MAX(seq), 0) AS s FROM sync_log').get() as { s: number }).s : 0;
    const problem = (db.prepare('SELECT IFNULL(MAX(id), 0) AS p FROM problem').get() as { p: number }).p;
    return { seq, problem };
  } finally {
    db.close();
  }
}

// What was written to the person's data in the database since the mark, by table. Set aside:
// problems (carried over instead) and the journal of the home's files (`file`): restoring the
// database leaves the files as they are, and the journal records them again from the disk.
export function writesSince(home: string, m: Mark): Record<string, number> {
  const db = openDb(home);
  try {
    if (!tableExists(db, 'sync_log')) return { unknown: 1 };
    const rows = db.prepare(`SELECT tbl, COUNT(*) AS n FROM sync_log WHERE seq > ? AND tbl NOT IN ('problem', 'file') GROUP BY tbl`).all(m.seq) as { tbl: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.tbl, r.n]));
  } finally {
    db.close();
  }
}

// The pre-migration backup an upgrade from `from` made (db.ts names them …-v<from>.db), the newest
// one made at or after `since`.
export function preMigrationBackup(home: string, from: number, since: number): string | null {
  const dir = join(home, 'backups');
  if (!existsSync(dir)) return null;
  const found = readdirSync(dir).filter((f) => f.endsWith(`-v${from}.db`)).map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs })).filter((x) => x.t >= since - 2000).sort((a, b) => b.t - a.t)[0];
  return found ? resolve(dir, found.f) : null;
}

export interface ProblemRow { id: number; at: string; source: string; message: string; detail: string | null; task_id: string | null; resolved_at: string | null }

export function problemsSince(home: string, id: number): ProblemRow[] {
  const db = openDb(home);
  try { return db.prepare('SELECT id, at, source, message, detail, task_id, resolved_at FROM problem WHERE id > ? ORDER BY id').all(id) as unknown as ProblemRow[]; } finally { db.close(); }
}

// Problems carried over into a restored database, so going back loses none of them.
export function carryProblems(home: string, rows: ProblemRow[]): void {
  if (!rows.length) return;
  const db = openDb(home);
  try {
    const ins = db.prepare('INSERT INTO problem (at, source, message, detail, task_id, resolved_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of rows) ins.run(r.at, r.source, r.message, r.detail, r.task_id, r.resolved_at);
  } finally {
    db.close();
  }
}

// A problem written straight into the database while no server runs (safe mode), with its
// playbook when this database knows playbooks. One stays open per playbook.
export function recordProblem(home: string, p: { source: string; said: string; playbook: string; subject?: string | null; detail?: string; repairs?: { name: string; ok: boolean; said: string }[] }, now = new Date()): number | null {
  if (!existsSync(join(home, 'nova.db'))) return null;
  const db = openDb(home);
  try {
    if (!tableExists(db, 'problem')) return null;
    const pb = tableExists(db, 'problem_playbook');
    if (pb) {
      const open = db.prepare(`SELECT pp.problem_id AS id FROM problem_playbook pp JOIN problem p ON p.id = pp.problem_id WHERE pp.playbook = ? AND pp.subject IS ? AND p.resolved_at IS NULL`).get(p.playbook, p.subject ?? null) as { id: number } | undefined;
      if (open) return open.id;
    }
    const at = now.toISOString();
    db.prepare('INSERT INTO problem (at, source, message, detail) VALUES (?, ?, ?, ?)').run(at, p.source, p.said, p.detail ?? null);
    const id = (db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id;
    if (pb) {
      const repairs = (p.repairs ?? []).map((r) => ({ at, name: r.name, by: 'nova', ok: r.ok, said: r.said }));
      db.prepare('INSERT OR REPLACE INTO problem_playbook (problem_id, playbook, subject, repairs, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, p.playbook, p.subject ?? null, JSON.stringify(repairs), at);
    }
    return id;
  } finally {
    db.close();
  }
}
