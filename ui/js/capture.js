// Capture in the PWA (M6 plan §1): the indicator every page shows while anything is capturing,
// Settings › Capture (sources per device with consent and pause, what each platform can capture,
// what is never captured, the person's space signals and switch, retention), and the Capture view
// (/capture): what Nova suggests remembering, what needs a space, and recent capture, each item
// one tap from Remember or Forget. Everything shown is the server's real state.
import { api, on as onCore } from './core.js';
import { escapeHtml as esc } from './markdown.js';
import { closeSheet, openSheet, toast } from './shell.js';
import { waitingLine } from './wait.js';

let data = null;      // GET /capture: { status, sources, settings, posture }
let view = null;      // the Capture view: { recent, unclassified, proposals }
let failed = '';
let unreachable = ''; // why the last GET /capture failed: then nobody here knows whether capture is on
let redraw = () => {};

const enc = encodeURIComponent;
const when = (iso) => { try { return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const excerpt = (t, n = 220) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export const captureData = () => data;

export async function loadCapture() {
  try {
    const d = await api('GET', '/capture');
    if (!d?.status) throw new Error('Nova’s server didn’t answer.');
    data = d;
    failed = '';
    unreachable = '';
  } catch (e) {
    failed = e.message || 'Nova’s server didn’t answer.';
    unreachable = failed;
  }
  renderIndicator();
  redraw();
}

// Whether capture is on can change while this page can't hear about it: asked again when the
// connection comes back, and a little after it drops (that ask fails, and the indicator says so).
// The wait lets a page that is only being left go quietly.
let dropped = 0;
onCore('open', () => { clearTimeout(dropped); loadCapture(); });
onCore('error', () => { clearTimeout(dropped); dropped = setTimeout(loadCapture, 2000); }); // wait: retry: ask again after the connection drops
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => loadCapture());
  window.addEventListener('offline', () => { unreachable = 'You’re offline.'; renderIndicator(); });
}

export async function loadCaptureView() {
  try {
    const [recent, unclassified, proposals] = await Promise.all([
      api('GET', '/capture/events?limit=30'), api('GET', '/capture/events?unclassified=1&limit=50'), api('GET', '/capture/proposals'),
    ]);
    // An answer cut off as the page is left reads as null: kept as no answer, not drawn.
    if (![recent, unclassified, proposals].every(Array.isArray)) throw new Error('Nova’s server didn’t answer.');
    view = { recent, unclassified, proposals };
    failed = '';
  } catch (e) {
    failed = e.message || 'Nova’s server didn’t answer.';
  }
  redraw();
}

// Many events can arrive at once; the page asks again at most every few hundred milliseconds.
let soon = 0;
export function captureChanged(viewShowing) {
  clearTimeout(soon);
  soon = setTimeout(() => { loadCapture(); if (viewShowing()) loadCaptureView(); }, 300); // wait: debounce: many events at once
}

// ---- the indicator ---------------------------------------------------------------------------

// On every page while any source is capturing (the top bar is kept even on a phone's Home for it).
// When Nova's server can't be reached, capture may still be on there: the indicator says the state
// is unknown rather than hiding.
export function renderIndicator() {
  const a = document.getElementById('capture-ind');
  if (!a) return;
  const s = data?.status;
  const on = !!s?.active || !!unreachable;
  document.body.dataset.capturing = on ? 'on' : 'off';
  a.hidden = !on;
  if (!on) return;
  if (unreachable) {
    a.classList.add('is-warn');
    a.querySelector('.capture-word').textContent = 'Capture state unknown';
    a.setAttribute('aria-label', 'Capture state unknown: Nova’s server isn’t answering, so this page can’t tell whether anything is capturing. Open Capture.');
    a.title = `${unreachable} Capture may still be on.`;
    return;
  }
  const names = s.capturing.map((c) => (c.device ? `${c.name} on ${c.device}` : c.name));
  a.classList.toggle('is-warn', !!s.problem);
  a.querySelector('.capture-word').textContent = s.problem ? 'Capture needs you' : 'Capturing';
  a.setAttribute('aria-label', `${s.problem ? 'Capture needs you' : 'Capturing'}: ${names.join(', ')}. Open Capture.`);
  a.title = s.problem ?? `Capturing: ${names.join(', ')}`;
}

// ---- Settings › Capture ----------------------------------------------------------------------

