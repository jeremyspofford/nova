// Words and pure helpers of the third-party app and telemetry export views (FR-222, FR-223; docs/04
// §7: plain and short). Every user-facing string of the consent page, Settings → Authorized apps and Settings
// → Telemetry export is a message here (FR-016), read at render time; every refusal the Hub
// answers with gets plain words, never a raw code. App names, addresses and the Hub's own error
// `message`s stay as they are.
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import { isAppScope, type AppConsentView, type OtlpSignal } from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import { TEAM_TEXT } from '../team/format.ts';

export const SETTINGS_APPS_PATH = '/settings/apps';
export const SETTINGS_TELEMETRY_PATH = '/settings/telemetry';
/** The consent page apps open (the Hub's metadata names it `authorization_endpoint`). */
export const AUTHORIZE_PATH = '/authorize';

// ---- the consent page --------------------------------------------------------------------------

export const CONSENT_TEXT = defineMessages('appauth.consent', {
  loading: 'Loading the request',
  title: 'Allow {name} to use your Hub?',
  intro:
    '{name} is asking to read parts of this Hub as you. Apps can only read: they cannot send messages, run tools or change anything.',
  nameCaution:
    'The app chose this name itself; Nova cannot check it. Allow it only if you just started signing in to it.',
  registered: 'It registered with this Hub {when}.',
  backLoopback:
    'When you answer, Nova sends you back to an app on the computer you are using ({host}).',
  backScheme: 'When you answer, Nova sends you back to the app that opens {scheme}: links.',
  asksHeading: 'It asks to',
  keepHint: 'Untick anything you do not want to allow.',
  alreadyAllowed: 'Already allowed',
  authorizedBefore:
    'You allowed this app before. Allowing again adds what is new; what you allowed before stays.',
  revokeLater: 'You can revoke it at any time in Settings → Authorized apps.',
  keepOne: 'Keep at least one, or choose Deny.',
  allow: 'Allow',
  deny: 'Deny',
  allowing: 'Allowing…',
  denying: 'Denying…',
  allowed:
    'Allowed. Nova is sending you back to {name}. If nothing happens, you can close this page.',
  denied:
    'Denied. Nova told {name} no and is sending you back. If nothing happens, you can close this page.',
  noRequest: 'No sign-in request here',
  noRequestDetail:
    'Apps open this page when they ask for access to your Hub. Start the sign-in from the app.',
  refusedTitle: 'This sign-in request cannot be answered',
  tellApp: 'Go back to the app',
  tellAppHint: 'The app is told why, and nothing is allowed.',
  ownerOnly: 'Only the owner of this Hub can allow apps to use it.',
  ownerOnlyDetail:
    'Apps that sign in to this Hub read the owner’s data, so only the owner approves them.',
  badRedirect:
    'The Hub answered with an address that is not this app’s. Nothing was sent; start again from the app.',
  sendFailed: 'Could not send your answer.',
  readFailed: 'The Hub could not read this request.',
});

/** Where the browser goes after the decision: what the person is told about it. */
export function backText(view: Pick<AppConsentView['client'], 'redirectUri' | 'redirectKind'>) {
  try {
    const u = new URL(view.redirectUri);
    return view.redirectKind === 'loopback'
      ? CONSENT_TEXT.backLoopback({ host: u.host })
      : CONSENT_TEXT.backScheme({ scheme: u.protocol.replace(/:$/, '') });
  } catch {
    return CONSENT_TEXT.backScheme({ scheme: view.redirectUri.split(':')[0] ?? view.redirectUri });
  }
}

/**
 * Whether `target` (the Hub's answer) goes to the app's redirect URI: same scheme, host and path.
 * The Hub built it from that URI; this is a second check before the browser leaves.
 */
