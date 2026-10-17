// Local project folders (FR-035): which folders may be bound, indexing into the project's
// sources (caps, ignored, protected and binary files, symlinks), re-indexing changes, removal,
// restart recovery, and the roots export for the tools scope.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, uuidv7 } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  IgnoreRules,
  MemoryEventSink,
  ProjectFolderService,
  SourceService,
  listProjectFolderRoots,
  type ProjectFolderServiceOptions,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000e1';
const OTHER = '01920000-0000-7000-8000-0000000000e2';

let dir: string;
let dataDir: string;
let home: string;
let repo: string;
let db: NovaDatabase;
let events: MemoryEventSink;
let projectId: string;
let svc: ProjectFolderService;

async function openDb(): Promise<NovaDatabase> {
  const d = openDatabase({ path: ':memory:' });
  await migrate(d);
  return d;
}

function make(opts: Partial<ProjectFolderServiceOptions> = {}): ProjectFolderService {
  return new ProjectFolderService({ db, events, dataDir, home, ...opts });
}

function write(rel: string, content: string | Buffer, base = repo): void {
  const p = join(base, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

function sourceNames(): string[] {
  return (
    db.raw
      .prepare('SELECT name FROM source WHERE project_id = ? AND deleted_at IS NULL ORDER BY name')
      .all(projectId) as { name: string }[]
  ).map((r) => r.name);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof NovaError ? err.code : String(err);
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'nova-folders-'));
  home = join(dir, 'home');
  dataDir = join(home, '.nova');
  repo = join(home, 'code', 'repo');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  db = await openDb();
  events = new MemoryEventSink();
  const now = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare(
        "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'x', ?, ?)",
      )
      .run(id, now, now);
  projectId = uuidv7();
  db.raw
    .prepare(
      'INSERT INTO project (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(projectId, ACCOUNT, 'Proj', now, now);
  svc = make();
});
afterEach(async () => {
  await svc.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('binding folders', () => {
  it('refuses missing, relative and non-folder paths, and protected locations', async () => {
    write('file.txt', 'x');
    mkdirSync(join(home, '.ssh'), { recursive: true });
    const add = (path: string) => codeOf(svc.add(ACCOUNT, projectId, { path }));
    expect(await add('code/repo')).toBe('validation');
    expect(await add(join(dir, 'nope'))).toBe('validation');
    expect(await add(join(repo, 'file.txt'))).toBe('validation');
    expect(await add('/')).toBe('policy_denied');
    expect(await add(dataDir)).toBe('policy_denied');
    mkdirSync(join(dataDir, 'workspace'));
    expect(await add(join(dataDir, 'workspace'))).toBe('policy_denied');
    expect(await add(home)).toBe('policy_denied');
    expect(await add(dir)).toBe('policy_denied');
    expect(await add(join(home, '.ssh'))).toBe('policy_denied');
    expect(await codeOf(svc.add(OTHER, projectId, { path: repo }))).toBe('not_found');
  });

  it('accepts ~ paths, stores the real path, refuses duplicates and caps the count', async () => {
    symlinkSync(repo, join(home, 'link'));
    const view = await svc.add(ACCOUNT, projectId, { path: '~/link', access: 'write' });
    expect(view).toMatchObject({ projectId, path: repo, access: 'write', status: 'indexing' });
    expect(await codeOf(svc.add(ACCOUNT, projectId, { path: repo }))).toBe('conflict');
    const capped = make({ limits: { maxFoldersPerProject: 1 } });
    mkdirSync(join(home, 'two'));
    expect(await codeOf(capped.add(ACCOUNT, projectId, { path: join(home, 'two') }))).toBe(
      'validation',
    );
    await capped.stop();
    await svc.idle();
    expect(await listProjectFolderRoots(db, projectId)).toEqual([
      { path: repo, access: 'write', label: 'repo' },
    ]);
    expect(await svc.list(ACCOUNT, projectId)).toHaveLength(1);
    expect(await codeOf(svc.list(OTHER, projectId))).toBe('not_found');
  });
});

describe('indexing', () => {
  it('indexes text files into retrievable sources and skips everything else', async () => {
    write('src/app.ts', 'export const refund = "refunds are processed in five days";');
    write('README.md', '# Repo\nThe deployment guide lives here.');
    write('.gitignore', '*.log\nsecret/\n/top-only.txt\n# comment\n!keep.log\n');
    write('debug.log', 'ignored by gitignore');
    write('secret/plan.md', 'ignored folder');
    write('top-only.txt', 'anchored ignore');
    write('nested/top-only.txt', 'not anchored here');
    write('node_modules/dep/index.js', 'dependency');
    write('build/out.js', 'build output');
    write('.git/HEAD', 'ref: main');
    write('.nova/skills/x/SKILL.md', 'project config');
    write('.ssh/id_ed25519', 'private key');
    write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    write('blob.dat2', Buffer.from([1, 0, 2, 3]));
    write('huge.txt', 'x'.repeat(5_000));
    symlinkSync(join(repo, 'README.md'), join(repo, 'link.md'));
    const small = make({ limits: { maxFileBytes: 1_000 } });
    const added = await small.add(ACCOUNT, projectId, { path: repo });
    await small.idle();
    const [view] = await small.list(ACCOUNT, projectId);
    expect(view).toMatchObject({ id: added.id, status: 'ready', fileCount: 4 });
    expect(view?.error).toBe('1 file is larger than 1 KB and not indexed.');
    expect(sourceNames()).toEqual([
      'repo/.gitignore',
      'repo/README.md',
      'repo/nested/top-only.txt',
      'repo/src/app.ts',
    ]);
    const sources = new SourceService({ db, events, dataDir });
    const hits = sources.retrieve(ACCOUNT, projectId, 'how are refunds processed');
    expect(hits[0]).toMatchObject({ name: 'repo/src/app.ts' });
    expect(events.events.find((e) => e.name === 'project.folder.indexed')?.payload).toEqual({
      projectId,
      folderId: added.id,
      fileCount: 4,
      status: 'ready',
    });
    await small.stop();
  });

  it('stops at the file cap and says so', async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e']) write(`${n}.md`, `file ${n}`);
    const capped = make({ limits: { maxFiles: 3 } });
    await capped.add(ACCOUNT, projectId, { path: repo });
    await capped.idle();
    const [view] = await capped.list(ACCOUNT, projectId);
    expect(view).toMatchObject({ status: 'ready', fileCount: 3 });
    expect(view?.error).toBe('Only the first 3 files were indexed.');
    expect(sourceNames()).toEqual(['repo/a.md', 'repo/b.md', 'repo/c.md']);
    await capped.stop();
  });

  it('re-indexes new, changed and removed files and skips unchanged ones', async () => {
    write('keep.md', 'unchanged content');
    write('change.md', 'old wording about kittens');
    write('drop.md', 'to be removed');
    const added = await svc.add(ACCOUNT, projectId, { path: repo });
    await svc.idle();
    const stamp = (name: string) =>
      (
        db.raw.prepare('SELECT updated_at AS u FROM source WHERE name = ?').get(`repo/${name}`) as {
          u: string;
        }
      ).u;
    const keepBefore = stamp('keep.md');
    await new Promise((r) => setTimeout(r, 5));
    write('change.md', 'new wording about puppies');
    rmSync(join(repo, 'drop.md'));
    write('fresh.md', 'a brand new file');
    const again = await svc.reindex(ACCOUNT, projectId, added.id);
    expect(again.status).toBe('indexing');
    await svc.idle();
    expect(sourceNames()).toEqual(['repo/change.md', 'repo/fresh.md', 'repo/keep.md']);
    expect(stamp('keep.md')).toBe(keepBefore);
    const sources = new SourceService({ db, events, dataDir });
    expect(sources.retrieve(ACCOUNT, projectId, 'kittens')).toEqual([]);
    expect(sources.retrieve(ACCOUNT, projectId, 'puppies')[0]?.name).toBe('repo/change.md');
    const dropped = db.raw
      .prepare(
        "SELECT count(*) AS n FROM source_chunk c JOIN source s ON s.id = c.source_id WHERE s.name = 'repo/drop.md'",
      )
      .get() as { n: number };
    expect(dropped.n).toBe(0);
    expect((await svc.get(ACCOUNT, projectId, added.id)).fileCount).toBe(3);
  });

  it('removes a folder with its sources, leaving the files alone', async () => {
    write('a.md', 'alpha');
    const added = await svc.add(ACCOUNT, projectId, { path: repo });
    await svc.idle();
    await svc.remove(ACCOUNT, projectId, added.id);
    expect(sourceNames()).toEqual([]);
    expect(db.raw.prepare('SELECT count(*) AS n FROM source_chunk').get()).toEqual({ n: 0 });
    expect(await svc.list(ACCOUNT, projectId)).toEqual([]);
    expect(await listProjectFolderRoots(db, projectId)).toEqual([]);
    expect(readFileSync(join(repo, 'a.md'), 'utf8')).toBe('alpha');
    expect(await codeOf(svc.remove(ACCOUNT, projectId, added.id))).toBe('not_found');
    expect(await codeOf(svc.reindex(ACCOUNT, projectId, added.id))).toBe('not_found');
  });

  it('reports a folder that disappeared, and recovers work interrupted by a restart', async () => {
    write('a.md', 'alpha');
    const added = await svc.add(ACCOUNT, projectId, { path: repo });
    await svc.idle();
    rmSync(repo, { recursive: true, force: true });
    await svc.reindex(ACCOUNT, projectId, added.id);
    await svc.idle();
    const broken = await svc.get(ACCOUNT, projectId, added.id);
    expect(broken).toMatchObject({ status: 'error', fileCount: 1 });
    expect(broken.error).toMatch(/missing/);

    mkdirSync(repo, { recursive: true });
    write('b.md', 'beta');
    db.raw.prepare("UPDATE project_folder SET index_status = 'indexing'").run();
    const fresh = make();
    expect(await fresh.recover()).toBe(1);
    await fresh.idle();
    expect(await fresh.get(ACCOUNT, projectId, added.id)).toMatchObject({
      status: 'ready',
      fileCount: 1,
    });
    expect(sourceNames()).toEqual(['repo/b.md']);
    await fresh.stop();
  });
});

describe('ignore rules', () => {
  it('matches names anywhere, anchored paths at the top, and folders only with a slash', () => {
    const r = new IgnoreRules('*.tmp\n/dist-local\ncache/\ndocs/**/draft.md\n!x\n\n');
    expect(r.size).toBe(4);
    expect(r.ignores('a/b/c.tmp', false)).toBe(true);
    expect(r.ignores('dist-local', true)).toBe(true);
    expect(r.ignores('sub/dist-local', true)).toBe(false);
    expect(r.ignores('cache', true)).toBe(true);
    expect(r.ignores('cache', false)).toBe(false);
    expect(r.ignores('docs/a/b/draft.md', false)).toBe(true);
    expect(r.ignores('x', false)).toBe(false);
  });
});
