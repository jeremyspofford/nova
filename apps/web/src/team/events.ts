// How the team views stay current (FR-217, FR-091; decision 5): the team's events on the app's
// one shared stream (src/hub-events.ts). Each view follows the events it shows while it is mounted
// and refetches. A shared thread's own conversation comes from its per-thread stream
// (`/api/v1/team/threads/:id/stream`), like a chat's: other people's turns run under their own
// accounts, so the global stream does not carry them.
import type { EventEnvelope } from '@nova/shared';
import { useHubStream } from '../hub-events.ts';

/** People join and leave; the owner's invitations are made, used and withdrawn. */
export const MEMBERS_EVENTS = [
  'team.invitation.created',
  'team.invitation.revoked',
  'team.member.joined',
  'team.member.removed',
] as const;

/** Someone shared a chat with you, took you out of one, or left one of yours. */
export const SHARED_LIST_EVENTS = ['thread.shared', 'team.member.removed'] as const;

/** A task you asked for started, finished, failed or was cancelled; an agent changed. */
export const TEAM_AGENT_EVENTS = ['team.task.updated', 'agent.updated'] as const;

/** A setting changed (the owner's Hub switch for public cards). */
export const CARD_EVENTS = ['settings.changed'] as const;

/** Events of a shared thread's own stream (the conversation, participants, status). */
export const SHARED_THREAD_EVENTS = [
  'turn.started',
  'turn.completed',
  'turn.interrupted',
  'chat.message.created',
  'chat.delta',
  'chat.message.completed',
  'chat.message.updated',
  'chat.message.deleted',
  'thread.status.changed',
  'thread.shared',
  'approval.requested',
  'approval.decided',
] as const;

/**
 * Follows the named events while mounted; `onOpen` runs when the stream (re)connects, so a view
 * fetches again whatever happened while it was closed.
 */
export function useTeamEvents(
  names: readonly string[],
  onEvent: (env: EventEnvelope) => void,
  onOpen?: () => void,
): void {
  useHubStream(names, onEvent, onOpen);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The thread a `thread.shared` event is about. */
export function eventThreadId(env: EventEnvelope): string | null {
  return str(env.payload.threadId) ?? env.correlation?.threadId ?? null;
}

/** The participants a `thread.shared` event names (after the change). */
export function eventParticipants(env: EventEnvelope): string[] {
  const p = env.payload.participants;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}

/** The task a `team.task.updated` event is about. */
export function eventTaskId(env: EventEnvelope): string | null {
  return str(env.payload.taskId);
}
