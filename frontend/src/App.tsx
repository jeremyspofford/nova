import { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AppShell } from './shell/AppShell';
import { checkAuth, setAuthToken, type AuthState } from './api';
import { ErrorBoundary } from './components/ErrorBoundary';
import { GuestChat } from './pages/GuestChat';

/** Token gate — shown only when the backend has NOVA_AUTH_TOKEN set and we
 *  don't hold the right one. Empty token backend-side = open (dev). */
export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null); // null = checking
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const locked = auth === 'locked';

  // THE GUEST SHELL, decided before anything else runs and outside the
  // router on purpose (docs/plans/public-access-and-guests.md §3).
  //
  // `checkAuth()` probes GET /api/v1/settings, which a guest token is
  // REFUSED on by design — so a guest arriving at the normal app would be
  // told the token was wrong and shown the admin unlock box, which is both
  // untrue and an invitation to guess. Guests get their own page, which asks
  // the one route that can answer for them.
  //
  // This is a client-side branch and therefore not a control: it decides
  // which UI to draw, never what anyone may do. Every permission on this
  // page is enforced again in auth_middleware, and a guest who skips the
  // page entirely gets exactly the same answers from the API.
  const isGuest = window.location.pathname.startsWith('/guest');

  useEffect(() => {
    if (isGuest) return;   // the guest page owns its own token handling
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
  }, [isGuest]);

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

  if (isGuest) {
    return (
      <ErrorBoundary label="Nova">
        <GuestChat />
      </ErrorBoundary>
    );
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
