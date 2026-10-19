// M7.5 out-of-band management (FR-147; docs/23 §7; ADR-096 D6): BMC endpoints, the Redfish client
// with certificate pinning, the IPMI adapter through ipmitool, the Redfish BIOS matrix, approvals
// and audit. Intel AMT is refused (`capability_missing` `{reason: not_built}`).
// packages/core/src/index.ts re-exports these by name.
export { hostPort, parseOobAddress, type OobAddress } from './address.ts';
export {
  OOB_REDFISH_BIOS_MATRIX,
  biosSettings,
  biosSnapshot,
  biosVendorFor,
  planBios,
  type BiosPlanResult,
  type BiosSnapshot,
  type OobBiosAttribute,
  type OobBiosVendor,
} from './bios.ts';
export {
  IPMI_DEFAULT_PORT,
  IpmiAdapter,
  ipmiFields,
  ipmiPowerState,
  parseSdrList,
  type IpmiAdapterOptions,
  type IpmiPowerOp,
  type IpmiTarget,
} from './ipmi.ts';
export {
  OOB_TIMEOUT_MS,
  OobTransportError,
  REDFISH_MAX_BYTES,
  RedfishClient,
  bmcError,
  certificatePin,
  peerPin,
  pinMismatchError,
  pinnedRequest,
  redfishPath,
  tlsRedfishTransport,
  type OobTransportFailure,
  type PinnedRequest,
  type PinnedResponse,
  type RedfishClientOptions,
  type RedfishCredentials,
  type RedfishTransport,
} from './redfish.ts';
export {
  OOB_APPROVAL_TTL_MS,
  OobService,
  REDFISH_DEFAULT_PORT,
  oobCredentialRef,
  type OobServiceOptions,
  type OobSettings,
} from './service.ts';
