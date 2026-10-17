// Paths, words and error shapes shared by the Spaces and Sites views (FR-036, FR-037).
import type { PageAuthorKind, PageView, SiteTarget, SpaceAgentEdits } from '@nova/shared';
import { ApiError } from '../api.ts';

const enc = encodeURIComponent;

export function spacePath(spaceId?: string | null, pageId?: string | null): string {
  if (!spaceId) return '/spaces';
  return pageId ? `/spaces/${enc(spaceId)}/${enc(pageId)}` : `/spaces/${enc(spaceId)}`;
}

export function sitePath(siteId?: string | null): string {
  return siteId ? `/sites/${enc(siteId)}` : '/sites';
}

export const AGENT_EDITS_TEXT: Record<SpaceAgentEdits, { label: string; description: string }> = {
  propose: {
    label: 'Propose changes for my review',
    description: 'An agent’s edit waits as a proposal until you accept or reject it.',
  },
  direct: {
    label: 'Edit directly',
    description: 'Every edit is a version you can restore.',
  },
};

/** How agent edits land, as a short phrase for lists. */
export function agentEditsShort(mode: SpaceAgentEdits): string {
  return mode === 'propose' ? 'Agent edits wait for your review' : 'Agents edit directly';
}

export function authorText(kind: PageAuthorKind | 'agent'): string {
  return kind === 'agent' ? 'Agent' : 'You';
}

/** Where a publish went: "to the folder “docs”" or "as a zip download". */
export function targetText(t: SiteTarget): string {
  return t.kind === 'folder' ? `to the folder “${t.folder}”` : 'as a zip download';
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
