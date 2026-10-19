// M8 third-party app authorization and OTLP export (FR-222, FR-223; ADR-097 D6). Views and zod
// requests for /api/v1/apps, /api/v1/oauth and /api/v1/telemetry/otlp.
//
// Apps use OAuth 2.0 authorization code with PKCE (S256 only) as public clients (native apps:
// loopback or private-use-scheme redirects, RFC 8252). The owner approves on the Hub's consent
// page; the approval is an app authorization of kind `app` (the M4 table Settings already lists
// and revokes). Tokens start `nva_`: access tokens live 1 hour, refresh tokens 30 days and are
// rotated on every use.
import { z } from 'zod';

// ---- scopes ------------------------------------------------------------------------------------

/**
 * What an app may ask for. Reused from the MCP client scopes (FR-192): `projects:read` is
 * `projects: "*"` and `threads:read` is `threads: "read"` (read_write grants read only there too).
 * The rest are new. Every scope reads only: writes that act with the user's authority (sending a
 * message, running a tool) are not offered, since only user-typed instructions authorize (FR-189);
 * an app that needs tools is added as an MCP client instead. Device scopes belong to device
 * sessions and are not offered to apps.
 */
export const APP_SCOPES = [
  'account:read',
  'projects:read',
  'threads:read',
  'runs:read',
  'memory:read',
  'notifications:read',
  'usage:read',
] as const;
export type AppScope = (typeof APP_SCOPES)[number];

/** The consent page's plain words for each scope. */
export const APP_SCOPE_TEXT: Record<AppScope, { label: string; description: string }> = {
  'account:read': {
    label: 'See your name and picture',
    description: 'Your display name and avatar on this Hub.',
  },
  'projects:read': {
    label: 'See your projects',
    description: 'The names and settings of your projects, not their files.',
  },
  'threads:read': {
    label: 'Read your chats',
    description: 'Your chats, their messages, attachments and artifacts, and chat search.',
  },
  'runs:read': {
    label: 'See your Work runs',
    description: 'Your background runs, their goals and their progress.',
  },
  'memory:read': {
    label: 'Read what Nova remembers',
    description: 'The memory items Nova keeps about you.',
  },
  'notifications:read': {
    label: 'See your notifications',
    description: 'The notifications Nova sent you.',
  },
  'usage:read': {
    label: 'See your usage',
    description: 'Tokens and costs by model and day.',
  },
};

export function isAppScope(s: string): s is AppScope {
  return (APP_SCOPES as readonly string[]).includes(s);
}

export const appScopeSchema = z.enum(APP_SCOPES);

/** Lifetimes (D6): access tokens 1 hour, refresh tokens 30 days (rotated), codes 5 minutes. */
export const APP_ACCESS_TOKEN_TTL_S = 3600;
export const APP_REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
export const APP_CODE_TTL_S = 300;

// ---- registration (POST /api/v1/apps/register, public) ------------------------------------------

/**
 * A redirect URI an app may register: a loopback `http://127.0.0.1[:port]/…` or
 * `http://[::1][:port]/…` (any port matches at request time, RFC 8252 §7.3), or a private-use
 * scheme in reverse-domain form (`com.example.app:/callback`, RFC 8252 §7.1). `localhost`, other
 * http hosts, https web redirects and fragments are refused: browser apps cannot call the Hub API
 * (it sends no CORS headers), so only native apps can complete the flow.
 */
export const appRedirectUriSchema = z.string().trim().min(1).max(500);

const registerNova = z
  .object({
    name: z.string().trim().min(1).max(100),
    redirectUris: z.array(appRedirectUriSchema).min(1).max(10),
    scopes: z.array(appScopeSchema).min(1).max(APP_SCOPES.length),
  })
  .strict();

/** RFC 7591 field names, so generic OAuth libraries can register too. */
const registerRfc = z
  .object({
    client_name: z.string().trim().min(1).max(100),
    redirect_uris: z.array(appRedirectUriSchema).min(1).max(10),
    scope: z.string().trim().min(1).max(500),
    // Accepted and checked: only the values Nova supports.
    token_endpoint_auth_method: z.literal('none').optional(),
    grant_types: z
      .array(z.enum(['authorization_code', 'refresh_token']))
      .max(2)
      .optional(),
    response_types: z.array(z.literal('code')).max(1).optional(),
  })
  .strict();

