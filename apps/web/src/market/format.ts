// Words and pure helpers for the marketplace (FR-049, FR-012; docs/14 §5, docs/08 §7, docs/26 §3):
// the tabs and kinds, catalog and item verdicts, why an item is Unverified, why policy refuses an
// install, every refusal of the marketplace in plain words (never a raw code), and catalog
// locations. User-facing text lives here so it can be extracted for translation.
import type {
  MarketCatalogKind,
  MarketCatalogSignature,
  MarketItemKind,
  MarketPermissionLine,
  MarketPreview,
  MarketUnverifiedReason,
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

export const TAB_LABEL: Record<MarketTab, string> = {
  plugins: 'Plugins',
  skills: 'Skills',
  themes: 'Themes',
  pets: 'Pets',
  mcp: 'MCP servers',
  installed: 'Installed',
  catalogs: 'Catalogs',
};

export const KIND_TEXT: Record<MarketItemKind, { one: string; many: string; title: string }> = {
  plugin: { one: 'plugin', many: 'plugins', title: 'Plugins' },
  skill: { one: 'skill', many: 'skills', title: 'Skills' },
  theme: { one: 'theme', many: 'themes', title: 'Themes' },
  pet: { one: 'pet', many: 'pets', title: 'Pets' },
  mcp: { one: 'MCP server', many: 'MCP servers', title: 'MCP servers' },
};

export const MARKET_TEXT = {
  title: 'Marketplace',
  intro:
    'Plugins, skills, themes, pets and MCP servers from your catalogs. Each item shows what it can do before anything is installed, and an update shows what changes.',
  search: 'Search the marketplace',
  searchPlaceholder: 'Search by name or description',
  tabs: 'Marketplace sections',
  loading: 'Loading the marketplace',
  loadFailed: 'Could not load the marketplace.',
  retry: 'Try again',
  empty: (kind: string) => `No ${kind} in your catalogs yet.`,
  noMatch: (q: string) => `Nothing matches “${q}”.`,
  by: (author: string) => `By ${author}`,
  version: (v: string) => `Version ${v}`,
  installedVersion: (v: string) => `Installed: ${v}`,
  updateTo: (v: string) => `Update to ${v}`,
  install: 'Install',
  remove: 'Remove…',
  details: 'Details',
  detailsOf: (name: string) => `Details of ${name}`,
  installOf: (name: string) => `Install ${name}`,
  updateOf: (name: string) => `Update ${name}`,
  removeOf: (name: string) => `Remove ${name}`,
  canAccess: 'It can',
  noPermissions: 'It asks for no permissions.',
  screenshots: 'Screenshots',
  screenshot: (n: number, name: string) => `Screenshot ${n} of ${name}`,
  changelog: 'Changelog',
  noChangelog: 'No changelog.',
  brings: 'What it brings',
  hooks: 'Hooks',
  roles: 'Sub-agent roles',
  browserExtensions: 'Browser extensions',
  entryPoints: 'App screens',
  homepage: 'Homepage',
  catalog: 'Catalog',
  versions: 'Versions',
  close: 'Close',
  rating: 'Your rating',
  ratingHint: 'Ratings stay on this Hub. Nothing is sent anywhere.',
  stars: (n: number) => `${n} ${n === 1 ? 'star' : 'stars'}`,
  rate: 'Save rating',
  review: 'Notes (optional)',
  clearRating: 'Clear rating',
  rated: 'Rating saved.',
  rateFailed: 'Could not save the rating.',
  ratingCleared: 'Rating cleared.',
  unrated: 'Not rated',
  removeTitle: (name: string) => `Remove ${name}?`,
  removeBody: (kind: MarketItemKind) => REMOVE_BODY[kind],
  removeConfirm: 'Remove',
  removeFailed: 'Could not remove it.',
  cancel: 'Cancel',
  removed: (name: string) => `${name} removed.`,
  installedToast: (name: string) => `${name} installed.`,
  updatedToast: (name: string) => `${name} updated.`,
  installedTab: 'Installed from the marketplace',
  noneInstalled: 'Nothing is installed from the marketplace yet.',
  from: (origin: string) => `From ${origin}`,
  kindOff: (kinds: string) => `Installing ${kinds} is turned off.`,
  petsHint: 'Choose an installed pet in Settings → Appearance.',
  themesHint: 'An installed theme is kept in Settings → Appearance → Your themes; use it there.',
} as const;

const REMOVE_BODY: Record<MarketItemKind, string> = {
  plugin:
    'Its skills, servers, hooks and app screens are removed. Data it keeps stays unless you remove it in Settings.',
  skill: 'The skill is removed from your skills.',
  theme: 'The theme is removed from your themes. The look you use now does not change.',
  pet: 'The pet is removed. If it is your companion, the companion turns off.',
  mcp: 'The MCP server is removed, with the settings and secrets it stored.',
};

export const INSTALL_TEXT = {
  install: (name: string, version: string) => `Install ${name} ${version}?`,
  update: (name: string, version: string) => `Update ${name} to ${version}?`,
  replaces: (v: string) => `Replaces version ${v}.`,
  verifiedBy: (who: string) => `Signed by ${who}.`,
  unverifiedTitle: 'This item is not verified',
  unverifiedBody:
    'It stays labelled Unverified for as long as it is installed. Install it only if you trust where it came from.',
  sideload: 'I trust its source; install it unverified',
  diff: 'Permission changes',
  diffAdded: 'New',
  diffRemoved: 'No longer',
  diffChanged: 'Changed',
  diffChangedLine: (text: string, before: string | null, after: string | null) =>
    `${text}: ${before ?? 'none'} → ${after ?? 'none'}`,
  diffNone: 'Permissions are unchanged.',
  diffOnlyRemoved: 'This update only removes permissions.',
  acceptDiff: 'I accept these permission changes',
  can: 'It can',
  enforced:
    'Nova enforces these limits; nothing it installs goes beyond them, and built-in safety still applies.',
  hooks: 'Hooks to trust',
  hooksHint:
    'A hook never runs until you trust it by its hash. Hooks you leave unticked stay off; you can trust them later.',
  trustNow: (id: string) => `Trust ${id} now`,
  skills: 'Skills',
  servers: 'MCP servers it adds',
  roles: 'Sub-agent roles',
  entryPoints: 'App screens',
  theme: 'Colors',
  petStates: 'States',
  serverAt: (transport: string, url: string) => `${transport} server at ${url}`,
  settingsForm: 'Settings for this server',
  turnOn: 'Turn it on after installing',
  installButton: 'Install',
  updateButton: 'Update',
  cancel: 'Cancel',
  warnings: 'Warnings',
  checking: 'Checking the item…',
  checkingTitle: (name: string) => `Install ${name}`,
  previewFailed: 'Could not check the item.',
  failed: 'Could not install the item.',
  retry: 'Try again',
  blocked: 'This cannot be installed',
  why: 'Why it is Unverified',
  none: 'It asks for no permissions.',
  hookEvent: 'Event',
  hookRow: (id: string) => `Hook ${id}`,
  matches: '· matches',
  hookRuns: 'Runs',
  hookHash: 'Hash',
  skillTools: 'Tools it may use',
} as const;

export const BLOCKED_TEXT: Record<NonNullable<MarketPreview['blockedBy']>, string> = {
  managed: 'Your organization does not allow installing this.',
  sideload_disabled:
    'Installing unverified items is turned off. You can turn it on under Catalogs → Install rules.',
  kind_not_allowed: 'Installing this kind of item is turned off under Catalogs → Install rules.',
};

export const UNVERIFIED_TEXT: Record<MarketUnverifiedReason, string> = {
  catalog_unsigned: 'Its catalog is not signed.',
  catalog_untrusted: 'Its catalog is signed by a key you do not trust.',
  no_checksum: 'Its catalog lists no checksum for it, so its files cannot be checked.',
  checksum_mismatch: 'Its files do not match the checksum its catalog lists.',
  bundle_unsigned: 'Its bundle is not signed.',
  bundle_untrusted: 'Its bundle is signed by a key you do not trust.',
};

export const CATALOG_SIGNATURE_TEXT: Record<
  MarketCatalogSignature,
  { text: string; tone: string | null; icon: IconName }
> = {
  verified: { text: 'Signed by a key you trust', tone: 'ready', icon: 'shield' },
  untrusted: { text: 'Signed by a key you do not trust', tone: 'needs_input', icon: 'alert' },
  unsigned: { text: 'Not signed', tone: 'needs_input', icon: 'alert' },
  invalid: { text: 'Refused: its signature does not match', tone: 'blocked', icon: 'stop' },
};

export const CATALOG_KIND_TEXT: Record<MarketCatalogKind, string> = {
  builtin: 'Built in',
  local: 'Folder on the Hub',
  git: 'Git repository',
  url: 'Web address',
};

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

export const CATALOG_TEXT = {
  title: 'Catalogs',
  intro:
    'Where the marketplace finds items. Every catalog’s index must be signed; an index whose signature does not match is refused.',
  builtinNote: 'The sample catalog ships with Nova and works offline.',
  items: (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`,
  readAt: (c: string) => `Read at commit ${c.slice(0, 12)}`,
  unreadable: (why: string) => `Could not be read: ${why}`,
  remove: (name: string) => `Remove ${name}`,
  removeButton: 'Remove',
  removed: (name: string) => `${name} removed.`,
  added: (name: string) => `${name} added.`,
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
  errFull: 'You can have up to 20 catalogs. Remove one first.',
  yours: 'Your catalogs',
  none: 'You have not added a catalog.',
  publishers: 'Trusted publishers',
  publishersIntro:
    'Extensions and plugins signed by these keys install as Verified. Anything else needs the sideload confirmation and stays Unverified.',
  noPublishers: 'You trust no publishers yet.',
  publisherName: 'Publisher name',
  publisherKey: 'Publisher key',
  addPublisher: 'Trust this publisher',
  publisherAdded: (name: string) => `${name} is now trusted.`,
  publisherRemoved: (name: string) => `${name} is no longer trusted.`,
  removePublisher: (name: string) => `Stop trusting ${name}`,
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
  signedWith: (name: string | null, key: string) =>
    name ? `Signed by ${name} (${key})` : `Signed with the key ${key}`,
  addPublisherSummary: 'Trust a publisher',
  publisherKeyHint:
    'Their Ed25519 public key, base64url, 43 characters. Get it from the publisher.',
  trustTitle: (name: string) => `Trust ${name}?`,
  trustBody:
    'Extensions, plugins and catalogs signed by this key then install as Verified, without the sideload confirmation. Check the key with the publisher first.',
  trustConfirm: 'Trust this publisher',
  untrustTitle: (name: string) => `Stop trusting ${name}?`,
  untrustBody:
    'What they signed stays installed but shows as Unverified, and new items from them need the sideload confirmation.',
  cancel: 'Cancel',
} as const;

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

// ---- refusals ---------------------------------------------------------------------------------

function reasonOf(err: ApiError): string | null {
  const r = err.body.details?.reason;
  return typeof r === 'string' ? r : null;
}

/** A refusal of the marketplace in plain words (docs/04 §7). */
export function marketErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (!(err instanceof ApiError)) return errorMessage(err, fallback);
  const d = err.body.details ?? {};
  switch (reasonOf(err) ?? err.body.code) {
    case 'owner_only':
      return 'Only the owner of this Hub can use the marketplace.';
    case 'managed':
      return `Managed by your organization: ${err.body.message}`;
    case 'sideload_disabled':
      return BLOCKED_TEXT.sideload_disabled;
    case 'kind_not_allowed':
      return BLOCKED_TEXT.kind_not_allowed;
    case 'catalog_signature_invalid':
      return 'This catalog was refused: its index does not match its signature. Nothing from it can be installed.';
    case 'bundle_invalid':
      return 'This item was refused: its files do not match its signature, so it may have been changed after it was signed. It cannot be installed, even unverified.';
    case 'sideload_confirmation_required':
      return 'This item is not verified. Tick that you trust its source to install it unverified.';
    case 'permission_diff_not_accepted':
      return 'This update changes what the item can do. Tick that you accept the permission changes to update it.';
    case 'installer_missing':
    case 'capability_missing': {
      const kind = typeof d.kind === 'string' && d.kind in KIND_TEXT ? d.kind : null;
      return kind
        ? `This Hub cannot install ${KIND_TEXT[kind as MarketItemKind].many} yet.`
        : 'This Hub cannot install this kind of item yet.';
    }
    case 'name_taken':
      return 'An MCP server with this name already exists. Remove or rename it first.';
    case 'request_expired':
      return 'This preview expired. Open the item again.';
    case 'conflict':
      return 'What is installed changed since the preview. Open the item again.';
    case 'not_found':
      return 'That is no longer there. It may have been removed from its catalog or uninstalled.';
    case 'policy_denied':
      return `Refused by policy: ${err.body.message}`;
    case 'validation':
      return err.body.message ? `This was refused: ${err.body.message}.` : fallback;
    default:
      return errorMessage(err, fallback);
  }
}
