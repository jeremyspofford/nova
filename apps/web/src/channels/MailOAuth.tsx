// Email OAuth (FR-110, M8; SASL XOAUTH2): the authorization of a mailbox that signs in with its
// provider's tokens. Authorizing leaves the app for the provider's page (single-use state, PKCE);
// the Hub finishes the exchange, keeps the tokens in its vault and sends the browser back to
// /settings/channels?oauth=ok|error. The panel shows the state (never a token), what was granted,
// the redirect URI to register with the provider, Authorize (again) and Sign out, which asks
// first: it revokes the tokens at the provider and stops the mailbox.
import { useEffect, useState } from 'react';
import type { ChannelBindingViewM7 } from '@nova/shared';
import { Button, Dialog, Icon, Spinner, useToast } from '@nova/ui';
import { errorMessage } from '../api.ts';
import { navigate, useLocation } from '../router.ts';
import { formatWhen } from '../settings/common.ts';
import { oauthRedirect, safeAuthorizeUrl } from '../settings/McpAuth.tsx';
import { useChannelsM8Api } from './api-m8.ts';
import { MAIL_OAUTH_TEXT, OAUTH_STATUS, mailOAuthRedirectUri } from './format.ts';
import { Chip, CopyValue } from './parts.tsx';

const CHANNELS_PATH = '/settings/channels';

/** Start authorizing a binding's mailbox: the browser leaves for the provider's page. */
export function useMailOAuthStart(): {
  start: (b: ChannelBindingViewM7) => Promise<void>;
  busy: string | null;
} {
  const api = useChannelsM8Api();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const start = async (b: ChannelBindingViewM7) => {
    setBusy(b.id);
    try {
      const { authorizeUrl } = await api.startChannelOAuth(b.id);
      const url = safeAuthorizeUrl(authorizeUrl);
      if (!url) {
        toast.show(MAIL_OAUTH_TEXT.unsafeUrl, { tone: 'error' });
        return;
      }
      oauthRedirect.go(url);
    } catch (err) {
      toast.show(MAIL_OAUTH_TEXT.startFailed({ error: errorMessage(err) }), { tone: 'error' });
    } finally {
      // The page normally leaves for the provider; if it does not, the button works again.
      setBusy(null);
    }
  };
  return { start, busy };
}

/** An email binding that signs in with OAuth (its view carries `oauth`). */
export function usesMailOAuth(b: ChannelBindingViewM7): boolean {
  return (
    b.kind === 'email' && ((b.oauth !== null && b.oauth !== undefined) || b.config.auth === 'oauth')
  );
}

/** In a channel's row: Authorize while the mailbox is not authorized (or no longer). */
export function MailOAuthRowAction({ binding: b }: { binding: ChannelBindingViewM7 }) {
  const { start, busy } = useMailOAuthStart();
  if (!usesMailOAuth(b) || b.oauth?.status === 'connected') return null;
  const again = b.oauth?.status === 'expired' || b.oauth?.status === 'error';
  return (
    <Button
      variant="primary"
      disabled={busy !== null}
      aria-label={
        again
          ? MAIL_OAUTH_TEXT.authorizeAgainLabel({ label: b.label })
          : MAIL_OAUTH_TEXT.authorizeLabel({ label: b.label })
      }
      onClick={() => void start(b)}
    >
      {busy ? <Spinner /> : null}{' '}
      {again ? MAIL_OAUTH_TEXT.authorizeAgain : MAIL_OAUTH_TEXT.authorize}
    </Button>
  );
}

/** Why a row's mailbox needs the owner, or null. */
export function mailOAuthRowNote(b: ChannelBindingViewM7): string | null {
  if (!usesMailOAuth(b)) return null;
  const s = b.oauth?.status ?? 'needs_auth';
  if (s === 'needs_auth') return MAIL_OAUTH_TEXT.rowNeeds;
  if (s === 'expired' || s === 'error') return MAIL_OAUTH_TEXT.rowExpired;
  return null;
}

