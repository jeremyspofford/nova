// The fake Hub's M5 Code part: environments, Code sessions, changes with hunk decisions,
// comments, reviews, commits and symbols, plus the routes src/api.ts does not have yet (a
// session terminal and the agent's exec sessions, src/code/extras.ts).
/* eslint-disable @typescript-eslint/require-await */
import type {
  CodeChangeView,
  CodeReviewView,
  CodeSessionView,
  CodeSymbolView,
  CommitResult,
  DiffCommentView,
  DiffHunkView,
  EnvironmentView,
  ReviewFindingView,
  TerminalView,
} from '@nova/shared';
import { ApiError, type Api } from '../src/api.ts';
import type { CodeExtrasApi, ExecSessionView } from '../src/code/extras.ts';

export interface M5CodeState {
  environments: EnvironmentView[];
  sessions: CodeSessionView[];
  changes: CodeChangeView[];
  comments: DiffCommentView[];
  reviews: CodeReviewView[];
  symbols: CodeSymbolView[];
  /** What the next review returns: its status and findings. */
  nextReview: { status: CodeReviewView['status']; findings: ReviewFindingView[] };
  /** Added to every commit result, e.g. `{hooksRan: false}`. */
  commitExtra: Record<string, unknown>;
  /** Commit requests, in order. */
  commits: { sessionId: string; body: Record<string, unknown> }[];
  /** Comment batches as posted, in order. */
  submitted: { sessionId: string; comments: unknown[]; submit: boolean }[];
  /** Exec sessions the agent left running (FR-184). */
  exec: ExecSessionView[];
  /** Session terminals started through POST /code/sessions/:id/terminal. */
  terminals: TerminalView[];
  /** Make the next call to one of the extra routes fail. */
  failExtras: Partial<Record<keyof CodeExtrasApi, Error>>;
  /** Called with each created session, e.g. to add its thread to the fake. */
  onCreate: ((s: CodeSessionView) => void) | null;
}

export function m5CodeState(init: Partial<M5CodeState> = {}): M5CodeState {
  return {
    environments: [],
    sessions: [],
    changes: [],
    comments: [],
    reviews: [],
    symbols: [],
    nextReview: { status: 'done', findings: [] },
    commitExtra: {},
    commits: [],
    submitted: [],
    exec: [],
    terminals: [],
    failExtras: {},
    onCreate: null,
    ...init,
  };
}

// ---- builders --------------------------------------------------------------------------------

let n = 0;
const at = (s = 0) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();

export function environment(over: Partial<EnvironmentView> = {}): EnvironmentView {
  return {
    id: `env-${++n}`,
    kind: 'local',
    label: 'This Hub',
    status: 'ok',
    detail: null,
    checkedAt: at(),
    ...over,
  };
}

export function codeSession(over: Partial<CodeSessionView> = {}): CodeSessionView {
  const id = over.id ?? `cs-${++n}`;
  return {
    id,
    threadId: `t-${id}`,
    title: 'Fix the flaky test',
    environmentId: null,
    folder: { path: '/home/me/app', projectFolderId: null },
    repo: { root: '/home/me/app', branch: 'feature/x', head: 'abc1234', dirty: false },
    worktreeId: null,
    permissionMode: 'manual',
    model: null,
    pullRequestUrl: null,
    ciStatus: null,
    derived: { status: 'ready', reason: null },
    createdAt: at(),
    updatedAt: at(n),
    ...over,
  };
}

export function hunk(over: Partial<DiffHunkView> = {}): DiffHunkView {
  return {
    id: '1-1',
    header: '@@ -1,2 +1,2 @@',
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [
      { kind: 'context', text: 'import { sum } from "./sum";', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'const total = sum(1, 2);', oldNo: 2, newNo: null },
      { kind: 'add', text: 'const total = sum(1, 3);', oldNo: null, newNo: 2 },
    ],
    state: 'pending',
    ...over,
  };
}

