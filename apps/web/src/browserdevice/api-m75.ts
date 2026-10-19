// M7.5 Hub client calls of the local browser fallback (FR-209) and the extension bridge (FR-096;
// docs/11 §4.3, §4.6), in the conventions of src/api.ts. The fallback's consents and sessions are
// the signed-in account's; the bridge (status, shared tabs, per-host grants) is the Hub owner's,
// under `/devices/:id/bridge` (403 `owner_only` for a member). `createApi` spreads
// `browserDeviceApi(call)` into the client; until then `useBrowserDeviceApi` reads the calls from
// the same services object and answers null when the client has none.
import type {
  BrowserBridgeGrantView,
  BrowserBridgeStatusView,
  BrowserFallbackConsentView,
  BrowserFallbackScopeKind,
  BrowserFallbackSessionView,
  CreateBridgeGrantRequest,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

const bridge = (deviceId: string) => `${V1}/devices/${enc(deviceId)}/bridge`;

export function browserDeviceApi(call: HubCall) {
  return {
    // ---- local browser fallback (FR-209) -------------------------------------------------------
    /** The account's consents (newest first); `all` adds revoked ones. */
    listFallbackConsents: (
      q: {
        scopeKind?: BrowserFallbackScopeKind;
        scopeRef?: string;
        deviceId?: string;
        all?: boolean;
      } = {},
    ) =>
      call<{ items: BrowserFallbackConsentView[] }>(
        'GET',
        `${V1}/browser/fallback/consents${query({
          scopeKind: q.scopeKind,
          scopeRef: q.scopeRef,
          deviceId: q.deviceId,
          all: q.all ? 'true' : undefined,
        })}`,
      ),
    /** Revoke a consent; a session running on it stops. 404 when it is not the account's. */
    revokeFallbackConsent: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/browser/fallback/consents/${enc(id)}`),
    /** Fallback sessions, newest first (1..200). */
    listFallbackSessions: (q: { computerId?: string; limit?: number } = {}) =>
      call<{ items: BrowserFallbackSessionView[] }>(
        'GET',
        `${V1}/browser/fallback/sessions${query({ computerId: q.computerId, limit: q.limit })}`,
      ),

    // ---- extension bridge (FR-096), the owner's ------------------------------------------------
    /** Connected or not, the shared tabs and the switches; 404 for a device not on this Hub. */
    getBridgeStatus: (deviceId: string) => call<BrowserBridgeStatusView>('GET', bridge(deviceId)),
    /** Pending and active grants; `all` adds revoked ones. */
    listBridgeGrants: (deviceId: string, all = false) =>
      call<{ items: BrowserBridgeGrantView[] }>(
        'GET',
        `${bridge(deviceId)}/grants${all ? '?all=true' : ''}`,
      ),
    /**
     * Grant one host, or "all sites" with its own acknowledgement. 403 `bridge_disabled` or
     * `all_sites_disabled`; 400 for a host that is not a host name.
     */
    createBridgeGrant: (deviceId: string, body: CreateBridgeGrantRequest) =>
      call<BrowserBridgeGrantView>('POST', `${bridge(deviceId)}/grants`, body),
    /** Confirm a grant the extension reported (pending); "all sites" needs the acknowledgement. */
    confirmBridgeGrant: (
      deviceId: string,
      grantId: string,
      body: { confirm: true; acknowledgeElevatedRisk?: true },
    ) =>
      call<BrowserBridgeGrantView>(
        'POST',
        `${bridge(deviceId)}/grants/${enc(grantId)}/confirm`,
        body,
      ),
    revokeBridgeGrant: (deviceId: string, grantId: string) =>
      call<{ ok: true }>('DELETE', `${bridge(deviceId)}/grants/${enc(grantId)}`),
  };
}

export type BrowserDeviceApi = ReturnType<typeof browserDeviceApi>;

/**
 * The calls of the app's client, or null when this client has none yet (an older Hub client or a
 * test fake without them): the views then stay out of the page instead of failing it.
 */
export function useBrowserDeviceApi(): BrowserDeviceApi | null {
  const api = useServices().api as unknown as Partial<BrowserDeviceApi>;
  return typeof api.listFallbackConsents === 'function' && typeof api.getBridgeStatus === 'function'
    ? (api as BrowserDeviceApi)
    : null;
}