export function MailOAuthPanel({
  binding: b,
  onSaved,
}: {
  binding: ChannelBindingViewM7;
  onSaved: (b: ChannelBindingViewM7) => void;
}) {
  const api = useChannelsM8Api();
  const toast = useToast();
  const { start, busy } = useMailOAuthStart();
  const [confirm, setConfirm] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const oauth = b.oauth ?? {
    status: 'needs_auth' as const,
    scopes: [],
    expiresAt: null,
    authorizedAt: null,
    lastError: null,
  };
  const again = oauth.status !== 'needs_auth';

  const signOut = async () => {
    setSigningOut(true);
    setError(null);
    try {
      const next = await api.revokeChannelOAuth(b.id);
      onSaved(next);
      setConfirm(false);
      const text = MAIL_OAUTH_TEXT.signedOut({ label: b.label });
      toast.show(text, { tone: 'success' });
    } catch (err) {
      setError(MAIL_OAUTH_TEXT.signOutFailed({ error: errorMessage(err) }));
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <fieldset className="ws-fieldset" aria-label={MAIL_OAUTH_TEXT.panelLabel({ label: b.label })}>
      <legend>{MAIL_OAUTH_TEXT.heading}</legend>
      <p className="nv-field-hint ws-flush">{MAIL_OAUTH_TEXT.intro}</p>
      <p className="ws-row-meta ws-flush" role="status">
        <Chip spec={OAUTH_STATUS[oauth.status]} />
        {oauth.status === 'connected' && oauth.authorizedAt ? (
          <span className="muted">
            {MAIL_OAUTH_TEXT.authorizedWhen({ when: formatWhen(oauth.authorizedAt) })}
          </span>
        ) : null}
      </p>
      {oauth.status === 'connected' ? (
        <p className="muted ws-flush">{MAIL_OAUTH_TEXT.renews}</p>
      ) : null}
      {oauth.status === 'expired' ? (
        <p className="ws-warning">
          <Icon name="alert" /> {MAIL_OAUTH_TEXT.expiredHelp}
        </p>
      ) : null}
      {oauth.scopes.length ? (
        <p className="muted ws-flush">
          {MAIL_OAUTH_TEXT.scopes({ scopes: oauth.scopes.join(' ') })}
        </p>
      ) : null}
      {oauth.lastError ? (
        <p className="ws-warning">
          <Icon name="alert" /> {MAIL_OAUTH_TEXT.lastError({ error: oauth.lastError })}
        </p>
      ) : null}
      <CopyValue
        label={MAIL_OAUTH_TEXT.redirectLabel}
        value={mailOAuthRedirectUri()}
        hint={MAIL_OAUTH_TEXT.redirectHint}
      />
      <div className="row">
        <Button
          variant={again && oauth.status === 'connected' ? 'default' : 'primary'}
          disabled={busy !== null}
          aria-label={
            again
              ? MAIL_OAUTH_TEXT.authorizeAgainLabel({ label: b.label })
              : MAIL_OAUTH_TEXT.authorizeLabel({ label: b.label })
          }
          onClick={() => void start(b)}
        >
          {busy ? <Spinner /> : null}{' '}
          {again ? MAIL_OAUTH_TEXT.authorizeAgain : MAIL_OAUTH_TEXT.authorize}
        </Button>
        {again ? (
          <Button
            variant="ghost"
            aria-label={MAIL_OAUTH_TEXT.signOutLabel({ label: b.label })}
            onClick={() => setConfirm(true)}
          >
            {MAIL_OAUTH_TEXT.signOut}
          </Button>
        ) : null}
      </div>
      <Dialog
        open={confirm}
        title={MAIL_OAUTH_TEXT.signOutTitle}
        description={MAIL_OAUTH_TEXT.signOutWhat}
        onClose={() => {
          setConfirm(false);
          setError(null);
        }}
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>{MAIL_OAUTH_TEXT.cancel}</Button>
            <Button variant="danger" disabled={signingOut} onClick={() => void signOut()}>
              {signingOut ? <Spinner /> : null} {MAIL_OAUTH_TEXT.signOut}
            </Button>
          </>
        }
      >
        {error ? (
          <p role="alert" className="nv-field-error">
            {error}
          </p>
        ) : null}
      </Dialog>
    </fieldset>
  );
}

/** Reports a mailbox authorization the Hub redirected back from, once, then cleans the URL. */
export function useChannelOAuthReturn(): void {
  const toast = useToast();
  const loc = useLocation();
  const q = loc.indexOf('?');
  const result = q < 0 ? null : new URLSearchParams(loc.slice(q + 1)).get('oauth');
  useEffect(() => {
    if (result === null) return;
    const ok = result === 'ok';
    const text = ok ? MAIL_OAUTH_TEXT.returnedOk : MAIL_OAUTH_TEXT.returnedError;
    toast.show(text, { tone: ok ? 'success' : 'error' });
    navigate(CHANNELS_PATH, { replace: true });
  }, [result, toast]);
}
