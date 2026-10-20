// Words and pure helpers for the marketplace (FR-049, FR-012; docs/14 §5, docs/08 §7, docs/26 §3):
// the tabs and kinds, catalog and item verdicts, why an item is Unverified, why policy refuses an
// install, every refusal of the marketplace in plain words (never a raw code), and catalog
// locations. Every word is a message (FR-016), read at render time; text the Hub or a catalog
// writes (permission lines, warnings, error `message`s, names and descriptions) stays as it came.
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import type {
  MarketCatalogSignature,
  MarketItemKind,
  MarketPermissionDiff,
  MarketPermissionLine,
  MarketPublisher,
  MarketVouch,
} from '@nova/shared';
import type { IconName } from '@nova/ui';
import { ApiError, errorMessage } from '../api.ts';

/** The marketplace page (docs/04 §1: a top-level surface). */
export const MARKET_PATH = '/marketplace';

export const MARKET_TABS = [
  'plugins',
  'skills',
  'themes',
  'pets',
  'mcp',
  'installed',
  'catalogs',
] as const;
export type MarketTab = (typeof MARKET_TABS)[number];

export const TAB_KIND: Partial<Record<MarketTab, MarketItemKind>> = {
  plugins: 'plugin',
  skills: 'skill',
  themes: 'theme',
  pets: 'pet',
  mcp: 'mcp',
};

export function marketTabPath(tab: MarketTab): string {
  return tab === 'plugins' ? MARKET_PATH : `${MARKET_PATH}/${tab}`;
}

/** The tab a path segment names; the first tab otherwise. */
export function parseMarketTab(segment: string | null | undefined): MarketTab {
  return (MARKET_TABS as readonly string[]).includes(segment ?? '')
    ? (segment as MarketTab)
    : 'plugins';
}

export const TAB_LABEL = defineMessages('market.sections', {
  plugins: 'Plugins',
  skills: 'Skills',
  themes: 'Themes',
  pets: 'Pets',
  mcp: 'MCP servers',
  installed: 'Installed',
  catalogs: 'Catalogs',
});

/** A kind of item: `one` names one item in a card's details, `title` the kind as a heading. */
export const KIND_TEXT = defineMessages('market.kinds', {
  plugin: { one: 'plugin', title: 'Plugins' },
  skill: { one: 'skill', title: 'Skills' },
  theme: { one: 'theme', title: 'Themes' },
  pet: { one: 'pet', title: 'Pets' },
  mcp: { one: 'MCP server', title: 'MCP servers' },
});

export const MARKET_TEXT = defineMessages('market', {
  title: 'Marketplace',
  intro:
    'Plugins, skills, themes, pets and MCP servers from your catalogs. Each item shows what it can do before anything is installed, and an update shows what changes.',
  search: 'Search the marketplace',
  searchPlaceholder: 'Search by name or description',
  tabs: 'Marketplace sections',
  loading: 'Loading the marketplace',
  loadFailed: 'Could not load the marketplace.',
  retry: 'Try again',
  /** A kind's tab when its catalogs list nothing of that kind. */
  empty:
    '{kind, select, plugin {No plugins in your catalogs yet.} skill {No skills in your catalogs yet.} theme {No themes in your catalogs yet.} pet {No pets in your catalogs yet.} mcp {No MCP servers in your catalogs yet.} other {Nothing of this kind in your catalogs yet.}}',
  noMatch: 'Nothing matches “{query}”.',
  by: 'By {author}',
  version: 'Version {version}',
  installedVersion: 'Installed: {version}',
  updateTo: 'Update to {version}',
  install: 'Install',
  remove: 'Remove…',
  details: 'Details',
  detailsOf: 'Details of {name}',
  installOf: 'Install {name}',
  updateOf: 'Update {name}',
  removeOf: 'Remove {name}',
  canAccess: 'It can',
  /** The list of what an item can do, named after the item. */
  canAccessOf: 'What {name} can do',
  screenshots: 'Screenshots',
  screenshot: 'Screenshot {n} of {name}',
  changelog: 'Changelog',
  noChangelog: 'No changelog.',
  brings: 'What it brings',
  hooks: 'Hooks',
  roles: 'Sub-agent roles',
  browserExtensions: 'Browser extensions',
  entryPoints: 'App screens',
  /** An app screen and where it shows: "Sample panel (in Apps)". */
  entryPoint: '{title} ({where})',
  homepage: 'Homepage',
  catalog: 'Catalog',
  versions: 'Versions',
  close: 'Close',
  rating: 'Your rating',
  ratingHint: 'Ratings stay on this Hub. Nothing is sent anywhere.',
  stars: '{n, plural, one {# star} other {# stars}}',
  rate: 'Save rating',
  review: 'Notes (optional)',
  clearRating: 'Clear rating',
  rated: 'Rating saved.',
  rateFailed: 'Could not save the rating.',
  ratingCleared: 'Rating cleared.',
  unrated: 'Not rated',
  removeTitle: 'Remove {name}?',
  removeConfirm: 'Remove',
  removeFailed: 'Could not remove it.',
  cancel: 'Cancel',
  removed: '{name} removed.',
  installedToast: '{name} installed.',
  updatedToast: '{name} updated.',
  installedTab: 'Installed from the marketplace',
  noneInstalled: 'Nothing is installed from the marketplace yet.',
  from: 'From {origin}',
  /** A kind's tab when installing that kind is turned off. */
  kindOff:
    '{kind, select, plugin {Installing plugins is turned off.} skill {Installing skills is turned off.} theme {Installing themes is turned off.} pet {Installing pets is turned off.} mcp {Installing MCP servers is turned off.} other {Installing this kind of item is turned off.}}',
  petsHint: 'Choose an installed pet in Settings → Appearance.',
  themesHint: 'An installed theme is kept in Settings → Appearance → Your themes; use it there.',
});

