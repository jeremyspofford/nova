// MCP Apps for tool calls (FR-198, docs/04 §2.9): a tool that declares a UI (`ui.resourceUri` on
// its descriptor) renders its app under the call's card, matched to the chat entry point of the
// same server and resource. The app gets the call's redacted arguments, then its result; it runs
// in the sandboxed App frame and its own tool calls pass the policy gate there. The tool list and
// the entry points load once per chat, and only when a reply has a tool call.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ToolDescriptor, UiEntryPointView } from '@nova/shared';
import { fillComposer, useAppOwners } from '../apps/AppsView.tsx';
import { McpAppFrame, type AppToolResult } from '../apps/McpAppFrame.tsx';
import { useServices } from '../services.tsx';
import type { DisplayCall } from './thread-state.ts';

interface ToolAppsData {
  tools: ToolDescriptor[];
  entries: UiEntryPointView[];
}

interface ToolAppsCtx {
  data: ToolAppsData | null;
  ensure: () => void;
}

const Ctx = createContext<ToolAppsCtx | null>(null);

export function ToolAppsProvider({ children }: { children: ReactNode }) {
  const { api } = useServices();
  const [data, setData] = useState<ToolAppsData | null>(null);
  const started = useRef(false);
  const ensure = useCallback(() => {
    if (started.current) return;
    started.current = true;
    Promise.all([api.listTools(), api.uiEntryPoints('thread')]).then(
      ([tools, entries]) => setData({ tools: tools.items, entries: entries.items }),
      () => undefined, // without them a tool call shows its card only
    );
  }, [api]);
  const value = useMemo(() => ({ data, ensure }), [data, ensure]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The chat entry point that renders `tool`, by the descriptor's server (or plugin) and resource. */
export function toolAppEntry(data: ToolAppsData, tool: string): UiEntryPointView | null {
  const d = data.tools.find((t) => t.name === tool);
  const uri = d?.ui?.resourceUri;
  if (!d || !uri) return null;
  return (
    data.entries.find(
      (e) =>
        e.resource === uri &&
        (d.serverId ? e.serverId === d.serverId : !!d.pluginId && e.pluginId === d.pluginId),
    ) ?? null
  );
}

/** The arguments preview as an object; truncated or non-object previews give {}. */
export function previewArgs(preview: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(preview);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const SHOWN = new Set(['running', 'ok', 'error', 'timeout']);

/** The app for one tool call, under its card; nothing when the tool has no UI. */
export function ToolCallApp({ call, threadId }: { call: DisplayCall; threadId: string }) {
  const ctx = useContext(Ctx);
  const [closed, setClosed] = useState(false);
  const wanted = !!ctx && !!call.tool && SHOWN.has(call.status);
  useEffect(() => {
    if (wanted) ctx.ensure();
  }, [ctx, wanted]);
  const entry = wanted && ctx.data ? toolAppEntry(ctx.data, call.tool) : null;
  if (!entry || closed) return null;
  return (
    <ToolAppFrame entry={entry} call={call} threadId={threadId} onClose={() => setClosed(true)} />
  );
}

function ToolAppFrame({
  entry,
  call,
  threadId,
  onClose,
}: {
  entry: UiEntryPointView;
  call: DisplayCall;
  threadId: string;
  onClose: () => void;
}) {
  const owners = useAppOwners();
  const done = call.status !== 'running';
  const failed = call.status === 'error' || call.status === 'timeout';
  const text = failed ? (call.error ?? call.resultPreview ?? '') : (call.resultPreview ?? '');
  const toolCall = useMemo(() => {
    const result: AppToolResult | null = done
      ? { content: [{ type: 'text', text }], ...(failed ? { isError: true } : {}) }
      : null;
    return { arguments: previewArgs(call.argsPreview), result };
  }, [call.argsPreview, done, failed, text]);
  return (
    <McpAppFrame
      entry={entry}
      threadId={threadId}
      owner={owners(entry)}
      toolCall={toolCall}
      onMessage={fillComposer}
      onClose={onClose}
    />
  );
}
