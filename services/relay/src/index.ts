// The self-hostable Relay service (FR-137, docs/22 §3, contracts/rest-api.md §3).
export {
  DEFAULT_LIMITS,
  buildRelayServer,
  parseTrustProxy,
  type RelayLimits,
  type RelayServer,
  type RelayServerOptions,
  type RelayStats,
} from './server.ts';
export {
  ROUTE_TOKEN_PREFIX,
  RelayState,
  newRouteToken,
  tokenHash,
  type ClientRoute,
  type HubRecord,
  type Pairing,
  type PushRegistration,
  type RevokedRoute,
} from './state.ts';
export { MockPushSender, type PushMessage, type PushSender } from './push.ts';
