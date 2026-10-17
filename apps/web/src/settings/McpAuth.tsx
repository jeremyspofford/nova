// OAuth for remote MCP servers (FR-047): the sign-in state of an http/sse server, with sign in,
// reconnect and sign out. Signing in leaves the app for the server's authorization page; the Hub
// finishes the exchange, stores the tokens in the vault and sends the browser back to
// /settings/tools?oauth=ok|error.
import { useEffect, useState } from 'react';
import type { McpAuthView, McpServerView } from '@nova/shared';
import { Button, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import { useServices } from '../services.tsx';
import { StateChip } from './badges.tsx';

/** Where the browser goes to sign in; tests replace `go`. */
export const oauthRedirect = {
  go: (url: string): void => {
    window.location.assign(url);
  },
};

export const AUTH_STATUS: Record<
  McpAuthView['status'],
  { text: string; tone: string | null; icon: 'check' | 'hand' | 'clock' | 'alert' }
> = {
  connected: { text: 'Signed in', tone: 'ready', icon: 'check' },
  needs_auth: { text: 'Needs sign-in', tone: 'needs_input', icon: 'hand' },
  expired: { text: 'Sign-in expired', tone: 'needs_input', icon: 'clock' },
  error: { text: 'Sign-in failed', tone: 'blocked', icon: 'alert' },
};

/** Only an https page (or http on this machine) may be opened for sign-in. */
export function safeAuthorizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return u.toString();
    const local =
      u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
    return u.protocol === 'http:' && local ? u.toString() : null;
  } catch {
    return null;
  }
}

export function McpAuthControls({
  server: s,
  onSaved,
}: {
  server: McpServerView;
  onSaved: (s: McpServerView) => void;
}) {
  const { api } = useServices();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const auth = s.auth;
  if (s.transport === 'stdio' || !auth || auth.kind !== 'oauth') return null;
  const st = AUTH_STATUS[auth.status];

  const start = async () => {
    setBusy(true);
    try {
      const { authorizeUrl } = await api.startMcpOAuth(s.id);
      const url = safeAuthorizeUrl(authorizeUrl);
      if (!url) throw new Error('The server gave a sign-in address that is not https.');
      oauthRedirect.go(url);
    } catch (err) {
      toast.show(`Could not start sign-in for ${s.name}: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      // The page normally leaves for the sign-in; if it does not, the button works again.
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      onSaved(await api.revokeMcpOAuth(s.id));
      toast.show(`Signed out of ${s.name}. Its tokens were revoked and deleted.`, {
        tone: 'success',
      });
    } catch (err) {
      toast.show(`Could not sign out of ${s.name}: ${errorMessage(err)}`, { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws-row-meta" role="group" aria-label={`Sign-in for ${s.name}`}>
      <StateChip {...st} />
      {auth.status === 'connected' && auth.expiresAt ? (
        <span className="muted">
          until{' '}
          {new Date(auth.expiresAt).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      ) : null}
      {auth.scopes.length ? <span className="muted">scopes: {auth.scopes.join(', ')}</span> : null}
      <Button
        disabled={busy}
        variant={auth.status === 'connected' ? 'ghost' : 'primary'}
        aria-label={`${auth.status === 'needs_auth' ? 'Sign in to' : 'Reconnect'} ${s.name}`}
        onClick={() => void start()}
      >
        {busy ? <Spinner /> : null} {auth.status === 'needs_auth' ? 'Sign in' : 'Reconnect'}
      </Button>
      {auth.status !== 'needs_auth' ? (
        <Button
          variant="ghost"
          disabled={busy}
          aria-label={`Sign out of ${s.name}`}
          onClick={() => void revoke()}
        >
          Sign out
        </Button>
      ) : null}
    </div>
  );
}

/** Reports the result of a sign-in the Hub redirected back from, once, then cleans the URL. */
export function useOAuthReturn(): void {
  const toast = useToast();
  const loc = useLocation();
  const q = loc.indexOf('?');
  const result = q < 0 ? null : new URLSearchParams(loc.slice(q + 1)).get('oauth');
  useEffect(() => {
    if (result === null) return;
    if (result === 'ok')
      toast.show('Signed in. The server reconnects with the new sign-in.', { tone: 'success' });
    else toast.show('Sign-in did not finish. Try again from the server below.', { tone: 'error' });
    navigate('/settings/tools', { replace: true });
  }, [result, toast]);
}
