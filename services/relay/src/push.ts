// Push for mobile clients (FR-111, FR-137, docs/13 §6, docs/22 §3.2). The Relay sends two kinds:
// a content-free wake-up when a frame waits for a client route that is not connected (the route
// id only), and a notification the Hub asks for, which carries only ids, a redacted title and the
// deep link (the Hub never gives it more; the Relay stays content-blind). Real senders are APNs
// (HTTP/2 with an ES256 provider token) and FCM (HTTP v1 with a service-account OAuth token);
// both are off until the operator configures them (`pushSenderFromEnv`), and the Relay records
// pushes with the mock meanwhile. Tokens are checked for shape when a client registers them.
// Self-contained on purpose: this package is Apache-2.0 and imports no AGPL code (ADR-023).
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect as http2Connect, type ClientHttp2Session } from 'node:http2';

export interface PushNotice {
  /** The Hub's notification id. */
  id: string;
  category: 'approval' | 'completion' | 'error' | 'attention' | 'system';
  /** Redacted by the Hub ("Approval needed"); never content. */
  title: string;
  /** `nova://run/<id>`, `nova://code/<id>` or `nova://approval/<id>`. */
  link: string | null;
}

export interface PushMessage {
  platform: 'apns' | 'fcm';
  token: string;
  topic: string | null;
  /** `wake`: reconnect, something waits; `notify`: show the Hub's redacted notification. */
  kind: 'wake' | 'notify';
  routeId: string;
  notification?: PushNotice;
}

export interface PushOutcome {
  ok: boolean;
  /** The token is no longer valid (APNs 410, FCM 404): the registration is dropped. */
  gone?: boolean;
  detail?: string | null;
}

export interface PushSender {
  readonly name: string;
  send(msg: PushMessage): Promise<void | PushOutcome>;
}

/** Records pushes instead of sending them (tests, and the default while none is configured). */
export class MockPushSender implements PushSender {
  readonly name = 'mock';
  readonly sent: PushMessage[] = [];
  send(msg: PushMessage): Promise<PushOutcome> {
    this.sent.push(msg);
    return Promise.resolve({ ok: true });
  }
}

// ---- token shapes (validated at registration) ---------------------------------------------------

/** APNs device tokens are hex (32 bytes today; Apple says not to assume the length). */
const APNS_TOKEN = /^(?:[0-9a-fA-F]{2}){32,100}$/;
/** FCM registration tokens: URL-safe base64 characters and a colon, roughly 150-200 long. */
const FCM_TOKEN = /^[A-Za-z0-9_:-]{32,4096}$/;
/** An APNs topic is the app's bundle id (plus `.voip` and the like). */
export const PUSH_TOPIC = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;

export function pushTokenProblem(platform: 'apns' | 'fcm', token: string): string | null {
  if (platform === 'apns')
    return APNS_TOKEN.test(token) ? null : 'an APNs device token is 64 or more hex characters';
  return FCM_TOKEN.test(token) ? null : 'not an FCM registration token';
}

// ---- APNs -----------------------------------------------------------------------------------------

export const APNS_ORIGIN = 'https://api.push.apple.com';
export const APNS_SANDBOX_ORIGIN = 'https://api.sandbox.push.apple.com';

export interface ApnsOptions {
  /** The `.p8` signing key (PKCS#8 PEM, P-256). */
  keyPem: string;
  keyId: string;
  teamId: string;
  /** Bundle ids this Relay may push to; the first is used when a client named none. */
  topics: string[];
  sandbox?: boolean;
  /** Tests: a local HTTP/2 server instead of Apple's. */
  origin?: string;
  now?: () => number;
  timeoutMs?: number;
}

const b64url = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');

export class ApnsSender implements PushSender {
  readonly name = 'apns';
  readonly #o: ApnsOptions;
  readonly #key: KeyObject;
  readonly #origin: string;
  readonly #now: () => number;
  #jwt: { token: string; at: number } | null = null;
  #session: ClientHttp2Session | null = null;

