// The team's pages that render without a session (decision 5, FR-113): `/join` (joining with an
// invitation) and `/profile/<handle>` (a public profile card). App.tsx asks `memberPublicPage`
// for the current path before it mounts the Hub app.
import { JoinMemberPage, isMemberJoinPath } from './JoinMemberPage.tsx';
import { PublicProfilePage, profileHandleFrom } from './PublicProfilePage.tsx';

export type MemberPublicPage = { kind: 'join' } | { kind: 'profile'; handle: string };

/** The public team page a path names, or null for every other path. */
export function memberPublicPage(pathname: string): MemberPublicPage | null {
  if (isMemberJoinPath(pathname)) return { kind: 'join' };
  const handle = profileHandleFrom(pathname);
  return handle ? { kind: 'profile', handle } : null;
}

export function MemberPublicPageView({ page }: { page: MemberPublicPage }) {
  return page.kind === 'join' ? <JoinMemberPage /> : <PublicProfilePage handle={page.handle} />;
}
