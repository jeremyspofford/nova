// The `schedule.report` tool (FR-187, docs/09 §6): a run fired by a schedule says whether its
// result should be delivered. `notify: false` means the notify condition is not met: nothing is
// delivered and the history says "no news". Without a call, the final reply is delivered.
import type { ToolResult } from '../tools/types.ts';
import { builtinDescriptor, type BuiltinTool } from '../tools/builtin.ts';

export const REPORT_TOOL = 'schedule.report';

export interface ReportArgs {
  notify: boolean;
  message?: string;
}

export const MAX_REPORT_MESSAGE = 4000;

export function reportTool(
  handler: (accountId: string, threadId: string, args: ReportArgs) => Promise<ToolResult>,
): BuiltinTool {
  return {
    descriptor: builtinDescriptor({
      name: REPORT_TOOL,
      title: 'Report a scheduled check',
      description:
        'Only in a run started by a schedule: say whether the result should be delivered. ' +
        'Use notify false when the notify condition is not met (nothing is sent). Use notify ' +
        'true to deliver `message`, or your final reply when message is omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          notify: { type: 'boolean' },
          message: { type: 'string', maxLength: MAX_REPORT_MESSAGE },
        },
        required: ['notify'],
        additionalProperties: false,
      },
      // It only records the decision; Nova delivers after the run, to the user's own targets.
      annotations: { readOnly: true, idempotent: true, action: 'read' },
      timeoutMs: 30_000,
    }),
    origin: null,
    handler: (args, ctx) => {
      const a = (args ?? {}) as Partial<ReportArgs>;
      const out: ReportArgs = { notify: a.notify === true };
      if (typeof a.message === 'string' && a.message.trim())
        out.message = a.message.trim().slice(0, MAX_REPORT_MESSAGE);
      return handler(ctx.accountId, ctx.threadId, out);
    },
  };
}
