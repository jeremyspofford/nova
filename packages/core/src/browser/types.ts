// The browser area's own seams (docs/11 §4): the driver under the controller (Playwright, or a
// fake in tests), the page model the tools and the classifier read, and the late-bound hooks other
// areas fill in (the external-agent guard, the local browser fallback). The controller itself
// implements `BrowserController` from computers/types.ts.
import type { RawConsoleEvent, RawNetworkEvent } from './capture.ts';

/** An interactive element of the page, with the stable ref the actions take. */
export interface PageElement {
  /** `e1`, `e2`, … assigned by the last read; stale after the page changes. */
  ref: string;
  /** ARIA role (button, link, textbox, searchbox, checkbox, combobox, …). */
  role: string;
  /** Accessible name, clipped. Untrusted page content (FR-103). */
  name: string;
  tag: string;
  /** `type` of an input (password, email, search, submit, file, …). */
  inputType?: string;
  /** Absolute URL of a link. */
  href?: string;
  /** The form the element belongs to. */
  form?: { action: string; method: string } | null;
  autocomplete?: string;
  /** The `name` attribute of a field. */
  fieldName?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Options of a select (first 20). */
  options?: string[];
  /** Whether the element is checked/selected, when it has a state. */
  checked?: boolean;
}

/** One read of the page (driver level). Everything here is untrusted page content. */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Visible text, capped by the caller's budget. */
  text: string;
  /** Accessibility tree summary (ARIA snapshot), capped. */
  tree: string;
  elements: PageElement[];
  /** Child frames (origin), e.g. a CAPTCHA widget. Only the top frame is read. */
  frames: string[];
}

/** A tool a page registered from its top frame (FR-208). */
export interface PageToolRegistration {
  /** The page's origin when it registered (dropped when the browser leaves it). */
  origin: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DriverLaunchOptions {
  /** The computer's profile folder: downloads, and the cookie state when persisted (FR-096). */
  profileDir: string;
  /** The egress proxy session (docs/12 §8); null only where the caller allows direct network. */
  proxy: { server: string; caSpki: string | null } | null;
  /** Cookies and storage to start with (a relaunch carries them over; FR-096). */
  storageState: StorageState | null;
  viewport: { width: number; height: number };
  executablePath: string | null;
  /** A main-frame navigation to this URL may proceed; false aborts it (docs/11 §4). */
  allowNavigation: (url: string) => boolean;
  /** A subresource request may proceed (blocked sites and private addresses never do). */
  allowRequest: (url: string) => boolean;
  /** The page navigated (main frame); page tools of another origin are dropped. */
  onNavigated?: (url: string) => void;
  /** The top frame registered or removed a tool (FR-208); iframes are ignored by the driver. */
  onPageTool?: (op: 'register' | 'unregister', reg: PageToolRegistration) => void;
  /** A main-frame navigation was refused by `allowNavigation`. */
  onBlockedNavigation?: (url: string) => void;
  /** The page tried to open a window (closed; reported to the agent). */
  onPopup?: (url: string) => void;
  /** A console message or an uncaught page error (docs/11 §4 observation, M7). */
  onConsole?: (event: RawConsoleEvent) => void;
  /** Network activity of the page, by request id (docs/11 §4 network summary, M7). */
  onNetwork?: (event: RawNetworkEvent) => void;
  /**
   * Response bodies are read only for text types whose size is under this (bytes); 0 reads
   * none. Request bodies are never reported.
   */
  captureBodyMaxBytes?: number;
  /** The page or the whole browser crashed (docs/11 §10); not called for our own close. */
  onCrash?: (reason: string) => void;
}

/** Cookies and origins' storage, as Playwright's storage state. */
export interface StorageState {
  cookies: Record<string, unknown>[];
  origins: Record<string, unknown>[];
}

/** User input during a takeover (FR-087), delivered by the screen area. */
export type BrowserTakeoverInput =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string }
  | { kind: 'scroll'; dy: number };

export interface DriverSession {
  url(): string;
  goto(url: string, timeoutMs: number): Promise<{ status: number | null }>;
  back(timeoutMs: number): Promise<void>;
  snapshot(maxChars: number): Promise<PageSnapshot>;
  /** The element behind a ref now (null when gone); used to detect a page that changed. */
  describe(ref: string): Promise<PageElement | null>;
  click(ref: string, timeoutMs: number): Promise<void>;
  /** Move the pointer over an element (menus, tooltips); changes nothing on the site. */
  hover(ref: string, timeoutMs: number): Promise<void>;
  fill(ref: string, text: string, timeoutMs: number): Promise<void>;
  select(ref: string, value: string, timeoutMs: number): Promise<void>;
  press(key: string, timeoutMs: number): Promise<void>;
  scroll(direction: 'up' | 'down', amount: number): Promise<void>;
  waitFor(
    kind: 'load' | 'idle' | 'text',
    text: string | undefined,
    timeoutMs: number,
  ): Promise<boolean>;
  screenshot(fullPage: boolean): Promise<Uint8Array>;
  /** A PNG of one element of the last read (docs/11 §4: element screenshots). */
  screenshotElement(ref: string): Promise<Uint8Array>;
  /** Click `ref` and save the download it starts. */
  download(ref: string, timeoutMs: number): Promise<{ suggestedName: string; data: Uint8Array }>;
  upload(ref: string, files: { name: string; mime: string; data: Uint8Array }[]): Promise<void>;
  /** Developer-protocol mode only (FR-094). The result is untrusted. */
  evaluate(expression: string, timeoutMs: number): Promise<unknown>;
  /** Run a page-registered tool (FR-208); the result is untrusted. */
  callPageTool(name: string, args: unknown, timeoutMs: number): Promise<unknown>;
  input(event: BrowserTakeoverInput): Promise<void>;
  storageState(): Promise<StorageState>;
  /** The context's cookies (cheap; what a restart after a crash carries over). */
  cookies(): Promise<Record<string, unknown>[]>;
  /**
   * After a page crash: replace the page with a new one in the same browser, which keeps its
   * cookies. False when the browser itself is gone (the caller launches a new one).
   */
  recover(): Promise<boolean>;
  /**
   * Why the page or the browser is down, from the driver's own signals (the page's crash event,
   * the browser's connection), never from an error message a page could write; null when up.
   */
  crashState(): Promise<string | null>;
  /** Whether the focused field takes a password or a one-time code (takeover typing). */
  focusedSecret(): Promise<boolean>;
  close(): Promise<void>;
}

/** What drives a real browser: Playwright (preferred), or a fake in tests. */
export interface BrowserDriver {
  readonly name: string;
  /** Whether a browser can start on this host, and why not (checked once and cached). */
  probe(executablePath: string | null): Promise<{ ok: boolean; detail: string }>;
  launch(opts: DriverLaunchOptions): Promise<DriverSession>;
}

// ---- hooks other areas fill in -------------------------------------------------------------
// The external-agent guard (FR-194) is the agents area's `ExternalAgentGuard` (agents/types.ts);
// `signatureGuard` in injection.ts stands in for it until it is wired.

/**
 * The local browser fallback (FR-209, docs/11 §4.6): continue on a connected computer's browser
 * after the user consents for that site. The devices area provides it; until then it is null and
 * the fallback is refused as not available.
 */
export interface LocalBrowserFallback {
  open(input: {
    accountId: string;
    threadId: string | null;
    computerId: string;
    host: string;
    profile: 'clean' | 'extension';
  }): Promise<{ ok: true; deviceId: string } | { ok: false; reason: string }>;
}
