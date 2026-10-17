// The tool runtime: registry, built-in tools, sandbox, artifacts, mentions, tool routes
// (FR-022, FR-029, FR-038, FR-196). Filled in by M3.
import type {
  AuditSink,
  ChatServiceOptions,
  Notifier,
  ToolGate,
  ToolSourceProvider,
} from '@nova/core';
import type { HubArea, HubContext } from './hub-context.ts';

export interface ToolsArea extends HubArea {
  /** Options merged into the ChatService (the tool loop hooks in here). */
  chatOptions: Partial<ChatServiceOptions>;
}

export function setupTools(
  _ctx: HubContext & {
    gate: ToolGate;
    sources: ToolSourceProvider[];
    audit: AuditSink;
    notifier: Notifier;
  },
): Promise<ToolsArea> {
  return Promise.resolve({
    chatOptions: {},
    register: () => undefined,
    close: () => Promise.resolve(),
  });
}
