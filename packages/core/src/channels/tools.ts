// Channel tools for agents (FR-088, docs/18 J7 step 4): `channel.list` shows the connected
// channels of the thread's agent and `channel.send` posts a message to one of them. A send is
// external communication: the gate decides it (confirmed every time unless a rule names the
// recipient), with the resource `account` `<kind>:<conversation>` that agent rules match
// (`channelResource`). In a shared channel the private-to-shared check runs as for a reply.
// M8: `files` names artifacts or attachments of the thread to send after the text, on channels
// that carry files (Telegram); a shared channel checks them first.
import type { ToolSourceProvider } from '../tools/types.ts';
import { argsOf, builtinDescriptor, fail, ok, str, type BuiltinTool } from '../tools/builtin.ts';
import type { ChannelService } from './service.ts';

export function channelTools(
  service: Pick<ChannelService, 'sendTargets' | 'findTarget' | 'sendAsAgent'>,
): BuiltinTool[] {
  const list: BuiltinTool = {
    origin: null,
    descriptor: builtinDescriptor({
      name: 'channel.list',
      title: 'List channels',
      description:
        'List the connected channels (Slack, Teams, webhooks) this agent can send messages to, ' +
        'with their ids, names and whether other people read them.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnly: true, idempotent: true },
    }),
    handler: (_args, ctx) => {
      const targets = service.sendTargets(ctx.accountId, ctx.threadId);
      if (!targets.length) return Promise.resolve(ok('No channels are connected for this agent.'));
      const lines = targets.map(
        (t) =>
          `- ${t.label} (id ${t.id}, ${t.kind}, ${t.audience === 'shared' ? 'shared' : 'private'})`,
      );
      return Promise.resolve(ok(`Connected channels:\n${lines.join('\n')}`));
    },
  };
  const send: BuiltinTool = {
    origin: null,
    descriptor: builtinDescriptor({
      name: 'channel.send',
      title: 'Send a channel message',
      description:
        'Post a message to one of the connected channels (use channel.list for their ids). ' +
        'Replies to a message that arrived on a channel are sent automatically (with the ' +
        'artifacts the turn made, where the channel carries files): use this only to start a new ' +
        'message. `files` takes artifact or attachment ids of this chat to send after the text ' +
        '(Telegram only).',
      inputSchema: {
        type: 'object',
        properties: {
          channel: { type: 'string', minLength: 1, maxLength: 300 },
          text: { type: 'string', minLength: 1, maxLength: 4000 },
          files: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 100 },
            maxItems: 10,
          },
        },
        required: ['channel', 'text'],
        additionalProperties: false,
      },
      annotations: { requiresNetwork: true, action: 'send' },
      effects: ['external_communication'],
    }),
    resource: (args, ctx) => {
      const ref = str(argsOf(args).channel);
      const t = ref ? service.findTarget(ctx.accountId, ctx.threadId, ref) : null;
      // An unknown channel still names its kind-less target, so rules see something specific.
      return { kind: 'account', value: t ? `${t.kind}:${t.externalRef}` : `channel:${ref ?? '*'}` };
    },
    handler: async (args, ctx) => {
      const a = argsOf(args);
      const ref = str(a.channel) ?? '';
      const text = str(a.text)?.trim() ?? '';
      if (!text) return fail('invalid_arguments', 'text is required');
      const files = Array.isArray(a.files)
        ? a.files.filter((f): f is string => typeof f === 'string' && f.length > 0)
        : [];
      if (files.length > 10) return fail('invalid_arguments', 'at most 10 files');
      const target = service.findTarget(ctx.accountId, ctx.threadId, ref);
      if (!target)
        return fail('not_found', `no connected channel "${ref}"; use channel.list to see them`);
      try {
        const receipt = await service.sendAsAgent({
          accountId: ctx.accountId,
          threadId: ctx.threadId,
          turnId: ctx.turnId || null,
          bindingId: target.id,
          text,
          ...(files.length ? { files } : {}),
        });
        const what = files.length
          ? ` with ${files.length} ${files.length === 1 ? 'file' : 'files'}`
          : '';
        return ok(`Sent to ${target.label}${what}.`, { receipt: receipt.id, bindingId: target.id });
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        return fail(
          typeof code === 'string' ? code : 'send_failed',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  };
  return [list, send];
}

/** The channel tools as a source: offered in agent threads and in threads bound to a channel. */
export function channelToolSource(
  tools: readonly BuiltinTool[],
  boundThread: (accountId: string, threadId: string) => boolean,
): ToolSourceProvider {
  return {
    source: 'builtin',
    list: (accountId, scope) => {
      if (!scope) return Promise.resolve([...tools]);
      const offered =
        scope.mode === 'agent' ||
        (scope.threadId !== null && boundThread(accountId, scope.threadId));
      return Promise.resolve(offered ? [...tools] : []);
    },
  };
}
