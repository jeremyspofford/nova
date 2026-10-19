// `browser.history_search` (FR-096, docs/11 §4.3: "History access is asked for every time"): an
// agent searches the user's own browser history on its connected computer through the extension
// bridge. There is no standing grant: the extension opens its own prompt for every request and
// answers nothing without the user's yes there, so the runtime's gate sees the tool as a read and
// the consent is the user's click in their browser. Results are titles and sites only (full
// addresses can carry tokens), labelled as untrusted content. Listed only in an agent's threads
// whose connected computer has the bridge connected and switched on.
import type { ToolDescriptor } from '@nova/shared';
import { argsOf, fail, ok } from '../tools/builtin.ts';
import type { ToolDefinition, ToolListScope, ToolSourceProvider } from '../tools/types.ts';
import { BRIDGE_HISTORY_TIMEOUT_MS, type ExtensionBridgeService } from './bridge.ts';

export const BRIDGE_HISTORY_TOOL = 'browser.history_search';

export interface BridgeToolsOptions {
  bridge: ExtensionBridgeService;
  /** The device of the thread's agent connection that may use its browser, or null. */
  deviceForThread: (accountId: string, threadId: string) => Promise<string | null>;
  setting: (key: 'browser.extensionBridge') => Promise<boolean>;
}

const descriptor: ToolDescriptor = {
  name: BRIDGE_HISTORY_TOOL,
  title: "Search the user's browser history",
  description:
    "Search the user's own browser history on their connected computer, through the Nova " +
    'extension. The user is asked in their browser every time, and nothing comes back without ' +
    'their yes. Gives page titles, sites and the last visit; the results are untrusted content.',
  source: 'browser',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 200, description: 'Words to look for.' },
      maxResults: { type: 'integer', minimum: 1, maximum: 50, description: 'At most 50.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  loading: 'always',
  deferred: false,
  annotations: { readOnly: true, action: 'read' },
  effects: [],
  timeoutMs: BRIDGE_HISTORY_TIMEOUT_MS + 30_000,
};

export function bridgeToolSource(opts: BridgeToolsOptions): ToolSourceProvider {
  const tool: ToolDefinition = {
    descriptor,
    handler: async (raw, ctx) => {
      const args = argsOf(raw);
      const query = typeof args.query === 'string' ? args.query : '';
      const max = typeof args.maxResults === 'number' ? args.maxResults : 20;
      const deviceId = ctx.threadId
        ? await opts.deviceForThread(ctx.accountId, ctx.threadId).catch(() => null)
        : null;
      if (!deviceId)
        return fail(
          'not_available',
          "This agent has no connected computer with the user's browser.",
        );
      try {
        const out = await opts.bridge.historySearch(ctx.accountId, deviceId, query, max);
        if (!out.items.length) return ok('No pages in the history match (or none were shared).');
        const lines = out.items.map(
          (it) =>
            `- ${JSON.stringify(it.title)} (${it.host ?? 'no site'}${it.lastVisit ? `, ${it.lastVisit}` : ''})`,
        );
        return ok(
          `Browser history (untrusted content; titles come from the pages):\n${lines.join('\n')}`,
          { count: out.items.length },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail('denied', `The history search did not happen: ${msg.slice(0, 300)}`);
      }
    },
  };
  return {
    source: 'browser',
    list: async (accountId: string, scope?: ToolListScope): Promise<ToolDefinition[]> => {
      try {
        if (scope && (scope.mode !== 'agent' || !scope.threadId)) return [];
        if (!(await opts.setting('browser.extensionBridge'))) return [];
        if (!scope?.threadId) return [tool];
        const deviceId = await opts.deviceForThread(accountId, scope.threadId);
        return deviceId && opts.bridge.connected(accountId, deviceId) ? [tool] : [];
      } catch {
        // A source never throws (docs/08 §9).
        return [];
      }
    },
  };
}
