// M6.5 trust (FR-134, docs/22 §5): the Hub identity key, the Hub local CA, the Hub's TLS leaf,
// device certificates, mesh certificates and the revocation list. packages/core/src/index.ts
// re-exports these by name.
export {
  HUB_IDENTITY_REF,
  HubIdentity,
  ed25519FromRaw,
  hubFingerprint,
  rawEd25519,
  type HubIdentityFailure,
  type HubIdentityHandle,
  type HubIdentityOptions,
} from './identity.ts';
export { checkHubIdentity, type HubIdentityCheck, type HubIdentityCheckInput } from './pinning.ts';
export {
  DEVICE_CERT_DAYS,
  HUB_CLIENT_DAYS,
  HUB_CLIENT_REF,
  LEAF_DAYS,
  LEGACY_SERVER_CERT_GRACE_MS,
  LOCAL_CA_BASE_CONSTRAINTS,
  LOCAL_CA_DAYS,
  TrustService,
  certificateName,
  isSingleLabel,
  type DeviceCertificateCheck,
  type DeviceCertificateRequest,
  type HubClientCertificate,
  type MeshCertSource,
  type TlsMaterial,
  type TrustServiceOptions,
  type TrustSettings,
} from './service.ts';
export {
  buildCertificate,
  certificateFingerprint,
  nameConstraintsPermit,
  pemToDer,
  type BuiltCertificate,
  type CertificateSpec,
  type DistinguishedName,
  type NameConstraints,
} from './x509.ts';
