// M8 Hub client calls of the team area (ADR-097; decision 5), in the conventions of src/api.ts: a
// removed member's data (kept for `team.removedMemberPurgeDays`, exported, purged on request) and
// what the signed-in person may reach (`GET /api/v1/team/me/access`, for member mode). `createApi`
// spreads `teamM8Api(call)` into the client; until then `useTeamM8Api` reads them from the
// services object.
import type { RemovedMemberView, TeamAccessView } from '@nova/shared';
import { useServices } from '../services.tsx';
import type { HubCall } from './api.ts';

const V1 = '/api/v1';
const enc = encodeURIComponent;

export function teamM8Api(call: HubCall) {
  return {
    /** Owner only: removed members and where the purge of their data stands. */
    listRemovedMembers: () => call<{ items: RemovedMemberView[] }>('GET', `${V1}/team/removed`),
    /**
     * Owner only: delete a removed member's data now (the confirmation is explicit in the body).
     * 409 `already_purged`; a purge that fails answers with `status: failed` and is retried later.
     */
    purgeRemovedMember: (accountId: string) =>
      call<RemovedMemberView>('POST', `${V1}/team/removed/${enc(accountId)}/purge`, {
        confirm: true,
      }),
    /** Where the browser downloads a removed member's data (owner only, until it is purged). */
    removedMemberExportUrl: (accountId: string) => `${V1}/team/removed/${enc(accountId)}/export`,
    /** What this person may reach: the owner-only routes and limits (empty for the owner). */
    getTeamAccess: () => call<TeamAccessView>('GET', `${V1}/team/me/access`),
  };
}

export type TeamM8Api = ReturnType<typeof teamM8Api>;

/** The M8 team calls of the app's client. */
export function useTeamM8Api(): TeamM8Api {
  const api: unknown = useServices().api;
  return api as TeamM8Api;
}