const STATE = (s) => (!s.enabled ? ['Off', ''] : s.paused ? ['Paused', ''] : s.status === 'unreachable' || s.status === 'refused' || s.status === 'elsewhere' || s.status === 'needs_key' ? ['Needs you', 'is-warn'] : ['Capturing', 'is-on']);

function counts(s) {
  const c = s.counts ?? {};
  const kept = c.kept ? `${plural(c.kept, 'item')} kept` : 'Nothing kept yet';
  const left = [c.private ? `${c.private} private` : '', c.sensitive_app ? `${c.sensitive_app} from a password manager or bank` : '', c.excluded ? `${c.excluded} excluded` : ''].filter(Boolean);
  return `${kept}${left.length ? `; ${left.join(', ')} never stored` : ''}.`;
}

// Pausing stops what Nova takes in, not Screenpipe itself, which keeps recording on its computer.
const PAUSED_SCREENPIPE = 'Paused: Nova takes nothing in from it. Screenpipe itself keeps recording on its computer until you pause it there too.';

function sourceRow(s) {
  const [word, tone] = STATE(s);
  const where = s.device?.name ? ` on ${s.device.name}` : '';
  const note = s.enabled
    ? [s.paused && s.adapter === 'screenpipe' ? PAUSED_SCREENPIPE : '', s.detail ?? '', counts(s), s.consent ? `On since ${when(s.consent.at)}.` : ''].filter(Boolean).join(' ')
    : s.adapter === 'screenpipe' ? `Takes screen text, audio transcripts and the app and window from Screenpipe at ${s.url}. Off until you turn it on.` : `This device offers ${s.kinds.join(', ')}. Off until you turn it on.`;
  const act = (action, label, extra = '') => `<button type="button" class="btn small${extra}" data-action="${action}" data-source="${esc(s.id)}">${label}</button>`;
  const actions = !s.enabled ? act('capture-on', 'Turn on') : `${s.paused ? act('capture-resume', 'Resume') : act('capture-pause', 'Pause')}${act('capture-off', 'Turn off', ' quiet')}`;
  return `<li class="conn" data-source="${esc(s.id)}">
  <div class="conn-head"><p class="settings-label">${esc(s.name)}${esc(where)}</p><span class="pill ${tone}">${word}</span></div>
  <p class="settings-note">${esc(note)}</p>
  <div class="sheet-actions">${actions}</div>
  ${s.adapter === 'screenpipe' ? screenpipeEdit(s) : ''}
</li>`;
}

// A saved Screenpipe's address, how far back each pull asks again, and its API key. The key is a
// password field that is never filled in: Nova keeps it in its vault and never shows it back.
function screenpipeEdit(s) {
  const open = s.status === 'needs_key' || s.status === 'unreachable';
  return `<details class="raw capture-edit"${open ? ' open' : ''}><summary>Address and API key</summary>
<form class="capture-form" data-form="screenpipe-edit" data-source="${esc(s.id)}"><div class="field-row">
<div><label class="field-label">Screenpipe’s address<input class="field" name="url" value="${esc(s.url)}" autocomplete="off" spellcheck="false" required></label></div>
<div><label class="field-label">Ask again for the last (minutes)<input class="field" name="lookback_minutes" type="number" min="1" max="240" step="1" value="${esc(s.lookback_minutes)}" required></label></div>
<div><label class="field-label">API key${s.has_api_key ? ' (saved; type a new one to replace it)' : ' (if Screenpipe asks for one)'}<input class="field" name="api_key" type="password" autocomplete="new-password" spellcheck="false" placeholder="${s.has_api_key ? '••••••••' : 'From Screenpipe’s Settings › Privacy'}"></label></div>
</div>
<p class="settings-note">${s.has_api_key ? 'A key is saved. Nova keeps it in its vault and sends it with every request to Screenpipe.' : 'No key saved. Screenpipe asks for one only if its API key is turned on.'}</p>
<div class="sheet-actions"><button type="submit" class="btn small">Save</button>${s.has_api_key ? `<button type="button" class="btn small quiet" data-action="capture-key-remove" data-source="${esc(s.id)}">Remove the key</button>` : ''}</div></form></details>`;
}

