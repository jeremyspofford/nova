// `user.ask` (FR-188): a Work run or a Code session asks the user a question through the
// request broker and waits for the answer (thread status Needs input, FR-215). The answer comes
// back as the tool result, labelled as the user's answer. Nobody answering before the timeout
// (default 24 h, like an approval) ends the call with `approval_timeout`; a cancelled turn
// withdraws the question.
import type { ToolSourceProvider } from '../tools/types.ts';
import { argsOf, builtinDescriptor, fail, ok, str, type BuiltinTool } from '../tools/builtin.ts';
import type { RequestBroker } from '../runtime/types.ts';

/** The default wait for an answer (docs/09 §12: like an approval, 24 h). */
export const USER_ASK_TIMEOUT_MS = 24 * 3_600_000;
/** The longest wait a setting can ask for (policy.approvalTimeoutMinutes allows 7 days). */
const MAX_WAIT_MS = 7 * 86_400_000;

export interface UserAskToolOptions {
  broker: RequestBroker;
  /** The thread's mode: the question is asked only in Work and Code threads. */
  threadMode: (accountId: string, threadId: string) => Promise<string | null>;
  /** How long to wait for the answer; default 24 h. */
  timeoutMs?: (projectId: string | null) => Promise<number>;
  /** The run a turn belongs to, for the request's correlation. */
  runOf?: (turnId: string) => string | null;
}

export function userAskTool(opts: UserAskToolOptions): BuiltinTool {
  return {
    // The answer is what the signed-in user typed in a Nova client, not untrusted content.
    origin: null,
    descriptor: builtinDescriptor({
      name: 'user.ask',
      title: 'Ask the user',
      description:
        'Ask the user a question and wait for their answer. Use it in Work runs and Code ' +
        'sessions when you need a decision or information only the user has. Offer `choices` ' +
        'when the answer is one of a few options. Do not use it to ask permission for an ' +
        'action: actions that need approval are asked about automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 4000 },
          choices: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 200 },
            maxItems: 20,
          },
          multiline: {
            type: 'boolean',
            description: 'The answer is long-form text.',
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
      // Asking changes nothing in the world, so the policy gate allows it without a card.
      annotations: { readOnly: true, idempotent: false },
      // The runtime must never cut the wait short: the request has its own timeout.
      timeoutMs: MAX_WAIT_MS + 60_000,
    }),
    handler: async (args, ctx) => {
      const a = argsOf(args);
      const question = str(a.question)?.trim();
      if (!question) return fail('invalid_arguments', 'question is required');
      if (!ctx.threadId) return fail('unavailable', 'user.ask needs a thread');
      const mode = await opts.threadMode(ctx.accountId, ctx.threadId).catch(() => null);
      if (mode !== 'work' && mode !== 'code')
        return fail(
          'unavailable',
          'user.ask is for Work runs and Code sessions; in a chat, ask in your reply instead.',
        );
      const payload: Record<string, unknown> = { question };
      const choices = Array.isArray(a.choices)
        ? [...new Set(a.choices.filter((c): c is string => typeof c === 'string' && !!c.trim()))]
        : [];
      if (choices.length) payload.choices = choices.map((c) => c.trim());
      if (a.multiline === true) payload.multiline = true;
      let timeoutMs = USER_ASK_TIMEOUT_MS;
      try {
        if (opts.timeoutMs) timeoutMs = await opts.timeoutMs(ctx.projectId);
      } catch {
        timeoutMs = USER_ASK_TIMEOUT_MS;
      }
      const correlation: { threadId: string; turnId?: string; runId?: string; callId?: string } = {
        threadId: ctx.threadId,
      };
      if (ctx.turnId) correlation.turnId = ctx.turnId;
      if (ctx.callId) correlation.callId = ctx.callId;
      const runId = ctx.turnId ? (opts.runOf?.(ctx.turnId) ?? null) : null;
      if (runId) correlation.runId = runId;
      const r = await opts.broker.ask(
        {
          accountId: ctx.accountId,
          kind: 'user_input',
          correlation,
          payload,
          timeoutMs: Math.min(Math.max(timeoutMs, 1_000), MAX_WAIT_MS),
        },
        ctx.signal,
      );
      switch (r.status) {
        case 'resolved': {
          const answer = (r.result ?? {}) as { text?: unknown; choice?: unknown };
          const text =
            typeof answer.choice === 'string'
              ? `The user chose: ${answer.choice}`
              : `The user answered: ${typeof answer.text === 'string' ? answer.text : ''}`;
          return ok(text, { answeredBy: r.by, userAnswer: true });
        }
        case 'expired':
          // Like an unanswered approval (docs/09 §12): the run pauses until the user returns.
          return fail('approval_timeout', 'Nobody answered the question in time.');
        case 'cancelled':
          return fail('cancelled', 'The question was withdrawn because the turn was cancelled.');
      }
    },
  };
}

/** The request tools (`user.ask`) as a tool source for the tool runtime. */
export function requestToolSource(tools: readonly BuiltinTool[]): ToolSourceProvider {
  return { source: 'builtin', list: () => Promise.resolve([...tools]) };
}