export function codeChange(sessionId: string, over: Partial<CodeChangeView> = {}): CodeChangeView {
  return {
    id: `ch-${++n}`,
    sessionId,
    path: 'src/total.ts',
    kind: 'modify',
    oldPath: null,
    additions: 1,
    deletions: 1,
    callId: 'call-1',
    state: 'pending',
    hunks: [hunk()],
    binary: false,
    createdAt: at(),
    ...over,
  };
}

/** A change's state from its hunks: pending, accepted, rejected, or partly accepted. */
function stateOf(c: CodeChangeView): CodeChangeView['state'] {
  if (c.binary) return c.state;
  const s = new Set(c.hunks.map((h) => h.state));
  if (s.size === 1) return [...s][0]!;
  return s.has('accepted') ? 'partial' : s.has('pending') ? 'pending' : 'rejected';
}

export type M5CodeApi = Pick<
  Api,
  | 'listEnvironments'
  | 'listCodeSessions'
  | 'createCodeSession'
  | 'getCodeSession'
  | 'updateCodeSession'
  | 'listChanges'
  | 'decideHunks'
  | 'decideAll'
  | 'listComments'
  | 'addComments'
  | 'resolveComment'
  | 'startReview'
  | 'getReview'
  | 'commit'
  | 'codeSymbols'
> &
  CodeExtrasApi;

