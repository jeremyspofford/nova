import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Api } from '../src/api.ts';
import {
  diffTotals,
  lineAnchor,
  mergeChanges,
  pairLines,
  splitRows,
  tokenize,
  wordDiff,
  type DiffLine,
} from '../src/code/diff.ts';
import { codeExtras } from '../src/code/extras.ts';
import { lineRange } from '../src/code/FilePane.tsx';
import {
  branchProblem,
  defaultBranch,
  onDefaultBranch,
  shortSha,
  slugify,
  suggestBranch,
} from '../src/code/git.ts';
import { branchText, sessionTitle, sortSessions } from '../src/code/labels.ts';
import { initialMode, modeOptions, modeUnavailable, type ModeContext } from '../src/code/modes.ts';
import { groupFindings, reviewSummary } from '../src/code/ReviewPane.tsx';
import { fenced } from '../src/code/SessionView.tsx';
import { codeChange, codeSession, hunk } from './fakes-m5-code.ts';

const line = (
  kind: DiffLine['kind'],
  text: string,
  oldNo: number | null,
  newNo: number | null,
) => ({ kind, text, oldNo, newNo });

describe('word-level diff (FR-064)', () => {
  it('marks only the words that changed in a modified line', () => {
    const d = wordDiff('const total = sum(1, 2);', 'const total = sum(1, 3);')!;
    expect(d.old.filter((s) => s.changed).map((s) => s.text)).toEqual(['2']);
    expect(d.new.filter((s) => s.changed).map((s) => s.text)).toEqual(['3']);
    expect(d.old.map((s) => s.text).join('')).toBe('const total = sum(1, 2);');
    expect(d.new.map((s) => s.text).join('')).toBe('const total = sum(1, 3);');
  });

  it('gives no marks when the lines share nothing, are equal or are too long', () => {
    expect(wordDiff('alpha', 'beta')).toBeNull();
    expect(wordDiff('same line', 'same line')).toBeNull();
    expect(wordDiff('', 'x')).toBeNull();
    const long = Array.from({ length: 500 }, (_, i) => `w${i}`).join(' ');
    expect(wordDiff(long, `${long} more`)).toBeNull();
  });

  it('tokenizes words, spaces and punctuation', () => {
    expect(tokenize('a.b(c)  d')).toEqual(['a', '.', 'b', '(', 'c', ')', '  ', 'd']);
    expect(tokenize('')).toEqual([]);
  });

  it('pairs removed and added lines block by block, and lines them up for the split view', () => {
    const lines = [
      line('context', 'a', 1, 1),
      line('del', 'b', 2, null),
      line('del', 'c', 3, null),
      line('add', 'B', null, 2),
      line('context', 'd', 4, 3),
      line('add', 'e', null, 4),
    ];
    const pairs = pairLines(lines);
    expect(pairs.get(1)).toBe(3);
    expect(pairs.get(3)).toBe(1);
    expect(pairs.has(2)).toBe(false);
    expect(pairs.has(5)).toBe(false);
    expect(splitRows(lines)).toEqual([
      { old: 0, new: 0 },
      { old: 1, new: 3 },
      { old: 2, new: null },
      { old: 4, new: 4 },
      { old: null, new: 5 },
    ]);
  });

  it('anchors comments: removed lines on the old side, others on the new', () => {
    expect(lineAnchor(line('del', 'x', 7, null))).toEqual({ side: 'old', line: 7 });
    expect(lineAnchor(line('add', 'x', null, 9))).toEqual({ side: 'new', line: 9 });
    expect(lineAnchor(line('context', 'x', 3, 4))).toEqual({ side: 'new', line: 4 });
    expect(lineAnchor(line('add', 'x', null, null))).toBeNull();
  });

  it('totals files, lines and pending hunks, and merges updated changes in place', () => {
    const a = codeChange('s', { additions: 3, deletions: 1 });
    const b = codeChange('s', {
      binary: true,
      hunks: [],
      additions: 0,
      deletions: 0,
      state: 'pending',
    });
    const c = codeChange('s', { hunks: [hunk({ state: 'accepted' })], state: 'accepted' });
    expect(diffTotals([a, b, c])).toEqual({
      files: 3,
      additions: 4,
      deletions: 2,
      pendingHunks: 2,
    });
    const a2 = { ...a, state: 'accepted' as const };
    const d = codeChange('s');
    expect(mergeChanges([a, b], [a2, d]).map((x) => x.id)).toEqual([a.id, b.id, d.id]);
    expect(mergeChanges([a, b], [a2])[0]!.state).toBe('accepted');
  });
});

