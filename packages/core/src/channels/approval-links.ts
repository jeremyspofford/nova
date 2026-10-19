// Signed approval links for email (FR-110, FR-100, docs/13 §4): an approval sent by email is
// answered only through a link in it, never by reply text, because a From address is easy to
// forge. A link is `<id>.<expiry>.<signature>`: HMAC-SHA256 with the Hub's link key (vault) over
// the id, the approval, the binding and the expiry, checked in constant time; its row makes it
// single use. Opening the link (GET) only shows the choices, so mail scanners that follow links
// change nothing; the answer is a POST from that page. Links go only to private bindings whose
// sender was the owner's verified address.
import { createHmac, randomBytes } from 'node:crypto';
import { NovaError, uuidv7 } from '@nova/shared';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';
import { safeEqual } from './signing.ts';

export const LINK_KEY_REF = 'secret://channels/approval-link-key';
const TOKEN = /^([0-9a-f-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

export interface ApprovalLinkRow {
  id: string;
  account_id: string;
  binding_id: string;
  approval_id: string;
  expires_at: string;
  used_at: string | null;
  decision: string | null;
  created_at: string;
}

export class ApprovalLinks {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #now: () => Date;
  #key: Promise<string> | null = null;

  constructor(opts: { db: NovaDatabase; secrets: SecretStore; now?: () => Date }) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#now = opts.now ?? (() => new Date());
  }

  #linkKey(): Promise<string> {
    this.#key ??= (async () => {
      const stored = await this.#secrets.get(LINK_KEY_REF);
      if (stored) return stored;
      const fresh = randomBytes(32).toString('base64url');
      await this.#secrets.put(LINK_KEY_REF, fresh);
      return fresh;
    })().catch((err: unknown) => {
      this.#key = null;
      throw err;
    });
    return this.#key;
  }

  #sign(key: string, id: string, approvalId: string, bindingId: string, exp: string): string {
    return createHmac('sha256', key)
      .update(`nova-approval-link-v1|${id}|${approvalId}|${bindingId}|${exp}`)
      .digest('base64url');
  }

  /** A new one-use link token for an approval sent to a binding. */
  async create(input: {
    accountId: string;
    bindingId: string;
    approvalId: string;
    expiresAt: Date;
  }): Promise<string> {
    const id = uuidv7();
    const exp = String(Math.floor(input.expiresAt.getTime() / 1000));
    const key = await this.#linkKey();
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO channel_approval_link (id, account_id, binding_id, approval_id, expires_at,
             used_at, decision, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .run(
          id,
          input.accountId,
          input.bindingId,
          input.approvalId,
          new Date(Number(exp) * 1000).toISOString(),
          this.#now().toISOString(),
        );
    });
    return `${id}.${exp}.${this.#sign(key, id, input.approvalId, input.bindingId, exp)}`;
  }

  /**
   * The link's row when the token is genuine, unexpired and unspent. Any failure is the same
   * `not_found`, so a guess learns nothing.
   */
  async open(token: string): Promise<ApprovalLinkRow> {
    const gone = () => new NovaError('not_found', 'this approval link is not valid any more');
    const m = TOKEN.exec(token);
    if (!m) throw gone();
    const [, id, exp, sig] = m as unknown as [string, string, string, string];
    const row = this.#db.raw.prepare('SELECT * FROM channel_approval_link WHERE id = ?').get(id) as
      ApprovalLinkRow | undefined;
    if (!row) throw gone();
    const key = await this.#linkKey();
    if (!safeEqual(this.#sign(key, id, row.approval_id, row.binding_id, exp), sig)) throw gone();
    if (Date.parse(row.expires_at) !== Number(exp) * 1000) throw gone();
    if (Number(exp) * 1000 <= this.#now().getTime() || row.used_at) throw gone();
    return row;
  }

  /** Spend the link (single use): false when it was spent meanwhile. */
  async spend(id: string, decision: string): Promise<boolean> {
    const res = await this.#db.transaction(() =>
      this.#db.raw
        .prepare(
          'UPDATE channel_approval_link SET used_at = ?, decision = ? WHERE id = ? AND used_at IS NULL',
        )
        .run(this.#now().toISOString(), decision, id),
    );
    return Number(res.changes) === 1;
  }
}