/** `POST /api/v1/apps/register`: D6's shape or RFC 7591's; both become `{name, redirectUris, scopes}`. */
export const appRegisterSchema = z.union([registerNova, registerRfc]).transform((b, ctx) => {
  if ('name' in b) return { name: b.name, redirectUris: b.redirectUris, scopes: b.scopes };
  const scopes = b.scope.split(/\s+/).filter(Boolean);
  const bad = scopes.filter((s) => !isAppScope(s));
  if (bad.length || !scopes.length) {
    ctx.addIssue({ code: 'custom', path: ['scope'], message: `unknown scope ${bad.join(' ')}` });
    return z.NEVER;
  }
  return {
    name: b.client_name,
    redirectUris: b.redirect_uris,
    scopes: [...new Set(scopes)] as AppScope[],
  };
});
export type AppRegisterRequest = z.output<typeof appRegisterSchema>;

/** 201 answer of register (RFC 7591 §3.2.1 names). */
export interface AppClientRegisteredView {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  scope: string;
  token_endpoint_auth_method: 'none';
  grant_types: ['authorization_code', 'refresh_token'];
  response_types: ['code'];
  client_id_issued_at: number;
}

// ---- consent (GET/POST /api/v1/apps/authorize, owner session) -----------------------------------

/**
 * `GET /api/v1/apps/authorize?<the authorization request's query>`: what the consent page shows.
 * The query is the app's OAuth request as it reached `/authorize` (client_id, redirect_uri,
 * response_type=code, scope, state, code_challenge, code_challenge_method=S256).
 */
export interface AppConsentView {
  client: {
    id: string;
    name: string;
    /** The redirect the answer goes to. */
    redirectUri: string;
    redirectKind: 'loopback' | 'private_scheme';
    registeredAt: string;
  };
  scopes: {
    scope: AppScope;
    label: string;
    description: string;
    /** Already granted to this app by an earlier approval. */
    granted: boolean;
  }[];
  /** The app holds an active authorization of this account already. */
  authorized: boolean;
}

/** `POST /api/v1/apps/authorize`: the decision on the request in `query` (`location.search`). */
export const appAuthorizeDecisionSchema = z
  .object({
    query: z.string().max(4000),
    decision: z.enum(['approve', 'deny']),
    /** The requested scopes the owner kept (default: all requested). */
    scopes: z.array(appScopeSchema).min(1).max(APP_SCOPES.length).optional(),
  })
  .strict();
export type AppAuthorizeDecision = z.infer<typeof appAuthorizeDecisionSchema>;

/** Answer of the decision: where the consent page sends the browser (the app's redirect). */
export interface AppAuthorizeResultView {
  redirectTo: string;
}

// ---- tokens (POST /api/v1/oauth/token and /revoke, public) ---------------------------------------

/** RFC 6749 §4.1.3 with RFC 7636's verifier, and §6 refresh. Form-encoded or JSON. */
export const oauthTokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    code: z.string().min(1).max(200),
    redirect_uri: z.string().min(1).max(500),
    client_id: z.string().min(1).max(100),
    code_verifier: z.string().min(1).max(200),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    refresh_token: z.string().min(1).max(200),
    client_id: z.string().min(1).max(100),
    scope: z.string().max(500).optional(),
  }),
]);
export type OAuthTokenRequest = z.infer<typeof oauthTokenRequestSchema>;

/** RFC 6749 §5.1. */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** RFC 6749 §5.2 error codes the token endpoint answers with. */
export const OAUTH_TOKEN_ERRORS = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
  'slow_down',
] as const;
export type OAuthTokenError = (typeof OAUTH_TOKEN_ERRORS)[number];

/** RFC 7009. A public client names itself with `client_id`. */
export const oauthRevokeRequestSchema = z.object({
  token: z.string().min(1).max(200),
  token_type_hint: z.enum(['access_token', 'refresh_token']).optional(),
  client_id: z.string().min(1).max(100),
});

// ---- the owner's list (GET /api/v1/apps, DELETE /api/v1/apps/:id) --------------------------------

/**
 * `GET /api/v1/apps/pending` (owner): a registered app no one authorizes now. Either it waits for
 * its first approval (it registered itself; `expiresAt` is when the registration lapses) or it
 * does not expire (`expiresAt: null`: the owner registered it, or its authorization was revoked).
 * Never secrets: public clients have none.
 */
