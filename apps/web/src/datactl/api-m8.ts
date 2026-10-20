// M8 Hub client calls for data controls (FR-105, FR-121; ADR-097 D5) and spend caps and provider
// limits (FR-116, FR-115), in the conventions of src/api.ts. Under /api/v1/data everything is the
// Hub owner's (403 `policy_denied` `{reason: owner_only}` for anyone else): the overview, the
// export (a one-use ticket, then a plain browser download of
// `GET /api/v1/data/export/download?ticket=`), delete-all (the Hub's name typed), the import
// (upload the raw file, check it, then import into an empty Hub), retention and crash reports.
// Delete-all and an import answer, then the Hub restarts its services. Under /api/v1/usage every
// account manages its own spend caps, sees its providers' limits and clears its usage records.
// `createApi` spreads `datactlApi(call, fetchImpl)` into the client (the upload sends the file as
// the raw body, so it needs the client's fetch); until then `useDatactlApi` reads them from the
// services object.
import type {
  CrashReportPreviewView,
  CrashReportView,
  DataDeleteResultView,
  DataImportCheckView,
  DataImportResultView,
  DataImportUploadView,
  DataOverviewView,
  ProviderLimitView,
  RetentionSweepView,
  RetentionView,
  SpendCapView,
  SpendPeriod,
} from '@nova/shared';
import { ApiError, type ApiErrorBody } from '../api.ts';
import { useServices } from '../services.tsx';

/** The request function of `createApi` (JSON in and out, errors as ApiError). */
export type HubCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

const V1 = '/api/v1';
const enc = encodeURIComponent;

/** `PUT /api/v1/usage/caps/:provider` (the Hub fills the defaults: month, 0.8, hard stop). */
export interface SpendCapBody {
  limitUsd: number;
  period?: SpendPeriod;
  warnAt?: number;
  hardStop?: boolean;
}

export interface CrashReportList {
  items: CrashReportView[];
  /** `privacy.crashReports`. */
  enabled: boolean;
  /** `privacy.crashReportEndpoint`, or null when empty. */
  endpoint: string | null;
}

export function datactlApi(call: HubCall, fetchImpl: typeof fetch = (i, init) => fetch(i, init)) {
  return {
    // ---- overview and export ---------------------------------------------------------------------
    /** What an export would hold now, the Hub's name (delete-all asks for it) and whether it is empty. */
    getDataOverview: () => call<DataOverviewView>('GET', `${V1}/data`),
    /**
     * A one-use ticket (2 minutes) for the browser download; the passphrase (at least 12
     * characters) seals the archive and includes the vault's secrets. A sealed export needs
     * `confirm`, the Hub's name (400 `{reason: confirmation_mismatch}`), and is refused from a
     * paired device's session (403 `{reason: hub_only}`).
     */
    createExportTicket: (passphrase?: string, confirm?: string) =>
      call<{ ticket: string; expiresAt: string }>('POST', `${V1}/data/export/ticket`, {
        ...(passphrase !== undefined ? { passphrase } : {}),
        ...(passphrase !== undefined && confirm !== undefined ? { confirm } : {}),
      }),
    /** The download address for a ticket (404 `{reason: ticket_expired}` once used or expired). */
    exportDownloadUrl: (ticket: string) => `${V1}/data/export/download?ticket=${enc(ticket)}`,

    // ---- delete-all ------------------------------------------------------------------------------
    /** 400 `{reason: confirmation_mismatch}` unless `confirm` is the Hub's name; 409 `busy`. */
    deleteAllData: (confirm: string) =>
      call<DataDeleteResultView>('POST', `${V1}/data/delete-all`, { confirm }),

    // ---- import ----------------------------------------------------------------------------------
    /** The archive as the raw body (201); kept for an hour for a check and the import. */
    uploadImport: async (file: Blob): Promise<DataImportUploadView> => {
      const res = await fetchImpl(`${V1}/data/import/upload`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/octet-stream' },
        body: file,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: ApiErrorBody;
      } & Partial<DataImportUploadView>;
      if (!res.ok)
        throw new ApiError(
          res.status,
          data.error ?? { code: 'server_error', message: res.statusText, retryable: true },
        );
      return data as DataImportUploadView;
    },
    removeImportUpload: (uploadId: string) =>
      call<{ ok: true }>('DELETE', `${V1}/data/import/uploads/${enc(uploadId)}`),
    /** What the archive holds and whether this Hub can take it; writes nothing. */
    checkImport: (uploadId: string, passphrase?: string) =>
      call<DataImportCheckView>('POST', `${V1}/data/import/check`, {
        uploadId,
        ...(passphrase !== undefined ? { passphrase } : {}),
      }),
    /** Into an empty Hub only (409 `{reason: hub_not_empty}`); all or nothing; then a restart. */
    importData: (uploadId: string, passphrase?: string) =>
      call<DataImportResultView>('POST', `${V1}/data/import`, {
        uploadId,
        ...(passphrase !== undefined ? { passphrase } : {}),
        confirm: true,
      }),

    // ---- retention -------------------------------------------------------------------------------
    getRetention: () => call<RetentionView>('GET', `${V1}/data/retention`),
    sweepRetention: () => call<RetentionSweepView>('POST', `${V1}/data/retention/sweep`, {}),

    // ---- crash reports ---------------------------------------------------------------------------
    listCrashReports: () => call<CrashReportList>('GET', `${V1}/data/crash-reports`),
    /** Exactly the body that would be sent, and whether it would be sent now. */
    previewCrashReport: (id: string) =>
      call<CrashReportPreviewView>('GET', `${V1}/data/crash-reports/${enc(id)}/preview`),
    /** 403 `{reason: crash_reports_off | no_endpoint}`; 500 `{reason: send_failed}`. */
    sendCrashReport: (id: string) =>
      call<CrashReportView>('POST', `${V1}/data/crash-reports/${enc(id)}/send`, {}),
    deleteCrashReport: (id: string) =>
      call<{ ok: true }>('DELETE', `${V1}/data/crash-reports/${enc(id)}`),
    deleteAllCrashReports: () => call<{ deleted: number }>('DELETE', `${V1}/data/crash-reports`),

    // ---- spend caps, provider limits and usage (every account its own) --------------------------
    listSpendCaps: () => call<{ items: SpendCapView[] }>('GET', `${V1}/usage/caps`),
    setSpendCap: (provider: string, body: SpendCapBody) =>
      call<SpendCapView>('PUT', `${V1}/usage/caps/${enc(provider)}`, body),
    /** 404 when the provider has no cap. */
    removeSpendCap: (provider: string) =>
      call<{ ok: true }>('DELETE', `${V1}/usage/caps/${enc(provider)}`),
    listProviderLimits: () => call<{ items: ProviderLimitView[] }>('GET', `${V1}/usage/limits`),
    /** The account's usage records go; each cap keeps its period's spend. */
    clearUsage: () => call<{ removed: number }>('POST', `${V1}/usage/clear`, { confirm: true }),
  };
}

export type DatactlApi = ReturnType<typeof datactlApi>;

/**
 * The data-controls calls of the app's client (part of `Api` once `createApi` spreads them). The
 * pieces other pages show (spend caps, provider limits) stay hidden while a call is absent.
 */
export function useDatactlApi(): Partial<DatactlApi> {
  const api: unknown = useServices().api;
  return api as Partial<DatactlApi>;
}
