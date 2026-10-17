// Mesh adapters for the Network Setup assistant (FR-136, docs/22 §2, §6): Headscale (server),
// the Tailscale client, NetBird, plain WireGuard, ufw and OS package installs, all through
// `MeshCommandRunner` (argument lists, timeouts, secrets only through env or stdin).
export {
  classifyInterface,
  defaultNetworkProbe,
  detectInterfaces,
  detectPackageManager,
  inCgnat,
  ipv4Network,
  lanSubnets,
  parseResolvConf,
  type NetworkProbe,
  type PackageManager,
  type ResolvConf,
} from './detect.ts';
export {
  HeadscaleAdapter,
  headscaleCommand,
  mergeNovaPolicy,
  parseHeadscaleNodes,
  parseHeadscaleUsers,
  parseHuJson,
  summarizePolicy,
  type HeadscaleCli,
  type HeadscaleNode,
  type HeadscaleStepParams,
  type HeadscaleUser,
} from './headscale.ts';
export { installCommand, planInstall, removeCommand, type InstallableClient } from './install.ts';
export { NetbirdAdapter, netbirdUpCommand, parseNetbirdStatus } from './netbird.ts';
export {
  DEFAULT_MESH_COMMAND_TIMEOUT_MS,
  MeshCommandError,
  MeshExec,
  ProcessMeshRunner,
  previewCommand,
  type MeshCommand,
  type MeshCommandResult,
  type MeshCommandRunner,
  type MeshExecRecord,
  type MeshSecretRef,
  type ProcessMeshRunnerOptions,
  type ResolvedMeshCommand,
} from './runner.ts';
export {
  TailscaleAdapter,
  parseTailscalePrefs,
  parseTailscaleStatus,
  tailscaleUpCommand,
  type TailscalePrefs,
  type TailscaleRoutesParams,
  type TailscaleUpParams,
} from './tailscale.ts';
export type {
  MeshAdapter,
  MeshPlanInput,
  MeshStep,
  MeshStepContext,
  MeshStepHandler,
  MeshStepPlan,
} from './types.ts';
export {
  detectUfw,
  ufwAllow,
  ufwDelete,
  type FirewallDetection,
  type FirewallRule,
} from './ufw.ts';
export {
  WireguardAdapter,
  ensureWireguardKey,
  wireguardConfig,
  wireguardPublicKey,
  type WireguardParams,
  type WireguardPeer,
} from './wireguard.ts';