// What each kind of exclusion keeps out, said plainly: audio has no app or site, so only a time
// window or a space keeps it out.
const COVERS = {
  app: 'Screen text and activity in it, and its editions (Beta and so on). Audio has no app, so this doesn’t stop audio: use a time window, or pause.',
  site: 'Pages there, by their address, or in a browser by the window title or the text on screen. Audio isn’t tied to a site, so this doesn’t stop audio.',
  space: 'Everything filed in that space, audio included.',
  time: 'Everything in those hours, audio included, even a recording that only runs into them.',
};

function exclusionText(e) {
  if (e.kind === 'app') return `The app ${e.app}`;
  if (e.kind === 'site') return `The site ${e.site}`;
  if (e.kind === 'space') return `Anything in the ${e.space} space`;
  return `${e.window.start}–${e.window.end}${e.window.days ? (e.window.days.join() === '1,2,3,4,5' ? ' on weekdays' : ' on some days') : ' every day'}`;
}
const exclusionLine = (e) => `${exclusionText(e)}. ${COVERS[e.kind] ?? ''}`.trim();

function signalText(s) {
  if (s.kind === 'app') return `${s.app} → ${s.space}`;
  if (s.kind === 'device') return `${deviceName(s.device)} → ${s.space}`;
  return `${s.window.start}–${s.window.end}${s.window.days?.join() === '1,2,3,4,5' ? ' on weekdays' : ''} → ${s.space}`;
}
const deviceName = (id) => data?.sources.find((s) => s.device.id === id)?.device.name ?? 'a device';

const listOf = (items, text, action, line = text) => (items.length
  ? `<ul class="capture-rules">${items.map((x, i) => `<li><span>${esc(line(x))}</span><button type="button" class="btn small quiet" data-action="${action}" data-index="${i}" aria-label="Remove: ${esc(text(x))}">Remove</button></li>`).join('')}</ul>`
  : '');

