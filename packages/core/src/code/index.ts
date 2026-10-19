// Code sessions (FR-061..FR-066, FR-069, FR-073, FR-074, FR-211; M6: FR-062, FR-067, FR-068,
// FR-070, FR-072, FR-073, FR-078, FR-097): sessions bound to a saved environment and a folder,
// permission modes as thread policy, change capture with a shadow Git repository, per-hunk review,
// comments, structured review, commits, pushes and pull requests with CI status, the worktree
// registry, dev servers, auto-verify, cross-session operations, the coding tools and the repo
// symbol index. See packages/core/src/runtime/types.ts for the seams.
export * from './git.ts';
export * from './diff.ts';
export * from './shadow.ts';
export * from './policy.ts';
export * from './symbols.ts';
export * from './review.ts';
export { COMMIT_HOOKS, hasCommitHooks, hookFile, hooksDir } from './commit.ts';
export * from './worktrees.ts';
export * from './service.ts';
export * from './tools.ts';
export {
  EnvironmentService,
  EnvHelperSandbox,
  environmentSecretRef,
  type CreateEnvironmentRequest,
  type EnvDeviceProvider,
  type EnvHelperConnection,
  type EnvHelperHello,
  type EnvHelperProcess,
  type EnvHelperRead,
  type EnvHelperSpawn,
  type EnvSshTarget,
  type EnvSshTransport,
  type EnvironmentServiceOptions,
  type UpdateEnvironmentRequest,
} from './environments.ts';
export {
  GitHostService,
  GitHubClient,
  ciStatusOf,
  gitHostTokenRef,
  parseRemote,
  type CreateGitHostRequest,
  type GitHostClient,
  type GitHostPull,
  type GitHostRepo,
  type GitHostServiceOptions,
} from './githost.ts';
export {
  PullRequestService,
  type CodeCreatePullRequest,
  type PullRequestServiceOptions,
  type CodePushRequest,
} from './pr.ts';
export {
  DevServerManager,
  MAX_DEV_SERVERS,
  detectDevServers,
  type DevServerGrant,
  type DevServerManagerOptions,
  type DevServerOpener,
} from './devservers.ts';
export { browserDevServerGrant, browserDevServerOpener, type DevServerBrowser } from './preview.ts';
export {
  AutoVerifier,
  detectVerifyCommands,
  type AutoVerifierOptions,
  type VerifyCommand,
} from './verify.ts';
export {
  CodeSessionOps,
  MAX_ACTIVE_WORKERS,
  SIDE_QUESTION_SYSTEM,
  type CodeSessionOpsOptions,
  type CodeSessionSummary,
  type CodeWorkerResult,
} from './sessions.ts';
export {
  CODE_M6_TOOL_NAMES,
  SESSION_TOOL_NAMES,
  codeAreaToolSource,
  codeM6Tools,
  type CodeM6ToolDeps,
} from './tools-m6.ts';
// M7 (docs/10 §2, §9, §15; FR-212, FR-213): environment transports, Hub-side capture for sessions
// on other machines, session handoff, three-way merges, best-of-N attempts, the SSH transport with
// pinned host keys, and delegation from agents.
export {
  LocalTransport,
  TRANSPORT_TAG,
  TransportGit,
  helperTransport,
  localWorkspace,
  nodeWorkFs,
  transportWorkFs,
  transportWorkspace,
  type CodeWorkspace,
  type EnvironmentTransport,
  type TransportRunRequest,
  type TransportRunResult,
  type WorkFs,
} from './transport.ts';
export {
  HandoffService,
  MAX_HANDOFF_BUNDLE_BYTES,
  MAX_HANDOFF_PATCH_BYTES,
  type HandoffServiceOptions,
  type SessionHandoffRequest,
  type ThreadHandoffRequest,
} from './handoff.ts';
export { MergeService, type MergeConflictMode, type MergeServiceOptions } from './merge.ts';
export {
  AttemptService,
  type ApplyAttemptRequest,
  type AttemptServiceOptions,
  type StartAttemptsRequest,
} from './attempts.ts';
export {
  OpenSshTransport,
  SSH_HELPER,
  SSH_HELPER_SHA256,
  SSH_HELPER_VERSION,
  SshHelperConnection,
  normalizeHostKey,
  type OpenSshOptions,
} from './ssh.ts';
export { hostKeyFingerprint } from './environments.ts';
export {
  CodeDelegations,
  type CodeAgentHost,
  type CodeDelegateInput,
  type CodeDelegationsOptions,
} from './delegation.ts';
