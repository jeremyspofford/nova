// Trust paths (FR-134, docs/22 §5): the Hub local CA, the Hub's TLS leaf, device certificates for
// Add Device, mesh certificates, the revocation list, and what the HTTPS listener serves.
//
// - The local CA is ECDSA P-256, valid ten years, with name constraints (local names, private
//   address ranges and the names the Hub had when it was created), so the root a device installs
//   can never vouch for anyone else's site. Its key is a vault entry, like every other Hub key
//   (docs/12 §5); the database keeps only its public certificate.
// - The leaf is valid 90 days and renewed at two thirds of its life or as soon as the names the
//   Hub answers to change. Names outside the CA's constraints are left out and reported.
// - A device certificate carries the device's own Ed25519 key, signed by the CA; revoking a device
//   revokes its certificates, and `verifyDeviceCertificate` consults that list.
// - Mesh certificates come from the mesh (e.g. `tailscale cert`) through a source the network
//   setup area provides; the Hub stores them and serves them for their host name.
// The egress inspection CA (computers/egress-ca.ts) is a different CA with its own key.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';
import {
  NovaError,
  hubIdentityStatementBytes,
  uuidv7,
  type HubIdentityStatement,
  type TrustCaView,
  type TrustCertificateKind,
  type TrustCertificateView,
  type TrustLeafView,
  type TrustMeshCertView,
  type TrustMode,
  type TrustServingView,
  type TrustSummary,
  type TrustView,
  type DeviceCertificateStateView,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditSink } from '../tools/types.ts';
import { ed25519FromRaw, HubIdentity } from './identity.ts';
import {
  buildCertificate,
  certificateFingerprint,
  KEY_USAGE,
  keyId,
  nameConstraintsPermit,
  OID,
  pemToDer,
  type NameConstraints,
} from './x509.ts';

const DAY = 86_400_000;
export const LOCAL_CA_DAYS = 3650;
export const LEAF_DAYS = 90;
export const DEVICE_CERT_DAYS = 365;
/** The Hub's client certificate for the management channel lives as long as its TLS leaf. */
export const HUB_CLIENT_DAYS = LEAF_DAYS;
/**
 * The vault entry holding the Hub's client certificate and its key (ADR-096 D1): one JSON value
 * `{certPem, keyPem}`. The certificate is public; the key never leaves the vault but for the TLS
 * client that presents it.
 */
export const HUB_CLIENT_REF = 'secret://hub/client-certificate';
/**
 * How long after a renewal was issued the Hub still accepts the device's old certificate without
 * serverAuth on the management channel (the device installs the renewal at its next check-in).
 */
export const LEGACY_SERVER_CERT_GRACE_MS = 10 * 60_000;
/** A mesh certificate this close to expiry is `expiring`. */
const MESH_EXPIRING_DAYS = 14;
const MAX_SANS = 100;

/**
 * What the local CA may always sign: the special-use names that can never be delegated to anyone
 * (mDNS `.local` and `localhost`, RFC 6761/6762; RFC 8375 `home.arpa`; `.internal`, reserved for
 * private use) and private, loopback, link-local and carrier-grade NAT ranges (mesh addresses live
 * there). The Hub's own names of two labels or more, as it has them when the CA is created, are
 * added to these; a single-label name never is (`dev` would cover every `.dev` site).
 */
export const LOCAL_CA_BASE_CONSTRAINTS: NameConstraints = {
  dns: ['local', 'localhost', 'home.arpa', 'internal'],
  ip: [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '127.0.0.0/8',
    '100.64.0.0/10',
    '169.254.0.0/16',
    '::1/128',
    'fc00::/7',
    'fe80::/10',
  ],
};

export interface TrustSettings {
  mode(): Promise<TrustMode>;
  meshCerts(): Promise<boolean>;
  pinNativeShells(): Promise<boolean>;
}

/** Issues a certificate for a host on the mesh (agent D's `tailscale cert` adapter). */
export interface MeshCertSource {
  request(host: string): Promise<{ certPem: string; keyPem: string; notAfter: string | Date }>;
}

/** What the HTTPS listener serves: a default certificate and per-name ones (SNI). */
export interface TlsMaterial {
  cert: string;
  key: string;
  sni: { host: string; cert: string; key: string }[];
}

export interface DeviceCertificateRequest {
  deviceId: string;
  /** base64url of the device's raw 32-byte Ed25519 public key. */
  publicKey: string;
  role: string;
}

/**
 * The Hub's client certificate for the Hub -> novad management channel (ADR-096 D1): issued by the
 * local CA, URI SAN `urn:nova:hub:<hubFingerprint>`, EKU clientAuth, renewed with the TLS leaf.
 */
export interface HubClientCertificate {
  certPem: string;
  keyPem: string;
  /** The local CA that issued it: what device certificates must chain to. */
  caPem: string;
  /** Lower-case hex. */
  serial: string;
  notBefore: string;
  notAfter: string;
  uri: string;
}

export type DeviceCertificateCheck =
  | { ok: true; deviceId: string; role: string | null; serial: string }
  | {
      ok: false;
      reason:
        | 'malformed'
        | 'no_ca'
        | 'unknown_issuer'
        | 'bad_signature'
        | 'not_yet_valid'
        | 'expired'
        | 'unknown_serial'
        | 'revoked';
    };

export interface TrustServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  settings: TrustSettings;
  /** The names and addresses the Hub answers to; the leaf certifies those the CA may sign. */
  names: () => Promise<string[]>;
  identity?: HubIdentity;
  events?: EventSink;
  audit?: AuditSink;
  log?: Logger;
  now?: () => Date;
  /** The owner account, for audit rows of system actions (none before setup). */
  ownerAccount?: () => Promise<string | null>;
}

interface CaRow {
  id: string;
  cert_pem: string;
  fingerprint: string;
  /** Null once a retired CA's key left the vault. */
  key_ref: string | null;
  name_constraints_json: string;
  not_before: string;
  not_after: string;
  created_at: string;
}

interface CertRow {
  id: string;
  ca_id: string | null;
  kind: TrustCertificateKind;
  serial: string;
  subject: string;
  device_id: string | null;
  role: string | null;
  sans_json: string;
  public_key: string | null;
  cert_pem: string;
  key_ref: string | null;
  not_before: string;
  not_after: string;
  created_at: string;
  superseded_at: string | null;
  revoked_at: string | null;
}

interface Actor {
  actor: 'user' | 'system';
  accountId?: string | null;
}

const SYSTEM: Actor = { actor: 'system' };

const DNS_NAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
// No dots: a device certificate's common name must never look like a host name.
const DEVICE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ROLE = /^[a-z][a-z0-9-]{0,31}$/;

/** A host name or IP literal fit for a certificate, lower-cased; null otherwise. */
export function certificateName(name: string): string | null {
  const n = name.trim().toLowerCase().replace(/\.$/, '');
  if (n.includes('%')) return null; // scoped IPv6 (fe80::1%eth0) cannot be certified
  if (isIP(n)) return n;
  return DNS_NAME.test(n) ? n : null;
}

