// Optional OIDC sign-in for the people of a Hub (FR-113, docs/13 §7). The owner configures a
// provider (issuer, client id, an optional client secret kept in the vault as
// `secret://team/oidc/<id>`). Three flows use the authorization code flow with PKCE and a nonce:
// `link` (a signed-in person links an identity to their account), `sign_in` (a linked identity
// signs in to its account) and `join` (a new member redeems an invitation with their identity
// instead of a local account). The pending login (state, nonce, verifier) is kept in memory for
// ten minutes and used once; the state is the only thing the callback trusts.
import { createHash, timingSafeEqual, type JsonWebKey } from 'node:crypto';
import {
  NovaError,
  uuidv7,
  type CreateOidcProviderRequest,
  type OidcFlow,
  type OidcIdentityView,
  type OidcProviderView,
  type UpdateOidcProviderRequest,
} from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditSink } from '../tools/types.ts';
import type { TeamService } from './members.ts';
import { oneLine } from './text.ts';
import {
  OidcError,
  authorizationUrl,
  discover,
  exchangeCode,
  fetchJwks,
  pkcePair,
  randomToken,
  verifyIdToken,
  type FetchLike,
  type IdTokenClaims,
  type OidcDiscovery,
} from './oidc.ts';

export const OIDC_CALLBACK_PATH = '/api/v1/auth/oidc/callback';
const DEFAULT_SCOPES = ['openid', 'profile', 'email'];
const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 1000;
/** Sign-ins one address may have pending at once; its own oldest goes first. */
const MAX_PENDING_PER_ADDRESS = 10;
const JWKS_TTL_MS = 10 * 60_000;

interface ProviderRow {
  id: string;
  label: string;
  issuer: string;
  client_id: string;
  client_secret_ref: string | null;
  scopes: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface Pending {
  flow: OidcFlow;
  providerId: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
  accountId: string | null;
  invitation: string | null;
  displayName: string | null;
  /** SHA-256 of the random value the starting browser holds in its binding cookie. */
  binding: Buffer;
  /** Where the start came from: each address keeps only a few sign-ins pending. */
  address: string;
}

export type OidcOutcome =
  | { kind: 'signed_in'; accountId: string; session: { token: string; maxAgeS: number } }
  | { kind: 'joined'; accountId: string; session: { token: string; maxAgeS: number } }
  | { kind: 'linked'; accountId: string };

export interface OidcServiceOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  events: EventSink;
  team: TeamService;
  audit?: AuditSink;
  fetch?: FetchLike;
  log?: Logger;
  now?: () => Date;
}

