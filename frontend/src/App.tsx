import { useEffect, useState } from 'react';
import { Brain } from './pages/Brain';
import { checkAuth, setAuthToken } from './api';

/** Token gate — shown only when the backend has NOVA_AUTH_TOKEN set and we
 *  don't hold the right one. Empty token backend-side = open (dev). */
export default function App() {
  const [locked, setLocked] = useState<boolean | null>(null); // null = checking
  const [token, setToken] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    checkAuth().then(ok => setLocked(!ok)).catch(() => setLocked(false));
    const onUnauthorized = () => setLocked(true);
    window.addEventListener('nova:unauthorized', onUnauthorized);
    return () => window.removeEventListener('nova:unauthorized', onUnauthorized);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAuthToken(token.trim());
    if (await checkAuth().catch(() => false)) {
      setError('');
      setLocked(false);
    } else {
      setAuthToken(null);
      setError('That token was not accepted.');
    }
  }

  if (locked === null) return <div className="w-full h-screen bg-stone-950" />;

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

  return <Brain />;
}
