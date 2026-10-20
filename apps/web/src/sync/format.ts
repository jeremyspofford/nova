// Words for Settings → Sync (FR-109, docs/13 §2.2, FR-016): the state of this device's offline
// copy, each device's sync status (synced / pending / offline / error), what a merge-log entry is
// about and why, and its two values in plain text. Worded when shown, in the active locale.
import { defineMessages, fmt, messageFor } from '@nova/i18n';
import {
  SYNC_TOMBSTONE,
  type SyncKind,
  type SyncMergeSideView,
  type SyncReplicaStatus,
} from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import type { StatusSpec } from '../offline/format.ts';
import type { ReplicaState } from '../replica/engine.ts';
import { hlcMs } from '../replica/hlc.ts';

const STATUS_TEXT = defineMessages('sync.status', {
  synced: 'Synced',
  pending: 'Pending',
  offline: 'Offline',
  error: 'Error',
});

const STATUS_LOOK: Record<SyncReplicaStatus, Omit<StatusSpec, 'text'>> = {
  synced: { tone: 'ready', icon: 'check' },
  pending: { tone: 'running', icon: 'clock' },
  offline: { tone: 'neutral', icon: 'alert' },
  error: { tone: 'blocked', icon: 'alert' },
};

/** A device's sync status as a chip; a status this app does not know shows the Hub's code. */
export function replicaStatusSpec(status: string): StatusSpec {
  const look = (STATUS_LOOK as Record<string, Omit<StatusSpec, 'text'> | undefined>)[status];
  const text = messageFor(STATUS_TEXT, status);
  if (look && text) return { text, ...look };
  return { text: status.replace(/_/g, ' '), tone: 'neutral', icon: 'alert' };
}

const PHASE_TEXT = defineMessages('sync.phase', {
  off: 'Off',
  unsupported: 'Not available in this browser',
  notLoaded: 'Not loaded yet',
  loading: 'Loading',
  offline: 'Offline',
  syncing: 'Syncing',
  upToDate: 'Up to date',
  paused: 'Paused',
  error: 'Error',
  removed: 'Removed',
});

/** This device's copy, as one chip. */
export function phaseSpec(s: ReplicaState, hubOffline: boolean): StatusSpec {
  switch (s.phase) {
    case 'off':
      return { text: PHASE_TEXT.off, tone: 'neutral', icon: 'stop' };
    case 'unsupported':
      return { text: PHASE_TEXT.unsupported, tone: 'blocked', icon: 'alert' };
    case 'loading':
      return hubOffline
        ? { text: PHASE_TEXT.notLoaded, tone: 'needs_input', icon: 'clock' }
        : { text: PHASE_TEXT.loading, tone: 'running', icon: null };
    case 'ready':
      if (hubOffline) return { text: PHASE_TEXT.offline, tone: 'neutral', icon: 'alert' };
      return s.syncing
        ? { text: PHASE_TEXT.syncing, tone: 'running', icon: null }
        : { text: PHASE_TEXT.upToDate, tone: 'ready', icon: 'check' };
    case 'paused':
      return { text: PHASE_TEXT.paused, tone: 'needs_input', icon: 'stop' };
    case 'error':
      return { text: PHASE_TEXT.error, tone: 'blocked', icon: 'alert' };
    case 'removed':
      return { text: PHASE_TEXT.removed, tone: 'blocked', icon: 'stop' };
  }
}

/** What a merge-log entry is about. */
export const KIND_LABEL = defineMessages('sync.kind', {
  thread: 'Chat',
  message: 'Message',
  project: 'Project',
  memory: 'Memory',
  space: 'Space',
  page: 'Page',
  schedule: 'Schedule',
  setting: 'Setting',
});

const COUNT_TEXT = defineMessages('sync.counts', {
  thread: '{n, plural, one {# chat} other {# chats}}',
  message: '{n, plural, one {# message} other {# messages}}',
  project: '{n, plural, one {# project} other {# projects}}',
  memory: '{n, plural, one {# memory} other {# memories}}',
  space: '{n, plural, one {# space} other {# spaces}}',
  page: '{n, plural, one {# page} other {# pages}}',
  schedule: '{n, plural, one {# schedule} other {# schedules}}',
  setting: '{n, plural, one {# setting} other {# settings}}',
  nothing: 'Nothing yet',
});

