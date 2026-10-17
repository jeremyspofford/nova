// How the Spaces and Sites views stay current (FR-036, FR-037): `space.*` and `site.*` events on
// the global stream (contracts/hub-api.md §5). Each view follows them while it is mounted.
import { useEffect, useRef } from 'react';
import type { EventEnvelope } from '@nova/shared';
import { EVENTS_STREAM_URL } from '../notifications/Bell.tsx';
import { useServices } from '../services.tsx';
import { openStream } from '../sse.ts';

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

/** Follows the named events on the global stream while mounted. */
export function useHubEvents(
  names: readonly string[],
  onEvent: (env: EventEnvelope) => void,
): void {
  const { eventSource } = useServices();
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  const key = names.join(',');
  useEffect(() => {
    const handle = openStream(
      EVENTS_STREAM_URL,
      { onEvent: (env) => handler.current(env) },
      { names: key.split(','), factory: eventSource },
    );
    return () => handle.close();
  }, [key, eventSource]);
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
