import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as views from '../ui/js/view.js';

const KEY = '01234567-89abcdef-01234567-89abcdef-01234567-89abcdef-01234567-89abcdef';
const base = { settings: { target: '/srv/copies', keep: 7, encrypted_target: '/media/archive' }, permissions: { canEdit: true, console: true }, state: 'ready', errors: {}, recovery: { state: 'hidden' } };
function render(over = {}, options) {
  assert.equal(typeof views.renderBackupsSettings, 'function', 'the shared Backups renderer is missing');
  return views.renderBackupsSettings({ ...base, ...over }, options);
}

test('Backups has its own rendered styleguide entry rather than a helper exemption', () => {
  const guide = readFileSync('ui/js/styleguide.js', 'utf8');
  assert.match(guide, /\['backups-settings', 'Backups settings', '/);
  assert.match(guide, /renderBackupsSettings\(/);
});

test('folder and retention drafts have associated labels, help and explicit removal actions', () => {
  const html = render({}, { id: 'example' });
  for (const name of ['target', 'keep', 'encrypted_target']) {
    assert.match(html, new RegExp(`name="${name}"`));
    assert.match(html, new RegExp(`for="example-${name}"`));
    assert.match(html, new RegExp(`id="example-${name}"`));
    assert.match(html, new RegExp(`aria-describedby="example-${name}-help`));
  }
  assert.match(html, /name="keep"[^>]*min="1"[^>]*max="365"[^>]*step="1"/);
  assert.match(html, /data-action="backups-clear-target"/);
  assert.match(html, /data-action="backups-clear-encrypted"/);
  assert.match(html, /already exists/i);
  assert.match(html, /private/i);
  assert.match(html, /outside Nova/);
  assert.match(html, /different folder/i);
  assert.match(html, /data-action="backups-save"/);
});

test('loading and read-only capabilities cannot mutate settings or reveal a key', () => {
  const loading = render({ state: 'loading' });
  assert.match(loading, /Loading backup settings/);
  assert.doesNotMatch(loading, /<form|backups-reveal|backups-save/);
  for (const permissions of [{ canEdit: false, console: false, readOnlyReason: 'This paired device can view settings.' }, { canEdit: false, console: true, readOnlyReason: 'Settings are read-only on standby.' }, {}]) {
    const html = render({ permissions, recovery: { state: 'confirm', key: KEY } });
    assert.doesNotMatch(html, /backups-save|backups-reveal|backups-confirm|backups-clear-/);
    assert.doesNotMatch(html, new RegExp(KEY));
    assert.match(html, /disabled/);
  }
});

test('a paired approver can receive the first key once but cannot repeat a reveal', () => {
  const permissions = { canEdit: true, console: false };
  const first = render({ permissions, recovery: { state: 'first-shown', key: KEY } });
  assert.match(first, new RegExp(KEY));
  assert.match(first, /once|first/i);
  assert.match(first, /backups-hide/);
  assert.doesNotMatch(first, /backups-reveal|backups-confirm/);
  const hidden = render({ permissions, recovery: { state: 'hidden', key: KEY } });
  assert.doesNotMatch(hidden, new RegExp(KEY));
  assert.doesNotMatch(hidden, /backups-reveal|backups-confirm/);
  assert.match(hidden, /console/i);
  assert.doesNotMatch(render({ permissions, recovery: { state: 'shown', key: KEY } }), new RegExp(KEY), 'a repeated key state cannot bypass the console role');
});

test('repeated reveal uses explicit tier-3 confirmation with no hidden key bytes', () => {
  const html = render({ recovery: { state: 'confirm', key: KEY, confirmed: false } });
  assert.match(html, /data-tier="3"/);
  assert.match(html, /type="checkbox"[^>]*name="confirm"/);
  assert.match(html, /data-action="backups-confirm"[^>]*disabled/);
  assert.doesNotMatch(html, new RegExp(KEY));
  assert.doesNotMatch(render({ recovery: { state: 'confirm', confirmed: true } }), /data-action="backups-confirm"[^>]*disabled/);
});

test('only visible authorized key states emit escaped key text, only inside code', () => {
  for (const state of ['hidden', 'confirm', 'unavailable']) assert.doesNotMatch(render({ recovery: { state, key: KEY } }), new RegExp(KEY));
  for (const state of ['first-shown', 'shown']) {
    const html = render({ recovery: { state, key: KEY } });
    assert.equal(html.split(KEY).length - 1, 1);
    assert.match(html, new RegExp(`<code>${KEY}</code>`));
    assert.match(html, /encrypted backup copies/i);
    assert.doesNotMatch(html, /all.*credentials|all.*sign.ins/i);
  }
});

test('saving prevents duplicate submit while retaining editable drafts and failed fields', () => {
  const settings = { target: '/srv/pending draft', keep: '', encrypted_target: '/media/new copy' };
  const saving = render({ state: 'saving', settings });
  assert.match(saving, /aria-busy="true"/);
  assert.match(saving, /data-action="backups-save"[^>]*disabled/);
  assert.match(saving, /name="target"[^>]*value="\/srv\/pending draft"(?![^>]*disabled)/);
  const failure = render({ state: 'error', settings, notice: 'Could not save. The folder is not writable.', errors: { target: 'Choose a private folder.', keep: 'Enter a whole number from 1 to 365.', encrypted_target: 'Choose a different folder.' } });
  assert.match(failure, /role="alert"/);
  assert.match(failure, /aria-invalid="true"/);
  assert.match(failure, /value="\/srv\/pending draft"/);
  assert.match(failure, /name="keep"[^>]*value=""/);
  assert.match(failure, /not writable/);
  assert.match(failure, /keep-error/);
});

test('empty settings use default retention without converting an invalid draft or promising folder creation', () => {
  const html = render({ settings: { target: null, encrypted_target: null } });
  assert.match(html, /No backup folders selected/);
  assert.match(html, /name="keep"[^>]*value="7"/);
  assert.doesNotMatch(html, /create.*folder|browse/i);
  assert.match(render({ settings: { ...base.settings, keep: 'invalid' } }), /value="invalid"/);
});

test('all arbitrary strings and identifiers are escaped; rendering is pure and deterministic', () => {
  const attack = '\"><img src=x onerror=alert(1)>';
  const model = { ...base, settings: { target: attack, keep: attack, encrypted_target: attack }, notice: attack, errors: { target: attack, keep: attack, encrypted_target: attack }, recovery: { state: 'shown', key: attack, error: attack } };
  const before = JSON.stringify(model);
  const html = render(model, { id: attack });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.equal(render(model, { id: attack }), html);
  assert.equal(JSON.stringify(model), before);
});
