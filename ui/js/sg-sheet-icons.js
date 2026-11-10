// The "Sheet" status icon style, design-first (2026-11-09): compositions for the owner's reaction,
// before any wiring. On the review page the owner kept the tiles of the agent state sheet
// (docs/builder-packet/ui-references/nova-agent-state-system-sheet-2026-11-08.jpg) "as another style
// theme for users to choose from". Styleguide only: the app never loads this file or the crops, and
// nothing here is saved or sent; the style choice is a specimen.
//
// The tiles are the owner's artwork, never redrawn: scripts/sheet-icons.js crops each one, its
// rounded frame and all, pixel for pixel into ui/icons/state-sheet-<tile>-246.webp (246 px is the
// largest the sheet honestly gives: its tiles are 232 px tall and up to 244 wide). A state in this
// style is a crop plus treatment only. Drawn from the real model (ui/js/status-icon.js): ten states
// (STATUS_ICON_STATES); a change takes MORPH_MS (800 ms) on the same soft ease, and retargets from
// what is on screen; success settles to idle by itself after SUCCESS_MS; with reduced motion a change
// swaps straight. The crossfades below are StatusModel's own weights at each moment, the crops mixed
// by them. The sheet has eight tiles; listening and speaking have none, and are drawn as gaps.
// Sizes in the app (shell.js LIVE_PX): the hero 112 px, the rail 32 px, a phone's top bar 24 px.
// Its CSS is ui/styles/compositions.css (.ss-*).
import { ICONS } from './components.js';
import { escapeHtml as esc } from './markdown.js';
import { ICON_WORDS } from './status.js';
import { MORPH_MS, STATUS_ICON_STATES, SUCCESS_MS, StatusModel, markSvg, statusIcon } from './status-icon.js';
import { SKY_BAND } from './sg-compositions.js';

// Every frame: [state, what it shows].
export const SS_FRAMES = [
  ['sizes', 'Every state at 16, 24, 48, 96 and 180 px: today’s Mark beside the Sheet tile it would use'],
  ['small', 'Is it still legible? Each tile at 16 and 24 px, the downscale enlarged pixel for pixel, with a verdict'],
  ['no-tile', 'Listening and speaking: no tile on your sheet, and the candidates side by side'],
  ['change', 'A state change as frames: the crops crossfaded by the real model’s weights, 800 ms on its ease'],
  ['rail', 'In the rail, while Nova works: the WORKING tile at 32 px'],
  ['hero', 'The empty chat’s hero: the IDLE tile at 112 px'],
  ['phone-bar', 'A phone’s top bar: the WORKING tile at 24 px'],
  ['appearance', 'Proposed in Settings › Appearance: choose Mark or Sheet, as designs are chosen'],
];
export const isSsFrame = (s) => SS_FRAMES.some(([k]) => k === s);

// The model's states onto the sheet's tiles. Amber is WARNING, for needs-you only; red is ERROR, for
// stopped only. Listening and speaking have no tile.
const TILE = { idle: 'idle', working: 'working', thinking: 'thinking', success: 'success', 'needs-you': 'warning', stopped: 'error', paused: 'paused', offline: 'offline' };
const NO_TILE = ['listening', 'speaking'];
const CANDIDATES = ['working', 'thinking', 'idle'];
const SIZES = [180, 96, 48, 24, 16];
const PX = { hero: 112, rail: 32, mini: 24 }; // shell.js LIVE_PX
const CROP_PX = 246;
const src = (tile) => `/icons/state-sheet-${tile}-${CROP_PX}.webp`;
const NAME = (tile) => tile.toUpperCase();
const icon = (name) => ICONS[name] ?? '';
const tileImg = (tile, px, alt = '') => `<img class="ss-img" src="${src(tile)}" width="${px}" height="${px}" alt="${esc(alt)}" decoding="async">`;
const markSlot = (state, px) => `<span class="ss-mark" data-ss-mark="${state}" data-ss-px="${px}" aria-hidden="true"></span>`;

