// Application root: connects to the Hub, handles first-run setup and sign-in, then mounts the
// signed-in workspace with its stores. Until settings load, the cached theme paints the page.
// `/add-device` is the joining device's page instead, which needs no session (FR-132).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, TextField, ToastProvider, applyTheme, resolveTheme } from '@nova/ui';
import {
  ApiError,
  errorMessage,
  type Api,
  type Hello,
  type ResolvedSetting,
  type Session,
} from './api.ts';
import { readCachedTheme } from './appearance.ts';
import { CommandRegistry } from './commands.ts';
import { AnnouncerProvider, ServicesProvider } from './services.tsx';
import { SettingsProvider } from './settings.tsx';
import { browserEventSource, type EventSourceFactory } from './sse.ts';
import { ModelsProvider, ThreadsProvider } from './stores.tsx';
import { Workspace } from './shell/Workspace.tsx';
import { JoinPage, isJoinPath } from './join/JoinPage.tsx';
import type { TerminalScreenFactory, WebSocketFactory } from './terminal/session.ts';
import { TerminalsProvider } from './terminal/TerminalPanel.tsx';

type State =
  | { kind: 'loading' }
  | { kind: 'offline'; message: string }
  | { kind: 'signed-out'; hello: Hello; setupCode: string | null }
  | { kind: 'ready'; hello: Hello; session: Session; settings: ResolvedSetting[] };

export interface AppProps {
  api: Api;
  registry?: CommandRegistry;
  eventSource?: EventSourceFactory;
  /** Reads and clears the one-time setup code from the URL fragment. */
  takeSetupCode?: () => string | null;
  /** Minimum gap between streaming announcements (tests shorten it). */
  announceEveryMs?: number;
  /** Terminal socket and screen (FR-006); the browser's WebSocket and xterm.js by default. */
  webSocket?: WebSocketFactory;
  terminalScreen?: TerminalScreenFactory;
}

export function takeSetupCodeFromLocation(): string | null {
  const m = /(?:^#|&)setup=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (!m) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return m[1] ?? null;
}

/**
 * The joining device's page (`/add-device`, FR-132) renders without a session, before the setup
 * or sign-in screen; every other path is the Hub app.
 */
export function App(props: AppProps) {
  const [joining] = useState(() => isJoinPath(window.location.pathname));
  return joining ? <JoinPage /> : <HubApp {...props} />;
}

function HubApp({
  api,
  registry: given,
  eventSource = browserEventSource,
  takeSetupCode = takeSetupCodeFromLocation,
  announceEveryMs,
  webSocket,
  terminalScreen,
}: AppProps) {
  const registry = useMemo(() => given ?? new CommandRegistry(), [given]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [setupCode] = useState(() => takeSetupCode());
  const [displayName, setDisplayName] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const hello = await api.hello();
      try {
        const session = await api.session();
        const { settings } = await api.settings();
        setDisplayName(session.displayName);
        setState({ kind: 'ready', hello, session, settings });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401)
          setState({ kind: 'signed-out', hello, setupCode });
        else throw err;
      }
    } catch (err) {
      setState({ kind: 'offline', message: errorMessage(err, 'Cannot reach the Hub') });
    }
  }, [api, setupCode]);

  useEffect(() => {
    // load() sets state only after awaiting the network, so this cannot cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    if (state.kind === 'ready') return; // the workspace applies the full appearance
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
    applyTheme(resolveTheme(readCachedTheme(), dark), document.documentElement);
  }, [state.kind]);

  const signOut = () => {
    api.logout().then(
      () => void load(),
      () => void load(),
    );
  };

  if (state.kind === 'ready') {
    return (
      <ServicesProvider
        api={api}
        eventSource={eventSource}
        registry={registry}
        webSocket={webSocket}
        terminalScreen={terminalScreen}
      >
        <SettingsProvider api={api} initial={state.settings}>
          <ToastProvider>
            <AnnouncerProvider>
              <ThreadsProvider api={api}>
                <ModelsProvider api={api}>
                  <TerminalsProvider>
                    <Workspace
                      displayName={displayName}
                      onDisplayName={setDisplayName}
                      onSignOut={signOut}
                      announceEveryMs={announceEveryMs}
                    />
                  </TerminalsProvider>
                </ModelsProvider>
              </ThreadsProvider>
            </AnnouncerProvider>
          </ToastProvider>
        </SettingsProvider>
      </ServicesProvider>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Nova</span>
      </header>
      <main className="main" id="main">
        {state.kind === 'loading' ? <p className="muted">Connecting to the Hub…</p> : null}
        {state.kind === 'offline' ? (
          <section className="panel" role="alert">
            <h1>Cannot reach the Hub</h1>
            <p className="muted">{state.message}</p>
            <Button onClick={() => void load()}>Retry</Button>
          </section>
        ) : null}
        {state.kind === 'signed-out' ? (
          <SetupPanel api={api} code={state.setupCode} onDone={() => void load()} />
        ) : null}
      </main>
    </div>
  );
}

function SetupPanel({ api, code, onDone }: { api: Api; code: string | null; onDone: () => void }) {
  const [name, setName] = useState('');
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const effective = code ?? manual.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.setup(effective, name.trim() || undefined);
      onDone();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'That setup code is invalid or has expired.'
          : 'Setup failed. Try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h1>Set up Nova</h1>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        {code ? (
          <p className="muted">Setup link detected. Choose a display name to finish.</p>
        ) : (
          <TextField
            label="Setup code"
            hint="Printed by the Hub at startup, or run: nova-hub code"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            autoComplete="off"
          />
        )}
        <TextField
          label="Your name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" variant="primary" disabled={busy || effective.length < 10}>
          Finish setup
        </Button>
      </form>
    </section>
  );
}