/** What removing an item of each kind takes with it (the Remove confirmation). */
export const REMOVE_BODY_TEXT = defineMessages('market.removeBody', {
  plugin:
    'Its skills, servers, hooks and app screens are removed. Data it keeps stays unless you remove it in Settings.',
  skill: 'The skill is removed from your skills.',
  theme: 'The theme is removed from your themes. If you were using it, its base theme is used.',
  pet: 'The pet is removed. If it is your companion, the companion turns off.',
  mcp: 'The MCP server is removed, with the settings and secrets it stored.',
});

export const INSTALL_TEXT = defineMessages('market.installDialog', {
  install: 'Install {name} {version}?',
  update: 'Update {name} to {version}?',
  replaces: 'Replaces version {version}.',
  unverifiedTitle: 'This item is not verified.',
  unverifiedBody:
    'It stays labelled Unverified for as long as it is installed. Install it only if you trust where it came from.',
  sideload: 'I trust its source; install it unverified',
  diff: 'Permission changes',
  diffAdded: 'New',
  diffRemoved: 'No longer',
  diffChanged: 'Changed',
  /** A changed permission whose before and after read as words: "Its tools: ask → allow". */
  diffChangedLine: '{text}: {before} → {after}',
  diffNone: 'Permissions are unchanged.',
  diffOnlyRemoved: 'This update only removes permissions.',
  acceptDiff: 'I accept these permission changes',
  can: 'It can',
  enforced:
    'Nova enforces these limits; nothing it installs goes beyond them, and built-in safety still applies.',
  hooks: 'Hooks to trust',
  hooksHint:
    'A hook never runs until you trust it by its hash. Hooks you leave unticked stay off; you can trust them later.',
  trustNow: 'Trust {id} now',
  skills: 'Skills',
  servers: 'MCP servers it adds',
  roles: 'Sub-agent roles',
  entryPoints: 'App screens',
  theme: 'Colors',
  /** A theme's variant. */
  variant: '{variant, select, dark {Dark} light {Light} other {{variant}}}',
  petStates: 'States',
  /** A pet's state by its name (a pet may name its own states). */
  petState:
    '{state, select, idle {Idle} thinking {Thinking} working {Working} waiting {Waiting} success {Success} error {Error} other {{state}}}',
  serverAt: '{transport} server at {url}',
  settingsForm: 'Settings for this server',
  /** A setting the server needs, by the title its bundle gives it. */
  required: '{title} (required)',
  turnOn: 'Turn it on after installing',
  installButton: 'Install',
  updateButton: 'Update',
  cancel: 'Cancel',
  warnings: 'Warnings',
  checking: 'Checking the item…',
  checkingTitle: 'Install {name}',
  previewFailed: 'Could not check the item.',
  failed: 'Could not install the item.',
  retry: 'Try again',
  blocked: 'This cannot be installed.',
  why: 'Why it is Unverified',
  none: 'It asks for no permissions.',
  hookEvent: 'Event',
  hookRow: 'Hook {id}',
  /** A hook's event and what it applies to; `matcher` is shown as code. */
  eventMatches: '{event} · matches {matcher}',
  hookRuns: 'Runs',
  hookHash: 'Hash',
  skillTools: 'Tools it may use',
});

/** Where an app screen shows (a plugin's `uiEntryPoints[].kind`). */
export const ENTRY_KIND_TEXT = defineMessages('market.entryKinds', {
  global: 'in Apps',
  thread: 'beside a chat',
  file: 'for files',
});

