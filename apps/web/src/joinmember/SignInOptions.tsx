// The sign-in screen's providers (FR-113, docs/13 §7): "Continue with <provider>" for each OIDC
// provider the owner turned on, for people who linked their identity in Settings → Account. When
// the provider sent the browser back refused (`/sign-in?oidc_error=<reason>`), the reason is
// explained in plain words and removed from the address. With no provider and no refusal it
// renders nothing, so a Hub without OIDC shows only the setup code.
import { useEffect, useId, useState } from 'react';
import { Button, Icon, Spinner } from '@nova/ui';
import { oidcErrorText, oidcReturn, teamErrorMessage } from '../team/format.ts';
import { browser, isSafeExternalUrl } from '../team/leave.ts';
import { memberClient, type MemberClient } from './client.ts';
import './joinmember.css';

export function SignInOptions({
  client: given,
  search,
}: {
  client?: MemberClient;
  /** The query string to read `oidc_error` from (the address bar by default). */
  search?: string;
}) {
  const [client] = useState<MemberClient>(() => given ?? memberClient());
  const [refused] = useState(() => oidcReturn(search ?? window.location.search).error);
  const [providers, setProviders] = useState<{ id: string; label: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const headingId = useId();

  // The refusal leaves the address, so a reload does not show it again.
  useEffect(() => {
    if (search === undefined && refused) history.replaceState(null, '', window.location.pathname);
  }, [refused, search]);

  useEffect(() => {
    let alive = true;
    client.oidcProviders().then(
      (r) => alive && setProviders(r.items),
      () => alive && setProviders([]),
    );
    return () => {
      alive = false;
    };
  }, [client]);

  const start = async (providerId: string) => {
    setBusy(providerId);
    setFailure(null);
    try {
      const out = await client.oidcStart({ providerId, flow: 'sign_in' });
      if (!isSafeExternalUrl(out.url))
        throw new Error('The Hub sent an address this page will not open.');
      browser.leaveTo(out.url);
    } catch (err) {
      setFailure(err);
      setBusy(null);
    }
  };

  if (!refused && !providers?.length) return null;
  return (
    <section className="panel joinm-signin" aria-labelledby={headingId}>
      <h2 id={headingId}>Sign in</h2>
      {refused ? (
        <p className="joinm-notice" role="alert">
          <Icon name="alert" /> {oidcErrorText(refused)}
        </p>
      ) : null}
      {providers === null ? <Spinner label="Loading sign-in options" /> : null}
      {providers && providers.length > 0 ? (
        <>
          <p className="muted joinm-flush">
            Sign in with the account you linked in Settings → Account.
          </p>
          <div className="stack">
            {providers.map((p) => (
              <Button key={p.id} onClick={() => void start(p.id)} disabled={busy !== null}>
                {busy === p.id ? <Spinner /> : <Icon name="external" />} Continue with {p.label}
              </Button>
            ))}
          </div>
        </>
      ) : null}
      {failure ? (
        <p role="alert" className="nv-field-error">
          {teamErrorMessage(failure, 'Could not start signing in.')}
        </p>
      ) : null}
      <p className="muted joinm-flush">
        New here? Open the invitation link the owner of the Hub sent you.
      </p>
    </section>
  );
}
