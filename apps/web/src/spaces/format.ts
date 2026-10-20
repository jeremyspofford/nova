// Paths, words and error shapes shared by the Spaces and Sites views (FR-036, FR-037). The words
// are messages (FR-016): read them at render time so they follow the active locale.
import { defineMessages, messageFor } from '@nova/i18n';
import type {
  PageAuthorKind,
  PageView,
  SiteRemoteRef,
  SiteTarget,
  SpaceAgentEdits,
} from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';

const enc = encodeURIComponent;

export function spacePath(spaceId?: string | null, pageId?: string | null): string {
  if (!spaceId) return '/spaces';
  return pageId ? `/spaces/${enc(spaceId)}/${enc(pageId)}` : `/spaces/${enc(spaceId)}`;
}

export function sitePath(siteId?: string | null): string {
  return siteId ? `/sites/${enc(siteId)}` : '/sites';
}

/** Words the Spaces and Sites views share. */
export const SPACES_TEXT = defineMessages('spaces', {
  retry: 'Retry',
  cancel: 'Cancel',
  save: 'Save',
  delete: 'Delete',
  close: 'Close',
  loading: 'Loading…',
  /** Who made a version or an edit. */
  author: { agent: 'Agent', user: 'You' },
  /**
   * Where a publish went, after "published": the folder on the Hub, a zip, or a hosting target
   * ({name}) and its folder. A target that was removed says so.
   */
  where:
    '{where, select, folder {to the folder “{folder}”} zip {as a zip download} remote {to “{name}”, folder “{folder}”} other {to a removed hosting target, folder “{folder}”}}',
});

export const AGENT_EDITS_TEXT = defineMessages('spaces.agentEdits', {
  propose: {
    label: 'Propose changes for my review',
    description: 'An agent’s edit waits as a proposal until you accept or reject it.',
    short: 'Agent edits wait for your review',
  },
  direct: {
    label: 'Edit directly',
    description: 'Every edit is a version you can restore.',
    short: 'Agents edit directly',
  },
}) satisfies Record<SpaceAgentEdits, { label: string; description: string }>;

/** How agent edits land, as a short phrase for lists. */
export function agentEditsShort(mode: SpaceAgentEdits): string {
  return AGENT_EDITS_TEXT[mode].short;
}

export function authorText(kind: PageAuthorKind | 'agent'): string {
  return kind === 'agent' ? SPACES_TEXT.author.agent : SPACES_TEXT.author.user;
}

/** The page of the owner's hosting targets (`/sites/targets`, M8). */
export const TARGETS_PATH = '/sites/targets';

/**
 * Where a publish went, as the arguments of messages that say it (`select` on `where`): the
 * folder on the Hub, a zip, a hosting target with its name and folder, or a removed one.
 */
export function targetArgs(
  t: SiteTarget,
  remote?: SiteRemoteRef | null,
): { where: 'folder' | 'zip' | 'remote' | 'removed'; folder: string; name: string } {
  if (t.kind === 'folder') return { where: 'folder', folder: t.folder, name: '' };
  if (t.kind === 'zip') return { where: 'zip', folder: '', name: '' };
  return remote?.name
    ? { where: 'remote', folder: t.folder, name: remote.name }
    : { where: 'removed', folder: t.folder, name: '' };
}

/**
 * Where a publish went: "to the folder “docs”", "as a zip download", or (M8) "to “NAS”, folder
 * “docs”" for a hosting target (one whose target was removed says so).
 */
export function targetText(t: SiteTarget, remote?: SiteRemoteRef | null): string {
  return SPACES_TEXT.where(targetArgs(t, remote));
}

/** The reason code of any refusal the Hub answers (`details.reason`). */
export function reasonOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const r = err.body.details?.reason;
  return typeof r === 'string' ? r : null;
}

/** Plain words for the Hub's refusals around page order, sources, publishing and targets (M8). */
export const REASON_TEXT = defineMessages('spaces.reasons', {
  order_stale: 'The pages changed meanwhile. This is the order now.',
  folder_in_use:
    'That folder holds files Nova did not put there, or another site is published in it. Choose another name.',
  egress_denied: 'Your network policy does not let Nova reach this hosting target.',
  remote_targets_off: 'Publishing to hosting targets is turned off.',
  target_missing: 'That hosting target was removed.',
  target_unreachable:
    'The hosting target could not be reached. Check its address and that it is running.',
  target_timeout: 'The hosting target did not answer in time. Try again later.',
  target_auth_failed:
    'The hosting target refused the sign-in. Check the user name, password or token.',
  target_not_found: 'There is no WebDAV folder at that address.',
  target_refused: 'The hosting target refused the request.',
  target_redirected:
    'The hosting target answered with a redirect. Enter the address it sends you to instead.',
  target_in_use: 'Sites are published on this target. Unpublish them first.',
  https_required: 'Use an https address. Plain http works only for this machine.',
  credentials_in_url: 'Enter the user name and password as the sign-in, not in the address.',
  url_invalid: 'Enter a web address, for example https://dav.example.com/sites/.',
  source_missing: 'That source is gone. Choose another.',
  source_kind: 'A site can be built from an HTML or Markdown artifact only.',
  data_missing: 'A connected data source is gone. Remove it from the site first.',
  data_format: 'A connected data source is not JSON or CSV.',
  not_published: 'This site is not published.',
});

/** The words for a refusal reason the Hub names, or undefined for one without words here. */
export function reasonText(reason: string): string | undefined {
  return messageFor(REASON_TEXT, reason);
}

/** The words for a refusal: its reason's text, else the Hub's message, else `fallback`. */
export function refusalText(err: unknown, fallback: string): string {
  const r = reasonOf(err);
  return (r && reasonText(r)) || errorMessage(err, fallback);
}

/** The reason of a 409 `conflict` answer, when the error is one. */
export function conflictReason(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const r = err.body.details?.reason;
  return typeof r === 'string' ? r : 'conflict';
}

/** The page a stale save, restore or proposal answer carries. */
export function conflictPage(err: unknown): PageView | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const cur = err.body.details?.current as Partial<PageView> | undefined;
  return cur && typeof cur.version === 'number' && typeof cur.content === 'string'
    ? (cur as PageView)
    : null;
}

/** Folder names and data names, as the Hub checks them. */
export const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const DATA_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** A folder or data name made from free text. */
export function slugName(s: string, max = 40, sep = '-'): string {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, sep)
    .replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '')
    .slice(0, max);
}
