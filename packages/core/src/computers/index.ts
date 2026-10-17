// M6 computers: substrates, the egress proxy (seams in types.ts).
export * from './types.ts';
export { CertificateAuthority, type CertificateAuthorityOptions } from './egress-ca.ts';
export {
  LIMITED_METHODS,
  addressAllowed,
  classifyAddress,
  decideHost,
  matchingPattern,
  narrowMode,
  validateEgressPolicy,
  type AddressClass,
  type HostDecision,
} from './egress-policy.ts';
export {
  EgressProxyService,
  type EgressCredential,
  type EgressProxyOptions,
  type EgressScope,
  type LocalEgressSession,
  type ProxyPolicy,
} from './egress-proxy.ts';
export {
  EgressStore,
  effectivePolicy,
  proxyEgress,
  threadScopes,
  type EgressGlobal,
  type EgressStoreOptions,
  type ProxyEgressOptions,
  type ProxySandboxEgress,
} from './egress-store.ts';
export {
  DirComputer,
  folderSize,
  shellQuote,
  type ComputerHost,
  type DirComputerOptions,
} from './computer.ts';
export { MockCloudRunner, type CloudRunner, type MockCloudRunnerOptions } from './cloud.ts';
export {
  ComputerService,
  type BrowserFactory,
  type ComputerServiceOptions,
  type LocalHostComputers,
  type ScreenFactory,
} from './service.ts';
