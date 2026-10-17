// App-wide services handed down by context: the Hub client, the stream factory, the command
// registry, a screen-reader announcer, and per-session chat memory (drafts, scroll positions and
// messages queued for a chat that was just created).
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { SendMessageRequest } from '@nova/shared';
import { VisuallyHidden } from '@nova/ui';
import type { Api } from './api.ts';
import type { CommandRegistry } from './commands.ts';
import type { EventSourceFactory } from './sse.ts';

export interface PendingAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Base64 contents. */
  data: string;
}

export interface Draft {
  text: string;
  attachments: PendingAttachment[];
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
}

const ServicesCtx = createContext<Services | null>(null);

export function ServicesProvider({
  api,
  eventSource,
  registry,
  children,
}: Omit<Services, 'memory'> & { children: ReactNode }) {
  const [mem] = useState<ChatMemory>(() => ({
    drafts: new Map(),
    scroll: new Map(),
    pending: new Map(),
  }));
  const value = useMemo(
    () => ({ api, eventSource, registry, memory: mem }),
    [api, eventSource, registry, mem],
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