function stateKey(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

function refused(reason: string, message: string): NovaError {
  return new NovaError('auth_missing', message, { details: { reason } });
}

export class OidcService {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #events: EventSink;
  readonly #team: TeamService;
  #audit: AuditSink | undefined;
  readonly #fetch: FetchLike;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #pending = new Map<string, Pending>();
  readonly #discovery = new Map<string, { at: number; doc: OidcDiscovery }>();
  readonly #jwks = new Map<string, { at: number; keys: JsonWebKey[] }>();

  constructor(opts: OidcServiceOptions) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#events = opts.events;
    this.#team = opts.team;
    this.#audit = opts.audit;
    this.#fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.#log = opts.log ?? new Logger({ module: 'core.team.oidc', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  // ---- providers (owner) ------------------------------------------------------------------------

  #row(id: string): ProviderRow | null {
    return (
      (this.#db.raw.prepare('SELECT * FROM oidc_provider WHERE id = ?').get(id) as
        ProviderRow | undefined) ?? null
    );
  }

  #view(r: ProviderRow): OidcProviderView {
    return {
      id: r.id,
      label: r.label,
      issuer: r.issuer,
      clientId: r.client_id,
      hasClientSecret: r.client_secret_ref !== null,
      scopes: r.scopes.split(' ').filter(Boolean),
      enabled: r.enabled === 1,
      redirectPath: OIDC_CALLBACK_PATH,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  providers(actor: string): OidcProviderView[] {
    this.#team.assertOwner(actor);
    const rows = this.#db.raw
      .prepare('SELECT * FROM oidc_provider ORDER BY created_at')
      .all() as unknown as ProviderRow[];
    return rows.map((r) => this.#view(r));
  }

  /** Enabled providers by label only: what a sign-in or join page may show. */
  publicProviders(): { id: string; label: string }[] {
    return (
      this.#db.raw
        .prepare('SELECT id, label FROM oidc_provider WHERE enabled = 1 ORDER BY created_at')
        .all() as { id: string; label: string }[]
    ).map((r) => ({ id: r.id, label: r.label }));
  }

  async createProvider(actor: string, req: CreateOidcProviderRequest): Promise<OidcProviderView> {
    this.#team.assertOwner(actor);
    const issuer = req.issuer.replace(/\/+$/, '') || req.issuer;
    if (this.#db.raw.prepare('SELECT 1 AS x FROM oidc_provider WHERE issuer = ?').get(issuer))
      throw new NovaError('conflict', 'this issuer is already configured');
    const id = uuidv7();
    const at = this.#now().toISOString();
    const ref = req.clientSecret ? `secret://team/oidc/${id}` : null;
    if (ref && req.clientSecret) await this.#secrets.put(ref, req.clientSecret);
    try {
      await this.#db.transaction(() =>
        this.#db.raw
          .prepare(
            `INSERT INTO oidc_provider (id, label, issuer, client_id, client_secret_ref, scopes,
               enabled, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            req.label,
            issuer,
            req.clientId,
            ref,
            (req.scopes ?? DEFAULT_SCOPES).join(' '),
            req.enabled === false ? 0 : 1,
            actor,
            at,
            at,
          ),
      );
    } catch (err) {
      if (ref) await this.#secrets.delete(ref).catch(() => false);
      throw err;
    }
    await this.#auditAuth(actor, 'oidc.provider.create', `oidc:${id}`, {
      issuer,
      secretRef: ref,
    });
    return this.#view(this.#row(id)!);
  }

  async updateProvider(
    actor: string,
    id: string,
    req: UpdateOidcProviderRequest,
  ): Promise<OidcProviderView> {
    this.#team.assertOwner(actor);
    const cur = this.#row(id);
    if (!cur) throw new NovaError('not_found', 'OIDC provider not found');
    let ref = cur.client_secret_ref;
    if (req.clientSecret === null && ref) {
      await this.#secrets.delete(ref).catch(() => false);
      ref = null;
    } else if (typeof req.clientSecret === 'string') {
      ref = ref ?? `secret://team/oidc/${id}`;
      await this.#secrets.put(ref, req.clientSecret);
    }
    const at = this.#now().toISOString();
    await this.#db.transaction(() =>
      this.#db.raw
        .prepare(
          `UPDATE oidc_provider SET label = ?, client_id = ?, client_secret_ref = ?, scopes = ?,
             enabled = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          req.label ?? cur.label,
          req.clientId ?? cur.client_id,
          ref,
          req.scopes ? req.scopes.join(' ') : cur.scopes,
          req.enabled === undefined ? cur.enabled : req.enabled ? 1 : 0,
          at,
          id,
        ),
    );
    this.#discovery.delete(id);
    await this.#auditAuth(actor, 'oidc.provider.update', `oidc:${id}`, {
      changed: Object.keys(req),
      secretRef: ref,
    });
    return this.#view(this.#row(id)!);
  }

  async deleteProvider(actor: string, id: string): Promise<void> {
    this.#team.assertOwner(actor);
    const cur = this.#row(id);
    if (!cur) throw new NovaError('not_found', 'OIDC provider not found');
    await this.#db.transaction(() =>
      this.#db.raw.prepare('DELETE FROM oidc_provider WHERE id = ?').run(id),
    );
    if (cur.client_secret_ref) await this.#secrets.delete(cur.client_secret_ref).catch(() => false);
    this.#discovery.delete(id);
    await this.#auditAuth(actor, 'oidc.provider.delete', `oidc:${id}`, { issuer: cur.issuer });
  }

  /**
   * Check a provider from the Hub (owner): its discovery document and its key set, under the same
   * address rules as a sign-in (https, http only to this machine). Works on a provider that is
   * turned off, so it can be checked before it is turned on.
   */
  async testProvider(actor: string, id: string): Promise<{ ok: boolean; detail: string }> {
    this.#team.assertOwner(actor);
    const p = this.#row(id);
    if (!p) throw new NovaError('not_found', 'OIDC provider not found');
    let out: { ok: boolean; detail: string };
    try {
      const doc = await discover(p.issuer, this.#fetch);
      const keys = await fetchJwks(doc, this.#fetch);
      const signing = keys.filter((k) => k.use === undefined || k.use === 'sig').length;
      out = signing
        ? {
            ok: true,
            detail: `${doc.issuer} answers; ${signing} signing key${signing === 1 ? '' : 's'}; sign-in at ${new URL(doc.authorization_endpoint).host}`,
          }
        : { ok: false, detail: 'the provider publishes no signing key' };
      if (out.ok) this.#discovery.set(p.id, { at: Date.now(), doc });
    } catch (err) {
      out = { ok: false, detail: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
    }
    await this.#auditAuth(actor, 'oidc.provider.test', `oidc:${id}`, { ok: out.ok });
    return out;
  }

  // ---- identities ----------------------------------------------------------------------------

  identities(accountId: string): OidcIdentityView[] {
    const rows = this.#db.raw
      .prepare(
        `SELECT i.id, i.provider_id, p.label, i.subject, i.email, i.linked_at, i.last_sign_in_at
         FROM oidc_identity i JOIN oidc_provider p ON p.id = i.provider_id
         WHERE i.account_id = ? ORDER BY i.linked_at`,
      )
      .all(accountId) as {
      id: string;
      provider_id: string;
      label: string;
      subject: string;
      email: string | null;
      linked_at: string;
      last_sign_in_at: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      providerId: r.provider_id,
      providerLabel: r.label,
      subject: r.subject,
      email: r.email,
      linkedAt: r.linked_at,
      lastSignInAt: r.last_sign_in_at,
    }));
  }

  async unlink(accountId: string, identityId: string): Promise<void> {
    const changed = await this.#db.transaction(
      () =>
        this.#db.raw
          .prepare('DELETE FROM oidc_identity WHERE id = ? AND account_id = ?')
          .run(identityId, accountId).changes,
    );
    if (!changed) throw new NovaError('not_found', 'identity not found');
    await this.#auditAuth(accountId, 'oidc.unlink', `oidc-identity:${identityId}`, {});
  }

  // ---- the flows --------------------------------------------------------------------------------

  async #discoveryFor(p: ProviderRow): Promise<OidcDiscovery> {
    const cached = this.#discovery.get(p.id);
    if (cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.doc;
    const doc = await discover(p.issuer, this.#fetch);
    this.#discovery.set(p.id, { at: Date.now(), doc });
    return doc;
  }

  async #keys(doc: OidcDiscovery, fresh: boolean) {
    const cached = this.#jwks.get(doc.jwks_uri);
    if (!fresh && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.keys;
    const keys = await fetchJwks(doc, this.#fetch);
    this.#jwks.set(doc.jwks_uri, { at: Date.now(), keys });
    return keys;
  }

  /**
   * Room for a new pending sign-in from `address`: expired ones go, the address's own oldest
   * goes when it has too many, and a full map refuses new starts rather than dropping someone
   * else's sign-in in progress.
   */
  #makeRoom(address: string): void {
    const now = this.#now().getTime();
    for (const [k, p] of this.#pending) if (p.expiresAt <= now) this.#pending.delete(k);
    const mine = [...this.#pending].filter(([, p]) => p.address === address);
    for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_PENDING_PER_ADDRESS + 1)))
      this.#pending.delete(k);
    if (this.#pending.size >= MAX_PENDING)
      throw new NovaError('rate_limited', 'too many sign-ins are in progress; try again soon', {
        details: { reason: 'oidc_busy' },
      });
  }

  /**
   * Start a sign-in at the provider: the URL to send the browser to. `link` needs the signed-in
   * account; `join` needs a usable invitation (checked again at the callback).
   */
  async start(input: {
    providerId: string;
    flow: OidcFlow;
    baseUrl: string;
    accountId?: string | null;
    invitation?: string | null;
    displayName?: string | null;
    /**
     * A random value the Hub hands the starting browser in a cookie: the callback is accepted
     * only from a browser that holds it (login CSRF, link CSRF, a leaked provider URL).
     */
    browserBinding: string;
    /** The client address of the start. */
    address: string;
  }): Promise<{ url: string; expiresAt: string }> {
    if (input.browserBinding.length < 32)
      throw new NovaError('validation', 'a weak browser binding');
    const p = this.#row(input.providerId);
    if (!p || p.enabled !== 1) throw new NovaError('not_found', 'OIDC provider not found');
    if (input.flow === 'link' && !input.accountId)
      throw new NovaError('token_required', 'sign in to link an identity');
    if (
      input.flow === 'join' &&
      !(input.invitation && this.#team.invitationUsable(input.invitation))
    )
      throw refused('invitation_invalid', 'this invitation is invalid, used or expired');
    let doc: OidcDiscovery;
    try {
      doc = await this.#discoveryFor(p);
    } catch (err) {
      throw new NovaError('node_unavailable', 'the sign-in provider cannot be reached', {
        details: { reason: err instanceof OidcError ? err.reason : 'discovery' },
      });
    }
    this.#makeRoom(input.address);
    const state = randomToken(32);
    const nonce = randomToken(32);
    const { verifier, challenge } = pkcePair();
    const redirectUri = `${input.baseUrl.replace(/\/$/, '')}${OIDC_CALLBACK_PATH}`;
    const expiresAt = this.#now().getTime() + PENDING_TTL_MS;
    this.#pending.set(stateKey(state), {
      flow: input.flow,
      providerId: p.id,
      nonce,
      verifier,
      redirectUri,
      expiresAt,
      accountId: input.flow === 'link' ? (input.accountId ?? null) : null,
      invitation: input.flow === 'join' ? (input.invitation ?? null) : null,
      displayName: input.displayName ? oneLine(input.displayName) || null : null,
      binding: createHash('sha256').update(input.browserBinding).digest(),
      address: input.address,
    });
    return {
      url: authorizationUrl(doc, {
        clientId: p.client_id,
        redirectUri,
        scopes: p.scopes.split(' ').filter(Boolean),
        state,
        nonce,
        challenge,
      }),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** How the browser came back from the provider. The state is used once, whatever happens. */
  async callback(
    q: { state?: string; code?: string; error?: string },
    browserBinding: string | undefined,
  ): Promise<OidcOutcome> {
    const key = q.state && q.state.length <= 200 ? stateKey(q.state) : null;
    const pending = key ? this.#pending.get(key) : undefined;
    if (key) this.#pending.delete(key);
    if (!pending || pending.expiresAt <= this.#now().getTime())
      throw refused('state_invalid', 'this sign-in expired or was already used; start again');
    try {
      return await this.#finish(pending, q, browserBinding);
    } catch (err) {
      // The flow travels with the refusal: a failed link returns to the account settings.
      if (!(err instanceof NovaError)) throw err;
      throw new NovaError(err.code, err.message, {
        details: { ...(err.details ?? {}), flow: pending.flow },
      });
    }
  }

  async #finish(
    pending: Pending,
    q: { state?: string; code?: string; error?: string },
    browserBinding: string | undefined,
  ): Promise<OidcOutcome> {
    // Only the browser that started the sign-in may finish it.
    const held = createHash('sha256')
      .update(browserBinding ?? '')
      .digest();
    if (!browserBinding || !timingSafeEqual(held, pending.binding))
      throw refused('browser_mismatch', 'this sign-in was started in another browser; start again');
    if (q.error || !q.code)
      throw refused('provider_error', 'the sign-in provider did not sign you in');
    const p = this.#row(pending.providerId);
    if (!p || p.enabled !== 1) throw refused('provider_disabled', 'this sign-in provider is off');
    let claims: IdTokenClaims;
    try {
      claims = await this.#verify(p, pending, q.code);
    } catch (err) {
      const reason = err instanceof OidcError ? err.reason : 'token_exchange';
      await this.#auditAuth(
        pending.accountId ?? this.#team.ownerId() ?? '',
        'oidc.refused',
        `oidc:${p.id}`,
        {
          reason,
          flow: pending.flow,
        },
        'system',
      );
      throw refused(`oidc_${reason}`, `the sign-in was refused (${reason})`);
    }
    const email = typeof claims.email === 'string' ? claims.email.slice(0, 320) : null;
    const now = this.#now().toISOString();
    const linked = this.#db.raw
      .prepare(
        `SELECT i.account_id FROM oidc_identity i JOIN account a ON a.id = i.account_id
         WHERE i.provider_id = ? AND i.subject = ? AND a.deleted_at IS NULL`,
      )
      .get(p.id, claims.sub) as { account_id: string } | undefined;
    switch (pending.flow) {
      case 'link': {
        const accountId = pending.accountId!;
        if (!this.#team.roleOf(accountId))
          throw refused('account_closed', 'this account is closed');
        if (linked && linked.account_id !== accountId)
          throw new NovaError('conflict', 'this identity is linked to someone else on this Hub', {
            details: { reason: 'identity_taken' },
          });
        if (!linked)
          await this.#db.transaction(() =>
            this.#insertIdentity(accountId, p.id, claims.sub, email, now),
          );
        await this.#auditAuth(accountId, 'oidc.link', `oidc:${p.id}`, { subject: claims.sub });
        return { kind: 'linked', accountId };
      }
      case 'sign_in': {
        if (!linked || !this.#team.roleOf(linked.account_id))
          throw refused('not_linked', 'this identity is not linked to anyone on this Hub');
        const session = await this.#team.issueSession(linked.account_id);
        await this.#db.transaction(() =>
          this.#db.raw
            .prepare(
              'UPDATE oidc_identity SET last_sign_in_at = ? WHERE provider_id = ? AND subject = ?',
            )
            .run(now, p.id, claims.sub),
        );
        await this.#auditAuth(linked.account_id, 'oidc.sign_in', `oidc:${p.id}`, {
          subject: claims.sub,
        });
        await this.#events.emit({
          name: 'auth.session.created',
          actor: 'user',
          accountId: linked.account_id,
          payload: { accountId: linked.account_id, via: 'oidc' },
        });
        return { kind: 'signed_in', accountId: linked.account_id, session };
      }
      case 'join': {
        if (linked)
          throw new NovaError('conflict', 'this identity already belongs to someone on this Hub', {
            details: { reason: 'identity_taken' },
          });
        const name =
          pending.displayName ??
          (typeof claims.name === 'string' ? claims.name : null) ??
          (typeof claims.preferred_username === 'string' ? claims.preferred_username : null) ??
          email ??
          'Member';
        const out = await this.#team.redeem(pending.invitation ?? '', name, {
          via: 'oidc',
          link: (accountId) => this.#insertIdentity(accountId, p.id, claims.sub, email, now),
        });
        return { kind: 'joined', accountId: out.accountId, session: out.session };
      }
    }
  }

  async #verify(p: ProviderRow, pending: Pending, code: string): Promise<IdTokenClaims> {
    const doc = await this.#discoveryFor(p);
    const secret = p.client_secret_ref ? await this.#secrets.get(p.client_secret_ref) : null;
    const { idToken } = await exchangeCode(
      doc,
      {
        code,
        redirectUri: pending.redirectUri,
        clientId: p.client_id,
        clientSecret: secret,
        verifier: pending.verifier,
      },
      this.#fetch,
    );
    const opts = {
      issuer: doc.issuer,
      clientId: p.client_id,
      nonce: pending.nonce,
      now: this.#now(),
    };
    try {
      return verifyIdToken(idToken, { ...opts, keys: await this.#keys(doc, false) });
    } catch (err) {
      // A rotated key: read the key set once more before refusing.
      if (!(err instanceof OidcError) || err.reason !== 'key') throw err;
      return verifyIdToken(idToken, { ...opts, keys: await this.#keys(doc, true) });
    }
  }

  #insertIdentity(
    accountId: string,
    providerId: string,
    subject: string,
    email: string | null,
    at: string,
  ): void {
    const has = this.#db.raw
      .prepare('SELECT 1 AS x FROM oidc_identity WHERE account_id = ? AND provider_id = ?')
      .get(accountId, providerId);
    if (has)
      throw new NovaError('conflict', 'this account already has an identity from this provider', {
        details: { reason: 'already_linked' },
      });
    this.#db.raw
      .prepare(
        `INSERT INTO oidc_identity (id, account_id, provider_id, subject, email, linked_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(uuidv7(), accountId, providerId, subject, email, at);
  }

  async #auditAuth(
    accountId: string,
    action: string,
    resource: string,
    detail: Record<string, unknown>,
    actor = 'user',
  ): Promise<void> {
    if (!accountId) return;
    try {
      await this.#audit?.append({ accountId, actor, kind: 'auth', action, resource, detail });
    } catch (err) {
      this.#log.warn('OIDC audit not recorded', { err, action });
    }
  }
}
