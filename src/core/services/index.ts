// Services (docs/plans/M10-orchestration.md, M10e): the definition format, the driver interface, the
// Service Manager and the console's own definition. The supervisor driver lives with the supervisor
// (src/supervisor/services.ts).
export { ALONGSIDE, CAPTURE_PERMISSIONS, CONSOLE, EGRESS, INTERPRETERS, PLACEMENT_MODES, PLATFORMS, commandProblem, isCaptureService, notLinux, platformKey, programName, promotionTier, validate } from './definition.ts';
export { SCREENPIPE, SCREENPIPE_PORT, screenpipeDefinition } from './screenpipe.ts';
export { DeviceWorkloads } from './workloads.ts';
export type { Alongside, Artifact, DeviceView, Placement, PlacementMode, Port, ProgramArtifact, ReleaseArtifact, ServiceDefinition, Validated } from './definition.ts';
export type { Outcome as ServiceOutcome, Plan as ServicePlan, PlanStep as ServicePlanStep, Say as ServiceSay, ServiceDriver, ServiceStatus, VersionStatus as ServiceVersionStatus, VersionView as ServiceVersionView } from './driver.ts';
export { ServiceManager } from './manager.ts';
export { FAILOVER_AFTER_MS, NEEDS as PLACEMENT_NEEDS, devicePlatform, ineligible as placementRefusal, resolvePlacement, wantedRoles } from './placement.ts';
export type { Considered as PlacementConsidered, PlacementDevice, PlacementHardware, Resolution as PlacementResolution, ResolveOptions as PlacementOptions } from './placement.ts';
export type { ManagerOptions as ServiceManagerOptions } from './manager.ts';
export { CONSOLE_HEALTH, consoleDefinition } from './console.ts';
