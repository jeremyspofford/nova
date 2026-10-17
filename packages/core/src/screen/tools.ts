// The computer-use tools (FR-093, FR-207, FR-075; docs/11 §5, §6): `screen.observe`,
// `screen.click`, `screen.type`, `screen.key`, `screen.scroll`, `screen.drag`,
// `screen.request_access` and `appshot.capture`. Every call passes the policy gate in the tool
// runtime first; the screen service then applies enablement, the kill key, tiers, grants and the
// coordinate check, so a refusal comes back as a clear tool error that names the tier and the
// tool to use instead. Screen content is untrusted (FR-103): results carry the `capture` origin.
// Tool precedence (docs/11 §5.3): connectors, shell, browser, then computer use; the Hub lists
// this source last.
import type { ScreenAction } from '../computers/types.ts';
import type { RequestBroker } from '../runtime/types.ts';
import {
  argsOf,
  builtinDescriptor,
  extrasOf,
  fail,
  num,
  ok,
  str,
  type BuiltinTool,
} from '../tools/builtin.ts';
import type { ToolContext, ToolResult, ToolSourceProvider } from '../tools/types.ts';
import type { ScreenObservationView } from '@nova/shared';
import type { ScreenService } from './service.ts';
import { TIER_LABEL } from './tiers.ts';

export const SCREEN_TOOL_NAMES = [
  'screen.observe',
  'screen.click',
  'screen.type',
  'screen.key',
  'screen.scroll',
  'screen.drag',
  'screen.request_access',
  'appshot.capture',
] as const;

/** The computer a thread works on, and the agent that owns it. */
export interface ScreenComputerRef {
  computerId: string;
  agentId?: string | null;
}

export interface ScreenToolOptions {
  service: ScreenService;
  /** The computer of a thread (the agents area: an agent's thread uses its computer). */
  computerOf?: () =>
    ((accountId: string, threadId: string) => Promise<ScreenComputerRef | null>) | null;
  /** Asks the user for `screen.request_access` (the requests area), bound late. */
  broker?: () => RequestBroker | null;
  grantMinutes?: () => Promise<number>;
  killKey?: () => Promise<string>;
  /** How long an access request waits for the user; default 24 h like a question. */
  askTimeoutMs?: number;
}

const ASK_TIMEOUT_MS = 24 * 3_600_000;
/** The runtime must not cut an action short while it waits for a takeover to end. */
const WAIT_TIMEOUT_MS = 6 * 3_600_000;
const COORD = { type: 'integer', minimum: 0, maximum: 100_000 } as const;
const COMPUTER = {
  type: 'string',
  maxLength: 100,
  description: "Only outside an agent's thread: the computer to use.",
} as const;
const KEYS_PATTERN = '^[A-Za-z0-9]+([+ ][A-Za-z0-9]+){0,4}$';

const PRECEDENCE =
  'Use computer use only when no connector, shell, file or browser tool can do the step.';

function descriptor(d: Parameters<typeof builtinDescriptor>[0]) {
  return { ...builtinDescriptor(d), source: 'computer' as const };
}

function windowsText(view: ScreenObservationView): string {
  return view.windows
    .map((w) => {
      const where = w.bounds
        ? ` at ${w.bounds.x},${w.bounds.y} ${w.bounds.width}x${w.bounds.height}`
        : '';
      const level = `${TIER_LABEL[w.tier].toLowerCase()}${w.granted ? ', granted' : ', not granted'}`;
      return `- ${JSON.stringify(w.app)}: ${JSON.stringify(w.title)} [${level}]${w.focused ? ' focused' : ''}${where}`;
    })
    .join('\n');
}

function screenText(view: ScreenObservationView): string {
  return [
    `Screen ${view.width}x${view.height} (pixels from the top left), observed ${view.takenAt}.`,
    'Windows, front first:',
    windowsText(view) || '(none)',
    'Accessibility tree (screen content, untrusted):',
    view.tree,
  ].join('\n');
}

