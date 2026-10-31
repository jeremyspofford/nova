// Settings › Backups › Checkpoints (M7 amendment §1), from /api/v1/resilience/checkpoints. A
// checkpoint is everything Nova keeps on this computer, kept here; Nova takes one by itself before
// it changes itself, upgrades or restores, and the person can take their own. The retention rule
// is stated as the server states it. Restoring and deleting are the hub's own screen's only (tier
// 3) and ask every time. Restoring says
// what it undoes and that a checkpoint of now comes first; both want a required checkbox, and
// while one asks, its button is the view's one standout. Nova then restarts by itself and this part
// says so until it answers again. Everything shown is the server's own record.
import { api } from './core.js';
import { escapeHtml as esc } from './markdown.js';
import { toast } from './shell.js';
import { over, waitingLine } from './wait.js';

let data = null;
let failed = '';
let rerender = () => {};
// The checkpoint whose restore is being asked about (with what the server says it would do), the
// one whose delete is, and a restore under way.
let asking = null;
let deleting = null;
let restoring = null;

export async function loadCheckpoints() {
  try {
    data = await api('GET', '/resilience/checkpoints');
    failed = '';
    over('checkpoints');
  } catch (e) {
    failed = e.message || 'Nova’s server didn’t answer.';
  }
  rerender();
}

const time = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); };
const plain = (text) => String(text ?? '').replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, (iso) => time(iso));

function confirmPanel(c) {
  if (!asking || asking.id !== c.id) return '';
  if (!asking.preview) return `<div class="change-confirm cp-confirm">${waitingLine('Working out what restoring would do', { key: 'restore-preview' })}</div>`;
  return `<div class="change-confirm cp-confirm" role="group" aria-label="Restore ${esc(c.label)}">
  <ul class="change-asks">${asking.preview.said.map((s) => `<li>${esc(plain(s))}</li>`).join('')}</ul>
  <label class="confirm"><input type="checkbox" name="confirm" data-action="cp-restore-confirm"> I understand everything since ${esc(time(c.at))} is undone, and I want to go back.</label>
  <div class="sheet-actions"><button type="button" class="btn primary" data-action="cp-restore-yes" data-id="${esc(c.id)}" disabled>Restore this checkpoint</button><button type="button" class="btn quiet" data-action="cp-restore-no">Keep things as they are</button></div>
</div>`;
}

// Deleting data is tier 3: the hub's own screen, a required checkbox, every time.
function deletePanel(c) {
  if (deleting !== c.id) return '';
  return `<div class="change-confirm cp-delete-confirm" role="group" aria-label="Delete ${esc(c.label)}"><p class="settings-note">Delete “${esc(c.label)}”? It can’t be undone: you won’t be able to go back to how things were on ${esc(time(c.at))}.</p>
  <label class="confirm"><input type="checkbox" name="confirm" data-action="cp-delete-confirm"> I understand this checkpoint is deleted for good.</label>
  <div class="sheet-actions"><button type="button" class="btn primary" data-action="cp-delete-yes" data-id="${esc(c.id)}" disabled>Delete it</button><button type="button" class="btn quiet" data-action="cp-delete-no">Keep it</button></div></div>`;
}

function row(c) {
  const actions = [
    data.can_restore && !restoring ? `<button type="button" class="btn small quiet" data-action="cp-restore" data-id="${esc(c.id)}">Restore…</button>` : '',
    c.kind === 'named' && data.can_restore && !restoring ? `<button type="button" class="btn small quiet" data-action="cp-delete" data-id="${esc(c.id)}">Delete</button>` : '',
  ].filter(Boolean).join('');
  return `<li class="change-row cp-row" data-id="${esc(c.id)}" data-kind="${esc(c.kind)}">
  <div class="conn-head"><p class="settings-label">${esc(c.label)}</p><span class="pill">${c.kind === 'named' ? 'Named' : 'Automatic'}</span></div>
  <p class="settings-note">${esc(time(c.at))} · ${esc(c.size)} · Nova ${esc(c.nova_version)}</p>
  ${actions && asking?.id !== c.id && deleting !== c.id ? `<div class="sheet-actions">${actions}</div>` : ''}
  ${confirmPanel(c)}${deletePanel(c)}
</li>`;
}

