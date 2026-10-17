// The file browser and editor (FR-039): roots as the tools get them plus project folders,
// containment (`..`, absolute paths, symlinks), protected and credential paths, reading text
// and binaries, saving through the policy gate (allow, deny, an approval that completes the save
// later) and conflicts on a stale base hash.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NovaError, uuidv7 } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  FileService,
  MAX_TEXT_BYTES,
  listProjectFolderRoots,
  loadPermissionProfile,
  resolveToolRoots,
  sha256,
  type AuditRecord,
  type GateOutcome,
  type GateRequest,
  type ToolGate,
  type ToolScope,
} from '../src/index.ts';

const ACCOUNT = '01920000-0000-7000-8000-0000000000f1';
const OTHER = '01920000-0000-7000-8000-0000000000f2';

let dir: string;
let dataDir: string;
let workspace: string;
let shared: string;
let folder: string;
let db: NovaDatabase;
let projectId: string;
let threadId: string;

async function openDb(): Promise<NovaDatabase> {
  const d = openDatabase({ path: ':memory:' });
  await migrate(d);
  return d;
}

function seed(): void {
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
  threadId = uuidv7();
  db.raw
    .prepare(
      "INSERT INTO thread (id, account_id, project_id, mode, created_at, updated_at) VALUES (?, ?, ?, 'chat', ?, ?)",
    )
    .run(threadId, ACCOUNT, projectId, now, now);
  db.raw
    .prepare(
      `INSERT INTO project_folder (id, project_id, path, access, index_status, created_at, updated_at)
       VALUES (?, ?, ?, 'write', 'ready', ?, ?)`,
    )
    .run(uuidv7(), projectId, folder, now, now);
}

/**
 * Roots resolved as the tools resolve them: the workspace and a read-only shared folder, plus a
 * project's folders, under a built-in permission profile.
 */
function scopeFor(profileId: 'workspace' | 'read-only' = 'workspace') {
  return async (q: { projectId: string | null }): Promise<ToolScope> => {
    const { profile } = await loadPermissionProfile(db, ACCOUNT, profileId);
    const folders = q.projectId ? await listProjectFolderRoots(db, q.projectId) : [];
    const r = resolveToolRoots({
      profile,
      roots: [{ path: shared, access: 'read', label: 'Shared' }, ...folders],
      workspaceDir: workspace,
      home: null,
    });
    return { roots: r.roots, profile: r.profile, network: r.network.mode, deny: r.deny };
  };
}

class FakeGate implements ToolGate {
  readonly calls: GateRequest[] = [];
  next: 'allow' | 'deny' | 'ask' = 'allow';
  #answer: ((o: GateOutcome) => void) | null = null;
  readonly signals: AbortSignal[] = [];

  check(req: GateRequest, signal: AbortSignal): Promise<GateOutcome> {
    this.calls.push(req);
    this.signals.push(signal);
    if (this.next === 'allow')
      return Promise.resolve({ effect: 'allow', reason: 'ok', tier: 'pre_approvable' });
    if (this.next === 'deny')
      return Promise.resolve({
        effect: 'deny',
        reason: 'not here',
        tier: 'pre_approvable',
        stop: false,
      });
    db.raw
      .prepare(
        `INSERT INTO approval (id, account_id, tool_call_id, requested_action, options_json, created_at)
         VALUES (?, ?, ?, 'save', '[]', ?)`,
      )
      .run(uuidv7(), req.accountId, req.callId, new Date().toISOString());
    return new Promise((resolve) => {
      this.#answer = resolve;
      signal.addEventListener('abort', () =>
        resolve({ effect: 'deny', reason: 'cancelled', tier: 'pre_approvable', stop: true }),
      );
    });
  }

  answer(o: GateOutcome): void {
    this.#answer?.(o);
  }

  preview(): never {
    throw new Error('not used');
  }
}

