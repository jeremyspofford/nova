// What Nova reads from a page itself, for the co-pilot's ground truth (M10b plan): functions run in
// Nova's isolated world through CDP (`Runtime.callFunctionOn`), where the page can't replace what
// they call. Each is a function's source; `this` is the element it runs on, and arguments arrive as
// values, never as source (a sign-in's value goes this way, so it is never part of any script).
//
// They only read, except the ones that act (click, fill, choose, sign in) and the one that masks
// saved values before a screenshot or a final read.

// What Nova knows of one element: enough to tell what it is and what it would do.
export const ELEMENT_FACTS = `function () {
  const el = this;
  if (!el || !el.tagName) return null;
  const text = (n) => (n ? (n.innerText ?? n.textContent ?? '') : '').replace(/\\s+/g, ' ').trim();
  const byIds = (ids) => ids.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(text).join(' ');
  const name = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') ? byIds(el.getAttribute('aria-labelledby')) : '')
    || (el.labels && el.labels.length ? text(el.labels[0]) : '')
    || (el.tagName === 'INPUT' && /^(submit|button|reset|image)$/i.test(el.type) ? (el.value || el.alt || '') : '')
    || text(el) || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || '';
  const form = el.form || el.closest('form');
  const action = el.formAction && el.hasAttribute('formaction') ? el.formAction : form ? form.action : '';
  const card = !!(form && form.querySelector('[autocomplete^="cc-"], input[name*="card" i], input[id*="card" i], input[name*="cvv" i], input[name*="cvc" i], input[id*="cvv" i]'));
  const r = el.getBoundingClientRect();
  return {
    tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || (el.tagName === 'BUTTON' ? 'submit' : ''), role: el.getAttribute('role') || '',
    name: name.slice(0, 300), id: el.id || '', classes: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
    formAction: action || '', formHasCard: card, disabled: !!el.disabled, visible: r.width > 0 && r.height > 0,
  };
}`;

// Whether something else would take a click at the element's centre (an overlay, a dialog).
const COVERED = `const covered = (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!at) return false;
    if (at === el || el.contains(at)) return false;
    if (el.labels && [...el.labels].some((l) => l === at || l.contains(at))) return false;
    if (at.tagName === 'LABEL' && at.control === el) return false;
    return true;
  };`;

export const CLICK = `function () {
  ${COVERED}
  const el = this;
  if (!el || !el.tagName) return 'missing';
  if (el.disabled) return 'disabled';
  if (covered(el)) return 'covered';
  el.setAttribute('data-nova-set', '1');
  el.click();
  return 'ok';
}`;

// \`strict\` (an account plan, M10d review): a field that looks like it takes a code refuses too.
export const FILL = `function (value, strict) {
  const el = this;
  if (!el || !el.tagName) return 'missing';
  if (el.disabled || el.readOnly) return 'disabled';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
  if (!proto) { if (el.isContentEditable) { el.focus(); el.textContent = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.setAttribute('data-nova-set', '1'); return 'ok'; } return 'not-a-field'; }
  // A password field never takes a value from a plan (M10d): the vault's, through a login or account
  // step, or the person's own.
  if (el instanceof HTMLInputElement && (el.getAttribute('type') || '').toLowerCase() === 'password') return 'secret-field';
  // A one-time code's field is the person's too, however it is named.
  if ((el.getAttribute('autocomplete') || '').toLowerCase().includes('one-time-code')) return 'secret-field';
  if (strict) {
    const words = [el.name, el.id, el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '', (el.labels && el.labels[0] ? el.labels[0].textContent : '') || ''].join(' ');
    const max = Number(el.getAttribute('maxlength') || 0);
    if (/code|otp|token|pin|mfa|2fa|totp/i.test(words) || ((el.getAttribute('inputmode') || '') === 'numeric' && max > 0 && max <= 10)) return 'secret-field';
  }
  el.scrollIntoView({ block: 'center' });
  el.focus();
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.setAttribute('data-nova-set', '1');
  return 'ok';
}`;

export const SELECT = `function (want) {
  const el = this;
  if (!el || !el.tagName) return 'missing';
  if (!(el instanceof HTMLSelectElement)) return 'not-a-list';
  if (el.disabled) return 'disabled';
  const opt = [...el.options].find((o) => o.value === want) ?? [...el.options].find((o) => o.text.trim() === want);
  if (!opt) return 'no-option';
  el.value = opt.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.setAttribute('data-nova-set', '1');
  return 'ok';
}`;

