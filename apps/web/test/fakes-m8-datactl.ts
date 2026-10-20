// The fake Hub's M8 data-controls part (FR-105, FR-121) and spend caps and provider limits (FR-116,
// FR-115), in memory, with the Hub's rules from apps/hub/src/datactl.ts and
// packages/core/src/datactl + packages/core/src/profile/spend.ts:
// - everything under /api/v1/data is the owner's (403 `policy_denied` `{reason: owner_only}` for a
//   member); /api/v1/usage is every account's own;
// - export: a ticket for a passphrase of at least 12 characters (400 `validation` with `issues`
//   otherwise); a sealed export needs `confirm`, the Hub's name compared trimmed and ignoring case
//   (400 `validation` `{reason: confirmation_mismatch, field: confirm}`), and is refused from a
//   paired device's session (403 `policy_denied` `{reason: hub_only}`, `deviceSession`); the
//   download address carries it;
// - delete-all: the Hub's name typed, compared trimmed and ignoring case (400 `validation`
//   `{reason: confirmation_mismatch}`), 409 `conflict` `{reason: busy}` while another runs; the Hub
//   is then empty;
// - import: an upload (400 `{reason: empty}` for an empty file), then a check and the import. What
//   a file holds comes from `archives` by its name (default: a plain archive): a sealed one needs
//   its passphrase (400 `{reason: passphrase_required}`, `{reason: wrong_passphrase}`), a broken one
//   is refused with its reason at the check and the import (`refuse`: `archive_damaged`,
//   `unsafe_path`, `foreign_secret`, `disk_full`…), and `refuseImport` only at the import (a
//   secret this Hub holds found while applying, the disk filled up meanwhile); an import needs an
//   empty Hub (409 `{reason: hub_not_empty}`); an unknown upload is 404;
// - retention: each item's days from the Hub settings, the audit floor, what is due; a sweep
//   removes what is due;
// - crash reports: the preview is the body byte for byte; sending is refused while
//   `privacy.crashReports` is off (403 `{reason: crash_reports_off}`) or without an endpoint (403
//   `{reason: no_endpoint}`); a failing endpoint is 500 `{reason: send_failed}` and keeps the error;
// - spend caps: the body as `spendCapSchema` checks it (400 `validation` with `issues`), the state
//   from the spend; removing a missing cap is 404; "clear usage data" needs `confirm: true` and
//   never resets a cap.
//
// Wiring into test/fakes.ts (done by the lead): `HubState` gets `m8datactl: M8DatactlState`,
// `createHub` defaults it to `m8DatactlState()`, and `impl` spreads
// `...m8DatactlImpl(state.m8datactl, { isMember: () => state.m7team.me !== OWNER_ID, setting })`.
// Until then tests use `renderWithDatactl`, which spreads it over `createHub().api`.
/* eslint-disable @typescript-eslint/require-await */
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { vi, type Mock } from 'vitest';
import {
  AUDIT_RETENTION_FLOOR_DAYS,
  RETENTION_ITEMS,
  RETENTION_SETTING_KEYS,
  dataExportSchema,
  resolveSetting,
  spendCapSchema,
  spendProviderSchema,
  type CrashReportView,
  type DataImportCheckView,
  type DataOverviewView,
  type ProviderLimitView,
  type RetentionItem,
  type RetentionSweepView,
  type SettingKey,
  type SpendCapView,
} from '@nova/shared';
import { ToastProvider } from '@nova/ui';
import { ApiError } from '../src/api.ts';
import type { DatactlApi } from '../src/datactl/api-m8.ts';
import { ManagedLockNotes } from '../src/managed/ManagedNote.tsx';
import { AnnouncerProvider, ServicesProvider } from '../src/services.tsx';
import { SettingsProvider } from '../src/settings.tsx';
import { DONE_ONBOARDING, createHub, fakeEventSource, testRegistry } from './fakes.ts';
import { MEMBER_ID, m7TeamState } from './fakes-m7-team.ts';
import {
  m8ManagedImpl,
  m8ManagedState,
  managedLayerOf,
  type M8ManagedState,
} from './fakes-m8-managed.ts';

