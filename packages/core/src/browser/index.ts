// M6 browser area (docs/11 §4): the agent browser per computer, its policy (site lists and
// levels, the page-action classifier, sign-in, injection defense), the Activity trace and the
// browser tools; M7 adds console and network capture, crash restarts and levels per scope; M7.5
// the local browser fallback on a connected computer and the extension bridge (FR-209, FR-096).
// Explicit exports keep names from colliding with other areas.
export type {
  BrowserDriver,
  BrowserTakeoverInput,
  DriverLaunchOptions,
  DriverSession,
  FallbackBeginInput,
  FallbackPlan,
  FallbackRefusal,
  LocalBrowserFallback,
  PageElement,
  PageSnapshot,
  PageToolRegistration,
  StorageState,
} from './types.ts';
export {
  classifyPageAction,
  type PageActionClassification,
  type PageActionInput,
  type PageActionKind,
} from './classifier.ts';
export {
  pageLabel as browserPageLabel,
  signatureGuard as browserSignatureGuard,
  suspectInstructions as suspectPageInstructions,
} from './injection.ts';
export {
  BROWSER_ACT_TOOL,
  BROWSER_SITE_TOOL,
  BrowserSites,
  scopedActTool as browserScopedActTool,
  type BrowserSitesOptions,
  type SiteDecision,
  type SitePermissions,
  type SiteScope as BrowserSiteScope,
} from './sites.ts';
export {
  CAPTURE_BODY_MAX_BYTES as BROWSER_CAPTURE_BODY_MAX_BYTES,
  ConsoleLog as BrowserConsoleLog,
  NetworkLog as BrowserNetworkLog,
  type RawConsoleEvent as BrowserRawConsoleEvent,
  type RawNetworkEvent as BrowserRawNetworkEvent,
} from './capture.ts';
export { BrowserRecorder, type BrowserRecorderOptions, type RecordInput } from './recorder.ts';
export {
  BrowserSession,
  BROWSER_FRAME_INTERVAL_MS,
  type BrowserSessionOptions,
  type SessionTimers,
} from './session.ts';
export {
  SigninDesk,
  type SigninAnswer,
  type SigninDeskOptions,
  type SigninFill,
} from './signin.ts';
export { PlaywrightDriver, playwrightProxy, type PlaywrightDriverOptions } from './playwright.ts';
export {
  BrowserService,
  fallbackAllowHosts as browserFallbackAllowHosts,
  BROWSER_MAX_READ_CHARS,
  BROWSER_MAX_RESTARTS,
  BROWSER_READ_CHARS,
  BROWSER_RESTART_WINDOW_MS,
  BROWSER_SIGNIN_TIMEOUT_MS,
  threadScope as browserThreadScope,
  type AgentBrowserController,
  type BrowserCall,
  type BrowserServiceOptions,
  type ComputerResolver,
  type PageWrite,
  type ScopeResolver as BrowserScopeResolver,
} from './service.ts';
export {
  BROWSER_MODES,
  browserEvaluateTool,
  browserToolSource,
  browserTools,
  type BrowserToolsOptions,
} from './tools.ts';
// ---- M7.5: local browser fallback and the extension bridge (FR-209, FR-096; ADR-096) ----------
export {
  CHALLENGE_REPEATS as BROWSER_CHALLENGE_REPEATS,
  ChallengeCounter as BrowserChallengeCounter,
  detectBlock as detectBrowserBlock,
  type BlockFinding as BrowserBlockFinding,
  type BlockInput as BrowserBlockInput,
} from './blockpage.ts';
export {
  DeviceBrowserDriver,
  closeOrphanDeviceSessions,
  deviceCdpPath,
  startCdpRelay,
  type CdpRelay,
  type DeviceBrowserDriverOptions,
  type DeviceBrowserLaunch,
  type DeviceBrowserLink,
  type DeviceEgressCounts,
  type DeviceManagementSocket,
} from './device-launcher.ts';
export {
  deviceBrowserLink,
  type DeviceBridgeCaller,
  type DeviceLinkOptions,
} from './device-link.ts';
export {
  FALLBACK_OFFER_TIMEOUT_MS,
  LocalFallbackService,
  connectedComputerResolver,
  type DeviceDriverFactory,
  type FallbackBridge,
  type FallbackDeviceSource,
  type FallbackTarget,
  type FallbackTargetResolver,
  type LocalFallbackServiceOptions,
} from './fallback.ts';
export {
  BRIDGE_CDP_METHODS,
  BRIDGE_HISTORY_TIMEOUT_MS,
  ExtensionBridgeService,
  type ExtensionBridgeOptions,
} from './bridge.ts';
export { BridgeTabDriver, type BridgeTabDriverOptions } from './bridge-tab.ts';
export { BRIDGE_HISTORY_TOOL, bridgeToolSource, type BridgeToolsOptions } from './bridge-tools.ts';