export function renderCaptureSettings() {
  const head = '<section class="memory-section" id="capture" aria-labelledby="set-capture"><h2 class="memory-heading" id="set-capture">Capture</h2>';
  if (!data) return `${head}${failed ? `<p class="memory-lede">${esc(failed)}</p><button type="button" class="btn set-retry" data-action="retry-capture">Try again</button>` : waitingLine('Loading capture', { key: 'capture' })}</section>`;
  const { status, sources, settings, posture } = data;
  const screenpipe = sources.find((s) => s.adapter === 'screenpipe');
  const lede = 'What Nova may see on your devices, for context. Each source starts turned off, and the top bar shows when capture is on. What is captured is kept on your own devices.';
  const now = status.active
    ? `Capturing from ${status.capturing.map((c) => c.name).join(', ')}. ${plural(status.today, 'item')} in the last day.`
    : status.paused ? `Paused (${plural(status.paused, 'source')}): Nova takes nothing in. Screenpipe keeps recording on its computer until you pause it there too.` : 'Off.';
  const spaces = settings.spaces;
  const spaceOptions = spaces.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  return `${head}
<p class="memory-lede">${esc(lede)}</p>
<div class="capture-now"><p class="settings-note">${esc(now)}</p><div class="sheet-actions">
${status.active ? '<button type="button" class="btn small" data-action="capture-pause-all">Pause all</button>' : status.paused ? '<button type="button" class="btn small" data-action="capture-resume-all">Resume all</button>' : ''}
<a class="btn small" href="/capture">Open Capture</a></div></div>
<h3 class="conn-sub">Sources</h3>
${sources.length ? `<ul class="conn-list">${sources.map(sourceRow).join('')}</ul>` : '<p class="settings-note">No source yet. A paired computer lists what it can capture here once its device agent says so.</p>'}
${screenpipe ? '' : `<form class="capture-form" data-form="screenpipe"><div class="field-row"><div><label class="field-label">Screenpipe’s address<input class="field" name="url" value="http://localhost:3030" autocomplete="off" spellcheck="false" required></label></div>
<div><label class="field-label">API key (if Screenpipe asks for one)<input class="field" name="api_key" type="password" autocomplete="new-password" spellcheck="false" placeholder="From Screenpipe’s Settings › Privacy"></label></div></div>
<p class="settings-note">If Screenpipe runs on this computer, Nova can take in what it records. It stays off until you turn it on.</p>
<div class="sheet-actions"><button type="submit" class="btn small">Add Screenpipe</button></div></form>`}
<details class="raw"><summary>What each kind of device can capture</summary><ul class="capture-posture">${posture.map((p) => `<li><p class="settings-label">${esc(p.label)}</p><p class="settings-note">${esc(p.can)}</p></li>`).join('')}</ul></details>
<h3 class="conn-sub">Never captured</h3>
<p class="settings-note">Private and incognito windows, always: Nova recognises them by the window’s title, in the major browsers’ common languages. That is a best effort, so also list them in Screenpipe’s own ignored-windows setting, which stops Screenpipe recording them at all. Password managers and banking apps and sites, recognised by their names: also a best effort. And anything you list here.</p>
<p class="settings-note">Before it is kept, text shaped like a key, a token, a password, a card or bank account number is blanked out. Then a model on this device checks the rest for passwords, keys and someone’s money or health details. Until a model this device trusts for that has checked it, captured text is held, not added to memory.</p>
${listOf(settings.exclusions, exclusionText, 'capture-unexclude', exclusionLine)}
<form class="capture-form" data-form="exclusion"><div class="field-row">
<div><label class="field-label">Kind<select class="field" name="kind"><option value="app">An app</option><option value="site">A site</option><option value="space">A space</option><option value="time">A time of day</option></select></label></div>
<div><label class="field-label">Which (an app, a site, a space, or 12:00–13:00)<input class="field" name="value" autocomplete="off" spellcheck="false" required></label></div>
</div><div class="sheet-actions"><button type="submit" class="btn small">Add</button></div></form>
<h3 class="conn-sub">Spaces</h3>
<p class="settings-note">Nova files capture into a space only by what you set here: an app, a device, or your hours. Anything unclear stays unclassified until you say.</p>
${listOf(settings.signals, signalText, 'capture-unsignal')}
<form class="capture-form" data-form="signal"><div class="field-row">
<div><label class="field-label">When<select class="field" name="kind"><option value="app">I use the app</option><option value="calendar">It’s these hours (09:00–17:00)</option></select></label></div>
<div><label class="field-label">App or hours<input class="field" name="value" autocomplete="off" spellcheck="false" required></label></div>
<div><label class="field-label">Space<input class="field" name="space" list="capture-spaces" autocomplete="off" spellcheck="false" required></label></div>
</div><datalist id="capture-spaces">${spaceOptions}</datalist><div class="sheet-actions"><button type="submit" class="btn small">Add</button></div></form>
<div class="capture-switch"><p class="settings-label">Right now</p>
<p class="settings-note">${settings.switch ? `Everything goes to ${esc(settings.switch.space)} since ${esc(when(settings.switch.since))}, whatever else says.` : 'No switch on: the rules above decide.'}</p>
<div class="sheet-actions">${settings.switch ? '<button type="button" class="btn small" data-action="capture-switch-off">End the switch</button>' : `<label class="sr-only" for="capture-switch-space">Space</label><select class="field capture-inline" id="capture-switch-space">${spaceOptions}</select><button type="button" class="btn small" data-action="capture-switch-on">Switch to it</button>`}</div></div>
<h3 class="conn-sub">Keep capture for</h3>
<div class="sheet-actions"><label class="sr-only" for="capture-days">Days</label><input class="field capture-inline" id="capture-days" type="number" min="1" max="3650" value="${settings.retention_days}"><span class="settings-note">days, then it is deleted for good. What you remember from it stays in Memory.</span><button type="button" class="btn small" data-action="capture-retention">Save</button></div>
</section>`;
}

// ---- the Capture view (/capture) ---------------------------------------------------------------

// Screening, job 1: every event that isn't simply checked shows its state and Nova's own reason,
// so nothing is held, redacted or excluded silently. The words are Nova's (the server's), never a
// model's. An event that isn't usable can't be remembered here either.
const sensitivity = (e) => e.sensitivity ?? { state: 'index', usable: true, label: '', why: null, detail: null };
const SENSITIVE_TONE = { unscreened: 'is-warn', held: 'is-warn', redact: '', hold: 'is-warn', exclude: 'is-warn' };
// What a held or sensitive event's words are shown as: behind a tap, not on the page as it opens.
const HIDDEN = new Set(['unscreened', 'held', 'hold']);

function sensitivityPill(e) {
  const s = sensitivity(e);
  if (s.state === 'index') return '';
  // A redaction's label says what was redacted ("Redacted: a card number."), the rest say what
  // happened and their reason follows.
  const label = s.state === 'redact' ? (s.why ?? s.label).replace(/\.$/, '') : s.label;
  return `<span class="pill ${SENSITIVE_TONE[s.state] ?? ''}" data-sensitivity="${esc(s.state)}">${esc(label)}</span>`;
}

