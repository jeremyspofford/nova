// Test environment for sync (FR-109): the core services over a migrated in-memory database, a sync
// service with service-backed writers, a simulated clock for the HLCs, two replica devices of the
// owner and one device of another account, and helpers to build device clocks and push.
import { randomUUID } from 'node:crypto';
import { checkSettingWrite, type SettingKey, type SyncOp } from '@nova/shared';
import {
  NotificationService,
  ProjectService,
  ScheduleService,
  SpaceService,
  SyncService,
  formatHlc,
  serviceWriters,
  type AuditRecord,
} from '../src/index.ts';
import { ACCOUNT, makeEnv, type Env } from './helpers.ts';

export { ACCOUNT };
export const OTHER = '01920000-0000-7000-8000-0000000000f2';
export const DEV_A = '01920000-0000-7000-8000-0000000000da';
export const DEV_B = '01920000-0000-7000-8000-0000000000db';
export const DEV_OTHER = '01920000-0000-7000-8000-0000000000dc';

export interface SyncEnv extends Env {
  sync: SyncService;
  spaces: SpaceService;
  schedules: ScheduleService;
  audit: AuditRecord[];
  clock: { t: number };
  settingsWritten: { key: string; value: unknown }[];
  /** A device clock `offsetMs` from the simulated now. */
  hlc: (device: string, offsetMs?: number, c?: number) => string;
  op: (
    device: string,
    kind: SyncOp['kind'],
    id: string,
    field: string,
    value: unknown,
    extra?: { offsetMs?: number; base?: string | null; c?: number },
  ) => SyncOp;
  /** A fresh service over the same database (a restart). */
  restart: () => SyncService;
  makeDevice: (id: string, accountId?: string, scopes?: string[]) => void;
}

export async function syncEnv(): Promise<SyncEnv> {
  const env = await makeEnv();
  const clock = { t: Date.now() };
  const now = () => new Date(clock.t);
  const db = env.db;
  const iso = new Date(clock.t - 60_000).toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Other', ?, ?)",
    )
    .run(OTHER, new Date(clock.t + 60_000).toISOString(), iso);
  const makeDevice = (id: string, accountId = ACCOUNT, scopes = ['offline-replica']) => {
    db.raw
      .prepare(
        `INSERT INTO device (id, account_id, name, kind, platform, cert_fingerprint, public_key, roles,
           scopes, status, offline_replica, created_at, updated_at)
         VALUES (?, ?, ?, 'client', 'web', ?, ?, '["client"]', ?, 'active', ?, ?, ?)`,
      )
      .run(
        id,
        accountId,
        `Device ${id.slice(-2)}`,
        randomUUID(),
        randomUUID(),
        JSON.stringify(scopes),
        scopes.includes('offline-replica') ? 1 : 0,
        iso,
        iso,
      );
  };
  makeDevice(DEV_A);
  makeDevice(DEV_B);
  makeDevice(DEV_OTHER, OTHER);
  const audit: AuditRecord[] = [];
  const auditSink = { append: (r: AuditRecord) => Promise.resolve(void audit.push(r)) };
  const spaces = new SpaceService({ db, events: env.events, audit: auditSink });
  const schedules = new ScheduleService({
    db,
    events: env.events,
    secrets: env.secrets,
    notifier: new NotificationService({ db }),
    timers: { setTimeout: () => 0, clearTimeout: () => undefined },
  });
  // Projects announce their changes when the Hub gives them the event sink (as app.ts does).
  const projects = new ProjectService({ db, events: env.events });
  // The Hub's settings writer: validated, then stored globally (docs/14 §1).
  const settingsWritten: { key: string; value: unknown }[] = [];
  const writeSetting = (_accountId: string, key: string, value: unknown): Promise<void> => {
    const check = checkSettingWrite(key, value, 'global', { global: {}, project: {}, managed: {} });
    if (!check.ok) return Promise.reject(new Error(check.message));
    settingsWritten.push({ key, value: check.value });
    db.raw
      .prepare(
        `INSERT INTO setting (key, scope_kind, scope_ref, value_json, updated_at)
         VALUES (?, 'global', '', ?, ?)
         ON CONFLICT (key, scope_kind, scope_ref) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, JSON.stringify(check.value), now().toISOString());
    return Promise.resolve();
  };
  const build = () =>
    new SyncService({
      db,
      events: env.events,
      audit: auditSink,
      now,
      writers: serviceWriters({
        db,
        events: env.events,
        threads: env.threads,
        projects,
        memory: env.memory,
        spaces,
        schedules,
        setting: writeSetting,
      }),
    });
  const sync = build();
  const off = env.events.on((e) => sync.onEvent(e));
  const hlc = (device: string, offsetMs = 0, c = 0) =>
    formatHlc({ pt: clock.t + offsetMs, c, node: device });
  return {
    ...env,
    projects,
    sync,
    spaces,
    schedules,
    audit,
    clock,
    settingsWritten,
    hlc,
    op: (device, kind, id, field, value, extra = {}) => ({
      kind,
      id,
      field,
      value,
      hlc: hlc(device, extra.offsetMs ?? 0, extra.c ?? 0),
      ...(extra.base !== undefined ? { base: extra.base } : {}),
    }),
    restart: build,
    makeDevice,
    close: async () => {
      off();
      await sync.close();
      await schedules.stop();
      await env.close();
    },
  };
}

/** Settings that are not security-relevant (they sync) and one that is (it never does). */
export const PLAIN_SETTING = 'appearance.theme' satisfies SettingKey;
export const SECURITY_SETTING = 'sync.enabled' satisfies SettingKey;
