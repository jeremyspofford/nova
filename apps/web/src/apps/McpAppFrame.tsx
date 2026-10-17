// The App frame (FR-198, docs/04 §2.9, docs/08 §3.1): a `ui://` resource in an iframe sandboxed
// to scripts only (never allow-same-origin, so it cannot reach the app, its session or storage),
// inside Nova's chrome: the app's name, its plugin or server, a Verified/Unverified badge, the
// display modes and Close. Modes change in place, so the app keeps running: inline (the height
// the app reports, capped), fullscreen (a dialog; Esc or Exit returns) and picture-in-picture (a
// floating panel, draggable and resizable; one at a time). Tool calls go to the Hub with origin
// `ui` and pass the policy gate; their approval cards render here, in Nova's chrome, never in
// the frame. What the app shares as model context is listed under "Shared with the model";
// anything it marks private stays in this frame.
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { ToolDescriptor, UiEntryPointView } from '@nova/shared';
import { Button, Icon, IconButton, trapTab } from '@nova/ui';
import { errorMessage, type ToolInvokeResult } from '../api.ts';
import { ApprovalCard } from '../chat/ApprovalCard.tsx';
import type { ClientApproval } from '../chat/thread-state.ts';
import { useAnnounce, useServices } from '../services.tsx';
import {
  HostBridge,
  MODEL_CONTEXT_MAX_CHARS,
  PRIVATE_KEY,
  RPC,
  RpcError,
  isPlainObject,
  linkUrl,
  messageText,
  splitModelContext,
  toolSegment,
  type RpcParams,
} from './bridge.ts';
import {
  DISPLAY_MODES,
  INLINE_DEFAULT_HEIGHT,
  INLINE_MAX_HEIGHT,
  claimPip,
  clampHeight,
  currentPip,
  releasePip,
  subscribePip,
  themeVariables,
  themeVariant,
  type DisplayMode,
} from './display.ts';
import './apps.css';

/** The MCP Apps protocol version Nova offers when an app names none (or one it cannot parse). */
export const UI_PROTOCOL_VERSION = '2026-01-26';
/** Tool calls one app may have running at once. */
export const MAX_APP_CALLS = 4;
/** Host-context key of Nova's file extension (file entry points). */
export const FILE_CONTEXT_KEY = 'nova/file';
const APPROVALS_KEPT = 5;
const WAITING_TEXT =
  'The call is waiting for your approval in Nova. Its result will not reach the app; run it again after you answer.';

/** A tool result as an app receives it (an MCP `CallToolResult`). */
export interface AppToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface AppOwner {
  name: string;
  verified: boolean;
}

export interface McpAppFrameProps {
  entry: UiEntryPointView;
  /** The chat the app belongs to: its tool calls run there and its context is shared there. */
  threadId: string | null;
  /** A card in a list (inline, fullscreen, picture-in-picture) or a whole page (/apps/<id>). */
  placement?: 'card' | 'page';
  owner?: AppOwner | null;
  /** The tool call the app renders: its input, then its result (sent after `initialized`). */
  toolCall?: { arguments: Record<string, unknown>; result?: AppToolResult | null };
  /** The file a file entry point opened (shared in the host context). */
  file?: { root: string; path: string };
  /** Kept running but hidden (another chat is open); a picture-in-picture app stays visible. */
  inactive?: boolean;
  /** `ui/message`: put the app's text in the composer, never send it; false when there is none. */
  onMessage?: (text: string) => boolean;
  /** The model-visible context the app shared (private parts removed); null clears it. */
  onModelContext?: (text: string | null) => void;
  onClose?: () => void;
  /** How often pending approvals are checked while a tool call waits. */
  approvalPollMs?: number;
}

const MODE_TEXT: Record<DisplayMode, string> = {
  inline: 'Inline',
  fullscreen: 'Full screen',
  pip: 'Picture in picture',
};

function toolResult(ok: boolean, text: string): AppToolResult {
  return ok
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], isError: true };
}

function clampPos(p: { right: number; bottom: number }) {
  const w = typeof window.innerWidth === 'number' ? window.innerWidth : 1024;
  const h = typeof window.innerHeight === 'number' ? window.innerHeight : 768;
  return {
    right: Math.round(Math.min(Math.max(0, p.right), Math.max(0, w - 160))),
    bottom: Math.round(Math.min(Math.max(0, p.bottom), Math.max(0, h - 80))),
  };
}