// What 16 and 24 px do to each tile, looked at in this entry's own enlarged downscales: said
// plainly, not fixed by redrawing. The tile's own frame takes about a sixth of each side, so at 16 px
// the artwork inside is about 13 px across.
const VERDICT = {
  idle: ['Weak', 'At 16 px a swirl with an orange heart: told from THINKING and OFFLINE by that orange, not by its shape. At 24 px the spiral reads.'],
  working: ['Weak', 'At 16 px a tilted ring with an orange end; its two speed lines are gone. Close to IDLE at a glance. At 24 px the ring and its hole read.'],
  thinking: ['Weak', 'At 16 px a blue swirl, the spiral only just there: IDLE without the orange, or OFFLINE brighter. At 24 px it reads.'],
  success: ['Legible', 'The check holds at 16 px, green against violet.'],
  warning: ['Legible', 'The triangle holds at 16 px, and amber says it too.'],
  error: ['Legible', 'The X holds at 16 px, and red says it too.'],
  paused: ['Legible', 'The two bars hold at 16 px: the clearest shape on the sheet.'],
  offline: ['Mush', 'At 16 px a dim navy smudge on the dark tile: the swirl is gone, and on a dark page the whole icon nearly disappears. It reads as “off”, not as a shape. At 24 px the swirl is faint.'],
};

// ---- the frames --------------------------------------------------------------------------------

function sizes(id) {
  const block = (state) => {
    const tile = TILE[state];
    const sheet = tile
      ? `<div class="ss-sizes">${SIZES.map((px) => tileImg(tile, px, px === 180 ? `${NAME(tile)} tile` : '')).join('')}</div>`
      : `<div class="ss-none"><p class="au-block-head">No tile on your sheet</p><p class="au-note">See “Listening and speaking” for the candidates.</p></div>`;
    return `<section class="ss-state" aria-labelledby="${id}-${state}"><h4 class="ss-h" id="${id}-${state}">${esc(state)} <span class="uc-faint">· ${tile ? `your sheet’s ${NAME(tile)}` : 'no tile'}</span></h4>
<p class="ss-label">Mark, today</p><div class="ss-sizes">${SIZES.map((px) => markSlot(state, px)).join('')}</div>
<p class="ss-label">Sheet</p>${sheet}</section>`;
  };
  return `<p class="au-note ss-lede">Each row: 180, 96, 48, 24 and 16 px. The Mark is today’s status icon, live; the Sheet is the crop of your tile, the browser’s own downscale of ${CROP_PX} px. Amber is only for needs-you and red only for stopped, on both.</p>${STATUS_ICON_STATES.map(block).join('')}`;
}

function small(id) {
  const row = (state) => {
    const tile = TILE[state];
    const [word, why] = VERDICT[tile];
    return `<li class="ss-legible" aria-labelledby="${id}-${tile}"><h4 class="ss-h" id="${id}-${tile}">${NAME(tile)} <span class="uc-faint">· ${esc(state)}</span></h4>
<div class="ss-sizes ss-small"><figure class="ss-fig">${tileImg(tile, 16)}<figcaption class="ss-cap">16 px</figcaption></figure><figure class="ss-fig">${tileImg(tile, 24)}<figcaption class="ss-cap">24 px</figcaption></figure>
<figure class="ss-fig"><canvas class="ss-zoom" data-ss-zoom="${tile}" data-ss-px="16" data-ss-k="8" aria-hidden="true"></canvas><figcaption class="ss-cap">16 px, each pixel 8×</figcaption></figure>
<figure class="ss-fig"><canvas class="ss-zoom" data-ss-zoom="${tile}" data-ss-px="24" data-ss-k="6" aria-hidden="true"></canvas><figcaption class="ss-cap">24 px, each pixel 6×</figcaption></figure></div>
<p class="ss-verdict"><span class="ss-word" data-ss-verdict="${word.toLowerCase()}">${word}</span> ${esc(why)}</p></li>`;
  };
  return `<p class="au-note ss-lede">The enlarged ones are the 16 and 24 px downscales, halved step by step as the Mark’s are, then shown with every pixel blown up. Nothing is redrawn to help: where a tile turns to mush, it says so.</p>
<ul class="ss-list">${Object.keys(TILE).map(row).join('')}</ul>
<p class="au-note">In short: the four shapes (check, triangle, X, bars) hold at 16 px; the three swirls are told apart by colour alone, and OFFLINE turns to mush. 16 px is a task row’s icon; the live places are 24 px and up. The Mark at 16 px is in “Every state”.</p>`;
}

