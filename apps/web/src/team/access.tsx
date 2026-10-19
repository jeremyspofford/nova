// Member mode inside a page (ADR-097 D7; decision 5): what the signed-in person may reach, from
// `GET /api/v1/team/me/access`, so Tools & MCP, Notifications and Channels hide or explain the
// parts a member cannot use instead of showing controls the Hub refuses. The owner may do
// everything and nothing is fetched; for a member, anything not yet known counts as refused
// (fail closed), and the role alone already says the Hub's settings and machine are the owner's.
import { useEffect, useState, type ReactNode } from 'react';
import type { TeamAccessView } from '@nova/shared';
import { Icon } from '@nova/ui';
import { useTeamM8Api, type TeamM8Api } from './api-m8.ts';
import { MEMBER_MODE_TEXT } from './format.ts';
import { useTeamRole } from './role.tsx';

export interface MemberAccess {
  /** The signed-in person is a member (not the owner). */
  member: boolean;
  /** The Hub's answer, once loaded (members only). */
  view: TeamAccessView | null;
  /** The answer could not be read (members only): owner-only parts stay hidden. */
  error: unknown;
  /** Whether this person may call the route (method and Fastify pattern). */
  may: (method: string, route: string) => boolean;
  /** The Hub's own settings (beyond their appearance, keyboard and onboarding). */
  hubSettings: boolean;
  /** Stdio MCP servers: programs on the Hub machine. */
  stdioMcpServers: boolean;
  /** Provider, MCP, OAuth and mail servers on private addresses. */
  privateAddresses: boolean;
}

/** Whether `view` lists the route as refused (`*`, one method, or a comma-separated list). */
export function refusedRoute(view: TeamAccessView, method: string, route: string): boolean {
  const m = method.toUpperCase();
  return view.refused.some(
    (r) =>
      r.route === route &&
      (r.method === '*' ||
        r.method
          .split(',')
          .map((x) => x.trim().toUpperCase())
          .includes(m)),
  );
}

const OWNER: MemberAccess = {
  member: false,
  view: null,
  error: null,
  may: () => true,
  hubSettings: true,
  stdioMcpServers: true,
  privateAddresses: true,
};

export function useMemberAccess(): MemberAccess {
  const { isMember } = useTeamRole();
  const api = useTeamM8Api();
  const [view, setView] = useState<TeamAccessView | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!isMember) return;
    let alive = true;
    // A client without the call (an older Hub) knows nothing: everything stays refused.
    const get: TeamM8Api['getTeamAccess'] | undefined = (api as Partial<TeamM8Api>).getTeamAccess;
    (get ? get() : Promise.reject(new Error('no access route'))).then(
      (v) => {
        if (!alive) return;
        setView(v);
        setError(null);
      },
      (err: unknown) => alive && setError(err),
    );
    return () => {
      alive = false;
    };
  }, [api, isMember]);
  if (!isMember) return OWNER;
  return {
    member: true,
    view,
    error,
    may: (method, route) => (view ? !refusedRoute(view, method, route) : false),
    hubSettings: view?.limits.hubSettings ?? false,
    stdioMcpServers: view?.limits.stdioMcpServers ?? false,
    privateAddresses: view?.limits.privateAddresses ?? false,
  };
}

/** What a member can and cannot do on this page, said once at its top. */
export function MemberNote({ access, children }: { access: MemberAccess; children: ReactNode }) {
  if (!access.member) return null;
  return (
    <div className="ws-callout team-owner-only" role="note">
      <Icon name="shield" />
      <div className="stack">
        <p>{children}</p>
        {access.error ? <p className="muted">{MEMBER_MODE_TEXT.accessUnknown}</p> : null}
      </div>
    </div>
  );
}

/** In place of a part only the owner sets: who sets it, never a dead control. */
export function OwnerSets({ heading, children }: { heading: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-label={heading}>
      <h3>{heading}</h3>
      <p className="muted ws-flush">
        <Icon name="shield" /> {children}
      </p>
    </section>
  );
}