export function screenTools(opts: ScreenToolOptions): BuiltinTool[] {
  const service = opts.service;

  /** The computer for this call: the thread's own, or an explicit one outside agent threads. */
  async function target(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<{ ref: ScreenComputerRef; actor: string } | ToolResult> {
    const explicit = str(args.computerId);
    const resolver = opts.computerOf?.() ?? null;
    let bound: ScreenComputerRef | null = null;
    if (ctx.threadId && resolver) {
      try {
        bound = await resolver(ctx.accountId, ctx.threadId);
      } catch {
        bound = null;
      }
    }
    // A call the signed-in user made in a Nova client is theirs; a model call is the agent's.
    const actor = (agentId?: string | null) =>
      ctx.origin === 'ui' ? 'user' : agentId ? `agent:${agentId}` : 'system';
    if (bound) {
      if (explicit && explicit !== bound.computerId)
        return fail(
          'computer_mismatch',
          "This thread works on its agent's own computer; leave computerId out.",
        );
      return { ref: bound, actor: actor(bound.agentId) };
    }
    if (!explicit)
      return fail('no_computer', 'No computer is attached to this thread; pass computerId.');
    return { ref: { computerId: explicit }, actor: actor(null) };
  }

  const caller = (t: { ref: ScreenComputerRef; actor: string }, ctx: ToolContext) => ({
    accountId: ctx.accountId,
    computerId: t.ref.computerId,
    actor: t.actor,
    threadId: ctx.threadId || null,
    turnId: ctx.turnId || null,
    callId: ctx.callId || null,
    signal: ctx.signal,
  });

  function actionTool(d: {
    name: string;
    title: string;
    description: string;
    properties: Record<string, unknown>;
    required: string[];
    toAction: (a: Record<string, unknown>) => ScreenAction | null;
    done: (a: ScreenAction) => string;
  }): BuiltinTool {
    return {
      origin: 'capture',
      descriptor: descriptor({
        name: d.name,
        title: d.title,
        description: `${d.description} ${PRECEDENCE}`,
        inputSchema: {
          type: 'object',
          properties: { ...d.properties, computerId: COMPUTER },
          required: d.required,
          additionalProperties: false,
        },
        annotations: { action: 'write' },
        timeoutMs: WAIT_TIMEOUT_MS,
      }),
      handler: async (args, ctx) => {
        const a = argsOf(args);
        const t = await target(a, ctx);
        if ('ok' in t) return t;
        const action = d.toAction(a);
        if (!action) return fail('invalid_arguments', 'The arguments do not describe an action.');
        const r = await service.act(caller(t, ctx), action);
        if (!r.ok) return fail(r.error.code, r.error.message, r.error.details);
        const where = r.value.action.app ? ` in ${r.value.action.app}` : '';
        const after = r.value.after ? `\n${screenText(r.value.after)}` : '';
        return ok(`${d.done(action)}${where}.${after}`, {
          computerId: t.ref.computerId,
          actionId: r.value.action.id,
          app: r.value.action.app,
          tier: r.value.action.tier,
        });
      },
    };
  }

  const observe: BuiltinTool = {
    origin: 'capture',
    descriptor: descriptor({
      name: 'screen.observe',
      title: 'Observe the screen',
      description:
        "Take a screenshot of the computer's desktop with its windows and accessibility tree. " +
        'Observe before acting: clicks and drags are checked against the last observation. ' +
        'Browsers are view only (use the browser tools), terminals and editors click only, ' +
        `other apps full control once the user grants them. ${PRECEDENCE}`,
      inputSchema: {
        type: 'object',
        properties: { computerId: COMPUTER },
        additionalProperties: false,
      },
      annotations: { readOnly: true, action: 'read' },
      timeoutMs: WAIT_TIMEOUT_MS,
    }),
    handler: async (args, ctx) => {
      const t = await target(argsOf(args), ctx);
      if ('ok' in t) return t;
      const r = await service.observe(caller(t, ctx));
      if (!r.ok) return fail(r.error.code, r.error.message, r.error.details);
      return {
        ok: true,
        content: [
          { type: 'text', text: screenText(r.value) },
          { type: 'image', mime: 'image/png', data: r.value.image },
        ],
        meta: {
          computerId: t.ref.computerId,
          width: r.value.width,
          height: r.value.height,
          takenAt: r.value.takenAt,
          windows: r.value.windows,
        },
      };
    },
  };

  const click = actionTool({
    name: 'screen.click',
    title: 'Click on the screen',
    description:
      'Click at a point of the last observation. Right clicks need full control of the app.',
    properties: { x: COORD, y: COORD, button: { enum: ['left', 'right'] } },
    required: ['x', 'y'],
    toAction: (a) => {
      const x = num(a.x);
      const y = num(a.y);
      if (x === undefined || y === undefined) return null;
      return a.button === 'right'
        ? { kind: 'click', x, y, button: 'right' }
        : { kind: 'click', x, y };
    },
    done: (a) => (a.kind === 'click' ? `Clicked (${a.x}, ${a.y})` : 'Clicked'),
  });

  const type = actionTool({
    name: 'screen.type',
    title: 'Type text',
    description:
      'Type text into the focused field of the frontmost app (full control only). Click the ' +
      'field first.',
    properties: { text: { type: 'string', minLength: 1, maxLength: 2_000 } },
    required: ['text'],
    toAction: (a) => {
      const text = str(a.text);
      return text ? { kind: 'type', text } : null;
    },
    done: (a) => (a.kind === 'type' ? `Typed ${a.text.length} characters` : 'Typed'),
  });

  const key = actionTool({
    name: 'screen.key',
    title: 'Press keys',
    description:
      'Press a key or a combination in the frontmost app (full control only), like Enter, Tab, ' +
      'Backspace or ctrl+s.',
    properties: { keys: { type: 'string', maxLength: 60, pattern: KEYS_PATTERN } },
    required: ['keys'],
    toAction: (a) => {
      const keys = str(a.keys)?.trim();
      return keys ? { kind: 'key', keys } : null;
    },
    done: (a) => (a.kind === 'key' ? `Pressed ${a.keys}` : 'Pressed keys'),
  });

  const scroll = actionTool({
    name: 'screen.scroll',
    title: 'Scroll',
    description: 'Scroll the window at a point; positive dy scrolls down.',
    properties: { x: COORD, y: COORD, dy: { type: 'integer', minimum: -10_000, maximum: 10_000 } },
    required: ['x', 'y', 'dy'],
    toAction: (a) => {
      const x = num(a.x);
      const y = num(a.y);
      const dy = num(a.dy);
      if (x === undefined || y === undefined || dy === undefined) return null;
      return { kind: 'scroll', x, y, dy };
    },
    done: (a) => (a.kind === 'scroll' ? `Scrolled ${a.dy} at (${a.x}, ${a.y})` : 'Scrolled'),
  });

  const drag = actionTool({
    name: 'screen.drag',
    title: 'Drag',
    description:
      'Drag from one point to another (full control only), e.g. a window by its title bar.',
    properties: { fromX: COORD, fromY: COORD, toX: COORD, toY: COORD },
    required: ['fromX', 'fromY', 'toX', 'toY'],
    toAction: (a) => {
      const [fx, fy, tx, ty] = [num(a.fromX), num(a.fromY), num(a.toX), num(a.toY)];
      if (fx === undefined || fy === undefined || tx === undefined || ty === undefined) return null;
      return { kind: 'drag', from: [fx, fy], to: [tx, ty] };
    },
    done: (a) =>
      a.kind === 'drag'
        ? `Dragged (${a.from[0]}, ${a.from[1]}) to (${a.to[0]}, ${a.to[1]})`
        : 'Dragged',
  });

  const requestAccess: BuiltinTool = {
    // The answers are the signed-in user's own, not screen content.
    origin: null,
    descriptor: descriptor({
      name: 'screen.request_access',
      title: 'Ask to control apps',
      description:
        'Ask the user to let you control apps on the computer (by app name, as observed). Each ' +
        'app is granted separately for a limited time; browsers stay view only, terminals and ' +
        'editors click only. Apps like password managers and system settings are never granted.',
      inputSchema: {
        type: 'object',
        properties: {
          apps: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 200 },
            minItems: 1,
            maxItems: 10,
          },
          reason: { type: 'string', maxLength: 500 },
          computerId: COMPUTER,
        },
        required: ['apps'],
        additionalProperties: false,
      },
      // Asking changes nothing; only the user's answer makes a grant.
      annotations: { readOnly: true, idempotent: false },
      // Up to ten apps, each asked in turn.
      timeoutMs: ASK_TIMEOUT_MS * 10 + 60_000,
    }),
    handler: async (args, ctx) => {
      const a = argsOf(args);
      const t = await target(a, ctx);
      if ('ok' in t) return t;
      const broker = opts.broker?.() ?? null;
      if (!broker)
        return fail(
          'unavailable',
          "Nova cannot ask the user here; they can grant apps in the computer's screen settings.",
        );
      const apps = [
        ...new Set(
          (Array.isArray(a.apps) ? a.apps : [])
            .filter((x): x is string => typeof x === 'string')
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ];
      if (!apps.length) return fail('invalid_arguments', 'apps is required');
      const { computerId } = t.ref;
      const minutes = (await opts.grantMinutes?.().catch(() => 30)) ?? 30;
      const killKey = (await opts.killKey?.().catch(() => 'Escape')) ?? 'Escape';
      const reason = str(a.reason)?.trim();
      const status = await service.status(ctx.accountId, computerId).catch(() => null);
      if (!status) return fail('no_computer', 'That computer does not exist.');
      const lines: string[] = [];
      for (const app of apps) {
        const tier = await service.appTier(ctx.accountId, computerId, app);
        if (tier === 'none') {
          lines.push(`${app}: never controlled by Nova; ask the user to do that step.`);
          continue;
        }
        const held = status.grants.find((g) => g.app.toLowerCase() === app.toLowerCase());
        if (held) {
          lines.push(
            `${app}: already granted (${Math.ceil(held.remainingSeconds / 60)} min left).`,
          );
          continue;
        }
        const allow = `Allow for ${minutes} min`;
        const question = [
          `Allow Nova to control "${app}"?`,
          `Level: ${TIER_LABEL[tier]}${tier === 'view' ? ' (the agent acts through the browser tool)' : ''}`,
          `Expires: ${minutes} minutes after you allow`,
          `Stop at any time with ${killKey} or the Stop button.`,
          ...(reason ? [`The agent says: ${reason}`] : []),
        ].join('\n');
        const correlation: { threadId?: string; turnId?: string; callId?: string } = {};
        if (ctx.threadId) correlation.threadId = ctx.threadId;
        if (ctx.turnId) correlation.turnId = ctx.turnId;
        if (ctx.callId) correlation.callId = ctx.callId;
        const r = await broker.ask(
          {
            accountId: ctx.accountId,
            kind: 'user_input',
            correlation,
            payload: { question, choices: [allow, 'Deny'] },
            timeoutMs: opts.askTimeoutMs ?? ASK_TIMEOUT_MS,
          },
          ctx.signal,
        );
        if (r.status === 'cancelled')
          return fail('cancelled', 'The request was withdrawn because the turn was cancelled.');
        if (r.status === 'expired') {
          lines.push(`${app}: nobody answered; no access.`);
          continue;
        }
        const choice = (r.result as { choice?: unknown } | null)?.choice;
        // Only the signed-in user's own answer grants anything (FR-189).
        if (r.by === 'user' && choice === allow) {
          const g = await service.grant(ctx.accountId, computerId, {
            app,
            minutes,
            threadId: ctx.threadId || null,
          });
          lines.push(`${app}: granted (${TIER_LABEL[g.tier].toLowerCase()}) until ${g.expiresAt}.`);
        } else if (r.by !== 'user')
          lines.push(`${app}: not granted (only the user's own answer grants access).`);
        else lines.push(`${app}: denied by the user.`);
      }
      return ok(lines.join('\n'), { computerId });
    },
  };

  const appshot: BuiltinTool = {
    origin: 'capture',
    descriptor: descriptor({
      name: 'appshot.capture',
      title: 'Capture an appshot',
      description:
        'Save an image of an app window (the focused one, or by app name or window id), the ' +
        'whole screen or the browser page, with the app and window title, as an artifact for ' +
        'debugging.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { enum: ['window', 'screen', 'browser'] },
          app: { type: 'string', maxLength: 200 },
          windowId: { type: 'string', maxLength: 200 },
          computerId: COMPUTER,
        },
        additionalProperties: false,
      },
      // It only reads the screen; the artifact is Nova's own record.
      annotations: { readOnly: true, action: 'read' },
      timeoutMs: 60_000,
    }),
    handler: async (args, ctx) => {
      const a = argsOf(args);
      const t = await target(a, ctx);
      if ('ok' in t) return t;
      const source = a.source === 'screen' || a.source === 'browser' ? a.source : 'window';
      try {
        const view = await service.appshot({
          accountId: ctx.accountId,
          computerId: t.ref.computerId,
          source,
          windowId: str(a.windowId),
          app: str(a.app),
          threadId: ctx.threadId || null,
          messageId: extrasOf(ctx)?.messageId ?? null,
          turnId: ctx.turnId || null,
          actor: t.actor,
        });
        const what = [view.app ?? 'Screen', view.windowTitle].filter(Boolean).join(' - ');
        return ok(`Saved an appshot of ${what} (${view.width}x${view.height}) as an artifact.`, {
          appshotId: view.id,
          artifactId: view.artifactId,
          computerId: view.computerId,
          url: view.url,
        });
      } catch (err) {
        const code =
          typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'failed';
        return fail(code, err instanceof Error ? err.message : String(err));
      }
    },
  };

  return [observe, click, type, key, scroll, drag, requestAccess, appshot];
}

/**
 * The screen tools as a tool source (docs/11 §5.3): offered in agent and Work threads, and, once
 * the thread-to-computer mapping is bound, only in threads that work on a computer. Without a
 * scope (catalogs, direct invocation) every tool is listed.
 */
export function screenToolSource(
  tools: readonly BuiltinTool[],
  opts: {
    modes?: readonly ('chat' | 'work' | 'code' | 'agent')[];
    computerOf?: ScreenToolOptions['computerOf'];
  } = {},
): ToolSourceProvider {
  const modes = opts.modes ?? ['agent', 'work'];
  return {
    source: 'computer',
    list: async (accountId, scope) => {
      if (!scope) return [...tools];
      if (!modes.includes(scope.mode)) return [];
      const resolver = opts.computerOf?.() ?? null;
      if (!resolver) return [...tools];
      if (!scope.threadId) return [];
      try {
        return (await resolver(accountId, scope.threadId)) ? [...tools] : [];
      } catch {
        return [];
      }
    },
  };
}
