// Network boot from the Hub (FR-143, docs/23 §5.2, ADR-096 D5). A device gets a boot token
// (`nvb_…`, shown once, only its hash kept, rotatable and revocable); iPXE fetches a menu of the
// images the owner placed in `<dataDir>/boot-images` and chains to the one picked. Nova runs no
// DHCP or TFTP: the owner points a DHCP server's next-server/filename (or an iPXE build's embedded
// script) at `/boot/ipxe/<token>`. Image names are plain file names directly in that folder (no
// paths, no `..`, no symbolic links), so a request can never leave it.
import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  NovaError,
  PXE_TOKEN_PREFIX,
  bootImageNameSchema,
  pxeTokenSchema,
  uuidv7,
  type BootImageView,
  type PxeTokenCreatedView,
  type PxeTokenView,
} from '@nova/shared';
import type { NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import type { EventSink } from '../events.ts';
import type { AuditSink } from '../tools/types.ts';
import type { BootDeviceLink } from './service.ts';

type SqlValue = string | number | null;

/** The hash a boot token is kept as: its own domain, so it never matches another secret's. */
export function pxeTokenHash(token: string): string {
  return createHash('sha256').update(`nova-pxe-token\0${token}`, 'utf8').digest('hex');
}

/** A Hub base URL safe to write into an iPXE script: scheme, host and port only. */
const BASE_URL = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * The iPXE menu script for one device's token: one item per image, the local disk by default
 * after 30 s. Image names are validated file names and the token is base64url, so nothing in the
 * script can expand (`${…}`) or break a line.
 */
export function ipxeScript(input: { hubUrl: string; token: string; images: string[] }): string {
  const base = input.hubUrl.replace(/\/+$/, '');
  if (!BASE_URL.test(base)) throw new NovaError('validation', 'not a plain Hub base URL');
  if (!pxeTokenSchema.safeParse(input.token).success)
    throw new NovaError('validation', 'not a boot token');
  const images = input.images.filter((n) => bootImageNameSchema.safeParse(n).success);
  if (!images.length) {
    return [
      '#!ipxe',
      '# Nova network boot (FR-143).',
      "echo No boot images on the Hub yet: put them in the Hub's boot-images folder.",
      'sleep 5',
      'exit',
      '',
    ].join('\n');
  }
  const lines = [
    '#!ipxe',
    '# Nova network boot menu (FR-143), for the device this boot token belongs to.',
    ':menu',
    'menu Nova boot images',
    'item --gap -- Images on the Hub',
  ];
  images.forEach((name, i) => lines.push(`item img${i + 1} ${name}`));
  lines.push(
    'item --gap --',
    'item local Boot from the local disk',
    'choose --default local --timeout 30000 target && goto ${target} || goto local',
  );
  images.forEach((name, i) =>
    lines.push(
      `:img${i + 1}`,
      `chain --autofree ${base}/boot/images/${input.token}/${name} || goto failed`,
    ),
  );
  lines.push(
    ':failed',
    'echo Booting the image failed.',
    'prompt --timeout 5000 Press a key to return to the menu || goto menu',
    'goto menu',
    ':local',
    'exit',
    '',
  );
  return lines.join('\n');
}

interface TokenRow {
  id: string;
  account_id: string;
  device_id: string;
  token_hash: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

/** Whose token a fetch presented. */
export interface PxeHolder {
  tokenId: string;
  accountId: string;
  deviceId: string;
}

/** An image to send: a regular file directly in the images folder. */
export interface PxeImageFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface PxeServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  devices: Pick<BootDeviceLink, 'device'>;
  /** `<dataDir>/boot-images`; it may not exist (no images then). */
  imagesDir: string;
  log?: Logger;
  audit?: AuditSink;
  now?: () => Date;
}

export class PxeService {
  readonly imagesDir: string;
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #devices: Pick<BootDeviceLink, 'device'>;
  readonly #log: Logger;
  readonly #now: () => Date;
  #audit: AuditSink | null;

  constructor(opts: PxeServiceOptions) {
    this.imagesDir = opts.imagesDir;
    this.#db = opts.db;
    this.#events = opts.events;
    this.#devices = opts.devices;
    this.#log = opts.log ?? new Logger({ module: 'core.pxe', sinks: [] });
    this.#audit = opts.audit ?? null;
    this.#now = opts.now ?? (() => new Date());
  }

  useAudit(audit: AuditSink): void {
    this.#audit = audit;
  }

  // ---- the owner's side ------------------------------------------------------------------------

  async tokenView(accountId: string, deviceId: string): Promise<PxeTokenView> {
    const d = await this.#devices.device(accountId, deviceId);
    return tokenView(d.id, this.#active(d.id));
  }

  /** A new boot token for the device, replacing the one it had; the value is returned once. */
  async createToken(
    accountId: string,
    deviceId: string,
    hubUrl: string,
  ): Promise<PxeTokenCreatedView> {
    const d = await this.#devices.device(accountId, deviceId);
    if (d.status === 'revoked')
      throw new NovaError('conflict', 'the device is revoked', { details: { reason: 'revoked' } });
    const token = `${PXE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const before = this.#active(d.id);
    const now = this.#iso();
    const id = uuidv7();
    await this.#db.transaction(() => {
      this.#run(
        'UPDATE pxe_token SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
        now,
        d.id,
      );
      this.#run(
        `INSERT INTO pxe_token (id, account_id, device_id, token_hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        accountId,
        d.id,
        pxeTokenHash(token),
        now,
      );
    });
    const status = before ? 'rotated' : 'created';
    await this.#emit(accountId, d.id, status, 'user');
    await this.#auditAppend(accountId, 'device.boot.pxe.token', d.id, {
      action: status,
      before: before ? { tokenId: before.id, createdAt: before.created_at } : null,
      after: { tokenId: id, createdAt: now },
    });
    const view = tokenView(d.id, this.#active(d.id));
    return { ...view, token, scriptUrl: `${hubUrl.replace(/\/+$/, '')}/boot/ipxe/${token}` };
  }

  async revokeToken(accountId: string, deviceId: string): Promise<PxeTokenView> {
    const d = await this.#devices.device(accountId, deviceId);
    const before = this.#active(d.id);
    if (before) {
      await this.#db.transaction(() => {
        this.#run('UPDATE pxe_token SET revoked_at = ? WHERE id = ?', this.#iso(), before.id);
      });
      await this.#emit(accountId, d.id, 'revoked', 'user');
      await this.#auditAppend(accountId, 'device.boot.pxe.token', d.id, {
        action: 'revoked',
        before: { tokenId: before.id, createdAt: before.created_at },
        after: null,
      });
    }
    return tokenView(d.id, null);
  }

  /** A revoked device's boot token stops working at once. */
  async onDeviceRevoked(accountId: string, deviceId: string): Promise<void> {
    const n = await this.#db.transaction(() =>
      this.#run(
        'UPDATE pxe_token SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL',
        this.#iso(),
        deviceId,
      ),
    );
    if (n) await this.#emit(accountId, deviceId, 'revoked', 'system');
  }

  /** The images the menu offers: valid names, regular files, directly in the folder. */
  images(): BootImageView[] {
    const dir = this.#dir();
    if (!dir) return [];
    const out: BootImageView[] = [];
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      // A Dirent does not follow symbolic links: a link is never offered.
      if (!ent.isFile() || !bootImageNameSchema.safeParse(ent.name).success) continue;
      const file = this.#file(dir, ent.name);
      if (file) out.push({ name: ent.name, size: file.size, modifiedAt: file.modifiedAt });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // ---- the public routes ------------------------------------------------------------------------

  /** Who holds this token, or null (unknown, revoked, or its device revoked). */
  holder(token: string): PxeHolder | null {
    if (!pxeTokenSchema.safeParse(token).success) return null;
    const row = this.#get<TokenRow & { device_status: string }>(
      `SELECT t.*, d.status AS device_status FROM pxe_token t JOIN device d ON d.id = t.device_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
      pxeTokenHash(token),
    );
    if (!row || row.device_status === 'revoked') return null;
    return { tokenId: row.id, accountId: row.account_id, deviceId: row.device_id };
  }

  /** The iPXE menu for a token, or null; audited per fetch. */
  async script(token: string, hubUrl: string, from: string): Promise<string | null> {
    const holder = this.holder(token);
    if (!holder) return null;
    const images = this.images().map((i) => i.name);
    const script = ipxeScript({ hubUrl, token, images });
    await this.#used(holder);
    await this.#auditAppend(
      holder.accountId,
      'device.boot.pxe.script',
      holder.deviceId,
      { from, images: images.length },
      'system',
    );
    return script;
  }

  /**
   * An image for a token, or null (unknown token, bad name, missing file); audited per fetch with
   * the byte range asked for.
   */
  async image(
    token: string,
    name: string,
    from: string,
    range: string | null,
  ): Promise<PxeImageFile | null> {
    const holder = this.holder(token);
    if (!holder) return null;
    const dir = this.#dir();
    if (!dir || !bootImageNameSchema.safeParse(name).success) return null;
    const file = this.#file(dir, name);
    if (!file) return null;
    await this.#used(holder);
    await this.#auditAppend(
      holder.accountId,
      'device.boot.pxe.image',
      holder.deviceId,
      { from, name, size: file.size, range },
      'system',
    );
    return file;
  }

  // ---- internals -------------------------------------------------------------------------------

  #dir(): string | null {
    try {
      return realpathSync(this.imagesDir);
    } catch {
      return null;
    }
  }

  /** A regular file (never a link, folder or device node) named directly in `dir`. */
  #file(dir: string, name: string): PxeImageFile | null {
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isFile()) return null;
      return { path, size: st.size, modifiedAt: st.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  #active(deviceId: string): TokenRow | null {
    return (
      this.#get<TokenRow>(
        'SELECT * FROM pxe_token WHERE device_id = ? AND revoked_at IS NULL',
        deviceId,
      ) ?? null
    );
  }

  async #used(holder: PxeHolder): Promise<void> {
    await this.#db.transaction(() => {
      this.#run('UPDATE pxe_token SET last_used_at = ? WHERE id = ?', this.#iso(), holder.tokenId);
    });
  }

  async #emit(
    accountId: string,
    deviceId: string,
    status: 'created' | 'rotated' | 'revoked',
    actor: 'user' | 'system',
  ): Promise<void> {
    await this.#events.emit({
      name: 'device.boot.changed',
      accountId,
      actor,
      payload: { deviceId, kind: 'pxe_token', status },
    });
  }

  async #auditAppend(
    accountId: string,
    action: string,
    deviceId: string,
    detail: Record<string, unknown>,
    actor = 'user',
  ): Promise<void> {
    if (!this.#audit) return;
    try {
      await this.#audit.append({
        accountId,
        actor,
        kind: 'device',
        action,
        resource: deviceId,
        detail,
      });
    } catch (err) {
      this.#log.warn('pxe audit failed', { err, action });
    }
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  #get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#db.raw.prepare(sql).get(...params) as unknown as T | undefined;
  }

  #run(sql: string, ...params: SqlValue[]): number {
    return Number(this.#db.raw.prepare(sql).run(...params).changes);
  }
}

function tokenView(deviceId: string, row: TokenRow | null): PxeTokenView {
  return {
    deviceId,
    active: row !== null,
    createdAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
  };
}
