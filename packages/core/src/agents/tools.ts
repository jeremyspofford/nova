// Built-in tools of always-on agents (docs/09 §4, §6, §8; FR-059, FR-072, FR-089, FR-181,
// FR-206), offered only in agent threads. Tools that change only the agent's own state (notes,
// goal, its schedules and wakes, background work) are Nova-internal, so the gate treats them as
// read-only actions, as the run tools (every action the agent then takes passes the gate on its
// own). Messaging or archiving another of the user's sessions is an action under policy, never
// user-authorized (FR-072, FR-189). A proactive research thread gets only the reading tools, and
// every changing handler refuses there (FR-082).
import { z } from 'zod';
import {
  DELIVERY_KINDS,
  GOAL_STATUSES,
  NovaError,
  idSchema,
  scheduleSchema,
  type BudgetAmounts,
  type GoalStatus,
} from '@nova/shared';
import type { ScheduleInput } from '../scheduler/service.ts';
import {
  argsOf,
  builtinDescriptor,
  fail,
  num,
  ok,
  str,
  type BuiltinTool,
} from '../tools/builtin.ts';
import type { Origin, ToolContext, ToolResult } from '../tools/types.ts';

export interface AgentToolHost {
  turnOf(threadId: string): { kind: string; authority: 'user' | 'none'; threadKind: string } | null;
  setWake(
    accountId: string,
    threadId: string,
    input: { at?: string | undefined; in?: unknown; reason: string },
  ): Promise<{ scheduleId: string; at: string; moved: boolean }>;
  upsertSchedule(
    accountId: string,
    threadId: string,
    input: ScheduleInput & { id?: string | undefined },
    sent: ReadonlySet<string>,
  ): Promise<{ id: string; nextRunAt: string | null }>;
  cancelSchedule(accountId: string, threadId: string, scheduleId: string): Promise<void>;
  agentSchedules(
    accountId: string,
    threadId: string,
  ): Promise<
    {
      id: string;
      title: string;
      origin: string;
      enabled: boolean;
      nextRunAt: string | null;
      wakeReason: string | null;
    }[]
  >;
  agentNote(
    accountId: string,
    threadId: string,
    input: {
      content: string;
      kind?: 'note' | 'fact' | 'preference' | undefined;
      responsibilityId?: string | undefined;
    },
  ): Promise<string>;
  agentNotes(
    accountId: string,
    threadId: string,
  ): Promise<{ id: string; kind: string; content: string; author: string; pinned: boolean }[]>;
  agentProgress(accountId: string, threadId: string, rid: string, note: string): Promise<void>;
  delegate(
    accountId: string,
    threadId: string,
    input: { objective: string; title?: string | undefined },
  ): Promise<{ runId: string; threadId: string }>;
  backgroundFor(
    accountId: string,
    threadId: string,
  ): Promise<{ runId: string; title: string; status: string }[]>;
  listSessions(
    accountId: string,
    opts: {
      mode?: 'chat' | 'work' | 'code' | 'agent' | undefined;
      q?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<{ id: string; title: string | null; mode: string; updatedAt: string }[]>;
  readSession(accountId: string, threadId: string, limit?: number): string;
  messageSession(
    accountId: string,
    fromThreadId: string,
    targetThreadId: string,
    text: string,
  ): Promise<{ turnId: string }>;
  archiveSession(accountId: string, fromThreadId: string, targetThreadId: string): Promise<void>;
  goalForThread(accountId: string, threadId: string): Promise<Record<string, unknown> | null>;
  goalSetFromTool(
    accountId: string,
    threadId: string,
    body: { objective: string; budgets?: BudgetAmounts },
  ): Promise<string>;
  goalUpdateFromTool(
    accountId: string,
    threadId: string,
    turnId: string,
    a: {
      status?: GoalStatus | undefined;
      progressNote?: string | undefined;
      blocker?: { key: string; description?: string | undefined } | undefined;
    },
  ): Promise<string>;
}

export interface AgentTools {
  /** Every tool, offered in an agent's main and binding threads. */
  all: BuiltinTool[];
  /** Reading tools only: the proactive research thread (FR-082). */
  read: BuiltinTool[];
  /** For catalogs without a thread: all but the goal tools (the runs area lists those names). */
  catalog: BuiltinTool[];
}

/** Nova-internal: allowed without a card (it changes only the agent's own state). */
const INTERNAL = { readOnly: true, action: 'read' } as const;
/** Reaches beyond the agent: the gate decides (FR-072). */
const ACTION = { readOnly: false, action: 'write' } as const;

function toolOf(
  d: {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
  },
  annotations: typeof INTERNAL | typeof ACTION,
  origin: Origin | null,
  handler: BuiltinTool['handler'],
): BuiltinTool {
  return { descriptor: builtinDescriptor({ ...d, annotations }), origin, handler };
}

/** Errors become tool errors the model reads; nothing else escapes. */
async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NovaError) return fail(err.code, err.message);
    if (err instanceof z.ZodError)
      return fail(
        'invalid_arguments',
        err.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '),
      );
    throw err;
  }
}

