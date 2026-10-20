// Words and pure helpers for extensions (FR-117; docs/14 §4-§5, docs/26 §3): every status,
// signature and permission kind in plain words, every refusal of the extensions area as a sentence
// (never a raw code), the stable command ids extension commands get in the command registry, and
// reading a chosen `.novax` file for upload. Every word is a message (FR-016), read at render time;
// text the Hub or the extension writes (permission lines, warnings, error `message`s, names)
// stays as it was sent.
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import type {
  ExtensionHookView,
  ExtensionPermissionLine,
  ExtensionStatus,
  ExtensionView,
} from '@nova/shared';
import { EXTENSION_BUNDLE_MAX_BYTES } from '@nova/shared';
import type { IconName } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';
import { HOOK_EVENT_TEXT } from '../settings/plugin-text.ts';

/** Where the extensions live in Settings (also the owner's notification link). */
export const EXTENSIONS_PATH = '/settings/extensions';

export const EXT_TEXT = defineMessages('extensions', {
  title: 'Extensions',
  intro:
    'Extensions add commands, panels, tools, hooks, themes and shortcuts. Each one runs on the Hub by itself, with only the permissions it declares; anything else it asks for is refused and it is turned off.',
  ownerOnly: 'Extensions',
  loading: 'Loading extensions',
  loadFailed: 'Could not load the extensions.',
  none: 'No extensions are installed.',
  noneHint: 'Install one from a .novax file below, or find one in the Marketplace.',
  marketLink: 'Open the Marketplace',
  installed: 'Installed extensions',
  installTitle: 'Install from a file',
  installHint:
    'Choose a .novax bundle. Nothing is installed until you have seen what it can do and chosen Install.',
  chooseFile: 'Choose a .novax file',
  checking: 'Checking the bundle…',
  tooLarge: 'This file is larger than {size}, the largest bundle the Hub accepts.',
  notNovax: 'Choose a .novax file.',
  readFailed: 'This file could not be read.',
  sdkOff:
    'Extensions are turned off on this Hub, so none of them run. Their commands, panels, tools and hooks come back when you turn them on.',
  sdkSwitch: 'Run extensions',
  sdkSwitchHint:
    'Off stops every extension. Their settings and data stay until you uninstall them.',
  developer: 'For developers',
  developerBody:
    'To try an extension you are writing, run nova dev with the folder of your extension. It packs the folder, loads it into this Hub and loads it again each time you save. A loaded folder is always Unverified. Use nova validate to check it and nova pack to make a signed .novax file.',
  developerEnv:
    'The command reads the Hub address and a token from NOVA_URL and NOVA_TOKEN in its environment.',
  permissions: 'It can',
  noPermissions: 'It asks for no permissions.',
  /** After a sensitive permission line. */
  sensitive: '(Sensitive)',
  hooks: 'Hooks',
  hooksHint:
    'A hook never runs until you trust it by its hash. An update changes the hash, so you trust it again.',
  trust: 'Trust…',
  secrets: 'Secrets',
  secretsHint:
    'Values are stored in the Hub’s vault. Nova never shows them again, and the extension reads only the names it declared.',
  secretSet: 'Stored',
  secretUnset: 'Not set',
  setSecret: 'Set',
  replaceSecret: 'Replace',
  clearSecret: 'Clear',
  saveSecret: 'Save',
  cancel: 'Cancel',
  apps: 'Apps',
  openApp: 'Open',
  uninstall: 'Uninstall…',
  uninstallTitle: 'Uninstall {name}?',
  uninstallBody:
    'Its worker stops, and its commands, panels, tools, hooks and stored secrets are removed.',
  removeData: 'Also remove its data (the files it keeps on the Hub)',
  keepData: 'Its data stays on the Hub, so a reinstall can use it again.',
  uninstallConfirm: 'Uninstall',
  uninstalled: '{name} uninstalled.',
  turnedOn: '{name} turned on.',
  turnedOff: '{name} turned off.',
  secretSaved: '{name} stored.',
  secretCleared: '{name} cleared.',
  publisher: 'Publisher',
  /** Who signed it, then the signature in words: "Example Labs · Signed by a publisher you trust". */
  publisherLine: '{publisher} · {signature}',
  notSigned: 'Not signed',
  unknownPublisher: 'A publisher you do not trust',
  untrustedKey: 'Key {fingerprint}, not trusted',
  fingerprint: 'Key fingerprint',
  retry: 'Try again',
  settingFailed: 'Could not change the setting.',
  changeFailed: 'Could not change {name}.',
  runSwitch: 'Run {name}',
  trustHook: 'Trust {id}',
  hookTrusted: '{id} trusted.',
  uninstallOf: 'Uninstall {name}',
  uninstallFailed: 'Could not uninstall {name}.',
  secretValue: 'Value of {name}',
  setSecretOf: 'Set {name}',
  replaceSecretOf: 'Replace {name}',
  clearSecretOf: 'Clear {name}',
  storeFailed: 'Could not store {name}.',
  clearFailed: 'Could not clear {name}.',
  clearTitle: 'Clear {name}?',
  clearBody: '{extension} can no longer read it. The stored value is deleted from the vault.',
  secretRow: 'Secret {name}',
  openAppOf: 'Open {title}',
  checkFailed: 'Could not check the bundle.',
  hooksOf: 'Hooks: {name}',
  secretsOf: 'Secrets: {name}',
  appsOf: 'Apps: {name}',
  permissionsOf: 'It can: {name}',
  appKind: {
    global: 'Opens from Apps',
    thread: 'Opens beside a chat, from its Apps panel',
    file: 'Opens files with Open with',
  },
  fromHub: 'From a file or folder on the Hub',
  pathLabel: 'Path on the Hub',
  pathHint: 'A .novax file or an extension folder, as a full path on the Hub’s machine.',
  pathCheck: 'Check',
  pathError: 'Enter a full path on the Hub, starting with /.',
  devCommands: 'Commands',
  registered: 'Running now',
  notRunning: 'Nothing: it is not running',
  /** What the worker registered, when it registered nothing. */
  nothingYet: 'Nothing yet',
  /** The extension's last error, in its own words. */
  error: 'Last error: {error}',
});

