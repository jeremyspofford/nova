// Delivering a scheduled job's result (FR-187, docs/09 §6). A delivery counts only with a receipt:
// the notification id for `inapp` and `os` (one notification serves both; clients raise it as an
// OS notification where the user allowed that), a 2xx answer for `webhook`. Webhooks are POSTed as
// signed JSON (HMAC-SHA256 with a per-schedule secret from the secret store), https only, never to
// a private or loopback address: the address is checked after DNS and the connection is pinned to
// it, so a rebinding answer cannot redirect it. Slack, Teams and email arrive with channels (M6).
import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { DELIVERY_KINDS } from '@nova/shared';
import { defaultRedactor, type Redactor } from '@nova/security';
import type { SecretStore } from '@nova/secrets';
import { isPrivateAddress } from '../tools/web.ts';
import type { NotificationInput, Notifier } from '../tools/types.ts';

export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export interface DeliveryTarget {
  kind: DeliveryKind;
  ref?: string;
}

/** What is delivered for one run of a schedule. */
export interface DeliveryRequest {
  accountId: string;
  scheduleId: string;
  title: string;
  runId: string;
  threadId: string | null;
  fireId: string;
  /** The run's report message or final reply (model output: untrusted, redacted on the way out). */
  message: string;
  firedAt: string;
}

export interface DeliveryAttempt {
  /** The provider's proof of delivery; null when the target accepted nothing it can show. */
  receipt: string | null;
  error?: string;
}

export interface DeliveryResult extends DeliveryTarget, DeliveryAttempt {}

/** One kind of delivery target. Never throws: failures come back without a receipt. */
export interface DeliveryChannel {
  deliver(req: DeliveryRequest, target: DeliveryTarget): Promise<DeliveryAttempt>;
}

/** A notifier that returns what it recorded (NotificationService.create). */
export interface ReceiptNotifier {
  create(n: NotificationInput): Promise<{ id: string } | null>;
}

const MAX_MESSAGE = 4000;

function messageOf(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (cause && typeof cause.code === 'string') return cause.code;
  return err instanceof Error ? err.message : String(err);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** In-app and OS delivery through the notification center; the notification id is the receipt. */
export function notificationChannel(
  notifier: () => Notifier | ReceiptNotifier | null,
): DeliveryChannel {
  return {
    async deliver(req) {
      const n = notifier();
      if (!n) return { receipt: null, error: 'notifications are not available' };
      const input: NotificationInput = {
        accountId: req.accountId,
        kind: 'completion',
        title: clip(req.title, 300),
        body: clip(req.message, 2000),
        href: `/work/${encodeURIComponent(req.runId)}`,
        // inapp and os share one notification per run.
        dedupeKey: `schedule-run:${req.runId}`,
      };
      try {
        if ('create' in n) {
          const row = await n.create(input);
          return row
            ? { receipt: row.id }
            : { receipt: null, error: 'completion notifications are turned off' };
        }
        await n.notify(input);
        return { receipt: null, error: 'the notifier accepted it but gave no receipt' };
      } catch (err) {
        return { receipt: null, error: `the notification failed: ${messageOf(err)}` };
      }
    },
  };
}

/** Where a schedule's webhook signing secret lives in the secret store. */
export function webhookSecretRef(scheduleId: string): string {
  return `secret://schedule/${scheduleId}/webhook`;
}

/** Create the schedule's signing secret unless it exists. */
export async function ensureWebhookSecret(secrets: SecretStore, scheduleId: string): Promise<void> {
  const ref = webhookSecretRef(scheduleId);
  if (!(await secrets.has(ref))) await secrets.put(ref, randomBytes(32).toString('hex'));
}

/** `sha256=<hex>` over `<timestamp>.<body>`; receivers recompute it with the shared secret. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** Why a webhook URL is refused, or null: https, no credentials, not a private or local host. */
export function webhookUrlProblem(raw: string | undefined): string | null {
  if (!raw) return 'a webhook needs a URL';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${clip(raw, 100)}" is not a URL`;
  }
  if (url.protocol !== 'https:') return 'webhook URLs must use https';
  if (url.username || url.password) return 'webhook URLs cannot carry credentials';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host) ? isPrivateAddress(host) : localName(host))
    return `${host} is a private or local address`;
  return null;
}

function localName(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.')
  );
}

export interface WebhookRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