function noTile(id) {
  const one = (state) => `<section class="ss-state" aria-labelledby="${id}-${state}"><h4 class="ss-h" id="${id}-${state}">${esc(state)} <span class="uc-faint">· ${esc(ICON_WORDS[state])}</span></h4>
<div class="ss-sizes"><figure class="ss-fig">${markSlot(state, 96)}<figcaption class="ss-cap">Mark, today</figcaption></figure>
<figure class="ss-fig"><div class="ss-none ss-gap"><p class="au-block-head">No tile on your sheet</p></div><figcaption class="ss-cap">Sheet</figcaption></figure></div>
<p class="ss-label">Candidates, if it borrows a tile</p>
<div class="ss-sizes">${CANDIDATES.map((t) => `<figure class="ss-fig">${tileImg(t, 96, `${NAME(t)} tile`)}<figcaption class="ss-cap">${NAME(t)}</figcaption></figure>`).join('')}</div></section>`;
  return `<p class="au-note ss-lede">Your sheet draws eight states; Nova has ten. Nothing is picked here: which one each borrows is your call. Borrowing means two states look the same (listening as WORKING looks like Nova working). Not WARNING or ERROR: amber is only for needs-you, red only for stopped. A third way is a new tile from you.</p>${NO_TILE.map(one).join('')}`;
}

// A change, frame by frame: StatusModel's weights at each moment, each crop mixed by its weight.
function sequence(events, times) {
  const m = new StatusModel(events[0][1], 0);
  const out = [];
  let next = 1;
  for (const t of times) {
    while (next < events.length && events[next][0] <= t) { m.set(events[next][1], events[next][0]); next++; }
    const w = Object.fromEntries(Object.entries(m.weights(t)).filter(([, k]) => k > 0.005).map(([s, k]) => [s, Math.round(k * 100) / 100]));
    out.push([t, w]);
  }
  return out;
}
const SEQUENCES = [
  ['Idle to working', 'Nova starts on something.', [[0, 'idle'], [0, 'working']], [0, 200, 400, 600, MORPH_MS]],
  ['Working to success, which settles to idle by itself', `Success is never a resting state: it shows, then settles to idle ${SUCCESS_MS} ms after it began.`, [[0, 'working'], [0, 'success']], [0, 400, MORPH_MS, SUCCESS_MS, SUCCESS_MS + 400, SUCCESS_MS + MORPH_MS]],
  ['Idle to working, then needs-you 150 ms later', 'A change mid-change starts from what is on screen, so three tiles are mixed for a moment.', [[0, 'idle'], [0, 'working'], [150, 'needs-you']], [0, 150, 400, 700, 150 + MORPH_MS]],
];

function change(id) {
  const words = (w) => Object.entries(w).map(([s, k]) => `${esc(s)} ${Math.round(k * 100)}%`).join(' · ');
  const seq = ([title, note, events, times], i) => `<section class="ss-state" aria-labelledby="${id}-q${i}"><h4 class="ss-h" id="${id}-q${i}">${esc(title)}</h4><p class="au-note">${esc(note)}</p>
<ol class="ss-sizes ss-frames">${sequence(events, times).map(([t, w]) => `<li class="ss-fig"><canvas class="ss-mix" data-ss-mix="${esc(JSON.stringify(Object.fromEntries(Object.entries(w).map(([s, k]) => [TILE[s], k]))))}" data-ss-px="96" aria-hidden="true"></canvas><span class="ss-cap"><b>${t} ms</b> ${words(w)}</span></li>`).join('')}</ol></section>`;
  return `<p class="au-note ss-lede">The tiles don’t morph into each other: their shapes are yours, and only the light between them changes. Each frame is the crops added in the proportions the real model gives at that moment (${MORPH_MS} ms, the same soft ease-in-out as the Mark). Within a state the tile is still, as drawn; with reduced motion a change swaps straight to the new tile.</p>${SEQUENCES.map(seq).join('')}`;
}

// ---- the places it shows -----------------------------------------------------------------------

const NAV = [['chat', 'Chat'], ['tasks', 'Tasks'], ['memory', 'Memory'], ['activity', 'Activity'], ['settings', 'Settings']];
function rail(id, { live = null, active = 'chat' } = {}) {
  const home = live
    ? `<a class="uc-row" href="#${id}-home" aria-label="Home. ${esc(ICON_WORDS[live])}"><span class="ss-live" aria-hidden="true">${tileImg(TILE[live], PX.rail)}</span><span class="uc-label">Home</span></a>`
    : `<a class="uc-row" href="#${id}-home"><span class="uc-ic" aria-hidden="true">${icon('home')}</span><span class="uc-label">Home</span></a>`;
  return `<div class="uc-rail"><nav class="uc-nav" aria-label="Places">${home}${NAV.map(([ic, name]) => `<a class="uc-row${ic === active ? ' is-on' : ''}" href="#${id}-${ic}"${ic === active ? ' aria-current="page"' : ''}><span class="uc-ic" aria-hidden="true">${icon(ic)}</span><span class="uc-label">${name}</span></a>`).join('')}</nav></div>`;
}
const top = (title, live = null) => `<header class="uc-top"><button type="button" class="uc-icon uc-menu" aria-label="Open navigation">${icon('panel')}</button><h2 class="uc-title">${title}</h2>${live ? `<span class="ss-live ss-top" role="img" aria-label="${esc(ICON_WORDS[live])}">${tileImg(TILE[live], PX.mini)}</span>` : ''}</header>`;
const THREAD = `<div class="uc-chat"><div class="uc-thread"><p class="uc-you">What does Friday look like? Check my notes and the calendar.</p><div class="uc-nova"><p>Looking at your notes and Friday’s calendar now.</p></div></div></div>`;