describe('Git helpers (FR-070)', () => {
  it('suggests nova/<slug> from the first line of the message', () => {
    expect(slugify('Fix the flaky login test!')).toBe('fix-the-flaky-login-test');
    expect(suggestBranch('Fix: handle empty input\n\nMore detail')).toBe(
      'nova/fix-handle-empty-input',
    );
    expect(suggestBranch('', 'Session title')).toBe('nova/session-title');
    expect(suggestBranch('', '')).toBe('nova/changes');
    expect(slugify('a'.repeat(60))).toHaveLength(40);
    expect(slugify('one two three four five six seven eight nine ten', 20)).toBe(
      'one-two-three-four',
    );
  });

  it('knows the default branch and checks branch names', () => {
    const repo = { root: '/r', branch: 'main', head: null, dirty: false };
    expect(defaultBranch(repo)).toBe('main');
    expect(onDefaultBranch(repo)).toBe(true);
    expect(onDefaultBranch({ ...repo, branch: 'feature' })).toBe(false);
    expect(onDefaultBranch({ ...repo, branch: 'trunk', defaultBranch: 'trunk' })).toBe(true);
    expect(onDefaultBranch(null)).toBe(false);
    expect(onDefaultBranch({ ...repo, branch: null })).toBe(false);
    expect(branchProblem('nova/fix', 'main')).toBeNull();
    expect(branchProblem('  ', 'main')).toMatch(/Enter a branch/);
    expect(branchProblem('main', 'main')).toMatch(/other than main/);
    for (const bad of ['has space', 'a..b', '/lead', 'trail/', 'x.lock', 'a~b'])
      expect(branchProblem(bad, 'main')).toMatch(/Use letters/);
    expect(shortSha('9f8e7d6c5b4a')).toBe('9f8e7d6');
  });
});

describe('permission modes (FR-063)', () => {
  const ctx = (over: Partial<ModeContext> = {}): ModeContext => ({
    reviewerModel: null,
    allowBypass: false,
    environment: { kind: 'local' },
    ...over,
  });

  it('explains why Auto and Bypass cannot be picked', () => {
    expect(modeUnavailable('manual', ctx())).toBeNull();
    expect(modeUnavailable('plan', ctx())).toBeNull();
    expect(modeUnavailable('auto', ctx())).toMatch(/reviewer model/);
    expect(modeUnavailable('auto', ctx({ reviewerModel: 'pa1/mock-smart' }))).toBeNull();
    expect(modeUnavailable('bypass', ctx())).toMatch(/VM or container environment and Allow/);
    expect(modeUnavailable('bypass', ctx({ allowBypass: true }))).toMatch(/^needs a VM/);
    expect(modeUnavailable('bypass', ctx({ environment: { kind: 'container' } }))).toMatch(
      /^needs Allow Bypass/,
    );
    expect(
      modeUnavailable('bypass', ctx({ environment: { kind: 'vm' }, allowBypass: true })),
    ).toBeNull();
    // The Hub's local environment on a container sandbox counts as isolated, as the Hub decides.
    expect(
      modeUnavailable(
        'bypass',
        ctx({ environment: { kind: 'local', isolated: true }, allowBypass: true }),
      ),
    ).toBeNull();
    const opts = modeOptions(ctx());
    expect(opts.find((o) => o.value === 'auto')).toMatchObject({
      disabled: true,
      label: 'Auto (needs a reviewer model in Settings → Code)',
    });
    expect(opts.find((o) => o.value === 'manual')).toMatchObject({ disabled: false });
  });

  it('starts a folder in its remembered mode, else the default, else Manual', () => {
    const defaults = {
      permissionMode: 'accept_edits' as const,
      folderModes: { '/a': 'auto' as const },
    };
    expect(initialMode('/b', defaults, ctx())).toBe('accept_edits');
    expect(initialMode('/a', defaults, ctx())).toBe('manual');
    expect(initialMode('/a', defaults, ctx({ reviewerModel: 'm' }))).toBe('auto');
  });
});

