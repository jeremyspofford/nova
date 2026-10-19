// Reading a mailbox for email bindings (FR-110): IMAP through imapflow, always read-only (EXAMINE,
// BODY.PEEK), so Nova never changes the user's mail. New mail is everything past the cursor (the
// folder's UIDVALIDITY and the last UID seen); a binding starts from the mail that arrives after
// it connects, and a changed UIDVALIDITY starts over from the current end instead of replaying the
// folder. `watch` keeps one connection in IDLE and resolves when the server reports new mail.
// Plain connections are allowed only to this machine (`none` on a loopback host), so a password
// never crosses a network in the clear. Every client has an 'error' listener: imapflow reports a
// connection lost while a session starts (or idles) as an 'error' event, and without a listener
// that throws inside its promise chain and escapes as an unhandled rejection, which ends the Hub.
// The failure still reaches the caller (the call in flight rejects, `watch` sees 'close'), and the
// poller backs off and marks the binding.
import { ImapFlow } from 'imapflow';
import { NovaError } from '@nova/shared';

export interface MailServer {
  /** What to connect to: the server's name, or the checked address it was pinned to. */
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  /** The server's name for TLS (SNI and certificate) when `host` is a pinned address. */
  servername?: string;
}

export interface MailboxAccess extends MailServer {
  username: string;
  password: string;
  folder: string;
}

export interface MailCursor {
  uidValidity: string;
  lastUid: number;
}

export interface FetchedMail {
  uid: number;
  source: Buffer;
}