function service(
  gate: ToolGate,
  audit: AuditRecord[] = [],
  profile: 'workspace' | 'read-only' = 'workspace',
) {
  return new FileService({
    db,
    gate,
    audit: { append: (r) => Promise.resolve(void audit.push(r)) },
    scope: scopeFor(profile),
    dataDir,
    workspaceDir: workspace,
  });
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
  dir = mkdtempSync(join(tmpdir(), 'nova-files-'));
  dataDir = join(dir, 'data');
  workspace = join(dataDir, 'workspace');
  shared = join(dir, 'shared');
  folder = join(dir, 'repo');
  for (const d of [workspace, shared, folder, join(dir, 'outside')])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(dataDir, 'nova.db'), 'secret db');
  writeFileSync(join(dir, 'outside', 'secret.txt'), 'outside');
  db = await openDb();
  seed();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('file roots', () => {
  it('lists the account roots, and a thread or project adds its folders', async () => {
    const files = service(new FakeGate());
    expect((await files.roots(ACCOUNT)).map((r) => r.label)).toEqual(['Workspace', 'Shared']);
    const viaThread = await files.roots(ACCOUNT, { threadId });
    expect(viaThread.at(-1)).toEqual({ path: folder, label: 'repo', access: 'write' });
    expect(await files.roots(ACCOUNT, { projectId })).toEqual(viaThread);
    expect(await codeOf(files.roots(OTHER, { threadId }))).toBe('not_found');
    expect(await codeOf(files.roots(OTHER, { projectId }))).toBe('not_found');
  });

  it('caps a project folder at what the profile grants project roots', async () => {
    const files = service(new FakeGate(), [], 'read-only');
    const roots = await files.roots(ACCOUNT, { projectId });
    expect(roots.find((r) => r.path === folder)?.access).toBe('read');
    expect(await listProjectFolderRoots(db, projectId)).toEqual([
      { path: folder, access: 'write', label: 'repo' },
    ]);
  });

  it('drops the folders of a deleted project', async () => {
    db.raw.prepare('UPDATE project SET deleted_at = ? WHERE id = ?').run('2026-01-01', projectId);
    expect(await listProjectFolderRoots(db, projectId)).toEqual([]);
  });
});

