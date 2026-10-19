// Words and pure helpers of the third-party app and telemetry export views (FR-222, FR-223; docs/04
// §7: plain and short). Every user-facing string of the consent page, Settings → Apps and Settings
// → Telemetry export lives here, so it can be extracted for translation; every refusal the Hub
// answers with gets plain words, never a raw code.
import { APP_SCOPE_TEXT, isAppScope, type AppConsentView, type OtlpSignal } from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import { OWNER_ONLY_TEXT } from '../team/format.ts';

export const SETTINGS_APPS_PATH = '/settings/apps';
export const SETTINGS_TELEMETRY_PATH = '/settings/telemetry';
/** The consent page apps open (the Hub's metadata names it `authorization_endpoint`). */
export const AUTHORIZE_PATH = '/authorize';

// ---- the consent page --------------------------------------------------------------------------

export const CONSENT_TEXT = {
  loading: 'Loading the request',
  title: (name: string) => `Allow ${name} to use your Hub?`,
  intro: (name: string) =>
    `${name} is asking to read parts of this Hub as you. Apps can only read: they cannot send messages, run tools or change anything.`,
  nameCaution:
    'The app chose this name itself; Nova cannot check it. Allow it only if you just started signing in to it.',
  registered: (when: string) => `It registered with this Hub ${when}.`,
  backLoopback: (host: string) =>
    `When you answer, Nova sends you back to an app on the computer you are using (${host}).`,
  backScheme: (scheme: string) =>
    `When you answer, Nova sends you back to the app that opens ${scheme}: links.`,
  asksHeading: 'It asks to',
  keepHint: 'Untick anything you do not want to allow.',
  alreadyAllowed: 'Already allowed',
  authorizedBefore:
    'You allowed this app before. Allowing again adds what is new; what you allowed before stays.',
  revokeLater: 'You can revoke it at any time in Settings → Apps.',
  keepOne: 'Keep at least one, or choose Deny.',
  allow: 'Allow',
  deny: 'Deny',
  allowing: 'Allowing…',
  denying: 'Denying…',
  allowed: (name: string) =>
    `Allowed. Nova is sending you back to ${name}. If nothing happens, you can close this page.`,
  denied: (name: string) =>
    `Denied. Nova told ${name} no and is sending you back. If nothing happens, you can close this page.`,
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
} as const;

