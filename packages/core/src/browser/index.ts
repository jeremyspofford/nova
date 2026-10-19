// M6 browser area (docs/11 §4): the agent browser per computer, its policy (site lists and
// levels, the page-action classifier, sign-in, injection defense), the Activity trace and the
// browser tools; M7 adds console and network capture, crash restarts and levels per scope.
// Explicit exports keep names from colliding with other areas.
export type {
  BrowserDriver,
  BrowserTakeoverInput,
  DriverLaunchOptions,
  DriverSession,
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