/** An app screen in words: its title and where it shows (an unknown place as it came). */
export function entryPointText(title: string, kind: string): string {
  return MARKET_TEXT.entryPoint({ title, where: messageFor(ENTRY_KIND_TEXT, kind) ?? kind });
}

export const BLOCKED_TEXT = defineMessages('market.blocked', {
  managed: 'Your organization does not allow installing this.',
  sideload_disabled:
    'Installing unverified items is turned off. You can turn it on under Catalogs → Install rules.',
  kind_not_allowed: 'Installing this kind of item is turned off under Catalogs → Install rules.',
});

export const UNVERIFIED_TEXT = defineMessages('market.unverified', {
  catalog_unsigned: 'Its catalog is not signed.',
  catalog_untrusted: 'Its catalog is signed by a key you do not trust.',
  no_checksum: 'Its catalog lists no checksum for it, so its files cannot be checked.',
  checksum_mismatch: 'Its files do not match the checksum its catalog lists.',
  bundle_unsigned: 'Its bundle is not signed.',
  bundle_untrusted: 'Its bundle is signed by a key you do not trust.',
});

const SIGNATURE_TEXT = defineMessages('market.signature', {
  verified: 'Signed by a key you trust',
  untrusted: 'Signed by a key you do not trust',
  unsigned: 'Not signed',
  invalid: 'Refused: its signature does not match',
});

/** A catalog's signature as a chip; `text` reads in the active locale. */
function signatureChip(
  sig: MarketCatalogSignature,
  tone: string | null,
  icon: IconName,
): { readonly text: string; tone: string | null; icon: IconName } {
  return {
    get text() {
      return SIGNATURE_TEXT[sig];
    },
    tone,
    icon,
  };
}

export const CATALOG_SIGNATURE_TEXT: Record<
  MarketCatalogSignature,
  { readonly text: string; tone: string | null; icon: IconName }
> = {
  verified: signatureChip('verified', 'ready', 'shield'),
  untrusted: signatureChip('untrusted', 'needs_input', 'alert'),
  unsigned: signatureChip('unsigned', 'needs_input', 'alert'),
  invalid: signatureChip('invalid', 'blocked', 'stop'),
};

export const CATALOG_KIND_TEXT = defineMessages('market.catalogKinds', {
  builtin: 'Built in',
  local: 'Folder on the Hub',
  git: 'Git repository',
  url: 'Web address',
});

export const PERMISSION_ICON: Record<MarketPermissionLine['kind'], IconName> = {
  network: 'network',
  fs: 'folder',
  secret: 'shield',
  tool: 'tool',
  action_default: 'tool',
  hooks_answer_asks: 'hand',
  browser_extension: 'external',
  ui_domain: 'network',
  ui_entry: 'panel',
  hook: 'hand',
  role: 'agents',
  mcp_server: 'server',
  program: 'terminal',
  skill_tools: 'tool',
  panel: 'panel',
  command: 'slash',
  plugin: 'server',
  event: 'activity',
};

