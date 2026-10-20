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
import { applyAppearance, readCachedLook, readCachedTheme } from './appearance.ts';
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
import { ManagedLockNotes } from './managed/ManagedNote.tsx';
import { LocaleFromSettings, LocaleProvider, useLocale } from './i18n/I18nProvider.tsx';
import { defineMessages } from '@nova/i18n';

const APP_TEXT = defineMessages('app', {
  connecting: 'Connecting to the Hub…',
  offline: 'Cannot reach the Hub',
  retry: 'Retry',
  setup: {
    title: 'Set up Nova',
    linkDetected: 'Setup link detected. Choose a display name to finish.',
    code: 'Setup code',
    codeHint: 'Printed by the Hub at startup, or run: {command}',
    name: 'Your name (optional)',
    finish: 'Finish setup',
    badCode: 'That setup code is invalid or has expired.',
    failed: 'Setup failed. Try again.',
  },
});

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
  // The interface language wraps everything (FR-016); signed in, it follows the setting.
  return (
    <LocaleProvider>
      <AppRoutes {...props} />
    </LocaleProvider>
  );
}

function AppRoutes(props: AppProps) {
  const [joining] = useState(() => isJoinPath(window.location.pathname));
  const [memberPage] = useState(() => memberPublicPage(window.location.pathname));
  const { locale } = useLocale();
  if (joining) return <JoinPage key={locale} />;
  if (memberPage) return <MemberPublicPageView key={locale} page={memberPage} />;
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
  // Re-render (and re-read messages) when the language changes.
  useLocale();
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
      setState({ kind: 'offline', message: errorMessage(err, APP_TEXT.offline) });
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
    // The last look this device applied (a saved theme and overrides included), else its theme.
    const look = readCachedLook(dark);
    if (look) applyAppearance(look, document.documentElement);
    else applyTheme(resolveTheme(readCachedTheme(), dark), document.documentElement);
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
        {state.kind === 'loading' ? <p className="muted">{APP_TEXT.connecting}</p> : null}
        {state.kind === 'offline' ? (
          <section className="panel" role="alert">
            <h1>{APP_TEXT.offline}</h1>
            <p className="muted">{state.message}</p>
            <Button onClick={() => void load()}>{APP_TEXT.retry}</Button>
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
  const { locale } = useLocale();
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
            <LocaleFromSettings />
            <ToastProvider>
              <AnnouncerProvider>
                <ThreadsProvider api={api}>
                  <ModelsProvider api={api}>
                    <TerminalsProvider>
                      <TeamRoleProvider role={state.session.role ?? null}>
                        {/* Locked fields name the policy's source (FR-106, WCAG 1.3.1). */}
                        <ManagedLockNotes>
                          <Workspace
                            key={locale}
                            displayName={displayName}
                            onDisplayName={setDisplayName}
                            onSignOut={signOut}
                            announceEveryMs={announceEveryMs}
                          />
                        </ManagedLockNotes>
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
          ? APP_TEXT.setup.badCode
          : APP_TEXT.setup.failed,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h1>{APP_TEXT.setup.title}</h1>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        {code ? (
          <p className="muted">{APP_TEXT.setup.linkDetected}</p>
        ) : (
          <TextField
            label={APP_TEXT.setup.code}
            hint={APP_TEXT.setup.codeHint({ command: 'nova-hub code' })}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            // A one-time code: paste and autofill work (WCAG 3.3.8).
            autoComplete="one-time-code"
            spellCheck={false}
          />
        )}
        <TextField
          label={APP_TEXT.setup.name}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error ?? undefined}
        />
        <Button type="submit" variant="primary" disabled={busy || effective.length < 10}>
          {APP_TEXT.setup.finish}
        </Button>
      </form>
    </section>
  );
}
