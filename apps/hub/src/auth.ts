// Credentials for the Hub API (FR-192). Tokens are random, shown once, stored as hashes, and
// checked in constant time by the database lookup on their hash.
import { and, eq, isNull, or } from 'drizzle-orm';
import { NovaError, uuidv7 } from '@nova/shared';
import { hubOwnerId, recordHubOwner } from '@nova/core';
import { hashToken, newToken, type TokenKind } from '@nova/security';
import { schema, type NovaDatabase } from '@nova/storage';

const { account, authToken } = schema;

export interface Principal {
  tokenId: string;
  kind: TokenKind;
  accountId: string | null;
  /** The device of a device session (Add Device); null for the owner's own browser session. */
  deviceId: string | null;
  /** That device's scopes, read on every request so a change applies at once; null without one. */
  scopes: string[] | null;
}

/** The device and scopes behind a request's session (ADR-095 decision 3). */
export interface DeviceScopes {
  deviceId: string;
  scopes: readonly string[];
}

/**
 * `ctx.deviceScopes(req)`: the device id and scopes of a device session, null for a session that
 * belongs to no device (the owner's own browser) or no session. Areas gate on a scope with it.
 */
export function deviceScopes(req: { principal?: Principal | null }): DeviceScopes | null {
  const p = req.principal;
  if (!p?.deviceId) return null;
  return { deviceId: p.deviceId, scopes: p.scopes ?? [] };
}

export class AuthService {
  readonly #db: NovaDatabase;
  readonly #now: () => Date;

