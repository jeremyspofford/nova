// Words for the offline layer (docs/04 §6, §7, FR-016): what a waiting change is and what its
// status is, why the Hub refused one, what became of it once sent, and when it is tried again.
// Short, plain and specific; a change keeps codes and names, worded when shown.
import { defineMessages, messageFor } from '@nova/i18n';
import type { IconName } from '@nova/ui';
import type { QueueItem, QueueStatus, QueueSubject } from './queue.ts';

export interface StatusSpec {
  text: string;
  tone: 'ready' | 'running' | 'needs_input' | 'blocked' | 'neutral';
  icon: IconName | null;
}

const STATUS_TEXT = defineMessages('offline.status', {
  queued: 'Waiting to send',
  sending: 'Sending',
  failed: 'Not sent',
  done: 'Sent',
});

const STATUS_LOOK: Record<QueueStatus, Omit<StatusSpec, 'text'>> = {
  queued: { tone: 'neutral', icon: 'clock' },
  sending: { tone: 'running', icon: null },
  failed: { tone: 'blocked', icon: 'alert' },
  done: { tone: 'ready', icon: 'check' },
};

/** A waiting change's status, as a chip. */
export function queueStatus(status: QueueStatus): StatusSpec {
  return { text: STATUS_TEXT[status], ...STATUS_LOOK[status] };
}

/** Why the Hub refused a change (SyncOpResult reasons, apps/hub/src/sync.ts). */
const REJECTED = defineMessages('offline.rejected', {
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
});

const REFUSED = defineMessages('offline.refused', {
  answerGone: 'The Hub refused the answer: the message it answers is not in that chat any more.',
  /** A reason this app has no words for: the Hub's code, with spaces. */
  other: 'The Hub refused it ({reason}).',
});

/** A sentence for a refused change. */
export function rejectionText(item: Pick<QueueItem, 'kind'>, reason: string): string {
  if (item.kind === 'answer' && reason === 'invalid_value') return REFUSED.answerGone;
  return messageFor(REJECTED, reason) ?? REFUSED.other({ reason: reason.replace(/_/g, ' ') });
}

/** Why a change failed or waits, when the words are this app's (`QueueProblem`). */
const PROBLEM_TEXT = defineMessages('offline.problem', {
  no_replica:
    'This device has no offline copy now, so the Hub will not take its changes. Copy what you need, then discard it.',
  signed_out:
    'This device is signed out of the Hub, so it cannot send this. Copy what you need, then discard it.',
  sync_disabled: 'Sync is turned off on the Hub. Retry once it is on again.',
  loading: 'Waiting for the offline copy to finish loading.',
  in_flight: 'The Hub is still working on it.',
  not_yet: 'The Hub could not take it yet.',
  answer_not_yet: 'The Hub could not start an answer yet.',
  send_failed: 'Sending failed.',
});

/** Why a change failed or waits, in the active locale; the Hub's own words stay as they are. */
export function problemText(
  item: Pick<QueueItem, 'kind' | 'problem' | 'error' | 'errorCode'>,
): string | null {
  if (item.problem === 'rejected') return rejectionText(item, item.errorCode ?? 'rejected');
  if (item.problem) return messageFor(PROBLEM_TEXT, item.problem) ?? item.error;
  return item.error;
}

/** What became of a change once sent (`QueueNote`). */
const NOTE_TEXT = defineMessages('offline.note', {
  overwritten: 'A newer change made elsewhere won. Yours is kept in Settings → Sync → History.',
  requested: 'Sent. The Hub is answering it now.',
  answered: 'Sent. It already has a reply in the chat.',
  not_last: 'Sent. Newer messages follow it in the chat, so it was not answered on its own.',
  turn_in_progress:
    'Sent. A reply was already running in that chat, so it was not answered; ask again there.',
  shared_thread:
    'Sent. In a shared chat a message written offline is not answered for you; ask again there.',
  not_user_message: 'Sent. The Hub could not answer it.',
  answer_failed: 'Sent, but the Hub could not be asked to answer it. Ask again in the chat.',
});

/** What became of a change once sent, in the active locale. */
export function noteText(note: string | null): string | null {
  return note ? (messageFor(NOTE_TEXT, note) ?? note) : null;
}