export const PREVIEW_TEXT = defineMessages('extensions.preview', {
  install: 'Install {name} {version}?',
  update: 'Update {name} to {version}?',
  replaces: 'Replaces version {version}.',
  unverifiedTitle: 'This extension is not verified.',
  /** `why` is the Hub's reason ("The bundle is not signed") or `notSigned`. */
  unverifiedBody:
    '{why}. It stays labelled Unverified for as long as it is installed. Install it only if you trust where it came from.',
  notSigned: 'It is not signed',
  /** The signature in words, then the trusted publisher's name. */
  signedBy: '{signature}: {name}',
  sideload: 'I trust its source; install it unverified',
  diff: 'Permission changes',
  diffNew: 'New',
  diffChanged: 'Changed',
  diffGone: 'No longer',
  diffNone: 'Permissions are unchanged.',
  can: 'This extension can',
  enforced:
    'Nova enforces these limits: anything it did not declare is refused, and it is turned off.',
  hooks: 'Hooks to trust',
  hooksHint:
    'A hook never runs until you trust it by its hash. Hooks you leave unticked stay off; you can trust them later.',
  trustNow: 'Trust {id} now',
  hookEvent: 'Event',
  hookRow: 'Hook {id}',
  /** After the hook's event; `matcher` is the matcher as code. */
  matches: '· matches {matcher}',
  failed: 'Could not install the extension.',
  hookRuns: 'Runs',
  hookHash: 'Hash',
  /** `failClosed` is `yes` or `no`; `timeout` a duration ("30 s"). */
  hookRunsValue:
    '{failClosed, select, yes {The extension’s own handler, in its sandbox (timeout {timeout}); if it fails, the action it guards is blocked} other {The extension’s own handler, in its sandbox (timeout {timeout})}}',
  policyBlock:
    'Your organization allows only extensions signed by a publisher you trust, so this one cannot be installed.',
  turnOn: 'Turn it on after installing',
  installButton: 'Install',
  updateButton: 'Update',
  cancel: 'Cancel',
  warnings: 'Warnings',
  installed: '{name} installed.',
  updated: '{name} updated.',
});

