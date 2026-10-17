// Credentials for the Hub API (FR-192). Tokens are random, shown once, stored as hashes, and
// checked in constant time by the database lookup on their hash.
import { and, eq, isNull } from 'drizzle-orm';
import { NovaError, uuidv7 } from '@nova/shared';
import { hashToken, newToken, type TokenKind } from '@nova/security';
import { schema, type NovaDatabase } from '@nova/storage';

const { account, authToken } = schema;

export interface Principal {
  tokenId: string;
  kind: TokenKind;
  accountId: string | null;
}

export class AuthService {
  readonly #db: NovaDatabase;
  readonly #now: () => Date;

  constructor(db: NovaDatabase, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
  }

  async ownerAccount(): Promise<{ id: string; displayName: string | null } | null> {
    const rows = await this.#db.orm
      .select({ id: account.id, displayName: account.displayName })
      .from(account)
      .where(and(eq(account.kind, 'local'), isNull(account.deletedAt)))
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
    if (!row || row.kind === 'setup') return null;
    return { tokenId: row.id, kind: row.kind, accountId: row.accountId };
  }

  async revoke(tokenId: string): Promise<void> {
    await this.#db.orm
      .update(authToken)
      .set({ revokedAt: this.#now().toISOString() })
      .where(eq(authToken.id, tokenId));
  }

  async hasActiveSessions(): Promise<boolean> {
    const rows = await this.#db.orm
      .select({ id: authToken.id, expiresAt: authToken.expiresAt })
      .from(authToken)
      .where(and(eq(authToken.kind, 'session'), isNull(authToken.revokedAt)));
    const now = this.#now().toISOString();
    return rows.some((r) => !r.expiresAt || r.expiresAt > now);
  }
}