  constructor(opts: ApnsOptions) {
    if (!/^[A-Z0-9]{10}$/.test(opts.keyId) || !/^[A-Z0-9]{10}$/.test(opts.teamId))
      throw new Error('APNs: the key id and team id are 10 letters or digits');
    if (!opts.topics.length || opts.topics.some((t) => !PUSH_TOPIC.test(t)))
      throw new Error('APNs: give the bundle ids to push to');
    this.#o = opts;
    this.#key = createPrivateKey(opts.keyPem);
    if (this.#key.asymmetricKeyType !== 'ec') throw new Error('APNs: the key is not an EC key');
    this.#origin = opts.origin ?? (opts.sandbox ? APNS_SANDBOX_ORIGIN : APNS_ORIGIN);
    this.#now = opts.now ?? (() => Date.now());
  }

  /**
   * The provider token: ES256 over `{iss: team, iat}` with the key id in the header. Apple wants
   * it reused, refreshed between 20 and 60 minutes; this one is replaced after 40.
   */
  providerToken(force = false): string {
    const now = this.#now();
    if (!force && this.#jwt && now - this.#jwt.at < 40 * 60_000) return this.#jwt.token;
    const head = b64url(JSON.stringify({ alg: 'ES256', kid: this.#o.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.#o.teamId, iat: Math.floor(now / 1000) }));
    const sig = sign('sha256', Buffer.from(`${head}.${claims}`), {
      key: this.#key,
      dsaEncoding: 'ieee-p1363',
    });
    this.#jwt = { token: `${head}.${claims}.${b64url(sig)}`, at: now };
    return this.#jwt.token;
  }

  #connection(): ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) return this.#session;
    const session = http2Connect(this.#origin);
    session.on('error', () => {
      if (this.#session === session) this.#session = null;
    });
    session.on('goaway', () => {
      if (this.#session === session) this.#session = null;
    });
    session.unref();
    this.#session = session;
    return session;
  }

  async send(msg: PushMessage): Promise<PushOutcome> {
    if (msg.platform !== 'apns') return { ok: false, detail: 'not an APNs registration' };
    const topic = msg.topic ?? this.#o.topics[0]!;
    // A client cannot make the Relay's key push to another app of the same team.
    if (!this.#o.topics.includes(topic)) return { ok: false, detail: 'topic not allowed' };
    let res = await this.#post(msg, topic, false);
    if (res.status === 403 && res.reason === 'ExpiredProviderToken')
      res = await this.#post(msg, topic, true);
    if (res.status === 200) return { ok: true };
    const gone = res.status === 410 || (res.status === 400 && res.reason === 'BadDeviceToken');
    return { ok: false, gone, detail: `APNs ${res.status}${res.reason ? ` ${res.reason}` : ''}` };
  }

  #post(
    msg: PushMessage,
    topic: string,
    fresh: boolean,
  ): Promise<{ status: number; reason: string | null }> {
    const n = msg.kind === 'notify' ? msg.notification : undefined;
    const body = JSON.stringify(
      n
        ? {
            aps: {
              alert: { title: n.title },
              sound: 'default',
              'thread-id': n.category,
              // Lets the app's extension replace the redacted text with what it fetches itself.
              'mutable-content': 1,
            },
            nova: {
              kind: 'notify',
              id: n.id,
              category: n.category,
              link: n.link,
              route: msg.routeId,
            },
          }
        : { aps: { 'content-available': 1 }, nova: { kind: 'wake', route: msg.routeId } },
    );
    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': `/3/device/${msg.token}`,
      authorization: `bearer ${this.providerToken(fresh)}`,
      'apns-topic': topic,
      'apns-push-type': n ? 'alert' : 'background',
      // Background pushes must use priority 5 (Apple); alerts are immediate.
      'apns-priority': n ? '10' : '5',
      'apns-expiration': String(Math.floor(this.#now() / 1000) + 3600),
      'content-type': 'application/json',
    };
    if (n) headers['apns-collapse-id'] = n.id.slice(0, 64);
    return new Promise((resolve) => {
      let session: ClientHttp2Session;
      try {
        session = this.#connection();
      } catch {
        resolve({ status: 0, reason: 'unreachable' });
        return;
      }
      const req = session.request(headers);
      let status = 0;
      let data = '';
      const done = (s: number, reason: string | null) => {
        req.removeAllListeners();
        resolve({ status: s, reason });
      };
      req.setTimeout(this.#o.timeoutMs ?? 15_000, () => {
        req.close();
        done(0, 'timeout');
      });
      req.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
      });
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        if (data.length < 4096) data += chunk;
      });
      req.on('end', () => {
        let reason: string | null = null;
        try {
          const parsed = JSON.parse(data) as { reason?: unknown };
          if (typeof parsed.reason === 'string') reason = parsed.reason.slice(0, 100);
        } catch {
          // an empty body on success
        }
        done(status, reason);
      });
      req.on('error', () => done(0, 'unreachable'));
      req.end(body);
    });
  }

  close(): void {
    this.#session?.close();
    this.#session = null;
  }
}

// ---- FCM ------------------------------------------------------------------------------------------

export const FCM_API = 'https://fcm.googleapis.com';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export interface FcmOptions {
  serviceAccount: FcmServiceAccount;
  /** Tests: a local server for the API and the token endpoint. */
  apiBase?: string;
  tokenUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
}

export class FcmSender implements PushSender {
  readonly name = 'fcm';
  readonly #o: FcmOptions;
  readonly #key: KeyObject;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  #access: { token: string; until: number } | null = null;

  constructor(opts: FcmOptions) {
    const sa = opts.serviceAccount;
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(sa.project_id) || !sa.client_email.includes('@'))
      throw new Error('FCM: not a service account');
    this.#o = opts;
    this.#key = createPrivateKey(sa.private_key);
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** An OAuth access token from a signed service-account assertion (RS256), reused until near expiry. */
  async accessToken(force = false): Promise<string> {
    const now = this.#now();
    if (!force && this.#access && this.#access.until > now + 60_000) return this.#access.token;
    const tokenUrl = this.#o.tokenUrl ?? GOOGLE_TOKEN_URL;
    const iat = Math.floor(now / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: this.#o.serviceAccount.client_email,
        scope: FCM_SCOPE,
        aud: tokenUrl,
        iat,
        exp: iat + 3600,
      }),
    );
    const sig = sign('sha256', Buffer.from(`${head}.${claims}`), this.#key);
    const res = await this.#fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${head}.${claims}.${b64url(sig)}`,
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(this.#o.timeoutMs ?? 15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (!res.ok || typeof body.access_token !== 'string')
      throw new Error(`FCM: the token endpoint answered ${res.status}`);
    const ttl = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.#access = { token: body.access_token, until: now + ttl * 1000 };
    return body.access_token;
  }

  async send(msg: PushMessage): Promise<PushOutcome> {
    if (msg.platform !== 'fcm') return { ok: false, detail: 'not an FCM registration' };
    let res: Response;
    try {
      res = await this.#post(msg, false);
      if (res.status === 401) res = await this.#post(msg, true);
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message.slice(0, 200) : 'failed' };
    }
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: { status?: unknown } };
    const status = typeof body.error?.status === 'string' ? body.error.status : '';
    // NOT_FOUND / UNREGISTERED: the app was uninstalled or the token rotated.
    const gone = res.status === 404 || status === 'UNREGISTERED' || status === 'NOT_FOUND';
    return { ok: false, gone, detail: `FCM ${res.status}${status ? ` ${status}` : ''}` };
  }

  async #post(msg: PushMessage, fresh: boolean): Promise<Response> {
    const token = await this.accessToken(fresh);
    const n = msg.kind === 'notify' ? msg.notification : undefined;
    // FCM data values are strings.
    const data: Record<string, string> = n
      ? {
          kind: 'notify',
          id: n.id,
          category: n.category,
          link: n.link ?? '',
          route: msg.routeId,
        }
      : { kind: 'wake', route: msg.routeId };
    const message: Record<string, unknown> = {
      token: msg.token,
      data,
      android: {
        priority: 'high',
        ttl: '3600s',
        ...(n ? { collapse_key: n.id.slice(0, 64) } : {}),
      },
    };
    if (n) message.notification = { title: n.title };
    const base = (this.#o.apiBase ?? FCM_API).replace(/\/+$/, '');
    return this.#fetch(
      `${base}/v1/projects/${encodeURIComponent(this.#o.serviceAccount.project_id)}/messages:send`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 15_000),
      },
    );
  }
}