export const HOOK_TRUST_TEXT = defineMessages('extensions.hookTrust', {
  title: 'Trust this hook?',
  /** Under the title: the hook's id and its trust state in words. */
  description: '{id} · {status}',
  from: 'From',
  event: 'Event',
  runs: 'Runs',
  runsValue: 'The extension’s own handler, in its sandbox (timeout {timeout})',
  hash: 'Hash',
  can: 'Can',
  cannot: 'Cannot',
  failClosed: 'If it fails',
  failClosedYes: 'The action it guards is blocked',
  failClosedNo: 'It has no effect',
  changed:
    'This hook changed since it was shown. Check its new hash, then trust it only if you still want it.',
  gone: 'This hook no longer exists.',
  trust: 'Trust',
  keep: 'Keep disabled',
  /** After the hook's event; `matcher` is the matcher as code. */
  matches: '· matches {matcher}',
  failed: 'Could not trust the hook.',
  reloadFailed: 'The hook changed and could not be reloaded.',
});

/** A hook event in plain words (the settings' hook words), or the event itself. */
export function hookEventText(event: string): string {
  return messageFor(HOOK_EVENT_TEXT, event) ?? event;
}

/** A status chip whose word is read in the active locale each time it is shown. */
function chip(text: () => string, tone: string | null, icon: IconName) {
  return {
    get text() {
      return text();
    },
    tone,
    icon,
  };
}

const STATUS_WORDS = defineMessages('extensions.status', {
  running: 'Running',
  starting: 'Starting',
  stopped: 'Stopped',
  disabled: 'Off',
  error: 'Error',
});

/** Why the Hub stopped an extension the owner left on (the view's `stopped`). */
export const STOPPED_TEXT = defineMessages('extensions.stopped', {
  notAllowed: 'Your organization’s policy does not allow this extension, so it is stopped.',
  unverified:
    'Your organization allows only extensions signed by a publisher you trust, so this unverified one is stopped.',
  unreadable:
    'Your organization’s policy could not be read, so every extension is stopped until it is fixed.',
  sdkOff: 'Stopped because extensions are turned off on this Hub.',
  /** An older Hub that gives only its own sentence: `reason` is the Hub's words. */
  hubReason: 'Stopped: {reason}',
});

/** The sentence for why an extension is stopped, or null when the Hub said nothing. */
export function stoppedText(e: Pick<ExtensionView, 'stopped' | 'error'>): string | null {
  const s = e.stopped;
  if (!s) return e.error ? STOPPED_TEXT.hubReason({ reason: e.error }) : null;
  if (s.reason === 'sdk_off') return STOPPED_TEXT.sdkOff;
  if (s.reason === 'managed_unreadable') return STOPPED_TEXT.unreadable;
  return s.policy === 'unverifiedInstalls' ? STOPPED_TEXT.unverified : STOPPED_TEXT.notAllowed;
}

export const STATUS_TEXT: Record<
  ExtensionStatus,
  { readonly text: string; tone: string | null; icon: IconName }
> = {
  running: chip(() => STATUS_WORDS.running, 'ready', 'check'),
  starting: chip(() => STATUS_WORDS.starting, 'running', 'refresh'),
  stopped: chip(() => STATUS_WORDS.stopped, null, 'stop'),
  disabled: chip(() => STATUS_WORDS.disabled, null, 'stop'),
  error: chip(() => STATUS_WORDS.error, 'blocked', 'alert'),
};

