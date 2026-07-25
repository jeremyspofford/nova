import { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AppShell } from './shell/AppShell';
import { checkAuth, setAuthToken, type AuthState } from './api';
import { ErrorBoundary } from './components/ErrorBoundary';

/** Token gate — shown only when the backend has NOVA_AUTH_TOKEN set and we
 *  don't hold the right one. Empty token backend-side = open (dev). */
export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null); // null = checking
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const locked = auth === 'locked';

  useEffect(() => {
    // login-by-link: a token in the URL FRAGMENT (#token=…) — fragments
    // never cross the network or reach server logs. This is what the
    // phone-setup QR encodes, and it kills manual token entry entirely.
    const m = window.location.hash.match(/token=([^&]+)/);
    if (m) {
      setAuthToken(decodeURIComponent(m[1]).trim());
      history.replaceState(null, '', window.location.pathname);
    }
    checkAuth().then(setAuth);
    const onUnauthorized = () => setAuth('locked');
    window.addEventListener('nova:unauthorized', onUnauthorized);
    return () => window.removeEventListener('nova:unauthorized', onUnauthorized);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAuthToken(token.trim());
    const next = await checkAuth();
    if (next === 'ok') {
      setError('');
      setAuth('ok');
    } else {
      setAuthToken(null);
      setError(next === 'offline'
        ? "Couldn't reach Nova — is the backend running?"
        : 'That token was not accepted.');
    }
  }

  if (auth === null) return <div className="w-full h-screen bg-stone-950" />;

  if (auth === 'offline') {
    return (
      <div className="w-full h-screen bg-stone-950 flex items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-xl bg-stone-900/95 border border-stone-700
                        shadow-2xl p-6 space-y-3 text-center">
          <h1 className="text-teal-400 font-semibold text-lg">Nova</h1>
          <p className="text-sm text-stone-300">Can&rsquo;t reach the backend.</p>
          <p className="text-xs text-stone-500">
            It may still be starting. If it stays down:
            <code className="mx-1 text-stone-400">docker compose up -d backend</code>
          </p>
          <button
            onClick={() => { setAuth(null); checkAuth().then(setAuth); }}
            className="w-full bg-teal-700 hover:bg-teal-600 text-white rounded py-2 text-sm">
            retry
          </button>
        </div>
      </div>
    );
  }

  if (locked) {
    return (
      <div className="w-full h-screen bg-stone-950 flex items-center justify-center p-4">
        <form onSubmit={submit}
          className="w-full max-w-sm rounded-xl bg-stone-900/95 border border-stone-700 shadow-2xl p-6 space-y-4">
          <div>
            <h1 className="text-teal-400 font-semibold text-lg">Nova</h1>
            <p className="text-xs text-stone-500 mt-1">
              This instance requires the admin token (NOVA_AUTH_TOKEN in .env).
            </p>
          </div>
          <input
            type="password"
            autoFocus
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="admin token"
            className="w-full bg-stone-800 border border-stone-700 rounded px-3 py-2 text-sm text-stone-200 focus:outline-none focus:ring-1 focus:ring-teal-500"
          />
          {error && <div className="text-xs text-red-400">{error}</div>}
          <button type="submit"
            className="w-full bg-teal-700 hover:bg-teal-600 text-white rounded py-2 text-sm">
            unlock
          </button>
        </form>
      </div>
    );
  }

  return (
    <ErrorBoundary label="Nova">
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
