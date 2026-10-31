// Settings › Danger zone (M7 amendment §2): erasing Nova on this machine and starting over. Last on
// the Settings page and set apart; its one standout is the erase button, in the alert colour. It
// is the hub's own screen only (a paired phone or browser is told so, with no button), and tier 3:
// confirmed every time with a required checkbox.
//
// The flow, in one sheet: the export first (recommended, not forced) into a folder the person
// names, with its recovery key shown once; then the confirmation, listing exactly what is erased
// and what is not (the person's own files, backup folders that aren't there, devices that can't be
// told, the code releases); then Nova starts over. Everything listed comes from GET /reset: real
// state only.
import { api, on } from './core.js';
import { escapeHtml as esc } from './markdown.js';
import { status } from './components.js';
import { openSheet, toast } from './shell.js';
import { forgetHere } from './forget-here.js';
import { waitingLine } from './wait.js';

let preview = null;
let failed = '';
let hubOnly = false;
let rerender = () => {};
// The sheet's step: export → exported → confirm → erasing.
let flow = { step: null, exported: null, error: '', busy: false, staged: null };

export async function loadReset() {
  try {
    preview = await api('GET', '/reset');
    failed = '';
    hubOnly = false;
  } catch (e) {
    if (e.status === 403) hubOnly = true;
    else failed = e.message || 'Nova’s server didn’t answer.';
  }
  rerender();
}

export function renderReset() {
  const head = `<section class="memory-section danger-zone" id="danger-zone" aria-labelledby="set-danger">
<h2 class="memory-heading" id="set-danger">Danger zone</h2>
<p class="memory-lede">Erasing Nova returns it to how it was the first time, on this machine: no memories, conversations, settings, saved passwords, paired devices, checkpoints or backups. Nova offers to export everything first.</p>`;
  if (hubOnly) return `${head}<p class="settings-note">This can be done on the hub’s own screen only, not from a paired phone or browser.</p></section>`;
  if (!preview) return `${head}${failed ? `<p class="settings-note">${esc(failed)}</p><button type="button" class="btn set-retry" data-action="reset-retry">Try again</button>` : waitingLine('Loading what a reset would erase', { key: 'reset' })}</section>`;
  if (preview.staged) return `${head}<p class="settings-note reset-staged" role="status">${esc(preview.staged_said ?? 'Nova is erasing itself and starting over.')}</p></section>`;
  return `${head}<div class="sheet-actions"><button type="button" class="btn primary danger" data-action="reset-start">Erase Nova and start over…</button></div></section>`;
}

