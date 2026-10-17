// The fake Hub's M6 spaces part: Spaces and Pages (FR-036) and Sites (FR-037), in memory, with
// the Hub's conflict rules: a save or restore on a stale base answers 409 `stale_version` with the
// current page, accepting a proposal made on an older version answers 409 `stale_proposal` unless
// forced, deleting a published site answers 409 `published`, and publishing into a folder Nova
// did not fill answers 409 `folder_in_use`. Views handed out are copies and never mutated.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m6spaces: M6SpacesState`,
// `createHub` defaults it to `m6SpacesState()`, and `impl` spreads
// `...m6SpacesImpl(state.m6spaces, { id, ts: () => ts(), maybeFail })`. Until then tests build
// the client with `createSpacesHub()` and spread its `api` over `createHub().api`.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import type { z } from 'zod';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  acceptProposalSchema,
  buildSiteSchema,
  createCommentSchema,
  createPageSchema,
  createSiteSchema,
  createSpaceSchema,
  publishSiteSchema,
  restorePageSchema,
  savePageSchema,
  updatePageSchema,
  updateSiteSchema,
  updateSpaceSchema,
  type CommentAnchor,
  type PageCommentView,
  type PageProposalView,
  type PageSummaryView,
  type PageVersionView,
  type PageView,
  type SiteDataSourceView,
  type SitePublishResult,
  type SitePublishView,
  type SiteVersionView,
  type SiteView,
  type SpaceView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import type { SpacesApi } from '../src/spaces/api.ts';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';

const T0 = '2026-10-01T12:00:00.000Z';
let n = 0;

