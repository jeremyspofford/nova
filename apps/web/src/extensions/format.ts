// Words and pure helpers for extensions (FR-117; docs/14 §4-§5, docs/26 §3): every status,
// signature and permission kind in plain words, every refusal of the extensions area as a sentence
// (never a raw code), the stable command ids extension commands get in the command registry, and
// reading a chosen `.novax` file for upload. User-facing text lives here, in one place per topic,
// so it can be extracted for translation.
import type {
  ExtensionHookView,
  ExtensionPermissionLine,
  ExtensionSignature,
  ExtensionStatus,
  ExtensionView,
} from '@nova/shared';
import { EXTENSION_BUNDLE_MAX_BYTES } from '@nova/shared';
import type { IconName } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';

/** Where the extensions live in Settings (also the owner's notification link). */
export const EXTENSIONS_PATH = '/settings/extensions';

export const EXT_TEXT = {
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
  tooLarge: 'This file is larger than 32 MB, the largest bundle the Hub accepts.',
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
  sensitive: 'Sensitive',
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
  uninstallTitle: (name: string) => `Uninstall ${name}?`,
  uninstallBody:
    'Its worker stops, and its commands, panels, tools, hooks and stored secrets are removed.',
  removeData: 'Also remove its data (the files it keeps on the Hub)',
  keepData: 'Its data stays on the Hub, so a reinstall can use it again.',
  uninstallConfirm: 'Uninstall',
  uninstalled: (name: string) => `${name} uninstalled.`,
  turnedOn: (name: string) => `${name} turned on.`,
  turnedOff: (name: string) => `${name} turned off.`,
  secretSaved: (name: string) => `${name} stored.`,
  secretCleared: (name: string) => `${name} cleared.`,
  publisher: 'Publisher',
  notSigned: 'Not signed',
  unknownPublisher: 'A publisher you do not trust',
  fingerprint: 'Key fingerprint',
  version: 'Version',
  retry: 'Try again',
  settingFailed: 'Could not change the setting.',
  changeFailed: (name: string) => `Could not change ${name}.`,
  runSwitch: (name: string) => `Run ${name}`,
  trustHook: (id: string) => `Trust ${id}`,
  hookTrusted: (id: string) => `${id} trusted.`,
  uninstallOf: (name: string) => `Uninstall ${name}`,
  uninstallFailed: (name: string) => `Could not uninstall ${name}.`,
  secretValue: (name: string) => `Value of ${name}`,
  setSecretOf: (name: string) => `Set ${name}`,
  replaceSecretOf: (name: string) => `Replace ${name}`,
  clearSecretOf: (name: string) => `Clear ${name}`,
  storeFailed: (name: string) => `Could not store ${name}.`,
  clearFailed: (name: string) => `Could not clear ${name}.`,
  clearTitle: (name: string) => `Clear ${name}?`,
  clearBody: (extension: string) =>
    `${extension} can no longer read it. The stored value is deleted from the vault.`,
  secretRow: (name: string) => `Secret ${name}`,
  openAppOf: (title: string) => `Open ${title}`,
  checkFailed: 'Could not check the bundle.',
  hooksOf: (name: string) => `Hooks: ${name}`,
  secretsOf: (name: string) => `Secrets: ${name}`,
  appsOf: (name: string) => `Apps: ${name}`,
  permissionsOf: (name: string) => `It can: ${name}`,
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
  error: 'Last error',
} as const;

export const PREVIEW_TEXT = {
  install: (name: string, version: string) => `Install ${name} ${version}?`,
  update: (name: string, version: string) => `Update ${name} to ${version}?`,
  replaces: (v: string) => `Replaces version ${v}.`,
  unverifiedTitle: 'This extension is not verified',
  unverifiedBody: (why: string) =>
    `${why}. It stays labelled Unverified for as long as it is installed. Install it only if you trust where it came from.`,
  sideload: 'I trust its source; install it unverified',
  diff: 'Permission changes',
  diffNew: 'New',
  diffGone: 'No longer',
  diffNone: 'Permissions are unchanged.',
  can: 'This extension can',
  enforced:
    'Nova enforces these limits: anything it did not declare is refused, and it is turned off.',
  hooks: 'Hooks to trust',
  hooksHint:
    'A hook never runs until you trust it by its hash. Hooks you leave unticked stay off; you can trust them later.',
  trustNow: (id: string) => `Trust ${id} now`,
  hookEvent: 'Event',
  hookRow: (id: string) => `Hook ${id}`,
  matches: '· matches',
  failed: 'Could not install the extension.',
  hookRuns: 'Runs',
  hookHash: 'Hash',
  hookRunsValue: (timeout: string, failClosed: boolean) =>
    `The extension’s own handler, in its sandbox (timeout ${timeout})${
      failClosed ? '; if it fails, the action it guards is blocked' : ''
    }`,
  policyBlock:
    'Your organization allows only extensions signed by a publisher you trust, so this one cannot be installed.',
  turnOn: 'Turn it on after installing',
  installButton: 'Install',
  updateButton: 'Update',
  cancel: 'Cancel',
  warnings: 'Warnings',
  installed: (name: string) => `${name} installed.`,
  updated: (name: string) => `${name} updated.`,
} as const;

