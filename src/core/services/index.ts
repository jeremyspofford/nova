// Services (docs/plans/M10-orchestration.md, M10e): the definition format, the driver interface, the
// Service Manager and the console's own definition. The supervisor driver lives with the supervisor
// (src/supervisor/services.ts).
export { ALONGSIDE, CONSOLE, EGRESS, INTERPRETERS, PLACEMENT_MODES, PLATFORMS, commandProblem, notLinux, platformKey, programName, promotionTier, validate } from './definition.ts';
export type { Alongside, Artifact, DeviceView, Placement, PlacementMode, Port, ProgramArtifact, ReleaseArtifact, ServiceDefinition, Validated } from './definition.ts';
export type { Outcome as ServiceOutcome, Plan as ServicePlan, PlanStep as ServicePlanStep, Say as ServiceSay, ServiceDriver, ServiceStatus, VersionStatus as ServiceVersionStatus, VersionView as ServiceVersionView } from './driver.ts';
export { ServiceManager } from './manager.ts';
export type { ManagerOptions as ServiceManagerOptions } from './manager.ts';
export { CONSOLE_HEALTH, consoleDefinition } from './console.ts';