function composer(id) {
  return `<form class="uc-composer is-big" data-sg-inert novalidate><label class="sr-only" for="${id}-ask">Message Nova</label><textarea id="${id}-ask" rows="2" placeholder="Ask Nova anything…"></textarea>
<div class="uc-composer-bar"><span class="uc-spacer"></span><button type="submit" class="uc-send" aria-label="Send" data-ss-demo>${icon('send')}</button></div></form>`;
}

// ---- Appearance: Mark or Sheet, chosen as a design is ------------------------------------------

function card(style, on) {
  const [name, note, thumb] = style === 'mark'
    ? ['Mark', 'Today’s. Nova’s mark, the one SVG N: each state changes its light and motion.', markSvg({ size: 48 })]
    : ['Sheet', 'Your state sheet: a tile for each state, crossfading in 800 ms. Listening and speaking have no tile yet.', `<span class="ss-quad">${['idle', 'working', 'thinking', 'paused'].map((t) => tileImg(t, 24)).join('')}</span>`];
  return `<button type="button" class="ds-card ss-card" data-ss-pick="${style}" aria-pressed="${on}"><span class="ss-thumb" aria-hidden="true">${thumb}</span><span class="ds-text"><span class="ds-name">${name}</span><span class="ds-note">${note}</span>${on ? '<span class="ds-tags"><span class="pill">This device</span></span>' : ''}</span></button>`;
}

function appearance(id) {
  return `<p class="ss-kind">Settings › Appearance</p><h3 class="uc-h">Appearance</h3>
<p class="au-note">Theme: <b>Nebula</b> · this device only. The design cards, light and dark, and the contrast check stay as they are; this is proposed beside them.</p>
<section class="ss-state" aria-labelledby="${id}-si"><h4 class="ss-h" id="${id}-si">Status icon <span class="uc-faint">· proposed</span></h4>
<p class="au-note">How Nova shows what it is doing, in the rail, a phone’s top bar and the hero.</p>
<ul class="ds-others ss-cards" aria-label="Status icon styles"><li>${card('mark', true)}</li><li>${card('sheet', false)}</li></ul>
<p class="au-note">At rest the two look alike: your sheet’s IDLE tile is a near-twin of the mark. They differ once Nova is working, thinking, paused, needs you or has stopped.</p>
<p class="au-note" data-ss-said role="status">A specimen: picking one here saves nothing, and the app has no such choice yet.</p></section>`;
}

// ---- frames -------------------------------------------------------------------------------------

function page(state, title, body) {
  const id = `ss-${state}`;
  return `<div class="uc-screen ss" data-ss-frame="${state}"><div class="uc-main">${top(title)}<div class="ss-col"><div class="ss-page">${body(id)}</div></div></div></div>`;
}

export function ssFrame(state) {
  const id = `ss-${state}`;
  if (state === 'small') return page(state, 'Sheet style: small sizes', small);
  if (state === 'no-tile') return page(state, 'Sheet style: listening and speaking', noTile);
  if (state === 'change') return page(state, 'Sheet style: a state change', change);
  if (state === 'appearance') return page(state, 'Settings', appearance);
  if (state === 'rail') return `<div class="uc-screen ss" data-ss-frame="rail">${rail(id, { live: 'working' })}<div class="uc-main">${top('Friday plan')}${THREAD}</div></div>`;
  if (state === 'hero') {
    return `<div class="uc-screen ss" data-ss-frame="hero">${rail(id, { active: 'chat' })}<div class="uc-main">${top('New chat')}<div class="uc-chat uc-chat-empty"><div class="uc-hero">${SKY_BAND}<span class="ss-live ss-hero" role="img" aria-label="${esc(ICON_WORDS.idle)}">${tileImg('idle', PX.hero)}</span></div><h3 class="uc-greet">Good evening, Alex</h3>${composer(id)}</div></div></div>`;
  }
  if (state === 'phone-bar') return `<div class="uc-screen ss ss-phone" data-ss-frame="phone-bar"><div class="uc-main">${top('Friday plan', 'working')}${THREAD}</div></div>`;
  return page('sizes', 'Sheet style: every state', sizes);
}
// The styleguide entry: every frame, each with its full-screen address.
export function ssEntry(wrap) {
  return SS_FRAMES.map(([s, said]) => wrap(`${esc(said)} · <a class="link" href="?entry=sheet-icon-style&amp;frame=${s}">Full screen</a>`, ssFrame(s))).join('');
}

