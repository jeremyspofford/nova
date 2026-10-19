// M7 Hub client calls of the agent browser (FR-092, FR-094, FR-103; docs/11 §4, §4.4), in the
// conventions of src/api.ts: an allowed site's level for one project or agent (the narrower scope
// wins), and an open browser's console and network capture, redacted by the Hub like what the
// agent reads. `createApi` spreads `browserM7Api(call)` into the client next to
// `browserApi(call)`; until then `useBrowserM7Api` reads them from the same services object.
import type {
  BrowserCaptureView,
  BrowserConsoleEntryView,
  BrowserNetworkEntryView,
  BrowserSiteLevel,
  BrowserSiteScopeKind,
  BrowserSiteScopedLevelView,
} from '@nova/shared';
import { useServices } from '../services.tsx';
import type { BrowserApi, HubCall } from './api.ts';

const V1 = '/api/v1';
const enc = encodeURIComponent;

const scoped = (pattern: string, kind: BrowserSiteScopeKind, ref: string) =>
  `${V1}/browser/sites/${enc(pattern)}/levels/${enc(kind)}/${enc(ref)}`;

export function browserM7Api(call: HubCall) {
  return {
    /** Levels set for one project or agent (or every scope); the narrower scope wins. */
    listBrowserSiteLevels: (
      q: { scopeKind?: BrowserSiteScopeKind; scopeRef?: string; pattern?: string } = {},
    ) => {
      const params = new URLSearchParams();
      if (q.scopeKind) params.set('scopeKind', q.scopeKind);
      if (q.scopeRef) params.set('scopeRef', q.scopeRef);
      if (q.pattern) params.set('pattern', q.pattern);
      const qs = params.toString();
      return call<{ items: BrowserSiteScopedLevelView[] }>(
        'GET',
        `${V1}/browser/site-levels${qs ? `?${qs}` : ''}`,
      );
    },
    /**
     * An allowed site's level for one project or agent. 404 for an unknown site, project or agent;
     * 400 for a blocked site (allow it first).
     */
    putBrowserSiteLevel: (
      pattern: string,
      scopeKind: BrowserSiteScopeKind,
      scopeRef: string,
      level: BrowserSiteLevel,
    ) => call<BrowserSiteScopedLevelView>('PUT', scoped(pattern, scopeKind, scopeRef), { level }),
    /** Back to the level for everything else; 404 when that scope has no level for the site. */
    deleteBrowserSiteLevel: (pattern: string, scopeKind: BrowserSiteScopeKind, scopeRef: string) =>
      call<{ ok: true }>('DELETE', scoped(pattern, scopeKind, scopeRef)),
    /** The newest console messages of an open browser (newest last); 404 when none is open. */
    browserConsole: (computerId: string, limit?: number) =>
      call<BrowserCaptureView<BrowserConsoleEntryView>>(
        'GET',
        `${V1}/browser/sessions/${enc(computerId)}/console${limit ? `?limit=${limit}` : ''}`,
      ),
    /** The newest requests of an open browser (newest last); 404 when none is open. */
    browserNetwork: (computerId: string, limit?: number) =>
      call<BrowserCaptureView<BrowserNetworkEntryView>>(
        'GET',
        `${V1}/browser/sessions/${enc(computerId)}/network${limit ? `?limit=${limit}` : ''}`,
      ),
  };
}

export type BrowserM7Api = ReturnType<typeof browserM7Api>;

/** The browser calls, M6 and M7, of the app's client. */
export function useBrowserM7Api(): BrowserApi & BrowserM7Api {
  const api: unknown = useServices().api;
  return api as BrowserApi & BrowserM7Api;
}

/**
 * Whether this client has the M7 browser calls: an older client (or a test fake without them)
 * leaves the console and network views out instead of failing the panel.
 */
export function useHasBrowserCapture(): boolean {
  const api = useServices().api as unknown as Partial<BrowserM7Api>;
  return typeof api.browserConsole === 'function' && typeof api.browserNetwork === 'function';
}
