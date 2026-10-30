// The device components (M4a): the mesh card says "only this device" only while that's true, the
// approval sheet is tier 3 with the digits first, revoking is tier 3, and the add sheet carries the
// three front doors and the warning. Neutral placeholders only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { addDeviceSheet, deviceMeshCard, deviceRow, joinRequestSheet, revokeSheet } from '../ui/js/components.js';
import { qrEncode } from '../ui/js/qr.js';

const now = new Date('2026-10-29T10:00:00Z');
const hub = { id: 'h', name: 'Hub', kind: 'computer', role: 'hub', trust: 'trusted', online: true, this: true };
const phone = { id: 'p', name: 'Phone', kind: 'phone', role: 'client', trust: 'trusted', online: false, last_seen: '2026-10-29T09:50:00Z', this: false };
const gone = { id: 'g', name: 'Old tablet', kind: 'browser', role: 'client', trust: 'revoked', revoked_at: '2026-10-28T10:00:00Z' };

test('the mesh card shows real devices; "only this device" only while it is true', () => {
  const alone = deviceMeshCard({ devices: [hub, gone], now });
  assert.match(alone, /Only this device for now/);
  assert.equal((alone.match(/class="device-row"/g) ?? []).length, 1, 'revoked devices aren’t on the card');
  const two = deviceMeshCard({ devices: [hub, phone], now });
  assert.doesNotMatch(two, /Only this device/);
  assert.match(two, /Hub <span class="device-tag">· this device/);
  assert.match(two, /Phone · last seen 10 min ago/);
  assert.match(two, /is-warn">Offline/);
  const many = deviceMeshCard({ devices: [hub, phone, { ...phone, id: 'a' }, { ...phone, id: 'b' }, { ...phone, id: 'c' }], now });
  assert.equal((many.match(/class="device-row"/g) ?? []).length, 3);
  assert.match(many, /and 2 more/);
  assert.match(deviceRow(gone, { now }), /Browser · revoked/);
  assert.match(deviceRow(gone, { now }), /<span class="pill">Revoked/);
  // A computer whose agent is in safe mode (M4b) is online, and says why its runtime is down.
  const computer = { id: 'c', name: 'Test computer', kind: 'computer', role: 'spoke', trust: 'trusted', online: true, agent: { safe_mode: true } };
  assert.match(deviceRow(computer, { now }), /Computer · safe mode: its agent stopped after repeated crashes/);
  assert.doesNotMatch(deviceRow({ ...computer, agent: { safe_mode: false } }, { now }), /safe mode/);
});

test('approving a device is tier 3: the digits, who it is and what it may do, a locked Confirm', () => {
  const html = joinRequestSheet({ id: 'r1', name: 'Desk computer', kind: 'computer', platform: 'linux', capabilities: ['shell.run'], fingerprint: 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789', confirmation: '042917' });
  assert.match(html, /data-tier="3" data-request="r1"/);
  assert.match(html, /<p class="digits" aria-label="0 4 2 9 1 7">042 917<\/p>/);
  assert.match(html, /can’t read your conversations/);
  assert.match(html, /shell\.run/);
  assert.match(html, /ABCD-EFGH-JKMN/);
  assert.match(html, /name="confirm" required/);
  assert.match(html, /data-action="approve" value="approve" disabled>Add this device/);
  assert.match(html, /data-action="deny-request"/);
  assert.match(revokeSheet(phone), /data-tier="3" data-revoke="p"[\s\S]*disabled>Revoke/);
});

test('the add sheet: a QR that decodes to the pairing address, the address and code, the command, the warning', () => {
  const p = {
    pairing_id: 'x', code: 'ABCD-EFGH', expires_at: '2026-10-29T10:05:00Z', hub_url: 'https://hub.example:4320', hub_fingerprint: 'ABCD-EFGH',
    url: 'https://hub.example:4320/pair#c=ABCD-EFGH&h=ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789', command: 'curl -fsS https://hub.example:4320/join.sh | sh -s -- ABCD-EFGH',
  };
  const html = addDeviceSheet(p, { now });
  assert.match(html, /<svg class="qr"/);
  assert.match(html, /https:\/\/hub\.example:4320\/pair<\/dd>/);
  assert.match(html, /ABCD-EFGH<\/dd>/);
  assert.match(html, /curl -fsS https:\/\/hub\.example:4320\/join\.sh \| sh -s -- ABCD-EFGH/);
  assert.match(html, /Only enter this code at https:\/\/hub\.example:4320 on a device you already trust\./);
  // The QR in the sheet is the pairing address.
  const { size, dark } = qrEncode(p.url);
  const n = (size + 8) * 4;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (dark[y * size + x]) for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) { const i = (((y + 4) * 4 + dy) * n + (x + 4) * 4 + dx) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
  assert.equal(jsQR(px, n, n)?.data, p.url);
  const expired = addDeviceSheet(p, { now: new Date('2026-10-29T10:06:00Z') });
  assert.match(expired, /That code has expired/);
  assert.doesNotMatch(expired, /<svg/);
  assert.match(expired, /data-action="add-device">Make a new code/);
});