export function m5CodeImpl(
  st: M5CodeState,
  helpers: { id: (prefix: string) => string; ts: () => string; maybeFail: (n: keyof Api) => void },
): M5CodeApi {
  const { id: newId, ts, maybeFail } = helpers;
  const notFound = () =>
    new ApiError(404, { code: 'not_found', message: 'Not found', retryable: false });
  const session = (id: string) => {
    const s = st.sessions.find((x) => x.id === id);
    if (!s) throw notFound();
    return s;
  };
  const failExtra = (name: keyof CodeExtrasApi) => {
    const err = st.failExtras[name];
    if (err) {
      delete st.failExtras[name];
      throw err;
    }
  };
  const replaceChange = (c: CodeChangeView) => {
    const next = { ...c, state: stateOf(c) };
    st.changes = st.changes.map((x) => (x.id === c.id ? next : x));
    return next;
  };
  return {
    listEnvironments: async () => {
      maybeFail('listEnvironments');
      return { items: st.environments };
    },
    listCodeSessions: async () => {
      maybeFail('listCodeSessions');
      return { items: st.sessions };
    },
    createCodeSession: async (body) => {
      maybeFail('createCodeSession');
      const s = codeSession({
        id: newId('cs'),
        title: body.title ?? null,
        environmentId: body.environmentId ?? null,
        folder: { path: body.folder, projectFolderId: null },
        permissionMode: body.permissionMode ?? 'manual',
        model: body.model ?? null,
        createdAt: ts(),
        updatedAt: ts(),
      });
      st.sessions = [s, ...st.sessions];
      st.onCreate?.(s);
      return s;
    },
    getCodeSession: async (id) => {
      maybeFail('getCodeSession');
      return session(id);
    },
    updateCodeSession: async (id, body) => {
      maybeFail('updateCodeSession');
      const next: CodeSessionView = {
        ...session(id),
        ...(body.permissionMode ? { permissionMode: body.permissionMode } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.model ? { model: body.model } : {}),
        updatedAt: ts(),
      };
      st.sessions = st.sessions.map((s) => (s.id === id ? next : s));
      return next;
    },
    listChanges: async (id) => {
      maybeFail('listChanges');
      return { items: st.changes.filter((c) => c.sessionId === id) };
    },
    decideHunks: async (_id, changeId, body) => {
      maybeFail('decideHunks');
      const c = st.changes.find((x) => x.id === changeId);
      if (!c) throw notFound();
      const want = new Map(body.decisions.map((d) => [d.hunkId, d.accept]));
      return replaceChange({
        ...c,
        hunks: c.hunks.map((h) => {
          const ok = want.get(h.id);
          return ok === undefined ? h : { ...h, state: ok ? 'accepted' : 'rejected' };
        }),
      });
    },
    decideAll: async (id, accept, changeIds) => {
      maybeFail('decideAll');
      const state = accept ? ('accepted' as const) : ('rejected' as const);
      const touched = st.changes.filter(
        (c) => c.sessionId === id && (!changeIds || changeIds.includes(c.id)),
      );
      return {
        items: touched.map((c) =>
          replaceChange({
            ...c,
            ...(c.binary && c.state === 'pending' ? { state } : {}),
            hunks: c.hunks.map((h) => (h.state === 'pending' ? { ...h, state } : h)),
          }),
        ),
      };
    },
    listComments: async (id) => {
      maybeFail('listComments');
      const mine = new Set(st.changes.filter((c) => c.sessionId === id).map((c) => c.id));
      return { items: st.comments.filter((c) => mine.has(c.changeId)) };
    },
    addComments: async (id, body) => {
      maybeFail('addComments');
      session(id);
      st.submitted.push({ sessionId: id, comments: body.comments, submit: !!body.submit });
      const added = body.comments.map((c) => {
        const change = st.changes.find((x) => x.id === c.changeId);
        if (!change) throw notFound();
        const view: DiffCommentView = {
          id: newId('dc'),
          changeId: c.changeId,
          path: change.path,
          line: c.line,
          side: c.side,
          body: c.body,
          resolved: false,
          createdAt: ts(),
        };
        return view;
      });
      st.comments = [...st.comments, ...added];
      return { items: added };
    },
    resolveComment: async (_id, commentId) => {
      maybeFail('resolveComment');
      const c = st.comments.find((x) => x.id === commentId);
      if (!c) throw notFound();
      const next = { ...c, resolved: true };
      st.comments = st.comments.map((x) => (x.id === commentId ? next : x));
      return next;
    },
    startReview: async (id) => {
      maybeFail('startReview');
      session(id);
      const r: CodeReviewView = {
        id: newId('rv'),
        sessionId: id,
        status: st.nextReview.status,
        findings: st.nextReview.status === 'done' ? st.nextReview.findings : [],
        createdAt: ts(),
      };
      st.reviews = [...st.reviews, r];
      return r;
    },
    getReview: async (_id, reviewId) => {
      maybeFail('getReview');
      const r = st.reviews.find((x) => x.id === reviewId);
      if (!r) throw notFound();
      return r;
    },
    commit: async (id, body) => {
      maybeFail('commit');
      const s = session(id);
      st.commits.push({ sessionId: id, body: { ...body } });
      const branch = body.branch ?? s.repo?.branch ?? 'main';
      const files = st.changes.filter((c) => c.sessionId === id).length;
      st.sessions = st.sessions.map((x) =>
        x.id === id && x.repo ? { ...x, repo: { ...x.repo, branch, dirty: false } } : x,
      );
      const r: CommitResult = { sha: '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432', branch, files };
      return { ...r, ...st.commitExtra };
    },
    codeSymbols: async (_id, q) => {
      maybeFail('codeSymbols');
      const want = q.toLowerCase();
      return { items: st.symbols.filter((s) => s.name.toLowerCase().includes(want)) };
    },

    // ---- routes not in src/api.ts yet (src/code/extras.ts) ------------------------------------
    createSessionTerminal: async (sessionId) => {
      failExtra('createSessionTerminal');
      const s = session(sessionId);
      const t: TerminalView = {
        id: newId('term'),
        threadId: s.threadId,
        cwd: s.folder.path,
        status: 'running',
        exitCode: null,
        createdAt: ts(),
      };
      st.terminals = [...st.terminals, t];
      return t;
    },
    listExecSessions: async (threadId) => {
      failExtra('listExecSessions');
      return { items: st.exec.filter((e) => e.threadId === threadId) };
    },
    killExecSession: async (id) => {
      failExtra('killExecSession');
      if (!st.exec.some((e) => e.id === id)) throw notFound();
      st.exec = st.exec.filter((e) => e.id !== id);
      return { ok: true } as const;
    },
  };
}
