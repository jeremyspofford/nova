// The screen service (FR-093, FR-207, FR-098, FR-087, FR-075; docs/11 §4.2, §5, §6): computer
// use on a computer's controlled desktop with the Hub as the enforcement point.
//
// - Explicit enablement per computer; the kill key stops control at once (the in-flight input is
//   aborted, the controller handle is killed and dropped, queued input is refused) and control
//   stays stopped until the user resumes it; the work driving the computer is paused through the
//   late-bound control hooks.
// - Control tiers per app (tiers.ts) and per-app grants made only by the user (30 minutes by
//   default, renewable, revocable); coordinates are validated against the last observation.
// - Every input action is recorded with before/after screenshots (attachment blobs, encrypted at
//   rest) and audited (kind `screen`); refusals are recorded too.
// - Takeover: the user takes the keyboard and mouse; the agent's actions wait until control is
//   returned, and the agent must observe again before acting.
// - Appshots: a window, the screen or the browser page saved as an image artifact.
//
// A real desktop plugs in behind the same `ScreenController` seam: the computers area's
// `local_host` computer returns a controller that forwards observe/act/kill to novad's screen
// module (`local.screen`), which classifies apps by verified identity, masks sensitive regions
// (refusing the observation when masking fails), hides Nova's windows, guards the clipboard and
// handles the physical kill key; novad reports a local kill to the Hub, which calls
// `kill(accountId, computerId, 'key')`.
import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, lt, or, isNotNull, sql } from 'drizzle-orm';
import {
  NovaError,
  uuidv7,
  type AppshotView,
  type ScreenActionView,
  type ScreenControlState,
  type ScreenGrantView,
  type ScreenObservationView,
  type ScreenStatusView,
  type ScreenTakeoverView,
  type ScreenWindowView,
} from '@nova/shared';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import { readAttachmentBlob, writeAttachmentBlob } from '../attachments.ts';
import type {
  BrowserController,
  Computer,
  ComputerProvider,
  ScreenAction,
  ScreenController,
  ScreenObservation,
  ScreenWindow,
} from '../computers/types.ts';
import type { EventSink } from '../events.ts';
import { removeUnreferencedBlobs } from '../purge.ts';
import { ArtifactService } from '../tools/artifacts.ts';
import { noopAudit, type AuditRecord, type AuditSink } from '../tools/types.ts';
import { cropPng, pngSize, type ScreenRect } from './png.ts';
import {
  allowedAt,
  describeAction,
  effectiveTier,
  TIER_LABEL,
  tierRefusal,
  type ControlTier,
} from './tiers.ts';

const { screenAction, screenAppshot, screenControl, screenGrant, screenTakeover, thread } = schema;

/** Actions are checked against an observation at most this old (docs/11 §5). */
export const OBSERVATION_MAX_AGE_MS = 120_000;
/** Agent screenshots at most one per 2 s (docs/11 §8). */
export const OBSERVE_INTERVAL_MS = 2_000;
/** One input event never takes longer than this. */
const ACT_TIMEOUT_MS = 30_000;

export interface ScreenSettings {
  grantMinutes(): Promise<number>;
  killKey(): Promise<string>;
  tierOverrides(): Promise<Record<string, ControlTier>>;
}

export type ScreenPauseReason = 'takeover' | 'kill';

/**
 * Pauses and resumes the work driving a computer (the agent and its runs) when the user takes
 * over or presses the kill key; the agents and runs areas implement it.
 */
export interface ScreenControlHooks {
  pause(input: { accountId: string; computerId: string; reason: ScreenPauseReason }): Promise<void>;
  resume(input: {
    accountId: string;
    computerId: string;
    reason: ScreenPauseReason;
  }): Promise<void>;
}

export interface ScreenServiceOptions {
  db: NovaDatabase;
  events: EventSink;
  dataDir: string;
  audit?: AuditSink;
  computers?: ComputerProvider | null;
  artifacts?: ArtifactService;
  settings?: Partial<ScreenSettings>;
  control?: ScreenControlHooks | null;
  now?: () => Date;
  log?: Logger;
  observationMaxAgeMs?: number;
  observeIntervalMs?: number;
}

/** Who acts and for which call: a tool call of the agent, with its thread correlation. */
export interface ScreenCaller {
  accountId: string;
  computerId: string;
  /** `system` or `agent:<id>`. */
  actor: string;
  threadId?: string | null;
  turnId?: string | null;
  callId?: string | null;
  signal: AbortSignal;
}

export interface ScreenRefusal {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ScreenOutcome<T> = { ok: true; value: T } | { ok: false; error: ScreenRefusal };

export interface ScreenActResult {
  action: ScreenActionView;
  /** The screen after the action, or null when it could not be observed. */
  after: ScreenObservationView | null;
}

/** Pointer and key input to the browser page while the user has control (FR-087). */
export type BrowserTakeoverEvent =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'scroll'; dy: number };

export type TakeoverInput = { action: ScreenAction } | { browser: BrowserTakeoverEvent };

/**
 * The takeover hooks the browser area's controller adds to the seam: while paused, the agent's
 * browser writes wait, and the user's own input goes to the page.
 */
interface TakeoverBrowser extends BrowserController {
  pause(by: string): Promise<void> | void;
  resume(): void;
  input(event: BrowserTakeoverEvent): Promise<void>;
}

function takeoverBrowser(b: BrowserController | null): TakeoverBrowser | null {
  const t = b as Partial<TakeoverBrowser> | null;
  return t &&
    typeof t.pause === 'function' &&
    typeof t.resume === 'function' &&
    typeof t.input === 'function'
    ? (t as TakeoverBrowser)
    : null;
}

export interface AppshotInput {
  accountId: string;
  computerId: string;
  source: 'window' | 'screen' | 'browser';
  windowId?: string | undefined;
  app?: string | undefined;
  threadId?: string | null | undefined;
  messageId?: string | null | undefined;
  turnId?: string | null | undefined;
  /** `user`, `system` or `agent:<id>`. */
  actor: string;
}

interface GeoWindow {
  id: string;
  app: string;
  title: string;
  focused: boolean;
  /** The tier the controller reported. */
  tier: ControlTier;
  bounds: ScreenRect | null;
}

interface LastObservation {
  windows: GeoWindow[];
  width: number;
  height: number;
  takenAt: number;
}

interface Live {
  agent: ScreenController | null;
  /** The user's handle: the live view, appshots and takeover input. */
  user: ScreenController | null;
  /** Aborted by the kill key, disabling and a takeover: in-flight agent input stops. */
  epoch: AbortController;
  /** Set by the kill key before anything else, so queued input is refused at once. */
  stopped: boolean;
  last: LastObservation | null;
  lastObserveAt: number | null;
  takeover: {
    id: string;
    surface: 'desktop' | 'browser';
    waiters: Set<() => void>;
    /** The paused browser of a browser takeover. */
    browser: TakeoverBrowser | null;
  } | null;
  chain: Promise<unknown>;
  lastActionAt: string | null;
  activeApp: string | null;
}

type GrantRow = typeof screenGrant.$inferSelect;
type ActionRow = typeof screenAction.$inferSelect;
type TakeoverRow = typeof screenTakeover.$inferSelect;
type AppshotRow = typeof screenAppshot.$inferSelect;

