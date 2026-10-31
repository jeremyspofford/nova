// M10f in the PWA's pure parts: the roles on the approval sheet and in Settings › Devices, their
// tiered review, the words kept the same as the hub's, Settings' new Services category, and the
// empty states on the first session's path (orient, the value, exactly one action).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PURPOSE_WORDS } from '../src/core/index.ts';
import { ROLE_WORDS, deviceMeshCard, joinRequestSheet, memoryHighlightCard, rolesReviewSheet, rolesSheet } from '../ui/js/components.js';
import { renderMemory } from '../ui/js/view.js';
import { categoryOf, searchSettings } from '../ui/js/settings-ia.js';

const actions = (html) => (html.match(/<(a|button)\b[^>]*>/g) ?? []).length;

test('the screen’s words for each role are the hub’s', () => {
  assert.deepEqual(ROLE_WORDS, PURPOSE_WORDS);
});

test('the approval sheet shows what a device asked to be for, to confirm or change; a phone is a thin client and says so', () => {
  const allowed = ['thin-client', 'hub-candidate', 'compute', 'storage', 'capture-source', 'general-server'];
  const computer = joinRequestSheet({ id: 'r1', name: 'Desk box', kind: 'computer', platform: 'linux x64', capabilities: [], purposes: ['compute'], allowed, fixed: [], fingerprint: 'fp', confirmation: '123456' });
  assert.equal((computer.match(/name="purpose"/g) ?? []).length, 6, 'every role a computer may hold');
  assert.match(computer, /value="compute" checked/);
  assert.doesNotMatch(computer, /value="storage" checked/);
  assert.match(computer, /name="confirm_candidate"[\s\S]*Its key is pinned for that/, 'a hub candidacy has its own confirmation');
  const phone = joinRequestSheet({ id: 'r2', name: 'Phone', kind: 'phone', platform: 'iPhone', capabilities: [], purposes: ['thin-client'], allowed: ['thin-client'], fixed: ['thin-client'], fingerprint: 'fp', confirmation: '123456' });
  assert.match(phone, /Thin client\. A screen onto Nova, for using it\./);
  assert.doesNotMatch(phone, /type="checkbox" name="purpose"/);
  assert.doesNotMatch(phone, /confirm_candidate/);
});

test('changing roles in Settings › Devices: widening is tier 3, narrowing tier 2 and says what stops; the hub’s fixed roles can’t be unticked', () => {
  const d = { id: 'd1', name: 'Desk box', kind: 'computer', purposes: ['compute'] };
  const sheet = rolesSheet(d, { allowed: ['thin-client', 'hub-candidate', 'compute', 'storage', 'capture-source', 'general-server'], fixed: [] });
  assert.match(sheet, /What is “Desk box” for\?/);
  const wide = rolesReviewSheet(d, ['hub-candidate', 'compute'], { added: ['hub-candidate'], removed: [] });
  assert.match(wide, /data-tier="3"/);
  assert.match(wide, /name="confirm" required/);
  assert.match(wide, /name="confirm_candidate"/);
  const narrow = rolesReviewSheet({ ...d, purposes: ['compute', 'storage'] }, ['compute'], { added: [], removed: ['storage'] });
  assert.match(narrow, /data-tier="2"/);
  assert.match(narrow, /nothing stops/);
  assert.doesNotMatch(narrow, /name="confirm"/);
  const hub = rolesSheet({ id: 'h', name: 'Hub', kind: 'computer', role: 'hub', purposes: ['hub-candidate', 'general-server'] }, { allowed: ['hub-candidate', 'compute', 'storage', 'capture-source', 'general-server'], fixed: ['hub-candidate', 'general-server'] });
  assert.match(hub, /value="general-server" checked disabled/);
  assert.match(hub, /value="hub-candidate" checked disabled/);
});

test('Settings: a Services category, and search finds roles and the backend by people’s words', () => {
  assert.equal(categoryOf('services').label, 'Services');
  assert.equal(searchSettings('roles')[0].cat, 'devices');
  assert.equal(searchSettings('hub candidate')[0].cat, 'devices');
  for (const q of ['k3s', 'kubernetes', 'backend', 'supervisor']) assert.equal(searchSettings(q)[0].cat, 'services', q);
});

test('empty states on the first session’s path orient, say what it is for, and offer exactly one action', () => {
  const memory = renderMemory({ sections: [], days: [], candidates: [] });
  assert.match(memory, /What Nova knows[\s\S]*Nothing kept yet[\s\S]*Nova keeps what lasts here/);
  assert.equal(actions(memory), 1);
  // With things waiting from an import, keeping them is the action: the empty part offers none.
  const waiting = renderMemory({ sections: [], days: [], candidates: [{ id: 'c1', op: 'remember', kind: 'fact', content: 'Note “Garden plans”: …', source: 'imported from ~/Notes/plants.md' }] });
  assert.equal(actions(waiting.split('<section')[0]), 0);
  const alone = deviceMeshCard({ devices: [{ name: 'Hub', role: 'hub', trust: 'trusted' }] });
  assert.match(alone, /Only this device for now\. Pair your phone to reach Nova from it\./);
  assert.equal(actions(alone), 1);
  assert.equal(actions(memoryHighlightCard({ records: [] })), 1);
});
