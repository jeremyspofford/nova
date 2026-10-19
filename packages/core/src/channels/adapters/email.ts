// Email adapter (FR-110, docs/13 §4): a mailbox read over IMAP (polling, or IDLE) and replies sent
// over SMTP. A binding is one correspondent of a mailbox (`externalRef` their address, or a list's
// address); bindings of one mailbox share its password (`shareCredentialsWith`). Replies thread by
// Message-ID, In-Reply-To and References under the original subject, carry Auto-Submitted (RFC
// 3834) so auto-responders stay quiet, and are recognised as ours if they come back. Approvals
// sent by email are answered only through the signed one-use link in them, never by reply text
// (a From address is easy to forge). The password lives in the secret store; the mailbox needs
// TLS unless the server runs on this machine.
// M8: a mailbox may sign in with OAuth instead (`config.auth: oauth`): IMAP and SMTP use SASL
// XOAUTH2 with an access token from the Hub's `ChannelOAuth`, refreshed before it expires; a
// server that refuses the token gets one forced refresh and one more try. The password path is
// unchanged.
import { NovaError, uuidv7 } from '@nova/shared';
import type { Logger } from '@nova/telemetry';
import { createTransport } from 'nodemailer';
import type { ChannelReceipt } from '../types.ts';
import {
  notConfigured,
  sendFailed,
  type AdapterProbe,
  type BindingCredentials,
  type NovaChannelAdapter,
  type NovaInboundMessage,
  type NovaOutboundMessage,
} from './common.ts';
import {
  ImapReader,
  assertSecure,
  type FetchedMail,
  type MailCursor,
  type MailReader,
  type MailboxAccess,
  type MailServer,
} from './mail/imap.ts';
import { NOVA_MAIL_HEADER, parseMail } from './mail/parse.ts';

/** M8: where an OAuth mailbox's access token comes from (the Hub's `ChannelOAuth`). */
export interface MailOAuthTokens {
  accessToken(bindingId: string, opts?: { force?: boolean }): Promise<string>;
}

export interface EmailAdapterOptions {
  credentials: BindingCredentials;
  /** M8: OAuth sign-in; without it a binding set to `auth: oauth` cannot connect. */
  oauth?: MailOAuthTokens;
  /** The IMAP side (tests may swap it; the default is imapflow). */
  reader?: MailReader;
  now?: () => Date;
  /** How long an SMTP send may take. */
  timeoutMs?: number;
  /**
   * The checked address to connect to for a binding's server, or null to connect by name. The
   * Hub pins a non-owner's mailbox servers to public addresses (decision 5); it throws for a
   * private or local one.
   */
  pinHost?: (bindingId: string, host: string) => Promise<string | null>;
  /** Where connection errors are reported (they never throw; the call in flight fails). */
  log?: Logger;
}

const DEFAULT_PORTS = {
  imap: { tls: 993, starttls: 143, none: 143 },
  smtp: { tls: 465, starttls: 587, none: 25 },
};

type Security = MailServer['security'];

/** How SMTP signs in: a password, or (M8) XOAUTH2 with a token the Hub provides. */
type SmtpAuth =
  | { user: string; pass: string }
  | {
      type: 'OAuth2';
      user: string;
      accessToken: string;
      provisionCallback: (
        user: string,
        renew: boolean,
        cb: (err: Error | null, token?: string) => void,
      ) => void;
    };

/** The mailbox refused the login (imapflow's authentication failure, mapped by `mailError`). */
function loginRefused(err: unknown): boolean {
  return (
    err instanceof NovaError &&
    err.code === 'token_required' &&
    (err.details as { reason?: unknown } | undefined)?.reason === 'auth_failed'
  );
}

interface MailConfig {
  address: string;
  username: string;
  imap: MailServer;
  smtp: MailServer;
  folder: string;
  mode: 'idle' | 'polling';
  senderCheck: 'dmarc' | 'none';
  /** The receiving server's authserv-id (RFC 8601); null: derived from the IMAP host's name. */
  authservId: string | null;
  /** The IMAP server's configured name (not a pinned address). */
  imapName: string;
  /** M8: how the mailbox signs in. */
  auth: 'password' | 'oauth';
}

function security(v: string | null | undefined, fallback: Security): Security {
  return v === 'tls' || v === 'starttls' || v === 'none' ? v : fallback;
}

export class EmailAdapter implements NovaChannelAdapter {
  readonly kind = 'email' as const;
  readonly credentialNames = ['password', 'oauthClientSecret'] as const;
  readonly configKeys = [
    'address',
    'username',
    'imapHost',
    'imapPort',
    'imapSecurity',
    'smtpHost',
    'smtpPort',
    'smtpSecurity',
    'folder',
    'mode',
    'senderCheck',
    'authservId',
    'auth',
    'oauthAuthUrl',
    'oauthTokenUrl',
    'oauthRevokeUrl',
    'oauthClientId',
    'oauthScopes',
  ] as const;
  /** Approvals are answered by the signed link only. */
  readonly textAnswers = false;
  readonly #creds: BindingCredentials;
  readonly #reader: MailReader;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #pinHost: EmailAdapterOptions['pinHost'];
  readonly #log: Logger | undefined;
  readonly #oauth: MailOAuthTokens | undefined;