const HOOK_STATUS_WORDS = defineMessages('extensions.hookStatus', {
  trusted: 'Trusted',
  needsTrust: 'Needs trust',
  revoked: 'Trust revoked',
  disabled: 'Disabled',
});

export const HOOK_STATUS_TEXT: Record<
  ExtensionHookView['status'],
  { readonly text: string; tone: string | null; icon: IconName }
> = {
  trusted: chip(() => HOOK_STATUS_WORDS.trusted, 'ready', 'check'),
  needs_trust: chip(() => HOOK_STATUS_WORDS.needsTrust, 'needs_input', 'hand'),
  revoked: chip(() => HOOK_STATUS_WORDS.revoked, 'blocked', 'stop'),
  disabled: chip(() => HOOK_STATUS_WORDS.disabled, null, 'stop'),
};

export const SIGNATURE_TEXT = defineMessages('extensions.signature', {
  verified: 'Signed by a publisher you trust',
  unverified: 'Not signed by a publisher you trust',
  dev: 'Loaded by nova dev from a folder',
});

export const PERMISSION_ICON: Record<ExtensionPermissionLine['kind'], IconName> = {
  network: 'network',
  fs: 'folder',
  secret: 'shield',
  command: 'slash',
  panel: 'panel',
  tool: 'tool',
  action_default: 'tool',
  hook: 'hand',
  hooks_answer_asks: 'hand',
  event: 'activity',
  role: 'agents',
  mcp_server: 'server',
  ui_entry: 'panel',
  ui_domain: 'network',
  browser_extension: 'external',
  plugin: 'server',
};

const REGISTERED_TEXT = defineMessages('extensions.counts', {
  commands: '{n, plural, one {# command} other {# commands}}',
  panels: '{n, plural, one {# panel} other {# panels}}',
  tools: '{n, plural, one {# tool} other {# tools}}',
  hooks: '{n, plural, one {# hook} other {# hooks}}',
  themes: '{n, plural, one {# theme} other {# themes}}',
  keybindings: '{n, plural, one {# shortcut} other {# shortcuts}}',
  menus: '{n, plural, one {# menu} other {# menus}}',
  statusItems: '{n, plural, one {# status item} other {# status items}}',
  events: '{n, plural, one {# event listener} other {# event listeners}}',
});

const REGISTERED_KINDS = [
  'commands',
  'panels',
  'tools',
  'hooks',
  'themes',
  'keybindings',
  'menus',
  'statusItems',
  'events',
] as const;

/** What the extension's worker registered, as short counts ("2 commands, 1 panel"). */
export function registeredText(r: ExtensionView['registered']): string {
  const out = REGISTERED_KINDS.filter((k) => r[k] > 0).map((k) => REGISTERED_TEXT[k]({ n: r[k] }));
  return out.length ? fmt.list(out, { type: 'unit', style: 'short' }) : EXT_TEXT.nothingYet;
}

/** "Signed by Example Labs", "Not signed", or the fingerprint of an untrusted key. */
export function publisherText(p: ExtensionView['publisher']): string {
  if (!p.key) return EXT_TEXT.notSigned;
  if (p.trusted) return p.name ?? p.fingerprint ?? EXT_TEXT.unknownPublisher;
  // Never a name the bundle claims: the key's fingerprint, and that it is not trusted.
  return p.fingerprint
    ? EXT_TEXT.untrustedKey({ fingerprint: p.fingerprint })
    : EXT_TEXT.unknownPublisher;
}

// ---- the command registry ----------------------------------------------------------------------

const ESCAPES: Record<string, string> = { '.': '.d', '-': '.h', _: '.u' };

function escapeId(s: string): string {
  return s.replace(/[._-]/g, (c) => ESCAPES[c] ?? '');
}

/**
 * The registry id of an extension's command: `ext.` + the extension id and the command id, each
 * with `.`, `-` and `_` escaped and joined by `.s`. Every `.` after `ext.` starts an escape, so two
 * different commands never share an id, and the id is a valid key of `keyboard.bindings`
 * (`^[a-z][a-zA-Z0-9.]*$`), so the user can bind it like any other command.
 */