export function spaceView(over: Partial<SpaceView> = {}): SpaceView {
  return {
    id: `sp${++n}`,
    name: 'Handbook',
    description: null,
    projectId: null,
    agentEdits: 'propose',
    pageCount: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function pageView(over: Partial<PageView> = {}): PageView {
  return {
    id: `pg${++n}`,
    spaceId: 'sp1',
    title: 'Welcome',
    slug: 'welcome',
    position: 0,
    version: 1,
    updatedBy: 'user',
    openComments: 0,
    openProposals: 0,
    content: '# Welcome\n\nHello there.',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function versionView(over: Partial<PageVersionView> = {}): PageVersionView {
  return {
    pageId: 'pg1',
    version: 1,
    title: 'Welcome',
    authorKind: 'user',
    authorRef: null,
    summary: null,
    restoredFrom: null,
    proposalId: null,
    size: 0,
    createdAt: T0,
    ...over,
  };
}

export function commentView(over: Partial<PageCommentView> = {}): PageCommentView {
  return {
    id: `cm${++n}`,
    pageId: 'pg1',
    parentId: null,
    authorKind: 'user',
    authorRef: null,
    body: 'Looks good.',
    anchor: { kind: 'page' },
    version: 1,
    detached: false,
    resolved: false,
    resolvedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function proposalView(over: Partial<PageProposalView> = {}): PageProposalView {
  return {
    id: `pr${++n}`,
    spaceId: 'sp1',
    pageId: 'pg1',
    baseVersion: 1,
    title: 'Welcome',
    content: '# Welcome\n\nHello there, friend.',
    summary: 'Warmer greeting',
    authorKind: 'agent',
    authorRef: 't-agent',
    status: 'open',
    stale: false,
    createdAt: T0,
    decidedAt: null,
    ...over,
  };
}

export function siteView(over: Partial<SiteView> = {}): SiteView {
  return {
    id: `site${++n}`,
    name: 'Handbook site',
    description: null,
    source: { kind: 'space', spaceId: 'sp1' },
    sourceLabel: 'Handbook',
    data: [],
    latestVersion: null,
    publishedVersion: null,
    publishedTarget: null,
    publishedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

export function siteVersionView(over: Partial<SiteVersionView> = {}): SiteVersionView {
  return {
    siteId: 'site1',
    version: 1,
    note: null,
    files: [{ path: 'index.html', size: 1200 }],
    size: 1200,
    sha256: 'a'.repeat(64),
    scripts: false,
    published: false,
    createdAt: T0,
    ...over,
  };
}

export function publishView(over: Partial<SitePublishView> = {}): SitePublishView {
  return {
    id: `pub${++n}`,
    siteId: 'site1',
    version: 1,
    target: { kind: 'zip' },
    current: true,
    revertedAt: null,
    createdAt: T0,
    ...over,
  };
}

export function dataSourceView(over: Partial<SiteDataSourceView> = {}): SiteDataSourceView {
  return {
    id: `src${++n}`,
    name: 'sales.csv',
    mime: 'text/csv',
    size: 320,
    projectId: 'p1',
    projectName: 'Reports',
    ...over,
  };
}

/** A stored page version, with its content. */
export type StoredVersion = PageVersionView & { content: string };

export interface M6SpacesState {
  spaces: SpaceView[];
  pages: PageView[];
  versions: StoredVersion[];
  comments: PageCommentView[];
  proposals: PageProposalView[];
  sites: SiteView[];
  siteVersions: SiteVersionView[];
  publishes: SitePublishView[];
  dataSources: SiteDataSourceView[];
  /** Artifacts a site can be built from; an HTML one may run its own scripts in the preview. */
  artifacts: { id: string; title: string; html: boolean }[];
  /** Folders under the publish root that hold files Nova did not put there. */
  foreignFolders: string[];
}

/** State with a version row for every page's current version that the init did not give. */
export function m6SpacesState(init: Partial<M6SpacesState> = {}): M6SpacesState {
  const st: M6SpacesState = {
    spaces: [],
    pages: [],
    versions: [],
    comments: [],
    proposals: [],
    sites: [],
    siteVersions: [],
    publishes: [],
    dataSources: [],
    artifacts: [],
    foreignFolders: [],
    ...init,
  };
  for (const p of st.pages)
    if (!st.versions.some((v) => v.pageId === p.id && v.version === p.version))
      st.versions.push({
        ...versionView({
          pageId: p.id,
          version: p.version,
          title: p.title,
          authorKind: p.updatedBy,
          size: p.content.length,
          createdAt: p.updatedAt,
        }),
        content: p.content,
      });
  return st;
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, { code, message, retryable: false, ...(details ? { details } : {}) });

const notFound = () => err(404, 'not_found', 'Not found');

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success)
    throw err(400, 'validation', r.error.issues.map((i) => i.message).join('; ') || 'Invalid');
  return r.data;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'page';

/** Move a comment's anchor onto new text: the nearest occurrence of its quote, or detached. */
function reanchor(c: PageCommentView, content: string, version: number): PageCommentView {
  const a = c.anchor;
  if (a.kind === 'page' || c.detached) return { ...c, version };
  const at = content.indexOf(a.quote);
  if (at < 0) return { ...c, version, detached: true };
  if (a.kind === 'block') return { ...c, version };
  let best = at;
  for (let i = at; i >= 0; i = content.indexOf(a.quote, i + 1))
    if (Math.abs(i - a.start) < Math.abs(best - a.start)) best = i;
  const anchor: CommentAnchor = { ...a, start: best, end: best + a.quote.length };
  return { ...c, anchor, version };
}

/** Write a new version of a page and move its comments forward (what every save does). */
export function commitPage(
  st: M6SpacesState,
  p: PageView,
  next: { title: string; content: string },
  meta: Partial<StoredVersion> & { authorKind: 'user' | 'agent' },
  at: string,
): PageView {
  const version = p.version + 1;
  const updated: PageView = { ...p, ...next, version, updatedBy: meta.authorKind, updatedAt: at };
  st.pages = st.pages.map((x) => (x.id === p.id ? updated : x));
  st.versions.push({
    ...versionView({
      pageId: p.id,
      version,
      title: next.title,
      size: next.content.length,
      createdAt: at,
    }),
    ...meta,
    content: next.content,
  });
  st.comments = st.comments.map((c) =>
    c.pageId === p.id ? reanchor(c, next.content, version) : c,
  );
  return { ...updated };
}

/** An agent's direct edit behind the editor's back (a space with agentEdits `direct`). */
export function agentEdit(st: M6SpacesState, pageId: string, content: string): PageView {
  const p = st.pages.find((x) => x.id === pageId);
  if (!p) throw new Error(`no page ${pageId}`);
  return commitPage(
    st,
    p,
    { title: p.title, content },
    { authorKind: 'agent', authorRef: 't-agent', summary: 'Agent edit' },
    '2026-10-02T08:00:00.000Z',
  );
}

export function m6SpacesImpl(
  st: M6SpacesState,
  helpers: {
    id: (p: string) => string;
    ts: () => string;
    maybeFail: (name: keyof SpacesApi) => void;
  },
): SpacesApi {
  const { id, ts, maybeFail } = helpers;

  const space = (sid: string) => {
    const s = st.spaces.find((x) => x.id === sid);
    if (!s) throw notFound();
    return s;
  };
  const spaceOut = (s: SpaceView): SpaceView => ({
    ...s,
    pageCount: st.pages.filter((p) => p.spaceId === s.id).length,
  });
  const page = (sid: string, pid: string) => {
    const p = st.pages.find((x) => x.id === pid && x.spaceId === sid);
    if (!p) throw notFound();
    return p;
  };
  const pageOut = (p: PageView): PageView => ({
    ...p,
    openComments: st.comments.filter((c) => c.pageId === p.id && !c.resolved && !c.parentId).length,
    openProposals: st.proposals.filter((x) => x.pageId === p.id && x.status === 'open').length,
  });
  const summary = (p: PageView): PageSummaryView => {
    const { content: _content, ...rest } = pageOut(p);
    return rest;
  };
  const proposalOut = (x: PageProposalView): PageProposalView => {
    const p = x.pageId ? st.pages.find((q) => q.id === x.pageId) : undefined;
    return { ...x, stale: x.status === 'open' && !!p && x.baseVersion !== p.version };
  };
  const stale = (p: PageView, reason: 'stale_version' | 'stale_proposal') =>
    err(409, 'conflict', 'The page changed since.', { reason, current: pageOut(p) });

  const commit = (
    p: PageView,
    next: { title: string; content: string },
    meta: Partial<StoredVersion> & { authorKind: 'user' | 'agent' },
  ): PageView => pageOut(commitPage(st, p, next, meta, ts()));

  const site = (sid: string) => {
    const s = st.sites.find((x) => x.id === sid);
    if (!s) throw notFound();
    return s;
  };
  const patchSite = (sid: string, patch: Partial<SiteView>): SiteView => {
    const next = { ...site(sid), ...patch, updatedAt: ts() };
    st.sites = st.sites.map((s) => (s.id === sid ? next : s));
    return { ...next };
  };
  const sourceLabel = (src: SiteView['source']) =>
    src.kind === 'space'
      ? (st.spaces.find((s) => s.id === src.spaceId)?.name ?? null)
      : (st.artifacts.find((a) => a.id === src.artifactId)?.title ?? null);
  const zipUrl = (sid: string, v: number) =>
    `/api/v1/sites/${encodeURIComponent(sid)}/versions/${v}/zip`;
  /** Make `pub` the live publish (or none) and mirror it on the site. */
  const goLive = (sid: string, pub: SitePublishView | null): SiteView => {
    st.publishes = st.publishes.map((x) =>
      x.siteId === sid ? { ...x, current: pub !== null && x.id === pub.id } : x,
    );
    return patchSite(sid, {
      publishedVersion: pub?.version ?? null,
      publishedTarget: pub?.target ?? null,
      publishedAt: pub?.createdAt ?? null,
    });
  };
  const result = (s: SiteView, pub: SitePublishView | null): SitePublishResult => ({
    site: s,
    publish: pub ? { ...pub, current: true } : null,
    downloadUrl: pub?.target.kind === 'zip' ? zipUrl(s.id, pub.version) : null,
    folderPath: pub?.target.kind === 'folder' ? `/data/sites/${pub.target.folder}` : null,
  });

  return {
    // ---- spaces and pages ----
    listSpaces: async () => {
      maybeFail('listSpaces');
      return { items: st.spaces.map(spaceOut) };
    },
    createSpace: async (body) => {
      maybeFail('createSpace');
      const b = parse(createSpaceSchema, body);
      const s = spaceView({
        id: id('sp'),
        name: b.name,
        description: b.description ?? null,
        projectId: b.projectId ?? null,
        agentEdits: b.agentEdits ?? 'propose',
        createdAt: ts(),
        updatedAt: ts(),
      });
      st.spaces = [...st.spaces, s];
      return spaceOut(s);
    },
    getSpace: async (sid) => {
      maybeFail('getSpace');
      return spaceOut(space(sid));
    },
    updateSpace: async (sid, body) => {
      maybeFail('updateSpace');
      const b = parse(updateSpaceSchema, body);
      const next: SpaceView = {
        ...space(sid),
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.agentEdits !== undefined ? { agentEdits: b.agentEdits } : {}),
        updatedAt: ts(),
      };
      st.spaces = st.spaces.map((s) => (s.id === sid ? next : s));
      return spaceOut(next);
    },
    deleteSpace: async (sid) => {
      maybeFail('deleteSpace');
      space(sid);
      const gone = new Set(st.pages.filter((p) => p.spaceId === sid).map((p) => p.id));
      st.spaces = st.spaces.filter((s) => s.id !== sid);
      st.pages = st.pages.filter((p) => !gone.has(p.id));
      st.versions = st.versions.filter((v) => !gone.has(v.pageId));
      st.comments = st.comments.filter((c) => !gone.has(c.pageId));
      st.proposals = st.proposals.filter((x) => x.spaceId !== sid);
      return { ok: true as const };
    },
    listSpacePages: async (sid) => {
      maybeFail('listSpacePages');
      space(sid);
      return {
        items: st.pages
          .filter((p) => p.spaceId === sid)
          .sort((a, b) => a.position - b.position)
          .map(summary),
      };
    },
    createSpacePage: async (sid, body) => {
      maybeFail('createSpacePage');
      space(sid);
      const b = parse(createPageSchema, body);
      const siblings = st.pages.filter((p) => p.spaceId === sid);
      const at = ts();
      const p = pageView({
        id: id('pg'),
        spaceId: sid,
        title: b.title,
        slug: b.slug ?? slugify(b.title),
        position: siblings.reduce((m, x) => Math.max(m, x.position + 1), 0),
        content: b.content ?? '',
        createdAt: at,
        updatedAt: at,
      });
      st.pages = [...st.pages, p];
      st.versions.push({
        ...versionView({ pageId: p.id, title: p.title, size: p.content.length, createdAt: at }),
        content: p.content,
      });
      return pageOut(p);
    },
    getSpacePage: async (sid, pid) => {
      maybeFail('getSpacePage');
      return pageOut(page(sid, pid));
    },
    saveSpacePage: async (sid, pid, body) => {
      maybeFail('saveSpacePage');
      const b = parse(savePageSchema, body);
      const p = page(sid, pid);
      if (b.baseVersion !== p.version) throw stale(p, 'stale_version');
      return commit(
        p,
        { title: b.title ?? p.title, content: b.content ?? p.content },
        { authorKind: 'user', summary: b.summary ?? null },
      );
    },
    updateSpacePage: async (sid, pid, body) => {
      maybeFail('updateSpacePage');
      const b = parse(updatePageSchema, body);
      const next = { ...page(sid, pid), ...b };
      st.pages = st.pages.map((p) => (p.id === pid ? next : p));
      return summary(next);
    },
    deleteSpacePage: async (sid, pid) => {
      maybeFail('deleteSpacePage');
      page(sid, pid);
      st.pages = st.pages.filter((p) => p.id !== pid);
      st.versions = st.versions.filter((v) => v.pageId !== pid);
      st.comments = st.comments.filter((c) => c.pageId !== pid);
      // Open proposals for the page end as rejected; decided ones stay as they were.
      st.proposals = st.proposals.map((x) =>
        x.pageId === pid && x.status === 'open'
          ? { ...x, status: 'rejected' as const, decidedAt: ts() }
          : x,
      );
      return { ok: true as const };
    },
    listPageVersions: async (sid, pid) => {
      maybeFail('listPageVersions');
      page(sid, pid);
      return {
        items: st.versions
          .filter((v) => v.pageId === pid)
          .sort((a, b) => b.version - a.version)
          .map(({ content: _c, ...v }) => v),
      };
    },
    getPageVersion: async (sid, pid, version) => {
      maybeFail('getPageVersion');
      page(sid, pid);
      const v = st.versions.find((x) => x.pageId === pid && x.version === version);
      if (!v) throw notFound();
      return { ...v };
    },
    restoreSpacePage: async (sid, pid, body) => {
      maybeFail('restoreSpacePage');
      const b = parse(restorePageSchema, body);
      const p = page(sid, pid);
      if (b.baseVersion !== p.version) throw stale(p, 'stale_version');
      const v = st.versions.find((x) => x.pageId === pid && x.version === b.version);
      if (!v) throw notFound();
      return commit(
        p,
        { title: v.title, content: v.content },
        { authorKind: 'user', restoredFrom: v.version },
      );
    },
    listPageComments: async (sid, pid) => {
      maybeFail('listPageComments');
      page(sid, pid);
      return { items: st.comments.filter((c) => c.pageId === pid).map((c) => ({ ...c })) };
    },
    createPageComment: async (sid, pid, body) => {
      maybeFail('createPageComment');
      const b = parse(createCommentSchema, body);
      const p = page(sid, pid);
      const version = b.version ?? p.version;
      const text = st.versions.find((v) => v.pageId === pid && v.version === version)?.content;
      if (text === undefined) throw notFound();
      const anchor = b.anchor ?? { kind: 'page' as const };
      if (anchor.kind === 'range' && text.slice(anchor.start, anchor.end) !== anchor.quote)
        throw err(400, 'validation', 'the quoted text is not at that place in the page', {
          reason: 'anchor_mismatch',
        });
      if (b.parentId && !st.comments.some((c) => c.id === b.parentId && c.pageId === pid))
        throw notFound();
      const at = ts();
      let c = commentView({
        id: id('cm'),
        pageId: pid,
        parentId: b.parentId ?? null,
        body: b.body,
        anchor,
        version,
        createdAt: at,
        updatedAt: at,
      });
      // A comment on an older version moves forward to the current text at once.
      if (version !== p.version) c = reanchor(c, p.content, p.version);
      st.comments = [...st.comments, c];
      return { ...c };
    },
    resolvePageComment: async (sid, pid, cid, resolved) => {
      maybeFail('resolvePageComment');
      page(sid, pid);
      const c = st.comments.find((x) => x.id === cid && x.pageId === pid);
      if (!c) throw notFound();
      const next = { ...c, resolved, resolvedAt: resolved ? ts() : null, updatedAt: ts() };
      st.comments = st.comments.map((x) => (x.id === cid ? next : x));
      return { ...next };
    },
    deletePageComment: async (sid, pid, cid) => {
      maybeFail('deletePageComment');
      page(sid, pid);
      st.comments = st.comments.filter((c) => c.id !== cid && c.parentId !== cid);
      return { ok: true as const };
    },
    listSpaceProposals: async (sid, q = {}) => {
      maybeFail('listSpaceProposals');
      space(sid);
      return {
        items: st.proposals
          .filter((x) => x.spaceId === sid)
          .filter((x) => q.status === 'all' || x.status === 'open')
          .filter((x) => !q.pageId || x.pageId === q.pageId)
          .map(proposalOut),
      };
    },
    acceptSpaceProposal: async (sid, prid, body = {}) => {
      maybeFail('acceptSpaceProposal');
      const b = parse(acceptProposalSchema, body);
      const x = st.proposals.find((q) => q.id === prid && q.spaceId === sid);
      if (!x) throw notFound();
      if (x.status !== 'open')
        throw err(409, 'conflict', 'This proposal was already decided.', { reason: 'decided' });
      const decide = () => {
        st.proposals = st.proposals.map((q) =>
          q.id === prid ? { ...q, status: 'accepted' as const, decidedAt: ts() } : q,
        );
      };
      if (!x.pageId) {
        const at = ts();
        const p = pageView({
          id: id('pg'),
          spaceId: sid,
          title: x.title,
          slug: slugify(x.title),
          position: st.pages.filter((q) => q.spaceId === sid).length,
          content: x.content,
          updatedBy: 'agent',
          createdAt: at,
          updatedAt: at,
        });
        st.pages = [...st.pages, p];
        st.versions.push({
          ...versionView({ pageId: p.id, title: p.title, authorKind: 'agent', proposalId: prid }),
          content: p.content,
        });
        decide();
        return pageOut(p);
      }
      const p = page(sid, x.pageId);
      if (x.baseVersion !== p.version && !b.force) throw stale(p, 'stale_proposal');
      decide();
      return commit(
        p,
        { title: x.title, content: x.content },
        { authorKind: 'agent', authorRef: x.authorRef, summary: x.summary, proposalId: prid },
      );
    },
    rejectSpaceProposal: async (sid, prid) => {
      maybeFail('rejectSpaceProposal');
      const x = st.proposals.find((q) => q.id === prid && q.spaceId === sid);
      if (!x) throw notFound();
      const next = { ...x, status: 'rejected' as const, decidedAt: ts() };
      st.proposals = st.proposals.map((q) => (q.id === prid ? next : q));
      return proposalOut(next);
    },

    // ---- sites ----
    listSites: async () => {
      maybeFail('listSites');
      return { items: st.sites.map((s) => ({ ...s })) };
    },
    listSiteDataSources: async () => {
      maybeFail('listSiteDataSources');
      return { items: st.dataSources.map((d) => ({ ...d })) };
    },
    createSite: async (body) => {
      maybeFail('createSite');
      const b = parse(createSiteSchema, body);
      if (b.source.kind === 'space') space(b.source.spaceId);
      else {
        const aid = b.source.artifactId;
        if (!st.artifacts.some((a) => a.id === aid))
          throw err(400, 'validation', 'No artifact with that id.');
      }
      for (const d of b.data ?? [])
        if (!st.dataSources.some((x) => x.id === d.sourceId))
          throw err(400, 'validation', `No data source ${d.sourceId}.`);
      const s = siteView({
        id: id('site'),
        name: b.name,
        description: b.description ?? null,
        source: b.source,
        sourceLabel: sourceLabel(b.source),
        data: b.data ?? [],
        createdAt: ts(),
        updatedAt: ts(),
      });
      st.sites = [...st.sites, s];
      return { ...s };
    },
    getSite: async (sid) => {
      maybeFail('getSite');
      return { ...site(sid) };
    },
    updateSite: async (sid, body) => {
      maybeFail('updateSite');
      const b = parse(updateSiteSchema, body);
      return patchSite(sid, {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.description !== undefined ? { description: b.description } : {}),
        ...(b.source ? { source: b.source, sourceLabel: sourceLabel(b.source) } : {}),
        ...(b.data ? { data: b.data } : {}),
      });
    },
    deleteSite: async (sid) => {
      maybeFail('deleteSite');
      if (site(sid).publishedVersion !== null)
        throw err(409, 'conflict', 'Unpublish the site before deleting it.', {
          reason: 'published',
        });
      st.sites = st.sites.filter((s) => s.id !== sid);
      st.siteVersions = st.siteVersions.filter((v) => v.siteId !== sid);
      st.publishes = st.publishes.filter((p) => p.siteId !== sid);
      return { ok: true as const };
    },
    buildSite: async (sid, body = {}) => {
      maybeFail('buildSite');
      const b = parse(buildSiteSchema, body);
      const s = site(sid);
      const version = (s.latestVersion ?? 0) + 1;
      const src = s.source;
      const v = siteVersionView({
        siteId: sid,
        version,
        note: b.note ?? null,
        scripts:
          src.kind === 'artifact' && !!st.artifacts.find((a) => a.id === src.artifactId)?.html,
        createdAt: ts(),
      });
      st.siteVersions = [...st.siteVersions, v];
      patchSite(sid, { latestVersion: version });
      return { ...v };
    },
    listSiteVersions: async (sid) => {
      maybeFail('listSiteVersions');
      const s = site(sid);
      return {
        items: st.siteVersions
          .filter((v) => v.siteId === sid)
          .sort((a, b) => b.version - a.version)
          .map((v) => ({ ...v, published: v.version === s.publishedVersion })),
      };
    },
    listSitePublishes: async (sid) => {
      maybeFail('listSitePublishes');
      site(sid);
      return {
        items: st.publishes
          .filter((p) => p.siteId === sid)
          .reverse()
          .map((p) => ({ ...p })),
      };
    },
    publishSite: async (sid, body) => {
      maybeFail('publishSite');
      const b = parse(publishSiteSchema, body);
      site(sid);
      if (!st.siteVersions.some((v) => v.siteId === sid && v.version === b.version))
        throw notFound();
      const target = b.target;
      if (target.kind === 'folder') {
        if (st.foreignFolders.includes(target.folder))
          throw err(409, 'conflict', 'That folder holds files Nova did not put there.', {
            reason: 'folder_in_use',
          });
        // Another site's live folder is also taken.
        if (
          st.sites.some(
            (s) =>
              s.id !== sid &&
              s.publishedTarget?.kind === 'folder' &&
              s.publishedTarget.folder === target.folder,
          )
        )
          throw err(409, 'conflict', 'Another site is published in that folder.', {
            reason: 'folder_in_use',
          });
      }
      const pub = publishView({
        id: id('pub'),
        siteId: sid,
        version: b.version,
        target,
        createdAt: ts(),
      });
      st.publishes = [...st.publishes, pub];
      return result(goLive(sid, pub), pub);
    },
    unpublishSite: async (sid) => {
      maybeFail('unpublishSite');
      site(sid);
      const live = st.publishes.find((p) => p.siteId === sid && p.current);
      if (!live)
        throw err(409, 'conflict', 'The site is not published.', { reason: 'not_published' });
      const at = ts();
      st.publishes = st.publishes.map((p) => (p.id === live.id ? { ...p, revertedAt: at } : p));
      // The publish before the undone one comes back, if there is one.
      const prev =
        st.publishes
          .filter((p) => p.siteId === sid && p.id !== live.id && p.revertedAt === null)
          .at(-1) ?? null;
      return result(goLive(sid, prev), prev);
    },
    sitePreviewUrl: (sid, v) => `/api/v1/sites/${encodeURIComponent(sid)}/versions/${v}/preview`,
    siteZipUrl: zipUrl,
  };
}

// ---- test helpers -----------------------------------------------------------------------------

let seq = 0;
const nextId = (p: string) => `${p}-${(++seq).toString().padStart(4, '0')}`;
let clock = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 2, 9, 0, clock++)).toISOString();

export type SpacesMocks = SpacesApi & Record<keyof SpacesApi, Mock<(...args: never[]) => unknown>>;

/** A standalone fake: every method a spy over the in-memory implementation. */
export function createSpacesHub(init: Partial<M6SpacesState> = {}) {
  const state = m6SpacesState(init);
  const failNext: Partial<Record<keyof SpacesApi, Error>> = {};
  const impl = m6SpacesImpl(state, {
    id: nextId,
    ts: nextTs,
    maybeFail: (name) => {
      const e = failNext[name];
      if (e) {
        delete failNext[name];
        throw e;
      }
    },
  });
  const api = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [k, vi.fn(fn as (...a: unknown[]) => unknown)]),
  ) as unknown as SpacesMocks;
  return { api, state, failNext };
}

/**
 * Render `ui` inside the providers the spaces views need, with the main fake Hub's client and
 * the spaces part spread over it (what `createApi` will do).
 */
export async function renderWithSpaces(
  ui: ReactNode,
  opts: {
    spaces?: Partial<M6SpacesState>;
    settings?: Record<string, unknown>;
    /** Values set by managed policy (locked). */
    managed?: Record<string, unknown>;
  } = {},
) {
  const hub = createHub();
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  hub.state.managed = { ...opts.managed };
  const spaces = createSpacesHub(opts.spaces);
  const api = { ...hub.api, ...spaces.api };
  const { settings } = await hub.api.settings();
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, { children: ui }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { hub, spaces, api: spaces.api, state: spaces.state, ...utils };
}
