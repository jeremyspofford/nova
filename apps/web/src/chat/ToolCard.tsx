// Tool call card (docs/04 §2.2, FR-099): one collapsible card per `tool_call` part with the tool's
// title and name, where it comes from (built-in or the MCP server), its status as the stream
// updates it, the arguments preview, live output, the result or error, and the duration. Results
// and output are untrusted data (docs/08 §1.2, FR-103): they are shown as plain text in a <pre>,
// never parsed as Markdown or HTML. A pending approval for the call sits inside the card.
import { useId, useState, type ReactNode } from 'react';
import type { ToolCallStatus, ToolSource } from '@nova/shared';
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import { Icon, Spinner, type IconName } from '@nova/ui';
import { isTerminal, type DisplayCall } from './thread-state.ts';

export const TOOL_STATUS_TEXT = defineMessages('chat.toolStatus', {
  pending: 'Pending',
  awaiting_approval: 'Waiting for approval',
  running: 'Running',
  ok: 'Done',
  error: 'Failed',
  denied: 'Denied',
  timeout: 'Timed out',
  cancelled: 'Cancelled',
}) satisfies Record<ToolCallStatus, string>;

export const TOOL_TEXT = defineMessages('chat.tool', {
  source: {
    builtin: 'Built-in',
    mcp: 'MCP server',
    plugin: 'Plugin',
    computer: 'Computer',
    browser: 'Browser',
    page: 'Web page',
    device: 'Device',
  },
  mcpServer: 'MCP server {server}',
  /** The card's name when the tool has no title or name. */
  toolCall: 'Tool call',
  toolName: 'tool',
  card: 'Tool call: {title}',
  arguments: 'Arguments',
  outputSoFar: 'Output so far',
  error: 'Error',
  result: 'Result',
  resultNote: '(output from the tool, shown as plain text)',
  noDetails: 'No details yet.',
});

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

/** Where a tool comes from; MCP tools name their server (`mcp:<server>.<tool>`, docs/08 §8). */
export function toolSourceLabel(tool: string, source: ToolSource): string {
  if (source === 'mcp') {
    const server = /^mcp:([^./]+)[./]/.exec(tool)?.[1];
    return server ? TOOL_TEXT.mcpServer({ server }) : TOOL_TEXT.source.mcp;
  }
  return messageFor(TOOL_TEXT.source, source) ?? source;
}

export function formatDuration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  return fmt.duration(ms);
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
  const name = call.tool || TOOL_TEXT.toolName;
  const title = call.title?.trim() || call.tool || TOOL_TEXT.toolCall;
  const duration = formatDuration(call.durationMs);
  const failed = shown === 'error' || shown === 'denied' || shown === 'timeout';
  const problem = call.error ?? (failed ? call.resultPreview : null);
  const icon = STATUS_ICON[shown];
  return (
    <div
      className="tool-card"
      role="group"
      aria-label={TOOL_TEXT.card({ title })}
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
      {problem && !open ? (
        <p className="tool-card-problem" dir="auto">
          {problem}
        </p>
      ) : null}
      {approval}
      {open ? (
        <div id={`${id}-body`} className="tool-card-body">
          {call.argsPreview ? (
            <>
              <p className="tool-card-label">{TOOL_TEXT.arguments}</p>
              <pre
                role="group"
                className="tool-card-pre"
                tabIndex={0}
                aria-label={TOOL_TEXT.arguments}
              >
                {call.argsPreview}
              </pre>
            </>
          ) : null}
          {call.progress && !isTerminal(shown) ? (
            <>
              <p className="tool-card-label">{TOOL_TEXT.outputSoFar}</p>
              <pre
                role="group"
                className="tool-card-pre"
                data-untrusted="true"
                tabIndex={0}
                aria-label={TOOL_TEXT.outputSoFar}
              >
                {call.progress}
              </pre>
            </>
          ) : null}
          {problem ? (
            <>
              <p className="tool-card-label">{TOOL_TEXT.error}</p>
              <pre
                role="group"
                className="tool-card-pre"
                data-untrusted="true"
                tabIndex={0}
                aria-label={TOOL_TEXT.error}
              >
                {problem}
              </pre>
            </>
          ) : call.resultPreview ? (
            <>
              <p className="tool-card-label">
                {TOOL_TEXT.result} <span className="muted">{TOOL_TEXT.resultNote}</span>
              </p>
              <pre
                role="group"
                className="tool-card-pre"
                data-untrusted="true"
                tabIndex={0}
                aria-label={TOOL_TEXT.result}
              >
                {call.resultPreview}
              </pre>
            </>
          ) : null}
          {!call.argsPreview && !call.progress && !problem && !call.resultPreview ? (
            <p className="muted">{TOOL_TEXT.noDetails}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
