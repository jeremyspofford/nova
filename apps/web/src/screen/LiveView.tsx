// The live view of a computer (FR-087; docs/11 §4.2): frames from the Hub's live socket every
// 2 s, who holds control, and, while the user has taken over, their input: clicks on the frame,
// typing and keys while the frame has focus, a text field for longer text, key and scroll buttons,
// and a click by coordinates for keyboard users. The same view shows the desktop or the agent
// browser's page. Frames are the Hub's own PNG data; the screen's content is never interpreted.
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type WheelEvent,
} from 'react';
import type { ScreenStatusView } from '@nova/shared';
import { Button, Icon, Spinner, TextField } from '@nova/ui';
import { useServices } from '../services.tsx';
import { useScreenApi, type ScreenSurface } from './api.ts';
import { controllerText, sentence, timeOf } from './format.ts';

/** A desktop input event (screenInputSchema) or a browser page event (takeoverBrowserInputSchema). */
export type LiveInput =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' }
  | { kind: 'scroll'; x: number; y: number; dy: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string };

interface Frame {
  src: string;
  /** The frame's pixel size when the Hub reports it (desktop). */
  width: number | null;
  height: number | null;
  takenAt: string | null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const NAMED_KEYS = new Set([
  'Enter',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Insert',
]);
const TYPE_FLUSH_MS = 250;
const SCROLL_FLUSH_MS = 150;
const SCROLL_STEP = 300;
const MAX_COORD = 100_000;

/**
 * A key press as live input: printable characters are typed, named keys and combinations with
 * Ctrl, Alt or Meta are pressed. Tab and Esc stay in Nova (so focus can always leave the view).
 */
export function keyInput(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey'>,
  surface: ScreenSurface,
): LiveInput | null {
  const k = e.key;
  if (k === 'Tab' || k === 'Escape' || k === 'Dead' || k === 'Unidentified') return null;
  if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS'].includes(k)) return null;
  const combo = e.ctrlKey || e.altKey || e.metaKey;
  const named = NAMED_KEYS.has(k) || /^F([1-9]|1[0-2])$/.test(k);
  if (!combo && !named) return k.length === 1 ? { kind: 'type', text: k } : null;
  const key = k.length === 1 ? k.toLowerCase() : k;
  if (!/^[A-Za-z0-9]+$/.test(key)) return null;
  const mods =
    surface === 'browser'
      ? [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta', e.shiftKey && 'Shift']
      : [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.metaKey && 'meta', e.shiftKey && 'shift'];
  return { kind: 'key', keys: [...mods.filter(Boolean), key].join('+') };
}

/** The socket frame for an input: desktop actions as `action`, page events as `browser`. */
export function liveFrame(input: LiveInput, surface: ScreenSurface): Record<string, unknown> {
  if (surface === 'desktop') return { type: 'input', action: input };
  switch (input.kind) {
    case 'click':
      return { type: 'input', browser: { kind: 'click', x: input.x, y: input.y } };
    case 'scroll':
      return { type: 'input', browser: { kind: 'scroll', dy: input.dy } };
    case 'type':
      return { type: 'input', browser: input };
    case 'key':
      return { type: 'input', browser: { kind: 'key', key: input.keys } };
  }
}

const clampCoord = (v: number, size: number | null) =>
  Math.max(0, Math.min(Math.round(v), (size ?? MAX_COORD + 1) - 1, MAX_COORD));

export function LiveView({
  computerId,
  surface,
  control,
  onStatus,
  onClose,
}: {
  computerId: string;
  surface: ScreenSurface;
  /** The user has taken over: input goes to the computer. Otherwise the view only watches. */
  control: boolean;
  /** Every control state the Hub sends (on open and on each change). */
  onStatus?: (status: ScreenStatusView) => void;
  onClose?: () => void;
}) {
  const api = useScreenApi();
  const { webSocket } = useServices();
  const [frame, setFrame] = useState<Frame | null>(null);
  const [status, setStatus] = useState<ScreenStatusView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [conn, setConn] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const [attempt, setAttempt] = useState(0);
  const [text, setText] = useState('');
  const [point, setPoint] = useState({ x: '', y: '' });
  const socket = useRef<ReturnType<typeof webSocket> | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const typed = useRef('');
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scroll = useRef<{ dy: number; x: number; y: number }>({ dy: 0, x: 0, y: 0 });
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusCb = useRef(onStatus);
  const hintId = useId();
  useEffect(() => {
    statusCb.current = onStatus;
  });

  useEffect(() => {
    const ws = webSocket(api.screenLivePath(computerId, surface));
    socket.current = ws;
    let alive = true;
    ws.onopen = () => {
      if (!alive) return;
      setConn('open');
      setProblem(null);
    };
    ws.onmessage = (ev) => {
      if (!alive || typeof ev.data !== 'string') return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.type === 'state' && msg.status && typeof msg.status === 'object') {
        const s = msg.status as ScreenStatusView;
        setStatus(s);
        statusCb.current?.(s);
      } else if (msg.type === 'frame' && typeof msg.image === 'string' && BASE64.test(msg.image)) {
        setFrame({
          // The Hub always sends PNG; the type is fixed here, never taken from the message.
          src: `data:image/png;base64,${msg.image}`,
          width: typeof msg.width === 'number' ? msg.width : null,
          height: typeof msg.height === 'number' ? msg.height : null,
          takenAt: typeof msg.takenAt === 'string' ? msg.takenAt : null,
        });
      } else if (msg.type === 'error') {
        const e = msg.error as { message?: unknown } | undefined;
        setProblem(
          typeof e?.message === 'string' ? sentence(e.message) : 'The live view had a problem.',
        );
      } else if (msg.type === 'input.ack') {
        if (msg.ok === false)
          setProblem(
            typeof msg.error === 'string'
              ? `The input did not work: ${sentence(msg.error)}`
              : 'The input did not work.',
          );
        else setProblem(null);
      }
    };
    ws.onclose = () => {
      if (alive) setConn('closed');
    };
    ws.onerror = () => {
      if (alive) setConn('closed');
    };
    return () => {
      alive = false;
      socket.current = null;
      ws.close();
    };
  }, [api, webSocket, computerId, surface, attempt]);

  const send = useCallback((f: Record<string, unknown>): boolean => {
    const ws = socket.current;
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(f));
    return true;
  }, []);