/**
 * A DNS name with fewer than two labels (`dev`, `nova-hub`): it could be a top-level domain, so it
 * never enters the CA's constraints or the leaf. `localhost` is the one exception (RFC 6761).
 */
export function isSingleLabel(name: string): boolean {
  return !isIP(name) && !name.includes('.') && name !== 'localhost';
}

/** SHA-256 of a certificate's DER, lower-case hex. */
function sha256Hex(pem: string): string {
  return createHash('sha256').update(pemToDer(pem)).digest('hex');
}

function commonNameOf(subject: string): string {
  const line = subject.split('\n').find((l) => l.startsWith('CN='));
  return line ? line.slice(3) : subject;
}

function iso(d: Date): string {
  return d.toISOString();
}

/** Certificates carry whole seconds; stored times match them exactly. */
function validity(now: Date, days: number): { notBefore: Date; notAfter: Date } {
  const t = Math.floor(now.getTime() / 1000) * 1000;
  return { notBefore: new Date(t - 3_600_000), notAfter: new Date(t + days * DAY) };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

/** Whether certificate `a` was issued before `b` (UUIDv7 ids break ties within a millisecond). */
function before(a: { id: string; created_at: string }, b: { id: string; created_at: string }) {
  return a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);
}

/** When a certificate is renewed: at two thirds of its life. */
function renewAt(notBefore: string, notAfter: string): number {
  const from = Date.parse(notBefore);
  return from + ((Date.parse(notAfter) - from) * 2) / 3;
}

