// The companion's mood (FR-012), as a pure state machine. It follows thread status (any thread
// running: thinking; else any waiting for the user: waiting; else idle) and shows a short success
// or error reaction when a run or turn ends. Time comes in with each event, so tests need no clock.
import type { EventEnvelope } from '@nova/shared';

export type PetState = 'idle' | 'thinking' | 'waiting' | 'success' | 'error';

/** How long a success or error reaction lasts before the pet goes back to what it was doing. */
export const REACTION_MS = 2400;

type ThreadStatus = 'running' | 'needs_input' | 'ready' | 'blocked';

export interface PetModel {
  /** The last known status of each busy thread or run (ready and blocked ones are dropped). */
  busy: Readonly<Record<string, 'running' | 'needs_input'>>;
  reaction: { kind: 'success' | 'error'; until: number } | null;
}

export type PetEvent =
  | { type: 'status'; ref: string; status: ThreadStatus; at: number }
  | { type: 'outcome'; ok: boolean; at: number }
  /** Time passed: a reaction that is over ends. */
  | { type: 'tick'; at: number };

export const initialPet: PetModel = { busy: {}, reaction: null };

export function petReducer(m: PetModel, ev: PetEvent): PetModel {
  // Any event at or after the reaction's end clears it.
  const reaction = m.reaction && ev.at < m.reaction.until ? m.reaction : null;
  switch (ev.type) {
    case 'status': {
      const busy = { ...m.busy };
      if (ev.status === 'running' || ev.status === 'needs_input') busy[ev.ref] = ev.status;
      else delete busy[ev.ref];
      return { busy, reaction };
    }
    case 'outcome':
      return {
        busy: m.busy,
        reaction: { kind: ev.ok ? 'success' : 'error', until: ev.at + REACTION_MS },
      };
    case 'tick':
      return reaction === m.reaction ? m : { busy: m.busy, reaction };
  }
}

/** What the pet shows. Muted (Keep still) always rests. */
export function petState(m: PetModel, muted: boolean): PetState {
  if (muted) return 'idle';
  if (m.reaction) return m.reaction.kind;
  const all = Object.values(m.busy);
  if (all.includes('running')) return 'thinking';
  if (all.includes('needs_input')) return 'waiting';
  return 'idle';
}

const THREAD_STATUSES = new Set(['running', 'needs_input', 'ready', 'blocked']);

/**
 * The pet event an envelope means, if any: `thread.status.changed` {ref, status},
 * `run.completed` {status} (done is a success; failed and output_missing are errors; cancelled
 * is neither) and `turn.completed` {status: completed|failed} (only a failure reacts).
 */
export function petEventOf(env: EventEnvelope, at: number): PetEvent | null {
  const p = env.payload;
  switch (env.name) {
    case 'thread.status.changed': {
      const ref = p.ref as { kind?: unknown; id?: unknown } | undefined;
      const id = typeof ref?.id === 'string' ? `${String(ref.kind)}:${ref.id}` : null;
      const status = typeof p.status === 'string' ? p.status : '';
      if (!id || !THREAD_STATUSES.has(status)) return null;
      return { type: 'status', ref: id, status: status as ThreadStatus, at };
    }
    case 'run.completed':
      if (p.status === 'done') return { type: 'outcome', ok: true, at };
      if (p.status === 'failed' || p.status === 'output_missing')
        return { type: 'outcome', ok: false, at };
      return null;
    case 'turn.completed':
      return p.status === 'failed' ? { type: 'outcome', ok: false, at } : null;
    default:
      return null;
  }
}
