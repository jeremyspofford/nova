// M8 managed policy (FR-106, docs/12 §10, ADR-078, ADR-097 D4). packages/core/src/index.ts
// re-exports it.
export {
  MANAGED_HOOKS_KEY,
  MANAGED_RESTRICT_KEY,
  ManagedPolicy,
  compileManaged,
  type ManagedPolicyOptions,
} from './policy.ts';
export {
  ManagedRestrictions,
  NO_RESTRICTIONS,
  effectiveEgressAllow,
  extensionOfTool,
  globMatch,
  managedDenied,
  managedRestrictions,
  mcpServerOfTool,
  type ManagedApprovalKind,
  type ManagedMcpServer,
  type ManagedRestrictionsOptions,
} from './restrictions.ts';
export {
  SECURITY_RULES,
  comparable,
  looser,
  meet,
  ruleFor,
  securityValueProblem,
  tightenSetting,
  type TightenRule,
} from './rules.ts';
export {
  MANAGED_MAX_BYTES,
  MANAGED_SIGNATURE_DOMAIN,
  checkProtectedFile,
  defaultManagedPath,
  fetchManagedEnvelope,
  managedEnvelopeSchema,
  managedPublicKey,
  nodeManagedFs,
  parseManagedPolicy,
  resolveManagedPath,
  signManagedPolicy,
  verifyManagedEnvelope,
  type ManagedFetch,
  type ManagedEnvelope,
  type ManagedFileInfo,
  type ManagedFs,
  type ManagedPathChoice,
  type ProtectedFileCheck,
  type ProtectedFileOptions,
} from './source.ts';