export const HOOK_TRUST_TEXT = {
  title: 'Trust this hook?',
  from: 'From',
  event: 'Event',
  runs: 'Runs',
  runsValue: (seconds: string) =>
    `The extension’s own handler, in its sandbox (timeout ${seconds})`,
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
  matches: '· matches',
  failed: 'Could not trust the hook.',
  reloadFailed: 'The hook changed and could not be reloaded.',
  trusted: (id: string) => `${id} trusted.`,
} as const;

export const STATUS_TEXT: Record<
  ExtensionStatus,
  { text: string; tone: string | null; icon: IconName }
> = {
  running: { text: 'Running', tone: 'ready', icon: 'check' },
  starting: { text: 'Starting', tone: 'running', icon: 'refresh' },
  stopped: { text: 'Stopped', tone: null, icon: 'stop' },
  disabled: { text: 'Off', tone: null, icon: 'stop' },
  error: { text: 'Error', tone: 'blocked', icon: 'alert' },
};

export const HOOK_STATUS_TEXT: Record<
  ExtensionHookView['status'],
  { text: string; tone: string | null; icon: IconName }
> = {
  trusted: { text: 'Trusted', tone: 'ready', icon: 'check' },
  needs_trust: { text: 'Needs trust', tone: 'needs_input', icon: 'hand' },
  revoked: { text: 'Trust revoked', tone: 'blocked', icon: 'stop' },
  disabled: { text: 'Disabled', tone: null, icon: 'stop' },
};

export const SIGNATURE_TEXT: Record<ExtensionSignature, string> = {
  verified: 'Signed by a publisher you trust',
  unverified: 'Not signed by a publisher you trust',
  dev: 'Loaded by nova dev from a folder',
};

export const PERMISSION_ICON: Record<ExtensionPermissionLine['kind'], IconName> = {
  network: 'network',
  fs: 'folder',
  secret: 'shield',
  command: 'slash',
  panel: 'panel',
  tool: 'tool',
  hook: 'hand',
  event: 'activity',
  plugin: 'server',
};

/** What the extension's worker registered, as short counts ("2 commands, 1 panel"). */
export function registeredText(r: ExtensionView['registered']): string {
  const parts: [number, string, string][] = [
    [r.commands, 'command', 'commands'],
    [r.panels, 'panel', 'panels'],
    [r.tools, 'tool', 'tools'],
    [r.hooks, 'hook', 'hooks'],
    [r.themes, 'theme', 'themes'],
    [r.keybindings, 'shortcut', 'shortcuts'],
    [r.menus, 'menu', 'menus'],
    [r.statusItems, 'status item', 'status items'],
    [r.events, 'event listener', 'event listeners'],
  ];
  const out = parts.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return out.length ? out.join(', ') : 'Nothing yet';
}

/** "Signed by Example Labs", "Not signed", or the fingerprint of an untrusted key. */
export function publisherText(p: ExtensionView['publisher']): string {
  if (!p.key) return EXT_TEXT.notSigned;
  if (p.trusted && p.name) return p.name;
  return EXT_TEXT.unknownPublisher;
}

/** A hook's timeout in plain words ("30 s", "2 min"). */
export function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
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
  if (file.size > EXTENSION_BUNDLE_MAX_BYTES) return { ok: false, error: EXT_TEXT.tooLarge };
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

/** A refusal of the extensions area in plain words (docs/04 §7: what happened and what to do). */
export function extensionErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  switch (reasonOf(err) ?? err.body.code) {
    case 'owner_only':
      return 'Only the owner of this Hub can manage extensions.';
    case 'managed':
      return `Managed by your organization: ${err.body.message}`;
    case 'signature_invalid':
      return 'This bundle was refused: its files do not match its signature, so it may have been changed after it was signed. It cannot be installed, even unverified.';
    case 'not_an_extension':
      return 'This is not an extension: the bundle has no .nova-plugin/extension.json.';
    case 'fs_scope_refused':
      return 'This extension asks for files inside the Hub’s own data, which is never allowed.';
    case 'sideload_confirmation_required':
      return 'This extension is not verified. Tick that you trust its source to install it unverified.';
    case 'request_expired':
      return 'This preview expired. Choose the file again.';
    case 'conflict':
      return 'The extension changed since the preview. Choose the file again.';
    case 'not_found':
      return 'That is no longer there. The extension may have been removed or turned off.';
    case 'policy_denied':
      return `Refused by policy: ${err.body.message}`;
    case 'validation':
      return err.body.message ? `This was refused: ${err.body.message}.` : fallback;
    default:
      return errorMessage(err, fallback);
  }
}

/**
 * A command's failure inside its extension (the host's codes: packages/core/src/sdk/host.ts and
 * engine.ts); a handler's own error keeps its message, which is the extension's text.
 */
export function commandErrorText(
  title: string,
  error: { code: string; message: string } | null,
): string {
  if (!error) return `${title} did not finish.`;
  switch (error.code) {
    case 'timeout':
      return `${title} took too long, so Nova stopped waiting for it.`;
    case 'extension_unavailable':
    case 'extension_stopped':
    case 'not_registered':
      return `${title} is not available: its extension is not running.`;
    case 'extension_busy':
      return `${title} is busy with other calls. Try again in a moment.`;
    case 'cancelled':
      return `${title} was cancelled.`;
    case 'invalid_arguments':
      return `${title} could not be given what it needs.`;
    case 'policy_denied':
      return `${title} asked for something its extension did not declare, so it was refused and the extension was turned off.`;
    default:
      return `${title} failed: ${error.message}`;
  }
}