const NOW = '2026-10-15T12:00:00.000Z';

/** What an uploaded file holds: the check's answer, or the reason the Hub refuses it. */
export interface FakeArchive {
  encrypted: boolean;
  passphrase?: string;
  /** Refused at the check and the import (400 `validation` with this reason). */
  refuse?: { reason: string; message: string };
  /** Refused only at the import, after a clean check. */
  refuseImport?: { reason: string; message: string };
  check: Omit<DataImportCheckView, 'hubEmpty' | 'blockingTables' | 'encrypted'>;
}

export function plainArchive(over: Partial<FakeArchive['check']> = {}): FakeArchive {
  return {
    encrypted: false,
    check: {
      format: 1,
      hubVersion: '0.8.0',
      schemaVersion: 51,
      migratesFrom: null,
      createdAt: '2026-10-10T09:00:00.000Z',
      tables: [
        { name: 'thread', rows: 40 },
        { name: 'message', rows: 900 },
      ],
      rows: 940,
      files: { count: 12, bytes: 5 * 1024 * 1024 },
      secrets: { included: false, count: 0 },
      toReEnter: [
        'secret://provider/pa1/api_key',
        'secret://provider/pa2/api_key',
        'secret://mcp/srv1/token',
      ],
      omitted: [
        {
          kind: 'table',
          ref: 'trust_ca',
          reason: "the Hub's own keys travel only in an archive sealed with a passphrase",
        },
        {
          kind: 'secret',
          ref: 'secret://provider/pa1/api_key',
          reason: 'secrets travel only with a passphrase',
        },
      ],
      ...over,
    },
  };
}

export function sealedArchive(passphrase = 'correct horse battery'): FakeArchive {
  const plain = plainArchive({
    secrets: { included: true, count: 3 },
    toReEnter: [],
    omitted: [],
  });
  return { ...plain, encrypted: true, passphrase };
}

export interface M8DatactlState {
  overview: DataOverviewView;
  /** The next delete-all or import is refused as busy. */
  busy: boolean;
  /** The session is a paired device's (a sealed export is refused with `hub_only`). */
  deviceSession: boolean;
  tickets: Map<string, { passphrase?: string; confirm?: string }>;
  /** What a file holds, by its name (default: `plainArchive()`). */
  archives: Record<string, FakeArchive>;
  uploads: Map<string, { name: string; bytes: number; archive: FakeArchive }>;
  /** Items each retention item would remove now. */
  due: Record<RetentionItem, number>;
  lastSweep: RetentionSweepView | null;
  crash: { report: CrashReportView; body: string }[];
  /** The crash report endpoint answers this status (200: taken). */
  endpointStatus: number;
  caps: SpendCapView[];
  /** Spend this period by provider (US dollars). */
  spent: Record<string, number>;
  limits: Omit<ProviderLimitView, 'spendCap'>[];
  usageRecords: number;
}

export function crashReport(id: string, over: Partial<CrashReportView> = {}) {
  const report: CrashReportView = {
    id,
    kind: 'uncaughtException',
    createdAt: '2026-10-14T08:00:00.000Z',
    errorName: 'TypeError',
    sentAt: null,
    lastError: null,
    ...over,
  };
  const body = JSON.stringify({
    v: 1,
    id,
    kind: report.kind,
    createdAt: report.createdAt,
    error: { name: report.errorName, code: null, stack: ['at run (dist/main.js:10:5)'] },
    app: { name: 'nova-hub', version: '0.8.0' },
    runtime: { node: 'v26.0.0', platform: 'linux', arch: 'x64', release: '6.1' },
    process: { uptimeSeconds: 42, rssMb: 180 },
  });
  return { report, body };
}

