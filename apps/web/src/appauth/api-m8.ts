// M8 Hub client calls for third-party apps and the OTLP export (FR-222, FR-223; ADR-097 D6), in
// the conventions of src/api.ts: the consent page's details and the owner's decision, the apps the
// owner authorized (revoke), the registered apps no one authorizes (remove), and the telemetry export's settings, status and test. `createApi`
// spreads `appAuthApi(call)` into the client; until then `useAppAuthApi` reads them from the
// services object.
import type {
  AppAuthorizeDecision,
  AppAuthorizeResultView,
  AppConsentView,
  AppGrantView,
  AppPendingView,
  OtlpStatusView,
  OtlpTestResultView,
  PutOtlpRequest,
} from '@nova/shared';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

export function appAuthApi(call: HubCall) {
  return {
    /**
     * What the consent page shows for an app's authorization request (`query`: the page's own
     * query string, passed through as the app sent it). Owner only. A request the Hub cannot
     * trust (unknown app, a redirect it did not register) is refused without `redirectTo`; other
     * refusals carry `details.redirectTo`, the app's redirect with the OAuth error.
     */
    getAppConsent: (query: string) =>
      call<AppConsentView>('GET', `${V1}/apps/authorize?${query.replace(/^\?/, '')}`),
    /** The owner's decision; the answer is where to send the browser (the app's redirect). */
    decideAppConsent: (body: AppAuthorizeDecision) =>
      call<AppAuthorizeResultView>('POST', `${V1}/apps/authorize`, body),
    /** The apps the owner authorized (active app authorizations of kind `app`). */
    listApps: () => call<{ items: AppGrantView[] }>('GET', `${V1}/apps`),
    /** Revoke an app: its authorization and every token it holds stop at once. */
    revokeApp: (id: string) => call<{ ok: true }>('DELETE', `${V1}/apps/${enc(id)}`),
    /**
     * Registered apps no one authorizes now, newest first: ones waiting for their first approval
     * (`expiresAt`: their registration lapses then) and ones revoked or registered by the owner
     * (`expiresAt: null`). Owner only.
     */
    listPendingApps: () => call<{ items: AppPendingView[] }>('GET', `${V1}/apps/pending`),
    /**
     * Delete such a registration, with its leftover codes and tokens. 409 `{reason: authorized}`
     * while someone authorizes it (revoke it first); 404 for an unknown app. Owner only.
     */
    removePendingApp: (clientId: string) =>
      call<{ ok: true }>('DELETE', `${V1}/apps/pending/${enc(clientId)}`),

    /** The OTLP export's settings (header names only) and how it is doing. Owner only. */
    getOtlp: () => call<OtlpStatusView>('GET', `${V1}/telemetry/otlp`),
    /** Change the export in one call; header values go to the vault, `null` removes a header. */
    updateOtlp: (body: PutOtlpRequest) => call<OtlpStatusView>('PUT', `${V1}/telemetry/otlp`, body),
    /** Send one log record to the collector now. */
    testOtlp: () => call<OtlpTestResultView>('POST', `${V1}/telemetry/otlp/test`, {}),
  };
}

export type AppAuthApi = ReturnType<typeof appAuthApi>;

/** The app-authorization and telemetry calls of the app's client. */
export function useAppAuthApi(): AppAuthApi {
  const api: unknown = useServices().api;
  return api as AppAuthApi;
}