// The decision behind it, as the decision asks: template version, the seat and model that answered,
// the scores, and the capture source.
function screeningRecord(e) {
  const s = sensitivity(e);
  const d = s.detail;
  if (!d) return '';
  const rows = [];
  rows.push(`Check: ${d.template}${d.version ? ` v${d.version}` : ''}.`);
  if (d.rules?.redacted?.length) rows.push(`Nova’s own rules redacted, before it was kept: ${d.rules.redacted.join(', ')} (in ${d.rules.fields.join(', ')}).`);
  if (d.decision) {
    rows.push(d.decision.trust === 'verdict' ? `Answered by ${d.decision.seat} (${d.decision.model}), which passed this check’s test.` : d.decision.model?.startsWith('rules@') ? 'Decided by Nova’s own rules, with no model.' : 'No model trusted for this check answered.');
    if (d.decision.scores) rows.push(`Scores: ${Object.entries(d.decision.scores).map(([k, v]) => `${k.replace(/_/g, ' ')} ${typeof v === 'number' ? v.toFixed(2) : '–'}`).join(', ')}.`);
    rows.push(`Decision ${d.decision.id}, ${when(d.decision.at)}.`);
  }
  rows.push(`Capture source: ${d.capture_source}.`);
  return `<details class="raw capture-record"><summary>How this was checked</summary><ul>${rows.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>`;
}

function eventText(e, n = 220) {
  const s = sensitivity(e);
  if (!e.text) return '';
  if (HIDDEN.has(s.state)) return `<details class="raw"><summary>Show what was captured</summary><p class="capture-text">${esc(excerpt(e.text, n))}</p></details>`;
  return `<p class="capture-text">${esc(excerpt(e.text, n))}</p>`;
}

function eventLine(e) {
  const what = [e.app, e.window_title].filter(Boolean).join(' · ') || e.kind;
  return `<p class="capture-meta"><span>${esc(when(e.at))}</span><span>${esc(what)}</span>${e.device?.name ? `<span>${esc(e.device.name)}</span>` : ''}${e.space ? `<span class="pill">${esc(e.space)}</span>` : '<span class="pill is-warn">Unclassified</span>'}${e.promoted?.length ? '<span class="pill is-on">Remembered</span>' : ''}${sensitivityPill(e)}</p>`;
}

function eventItem(e) {
  const s = sensitivity(e);
  // The reason, where the label doesn't already say it: a redaction's label names what, and a held
  // item's notice is on the holding card above.
  const notice = data?.status?.screening?.notice;
  const shown = s.state === 'hold' || s.state === 'exclude' || (s.state === 'held' && !!notice && !s.why?.startsWith(notice));
  const why = shown && s.why ? `<p class="settings-note capture-why">${esc(s.why)}</p>` : '';
  const remember = e.promoted?.length || !s.usable ? '' : `<button type="button" class="btn small" data-action="capture-remember" data-event="${esc(e.id)}">Remember</button>`;
  return `<li class="capture-item" data-event="${esc(e.id)}" data-sensitivity="${esc(s.state)}">${eventLine(e)}${why}${eventText(e)}${screeningRecord(e)}
  <div class="sheet-actions">${remember}<button type="button" class="btn small quiet" data-action="capture-forget" data-event="${esc(e.id)}">Forget</button></div></li>`;
}

// The holding area (option B): what waits for a trusted check, with the owner's notice and what
// stands in the way on this device.
function holdingCard(s) {
  const h = s.screening;
  if (!h || !(h.held + h.unscreened)) return '';
  const lines = h.held ? [h.notice, h.why].filter(Boolean) : ['They are waiting for Nova’s check for private details.'];
  return `<section class="card capture-card capture-holding" aria-labelledby="cap-held"><h3 class="card-title" id="cap-held">Held, not kept</h3>
<p class="settings-note">${esc(`${plural(h.held + h.unscreened, 'item')} ${h.held + h.unscreened === 1 ? 'is' : 'are'} held: not added to memory, and deleted with the rest of capture after ${plural(data.settings.retention_days, 'day')} unless checked first.`)}</p>
${lines.map((l) => `<p class="settings-note">${esc(l)}</p>`).join('')}
${h.held && !h.trusted ? '<div class="sheet-actions"><a class="btn small" href="/settings#models">Settings › Models</a></div>' : ''}</section>`;
}

