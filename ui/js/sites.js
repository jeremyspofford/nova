// Settings › Connections › Site sign-ins (M10b): the sites Nova's own browser keeps something for
// (a saved sign-in, or cookies and storage in its profile), from /api/v1/browser/sites. Sign-ins
// are saved here, never in chat; their values are never shown again. Forgetting a site deletes what
// Nova's browser keeps for it, and is confirmed every time (tier 3).
import { api } from './core.js';
import { escapeHtml as esc } from './markdown.js';
import { closeSheet, openSheet, toast } from './shell.js';
import { over, waitingLine } from './wait.js';

let data = null;   // { sites, kept }
let failed = '';
let rerender = () => {};

export async function loadSites() {
  try {
    data = await api('GET', '/browser/sites');
    over('browser-sites');
    failed = '';
  } catch (e) {
    failed = e.message || 'Nova’s server didn’t answer.';
  }
  rerender();
}

const when = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }); } catch { return ''; } };

function row(s) {
  const what = [s.login ? 'A sign-in is saved' : '', s.last_at ? `used ${when(s.last_at)}` : ''].filter(Boolean).join(', ');
  return `<li class="conn" data-site="${esc(s.site)}">
  <div class="conn-head"><p class="settings-label">${esc(s.site)}</p><span class="pill ${s.login ? 'is-on' : ''}">${s.login ? 'Sign-in saved' : 'Kept data'}</span></div>
  <p class="settings-note">${esc(what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}.` : 'Nova’s browser keeps cookies for it.')}</p>
  <div class="sheet-actions"><button type="button" class="btn small quiet" data-action="forget-site" data-site="${esc(s.site)}">Forget</button></div>
</li>`;
}

export function renderSites() {
  const head = '<section class="memory-section" id="browser-sites" aria-labelledby="set-browser-sites"><h2 class="memory-heading" id="set-browser-sites">Site sign-ins</h2>';
  if (!data) return `${head}${failed ? `<p class="memory-lede">${esc(failed)}</p><button type="button" class="btn set-retry" data-action="retry-sites">Try again</button>` : waitingLine('Loading sites', { key: 'browser-sites' })}</section>`;
  const sites = data.sites ?? [];
  return `${head}
<p class="memory-lede">${esc(sites.length ? 'Nova’s own browser remembers these sites between tasks, so it stays signed in where you let it. Sign-ins are kept in Nova’s vault, each saved for the site it belongs to.' : 'Nova’s own browser hasn’t kept anything for a site yet. Save a sign-in here and Nova can sign in for you; it is saved for the site it belongs to.')}</p>
${sites.length ? `<ul class="conn-list">${sites.map(row).join('')}</ul>` : ''}
<details class="raw conn-more"><summary>Save a sign-in</summary>
<form class="site-login" data-form="site-login"><div class="field-row">
  <div><label class="field-label">Site<input class="field" name="site" type="text" autocomplete="off" spellcheck="false" placeholder="shop.example.com" required></label></div>
  <div><label class="field-label">Username<input class="field" name="username" type="text" autocomplete="off" spellcheck="false" required></label></div>
  <div><label class="field-label">Password<input class="field" name="password" type="password" autocomplete="new-password" required></label></div>
</div><p class="settings-note">Never type a password into chat; save it here instead.</p>
<div class="sheet-actions"><button type="submit" class="btn">Save sign-in</button></div></form>
</details>
</section>`;
}

function forgetSheet(s) {
  return `<form class="site-forget" data-site="${esc(s.site)}" method="dialog">
  <h2 class="sheet-title" id="sheet-title">Forget ${esc(s.site)}?</h2>
  <p class="sheet-line">Nova deletes the cookies and storage its browser keeps for ${esc(s.site)}, so the next task there starts signed out. This can’t be undone.</p>
  ${s.login ? '<label class="check"><input type="checkbox" name="login" checked> Also delete its saved sign-in</label>' : ''}
  <div class="sheet-actions">
    <button type="submit" class="btn primary">Forget it</button>
    <button type="button" class="btn quiet" data-action="close-sheet">Keep it</button>
  </div>
</form>`;
}

export function bindSites(root, render) {
  rerender = render;
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b?.dataset.action === 'retry-sites') loadSites();
    if (b?.dataset.action === 'forget-site') {
      const s = data?.sites.find((x) => x.site === b.dataset.site);
      if (s) openSheet(forgetSheet(s), { label: `Forget ${s.site}` });
    }
  });
  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('.site-login');
    if (!form) return;
    e.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    const { site, username, password } = Object.fromEntries(new FormData(form));
    try {
      const r = await api('PUT', `/browser/logins/${encodeURIComponent(String(site).trim())}`, { username, password });
      form.reset();
      toast(`A sign-in for ${r.site} is saved.`);
      await loadSites();
    } catch (err) {
      toast(err.message);
    } finally {
      button.disabled = false;
    }
  });
  document.getElementById('sheet').addEventListener('submit', async (e) => {
    const form = e.target.closest('.site-forget');
    if (!form) return;
    e.preventDefault();
    const login = !!form.querySelector('input[name="login"]')?.checked;
    try {
      const r = await api('POST', `/browser/sites/${encodeURIComponent(form.dataset.site)}/forget`, { confirm: true, login });
      closeSheet();
      toast(`${r.site} is forgotten${r.login ? ', with its sign-in' : ''}.`);
    } catch (err) { toast(err.message); }
    await loadSites();
  });
}