export const CATALOG_TEXT = defineMessages('market.catalogs', {
  title: 'Catalogs',
  intro:
    'Where the marketplace finds items. Every catalog’s index must be signed; an index whose signature does not match is refused.',
  builtinNote: 'The sample catalog ships with Nova and works offline.',
  items: '{n, plural, one {# item} other {# items}}',
  /** `commit` is the first 12 characters of the commit's SHA. */
  readAt: 'Read at commit {commit}',
  /** `why` is the Hub's own words. */
  unreadable: 'Could not be read: {why}',
  remove: 'Remove {name}',
  removeButton: 'Remove',
  removed: '{name} removed.',
  added: '{name} added.',
  add: 'Add a catalog',
  name: 'Name',
  location: 'Location',
  locationHint:
    'A folder on the Hub (/srv/catalog), a web address (https://…) or a Git repository (https://….git, git@host:repo or ssh://…). Add #branch to a Git address to follow a branch.',
  key: 'Publisher key (optional)',
  keyHint:
    'The Ed25519 public key (base64url, 43 characters) the catalog’s index must be signed with. Without one, a good signature by a key you do not trust leaves its items Unverified.',
  commitLabel: 'Commit (Git only, optional)',
  commitHint: 'A full 40-character commit SHA. The index is then read at that commit only.',
  addButton: 'Add catalog',
  errName: 'Enter a name for the catalog.',
  errLocation:
    'Enter a full folder path on the Hub, an https:// address or a Git repository address.',
  errKey: 'A publisher key is 43 characters of letters, digits, - and _.',
  errCommit: 'A commit is 40 characters of 0-9 and a-f.',
  errCommitNotGit: 'Only a Git catalog can be pinned to a commit.',
  errFull:
    '{max, plural, one {You can have up to # catalog. Remove it first.} other {You can have up to # catalogs. Remove one first.}}',
  yours: 'Your catalogs',
  none: 'You have not added a catalog.',
  publishers: 'Trusted publishers',
  publishersIntro:
    'Extensions and plugins signed by these keys install as Verified. Anything else needs the sideload confirmation and stays Unverified.',
  noPublishers: 'You trust no publishers yet.',
  publisherName: 'Publisher name',
  publisherKey: 'Publisher key',
  addPublisher: 'Trust this publisher',
  publisherAdded: '{name} is now trusted.',
  publisherRemoved: '{name} is no longer trusted.',
  removePublisher: 'Stop trusting {name}',
  stopTrusting: 'Stop trusting',
  errPublisherName: 'Enter the publisher’s name.',
  errPublisherDup: 'You already trust this key.',
  rules: 'Install rules',
  allowSideload: 'Allow unverified items',
  allowSideloadHint:
    'Unsigned items, items signed by a key you do not trust, and items whose files do not match their checksum install only after an explicit confirmation, and stay labelled Unverified. Off, only Verified items install.',
  kinds: 'What may be installed',
  kindsHint: 'Clear a kind to stop installing it from the marketplace.',
  saveFailed: 'Could not save.',
  loading: 'Loading the catalogs',
  addPublisherSummary: 'Trust a publisher',
  publisherKeyHint:
    'Their Ed25519 public key, base64url, 43 characters. Get it from the publisher.',
  trustTitle: 'Trust {name}?',
  trustBody:
    'Extensions, plugins and catalogs signed by this key then install as Verified, without the sideload confirmation. Check the key with the publisher first.',
  trustConfirm: 'Trust this publisher',
  untrustTitle: 'Stop trusting {name}?',
  untrustBody:
    'What they signed stays installed but shows as Unverified, and new items from them need the sideload confirmation.',
  cancel: 'Cancel',
});

/** Whether a location reads as a Git catalog (packages/core/src/plugins/catalog.ts `catalogKind`). */
export function isGitLocation(location: string): boolean {
  const l = location.trim();
  if (/^git@[^:]+:/.test(l) || /^(ssh|git):\/\//.test(l) || /^git\+https:\/\//.test(l)) return true;
  return /^https:\/\//.test(l) && /\.git(#.*)?$/.test(l);
}

/** A folder on the Hub, an https URL or a Git address. */
export function isCatalogLocation(location: string): boolean {
  const l = location.trim();
  if (!l || l.length > 1000) return false;
  if (isGitLocation(l)) return true;
  if (l.startsWith('/') || /^[A-Za-z]:[\\/]/.test(l)) return true;
  try {
    return new URL(l).protocol === 'https:';
  } catch {
    return false;
  }
}

export const PUBLISHER_KEY = /^[A-Za-z0-9_-]{43}$/;
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** A catalog id from its name, unique among `taken` (the settings schema: `^[a-z0-9-]{1,40}$`). */
export function newCatalogId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 34) || 'catalog';
  let id = base;
  for (let n = 2; taken.includes(id) || id === 'nova-sample'; n++) id = `${base}-${n}`;
  return id;
}

/** The first characters of a key, to tell keys apart by eye. */
export function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key;
}

// ---- who signed -------------------------------------------------------------------------------

export const PUBLISHER_TEXT = defineMessages('market.publisher', {
  /** The details' label for the signature line. */
  label: 'Signature',
  /** `name` is the owner's own name for a key they trust. */
  signedBy: 'Signed by {name}',
  signedTrustedKey: 'Signed with a key you trust ({fingerprint})',
  notTrusted: 'Signed with the key {fingerprint}, not trusted',
});

/**
 * Who signed, as Nova may say it (the Hub's `publisherView`): the owner's own name for a key they
 * trust; a key trusted without a name (the one a catalog pins) by its fingerprint; any other key
 * only by its fingerprint and "not trusted". A name a catalog claims for a key is never shown.
 */
export function marketPublisherText(
  p: Pick<MarketPublisher, 'name' | 'key' | 'trusted'> & { fingerprint?: string | null },
): string {
  const fp = p.fingerprint || shortKey(p.key);
  if (p.trusted && p.name) return PUBLISHER_TEXT.signedBy({ name: p.name });
  if (p.trusted) return PUBLISHER_TEXT.signedTrustedKey({ fingerprint: fp });
  return PUBLISHER_TEXT.notTrusted({ fingerprint: fp });
}