export function renderCaptureView() {
  const head = '<header class="view-head"><h2 class="view-title">Capture</h2>';
  if (!data || !view) return `${head}${failed ? `<p class="memory-lede">${esc(failed)}</p></header><button type="button" class="btn set-retry" data-action="retry-capture">Try again</button>` : `${waitingLine('Loading capture', { key: 'capture-view' })}</header>`}`;
  const s = data.status;
  const line = s.active ? `Capturing from ${s.capturing.map((c) => c.name).join(', ')}. ${plural(s.today, 'item')} in the last day.` : s.paused ? 'Capture is paused.' : 'Capture is off.';
  const out = [`${head}<p class="memory-lede">${esc(line)}${s.problem ? ` ${esc(s.problem)}` : ''} <a href="/settings#capture">Capture settings</a></p></header>`];
  const { proposals, unclassified, recent } = view;
  if (!recent.length && !proposals.length) {
    out.push(`<div class="card empty-state"><p class="empty-title">${s.active ? 'Nothing captured yet' : 'Nothing is being captured'}</p><p class="empty-sub">${s.active ? 'What your sources capture shows up here as it arrives.' : 'Turn on a source in Settings › Capture, and what it captures shows up here.'}</p></div>`);
    return out.join('');
  }
  out.push(holdingCard(s));
  // One standout: remembering what Nova suggests, when it suggests anything.
  if (proposals.length) {
    const [p, ...more] = proposals;
    out.push(`<section class="card capture-card" aria-labelledby="cap-suggest"><h3 class="card-title" id="cap-suggest">Nova suggests remembering</h3>
${eventLine(p.event)}<p class="capture-text">${esc(excerpt(p.event.text, 400))}</p>
<div class="sheet-actions"><button type="button" class="btn primary" data-action="capture-accept" data-proposal="${esc(p.id)}">Remember this</button><button type="button" class="btn quiet" data-action="capture-dismiss" data-proposal="${esc(p.id)}">Not this</button></div>
${more.length ? `<p class="settings-note">${plural(more.length, 'more suggestion')} after this one.</p>` : ''}</section>`);
  }
  if (unclassified.length) {
    const [u, ...more] = unclassified;
    const spaces = data.settings.spaces;
    out.push(`<section class="card capture-card" aria-labelledby="cap-sort"><h3 class="card-title" id="cap-sort">Which space is this?</h3>
<p class="settings-note">${plural(unclassified.length, 'item')} didn’t match what you set, so Nova left ${unclassified.length === 1 ? 'it' : 'them'} unclassified rather than guess.</p>
<div class="capture-sort" data-event="${esc(u.id)}">${eventLine(u)}${eventText(u)}
<div class="sheet-actions">${spaces.map((sp) => `<button type="button" class="btn small" data-action="capture-space" data-event="${esc(u.id)}" data-space="${esc(sp)}">${esc(sp)}</button>`).join('')}</div>
${u.app ? `<label class="capture-check"><input type="checkbox" id="capture-always"> Always put ${esc(u.app)} there</label>` : ''}</div>
${more.length ? `<details class="raw"><summary>${plural(more.length, 'more')}</summary><ul class="capture-list">${more.map(eventItem).join('')}</ul></details>` : ''}</section>`);
  }
  out.push(`<section class="card capture-card" aria-labelledby="cap-recent"><h3 class="card-title" id="cap-recent">Recent</h3>
<p class="settings-note">Captured evidence, not memory: it is deleted after ${plural(data.settings.retention_days, 'day')} unless you remember something from it.</p>
<ul class="capture-list">${recent.map(eventItem).join('')}</ul></section>`);
  return out.join('');
}

// ---- sheets ------------------------------------------------------------------------------------

const findEvent = (id) => [...(view?.recent ?? []), ...(view?.unclassified ?? []), ...(view?.proposals ?? []).map((p) => p.event)].find((e) => e.id === id);