const list = (items) => (items.length ? `<ul class="reset-list">${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '');
const names = (xs) => xs.map((x) => esc(x)).join(', ');
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function exportStep() {
  return `<form class="reset-sheet" data-step="export">
  <h2 class="sheet-title" id="sheet-title">Export everything first</h2>
  <p class="sheet-line">Recommended. Nova writes an encrypted copy of everything, and your memories as plain files, into a folder of yours. Make the folder first, outside Nova’s home: Nova never creates it.</p>
  <p class="sheet-line reset-left-out">${esc(preview.export_said)}</p>
  <label class="field-label">Folder for the export<input class="field" name="folder" type="text" placeholder="/media/drive/nova-export" autocomplete="off" spellcheck="false" required></label>
  ${flow.error ? `<p class="reset-error" role="alert">${esc(flow.error)}</p>` : ''}
  <div class="sheet-actions">
    <button type="submit" class="btn primary"${flow.busy ? ' disabled' : ''}>${flow.busy ? 'Exporting…' : 'Export'}</button>
    <button type="button" class="btn quiet" data-action="reset-skip">Skip the export</button>
  </div>
</form>`;
}

function exportedStep() {
  const x = flow.exported;
  return `<div class="reset-sheet" data-step="exported">
  <h2 class="sheet-title" id="sheet-title">Exported</h2>
  <p class="sheet-line">Saved in <span class="reset-path">${esc(x.folder)}</span>.</p>
  <p class="sheet-line">Your recovery key opens the export on any machine. Keep it somewhere other than this computer: Nova shows it only now, and keeps no copy.</p>
  <p class="reset-key" aria-label="Recovery key">${esc(x.recovery_key)}</p>
  <p class="sheet-line reset-left-out">${esc(preview.export_said)}</p>
  <div class="sheet-actions"><button type="button" class="btn primary" data-action="reset-continue">I’ve kept the key: continue</button></div>
</div>`;
}

function confirmStep() {
  const p = preview;
  const erased = [
    `Nova’s own files in its home: ${names(p.wipes.home)}.`,
    ...(p.wipes.keychain ? [`The vault’s key in ${esc(p.wipes.keychain)}.`] : []),
    ...p.wipes.backups.map((b) => `${count(b.count, b.kind === 'folder' ? 'backup' : 'encrypted copy', b.kind === 'folder' ? 'backups' : 'encrypted copies')} in ${esc(b.folder)}.`),
  ];
  const kept = [
    ...(p.keeps.foreign.length ? [`In Nova’s home but not Nova’s, so left in place: ${names(p.keeps.foreign)}.`] : []),
    ...(p.keeps.before?.length ? [`Already here before Nova; left alone: ${names(p.keeps.before)}.`] : []),
    ...(p.keeps.relay ? [esc(p.keeps.relay)] : []),
    ...p.keeps.unreachable.map((u) => esc(u.said)),
    ...(p.keeps.strays.length ? [`${count(p.keeps.strays.length, 'thing')} in the backup folders that look like backups but aren’t Nova’s: left alone.`] : []),
    ...(p.keeps.export ? [`Your export in ${esc(p.keeps.export)}.`] : []),
    esc(p.keeps.releases),
  ];
  const devices = [
    ...(p.devices.can_tell.length ? [`Told first, and signed out: ${names(p.devices.can_tell.map((d) => d.name))}.`] : []),
    ...(p.devices.cant_tell.length ? [`Can’t be told now: ${names(p.devices.cant_tell.map((d) => d.name))}. ${esc(p.devices.cant_tell_said)}`] : []),
  ];
  return `<form class="reset-sheet" data-step="confirm" data-tier="3">
  <p class="sheet-kicker">${status('needs-you')}</p>
  <h2 class="sheet-title" id="sheet-title">Erase Nova on this machine?</h2>
  <p class="sheet-line">Everything goes, and Nova starts again as it did the first time. This can’t be undone${p.keeps.export ? '' : ', and you didn’t export'}.</p>
  <h3 class="reset-sub">Erased</h3>${list(erased)}
  <h3 class="reset-sub">Not erased</h3>${list(kept)}
  ${devices.length ? `<h3 class="reset-sub">Your devices</h3>${list(devices)}` : ''}
  ${flow.error ? `<p class="reset-error" role="alert">${esc(flow.error)}</p>` : ''}
  <label class="confirm"><input type="checkbox" name="confirm" required> ${esc(p.confirm)}</label>
  <div class="sheet-actions">
    <button type="submit" class="btn primary danger" data-action="reset-erase" disabled>Erase Nova</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Keep Nova</button>
  </div>
</form>`;
}

function erasingStep() {
  return `<div class="reset-sheet" data-step="erasing" role="status">
  <h2 class="sheet-title" id="sheet-title">Nova is starting over</h2>
  <p class="sheet-line">${esc(flow.staged?.said ?? '')}</p>
  <p class="sheet-line">${flow.staged?.restart === 'in-place' ? 'This page opens first-run setup once Nova is back.' : 'Once it has started again, this page opens first-run setup.'}</p>
</div>`;
}

function show() {
  const html = { export: exportStep, exported: exportedStep, confirm: confirmStep, erasing: erasingStep }[flow.step]?.();
  if (html) openSheet(html, { label: 'Erase Nova', onClose: () => { if (flow.step !== 'erasing') flow = { step: null, exported: null, error: '', busy: false, staged: null }; } });
}

async function exportNow(form) {
  flow.busy = true;
  flow.error = '';
  show();
  try {
    flow.exported = await api('POST', '/reset/export', { folder: form.elements.folder.value.trim() });
    flow.step = 'exported';
  } catch (e) {
    flow.error = e.message;
  }
  flow.busy = false;
  show();
  if (flow.step === 'export') document.querySelector('#sheet input[name="folder"]')?.focus();
}

async function toConfirm() {
  flow.error = '';
  await loadReset();
  flow.step = 'confirm';
  show();
}

async function erase(form) {
  if (!form.elements.confirm.checked) { form.elements.confirm.focus(); return; }
  try {
    flow.staged = await api('POST', '/reset', { confirm: true });
    flow.step = 'erasing';
    show();
    waitForFirstRun(flow.staged.id);
  } catch (e) {
    flow.error = e.message;
    show();
  }
}

// Once Nova is back on a new home (the report of this reset is there), first-run setup opens.
function waitForFirstRun(id) {
  const look = async () => {
    try {
      const r = await fetch('/api/v1/reset/report', { headers: { 'x-nova': '1' } });
      const report = r.ok ? await r.json() : null;
      if (report?.id === id) { location.assign('/'); return; }
      // Still up: if the restart failed, say plainly that it finishes when Nova starts next.
      const now = r.ok ? await fetch('/api/v1/reset', { headers: { 'x-nova': '1' } }).then((x) => (x.ok ? x.json() : null)) : null;
      if (now?.staged_said && now.staged_said !== flow.staged?.said && flow.step === 'erasing') {
        flow.staged = { ...flow.staged, said: now.staged_said, restart: 'next-start' };
        show();
      }
    } catch { /* not back yet */ }
    setTimeout(look, 1000); // wait: poll: is Nova back on its new home?
  };
  setTimeout(look, 1000); // wait: poll: is Nova back on its new home?
}

// Wires the part into Settings: `render` redraws it when the data changes.
export function bindReset(root, render) {
  rerender = render;
  // A paired phone or browser hears it on its stream: the Nova it was paired with is gone.
  // It forgets its key, drafts and offline copies of the Nova that is being erased.
  on('reset', () => {
    void forgetHere();
    if (hubOnly) toast('The hub was reset: Nova there was erased and starts over. This device is no longer paired with it, and has forgotten what it kept.', { tone: 'alert', ms: 15000 });
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b?.dataset.action === 'reset-retry') loadReset();
    if (b?.dataset.action === 'reset-start') { flow = { step: 'export', exported: null, error: '', busy: false, staged: null }; show(); }
  });
  const sheet = document.getElementById('sheet');
  sheet.addEventListener('submit', (e) => {
    const form = e.target.closest('.reset-sheet');
    if (!form) return;
    e.preventDefault();
    if (form.dataset.step === 'export') exportNow(form);
    if (form.dataset.step === 'confirm') erase(form);
  });
  sheet.addEventListener('change', (e) => {
    const form = e.target.closest('.reset-sheet[data-step="confirm"]');
    if (form && e.target.name === 'confirm') form.querySelector('[data-action="reset-erase"]').disabled = !e.target.checked;
  });
  sheet.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]')?.dataset.action;
    if (a === 'reset-skip' || a === 'reset-continue') toConfirm();
  });
}