// The 16 or 24 px downscale of a crop, halved step by step (as the raster Mark's was before it
// became an SVG), drawn back with every pixel blown up.
function zoom(canvas, img) {
  const px = Number(canvas.dataset.ssPx), k = Number(canvas.dataset.ssK);
  let c = img, w = img.naturalWidth;
  while (w / 2 >= px) {
    const h = document.createElement('canvas');
    h.width = h.height = Math.round(w / 2);
    const g = h.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, h.width, h.height);
    c = h; w = h.width;
  }
  const small = document.createElement('canvas');
  small.width = small.height = px;
  const s = small.getContext('2d');
  s.imageSmoothingQuality = 'high';
  s.drawImage(c, 0, 0, px, px);
  canvas.width = canvas.height = px * k;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(small, 0, 0, px * k, px * k);
  canvas.style.width = canvas.style.height = `${px * k}px`;
}

// The crops added by weight: the mix of premultiplied pixels, exact where tiles overlap.
function mix(canvas, imgs) {
  const px = Number(canvas.dataset.ssPx);
  const dpr = Math.min(3, Math.max(1, Math.ceil(globalThis.devicePixelRatio || 1)));
  canvas.width = canvas.height = px * dpr;
  canvas.style.width = canvas.style.height = `${px}px`;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.globalCompositeOperation = 'lighter';
  for (const [tile, k] of Object.entries(JSON.parse(canvas.dataset.ssMix))) {
    g.globalAlpha = k;
    g.drawImage(imgs[tile], 0, 0, canvas.width, canvas.height);
  }
}

const loaded = new Map();
const load = (tile) => {
  if (!loaded.has(tile)) loaded.set(tile, new Promise((done, fail) => { const i = new Image(); i.onload = () => done(i); i.onerror = fail; i.src = src(tile); }));
  return loaded.get(tile);
};

// Fills the Mark slots with today's status icon, draws the enlarged downscales and the crossfade
// frames, and lets the Appearance specimen be picked (locally: nothing is saved).
export function bindSheetIcons(root) {
  for (const el of root.querySelectorAll('[data-ss-mark]')) {
    if (el.firstChild) continue;
    el.append(statusIcon({ status: el.dataset.ssMark, size: Number(el.dataset.ssPx), decorative: true }));
  }
  const canvases = [...root.querySelectorAll('canvas[data-ss-zoom], canvas[data-ss-mix]')].filter((c) => !c.dataset.ssDrawn);
  if (canvases.length) {
    Promise.all(Object.values(TILE).map(async (t) => [t, await load(t)])).then((pairs) => {
      const imgs = Object.fromEntries(pairs);
      for (const c of canvases) {
        if (c.dataset.ssZoom) zoom(c, imgs[c.dataset.ssZoom]); else mix(c, imgs);
        c.dataset.ssDrawn = '1';
      }
    }).catch(() => {});
  }
  for (const frame of root.querySelectorAll('[data-ss-frame]')) {
    if (frame.dataset.ssBound) continue;
    frame.dataset.ssBound = '1';
    frame.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-ss-pick]');
      if (pick) {
        for (const b of frame.querySelectorAll('[data-ss-pick]')) b.setAttribute('aria-pressed', String(b === pick));
        const said = frame.querySelector('[data-ss-said]');
        if (said) said.textContent = `Demo: ${pick.dataset.ssPick === 'sheet' ? 'Sheet' : 'Mark'} picked here only. Nothing was saved.`;
      }
      if (e.target.closest('[data-ss-demo]')) e.preventDefault();
      if (e.target.closest('a[href^="#"]')) e.preventDefault();
    });
  }
}