/** What vouches for a Verified item (the preview's `vouchedBy`), said by name. */
export const VOUCH_TEXT = defineMessages('market.vouch', {
  /** `catalog` is the catalog's name; `fingerprint` the pinned key's. */
  catalogPinned:
    'Verified: listed in {catalog}, signed with the key this catalog pins ({fingerprint}).',
  /** `publisher` is the owner's name for the trusted publisher that signs the catalog. */
  catalogTrusted: 'Verified: listed in {catalog}, signed by {publisher}, a publisher you trust.',
  /** `publisher` is the owner's name for the trusted publisher that signed the bundle. */
  bundle: 'Its bundle is signed by {publisher}, a publisher you trust.',
});

/** The vouching sentences of a Verified item: the catalog's, then the bundle's when it has one. */
export function vouchText(v: MarketVouch): string[] {
  const c = v.catalog;
  const who = (p: MarketPublisher | null) => p?.name ?? p?.fingerprint ?? '';
  const out = [
    c.signedWith === 'pinned_key'
      ? VOUCH_TEXT.catalogPinned({ catalog: c.name, fingerprint: c.publisher?.fingerprint ?? '' })
      : VOUCH_TEXT.catalogTrusted({ catalog: c.name, publisher: who(c.publisher) }),
  ];
  if (v.bundle) out.push(VOUCH_TEXT.bundle({ publisher: who(v.bundle) }));
  return out;
}

// ---- what an update changes -------------------------------------------------------------------
// The permission diff's `changed` lines (the marketplace's, and an extension's in Settings →
// Extensions) carry each line's `detail` before and after: a tool's `action, default` (plugins)
// or `action:default` (extensions), an action default, an extension's file access (`r`, `rw`),
// and JSON for the rest: an MCP server's {transport, command, url, args, defaultApproval, policy,
// enabledTools, disabledTools}, a hook's, a role's, a panel's or an app screen's fields. Each is
// worded part by part; raw JSON is never shown. A part that lets the item do more without asking
// (a looser approval, a different program, more sites, files or tools) is marked sensitive.

export const CHANGE_TEXT = defineMessages('market.change', {
  sensitive: 'Sensitive',
  /** One part of a changed permission: "Its tools: ask you first → run without asking". */
  field: '{label}: {before} → {after}',
  unreadable: 'Nova cannot show this change in detail. Check the item before you accept.',
  none: 'none',
  notSet: 'not set',
  yes: 'yes',
  no: 'no',
  allTools: 'all its tools',
  noTools: 'no tools',
  /** What an MCP server or a hook runs: "runs node server.js". */
  program: 'runs {command}',
  connects: 'connects to {where}',
  calls: 'calls {tool}',
  read: 'read',
  readWrite: 'read and write',
  /** The plain label of each part a changed line can have. */
  part: {
    runs: 'What it runs',
    defaultApproval: 'Its tools',
    network: 'Sites it may reach',
    fs: 'Files it may use',
    enabledTools: 'Tools it offers',
    disabledTools: 'Tools turned off',
    action: 'What it does',
    default: 'By default it',
    access: 'Access',
    event: 'When it runs',
    matcher: 'What it applies to',
    handler: 'What it runs',
    failClosed: 'Blocks the action when it fails',
    timeoutMs: 'Time limit',
    tools: 'Tools it may use',
    modelHint: 'Model it suggests',
    title: 'Title',
    extensions: 'File types',
    entryPoint: 'Where it shows',
    resource: 'What it shows',
    file: 'File',
    connectDomains: 'Sites it connects to',
    resourceDomains: 'Sites it loads from',
    frameDomains: 'Sites it embeds',
  },
  /** How an MCP server's tools are approved by default (its `defaultApproval`), after "Its tools". */
  serverApproval: {
    allow: 'run without asking',
    ask: 'ask you first',
    deny: 'are refused',
  },
  /** How a kind of action or a tool is approved by default, after "By default it". */
  actionApproval: {
    allow: 'runs without asking',
    ask: 'asks you first',
    deny: 'is refused',
  },
  /** An MCP server's file access. */
  fileAccess: {
    none: 'no files',
    read: 'read files only',
    project: 'the project’s files',
  },
});

/** A default approval in words (an unknown value as it came). */
const actionApproval = (v: string) => messageFor(CHANGE_TEXT.actionApproval, v) ?? v;

/**
 * What can change under a permission line (`detail`), in words: a tool default is worded, other
 * details (a hook's command) are shown as they are.
 */