// A sign-in's value into its field, only on the page of the host it was saved for, only into a field
// of that page's own document, and masked on the page at once (frames and screenshots show discs).
export const SECRET = `function (value, host, part, selector) {
  const el = this;
  if (location.host !== host) return 'wrong-host';
  if (el.ownerDocument !== document || !(el instanceof HTMLInputElement)) return 'not-a-field';
  // The field must still be the one the plan names, before and after it takes focus (a page can
  // swap it in a focus handler): otherwise nothing is set.
  const same = () => el.isConnected && document.querySelector(selector) === el && el.getClientRects().length > 0 && location.host === host;
  if (!same()) return 'swapped';
  const type = (el.getAttribute('type') || 'text').toLowerCase();
  if (part === 'password' ? type !== 'password' : !['text', 'email', 'tel', ''].includes(type)) return 'not-a-field';
  if (el.disabled || el.readOnly) return 'disabled';
  el.style.setProperty('-webkit-text-security', 'disc', 'important');
  el.setAttribute('data-nova-secret', '1');
  el.focus();
  if (!same()) return 'swapped';
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.setAttribute('data-nova-set', '1');
  return 'ok';
}`;

// The page as Nova's checks need it. `pay`: the forms on it and their submit controls, for the pay
// guard; `ticked`: boxes and choices already ticked; `dialogs`: open dialogs' text.
export const PAGE_FACTS = `function () {
  const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0; };
  const text = (n) => (n ? (n.innerText ?? n.textContent ?? '') : '').replace(/\\s+/g, ' ').trim();
  const body = document.body ? document.body.innerText : '';
  const captchaFrames = [...document.querySelectorAll('iframe')].some((f) => /recaptcha|hcaptcha|turnstile|captcha|challenge/i.test(f.src || '') && shown(f));
  const captchaMarks = [...document.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [class*="captcha" i], [id*="captcha" i]')].some(shown);
  const captchaWords = /verify (that )?you are (a )?human|i.?m not a robot|complete the captcha|prove you.?re (a )?human/i.test(body);
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]')]
    .filter(shown).filter((d, i, all) => !all.some((o) => o !== d && o.contains(d))).slice(0, 5).map((d) => ({ text: text(d).slice(0, 4000) }));
  const label = (el) => (el.labels && el.labels.length ? text(el.labels[0]) : '') || text(el.closest('label')) || el.getAttribute('aria-label') || text(el.parentElement);
  const ticked = [...document.querySelectorAll('input[type="checkbox"], input[type="radio"]')]
    .filter((el) => el.checked && (shown(el) || (el.labels && [...el.labels].some(shown))))
    .slice(0, 30).map((el) => ({ label: label(el).slice(0, 200), touched: el.hasAttribute('data-nova-set'), radio: el.type === 'radio' }));
  const pay = [...document.forms].slice(0, 20).map((f) => ({
    action: f.action || location.href, method: (f.method || 'get').toLowerCase(),
    hasCard: !!f.querySelector('[autocomplete^="cc-"], input[name*="card" i], input[id*="card" i], input[name*="cvv" i], input[name*="cvc" i]'),
    buttons: [...f.querySelectorAll('button, input[type="submit"], input[type="image"]')].slice(0, 10).map((b) => ({
      tag: b.tagName.toLowerCase(), type: b.getAttribute('type') || (b.tagName === 'BUTTON' ? 'submit' : ''), name: (b.getAttribute('aria-label') || text(b) || b.value || '').slice(0, 120), id: b.id || '', classes: typeof b.className === 'string' ? b.className.slice(0, 120) : '',
    })),
  }));
  return {
    url: location.href, path: location.pathname, title: document.title.slice(0, 200), text: body.slice(0, 6000),
    password_fields: [...document.querySelectorAll('input[type="password"]')].filter(shown).length,
    captcha: captchaFrames || captchaMarks || captchaWords,
    paywall: /(subscribe|subscription) to (continue|keep) reading|subscribers only|for (paid )?(subscribers|members) only|this (article|content|page) is for (paid )?(subscribers|members)/i.test(body),
    dialogs, ticked, pay,
  };
}`;

// The checkout's lines and total, as the page shows them.
export const CHECKOUT_READ = `function (lines, total) {
  const text = (n) => (n ? (n.innerText ?? n.textContent ?? '') : '').replace(/\\s+/g, ' ').trim();
  return { lines: [...document.querySelectorAll(lines)].slice(0, 100).map(text), total: text(document.querySelector(total)) };
}`;

export interface PageFacts {
  url: string; path: string; title: string; text: string;
  password_fields: number; captcha: boolean; paywall: boolean;
  dialogs: { text: string }[];
  ticked: { label: string; touched: boolean; radio: boolean }[];
  pay: { action: string; method: string; hasCard: boolean; buttons: { tag: string; type: string; name: string; id: string; classes: string }[] }[];
}
export interface ElementFacts { tag: string; type: string; role: string; name: string; id: string; classes: string; formAction: string; formHasCard: boolean; disabled: boolean; visible: boolean }