  constructor(opts: EmailAdapterOptions) {
    this.#creds = opts.credentials;
    this.#oauth = opts.oauth;
    const log = opts.log;
    this.#log = log;
    this.#reader =
      opts.reader ??
      new ImapReader({ onError: (err) => log?.warn('mailbox connection error', { err }) });
    this.#now = opts.now ?? (() => new Date());
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#pinHost = opts.pinHost;
  }

  /** The server to connect to: pinned to its checked address when the Hub asks for that. */
  async #pinned(bindingId: string, server: MailServer): Promise<MailServer> {
    const address = this.#pinHost ? await this.#pinHost(bindingId, server.host) : null;
    return address ? { ...server, host: address, servername: server.host } : server;
  }

  /** A password mailbox needs its password; an OAuth one may have a client secret (M8). */
  credentialsFor(config: Record<string, string | null>) {
    return config.auth === 'oauth'
      ? [{ name: 'oauthClientSecret', required: false }]
      : [{ name: 'password', required: true }];
  }

  parse(): Promise<NovaInboundMessage | null> {
    // Mail is read from the mailbox, never posted to the Hub.
    return Promise.reject(new NovaError('not_found', 'email arrives through its mailbox'));
  }

  async #config(bindingId: string): Promise<MailConfig> {
    const c = await this.#creds.config(bindingId);
    const address = c.address?.toLowerCase() ?? null;
    if (!address || !c.imapHost || !c.smtpHost) throw notConfigured('the mailbox of this binding');
    const imapSecurity = security(c.imapSecurity, 'tls');
    const smtpSecurity = security(c.smtpSecurity, 'tls');
    return {
      address,
      username: c.username ?? address,
      imap: await this.#pinned(bindingId, {
        host: c.imapHost,
        port: Number(c.imapPort ?? DEFAULT_PORTS.imap[imapSecurity]),
        security: imapSecurity,
      }),
      smtp: await this.#pinned(bindingId, {
        host: c.smtpHost,
        port: Number(c.smtpPort ?? DEFAULT_PORTS.smtp[smtpSecurity]),
        security: smtpSecurity,
      }),
      folder: c.folder ?? 'INBOX',
      mode: c.mode === 'polling' ? 'polling' : 'idle',
      senderCheck: c.senderCheck === 'none' ? 'none' : 'dmarc',
      authservId: c.authservId?.trim().toLowerCase() || null,
      imapName: c.imapHost,
      auth: c.auth === 'oauth' ? 'oauth' : 'password',
    };
  }

  async #password(bindingId: string): Promise<string> {
    const p = await this.#creds.secret(bindingId, 'password');
    if (!p) throw notConfigured('the mailbox password');
    return p;
  }

  async #token(bindingId: string, force: boolean): Promise<string> {
    if (!this.#oauth) throw notConfigured('OAuth sign-in for mailboxes');
    return this.#oauth.accessToken(bindingId, { force });
  }

  async #accessOf(bindingId: string, c: MailConfig, force: boolean): Promise<MailboxAccess> {
    const base = { ...c.imap, username: c.username, folder: c.folder };
    return c.auth === 'oauth'
      ? { ...base, password: '', accessToken: await this.#token(bindingId, force) }
      : { ...base, password: await this.#password(bindingId) };
  }

  async access(bindingId: string): Promise<MailboxAccess> {
    return this.#accessOf(bindingId, await this.#config(bindingId), false);
  }

  /**
   * Run an IMAP call; an OAuth mailbox whose server refused the token gets a forced refresh and
   * one more try (the token may have been revoked or rotated early).
   */
  async #withAccess<T>(bindingId: string, fn: (access: MailboxAccess) => Promise<T>): Promise<T> {
    const c = await this.#config(bindingId);
    try {
      return await fn(await this.#accessOf(bindingId, c, false));
    } catch (err) {
      if (c.auth !== 'oauth' || !loginRefused(err)) throw err;
      return fn(await this.#accessOf(bindingId, c, true));
    }
  }

  /** Whether the binding's mailbox is watched by IDLE (default) or polled. */
  async mode(bindingId: string): Promise<'idle' | 'polling'> {
    return (await this.#config(bindingId)).mode;
  }

  /** New mail after the cursor. */
  async read(
    bindingId: string,
    cursor: MailCursor | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    messages: FetchedMail[];
    skipped?: { uid: number; size: number }[];
    cursor: MailCursor;
  }> {
    return this.#withAccess(bindingId, (a) => this.#reader.fetchNew(a, cursor, limit, signal));
  }

  /** Wait for new mail (IDLE) up to `ms`. */
  async watch(bindingId: string, ms: number, signal: AbortSignal): Promise<void> {
    if (!this.#reader.watch) {
      await new Promise((r) => setTimeout(r, Math.min(ms, 1_000)).unref());
      return;
    }
    const watch = this.#reader.watch.bind(this.#reader);
    await this.#withAccess(bindingId, (a) => watch(a, ms, signal));
  }

  /** One fetched message as an inbound message, or null when it must not start anything. */
  async parseRaw(bindingId: string, source: Buffer): Promise<NovaInboundMessage | null> {
    const c = await this.#config(bindingId);
    return parseMail(source, {
      address: c.address,
      senderCheck: c.senderCheck,
      authservId: c.authservId,
      imapHost: c.imapName,
      receivedAt: this.#now().toISOString(),
    });
  }

  /** SMTP sign-in: the password, or (M8) XOAUTH2 with a token nodemailer asks the Hub for. */
  async #smtpAuth(bindingId: string, c: MailConfig): Promise<SmtpAuth> {
    if (c.auth !== 'oauth') return { user: c.username, pass: await this.#password(bindingId) };
    const accessToken = await this.#token(bindingId, false);
    return {
      type: 'OAuth2',
      user: c.username,
      accessToken,
      // A refused token is renewed once (`renew`), never fetched by nodemailer itself.
      provisionCallback: (
        _user: string,
        renew: boolean,
        cb: (err: Error | null, token?: string) => void,
      ) => {
        this.#token(bindingId, renew).then(
          (t) => cb(null, t),
          (err: unknown) => cb(err instanceof Error ? err : new Error(String(err))),
        );
      },
    };
  }

  #transport(c: MailConfig, auth: SmtpAuth) {
    assertSecure(c.smtp, 'SMTP');
    const transport = createTransport({
      host: c.smtp.host,
      port: c.smtp.port,
      secure: c.smtp.security === 'tls',
      requireTLS: c.smtp.security === 'starttls',
      ignoreTLS: c.smtp.security === 'none',
      auth,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: this.#timeoutMs,
      tls: {
        minVersion: 'TLSv1.2',
        ...(c.smtp.servername ? { servername: c.smtp.servername } : {}),
      },
    });
    // A transport is an event emitter too: an 'error' with no listener would throw.
    transport.on('error', (err: unknown) => this.#log?.warn('mail transport error', { err }));
    return transport;
  }

  async send(
    bindingId: string,
    message: NovaOutboundMessage,
    signal: AbortSignal,
  ): Promise<ChannelReceipt> {
    const c = await this.#config(bindingId);
    const auth = await this.#smtpAuth(bindingId, c);
    const domain = c.address.split('@')[1] ?? 'nova.invalid';
    const id = `${uuidv7()}@${domain}`;
    const base = message.subject?.trim() || 'Nova';
    const replying = !!message.inReplyTo;
    const subject = replying && !/^re:/i.test(base) ? `Re: ${base}` : base;
    const references = [message.threadRef, message.inReplyTo]
      .filter((r): r is string => !!r)
      .filter((r, i, all) => all.indexOf(r) === i)
      .map((r) => `<${r}>`);
    let text = message.text;
    if (message.approval?.link)
      text +=
        `\n\nTo answer, open this link (it works once): ${message.approval.link}\n` +
        'Replying to this email does not answer the approval.';
    const transport = this.#transport(c, auth);
    try {
      await Promise.race([
        transport.sendMail({
          from: c.address,
          to: message.conversation,
          subject,
          text,
          messageId: `<${id}>`,
          ...(message.inReplyTo ? { inReplyTo: `<${message.inReplyTo}>` } : {}),
          ...(references.length ? { references } : {}),
          headers: { 'Auto-Submitted': 'auto-replied', [NOVA_MAIL_HEADER]: '1' },
        }),
        new Promise((_r, reject) =>
          signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true }),
        ),
      ]);
    } catch (err) {
      throw sendFailed('the email', err instanceof Error ? err.message.slice(0, 200) : 'error');
    } finally {
      transport.close();
    }
    return { id, at: this.#now().toISOString() };
  }

  /** Log in to both sides: IMAP opens the folder, SMTP authenticates. */
  async probe(bindingId: string, signal: AbortSignal): Promise<AdapterProbe> {
    try {
      const c = await this.#config(bindingId);
      await this.#withAccess(bindingId, (a) => this.#reader.check(a, signal));
      const transport = this.#transport(c, await this.#smtpAuth(bindingId, c));
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
      const how = c.auth === 'oauth' ? `${c.mode}, OAuth` : c.mode;
      return { ok: true, detail: `reading ${c.folder} of ${c.address} (${how})` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    }
  }
}
