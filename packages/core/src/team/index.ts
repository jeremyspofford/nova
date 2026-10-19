// M7 team module (FR-217, FR-091, FR-113; decision 5 of ADR-095): the people of one Hub and
// their invitations, OIDC sign-in, public profile cards, shared threads and team agents, and what
// a member may not do on a Hub that is not theirs.
export { TeamService, type TeamServiceOptions, type TeamSessions } from './members.ts';
export { hubOwnerId, isHubOwner, recordHubOwner } from './owner.ts';
export {
  PROFILE_CARD_BASE,
  ProfileCardService,
  type ProfileCardServiceOptions,
  type PublicCard,
} from './card.ts';
export {
  OIDC_ALGORITHMS,
  OidcError,
  authorizationUrl as oidcAuthorizationUrl,
  discover as discoverOidc,
  exchangeCode as exchangeOidcCode,
  fetchJwks as fetchOidcJwks,
  pkcePair as oidcPkcePair,
  randomToken as oidcRandomToken,
  verifyIdToken,
  type FetchLike,
  type IdTokenClaims,
  type OidcDiscovery,
  type OidcFailure,
  type VerifyIdTokenOptions,
} from './oidc.ts';
export {
  OIDC_CALLBACK_PATH,
  OidcService,
  type OidcOutcome,
  type OidcServiceOptions,
} from './oidc-service.ts';
export {
  SHARED_THREAD_LIMITS,
  SharedThreadService,
  type SharedEventSource,
  type SharedThreadServiceOptions,
  type Sharing,
} from './shared.ts';
export { TeamAgentService, type TeamAgentServiceOptions } from './agents.ts';
export {
  OWNER_ONLY_ROUTES,
  memberBodyReason,
  memberScoped,
  memberWorkspace,
  ownerOnlyError,
  ownerOnlyReason,
} from './access.ts';
export {
  pinnedPublicAddress,
  privateAddressError,
  publicFetch,
  publicHostProblem,
  publicUrlProblem,
  type ResolveHost,
} from './public-net.ts';
export { oneLine } from './text.ts';