// ---- dispatch and configuration -----------------------------------------------------------------

/** Sends by platform; a platform that is not configured is recorded by the mock. */
export class PlatformPushSender implements PushSender {
  readonly name: string;
  readonly #apns: PushSender | null;
  readonly #fcm: PushSender | null;
  readonly #fallback: PushSender;

  constructor(opts: { apns?: PushSender | null; fcm?: PushSender | null; fallback?: PushSender }) {
    this.#apns = opts.apns ?? null;
    this.#fcm = opts.fcm ?? null;
    this.#fallback = opts.fallback ?? new MockPushSender();
    this.name = [this.#apns?.name, this.#fcm?.name].filter(Boolean).join('+') || 'mock';
  }

  async send(msg: PushMessage): Promise<PushOutcome> {
    const sender = msg.platform === 'apns' ? this.#apns : this.#fcm;
    const out = await (sender ?? this.#fallback).send(msg);
    return out ?? { ok: true };
  }
}

/**
 * The operator's push configuration (off by default: nothing set means the recording mock).
 *   NOVA_RELAY_APNS_KEY_FILE, NOVA_RELAY_APNS_KEY_ID, NOVA_RELAY_APNS_TEAM_ID,
 *   NOVA_RELAY_APNS_TOPICS (comma-separated bundle ids), NOVA_RELAY_APNS_SANDBOX=1
 *   NOVA_RELAY_FCM_SERVICE_ACCOUNT_FILE (the service account JSON)
 * Key files are read once at start; their contents never reach the log.
 */
export function pushSenderFromEnv(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): { sender: PushSender; configured: ('apns' | 'fcm')[] } {
  const configured: ('apns' | 'fcm')[] = [];
  let apns: ApnsSender | null = null;
  let fcm: FcmSender | null = null;
  if (env.NOVA_RELAY_APNS_KEY_FILE) {
    apns = new ApnsSender({
      keyPem: readFile(env.NOVA_RELAY_APNS_KEY_FILE),
      keyId: env.NOVA_RELAY_APNS_KEY_ID ?? '',
      teamId: env.NOVA_RELAY_APNS_TEAM_ID ?? '',
      topics: (env.NOVA_RELAY_APNS_TOPICS ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      sandbox: env.NOVA_RELAY_APNS_SANDBOX === '1',
    });
    configured.push('apns');
  }
  if (env.NOVA_RELAY_FCM_SERVICE_ACCOUNT_FILE) {
    const sa = JSON.parse(readFile(env.NOVA_RELAY_FCM_SERVICE_ACCOUNT_FILE)) as FcmServiceAccount;
    fcm = new FcmSender({ serviceAccount: sa });
    configured.push('fcm');
  }
  if (!configured.length) return { sender: new MockPushSender(), configured };
  return { sender: new PlatformPushSender({ apns, fcm }), configured };
}
