// A public profile card, `/profile/<handle>` (FR-113): read-only, without a session. It shows
// only what the person chose to publish (their display name and, if they allowed it, their
// avatar) while the Hub allows public cards; anything else reads as "no card here". The avatar is
// loaded only from the Hub's own profile route.
import { useEffect, useState } from 'react';
import type { PublicProfileView } from '@nova/shared';
import { Icon, Spinner, applyTheme, resolveTheme } from '@nova/ui';
import { ApiError } from '../api.ts';
import { readCachedTheme } from '../appearance.ts';
import { teamErrorMessage } from '../team/format.ts';
import { memberClient, type MemberClient } from './client.ts';
import { JOIN_MEMBER_TEXT, PROFILE_TEXT as S } from './strings.ts';
import './joinmember.css';

export const PROFILE_PATH = '/profile';

/** The handle a `/profile/<handle>` path names, or null for any other path. */
export function profileHandleFrom(pathname: string): string | null {
  const m = /^\/profile\/([a-z0-9][a-z0-9_-]{2,39})\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

/** Only the Hub's own avatar route is ever loaded as an image. */
function safeAvatar(path: string | null, handle: string): string | null {
  return path === `/api/v1/profiles/${handle}/avatar` ? path : null;
}

type State =
  | { kind: 'loading' }
  | { kind: 'card'; card: PublicProfileView }
  | { kind: 'missing' }
  | { kind: 'error'; error: unknown };

export function PublicProfilePage({
  handle,
  client: given,
}: {
  handle: string;
  client?: MemberClient;
}) {
  const [client] = useState<MemberClient>(() => given ?? memberClient());
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
    applyTheme(resolveTheme(readCachedTheme(), dark), document.documentElement);
  }, []);

  useEffect(() => {
    let alive = true;
    client.publicProfile(handle).then(
      (card) => alive && setState({ kind: 'card', card }),
      (error: unknown) =>
        alive &&
        setState(
          error instanceof ApiError && error.status === 404
            ? { kind: 'missing' }
            : { kind: 'error', error },
        ),
    );
    return () => {
      alive = false;
    };
  }, [client, handle]);

  const avatar =
    state.kind === 'card' ? safeAvatar(state.card.avatarPath, state.card.handle) : null;
  return (
    <div className="shell joinm">
      <header className="topbar">
        <span className="brand">Nova</span>
      </header>
      <main className="main" id="main">
        <section className="panel joinm-panel" aria-label={S.region}>
          {state.kind === 'loading' ? <Spinner label={S.loading} /> : null}
          {state.kind === 'card' ? (
            <div className="joinm-card">
              {avatar ? (
                <img className="joinm-avatar" src={avatar} alt="" />
              ) : (
                <span className="joinm-avatar joinm-avatar-empty" aria-hidden="true">
                  <Icon name="at" size="28px" />
                </span>
              )}
              <div className="stack">
                <h1 className="joinm-flush" dir="auto">
                  {state.card.displayName ?? state.card.handle}
                </h1>
                <p className="muted joinm-flush" dir="ltr">
                  @{state.card.handle}
                </p>
              </div>
            </div>
          ) : null}
          {state.kind === 'missing' ? (
            <>
              <h1 className="joinm-flush">{S.missingTitle}</h1>
              <p className="muted joinm-flush">{S.missingBody}</p>
            </>
          ) : null}
          {state.kind === 'error' ? (
            <div role="alert">
              <h1 className="joinm-flush">{S.errorTitle}</h1>
              <p className="muted joinm-flush">
                {teamErrorMessage(state.error, JOIN_MEMBER_TEXT.noAnswer)}
              </p>
            </div>
          ) : null}
          <p className="muted joinm-flush joinm-foot">{S.foot}</p>
        </section>
      </main>
    </div>
  );
}
