// M6.5 Relay, the Hub's side (FR-137, docs/22 §3): registration with a Relay, the outbound
// connection, pairing slots for Add Device, the paired-client registry and the API tunnel.
// packages/core/src/index.ts re-exports it.
export {
  RELAY_STATES,
  RelayHub,
  relayRegistrationSecret,
  relayRegistrationTokenFor,
  type RelayClientView,
  type RelayConnectorState,
  type RelayDispatch,
  type RelayEndpointCandidate,
  type RelayHubIdentity,
  type RelayHubOptions,
  type RelayPairingSeam,
  type RelaySettings,
  type RelayStatus,
  type RelayTestResult,
  type RelayTunnelClient,
} from './service.ts';
