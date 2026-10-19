// The self-hostable cloud runner service (FR-108, FR-071, contracts/rest-api.md §5; ADR-095).
export {
  DEFAULT_RATE_LIMITS,
  RUNNER_VERSION,
  buildRunnerServer,
  type RateLimits,
  type RunnerServer,
  type RunnerServerOptions,
} from './server.ts';
export {
  CACHE_ROOT,
  DEFAULT_RUNNER_LIMITS,
  Runner,
  STATE_DIR,
  WORKDIR,
  programPath,
  repoName,
  splitRef,
  workspacePath,
  type CreateEnvironmentInput,
  type ExecInput,
  type ProgramInput,
  type ProgramResult,
  type RunnerLimits,
  type RunnerOptions,
} from './runner.ts';
export {
  BwrapSubstrate,
  ContainerSubstrate,
  DEFAULT_IMAGE,
  commandScript,
  detectSubstrate,
  findOnPath,
  limitsPrelude,
  programScript,
  runOnce,
  type SandboxMount,
  type SandboxProcess,
  type SandboxSpec,
  type Substrate,
  type SubstrateKind,
} from './sandbox.ts';
export { filterArch, seccompProgram, type FilterArch } from './seccomp.ts';
export {
  RUNNER_TOKEN_PREFIX,
  addToken,
  findToken,
  newRunnerToken,
  parseTokenFile,
  readTokenFile,
  tokenHash,
  tokenRecord,
  type RunnerToken,
} from './tokens.ts';
export { RunnerError, isRunnerError, type RunnerErrorCode } from './errors.ts';
export { OutputRing, type OutputRead } from './output.ts';
export { diskUsage, parseProcStat, parseTimes, treeCpuSeconds } from './meter.ts';
export { redact, redactUrl } from './redact.ts';
export { MemoryLog, silentLog, streamLog, type RunnerLog, type RunnerLogRecord } from './log.ts';
export type * from './types.ts';