const sameApp = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The geometry a controller reports on a window (the mock and novad do; the seam may not). */
export function windowBounds(w: ScreenWindow): ScreenRect | null {
  const b = (w as ScreenWindow & { bounds?: unknown }).bounds;
  if (typeof b !== 'object' || b === null) return null;
  const r = b as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const x = n(r.x);
  const y = n(r.y);
  const width = n(r.width);
  const height = n(r.height);
  if (x === null || y === null || width === null || height === null) return null;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

const contains = (r: ScreenRect, x: number, y: number) =>
  x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;

/** The points a pointer action touches. */
function pointsOf(a: ScreenAction): [number, number][] {
  switch (a.kind) {
    case 'click':
    case 'scroll':
      return [[a.x, a.y]];
    case 'drag':
      return [a.from, a.to];
    case 'type':
    case 'key':
      return [];
  }
}

/** Typed text is never stored or audited: only its length (FR-101). */
export function redactScreenAction(a: ScreenAction): Record<string, unknown> {
  return a.kind === 'type' ? { kind: 'type', chars: a.text.length } : { ...a };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class ScreenService {
  readonly #db: NovaDatabase;
  readonly #events: EventSink;
  readonly #dataDir: string;
  readonly #audit: AuditSink;
  readonly #artifacts: ArtifactService;
  readonly #settings: ScreenSettings;
  readonly #now: () => Date;
  readonly #log: Logger;
  readonly #maxAge: number;
  readonly #interval: number;
  readonly #live = new Map<string, Live>();
  readonly #listeners = new Set<(accountId: string, computerId: string) => void>();
  #computers: ComputerProvider | null;
  #control: ScreenControlHooks | null;

  constructor(opts: ScreenServiceOptions) {
    this.#db = opts.db;
    this.#events = opts.events;
    this.#dataDir = opts.dataDir;
    this.#audit = opts.audit ?? noopAudit;
    this.#now = opts.now ?? (() => new Date());
    this.#artifacts =
      opts.artifacts ??
      new ArtifactService({
        db: opts.db,
        events: opts.events,
        dataDir: opts.dataDir,
        now: this.#now,
      });
    this.#settings = {
      grantMinutes: opts.settings?.grantMinutes ?? (() => Promise.resolve(30)),
      killKey: opts.settings?.killKey ?? (() => Promise.resolve('Escape')),
      tierOverrides: opts.settings?.tierOverrides ?? (() => Promise.resolve({})),
    };
    this.#log = opts.log ?? new Logger({ module: 'core.screen', sinks: [] });
    this.#maxAge = opts.observationMaxAgeMs ?? OBSERVATION_MAX_AGE_MS;
    this.#interval = opts.observeIntervalMs ?? OBSERVE_INTERVAL_MS;
    this.#computers = opts.computers ?? null;
    this.#control = opts.control ?? null;
  }

  /** Where computers come from (the computers area), bound late. */
  useComputers(provider: ComputerProvider): void {
    this.#computers = provider;
  }

  /** Pause and resume the agent driving a computer (the agents and runs areas), bound late. */
  useControl(hooks: ScreenControlHooks): void {
    this.#control = hooks;
  }

  /** Called whenever a computer's control state, grants or takeover change (the live view). */
  onChange(fn: (accountId: string, computerId: string) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  // ---- status, enablement, kill key -----------------------------------------------------------

  async status(accountId: string, computerId: string): Promise<ScreenStatusView> {
    await this.#ownComputer(accountId, computerId);
    const [ctl, grants, takeover, killKey] = await Promise.all([
      this.#controlRow(accountId, computerId),
      this.#grants(accountId, computerId, false),
      this.#openTakeover(accountId, computerId),
      this.#settings.killKey(),
    ]);
    const state = this.#stateOf(ctl, grants, takeover);
    const live = this.#live.get(key(accountId, computerId));
    const apps = [...new Set(grants.map((g) => g.app))].sort((a, b) => a.localeCompare(b));
    const visible = state === 'controlling';
    return {
      computerId,
      enabled: ctl?.enabled ?? false,
      state,
      stoppedAt: ctl?.stoppedAt ?? null,
      stoppedBy: ctl?.stoppedBy ?? null,
      grants: grants.map((g) => this.#grantView(g)),
      takeover: takeover ? toTakeoverView(takeover) : null,
      indicator: {
        visible,
        apps: visible ? apps : [],
        text: visible ? `Nova is controlling ${apps.join(', ')} · ${killKey} to stop` : null,
        killKey,
      },
      lastActionAt: live?.lastActionAt ?? null,
      activeApp: live?.activeApp ?? null,
    };
  }

  /** The explicit enablement toggle (FR-093). Turning it off stops control like the kill key. */
  async setEnabled(
    accountId: string,
    computerId: string,
    enabled: boolean,
  ): Promise<ScreenStatusView> {
    await this.#ownComputer(accountId, computerId);
    if (!enabled) await this.#stopAgent(accountId, computerId);
    const before = await this.#state(accountId, computerId);
    const now = this.#iso();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .insert(screenControl)
        .values({ computerId, accountId, enabled, updatedAt: now })
        .onConflictDoUpdate({ target: screenControl.computerId, set: { enabled, updatedAt: now } });
    });
    await this.#auditAppend({
      accountId,
      actor: 'user',
      kind: 'screen',
      action: enabled ? 'screen.control.enabled' : 'screen.control.disabled',
      resource: `computer:${computerId}`,
      result: 'ok',
    });
    await this.#changed(accountId, computerId, before);
    return this.status(accountId, computerId);
  }

  /**
   * The kill key (FR-207): stop control at once. The in-flight input is aborted, the agent's
   * controller handle is killed and dropped, queued input is refused, and control stays stopped
   * (the run paused) until the user resumes it. `by`: the API (`user`), the key on a device
   * (`key`) or a safety stop (`system`).
   */
  async kill(
    accountId: string,
    computerId: string,
    by: 'user' | 'key' | 'system' = 'user',
  ): Promise<ScreenStatusView> {
    // First stop delivery, then check and record: the kill must not wait on anything.
    const live = this.#liveOf(accountId, computerId);
    const wasStopped = live.stopped;
    live.stopped = true;
    await this.#stopAgent(accountId, computerId);
    try {
      await this.#ownComputer(accountId, computerId);
    } catch (err) {
      live.stopped = wasStopped;
      throw err;
    }
    const before = await this.#state(accountId, computerId);
    const now = this.#iso();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .insert(screenControl)
        .values({
          computerId,
          accountId,
          enabled: false,
          stoppedAt: now,
          stoppedBy: by,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: screenControl.computerId,
          set: { stoppedAt: now, stoppedBy: by, updatedAt: now },
        });
    });
    await this.#auditAppend({
      accountId,
      actor: by === 'system' ? 'system' : 'user',
      kind: 'screen',
      action: 'screen.kill',
      resource: `computer:${computerId}`,
      result: 'ok',
      detail: { by },
    });
    await this.#hook('pause', accountId, computerId, 'kill');
    await this.#changed(accountId, computerId, before, by === 'system' ? 'system' : 'user');
    return this.status(accountId, computerId);
  }

  /** Resume control after the kill key (the user's "Resume control"). */
  async resumeControl(accountId: string, computerId: string): Promise<ScreenStatusView> {
    await this.#ownComputer(accountId, computerId);
    const ctl = await this.#controlRow(accountId, computerId);
    const live = this.#liveOf(accountId, computerId);
    if (!ctl?.stoppedAt) {
      live.stopped = false;
      return this.status(accountId, computerId);
    }
    const before = await this.#state(accountId, computerId);
    live.stopped = false;
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(screenControl)
        .set({ stoppedAt: null, stoppedBy: null, updatedAt: this.#iso() })
        .where(
          and(eq(screenControl.computerId, computerId), eq(screenControl.accountId, accountId)),
        );
    });
    await this.#auditAppend({
      accountId,
      actor: 'user',
      kind: 'screen',
      action: 'screen.resume',
      resource: `computer:${computerId}`,
      result: 'ok',
    });
    await this.#hook('resume', accountId, computerId, 'kill');
    await this.#changed(accountId, computerId, before);
    return this.status(accountId, computerId);
  }

  // ---- grants (FR-207, docs/12 §4.2) ----------------------------------------------------------

  /** The tier the agent gets in an app on this computer now. */
  async appTier(accountId: string, computerId: string, app: string): Promise<ControlTier> {
    const overrides = await this.#overrides();
    const seen = this.#live
      .get(key(accountId, computerId))
      ?.last?.windows.find((w) => sameApp(w.app, app));
    return effectiveTier(app, seen?.tier ?? 'full', overrides);
  }

  /** A grant made by the user; an active grant for the same app is renewed instead. */
  async grant(
    accountId: string,
    computerId: string,
    input: { app: string; minutes?: number | undefined; threadId?: string | null | undefined },
  ): Promise<ScreenGrantView> {
    await this.#ownComputer(accountId, computerId);
    const app = input.app.trim();
    const tier = await this.appTier(accountId, computerId, app);
    if (tier === 'none')
      throw new NovaError(
        'policy_denied',
        `${app} is never controlled by Nova; do this step yourself.`,
        {
          details: { app, tier },
        },
      );
    const minutes = input.minutes ?? (await this.#settings.grantMinutes());
    const existing = (await this.#grants(accountId, computerId, false)).find((g) =>
      sameApp(g.app, app),
    );
    if (existing) return this.renewGrant(accountId, computerId, existing.id, minutes);
    const before = await this.#state(accountId, computerId);
    const now = this.#now();
    const row: GrantRow = {
      id: uuidv7(),
      accountId,
      computerId,
      app,
      tier,
      grantedBy: 'user',
      threadId: input.threadId ?? null,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
      renewedAt: null,
      revokedAt: null,
    };
    await this.#db.transaction(async () => {
      await this.#db.orm.insert(screenGrant).values(row);
    });
    await this.#grantChanged(row, 'screen.grant.created', 'active', before);
    return this.#grantView(row);
  }

  /** Renew a grant from the indicator: it runs for the full lifetime again. */
  async renewGrant(
    accountId: string,
    computerId: string,
    grantId: string,
    minutes?: number,
  ): Promise<ScreenGrantView> {
    const row = await this.#grantRow(accountId, computerId, grantId);
    if (row.revokedAt)
      throw new NovaError('conflict', 'that grant was revoked; grant the app again');
    const before = await this.#state(accountId, computerId);
    const now = this.#now();
    const m = minutes ?? (await this.#settings.grantMinutes());
    const next = {
      expiresAt: new Date(now.getTime() + m * 60_000).toISOString(),
      renewedAt: now.toISOString(),
    };
    await this.#db.transaction(async () => {
      await this.#db.orm.update(screenGrant).set(next).where(eq(screenGrant.id, grantId));
    });
    const updated = { ...row, ...next };
    await this.#grantChanged(updated, 'screen.grant.renewed', 'active', before);
    return this.#grantView(updated);
  }

  async revokeGrant(
    accountId: string,
    computerId: string,
    grantId: string,
  ): Promise<ScreenGrantView> {
    const row = await this.#grantRow(accountId, computerId, grantId);
    if (row.revokedAt) return this.#grantView(row);
    const before = await this.#state(accountId, computerId);
    const revokedAt = this.#iso();
    await this.#db.transaction(async () => {
      await this.#db.orm.update(screenGrant).set({ revokedAt }).where(eq(screenGrant.id, grantId));
    });
    const updated = { ...row, revokedAt };
    await this.#grantChanged(updated, 'screen.grant.revoked', 'revoked', before);
    return this.#grantView(updated);
  }

  async listGrants(accountId: string, computerId: string, all = false): Promise<ScreenGrantView[]> {
    await this.#ownComputer(accountId, computerId);
    return (await this.#grants(accountId, computerId, all)).map((g) => this.#grantView(g));
  }

  // ---- the agent: observe and act (FR-093, FR-207, FR-098) ------------------------------------

  /** `screen.observe`: a screenshot and the accessibility tree; the base for later actions. */
  async observe(c: ScreenCaller): Promise<ScreenOutcome<ScreenObservationView>> {
    const live = this.#liveOf(c.accountId, c.computerId);
    if (!(await this.#waitForTakeover(live, c.signal))) return cancelled();
    const blocked = await this.#blocked(c.accountId, c.computerId);
    if (blocked) return { ok: false, error: blocked };
    const now = this.#now().getTime();
    if (live.lastObserveAt !== null && now - live.lastObserveAt < this.#interval) {
      const retryAfterMs = this.#interval - (now - live.lastObserveAt);
      return {
        ok: false,
        error: {
          code: 'rate_limited',
          message: `Screenshots are limited to one every ${this.#interval / 1000} s; try again in ${Math.ceil(retryAfterMs / 1000)} s.`,
          details: { retryAfterMs },
        },
      };
    }
    const handle = await this.#agentHandle(c.accountId, c.computerId, live);
    if ('code' in handle) return { ok: false, error: handle };
    const shot = await this.#capture(handle, false);
    if ('code' in shot) return { ok: false, error: shot };
    live.last = shot.geo;
    live.lastObserveAt = now;
    return {
      ok: true,
      value: await this.#observationView(c.accountId, c.computerId, shot.obs, shot.geo),
    };
  }

  /** One input action of the agent, checked, delivered and recorded. */
  async act(c: ScreenCaller, action: ScreenAction): Promise<ScreenOutcome<ScreenActResult>> {
    const live = this.#liveOf(c.accountId, c.computerId);
    // The agent pauses while the user has control (FR-087).
    if (!(await this.#waitForTakeover(live, c.signal))) return cancelled();
    const run = live.chain.then(
      () => this.#act(c, live, action),
      () => this.#act(c, live, action),
    );
    live.chain = run.catch(() => undefined);
    return run;
  }

  async #act(
    c: ScreenCaller,
    live: Live,
    action: ScreenAction,
  ): Promise<ScreenOutcome<ScreenActResult>> {
    // A takeover may have started while this action waited for the one before it.
    if (!(await this.#waitForTakeover(live, c.signal))) return cancelled();
    const started = this.#iso();
    const refuse = async (
      error: ScreenRefusal,
      target?: { app: string; title: string; tier: ControlTier },
    ): Promise<ScreenOutcome<ScreenActResult>> => {
      await this.#record(c, action, {
        status: 'refused',
        error,
        target: target ?? null,
        before: null,
        after: null,
        createdAt: started,
      });
      return { ok: false, error };
    };
    const blocked = await this.#blocked(c.accountId, c.computerId);
    if (blocked) return refuse(blocked);
    const last = live.last;
    if (!last)
      return refuse({
        code: 'observation_required',
        message: 'Call screen.observe first: every action is checked against the last observation.',
      });
    if (this.#now().getTime() - last.takenAt > this.#maxAge)
      return refuse({
        code: 'observation_stale',
        message: `The last observation is older than ${Math.round(this.#maxAge / 1000)} s; call screen.observe again.`,
      });
    const points = pointsOf(action);
    for (const [x, y] of points) {
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= last.width ||
        y >= last.height
      )
        return refuse({
          code: 'coordinates_invalid',
          message: `(${x}, ${y}) is outside the ${last.width}x${last.height} screen of the last observation.`,
          details: { width: last.width, height: last.height },
        });
    }
    // Who receives the input: the window under each point (windows come front first), or the
    // frontmost window for keys and text, or when the controller reports no geometry.
    const focused = last.windows.find((w) => w.focused) ?? null;
    const geometry = last.windows.some((w) => w.bounds);
    const receivers: GeoWindow[] = [];
    for (const [x, y] of points) {
      const under = geometry
        ? (last.windows.find((w) => w.bounds && contains(w.bounds, x, y)) ?? null)
        : focused;
      if (!under)
        return refuse({
          code: 'no_target',
          message: `There is no app window at (${x}, ${y}); observe the screen and pick a point inside a window.`,
        });
      receivers.push(under);
    }
    if (!points.length) {
      if (!focused)
        return refuse({
          code: 'no_target',
          message: 'No app window is in front to receive the input; click into the app first.',
        });
      receivers.push(focused);
    }
    const primary = receivers[0]!;
    // The frontmost app's tier is checked before every input event, and so is every receiver's.
    const checked = [...new Set([...receivers, ...(focused ? [focused] : [])])];
    const overrides = await this.#overrides();
    const tierOf = (w: GeoWindow) => effectiveTier(w.app, w.tier, overrides);
    for (const w of checked) {
      const tier = tierOf(w);
      if (!allowedAt(tier, action))
        return refuse(tierRefusal(w.app, tier, action), { app: w.app, title: w.title, tier });
    }
    const target = { app: primary.app, title: primary.title, tier: tierOf(primary) };
    // Only apps the user granted receive input (FR-207).
    const grants = await this.#grants(c.accountId, c.computerId, false);
    const missing = [...new Set(receivers.map((w) => w.app))].filter(
      (app) => !grants.some((g) => sameApp(g.app, app)),
    );
    if (missing.length)
      return refuse(
        {
          code: 'screen_grant_required',
          message: `Nova has no grant to control ${missing.join(', ')}. Ask the user with screen.request_access first.`,
          details: { apps: missing, tool: 'screen.request_access' },
        },
        target,
      );
    const handle = await this.#agentHandle(c.accountId, c.computerId, live);
    if ('code' in handle) return refuse(handle, target);
    const epoch = live.epoch;
    const before = await this.#capture(handle);
    if ('code' in before) return refuse(before, target);
    if (epoch.signal.aborted || c.signal.aborted) {
      const error = {
        code: 'screen_stopped',
        message: 'Control was stopped before the input was sent.',
      };
      await this.#record(c, action, {
        status: 'stopped',
        error,
        target,
        before: before.blob,
        after: null,
        createdAt: started,
      });
      return { ok: false, error };
    }
    let result: { ok: boolean; error?: string };
    try {
      result = await handle.act(
        action,
        AbortSignal.any([c.signal, epoch.signal, AbortSignal.timeout(ACT_TIMEOUT_MS)]),
      );
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const stopped = epoch.signal.aborted;
    const after = await this.#capture(handle);
    const afterOk = 'code' in after ? null : after;
    if (afterOk && !stopped) live.last = afterOk.geo;
    live.lastActionAt = this.#iso();
    live.activeApp = target.app;
    const error: ScreenRefusal | null = result.ok
      ? null
      : stopped
        ? { code: 'screen_stopped', message: 'Control was stopped; the input was not delivered.' }
        : c.signal.aborted
          ? { code: 'cancelled', message: 'The call was cancelled.' }
          : { code: 'screen_failed', message: clip(result.error ?? 'the input failed', 500) };
    const view = await this.#record(c, action, {
      status: result.ok ? 'ok' : stopped || c.signal.aborted ? 'stopped' : 'failed',
      error,
      target,
      before: before.blob,
      after: afterOk?.blob ?? null,
      createdAt: started,
    });
    if (error) return { ok: false, error };
    return {
      ok: true,
      value: {
        action: view,
        after: afterOk
          ? await this.#observationView(c.accountId, c.computerId, afterOk.obs, afterOk.geo)
          : null,
      },
    };
  }

  // ---- the user's view and takeover (FR-087) --------------------------------------------------

  /** The current screen for the user's live view; changes nothing the agent relies on. */
  async frame(accountId: string, computerId: string): Promise<ScreenObservationView> {
    const computer = await this.#ownComputer(accountId, computerId);
    const live = this.#liveOf(accountId, computerId);
    const handle = await this.#userHandle(computer, live);
    const shot = await this.#capture(handle, false);
    if ('code' in shot)
      throw new NovaError('conflict', shot.message, { details: { reason: shot.code } });
    return this.#observationView(accountId, computerId, shot.obs, shot.geo);
  }

  /** The browser page of the computer for the live view, as a PNG. */
  async browserFrame(accountId: string, computerId: string): Promise<Uint8Array> {
    const computer = await this.#ownComputer(accountId, computerId);
    const browser = await computer.browser();
    if (!browser) throw new NovaError('conflict', 'this computer has no browser');
    return browser.screenshot();
  }

  async takeover(accountId: string, computerId: string): Promise<ScreenTakeoverView | null> {
    await this.#ownComputer(accountId, computerId);
    const row = await this.#openTakeover(accountId, computerId);
    return row ? toTakeoverView(row) : null;
  }

  /** The user takes over the keyboard and mouse; the agent pauses until control is returned. */
  async startTakeover(
    accountId: string,
    computerId: string,
    surface: 'desktop' | 'browser' = 'desktop',
  ): Promise<ScreenTakeoverView> {
    const computer = await this.#ownComputer(accountId, computerId);
    if (await this.#openTakeover(accountId, computerId))
      throw new NovaError('conflict', 'you have already taken over this computer');
    const live = this.#liveOf(accountId, computerId);
    let browser: TakeoverBrowser | null = null;
    if (surface === 'browser') {
      browser = takeoverBrowser(await computer.browser());
      if (!browser)
        throw new NovaError('conflict', 'this computer has no browser the user can take over');
    } else {
      await this.#userHandle(computer, live);
    }
    const before = await this.#state(accountId, computerId);
    const row: TakeoverRow = {
      id: uuidv7(),
      accountId,
      computerId,
      surface,
      startedBy: 'user',
      startedAt: this.#iso(),
      endedAt: null,
      endReason: null,
      inputCount: 0,
    };
    try {
      await this.#db.transaction(async () => {
        await this.#db.orm.insert(screenTakeover).values(row);
      });
    } catch (err) {
      // The unique index on open takeovers lost a race.
      throw new NovaError('conflict', 'you have already taken over this computer', { cause: err });
    }
    live.takeover = { id: row.id, surface, waiters: new Set(), browser };
    // The agent's browser writes wait while the user has the page.
    if (browser) await browser.pause('user');
    // The agent's in-flight input stops at once; it must observe again afterwards.
    live.epoch.abort();
    live.epoch = new AbortController();
    live.last = null;
    await this.#events.emit({
      name: 'computer.takeover.started',
      actor: 'user',
      accountId,
      payload: { computerId, actor: 'user', takeoverId: row.id, surface },
    });
    await this.#auditAppend({
      accountId,
      actor: 'user',
      kind: 'computer',
      action: 'computer.takeover.started',
      resource: `computer:${computerId}`,
      result: 'ok',
      detail: { takeoverId: row.id, surface },
    });
    await this.#hook('pause', accountId, computerId, 'takeover');
    await this.#changed(accountId, computerId, before);
    return toTakeoverView(row);
  }

  /** The user's input while they have control: no tiers or grants apply to the user. */
  async takeoverInput(
    accountId: string,
    computerId: string,
    input: TakeoverInput,
  ): Promise<{ ok: boolean; error: string | null }> {
    const computer = await this.#ownComputer(accountId, computerId);
    const row = await this.#openTakeover(accountId, computerId);
    const live = this.#liveOf(accountId, computerId);
    if (!row || !live.takeover) throw new NovaError('conflict', 'take over the computer first');
    let result: { ok: boolean; error?: string };
    const signal = AbortSignal.timeout(ACT_TIMEOUT_MS);
    if ('action' in input) {
      if (row.surface !== 'desktop')
        throw new NovaError('validation', 'this takeover is of the browser; send browser input');
      const handle = await this.#userHandle(computer, live);
      try {
        result = await handle.act(input.action, signal);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      await this.#record(
        {
          accountId,
          computerId,
          actor: 'user',
          signal,
        },
        input.action,
        {
          status: result.ok ? 'ok' : 'failed',
          error: result.ok
            ? null
            : { code: 'screen_failed', message: clip(result.error ?? 'failed', 500) },
          target: null,
          before: null,
          after: null,
          createdAt: this.#iso(),
          takeoverId: row.id,
        },
      );
    } else {
      if (row.surface !== 'browser')
        throw new NovaError('validation', 'this takeover is of the desktop; send screen input');
      const browser = live.takeover.browser ?? takeoverBrowser(await computer.browser());
      if (!browser) throw new NovaError('conflict', 'this computer has no browser');
      try {
        await browser.input(input.browser);
        result = { ok: true };
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(screenTakeover)
        .set({ inputCount: sql`${screenTakeover.inputCount} + 1` })
        .where(eq(screenTakeover.id, row.id));
    });
    this.#notify(accountId, computerId);
    return { ok: result.ok, error: result.ok ? null : clip(result.error ?? 'failed', 500) };
  }

  /** Return control to the agent: it resumes and must observe before acting again. */
  async endTakeover(accountId: string, computerId: string): Promise<ScreenTakeoverView> {
    await this.#ownComputer(accountId, computerId);
    const row = await this.#openTakeover(accountId, computerId);
    if (!row) throw new NovaError('conflict', 'this computer is not taken over');
    return this.#closeTakeover(row, 'returned');
  }

  async #closeTakeover(
    row: TakeoverRow,
    reason: 'returned' | 'restart',
  ): Promise<ScreenTakeoverView> {
    const before = await this.#state(row.accountId, row.computerId);
    const endedAt = this.#iso();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(screenTakeover)
        .set({ endedAt, endReason: reason })
        .where(eq(screenTakeover.id, row.id));
    });
    const fresh = (
      await this.#db.orm.select().from(screenTakeover).where(eq(screenTakeover.id, row.id)).limit(1)
    )[0]!;
    const live = this.#live.get(key(row.accountId, row.computerId));
    if (live) {
      const t = live.takeover;
      live.takeover = null;
      live.last = null;
      try {
        t?.browser?.resume();
      } catch (err) {
        this.#log.warn('could not resume the browser after a takeover', { err });
      }
      for (const wake of t?.waiters ?? []) wake();
    }
    await this.#events.emit({
      name: 'computer.takeover.ended',
      actor: reason === 'restart' ? 'system' : 'user',
      accountId: row.accountId,
      payload: {
        computerId: row.computerId,
        actor: reason === 'restart' ? 'system' : 'user',
        takeoverId: row.id,
        surface: row.surface,
        reason,
        inputs: fresh.inputCount,
      },
    });
    await this.#auditAppend({
      accountId: row.accountId,
      actor: reason === 'restart' ? 'system' : 'user',
      kind: 'computer',
      action: 'computer.takeover.ended',
      resource: `computer:${row.computerId}`,
      result: reason,
      detail: { takeoverId: row.id, surface: row.surface, inputs: fresh.inputCount },
    });
    if (reason === 'returned')
      await this.#hook('resume', row.accountId, row.computerId, 'takeover');
    await this.#changed(
      row.accountId,
      row.computerId,
      before,
      reason === 'restart' ? 'system' : 'user',
    );
    return toTakeoverView(fresh);
  }

  /** After a restart no takeover is live: close the open ones (the user takes over again). */
  async recover(): Promise<number> {
    const rows = await this.#db.orm
      .select()
      .from(screenTakeover)
      .where(isNull(screenTakeover.endedAt));
    for (const r of rows) await this.#closeTakeover(r, 'restart');
    return rows.length;
  }

  // ---- appshots (FR-075) ----------------------------------------------------------------------

  async appshot(input: AppshotInput): Promise<AppshotView> {
    const computer = await this.#ownComputer(input.accountId, input.computerId);
    if (input.threadId) await this.#ownThread(input.accountId, input.threadId);
    let png: Uint8Array;
    let app: string | null = null;
    let title: string | null = null;
    let url: string | null = null;
    if (input.source === 'browser') {
      const browser = await computer.browser();
      if (!browser) throw new NovaError('conflict', 'this computer has no browser');
      png = await browser.screenshot();
      const page = await browser.read({ maxChars: 200 }).catch(() => null);
      app = 'Browser';
      title = page?.title ?? null;
      url = page?.url ?? null;
    } else {
      const live = this.#liveOf(input.accountId, input.computerId);
      const shot = await this.#capture(await this.#userHandle(computer, live), false);
      if ('code' in shot)
        throw new NovaError('conflict', shot.message, { details: { reason: shot.code } });
      png = shot.obs.image;
      if (input.source === 'window') {
        const w = input.windowId
          ? shot.geo.windows.find((x) => x.id === input.windowId)
          : input.app
            ? shot.geo.windows.find((x) => sameApp(x.app, input.app!))
            : shot.geo.windows.find((x) => x.focused);
        if (!w) throw new NovaError('not_found', 'no such window on the screen');
        app = w.app;
        title = w.title;
        // Crop the window when the frame can be read; otherwise keep the whole screen.
        png = (w.bounds && cropPng(png, w.bounds)) ?? png;
      }
    }
    const size = pngSize(png);
    if (!size) throw new NovaError('conflict', 'the capture is not a PNG image');
    const label = [app ?? 'Screen', title].filter(Boolean).join(' - ');
    const artifact = await this.#artifacts.save({
      accountId: input.accountId,
      threadId: input.threadId ?? null,
      messageId: input.messageId ?? null,
      turnId: input.turnId ?? null,
      kind: 'image',
      title: clip(`Appshot: ${label}`, 200),
      content: Buffer.from(png).toString('base64'),
      encoding: 'base64',
      mime: 'image/png',
    });
    const row: AppshotRow = {
      id: uuidv7(),
      accountId: input.accountId,
      computerId: input.computerId,
      artifactId: artifact.id,
      source: input.source,
      app,
      windowTitle: title,
      url,
      width: size.width,
      height: size.height,
      threadId: input.threadId ?? null,
      capturedBy: input.actor,
      capturedAt: this.#iso(),
    };
    await this.#db.transaction(async () => {
      await this.#db.orm.insert(screenAppshot).values(row);
    });
    await this.#auditAppend({
      accountId: input.accountId,
      actor: input.actor,
      kind: 'screen',
      action: 'appshot.captured',
      resource: `computer:${input.computerId}`,
      result: 'ok',
      threadId: input.threadId ?? null,
      turnId: input.turnId ?? null,
      detail: { appshotId: row.id, artifactId: artifact.id, source: input.source, app },
    });
    return toAppshotView(row);
  }

  async listAppshots(
    accountId: string,
    q: { computerId?: string | undefined; threadId?: string | undefined; limit: number },
  ): Promise<AppshotView[]> {
    const conds = [eq(screenAppshot.accountId, accountId)];
    if (q.computerId) conds.push(eq(screenAppshot.computerId, q.computerId));
    if (q.threadId) conds.push(eq(screenAppshot.threadId, q.threadId));
    const rows = await this.#db.orm
      .select()
      .from(screenAppshot)
      .where(and(...conds))
      .orderBy(desc(screenAppshot.capturedAt), desc(screenAppshot.id))
      .limit(q.limit);
    return rows.map(toAppshotView);
  }

  async getAppshot(accountId: string, id: string): Promise<AppshotView> {
    const rows = await this.#db.orm
      .select()
      .from(screenAppshot)
      .where(and(eq(screenAppshot.id, id), eq(screenAppshot.accountId, accountId)))
      .limit(1);
    if (!rows[0]) throw new NovaError('not_found', 'appshot not found');
    return toAppshotView(rows[0]);
  }

  // ---- the recorded actions (FR-098) ------------------------------------------------------------

  async listActions(
    accountId: string,
    computerId: string,
    q: { limit: number; before?: string | undefined },
  ): Promise<ScreenActionView[]> {
    await this.#ownComputer(accountId, computerId);
    const conds = [eq(screenAction.accountId, accountId), eq(screenAction.computerId, computerId)];
    if (q.before) conds.push(lt(screenAction.id, q.before));
    const rows = await this.#db.orm
      .select()
      .from(screenAction)
      .where(and(...conds))
      .orderBy(desc(screenAction.id))
      .limit(q.limit);
    return rows.map(toActionView);
  }

  /** The before or after screenshot of a recorded action. */
  async actionScreenshot(
    accountId: string,
    computerId: string,
    actionId: string,
    which: 'before' | 'after',
  ): Promise<Buffer> {
    const rows = await this.#db.orm
      .select()
      .from(screenAction)
      .where(
        and(
          eq(screenAction.id, actionId),
          eq(screenAction.accountId, accountId),
          eq(screenAction.computerId, computerId),
        ),
      )
      .limit(1);
    const blob = which === 'before' ? rows[0]?.beforeBlob : rows[0]?.afterBlob;
    if (!blob) throw new NovaError('not_found', 'no such screenshot');
    return readAttachmentBlob(this.#dataDir, blob);
  }

  /** Drop screenshots older than the retention (docs/11 §9); the action rows stay. */
  async pruneScreenshots(retentionDays: number): Promise<number> {
    const cutoff = new Date(this.#now().getTime() - retentionDays * 86_400_000).toISOString();
    const old = and(
      lt(screenAction.createdAt, cutoff),
      or(isNotNull(screenAction.beforeBlob), isNotNull(screenAction.afterBlob)),
    );
    const rows = await this.#db.orm
      .select({ before: screenAction.beforeBlob, after: screenAction.afterBlob })
      .from(screenAction)
      .where(old);
    if (!rows.length) return 0;
    await this.#db.transaction(async () => {
      await this.#db.orm.update(screenAction).set({ beforeBlob: null, afterBlob: null }).where(old);
    });
    const blobs = new Set(rows.flatMap((r) => [r.before, r.after]).filter((p): p is string => !!p));
    return removeUnreferencedBlobs(
      this.#db,
      this.#dataDir,
      [...blobs].filter((p) => !this.#blobInUse(p)),
    );
  }

  /** Remove a deleted computer's screen rows (the computers area calls it). */
  async purgeComputer(accountId: string, computerId: string): Promise<void> {
    await this.#stopAgent(accountId, computerId);
    this.#live.delete(key(accountId, computerId));
    const blobs = (
      await this.#db.orm
        .select({ before: screenAction.beforeBlob, after: screenAction.afterBlob })
        .from(screenAction)
        .where(and(eq(screenAction.accountId, accountId), eq(screenAction.computerId, computerId)))
    )
      .flatMap((r) => [r.before, r.after])
      .filter((p): p is string => !!p);
    await this.#db.transaction(async () => {
      for (const t of [screenAction, screenGrant, screenTakeover, screenAppshot] as const)
        await this.#db.orm
          .delete(t)
          .where(and(eq(t.accountId, accountId), eq(t.computerId, computerId)));
      await this.#db.orm
        .delete(screenControl)
        .where(
          and(eq(screenControl.accountId, accountId), eq(screenControl.computerId, computerId)),
        );
    });
    removeUnreferencedBlobs(
      this.#db,
      this.#dataDir,
      [...new Set(blobs)].filter((p) => !this.#blobInUse(p)),
    );
  }

  // ---- internals --------------------------------------------------------------------------------

  #blobInUse(p: string): boolean {
    return !!this.#db.raw
      .prepare('SELECT 1 AS x FROM screen_action WHERE before_blob = ? OR after_blob = ? LIMIT 1')
      .get(p, p);
  }

  #iso(): string {
    return this.#now().toISOString();
  }

  #liveOf(accountId: string, computerId: string): Live {
    const k = key(accountId, computerId);
    let live = this.#live.get(k);
    if (!live) {
      live = {
        agent: null,
        user: null,
        epoch: new AbortController(),
        stopped: false,
        last: null,
        lastObserveAt: null,
        takeover: null,
        chain: Promise.resolve(),
        lastActionAt: null,
        activeApp: null,
      };
      this.#live.set(k, live);
    }
    return live;
  }

  /** Abort the agent's input and kill its handle; nothing else is delivered through it. */
  async #stopAgent(accountId: string, computerId: string): Promise<void> {
    const live = this.#live.get(key(accountId, computerId));
    if (!live) return;
    live.epoch.abort();
    live.epoch = new AbortController();
    live.last = null;
    const handle = live.agent;
    live.agent = null;
    if (handle) {
      try {
        await handle.kill();
      } catch (err) {
        this.#log.warn('could not kill a screen controller', { err, computerId });
      }
    }
  }

  async #ownComputer(accountId: string, computerId: string): Promise<Computer> {
    const computer = this.#computers ? await this.#computers.get(accountId, computerId) : null;
    if (!computer) throw new NovaError('not_found', 'computer not found');
    return computer;
  }

  async #ownThread(accountId: string, threadId: string): Promise<void> {
    const rows = await this.#db.orm
      .select({ id: thread.id })
      .from(thread)
      .where(and(eq(thread.id, threadId), eq(thread.accountId, accountId)))
      .limit(1);
    if (!rows[0]) throw new NovaError('not_found', 'thread not found');
  }

  async #agentHandle(
    accountId: string,
    computerId: string,
    live: Live,
  ): Promise<ScreenController | ScreenRefusal> {
    if (live.agent) return live.agent;
    const computer = this.#computers ? await this.#computers.get(accountId, computerId) : null;
    if (!computer) return { code: 'no_computer', message: 'That computer does not exist.' };
    const handle = await computer.screen();
    if (!handle)
      return { code: 'screen_unavailable', message: 'This computer has no controlled desktop.' };
    live.agent = handle;
    return handle;
  }

  async #userHandle(computer: Computer, live: Live): Promise<ScreenController> {
    if (live.user) return live.user;
    const handle = await computer.screen();
    if (!handle) throw new NovaError('conflict', 'this computer has no controlled desktop');
    live.user = handle;
    return handle;
  }

  /**
   * Observe through a handle and keep the frame as a blob. A failed observation (including a
   * failed masking on the device) is refused, never acted on (fail closed).
   */
  async #capture(
    handle: ScreenController,
    store = true,
  ): Promise<
    { obs: ScreenObservation; geo: LastObservation; blob: string | null } | ScreenRefusal
  > {
    let obs: ScreenObservation;
    try {
      obs = await handle.observe();
    } catch (err) {
      return {
        code: 'observation_failed',
        message: `The screen could not be observed: ${clip(err instanceof Error ? err.message : String(err), 300)}`,
      };
    }
    const size = pngSize(obs.image);
    if (!size) return { code: 'observation_failed', message: 'The screen image is not a PNG.' };
    const geo: LastObservation = {
      width: size.width,
      height: size.height,
      takenAt: this.#now().getTime(),
      windows: obs.windows.map((w) => ({
        id: w.id,
        app: w.app,
        title: w.title,
        focused: w.focused,
        tier: w.tier,
        bounds: windowBounds(w),
      })),
    };
    const blob = store ? writeAttachmentBlob(this.#dataDir, Buffer.from(obs.image)).blobPath : null;
    return { obs, geo, blob };
  }

  async #observationView(
    accountId: string,
    computerId: string,
    obs: ScreenObservation,
    geo: LastObservation,
  ): Promise<ScreenObservationView> {
    const [overrides, grants] = await Promise.all([
      this.#overrides(),
      this.#grants(accountId, computerId, false),
    ]);
    const windows: ScreenWindowView[] = geo.windows.map((w) => ({
      id: w.id,
      app: w.app,
      title: w.title,
      focused: w.focused,
      tier: effectiveTier(w.app, w.tier, overrides),
      bounds: w.bounds,
      granted: grants.some((g) => sameApp(g.app, w.app)),
    }));
    return {
      computerId,
      width: geo.width,
      height: geo.height,
      takenAt: obs.takenAt,
      windows,
      tree: obs.tree,
      mime: 'image/png',
      image: Buffer.from(obs.image).toString('base64'),
    };
  }

  async #blocked(accountId: string, computerId: string): Promise<ScreenRefusal | null> {
    const stopped: ScreenRefusal = {
      code: 'screen_stopped',
      message:
        'The user stopped computer control with the kill key. Wait until they resume control.',
    };
    if (this.#live.get(key(accountId, computerId))?.stopped) return stopped;
    const ctl = await this.#controlRow(accountId, computerId);
    if (!ctl?.enabled)
      return {
        code: 'screen_disabled',
        message:
          'Computer use is off for this computer. The user can turn it on for the computer in Nova.',
      };
    return ctl.stoppedAt ? stopped : null;
  }

  async #waitForTakeover(live: Live, signal: AbortSignal): Promise<boolean> {
    while (live.takeover) {
      if (signal.aborted) return false;
      const t = live.takeover;
      await new Promise<void>((resolve) => {
        const done = () => {
          t.waiters.delete(done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        t.waiters.add(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    return !signal.aborted;
  }

  async #record(
    c: Omit<ScreenCaller, 'signal'> & { signal?: AbortSignal },
    action: ScreenAction,
    r: {
      status: ActionRow['status'];
      error: ScreenRefusal | null;
      target: { app: string; title: string; tier: ControlTier } | null;
      before: string | null;
      after: string | null;
      createdAt: string;
      takeoverId?: string;
    },
  ): Promise<ScreenActionView> {
    const row: ActionRow = {
      id: uuidv7(),
      accountId: c.accountId,
      computerId: c.computerId,
      actor: c.actor,
      origin: r.takeoverId ? 'takeover' : 'tool',
      kind: action.kind,
      argsJson: JSON.stringify(redactScreenAction(action)),
      app: r.target?.app ?? null,
      windowTitle: r.target ? clip(r.target.title, 500) : null,
      tier: r.target?.tier ?? null,
      status: r.status,
      errorCode: r.error?.code ?? null,
      errorMessage: r.error ? clip(r.error.message, 1000) : null,
      threadId: c.threadId ?? null,
      turnId: c.turnId ?? null,
      callId: c.callId ?? null,
      takeoverId: r.takeoverId ?? null,
      beforeBlob: r.before,
      afterBlob: r.after,
      createdAt: r.createdAt,
      completedAt: this.#iso(),
    };
    await this.#db.transaction(async () => {
      await this.#db.orm.insert(screenAction).values(row);
    });
    const correlation: { threadId?: string; turnId?: string; callId?: string } = {};
    if (row.threadId) correlation.threadId = row.threadId;
    if (row.turnId) correlation.turnId = row.turnId;
    if (row.callId) correlation.callId = row.callId;
    await this.#events.emit({
      name: 'screen.action',
      actor: row.actor,
      accountId: row.accountId,
      ...(Object.keys(correlation).length ? { correlation } : {}),
      payload: {
        computerId: row.computerId,
        actionId: row.id,
        kind: row.kind,
        origin: row.origin,
        app: row.app,
        status: row.status,
        error: row.errorCode,
      },
    });
    await this.#auditAppend({
      accountId: row.accountId,
      actor: row.actor,
      kind: 'screen',
      action: `screen.${row.kind}`,
      resource: `computer:${row.computerId}${row.app ? `/app:${row.app}` : ''}`,
      inputHash: createHash('sha256').update(JSON.stringify(action)).digest('hex'),
      decision: r.status === 'refused' ? 'deny' : 'allow',
      result: r.status,
      threadId: row.threadId,
      turnId: row.turnId,
      detail: {
        actionId: row.id,
        origin: row.origin,
        tier: row.tier,
        error: row.errorCode,
        takeoverId: row.takeoverId,
        what: describeAction(action),
      },
    });
    if (row.status !== 'refused') this.#notify(row.accountId, row.computerId);
    return toActionView(row);
  }

  async #controlRow(accountId: string, computerId: string) {
    const rows = await this.#db.orm
      .select()
      .from(screenControl)
      .where(and(eq(screenControl.computerId, computerId), eq(screenControl.accountId, accountId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async #grants(accountId: string, computerId: string, all: boolean): Promise<GrantRow[]> {
    const conds = [eq(screenGrant.accountId, accountId), eq(screenGrant.computerId, computerId)];
    if (!all) {
      const conds2 = [...conds, isNull(screenGrant.revokedAt)];
      const rows = await this.#db.orm
        .select()
        .from(screenGrant)
        .where(and(...conds2))
        .orderBy(desc(screenGrant.createdAt), desc(screenGrant.id));
      const now = this.#iso();
      return rows.filter((g) => g.expiresAt > now);
    }
    return this.#db.orm
      .select()
      .from(screenGrant)
      .where(and(...conds))
      .orderBy(desc(screenGrant.createdAt), desc(screenGrant.id));
  }

  async #grantRow(accountId: string, computerId: string, grantId: string): Promise<GrantRow> {
    const rows = await this.#db.orm
      .select()
      .from(screenGrant)
      .where(
        and(
          eq(screenGrant.id, grantId),
          eq(screenGrant.accountId, accountId),
          eq(screenGrant.computerId, computerId),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new NovaError('not_found', 'grant not found');
    return rows[0];
  }

  #grantView(g: GrantRow): ScreenGrantView {
    const now = this.#now().getTime();
    const remaining = Math.max(0, Math.floor((Date.parse(g.expiresAt) - now) / 1000));
    const active = !g.revokedAt && remaining > 0;
    return {
      id: g.id,
      computerId: g.computerId,
      app: g.app,
      tier: g.tier,
      grantedBy: g.grantedBy,
      threadId: g.threadId,
      createdAt: g.createdAt,
      expiresAt: g.expiresAt,
      revokedAt: g.revokedAt,
      active,
      remainingSeconds: active ? remaining : 0,
    };
  }

  async #grantChanged(
    row: GrantRow,
    action: 'screen.grant.created' | 'screen.grant.renewed' | 'screen.grant.revoked',
    status: 'active' | 'revoked',
    before: ScreenControlState,
  ): Promise<void> {
    await this.#events.emit({
      name: 'screen.grant.changed',
      actor: 'user',
      accountId: row.accountId,
      payload: {
        computerId: row.computerId,
        grantId: row.id,
        app: row.app,
        status,
        expiresAt: row.expiresAt,
      },
    });
    await this.#auditAppend({
      accountId: row.accountId,
      actor: 'user',
      kind: 'screen',
      action,
      resource: `computer:${row.computerId}/app:${row.app}`,
      result: 'ok',
      threadId: row.threadId,
      detail: {
        grantId: row.id,
        tier: row.tier,
        level: TIER_LABEL[row.tier],
        expiresAt: row.expiresAt,
      },
    });
    await this.#changed(row.accountId, row.computerId, before);
  }

  async #openTakeover(accountId: string, computerId: string): Promise<TakeoverRow | null> {
    const rows = await this.#db.orm
      .select()
      .from(screenTakeover)
      .where(
        and(
          eq(screenTakeover.accountId, accountId),
          eq(screenTakeover.computerId, computerId),
          isNull(screenTakeover.endedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  #stateOf(
    ctl: { enabled: boolean; stoppedAt: string | null } | null,
    grants: GrantRow[],
    takeover: TakeoverRow | null,
  ): ScreenControlState {
    if (takeover) return 'taken_over';
    if (!ctl?.enabled) return 'disabled';
    if (ctl.stoppedAt) return 'stopped';
    return grants.length ? 'controlling' : 'idle';
  }

  async #state(accountId: string, computerId: string): Promise<ScreenControlState> {
    const [ctl, grants, takeover] = await Promise.all([
      this.#controlRow(accountId, computerId),
      this.#grants(accountId, computerId, false),
      this.#openTakeover(accountId, computerId),
    ]);
    return this.#stateOf(ctl, grants, takeover);
  }

  /** Announce a state change (the indicator follows it) and wake the live views. */
  async #changed(
    accountId: string,
    computerId: string,
    before: ScreenControlState,
    actor: 'user' | 'system' = 'user',
  ): Promise<void> {
    const state = await this.#state(accountId, computerId);
    if (state !== before)
      await this.#events.emit({
        name: 'screen.control.changed',
        actor,
        accountId,
        payload: { computerId, from: before, state },
      });
    this.#notify(accountId, computerId);
  }

  #notify(accountId: string, computerId: string): void {
    for (const fn of this.#listeners) {
      try {
        fn(accountId, computerId);
      } catch (err) {
        this.#log.warn('screen listener failed', { err });
      }
    }
  }

  async #overrides(): Promise<Record<string, ControlTier>> {
    try {
      return await this.#settings.tierOverrides();
    } catch {
      return {};
    }
  }

  async #hook(
    which: 'pause' | 'resume',
    accountId: string,
    computerId: string,
    reason: ScreenPauseReason,
  ): Promise<void> {
    if (!this.#control) return;
    try {
      await this.#control[which]({ accountId, computerId, reason });
    } catch (err) {
      this.#log.error(`could not ${which} the agent of a computer`, { err, computerId, reason });
    }
  }

  async #auditAppend(rec: AuditRecord): Promise<void> {
    try {
      await this.#audit.append(rec);
    } catch (err) {
      this.#log.error('could not audit a screen action', { err, action: rec.action });
    }
  }
}

