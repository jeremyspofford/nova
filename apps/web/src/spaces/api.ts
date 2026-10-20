// Hub client calls for Spaces and Pages (FR-036) and Sites (FR-037), in the conventions of
// src/api.ts. `createApi` spreads `spacesApi(call)` into the client, so `Api` includes these;
// until then `useSpacesApi` reads them from the same services object.
import type { z } from 'zod';
import type {
  DeletedPageView,
  PageCommentView,
  PageDeletionView,
  PageProposalView,
  PageSummaryView,
  PageVersionView,
  PageView,
  SiteDataSourceView,
  SiteHostingTargetView,
  SitePublishPlanView,
  SitePublishResult,
  SitePublishView,
  SiteSourcePreviewView,
  SiteVersionView,
  SiteView,
  SpaceView,
  acceptProposalSchema,
  buildSiteSchema,
  createCommentSchema,
  createHostingTargetSchema,
  createPageSchema,
  createSiteSchema,
  createSpaceSchema,
  publishPlanSchema,
  publishSiteSchema,
  restorePageSchema,
  savePageSchema,
  siteSourcePreviewSchema,
  updateHostingTargetSchema,
  updatePageSchema,
  updateSiteSchema,
  updateSpaceSchema,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

function query(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const space = (id: string) => `${V1}/spaces/${enc(id)}`;
const page = (spaceId: string, pageId: string) => `${space(spaceId)}/pages/${enc(pageId)}`;
const site = (id: string) => `${V1}/sites/${enc(id)}`;

export function spacesApi(call: HubCall) {
  return {
    // ---- M6: Spaces and Pages (FR-036) ---------------------------------------------------------
    listSpaces: () => call<{ items: SpaceView[] }>('GET', `${V1}/spaces`),
    createSpace: (body: z.input<typeof createSpaceSchema>) =>
      call<SpaceView>('POST', `${V1}/spaces`, body),
    getSpace: (id: string) => call<SpaceView>('GET', space(id)),
    updateSpace: (id: string, body: z.input<typeof updateSpaceSchema>) =>
      call<SpaceView>('PATCH', space(id), body),
    deleteSpace: (id: string) => call<{ ok: true }>('DELETE', space(id)),
    listSpacePages: (spaceId: string) =>
      call<{ items: PageSummaryView[] }>('GET', `${space(spaceId)}/pages`),
    createSpacePage: (spaceId: string, body: z.input<typeof createPageSchema>) =>
      call<PageView>('POST', `${space(spaceId)}/pages`, body),
    getSpacePage: (spaceId: string, pageId: string) => call<PageView>('GET', page(spaceId, pageId)),
    /** A new version; 409 `conflict` with `details.current` when the base is stale. */
    saveSpacePage: (spaceId: string, pageId: string, body: z.input<typeof savePageSchema>) =>
      call<PageView>('PUT', page(spaceId, pageId), body),
    /** Order and site file name; not versioned. */
    updateSpacePage: (spaceId: string, pageId: string, body: z.input<typeof updatePageSchema>) =>
      call<PageSummaryView>('PATCH', page(spaceId, pageId), body),
    deleteSpacePage: (spaceId: string, pageId: string) =>
      call<{ ok: true }>('DELETE', page(spaceId, pageId)),
    listPageVersions: (spaceId: string, pageId: string) =>
      call<{ items: PageVersionView[] }>('GET', `${page(spaceId, pageId)}/versions`),
    getPageVersion: (spaceId: string, pageId: string, version: number) =>
      call<PageVersionView>('GET', `${page(spaceId, pageId)}/versions/${version}`),
    restoreSpacePage: (spaceId: string, pageId: string, body: z.input<typeof restorePageSchema>) =>
      call<PageView>('POST', `${page(spaceId, pageId)}/restore`, body),
    listPageComments: (spaceId: string, pageId: string) =>
      call<{ items: PageCommentView[] }>('GET', `${page(spaceId, pageId)}/comments`),
    createPageComment: (
      spaceId: string,
      pageId: string,
      body: z.input<typeof createCommentSchema>,
    ) => call<PageCommentView>('POST', `${page(spaceId, pageId)}/comments`, body),
    resolvePageComment: (spaceId: string, pageId: string, commentId: string, resolved: boolean) =>
      call<PageCommentView>('POST', `${page(spaceId, pageId)}/comments/${enc(commentId)}/resolve`, {
        resolved,
      }),
    deletePageComment: (spaceId: string, pageId: string, commentId: string) =>
      call<{ ok: true }>('DELETE', `${page(spaceId, pageId)}/comments/${enc(commentId)}`),
    listSpaceProposals: (spaceId: string, q: { status?: 'open' | 'all'; pageId?: string } = {}) =>
      call<{ items: PageProposalView[] }>('GET', `${space(spaceId)}/proposals${query({ ...q })}`),
    acceptSpaceProposal: (
      spaceId: string,
      proposalId: string,
      body: z.input<typeof acceptProposalSchema> = {},
    ) => call<PageView>('POST', `${space(spaceId)}/proposals/${enc(proposalId)}/accept`, body),
    rejectSpaceProposal: (spaceId: string, proposalId: string) =>
      call<PageProposalView>('POST', `${space(spaceId)}/proposals/${enc(proposalId)}/reject`, {}),

    // ---- M6: Sites (FR-037) --------------------------------------------------------------------
    listSites: () => call<{ items: SiteView[] }>('GET', `${V1}/sites`),
    /** The account's JSON and CSV project sources a site can connect. */
    listSiteDataSources: () =>
      call<{ items: SiteDataSourceView[] }>('GET', `${V1}/sites/data-sources`),
    createSite: (body: z.input<typeof createSiteSchema>) =>
      call<SiteView>('POST', `${V1}/sites`, body),
    getSite: (id: string) => call<SiteView>('GET', site(id)),
    updateSite: (id: string, body: z.input<typeof updateSiteSchema>) =>
      call<SiteView>('PATCH', site(id), body),
    /** 409 `conflict` while the site is published. */
    deleteSite: (id: string) => call<{ ok: true }>('DELETE', site(id)),
    /** Generate a new version from the source as it is now. */
    buildSite: (id: string, body: z.input<typeof buildSiteSchema> = {}) =>
      call<SiteVersionView>('POST', `${site(id)}/build`, body),
    listSiteVersions: (id: string) =>
      call<{ items: SiteVersionView[] }>('GET', `${site(id)}/versions`),
    listSitePublishes: (id: string) =>
      call<{ items: SitePublishView[] }>('GET', `${site(id)}/publishes`),
    /** Publish a version (also a rollback when it is an earlier one); needs `confirm: true`. */
    publishSite: (id: string, body: z.input<typeof publishSiteSchema>) =>
      call<SitePublishResult>('POST', `${site(id)}/publish`, body),
    /** Undo the live publish: the previous one comes back, or nothing is published. */
    unpublishSite: (id: string) =>
      call<SitePublishResult>('POST', `${site(id)}/unpublish`, { confirm: true }),
    /** A version's preview page, served sandboxed (no same-origin); load it in an iframe. */
    sitePreviewUrl: (id: string, version: number) => `${site(id)}/versions/${version}/preview`,
    /** A version as a zip download. */
    siteZipUrl: (id: string, version: number) => `${site(id)}/versions/${version}/zip`,

    // ---- M8: page order and deleted pages (FR-036) ---------------------------------------------
    /** The whole order in one write; 409 `order_stale` when the pages changed meanwhile. */
    reorderSpacePages: (spaceId: string, pageIds: string[]) =>
      call<{ items: PageSummaryView[] }>('PUT', `${space(spaceId)}/order`, { pageIds }),
    /** What deleting a page takes with it, for the confirmation. */
    getPageDeletion: (spaceId: string, pageId: string) =>
      call<PageDeletionView>('GET', `${page(spaceId, pageId)}/deletion`),
    listDeletedPages: (spaceId: string) =>
      call<{ items: DeletedPageView[] }>('GET', `${space(spaceId)}/deleted-pages`),
    /** Bring a deleted page back with its history and comments. */
    undeleteSpacePage: (spaceId: string, pageId: string) =>
      call<PageView>('POST', `${page(spaceId, pageId)}/undelete`, {}),

    // ---- M8: a site's source, publish plans and hosting targets (FR-037) -----------------------
    /** What a build from another source would make, against the latest version. */
    previewSiteSource: (id: string, body: z.input<typeof siteSourcePreviewSchema>) =>
      call<SiteSourcePreviewView>('POST', `${site(id)}/source-preview`, body),
    /** What publishing a version to a target would do (owner). */
    planSitePublish: (id: string, body: z.input<typeof publishPlanSchema>) =>
      call<SitePublishPlanView>('POST', `${site(id)}/publish-plan`, body),
    listSiteTargets: () => call<{ items: SiteHostingTargetView[] }>('GET', `${V1}/sites/targets`),
    createSiteTarget: (body: z.input<typeof createHostingTargetSchema>) =>
      call<SiteHostingTargetView>('POST', `${V1}/sites/targets`, body),
    updateSiteTarget: (id: string, body: z.input<typeof updateHostingTargetSchema>) =>
      call<SiteHostingTargetView>('PATCH', `${V1}/sites/targets/${enc(id)}`, body),
    /** 409 `target_in_use` while a site is published there. */
    deleteSiteTarget: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/sites/targets/${enc(id)}`),
    /** Try the connection; the outcome is kept on the target (`lastCheck`). */
    checkSiteTarget: (id: string) =>
      call<SiteHostingTargetView>('POST', `${V1}/sites/targets/${enc(id)}/check`, {}),
  };
}

export type SpacesApi = ReturnType<typeof spacesApi>;

/** The spaces calls of the app's client (part of `Api` once `createApi` spreads them in). */
export function useSpacesApi(): SpacesApi {
  const api: unknown = useServices().api;
  return api as SpacesApi;
}