describe('review and session text (FR-069, FR-215)', () => {
  it('groups findings by file, worst first, and summarizes them', () => {
    const f = (path: string, severity: 'info' | 'warn' | 'error', line: number | null) => ({
      id: `${path}${line}`,
      path,
      line,
      severity,
      title: 't',
      reasoning: 'r',
      fix: null,
    });
    const groups = groupFindings([
      f('b.ts', 'info', 3),
      f('a.ts', 'warn', 9),
      f('b.ts', 'error', 7),
      f('a.ts', 'error', 1),
      f('c.ts', 'info', null),
    ]);
    expect(groups.map((g) => g.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(groups[1]!.findings.map((x) => x.severity)).toEqual(['error', 'info']);
    expect(reviewSummary([f('a', 'error', 1), f('a', 'warn', 2), f('a', 'warn', 3)])).toBe(
      '3 findings: 1 error, 2 warnings.',
    );
    expect(reviewSummary([])).toBe('No findings.');
  });

  it('fences text so its own backticks cannot close the block', () => {
    expect(fenced('x')).toBe('```\nx\n```');
    expect(fenced('a ```` b')).toBe('`````\na ```` b\n`````');
  });

  it('finds a line in text', () => {
    expect(lineRange('a\nbb\nccc', 2)).toEqual({ start: 2, end: 4 });
    expect(lineRange('a\nbb', 9)).toEqual({ start: 2, end: 4 });
    expect(lineRange('only', 1)).toEqual({ start: 0, end: 4 });
  });

  it('names sessions and sorts them Needs input first', () => {
    const s = codeSession({
      title: null,
      folder: { path: '/home/me/garden', projectFolderId: null },
    });
    expect(sessionTitle(s)).toBe('garden');
    expect(branchText(null)).toBe('Not a Git repository');
    expect(branchText({ root: '/', branch: null, head: null, dirty: true })).toBe(
      'Detached HEAD, uncommitted changes',
    );
    const ready = codeSession({ updatedAt: '2026-10-01T12:00:09Z' });
    const needs = codeSession({ derived: { status: 'needs_input', reason: 'Approval needed' } });
    const blocked = codeSession({ derived: { status: 'blocked', reason: null } });
    const newer = codeSession({ updatedAt: '2026-10-02T12:00:00Z' });
    expect(sortSessions([ready, blocked, newer, needs]).map((x) => x.id)).toEqual([
      needs.id,
      blocked.id,
      newer.id,
      ready.id,
    ]);
  });
});

describe('extra Hub routes (FR-066, FR-184)', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('calls the routes api.ts lacks, with the client conventions', async () => {
    const fetchImpl = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(
        url.includes('terminal')
          ? json(201, { id: 'term1' })
          : url.includes('exec/sessions?')
            ? json(200, { items: [] })
            : json(200, { ok: true }),
      ),
    );
    const x = codeExtras({} as Api, fetchImpl as unknown as typeof fetch);
    await expect(x.createSessionTerminal('cs 1')).resolves.toEqual({ id: 'term1' });
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/v1/code/sessions/cs%201/terminal');
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: JSON.stringify({ cols: 100, rows: 30 }),
    });
    await x.listExecSessions('t1');
    expect(fetchImpl.mock.calls[1]![0]).toBe('/api/v1/exec/sessions?threadId=t1');
    await x.killExecSession('ex1');
    expect(fetchImpl.mock.calls[2]![1]).toMatchObject({ method: 'DELETE' });
  });

  it('turns an error reply into an ApiError, and prefers methods the client has', async () => {
    const fail = vi.fn(() =>
      Promise.resolve(
        json(409, {
          error: { code: 'sandbox_unavailable', message: 'No sandbox', retryable: false },
        }),
      ),
    );
    const x = codeExtras({} as Api, fail);
    const err = await x.createSessionTerminal('s').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body.code).toBe('sandbox_unavailable');
    const bare = vi.fn(() => Promise.resolve(new Response('oops', { status: 500 })));
    const e2 = await codeExtras({} as Api, bare as unknown as typeof fetch)
      .listExecSessions('t')
      .catch((e: unknown) => e);
    expect((e2 as ApiError).status).toBe(500);
    const own = vi.fn(() => Promise.resolve({ items: [] }));
    await codeExtras({ listExecSessions: own } as unknown as Api, fail).listExecSessions('t');
    expect(own).toHaveBeenCalledWith('t');
  });
});
