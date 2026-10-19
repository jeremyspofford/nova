// Words for the offline layer (docs/04 §6, §7): what a waiting change's status is, why the Hub
// refused one, and how long ago something happened. Short, plain and specific.
import type { IconName } from '@nova/ui';
import type { QueueItem, QueueStatus } from './queue.ts';

export interface StatusSpec {
  text: string;
  tone: 'ready' | 'running' | 'needs_input' | 'blocked' | 'neutral';
  icon: IconName | null;
}

export const QUEUE_STATUS: Record<QueueStatus, StatusSpec> = {
  queued: { text: 'Waiting to send', tone: 'neutral', icon: 'clock' },
  sending: { text: 'Sending', tone: 'running', icon: null },
  failed: { text: 'Not sent', tone: 'blocked', icon: 'alert' },
  done: { text: 'Sent', tone: 'ready', icon: 'check' },
};

/** Why the Hub refused a change (SyncOpResult reasons, apps/hub/src/sync.ts). */
const REJECTED: Record<string, string> = {
  deleted: 'It was deleted on the Hub.',
  not_found: 'It no longer exists on the Hub.',
  append_only: 'A different message with the same id is already on the Hub.',
  read_only_field: 'The Hub does not let devices change that.',
  unknown_field: 'The Hub does not know that field.',
  invalid_value: 'The Hub refused the value.',
  not_deletable: 'The Hub does not let devices delete that.',
  not_syncable: 'That setting stays on the Hub.',
  clock_skew: "This device's clock is ahead of the Hub's. Correct the clock, then retry.",
  hlc_device_mismatch: 'The change was clocked for another device. Retry to send it again.',
  invalid_id: 'The Hub refused the new id.',
  not_supported: 'The Hub cannot take this change from a device.',
  apply_failed: 'The Hub could not apply it. Retry later.',
  stale_version: 'The page changed on the Hub first.',
  local_runtime_not_granted:
    "The Hub has not given this device Local models, so it does not take answers from this computer's model. Copy the answer or discard it.",
};

/** A sentence for a refused change. */
export function rejectionText(item: Pick<QueueItem, 'kind'>, reason: string): string {
  if (item.kind === 'answer' && reason === 'invalid_value')
    return 'The Hub refused the answer: the message it answers is not in that chat any more.';
  return REJECTED[reason] ?? `The Hub refused it (${reason.replace(/_/g, ' ')}).`;
}

/** What became of asking the Hub to answer a message written offline. */
export const ANSWER_NOTE: Record<string, string> = {
  requested: 'Sent. The Hub is answering it now.',
  answered: 'Sent. It already has a reply in the chat.',
  not_last: 'Sent. Newer messages follow it in the chat, so it was not answered on its own.',
  turn_in_progress:
    'Sent. A reply was already running in that chat, so it was not answered; ask again there.',
  shared_thread:
    'Sent. In a shared chat a message written offline is not answered for you; ask again there.',
  not_user_message: 'Sent. The Hub could not answer it.',
  failed: 'Sent, but the Hub could not be asked to answer it. Ask again in the chat.',
};

/** "in 8 s", "in 2 min". */
export function inText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

/** "1 change", "3 changes". */
export function changesText(n: number): string {
  return `${n} ${n === 1 ? 'change' : 'changes'}`;
}

/** Bytes for people: "512 B", "3.4 KB", "1.2 MB". */
export function bytesText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}
