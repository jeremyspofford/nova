// M6 devices: devices running `novad` (docs/23) — the registry and management channel, versions
// and capability gating, Wake-on-LAN, file operations with staged writes, an agent's connected
// computer and its file tools, a Code session's device environment, and a fake device for tests.
// M7.5 (ADR-096 D1, D3, D9): the management channel over mutual TLS, the heartbeat's device
// policy, decommission, managed services, available updates and owner overrides.
export {
  DECOMMISSION_APPROVAL_TTL_MS,
  DeviceService,
  deviceSecretHash,
  inDeviceQuietHours,
  novadDeviceForCredential,
  managementTokenRef,
  type CapabilityValidator as DeviceCapabilityValidator,
  type ConnectionHook as DeviceConnectionHook,
  type DeviceCallContext,
  type DeviceServiceOptions,
  type DeviceSettings,
  type ManagedDevice,
  type AvailableNovadBuilds,
  type DevicePolicyFlag,
  type HeartbeatEventsListener,
  type CertificateRenewal,
} from './service.ts';
export {
  checkDeviceServerCertificate,
  deviceTlsError,
  mutualTlsDeviceTransport,
  mutualTlsPost,
  openMutualTls,
  tlsFailureOf,
  type DeviceTarget,
  type DeviceTlsMaterial,
  type DeviceTlsTrust,
} from './tls.ts';
export {
  DEVICE_CREDENTIAL_PREFIX,
  DEVICE_ENROLL_PREFIX,
  DEVICE_PROTOCOL_VERSIONS,
  MANAGEMENT_TOKEN_PREFIX,
  deviceCapabilitiesUpdateSchema,
  deviceHeartbeatSchema,
  deviceLanSubnetSchema,
  devicePowerReportSchema,
  negotiateDeviceProtocol,
  registerDeviceSchema,
  type DeviceHeartbeat,
  type DeviceLanSubnet,
  type RegisterDeviceRequest,
  type RegisterDeviceResponse,
} from './protocol.ts';
export {
  callDevice,
  deviceError,
  httpDeviceTransport,
  type DeviceTransport,
  type DeviceTransportResponse,
} from './client.ts';
export {
  DEVICE_CAPABILITY_MODULE,
  MIN_NOVAD_VERSIONS,
  deviceCapabilityStatuses,
  compareNovadVersions,
  minimumNovadVersions,
  requireDeviceCapabilities,
} from './versions.ts';
export { magicPacket, parseMac, sendMagicPacket, type WolTarget } from './wol.ts';
export { DeviceComputer, DeviceComputerProvider, type DeviceComputerOptions } from './computer.ts';
export {
  deviceEnvProvider,
  deviceEnvironment,
  deviceHelperConnection,
  type DeviceEnvironment,
  type DeviceEnvironmentHealth,
  type DeviceHelperConnection,
} from './environment.ts';
export { FakeDevice, fakeDeviceLineDiff, type FakeDeviceOptions } from './fake-device.ts';
export {
  DEVICE_FILE_TOOL_NAMES,
  DEVICE_READ_DEFAULT_BYTES,
  DEVICE_READ_MAX_BYTES,
  DEVICE_STAGE_MAX_CHARS,
  deviceFileTools,
  deviceToolSource,
  type DeviceAgentThread,
  type DeviceAgentThreadResolver,
  type DeviceToolsOptions,
} from './tools.ts';
