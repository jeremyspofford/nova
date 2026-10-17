// M6 browser API shapes (owned by the browser area; the web reads them). FR-086, FR-092,
// FR-094, FR-095, FR-096, FR-098, FR-103, FR-208, FR-209; docs/11 §4, docs/12 §2.2.
import { z } from 'zod';
import type { ActionEffectClass } from '../api.ts';

/** Per-site permission levels for write actions (docs/11 §4.4, FR-094). */
export const BROWSER_SITE_LEVELS = ['always_ask', 'auto_review', 'always_allow'] as const;
export type BrowserSiteLevel = (typeof BROWSER_SITE_LEVELS)[number];

/** A site entry: on the allow list (with a level) or on the block list. */
export const BROWSER_SITE_ACCESS = ['allow', 'block'] as const;
export type BrowserSiteAccess = (typeof BROWSER_SITE_ACCESS)[number];

export interface BrowserSiteView {
  /** A host (`example.com`) or a leftmost wildcard (`*.example.com`). */
  pattern: string;
  access: BrowserSiteAccess;
  /** Null for blocked sites. */
  level: BrowserSiteLevel | null;
  /** Developer-protocol mode: off by default, never on a blocked site (FR-094). */
  devProtocol: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserDomainsView {
  allow: string[];
  deny: string[];
}

export interface BrowserStatusView {
  /** A browser can be launched on this Hub (Chromium found and starts). */
  available: boolean;
  detail: string;
  driver: string;
  /** Traffic goes through the egress proxy (docs/12 §8); without it the browser stays closed. */
  egress: 'wired' | 'missing' | 'not_required';
}

export const BROWSER_SESSION_STATES = ['starting', 'running', 'paused', 'closed', 'error'] as const;
export type BrowserSessionState = (typeof BROWSER_SESSION_STATES)[number];

export interface BrowserSessionView {
  computerId: string;
  state: BrowserSessionState;
  url: string | null;
  title: string | null;
  host: string | null;
  /** Who holds control while paused (takeover, FR-087). */
  pausedBy: string | null;
  /** Tools the current page registered (FR-208), as `page:<host>.<name>`. */
  pageTools: string[];
  startedAt: string;
  lastActionAt: string | null;
  /** The cookies of this profile survive a restart only with `browser.persistCookies`. */
  persistCookies: boolean;
}

export const BROWSER_ACTION_RESULTS = ['ok', 'error', 'blocked', 'denied', 'handoff'] as const;
export type BrowserActionResult = (typeof BROWSER_ACTION_RESULTS)[number];

/** What the page-action classifier found (FR-095). */
export interface BrowserClassificationView {
  /** Effect classes the action was given; any class means the action was flagged. */
  effects: ActionEffectClass[];
  flagged: boolean;
  /** Why, in plain words ("looks like a purchase"). */
  reasons: string[];
  /** The user must do this step (CAPTCHA, a verification code). */
  handoff: boolean;
}

/** One recorded browser action for the Activity trace (FR-098). */
export interface BrowserActionView {
  id: string;
  computerId: string;
  threadId: string | null;
  turnId: string | null;
  callId: string | null;
  tool: string;
  action: string;
  /** The element acted on (role and name), redacted. */
  target: string | null;
  url: string | null;
  host: string | null;
  result: BrowserActionResult;
  error: string | null;
  classification: BrowserClassificationView | null;
  /** Before/after screenshots exist (GET /browser/actions/:id/screenshots/before|after). */
  before: boolean;
  after: boolean;
  approvalId: string | null;
  createdAt: string;
}

export const BROWSER_SIGNIN_STATES = ['pending', 'completed', 'cancelled', 'expired'] as const;
export type BrowserSigninState = (typeof BROWSER_SIGNIN_STATES)[number];

/** A private sign-in form the agent asked for (FR-086); credentials never reach the model. */
export interface BrowserSigninView {
  id: string;
  computerId: string;
  threadId: string | null;
  host: string;
  url: string | null;
  state: BrowserSigninState;
  /** Saved logins for this host; reusing one needs the user's confirmation. */
  savedLogins: { id: string; username: string }[];
  createdAt: string;
  expiresAt: string;
}

/** A saved login: the password lives in the vault only (`secret://browser/login/<id>`). */
export interface BrowserLoginView {
  id: string;
  host: string;
  username: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// ---- request bodies -------------------------------------------------------------------------

/**
 * A site pattern: a host name or a leftmost wildcard, lower-cased; no scheme, port or path and
 * never a bare `*` (docs/12 §8).
 */
export const browserSitePatternSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$|^\[[0-9a-f:.]+\]$/,
    'a host name such as example.com or *.example.com',
  );

export const putBrowserSiteSchema = z
  .object({
    pattern: browserSitePatternSchema,
    access: z.enum(BROWSER_SITE_ACCESS).default('allow'),
    level: z.enum(BROWSER_SITE_LEVELS).optional(),
    devProtocol: z.boolean().optional(),
  })
  .strict();
export type PutBrowserSiteRequest = z.input<typeof putBrowserSiteSchema>;

export const patchBrowserSiteSchema = z
  .object({
    level: z.enum(BROWSER_SITE_LEVELS).optional(),
    devProtocol: z.boolean().optional(),
  })
  .strict();
export type PatchBrowserSiteRequest = z.infer<typeof patchBrowserSiteSchema>;

export const putBrowserDomainsSchema = z
  .object({
    allow: z.array(browserSitePatternSchema).max(500).optional(),
    deny: z.array(browserSitePatternSchema).max(500).optional(),
  })
  .strict();
export type PutBrowserDomainsRequest = z.infer<typeof putBrowserDomainsSchema>;

/**
 * The private sign-in form's answer (FR-086): typed credentials (optionally saved to the vault),
 * or a saved login the user confirms. Sent to the browser area only; never echoed or stored.
 */
export const submitBrowserSigninSchema = z.union([
  z
    .object({
      username: z.string().min(1).max(500),
      password: z.string().min(1).max(1000),
      save: z.boolean().default(false),
    })
    .strict(),
  z.object({ loginId: z.string().min(1).max(100), confirm: z.literal(true) }).strict(),
]);
export type SubmitBrowserSigninRequest = z.input<typeof submitBrowserSigninSchema>;

export const browserActionsQuerySchema = z
  .object({
    threadId: z.string().min(1).max(100).optional(),
    callId: z.string().min(1).max(200).optional(),
    computerId: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