function key(accountId: string, computerId: string): string {
  return `${accountId}\u0000${computerId}`;
}

function cancelled(): { ok: false; error: ScreenRefusal } {
  return { ok: false, error: { code: 'cancelled', message: 'The call was cancelled.' } };
}

function toTakeoverView(r: TakeoverRow): ScreenTakeoverView {
  return {
    id: r.id,
    computerId: r.computerId,
    surface: r.surface,
    startedBy: r.startedBy,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    endReason: r.endReason,
    inputCount: r.inputCount,
  };
}

function toActionView(r: ActionRow): ScreenActionView {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(r.argsJson) as Record<string, unknown>;
  } catch {
    args = {};
  }
  return {
    id: r.id,
    computerId: r.computerId,
    actor: r.actor,
    origin: r.origin,
    kind: r.kind,
    args,
    app: r.app,
    windowTitle: r.windowTitle,
    tier: r.tier,
    status: r.status,
    error: r.errorCode ? { code: r.errorCode, message: r.errorMessage ?? '' } : null,
    threadId: r.threadId,
    turnId: r.turnId,
    callId: r.callId,
    takeoverId: r.takeoverId,
    hasBefore: !!r.beforeBlob,
    hasAfter: !!r.afterBlob,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}

function toAppshotView(r: AppshotRow): AppshotView {
  return {
    id: r.id,
    computerId: r.computerId,
    artifactId: r.artifactId,
    source: r.source,
    app: r.app,
    windowTitle: r.windowTitle,
    url: r.url,
    width: r.width,
    height: r.height,
    threadId: r.threadId,
    capturedBy: r.capturedBy,
    capturedAt: r.capturedAt,
  };
}
