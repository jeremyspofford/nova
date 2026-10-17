// Microsoft Teams adapter (FR-088, docs/13 §4): Bot Framework activities in, replies out through
// the connector service. Inbound requests carry a bearer JWT that a `TeamsTokenVerifier` checks
// (the default verifies the Bot Framework signing keys: issuer, audience = the app id, expiry and
// the `serviceUrl` claim); without a valid token nothing is read. The service URL of a verified
// activity is remembered on the binding, and replies go only to that URL and only to the
// connector's hosts, so the app password and access tokens never reach another host. Personal
// chats are private; channels and group chats are shared; a personal chat or an @mention of the
// bot addresses the agent.
import { createPublicKey, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { uuidv7 } from '@nova/shared';
import type { ChannelReceipt, InboundMessage, OutboundMessage } from '../types.ts';
import { headerOf, unauthorized } from '../signing.ts';
import {
  jsonBody,
  notConfigured,
  obj,
  sendFailed,
  str,
  type AdapterProbe,
  type BindingCredentials,
  type FetchLike,
  type NovaChannelAdapter,
} from './common.ts';

export const BOT_FRAMEWORK_OPENID =
  'https://login.botframework.com/v1/.well-known/openidconfiguration';
export const BOT_FRAMEWORK_TOKEN_URL =
  'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
const CLOCK_SKEW_MS = 5 * 60_000;

/** Checks the bearer token of an inbound activity. */
export interface TeamsTokenVerifier {
  verify(input: {
    authorization: string | undefined;
    appId: string;
    serviceUrl: string | null;
  }): Promise<boolean>;
}

export interface BotFrameworkVerifierOptions {
  openIdUrl?: string;
  /** Accepted issuers (default the Bot Framework's). */
  issuers?: string[];
  fetch?: FetchLike;
  now?: () => Date;
  /** How long fetched signing keys are reused (default 1 h; an unknown key id refetches). */
  cacheMs?: number;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    return obj(JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

/** Verifies Bot Framework JWTs (RS256) against the published signing keys. Fails closed. */
export class BotFrameworkVerifier implements TeamsTokenVerifier {
  readonly #o: Required<Omit<BotFrameworkVerifierOptions, 'fetch' | 'now'>> & {
    fetch: FetchLike;
    now: () => Date;
  };
  #keys: { at: number; keys: Jwk[] } | null = null;

  constructor(opts: BotFrameworkVerifierOptions = {}) {
    this.#o = {
      openIdUrl: opts.openIdUrl ?? BOT_FRAMEWORK_OPENID,
      issuers: opts.issuers ?? [BOT_FRAMEWORK_ISSUER],
      fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
      now: opts.now ?? (() => new Date()),
      cacheMs: opts.cacheMs ?? 60 * 60_000,
    };
  }

  async verify(input: {
    authorization: string | undefined;
    appId: string;
    serviceUrl: string | null;
  }): Promise<boolean> {
    try {
      const token = input.authorization?.startsWith('Bearer ')
        ? input.authorization.slice(7).trim()
        : null;
      const parts = token?.split('.');
      if (!parts || parts.length !== 3) return false;
      const [h, p, s] = parts as [string, string, string];
      const header = b64urlJson(h);
      const claims = b64urlJson(p);
      if (!header || !claims || header.alg !== 'RS256') return false;
      const kid = str(header.kid);
      const key = await this.#key(kid);
      if (!key) return false;
      const ok = verifySignature(
        'RSA-SHA256',
        Buffer.from(`${h}.${p}`),
        createPublicKey({ key, format: 'jwk' }),
        Buffer.from(s, 'base64url'),
      );
      if (!ok) return false;
      const now = this.#o.now().getTime();
      const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : null;
      const nbf = typeof claims.nbf === 'number' ? claims.nbf * 1000 : null;
      if (exp === null || exp + CLOCK_SKEW_MS < now) return false;
      if (nbf !== null && nbf - CLOCK_SKEW_MS > now) return false;
      if (!this.#o.issuers.includes(str(claims.iss) ?? '')) return false;
      const aud = claims.aud;
      if (!(aud === input.appId || (Array.isArray(aud) && aud.includes(input.appId)))) return false;
      // The service URL the activity names must be the one the token was issued for.
      const claimed = str(claims.serviceUrl) ?? str(claims.serviceurl);
      if (claimed && input.serviceUrl && trimSlash(claimed) !== trimSlash(input.serviceUrl))
        return false;
      return true;
    } catch {
      return false;
    }
  }

  async #key(kid: string | null): Promise<Jwk | null> {
    const now = this.#o.now().getTime();
    const find = () =>
      this.#keys?.keys.find((k) => (kid ? k.kid === kid : true) && k.kty === 'RSA') ?? null;
    if (this.#keys && now - this.#keys.at < this.#o.cacheMs) {
      const hit = find();
      if (hit) return hit;
    }
    const meta = obj(await (await this.#o.fetch(this.#o.openIdUrl, { redirect: 'error' })).json());
    const jwksUri = str(meta.jwks_uri);
    if (!jwksUri) return null;
    const jwks = obj(await (await this.#o.fetch(jwksUri, { redirect: 'error' })).json());
    const keys = Array.isArray(jwks.keys) ? (jwks.keys as Jwk[]) : [];
    this.#keys = { at: now, keys };
    return find();
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

/** The Bot Framework connector hosts replies may go to. */
export function defaultServiceHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'smba.trafficmanager.net' ||
    h.endsWith('.botframework.com') ||
    h.endsWith('.trafficmanager.net') ||
    h.endsWith('.teams.microsoft.com')
  );
}

export interface TeamsAdapterOptions {
  credentials: BindingCredentials;
  verifier: TeamsTokenVerifier;
  tokenUrl?: string;
  /** Which hosts replies may be sent to (default the connector's; tests allow a mock). */
  serviceHost?: (host: string, protocol: string) => boolean;
  fetch?: FetchLike;
  now?: () => Date;
}

export class TeamsAdapter implements NovaChannelAdapter {
  readonly kind = 'teams' as const;
  readonly credentialNames = ['appPassword'] as const;
  readonly #o: TeamsAdapterOptions;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #tokens = new Map<string, { token: string; until: number }>();

  constructor(opts: TeamsAdapterOptions) {
    this.#o = opts;
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#now = opts.now ?? (() => new Date());
  }

  async parse(input: {
    bindingId: string;
    headers: Record<string, string | undefined>;
    rawBody: Uint8Array;
  }): Promise<InboundMessage | null> {
    const config = await this.#o.credentials.config(input.bindingId);
    const appId = config.appId;
    if (!appId) throw unauthorized('no app id is configured');
    // The activity is read for its service URL only after nothing else is trusted from it.
    let activity: Record<string, unknown>;
    try {
      activity = jsonBody(input.rawBody);
    } catch {
      throw unauthorized('the body is not an activity');
    }
    const serviceUrl = str(activity.serviceUrl);
    const ok = await this.#o.verifier.verify({
      authorization: headerOf(input.headers, 'authorization'),
      appId,
      serviceUrl,
    });
    if (!ok) throw unauthorized('invalid token');
    if (serviceUrl && serviceUrl !== config.serviceUrl)
      await this.#o.credentials.remember(input.bindingId, 'serviceUrl', serviceUrl);

    if (activity.type !== 'message') return null;
    const from = obj(activity.from);
    const recipient = obj(activity.recipient);
    const conversation = obj(activity.conversation);
    const fromId = str(from.id);
    const conversationId = str(conversation.id);
    const id = str(activity.id);
    if (!fromId || !conversationId || !id) return null;
    // Loop prevention: the bot's own activities never count as messages.
    if (fromId === str(recipient.id)) return null;
    const personal = conversation.conversationType === 'personal';
    const entities = Array.isArray(activity.entities) ? activity.entities : [];
    const mentioned = entities.some((e) => {
      const m = obj(e);
      return m.type === 'mention' && str(obj(m.mentioned).id) === str(recipient.id);
    });
    const raw = typeof activity.text === 'string' ? activity.text : '';
    const text = raw
      .replace(/<at>[^<]*<\/at>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // A channel thread's conversation id carries `;messageid=<root>`: the binding names the
    // channel, and the reply goes to the thread (`<full conversation id>|<activity id>`).
    const base = conversationId.split(';messageid=')[0] ?? conversationId;
    return {
      kind: 'teams',
      conversation: base,
      visibility: personal ? 'private' : 'shared',
      sender: { externalId: fromId, displayName: str(from.name) },
      addressed: personal || mentioned,
      text,
      messageId: id,
      threadRef: personal ? null : `${conversationId}|${id}`,
      receivedAt: this.#now().toISOString(),
    };
  }

  async send(
    bindingId: string,
    message: OutboundMessage,
    signal: AbortSignal,
  ): Promise<ChannelReceipt> {
    const config = await this.#o.credentials.config(bindingId);
    const base = config.serviceUrl;
    if (!base) throw notConfigured('the Teams service URL (it is learned from the first message)');
    const url = new URL(base);
    const allowed = this.#o.serviceHost ?? ((h, p) => p === 'https:' && defaultServiceHost(h));
    if (!allowed(url.hostname, url.protocol))
      throw sendFailed('Teams reply', `${url.hostname} is not a Bot Framework connector host`);
    const token = await this.#token(bindingId, config, signal);
    // A reply in a thread: `<full conversation id>|<activity id>` (or a bare activity id).
    const [threadConv, replyTo] = message.threadRef?.includes('|')
      ? (message.threadRef.split('|', 2) as [string, string])
      : [message.conversation, message.threadRef ?? null];
    const conv = encodeURIComponent(replyTo ? threadConv : message.conversation);
    const path = replyTo
      ? `v3/conversations/${conv}/activities/${encodeURIComponent(replyTo)}`
      : `v3/conversations/${conv}/activities`;
    let res: Response;
    try {
      res = await this.#fetch(new URL(path, base.endsWith('/') ? base : `${base}/`), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'message',
          text: message.text,
          ...(replyTo ? { replyToId: replyTo } : {}),
        }),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      throw sendFailed('Teams reply', err instanceof Error ? err.message : String(err));
    }
    if (!res.ok) throw sendFailed('Teams reply', `HTTP ${res.status}`);
    const body = obj(await res.json().catch(() => ({})));
    return { id: str(body.id) ?? `teams:${uuidv7()}`, at: this.#now().toISOString() };
  }

  async probe(bindingId: string, signal: AbortSignal): Promise<AdapterProbe> {
    try {
      const config = await this.#o.credentials.config(bindingId);
      await this.#token(bindingId, config, signal);
      return {
        ok: true,
        detail: config.serviceUrl
          ? 'connected'
          : 'credentials work; replies start after the first message',
      };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /** A connector access token for the app (client credentials), reused until it expires. */
  async #token(
    bindingId: string,
    config: Record<string, string | null>,
    signal: AbortSignal,
  ): Promise<string> {
    const appId = config.appId;
    if (!appId) throw notConfigured('the Teams app id');
    const cached = this.#tokens.get(appId);
    const now = this.#now().getTime();
    if (cached && cached.until > now) return cached.token;
    const password = await this.#o.credentials.secret(bindingId, 'appPassword');
    if (!password) throw notConfigured('the Teams app password');
    let res: Response;
    try {
      res = await this.#fetch(this.#o.tokenUrl ?? BOT_FRAMEWORK_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: appId,
          client_secret: password,
          scope: 'https://api.botframework.com/.default',
        }).toString(),
        signal,
        redirect: 'error',
      });
    } catch (err) {
      throw sendFailed('Teams sign-in', err instanceof Error ? err.message : String(err));
    }
    const body = obj(await res.json().catch(() => ({})));
    const token = str(body.access_token);
    if (!res.ok || !token)
      throw sendFailed('Teams sign-in', str(body.error) ?? `HTTP ${res.status}`);
    const ttl = typeof body.expires_in === 'number' ? body.expires_in * 1000 : 3_600_000;
    this.#tokens.set(appId, { token, until: now + Math.max(0, ttl - 60_000) });
    return token;
  }
}
