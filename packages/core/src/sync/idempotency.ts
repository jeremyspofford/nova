// Idempotent writes (FR-112, ADR-095 decision 2). A client that queues mutating requests while
// offline sends each with an `Idempotency-Key`; when it retries, the Hub answers a repeated key
// from the same principal with the first answer (status and body) for 24 hours instead of doing it
// again. The same key with a different body is refused, and so is a repeat while the first request
// still runs. Only answers the Hub may repeat are kept (the caller decides per route; replay is
// opt-in). Whatever the caller says, an answer that carries a credential (a Nova token, a key-like
// string, a field named like a token or secret), or is larger than 256 KiB, is never written: its
// key is remembered, so a repeat is refused rather than replayed or redone. Secrets never reach
// the database (docs/12).
import { createHash } from 'node:crypto';
import { DEFAULT_RULES } from '@nova/security';
import type { NovaDatabase } from '@nova/storage';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A first request that has not answered after this long is taken as lost (a crash). */
export const IDEMPOTENCY_IN_FLIGHT_MS = 5 * 60 * 1000;
export const IDEMPOTENCY_MAX_RESPONSE_BYTES = 256 * 1024;
/** 1-200 visible ASCII characters (decision 2). */
export const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

// Shapes that are credentials by themselves (the redactor's token rules) and every Nova token
// (`nvx_`, `nvd_`, `nve_`, `nvm_`, `nvc_`, `nvr_`, ...).
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\bnv[a-z]_[A-Za-z0-9_-]{20,}/,
  ...DEFAULT_RULES.filter((r) => r.scan === 'token').map(
    (r) => new RegExp(r.pattern.source, r.pattern.flags.replace('g', '')),
  ),
];
// JSON keys that name a credential (`token`, `enrollToken`, `clientSecret`, `privateKey`, a grant).
const CREDENTIAL_KEY =
  /(?:token|secret|password|passwd|credentials?|private_?key|api_?key|cookie)$|^grant$/i;

/**
 * Whether a response body carries a credential: a token-shaped string anywhere, or a non-empty
 * value under a key named like one. Errs towards yes: a false positive only costs a replay.
 */
export function carriesCredential(body: string): boolean {
  if (CREDENTIAL_SHAPES.some((re) => re.test(body))) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return false;
  }
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > 20 || v === null || typeof v !== 'object') return false;
    if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const filled = (typeof x === 'string' && x !== '') || (typeof x === 'object' && x !== null);
      if (filled && CREDENTIAL_KEY.test(k)) return true;
      if (walk(x, depth + 1)) return true;
    }
    return false;
  };
  return walk(parsed, 0);
}

export interface IdempotencyRef {
  /** `device:<id>` for a device session, else `token:<id>`. */
  principal: string;
  key: string;
  method: string;
  path: string;
}

export type IdempotencyStart =
  | { kind: 'proceed' }
  | { kind: 'replay'; status: number; body: string; contentType: string | null }
  | {
      kind: 'refuse';
      reason: 'idempotency_key_reused' | 'idempotency_in_flight' | 'idempotency_not_replayable';
    };

export interface IdempotencyStoreOptions {
  db: NovaDatabase;
  now?: () => Date;
  ttlMs?: number;
}

interface Row {
  body_hash: string;
  status: number | null;
  response: string | null;
  content_type: string | null;
  replayable: number;
  created_at: string;
  expires_at: string;
}

/** Hex SHA-256 of a parsed request body (the same bytes parse to the same JSON). */
export function hashRequestBody(body: unknown): string {
  const h = createHash('sha256');
  if (Buffer.isBuffer(body)) h.update(body);
  else h.update(JSON.stringify(body ?? null) ?? 'null');
  return h.digest('hex');
}

export class IdempotencyStore {
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(opts: IdempotencyStoreOptions) {
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
    this.#ttlMs = opts.ttlMs ?? IDEMPOTENCY_TTL_MS;
  }

  /** Claim the key for a new request, or say how to answer a repeat. */
  begin(
    ref: IdempotencyRef,
    bodyHash: string,
    accountId: string | null,
  ): Promise<IdempotencyStart> {
    return this.#db.transaction((): IdempotencyStart => {
      const now = this.#now();
      const nowIso = now.toISOString();
      let row = this.#row(ref);
      const lost =
        row?.status === null &&
        Date.parse(row.created_at) + IDEMPOTENCY_IN_FLIGHT_MS <= now.getTime();
      if (row && (row.expires_at <= nowIso || lost)) {
        this.#delete(ref);
        row = undefined;
      }
      if (!row) {
        this.#db.raw
          .prepare(
            `INSERT INTO idempotency_key (principal, key, method, path, account_id, body_hash,
               created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ref.principal,
            ref.key,
            ref.method,
            ref.path,
            accountId,
            bodyHash,
            nowIso,
            new Date(now.getTime() + this.#ttlMs).toISOString(),
          );
        return { kind: 'proceed' };
      }
      if (row.body_hash !== bodyHash) return { kind: 'refuse', reason: 'idempotency_key_reused' };
      if (row.status === null) return { kind: 'refuse', reason: 'idempotency_in_flight' };
      if (!row.replayable || row.response === null)
        return { kind: 'refuse', reason: 'idempotency_not_replayable' };
      return {
        kind: 'replay',
        status: row.status,
        body: row.response,
        contentType: row.content_type,
      };
    });
  }

  /**
   * Keep the first answer: its status always, its body only when the caller passes one (`null`:
   * not replayable) and it is small and carries no credential.
   */
  complete(
    ref: IdempotencyRef,
    res: { status: number; body: string | null; contentType: string | null },
  ): Promise<void> {
    const replayable =
      res.body !== null &&
      Buffer.byteLength(res.body, 'utf8') <= IDEMPOTENCY_MAX_RESPONSE_BYTES &&
      !carriesCredential(res.body);
    return this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `UPDATE idempotency_key SET status = ?, response = ?, content_type = ?, replayable = ?
           WHERE principal = ? AND key = ? AND method = ? AND path = ?`,
        )
        .run(
          res.status,
          replayable ? res.body : null,
          res.contentType,
          replayable ? 1 : 0,
          ref.principal,
          ref.key,
          ref.method,
          ref.path,
        );
    });
  }

  /** Forget a key whose request failed in a way worth retrying (5xx, 429, a lost connection). */
  abandon(ref: IdempotencyRef): Promise<void> {
    return this.#db.transaction(() => {
      this.#delete(ref);
    });
  }

  /** Remove expired keys; returns how many went. */
  sweep(): Promise<number> {
    return this.#db.transaction(() => {
      const r = this.#db.raw
        .prepare('DELETE FROM idempotency_key WHERE expires_at <= ?')
        .run(this.#now().toISOString());
      return Number(r.changes);
    });
  }

  #row(ref: IdempotencyRef): Row | undefined {
    return this.#db.raw
      .prepare(
        `SELECT body_hash, status, response, content_type, replayable, created_at, expires_at
         FROM idempotency_key WHERE principal = ? AND key = ? AND method = ? AND path = ?`,
      )
      .get(ref.principal, ref.key, ref.method, ref.path) as Row | undefined;
  }

  #delete(ref: IdempotencyRef): void {
    this.#db.raw
      .prepare(
        'DELETE FROM idempotency_key WHERE principal = ? AND key = ? AND method = ? AND path = ?',
      )
      .run(ref.principal, ref.key, ref.method, ref.path);
  }
}
