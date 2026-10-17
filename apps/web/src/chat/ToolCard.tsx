// Tool call card (docs/04 §2.2, FR-099): one collapsible card per `tool_call` part with the tool's
// title and name, where it comes from (built-in or the MCP server), its status as the stream
// updates it, the arguments preview, live output, the result or error, and the duration. Results
// and output are untrusted data (docs/08 §1.2, FR-103): they are shown as plain text in a <pre>,
// never parsed as Markdown or HTML. A pending approval for the call sits inside the card.
import { useId, useState, type ReactNode } from 'react';
import type { ToolCallStatus, ToolSource } from '@nova/shared';
import { Icon, Spinner, type IconName } from '@nova/ui';
import { isTerminal, type DisplayCall } from './thread-state.ts';

export const TOOL_STATUS_TEXT: Record<ToolCallStatus, string> = {
  pending: 'Pending',
  awaiting_approval: 'Waiting for approval',
  running: 'Running',
  ok: 'Done',
  error: 'Failed',
  denied: 'Denied',
  timeout: 'Timed out',
  cancelled: 'Cancelled',
};

const STATUS_ICON: Record<ToolCallStatus, IconName | null> = {
  pending: 'clock',
  awaiting_approval: 'hand',
  running: null,
  ok: 'check',
  error: 'alert',
  denied: 'alert',
  timeout: 'clock',
  cancelled: 'stop',
};

const SOURCE_TEXT: Record<ToolSource, string> = {
  builtin: 'Built-in',
  mcp: 'MCP server',
  plugin: 'Plugin',
  computer: 'Computer',
  browser: 'Browser',
  page: 'Web page',
  device: 'Device',
};

/** Where a tool comes from; MCP tools name their server (`mcp:<server>.<tool>`, docs/08 §8). */
export function toolSourceLabel(tool: string, source: ToolSource): string {
  if (source === 'mcp') {
    const server = /^mcp:([^./]+)[./]/.exec(tool)?.[1];
    return server ? `MCP server ${server}` : SOURCE_TEXT.mcp;
  }
  return SOURCE_TEXT[source] ?? source;
}

export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return sec ? `${min} min ${sec} s` : `${min} min`;
}

export interface ToolCardProps {
  call: DisplayCall;
  /** The status to show; a call with a pending approval shows "Waiting for approval". */
  status?: ToolCallStatus;
  /** The approval card (or its outcome) for this call. */
  approval?: ReactNode;
}

export function ToolCard({ call, status, approval }: ToolCardProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const shown = status ?? call.status;
  const name = call.tool || 'tool';
  const title = call.title?.trim() || call.tool || 'Tool call';
  const duration = formatDuration(call.durationMs);
  const failed = shown === 'error' || shown === 'denied' || shown === 'timeout';
  const problem = call.error ?? (failed ? call.resultPreview : null);
  const icon = STATUS_ICON[shown];
  return (
    <div
      className="tool-card"
      role="group"
      aria-label={`Tool call: ${title}`}
      data-status={shown}
      data-call-id={call.callId}
    >
      <button
        type="button"
        className="tool-card-head"
        aria-expanded={open}
        aria-controls={open ? `${id}-body` : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={open ? 'down' : 'forward'} className="tool-card-caret" />
        <Icon name="tool" />
        <span className="tool-card-title">{title}</span>
        {title !== name ? <code className="tool-card-name">{name}</code> : null}
        <span className="tool-card-source">{toolSourceLabel(name, call.source)}</span>
        <span className="tool-card-status" data-status={shown}>
          {icon ? <Icon name={icon} /> : <Spinner />}
          {TOOL_STATUS_TEXT[shown]}
        </span>
        {duration ? <span className="tool-card-duration">{duration}</span> : null}
      </button>
      {problem && !open ? <p className="tool-card-problem">{problem}</p> : null}
      {approval}
      {open ? (
        <div id={`${id}-body`} className="tool-card-body">
          {call.argsPreview ? (
            <>
              <p className="tool-card-label">Arguments</p>
              <pre className="tool-card-pre">{call.argsPreview}</pre>
            </>
          ) : null}
          {call.progress && !isTerminal(shown) ? (
            <>
              <p className="tool-card-label">Output so far</p>
              <pre className="tool-card-pre" data-untrusted="true">
                {call.progress}
              </pre>
            </>
          ) : null}
          {problem ? (
            <>
              <p className="tool-card-label">Error</p>
              <pre className="tool-card-pre" data-untrusted="true">
                {problem}
              </pre>
            </>
          ) : call.resultPreview ? (
            <>
              <p className="tool-card-label">
                Result <span className="muted">(output from the tool, shown as plain text)</span>
              </p>
              <pre className="tool-card-pre" data-untrusted="true">
                {call.resultPreview}
              </pre>
            </>
          ) : null}
          {!call.argsPreview && !call.progress && !problem && !call.resultPreview ? (
            <p className="muted">No details yet.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
