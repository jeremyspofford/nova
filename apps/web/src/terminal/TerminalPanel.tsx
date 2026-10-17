// Terminals in the bottom panel and in terminal panes (FR-006): one tab per terminal, New and
// Close, and the screen of the selected one. Without a sandbox on the Hub the panel says so
// instead of failing. A screen is drawn by one view at a time; another view showing the same
// terminal offers to show it there instead.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { TerminalView } from '@nova/shared';
import { Button, Icon, IconButton, Spinner, rovingIndex, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import type { CommandRegistry } from '../commands.ts';
import { useAnnounce, useServices } from '../services.tsx';
import { TerminalHub, type TerminalsSnapshot } from './session.ts';

const HubCtx = createContext<TerminalHub | null>(null);

/** Commands whose keys reach the app while a terminal has focus; every other key goes to the shell. */
export const TERMINAL_PASSTHROUGH = new Set(['panel.toggle', 'terminal.toggle']);

/** False for key events the app handles instead of the shell (the panel and terminal toggles,
 *  and the palette's Shift binding, which shells do not use). */
export function terminalKeyFilter(registry: CommandRegistry): (e: KeyboardEvent) => boolean {
  return (e) => {
    const cmd = registry.match(e, { terminalFocus: true });
    if (!cmd) return true;
    if (TERMINAL_PASSTHROUGH.has(cmd.id)) return false;
    return !(cmd.id === 'palette.open' && e.shiftKey);
  };
}

export function TerminalsProvider({ children }: { children: ReactNode }) {
  const { api, registry, webSocket, terminalScreen } = useServices();
  const announce = useAnnounce();
  const [hub] = useState(
    () =>
      new TerminalHub(api, {
        socket: webSocket,
        screen: terminalScreen,
        keyFilter: terminalKeyFilter(registry),
      }),
  );
  useEffect(
    () =>
      hub.onExit((t) =>
        announce(`Terminal exited${t.exitCode === null ? '' : ` with code ${t.exitCode}`}.`),
      ),
    [announce, hub],
  );
  useEffect(() => () => hub.dispose(), [hub]);
  return <HubCtx.Provider value={hub}>{children}</HubCtx.Provider>;
}

export function useTerminalHub(): TerminalHub {
  const hub = useContext(HubCtx);
  if (!hub) throw new Error('useTerminalHub must be used inside <TerminalsProvider>');
  return hub;
}

export function useTerminals(): TerminalsSnapshot {
  const hub = useTerminalHub();
  return useSyncExternalStore(hub.subscribe, hub.snapshot, hub.snapshot);
}

export function terminalLabel(items: TerminalView[], id: string): string {
  const i = items.findIndex((t) => t.id === id);
  return `Terminal ${i < 0 ? '' : i + 1}`.trim();
}

export interface TerminalPanelProps {
  /** Identifies this view, e.g. "bottom:chat" or "pane:chat:p2". */
  viewKey: string;
  /** Hidden views do not take a screen from a visible one. */
  visible: boolean;
  /** New terminals run under this chat's permission profile. */
  threadId?: string | null;
  /** Changing this focuses the selected terminal, starting one when there is none. */
  focusSignal?: number;
  /** Changing this starts a new terminal and focuses it. */
  newSignal?: number;
  /** Accessible name for the region. */
  label?: string;
}

export function TerminalPanel({
  viewKey,
  visible,
  threadId = null,
  focusSignal = 0,
  newSignal = 0,
  label = 'Terminals',
}: TerminalPanelProps) {
  const hub = useTerminalHub();
  const snap = useTerminals();
  const toast = useToast();
  const announce = useAnnounce();
  const base = useId();
  const tabs = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const busy = snap.creating > 0;
  const items = snap.items;
  const selected = items.some((t) => t.id === picked) ? picked : (items.at(-1)?.id ?? null);

  useEffect(() => {
    if (visible) hub.load();
  }, [hub, visible]);

  /** A terminal to focus once its screen is shown. */
  const focusNext = useRef<string | null>(null);
  /** The missing-sandbox note takes focus once it shows, when a focus request found it. */
  const focusNote = useRef(false);
  const create = useCallback(
    (focus = false): Promise<string | null> =>
      hub.create({ threadId }).then(
        (id) => {
          if (id) {
            if (focus) focusNext.current = id;
            setPicked(id);
            announce('Terminal started.');
          } else if (focus) {
            focusNote.current = true;
            setPicked(null);
          }
          return id;
        },
        (err: unknown) => {
          toast.show(`Could not start a terminal: ${errorMessage(err)}`, { tone: 'error' });
          return null;
        },
      ),
    [announce, hub, threadId, toast],
  );

  const close = (id: string) => {
    const name = terminalLabel(items, id);
    hub.close(id).then(
      () => announce(`${name} closed.`),
      (err: unknown) =>
        toast.show(`Could not close ${name}: ${errorMessage(err)}`, { tone: 'error' }),
    );
  };

  // A focus request (the terminal shortcut) focuses the selected terminal, or starts one. It waits
  // for the Hub's list, so a reload does not start a second shell next to a running one.
  const seenSignal = useRef(focusSignal);
  const seenNew = useRef(newSignal);
  const focusPending = useRef(false);
  useEffect(() => {
    if (focusSignal !== seenSignal.current) {
      seenSignal.current = focusSignal;
      focusPending.current = true;
    }
    if (newSignal !== seenNew.current) {
      seenNew.current = newSignal;
      focusPending.current = false;
      if (!snap.unavailable) void create(true);
      else document.getElementById(`${base}-note`)?.focus();
    }
    if (focusNext.current && focusNext.current === selected) {
      focusNext.current = null;
      hub.session(selected).focus();
    }
    if (focusNote.current && snap.unavailable) {
      focusNote.current = false;
      document.getElementById(`${base}-note`)?.focus();
    }
    if (!focusPending.current || !snap.loaded || busy) return;
    focusPending.current = false;
    if (selected) hub.session(selected).focus();
    else if (snap.unavailable) document.getElementById(`${base}-note`)?.focus();
    else void create(true);
  });

  const onTabKey = (e: React.KeyboardEvent) => {
    const i = items.findIndex((t) => t.id === selected);
    const next = rovingIndex(e.key, Math.max(0, i), items.length, 'horizontal');
    if (next === null) return;
    e.preventDefault();
    const t = items[next];
    if (!t) return;
    setPicked(t.id);
    tabs.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <section className="terminal-panel" aria-label={label}>
      <div className="terminal-bar">
        {items.length ? (
          <div
            ref={tabs}
            role="tablist"
            aria-label="Open terminals"
            className="terminal-tabs"
            onKeyDown={onTabKey}
          >
            {items.map((t) => {
              const name = terminalLabel(items, t.id);
              const on = t.id === selected;
              return (
                <span key={t.id} className="terminal-tab" data-selected={on || undefined}>
                  <button
                    type="button"
                    role="tab"
                    id={`${base}-tab-${t.id}`}
                    aria-selected={on}
                    aria-label={t.status === 'exited' ? `${name} (exited)` : name}
                    aria-controls={`${base}-panel`}
                    tabIndex={on ? 0 : -1}
                    className="terminal-tab-button"
                    onClick={() => setPicked(t.id)}
                  >
                    <Icon name="terminal" /> {name}
                    {t.status === 'exited' ? <span className="muted"> (exited)</span> : null}
                  </button>
                  <IconButton
                    label={`Close ${name}`}
                    icon={<Icon name="close" />}
                    variant="ghost"
                    onClick={() => close(t.id)}
                  />
                </span>
              );
            })}
          </div>
        ) : (
          <span className="muted terminal-none">Terminal</span>
        )}
        <span className="terminal-bar-spacer" />
        <IconButton
          label="New terminal"
          icon={<Icon name="plus" />}
          variant="ghost"
          disabled={busy || !!snap.unavailable}
          onClick={() => void create()}
        />
      </div>
      {snap.unavailable ? (
        <p id={`${base}-note`} className="terminal-note" role="note" tabIndex={-1}>
          <Icon name="alert" /> {snap.unavailable}
        </p>
      ) : null}
      {selected ? (
        <div
          id={`${base}-panel`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${selected}`}
          className="terminal-body"
        >
          <TerminalScreenView
            key={selected}
            id={selected}
            owner={viewKey}
            visible={visible}
            name={terminalLabel(items, selected)}
          />
        </div>
      ) : snap.unavailable ? null : (
        <div className="terminal-empty">
          {!snap.loaded ? (
            <p className="muted">
              <Spinner label="Loading terminals" /> Loading…
            </p>
          ) : (
            <>
              <p className="muted">No terminal is open.</p>
              <Button onClick={() => void create(true)} disabled={busy}>
                <Icon name="terminal" /> Start a terminal
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function TerminalScreenView({
  id,
  owner,
  visible,
  name,
}: {
  id: string;
  owner: string;
  visible: boolean;
  name: string;
}) {
  const hub = useTerminalHub();
  const snap = useTerminals();
  const box = useRef<HTMLDivElement>(null);
  const [claim, setClaim] = useState(0);
  const session = snap.sessions[id];
  const mine = session?.owner === owner;

  useEffect(() => {
    const el = box.current;
    if (!visible || !el) return;
    const s = hub.session(id);
    s.attach(el, owner);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => s.fit());
      observer.observe(el);
    }
    return () => {
      observer?.disconnect();
      s.release(owner);
    };
  }, [hub, id, owner, visible, claim]);

  const state = session?.state ?? 'starting';
  const elsewhere = visible && !!session && session.owner !== null && !mine;
  return (
    <div className="terminal-screen-wrap">
      <div
        ref={box}
        className="terminal-screen"
        role="group"
        aria-label={name}
        hidden={elsewhere}
        onClick={() => hub.session(id).focus()}
      />
      {elsewhere ? (
        <div className="terminal-elsewhere">
          <p className="muted">{name} is shown in another place.</p>
          <Button onClick={() => setClaim((n) => n + 1)}>Show it here</Button>
        </div>
      ) : null}
      <p className="terminal-status muted" role="status">
        {state === 'starting' || state === 'connecting' ? (
          <>
            <Spinner label="Connecting" /> Connecting…
          </>
        ) : state === 'disconnected' ? (
          <>
            {session?.error ?? 'Disconnected from the terminal.'}{' '}
            <button type="button" className="link" onClick={() => hub.session(id).connect()}>
              Reconnect
            </button>
          </>
        ) : state === 'exited' ? (
          `The shell exited${session?.exitCode === null || session?.exitCode === undefined ? '' : ` with code ${session.exitCode}`}.`
        ) : null}
      </p>
    </div>
  );
}
