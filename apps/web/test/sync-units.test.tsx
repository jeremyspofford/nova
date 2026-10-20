// The words and small rules of the offline and sync views: status chips for every state of this
// device's copy and of other devices, merge-log values as text (never HTML), who set a value, the
// Hub's refusals as sentences, waits and sizes, and the active path the copy shows for a chat.
import { describe, expect, it } from 'vitest';
import { fmt } from '@nova/i18n';
import type { MessageView } from '@nova/shared';
import { ApiError } from '../src/api.ts';
import { changesText, inText, rejectionText } from '../src/offline/format.ts';
import type { ReplicaState } from '../src/replica/engine.ts';
import { activePath } from '../src/replica/views.ts';
import {
  countsText,
  fieldLabel,
  phaseSpec,
  replicaStatusSpec,
  sideWhen,
  sideWho,
  syncErrorMessage,
  valueText,
} from '../src/sync/format.ts';

const state = (over: Partial<ReplicaState>): ReplicaState => ({
  phase: 'ready',
  granted: true,
  deviceId: 'd1',
  reason: null,
  removal: null,
  syncing: false,
  loadedAt: null,
  lastSyncAt: null,
  cursor: 0,
  bytes: 0,
  counts: null,
  version: 0,
  ...over,
});

describe('words for sync', () => {
  it('names every state of this device’s copy, online and offline', () => {
    const text = (s: Partial<ReplicaState>, offline = false) => phaseSpec(state(s), offline).text;
    expect(text({ phase: 'off' })).toBe('Off');
    expect(text({ phase: 'unsupported' })).toBe('Not available in this browser');
    expect(text({ phase: 'loading' })).toBe('Loading');
    expect(text({ phase: 'loading' }, true)).toBe('Not loaded yet');
    expect(text({ phase: 'ready' })).toBe('Up to date');
    expect(text({ phase: 'ready', syncing: true })).toBe('Syncing');
    expect(text({ phase: 'ready' }, true)).toBe('Offline');
    expect(text({ phase: 'paused' })).toBe('Paused');
    expect(text({ phase: 'error' })).toBe('Error');
    expect(text({ phase: 'removed' })).toBe('Removed');
    expect(replicaStatusSpec('synced').text).toBe('Synced');
    expect(replicaStatusSpec('something_new')).toMatchObject({
      text: 'something new',
      tone: 'neutral',
    });
  });

  it('shows values as plain text and says who set them', () => {
    expect(valueText('_deleted', true)).toBe('Deleted');
    expect(valueText('_deleted', false)).toBe('Kept');
    expect(valueText('title', null)).toBe('Empty');
    expect(valueText('pinned', true)).toBe('Yes');
    expect(valueText('value', 3)).toBe('3');
    expect(valueText('body', { text: '<b>hi</b>' })).toBe('<b>hi</b>');
    expect(valueText('value', { a: 1 })).toBe('{\n  "a": 1\n}');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(valueText('value', loop)).toBe('A value that cannot be shown');
    expect(fieldLabel('instructions')).toBe('Instructions');
    expect(fieldLabel('mystery')).toBe('mystery');
    const side = { value: 1, hlc: '001760000000000-0000-d1', deviceId: 'd1', deviceName: 'Laptop' };
    expect(sideWho(side, 'd1')).toBe('this device');
    expect(sideWho(side, 'd2')).toBe('Laptop');
    expect(sideWho({ ...side, deviceName: null }, null)).toBe('a device that is gone');
    expect(sideWho({ ...side, deviceId: null, deviceName: null }, null)).toBe('the Hub');
    expect(sideWhen({ ...side, hlc: 'bad' })).toBe('at an unknown time');
    expect(sideWhen(side)).toMatch(/2025/);
    expect(countsText(null)).toBe('Nothing yet');
    expect(
      countsText({
        thread: 1,
        message: 0,
        project: 2,
        memory: 1,
        space: 1,
        page: 0,
        schedule: 0,
        setting: 3,
      }),
    ).toBe('1 chat, 2 projects, 1 memory, 1 space, 3 settings');
  });

  it('turns the Hub’s refusals into sentences', () => {
    const err = (reason: string, status = 409) =>
      new ApiError(status, {
        code: 'conflict',
        message: 'raw',
        retryable: false,
        details: { reason },
      });
    expect(syncErrorMessage(err('already_restored'))).toBe('This value was restored already.');
    expect(syncErrorMessage(err('deleted'))).toMatch(/deleted/);
    expect(syncErrorMessage(err('not_supported'))).toMatch(/cannot be restored/);
    expect(syncErrorMessage(err('invalid_value', 400))).toMatch(/no longer valid/);
    expect(
      syncErrorMessage(new ApiError(404, { code: 'not_found', message: 'x', retryable: false })),
    ).toMatch(/It is gone/);
    expect(syncErrorMessage(new TypeError('Failed to fetch'))).toMatch(/Cannot reach the Hub/);
    expect(rejectionText({ kind: 'page' }, 'deleted')).toBe('It was deleted on the Hub.');
    expect(rejectionText({ kind: 'answer' }, 'invalid_value')).toMatch(
      /the message it answers is not in that chat/,
    );
    expect(rejectionText({ kind: 'answer' }, 'local_runtime_not_granted')).toMatch(
      /has not given this device Local models/,
    );
    expect(rejectionText({ kind: 'chat' }, 'brand_new')).toBe('The Hub refused it (brand new).');
    expect(inText(800)).toBe('in 1 s');
    expect(inText(300_000)).toBe('in 5 min');
    expect(changesText(1)).toBe('1 change');
    // Sizes go through the locale's formatter (FR-016).
    expect(fmt.bytes(512)).toBe('512 B');
    expect(fmt.bytes(3500)).toBe('3.4 KB');
    expect(fmt.bytes(5 * 1024 ** 2)).toBe('5 MB');
    expect(fmt.bytes(3 * 1024 ** 3)).toBe('3 GB');
  });
});

describe('the active path of a chat in the copy', () => {
  const m = (id: string, parentId: string | null, at: number): MessageView => ({
    id,
    threadId: 't',
    turnId: null,
    role: 'user',
    status: 'complete',
    parts: [],
    model: null,
    usage: null,
    createdAt: new Date(at * 1000).toISOString(),
    parentId,
  });

  it('follows the newest message back to the first, through branches and gaps', () => {
    expect(activePath([])).toEqual([]);
    const path = activePath([m('a', null, 1), m('b', 'a', 2), m('c', 'a', 3), m('d', 'c', 4)]);
    expect(path.map((x) => x.id)).toEqual(['a', 'c', 'd']);
    // A parent that is not in the copy (a branch's inherited messages) ends the path.
    expect(activePath([m('x', 'gone', 1), m('y', 'x', 2)]).map((x) => x.id)).toEqual(['x', 'y']);
    // A loop never hangs.
    expect(activePath([m('p', 'q', 1), m('q', 'p', 2)]).map((x) => x.id)).toEqual(['p', 'q']);
  });
});