  const flushTyping = useCallback(() => {
    if (typeTimer.current) clearTimeout(typeTimer.current);
    typeTimer.current = null;
    const t = typed.current;
    typed.current = '';
    if (t) send(liveFrame({ kind: 'type', text: t }, surface));
  }, [send, surface]);

  const input = useCallback(
    (i: LiveInput) => {
      if (!control) return;
      if (i.kind !== 'type') flushTyping();
      if (!send(liveFrame(i, surface))) setProblem('The live view is not connected.');
    },
    [control, flushTyping, send, surface],
  );

  useEffect(
    () => () => {
      if (typeTimer.current) clearTimeout(typeTimer.current);
      if (scrollTimer.current) clearTimeout(scrollTimer.current);
    },
    [],
  );

  /** A point on the shown frame in the computer's pixels. */
  const toScreen = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = img.current;
    if (!el || !frame) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const w = frame.width ?? (el.naturalWidth || rect.width);
    const h = frame.height ?? (el.naturalHeight || rect.height);
    return {
      x: clampCoord(((clientX - rect.left) / rect.width) * w, frame.width),
      y: clampCoord(((clientY - rect.top) / rect.height) * h, frame.height),
    };
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!control) return;
    const i = keyInput(e, surface);
    if (!i) return;
    e.preventDefault();
    if (i.kind === 'type') {
      typed.current += i.text;
      if (typeTimer.current) clearTimeout(typeTimer.current);
      typeTimer.current = setTimeout(flushTyping, TYPE_FLUSH_MS);
    } else input(i);
  };

  const onWheel = (e: WheelEvent<HTMLImageElement>) => {
    if (!control) return;
    const p = toScreen(e.clientX, e.clientY) ?? { x: 0, y: 0 };
    scroll.current = { dy: scroll.current.dy + e.deltaY, x: p.x, y: p.y };
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      const s = scroll.current;
      scroll.current = { dy: 0, x: 0, y: 0 };
      const dy = Math.max(-10_000, Math.min(10_000, Math.round(s.dy)));
      if (dy) input({ kind: 'scroll', x: s.x, y: s.y, dy });
    }, SCROLL_FLUSH_MS);
  };

  const scrollBy = (dy: number) => {
    const x = frame?.width ? Math.floor(frame.width / 2) : 0;
    const y = frame?.height ? Math.floor(frame.height / 2) : 0;
    input({ kind: 'scroll', x, y, dy });
  };

  const what = surface === 'browser' ? 'the agent browser' : "the computer's screen";
  const pointX = Number(point.x);
  const pointY = Number(point.y);
  const pointOk =
    point.x !== '' &&
    point.y !== '' &&
    Number.isInteger(pointX) &&
    Number.isInteger(pointY) &&
    pointX >= 0 &&
    pointY >= 0 &&
    (frame?.width === null || frame?.width === undefined || pointX < frame.width) &&
    (frame?.height === null || frame?.height === undefined || pointY < frame.height);

  return (
    <section className="scr-live" data-control={control || undefined} aria-label="Live view">
      <div className="ws-section-header">
        <p className="scr-live-who" role="status">
          {status ? controllerText(status) : 'Connecting to the live view…'}
        </p>
        <div className="ws-toolbar">
          <Button
            variant="ghost"
            onClick={() => send({ type: 'refresh' })}
            disabled={conn !== 'open'}
          >
            <Icon name="refresh" /> Refresh
          </Button>
          {onClose ? (
            <Button variant="ghost" onClick={onClose}>
              <Icon name="close" /> Close live view
            </Button>
          ) : null}
        </div>
      </div>
      {conn === 'closed' ? (
        <div className="ws-error" role="alert">
          <p>The live view is disconnected.</p>
          <Button
            onClick={() => {
              setConn('connecting');
              setAttempt((n) => n + 1);
            }}
          >
            Reconnect
          </Button>
        </div>
      ) : null}
      {problem ? (
        <p className="ws-warning" role="alert">
          <Icon name="alert" /> {problem}
        </p>
      ) : null}
      <div
        className="scr-live-frame"
        tabIndex={control ? 0 : -1}
        aria-label={control ? `Live view of ${what}. Typing here goes to the computer.` : undefined}
        aria-describedby={control ? hintId : undefined}
        onKeyDown={onKey}
        onBlur={flushTyping}
      >
        {frame ? (
          <img
            ref={img}
            src={frame.src}
            alt={`Live view of ${what}`}
            draggable={false}
            onClick={(e) => {
              const p = toScreen(e.clientX, e.clientY);
              if (p) input({ kind: 'click', x: p.x, y: p.y });
            }}
            onContextMenu={(e) => {
              if (!control || surface !== 'desktop') return;
              e.preventDefault();
              const p = toScreen(e.clientX, e.clientY);
              if (p) input({ kind: 'click', x: p.x, y: p.y, button: 'right' });
            }}
            onWheel={onWheel}
          />
        ) : conn === 'closed' ? null : (
          <p className="muted scr-live-wait">
            <Spinner label="Waiting for the first frame" /> Waiting for the screen…
          </p>
        )}
      </div>
      {frame?.takenAt ? (
        <p className="muted scr-live-time">Updated {timeOf(frame.takenAt)}</p>
      ) : null}
      {control ? (
        <div className="scr-live-controls">
          <p id={hintId} className="muted ws-flush">
            Click the screen to click there. While the screen has focus, what you type goes to the
            computer; Tab and Esc stay in Nova, so use the buttons below to send them.
          </p>
          <form
            className="ws-toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              if (!text) return;
              input({ kind: 'type', text });
              setText('');
            }}
          >
            <TextField
              label="Type text"
              value={text}
              maxLength={10_000}
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
            />
            <Button type="submit" disabled={!text}>
              Send text
            </Button>
          </form>
          <div className="ws-toolbar" role="group" aria-label="Send a key">
            {(['Enter', 'Tab', 'Escape', 'Backspace'] as const).map((k) => (
              <Button key={k} onClick={() => input({ kind: 'key', keys: k })}>
                {k === 'Escape' ? 'Esc' : k}
              </Button>
            ))}
            <Button onClick={() => scrollBy(-SCROLL_STEP)}>Scroll up</Button>
            <Button onClick={() => scrollBy(SCROLL_STEP)}>Scroll down</Button>
          </div>
          <details className="scr-live-point">
            <summary>Click at a point</summary>
            <form
              className="ws-toolbar"
              onSubmit={(e) => {
                e.preventDefault();
                if (pointOk) input({ kind: 'click', x: pointX, y: pointY });
              }}
            >
              <TextField
                label="X"
                inputMode="numeric"
                value={point.x}
                onChange={(e) => setPoint((p) => ({ ...p, x: e.target.value.trim() }))}
                hint={frame?.width ? `0 to ${frame.width - 1}` : undefined}
              />
              <TextField
                label="Y"
                inputMode="numeric"
                value={point.y}
                onChange={(e) => setPoint((p) => ({ ...p, y: e.target.value.trim() }))}
                hint={frame?.height ? `0 to ${frame.height - 1}` : undefined}
              />
              <Button type="submit" disabled={!pointOk}>
                Click
              </Button>
            </form>
          </details>
        </div>
      ) : null}
    </section>
  );
}
