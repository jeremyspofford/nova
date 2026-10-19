// The page scripts the extension runs for the Hub (FR-096; ADR-096 D8). The Hub names a script
// and gives its argument; the extension builds the expression from its own copy here, so nothing
// upstream (the Hub, novad) can make it run code of its choosing, and it runs every script only on
// the page host the Hub expects (another host gets nothing back). The reader is the same as the
// Hub's own agent browser uses (packages/core/src/browser/playwright.ts `PAGE_SCRIPT`); keep the
// two in step. None of them reads cookies, storage or form values other than what the reader
// reports (names, roles, options and checked states, never what is typed in a field).
import { BridgeRefusal } from './protocol.ts';

/** The page reader: `read` lists the top frame's interactive elements, `describe` one of them. */
const READER = String.raw`(function (arg) {
  var MAX_NAME = 120;
  function clip(s, n) { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function visible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    var st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  }
  function textOf(id) { var n = document.getElementById(id); return n ? n.innerText || n.textContent || '' : ''; }
  function roleOf(el) {
    var r = el.getAttribute('role'); if (r) return r.split(/\s+/)[0].toLowerCase();
    var tag = el.tagName.toLowerCase(), t = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'iframe') return 'iframe';
    if (tag === 'input') {
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image' || t === 'file') return 'button';
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'search') return 'searchbox';
      if (t === 'range') return 'slider';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  }
  function nameOf(el) {
    var a = el.getAttribute('aria-label'); if (a) return clip(a, MAX_NAME);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) return clip(lb.split(/\s+/).map(textOf).join(' '), MAX_NAME);
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return clip(l.innerText, MAX_NAME); }
      var p = el.closest('label'); if (p) return clip(p.innerText, MAX_NAME);
      var t = (el.getAttribute('type') || '').toLowerCase();
      if ((t === 'submit' || t === 'button' || t === 'reset') && el.value) return clip(el.value, MAX_NAME);
      if (el.getAttribute('placeholder')) return clip(el.getAttribute('placeholder'), MAX_NAME);
    }
    if (tag === 'iframe') return clip(el.getAttribute('title') || el.src || '', MAX_NAME);
    if (el.getAttribute('title')) return clip(el.getAttribute('title'), MAX_NAME);
    var img = el.querySelector && el.querySelector('img[alt]');
    var txt = clip(el.innerText || el.textContent || '', MAX_NAME);
    if (!txt && img) return clip(img.getAttribute('alt'), MAX_NAME);
    return txt;
  }
  function info(el, ref) {
    var tag = el.tagName.toLowerCase();
    var o = { ref: ref, role: roleOf(el), name: nameOf(el), tag: tag };
    var t = el.getAttribute('type'); if (t) o.inputType = t.toLowerCase();
    if (tag === 'a' && el.href) o.href = el.href;
    if (tag === 'iframe' && el.src) o.href = el.src;
    var f = el.form || el.closest('form');
    o.form = f ? { action: f.action || location.href, method: (f.getAttribute('method') || 'get').toLowerCase() } : null;
    var ac = el.getAttribute('autocomplete'); if (ac) o.autocomplete = ac;
    var nm = el.getAttribute('name'); if (nm) o.fieldName = nm;
    var ph = el.getAttribute('placeholder'); if (ph) o.placeholder = clip(ph, MAX_NAME);
    if (el.disabled) o.disabled = true;
    if (tag === 'select') o.options = Array.prototype.slice.call(el.options, 0, 20).map(function (x) { return clip(x.text, 60); });
    if (o.role === 'checkbox' || o.role === 'radio') o.checked = !!el.checked;
    return o;
  }
  var SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,iframe,[role],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]';
  if (arg.mode === 'describe') {
    var one = document.querySelector('[data-nova-ref="' + arg.ref + '"]');
    return one ? info(one, arg.ref) : null;
  }
  var old = document.querySelectorAll('[data-nova-ref]');
  for (var i = 0; i < old.length; i++) old[i].removeAttribute('data-nova-ref');
  var out = [], n = 0, all = document.querySelectorAll(SEL);
  var INTERACTIVE = /^(link|button|textbox|searchbox|checkbox|radio|combobox|listbox|option|menuitem|menuitemcheckbox|menuitemradio|tab|switch|slider|spinbutton|iframe|treeitem|gridcell)$/;
  for (var j = 0; j < all.length && out.length < arg.maxElements; j++) {
    var el = all[j];
    if (!visible(el)) continue;
    var role = roleOf(el);
    if (!INTERACTIVE.test(role) && !el.hasAttribute('onclick') && !(el.getAttribute('tabindex') && el.getAttribute('tabindex') !== '-1')) continue;
    var ref = 'e' + (++n);
    el.setAttribute('data-nova-ref', ref);
    out.push(info(el, ref));
  }
  var text = (document.body && document.body.innerText) || '';
  return { title: document.title || '', text: text.slice(0, arg.maxChars), elements: out };
})`;

