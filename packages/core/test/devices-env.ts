// Shared setup for the devices tests: a migrated database with an account, the service with a
// simulated clock, and a fake novad device enrolled against a tiny HTTP front for the
// novad -> Hub routes (the Hub's own routes are tested in apps/hub).
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NovaError } from '@nova/shared';
import { MemorySecretStore } from '@nova/secrets';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  DeviceService,
  FakeDevice,
  MemoryEventSink,
  type AuditRecord,
  type DeviceServiceOptions,
  type FakeDeviceOptions,
} from '../src/index.ts';

export const ACCOUNT = '01920000-0000-7000-8000-000000000001';
export const OTHER = '01920000-0000-7000-8000-000000000002';

/** A migrated in-memory database with two accounts. */
export async function devicesDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const iso = new Date().toISOString();
  for (const id of [ACCOUNT, OTHER])
    db.raw
      .prepare("INSERT INTO account (id, kind, created_at, updated_at) VALUES (?, 'local', ?, ?)")
      .run(id, iso, iso);
  return db;
}

export interface DevicesEnv {
  db: NovaDatabase;
  secrets: MemorySecretStore;
  events: MemoryEventSink;
  audit: AuditRecord[];
  clock: { now: number };
  svc: DeviceService;
  hubUrl: string;
  dir: string;
  devices: FakeDevice[];
  /** Enroll a new fake device; it listens on 127.0.0.1. */
  enroll(opts?: FakeDeviceOptions & { roles?: string[] }): Promise<FakeDevice>;
  close(): Promise<void>;
}

/** Map service errors to HTTP like the Hub does (a tiny stand-in for its error handler). */
function statusOf(err: unknown): number {
  if (err instanceof NovaError) {
    return (
      { auth_missing: 401, validation: 400, policy_denied: 403, conflict: 409, not_found: 404 }[
        err.code as string
      ] ?? 500
    );
  }
  return 400;
}

export async function devicesEnv(opts: Partial<DeviceServiceOptions> = {}): Promise<DevicesEnv> {
  const db = await devicesDb();
  const secrets = new MemorySecretStore();
  const events = new MemoryEventSink();
  const audit: AuditRecord[] = [];
  const clock = { now: Date.parse('2026-10-17T10:00:00.000Z') };
  const svc = new DeviceService({
    db,
    secrets,
    events,
    audit: {
      append: (r) => {
        audit.push(r);
        return Promise.resolve();
      },
    },
    now: () => new Date(clock.now),
    ...opts,
  });
  // The novad -> Hub routes, as the Hub area serves them.
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      const cred = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const run = async (): Promise<[number, unknown]> => {
        if (req.url === '/agent/v1/register') return [201, await svc.register(body)];
        if (req.url === '/agent/v1/heartbeat') return [200, await svc.heartbeat(cred, body)];
        if (req.url === '/agent/v1/capabilities') {
          await svc.updateCapabilities(cred, body);
          return [200, { ok: true }];
        }
        return [404, {}];
      };
      run()
        .then(([status, out]) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out));
        })
        .catch((err: unknown) => {
          res.writeHead(statusOf(err), { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: err instanceof NovaError ? err.code : 'validation',
                message: err instanceof Error ? err.message : 'error',
              },
            }),
          );
        });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const hubUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nova-devices-')));
  const devices: FakeDevice[] = [];
  return {
    db,
    secrets,
    events,
    audit,
    clock,
    svc,
    hubUrl,
    dir,
    devices,
    async enroll(o = {}) {
      const fake = new FakeDevice(o);
      devices.push(fake);
      const t = await svc.createEnrollToken(ACCOUNT, o.roles ?? ['client'], hubUrl);
      await fake.enroll(hubUrl, t.token);
      return fake;
    },
    async close() {
      svc.stop();
      for (const d of devices) await d.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