  constructor(db: NovaDatabase, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  /**
   * The Hub owner: the recorded owner row (M7, decision 5), the one lookup every area uses
   * (`hubOwnerId`); members and team agents' identities are never taken for it.
   */
  async ownerAccount(): Promise<{ id: string; displayName: string | null } | null> {
    const id = hubOwnerId(this.#db);
    return id ? this.account(id) : null;
  }

  /** One account's display name (members see their own in the session, not the owner's). */
  async account(accountId: string): Promise<{ id: string; displayName: string | null } | null> {
    const rows = await this.#db.orm
      .select({ id: account.id, displayName: account.displayName })
      .from(account)
      .where(and(eq(account.id, accountId), isNull(account.deletedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Issue a one-time setup code (default TTL 1 h). The caller shows it to the owner once. */
  async issueSetupCode(ttlMs = 60 * 60 * 1000): Promise<string> {
    const token = newToken('setup');
    const now = this.#now();
    await this.#db.orm.insert(authToken).values({
      id: uuidv7(),
      kind: 'setup',
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    return token;
  }

  /**
   * Exchange a setup code for a session. Creates the local owner account on first use. The code
   * is burned whether or not the exchange succeeds later.
   */
  async redeemSetupCode(
    code: string,
    displayName?: string,
  ): Promise<{ session: string; accountId: string }> {
    return this.#db.transaction(async () => {
      const found = await this.#find(code, 'setup');
      if (!found) throw new NovaError('auth_missing', 'setup code is invalid or expired');
      const nowIso = this.#now().toISOString();
      await this.#db.orm
        .update(authToken)
        .set({ revokedAt: nowIso, lastUsedAt: nowIso })
        .where(eq(authToken.id, found.id));
      let owner = await this.ownerAccount();
      if (!owner) {
        owner = { id: uuidv7(), displayName: displayName ?? null };
        await this.#db.orm.insert(account).values({
          id: owner.id,
          kind: 'local',
          displayName: displayName ?? null,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
      // The owner is recorded at once, so no later account can ever be taken for it.
      recordHubOwner(this.#db, owner.id, nowIso);
      const session = await this.#issue('session', owner.id, 30 * 24 * 60 * 60 * 1000);
      return { session, accountId: owner.id };
    });
  }

  async #issue(kind: TokenKind, accountId: string | null, ttlMs: number): Promise<string> {
    const token = newToken(kind);
    const now = this.#now();
    await this.#db.orm.insert(authToken).values({
      id: uuidv7(),
      kind,
      tokenHash: hashToken(token),
      accountId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    });
    return token;
  }

  async #find(token: string, kind?: TokenKind) {
    if (!token || token.length > 200) return null;
    const rows = await this.#db.orm
      .select()
      .from(authToken)
      .where(eq(authToken.tokenHash, hashToken(token)))
      .limit(1);
    const row = rows[0];
    if (!row || row.revokedAt) return null;
    if (kind && row.kind !== kind) return null;
    if (row.expiresAt && row.expiresAt <= this.#now().toISOString()) return null;
    return row;
  }

  /** Verify a bearer or cookie credential. Setup codes never authenticate API calls. */
  async verify(token: string): Promise<Principal | null> {
    const row = await this.#find(token);
    // Only sessions act as a user. Device, MCP-client and app tokens carry their own scopes and
    // are checked by the routes that accept them (FR-192), never here.
    if (!row || row.kind !== 'session') return null;
    // A removed member's account is closed: none of its sessions authenticate (decision 5).
    if (row.accountId && this.#closed(row.accountId)) return null;
    const device = this.#deviceOf(row.id);
    if (device === 'revoked') return null;
    return {
      tokenId: row.id,
      kind: row.kind,
      accountId: row.accountId,
      deviceId: device?.deviceId ?? null,
      scopes: device?.scopes ?? null,
    };
  }

  /**
   * The device a session belongs to (`device_session`, M6.5) and its current scopes. A revoked
   * device's sessions are deleted with it; one that is still found fails closed.
   */
  #deviceOf(tokenId: string): { deviceId: string; scopes: string[] } | 'revoked' | null {
    const row = this.#db.raw
      .prepare(
        `SELECT d.id, d.scopes, d.status FROM device_session s JOIN device d ON d.id = s.device_id
         WHERE s.token_id = ?`,
      )
      .get(tokenId) as { id: string; scopes: string | null; status: string } | undefined;
    if (!row) return null;
    if (row.status === 'revoked') return 'revoked';
    let scopes: string[] = [];
    try {
      const v: unknown = JSON.parse(row.scopes ?? '[]');
      if (Array.isArray(v)) scopes = v.filter((x): x is string => typeof x === 'string');
    } catch {
      scopes = [];
    }
    return { deviceId: row.id, scopes };
  }

  async revoke(tokenId: string): Promise<void> {
    await this.#db.orm
      .update(authToken)
      .set({ revokedAt: this.#now().toISOString() })
      .where(eq(authToken.id, tokenId));
  }

  /** Whether the owner can sign in now; members' sessions do not count (main.ts prints a code). */
  async hasActiveSessions(): Promise<boolean> {
    const owner = await this.ownerAccount();
    const mine = owner
      ? or(eq(authToken.accountId, owner.id), isNull(authToken.accountId))
      : isNull(authToken.accountId);
    const rows = await this.#db.orm
      .select({ id: authToken.id, expiresAt: authToken.expiresAt })
      .from(authToken)
      .where(and(eq(authToken.kind, 'session'), isNull(authToken.revokedAt), mine));
    const now = this.#now().toISOString();
    return rows.some((r) => !r.expiresAt || r.expiresAt > now);
  }

  // ---- M7 members (decision 5 of ADR-095): sessions of other people of the Hub ----------------

  /** A session for an account (a member who joined, an OIDC sign-in); 30 days like the owner's. */
  async issueSession(accountId: string): Promise<{ token: string; maxAgeS: number }> {
    const maxAgeS = 30 * 24 * 60 * 60;
    return { token: await this.#issue('session', accountId, maxAgeS * 1000), maxAgeS };
  }

  /** End every session of an account (a removed member); returns how many ended. */
  async revokeAccountSessions(accountId: string): Promise<number> {
    const at = this.#now().toISOString();
    return this.#db.transaction(() => {
      const res = this.#db.raw
        .prepare(
          `UPDATE auth_token SET revoked_at = ? WHERE account_id = ? AND kind = 'session'
             AND revoked_at IS NULL`,
        )
        .run(at, accountId);
      return Number(res.changes);
    });
  }

  #closed(accountId: string): boolean {
    const row = this.#db.raw
      .prepare('SELECT deleted_at FROM account WHERE id = ?')
      .get(accountId) as { deleted_at: string | null } | undefined;
    return !row || row.deleted_at !== null;
  }
}
