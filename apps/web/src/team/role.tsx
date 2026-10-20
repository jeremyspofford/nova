// Member mode (decision 5 of ADR-095): several people use one Hub, and the Hub's own settings and
// the areas that reach its machine belong to the owner. The Hub refuses members those routes
// (403 `policy_denied`, reason `owner_only`); the UI never shows them a dead control instead. This
// module knows who is signed in (owner or member), loads a member's own preferences in place of
// the Hub's settings (appearance, keyboard and onboarding are theirs), and says which Settings
// sections and surfaces a member sees; the rest show "Only the owner of this Hub can change this".
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { defineMessages } from '@nova/i18n';
import {
  SETTINGS,
  resolveSetting,
  type SettingKey,
  type TeamMeView,
  type TeamRole,
} from '@nova/shared';
import type { Api, ResolvedSetting } from '../api.ts';
import { useTeamApi, type MemberSettings, type TeamApi } from './api.ts';
import { isOwnerOnly } from './format.ts';
import { OwnerOnlyNotice } from './parts.tsx';

// ---- who is signed in --------------------------------------------------------------------------

export interface TeamRoleState {
  /** Null while unknown (loading, or a Hub without the team area): treated as the owner's view. */
  role: TeamRole | null;
  isMember: boolean;
  me: TeamMeView | null;
  reload: () => void;
}

const RoleCtx = createContext<TeamRoleState | null>(null);

const NONE: TeamRoleState = { role: null, isMember: false, me: null, reload: () => undefined };

/** Reads `GET /api/v1/team/me` while `active`; `given` stands in until it answers. */
function useFetchedRole(given: TeamRole | null | undefined, active: boolean): TeamRoleState {
  const api = useTeamApi();
  const [me, setMe] = useState<TeamMeView | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    api.getTeamMe().then(
      (view) => alive && setMe(view),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [api, active, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const role = me?.role ?? given ?? null;
  return useMemo(
    () => (active ? { role, isMember: role === 'member', me, reload } : NONE),
    [active, role, me, reload],
  );
}

/**
 * Who is signed in, for every view below it. `role` (from `GET /api/v1/session`) is used until
 * `GET /api/v1/team/me` answers; the views read it with `useTeamRole`.
 */
export function TeamRoleProvider({
  role,
  children,
}: {
  role?: TeamRole | null;
  children: ReactNode;
}) {
  const value = useFetchedRole(role, true);
  return <RoleCtx.Provider value={value}>{children}</RoleCtx.Provider>;
}

/** The signed-in person's role: from the provider, or fetched by this view when there is none. */
export function useTeamRole(): TeamRoleState {
  const shared = useContext(RoleCtx);
  // Hooks run unconditionally; under a provider the local copy stays idle.
  const local = useFetchedRole(null, shared === null);
  return shared ?? local;
}

/**
 * The signed-in person's account id from the shell's provider, or null outside it or while
 * unknown. It never fetches, so a list of messages can read it for each one (FR-217).
 */
export function useMyAccountId(): string | null {
  return useContext(RoleCtx)?.me?.accountId ?? null;
}

// ---- a member's settings in place of the Hub's ---------------------------------------------

function resolved(settings: MemberSettings): ResolvedSetting[] {
  return Object.keys(SETTINGS).map((key) => {
    const own = settings[key];
    if (own)
      return {
        key,
        value: own.value,
        source: own.source === 'member' ? 'global' : 'default',
        locked: false,
      };
    // Hub settings a member cannot read: the defaults stand in (their controls are hidden).
    return {
      key,
      value: resolveSetting(key as SettingKey, { global: {}, managed: {} }).value,
      source: 'default',
      locked: false,
    };
  });
}

/**
 * The settings store's client for a member (`<SettingsProvider api={…}>`): reads and writes go to
 * `/api/v1/team/me/settings`, so appearance, keyboard and onboarding are the member's own.
 */
export function memberSettingsApi(
  api: Pick<TeamApi, 'getMemberSettings' | 'setMemberSetting'>,
): Pick<Api, 'settings' | 'setSetting'> {
  return {
    settings: async () => ({ settings: resolved((await api.getMemberSettings()).settings) }),
    setSetting: async (key: string, value: unknown) => ({
      settings: resolved((await api.setMemberSetting(key, value)).settings),
    }),
  };
}

/**
 * The settings the app starts with: the Hub's for its owner; a member's own when the Hub refuses
 * its settings to this account (403 `owner_only`). Other failures are the caller's to handle.
 */
export async function loadHubSettings(
  api: Pick<Api, 'settings'> & Pick<TeamApi, 'getMemberSettings'>,
): Promise<{ settings: ResolvedSetting[]; member: boolean }> {
  try {
    return { ...(await api.settings()), member: false };
  } catch (err) {
    if (!isOwnerOnly(err)) throw err;
    return { settings: resolved((await api.getMemberSettings()).settings), member: true };
  }
}

// ---- what a member sees --------------------------------------------------------------------

/**
 * Settings sections a member uses: their own account, people, providers, memory and looks, and
 * since M8 (ADR-097 D7) their tools and MCP servers, notifications and channels, which show a
 * member only what they may change (src/team/access.tsx) and say who sets the rest.
 */
export const MEMBER_SETTINGS_SECTIONS: readonly string[] = [
  'account',
  'members',
  'profile',
  'accounts',
  'memory',
  'tools',
  'notifications',
  'channels',
  'appearance',
  'keyboard',
  'managed',
];

/** Labels of the team's own Settings sections. */
export const TEAM_SETTINGS_LABELS = defineMessages('team.settingsSections', {
  account: 'Account',
  members: 'Members',
});

/** Workspace surfaces that only reach the Hub's machine or administer the Hub (the guard's list). */
export const MEMBER_HIDDEN_SURFACES: readonly string[] = [
  'devices',
  'network',
  'library',
  'code',
  'marketplace',
];

export function visibleSettingsSections<S extends string>(
  all: readonly S[],
  role: TeamRole | null,
): S[] {
  return role === 'member' ? all.filter((s) => MEMBER_SETTINGS_SECTIONS.includes(s)) : [...all];
}

export function surfaceHiddenFor(role: TeamRole | null, surface: string): boolean {
  return role === 'member' && MEMBER_HIDDEN_SURFACES.includes(surface);
}

/**
 * Renders `children` for the owner, and the owner-only notice for a member when `ownerOnly` is
 * true (a Settings section or surface the member reached by its address).
 */
export function MemberGate({
  ownerOnly,
  what,
  children,
}: {
  ownerOnly: boolean;
  what?: string;
  children: ReactNode;
}) {
  const { isMember } = useTeamRole();
  if (isMember && ownerOnly) return <OwnerOnlyNotice what={what} />;
  return <>{children}</>;
}

/** A Settings section, gated: members get the notice for a section that is not theirs. */
export function MemberSettingsGate({
  section,
  label,
  children,
}: {
  section: string;
  label?: string;
  children: ReactNode;
}) {
  return (
    <MemberGate ownerOnly={!MEMBER_SETTINGS_SECTIONS.includes(section)} what={label}>
      {children}
    </MemberGate>
  );
}
