// Application shell for M0: first-run setup, theme from Hub settings, and the command palette.
// Later milestones fill the sidebar and modes (docs/04 §1).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, TextField, applyTheme, resolveTheme, type ThemeChoice } from '@nova/ui';
import { ApiError, type Api, type Hello, type Session } from './api.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { CommandRegistry, matchesBinding } from './commands.ts';

const THEME_ORDER: ThemeChoice[] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
  'high-contrast-light': 'High contrast light',
  'high-contrast-dark': 'High contrast dark',
};

type State =
  | { kind: 'loading' }
  | { kind: 'offline'; message: string }
  | { kind: 'signed-out'; hello: Hello; setupCode: string | null }
  | { kind: 'ready'; hello: Hello; session: Session };

export interface AppProps {
  api: Api;
  registry?: CommandRegistry;
  /** Reads and clears the one-time setup code from the URL fragment. */
  takeSetupCode?: () => string | null;
}

export function takeSetupCodeFromLocation(): string | null {
  const m = /(?:^#|&)setup=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  if (!m) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return m[1] ?? null;
}

export function App({ api, registry: given, takeSetupCode = takeSetupCodeFromLocation }: AppProps) {
  const registry = useMemo(() => given ?? new CommandRegistry(), [given]);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [theme, setTheme] = useState<ThemeChoice>(() => readCachedTheme());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [setupCode] = useState(() => takeSetupCode());

  const load = useCallback(async () => {
    try {
      const hello = await api.hello();
      try {
        const session = await api.session();
        setState({ kind: 'ready', hello, session });
        const { settings } = await api.settings();
        const t = settings.find((s) => s.key === 'appearance.theme')?.value as
          ThemeChoice | undefined;
        if (t) setTheme(t);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401)
          setState({ kind: 'signed-out', hello, setupCode });
        else throw err;
      }
    } catch (err) {
      setState({
        kind: 'offline',
        message: err instanceof Error ? err.message : 'Cannot reach the Hub',
      });
    }
  }, [api, setupCode]);

  useEffect(() => {
    // load() sets state only after awaiting the network, so this cannot cascade renders.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const apply = () =>
      applyTheme(resolveTheme(theme, mq?.matches ?? true), document.documentElement);
    apply();
    writeCachedTheme(theme);
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchesBinding(e, 'mod+k') || matchesBinding(e, 'mod+shift+p')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const cycleTheme = async () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? 'system';
    setTheme(next);
    if (state.kind === 'ready')
      await api.setSetting('appearance.theme', next).catch(() => undefined);
  };

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Nova</span>
        <div className="topbar-actions">
          <Button
            variant="ghost"
            onClick={() => setPaletteOpen(true)}
            aria-keyshortcuts="Control+K Meta+K"
          >
            Commands
          </Button>
          <Button
            variant="ghost"
            onClick={() => void cycleTheme()}
            aria-label={`Theme: ${THEME_LABEL[theme]}. Change theme`}
          >
            Theme: {THEME_LABEL[theme]}
          </Button>
        </div>
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
        {state.kind === 'ready' ? (
          <section className="panel">
            <h1>
              {state.session.displayName
                ? `Welcome, ${state.session.displayName}`
                : 'Welcome to Nova'}
            </h1>
            <p className="muted">
              The Hub is running (version {state.hello.version}). Chat, Work, Code and Agents arrive
              in the next milestones.
            </p>
          </section>
        ) : null}
      </main>
      <CommandPalette
        registry={registry}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
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

const THEME_CACHE_KEY = 'nova.theme';
function readCachedTheme(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(THEME_CACHE_KEY);
    return v && v in THEME_LABEL ? (v as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}
function writeCachedTheme(t: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, t);
  } catch {
    // private mode or blocked storage: theme still applies for this session
  }
}
