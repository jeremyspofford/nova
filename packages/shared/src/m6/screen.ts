// M6 screen API shapes (owned by the screen area; the web reads them): computer use with control
// tiers, grants, the kill key and the control indicator (FR-093, FR-207), recorded actions with
// before/after screenshots (FR-098), takeover (FR-087) and appshots (FR-075).
import { z } from 'zod';
import { idSchema } from '../api.ts';

export const SCREEN_CONTROL_TIERS = ['none', 'view', 'click', 'full'] as const;
/** What the agent may do in an app (docs/11 §5.1); `none` apps are handled by the user. */
export type ScreenControlTier = (typeof SCREEN_CONTROL_TIERS)[number];

export const SCREEN_CONTROL_STATES = [
  'disabled',
  'idle',
  'controlling',
  'stopped',
  'taken_over',
] as const;
/**
 * `disabled`: computer use is off for the computer; `idle`: on, no app granted; `controlling`:
 * the agent may act in a granted app (the indicator shows); `stopped`: the kill key stopped
 * control until the user resumes it; `taken_over`: the user has the keyboard and mouse.
 */
export type ScreenControlState = (typeof SCREEN_CONTROL_STATES)[number];

export const DEFAULT_SCREEN_GRANT_MINUTES = 30;
export const DEFAULT_SCREEN_KILL_KEY = 'Escape';

export interface ScreenRectView {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenGrantView {
  id: string;
  computerId: string;
  app: string;
  /** The app's tier when the grant was made. */
  tier: ScreenControlTier;
  grantedBy: string;
  threadId: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  active: boolean;
  remainingSeconds: number;
}

export interface ScreenTakeoverView {
  id: string;
  computerId: string;
  surface: 'desktop' | 'browser';
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  /** returned | restart */
  endReason: string | null;
  inputCount: number;
}

/** The control indicator the clients show while the agent controls the screen (FR-207). */
export interface ScreenIndicatorView {
  visible: boolean;
  apps: string[];
  /** "Nova is controlling Expense Form · Escape to stop", or null when hidden. */
  text: string | null;
  killKey: string;
}

export interface ScreenStatusView {
  computerId: string;
  enabled: boolean;
  state: ScreenControlState;
  stoppedAt: string | null;
  /** user | key | system */
  stoppedBy: string | null;
  grants: ScreenGrantView[];
  takeover: ScreenTakeoverView | null;
  indicator: ScreenIndicatorView;
  lastActionAt: string | null;
  activeApp: string | null;
}

export interface ScreenWindowView {
  id: string;
  app: string;
  title: string;
  focused: boolean;
  /** The tier the agent gets in this app (the lowest of class, name and user override). */
  tier: ScreenControlTier;
  bounds: ScreenRectView | null;
  granted: boolean;
}

export interface ScreenObservationView {
  computerId: string;
  width: number;
  height: number;
  takenAt: string;
  windows: ScreenWindowView[];
  /** Accessibility tree summary; untrusted content (FR-103). */
  tree: string;
  mime: 'image/png';
  /** Base64 PNG. */
  image: string;
}

export const SCREEN_ACTION_KINDS = ['click', 'scroll', 'type', 'key', 'drag'] as const;
export type ScreenActionKindName = (typeof SCREEN_ACTION_KINDS)[number];

export interface ScreenActionView {
  id: string;
  computerId: string;
  /** user | system | agent:<id> */
  actor: string;
  origin: 'tool' | 'takeover';
  kind: ScreenActionKindName;
  /** Redacted arguments: typed text is kept as its length only. */
  args: Record<string, unknown>;
  app: string | null;
  windowTitle: string | null;
  tier: ScreenControlTier | null;
  status: 'ok' | 'refused' | 'failed' | 'stopped';
  error: { code: string; message: string } | null;
  threadId: string | null;
  turnId: string | null;
  callId: string | null;
  takeoverId: string | null;
  /** Before/after screenshots (FR-098) at `/computers/:id/screen/actions/:actionId/{before,after}`. */
  hasBefore: boolean;
  hasAfter: boolean;
  createdAt: string;
  completedAt: string | null;
}

export interface AppshotView {
  id: string;
  computerId: string;
  /** The image artifact (kind `image`, PNG); its bytes are at `/artifacts/:id/content`. */
  artifactId: string;
  source: 'window' | 'screen' | 'browser';
  app: string | null;
  windowTitle: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
  threadId: string | null;
  capturedBy: string;
  capturedAt: string;
}

// ---- requests --------------------------------------------------------------------------------

const coord = z.number().int().min(0).max(100_000);
/** Key combinations: `Enter`, `Tab`, `ctrl+s`, `ctrl+shift+t`. */
export const SCREEN_KEYS_PATTERN = /^[A-Za-z0-9]+([+ ][A-Za-z0-9]+){0,4}$/;

export const screenInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('click'),
      x: coord,
      y: coord,
      button: z.enum(['left', 'right']).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      x: coord,
      y: coord,
      dy: z.number().int().min(-10_000).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(10_000) }).strict(),
  z
    .object({ kind: z.literal('key'), keys: z.string().max(60).regex(SCREEN_KEYS_PATTERN) })
    .strict(),
  z
    .object({ kind: z.literal('drag'), from: z.tuple([coord, coord]), to: z.tuple([coord, coord]) })
    .strict(),
]);
export type ScreenInput = z.infer<typeof screenInputSchema>;

/** Pointer and key input to the agent's browser page while the user has taken it over (FR-087). */
export const takeoverBrowserInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), x: coord, y: coord }).strict(),
  z.object({ kind: z.literal('type'), text: z.string().min(1).max(10_000) }).strict(),
  z.object({ kind: z.literal('key'), key: z.string().max(60).regex(SCREEN_KEYS_PATTERN) }).strict(),
  z.object({ kind: z.literal('scroll'), dy: z.number().int().min(-10_000).max(10_000) }).strict(),
]);

export const screenControlSchema = z.object({ enabled: z.boolean() }).strict();

export const screenGrantSchema = z
  .object({
    app: z.string().trim().min(1).max(200),
    /** Shorter or longer than the default; at most a day. */
    minutes: z.number().int().min(1).max(1_440).optional(),
    threadId: idSchema.optional(),
  })
  .strict();

export const screenGrantsQuerySchema = z.object({
  /** Also list expired and revoked grants. */
  all: z.enum(['true', 'false', '1', '0']).optional(),
});

export const screenActionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Only actions created before this action id (paging back). */
  before: idSchema.optional(),
});

export const takeoverStartSchema = z
  .object({ surface: z.enum(['desktop', 'browser']).default('desktop') })
  .strict();

export const takeoverInputSchema = z.union([
  z.object({ action: screenInputSchema }).strict(),
  z.object({ browser: takeoverBrowserInputSchema }).strict(),
]);

export const appshotCreateSchema = z
  .object({
    source: z.enum(['window', 'screen', 'browser']).default('window'),
    /** A window id from an observation; without it, the window of `app` or the focused one. */
    windowId: z.string().min(1).max(200).optional(),
    app: z.string().trim().min(1).max(200).optional(),
    threadId: idSchema.optional(),
  })
  .strict();

export const appshotsQuerySchema = z.object({
  computerId: idSchema.optional(),
  threadId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