export function extensionCommandKey(extensionId: string, commandId: string): string {
  return `ext.${escapeId(extensionId)}.s${escapeId(commandId)}`;
}

/** `ext:<extensionId>/<commandId>` (a contributed keybinding's command) as its parts. */
export function parseExtensionCommand(
  name: string,
): { extensionId: string; commandId: string } | null {
  const m = /^ext:([^/]+)\/(.+)$/.exec(name);
  return m ? { extensionId: m[1]!, commandId: m[2]! } : null;
}

// ---- reading a bundle -------------------------------------------------------------------------

/** A chosen `.novax` file as base64 for the upload, or why it cannot be sent. */
export async function readBundleFile(
  file: File,
): Promise<{ ok: true; bundle: string; fileName: string } | { ok: false; error: string }> {
  if (!/\.novax$/i.test(file.name)) return { ok: false, error: EXT_TEXT.notNovax };
  if (file.size > EXTENSION_BUNDLE_MAX_BYTES)
    return { ok: false, error: EXT_TEXT.tooLarge({ size: fmt.bytes(EXTENSION_BUNDLE_MAX_BYTES) }) };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK)
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    return { ok: true, bundle: btoa(bin), fileName: file.name.slice(0, 200) };
  } catch {
    return { ok: false, error: EXT_TEXT.readFailed };
  }
}

// ---- refusals ---------------------------------------------------------------------------------

function reasonOf(err: ApiError): string | null {
  const r = err.body.details?.reason;
  return typeof r === 'string' ? r : null;
}

const ERROR_TEXT = defineMessages('extensions.errors', {
  fallback: 'Something went wrong.',
  /** By the refusal's reason (or its code). */
  reason: {
    owner_only: 'Only the owner of this Hub can manage extensions.',
    signature_invalid:
      'This bundle was refused: its files do not match its signature, so it may have been changed after it was signed. It cannot be installed, even unverified.',
    not_an_extension: 'This is not an extension: the bundle has no .nova-plugin/extension.json.',
    fs_scope_refused:
      'This extension asks for files inside the Hub’s own data, which is never allowed.',
    sideload_confirmation_required:
      'This extension is not verified. Tick that you trust its source to install it unverified.',
    publisher_change_confirmation_required:
      'This version comes from another publisher than the installed one. Tick that you accept the new publisher to install it.',
    request_expired: 'This preview expired. Choose the file again.',
    conflict: 'The extension changed since the preview. Choose the file again.',
    not_found: 'That is no longer there. The extension may have been removed or turned off.',
  },
  /** `message` is the Hub's own words. */
  managed: 'Managed by your organization: {message}',
  policyDenied: 'Refused by policy: {message}',
  validation: 'This was refused: {message}.',
});

/** A refusal of the extensions area in plain words (docs/04 §7: what happened and what to do). */
export function extensionErrorMessage(
  err: unknown,
  fallback: string = ERROR_TEXT.fallback,
): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const code = reasonOf(err) ?? err.body.code;
  const plain = messageFor(ERROR_TEXT.reason, code);
  if (plain !== undefined) return plain;
  switch (code) {
    case 'managed':
      return ERROR_TEXT.managed({ message: err.body.message });
    case 'policy_denied':
      return ERROR_TEXT.policyDenied({ message: err.body.message });
    case 'validation':
      return err.body.message ? ERROR_TEXT.validation({ message: err.body.message }) : fallback;
    default:
      return errorMessage(err, fallback);
  }
}

const COMMAND_ERROR_TEXT = defineMessages('extensions.commandErrors', {
  unfinished: '{title} did not finish.',
  timeout: '{title} took too long, so Nova stopped waiting for it.',
  unavailable: '{title} is not available: its extension is not running.',
  busy: '{title} is busy with other calls. Try again in a moment.',
  cancelled: '{title} was cancelled.',
  invalidArguments: '{title} could not be given what it needs.',
  policyDenied:
    '{title} asked for something its extension did not declare, so it was refused and the extension was turned off.',
  /** `message` is the extension's own words. */
  failed: '{title} failed: {message}',
});

