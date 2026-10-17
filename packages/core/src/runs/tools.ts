// Built-in tools of Work runs (docs/09 §2.1, §3, §4, §13): the plan (plan.set, plan.update), the
// structured result (run.complete), the goal (goal.get, goal.set, goal.update), sub-agents
// (task.spawn, task.message, task.wait, task.list, task.cancel) and chat escalation (work.start).
// They change only Nova's own run state, so the gate treats them as read-only actions; every
// action a run or a sub-agent then takes passes the gate on its own (ADR-076). The supervisor
// (RunService) implements the handlers and refuses calls outside the threads they belong to.
import type { BuiltinTool } from '../tools/builtin.ts';
import { builtinDescriptor } from '../tools/builtin.ts';
import type { Origin, ToolContext, ToolResult } from '../tools/types.ts';

export interface RunToolHost {
  planSet(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  planUpdate(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  runComplete(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  goalGet(ctx: ToolContext): Promise<ToolResult>;
  goalSet(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  goalUpdate(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  taskSpawn(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  taskMessage(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  taskWait(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  taskList(ctx: ToolContext): Promise<ToolResult>;
  taskCancel(ctx: ToolContext, args: unknown): Promise<ToolResult>;
  workStart(ctx: ToolContext, args: unknown): Promise<ToolResult>;
}

/** Nova-internal: allowed without a card; never deferred (tool-descriptor.json `loading`). */
const INTERNAL = { readOnly: true, action: 'read' } as const;

export const MAX_WAIT_SECONDS = 3600;

function tool(
  d: {
    name: string;
    title: string;
    description: string;
    inputSchema: Record<string, unknown>;
    timeoutMs?: number;
  },
  /** Sub-agent results carry what the children read: untrusted (FR-189). */
  origin: Origin | null,
  handler: BuiltinTool['handler'],
): BuiltinTool {
  return {
    descriptor: builtinDescriptor({ ...d, annotations: INTERNAL }),
    origin,
    handler,
  };
}

const stepsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  items: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 500 },
      detail: { type: 'string', maxLength: 2000 },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

const budgetsSchema = {
  type: 'object',
  properties: {
    timeSeconds: { type: 'integer', minimum: 60 },
    tokens: { type: 'integer', minimum: 1000 },
    costUsd: { type: 'number', minimum: 0 },
  },
  additionalProperties: false,
};

export interface RunTools {
  /** Offered in a run's own thread. */
  run: BuiltinTool[];
  /** Offered in a sub-agent's thread (depth 1: no task.* tools). */
  child: BuiltinTool[];
  /** Offered in chats while `chat.escalation` is not `off` (FR-186). */
  workStart: BuiltinTool;
  all: BuiltinTool[];
}

export function runTools(host: RunToolHost): RunTools {
  const planSet = tool(
    {
      name: 'plan.set',
      title: 'Set the run plan',
      description:
        "Record or replace this Work run's plan: ordered steps, each with a short title and an optional detail. The user sees the plan and may edit it.",
      inputSchema: {
        type: 'object',
        properties: { steps: stepsSchema },
        required: ['steps'],
        additionalProperties: false,
      },
    },
    null,
    (args, ctx) => host.planSet(ctx, args),
  );
  const planUpdate = tool(
    {
      name: 'plan.update',
      title: 'Update a plan step',
      description:
        'Mark a step of the plan as running, done, failed or skipped, with an optional note. idx is the number shown before the step in the plan (0 for the first step).',
      inputSchema: {
        type: 'object',
        properties: {
          idx: { type: 'integer', minimum: 0, maximum: 49 },
          status: { enum: ['pending', 'running', 'done', 'failed', 'skipped'] },
          detail: { type: 'string', maxLength: 2000 },
        },
        required: ['idx', 'status'],
        additionalProperties: false,
      },
    },
    null,
    (args, ctx) => host.planUpdate(ctx, args),
  );
  const runComplete = tool(
    {
      name: 'run.complete',
      title: 'Report the result',
      description:
        'Report the structured result of this Work run (or of your sub-agent task): a summary, the ids of artifacts you saved and the evidence that the work is done. The run finishes when this turn ends.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', minLength: 1, maxLength: 8000 },
          artifactIds: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 100 } },
          evidence: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 2000 } },
        },
        required: ['summary'],
        additionalProperties: false,
      },
    },
    null,
    (args, ctx) => host.runComplete(ctx, args),
  );
  const goalGet = tool(
    {
      name: 'goal.get',
      title: 'Read the goal',
      description:
        "Read this run's goal: objective, status, budgets, usage, remaining budget, progress note and blocker.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    'tool',
    (_args, ctx) => host.goalGet(ctx),
  );
  const goalSet = tool(
    {
      name: 'goal.set',
      title: 'Set a goal',
      description:
        'Set a goal for this run (an objective and optional budgets). Only when the user asked for a goal in this run; otherwise the call is refused.',
      inputSchema: {
        type: 'object',
        properties: {
          objective: { type: 'string', minLength: 1, maxLength: 4000 },
          budgets: budgetsSchema,
        },
        required: ['objective'],
        additionalProperties: false,
      },
    },
    null,
    (args, ctx) => host.goalSet(ctx, args),
  );
  const goalUpdate = tool(
    {
      name: 'goal.update',
      title: 'Update the goal',
      description:
        'Record progress on the goal, report a blocker ({key, description}; use the same key while the same thing blocks you), or change its status: "complete" with a progressNote summarizing the result; "blocked" only after the same blocker was reported on 3 consecutive goal turns; "paused" only when the user asked for it.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { enum: ['complete', 'blocked', 'paused'] },
          progressNote: { type: 'string', minLength: 1, maxLength: 4000 },
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
    null,
    (args, ctx) => host.goalUpdate(ctx, args),
  );
  const taskSpawn = tool(
    {
      name: 'task.spawn',
      title: 'Start a sub-agent',
      description:
        'Start a sub-agent in its own thread with a role (for example "researcher", "coder", "critic"), a scoped objective and optionally a subset of your tools. It works in parallel; collect its result with task.wait. Limits apply; extra sub-agents queue.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', minLength: 1, maxLength: 40 },
          objective: { type: 'string', minLength: 1, maxLength: 8000 },
          tools: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 } },
        },
        required: ['role', 'objective'],
        additionalProperties: false,
      },
    },
    null,
    (args, ctx) => host.taskSpawn(ctx, args),
  );
  const taskMessage = tool(
    {
      name: 'task.message',
      title: 'Message a sub-agent',
      description:
        'Send more input to one of your sub-agents. A busy sub-agent reads it when its current turn ends; a finished one starts again.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 100 },
          text: { type: 'string', minLength: 1, maxLength: 8000 },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
    null,
    (args, ctx) => host.taskMessage(ctx, args),
  );
  const taskWait = tool(
    {
      name: 'task.wait',
      title: 'Wait for sub-agents',
      description: `Wait until the given sub-agents finish, or the timeout passes (default 30 s, 10 to ${MAX_WAIT_SECONDS} s), and return their status and results.`,
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            minItems: 1,
            maxItems: 20,
            items: { type: 'string', maxLength: 100 },
          },
          timeoutSeconds: { type: 'integer', minimum: 1, maximum: 86_400 },
        },
        required: ['ids'],
        additionalProperties: false,
      },
      timeoutMs: (MAX_WAIT_SECONDS + 60) * 1000,
    },
    'tool',
    (args, ctx) => host.taskWait(ctx, args),
  );
  const taskList = tool(
    {
      name: 'task.list',
      title: 'List sub-agents',
      description: 'List the sub-agents of this run with their status and results.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    'tool',
    (_args, ctx) => host.taskList(ctx),
  );
  const taskCancel = tool(
    {
      name: 'task.cancel',
      title: 'Cancel a sub-agent',
      description: 'Cancel one of your sub-agents; a queued one never starts.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1, maxLength: 100 } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    null,
    (args, ctx) => host.taskCancel(ctx, args),
  );
  const workStart = tool(
    {
      name: 'work.start',
      title: 'Start a Work run',
      description:
        'Turn a request that needs many tool steps into a Work run shown in this chat: an objective (what to achieve, in full) and optionally a plan. Depending on the settings the user starts it from the run card, or it starts at once. Use it for multi-step work, not for quick answers.',
      inputSchema: {
        type: 'object',
        properties: {
          objective: { type: 'string', minLength: 1, maxLength: 8000 },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          plan: stepsSchema,
        },
        required: ['objective'],
        additionalProperties: false,
      },
    },
    null,
    (args, ctx) => host.workStart(ctx, args),
  );
  const run = [
    planSet,
    planUpdate,
    runComplete,
    goalGet,
    goalSet,
    goalUpdate,
    taskSpawn,
    taskMessage,
    taskWait,
    taskList,
    taskCancel,
  ];
  return { run, child: [runComplete], workStart, all: [...run, workStart] };
}
