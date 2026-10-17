// M6.5 network (FR-135, FR-138, FR-139; docs/22): the Hub's endpoints and their health checks,
// mDNS, the network change log behind rollback, and Wake Helper routing. Mesh adapters and the
// Network Setup assistant live in ./mesh and ./setup.
export {
  NetworkChangeLog,
  type NetworkChangeInput,
  type NetworkChangeListener,
  type NetworkChangeLogOptions,
  type NetworkUndo,
  type NetworkUndoHandler,
} from './changes.ts';
export {
  EndpointRegistry,
  lanCandidates,
  listensOnLoopbackOnly,
  type EndpointConfig,
  type EndpointRegistryOptions,
  type EndpointSource,
  type EndpointsListener,
  type ListenerInfo,
} from './endpoints.ts';
export {
  MdnsAdvertiser,
  NOVA_SERVICE_TYPE,
  hubMdnsName,
  mdnsRecords,
  type MdnsAdvertisement,
  type MdnsAdvertiserOptions,
  type MdnsQuestion,
  type MdnsRecord,
  type MdnsResponder,
} from './mdns.ts';
export {
  probeHello,
  type HelloProbeOptions,
  type HelloProbeResult,
  type HubProbe,
} from './probe.ts';
export { deviceReachability } from './reachability.ts';
export {
  directedBroadcast,
  inSubnet,
  interfaceAddresses,
  ipFamily,
  isLinkLocalIp,
  isLoopbackIp,
  isMeshIp,
  isVirtualInterface,
  normalizeIp,
  urlIp,
  type InterfaceAddress,
} from './subnet.ts';
export {
  WAKE_OTHER_PATH,
  WakeHelperRouter,
  type WakeHelperRouterOptions,
  type WakeRoute,
  type WakeRouteInput,
} from './wake.ts';
export * from './mesh/index.ts';
export * from './setup/index.ts';
