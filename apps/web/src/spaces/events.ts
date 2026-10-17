// How the Spaces and Sites views stay current (FR-036, FR-037): `space.*` and `site.*` events on
// the global stream (contracts/hub-api.md §5). Each view follows them while it is mounted.
import type { EventEnvelope } from '@nova/shared';
import { useHubStream } from '../hub-events.ts';

export const SPACES_EVENTS = [
  'space.created',
  'space.updated',
  'space.deleted',
  'space.page.created',
  'space.page.updated',
  'space.page.deleted',
  'space.comment.created',
  'space.comment.updated',
  'space.comment.deleted',
  'space.proposal.created',
  'space.proposal.decided',
] as const;

export const SITES_EVENTS = [
  'site.created',
  'site.updated',
  'site.deleted',
  'site.version.created',
  'site.published',
  'site.unpublished',
] as const;

/** Follows the named events on the app's shared stream while mounted (src/hub-events.ts). */
export function useHubEvents(
  names: readonly string[],
  onEvent: (env: EventEnvelope) => void,
): void {
  useHubStream(names, onEvent);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The ids a space or site event is about. */
export function eventIds(env: EventEnvelope): {
  spaceId: string | null;
  pageId: string | null;
  siteId: string | null;
  version: number | null;
  authorKind: string | null;
} {
  const p = env.payload;
  return {
    spaceId: str(p.spaceId),
    pageId: str(p.pageId),
    siteId: str(p.siteId),
    version: typeof p.version === 'number' ? p.version : null,
    authorKind: str(p.authorKind),
  };
}