export function permissionDetail(l: MarketPermissionLine): string | null {
  if (!l.detail) return null;
  return l.kind === 'action_default' ? actionApproval(l.detail) : l.detail;
}
/** Looser ranks higher: deny < ask < allow (unset follows the owner's settings, which ask). */
const APPROVAL_RANK: Record<string, number> = { deny: 0, ask: 1, allow: 2 };
const FILE_RANK: Record<string, number> = { none: 0, read: 1, project: 2 };

/** One part of a changed permission, before and after, in words. */
export interface ChangeField {
  label: string;
  before: string;
  after: string;
  /** It lets the item do more without asking (looser approval, more it runs, reaches or uses). */
  sensitive: boolean;
}

/**
 * A changed permission line in words: `plain` when its before and after already read as words
 * (shown as they are); otherwise the parts that changed, with `unreadable` set when some part
 * cannot be worded (it is then counted as sensitive, and its value is never shown).
 */
export interface ChangeView {
  plain: boolean;
  fields: ChangeField[];
  unreadable: boolean;
  sensitive: boolean;
}

type Changed = MarketPermissionDiff['changed'][number];
type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? v : null;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const looksStructured = (v: string | null) => v !== null && /^\s*[[{]/.test(v);
/** Hosts, tools or file types, joined the active locale's way ("a, b"). */
const listText = (v: readonly string[] | null | undefined, empty: string = CHANGE_TEXT.none) =>
  v?.length ? fmt.list(v, { type: 'unit', style: 'short' }) : empty;
const added = (before: unknown, after: unknown) =>
  (strings(after) ?? []).some((x) => !(strings(before) ?? []).includes(x));
const looser = (rank: Record<string, number>, a: unknown, b: unknown, unset: number) => {
  const r = (v: unknown) => (typeof v === 'string' ? (rank[v] ?? unset + 1) : unset);
  return r(b) > r(a);
};
const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

function parseObject(raw: string | null): Json | null {
  if (raw === null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** What an MCP server runs or where it connects, in words. */
function serverRuns(o: Json): string {
  const command = typeof o.command === 'string' && o.command ? o.command : null;
  const args = strings(o.args) ?? [];
  if (command) return CHANGE_TEXT.program({ command: [command, ...args].join(' ') });
  if (typeof o.url === 'string' && o.url) return CHANGE_TEXT.connects({ where: hostOf(o.url) });
  return CHANGE_TEXT.notSet;
}

/** A hook's handler (`{type, command}` or `{type, tool}`), in words. */
function handlerText(v: unknown): string | null {
  if (v === undefined || v === null) return CHANGE_TEXT.notSet;
  if (!isObject(v)) return null;
  const command = strings(v.command);
  if (command) return CHANGE_TEXT.program({ command: command.join(' ') });
  if (typeof v.tool === 'string') return CHANGE_TEXT.calls({ tool: v.tool });
  return null;
}

/** One part's value in words, or null when it cannot be worded. */
function valueText(key: string, v: unknown): string | null {
  if (v === undefined || v === null) {
    if (key === 'enabledTools') return CHANGE_TEXT.allTools;
    return CHANGE_TEXT.notSet;
  }
  if (key === 'defaultApproval' && typeof v === 'string')
    return messageFor(CHANGE_TEXT.serverApproval, v) ?? v;
  if (key === 'fs' && typeof v === 'string') return messageFor(CHANGE_TEXT.fileAccess, v) ?? v;
  if (key === 'handler') return handlerText(v);
  if (key === 'timeoutMs' && typeof v === 'number') return fmt.duration(v);
  if (key === 'enabledTools') return strings(v) ? listText(strings(v), CHANGE_TEXT.noTools) : null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? CHANGE_TEXT.yes : CHANGE_TEXT.no;
  const list = strings(v);
  return list ? listText(list) : null;
}

/** Whether a part's change lets the item do more without asking. */
function partSensitive(key: string, a: unknown, b: unknown): boolean {
  switch (key) {
    case 'runs':
    case 'handler':
      return true;
    case 'defaultApproval':
      return looser(APPROVAL_RANK, a, b, 1);
    case 'fs':
      return looser(FILE_RANK, a, b, 0);
    case 'enabledTools':
      return (a !== null && a !== undefined && (b === null || b === undefined)) || added(a, b);
    case 'disabledTools':
      return added(b, a);
    case 'failClosed':
      return a === true && b !== true;
    case 'network':
    case 'tools':
    case 'connectDomains':
    case 'resourceDomains':
    case 'frameDomains':
      return added(a, b);
    default:
      return false;
  }
}

/** The parts of two JSON details that differ, in words. */
function jsonFields(a: Json, b: Json, server: boolean): ChangeView {
  const fields: ChangeField[] = [];
  // Parts that cannot be worded (their values are never shown).
  const skipped: string[] = [];
  const part = (key: string, va: unknown, vb: unknown) => {
    if (same(va, vb)) return;
    const label = messageFor(CHANGE_TEXT.part, key);
    const before = valueText(key, va);
    const after = valueText(key, vb);
    if (!label || before === null || after === null) skipped.push(key);
    else fields.push({ label, before, after, sensitive: partSensitive(key, va, vb) });
  };
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (server) {
    // What runs (transport, command, args or address) is one part.
    if (['transport', 'command', 'args', 'url'].some((k) => !same(a[k], b[k])))
      fields.push({
        label: CHANGE_TEXT.part.runs,
        before: serverRuns(a),
        after: serverRuns(b),
        sensitive: true,
      });
    const policyShape = (v: unknown) => v === undefined || v === null || isObject(v);
    if (!policyShape(a.policy) || !policyShape(b.policy)) skipped.push('policy');
    const pa = isObject(a.policy) ? a.policy : {};
    const pb = isObject(b.policy) ? b.policy : {};
    for (const k of new Set([...Object.keys(pa), ...Object.keys(pb)])) part(k, pa[k], pb[k]);
    for (const k of ['transport', 'command', 'args', 'url', 'policy']) keys.delete(k);
  }
  for (const k of keys) part(k, a[k], b[k]);
  const unreadable = skipped.length > 0;
  return {
    plain: false,
    fields,
    unreadable,
    sensitive: unreadable || fields.some((f) => f.sensitive),
  };
}

/** The `access` of an extension's file scope: `r` or `rw`. */
const accessText = (v: string | null) =>
  v === 'rw' ? CHANGE_TEXT.readWrite : v === 'r' ? CHANGE_TEXT.read : (v ?? CHANGE_TEXT.notSet);

/**
 * A changed permission of an update in words. `kind` is the line's kind (from the new version's
 * lines); without it, the key's prefix is read.
 */
export function describeChange(c: Changed, kind?: string): ChangeView {
  const k = kind ?? c.key.replace(/^plugin\./, '').split(':')[0] ?? '';
  const fields = (list: ChangeField[]): ChangeView => ({
    plain: false,
    fields: list,
    unreadable: list.length === 0,
    sensitive: list.length === 0 || list.some((f) => f.sensitive),
  });
  if (looksStructured(c.before) || looksStructured(c.after)) {
    const a = parseObject(c.before);
    const b = parseObject(c.after);
    if (!a || !b) return fields([]);
    const view = jsonFields(a, b, k === 'mcp_server' || k === 'server');
    return view.fields.length || view.unreadable ? view : fields([]);
  }
  if (k === 'tool') {
    const split = (v: string | null) => {
      const [action, dflt] = (v ?? '').split(/\s*[,:]\s*/);
      return { action: action || null, dflt: dflt || null };
    };
    const a = split(c.before);
    const b = split(c.after);
    const out: ChangeField[] = [];
    if (a.action !== b.action)
      out.push({
        label: CHANGE_TEXT.part.action,
        before: a.action ?? CHANGE_TEXT.notSet,
        after: b.action ?? CHANGE_TEXT.notSet,
        // Anything beyond reading is a sharper tool.
        sensitive: b.action !== null && b.action !== 'read',
      });
    if (a.dflt !== b.dflt)
      out.push({
        label: CHANGE_TEXT.part.default,
        before: a.dflt ? actionApproval(a.dflt) : CHANGE_TEXT.notSet,
        after: b.dflt ? actionApproval(b.dflt) : CHANGE_TEXT.notSet,
        sensitive: looser(APPROVAL_RANK, a.dflt, b.dflt, 1),
      });
    return fields(out);
  }
  if (k === 'action_default' || k === 'action')
    return fields([
      {
        label: CHANGE_TEXT.part.default,
        before: c.before ? actionApproval(c.before) : CHANGE_TEXT.notSet,
        after: c.after ? actionApproval(c.after) : CHANGE_TEXT.notSet,
        sensitive: looser(APPROVAL_RANK, c.before, c.after, 1),
      },
    ]);
  if (k === 'fs' && /^(r|rw)?$/.test(c.before ?? '') && /^(r|rw)?$/.test(c.after ?? ''))
    return fields([
      {
        label: CHANGE_TEXT.part.access,
        before: accessText(c.before),
        after: accessText(c.after),
        sensitive: c.after === 'rw',
      },
    ]);
  return { plain: true, fields: [], unreadable: false, sensitive: false };
}

// ---- a change of publisher ---------------------------------------------------------------------

export const PUBLISHER_CHANGE_TEXT = defineMessages('market.publisherChange', {
  title: 'Another publisher',
  /** `who` is who signed it, in words ("Signed by Example Labs"). */
  from: 'The installed version: {who}.',
  to: 'This version: {who}.',
  unsigned: 'Not signed',
  clears:
    'Installing it treats it as a new extension: the secrets you stored for it and its data are deleted.',
  accept: 'I accept the new publisher; delete its stored secrets and data',
});

/** One side of a change of publisher, in words (a missing key is an unsigned bundle). */
export function publisherSideText(p: {
  key: string | null;
  name: string | null;
  fingerprint: string | null;
  trusted: boolean;
}): string {
  if (!p.key) return PUBLISHER_CHANGE_TEXT.unsigned;
  return marketPublisherText({ ...p, key: p.key });
}

// ---- refusals ---------------------------------------------------------------------------------

function reasonOf(err: ApiError): string | null {
  const r = err.body.details?.reason;
  return typeof r === 'string' ? r : null;
}

const ERROR_TEXT = defineMessages('market.errors', {
  fallback: 'Something went wrong.',
  ownerOnly: 'Only the owner of this Hub can use the marketplace.',
  /** `message` is the Hub's own words. */
  managed: 'Managed by your organization: {message}',
  catalogSignatureInvalid:
    'This catalog was refused: its index does not match its signature. Nothing from it can be installed.',
  bundleInvalid:
    'This item was refused: its files do not match its signature, so it may have been changed after it was signed. It cannot be installed, even unverified.',
  sideloadRequired:
    'This item is not verified. Tick that you trust its source to install it unverified.',
  publisherChangeRequired:
    'This version comes from another publisher than the installed one. Tick that you accept the new publisher to install it.',
  permissionsNotAccepted:
    'This update changes what the item can do. Tick that you accept the permission changes to update it.',
  /** The Hub has no installer for a kind of item yet. */
  cannotInstall:
    '{kind, select, plugin {This Hub cannot install plugins yet.} skill {This Hub cannot install skills yet.} theme {This Hub cannot install themes yet.} pet {This Hub cannot install pets yet.} mcp {This Hub cannot install MCP servers yet.} other {This Hub cannot install this kind of item yet.}}',
  nameTaken: 'An MCP server with this name already exists. Remove or rename it first.',
  requestExpired: 'This preview expired. Open the item again.',
  conflict: 'What is installed changed since the preview. Open the item again.',
  notFound: 'That is no longer there. It may have been removed from its catalog or uninstalled.',
  /** `message` is the Hub's own words. */
  policyDenied: 'Refused by policy: {message}',
  /** `message` is the Hub's own words. */
  validation: 'This was refused: {message}.',
});

/** A refusal of the marketplace in plain words (docs/04 §7). */
export function marketErrorMessage(err: unknown, fallback: string = ERROR_TEXT.fallback): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const d = err.body.details ?? {};
  const message = err.body.message;
  switch (reasonOf(err) ?? err.body.code) {
    case 'owner_only':
      return ERROR_TEXT.ownerOnly;
    case 'managed':
      return ERROR_TEXT.managed({ message });
    case 'sideload_disabled':
      return BLOCKED_TEXT.sideload_disabled;
    case 'kind_not_allowed':
      return BLOCKED_TEXT.kind_not_allowed;
    case 'catalog_signature_invalid':
      return ERROR_TEXT.catalogSignatureInvalid;
    case 'bundle_invalid':
      return ERROR_TEXT.bundleInvalid;
    case 'sideload_confirmation_required':
      return ERROR_TEXT.sideloadRequired;
    case 'publisher_change_confirmation_required':
      return ERROR_TEXT.publisherChangeRequired;
    case 'permission_diff_not_accepted':
      return ERROR_TEXT.permissionsNotAccepted;
    case 'installer_missing':
    case 'capability_missing':
      return ERROR_TEXT.cannotInstall({ kind: typeof d.kind === 'string' ? d.kind : 'other' });
    case 'name_taken':
      return ERROR_TEXT.nameTaken;
    case 'request_expired':
      return ERROR_TEXT.requestExpired;
    case 'conflict':
      return ERROR_TEXT.conflict;
    case 'not_found':
      return ERROR_TEXT.notFound;
    case 'policy_denied':
      return ERROR_TEXT.policyDenied({ message });
    case 'validation':
      return message ? ERROR_TEXT.validation({ message }) : fallback;
    default:
      return errorMessage(err, fallback);
  }
}
