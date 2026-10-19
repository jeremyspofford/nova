// Email adapter (FR-110, docs/13 §4): a mailbox read over IMAP (polling, or IDLE) and replies sent
// over SMTP. A binding is one correspondent of a mailbox (`externalRef` their address, or a list's
// address); bindings of one mailbox share its password (`shareCredentialsWith`). Replies thread by
// Message-ID, In-Reply-To and References under the original subject, carry Auto-Submitted (RFC
// 3834) so auto-responders stay quiet, and are recognised as ours if they come back. Approvals
// sent by email are answered only through the signed one-use link in them, never by reply text
// (a From address is easy to forge). The password lives in the secret store; the mailbox needs
// TLS unless the server runs on this machine.
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

export interface EmailAdapterOptions {
  credentials: BindingCredentials;
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
}

function security(v: string | null | undefined, fallback: Security): Security {
  return v === 'tls' || v === 'starttls' || v === 'none' ? v : fallback;
}

export class EmailAdapter implements NovaChannelAdapter {
  readonly kind = 'email' as const;
  readonly credentialNames = ['password'] as const;
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
  ] as const;
  /** Approvals are answered by the signed link only. */
  readonly textAnswers = false;
  readonly #creds: BindingCredentials;
  readonly #reader: MailReader;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #pinHost: EmailAdapterOptions['pinHost'];
  readonly #log: Logger | undefined;

  constructor(opts: EmailAdapterOptions) {
    this.#creds = opts.credentials;
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
    };
  }

  async #password(bindingId: string): Promise<string> {
    const p = await this.#creds.secret(bindingId, 'password');
    if (!p) throw notConfigured('the mailbox password');
    return p;
  }

  async access(bindingId: string): Promise<MailboxAccess> {
    const c = await this.#config(bindingId);
    return {
      ...c.imap,
      username: c.username,
      password: await this.#password(bindingId),
      folder: c.folder,
    };
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
    return this.#reader.fetchNew(await this.access(bindingId), cursor, limit, signal);
  }

  /** Wait for new mail (IDLE) up to `ms`. */
  async watch(bindingId: string, ms: number, signal: AbortSignal): Promise<void> {
    if (!this.#reader.watch) {
      await new Promise((r) => setTimeout(r, Math.min(ms, 1_000)).unref());
      return;
    }
    await this.#reader.watch(await this.access(bindingId), ms, signal);
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

  #transport(c: MailConfig, password: string) {
    assertSecure(c.smtp, 'SMTP');
    const transport = createTransport({
      host: c.smtp.host,
      port: c.smtp.port,
      secure: c.smtp.security === 'tls',
      requireTLS: c.smtp.security === 'starttls',
      ignoreTLS: c.smtp.security === 'none',
      auth: { user: c.username, pass: password },
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
    const password = await this.#password(bindingId);
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
    const transport = this.#transport(c, password);
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
      const password = await this.#password(bindingId);
      await this.#reader.check(
        { ...c.imap, username: c.username, password, folder: c.folder },
        signal,
      );
      const transport = this.#transport(c, password);
      try {
        await transport.verify();
      } finally {
        transport.close();
      }
      return { ok: true, detail: `reading ${c.folder} of ${c.address} (${c.mode})` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    }
  }
}