export const SCRIPT_NAMES = [
  'read',
  'describe',
  'href',
  'readyState',
  'navStatus',
  'frames',
  'point',
  'focus',
  'select',
  'hasText',
  'back',
  'box',
  'focusedSecret',
] as const;
export type ScriptName = (typeof SCRIPT_NAMES)[number];

const REF = /^e\d{1,5}$/;

function args(arg: unknown): Record<string, unknown> {
  return typeof arg === 'object' && arg !== null && !Array.isArray(arg)
    ? (arg as Record<string, unknown>)
    : {};
}

function ref(arg: unknown): string {
  const r = args(arg).ref;
  if (typeof r !== 'string' || !REF.test(r))
    throw new BridgeRefusal('invalid', 'not an element ref');
  return r;
}

function text(arg: unknown, key: string, max: number): string {
  const v = args(arg)[key];
  if (typeof v !== 'string' || v.length > max)
    throw new BridgeRefusal('invalid', `${key} is not valid`);
  return v;
}

function int(arg: unknown, key: string, min: number, max: number, dflt: number): number {
  const v = args(arg)[key];
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(Math.max(Math.floor(v), min), max)
    : dflt;
}

const el = (r: string) => `document.querySelector('[data-nova-ref="${r}"]')`;

function body(name: ScriptName, arg: unknown): string {
  switch (name) {
    case 'read':
      return `${READER}(${JSON.stringify({
        mode: 'read',
        maxChars: int(arg, 'maxChars', 1, 40_000, 12_000),
        maxElements: int(arg, 'maxElements', 1, 300, 300),
      })})`;
    case 'describe':
      return `${READER}(${JSON.stringify({ mode: 'describe', ref: ref(arg) })})`;
    case 'href':
      return 'location.href';
    case 'readyState':
      return 'document.readyState';
    case 'navStatus':
      return "(function(){var n=performance.getEntriesByType('navigation')[0];return n&&n.responseStatus?n.responseStatus:null;})()";
    case 'frames':
      return "Array.prototype.slice.call(document.querySelectorAll('iframe')).map(function(f){return f.src}).filter(Boolean).slice(0,20)";
    case 'point':
      return `(function(){var el=${el(ref(arg))};if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`;
    case 'focus':
      return `(function(){var el=${el(ref(arg))};if(!el)return false;el.focus();if(typeof el.select==='function')el.select();else{var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r);}return true;})()`;
    case 'select':
      return `(function(v){var el=${el(ref(arg))};if(!el||!el.options)return false;for(var i=0;i<el.options.length;i++){var o=el.options[i];if(o.text.trim()===v||o.value===v){el.value=o.value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;}}return false;})(${JSON.stringify(text(arg, 'value', 500))})`;
    case 'hasText':
      return `(document.body&&document.body.innerText||'').indexOf(${JSON.stringify(text(arg, 'text', 500))})>=0`;
    case 'back':
      return '(history.back(),null)';
    case 'box':
      return `(function(){var el=${el(ref(arg))};if(!el)return null;var r=el.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:Math.max(1,r.width),height:Math.max(1,r.height)};})()`;
    case 'focusedSecret':
      return "(function(){var e=document.activeElement;if(!e||e.tagName!=='INPUT')return false;var t=(e.getAttribute('type')||'').toLowerCase(),a=e.getAttribute('autocomplete')||'';return t==='password'||/(?:current|new)-password|one-time-code/i.test(a);})()";
  }
}

/** Whether `name` is one of the scripts. */
export function isScriptName(name: unknown): name is ScriptName {
  return typeof name === 'string' && (SCRIPT_NAMES as readonly string[]).includes(name);
}

/**
 * The expression for a script, run only while the page is on `expectHost` (null: about:blank);
 * on any other host it gives `{__novaWrongHost: true}` and does nothing.
 */
export function scriptExpression(
  name: ScriptName,
  arg: unknown,
  expectHost: string | null,
): string {
  const host = JSON.stringify(expectHost ?? '');
  return `(function(){if(location.hostname!==${host})return {__novaWrongHost:true};return (${body(name, arg)});})()`;
}