// The space is the event's when it has one; otherwise the person says, never a silent default.
// With a proposal, the same sheet accepts it.
function rememberSheet(e, proposal = null) {
  const spaces = data?.settings.spaces ?? [];
  return `<form class="capture-remember" data-event="${esc(e.id)}"${proposal ? ` data-proposal="${esc(proposal)}"` : ''} method="dialog">
  <h2 class="sheet-title" id="sheet-title">Remember this?</h2>
  <p class="sheet-line">It becomes a memory, noting it came from what was captured ${esc(when(e.at))}${e.app ? ` in ${esc(e.app)}` : ''}.</p>
  <label class="field-label">What to remember<textarea class="field" name="content" rows="4" required>${esc(e.text ?? '')}</textarea></label>
  <label class="field-label">Which space${e.space ? '' : ' (it has none yet)'}<input class="field" name="scope" value="${esc(e.space ?? '')}" list="capture-remember-spaces" placeholder="${esc(spaces.join(', '))}" autocomplete="off" spellcheck="false" required></label>
  <datalist id="capture-remember-spaces">${spaces.map((sp) => `<option value="${esc(sp)}">`).join('')}</datalist>
  <div class="sheet-actions"><button type="submit" class="btn primary">Remember</button><button type="button" class="btn quiet" data-action="close-sheet">Cancel</button></div>
</form>`;
}

function forgetSheet(e) {
  return `<form class="capture-forget" data-event="${esc(e.id)}" method="dialog">
  <h2 class="sheet-title" id="sheet-title">Forget this for good?</h2>
  <p class="sheet-line">Nova deletes it here and passes the forget on to its backups and the standby, so it isn’t taken in again.${e.promoted?.length ? ' The memory you made from it goes too.' : ''}</p>
  <div class="sheet-actions"><button type="submit" class="btn primary">Forget</button><button type="button" class="btn quiet" data-action="close-sheet">Keep it</button></div>
</form>`;
}

// ---- actions -----------------------------------------------------------------------------------

// `form`, when given, is reset once the change is saved: what was typed is now what Nova has, and a
// failed change leaves it as typed, to fix.
async function act(fn, done, form = null) {
  try {
    const r = await fn();
    form?.reset();
    if (done) toast(typeof done === 'function' ? done(r) : done);
  } catch (e) { toast(e.message); }
  await loadCapture();
  if (view) await loadCaptureView();
}

