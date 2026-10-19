// Hub client calls for the agent browser (FR-086, FR-092, FR-094, FR-096, FR-098; docs/11 §4), in
// the conventions of src/api.ts. `createApi` spreads `browserApi(call)` into the client, so `Api`
// includes these; until then `useBrowserApi` reads them from the same services object. Since M7
// the trace is newest first with a cursor; the other M7 calls are in api-m7.ts.
import type {
  BrowserActionsPageView,
  BrowserDomainsView,
  BrowserLoginView,
  BrowserSessionView,
  BrowserSigninView,
  BrowserSiteView,
  BrowserStatusView,
  PatchBrowserSiteRequest,
  PutBrowserDomainsRequest,
  PutBrowserSiteRequest,
  SubmitBrowserSigninRequest,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/** What the private sign-in answer did (never echoes what was typed). */
export interface BrowserSigninResult {
  state: 'completed' | 'failed';
  message: string;
}

const V1 = '/api/v1';
const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function browserApi(call: HubCall) {
  return {
    /** Whether the agent browser can run on this Hub (Chromium found, egress proxy wired). */
    browserStatus: () => call<BrowserStatusView>('GET', `${V1}/browser/status`),

    // ---- sites and domain lists (FR-094) -------------------------------------------------------
    listBrowserSites: () => call<{ items: BrowserSiteView[] }>('GET', `${V1}/browser/sites`),
    /** Add or change a site; a new allowed site starts at Always ask. */
    putBrowserSite: (body: PutBrowserSiteRequest) =>
      call<BrowserSiteView>('PUT', `${V1}/browser/sites`, body),
    /** Level or developer-protocol mode; 400 on a blocked site, 403 when policy turns it off. */
    patchBrowserSite: (pattern: string, body: PatchBrowserSiteRequest) =>
      call<BrowserSiteView>('PATCH', `${V1}/browser/sites/${enc(pattern)}`, body),
    deleteBrowserSite: (pattern: string) =>
      call<{ ok: true }>('DELETE', `${V1}/browser/sites/${enc(pattern)}`),
    browserDomains: () => call<BrowserDomainsView>('GET', `${V1}/browser/domains`),
    /** Replace a list; a pattern on both lists is blocked. */
    setBrowserDomains: (body: PutBrowserDomainsRequest) =>
      call<BrowserDomainsView>('PUT', `${V1}/browser/domains`, body),

    // ---- sessions and the Activity trace (FR-096, FR-098) --------------------------------------
    listBrowserSessions: () =>
      call<{ items: BrowserSessionView[] }>('GET', `${V1}/browser/sessions`),
    /** 404 when no browser is open for the computer. */
    closeBrowserSession: (computerId: string) =>
      call<{ ok: true }>('DELETE', `${V1}/browser/sessions/${enc(computerId)}`),
    /**
     * Newest first, at most `limit` (1..500); `cursor` is the previous page's `nextCursor` (null on
     * the last page). A cursor the Hub did not make answers 400.
     */
    listBrowserActions: (
      q: {
        computerId?: string;
        threadId?: string;
        callId?: string;
        limit?: number;
        cursor?: string;
      } = {},
    ) => call<BrowserActionsPageView>('GET', `${V1}/browser/actions${query({ ...q })}`),
    /** A recorded action's screenshot (PNG, served by the Hub). */
    browserShotUrl: (actionId: string, which: 'before' | 'after') =>
      `${V1}/browser/actions/${enc(actionId)}/screenshots/${which}`,

    // ---- private sign-in (FR-086) --------------------------------------------------------------
    listBrowserSignins: (threadId?: string) =>
      call<{ items: BrowserSigninView[] }>('GET', `${V1}/browser/signins${query({ threadId })}`),
    /** 410 `request_expired` once the form no longer waits. */
    submitBrowserSignin: (id: string, body: SubmitBrowserSigninRequest) =>
      call<BrowserSigninResult>('POST', `${V1}/browser/signins/${enc(id)}/submit`, body),
    cancelBrowserSignin: (id: string) =>
      call<{ ok: true }>('POST', `${V1}/browser/signins/${enc(id)}/cancel`, {}),
    listBrowserLogins: () => call<{ items: BrowserLoginView[] }>('GET', `${V1}/browser/logins`),
    deleteBrowserLogin: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/browser/logins/${enc(id)}`),
  };
}

export type BrowserApi = ReturnType<typeof browserApi>;

/** The browser calls of the app's client (part of `Api` once `createApi` spreads them in). */
export function useBrowserApi(): BrowserApi {
  const api: unknown = useServices().api;
  return api as BrowserApi;
}
