// OAuth for remote MCP servers (FR-047): the sign-in state of an http/sse server, with sign in,
// reconnect and sign out. Signing in leaves the app for the server's authorization page; the Hub
// finishes the exchange, stores the tokens in the vault and sends the browser back to
// /settings/tools?oauth=ok|error.
import { useEffect, useState } from 'react';
import { defineMessages, fmt } from '@nova/i18n';
import type { McpAuthView, McpServerView } from '@nova/shared';
import { Button, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import { useServices } from '../services.tsx';
import { StateChip } from './badges.tsx';

const S = defineMessages('settings.mcpAuth', {
  status: {
    connected: 'Signed in',
    needs_auth: 'Needs sign-in',
    expired: 'Sign-in expired',
    error: 'Sign-in failed',
  },
  notHttps: 'The server gave a sign-in address that is not https.',
  startFailed: 'Could not start sign-in for {name}: {error}',
  signedOut: 'Signed out of {name}. Its tokens were revoked and deleted.',
  signOutFailed: 'Could not sign out of {name}: {error}',
  group: 'Sign-in for {name}',
  until: 'until {when}',
  scopes: 'scopes: {scopes}',
  signInTo: 'Sign in to {name}',
  reconnectName: 'Reconnect {name}',
  signIn: 'Sign in',
  reconnect: 'Reconnect',
  signOutOf: 'Sign out of {name}',
  signOut: 'Sign out',
  returnOk: 'Signed in. The server reconnects with the new sign-in.',
  returnError: 'Sign-in did not finish. Try again from the server below.',
});

/** Where the browser goes to sign in; tests replace `go`. */
export const oauthRedirect = {
  go: (url: string): void => {
    window.location.assign(url);
  },
};

type AuthIcon = 'check' | 'hand' | 'clock' | 'alert';

/** A sign-in status chip; its words read in the active locale. */
function authChip(status: McpAuthView['status'], tone: string | null, icon: AuthIcon) {
  return {
    get text() {
      return S.status[status];
    },
    tone,
    icon,
  };
}

export const AUTH_STATUS: Record<
  McpAuthView['status'],
  { readonly text: string; tone: string | null; icon: AuthIcon }
> = {
  connected: authChip('connected', 'ready', 'check'),
  needs_auth: authChip('needs_auth', 'needs_input', 'hand'),
  expired: authChip('expired', 'needs_input', 'clock'),
  error: authChip('error', 'blocked', 'alert'),
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
      if (!url) throw new Error(S.notHttps);
      oauthRedirect.go(url);
    } catch (err) {
      toast.show(S.startFailed({ name: s.name, error: errorMessage(err) }), { tone: 'error' });
    } finally {
      // The page normally leaves for the sign-in; if it does not, the button works again.
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      onSaved(await api.revokeMcpOAuth(s.id));
      toast.show(S.signedOut({ name: s.name }), { tone: 'success' });
    } catch (err) {
      toast.show(S.signOutFailed({ name: s.name, error: errorMessage(err) }), { tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ws-row-meta" role="group" aria-label={S.group({ name: s.name })}>
      <StateChip text={st.text} tone={st.tone} icon={st.icon} />
      {auth.status === 'connected' && auth.expiresAt ? (
        <span className="muted">
          {S.until({
            when: fmt.dateTime(auth.expiresAt, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            }),
          })}
        </span>
      ) : null}
      {auth.scopes.length ? (
        <span className="muted">
          {S.scopes({ scopes: fmt.list(auth.scopes, { type: 'unit' }) })}
        </span>
      ) : null}
      <Button
        disabled={busy}
        variant={auth.status === 'connected' ? 'ghost' : 'primary'}
        aria-label={
          auth.status === 'needs_auth'
            ? S.signInTo({ name: s.name })
            : S.reconnectName({ name: s.name })
        }
        onClick={() => void start()}
      >
        {busy ? <Spinner /> : null} {auth.status === 'needs_auth' ? S.signIn : S.reconnect}
      </Button>
      {auth.status !== 'needs_auth' ? (
        <Button
          variant="ghost"
          disabled={busy}
          aria-label={S.signOutOf({ name: s.name })}
          onClick={() => void revoke()}
        >
          {S.signOut}
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
    if (result === 'ok') toast.show(S.returnOk, { tone: 'success' });
    else toast.show(S.returnError, { tone: 'error' });
    navigate('/settings/tools', { replace: true });
  }, [result, toast]);
}