export function m8DatactlState(init: Partial<M8DatactlState> = {}): M8DatactlState {
  return {
    overview: {
      hubName: 'nova-hub',
      hubVersion: '0.8.0',
      schemaVersion: 51,
      tables: 180,
      rows: 12_345,
      files: { count: 40, bytes: 30 * 1024 * 1024 },
      secrets: { count: 4 },
      empty: false,
      blockingTables: ['thread', 'message'],
    },
    busy: false,
    deviceSession: false,
    tickets: new Map(),
    archives: {},
    uploads: new Map(),
    due: { threads: 0, runs: 0, audit: 0, artifacts: 0, traces: 0 },
    lastSweep: null,
    crash: [crashReport('crash-1')],
    endpointStatus: 200,
    caps: [],
    spent: {},
    limits: [
      {
        providerAccountId: 'pa1',
        provider: 'anthropic',
        label: 'Work Anthropic',
        active: true,
        local: false,
        entitlements: { plan: 'Team', limit: 1000, used: 250, resetAt: '2026-11-01T00:00:00.000Z' },
        lastReported: null,
        spentThisMonthUsd: 12.5,
      },
      {
        providerAccountId: 'pa2',
        provider: 'ollama',
        label: 'Desk Ollama',
        active: true,
        local: true,
        entitlements: null,
        lastReported: null,
        spentThisMonthUsd: 0,
      },
    ],
    usageRecords: 25,
    ...init,
  };
}

const err = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(status, {
    code,
    message,
    retryable: false,
    ...(details ? { details } : {}),
  });
const refuse = (reason: string, message: string, status = 400, code = 'validation') =>
  err(status, code, message, { reason });
const zodIssues = (issues: { path: PropertyKey[]; message: string }[]) =>
  err(400, 'validation', 'request failed validation', {
    issues: issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
  });

function capView(
  provider: string,
  body: { limitUsd: number; period: 'day' | 'month'; warnAt: number; hardStop: boolean },
  spent: number,
): SpendCapView {
  const fraction = Math.round((spent / body.limitUsd) * 1e6) / 1e6;
  return {
    provider,
    ...body,
    periodStart: body.period === 'day' ? '2026-10-15T00:00:00.000Z' : '2026-10-01T00:00:00.000Z',
    resetsAt: body.period === 'day' ? '2026-10-16T00:00:00.000Z' : '2026-11-01T00:00:00.000Z',
    spentUsd: spent,
    fraction,
    state: fraction >= 1 ? 'reached' : fraction >= body.warnAt ? 'warning' : 'ok',
    updatedAt: NOW,
  };
}

/** A cap as the Hub would show it for this spend. */
export function cap(
  provider: string,
  limitUsd: number,
  spent: number,
  over: Partial<{ period: 'day' | 'month'; warnAt: number; hardStop: boolean }> = {},
): SpendCapView {
  return capView(
    provider,
    {
      limitUsd,
      period: over.period ?? 'month',
      warnAt: over.warnAt ?? 0.8,
      hardStop: over.hardStop ?? true,
    },
    spent,
  );
}