const MOVE_KEYS: Record<string, [number, number]> = {
  ArrowLeft: [24, 0],
  ArrowRight: [-24, 0],
  ArrowUp: [0, 24],
  ArrowDown: [0, -24],
};

export function McpAppFrame(props: McpAppFrameProps) {
  const {
    entry,
    threadId,
    placement = 'card',
    owner = null,
    toolCall,
    file,
    inactive = false,
    approvalPollMs = 1000,
  } = props;
  const { api } = useServices();
  const announce = useAnnounce();
  const pipKey = useId();
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<HostBridge | null>(null);
  const fullButton = useRef<HTMLButtonElement>(null);
  const exitButton = useRef<HTMLButtonElement>(null);
  const prevMode = useRef<DisplayMode>('inline');
  const initialized = useRef(false);
  const loads = useRef(0);
  const inflight = useRef(0);
  const tools = useRef<ToolDescriptor[] | null>(null);
  const sentResult = useRef<AppToolResult | null>(null);
  const seenApprovals = useRef(new Set<string>());
  const approvalsNow = useRef<ClientApproval[]>([]);
  /** What the app marked private: kept here, never sent to the Hub or a model. */
  const privateState = useRef<unknown[]>([]);
  const drag = useRef<{ x: number; y: number; right: number; bottom: number } | null>(null);
  /** Approval polls of running calls, stopped when the frame goes away. */
  const watchers = useRef(new Set<(refresh: boolean) => void>());

  const [mode, setMode] = useState<DisplayMode>('inline');
  const [height, setHeight] = useState(INLINE_DEFAULT_HEIGHT);
  const [approvals, setApprovals] = useState<ClientApproval[]>([]);
  const [focusFor, setFocusFor] = useState<Record<string, number>>({});
  const [shared, setShared] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [navigated, setNavigated] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [pos, setPos] = useState({ right: 16, bottom: 16 });

  const page = placement === 'page';
  /** What the app is told: a page is always full screen. */
  const shown: DisplayMode = page ? 'fullscreen' : mode;
  const dialog = !page && mode === 'fullscreen';

  useEffect(() => {
    approvalsNow.current = approvals;
  });
  useEffect(() => {
    const running = watchers.current;
    return () => {
      for (const stop of [...running]) stop(false);
    };
  }, []);

  // Entering fullscreen focuses Exit; leaving it returns focus to the Full screen button.
  useEffect(() => {
    const prev = prevMode.current;
    prevMode.current = mode;
    if (mode === 'fullscreen') exitButton.current?.focus();
    else if (prev === 'fullscreen') fullButton.current?.focus();
  }, [mode]);

  // Another app taking picture-in-picture sends this one back inline.
  const onPipChange = useEffectEvent(() => {
    if (mode !== 'pip' || currentPip() === pipKey) return;
    setMode('inline');
    bridge.current?.notify('ui/notifications/host-context-changed', { displayMode: 'inline' });
  });
  useEffect(() => subscribePip(() => onPipChange()), []);
  useEffect(() => () => releasePip(pipKey), [pipKey]);

  function hostContext(m: DisplayMode): Record<string, unknown> {
    return {
      theme: themeVariant(),
      styles: { variables: themeVariables() },
      displayMode: m,
      availableDisplayModes: page ? ['fullscreen'] : DISPLAY_MODES,
      locale: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: 'web',
      containerDimensions: { maxHeight: INLINE_MAX_HEIGHT },
      // After a reload the app gets back what it kept private; it never leaves this window.
      ...(privateState.current.length ? { [PRIVATE_KEY]: { content: privateState.current } } : {}),
      ...(file
        ? {
            [FILE_CONTEXT_KEY]: {
              root: file.root,
              path: file.path,
              name: file.path.split('/').pop() ?? file.path,
            },
          }
        : {}),
    };
  }

  function changeMode(next: DisplayMode): DisplayMode {
    if (page) return 'fullscreen';
    if (next === mode) return mode;
    setMode(next);
    if (next === 'pip') claimPip(pipKey);
    else releasePip(pipKey);
    bridge.current?.notify('ui/notifications/host-context-changed', { displayMode: next });
    announce(`${entry.title}: ${MODE_TEXT[next]}.`);
    return next;
  }

  // ---- bridge ---------------------------------------------------------------------------------

  function sendToolCall(): void {
    if (!toolCall) return;
    bridge.current?.notify('ui/notifications/tool-input', { arguments: toolCall.arguments });
    if (toolCall.result) {
      sentResult.current = toolCall.result;
      bridge.current?.notify('ui/notifications/tool-result', { ...toolCall.result });
    }
  }

  const result = toolCall?.result ?? null;
  useEffect(() => {
    if (!result || !initialized.current || sentResult.current === result) return;
    sentResult.current = result;
    bridge.current?.notify('ui/notifications/tool-result', { ...result });
  }, [result]);

  function mergeApprovals(items: ClientApproval[]): void {
    const fresh = items.filter((a) => !seenApprovals.current.has(a.id));
    if (!fresh.length) return;
    for (const a of fresh) seenApprovals.current.add(a.id);
    setApprovals((cur) => [...cur, ...fresh].slice(-APPROVALS_KEPT));
    // The newest card takes focus (never an Allow button; ApprovalCard focuses its heading).
    const first = fresh[0];
    if (first) setFocusFor((f) => ({ ...f, [first.id]: 1 }));
    announce(`${entry.title} needs your approval.`);
  }

  function updateApproval(view: ClientApproval): void {
    setApprovals((cur) => cur.map((a) => (a.id === view.id ? view : a)));
  }

  /** While a call waits, show the approvals the gate raised for it. */
  function watchApprovals(tool: string): (refresh: boolean) => void {
    let stopped = false;
    const tick = () => {
      api.listApprovals({ status: 'pending', ...(threadId ? { threadId } : {}) }).then(
        ({ items }) => {
          if (!stopped) mergeApprovals(items.filter((a) => a.tool === tool));
        },
        () => undefined,
      );
    };
    const first = setTimeout(tick, Math.min(200, approvalPollMs));
    const timer = setInterval(tick, approvalPollMs);
    const stop = (refresh: boolean) => {
      if (stopped) return;
      stopped = true;
      watchers.current.delete(stop);
      clearTimeout(first);
      clearInterval(timer);
      if (!refresh) return;
      // Cards still pending here were answered elsewhere or expired: show how they ended.
      for (const a of approvalsNow.current) {
        if (a.status === 'pending') api.getApproval(a.id).then(updateApproval, () => undefined);
      }
    };
    watchers.current.add(stop);
    return stop;
  }

  async function resolveTool(name: string): Promise<string | null> {
    const find = (list: ToolDescriptor[]) => {
      const own = list.filter((d) => !d.serverId || d.serverId === entry.serverId);
      const segment = toolSegment(name);
      return (
        own.find((d) => d.name === name) ??
        own.find((d) => d.name.slice(d.name.indexOf('.') + 1) === segment) ??
        null
      );
    };
    const cached = tools.current ? find(tools.current) : null;
    if (cached) return cached.name;
    try {
      tools.current = (await api.mcpServerTools(entry.serverId)).items;
    } catch (err) {
      throw new RpcError(RPC.refused, `Nova could not list this app's tools: ${errorMessage(err)}`);
    }
    return find(tools.current)?.name ?? null;
  }

  async function callTool(params: RpcParams): Promise<AppToolResult> {
    const name = params.name;
    if (typeof name !== 'string' || !name || name.length > 200)
      throw new RpcError(RPC.invalidParams, 'name must be a tool name');
    const args = params.arguments ?? {};
    if (!isPlainObject(args)) throw new RpcError(RPC.invalidParams, 'arguments must be an object');
    if (inflight.current >= MAX_APP_CALLS)
      throw new RpcError(RPC.refused, 'too many tool calls are running');
    inflight.current += 1;
    let stop: ((refresh: boolean) => void) | null = null;
    try {
      // An app calls its own server's tools only (docs/08 §3.1).
      const tool = await resolveTool(name);
      if (!tool)
        throw new RpcError(RPC.invalidParams, `${name} is not a tool of this app's server`);
      stop = watchApprovals(tool);
      return await invoke(tool, args);
    } finally {
      inflight.current -= 1;
      stop?.(true);
    }
  }

  /** One call through the Hub (the policy gate, origin `ui`); failures are tool errors. */
  async function invoke(tool: string, args: Record<string, unknown>): Promise<AppToolResult> {
    try {
      const res: ToolInvokeResult & { approvalId?: string | null } = await api.invokeTool(tool, {
        args,
        ...(threadId ? { threadId } : {}),
      });
      if (res.approvalId) {
        api.getApproval(res.approvalId).then(
          (a) => mergeApprovals([a]),
          () => undefined,
        );
        return toolResult(false, WAITING_TEXT);
      }
      return toolResult(res.ok, res.text || res.error?.message || '');
    } catch (err) {
      return toolResult(false, errorMessage(err, 'The tool call failed.'));
    }
  }

  function updateContext(params: RpcParams): Record<string, never> {
    const { visible, hidden } = splitModelContext(params);
    if (visible.length > MODEL_CONTEXT_MAX_CHARS)
      throw new RpcError(RPC.invalidParams, 'model context is limited to 4,000 tokens per app');
    privateState.current = hidden;
    const text = visible || null;
    setShared(text);
    props.onModelContext?.(text);
    return {};
  }

  function suggestMessage(params: RpcParams): Record<string, never> {
    const text = messageText(params);
    if (!props.onMessage?.(text))
      throw new RpcError(RPC.refused, 'there is no message box to fill here');
    announce(`${entry.title} added text to your message. Review it before you send.`);
    return {};
  }

  function onRequest(method: string, params: RpcParams): unknown {
    switch (method) {
      case 'ui/initialize': {
        initialized.current = false;
        const asked = params.protocolVersion;
        return {
          protocolVersion:
            typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked)
              ? asked
              : UI_PROTOCOL_VERSION,
          hostInfo: { name: 'Nova', version: '1' },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            logging: {},
            message: {},
            updateModelContext: {},
            // Nova's extension: content marked `_meta["nova/private"]` never reaches a model.
            experimental: { [PRIVATE_KEY]: {} },
          },
          hostContext: hostContext(shown),
        };
      }
      case 'ping':
        return {};
      case 'tools/call':
        return callTool(params);
      case 'ui/message':
        return suggestMessage(params);
      case 'ui/update-model-context':
        return updateContext(params);
      case 'ui/request-display-mode': {
        const m = params.mode;
        if (typeof m !== 'string' || !(DISPLAY_MODES as readonly string[]).includes(m))
          throw new RpcError(RPC.invalidParams, 'mode must be inline, fullscreen or pip');
        return { mode: changeMode(m as DisplayMode) };
      }
      case 'ui/open-link':
        // Shown as a link the user opens; a message never opens a window by itself.
        setLink(linkUrl(params));
        return {};
      default:
        throw new RpcError(RPC.methodNotFound, `${method} is not supported`);
    }
  }

  function onNotification(method: string, params: RpcParams): void {
    if (method === 'ui/notifications/initialized') {
      initialized.current = true;
      sendToolCall();
    } else if (method === 'ui/notifications/size-changed') {
      const h = params.height;
      if (typeof h === 'number' && Number.isFinite(h)) setHeight(clampHeight(h));
    }
    // Log messages and anything else need nothing from the host.
  }

  const request = useEffectEvent((method: string, params: RpcParams) => onRequest(method, params));
  const notification = useEffectEvent((method: string, params: RpcParams) =>
    onNotification(method, params),
  );
  useEffect(() => {
    const b = new HostBridge({
      frame: () => frame.current,
      onRequest: (m, p) => request(m, p),
      onNotification: (m, p) => notification(m, p),
    });
    b.start();
    bridge.current = b;
    return () => {
      b.stop();
      bridge.current = null;
    };
  }, []);

  // The theme can change while an app is open; tell it.
  const onTheme = useEffectEvent(() => {
    bridge.current?.notify('ui/notifications/host-context-changed', {
      theme: themeVariant(),
      styles: { variables: themeVariables() },
    });
  });
  useEffect(() => {
    if (typeof MutationObserver !== 'function') return;
    const obs = new MutationObserver(() => onTheme());
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme'],
    });
    return () => obs.disconnect();
  }, []);

  // ---- frame lifecycle --------------------------------------------------------------------------

  /** A second load means the app navigated its frame away from its resource: stop it. */
  const onLoad = () => {
    loads.current += 1;
    if (loads.current > 1) {
      initialized.current = false;
      setNavigated(true);
    }
  };

  const reload = () => {
    loads.current = 0;
    initialized.current = false;
    tools.current = null;
    sentResult.current = null;
    setNavigated(false);
    setFrameKey((k) => k + 1);
  };

  const close = () => {
    bridge.current?.request('ui/resource-teardown', {});
    releasePip(pipKey);
    // Its context leaves the chat with it.
    if (shared) props.onModelContext?.(null);
    props.onClose?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!dialog) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      changeMode('inline');
      return;
    }
    trapTab(e, root.current);
  };

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (mode !== 'pip' || page) return;
    if (e.target instanceof Element && e.target.closest('button, a')) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ...pos };
  };
  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    setPos(clampPos({ right: d.right - (e.clientX - d.x), bottom: d.bottom - (e.clientY - d.y) }));
  };
  const endDrag = () => {
    drag.current = null;
  };
  const onMoveKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = MOVE_KEYS[e.key];
    if (!step) return;
    e.preventDefault();
    setPos((p) => clampPos({ right: p.right + step[0], bottom: p.bottom + step[1] }));
  };

  const ownerName = owner?.name ?? null;
  const verified = owner?.verified === true;

  return (
    <section
      ref={root}
      className="app-frame"
      data-mode={page ? 'page' : mode}
      hidden={inactive && mode !== 'pip'}
      aria-labelledby={titleId}
      {...(dialog ? { role: 'dialog', 'aria-modal': true, tabIndex: -1 } : {})}
      style={
        !page && mode === 'pip' ? { right: `${pos.right}px`, bottom: `${pos.bottom}px` } : undefined
      }
      onKeyDown={onKeyDown}
    >
      <header
        className="app-frame-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="app-frame-id">
          <h3 id={titleId} className="app-frame-title">
            {entry.title}
          </h3>
          {ownerName ? <span className="app-frame-owner muted">{ownerName}</span> : null}
          <span className="app-frame-badge" data-verified={verified ? 'true' : 'false'}>
            {verified ? 'Verified' : 'Unverified'}
          </span>
        </div>
        <div className="app-frame-actions" role="group" aria-label={`${entry.title} display`}>
          {page ? null : (
            <>
              {mode === 'fullscreen' ? (
                <Button ref={exitButton} onClick={() => changeMode('inline')}>
                  Exit full screen
                </Button>
              ) : null}
              {mode === 'pip' ? (
                <Button
                  aria-label="Move panel (arrow keys)"
                  title="Drag the header or use the arrow keys"
                  onKeyDown={onMoveKey}
                >
                  Move
                </Button>
              ) : null}
              {DISPLAY_MODES.map((m) => (
                <Button
                  key={m}
                  ref={m === 'fullscreen' ? fullButton : undefined}
                  aria-pressed={mode === m}
                  data-display={m}
                  onClick={() => changeMode(m)}
                >
                  {MODE_TEXT[m]}
                </Button>
              ))}
            </>
          )}
          <IconButton icon={<Icon name="close" />} label={`Close ${entry.title}`} onClick={close} />
        </div>
      </header>
      <div
        className="app-frame-body"
        style={!page && mode === 'inline' ? { height: `${height}px` } : undefined}
      >
        {navigated ? (
          <div className="app-frame-stopped" role="status">
            <p>The app left its page, so Nova stopped it.</p>
            <Button onClick={reload}>
              <Icon name="refresh" /> Reload app
            </Button>
          </div>
        ) : (
          <iframe
            key={frameKey}
            ref={frame}
            className="app-frame-iframe"
            title={`App: ${entry.title}`}
            src={api.uiResourceUrl(entry.id)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={onLoad}
          />
        )}
      </div>
      {link ? (
        <p className="app-frame-notice" role="status">
          {entry.title} wants to open <code>{link}</code>{' '}
          <a href={link} target="_blank" rel="noopener noreferrer" onClick={() => setLink(null)}>
            Open link <Icon name="external" />
          </a>{' '}
          <Button variant="ghost" onClick={() => setLink(null)}>
            Dismiss
          </Button>
        </p>
      ) : null}
      {approvals.length ? (
        <div
          className="app-frame-approvals"
          role="group"
          aria-label={`Approvals for ${entry.title}`}
        >
          {approvals.map((a) => (
            <ApprovalCard
              key={a.id}
              approval={a}
              onChange={updateApproval}
              focusKey={focusFor[a.id] ?? 0}
            />
          ))}
        </div>
      ) : null}
      {shared ? (
        <details className="app-frame-shared">
          <summary>Shared with the model</summary>
          <pre>{shared}</pre>
          <p className="muted">Anything the app marks private stays in this window.</p>
        </details>
      ) : null}
    </section>
  );
}
