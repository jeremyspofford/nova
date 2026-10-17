// The Network Setup assistant (FR-136, docs/22 §6): plans, one-time consent, apply with snapshots,
// verification by reachability tests, automatic and one-click rollback.
export {
  DEFAULT_MESH_HOSTNAME,
  DEFAULT_MESH_TAGS,
  planNetworkSetup,
  type SetupPlanContext,
} from './planner.ts';
export {
  SETUP_CHANGE_KIND,
  lockoutRefusal,
  transportLost,
  type LockoutRefusal,
  type MeshEndpointCandidate,
  type SetupChangeLog,
  type SetupReachability,
  type SetupReachabilityResult,
  type SetupRelay,
  type SetupRelayState,
  type SetupTrust,
} from './seams.ts';
export { NetworkSetupService, type NetworkSetupServiceOptions } from './service.ts';
