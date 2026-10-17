// App-wide services handed down by context: the Hub client, the stream factory, the command
// registry, a screen-reader announcer, per-session chat memory (drafts, scroll positions and
// messages queued for a chat that was just created), a bus that hands the open chat's events
// to the inspector panels (artifacts, activity) without a second stream, and the socket and
// screen factories terminals use (FR-006), which tests replace with fakes.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { EventEnvelope, MentionKind, SendMessageRequest } from '@nova/shared';
import { VisuallyHidden } from '@nova/ui';
import type { Api } from './api.ts';
import type { CommandRegistry } from './commands.ts';
import type { EventSourceFactory } from './sse.ts';
import {
  browserWebSocket,
  xtermScreen,
  type TerminalScreenFactory,
  type WebSocketFactory,
} from './terminal/session.ts';

export interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Base64 contents. */
  data: string;
}

/** An `@`-mention chip in the composer (FR-022); `ref` goes back to the Hub with the message. */
export interface MentionChip {
  kind: MentionKind;
  ref: string;
  label: string;
}

export interface Draft {
  text: string;
  attachments: PendingAttachment[];
  mentions?: MentionChip[];
}

/** Events of the open chat, re-published for panels that show the same thread. */
export interface ThreadBus {
  emit: (env: EventEnvelope) => void;
  subscribe: (fn: (env: EventEnvelope) => void) => () => void;
}

export function createThreadBus(): ThreadBus {
  const subs = new Set<(env: EventEnvelope) => void>();
  return {
    emit: (env) => {
      for (const fn of [...subs]) fn(env);
    },
    subscribe: (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export interface ChatMemory {
  drafts: Map<string, Draft>;
  scroll: Map<string, number>;
  /** A first message waiting for its newly created chat to open. */
  pending: Map<
    string,
    Draft & { model?: string; reasoningLevel?: SendMessageRequest['reasoningLevel'] }
  >;
}

export interface Services {
  api: Api;
  eventSource: EventSourceFactory;
  registry: CommandRegistry;
  memory: ChatMemory;
  bus: ThreadBus;
  webSocket: WebSocketFactory;
  terminalScreen: TerminalScreenFactory;
}

const ServicesCtx = createContext<Services | null>(null);

export function ServicesProvider({
  api,
  eventSource,
  registry,
  webSocket = browserWebSocket,
  terminalScreen = xtermScreen,
  children,
}: Omit<Services, 'memory' | 'bus' | 'webSocket' | 'terminalScreen'> &
  Partial<Pick<Services, 'webSocket' | 'terminalScreen'>> & { children: ReactNode }) {
  const [mem] = useState<ChatMemory>(() => ({
    drafts: new Map(),
    scroll: new Map(),
    pending: new Map(),
  }));
  const [bus] = useState(createThreadBus);
  const value = useMemo(
    () => ({ api, eventSource, registry, memory: mem, bus, webSocket, terminalScreen }),
    [api, eventSource, registry, mem, bus, webSocket, terminalScreen],
  );
  return <ServicesCtx.Provider value={value}>{children}</ServicesCtx.Provider>;
}

export function useServices(): Services {
  const s = useContext(ServicesCtx);
  if (!s) throw new Error('useServices must be used inside <ServicesProvider>');
  return s;
}

// ---- screen-reader announcements (docs/04 §4.4) -------------------------------------------------

type Announce = (text: string) => void;
const AnnounceCtx = createContext<Announce>(() => undefined);

/** One polite live region for the app; repeated text is re-announced. */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState({ text: '', n: 0 });
  const announce = useCallback((text: string) => setMsg((m) => ({ text, n: m.n + 1 })), []);
  return (
    <AnnounceCtx.Provider value={announce}>
      {children}
      <div aria-live="polite" aria-atomic="true" data-testid="announcer">
        <VisuallyHidden>
          {/* Alternating a trailing no-break space makes identical messages announce again. */}
          {msg.text ? `${msg.text}${msg.n % 2 ? ' ' : ''}` : ''}
        </VisuallyHidden>
      </div>
    </AnnounceCtx.Provider>
  );
}

export function useAnnounce(): Announce {
  return useContext(AnnounceCtx);
}
