// The opt-in public profile card (FR-113): a read-only view of a person's display name and, if
// they choose, their avatar, at a handle they pick. Off by default for everyone; the Hub-wide
// `team.publicProfiles` setting must allow it too. Nothing else about the account is ever shown.
import { NovaError, type ProfileCardRequest, type ProfileCardView } from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';

interface CardRow {
  account_id: string;
  handle: string;
  enabled: number;
  show_avatar: number;
  updated_at: string;
}

export interface PublicCard {
  accountId: string;
  handle: string;
  displayName: string | null;
  showAvatar: boolean;
  hasAvatar: boolean;
}

export interface ProfileCardServiceOptions {
  db: NovaDatabase;
  now?: () => Date;
  /** `team.publicProfiles`: the Hub allows public cards at all. */
  allowed: () => Promise<boolean>;
}

export const PROFILE_CARD_BASE = '/api/v1/profiles/';

export class ProfileCardService {
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  readonly #allowed: () => Promise<boolean>;

  constructor(opts: ProfileCardServiceOptions) {
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
    this.#allowed = opts.allowed;
  }

  #row(accountId: string): CardRow | null {
    return (
      (this.#db.raw.prepare('SELECT * FROM profile_card WHERE account_id = ?').get(accountId) as
        CardRow | undefined) ?? null
    );
  }

  async get(accountId: string): Promise<ProfileCardView> {
    const r = this.#row(accountId);
    return {
      allowed: await this.#allowed(),
      enabled: r?.enabled === 1,
      handle: r?.handle ?? null,
      showAvatar: r ? r.show_avatar === 1 : true,
      path: r?.enabled === 1 ? `${PROFILE_CARD_BASE}${r.handle}` : null,
    };
  }

  async set(accountId: string, req: ProfileCardRequest): Promise<ProfileCardView> {
    if (req.enabled && !(await this.#allowed()))
      throw new NovaError('policy_denied', 'public profile cards are turned off on this Hub', {
        details: { reason: 'setting_off', setting: 'team.publicProfiles' },
      });
    const taken = this.#db.raw
      .prepare('SELECT account_id FROM profile_card WHERE handle = ? AND account_id <> ?')
      .get(req.handle, accountId);
    if (taken)
      throw new NovaError('conflict', 'this handle is taken', { details: { field: 'handle' } });
    const at = this.#now().toISOString();
    await this.#db.transaction(() =>
      this.#db.raw
        .prepare(
          `INSERT INTO profile_card (account_id, handle, enabled, show_avatar, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (account_id) DO UPDATE SET handle = excluded.handle,
             enabled = excluded.enabled, show_avatar = excluded.show_avatar,
             updated_at = excluded.updated_at`,
        )
        .run(accountId, req.handle, req.enabled ? 1 : 0, req.showAvatar === false ? 0 : 1, at),
    );
    return this.get(accountId);
  }

  /** The public card behind a handle; null unless its person and the Hub both allow it. */
  async publicCard(handle: string): Promise<PublicCard | null> {
    if (!(await this.#allowed())) return null;
    const r = this.#db.raw
      .prepare(
        `SELECT c.account_id, c.handle, c.show_avatar, a.display_name, a.avatar_path
         FROM profile_card c JOIN account a ON a.id = c.account_id
         WHERE c.handle = ? AND c.enabled = 1 AND a.deleted_at IS NULL`,
      )
      .get(handle) as
      | {
          account_id: string;
          handle: string;
          show_avatar: number;
          display_name: string | null;
          avatar_path: string | null;
        }
      | undefined;
    if (!r) return null;
    return {
      accountId: r.account_id,
      handle: r.handle,
      displayName: r.display_name,
      showAvatar: r.show_avatar === 1,
      hasAvatar: r.avatar_path !== null,
    };
  }
}