/** What a waiting change is: `named`/`toNamed` say whether the name and the new name are known. */
const LABEL_TEXT = defineMessages('offline.label', {
  newChat: '{named, select, yes {New chat “{name}”} other {New chat}}',
  message: '{named, select, yes {Message in “{name}”} other {Message in a chat}}',
  renameChat:
    '{named, select, yes {{toNamed, select, yes {Rename “{name}” to “{to}”} other {Remove the title of “{name}”}}} other {{toNamed, select, yes {Rename a chat to “{to}”} other {Remove the title of a chat}}}}',
  archiveChat: '{named, select, yes {Archive “{name}”} other {Archive a chat}}',
  restoreChat: '{named, select, yes {Restore “{name}”} other {Restore a chat}}',
  pinChat: '{named, select, yes {Pin “{name}”} other {Pin a chat}}',
  unpinChat: '{named, select, yes {Unpin “{name}”} other {Unpin a chat}}',
  moveChat:
    '{named, select, yes {Move “{name}” to another project} other {Move a chat to another project}}',
  projectInstructions:
    '{named, select, yes {Change the instructions of “{name}”} other {Change the instructions of a project}}',
  renameProject:
    '{named, select, yes {{toNamed, select, yes {Rename “{name}” to “{to}”} other {Rename “{name}”}}} other {{toNamed, select, yes {Rename a project to “{to}”} other {Rename a project}}}}',
  renameSpace:
    '{named, select, yes {{toNamed, select, yes {Rename the space “{name}” to “{to}”} other {Rename the space “{name}”}}} other {{toNamed, select, yes {Rename an unnamed space to “{to}”} other {Rename an unnamed space}}}}',
  editPage: '{named, select, yes {Edit the page “{name}”} other {Edit an untitled page}}',
  answer:
    "{named, select, yes {Answer from this computer's model in “{name}”} other {Answer from this computer's model in a chat}}",
  /** A change kept before changes carried what they are. */
  unknown: 'A change',
});

function short(s: string | null | undefined, n = 60): string | null {
  const t = s?.trim();
  if (!t) return null;
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** What a waiting change is, in words: "Message in “Trip planning”". */
export function itemLabel(item: Pick<QueueItem, 'subject'>): string {
  const s = item.subject as QueueSubject | undefined;
  if (!s) return LABEL_TEXT.unknown;
  const name = short(s.name);
  const to = short(s.to);
  const one = { named: name ? 'yes' : 'no', name: name ?? '' };
  const two = { ...one, toNamed: to ? 'yes' : 'no', to: to ?? '' };
  switch (s.action) {
    case 'newChat':
      return LABEL_TEXT.newChat(one);
    case 'message':
      return LABEL_TEXT.message(one);
    case 'renameChat':
      return LABEL_TEXT.renameChat(two);
    case 'archiveChat':
      return LABEL_TEXT.archiveChat(one);
    case 'restoreChat':
      return LABEL_TEXT.restoreChat(one);
    case 'pinChat':
      return LABEL_TEXT.pinChat(one);
    case 'unpinChat':
      return LABEL_TEXT.unpinChat(one);
    case 'moveChat':
      return LABEL_TEXT.moveChat(one);
    case 'projectInstructions':
      return LABEL_TEXT.projectInstructions(one);
    case 'renameProject':
      return LABEL_TEXT.renameProject(two);
    case 'renameSpace':
      return LABEL_TEXT.renameSpace(two);
    case 'editPage':
      return LABEL_TEXT.editPage(one);
    case 'answer':
      return LABEL_TEXT.answer(one);
    default:
      return LABEL_TEXT.unknown;
  }
}

const WAIT_TEXT = defineMessages('offline.wait', {
  seconds: '{n, plural, other {in # s}}',
  minutes: '{n, plural, other {in # min}}',
});

/** "in 8 s", "in 2 min". */
export function inText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? WAIT_TEXT.seconds({ n: s }) : WAIT_TEXT.minutes({ n: Math.round(s / 60) });
}

const CHANGES_TEXT = defineMessages('offline.changes', {
  count: '{n, plural, one {# change} other {# changes}}',
});

/** "1 change", "3 changes". */
export function changesText(n: number): string {
  return CHANGES_TEXT.count({ n });
}
