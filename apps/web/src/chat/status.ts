// Thread status chip (docs/04 §1.1, FR-215): one of four states derived from runtime state, never
// from model text. The Hub's derived status (which counts child threads and blocked reasons) wins
// when it is there, and `thread.status.changed` keeps it current; without it the thread's own state
// decides. Lists sort Needs input first, then Blocked, Running and Ready, keeping their order within
// a status.
import type { ThreadView } from '@nova/shared';
import type { Status } from '@nova/ui';

const RANK: Record<Status, number> = { needs_input: 0, blocked: 1, running: 2, ready: 3 };

function fromState(state: ThreadView['state']): Status {
  if (state === 'waiting_approval' || state === 'waiting_input') return 'needs_input';
  if (state === 'error') return 'blocked';
  if (state === 'streaming') return 'running';
  return 'ready';
}

export function threadStatus(
  thread: Pick<ThreadView, 'state' | 'derived'>,
  streamingHere = false,
): Status {
  const own = thread.derived?.status ?? fromState(thread.state);
  // The open chat knows it streams before the Hub says so; Running never hides a higher status.
  return streamingHere && own === 'ready' ? 'running' : own;
}

/** The reason behind a Needs input or Blocked chip ("Budget reached"), when the Hub gave one. */
export function threadStatusReason(thread: Pick<ThreadView, 'derived'>): string | undefined {
  return thread.derived?.reason ?? undefined;
}

/** A stable sort by status precedence (docs/04 §1.1); the list's own order breaks ties. */
export function sortByThreadStatus<T extends Pick<ThreadView, 'id' | 'state' | 'derived'>>(
  list: readonly T[],
  streamingId: string | null = null,
): T[] {
  return list
    .map((t, i) => ({ t, i, r: RANK[threadStatus(t, t.id === streamingId)] }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.t);
}
