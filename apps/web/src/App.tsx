// Application root: connects to the Hub, handles first-run setup and sign-in, then mounts the
// signed-in workspace with its stores. Until settings load, the cached theme paints the page.
// `/add-device` is the joining device's page instead, which needs no session (FR-132); so are the
// team's `/join` (joining with an invitation) and `/profile/<handle>` (a public card), and the
// sign-in screen offers the Hub's OIDC providers (FR-113, decision 5).
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
import { type EventSourceFactory } from './sse.ts';
import { hubTransport } from './relaytransport/transport.ts';
import { OfflineProvider } from './offline/context.tsx';
import type { OfflineRuntime } from './offline/runtime.ts';
import { TeamRoleProvider, loadHubSettings, memberSettingsApi } from './team/role.tsx';
import { ModelsProvider, ThreadsProvider } from './stores.tsx';
import { Workspace } from './shell/Workspace.tsx';
import { JoinPage, isJoinPath } from './join/JoinPage.tsx';
import { MemberPublicPageView, memberPublicPage } from './joinmember/pages.tsx';
import { SignInOptions } from './joinmember/SignInOptions.tsx';
import type { TerminalScreenFactory, WebSocketFactory } from './terminal/session.ts';
import { TerminalsProvider } from './terminal/TerminalPanel.tsx';

type State =
  | { kind: 'loading' }
  | { kind: 'offline'; message: string }
  | { kind: 'signed-out'; hello: Hello; setupCode: string | null }
  | {
      kind: 'ready';
      hello: Hello;
      session: Session;
      settings: ResolvedSetting[];
      /** A member's own settings, not the Hub's (M7, decision 5). */
      member: boolean;
    };

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
  /** The offline layer `createApi` was given (FR-112, FR-129); without it the app is online-only. */
  offline?: OfflineRuntime;
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
  const [memberPage] = useState(() => memberPublicPage(window.location.pathname));
  if (joining) return <JoinPage />;
  if (memberPage) return <MemberPublicPageView page={memberPage} />;
  return <HubApp {...props} />;
}

function HubApp({
  api,
  registry: given,
  // The event stream follows the Hub's path: direct, or through the Relay (FR-137).
  eventSource = hubTransport.eventSource,
  takeSetupCode = takeSetupCodeFromLocation,
  announceEveryMs,
  webSocket,
  terminalScreen,
  offline,
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
        // A member gets their own settings: the Hub refuses its settings to them (owner_only).
        const { settings, member } = await loadHubSettings(api);
        setDisplayName(session.displayName);
        setState({ kind: 'ready', hello, session, settings, member });
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
      <ReadyApp
        api={api}
        state={state}
        eventSource={eventSource}
        registry={registry}
        webSocket={webSocket}
        terminalScreen={terminalScreen}
        offline={offline}
        displayName={displayName}
        setDisplayName={setDisplayName}
        signOut={signOut}
        announceEveryMs={announceEveryMs}
      />
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
          <>
            <SignInOptions />
            <SetupPanel api={api} code={state.setupCode} onDone={() => void load()} />
          </>
        ) : null}
      </main>
    </div>
  );
}

/** The signed-in app: services, the offline layer, settings (the member's own for a member). */
function ReadyApp({
  api,
  state,
  eventSource,
  registry,
  webSocket,
  terminalScreen,
  offline,
  displayName,
  setDisplayName,
  signOut,
  announceEveryMs,
}: {
  api: Api;
  state: Extract<State, { kind: 'ready' }>;
  eventSource: EventSourceFactory;
  registry: CommandRegistry;
  webSocket: WebSocketFactory | undefined;
  terminalScreen: TerminalScreenFactory | undefined;
  offline: OfflineRuntime | undefined;
  displayName: string | null;
  setDisplayName: (name: string | null) => void;
  signOut: () => void;
  announceEveryMs: number | undefined;
}) {
  const settingsApi = useMemo(
    () => (state.member ? memberSettingsApi(api) : api),
    [api, state.member],
  );
  {
    return (
      <ServicesProvider
        api={api}
        eventSource={eventSource}
        registry={registry}
        webSocket={webSocket}
        terminalScreen={terminalScreen}
      >
        <OfflineProvider runtime={offline}>
          <SettingsProvider api={settingsApi} initial={state.settings}>
            <ToastProvider>
              <AnnouncerProvider>
                <ThreadsProvider api={api}>
                  <ModelsProvider api={api}>
                    <TerminalsProvider>
                      <TeamRoleProvider role={state.session.role ?? null}>
                        <Workspace
                          displayName={displayName}
                          onDisplayName={setDisplayName}
                          onSignOut={signOut}
                          announceEveryMs={announceEveryMs}
                        />
                      </TeamRoleProvider>
                    </TerminalsProvider>
                  </ModelsProvider>
                </ThreadsProvider>
              </AnnouncerProvider>
            </ToastProvider>
          </SettingsProvider>
        </OfflineProvider>
      </ServicesProvider>
    );
  }
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