/**
 * A command's failure inside its extension (the host's codes: packages/core/src/sdk/host.ts and
 * engine.ts); a handler's own error keeps its message, which is the extension's text.
 */
export function commandErrorText(
  title: string,
  error: { code: string; message: string } | null,
): string {
  const S = COMMAND_ERROR_TEXT;
  if (!error) return S.unfinished({ title });
  switch (error.code) {
    case 'timeout':
      return S.timeout({ title });
    case 'extension_unavailable':
    case 'extension_stopped':
    case 'not_registered':
      return S.unavailable({ title });
    case 'extension_busy':
      return S.busy({ title });
    case 'cancelled':
      return S.cancelled({ title });
    case 'invalid_arguments':
      return S.invalidArguments({ title });
    case 'policy_denied':
      return S.policyDenied({ title });
    default:
      return S.failed({ title, message: error.message });
  }
}

// ---- what a command returned ------------------------------------------------------------------

/** The longest result a toast shows on its one line. */
export const RESULT_LINE_MAX = 120;
/** The most of a result the dialog shows (the Hub caps it too). */
const RESULT_FULL_MAX = 20_000;

/**
 * What a command returned, as the extension wrote it (its data): `line` for the toast, and `full`
 * when one line does not hold it all, for a dialog. A command returns any JSON (docs/26 §9.3): a
 * string as is; an object by its `message` or `text` when it has one, else as `key: value` when
 * that fits a line; anything longer, formatted, only in the dialog (never raw JSON in a toast).
 * Nothing to show (null, a boolean, an empty string or object) is neither.
 */
export function commandResultText(result: unknown): {
  line: string | null;
  full: { text: string; json: boolean } | null;
} {
  const none = { line: null, full: null };
  if (result === null || result === undefined || typeof result === 'boolean') return none;
  if (typeof result === 'number') return { line: fmt.number(result), full: null };
  if (typeof result === 'string') return textResult(result);
  if (typeof result !== 'object') return none;
  if (!Array.isArray(result)) {
    const o = result as Record<string, unknown>;
    for (const said of [o.message, o.text])
      if (typeof said === 'string' && said.trim()) return textResult(said);
    if (Object.keys(o).length === 0) return none;
  } else if (result.length === 0) return none;
  const summary = summarize(result);
  if (summary !== null && summary.length <= RESULT_LINE_MAX) return { line: summary, full: null };
  let json: string;
  try {
    json = JSON.stringify(result, null, 2);
  } catch {
    return none;
  }
  return { line: null, full: { text: json.slice(0, RESULT_FULL_MAX), json: true } };
}

function textResult(s: string): ReturnType<typeof commandResultText> {
  const text = s.trim();
  if (!text) return { line: null, full: null };
  const first = text.split(/\r?\n/, 1)[0]!.trim();
  if (first === text && text.length <= RESULT_LINE_MAX) return { line: text, full: null };
  // The start of it, marked as cut; the dialog has the rest.
  const line = `${first.slice(0, RESULT_LINE_MAX - 1).trimEnd()}…`;
  return { line, full: { text: text.slice(0, RESULT_FULL_MAX), json: false } };
}

/** A flat array or object as one line (`saved: true, count: 3`), or null when it nests. */
function summarize(value: object): string | null {
  const flat = (v: unknown): string | null =>
    v === null || ['string', 'number', 'boolean'].includes(typeof v)
      ? typeof v === 'number'
        ? fmt.number(v)
        : String(v)
      : null;
  const parts: string[] = [];
  for (const [k, v] of Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as const)
    : Object.entries(value)) {
    const text = flat(v);
    if (text === null) return null;
    parts.push(Array.isArray(value) ? text : `${k}: ${text}`);
  }
  return fmt.list(parts, { type: 'unit', style: 'short' });
}