/** Sends one webhook POST and returns the status; throws when nothing could be sent. */
export type WebhookTransport = (req: WebhookRequest) => Promise<{ status: number }>;

/** A host's address for a webhook, refused when any address it resolves to is private. */
export async function publicAddress(
  hostname: string,
  resolveHost: (host: string) => Promise<string[]>,
  allowPrivate = false,
): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await resolveHost(host);
  if (!addresses.length) throw new Error(`${host} could not be resolved`);
  if (!allowPrivate && addresses.some(isPrivateAddress))
    throw new Error(`${host} is a private or local address`);
  return addresses[0]!;
}

/** A DNS lookup that always answers with the address already checked. */
export function pinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_host, options, callback) => {
    if (options.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

export interface HttpsTransportOptions {
  /** Resolve a host name to addresses (tests replace DNS). */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Allow private and loopback addresses (tests only). */
  allowPrivate?: boolean;
}

/** POST over https to a checked, pinned public address; redirects are not followed. */
export function httpsTransport(opts: HttpsTransportOptions = {}): WebhookTransport {
  const resolveHost =
    opts.resolveHost ??
    (async (host: string) => (await lookup(host, { all: true })).map((a) => a.address));
  return async ({ url, headers, body, signal }) => {
    const address = await publicAddress(url.hostname, resolveHost, opts.allowPrivate);
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
          signal,
          lookup: pinnedLookup(address),
        },
        (res) => {
          res.resume();
          res.once('end', () => resolve({ status: res.statusCode ?? 0 }));
          res.once('error', reject);
        },
      );
      req.once('error', reject);
      req.end(body);
    });
  };
}

export interface WebhookChannelOptions {
  secrets: SecretStore;
  transport: WebhookTransport;
  now: () => Date;
  redactor?: Redactor;
  timeoutMs?: number;
}

/** Signed JSON POSTs; a 2xx answer is the receipt. */
export function webhookChannel(opts: WebhookChannelOptions): DeliveryChannel {
  const redactor = opts.redactor ?? defaultRedactor;
  return {
    async deliver(req, target) {
      const problem = webhookUrlProblem(target.ref);
      if (problem) return { receipt: null, error: problem };
      const secret = await opts.secrets.get(webhookSecretRef(req.scheduleId));
      if (!secret) return { receipt: null, error: 'the webhook signing secret is missing' };
      const sentAt = opts.now();
      const body = JSON.stringify(
        redactor.redact({
          scheduleId: req.scheduleId,
          runId: req.runId,
          fireId: req.fireId,
          title: req.title,
          summary: clip(req.message, MAX_MESSAGE),
          firedAt: req.firedAt,
          deliveredAt: sentAt.toISOString(),
        }),
      );
      const timestamp = String(Math.floor(sentAt.getTime() / 1000));
      try {
        const res = await opts.transport({
          url: new URL(target.ref!),
          headers: {
            'content-type': 'application/json',
            'user-agent': 'Nova scheduler',
            'x-nova-delivery': req.fireId,
            'x-nova-timestamp': timestamp,
            'x-nova-signature': signWebhook(secret, timestamp, body),
          },
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
        if (res.status >= 200 && res.status < 300)
          return { receipt: `webhook:${req.fireId}:${res.status}` };
        return { receipt: null, error: `the webhook answered ${res.status}` };
      } catch (err) {
        return { receipt: null, error: `the webhook could not be reached: ${messageOf(err)}` };
      }
    },
  };
}

/** Deliver to every target in order; a channel that throws counts as a failed delivery. */
export async function deliverAll(
  channels: ReadonlyMap<DeliveryKind, DeliveryChannel>,
  req: DeliveryRequest,
  targets: readonly DeliveryTarget[],
): Promise<DeliveryResult[]> {
  const out: DeliveryResult[] = [];
  for (const target of targets) {
    const channel = channels.get(target.kind);
    let attempt: DeliveryAttempt;
    if (!channel) attempt = { receipt: null, error: `${target.kind} delivery is not available` };
    else {
      try {
        attempt = await channel.deliver(req, target);
      } catch (err) {
        attempt = { receipt: null, error: messageOf(err) };
      }
    }
    const result: DeliveryResult = { kind: target.kind, receipt: attempt.receipt };
    if (target.ref !== undefined) result.ref = target.ref;
    if (attempt.error !== undefined) result.error = attempt.error;
    out.push(result);
  }
  return out;
}
