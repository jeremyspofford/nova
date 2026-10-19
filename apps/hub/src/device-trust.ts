// Device trust area (FR-126, R-022; docs/22 §5 and §9.1; contracts/hub-api.md §1 "Auth & devices",
// §2, §3): mutual TLS for novad devices and compute nodes. When the Hub serves HTTPS the listener
// asks every client for a certificate of the Hub local CA without requiring one (main.ts), so
// browsers keep working; this area checks it on the device and node routes, in addition to the
// bearer credential those routes check themselves:
//
// - a presented certificate must pass the trust area's `verifyDeviceCertificate` (issuer,
//   signature, validity, the recorded serial, revocation) and belong to the caller: the device the
//   credential names (its id and key), or on registration the key in the body;
// - without one, a device the Hub issued a live certificate to is refused (its credential alone,
//   perhaps captured over plain HTTP before, is not enough); for others
//   `devices.tls.allowWithoutCertificate` decides (on by default for one release, with a
//   diagnostics problem); off, the call is refused;
// - plain HTTP, and requests the Relay tunnels in, are not affected.
//
// Refusals are 403 `policy_denied` with `details.reason` `certificate_<why>` (novad and the
// compute node name it), audited as `device.tls.refuse` (at most once an hour per device and
// reason). A device's state is announced as `device.tls.changed` when it changes. The owner route
// `GET /api/v1/devices/tls` (session) lists what each device last presented.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TLSSocket } from 'node:tls';
import {
  NovaError,
  type DeviceTlsReason,
  type DeviceTlsState,
  type DeviceTlsSummaryView,
  type DeviceTlsView,
} from '@nova/shared';
import {
  computeNodeForCredential,
  novadDeviceForCredential,
  rawEd25519,
  type AuditSink,
  type DeviceCertificateCheck,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

/** The routes novad and compute nodes call; `register` has no credential yet. */
const ROUTES: Record<string, { kind: 'novad' | 'compute'; register: boolean }> = {
  '/agent/v1/register': { kind: 'novad', register: true },
  '/agent/v1/heartbeat': { kind: 'novad', register: false },
  '/agent/v1/capabilities': { kind: 'novad', register: false },
  '/node/v1/register': { kind: 'compute', register: true },
  '/node/v1/heartbeat': { kind: 'compute', register: false },
  '/node/v1/models/sync': { kind: 'compute', register: false },
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface DeviceTrustDeps {
  /** The trust area's check (`trust.verifyDeviceCertificate`). */
  verifyDeviceCertificate(pem: string): DeviceCertificateCheck;
  audit?: AuditSink;
  now?: () => Date;
}

export interface DeviceTrustArea extends HubArea {
  /** What each device of the account last presented over HTTPS, and the problems. */
  summary(accountId?: string): Promise<DeviceTlsSummaryView>;
  /** For network diagnostics (the trust problems list). */
  problems(): string[];
  useAudit(audit: AuditSink): void;
}

interface Seen extends DeviceTlsView {
  accountId: string;
}

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return token || null;
}

/** The TLS socket a request arrived on, or null (plain HTTP, or tunneled through the Relay). */
function tlsSocketOf(req: FastifyRequest): TLSSocket | null {
  const socket = req.raw.socket as Partial<TLSSocket> | undefined;
  return socket?.encrypted === true && typeof socket.getPeerX509Certificate === 'function'
    ? (socket as TLSSocket)
    : null;
}

function refuse(reason: DeviceTlsReason, message: string): NovaError {
  return new NovaError('policy_denied', message, {
    details: { reason },
    action: 'Add the device again with the Hub local CA as the trust path',
  });
}

export function setupDeviceTrust(ctx: HubContext, deps: DeviceTrustDeps): Promise<DeviceTrustArea> {
  const log = ctx.log.child('device-trust');
  const now = deps.now ?? (() => new Date());
  let audit: AuditSink | null = deps.audit ?? null;
  const seen = new Map<string, Seen>();
  const audited = new Map<string, number>();

  /** Remember what a device presented; announce a change and audit a refusal. */
  async function note(
    row: { id: string; accountId: string; name: string },
    kind: 'novad' | 'compute',
    certificate: DeviceTlsState,
    reason: DeviceTlsReason | null,
    serial: string | null,
  ): Promise<void> {
    const at = now();
    const prev = seen.get(row.id);
    seen.set(row.id, {
      deviceId: row.id,
      accountId: row.accountId,
      kind,
      name: row.name,
      certificate,
      reason,
      serial,
      lastHttpsAt: at.toISOString(),
    });
    if (prev?.certificate !== certificate || prev.reason !== reason || prev.serial !== serial) {
      await ctx.events
        .emit({
          name: 'device.tls.changed',
          accountId: row.accountId,
          payload: { deviceId: row.id, kind, certificate, reason, serial },
        })
        .catch((err: unknown) => log.warn('device.tls.changed not emitted', { err }));
    }
    if (certificate !== 'refused' || !reason) return;
    const key = `${row.id}:${reason}`;
    const last = audited.get(key) ?? -Infinity;
    if (at.getTime() - last < HOUR) return;
    audited.set(key, at.getTime());
    await audit
      ?.append({
        accountId: row.accountId,
        actor: 'system',
        kind: 'device',
        action: 'device.tls.refuse',
        resource: row.id,
        detail: { kind, reason, serial },
      })
      .catch((err: unknown) => log.warn('device.tls.refuse audit failed', { err }));
  }

  /** Whether the Hub issued this device a certificate that is neither revoked nor expired. */
  function holdsCertificate(deviceId: string, publicKey: string): boolean {
    return Boolean(
      ctx.db.raw
        .prepare(
          `SELECT 1 FROM trust_certificate
           WHERE kind = 'device' AND revoked_at IS NULL AND not_after > ?
             AND (device_id = ? OR public_key = ?)
           LIMIT 1`,
        )
        .get(now().toISOString(), deviceId, publicKey),
    );
  }

  /** The device row a registration's key belongs to (Add Device made it pending), if any. */
  function deviceByKey(
    publicKey: string,
  ): { id: string; accountId: string; name: string; publicKey: string } | null {
    const r = ctx.db.raw
      .prepare(
        `SELECT id, account_id AS accountId, name, public_key AS publicKey FROM device
         WHERE public_key = ? AND status != 'revoked' LIMIT 1`,
      )
      .get(publicKey) as
      { id: string; accountId: string; name: string; publicKey: string } | undefined;
    return r ?? null;
  }

  /** The preHandler: runs only for the device and node routes, over TLS. */
  async function check(req: FastifyRequest): Promise<void> {
    const route = ROUTES[req.routeOptions.url ?? ''];
    if (!route) return;
    const socket = tlsSocketOf(req);
    if (!socket) return; // plain HTTP stays as before (docs/22 §9.1)
    const peer = socket.getPeerX509Certificate();
    // Who is calling: the device the credential names, or the key a registration brings.
    let row: { id: string; accountId: string; name: string; publicKey: string } | null = null;
    let claimedKey: string | null = null;
    if (route.register) {
      const body = req.body as { publicKey?: unknown } | null | undefined;
      claimedKey = typeof body?.publicKey === 'string' ? body.publicKey : null;
    } else {
      const token = bearer(req);
      if (!token) return; // the route answers 401 itself
      row =
        route.kind === 'novad'
          ? await novadDeviceForCredential(ctx.db, token)
          : await computeNodeForCredential(ctx.db, token);
      if (!row) return; // an unknown or revoked credential: the route's own 401
    }
    if (!peer) {
      // A device the Hub issued a live certificate to must present it, whatever the setting
      // says: its bearer credential alone (perhaps captured over plain HTTP before) is not enough.
      const known = row ?? (claimedKey ? deviceByKey(claimedKey) : null);
      const holds = known ? holdsCertificate(known.id, known.publicKey) : false;
      if (!holds && (await ctx.setting('devices.tls.allowWithoutCertificate'))) {
        if (row) await note(row, route.kind, 'missing', null, null);
        return;
      }
      if (known) await note(known, route.kind, 'refused', 'certificate_required', null);
      throw refuse(
        'certificate_required',
        holds
          ? 'this device holds a device certificate and must present it over HTTPS'
          : 'this Hub requires a device certificate over HTTPS, and none was presented',
      );
    }
    const result = deps.verifyDeviceCertificate(peer.toString());
    if (!result.ok) {
      const reason: DeviceTlsReason = `certificate_${result.reason}`;
      if (row) await note(row, route.kind, 'refused', reason, null);
      else log.warn('a registration presented a certificate the Hub refuses', { reason });
      throw refuse(reason, `the device certificate was refused (${result.reason})`);
    }
    // The certificate must be this caller's: a valid certificate of another device is refused.
    let key: string | null;
    try {
      key = rawEd25519(peer.publicKey).toString('base64url');
    } catch {
      key = null; // not an Ed25519 key: no device's
    }
    const mine = row
      ? result.deviceId === row.id && key === row.publicKey
      : key !== null && key === claimedKey;
    if (!mine) {
      if (row) await note(row, route.kind, 'refused', 'certificate_mismatch', result.serial);
      throw refuse('certificate_mismatch', 'the device certificate belongs to another device');
    }
    if (row) await note(row, route.kind, 'verified', null, result.serial);
  }

  function problems(): string[] {
    const t = now().getTime();
    const recent = [...seen.values()].filter((s) => t - Date.parse(s.lastHttpsAt) < DAY);
    const out: string[] = [];
    const missing = recent.filter((s) => s.certificate === 'missing');
    if (missing.length) {
      const one = missing.length === 1;
      const names = missing.map((s) => s.name ?? s.deviceId).join(', ');
      out.push(
        one
          ? `1 device reaches the Hub over HTTPS without a device certificate (${names}): it is accepted while devices.tls.allowWithoutCertificate is on; add it again with the Hub local CA as the trust path to give it one.`
          : `${missing.length} devices reach the Hub over HTTPS without a device certificate (${names}): they are accepted while devices.tls.allowWithoutCertificate is on; add them again with the Hub local CA as the trust path to give each one.`,
      );
    }
    const refused = recent.filter((s) => s.certificate === 'refused');
    if (refused.length)
      out.push(
        `${refused.length} device${refused.length === 1 ? ' was' : 's were'} refused over HTTPS: ${refused
          .map((s) => `${s.name ?? s.deviceId} (${s.reason ?? 'refused'})`)
          .join(', ')}.`,
      );
    return out;
  }

  async function summary(accountId?: string): Promise<DeviceTlsSummaryView> {
    const items = [...seen.values()]
      .filter((s) => !accountId || s.accountId === accountId)
      .sort((a, b) => b.lastHttpsAt.localeCompare(a.lastHttpsAt))
      .map((s): DeviceTlsView => {
        const { accountId: _account, ...view } = s;
        return view;
      });
    return {
      requireCertificate: !(await ctx.setting('devices.tls.allowWithoutCertificate')),
      items,
      problems: problems(),
    };
  }

  // A device revoked anywhere is forgotten here too (its next call is refused by its credential).
  const off = ctx.events.bus.subscribe('device.status.changed', (e) => {
    const id = e.payload.deviceId;
    if (e.payload.status === 'revoked' && typeof id === 'string') seen.delete(id);
  });

  ctx.diagnostics.add('deviceTls', async () => {
    const all = [...seen.values()];
    const count = (c: DeviceTlsState) => all.filter((s) => s.certificate === c).length;
    return {
      requireCertificate: !(await ctx.setting('devices.tls.allowWithoutCertificate')),
      verified: count('verified'),
      missing: count('missing'),
      refused: count('refused'),
      problems: problems(),
    };
  });

  return Promise.resolve({
    summary,
    problems,
    useAudit: (a) => {
      audit = a;
    },
    register(app: FastifyInstance) {
      app.addHook('preHandler', check);
      app.get('/api/v1/devices/tls', async (req) => summary(await ctx.accountOf(req)));
    },
    close() {
      off();
      return Promise.resolve();
    },
  });
}