/** The largest message read (larger ones are skipped and reported, never downloaded). */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export interface MailReader {
  /** Mail after the cursor (at most `limit`); a null cursor starts at the folder's end. */
  fetchNew(
    access: MailboxAccess,
    cursor: MailCursor | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    messages: FetchedMail[];
    /** Messages passed over for their size (the cursor moves past them). */
    skipped?: { uid: number; size: number }[];
    cursor: MailCursor;
  }>;
  /** Log in and open the folder (connect, test). */
  check(access: MailboxAccess, signal: AbortSignal): Promise<void>;
  /** Wait (IDLE) until the folder reports new mail or `ms` pass; rejects when the connection fails. */
  watch?(access: MailboxAccess, ms: number, signal: AbortSignal): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/** Whether a plain (unencrypted) connection is allowed: only to this machine. */
export function plainAllowed(server: Pick<MailServer, 'host' | 'security'>): boolean {
  return server.security !== 'none' || LOOPBACK.has(server.host.toLowerCase());
}

export function assertSecure(server: Pick<MailServer, 'host' | 'security'>, what: string): void {
  if (!plainAllowed(server))
    throw new NovaError(
      'validation',
      `${what} without TLS is only allowed on this machine; use tls or starttls`,
      { details: { field: 'config' } },
    );
}

function client(access: MailboxAccess, idle: boolean, onError: (err: unknown) => void): ImapFlow {
  assertSecure(access, 'IMAP');
  const c = new ImapFlow({
    host: access.host,
    ...(access.servername ? { servername: access.servername } : {}),
    port: access.port,
    secure: access.security === 'tls',
    doSTARTTLS:
      access.security === 'starttls' ? true : access.security === 'none' ? false : undefined,
    auth: { user: access.username, pass: access.password },
    logger: false,
    disableAutoIdle: !idle,
    disableCompression: true,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 10 * 60_000,
  });
  c.on('error', onError);
  return c;
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(new NovaError('server_error', 'the mailbox call was cancelled'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

function mailError(err: unknown): NovaError {
  const e = err as { authenticationFailed?: boolean; responseText?: string; message?: string };
  if (e.authenticationFailed)
    return new NovaError('token_required', 'the mailbox refused the login', {
      details: { reason: 'auth_failed' },
    });
  return new NovaError(
    'server_error',
    `the mailbox could not be read: ${(e.responseText ?? e.message ?? 'error').slice(0, 200)}`,
    { retryable: true },
  );
}

export class ImapReader implements MailReader {
  readonly #maxBytes: number;
  readonly #onError: (err: unknown) => void;

  constructor(opts: { maxMessageBytes?: number; onError?: (err: unknown) => void } = {}) {
    this.#maxBytes = opts.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.#onError = opts.onError ?? (() => undefined);
  }

  /** A client whose connection errors are reported, never thrown. */
  #client(access: MailboxAccess, idle: boolean): ImapFlow {
    return client(access, idle, (err) => {
      try {
        this.#onError(err);
      } catch {
        // a reporter must not turn an error into a crash
      }
    });
  }

  async check(access: MailboxAccess, signal: AbortSignal): Promise<void> {
    const c = this.#client(access, false);
    try {
      await Promise.race([
        (async () => {
          await c.connect();
          await c.mailboxOpen(access.folder, { readOnly: true });
        })(),
        aborted(signal),
      ]);
    } catch (err) {
      throw err instanceof NovaError ? err : mailError(err);
    } finally {
      await c.logout().catch(() => c.close());
    }
  }

  async fetchNew(
    access: MailboxAccess,
    cursor: MailCursor | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    messages: FetchedMail[];
    skipped: { uid: number; size: number }[];
    cursor: MailCursor;
  }> {
    const c = this.#client(access, false);
    try {
      return await Promise.race([this.#fetch(c, access, cursor, limit), aborted(signal)]);
    } catch (err) {
      throw err instanceof NovaError ? err : mailError(err);
    } finally {
      await c.logout().catch(() => c.close());
    }
  }

  async #fetch(
    c: ImapFlow,
    access: MailboxAccess,
    cursor: MailCursor | null,
    limit: number,
  ): Promise<{
    messages: FetchedMail[];
    skipped: { uid: number; size: number }[];
    cursor: MailCursor;
  }> {
    await c.connect();
    const box = await c.mailboxOpen(access.folder, { readOnly: true });
    const validity = String(box.uidValidity);
    const end = Math.max(0, Number(box.uidNext ?? 1) - 1);
    // A new binding, or a folder whose UIDs were reset: start from what arrives next.
    if (!cursor || cursor.uidValidity !== validity)
      return { messages: [], skipped: [], cursor: { uidValidity: validity, lastUid: end } };
    if (end <= cursor.lastUid || !box.exists) return { messages: [], skipped: [], cursor };
    // First UIDs and sizes only; then the sources of what this round keeps: at most `limit`
    // messages, none larger than the cap (those are passed over and reported).
    const listed: { uid: number; size: number }[] = [];
    for await (const m of c.fetch(
      `${cursor.lastUid + 1}:*`,
      { uid: true, size: true },
      { uid: true },
    )) {
      // `n:*` also returns the newest message when n is past it; keep only new UIDs.
      if (m.uid > cursor.lastUid) listed.push({ uid: m.uid, size: m.size ?? 0 });
    }
    listed.sort((a, b) => a.uid - b.uid);
    const kept = listed.slice(0, limit);
    const last = kept.at(-1)?.uid;
    if (last === undefined) return { messages: [], skipped: [], cursor };
    const skipped = kept.filter((k) => k.size > this.#maxBytes);
    const wanted = new Set(kept.filter((k) => k.size <= this.#maxBytes).map((k) => k.uid));
    const messages: FetchedMail[] = [];
    if (wanted.size)
      for await (const m of c.fetch(
        [...wanted].join(','),
        { uid: true, source: true },
        { uid: true },
      )) {
        if (!wanted.has(m.uid) || !m.source) continue;
        wanted.delete(m.uid);
        // A server that understated the size still cannot hand over more than the cap.
        if (m.source.length > this.#maxBytes) {
          skipped.push({ uid: m.uid, size: m.source.length });
          continue;
        }
        messages.push({ uid: m.uid, source: Buffer.from(m.source) });
      }
    messages.sort((a, b) => a.uid - b.uid);
    return { messages, skipped, cursor: { uidValidity: validity, lastUid: last } };
  }

  async watch(access: MailboxAccess, ms: number, signal: AbortSignal): Promise<void> {
    const c = this.#client(access, true);
    try {
      await Promise.race([
        (async () => {
          await c.connect();
          await c.mailboxOpen(access.folder, { readOnly: true });
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, ms);
            t.unref();
            // Enter IDLE now (not after imapflow's auto-idle delay): EXISTS ends the wait.
            c.idle().catch(() => undefined);
            c.once('exists', () => {
              clearTimeout(t);
              resolve();
            });
            c.once('close', () => {
              clearTimeout(t);
              reject(new NovaError('server_error', 'the mailbox connection closed'));
            });
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(t);
                resolve();
              },
              { once: true },
            );
          });
        })(),
        aborted(signal).catch(() => undefined),
      ]);
    } catch (err) {
      throw err instanceof NovaError ? err : mailError(err);
    } finally {
      await c.logout().catch(() => c.close());
    }
  }
}