/** Where the browser goes after the decision: what the person is told about it. */
export function backText(view: Pick<AppConsentView['client'], 'redirectUri' | 'redirectKind'>) {
  try {
    const u = new URL(view.redirectUri);
    return view.redirectKind === 'loopback'
      ? CONSENT_TEXT.backLoopback(u.host)
      : CONSENT_TEXT.backScheme(u.protocol.replace(/:$/, ''));
  } catch {
    return CONSENT_TEXT.backScheme(view.redirectUri.split(':')[0] ?? view.redirectUri);
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

/** The scope's plain words, or the raw name for one this client does not know. */
export function scopeText(scope: string): { label: string; description: string } {
  return isAppScope(scope) ? APP_SCOPE_TEXT[scope] : { label: scope, description: '' };
}

// ---- Settings → Apps ---------------------------------------------------------------------------

export const APPS_TEXT = {
  heading: 'Apps',
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
  metadataLabel: 'Sign-in details for apps',
  listHeading: 'Apps you allowed',
  listLabel: 'Apps you allowed',
  loading: 'Loading apps',
  loadFailed: 'Could not load the apps.',
  emptyTitle: 'No apps yet',
  emptyDescription: 'When you allow an app, it is listed here with what it may read.',
  sessions: (n: number) =>
    n === 0 ? 'Not signed in now' : n === 1 ? 'Signed in on 1 device' : `Signed in on ${n} devices`,
  lastUsed: (when: string) => `last used ${when}`,
  allowedWhen: (when: string) => `allowed ${when}`,
  returnsTo: 'Sends sign-ins back to',
  mayRead: 'May read',
  revoke: 'Revoke',
  revokeLabel: (name: string) => `Revoke ${name}`,
  revokeTitle: (name: string) => `Revoke ${name}?`,
  revokeWhat: (name: string, sessions: number) =>
    `${name} loses access at once: ${
      sessions === 0
        ? 'its tokens stop working'
        : sessions === 1
          ? 'its sign-in ends and its tokens stop working'
          : `its ${sessions} sign-ins end and its tokens stop working`
    }. It can ask again later; nothing is allowed until you approve it again.`,
  cancel: 'Cancel',
  revoked: (name: string) => `${name} revoked. Its tokens stopped working.`,
  revokeFailed: (name: string, why: string) => `Could not revoke ${name}: ${why}`,
  pendingHeading: 'Waiting for approval',
  pending: (n: number) =>
    n === 1
      ? '1 app registered but nobody approved it yet.'
      : `${n} apps registered but nobody approved them yet.`,
  pendingNone: 'No app is waiting.',
  pendingHow:
    'An app shows what it asks for when it opens the sign-in page here. Apps nobody approves within a day are removed.',
  pendingUnknown: 'Could not check for apps waiting for approval.',
  retry: 'Retry',
} as const;

// ---- Settings → Telemetry export (OTLP) --------------------------------------------------------

export const SIGNAL_TEXT: Record<OtlpSignal, { label: string; description: string }> = {
  traces: { label: 'Traces', description: 'Timing of requests and work, by route.' },
  metrics: { label: 'Metrics', description: 'Counts and durations, never content.' },
  logs: { label: 'Logs', description: 'The Hub’s log lines, redacted.' },
};

export const OTLP_TEXT = {
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
  replaceLabel: (name: string) => `Replace the value of ${name}`,
  remove: 'Remove',
  removeLabel: (name: string) => `Remove ${name}`,
  removeTitle: (name: string) => `Remove the header ${name}?`,
  removeWhat: 'It is no longer sent, and its value is deleted from the secret store.',
  removed: (name: string) => `${name} removed.`,
  addHeader: 'Add a header',
  headerName: 'Header name',
  headerNameHint: 'Letters, digits and hyphens, like Authorization or x-api-key.',
  headerNameInvalid: 'Use letters, digits and hyphens, starting with a letter or digit.',
  headerValue: 'Value',
  headerValueNew: (name: string) => `New value of ${name}`,
  headerValueMissing: 'Enter the value.',
  headerSaved: (name: string) => `${name} saved.`,
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
  contentConfirm: (where: string) =>
    `Prompts, replies, tool arguments and results, and other captured text will be sent to ${where}. Anyone who can read the collector can read them. Secrets are still removed.`,
  contentConfirmButton: 'Include content',
  contentOn: 'Content is now included in the export.',
  contentOff: 'Content is no longer exported.',
  yourCollector: 'your collector',
  testHeading: 'Check the connection',
  test: 'Send a test',
  testing: 'Sending…',
  testOk: (status: number | null) =>
    status
      ? `The collector accepted a test log line (HTTP ${status}).`
      : 'The collector accepted a test log line.',
  testFailed: (why: string) => `The test did not reach the collector: ${why}`,
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
  savedSignal: (label: string, on: boolean) =>
    on ? `${label} are sent from now on.` : `${label} are no longer sent.`,
} as const;

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

const REASON_TEXT: Record<string, string> = {
  owner_only: OWNER_ONLY_TEXT,
  managed: 'Your organization’s managed policy does not allow this.',
  apps_disabled:
    'App access is turned off on this Hub. The owner can turn it on in Settings → Apps.',
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
  no_endpoint: OTLP_TEXT.testNoEndpoint,
  rate_limited: 'Too many requests. Wait a minute and try again.',
  address_rate_limited: 'Too many requests from this address. Wait a minute and try again.',
  too_many_pending_apps: 'Too many apps are waiting for approval. Try again later.',
};

/** A refusal in plain words: by reason first, then by the field a validation names. */
export function appErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const reason = reasonOf(err);
  if (reason && REASON_TEXT[reason]) return REASON_TEXT[reason];
  if (err.status === 404) return 'It is no longer there. Refresh the page.';
  const d = err.body.details ?? {};
  const field =
    str(d.field) ??
    (Array.isArray(d.issues) ? str((d.issues[0] as { path?: unknown } | undefined)?.path) : null);
  if (field === 'endpoint') return OTLP_TEXT.endpointInvalid;
  if (field === 'headers') return OTLP_TEXT.tooManyHeaders;
  if (field?.startsWith('headers.')) return OTLP_TEXT.headerNameInvalid;
  return errorMessage(err, fallback);
}