export function m8DatactlImpl(
  st: M8DatactlState,
  helpers: { isMember: () => boolean; setting: (key: SettingKey) => unknown },
): DatactlApi {
  const owner = () => {
    if (helpers.isMember())
      throw refuse(
        'owner_only',
        "only the owner of this Hub can manage the Hub's data",
        403,
        'policy_denied',
      );
  };
  const uploadOf = (id: string) => {
    const u = st.uploads.get(id);
    if (!u) throw err(404, 'not_found', 'no such upload (it may have expired)');
    return u;
  };
  const staged = (archive: FakeArchive, passphrase?: string) => {
    if (archive.encrypted && passphrase === undefined)
      throw refuse('passphrase_required', 'this archive is sealed: enter its passphrase');
    if (archive.encrypted && passphrase !== archive.passphrase)
      throw refuse('wrong_passphrase', 'the passphrase is wrong or the archive was changed');
    if (archive.refuse) throw refuse(archive.refuse.reason, archive.refuse.message);
  };
  const crashOf = (id: string) => {
    const c = st.crash.find((x) => x.report.id === id);
    if (!c) throw err(404, 'not_found', 'no such crash report');
    return c;
  };
  const preview = (id: string) => {
    const c = crashOf(id);
    const enabled = helpers.setting('privacy.crashReports') === true;
    const endpoint = (helpers.setting('privacy.crashReportEndpoint') as string) || null;
    return {
      body: c.body,
      endpoint,
      wouldSend: enabled && !!endpoint,
      reason: !enabled ? ('off' as const) : !endpoint ? ('no_endpoint' as const) : null,
    };
  };
  const capOf = (provider: string) => st.caps.find((c) => c.provider === provider) ?? null;

  return {
    getDataOverview: async () => {
      owner();
      return structuredClone(st.overview);
    },
    createExportTicket: async (passphrase?: string, confirm?: string) => {
      owner();
      const body = {
        ...(passphrase !== undefined ? { passphrase } : {}),
        ...(confirm !== undefined ? { confirm } : {}),
      };
      const parsed = dataExportSchema.safeParse(body);
      if (!parsed.success) throw zodIssues(parsed.error.issues);
      // A sealed export: Hub-only, then the Hub's name (DataControls.assertSealedExport).
      if (passphrase !== undefined) {
        if (st.deviceSession)
          throw refuse(
            'hub_only',
            'a sealed export carries every secret: start it on the Hub itself, not from a paired device',
            403,
            'policy_denied',
          );
        const name = st.overview.hubName;
        if ((confirm ?? '').trim().toLowerCase() !== name.trim().toLowerCase())
          throw err(
            400,
            'validation',
            `a sealed export carries every secret: type the Hub's name (${name}) to confirm`,
            { reason: 'confirmation_mismatch', field: 'confirm' },
          );
      }
      const ticket = `ticket-${st.tickets.size + 1}-abcdefghijklmnopqrstuvwxyz`;
      st.tickets.set(ticket, body);
      return { ticket, expiresAt: '2026-10-15T12:02:00.000Z' };
    },
    exportDownloadUrl: (ticket: string) =>
      `/api/v1/data/export/download?ticket=${encodeURIComponent(ticket)}`,
    deleteAllData: async (confirm: string) => {
      owner();
      const name = st.overview.hubName;
      if (confirm.trim().toLowerCase() !== name.trim().toLowerCase())
        throw err(400, 'validation', `type the Hub's name (${name}) to delete everything`, {
          reason: 'confirmation_mismatch',
          field: 'confirm',
        });
      if (st.busy)
        throw refuse('busy', "the Hub's data is busy: import is running", 409, 'conflict');
      const result = {
        deletedAt: NOW,
        tables: st.overview.tables,
        rows: st.overview.rows,
        files: st.overview.files.count,
        secrets: st.overview.secrets.count,
        keptPaths: [],
        restartRequired: true as const,
      };
      st.overview = {
        ...st.overview,
        rows: 3,
        files: { count: 0, bytes: 0 },
        secrets: { count: 0 },
        empty: true,
        blockingTables: [],
      };
      return result;
    },
    uploadImport: async (file: Blob) => {
      owner();
      if (!file.size) throw refuse('empty', 'the archive is empty');
      const name = (file as File).name ?? 'export.novaexport';
      const archive = st.archives[name] ?? plainArchive();
      const uploadId = `00000000-0000-4000-8000-${String(st.uploads.size + 1).padStart(12, '0')}`;
      st.uploads.set(uploadId, { name, bytes: file.size, archive });
      return {
        uploadId,
        bytes: file.size,
        encrypted: archive.encrypted,
        expiresAt: '2026-10-15T13:00:00.000Z',
      };
    },
    removeImportUpload: async (uploadId: string) => {
      owner();
      uploadOf(uploadId);
      st.uploads.delete(uploadId);
      return { ok: true as const };
    },
    checkImport: async (uploadId: string, passphrase?: string) => {
      owner();
      const u = uploadOf(uploadId);
      staged(u.archive, passphrase);
      return {
        ...structuredClone(u.archive.check),
        encrypted: u.archive.encrypted,
        hubEmpty: st.overview.empty,
        blockingTables: [...st.overview.blockingTables],
      };
    },
    importData: async (uploadId: string, passphrase?: string) => {
      owner();
      const u = uploadOf(uploadId);
      if (st.busy)
        throw refuse('busy', "the Hub's data is busy: delete-all is running", 409, 'conflict');
      if (!st.overview.empty)
        throw err(
          409,
          'conflict',
          'this Hub already holds data: an import goes into an empty Hub (delete all data first)',
          { reason: 'hub_not_empty', tables: st.overview.blockingTables },
        );
      staged(u.archive, passphrase);
      if (u.archive.refuseImport)
        throw refuse(u.archive.refuseImport.reason, u.archive.refuseImport.message);
      const c = u.archive.check;
      st.uploads.delete(uploadId);
      st.overview = {
        ...st.overview,
        rows: c.rows,
        tables: c.tables.length,
        files: { ...c.files },
        empty: false,
        blockingTables: c.tables.map((t) => t.name),
      };
      return {
        importedAt: NOW,
        tables: c.tables.length,
        rows: c.rows,
        files: c.files.count,
        secrets: c.secrets.included ? c.secrets.count : 0,
        verified: true as const,
        toReEnter: [...c.toReEnter],
        keptTables: u.archive.encrypted ? [] : ['trust_ca', 'relay_registration'],
        restoredOff: { mcpServers: 1, plugins: 2, agentAdapters: 0, hooks: 3, sessions: 1 },
        restartRequired: true as const,
      };
    },
    getRetention: async () => {
      owner();
      return {
        items: RETENTION_ITEMS.map((item) => {
          const days = helpers.setting(RETENTION_SETTING_KEYS[item]) as number | null;
          return {
            item,
            setting: RETENTION_SETTING_KEYS[item],
            days,
            floorDays: item === 'audit' ? AUDIT_RETENTION_FLOOR_DAYS : 1,
            cutoff: days === null ? null : '2026-09-15T12:00:00.000Z',
            due: days === null ? 0 : st.due[item],
          };
        }),
        lastSweep: st.lastSweep,
        nextSweepAt: '2026-10-16T03:00:00.000Z',
      };
    },
    sweepRetention: async () => {
      owner();
      const removed: Partial<Record<RetentionItem, number>> = {};
      for (const item of RETENTION_ITEMS) {
        const days = helpers.setting(RETENTION_SETTING_KEYS[item]);
        if (days !== null && st.due[item] > 0) {
          removed[item] = st.due[item];
          st.due[item] = 0;
        }
      }
      st.lastSweep = {
        id: `sweep-${Date.parse(NOW)}`,
        trigger: 'manual',
        startedAt: NOW,
        finishedAt: NOW,
        removed,
        skipped: {},
        error: null,
      };
      return structuredClone(st.lastSweep);
    },
    listCrashReports: async () => {
      owner();
      return {
        items: st.crash.map((c) => ({ ...c.report })),
        enabled: helpers.setting('privacy.crashReports') === true,
        endpoint: (helpers.setting('privacy.crashReportEndpoint') as string) || null,
      };
    },
    previewCrashReport: async (id: string) => {
      owner();
      return preview(id);
    },
    sendCrashReport: async (id: string) => {
      owner();
      const c = crashOf(id);
      const p = preview(id);
      if (!p.wouldSend)
        throw refuse(
          p.reason === 'off' ? 'crash_reports_off' : 'no_endpoint',
          p.reason === 'off'
            ? 'crash reports are off: turn on privacy.crashReports to send them'
            : 'no crash report endpoint is set',
          403,
          'policy_denied',
        );
      if (st.endpointStatus >= 300) {
        c.report = { ...c.report, lastError: `the endpoint answered ${st.endpointStatus}` };
        throw err(
          500,
          'server_error',
          `the crash report was not sent: the endpoint answered ${st.endpointStatus}`,
          {
            reason: 'send_failed',
          },
        );
      }
      c.report = { ...c.report, sentAt: NOW, lastError: null };
      return { ...c.report };
    },
    deleteCrashReport: async (id: string) => {
      owner();
      crashOf(id);
      st.crash = st.crash.filter((c) => c.report.id !== id);
      return { ok: true as const };
    },
    deleteAllCrashReports: async () => {
      owner();
      const deleted = st.crash.length;
      st.crash = [];
      return { deleted };
    },
    listSpendCaps: async () => ({ items: st.caps.map((c) => ({ ...c })) }),
    setSpendCap: async (provider, body) => {
      if (!spendProviderSchema.safeParse(provider).success)
        throw zodIssues([{ path: ['provider'], message: 'Invalid string' }]);
      const parsed = spendCapSchema.safeParse(body);
      if (!parsed.success) throw zodIssues(parsed.error.issues);
      const view = capView(provider, parsed.data, st.spent[provider] ?? 0);
      st.caps = [...st.caps.filter((c) => c.provider !== provider), view];
      return { ...view };
    },
    removeSpendCap: async (provider) => {
      if (!capOf(provider)) throw err(404, 'not_found', 'no spend cap for that provider');
      st.caps = st.caps.filter((c) => c.provider !== provider);
      return { ok: true as const };
    },
    listProviderLimits: async () => ({
      items: st.limits.map((l) => ({ ...l, spendCap: capOf(l.provider) })),
    }),
    clearUsage: async () => {
      const removed = st.usageRecords;
      st.usageRecords = 0;
      return { removed };
    },
  };
}

