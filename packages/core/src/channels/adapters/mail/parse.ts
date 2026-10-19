// Parsing inbound mail for email bindings (FR-110, docs/13 §4): mailparser turns the raw message
// into the channel's inbound shape. Everything in it is untrusted (FR-103): the From address can
// be forged, so the sender counts as their mapped identity only when an Authentication-Results
// header of the receiving server (its authserv-id, RFC 8601) says so: `dmarc=pass` with its own
// `header.from` equal to the From domain, or `dkim=pass` with an aligned `header.d` in the same
// result. Headers are parsed, not searched: comments are stripped and results split on `;`, so
// text a sender put in a comment or in a header of its own counts for nothing. A binding with
// `senderCheck: none` (confirmed and audited when set) skips this and its messages are marked.
// Mail written by machines (Auto-Submitted, bulk, our own replies) never starts a turn, which also
// prevents reply loops with auto-responders.
import { createHash } from 'node:crypto';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { InboundAttachment, NovaInboundMessage } from '../common.ts';

/** The header Nova puts on everything it sends. */
export const NOVA_MAIL_HEADER = 'x-nova-channel';
const MAX_TEXT = 16_000;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export interface ParseContext {
  /** The mailbox's own address (lower case). */
  address: string;
  senderCheck: 'dmarc' | 'none';
  /**
   * The receiving server's authserv-id that Authentication-Results headers must carry; unset, it
   * is derived from `imapHost` (that host's domain and its subdomains). Neither: nothing counts.
   */
  authservId?: string | null;
  /** The IMAP server's name (the default authserv-id domain). */
  imapHost?: string | null;
  receivedAt: string;
}

function addresses(v: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list
    .flatMap((a) => a.value)
    .map((a) => a.address?.trim().toLowerCase())
    .filter((a): a is string => !!a);
}

function bare(id: string | undefined | null): string | null {
  const v = id?.trim().replace(/^<|>$/g, '');
  return v ? v.slice(0, 300) : null;
}

function headerText(parsed: ParsedMail, name: string): string | null {
  const v = parsed.headers.get(name);
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'text' in v && typeof v.text === 'string') return v.text;
  return null;
}

// ---- Authentication-Results (RFC 8601) ----------------------------------------------------------

/** The text without comments: `(…)` outside quoted strings, nested, with `\\` escapes. */
export function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\') {
      // An escaped character stays what it is (inside a comment it is dropped with it).
      if (depth === 0) out += c + (value[i + 1] ?? '');
      i++;
      continue;
    }
    if (quoted) {
      out += c;
      if (c === '"') quoted = false;
      continue;
    }
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')' && depth > 0) {
      depth--;
      if (depth === 0) out += ' ';
      continue;
    }
    if (depth > 0) continue;
    if (c === '"') quoted = true;
    out += c;
  }
  return out;
}

