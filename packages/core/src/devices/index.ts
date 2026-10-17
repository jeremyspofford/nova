// M6 devices: devices running `novad` (docs/23) — the registry and management channel, versions
// and capability gating, Wake-on-LAN, file operations with staged writes, an agent's connected
// computer, a Code session's device environment, and a fake device for tests.
export {
  DeviceService,
  deviceSecretHash,
  inDeviceQuietHours,
  managementTokenRef,
  type CapabilityValidator as DeviceCapabilityValidator,
  type ConnectionHook as DeviceConnectionHook,
  type DeviceCallContext,
  type DeviceServiceOptions,
  type DeviceSettings,
  type ManagedDevice,
} from './service.ts';
export {
  DEVICE_CREDENTIAL_PREFIX,
  DEVICE_ENROLL_PREFIX,
  DEVICE_PROTOCOL_VERSIONS,
  MANAGEMENT_TOKEN_PREFIX,
  deviceCapabilitiesUpdateSchema,
  deviceHeartbeatSchema,
  negotiateDeviceProtocol,
  registerDeviceSchema,
  type DeviceHeartbeat,
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