export function renderCheckpoints() {
  const head = '<section class="memory-section" id="checkpoints" aria-labelledby="set-checkpoints"><h2 class="memory-heading" id="set-checkpoints">Backups</h2><p class="conn-sub">Checkpoints</p>';
  if (!data) return `${head}${failed ? `<p class="memory-lede">${esc(failed)}</p><button type="button" class="btn set-retry" data-action="cp-retry">Try again</button>` : waitingLine('Loading checkpoints', { key: 'checkpoints' })}</section>`;
  const pending = restoring ?? (data.restoring ? `Restoring “${data.restoring.checkpoint.label}”. Nova restarts by itself and finishes it as it starts.` : null);
  // The one standout: a restore or a delete being confirmed, else taking a checkpoint.
  const takeClass = asking || deleting ? 'btn' : 'btn primary';
  return `${head}
<p class="memory-lede">A checkpoint is everything Nova keeps on this computer: memories, tasks, settings, its keys. It stays on this computer. Nova takes one by itself before it changes itself, upgrades or restores, and you can take your own.</p>
<p class="settings-note">${esc(data.retention.rule)}</p>
${pending ? `<p class="settings-note cp-restoring" role="status">${esc(pending)}</p>` : ''}
<div class="field-row cp-take"><label class="field-label">Name<input class="field" name="cp-name" type="text" maxlength="80" autocomplete="off" placeholder="Before trying something new"></label>
<div class="sheet-actions"><button type="button" class="${takeClass}" data-action="cp-take"${restoring ? ' disabled' : ''}>Take a checkpoint</button></div></div>
${data.can_restore ? '' : '<p class="settings-note">Restoring or deleting a checkpoint is done on the hub’s own screen.</p>'}
${data.checkpoints.length ? `<ul class="change-list cp-list">${data.checkpoints.map(row).join('')}</ul>` : '<p class="settings-note">No checkpoints yet.</p>'}
</section>`;
}

// Waits for Nova to come back after a restore, then shows what it has now.
async function backAgain(label) {
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500)); // wait: poll: is Nova back after the restore?
    try {
      const v = await api('GET', '/resilience/checkpoints');
      if (!v.restoring) {
        restoring = null;
        data = v;
        rerender();
        toast(`Restored “${label}”. A checkpoint of how things were just before is in the list.`);
        return;
      }
    } catch { /* restarting */ }
  }
  restoring = null;
  await loadCheckpoints();
}

// Wires the part into Settings: `render` redraws it when the data changes.
export function bindCheckpoints(root, render) {
  rerender = render;
  root.addEventListener('change', (e) => {
    const box = e.target.closest('[data-action="cp-restore-confirm"], [data-action="cp-delete-confirm"]');
    if (!box) return;
    const go = box.closest('.change-confirm')?.querySelector('[data-action="cp-restore-yes"], [data-action="cp-delete-yes"]');
    if (go) go.disabled = !box.checked;
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input[name="cp-name"]')) { e.preventDefault(); root.querySelector('[data-action="cp-take"]')?.click(); }
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-action]');
    if (!b || !b.dataset.action.startsWith('cp-')) return;
    const a = b.dataset.action;
    const id = b.dataset.id;
    const label = data?.checkpoints.find((c) => c.id === id)?.label ?? '';
    if (a === 'cp-retry') loadCheckpoints();
    if (a === 'cp-take') {
      const input = root.querySelector('input[name="cp-name"]');
      const name = input?.value.trim() ?? '';
      if (!name) { toast('Give it a name first, so you can tell it apart later.'); input?.focus(); return; }
      b.disabled = true;
      try {
        const c = await api('POST', '/resilience/checkpoints', { name });
        if (input) input.value = '';
        toast(`Checkpoint taken: “${c.label}”, ${c.size}.`);
      } catch (err) { toast(err.message); }
      await loadCheckpoints();
    }
    if (a === 'cp-restore') {
      asking = { id, preview: null };
      deleting = null;
      rerender();
      try { asking = { id, preview: await api('GET', `/resilience/checkpoints/${encodeURIComponent(id)}/restore`) }; } catch (err) { asking = null; toast(err.message); }
      rerender();
      root.querySelector('[data-action="cp-restore-confirm"]')?.focus();
    }
    if (a === 'cp-restore-no') { asking = null; rerender(); }
    if (a === 'cp-restore-yes') {
      const confirm = !!b.closest('.cp-confirm')?.querySelector('[data-action="cp-restore-confirm"]')?.checked;
      try {
        await api('POST', `/resilience/checkpoints/${encodeURIComponent(id)}/restore`, { confirm });
        asking = null;
        restoring = `Restoring “${label}”. Nova restarts by itself; this page carries on when it’s back.`;
        rerender();
        backAgain(label);
      } catch (err) { toast(err.message); }
    }
    if (a === 'cp-delete') { deleting = id; asking = null; rerender(); root.querySelector('[data-action="cp-delete-confirm"]')?.focus(); }
    if (a === 'cp-delete-no') { deleting = null; rerender(); }
    if (a === 'cp-delete-yes') {
      const confirm = !!b.closest('.change-confirm')?.querySelector('[data-action="cp-delete-confirm"]')?.checked;
      deleting = null;
      try { await api('POST', `/resilience/checkpoints/${encodeURIComponent(id)}/delete`, { confirm }); toast(`Deleted “${label}”.`); } catch (err) { toast(err.message); }
      await loadCheckpoints();
    }
  });
}