/** Split on a separator outside quoted strings. */
function splitOutside(value: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\' && quoted) {
      cur += c + (value[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (!quoted && sep.test(c)) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function unquote(v: string): string {
  return v.startsWith('"') && v.endsWith('"') && v.length >= 2
    ? v.slice(1, -1).replace(/\\(.)/g, '$1')
    : v;
}

export interface AuthResult {
  method: string;
  result: string;
  /** `ptype.property` → value, lower case (`header.from`, `header.d`, `smtp.mailfrom`). */
  props: Record<string, string>;
}

/** One Authentication-Results value: its authserv-id and results, or null when malformed. */
export function parseAuthResults(
  value: string,
): { authservId: string; results: AuthResult[] } | null {
  const parts = splitOutside(stripComments(value), /;/);
  const head = parts.shift();
  if (!head) return null;
  const authservId = unquote(splitOutside(head, /\s/)[0] ?? '').toLowerCase();
  if (!authservId) return null;
  const results: AuthResult[] = [];
  for (const part of parts) {
    // `method = result` and `ptype.prop = value` may have spaces around the `=`.
    const tokens = splitOutside(part.replace(/\s*=\s*/g, '='), /\s/);
    const first = /^([a-z0-9_-]+)(?:\/\d+)?\s*=\s*([a-z0-9_-]+)$/i.exec(tokens[0] ?? '');
    if (!first) continue;
    const props: Record<string, string> = {};
    for (const t of tokens.slice(1)) {
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const key = t.slice(0, eq).trim().toLowerCase();
      // The first value of a property counts; a repeat cannot override it.
      if (!(key in props)) props[key] = unquote(t.slice(eq + 1).trim()).toLowerCase();
    }
    results.push({ method: first[1]!.toLowerCase(), result: first[2]!.toLowerCase(), props });
  }
  return { authservId, results };
}

/** Whether an authserv-id is the receiving server's (configured, or the IMAP host's domain). */
export function authservTrusted(
  id: string,
  trust: Pick<ParseContext, 'authservId' | 'imapHost'>,
): boolean {
  const want = trust.authservId?.trim().toLowerCase();
  if (want) return id === want;
  const host = trust.imapHost
    ?.trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!host) return false;
  const labels = host.split('.');
  const ip = /^[\d.]+$/.test(host) || host.includes(':');
  const base = !ip && labels.length > 2 ? labels.slice(1).join('.') : host;
  return id === base || (!ip && id.endsWith(`.${base}`));
}

/** DKIM's `header.d` is aligned with the From domain: the same, or a parent of it (relaxed). */
function aligned(d: string | undefined, domain: string): boolean {
  if (!d) return false;
  return d === domain || (d.includes('.') && domain.endsWith(`.${d}`));
}

/**
 * Whether the receiving server authenticated the From domain. Only Authentication-Results
 * headers carrying its authserv-id count, and of those only the topmost (the server adds its own
 * on top; anything below came with the message). It must say `dmarc=pass` with `header.from`
 * equal to the From domain, or `dkim=pass` with an aligned `header.d`, in one result.
 */
export function senderAuthenticated(
  rawHeaderLines: string[],
  fromAddress: string,
  trust: Pick<ParseContext, 'authservId' | 'imapHost'> = {},
): boolean {
  const domain = (fromAddress.split('@')[1] ?? '').toLowerCase();
  if (!domain) return false;
  for (const line of rawHeaderLines) {
    const parsed = parseAuthResults(line.replace(/^authentication-results\s*:/i, ''));
    if (!parsed || !authservTrusted(parsed.authservId, trust)) continue;
    return parsed.results.some(
      (r) =>
        r.result === 'pass' &&
        ((r.method === 'dmarc' && r.props['header.from'] === domain) ||
          (r.method === 'dkim' && aligned(r.props['header.d'], domain))),
    );
  }
  return false;
}

/** The reply text without the quoted history most clients append. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(line.trim())) break;
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line.trim())) break;
    if (line.startsWith('>')) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/** Raw `Authentication-Results` lines in header order (mailparser joins repeated headers). */
function authResultLines(source: Buffer): string[] {
  const end = source.indexOf('\r\n\r\n');
  const head = source.subarray(0, end < 0 ? Math.min(source.length, 65_536) : end).toString('utf8');
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  return unfolded.split(/\r?\n/).filter((l) => /^authentication-results\s*:/i.test(l));
}

/**
 * One message, or null when it must not start anything (machine-written, ours, unreadable).
 * `conversation` is the sender's address, or the list's address for mail sent to a list.
 */
export async function parseMail(
  source: Buffer,
  ctx: ParseContext,
): Promise<NovaInboundMessage | null> {
  let parsed: ParsedMail;
  try {
    parsed = await simpleParser(source, { skipHtmlToText: false, skipTextLinks: true });
  } catch {
    return null;
  }
  // Loop prevention: our own messages, and mail written by machines (RFC 3834).
  if (parsed.headers.has(NOVA_MAIL_HEADER)) return null;
  const auto = headerText(parsed, 'auto-submitted');
  if (auto && auto.trim().toLowerCase() !== 'no') return null;
  const precedence = (headerText(parsed, 'precedence') ?? '').trim().toLowerCase();
  if (precedence === 'bulk' || precedence === 'junk' || precedence === 'auto_reply') return null;

  const from = addresses(parsed.from)[0];
  if (!from || from === ctx.address) return null;
  const fromName = parsed.from?.value[0]?.name?.trim() || null;
  const to = addresses(parsed.to);
  const cc = addresses(parsed.cc);
  // mailparser folds the List-* headers into one structured `list` header.
  const listHeader = parsed.headers.get('list') as { post?: { mail?: unknown } } | undefined;
  const listPost =
    (typeof listHeader?.post?.mail === 'string' ? listHeader.post.mail : null) ??
    /<mailto:([^>?]+)/i.exec(headerText(parsed, 'list-post') ?? '')?.[1];
  const list = listPost?.trim().toLowerCase() || null;
  const others = [...to, ...cc].filter((a) => a !== ctx.address && a !== from);
  const visibility = list || others.length ? 'shared' : 'private';
  // Addressed when the mailbox is a recipient in To (a Cc only copies it in) or the list's mail.
  const addressed = !!list || to.includes(ctx.address);

  const messageId =
    bare(parsed.messageId) ?? `sha256-${createHash('sha256').update(source).digest('hex')}`;
  const refs = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [parsed.references]
      : [];
  const threadRef = bare(refs[0]) ?? bare(parsed.inReplyTo) ?? messageId;
  const body = parsed.text ?? '';
  const text = stripQuoted(body).slice(0, MAX_TEXT);

  const attachments: InboundAttachment[] = [];
  for (const a of parsed.attachments) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    if (a.related || a.size > MAX_ATTACHMENT_BYTES) continue;
    attachments.push({
      name: (a.filename ?? 'attachment').slice(0, 200),
      mime: a.contentType || 'application/octet-stream',
      bytes: a.content,
    });
  }
  const subject = parsed.subject?.trim().slice(0, 300) ?? null;
  if (!text && !attachments.length && !subject) return null;
  return {
    kind: 'email',
    conversation: list ?? from,
    visibility,
    sender: { externalId: from, displayName: fromName },
    addressed,
    text: text || subject || '',
    messageId,
    threadRef,
    receivedAt: ctx.receivedAt,
    attachments,
    subject,
    senderVerified:
      ctx.senderCheck === 'none' ||
      senderAuthenticated(authResultLines(source), from, {
        authservId: ctx.authservId ?? null,
        imapHost: ctx.imapHost ?? null,
      }),
    // Recorded on the message: the binding chose to trust From addresses unchecked.
    ...(ctx.senderCheck === 'none' ? { senderUnchecked: true } : {}),
  };
}
