// The local account's profile (FR-113): display name, a unique username and an avatar. The
// avatar is stored as a sealed, content-addressed blob (docs/06 §3, FR-149 baseline) with its
// metadata stripped; the database keeps only the blob path. OIDC sign-in is out of scope for M4.
import { and, eq, isNull, ne } from 'drizzle-orm';
import type { z } from 'zod';
import { NovaError, type AccountView, type updateProfileSchema } from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import { readAttachmentBlob, writeAttachmentBlob } from '../attachments.ts';
import type { EventSink } from '../events.ts';
import { removeUnreferencedBlobs } from '../purge.ts';
import { prepareAvatar, sniffImage, type AvatarMime } from './avatar.ts';

const { account } = schema;

export type UpdateProfileRequest = z.infer<typeof updateProfileSchema>;

export interface ProfileServiceOptions {
  db: NovaDatabase;
  /** Where blobs live (docs/06 §3). */
  dataDir: string;
  events?: EventSink;
  now?: () => Date;
}

export interface AvatarImage {
  bytes: Buffer;
  mime: AvatarMime;
}

type AccountRow = typeof account.$inferSelect;

export class ProfileService {
  readonly #db: NovaDatabase;
  readonly #dataDir: string;
  readonly #events: EventSink | undefined;
  readonly #now: () => Date;

  constructor(opts: ProfileServiceOptions) {
    this.#db = opts.db;
    this.#dataDir = opts.dataDir;
    this.#events = opts.events;
    this.#now = opts.now ?? (() => new Date());
  }

  async get(accountId: string): Promise<AccountView> {
    return toView(await this.#row(accountId));
  }

  /**
   * Apply a profile change. A blank display name clears it; a username taken by another
   * account is a `conflict`; an avatar is validated, stripped of metadata and sealed, and the
   * previous one is removed unless something else still uses its blob.
   */
  async update(accountId: string, req: UpdateProfileRequest): Promise<AccountView> {
    const before = await this.#row(accountId);
    const set: Partial<AccountRow> = { updatedAt: this.#now().toISOString() };
    const fields: string[] = [];
    if (req.displayName !== undefined) {
      set.displayName = req.displayName?.trim() || null;
      fields.push('displayName');
    }
    if (req.username !== undefined) {
      if (req.username !== null) await this.#assertUsernameFree(accountId, req.username);
      set.username = req.username;
      fields.push('username');
    }
    if (req.avatar !== undefined) {
      set.avatarPath = req.avatar
        ? writeAttachmentBlob(this.#dataDir, prepareAvatar(req.avatar.mime, req.avatar.data))
            .blobPath
        : null;
      fields.push('avatar');
    }
    try {
      await this.#db.transaction(() =>
        this.#db.orm.update(account).set(set).where(eq(account.id, accountId)),
      );
    } catch (err) {
      if (set.avatarPath && set.avatarPath !== before.avatarPath) this.#dropBlob(set.avatarPath);
      if (err instanceof Error && /UNIQUE/i.test(err.message))
        throw usernameTaken(req.username ?? '');
      throw err;
    }
    const old = before.avatarPath;
    if (req.avatar !== undefined && old && old !== set.avatarPath) this.#dropBlob(old);
    if (fields.length)
      await this.#events?.emit({
        name: 'account.updated',
        actor: 'user',
        accountId,
        payload: { accountId, fields },
      });
    return this.get(accountId);
  }

  /** The avatar image, or null without one (or when its blob is gone). */
  async avatar(accountId: string): Promise<AvatarImage | null> {
    const row = await this.#row(accountId);
    if (!row.avatarPath) return null;
    let bytes: Buffer;
    try {
      bytes = readAttachmentBlob(this.#dataDir, row.avatarPath);
    } catch (err) {
      if (err instanceof NovaError && err.code === 'not_found') return null;
      throw err;
    }
    const mime = sniffImage(bytes);
    return mime ? { bytes, mime } : null;
  }

  async #row(accountId: string): Promise<AccountRow> {
    const rows = await this.#db.orm
      .select()
      .from(account)
      .where(and(eq(account.id, accountId), isNull(account.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NovaError('not_found', 'account not found');
    return row;
  }

  async #assertUsernameFree(accountId: string, username: string): Promise<void> {
    const rows = await this.#db.orm
      .select({ id: account.id })
      .from(account)
      .where(
        and(eq(account.username, username), isNull(account.deletedAt), ne(account.id, accountId)),
      )
      .limit(1);
    if (rows[0]) throw usernameTaken(username);
  }

  /** Remove a replaced avatar blob unless another account or a chat still refers to it. */
  #dropBlob(path: string): void {
    const shared = this.#db.raw
      .prepare('SELECT 1 AS x FROM account WHERE avatar_path = ? LIMIT 1')
      .get(path);
    if (!shared) removeUnreferencedBlobs(this.#db, this.#dataDir, [path]);
  }
}

function usernameTaken(username: string): NovaError {
  return new NovaError('conflict', `the username ${username} is taken`, {
    details: { field: 'username', reason: 'taken' },
  });
}

function toView(r: AccountRow): AccountView {
  return {
    accountId: r.id,
    displayName: r.displayName,
    username: r.username,
    hasAvatar: r.avatarPath !== null,
    createdAt: r.createdAt,
  };
}
