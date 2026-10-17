// M6 seams: computers, browser and screen control, and the egress proxy (docs/11, docs/12 §8).
// One interface for every substrate (cloud, local container or VM, the user's own machine
// through `novad`), so tools and tests are substrate-agnostic. Lead-owned: request changes.

export type ComputerKind = 'cloud' | 'local_container' | 'local_host';

export interface ComputerDirent {
  name: string;
  kind: 'file' | 'dir' | 'symlink' | 'other';
  size: number | null;
}

export interface ComputerStat {
  kind: ComputerDirent['kind'];
  size: number;
  mtimeMs: number;
}

export interface ComputerExecSpec {
  cmd: string;
  args?: string[];
  cwd?: string;
  /** Never a secret: credentials are injected by the egress proxy (ADR-063). */
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  /** Can only narrow the profile's network block (FR-193). */
  network?: 'off' | 'limited' | 'allowlist';
}

export interface ComputerExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ComputerStatus {
  state: 'starting' | 'running' | 'stopped' | 'degraded' | 'error';
  substrate: 'container' | 'micro_vm' | 'bwrap' | 'host' | 'cloud_stub' | null;
  detail: string | null;
}

export interface SnapshotRef {
  id: string;
  label: string | null;
  createdAt: string;
}

// ---- browser (FR-092, FR-094, FR-095, FR-098) -------------------------------------------------

export interface BrowserPageState {
  url: string;
  title: string;
  /** Visible text, token-budgeted. Untrusted (FR-103). */
  text: string;
  /** Interactive elements with stable refs the actions take. */
  elements: { ref: string; role: string; name: string }[];
}

export type BrowserAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; ref: string }
  | { kind: 'type'; ref: string; text: string; submit?: boolean }
  | { kind: 'select'; ref: string; value: string }
  | { kind: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { kind: 'press'; key: string }
  | { kind: 'wait'; for: 'load' | 'idle' | 'text'; text?: string; timeoutMs?: number }
  | { kind: 'back' };

export interface BrowserActionResult {
  ok: boolean;
  /** Why it did not run: a blocked host, a policy decision, a page error. */
  error?: { code: string; message: string };
  page: BrowserPageState | null;
  /** Before/after screenshots kept for the Activity trace (FR-098): blob paths or ids. */
  before?: string | null;
  after?: string | null;
}

/** A browser on a computer (served by the browser controller; Playwright or CDP). */
export interface BrowserController {
  /** Opens (or reuses) the computer's clean agent profile; nothing from the user's browsers. */
  read(opts?: { maxChars?: number }): Promise<BrowserPageState | null>;
  act(action: BrowserAction, signal: AbortSignal): Promise<BrowserActionResult>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
  close(): Promise<void>;
}

// ---- screen / computer use (FR-093, FR-207) ---------------------------------------------------

export type ScreenAppTier = 'view' | 'click' | 'full';

/** A window on the controlled desktop; `ScreenObservation.windows` lists them front first. */
export interface ScreenWindow {
  id: string;
  app: string;
  /** Browsers view-only, terminals and editors click-only, others full (FR-207). */
  tier: ScreenAppTier;
  title: string;
  focused: boolean;
  /** Where the window is, in screen pixels; input outside every window is refused. */
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ScreenObservation {
  /** PNG of the screen. */
  image: Uint8Array;
  windows: ScreenWindow[];
  /** Accessibility tree summary, preferred over pixels. Untrusted. */
  tree: string;
  takenAt: string;
}

export type ScreenAction =
  | { kind: 'click'; x: number; y: number; button?: 'left' | 'right' }
  | { kind: 'scroll'; x: number; y: number; dy: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string }
  | { kind: 'drag'; from: [number, number]; to: [number, number] };

export interface ScreenController {
  observe(): Promise<ScreenObservation>;
  act(action: ScreenAction, signal: AbortSignal): Promise<{ ok: boolean; error?: string }>;
  /** The kill key: stop control at once; no further input event is delivered (FR-207). */
  kill(): Promise<void>;
}

// ---- the computer --------------------------------------------------------------------------

export interface Computer {
  readonly id: string;
  readonly kind: ComputerKind;
  fs: {
    read(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
    write(path: string, data: Uint8Array, opts?: { createDirs?: boolean }): Promise<void>;
    list(path: string): Promise<ComputerDirent[]>;
    stat(path: string): Promise<ComputerStat>;
    delete(path: string): Promise<void>;
    move(from: string, to: string): Promise<void>;
  };
  exec(spec: ComputerExecSpec, signal: AbortSignal): Promise<ComputerExecResult>;
  /** Null when the computer has no browser (unavailable substrate): tools fail closed. */
  browser(): Promise<BrowserController | null>;
  /** Null without a controlled desktop. */
  screen(): Promise<ScreenController | null>;
  snapshot(label?: string): Promise<SnapshotRef>;
  restore(ref: SnapshotRef): Promise<void>;
  status(): Promise<ComputerStatus>;
  stop(): Promise<void>;
}

/** Where computers come from (the computers area); agents and tools ask it by id. */
export interface ComputerProvider {
  get(accountId: string, computerId: string): Promise<Computer | null>;
  /** The persistent cloud computer of an agent (FR-080), created on first use. */
  forAgent(accountId: string, agentId: string): Promise<Computer>;
}

// ---- egress proxy (FR-102, FR-193, docs/12 §8) ------------------------------------------------

export type EgressMode = 'off' | 'allowlist' | 'limited';

export type EgressBlockCause =
  'allowlist' | 'denylist' | 'method' | 'private_address' | 'inspection' | 'policy';

/** The network policy of one sandbox session (run, Code session, agent computer). */
export interface EgressPolicy {
  mode: EgressMode;
  /** Host patterns; a wildcard only as the leftmost label; a bare `*` is rejected. */
  allow: string[];
  deny: string[];
  /** Ids of credentials the proxy injects for allowed hosts (ADR-063); values stay in the vault. */
  credentials: string[];
  allowLocalBinding: boolean;
  /**
   * Exact hosts this session may reach on a private or loopback address, with
   * `allowLocalBinding` (the agent browser's sites the owner allowed by name, when
   * `browser.allowLocalSites` is on). Others need a dev-server grant.
   */
  localHosts?: string[];
}

export interface EgressSession {
  /** `http://host:port` for HTTP_PROXY/HTTPS_PROXY; unique to the session. */
  proxyUrl: string;
  /** PEM of the CA the proxy uses to inspect HTTPS (mount into the sandbox), when it inspects. */
  caCertPem: string | null;
  close(): Promise<void>;
}

/** The egress proxy: one session per sandbox, every decision audited (kind `network`). */
export interface EgressProxy {
  open(input: {
    accountId: string;
    /** run, session, agent or sandbox id, for the audit. */
    scope: { kind: 'run' | 'session' | 'agent' | 'sandbox'; id: string };
    policy: EgressPolicy;
  }): Promise<EgressSession>;
  /**
   * Let one scope reach a dev server on a private address (docs/12 §4.2); effective only while
   * the scope's session policy also sets `allowLocalBinding`. Returns the revoke function.
   */
  grantDevServer?(input: {
    accountId: string;
    scope: { kind: 'run' | 'session' | 'agent' | 'sandbox'; id: string };
    host: string;
    port: number;
  }): () => void;
}