const createScheduleSchema = scheduleSchema.omit({ projectId: true, autonomy: true });
const editScheduleSchema = scheduleSchema
  .omit({ projectId: true, autonomy: true, deliveryTargets: true })
  .partial()
  .extend({
    id: idSchema,
    deliveryTargets: z
      .array(
        z.object({ kind: z.enum(DELIVERY_KINDS), ref: z.string().max(500).optional() }).strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();

const whenSchema = {
  type: 'object',
  description:
    'One of {"cron": "0 9 * * 1-5"}, {"rrule": "FREQ=WEEKLY;BYDAY=MO"}, {"intervalSeconds": 3600} or {"at": "<ISO date-time>"}',
};

export function agentTools(host: AgentToolHost): AgentTools {
  const notProactive = (ctx: ToolContext): ToolResult | null =>
    host.turnOf(ctx.threadId)?.threadKind === 'proactive'
      ? fail('read_only', 'proactive research only reads; this tool changes something')
      : null;

  const wake = toolOf(
    {
      name: 'schedule.wake',
      title: 'Set your next wake-up',
      description:
        'Wake yourself up later to continue: give "at" (an ISO date-time) or "in" (like "45m", "2h", "1d"), and the reason. At least 5 minutes ahead, at most 30 days, and a limited number a day. A wake in quiet hours moves to their end. The user sees it in Scheduled and can cancel it.',
      inputSchema: {
        type: 'object',
        properties: {
          at: { type: 'string', maxLength: 64 },
          in: { type: ['string', 'number'] },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
    INTERNAL,
    null,
    (args, ctx) =>
      guarded(async () => {
        const refused = notProactive(ctx);
        if (refused) return refused;
        const a = argsOf(args);
        const r = await host.setWake(ctx.accountId, ctx.threadId, {
          at: str(a.at),
          in: a.in,
          reason: str(a.reason) ?? '',
        });
        return ok(
          `Wake-up set for ${r.at}${r.moved ? ' (moved to the end of quiet hours)' : ''}.`,
          { scheduleId: r.scheduleId, at: r.at },
        );
      }),
  );

  const scheduleCreate = toolOf(
    {
      name: 'schedule.create',
      title: 'Create or edit one of your schedules',
      description:
        'Create a schedule that wakes you with its instructions, or edit one you made (pass its id with the fields to change). Delivery targets are in-app or OS only. Fields: when, timezone (IANA), instructions, title, notifyCondition, deliveryTargets, catchUp, enabled.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 100 },
          when: whenSchema,
          timezone: { type: 'string', maxLength: 100 },
          instructions: { type: 'string', maxLength: 8000 },
          title: { type: 'string', maxLength: 200 },
          notifyCondition: { type: 'string', maxLength: 1000 },
          deliveryTargets: { type: 'array', maxItems: 10 },
          catchUp: { type: 'object' },
          enabled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    INTERNAL,
    null,
    (args, ctx) =>
      guarded(async () => {
        const refused = notProactive(ctx);
        if (refused) return refused;
        const a = argsOf(args);
        const sent = new Set(Object.keys(a));
        const input: ScheduleInput & { id?: string } =
          typeof a.id === 'string'
            ? ({ deliveryTargets: [], ...editScheduleSchema.parse(a) } as ScheduleInput & {
                id: string;
              })
            : createScheduleSchema.parse(a);
        const v = await host.upsertSchedule(ctx.accountId, ctx.threadId, input, sent);
        return ok(
          `Schedule ${input.id ? 'updated' : 'created'} (${v.id}); next run ${v.nextRunAt ?? 'none'}.`,
          {
            scheduleId: v.id,
          },
        );
      }),
  );

  const scheduleList = toolOf(
    {
      name: 'schedule.list',
      title: 'List your schedules',
      description: 'Your schedules and self-set wakes, with their next run.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    INTERNAL,
    'tool',
    (_args, ctx) =>
      guarded(async () => {
        const items = await host.agentSchedules(ctx.accountId, ctx.threadId);
        return ok(
          items.length
            ? JSON.stringify(
                items.map((s) => ({
                  id: s.id,
                  title: s.title,
                  origin: s.origin,
                  enabled: s.enabled,
                  nextRunAt: s.nextRunAt,
                  wakeReason: s.wakeReason,
                })),
              )
            : 'You have no schedules.',
        );
      }),
  );

  const scheduleCancel = toolOf(
    {
      name: 'schedule.cancel',
      title: 'Cancel one of your schedules',
      description: 'Cancel a schedule or wake you made yourself (not one the user made).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    INTERNAL,
    null,
    (args, ctx) =>
      guarded(async () => {
        const refused = notProactive(ctx);
        if (refused) return refused;
        const id = str(argsOf(args).id) ?? '';
        await host.cancelSchedule(ctx.accountId, ctx.threadId, id);
        return ok(`Schedule ${id} cancelled.`);
      }),
  );

  const note = toolOf(
    {
      name: 'agent.note',
      title: 'Write a note',
      description:
        'Keep a durable note (or a fact or preference you learned). The user sees and can edit every note.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 8000 },
          kind: { enum: ['note', 'fact', 'preference'] },
          responsibilityId: { type: 'string', maxLength: 100 },
        },
        required: ['content'],
        additionalProperties: false,
      },
    },
    INTERNAL,
    null,
    (args, ctx) =>
      guarded(async () => {
        const refused = notProactive(ctx);
        if (refused) return refused;
        const a = argsOf(args);
        const kind = str(a.kind) as 'note' | 'fact' | 'preference' | undefined;
        const id = await host.agentNote(ctx.accountId, ctx.threadId, {
          content: str(a.content) ?? '',
          kind,
          responsibilityId: str(a.responsibilityId),
        });
        return ok(`Note saved (${id}).`);
      }),
  );

  const notes = toolOf(
    {
      name: 'agent.notes',
      title: 'Read your notes',
      description: 'Your notes and what you remember, newest first.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    INTERNAL,
    'memory',
    (_args, ctx) =>
      guarded(async () => {
        const items = await host.agentNotes(ctx.accountId, ctx.threadId);
        return ok(
          items.length
            ? items
                .slice(0, 100)
                .map(
                  (n) =>
                    `- [${n.kind}${n.author === 'user' ? ', from the user' : ''}] ${n.content}`,
                )
                .join('\n')
            : 'You have no notes.',
        );
      }),
  );

  const progress = toolOf(
    {
      name: 'agent.progress',
      title: 'Record progress on a responsibility',
      description: 'Record a short progress note on one of your responsibilities (by its id).',
      inputSchema: {
        type: 'object',
        properties: {
          responsibilityId: { type: 'string', minLength: 1, maxLength: 100 },
          note: { type: 'string', minLength: 1, maxLength: 4000 },
        },
        required: ['responsibilityId', 'note'],
        additionalProperties: false,
      },
    },
    INTERNAL,
    null,
    (args, ctx) =>
      guarded(async () => {
        const refused = notProactive(ctx);
        if (refused) return refused;
        const a = argsOf(args);
        await host.agentProgress(
          ctx.accountId,
          ctx.threadId,
          str(a.responsibilityId) ?? '',
          str(a.note) ?? '',
        );
        return ok('Progress recorded.');
      }),
  );

  const delegateTool = toolOf(
    {
      name: 'agent.delegate',
      title: 'Start background work',
      description:
        'Start a Work run in the background for a self-contained task, with your rules and budgets. Its result comes back to you here when it ends; meanwhile you keep talking with the user.',
      inputSchema: {
        type: 'object',
        properties: {
          objective: { type: 'string', minLength: 1, maxLength: 8000 },
          title: { type: 'string', maxLength: 200 },
        },
        required: ['objective'],
        additionalProperties: false,
      },
    },
    INTERNAL,
    null,
    (args, ctx) =>
      guarded(async () => {
        const refused = notProactive(ctx);
        if (refused) return refused;
        const a = argsOf(args);
        const r = await host.delegate(ctx.accountId, ctx.threadId, {
          objective: str(a.objective) ?? '',
          title: str(a.title),
        });
        return ok(`Background work started (run ${r.runId}).`, r);
      }),
  );

  const background = toolOf(
    {
      name: 'agent.background',
      title: 'List your background work',
      description: 'The Work runs you started in the background and their status.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    INTERNAL,
    'tool',
    (_args, ctx) =>
      guarded(async () => {
        const items = await host.backgroundFor(ctx.accountId, ctx.threadId);
        return ok(
          items.length
            ? JSON.stringify(
                items.map((r) => ({ runId: r.runId, title: r.title, status: r.status })),
              )
            : 'No background work.',
        );
      }),
  );

  const sessionsList = toolOf(
    {
      name: 'sessions.list',
      title: "List the user's sessions",
      description:
        "The user's other sessions (threads), newest first; optionally by mode or a search query.",
      inputSchema: {
        type: 'object',
        properties: {
          mode: { enum: ['chat', 'work', 'code', 'agent'] },
          query: { type: 'string', maxLength: 200 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
    },
    INTERNAL,
    'tool',
    (args, ctx) =>
      guarded(async () => {
        const a = argsOf(args);
        const items = await host.listSessions(ctx.accountId, {
          mode: str(a.mode) as 'chat' | 'work' | 'code' | 'agent' | undefined,
          q: str(a.query),
          limit: num(a.limit),
        });
        return ok(items.length ? JSON.stringify(items) : 'No sessions.');
      }),
  );

  const sessionsRead = toolOf(
    {
      name: 'sessions.read',
      title: 'Read a session',
      description:
        'The latest messages of one of the user’s sessions, to answer questions about it.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string', minLength: 1, maxLength: 100 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['threadId'],
        additionalProperties: false,
      },
    },
    INTERNAL,
    'tool',
    (args, ctx) =>
      guarded(() => {
        const a = argsOf(args);
        const text = host.readSession(ctx.accountId, str(a.threadId) ?? '', num(a.limit) ?? 20);
        return Promise.resolve(ok(text || 'That session has no messages, or it does not exist.'));
      }),
  );

  const sessionsMessage = toolOf(
    {
      name: 'sessions.message',
      title: 'Message another session',
      description:
        'Send a message, as yourself, into another of the user’s sessions; it starts a turn there. The user approves this unless a rule allows it.',
      inputSchema: {
        type: 'object',
        properties: {
          threadId: { type: 'string', minLength: 1, maxLength: 100 },
          text: { type: 'string', minLength: 1, maxLength: 8000 },
        },
        required: ['threadId', 'text'],
        additionalProperties: false,
      },
    },
    ACTION,
    null,
    (args, ctx) =>
      guarded(async () => {
        const refused = notProactive(ctx);
        if (refused) return refused;
        const a = argsOf(args);
        const r = await host.messageSession(
          ctx.accountId,
          ctx.threadId,
          str(a.threadId) ?? '',
          str(a.text) ?? '',
        );
        return ok(`Message sent (turn ${r.turnId}).`);
      }),
  );

  const sessionsArchive = toolOf(
    {
      name: 'sessions.archive',
      title: 'Archive a session',
      description:
        'Archive one of the user’s sessions. The user approves this unless a rule allows it.',
      inputSchema: {
        type: 'object',
        properties: { threadId: { type: 'string', minLength: 1, maxLength: 100 } },
        required: ['threadId'],
        additionalProperties: false,
      },
    },
    ACTION,
    null,
    (args, ctx) =>
      guarded(async () => {
        const refused = notProactive(ctx);
        if (refused) return refused;
        const id = str(argsOf(args).threadId) ?? '';
        await host.archiveSession(ctx.accountId, ctx.threadId, id);
        return ok(`Session ${id} archived.`);
      }),
  );

  const goalGet = toolOf(
    {
      name: 'goal.get',
      title: 'Read your goal',
      description: 'Your goal: objective, status, budgets and use, the last progress note.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    INTERNAL,
    null,
    (_args, ctx) =>
      guarded(async () => {
        const g = await host.goalForThread(ctx.accountId, ctx.threadId);
        return ok(g ? JSON.stringify(g) : 'You have no goal.');
      }),
  );

  const goalSet = toolOf(
    {
      name: 'goal.set',
      title: 'Set your goal',
      description:
        'Set or replace your goal, only when the user asked for a goal in this turn: an objective and optional budgets.',
      inputSchema: {
        type: 'object',
        properties: {
          objective: { type: 'string', minLength: 1, maxLength: 4000 },
          budgets: {
            type: 'object',
            properties: {
              timeSeconds: { type: 'integer', minimum: 60 },
              tokens: { type: 'integer', minimum: 1000 },
              costUsd: { type: 'number', minimum: 0 },
            },
            additionalProperties: false,
          },
        },
        required: ['objective'],
        additionalProperties: false,
      },
    },
    INTERNAL,
    null,
    (args, ctx) =>
      guarded(async () => {
        const refused = notProactive(ctx);
        if (refused) return refused;
        const a = argsOf(args);
        const b = argsOf(a.budgets);
        const budgets: BudgetAmounts = {};
        if (num(b.timeSeconds) !== undefined) budgets.timeSeconds = num(b.timeSeconds);
        if (num(b.tokens) !== undefined) budgets.tokens = num(b.tokens);
        if (num(b.costUsd) !== undefined) budgets.costUsd = num(b.costUsd);
        const id = await host.goalSetFromTool(ctx.accountId, ctx.threadId, {
          objective: str(a.objective) ?? '',
          budgets,
        });
        return ok(`Goal set (${id}).`);
      }),
  );

  const goalUpdate = toolOf(
    {
      name: 'goal.update',
      title: 'Update your goal',
      description:
        'Record progress (progressNote), report a blocker ({key, description}) or change the status: complete (with a progressNote), blocked (after the same blocker on 3 consecutive goal turns), paused (only when the user asked).',
      inputSchema: {
        type: 'object',
        properties: {
          status: { enum: [...GOAL_STATUSES] },
          progressNote: { type: 'string', maxLength: 4000 },
          blocker: {
            type: 'object',
            properties: {
              key: { type: 'string', minLength: 1, maxLength: 200 },
              description: { type: 'string', maxLength: 2000 },
            },
            required: ['key'],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    INTERNAL,
    null,
    (args, ctx) =>
      guarded(async () => {
        const refused = notProactive(ctx);
        if (refused) return refused;
        const a = argsOf(args);
        const blocker = a.blocker === undefined ? undefined : argsOf(a.blocker);
        const text = await host.goalUpdateFromTool(ctx.accountId, ctx.threadId, ctx.turnId, {
          status: str(a.status) as GoalStatus | undefined,
          progressNote: str(a.progressNote),
          blocker: blocker
            ? { key: str(blocker.key) ?? '', description: str(blocker.description) }
            : undefined,
        });
        return ok(text);
      }),
  );

  const read = [notes, scheduleList, background, sessionsList, sessionsRead, goalGet];
  const all = [
    ...read,
    note,
    progress,
    wake,
    scheduleCreate,
    scheduleCancel,
    delegateTool,
    sessionsMessage,
    sessionsArchive,
    goalSet,
    goalUpdate,
  ];
  const goalNames = new Set(['goal.get', 'goal.set', 'goal.update']);
  return { all, read, catalog: all.filter((t) => !goalNames.has(t.descriptor.name)) };
}
