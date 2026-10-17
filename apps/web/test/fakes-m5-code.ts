// The fake Hub's M5 Code part: environments, Code sessions, changes, comments, reviews and
// commits. A minimal in-memory version; the Code UI extends it with the behaviour its tests need.
/* eslint-disable @typescript-eslint/require-await */
import type {
  CodeChangeView,
  CodeReviewView,
  CodeSessionView,
  CodeSymbolView,
  DiffCommentView,
  EnvironmentView,
} from '@nova/shared';
import { ApiError, type Api } from '../src/api.ts';

export interface M5CodeState {
  environments: EnvironmentView[];
  sessions: CodeSessionView[];
  changes: CodeChangeView[];
  comments: DiffCommentView[];
  reviews: CodeReviewView[];
  symbols: CodeSymbolView[];
}

export function m5CodeState(init: Partial<M5CodeState> = {}): M5CodeState {
  return {
    environments: [],
    sessions: [],
    changes: [],
    comments: [],
    reviews: [],
    symbols: [],
    ...init,
  };
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
>;

export function m5CodeImpl(
  st: M5CodeState,
  helpers: { id: (prefix: string) => string; ts: () => string; maybeFail: (n: keyof Api) => void },
): M5CodeApi {
  const { maybeFail } = helpers;
  const notFound = () =>
    new ApiError(404, { code: 'not_found', message: 'Not found', retryable: false });
  const session = (id: string) => {
    const s = st.sessions.find((x) => x.id === id);
    if (!s) throw notFound();
    return s;
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
    createCodeSession: async () => {
      maybeFail('createCodeSession');
      throw notFound();
    },
    getCodeSession: async (id) => {
      maybeFail('getCodeSession');
      return session(id);
    },
    updateCodeSession: async (id) => {
      maybeFail('updateCodeSession');
      return session(id);
    },
    listChanges: async (id) => {
      maybeFail('listChanges');
      return { items: st.changes.filter((c) => c.sessionId === id) };
    },
    decideHunks: async (_id, changeId) => {
      maybeFail('decideHunks');
      const c = st.changes.find((x) => x.id === changeId);
      if (!c) throw notFound();
      return c;
    },
    decideAll: async (id) => {
      maybeFail('decideAll');
      return { items: st.changes.filter((c) => c.sessionId === id) };
    },
    listComments: async () => {
      maybeFail('listComments');
      return { items: st.comments };
    },
    addComments: async () => {
      maybeFail('addComments');
      return { items: [] };
    },
    resolveComment: async (_id, commentId) => {
      maybeFail('resolveComment');
      const c = st.comments.find((x) => x.id === commentId);
      if (!c) throw notFound();
      return c;
    },
    startReview: async () => {
      maybeFail('startReview');
      throw notFound();
    },
    getReview: async (_id, reviewId) => {
      maybeFail('getReview');
      const r = st.reviews.find((x) => x.id === reviewId);
      if (!r) throw notFound();
      return r;
    },
    commit: async () => {
      maybeFail('commit');
      throw notFound();
    },
    codeSymbols: async () => {
      maybeFail('codeSymbols');
      return { items: st.symbols };
    },
  };
}
