// M8 third-party app authorization (FR-222, ADR-097 D6): OAuth 2.0 authorization code with PKCE
// for public clients, consent records, `nva_` access and refresh tokens with rotation, the
// app-scoped route list, revocation and audit. packages/core/src/index.ts re-exports these by name.
export {
  AppAuthService,
  OAuthError,
  type AppAuthServiceOptions,
  type AppTokenIdentity,
  type AppsAllowed,
  type AuthorizationRequest,
} from './service.ts';
export {
  APP_OAUTH_PUBLIC_ROUTES,
  APP_ROUTE_SCOPES,
  appRouteScope,
  formatScopes,
  grantScopesJson,
  parseScopeParam,
  readGrantScopes,
  readScopeList,
  sortScopes,
  type AppRouteRule,
} from './scopes.ts';
export {
  checkRedirectUri,
  isHubPath,
  isLoopbackHost,
  matchRedirectUri,
  redirectWith,
  type RedirectCheck,
  type RedirectKind,
  type RedirectRefusal,
} from './redirect.ts';
export { isCodeVerifier, isS256Challenge, s256Challenge, verifyPkce } from './pkce.ts';