export type DatactlMocks = { [K in keyof DatactlApi]: Mock<DatactlApi[K]> };

/**
 * Render `ui` with the main fake Hub's client and the data-controls part spread over it (what
 * `createApi` will do). `managed` adds the managed-policy part and its settings layer (locks and
 * their source); `as: 'member'` signs in as Alex.
 */
export async function renderWithDatactl(
  ui: ReactNode,
  opts: {
    datactl?: Partial<M8DatactlState>;
    as?: 'owner' | 'member';
    settings?: Record<string, unknown>;
    managed?: Partial<M8ManagedState>;
    /** Runs before the first render (to make the first load fail, say). */
    prepare?: (mocks: DatactlMocks) => void;
  } = {},
) {
  const member = opts.as === 'member';
  const hub = createHub(member ? { m7team: m7TeamState({ me: MEMBER_ID }) } : {});
  hub.state.settings = { 'onboarding.state': DONE_ONBOARDING, ...opts.settings };
  const state = m8DatactlState(opts.datactl);
  const managedState = opts.managed ? m8ManagedState(opts.managed) : null;
  hub.state.managed = managedState ? managedLayerOf(managedState.view) : {};
  const setting = (k: SettingKey) =>
    resolveSetting(k, { global: hub.state.settings, managed: hub.state.managed }).value;
  const impl = m8DatactlImpl(state, { isMember: () => member, setting });
  const mocks = Object.fromEntries(
    Object.entries(impl).map(([k, fn]) => [
      k,
      typeof fn === 'function' ? vi.fn(fn as (...a: unknown[]) => unknown) : fn,
    ]),
  ) as unknown as DatactlMocks;
  opts.prepare?.(mocks);
  const managed = managedState ? m8ManagedImpl(managedState, { isMember: () => member }) : {};
  const api = { ...hub.api, ...managed, ...mocks };
  const { settings } = await hub.api.settings();
  // As App.tsx: locked @nova/ui fields draw the note that names the policy's source.
  const inner = createElement(ToastProvider, {
    children: createElement(AnnouncerProvider, {
      children: createElement(ManagedLockNotes, { children: ui }),
    }),
  });
  const utils = render(
    createElement(ServicesProvider, {
      api,
      eventSource: fakeEventSource,
      registry: testRegistry(),
      children: createElement(SettingsProvider, { api, initial: settings, children: inner }),
    }),
  );
  return { hub, api: mocks, state, ...utils };
}
