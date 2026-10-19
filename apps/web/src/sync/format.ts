// Words for Settings → Sync (FR-109, docs/13 §2.2): the state of this device's offline copy, each
// device's sync status (synced / pending / offline / error), what a merge-log entry is about and
// why, and its two values in plain text.
import {
  SYNC_TOMBSTONE,
  type SyncKind,
  type SyncMergeEntryView,
  type SyncMergeSideView,
  type SyncReplicaStatus,
} from '@nova/shared';
import { ApiError, errorMessage } from '../api.ts';
import type { StatusSpec } from '../offline/format.ts';
import type { ReplicaState } from '../replica/engine.ts';
import { hlcMs } from '../replica/hlc.ts';

export const REPLICA_STATUS: Record<SyncReplicaStatus, StatusSpec> = {
  synced: { text: 'Synced', tone: 'ready', icon: 'check' },
  pending: { text: 'Pending', tone: 'running', icon: 'clock' },
  offline: { text: 'Offline', tone: 'neutral', icon: 'alert' },
  error: { text: 'Error', tone: 'blocked', icon: 'alert' },
};

export function replicaStatusSpec(status: string): StatusSpec {
  return (
    (REPLICA_STATUS as Record<string, StatusSpec | undefined>)[status] ?? {
      text: status.replace(/_/g, ' '),
      tone: 'neutral',
      icon: 'alert',
    }
  );
}

/** This device's copy, as one chip. */
export function phaseSpec(s: ReplicaState, hubOffline: boolean): StatusSpec {
  switch (s.phase) {
    case 'off':
      return { text: 'Off', tone: 'neutral', icon: 'stop' };
    case 'unsupported':
      return { text: 'Not available in this browser', tone: 'blocked', icon: 'alert' };
    case 'loading':
      return hubOffline
        ? { text: 'Not loaded yet', tone: 'needs_input', icon: 'clock' }
        : { text: 'Loading', tone: 'running', icon: null };
    case 'ready':
      if (hubOffline) return { text: 'Offline', tone: 'neutral', icon: 'alert' };
      return s.syncing
        ? { text: 'Syncing', tone: 'running', icon: null }
        : { text: 'Up to date', tone: 'ready', icon: 'check' };
    case 'paused':
      return { text: 'Paused', tone: 'needs_input', icon: 'stop' };
    case 'error':
      return { text: 'Error', tone: 'blocked', icon: 'alert' };
    case 'removed':
      return { text: 'Removed', tone: 'blocked', icon: 'stop' };
  }
}

export const KIND_LABEL: Record<SyncKind, string> = {
  thread: 'Chat',
  message: 'Message',
  project: 'Project',
  memory: 'Memory',
  space: 'Space',
  page: 'Page',
  schedule: 'Schedule',
  setting: 'Setting',
};

const KIND_PLURAL: Record<SyncKind, [string, string]> = {
  thread: ['chat', 'chats'],
  message: ['message', 'messages'],
  project: ['project', 'projects'],
  memory: ['memory', 'memories'],
  space: ['space', 'spaces'],
  page: ['page', 'pages'],
  schedule: ['schedule', 'schedules'],
  setting: ['setting', 'settings'],
};

/** "12 chats, 340 messages, 2 projects", or "Nothing yet". */
export function countsText(counts: Record<SyncKind, number> | null): string {
  if (!counts) return 'Nothing yet';
  const parts = (Object.keys(KIND_PLURAL) as SyncKind[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${KIND_PLURAL[k][counts[k] === 1 ? 0 : 1]}`);
  return parts.length ? parts.join(', ') : 'Nothing yet';
}

const FIELD_LABEL: Record<string, string> = {
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
  [SYNC_TOMBSTONE]: 'Deleted',
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}

export const MERGE_REASON_TEXT: Record<SyncMergeEntryView['reason'], string> = {
  concurrent: 'Changed in two places at about the same time; the newer change won.',
  stale: 'An older change arrived after a newer one; the newer one stayed.',
  restore: 'A restore from the merge log replaced this value.',
};

/** A value as text: never rendered as HTML. */
export function valueText(field: string, value: unknown): string {
  if (field === SYNC_TOMBSTONE) return value === true ? 'Deleted' : 'Kept';
  if (value === null || value === undefined || value === '') return 'Empty';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string')
    return (value as { text: string }).text;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'A value that cannot be shown';
  }
}

/** Who set a value: a device by name, this device, the Hub. */
export function sideWho(side: SyncMergeSideView, thisDevice: string | null): string {
  if (side.deviceId && side.deviceId === thisDevice) return 'this device';
  if (side.deviceName) return side.deviceName;
  return side.deviceId ? 'a device that is gone' : 'the Hub';
}

/** When a value was set, from its clock. */
export function sideWhen(side: SyncMergeSideView): string {
  const ms = hlcMs(side.hlc);
  if (ms === null) return 'at an unknown time';
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A sentence for a failed sync call. */
export function syncErrorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiError) {
    const reason = err.body.details?.reason;
    switch (reason) {
      case 'already_restored':
        return 'This value was restored already.';
      case 'deleted':
        return 'It was deleted, so there is nothing to restore it into.';
      case 'not_supported':
        return 'This value cannot be restored from here.';
      case 'invalid_value':
        return 'The old value is no longer valid, so it cannot be restored.';
      default:
        break;
    }
    if (err.status === 404) return 'It is gone: someone removed it already.';
  }
  return errorMessage(err, fallback);
}