function parseWindow(v) {
  const m = /^\s*([01]\d|2[0-3]):([0-5]\d)\s*[–-]\s*([01]\d|2[0-3]):([0-5]\d)\s*$/.exec(v);
  return m ? { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}` } : null;
}

// Wires Settings › Capture and the Capture view. `render` redraws whichever is on screen.
export function bindCapture(roots, render) {
  redraw = render;
  const src = (b) => `/capture/sources/${enc(b.dataset.source)}`;
  for (const root of roots) {
    root.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-action]');
      const a = b?.dataset.action;
      if (!a || !a.startsWith('capture') && a !== 'retry-capture') return;
      const s = data?.settings;
      if (a === 'retry-capture') { loadCapture(); loadCaptureView(); }
      else if (a === 'capture-on') act(() => api('POST', `${src(b)}/enable`), (r) => `${r.name} is on. The top bar shows while it captures.`);
      else if (a === 'capture-off') act(() => api('POST', `${src(b)}/disable`), (r) => `${r.name} is off.`);
      else if (a === 'capture-key-remove') act(() => api('PATCH', src(b), { api_key: null }), 'The key is removed.');
      else if (a === 'capture-pause') act(() => api('POST', `${src(b)}/pause`), (r) => (r.adapter === 'screenpipe' ? `${r.name} is paused: Nova takes nothing in. Screenpipe keeps recording until you pause it there too.` : `${r.name} is paused.`));
      else if (a === 'capture-resume') act(() => api('POST', `${src(b)}/resume`), (r) => `${r.name} is capturing again, from now.`);
      else if (a === 'capture-pause-all') act(() => api('POST', '/capture/pause', { paused: true }), 'Capture is paused: Nova takes nothing in. Screenpipe keeps recording until you pause it there too.');
      else if (a === 'capture-resume-all') act(() => api('POST', '/capture/pause', { paused: false }), 'Capture is on again, from now.');
      else if (a === 'capture-unexclude') act(() => api('PUT', '/capture/settings', { exclusions: s.exclusions.filter((_, i) => i !== Number(b.dataset.index)) }), 'Removed.');
      else if (a === 'capture-unsignal') act(() => api('PUT', '/capture/settings', { signals: s.signals.filter((_, i) => i !== Number(b.dataset.index)) }), 'Removed.');
      else if (a === 'capture-switch-on') act(() => api('PUT', '/capture/settings', { switch: { space: document.getElementById('capture-switch-space').value } }), 'Switched.');
      else if (a === 'capture-switch-off') act(() => api('PUT', '/capture/settings', { switch: null }), 'The switch is off.');
      else if (a === 'capture-retention') act(() => api('PUT', '/capture/settings', { retention_days: Number(document.getElementById('capture-days').value) }), 'Saved.');
      else if (a === 'capture-space') {
        const always = document.getElementById('capture-always')?.checked;
        act(() => api('POST', `/capture/events/${enc(b.dataset.event)}/space`, { space: b.dataset.space, ...(always ? { remember: 'app' } : {}) }), `Filed under ${b.dataset.space}.`);
      } else if (a === 'capture-accept') {
        const p = view?.proposals.find((x) => x.id === b.dataset.proposal);
        if (p) openSheet(rememberSheet(p.event, p.id), { label: 'Remember this' });
      }
      else if (a === 'capture-dismiss') act(() => api('POST', `/capture/proposals/${enc(b.dataset.proposal)}/dismiss`), 'Left as evidence.');
      else if (a === 'capture-remember' || a === 'capture-forget') {
        const e = findEvent(b.dataset.event);
        if (e) openSheet(a === 'capture-remember' ? rememberSheet(e) : forgetSheet(e), { label: a === 'capture-remember' ? 'Remember this' : 'Forget this' });
      }
    });
    root.addEventListener('submit', (ev) => {
      const form = ev.target.closest('.capture-form');
      if (!form) return;
      ev.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const s = data?.settings;
      if (form.dataset.form === 'screenpipe') act(() => api('POST', '/capture/sources/screenpipe', { url: f.url, ...(f.api_key ? { api_key: f.api_key } : {}) }), 'Screenpipe is added. It stays off until you turn it on.', form);
      else if (form.dataset.form === 'screenpipe-edit') {
        const body = { url: f.url, lookback_minutes: Number(f.lookback_minutes), ...(f.api_key ? { api_key: f.api_key } : {}) };
        act(() => api('PATCH', `/capture/sources/${enc(form.dataset.source)}`, body), f.api_key ? 'Saved, with the new key.' : 'Saved.', form);
      }
      else if (form.dataset.form === 'exclusion') {
        const v = String(f.value).trim();
        const rule = f.kind === 'time' ? { kind: 'time', window: parseWindow(v) ?? { start: v, end: v } } : { kind: f.kind, [f.kind]: v };
        const said = { app: 'Added. Nova won’t take in screen text from it; audio has no app, so this doesn’t stop audio.', site: 'Added. Nova won’t take in pages there; audio isn’t tied to a site.', space: 'Added. Nothing filed in that space is kept, audio included.', time: 'Added. Nothing from those hours is kept, audio included.' };
        act(() => api('PUT', '/capture/settings', { exclusions: [...s.exclusions, rule] }), said[f.kind] ?? 'Added.', form);
      } else if (form.dataset.form === 'signal') {
        const v = String(f.value).trim();
        const rule = f.kind === 'calendar' ? { kind: 'calendar', window: parseWindow(v) ?? { start: v, end: v }, space: f.space } : { kind: 'app', app: v, space: f.space };
        act(() => api('PUT', '/capture/settings', { signals: [...s.signals, rule] }), 'Added.', form);
      }
    });
  }
  document.getElementById('sheet').addEventListener('submit', (ev) => {
    const form = ev.target.closest('.capture-remember, .capture-forget');
    if (!form) return;
    ev.preventDefault();
    const id = form.dataset.event;
    if (form.classList.contains('capture-remember')) {
      const f = Object.fromEntries(new FormData(form));
      const body = { content: f.content, scope: String(f.scope).trim() };
      const send = form.dataset.proposal ? () => api('POST', `/capture/proposals/${enc(form.dataset.proposal)}/accept`, body) : () => api('POST', '/capture/promote', { event_ids: [id], ...body });
      act(async () => { const r = await send(); closeSheet(); return r; }, 'Remembered. It’s in Memory, with where it came from.');
    } else {
      act(async () => { const r = await api('DELETE', `/capture/events/${enc(id)}`); closeSheet(); return r; }, (r) => (r.memories.length ? 'Forgotten, with the memory made from it.' : 'Forgotten.'));
    }
  });
}
