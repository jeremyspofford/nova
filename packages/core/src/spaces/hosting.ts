// Hosting targets for sites (FR-037, M8). A `HostingTarget` is where a published site version
// lives: the Hub's own folder under `sites.publishRoot` (M6), or a remote static host the owner
// set up. The remote kind is WebDAV (webdav.ts): an upload over plain HTTP that needs no new
// dependency. A target holds one folder per published site and only replaces or removes a folder
// that is free or carries the site's `.nova-site` marker. Credentials are write-only: the value
// goes to the vault and the row keeps its `secret://` reference. Every request to a remote target
// passes the egress policy (`network.egressMode`, `network.egressDeny` and managed policy's
// egress restriction); a refused host is a `policy_denied` with the reason, audited.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isIP } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import type { z } from 'zod';
import {
  NovaError,
  uuidv7,
  type HostingAuth,
  type HostingProblem,
  type SiteHostingTargetView,
  type SiteRemoteRef,
  type createHostingTargetSchema,
  type hostingCredentialSchema,
  type updateHostingTargetSchema,
} from '@nova/shared';
import { secretRef, type SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import { matchingPattern } from '../computers/egress-policy.ts';
import type { EventSink } from '../events.ts';
import type { ManagedRestrictions } from '../managed/restrictions.ts';
import { noopAudit, type AuditSink } from '../tools/types.ts';
import { SITE_MARKER } from './marker.ts';
import { WebDavTarget } from './webdav.ts';

/** One file of a built site version, as it is written or uploaded. */
export interface HostedFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * Where a published site version lives. A target holds folders, one per published site; the site
 * services decide which version goes where and keep the publish history.
 */
export interface HostingTarget {
  readonly kind: 'hub' | 'webdav';
  /** The folder's address shown to the user: a path on the Hub, or the URL it is uploaded to. */
  location(folder: string): Promise<string>;
  /** True when the folder holds this site now, false when it is free; else `folder_in_use`. */
  claim(siteId: string, folder: string): Promise<boolean>;
  /** Put a version's files in the folder in one swap; answers the folder's location. */
  put(siteId: string, folder: string, files: readonly HostedFile[]): Promise<string>;
  /** Take this site's folder down; a folder that is gone or another's is left alone. */
  remove(siteId: string, folder: string): Promise<void>;
}

const FOLDER = /^[a-z0-9][a-z0-9-]{0,62}$/;

function folderInUse(): NovaError {
  return new NovaError(
    'conflict',
    'that folder already holds something Nova did not publish there',
    {
      details: { reason: 'folder_in_use' },
    },
  );
}

// ---- the Hub's own folder (M6) -----------------------------------------------------------------

/** Folders under the publish root (`sites.publishRoot`, default `<data>/sites`), swapped in by rename. */
export class HubFolderTarget implements HostingTarget {
  readonly kind = 'hub' as const;
  readonly #root: () => Promise<string>;

  constructor(root: () => Promise<string>) {
    this.#root = root;
  }

  async location(folder: string): Promise<string> {
    return (await this.#folder(folder)).dir;
  }

  async claim(siteId: string, folder: string): Promise<boolean> {
    return claimDir(siteId, (await this.#folder(folder)).dir);
  }

  async put(siteId: string, folder: string, files: readonly HostedFile[]): Promise<string> {
    const { root, dir } = await this.#folder(folder);
    mkdirSync(root, { recursive: true });
    const exists = claimDir(siteId, dir);
    const tmp = join(root, `.${folder}.tmp-${randomUUID()}`);
    try {
      mkdirSync(tmp, { recursive: true });
      for (const f of files) {
        const target = resolve(tmp, f.path);
        // Paths come from Nova's own zip; still, nothing may land outside the folder.
        if (!target.startsWith(tmp + sep) || f.path.endsWith('/')) continue;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, f.bytes);
      }
      writeFileSync(join(tmp, SITE_MARKER), `${siteId}\n`);
      // Swap: the old folder moves aside, the new one takes its name, the old one goes.
      const old = join(root, `.${folder}.old-${randomUUID()}`);
      if (exists) renameSync(dir, old);
      renameSync(tmp, dir);
      if (exists) rmSync(old, { recursive: true, force: true });
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    return dir;
  }

  async remove(siteId: string, folder: string): Promise<void> {
    const { dir } = await this.#folder(folder);
    try {
      if (claimDir(siteId, dir)) rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Someone else's folder by now: leave it alone.
      if (!(err instanceof NovaError)) throw err;
    }
  }

  async #folder(folder: string): Promise<{ root: string; dir: string }> {
    if (!FOLDER.test(folder)) throw new NovaError('validation', 'not a folder name');
    const root = resolve(await this.#root());
    const dir = resolve(root, folder);
    if (!dir.startsWith(root + sep)) throw new NovaError('validation', 'not a folder name');
    return { root, dir };
  }
}

/** Whether `dir` is free or Nova's folder for this site; anything else is refused. */
function claimDir(siteId: string, dir: string): boolean {
  if (!existsSync(dir)) return false;
  const st = lstatSync(dir);
  const mine =
    st.isDirectory() &&
    !st.isSymbolicLink() &&
    existsSync(join(dir, SITE_MARKER)) &&
    readFileSync(join(dir, SITE_MARKER), 'utf8').trim() === siteId;
  if (!mine) throw folderInUse();
  return true;
}

// ---- egress ------------------------------------------------------------------------------------

/** The egress ceiling for uploads to remote targets: the settings narrowed by managed policy. */
export interface HostingEgress {
  mode: 'off' | 'limited' | 'allowlist';
  deny: readonly string[];
  /** Each managed layer's allow list: a host must be in every one. */
  allow: readonly (readonly string[])[];
  /** Why the managed policy fails closed (no request at all), or null. */
  failClosed: string | null;
}

/**
 * The ceiling from `network.egressMode`, `network.egressDeny` and managed policy's layers (the
 * narrowest mode wins, deny lists add up, allow lists intersect). The owner's own
 * `network.egressAllow` governs sandboxes and the agent browser; a target the owner set up is
 * its own allow entry, as an extension's declared hosts are (ADR-097).
 */
export function hostingEgress(
  settings: { mode: HostingEgress['mode']; deny: readonly string[] },
  managed: Pick<ManagedRestrictions, 'layers' | 'failClosed'>,
): HostingEgress {
  if (managed.failClosed)
    return { mode: 'off', deny: [], allow: [], failClosed: managed.failClosed };
  const rank = { off: 0, limited: 1, allowlist: 2 } as const;
  let mode: HostingEgress['mode'] = settings.mode;
  const deny = [...settings.deny];
  const allow: string[][] = [];
  for (const l of managed.layers) {
    const m = l.egress?.mode;
    if (m && rank[m] < rank[mode]) mode = m;
    deny.push(...(l.egress?.deny ?? []));
    if (l.egress?.allow) allow.push([...l.egress.allow]);
  }
  return { mode, deny, allow, failClosed: null };
}

/** Why the egress ceiling refuses a request to `host`, or null. */
export function hostingEgressProblem(
  e: HostingEgress,
  host: string,
  method: string,
): string | null {
  if (e.failClosed)
    return `network access is off: your organization's managed policy could not be read (${e.failClosed})`;
  if (e.mode === 'off') return 'network access is turned off (egress off)';
  if (e.mode === 'limited' && !/^(GET|HEAD|OPTIONS)$/i.test(method))
    return `only read requests are allowed (egress limited), and publishing writes to ${host}`;
  if (matchingPattern(e.deny, host)) return `${host} is on the egress deny list`;
  if (e.allow.some((list) => !matchingPattern(list, host)))
    return `${host} is not among the hosts your organization's managed policy allows`;
  return null;
}

/**
 * A `fetch` that asks the egress ceiling before every request: a refused one never leaves the Hub
 * and fails with `policy_denied` `{reason: egress_denied, host}`.
 */
export function egressFetch(
  policy: () => Promise<HostingEgress>,
  inner: typeof fetch,
  onDenied?: (host: string, method: string, why: string) => Promise<void>,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let why: string | null;
    try {
      why = hostingEgressProblem(await policy(), host, method);
    } catch {
      why = 'the egress policy could not be read, so no request is made';
    }
    if (why) {
      await onDenied?.(host, method, why).catch(() => undefined);
      throw new NovaError('policy_denied', `Nova may not reach ${host}: ${why}`, {
        details: { reason: 'egress_denied', host },
      });
    }
    return inner(input, init);
  };
}

// ---- remote targets ----------------------------------------------------------------------------

function loopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  return isIP(h) === 4 && h.startsWith('127.');
}

/**
 * A target address as stored: http(s) without credentials, query or fragment, ending in `/`.
 * The upload address (`url`) is https, or http only to this machine (like the cloud runner's);
 * the public address is only shown, never fetched.
 */
export function hostingUrl(raw: string, field: 'url' | 'publicUrl'): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new NovaError('validation', `${field} is not a URL`, {
      details: { reason: 'url_invalid', field },
    });
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new NovaError('validation', `${field} must be an http or https address`, {
      details: { reason: 'url_invalid', field },
    });
  if (u.username || u.password)
    throw new NovaError('validation', 'enter the user name and password as the credential', {
      details: { reason: 'credentials_in_url', field },
    });
  if (u.search || u.hash)
    throw new NovaError('validation', `${field} cannot have a query or a fragment`, {
      details: { reason: 'url_invalid', field },
    });
  if (field === 'url' && u.protocol === 'http:' && !loopback(u.hostname))
    throw new NovaError('validation', 'use https (plain http only to this machine)', {
      details: { reason: 'https_required', field },
    });
  if (!u.pathname.endsWith('/')) u.pathname = `${u.pathname}/`;
  return u.toString();
}

export type CreateHostingTargetInput = z.infer<typeof createHostingTargetSchema>;
export type UpdateHostingTargetInput = z.infer<typeof updateHostingTargetSchema>;
type Credential = z.infer<typeof hostingCredentialSchema>;

interface TargetRow {
  id: string;
  account_id: string;
  name: string;
  kind: 'webdav';
  url: string;
  public_url: string | null;
  auth: HostingAuth;
  username: string | null;
  secret_ref: string | null;
  checked_at: string | null;
  check_ok: number | null;
  check_reason: string | null;
  check_message: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SiteTargetServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  events: EventSink;
  audit?: AuditSink;
  now?: () => Date;
  /** The egress ceiling (settings and managed policy); none means no ceiling (tests only). */
  egress?: () => Promise<HostingEgress>;
  /** `sites.remoteTargets`: off refuses adding, checking and publishing to targets. */
  enabled?: () => Promise<boolean>;
  /** The HTTP client under the egress check; the global `fetch` by default. */
  fetch?: typeof fetch;
  /** Per request; default 30 s. */
  timeoutMs?: number;
}

/** The owner's remote hosting targets: stored rows, vault credentials, connection checks. */
export class SiteTargetService {
  readonly #o: SiteTargetServiceOptions;
  #audit: AuditSink;
  readonly #now: () => Date;

  constructor(opts: SiteTargetServiceOptions) {
    this.#o = opts;
    this.#audit = opts.audit ?? noopAudit;
    this.#now = opts.now ?? (() => new Date());
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  list(accountId: string): Promise<SiteHostingTargetView[]> {
    return this.#sync(() =>
      this.#all<TargetRow>(
        'SELECT * FROM site_target WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at, id',
        accountId,
      ).map((r) => this.#view(r)),
    );
  }

  get(accountId: string, id: string): Promise<SiteHostingTargetView> {
    return this.#sync(() => this.#view(this.#row(accountId, id)));
  }

  async create(accountId: string, input: CreateHostingTargetInput): Promise<SiteHostingTargetView> {
    await this.assertEnabled();
    const url = hostingUrl(input.url, 'url');
    const publicUrl = input.publicUrl ? hostingUrl(input.publicUrl, 'publicUrl') : null;
    const id = uuidv7();
    const ref = await this.#storeCredential(id, null, input.credential);
    const now = this.#stamp();
    try {
      await this.#o.db.transaction(() => {
        this.#run(
          `INSERT INTO site_target (id, account_id, name, kind, url, public_url, auth, username,
             secret_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          accountId,
          input.name.trim(),
          input.kind,
          url,
          publicUrl,
          input.credential.kind,
          input.credential.kind === 'basic' ? input.credential.username : null,
          ref,
          now,
          now,
        );
      });
    } catch (err) {
      if (ref) await this.#o.secrets.delete(ref).catch(() => false);
      throw err;
    }
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: 'site.target.created',
      resource: `site_target:${id}`,
      result: 'ok',
      detail: {
        name: input.name.trim(),
        kind: input.kind,
        host: new URL(url).host,
        auth: input.credential.kind,
      },
    });
    await this.#emit(accountId, id, 'created');
    return this.get(accountId, id);
  }

  async update(
    accountId: string,
    id: string,
    patch: UpdateHostingTargetInput,
  ): Promise<SiteHostingTargetView> {
    const row = this.#row(accountId, id);
    const url = patch.url !== undefined ? hostingUrl(patch.url, 'url') : row.url;
    const publicUrl =
      patch.publicUrl === undefined
        ? row.public_url
        : patch.publicUrl
          ? hostingUrl(patch.publicUrl, 'publicUrl')
          : null;
    // The live sites' files stay where they are: moving the address would orphan them.
    if (url !== row.url && this.liveSites(id).length > 0)
      throw new NovaError(
        'conflict',
        'unpublish the sites on this target before changing its address',
        {
          details: { reason: 'target_in_use' },
        },
      );
    let ref = row.secret_ref;
    if (patch.credential) ref = await this.#storeCredential(id, row.secret_ref, patch.credential);
    const auth = patch.credential?.kind ?? row.auth;
    const username =
      patch.credential === undefined
        ? row.username
        : patch.credential.kind === 'basic'
          ? patch.credential.username
          : null;
    const now = this.#stamp();
    await this.#o.db.transaction(() => {
      this.#run(
        `UPDATE site_target SET name = ?, url = ?, public_url = ?, auth = ?, username = ?, secret_ref = ?,
           checked_at = CASE WHEN ? THEN NULL ELSE checked_at END,
           check_ok = CASE WHEN ? THEN NULL ELSE check_ok END,
           updated_at = ? WHERE id = ?`,
        patch.name?.trim() ?? row.name,
        url,
        publicUrl,
        auth,
        username,
        ref,
        url !== row.url || patch.credential ? 1 : 0,
        url !== row.url || patch.credential ? 1 : 0,
        now,
        id,
      );
    });
    const changed = Object.keys(patch).filter((k) => patch[k as keyof typeof patch] !== undefined);
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: 'site.target.updated',
      resource: `site_target:${id}`,
      result: 'ok',
      detail: { name: patch.name?.trim() ?? row.name, changed, host: new URL(url).host, auth },
    });
    await this.#emit(accountId, id, 'updated');
    return this.get(accountId, id);
  }

  /** Remove a target no site is live on; its credential leaves the vault. */
  async delete(accountId: string, id: string): Promise<void> {
    const row = this.#row(accountId, id);
    if (this.liveSites(id).length > 0)
      throw new NovaError('conflict', 'unpublish the sites on this target before removing it', {
        details: { reason: 'target_in_use' },
      });
    const now = this.#stamp();
    await this.#o.db.transaction(() => {
      this.#run(
        'UPDATE site_target SET deleted_at = ?, updated_at = ?, secret_ref = NULL, auth = ?, username = NULL WHERE id = ?',
        now,
        now,
        'none',
        id,
      );
    });
    if (row.secret_ref) await this.#o.secrets.delete(row.secret_ref).catch(() => false);
    await this.#audit.append({
      accountId,
      actor: 'user',
      kind: 'space',
      action: 'site.target.deleted',
      resource: `site_target:${id}`,
      result: 'ok',
      detail: { name: row.name, host: new URL(row.url).host },
    });
    await this.#emit(accountId, id, 'deleted');
  }

  /** Try the connection (a PROPFIND on the collection) and keep the outcome on the target. */
  async check(accountId: string, id: string): Promise<SiteHostingTargetView> {
    await this.assertEnabled();
    const row = this.#row(accountId, id);
    let ok = true;
    let reason: string | null = null;
    let message: string | null = null;
    try {
      await this.#client(row).check();
    } catch (err) {
      if (!(err instanceof NovaError)) throw err;
      ok = false;
      const r = err.details?.reason;
      reason = typeof r === 'string' ? r : 'target_refused';
      message = err.message;
    }
    const now = this.#stamp();
    await this.#o.db.transaction(() => {
      this.#run(
        'UPDATE site_target SET checked_at = ?, check_ok = ?, check_reason = ?, check_message = ? WHERE id = ?',
        now,
        ok ? 1 : 0,
        reason,
        message,
        id,
      );
    });
    await this.#emit(accountId, id, 'checked');
    return this.get(accountId, id);
  }

  /** `policy_denied` `{reason: remote_targets_off}` while `sites.remoteTargets` is off. */
  async assertEnabled(): Promise<void> {
    const on = this.#o.enabled ? await this.#o.enabled() : true;
    if (!on)
      throw new NovaError('policy_denied', 'publishing to hosting targets is turned off', {
        details: { reason: 'remote_targets_off' },
      });
  }

  /**
   * The target a publish writes to or takes down. Writing needs remote targets on; taking a site
   * down never does, so turning them off can still remove what is out there.
   */
  async open(accountId: string, id: string, purpose: 'write' | 'remove'): Promise<HostingTarget> {
    if (purpose === 'write') await this.assertEnabled();
    const row = this.#get<TargetRow>(
      'SELECT * FROM site_target WHERE id = ? AND account_id = ?',
      id,
      accountId,
    );
    if (!row || row.deleted_at)
      throw new NovaError('not_found', 'that hosting target was removed', {
        details: { reason: 'target_missing' },
      });
    return this.#client(row);
  }

  /** How a publish to `folder` on the target is shown; a removed target keeps no name. */
  ref(targetId: string, folder: string | null): SiteRemoteRef {
    const row = this.#get<TargetRow>('SELECT * FROM site_target WHERE id = ?', targetId);
    const seg = folder ? `${encodeURIComponent(folder)}/` : '';
    return {
      targetId,
      name: row && !row.deleted_at ? row.name : null,
      location: row ? `${row.url}${seg}` : null,
      publicUrl: row?.public_url ? `${row.public_url}${seg}` : null,
    };
  }

  /** Whether the egress policy lets Nova write to the target's host (shown before publishing). */
  async egressFor(
    accountId: string,
    id: string,
  ): Promise<{ host: string; allowed: boolean; message: string | null }> {
    const row = this.#row(accountId, id);
    const host = new URL(row.url).hostname.replace(/^\[|\]$/g, '');
    if (!this.#o.egress) return { host, allowed: true, message: null };
    let why: string | null;
    try {
      why = hostingEgressProblem(await this.#o.egress(), host, 'PUT');
    } catch {
      why = 'the egress policy could not be read, so no request is made';
    }
    return { host, allowed: why === null, message: why };
  }

  /** The sites live on a target now. */
  liveSites(targetId: string): { siteId: string; name: string; folder: string; version: number }[] {
    return this.#all<{ site_id: string; name: string; folder: string; version: number }>(
      `SELECT p.site_id, s.name, p.target_ref AS folder, p.version FROM site_publish p
       JOIN site s ON s.id = p.site_id
       WHERE p.target_id = ? AND s.deleted_at IS NULL AND p.id = (
         SELECT q.id FROM site_publish q WHERE q.site_id = p.site_id AND q.reverted_at IS NULL
         ORDER BY q.created_at DESC, q.rowid DESC LIMIT 1)
       ORDER BY s.name, p.site_id`,
      targetId,
    ).map((r) => ({ siteId: r.site_id, name: r.name, folder: r.folder, version: r.version }));
  }

  // ---- internals ---------------------------------------------------------------------------------

  #client(row: TargetRow): WebDavTarget {
    const inner = this.#o.fetch ?? fetch;
    return new WebDavTarget({
      url: row.url,
      authorization: () => this.#authorization(row),
      fetch: this.#o.egress
        ? egressFetch(this.#o.egress, inner, (host, method, why) =>
            this.#audit.append({
              accountId: row.account_id,
              actor: 'user',
              kind: 'network',
              action: 'site.egress.denied',
              resource: `site_target:${row.id}`,
              decision: 'deny',
              result: 'denied',
              detail: { host, method, reason: why },
            }),
          )
        : inner,
      ...(this.#o.timeoutMs ? { timeoutMs: this.#o.timeoutMs } : {}),
    });
  }

  async #authorization(row: TargetRow): Promise<string | null> {
    if (row.auth === 'none') return null;
    const value = row.secret_ref ? await this.#o.secrets.get(row.secret_ref) : null;
    if (!value)
      throw new NovaError(
        'conflict',
        'the stored credential for this target is missing; enter it again',
        {
          details: { reason: 'target_auth_failed' satisfies HostingProblem, missing: true },
        },
      );
    return row.auth === 'basic'
      ? `Basic ${Buffer.from(`${row.username ?? ''}:${value}`, 'utf8').toString('base64')}`
      : `Bearer ${value}`;
  }

  /** Put the credential's secret in the vault (or take it out for `none`); its reference. */
  async #storeCredential(
    id: string,
    current: string | null,
    c: Credential,
  ): Promise<string | null> {
    if (c.kind === 'none') {
      if (current) await this.#o.secrets.delete(current).catch(() => false);
      return null;
    }
    const ref = current ?? secretRef('sites', 'target', id, 'credential');
    await this.#o.secrets.put(ref, c.kind === 'basic' ? c.password : c.token);
    return ref;
  }

  #row(accountId: string, id: string): TargetRow {
    const r = this.#get<TargetRow>(
      'SELECT * FROM site_target WHERE id = ? AND account_id = ? AND deleted_at IS NULL',
      id,
      accountId,
    );
    if (!r) throw new NovaError('not_found', 'hosting target not found');
    return r;
  }

  #view(r: TargetRow): SiteHostingTargetView {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      url: r.url,
      publicUrl: r.public_url,
      auth: r.auth,
      username: r.username,
      hasCredential: r.secret_ref !== null,
      sites: this.liveSites(r.id),
      lastCheck: r.checked_at
        ? {
            ok: r.check_ok === 1,
            at: r.checked_at,
            reason: (r.check_reason as HostingProblem | null) ?? null,
            message: r.check_message,
          }
        : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async #emit(accountId: string, targetId: string, change: string): Promise<void> {
    await this.#o.events.emit({
      name: 'site.target.changed',
      accountId,
      actor: 'user',
      payload: { targetId, change },
    });
  }

  #sync<T>(fn: () => T): Promise<T> {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  #get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.#o.db.raw.prepare(sql).get(...params) as T | undefined;
  }

  #all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.#o.db.raw.prepare(sql).all(...params) as T[];
  }

  #run(sql: string, ...params: (string | number | null)[]): void {
    this.#o.db.raw.prepare(sql).run(...params);
  }
}