export class TrustService {
  readonly identity: HubIdentity;
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #settings: TrustSettings;
  readonly #names: () => Promise<string[]>;
  readonly #events: EventSink | null;
  #audit: AuditSink | null;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #owner: () => Promise<string | null>;
  #mesh: MeshCertSource | null = null;
  #serving: TrustServingView | null = null;
  /** The last maintenance failures, by what failed (`leaf`, `mesh:<host>`). */
  readonly #failures = new Map<string, string>();
  readonly #tlsListeners = new Set<() => void>();
  /** Certificate issuance runs one at a time, so two callers never mint two leaves. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(opts: TrustServiceOptions) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#settings = opts.settings;
    this.#names = opts.names;
    this.identity =
      opts.identity ??
      new HubIdentity({
        secrets: opts.secrets,
        db: opts.db,
        ...(opts.now ? { now: opts.now } : {}),
      });
    this.#events = opts.events ?? null;
    this.#audit = opts.audit ?? null;
    this.#log = opts.log ?? new Logger({ module: 'core.trust', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#owner = opts.ownerAccount ?? (() => Promise.resolve(null));
  }

  /**
   * Load the Hub identity key (created on the very first start). Throws, and the trust area stays
   * down, when the recorded key is missing from the vault or differs: never a new identity then.
   */
  async start(): Promise<void> {
    await this.identity.load();
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  useMeshCerts(source: MeshCertSource): void {
    this.#mesh = source;
  }

  /** The listener says what it serves, so the view can tell whether a restart is needed. */
  reportServing(serving: TrustServingView): void {
    this.#serving = serving;
  }

  /** Called when the TLS material changes (a renewal, a new mesh certificate). */
  onTlsChange(listener: () => void): () => void {
    this.#tlsListeners.add(listener);
    return () => this.#tlsListeners.delete(listener);
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(fn, fn);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  /** Tell the listener to read the material again (a setting it depends on changed). */
  refreshTls(): void {
    this.#tlsChanged();
  }

  #tlsChanged(): void {
    for (const l of this.#tlsListeners) {
      try {
        l();
      } catch (err) {
        this.#log.warn('a TLS change listener failed', { err });
      }
    }
  }

  async #record(
    who: Actor,
    action: string,
    resource: string | null,
    detail: Record<string, unknown>,
    event: Record<string, unknown> | null,
  ): Promise<void> {
    const accountId = who.accountId ?? (await this.#owner().catch(() => null));
    if (this.#audit && accountId) {
      await this.#audit
        .append({ accountId, actor: who.actor, kind: 'network', action, resource, detail })
        .catch((err: unknown) => this.#log.warn('trust audit failed', { err, action }));
    }
    if (event && this.#events) {
      await this.#events
        .emit({
          name: 'trust.changed',
          actor: who.actor,
          ...(accountId ? { accountId } : {}),
          payload: event,
        })
        .catch((err: unknown) => this.#log.warn('trust event failed', { err }));
    }
  }

  // ---- the local CA ---------------------------------------------------------------------------

  #caRow(): CaRow | null {
    return (
      (this.#db.raw
        .prepare('SELECT * FROM trust_ca WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1')
        .get() as CaRow | undefined) ?? null
    );
  }

  /** The active local CA's public certificate, or null before one was created. */
  caCertificate(): string | null {
    return this.#caRow()?.cert_pem ?? null;
  }

  async #candidateNames(): Promise<string[]> {
    let raw: string[] = [];
    try {
      raw = await this.#names();
    } catch (err) {
      this.#log.warn('reading the Hub names failed', { err });
    }
    const out = new Set<string>(['localhost', '127.0.0.1', '::1']);
    for (const n of raw) {
      const c = certificateName(n);
      if (c) out.add(c);
    }
    return [...out];
  }

  /** The local CA, created on first use (trust mode `local-ca`). */
  ensureCa(who: Actor = SYSTEM): Promise<CaRow> {
    return this.#serialize(() => this.#ensureCa(who));
  }

  /**
   * The active CA, or the first one. An existing CA is never replaced here, not even when its key
   * is missing from the vault (signing then fails and `problems` says why): only the owner
   * replaces it (`rotateCa`), since every device must install the new root.
   */
  async #ensureCa(who: Actor): Promise<CaRow> {
    const row = this.#caRow();
    if (row) return row;
    const fresh = await this.#newCa();
    await this.#db.transaction(() => this.#insertCa(fresh.row));
    await this.#record(
      who,
      'trust.ca.create',
      fresh.row.id,
      { fingerprint: fresh.row.fingerprint },
      { reason: 'ca_created', fingerprint: fresh.row.fingerprint },
    );
    return fresh.row;
  }

  /**
   * Replace the local CA at the owner's request: the new key goes into the vault first, then one
   * transaction makes the new CA the active one and retires the old one with its leaf, so a failed
   * vault write or insert leaves the old CA active. A leaf from the new CA follows; the old keys
   * leave the vault once nothing serves them. Device certificates of the old CA stop verifying.
   */
  rotateCa(who: Actor = SYSTEM): Promise<CaRow> {
    return this.#serialize(async () => {
      const old = this.#caRow();
      const fresh = await this.#newCa();
      const at = iso(this.#now());
      try {
        await this.#db.transaction(() => {
          // The one-active-CA index is checked per statement: the old row is retired first,
          // inside the same transaction, so both changes land together or not at all.
          if (old)
            this.#db.raw.prepare('UPDATE trust_ca SET retired_at = ? WHERE id = ?').run(at, old.id);
          this.#insertCa(fresh.row);
        });
      } catch (err) {
        if (fresh.row.key_ref) await this.#secrets.delete(fresh.row.key_ref).catch(() => false);
        throw err;
      }
      await this.#record(
        who,
        'trust.ca.rotate',
        fresh.row.id,
        { fingerprint: fresh.row.fingerprint, replaced: old?.fingerprint ?? null },
        {
          reason: 'ca_rotated',
          fingerprint: fresh.row.fingerprint,
          previous: old?.fingerprint ?? null,
        },
      );
      const { sans } = await this.#leafNames(fresh.row);
      await this.#issueLeaf(fresh.row, sans, who, 'ca_rotated');
      return fresh.row;
    });
  }

  /** A new CA certificate with its key already in the vault (not yet recorded). */
  async #newCa(): Promise<{ row: CaRow }> {
    // The CA is named after the identity: no identity (its key missing), no CA.
    await this.identity.load();
    const now = this.#now();
    const constraints: NameConstraints = {
      dns: [...LOCAL_CA_BASE_CONSTRAINTS.dns],
      ip: [...LOCAL_CA_BASE_CONSTRAINTS.ip],
    };
    for (const n of await this.#candidateNames()) {
      if (isIP(n) || isSingleLabel(n)) continue;
      if (!nameConstraintsPermit(constraints, n)) constraints.dns.push(n);
    }
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const subject = {
      commonName: `Nova Hub local CA ${this.identity.fingerprint.slice(0, 8)}`,
    };
    const { notBefore, notAfter } = validity(now, LOCAL_CA_DAYS);
    const cert = buildCertificate({
      subject,
      issuer: subject,
      publicKey,
      signer: privateKey,
      notBefore,
      notAfter,
      ca: { pathLength: 0 },
      keyUsage: KEY_USAGE.digitalSignature | KEY_USAGE.keyCertSign | KEY_USAGE.cRLSign,
      nameConstraints: constraints,
    });
    const id = uuidv7();
    const keyRef = `secret://hub/ca/${id}/key`;
    await this.#secrets.put(keyRef, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    return {
      row: {
        id,
        cert_pem: cert.pem,
        fingerprint: certificateFingerprint(cert.pem),
        key_ref: keyRef,
        name_constraints_json: JSON.stringify(constraints),
        not_before: iso(notBefore),
        not_after: iso(notAfter),
        created_at: iso(now),
      },
    };
  }

  #insertCa(row: CaRow): void {
    this.#db.raw
      .prepare(
        `INSERT INTO trust_ca (id, cert_pem, fingerprint, key_ref, name_constraints_json,
           not_before, not_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.cert_pem,
        row.fingerprint,
        row.key_ref,
        row.name_constraints_json,
        row.not_before,
        row.not_after,
        row.created_at,
      );
  }

  /** The CA's private key, refused when it is missing or is not the certificate's key. */
  async #caKey(ca: CaRow): Promise<KeyObject> {
    const pem = ca.key_ref ? await this.#secrets.get(ca.key_ref) : null;
    if (!pem)
      throw new NovaError(
        'conflict',
        'The local CA key is missing from the vault: restore the vault, or replace the CA (devices then install the new root).',
        { details: { reason: 'ca_key_missing' } },
      );
    const key = createPrivateKey(pem);
    const certKey = new X509Certificate(ca.cert_pem).publicKey.export({
      type: 'spki',
      format: 'der',
    });
    if (!createPublicKey(key).export({ type: 'spki', format: 'der' }).equals(certKey))
      throw new NovaError(
        'conflict',
        'The vault holds a different key than the local CA certificate.',
        {
          details: { reason: 'ca_key_mismatch' },
        },
      );
    return key;
  }

  /**
   * Delete the vault keys nothing serves any more: those of retired CAs and of superseded or
   * revoked Hub certificates. The running listener keeps the old key in memory until it swaps.
   */
  async #sweepKeys(): Promise<void> {
    const certs = this.#db.raw
      .prepare(
        `SELECT id, key_ref FROM trust_certificate WHERE key_ref IS NOT NULL
           AND (superseded_at IS NOT NULL OR revoked_at IS NOT NULL
                OR ca_id IN (SELECT id FROM trust_ca WHERE retired_at IS NOT NULL))`,
      )
      .all() as { id: string; key_ref: string }[];
    const cas = this.#db.raw
      .prepare(
        'SELECT id, key_ref FROM trust_ca WHERE retired_at IS NOT NULL AND key_ref IS NOT NULL',
      )
      .all() as { id: string; key_ref: string }[];
    for (const [table, rows] of [
      ['trust_certificate', certs],
      ['trust_ca', cas],
    ] as const) {
      for (const r of rows) {
        try {
          await this.#secrets.delete(r.key_ref);
        } catch (err) {
          this.#log.warn('deleting a retired key failed', { err, keyRef: r.key_ref });
          continue;
        }
        await this.#db.transaction(() => {
          this.#db.raw.prepare(`UPDATE ${table} SET key_ref = NULL WHERE id = ?`).run(r.id);
        });
      }
    }
  }

  #constraints(ca: CaRow): NameConstraints {
    return JSON.parse(ca.name_constraints_json) as NameConstraints;
  }

  /**
   * The leaf's names: the Hub's names the CA may sign, and the DNS names left out (outside the
   * constraints, or single-label).
   */
  async #leafNames(
    ca: CaRow,
  ): Promise<{ sans: string[]; outside: string[]; singleLabel: string[] }> {
    const nc = this.#constraints(ca);
    const sans: string[] = [];
    const outside: string[] = [];
    const singleLabel: string[] = [];
    for (const n of await this.#candidateNames()) {
      if (isSingleLabel(n)) singleLabel.push(n);
      else if (nameConstraintsPermit(nc, n)) sans.push(n);
      // Addresses outside the private ranges (a global IPv6 address) are left out quietly.
      else if (!isIP(n)) outside.push(n);
    }
    // DNS names first (the first is the subject), then addresses; stable order.
    const sorted = [
      ...sans.filter((n) => !isIP(n)).sort(),
      ...sans.filter((n) => isIP(n)).sort(),
    ].slice(0, MAX_SANS);
    return { sans: sorted, outside: outside.sort(), singleLabel: singleLabel.sort() };
  }

  // ---- the Hub's TLS leaf ---------------------------------------------------------------------

  #current(kind: 'hub_tls' | 'mesh', caId?: string): CertRow[] {
    const rows = this.#db.raw
      .prepare(
        `SELECT * FROM trust_certificate WHERE kind = ? AND superseded_at IS NULL
           AND revoked_at IS NULL ORDER BY created_at DESC`,
      )
      .all(kind) as unknown as CertRow[];
    return caId === undefined ? rows : rows.filter((r) => r.ca_id === caId);
  }

  /**
   * The current leaf, issued again when it reached two thirds of its life, when the Hub's names
   * changed, when its key is gone, or when `force` is set (a manual renewal).
   */
  ensureLeaf(opts: { force?: boolean; who?: Actor } = {}): Promise<CertRow> {
    return this.#serialize(async () => {
      // Nothing is issued while the trust area is down (its identity key missing).
      await this.identity.load();
      const who = opts.who ?? SYSTEM;
      const ca = await this.#ensureCa(who);
      const { sans } = await this.#leafNames(ca);
      const current = this.#current('hub_tls', ca.id)[0];
      const now = this.#now().getTime();
      if (
        current &&
        !opts.force &&
        now < renewAt(current.not_before, current.not_after) &&
        sameSet(JSON.parse(current.sans_json) as string[], sans) &&
        current.key_ref &&
        (await this.#secrets.has(current.key_ref))
      )
        return current;
      const reason = !current
        ? 'first'
        : opts.force
          ? 'manual'
          : now >= renewAt(current.not_before, current.not_after)
            ? 'expiry'
            : 'names';
      return this.#issueLeaf(ca, sans, who, reason);
    });
  }

  /** A new leaf from `ca`; every other current Hub leaf is superseded with it. */
  async #issueLeaf(ca: CaRow, sans: string[], who: Actor, reason: string): Promise<CertRow> {
    const signer = await this.#caKey(ca);
    const caX = new X509Certificate(ca.cert_pem);
    const now = this.#now();
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { notBefore, notAfter } = validity(now, LEAF_DAYS);
    const subjectName = sans.find((n) => !isIP(n)) ?? 'localhost';
    const cert = buildCertificate({
      subject: { commonName: subjectName },
      issuer: { commonName: commonNameOf(caX.subject) },
      publicKey,
      signer,
      issuerKeyId: keyId(createPublicKey(signer)),
      notBefore,
      notAfter,
      keyUsage: KEY_USAGE.digitalSignature,
      extKeyUsage: [OID.serverAuth],
      altNames: { hosts: sans },
    });
    const id = uuidv7();
    const keyRef = `secret://hub/tls/${id}/key`;
    await this.#secrets.put(keyRef, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const row: CertRow = {
      id,
      ca_id: ca.id,
      kind: 'hub_tls',
      serial: cert.serial,
      subject: subjectName,
      device_id: null,
      role: null,
      sans_json: JSON.stringify(sans),
      public_key: null,
      cert_pem: cert.pem,
      key_ref: keyRef,
      not_before: iso(notBefore),
      not_after: iso(notAfter),
      created_at: iso(now),
      superseded_at: null,
      revoked_at: null,
    };
    await this.#db.transaction(() => {
      this.#insert(row);
      this.#db.raw
        .prepare(
          `UPDATE trust_certificate SET superseded_at = ? WHERE kind = 'hub_tls'
             AND superseded_at IS NULL AND id <> ?`,
        )
        .run(iso(now), row.id);
    });
    this.#failures.delete('leaf');
    await this.#record(
      who,
      'trust.leaf.issue',
      row.id,
      { serial: row.serial, sans, notAfter: row.not_after, reason },
      { reason: 'leaf_issued', serial: row.serial, sans, notAfter: row.not_after },
    );
    this.#tlsChanged();
    await this.#sweepKeys();
    return row;
  }

  #insert(row: CertRow): void {
    this.#db.raw
      .prepare(
        `INSERT INTO trust_certificate (id, ca_id, kind, serial, subject, device_id, role,
           sans_json, public_key, cert_pem, key_ref, not_before, not_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.ca_id,
        row.kind,
        row.serial,
        row.subject,
        row.device_id,
        row.role,
        row.sans_json,
        row.public_key,
        row.cert_pem,
        row.key_ref,
        row.not_before,
        row.not_after,
        row.created_at,
      );
  }

  // ---- device certificates ----------------------------------------------------------------------

  /**
   * A certificate for a device's Ed25519 key, signed by the local CA, for Add Device (the
   * `certificatePem` of the grant). Null unless the trust mode is `local-ca`.
   */
  async issueDeviceCertificate(
    input: DeviceCertificateRequest,
    who: Actor = SYSTEM,
  ): Promise<{ certificatePem: string; expiresAt: string; serial: string } | null> {
    if ((await this.#settings.mode()) !== 'local-ca') return null;
    return this.#issueDevice(input, who, 'issued');
  }

  /** A device certificate from the local CA, in any trust mode (Add Device and renewal). */
  async #issueDevice(
    input: DeviceCertificateRequest,
    who: Actor,
    reason: 'issued' | 'renewed',
  ): Promise<{ certificatePem: string; expiresAt: string; serial: string }> {
    await this.identity.load();
    if (!DEVICE_ID.test(input.deviceId)) throw new NovaError('validation', 'bad device id');
    if (!ROLE.test(input.role)) throw new NovaError('validation', 'bad device role');
    let devicePublic: KeyObject;
    try {
      devicePublic = ed25519FromRaw(input.publicKey);
    } catch {
      throw new NovaError('validation', 'publicKey must be base64url of a raw Ed25519 key');
    }
    return this.#serialize(async () => {
      const ca = await this.#ensureCa(who);
      const signer = await this.#caKey(ca);
      const caX = new X509Certificate(ca.cert_pem);
      const now = this.#now();
      const { notBefore, notAfter } = validity(now, DEVICE_CERT_DAYS);
      const uri = `urn:nova:device:${input.deviceId}`;
      const cert = buildCertificate({
        // The device id has no dot, so no verifier mistakes it for a host name.
        subject: { commonName: input.deviceId, organizationalUnit: input.role },
        issuer: { commonName: commonNameOf(caX.subject) },
        publicKey: devicePublic,
        signer,
        issuerKeyId: keyId(createPublicKey(signer)),
        notBefore,
        notAfter,
        keyUsage: KEY_USAGE.digitalSignature,
        // clientAuth for its calls to the Hub (M7 mutual TLS), serverAuth for its management
        // server, which the Hub calls over mutual TLS (ADR-096 D1).
        extKeyUsage: [OID.clientAuth, OID.serverAuth],
        altNames: { uris: [uri] },
      });
      const row: CertRow = {
        id: uuidv7(),
        ca_id: ca.id,
        kind: 'device',
        serial: cert.serial,
        subject: input.deviceId,
        device_id: input.deviceId,
        role: input.role,
        sans_json: JSON.stringify([uri]),
        public_key: input.publicKey,
        cert_pem: cert.pem,
        key_ref: null,
        not_before: iso(notBefore),
        not_after: iso(notAfter),
        created_at: iso(now),
        superseded_at: null,
        revoked_at: null,
      };
      await this.#db.transaction(() => this.#insert(row));
      await this.#record(
        who,
        reason === 'renewed' ? 'trust.device.renew' : 'trust.device.issue',
        input.deviceId,
        { serial: row.serial, role: input.role, notAfter: row.not_after },
        {
          reason: reason === 'renewed' ? 'device_renewed' : 'device_issued',
          deviceId: input.deviceId,
          serial: row.serial,
        },
      );
      return { certificatePem: row.cert_pem, expiresAt: row.not_after, serial: row.serial };
    });
  }

  // ---- device certificate renewal (ADR-096 D1; the M7 gap "certificates are not renewed") ------

  /** A device's live certificates from the active CA for this key, newest first. */
  #liveDeviceCerts(deviceId: string, publicKey?: string): CertRow[] {
    const ca = this.#caRow();
    if (!ca) return [];
    const rows = this.#db.raw
      .prepare(
        `SELECT * FROM trust_certificate WHERE kind = 'device' AND device_id = ? AND ca_id = ?
           AND revoked_at IS NULL AND not_after > ? ORDER BY created_at DESC, id DESC`,
      )
      .all(deviceId, ca.id, iso(this.#now())) as unknown as CertRow[];
    return publicKey === undefined ? rows : rows.filter((r) => r.public_key === publicKey);
  }

  /**
   * The certificate a device should install (the heartbeat answer's `certificate`), or null.
   * When the device's newest certificate cannot serve its management endpoint (no serverAuth,
   * issued before M7.5) or has less than a third of its life left, a fresh one is issued for the
   * same key, device id and role; until the device presents it, every heartbeat answer carries it
   * again (the older one stays valid until then, and is revoked the first time the new one is
   * seen: `deviceCertificatePresented`).
   */
  async deviceCertificateRenewal(
    deviceId: string,
    publicKey: string,
  ): Promise<{ pem: string; notAfter: string; serial: string } | null> {
    const live = this.#liveDeviceCerts(deviceId, publicKey);
    const newest = live[0];
    if (!newest) return null;
    const answer = (r: { cert_pem: string; not_after: string; serial: string }) => ({
      pem: r.cert_pem,
      notAfter: r.not_after,
      serial: r.serial,
    });
    // Issued, not yet presented: send it again.
    if (live.length > 1) return answer(newest);
    const serverAuth = (new X509Certificate(newest.cert_pem).keyUsage ?? []).includes(
      OID.serverAuth,
    );
    if (serverAuth && this.#now().getTime() < renewAt(newest.not_before, newest.not_after))
      return null;
    const fresh = await this.#issueDevice(
      { deviceId, publicKey, role: newest.role ?? 'client' },
      SYSTEM,
      'renewed',
    );
    return { pem: fresh.certificatePem, notAfter: fresh.expiresAt, serial: fresh.serial };
  }

  /**
   * A device presented this certificate (mutual TLS on the Hub's routes or its management
   * endpoint). When it is newer than others the device holds, those are revoked: the renewal is
   * done. Returns how many were revoked.
   */
  async deviceCertificatePresented(deviceId: string, serial: string): Promise<number> {
    const live = this.#liveDeviceCerts(deviceId);
    const shown = live.find((r) => r.serial === serial.toLowerCase());
    if (!shown) return 0;
    const older = live.filter((r) => before(r, shown));
    if (!older.length) return 0;
    const at = iso(this.#now());
    await this.#db.transaction(() => {
      for (const r of older)
        this.#db.raw
          .prepare(
            `UPDATE trust_certificate SET revoked_at = ?, revoked_reason = 'renewed'
             WHERE id = ? AND revoked_at IS NULL`,
          )
          .run(at, r.id);
    });
    await this.#record(
      SYSTEM,
      'trust.device.revoke',
      deviceId,
      { certificates: older.length, reason: 'renewed', serials: older.map((r) => r.serial) },
      { reason: 'device_renewed', deviceId, certificates: older.length },
    );
    return older.length;
  }

  /**
   * A device's certificate as the management channel sees it (the devices area's view): the one
   * it uses now (the oldest live one, until a renewal is presented), whether that is the legacy
   * clientAuth-only kind and when its grace ends, and the renewal's state.
   */
  deviceCertificateState(
    deviceId: string,
    graceMs = LEGACY_SERVER_CERT_GRACE_MS,
  ): DeviceCertificateStateView {
    const live = this.#liveDeviceCerts(deviceId);
    const current = live.at(-1);
    if (!current) return { renewal: null, legacyCertificate: false, legacyGraceEndsAt: null };
    const serverAuth = (pem: string) =>
      (new X509Certificate(pem).keyUsage ?? []).includes(OID.serverAuth);
    const legacy = !serverAuth(current.cert_pem);
    const offered = live.length > 1 ? live[0] : undefined;
    if (offered) {
      return {
        renewal: {
          state: 'offered',
          offeredAt: offered.created_at,
          notAfter: offered.not_after,
          reason: legacy ? 'missing_server_auth' : 'expiring',
        },
        legacyCertificate: legacy,
        legacyGraceEndsAt: legacy
          ? new Date(Date.parse(offered.created_at) + graceMs).toISOString()
          : null,
      };
    }
    const replaced = this.#db.raw
      .prepare(
        `SELECT * FROM trust_certificate WHERE kind = 'device' AND device_id = ?
           AND revoked_reason = 'renewed' ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(deviceId) as CertRow | undefined;
    if (replaced && before(replaced, current))
      return {
        renewal: {
          state: 'presented',
          offeredAt: current.created_at,
          notAfter: current.not_after,
          reason: serverAuth(replaced.cert_pem) ? 'expiring' : 'missing_server_auth',
        },
        legacyCertificate: legacy,
        legacyGraceEndsAt: null,
      };
    return {
      renewal: { state: 'none', offeredAt: null, notAfter: null, reason: null },
      legacyCertificate: legacy,
      legacyGraceEndsAt: null,
    };
  }

  /**
   * Whether the Hub may still accept this device certificate as a management server certificate
   * although it lacks serverAuth (issued in M7, before devices served TLS): only the device's own
   * recorded, unrevoked, unexpired certificate, and only until it is renewed, that is while no
   * newer certificate of the device was issued more than `graceMs` ago (the device installs a
   * renewal with its next heartbeat; presenting it revokes the old one at once).
   */
  legacyServerCertificateAllowed(
    deviceId: string,
    pem: string,
    graceMs = LEGACY_SERVER_CERT_GRACE_MS,
  ): boolean {
    const check = this.verifyDeviceCertificate(pem);
    if (!check.ok || check.deviceId !== deviceId) return false;
    let x: X509Certificate;
    try {
      x = new X509Certificate(pem);
    } catch {
      return false;
    }
    if ((x.keyUsage ?? []).includes(OID.serverAuth)) return false;
    const live = this.#liveDeviceCerts(deviceId);
    const mine = live.find((r) => r.serial === check.serial);
    if (!mine) return false;
    const cutoff = this.#now().getTime() - graceMs;
    return !live.some((r) => before(mine, r) && Date.parse(r.created_at) < cutoff);
  }

  /** Revoke every certificate of a device (device revocation, docs/22 §4.5). */
  async revokeDevice(deviceId: string, reason = 'revoked', who: Actor = SYSTEM): Promise<number> {
    const now = iso(this.#now());
    const changed = await this.#db.transaction(
      () =>
        this.#db.raw
          .prepare(
            `UPDATE trust_certificate SET revoked_at = ?, revoked_reason = ?
             WHERE device_id = ? AND kind = 'device' AND revoked_at IS NULL`,
          )
          .run(now, reason.slice(0, 200), deviceId).changes,
    );
    const count = Number(changed);
    if (count > 0)
      await this.#record(
        who,
        'trust.device.revoke',
        deviceId,
        { certificates: count, reason },
        { reason: 'device_revoked', deviceId, certificates: count },
      );
    return count;
  }

  /** The revocation list: revoked device certificates, newest first. */
  revocations(): { serial: string; deviceId: string | null; revokedAt: string }[] {
    const rows = this.#db.raw
      .prepare(
        `SELECT serial, device_id, revoked_at FROM trust_certificate
         WHERE revoked_at IS NOT NULL ORDER BY revoked_at DESC`,
      )
      .all() as { serial: string; device_id: string | null; revoked_at: string }[];
    return rows.map((r) => ({ serial: r.serial, deviceId: r.device_id, revokedAt: r.revoked_at }));
  }

  // ---- the Hub's client certificate (ADR-096 D1) ------------------------------------------------

  /**
   * The Hub's client certificate for the management channel, issued again when it reached two
   * thirds of its life (it lives as long as the leaf and is renewed with it), when the local CA
   * or the Hub identity changed, when the vault lost it, or with `force`. Null while there is no
   * local CA: a device certificate needs one, so no device then serves the channel over TLS. It
   * is never recorded in `trust_certificate` (not a device's), so no device route accepts it.
   */
  hubClientCertificate(
    opts: { force?: boolean; who?: Actor } = {},
  ): Promise<HubClientCertificate | null> {
    return this.#serialize(async () => {
      await this.identity.load();
      const ca = this.#caRow();
      if (!ca) return null;
      const uri = `urn:nova:hub:${this.identity.fingerprint}`;
      const current = opts.force ? null : await this.#storedHubClient(ca, uri);
      if (current) return current;
      return this.#issueHubClient(ca, uri, opts.who ?? SYSTEM);
    });
  }

  /** The stored client certificate if it is still good for `ca` and this identity, else null. */
  async #storedHubClient(ca: CaRow, uri: string): Promise<HubClientCertificate | null> {
    const raw = await this.#secrets.get(HUB_CLIENT_REF).catch(() => null);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { certPem?: unknown; keyPem?: unknown };
      if (typeof v.certPem !== 'string' || typeof v.keyPem !== 'string') return null;
      const x = new X509Certificate(v.certPem);
      const caX = new X509Certificate(ca.cert_pem);
      if (!x.checkIssued(caX) || !x.verify(caX.publicKey)) return null;
      if (!x.checkPrivateKey(createPrivateKey(v.keyPem))) return null;
      if (!(x.subjectAltName ?? '').split(', ').includes(`URI:${uri}`)) return null;
      const notBefore = new Date(x.validFrom).toISOString();
      const notAfter = new Date(x.validTo).toISOString();
      if (this.#now().getTime() >= renewAt(notBefore, notAfter)) return null;
      return {
        certPem: v.certPem,
        keyPem: v.keyPem,
        caPem: ca.cert_pem,
        serial: x.serialNumber.toLowerCase(),
        notBefore,
        notAfter,
        uri,
      };
    } catch {
      return null;
    }
  }

  async #issueHubClient(ca: CaRow, uri: string, who: Actor): Promise<HubClientCertificate> {
    const signer = await this.#caKey(ca);
    const caX = new X509Certificate(ca.cert_pem);
    const now = this.#now();
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const { notBefore, notAfter } = validity(now, HUB_CLIENT_DAYS);
    const cert = buildCertificate({
      // No dots in the name: no verifier takes it for a host name.
      subject: {
        commonName: `Nova Hub ${this.identity.fingerprint.slice(0, 8)}`,
        organizationalUnit: 'hub-client',
      },
      issuer: { commonName: commonNameOf(caX.subject) },
      publicKey,
      signer,
      issuerKeyId: keyId(createPublicKey(signer)),
      notBefore,
      notAfter,
      keyUsage: KEY_USAGE.digitalSignature,
      extKeyUsage: [OID.clientAuth],
      altNames: { uris: [uri] },
    });
    const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await this.#secrets.put(HUB_CLIENT_REF, JSON.stringify({ certPem: cert.pem, keyPem }));
    this.#failures.delete('hub-client');
    const out: HubClientCertificate = {
      certPem: cert.pem,
      keyPem,
      caPem: ca.cert_pem,
      serial: cert.serial,
      notBefore: iso(notBefore),
      notAfter: iso(notAfter),
      uri,
    };
    await this.#record(
      who,
      'trust.hub_client.issue',
      null,
      { serial: out.serial, notAfter: out.notAfter, uri },
      { reason: 'hub_client_issued', serial: out.serial, notAfter: out.notAfter },
    );
    return out;
  }

  /**
   * Check a device certificate a client presents: issued by the active local CA, within its
   * validity, recorded here and not revoked. M7's mutual TLS calls this for every client
   * certificate (FR-192: a certificate authenticates, a network location never does).
   */
  verifyDeviceCertificate(pem: string): DeviceCertificateCheck {
    let x: X509Certificate;
    try {
      x = new X509Certificate(pem);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    const ca = this.#caRow();
    if (!ca) return { ok: false, reason: 'no_ca' };
    const caX = new X509Certificate(ca.cert_pem);
    if (!x.checkIssued(caX)) return { ok: false, reason: 'unknown_issuer' };
    if (!x.verify(caX.publicKey)) return { ok: false, reason: 'bad_signature' };
    const now = this.#now().getTime();
    if (now < Date.parse(x.validFrom)) return { ok: false, reason: 'not_yet_valid' };
    if (now > Date.parse(x.validTo)) return { ok: false, reason: 'expired' };
    const row = this.#db.raw
      .prepare(`SELECT * FROM trust_certificate WHERE ca_id = ? AND serial = ? AND kind = 'device'`)
      .get(ca.id, x.serialNumber.toLowerCase()) as CertRow | undefined;
    if (!row || sha256Hex(row.cert_pem) !== sha256Hex(pem))
      return { ok: false, reason: 'unknown_serial' };
    if (row.revoked_at) return { ok: false, reason: 'revoked' };
    return { ok: true, deviceId: row.device_id ?? '', role: row.role, serial: row.serial };
  }

  // ---- mesh certificates ----------------------------------------------------------------------

  /** Get a certificate for the Hub's mesh host name from the mesh and store it. */
  async requestMeshCert(host: string, who: Actor = SYSTEM): Promise<TrustMeshCertView> {
    const name = certificateName(host);
    if (!name || isIP(name)) throw new NovaError('validation', 'a mesh host name is required');
    const source = this.#mesh;
    if (!source)
      throw new NovaError('capability_missing', 'no mesh can issue certificates here', {
        details: { reason: 'no_mesh_cert_source' },
      });
    const got = await source.request(name);
    return this.storeMeshCert(name, got.certPem, got.keyPem, who);
  }

  /** Store a mesh certificate after checking it covers the host and matches its key. */
  storeMeshCert(
    host: string,
    certPem: string,
    keyPem: string,
    who: Actor = SYSTEM,
  ): Promise<TrustMeshCertView> {
    return this.#serialize(async () => {
      await this.identity.load();
      let x: X509Certificate;
      let key: KeyObject;
      try {
        x = new X509Certificate(certPem);
        key = createPrivateKey(keyPem);
      } catch {
        throw new NovaError('validation', 'the mesh returned an unreadable certificate or key');
      }
      if (!x.checkHost(host))
        throw new NovaError('validation', `the mesh certificate does not cover ${host}`);
      if (!x.checkPrivateKey(key))
        throw new NovaError('validation', 'the mesh certificate does not match its key');
      const now = this.#now();
      if (Date.parse(x.validTo) <= now.getTime())
        throw new NovaError('validation', 'the mesh certificate has expired');
      const previous = this.#current('mesh').filter((r) => r.subject === host);
      const id = uuidv7();
      const keyRef = `secret://hub/tls/mesh/${id}/key`;
      await this.#secrets.put(keyRef, key.export({ type: 'pkcs8', format: 'pem' }).toString());
      const row: CertRow = {
        id,
        ca_id: null,
        kind: 'mesh',
        serial: x.serialNumber.toLowerCase(),
        subject: host,
        device_id: null,
        role: null,
        sans_json: JSON.stringify([host]),
        public_key: null,
        cert_pem: certPem,
        key_ref: keyRef,
        not_before: new Date(x.validFrom).toISOString(),
        not_after: new Date(x.validTo).toISOString(),
        created_at: iso(now),
        superseded_at: null,
        revoked_at: null,
      };
      await this.#db.transaction(() => {
        this.#insert(row);
        for (const p of previous)
          this.#db.raw
            .prepare('UPDATE trust_certificate SET superseded_at = ? WHERE id = ?')
            .run(iso(now), p.id);
      });

      this.#failures.delete(`mesh:${host}`);
      await this.#record(
        who,
        'trust.mesh.store',
        host,
        { notAfter: row.not_after, serial: row.serial },
        { reason: 'mesh_cert', host, notAfter: row.not_after },
      );
      this.#tlsChanged();
      await this.#sweepKeys();
      return this.#meshView(row);
    });
  }

  /** The current mesh certificates, newest first. */
  meshCertificates(): TrustMeshCertView[] {
    return this.#current('mesh').map((r) => this.#meshView(r));
  }

  #meshView(r: CertRow): TrustMeshCertView {
    const left = Date.parse(r.not_after) - this.#now().getTime();
    return {
      host: r.subject,
      notAfter: r.not_after,
      status: left <= 0 ? 'expired' : left < MESH_EXPIRING_DAYS * DAY ? 'expiring' : 'ok',
    };
  }

  async #meshInUse(mode: TrustMode): Promise<boolean> {
    return mode === 'mesh' || (mode === 'local-ca' && (await this.#settings.meshCerts()));
  }

  // ---- what the listener serves ---------------------------------------------------------------

  /**
   * The certificates for the HTTPS listener, or null when the trust mode serves none (`none`, or
   * `mesh` before the mesh issued a certificate).
   */
  async tlsMaterial(): Promise<TlsMaterial | null> {
    // Without the Hub identity the trust area does not run: the listener falls back to plain
    // HTTP on loopback only (main.ts) and `problems` says why.
    await this.identity.load();
    const mode = await this.#settings.mode();
    if (mode === 'none') return null;
    const now = this.#now().getTime();
    const sni: TlsMaterial['sni'] = [];
    if (await this.#meshInUse(mode)) {
      for (const r of this.#current('mesh')) {
        if (Date.parse(r.not_after) <= now || !r.key_ref) continue;
        const key = await this.#secrets.get(r.key_ref);
        if (key) sni.push({ host: r.subject, cert: r.cert_pem, key });
      }
    }
    if (mode === 'mesh') {
      const first = sni[0];
      return first ? { cert: first.cert, key: first.key, sni } : null;
    }
    const leaf = await this.ensureLeaf();
    const key = leaf.key_ref ? await this.#secrets.get(leaf.key_ref) : null;
    if (!key) throw new NovaError('server_error', 'the Hub TLS key is missing from the vault');
    const ca = this.#caRow();
    // The chain is the leaf then the CA, so a client that pinned the CA can build it.
    return { cert: `${leaf.cert_pem}${ca ? ca.cert_pem : ''}`, key, sni };
  }

  /**
   * Periodic upkeep: renew the leaf at two thirds of its life or when the names changed, and
   * mesh certificates at two thirds of theirs. Failures are kept for `problems`, never thrown.
   */
  async maintain(): Promise<void> {
    try {
      await this.identity.load();
    } catch {
      return; // the trust area is down; `problems` already says why
    }
    try {
      await this.#sweepKeys();
    } catch (err) {
      this.#log.warn('deleting retired keys failed', { err });
    }
    const mode = await this.#settings.mode();
    if (mode === 'local-ca') {
      try {
        await this.ensureLeaf();
      } catch (err) {
        this.#failures.set('leaf', err instanceof Error ? err.message : String(err));
        this.#log.warn('renewing the Hub TLS certificate failed', { err });
      }
    }
    // The management channel's client certificate follows the leaf (ADR-096 D1), in any mode
    // while a local CA exists: devices that hold its certificates still want it.
    if (this.#caRow()) {
      try {
        await this.hubClientCertificate();
      } catch (err) {
        this.#failures.set('hub-client', err instanceof Error ? err.message : String(err));
        this.#log.warn('renewing the Hub client certificate failed', { err });
      }
    }
    if (!(await this.#meshInUse(mode)) || !this.#mesh) return;
    const now = this.#now().getTime();
    for (const r of this.#current('mesh')) {
      if (now < renewAt(r.not_before, r.not_after)) continue;
      try {
        await this.requestMeshCert(r.subject);
      } catch (err) {
        this.#failures.set(`mesh:${r.subject}`, err instanceof Error ? err.message : String(err));
        this.#log.warn('renewing a mesh certificate failed', { err, host: r.subject });
      }
    }
  }

  // ---- views ----------------------------------------------------------------------------------

  #caView(ca: CaRow): TrustCaView {
    const nc = this.#constraints(ca);
    return {
      fingerprint: ca.fingerprint,
      subject: commonNameOf(new X509Certificate(ca.cert_pem).subject),
      notBefore: ca.not_before,
      notAfter: ca.not_after,
      nameConstraints: { dns: nc.dns, ip: nc.ip },
    };
  }

  #leafView(r: CertRow): TrustLeafView {
    return {
      serial: r.serial,
      sans: JSON.parse(r.sans_json) as string[],
      notBefore: r.not_before,
      notAfter: r.not_after,
      renewAt: new Date(renewAt(r.not_before, r.not_after)).toISOString(),
    };
  }

  #certView(r: CertRow): TrustCertificateView {
    return {
      id: r.id,
      kind: r.kind,
      serial: r.serial,
      subject: r.subject,
      deviceId: r.device_id,
      role: r.role,
      sans: JSON.parse(r.sans_json) as string[],
      notBefore: r.not_before,
      notAfter: r.not_after,
      createdAt: r.created_at,
      supersededAt: r.superseded_at,
      revokedAt: r.revoked_at,
    };
  }

  #restartRequired(mode: TrustMode, hasMaterial: boolean): boolean {
    const s = this.#serving;
    if (!s || s.source === 'explicit') return false;
    const wants = mode !== 'none' && hasMaterial;
    return wants !== (s.source === 'trust');
  }

  async #problems(mode: TrustMode, ca: CaRow | null, leaf: CertRow | null): Promise<string[]> {
    const out: string[] = [];
    const now = this.#now().getTime();
    await this.identity.load().catch(() => undefined);
    const identity = this.identity.failure;
    if (identity) out.push(`${identity.message} The trust area is off until then.`);
    const serving = this.#serving;
    if (serving?.fallbackReason)
      out.push(
        `The trust certificates could not be read at start (${serving.fallbackReason}): the Hub serves plain HTTP on loopback only. Fix this and restart.`,
      );
    if (mode === 'local-ca') {
      if (!ca) out.push('The local CA has not been created yet.');
      else {
        if (Date.parse(ca.not_after) - now < 30 * DAY)
          out.push(`The local CA expires on ${ca.not_after.slice(0, 10)}.`);
        if (!ca.key_ref || !(await this.#secrets.has(ca.key_ref).catch(() => false)))
          out.push(
            'The local CA key is missing from the vault: restore the vault, or replace the CA (renew target "ca"; devices then install the new root). The Hub does not replace it on its own.',
          );
        const { outside, singleLabel } = await this.#leafNames(ca);
        for (const n of outside)
          out.push(
            `${n} is outside the names the local CA may sign; use a mesh certificate or NOVA_TLS_CERT for it.`,
          );
        for (const n of singleLabel)
          out.push(
            `${n} is a single-label name and is never certified (it could be a top-level domain); reach the Hub by its .local name or a full name instead.`,
          );
      }
      if (leaf && Date.parse(leaf.not_after) <= now) out.push('The Hub TLS certificate expired.');
    }
    if (await this.#meshInUse(mode)) {
      const mesh = this.#current('mesh');
      if (mode === 'mesh' && mesh.length === 0)
        out.push(
          this.#mesh
            ? 'No mesh certificate yet: run Network Setup to get one.'
            : 'No mesh can issue certificates here: set up a mesh first.',
        );
      for (const r of mesh) {
        const v = this.#meshView(r);
        if (v.status === 'expired') out.push(`The mesh certificate for ${v.host} expired.`);
      }
    }
    for (const [what, why] of this.#failures)
      out.push(
        `Renewing ${
          what === 'leaf'
            ? 'the Hub TLS certificate'
            : what === 'hub-client'
              ? 'the Hub client certificate'
              : what.slice(5)
        } failed: ${why}`,
      );
    const material = mode === 'local-ca' || this.#current('mesh').length > 0;
    // (A start that fell back to loopback already says to restart.)
    if (this.#restartRequired(mode, material) && !serving?.fallbackReason)
      out.push('The trust mode changed: restart the Hub to apply it.');
    return out;
  }

  async summary(): Promise<TrustSummary> {
    const mode = await this.#settings.mode();
    const ca = this.#caRow();
    const leaf = ca ? (this.#current('hub_tls', ca.id)[0] ?? null) : null;
    const mesh = (await this.#meshInUse(mode)) ? (this.#current('mesh')[0] ?? null) : null;
    return {
      mode,
      caFingerprint: ca?.fingerprint ?? null,
      leafNotAfter: leaf?.not_after ?? null,
      leafSans: leaf ? (JSON.parse(leaf.sans_json) as string[]) : [],
      meshCert: mesh ? { host: mesh.subject, notAfter: mesh.not_after } : null,
      problems: await this.#problems(mode, ca, leaf),
    };
  }

  async view(): Promise<TrustView> {
    await this.identity.load().catch(() => undefined);
    const mode = await this.#settings.mode();
    const ca = this.#caRow();
    const leaf = ca ? (this.#current('hub_tls', ca.id)[0] ?? null) : null;
    const mesh = this.#current('mesh')[0] ?? null;
    const issued = this.#db.raw
      .prepare('SELECT * FROM trust_certificate ORDER BY created_at DESC, id DESC LIMIT 200')
      .all() as unknown as CertRow[];
    const material = mode === 'local-ca' || this.#current('mesh').length > 0;
    return {
      mode,
      meshCerts: await this.#settings.meshCerts(),
      pinNativeShells: await this.#settings.pinNativeShells(),
      hubFingerprint: this.identity.loaded ? this.identity.fingerprint : null,
      hubPublicKey: this.identity.loaded ? this.identity.publicKey : null,
      serving: this.#serving,
      restartRequired: this.#restartRequired(mode, material),
      ca: ca ? this.#caView(ca) : null,
      leaf: leaf ? this.#leafView(leaf) : null,
      meshCert: mesh ? this.#meshView(mesh) : null,
      issued: issued.map((r) => this.#certView(r)),
      problems: await this.#problems(mode, ca, leaf),
    };
  }

  /**
   * The signed list of certificates the Hub serves, for native shells that pinned the identity
   * (docs/22 §5 "Native shell pinning"). The client's nonce is signed with it, so an old
   * statement (say one from while pinning was off) cannot be replayed.
   */
  async identityStatement(nonce: string): Promise<HubIdentityStatement> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
      throw new NovaError('validation', 'nonce must be 16-64 base64url characters');
    await this.identity.load();
    const certificates: HubIdentityStatement['certificates'] = [];
    const ca = this.#caRow();
    if (ca) {
      certificates.push({ kind: 'ca', sha256: sha256Hex(ca.cert_pem), notAfter: ca.not_after });
      const leaf = this.#current('hub_tls', ca.id)[0];
      if (leaf)
        certificates.push({
          kind: 'leaf',
          sha256: sha256Hex(leaf.cert_pem),
          notAfter: leaf.not_after,
        });
    }
    for (const r of this.#current('mesh'))
      certificates.push({ kind: 'mesh', sha256: sha256Hex(r.cert_pem), notAfter: r.not_after });
    const unsigned: Omit<HubIdentityStatement, 'signature'> = {
      v: 1,
      nonce,
      hubFingerprint: this.identity.fingerprint,
      hubPublicKey: this.identity.publicKey,
      pinning: (await this.#settings.pinNativeShells()) ? 'required' : 'off',
      certificates,
      issuedAt: iso(this.#now()),
    };
    return {
      ...unsigned,
      signature: this.identity.sign(hubIdentityStatementBytes(unsigned)).toString('base64url'),
    };
  }
}