describe('listing and reading', () => {
  it('lists folders first, hides credentials and the data folder, keeps links inside', async () => {
    mkdirSync(join(folder, 'src'));
    mkdirSync(join(folder, '.ssh'));
    writeFileSync(join(folder, 'b.md'), '# b');
    writeFileSync(join(folder, 'a.ts'), 'export {};');
    writeFileSync(join(folder, '.netrc'), 'machine x');
    symlinkSync(join(folder, 'a.ts'), join(folder, 'link-in.ts'));
    symlinkSync(join(dir, 'outside', 'secret.txt'), join(folder, 'link-out.txt'));
    const files = service(new FakeGate());
    const items = await files.list(ACCOUNT, folder);
    expect(items.map((i) => i.name)).toEqual(['src', 'a.ts', 'b.md', 'link-in.ts']);
    expect(items[0]).toMatchObject({ path: 'src', kind: 'dir', size: null, mime: null });
    expect(items[1]).toMatchObject({
      path: 'a.ts',
      kind: 'file',
      size: 10,
      mime: 'text/x-typescript',
    });
    expect(await files.list(ACCOUNT, folder, 'src')).toEqual([]);

    // A root that contains the data folder never shows it (only the workspace inside it).
    const wide = new FileService({
      db,
      gate: new FakeGate(),
      audit: { append: () => Promise.resolve() },
      scope: () =>
        Promise.resolve({
          roots: [{ path: dir, access: 'read', label: 'All' }],
          profile: { id: 'p', hash: 'h' },
          network: 'off',
        }),
      dataDir,
      workspaceDir: workspace,
    });
    expect((await wide.list(ACCOUNT, dir)).map((i) => i.name)).not.toContain('data');
    expect(await codeOf(wide.read(ACCOUNT, dir, 'data/nova.db'))).toBe('policy_denied');
  });

  it('keeps every path inside its root', async () => {
    writeFileSync(join(folder, 'ok.txt'), 'fine');
    symlinkSync(join(dir, 'outside'), join(folder, 'escape'));
    const files = service(new FakeGate());
    expect(await codeOf(files.read(ACCOUNT, folder, '../outside/secret.txt'))).toBe(
      'policy_denied',
    );
    expect(await codeOf(files.read(ACCOUNT, folder, join(dir, 'outside', 'secret.txt')))).toBe(
      'policy_denied',
    );
    expect(await codeOf(files.read(ACCOUNT, folder, 'escape/secret.txt'))).toBe('policy_denied');
    expect(await codeOf(files.list(ACCOUNT, folder, '..'))).toBe('policy_denied');
    // Another root's file is not reachable through this root.
    writeFileSync(join(shared, 'other.txt'), 'shared');
    expect(await codeOf(files.read(ACCOUNT, folder, join(shared, 'other.txt')))).toBe(
      'policy_denied',
    );
    // An absolute path inside the root is fine.
    expect((await files.read(ACCOUNT, folder, join(folder, 'ok.txt'))).text).toBe('fine');
    expect(await codeOf(files.list(ACCOUNT, join(dir, 'outside')))).toBe('not_found');
    expect(await codeOf(files.list(ACCOUNT, 'relative/root'))).toBe('not_found');
    expect(await codeOf(files.list(OTHER, folder))).toBe('not_found');
  });

  it('reads text with its hash, binaries without text, and marks read-only files', async () => {
    writeFileSync(join(folder, 'notes.md'), 'hello');
    writeFileSync(join(folder, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    mkdirSync(join(folder, '.git'));
    writeFileSync(join(folder, '.git', 'config'), '[core]');
    writeFileSync(join(shared, 'ro.txt'), 'read only');
    const files = service(new FakeGate());
    const text = await files.read(ACCOUNT, folder, 'notes.md');
    expect(text).toEqual({
      root: folder,
      path: 'notes.md',
      mime: 'text/markdown',
      size: 5,
      text: 'hello',
      sha256: sha256('hello'),
      readOnly: false,
    });
    const bin = await files.read(ACCOUNT, folder, 'pic.png');
    expect(bin).toMatchObject({ mime: 'image/png', text: null, size: 7 });
    expect((await files.read(ACCOUNT, folder, '.git/config')).readOnly).toBe(true);
    expect((await files.read(ACCOUNT, shared, 'ro.txt')).readOnly).toBe(true);
    expect(await codeOf(files.read(ACCOUNT, folder, 'missing.txt'))).toBe('not_found');
    expect(await codeOf(files.read(ACCOUNT, folder, ''))).toBe('validation');
    expect(await codeOf(files.list(ACCOUNT, folder, 'notes.md'))).toBe('validation');
    mkdirSync(join(folder, '.aws'));
    writeFileSync(join(folder, '.aws', 'credentials'), 'key');
    expect(await codeOf(files.read(ACCOUNT, folder, '.aws/credentials'))).toBe('policy_denied');
  });

  it('returns no text for files over 5 MB but still hashes them', async () => {
    const big = Buffer.alloc(MAX_TEXT_BYTES + 10, 'a');
    writeFileSync(join(folder, 'big.txt'), big);
    const files = service(new FakeGate());
    const view = await files.read(ACCOUNT, folder, 'big.txt');
    expect(view).toMatchObject({ text: null, size: big.length, sha256: sha256(big) });
  });

  it('locates raw bytes for files only', async () => {
    writeFileSync(join(folder, 'pic.png'), 'x');
    const files = service(new FakeGate());
    expect(await files.raw(ACCOUNT, folder, 'pic.png')).toEqual({
      path: join(folder, 'pic.png'),
      name: 'pic.png',
      mime: 'image/png',
      size: 1,
    });
    expect(await codeOf(files.raw(ACCOUNT, folder, '.'))).toBe('validation');
  });
});

describe('saving', () => {
  it('saves through the gate as fs.write from the UI, atomically, keeping the file mode', async () => {
    writeFileSync(join(folder, 'run.sh'), 'echo 1');
    chmodSync(join(folder, 'run.sh'), 0o750);
    const gate = new FakeGate();
    const audit: AuditRecord[] = [];
    const files = service(gate, audit);
    const out = await files.save(ACCOUNT, {
      root: folder,
      path: 'run.sh',
      text: 'echo 2',
      baseSha256: sha256('echo 1'),
    });
    expect(out).toEqual({
      status: 'saved',
      file: expect.objectContaining({ path: 'run.sh', text: 'echo 2', sha256: sha256('echo 2') }),
    });
    expect(readFileSync(join(folder, 'run.sh'), 'utf8')).toBe('echo 2');
    expect(statSync(join(folder, 'run.sh')).mode & 0o777).toBe(0o750);
    const req = gate.calls[0]!;
    expect(req).toMatchObject({
      accountId: ACCOUNT,
      origin: 'ui',
      projectId,
      tool: { name: 'fs.write' },
      resource: { kind: 'path', value: join(folder, 'run.sh') },
      provenance: { taint: [], userInstruction: { accountId: ACCOUNT } },
      args: { path: join(folder, 'run.sh'), content: 'echo 2' },
    });
    expect(audit).toEqual([
      expect.objectContaining({ kind: 'fs', action: 'fs.write', actor: 'user', result: 'ok' }),
    ]);
  });

  it('creates new files and their folders, and refuses stale or wrong bases', async () => {
    const files = service(new FakeGate());
    await files.save(ACCOUNT, {
      root: workspace,
      path: 'a/b/new.txt',
      text: 'x',
      baseSha256: null,
    });
    expect(readFileSync(join(workspace, 'a', 'b', 'new.txt'), 'utf8')).toBe('x');
    const exists = files.save(ACCOUNT, {
      root: workspace,
      path: 'a/b/new.txt',
      text: 'y',
      baseSha256: null,
    });
    await expect(exists).rejects.toMatchObject({ code: 'conflict', details: { reason: 'exists' } });
    const stale = files.save(ACCOUNT, {
      root: workspace,
      path: 'a/b/new.txt',
      text: 'y',
      baseSha256: sha256('old'),
    });
    await expect(stale).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'changed', sha256: sha256('x') },
    });
    const gone = files.save(ACCOUNT, {
      root: workspace,
      path: 'gone.txt',
      text: 'y',
      baseSha256: sha256('x'),
    });
    await expect(gone).rejects.toMatchObject({ code: 'conflict', details: { reason: 'deleted' } });
    expect(readFileSync(join(workspace, 'a', 'b', 'new.txt'), 'utf8')).toBe('x');
  });

  it('refuses read-only roots, protected paths and oversized text before the gate', async () => {
    writeFileSync(join(shared, 'ro.txt'), 'r');
    mkdirSync(join(folder, '.git'));
    const gate = new FakeGate();
    const files = service(gate);
    const base = { baseSha256: null };
    expect(
      await codeOf(files.save(ACCOUNT, { root: shared, path: 'x.txt', text: 'x', ...base })),
    ).toBe('policy_denied');
    expect(
      await codeOf(files.save(ACCOUNT, { root: folder, path: '.git/hooks/x', text: 'x', ...base })),
    ).toBe('policy_denied');
    expect(
      await codeOf(files.save(ACCOUNT, { root: folder, path: '../outside/x', text: 'x', ...base })),
    ).toBe('policy_denied');
    expect(await codeOf(files.save(ACCOUNT, { root: folder, path: '.', text: 'x', ...base }))).toBe(
      'validation',
    );
    const huge = 'é'.repeat(MAX_TEXT_BYTES / 2 + 1);
    expect(
      await codeOf(files.save(ACCOUNT, { root: folder, path: 'h.txt', text: huge, ...base })),
    ).toBe('validation');
    expect(gate.calls).toHaveLength(0);
  });

  it('a denied save writes nothing', async () => {
    const gate = new FakeGate();
    gate.next = 'deny';
    const files = service(gate);
    const out = files.save(ACCOUNT, { root: folder, path: 'n.txt', text: 'x', baseSha256: null });
    await expect(out).rejects.toMatchObject({ code: 'policy_denied', message: 'not here' });
    expect(existsSync(join(folder, 'n.txt'))).toBe(false);
  });

  it('an approval-gated save returns the approval and completes once granted', async () => {
    const gate = new FakeGate();
    gate.next = 'ask';
    const audit: AuditRecord[] = [];
    const files = service(gate, audit);
    const out = await files.save(ACCOUNT, {
      root: folder,
      path: 'later.txt',
      text: 'approved text',
      baseSha256: null,
    });
    if (out.status !== 'pending') throw new Error('expected an approval');
    const row = db.raw
      .prepare('SELECT tool_call_id AS callId FROM approval WHERE id = ?')
      .get(out.approvalId) as { callId: string };
    expect(row.callId).toBe(gate.calls[0]!.callId);
    expect(existsSync(join(folder, 'later.txt'))).toBe(false);
    gate.answer({
      effect: 'allow',
      reason: 'approved',
      tier: 'pre_approvable',
      approvalId: out.approvalId,
    });
    const saved = await out.done;
    expect(saved.text).toBe('approved text');
    expect(readFileSync(join(folder, 'later.txt'), 'utf8')).toBe('approved text');
    expect(audit[0]?.detail).toMatchObject({ approvalId: out.approvalId });
  });

  it('an approved save still refuses a file that changed while it waited; a denial writes nothing', async () => {
    const gate = new FakeGate();
    gate.next = 'ask';
    const files = service(gate);
    writeFileSync(join(folder, 'f.txt'), 'v1');
    const out = await files.save(ACCOUNT, {
      root: folder,
      path: 'f.txt',
      text: 'mine',
      baseSha256: sha256('v1'),
    });
    if (out.status !== 'pending') throw new Error('expected an approval');
    writeFileSync(join(folder, 'f.txt'), 'theirs');
    gate.answer({ effect: 'allow', reason: 'ok', tier: 'pre_approvable' });
    await expect(out.done).rejects.toMatchObject({ code: 'conflict' });
    expect(readFileSync(join(folder, 'f.txt'), 'utf8')).toBe('theirs');

    const again = await files.save(ACCOUNT, {
      root: folder,
      path: 'f.txt',
      text: 'mine',
      baseSha256: sha256('theirs'),
    });
    if (again.status !== 'pending') throw new Error('expected an approval');
    gate.answer({
      effect: 'deny',
      reason: 'no',
      tier: 'pre_approvable',
      stop: false,
      timeout: true,
    });
    await expect(again.done).rejects.toMatchObject({
      code: 'policy_denied',
      details: { reason: 'timeout', approvalId: again.approvalId },
    });
  });

  it('close cancels saves waiting for an approval', async () => {
    const gate = new FakeGate();
    gate.next = 'ask';
    const files = service(gate);
    const out = await files.save(ACCOUNT, {
      root: folder,
      path: 'c.txt',
      text: 'x',
      baseSha256: null,
    });
    if (out.status !== 'pending') throw new Error('expected an approval');
    await files.close();
    expect(gate.signals[0]?.aborted).toBe(true);
    await expect(out.done).rejects.toMatchObject({ code: 'policy_denied' });
    expect(existsSync(join(folder, 'c.txt'))).toBe(false);
  });
});