export function sameTarget(target: string, redirectUri: string): boolean {
  try {
    const a = new URL(target);
    const b = new URL(redirectUri);
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/** Each scope an app can ask for, in plain words (the Hub's APP_SCOPE_TEXT, translated). */
const SCOPE_TEXT = defineMessages('appauth.scopes', {
  'account:read': {
    label: 'See your name and picture',
    description: 'Your display name and avatar on this Hub.',
  },
  'projects:read': {
    label: 'See your projects',
    description: 'The names and settings of your projects, not their files.',
  },
  'threads:read': {
    label: 'Read your chats',
    description: 'Your chats, their messages, attachments and artifacts, and chat search.',
  },
  'runs:read': {
    label: 'See your Work runs',
    description: 'Your background runs, their goals and their progress.',
  },
  'memory:read': {
    label: 'Read what Nova remembers',
    description: 'The memory items Nova keeps about you.',
  },
  'notifications:read': {
    label: 'See your notifications',
    description: 'The notifications Nova sent you.',
  },
  'usage:read': {
    label: 'See your usage',
    description: 'Tokens and costs by model and day.',
  },
});

/**
 * The scope's plain words in the active locale; for one this client does not know, the Hub's
 * words when it sent them, else the raw name.
 */
export function scopeText(
  scope: string,
  hub?: { label: string; description: string },
): { label: string; description: string } {
  if (isAppScope(scope)) {
    const t = SCOPE_TEXT[scope];
    return { label: t.label, description: t.description };
  }
  return hub ?? { label: scope, description: '' };
}

// ---- Settings → Authorized apps -----------------------------------------------------------------

export const APPS_TEXT = defineMessages('appauth.apps', {
  heading: 'Authorized apps',
  intro:
    'Other apps can ask to read parts of this Hub as you, such as a notes app that reads your chats. You approve each app and what it may read on a page Nova shows; apps never send messages, run tools or change anything.',
  switchLabel: 'Let apps ask for access',
  switchOn: 'On: an app can register and ask; nothing is allowed until you approve it.',
  switchOff:
    'Off: registration, sign-in and token requests are refused, and every app token stops working at once.',
  switchedOn: 'Apps can ask for access again.',
  switchedOff: 'App access is off. Every app token stopped working.',
  managedOff: 'Your organization’s managed policy turned app access off on this Hub.',
  howHeading: 'How an app signs in',
  how: 'Give the app this Hub’s address. It opens a page here that says what it asks for, and you allow or deny it. Apps that support OAuth discovery find everything at this address:',
  /** A noun: also read inside "Copy {label}", "{label} copied." and "The {label} is selected". */
  metadataLabel: 'Sign-in address for apps',
  listHeading: 'Apps you allowed',
  listLabel: 'Apps you allowed',
  loading: 'Loading apps',
  loadFailed: 'Could not load the apps.',
  emptyTitle: 'No apps yet',
  emptyDescription: 'When you allow an app, it is listed here with what it may read.',
  sessions:
    '{n, plural, =0 {Not signed in now} one {Signed in on # device} other {Signed in on # devices}}',
  lastUsed: 'last used {when}',
  allowedWhen: 'allowed {when}',
  returnsTo: 'Sends sign-ins back to',
  /** Followed by the scopes' names, joined. */
  mayRead: 'May read: {scopes}',
  revoke: 'Revoke',
  revokeLabel: 'Revoke {name}',
  revokeTitle: 'Revoke {name}?',
  revokeWhat:
    '{sessions, plural, =0 {{name} loses access at once: its tokens stop working. It can ask again later; nothing is allowed until you approve it again.} one {{name} loses access at once: its sign-in ends and its tokens stop working. It can ask again later; nothing is allowed until you approve it again.} other {{name} loses access at once: its # sign-ins end and its tokens stop working. It can ask again later; nothing is allowed until you approve it again.}}',
  cancel: 'Cancel',
  revoked: '{name} revoked. Its tokens stopped working.',
  revokeFailed: 'Could not revoke {name}: {why}',
  changeFailed: 'Could not change it: {why}',
  /** A loopback return address: any port on that host. */
  anyPort: '{host} (any port)',
  pendingHeading: 'Registered, not allowed',
  pendingIntro:
    'Apps that registered with this Hub that you have not allowed, or no longer allow. None of them can read anything.',
  pendingLabel: 'Registered apps you have not allowed',
  pendingLoading: 'Loading registered apps',
  pendingNone: 'No other app is registered.',
  pendingHow:
    'An app shows what it asks for when it opens the sign-in page here. An app nobody approves within an hour is removed.',
  pendingLoadFailed: 'Could not load the registered apps.',
  /** Followed by the scopes' names, joined. */
  asksFor: 'Asks to read: {scopes}',
  registeredWhen: 'Registered {when}.',
  waitingUntil: 'Waiting for its first approval. It is removed at {time} unless you allow it.',
  notAllowedNow: 'Not allowed now. It stays registered until you remove it.',
  remove: 'Remove',
  removeLabel: 'Remove {name}',
  removeTitle: 'Remove {name}?',
  removeWhat:
    '{name}’s registration is deleted from this Hub, with any codes and tokens it still holds. It can register again later; nothing is allowed until you approve it.',
  removed: '{name} removed.',
  removeFailed: 'Could not remove {name}: {why}',
  retry: 'Retry',
});

/** The time of day a waiting registration lapses (always within the hour). */
export function lapseTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : fmt.time(t, { hour: 'numeric', minute: '2-digit' });
}

/**
 * A registered app's return address as the Hub lists it (`127.0.0.1`, `[::1]:9000`, or an app's
 * own scheme), in the words the authorized list uses: a loopback address takes any port.
 */
export function pendingHostLabel(host: string): string {
  const loopback = /^(127(?:\.\d{1,3}){3}|\[::1\]|localhost)(?::\d+)?$/i.exec(host);
  return loopback ? APPS_TEXT.anyPort({ host: loopback[1] ?? host }) : `${host}:`;
}

// ---- Settings → Telemetry export (OTLP) --------------------------------------------------------

export const SIGNAL_TEXT = defineMessages('appauth.signals', {
  traces: { label: 'Traces', description: 'Timing of requests and work, by route.' },
  metrics: { label: 'Metrics', description: 'Counts and durations, never content.' },
  logs: { label: 'Logs', description: 'The Hub’s log lines, redacted.' },
});

export const OTLP_TEXT = defineMessages('appauth.otlp', {
  heading: 'Telemetry export',
  intro:
    'Send the Hub’s traces, metrics and logs to your own OpenTelemetry collector over OTLP (HTTP with JSON). Off by default. Secrets are always removed before anything leaves the Hub.',
  managedOff: 'Your organization’s managed policy does not allow telemetry export.',
  loading: 'Loading the telemetry export',
  loadFailed: 'Could not load the telemetry export.',
  retry: 'Retry',
  switchLabel: 'Export telemetry',
  switchOn: 'On: the Hub sends the chosen signals to your collector.',
  switchOff: 'Off: nothing is sent.',
  needsEndpoint: 'Save a collector address first.',
  turnedOn: 'Telemetry export is on.',
  turnedOff: 'Telemetry export is off.',
  collectorHeading: 'Collector',
  endpointLabel: 'Collector address',
  endpointHint:
    'The base address, like https://collector.example.com:4318. Nova adds /v1/traces, /v1/metrics and /v1/logs. https is required, except to a collector on this computer.',
  endpointInvalid:
    'Enter an https:// address (http:// only to this computer), without a user name, query or fragment.',
  save: 'Save',
  saving: 'Saving…',
  clear: 'Clear',
  endpointSaved: 'Collector address saved.',
  endpointCleared: 'Collector address cleared. Nothing is sent.',
  headersHeading: 'Headers',
  headersIntro:
    'Headers your collector needs, such as an API key. Values are kept in the Hub’s secret store and never shown again.',
  headersNone: 'No headers.',
  headersLabel: 'Headers sent to the collector',
  set: 'Set',
  notSet: 'Not set',
  replace: 'Replace',
  replaceLabel: 'Replace the value of {name}',
  remove: 'Remove',
  removeLabel: 'Remove {name}',
  removeTitle: 'Remove the header {name}?',
  removeWhat: 'It is no longer sent, and its value is deleted from the secret store.',
  removed: '{name} removed.',
  addHeader: 'Add a header',
  headerName: 'Header name',
  headerNameHint: 'Letters, digits and hyphens, like Authorization or x-api-key.',
  headerNameInvalid: 'Use letters, digits and hyphens, starting with a letter or digit.',
  headerValue: 'Value',
  headerValueNew: 'New value of {name}',
  headerValueMissing: 'Enter the value.',
  headerSaved: '{name} saved.',
  cancel: 'Cancel',
  tooManyHeaders: 'At most 20 headers.',
  signalsHeading: 'What to send',
  contentHeading: 'Content',
  contentLabel: 'Include content',
  contentDescription:
    'Also send prompts, replies, tool arguments and results, and other captured text. Off: they are removed before export.',
  contentWarning:
    'Content is on: prompts, replies and tool results go to your collector. Anyone who can read the collector can read them.',
  contentConfirmTitle: 'Send content to your collector?',
  /** `{where}` is the collector's address, or "your collector". */
  contentConfirm:
    'Prompts, replies, tool arguments and results, and other captured text will be sent to {where}. Anyone who can read the collector can read them. Secrets are still removed.',
  contentConfirmButton: 'Include content',
  contentOn: 'Content is now included in the export.',
  contentOff: 'Content is no longer exported.',
  yourCollector: 'your collector',
  testHeading: 'Check the connection',
  test: 'Send a test',
  testing: 'Sending…',
  testOk: 'The collector accepted a test log line.',
  testOkStatus: 'The collector accepted a test log line (HTTP {status}).',
  /** `{why}` is the Hub's words, an HTTP status, or "no answer". */
  testFailed: 'The test did not reach the collector: {why}',
  httpStatus: 'HTTP {status}',
  noAnswer: 'no answer',
  testDidNotRun: 'The test did not run.',
  saveFailed: 'Could not save.',
  testNoEndpoint: 'Save a collector address to send a test.',
  statusHeading: 'Status',
  active: 'Exporting now',
  inactive: 'Not exporting',
  inactiveWhy: {
    managed: 'Managed policy does not allow it.',
    off: 'Export is off.',
    noEndpoint: 'No collector address.',
    noSignal: 'No signal is chosen.',
  },
  sent: 'Sent',
  queued: 'Waiting',
  dropped: 'Dropped',
  failures: 'Failed attempts',
  lastSuccess: 'Last delivered',
  lastError: 'Last error',
  nextAttempt: 'Next try',
  never: 'never',
  saved: 'Saved.',
  signalOn:
    '{signal, select, traces {Traces are sent from now on.} metrics {Metrics are sent from now on.} logs {Logs are sent from now on.} other {{signal} are sent from now on.}}',
  signalOff:
    '{signal, select, traces {Traces are no longer sent.} metrics {Metrics are no longer sent.} logs {Logs are no longer sent.} other {{signal} are no longer sent.}}',
  /** A signal's count in the status list. */
  count: {
    traces: 'Traces {n}',
    metrics: 'Metrics {n}',
    logs: 'Logs {n}',
  },
});

/** The confirmation after a signal is switched on or off. */
export function savedSignalText(signal: OtlpSignal, on: boolean): string {
  return on ? OTLP_TEXT.signalOn({ signal }) : OTLP_TEXT.signalOff({ signal });
}

/** The test's outcome when the collector answered. */
export function testOkText(status: number | null): string {
  return status ? OTLP_TEXT.testOkStatus({ status: String(status) }) : OTLP_TEXT.testOk;
}

// ---- refusals ----------------------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The refusal's reason (`details.reason`), else its code. */
export function reasonOf(err: unknown): string | null {
  return err instanceof ApiError ? (str(err.body.details?.reason) ?? err.body.code) : null;
}

/** The app's redirect with the OAuth error, when the Hub verified the redirect URI. */
export function refusalRedirect(err: unknown): string | null {
  return err instanceof ApiError ? str(err.body.details?.redirectTo) : null;
}

const REASON_TEXT = defineMessages('appauth.reasons', {
  managed: 'Your organization’s managed policy does not allow this.',
  apps_disabled:
    'App access is turned off on this Hub. The owner can turn it on in Settings → Authorized apps.',
  unknown_client:
    'This app is not registered with this Hub, or it was removed. Start the sign-in again from the app.',
  redirect_uri_required:
    'The request does not say where to send you back, so it cannot be answered.',
  redirect_uri_mismatch:
    'The request asks to send you back to an address this app did not register. Nothing was sent there.',
  invalid_request:
    'The app’s request is incomplete or malformed. Start the sign-in again from the app.',
  unsupported_response_type: 'The app asked for a kind of sign-in Nova does not offer.',
  invalid_scope: 'The app asked for access it did not register, or that Nova does not offer.',
  not_requested: 'You can only allow what the app asked for.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  address_rate_limited: 'Too many requests from this address. Wait a minute and try again.',
  too_many_pending_apps: 'Too many apps are waiting for approval. Try again later.',
  authorized: 'This app is allowed now. Revoke it under “Apps you allowed” first.',
});

const ERROR_TEXT = defineMessages('appauth.errors', {
  /** The fallback for an error with no words of its own. */
  somethingWrong: 'Something went wrong.',
  /** A 404: what the request was about is gone. */
  gone: 'It is no longer there. Refresh the page.',
});

/** A refusal's words by its reason, or undefined for a reason this client does not know. */
function reasonText(reason: string): string | undefined {
  if (reason === 'owner_only') return TEAM_TEXT.ownerOnly;
  if (reason === 'no_endpoint') return OTLP_TEXT.testNoEndpoint;
  return messageFor(REASON_TEXT, reason);
}

/** A refusal in plain words: by reason first, then by the field a validation names. */
export function appErrorMessage(
  err: unknown,
  fallback: string = ERROR_TEXT.somethingWrong,
): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const reason = reasonOf(err);
  const text = reason ? reasonText(reason) : undefined;
  if (text) return text;
  if (err.status === 404) return ERROR_TEXT.gone;
  const d = err.body.details ?? {};
  const field =
    str(d.field) ??
    (Array.isArray(d.issues) ? str((d.issues[0] as { path?: unknown } | undefined)?.path) : null);
  if (field === 'endpoint') return OTLP_TEXT.endpointInvalid;
  if (field === 'headers') return OTLP_TEXT.tooManyHeaders;
  if (field?.startsWith('headers.')) return OTLP_TEXT.headerNameInvalid;
  return errorMessage(err, fallback);
}