const COUNTED: readonly SyncKind[] = [
  'thread',
  'message',
  'project',
  'memory',
  'space',
  'page',
  'schedule',
  'setting',
];

/** "12 chats, 340 messages, 2 projects", or "Nothing yet". */
export function countsText(counts: Record<SyncKind, number> | null): string {
  if (!counts) return COUNT_TEXT.nothing;
  const parts = COUNTED.filter((k) => counts[k] > 0).map((k) => COUNT_TEXT[k]({ n: counts[k] }));
  return parts.length ? fmt.list(parts, { type: 'unit', style: 'short' }) : COUNT_TEXT.nothing;
}

const FIELD_TEXT = defineMessages('sync.field', {
  title: 'Title',
  pinned: 'Pinned',
  archived: 'Archived',
  project: 'Project',
  name: 'Name',
  instructions: 'Instructions',
  content: 'Content',
  status: 'Status',
  enabled: 'On or off',
  value: 'Value',
  version: 'Version',
  body: 'Message',
  /** The tombstone field (`_deleted`). */
  deleted: 'Deleted',
});

/** A field's name; one this app does not know shows as the Hub names it. */
export function fieldLabel(field: string): string {
  if (field === SYNC_TOMBSTONE) return FIELD_TEXT.deleted;
  return messageFor(FIELD_TEXT, field) ?? field;
}

export const MERGE_REASON_TEXT = defineMessages('sync.mergeReason', {
  concurrent: 'Changed in two places at about the same time; the newer change won.',
  stale: 'An older change arrived after a newer one; the newer one stayed.',
  restore: 'A restore from the merge log replaced this value.',
});

const VALUE_TEXT = defineMessages('sync.value', {
  deleted: 'Deleted',
  kept: 'Kept',
  empty: 'Empty',
  yes: 'Yes',
  no: 'No',
  unshowable: 'A value that cannot be shown',
});

/** A value as text: never rendered as HTML. */
export function valueText(field: string, value: unknown): string {
  if (field === SYNC_TOMBSTONE) return value === true ? VALUE_TEXT.deleted : VALUE_TEXT.kept;
  if (value === null || value === undefined || value === '') return VALUE_TEXT.empty;
  if (typeof value === 'boolean') return value ? VALUE_TEXT.yes : VALUE_TEXT.no;
  if (typeof value === 'string') return value;
  // A stored value, shown as it is kept (a port stays 8080, not "8,080").
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string')
    return (value as { text: string }).text;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return VALUE_TEXT.unshowable;
  }
}

const SIDE_TEXT = defineMessages('sync.side', {
  thisDevice: 'this device',
  gone: 'a device that is gone',
  hub: 'the Hub',
  unknownTime: 'at an unknown time',
});

/** Who set a value: a device by name, this device, the Hub. */
export function sideWho(side: SyncMergeSideView, thisDevice: string | null): string {
  if (side.deviceId && side.deviceId === thisDevice) return SIDE_TEXT.thisDevice;
  if (side.deviceName) return side.deviceName;
  return side.deviceId ? SIDE_TEXT.gone : SIDE_TEXT.hub;
}

/** When a value was set, from its clock. */
export function sideWhen(side: SyncMergeSideView): string {
  const ms = hlcMs(side.hlc);
  if (ms === null) return SIDE_TEXT.unknownTime;
  return fmt.dateTime(ms, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ERROR_TEXT = defineMessages('sync.error', {
  alreadyRestored: 'This value was restored already.',
  deleted: 'It was deleted, so there is nothing to restore it into.',
  notSupported: 'This value cannot be restored from here.',
  invalidValue: 'The old value is no longer valid, so it cannot be restored.',
  gone: 'It is gone: someone removed it already.',
  other: 'Something went wrong.',
});

/** A sentence for a failed sync call; the Hub's own words for anything else (English, D9). */
export function syncErrorMessage(err: unknown, fallback: string = ERROR_TEXT.other): string {
  if (err instanceof ApiError) {
    const reason = err.body.details?.reason;
    switch (reason) {
      case 'already_restored':
        return ERROR_TEXT.alreadyRestored;
      case 'deleted':
        return ERROR_TEXT.deleted;
      case 'not_supported':
        return ERROR_TEXT.notSupported;
      case 'invalid_value':
        return ERROR_TEXT.invalidValue;
      default:
        break;
    }
    if (err.status === 404) return ERROR_TEXT.gone;
  }
  return errorMessage(err, fallback);
}