export interface AppPendingView {
  clientId: string;
  name: string;
  /** Where its redirects go: a loopback host (with a port when one was registered) or its scheme. */
  redirectHosts: string[];
  /** The scopes it registered for (APP_SCOPE_TEXT has their plain words). */
  scopes: AppScope[];
  registeredAt: string;
  expiresAt: string | null;
}

/** One app the account authorized (an active app authorization of kind `app`). */
export interface AppGrantView {
  /** The app authorization's id (also listed by GET /api/v1/app-authorizations). */
  id: string;
  clientId: string;
  name: string;
  redirectUris: string[];
  scopes: AppScope[];
  /** Live refresh chains (an app signed in on two machines has two). */
  sessions: number;
  createdAt: string;
  lastUsedAt: string | null;
}

// ---- OTLP export (FR-223) -----------------------------------------------------------------------

export const OTLP_SIGNALS = ['traces', 'metrics', 'logs'] as const;
export type OtlpSignal = (typeof OTLP_SIGNALS)[number];

/**
 * The collector's base URL (OTLP/HTTP with JSON; `/v1/traces`, `/v1/metrics`, `/v1/logs` are
 * appended): https, or http only to a loopback collector (docs/16 §1). No credentials, query or
 * fragment in it (headers carry credentials, as vault references).
 */
export const otlpEndpointSchema = z.union([
  z.literal(''),
  z
    .string()
    .max(500)
    .refine((v) => {
      try {
        const u = new URL(v);
        const loopback = /^(localhost|\[::1\]|127(\.\d{1,3}){3})$/i.test(u.hostname);
        const scheme = u.protocol === 'https:' || (u.protocol === 'http:' && loopback);
        return scheme && !u.username && !u.password && !u.search && !u.hash;
      } catch {
        return false;
      }
    }, 'an https:// URL (http:// only to this machine), without credentials, query or fragment'),
]);

/** An HTTP header name a collector may want (`Authorization`, `x-api-key`, ...). */
export const otlpHeaderNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/, 'a header name: letters, digits and hyphens');

/** Where one header's value lives in the vault. */
export function otlpHeaderRef(name: string): string {
  return `secret://telemetry/otlp/header/${name.toLowerCase()}`;
}

/** `telemetry.otlp.headers`: header name -> its vault reference (never the value). */
export const otlpHeadersSettingSchema = z
  .record(
    otlpHeaderNameSchema,
    z
      .string()
      .regex(
        /^secret:\/\/telemetry\/otlp\/header\/[a-z0-9-]{1,64}$/,
        'a secret://telemetry/otlp/header/… reference',
      ),
  )
  .refine((r) => Object.keys(r).length <= 20, 'at most 20 headers');

export const otlpSignalsSchema = z
  .object({ traces: z.boolean(), metrics: z.boolean(), logs: z.boolean() })
  .strict();

/**
 * `PUT /api/v1/telemetry/otlp` (owner): change the export in one call. Header values go to the
 * vault; `null` removes a header; a header not named keeps its value.
 */
export const putOtlpSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpoint: otlpEndpointSchema.optional(),
    headers: z.record(otlpHeaderNameSchema, z.string().min(1).max(4000).nullable()).optional(),
    signals: otlpSignalsSchema.partial().optional(),
    includeContent: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');
export type PutOtlpRequest = z.infer<typeof putOtlpSchema>;

/** `GET /api/v1/telemetry/otlp` (owner): the export's settings and how it is doing. */
export interface OtlpStatusView {
  enabled: boolean;
  endpoint: string;
  /** Header names only; values never leave the vault. */
  headers: { name: string; set: boolean }[];
  signals: Record<OtlpSignal, boolean>;
  includeContent: boolean;
  /** Managed policy forbids export (D4 `restrict.telemetryExport`). */
  managedOff: boolean;
  /** Exporting now: enabled, an endpoint, a signal, and not forbidden. */
  active: boolean;
  queued: Record<OtlpSignal, number>;
  /** Items dropped since the Hub started: a full queue, a refused batch, or a failure. */
  dropped: Record<OtlpSignal, number>;
  sent: Record<OtlpSignal, number>;
  failures: number;
  lastError: string | null;
  lastSuccessAt: string | null;
  nextAttemptAt: string | null;
}

/** `POST /api/v1/telemetry/otlp/test` answer: one log record sent to the collector at once. */
export interface OtlpTestResultView {
  ok: boolean;
  status: number | null;
  error: string | null;
}
