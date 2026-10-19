// The page-action classifier (FR-095, docs/11 §4, docs/12 §2.2-§2.3): heuristics over the element
// an action targets (role, accessible name, input type, form action and method), the typed text
// and the page, giving the action its effect classes. Any class flags the action: the policy
// engine turns purchases, new accounts, installs, deletions and messages into a confirmation at
// the moment of action, and CAPTCHAs, credential changes, security warnings and verification
// codes into a handoff (FR-189). A password is never typed by the agent: sign-in goes through
// the private form (FR-086). When in doubt the classifier picks the stricter class.
import type { ActionEffectClass } from '@nova/shared';
import type { PageElement } from './types.ts';

export type PageActionKind =
  'click' | 'type' | 'select' | 'press' | 'hover' | 'upload' | 'download' | 'evaluate';

export interface PageActionInput {
  kind: PageActionKind;
  element: PageElement | null;
  /** Typed text (`type`). */
  text?: string;
  /** `type` then Enter. */
  submit?: boolean;
  /** `press`. */
  key?: string;
  /** `select`. */
  value?: string;
  /** The field the agent typed into last (what Enter submits). */
  lastTyped?: PageElement | null;
  page: { url: string; host: string; title: string; frames: readonly string[] };
}

export interface PageActionClassification {
  effects: ActionEffectClass[];
  reasons: string[];
  /** The user must do this step (FR-189 `handoff_required`). */
  handoff: boolean;
  /** Refused outright, with the reason the agent gets. */
  deny: string | null;
  /** Changes nothing on the site (moving focus, closing a menu): no check needed. */
  passive: boolean;
  /** Sends data to the site (a form, an upload): never toward an external agent (FR-194). */
  transmits: boolean;
}

const PURCHASE =
  /\b(buy|buy now|purchase|checkout|check out|place (my |your |the )?order|order now|pay|pay now|payment|complete (my |your |the )?(purchase|order|booking)|confirm (my |your |the )?(purchase|order|payment|booking)|subscribe|upgrade|start (my |your |a )?(free )?trial|donate|book now|reserve now|rent now|bid|place bid)\b/;
const ACCOUNT =
  /\b(sign up|signup|register|create (an |a |your |my |new )?account|join now|authori[sz]e|allow access|grant (access|permission|permissions)|connect (app|account|accounts)|accept (the )?invit\w*|invite|add (a )?(member|user|collaborator|admin)|(generate|create|new) (an? )?(personal )?(api )?(key|token|access token))\b/;
const INSTALL =
  /\b(install|add extension|add to (chrome|browser|firefox|edge)|download (the )?app)\b/;
const SEND =
  /\b(send|post|publish|tweet|reply|comment|share|submit|message|email|contact us|forward|transfer|wire)\b/;
const DELETE =
  /\b(delete|remove|erase|destroy|discard|cancel (my |your |the )?(subscription|account|order|membership|plan)|close (my |your |the )?account|deactivate|unsubscribe|empty trash|clear (all|history|data))\b/;
const CREDENTIAL =
  /\b((change|reset|update|set) (your |my |the )?password|new password|(enable|disable|turn on|turn off|remove) (two factor|2fa|mfa|two step)|security (settings|questions)|recovery (email|phone|codes?))\b/;
const BYPASS =
  /\b(proceed (anyway|to)|continue to (the )?site|accept the risk|ignore (this |the )?warning|visit this unsafe site|bypass|i understand the risks)\b/;
const CAPTCHA =
  /\b(captcha|recaptcha|hcaptcha|turnstile|i m not a robot|i am not a robot|verify (that )?you are (a )?human|are you a robot|bot check)\b/;
const OTP =
  /\b(otp|one time (code|password|passcode)|verification code|security code|2fa|two factor|authenticator|mfa|passcode|sms code)\b/;
const PAYMENT_FIELD =
  /\b(card number|credit card|debit card|cvv|cvc|cvv2|expiry|expiration|iban|routing number|account number)\b/;
const SEARCH_FIELD = /\b(search|query|find|q|s)\b/;
const CAPTCHA_FRAME =
  /(recaptcha|hcaptcha|turnstile|captcha|arkoselabs|funcaptcha|challenges\.cloudflare)/i;
const PAYMENT_PAGE = /\b(checkout|payment|pay|billing|cart)\b/;
const EXECUTABLE = /\.(exe|msi|msix|dmg|pkg|deb|rpm|appimage|apk|ipa|sh|bat|cmd|ps1|jar|vbs|scr)$/i;

/** Keys that only move focus or scroll; anything else may change the page. */
const PASSIVE_KEYS = new Set([
  'tab',
  'shift+tab',
  'escape',
  'esc',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'pageup',
  'pagedown',
  'home',
  'end',
]);

/** Lower-case words of untrusted text; punctuation splits words (so "I'm" reads "i m"). */
export function plainWords(...parts: (string | null | undefined)[]): string {
  return ` ${parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

function pathOf(url: string | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.pathname} ${u.search}`;
  } catch {
    return '';
  }
}

/** What the element says about itself: name, field name, placeholder, link and form targets. */
function elementWords(el: PageElement | null): string {
  if (!el) return ' ';
  return plainWords(
    el.name,
    el.fieldName,
    el.placeholder,
    pathOf(el.href),
    pathOf(el.form?.action),
  );
}

function isPasswordField(el: PageElement | null): boolean {
  if (!el) return false;
  const ac = (el.autocomplete ?? '').toLowerCase();
  return (
    (el.inputType ?? '').toLowerCase() === 'password' ||
    ac.includes('current-password') ||
    ac.includes('new-password')
  );
}

function isOtpField(el: PageElement | null): boolean {
  if (!el) return false;
  if ((el.autocomplete ?? '').toLowerCase().includes('one-time-code')) return true;
  return OTP.test(plainWords(el.name, el.fieldName, el.placeholder));
}

function isPaymentField(el: PageElement | null): boolean {
  if (!el) return false;
  if (/\bcc-/.test((el.autocomplete ?? '').toLowerCase())) return true;
  return PAYMENT_FIELD.test(plainWords(el.name, el.fieldName, el.placeholder));
}

function isSearchField(el: PageElement | null): boolean {
  if (!el) return false;
  if (el.role === 'searchbox' || (el.inputType ?? '').toLowerCase() === 'search') return true;
  if ((el.form?.method ?? '').toLowerCase() === 'get' && el.form?.action) {
    if (SEARCH_FIELD.test(plainWords(el.fieldName, el.placeholder, el.name))) return true;
  }
  return SEARCH_FIELD.test(plainWords(el.fieldName)) && !el.form;
}

/** A click that submits a form: a submit button or an image input inside one. */
function isSubmit(el: PageElement | null): boolean {
  if (!el || !el.form) return false;
  const t = (el.inputType ?? '').toLowerCase();
  if (el.tag === 'button') return t === '' || t === 'submit';
  return el.tag === 'input' && (t === 'submit' || t === 'image');
}

class Builder {
  readonly effects = new Set<ActionEffectClass>();
  readonly reasons: string[] = [];
  handoff = false;
  deny: string | null = null;
  transmits = false;

  add(effect: ActionEffectClass, reason: string): void {
    if (!this.effects.has(effect)) this.reasons.push(reason);
    this.effects.add(effect);
  }

  hand(effect: ActionEffectClass | null, reason: string): void {
    this.handoff = true;
    if (effect) this.effects.add(effect);
    this.reasons.push(reason);
  }

  /**
   * The classes the words of an element or a value name (stricter classes first). Following a
   * link sends nothing, so a link named "Reply" is not a message (`send: false`).
   */
  byWords(w: string, what: string, send = true): void {
    if (CAPTCHA.test(w)) this.hand('captcha', `${what} is a CAPTCHA; you complete those yourself`);
    if (CREDENTIAL.test(w))
      this.hand('credential_change', `${what} changes a password or security setting`);
    if (BYPASS.test(w)) this.hand('security_bypass', `${what} gets past a security warning`);
    if (PURCHASE.test(w)) this.add('purchase', `${what} looks like a purchase or payment`);
    if (ACCOUNT.test(w)) this.add('account_change', `${what} creates an account or grants access`);
    if (INSTALL.test(w)) this.add('install', `${what} installs software or an extension`);
    if (DELETE.test(w)) this.add('data_delete', `${what} deletes or cancels something`);
    if (send && SEND.test(w)) {
      this.add('external_communication', `${what} sends or publishes something`);
      this.transmits = true;
    }
  }

  result(passive: boolean): PageActionClassification {
    return {
      effects: [...this.effects],
      reasons: this.reasons,
      handoff: this.handoff,
      deny: this.deny,
      passive: passive && this.effects.size === 0 && !this.handoff && this.deny === null,
      transmits: this.transmits,
    };
  }
}

/** Classify one write action on an external page. Pure; never throws. */
export function classifyPageAction(input: PageActionInput): PageActionClassification {
  const b = new Builder();
  const el = input.element;
  const label = el ? `"${clipName(el.name) || el.role}" (${el.role})` : 'the page';
  const pageWords = plainWords(pathOf(input.page.url), input.page.title);
  const captchaFrames = input.page.frames.some((f) => CAPTCHA_FRAME.test(f));

  // A frame of a CAPTCHA widget is the CAPTCHA (only the top frame is read).
  if (el?.role === 'iframe' && (captchaFrames || CAPTCHA_FRAME.test(el.name)))
    b.hand('captcha', 'the element is a CAPTCHA; you complete those yourself');

  switch (input.kind) {
    case 'click': {
      b.byWords(elementWords(el), label, !(el?.role === 'link' && !el.form));
      if (isSubmit(el)) {
        b.transmits = true;
        const method = (el?.form?.method ?? 'get').toLowerCase();
        if (method !== 'get' && b.effects.size === 0) {
          b.add('external_communication', `${label} submits a form to ${input.page.host}`);
        }
        if (PAYMENT_PAGE.test(pageWords) && method !== 'get')
          b.add('purchase', `${label} submits a form on a payment page`);
      }
      if (el && (el.inputType ?? '').toLowerCase() === 'file') {
        b.add('external_communication', `${label} opens a file upload`);
        b.transmits = true;
      }
      return b.result(false);
    }
    case 'type': {
      if (isPasswordField(el)) {
        b.deny =
          'The agent never types passwords: ask the user to sign in with browser.sign_in, which ' +
          'opens a private form whose contents never reach you (FR-086).';
        return b.result(false);
      }
      if (isOtpField(el)) {
        b.hand(null, `${label} asks for a verification code; the user enters it`);
        return b.result(false);
      }
      if (isPaymentField(el)) b.add('purchase', `${label} is a payment field`);
      if (CAPTCHA.test(elementWords(el)))
        b.hand('captcha', `${label} is a CAPTCHA; you complete those yourself`);
      if (input.submit) classifySubmission(b, el, label, input.page.host, pageWords);
      return b.result(false);
    }
    case 'select': {
      b.byWords(plainWords(input.value), `choosing "${clipName(input.value ?? '')}"`);
      if (isPaymentField(el)) b.add('purchase', `${label} is a payment field`);
      return b.result(false);
    }
    case 'press': {
      const key = (input.key ?? '').trim().toLowerCase();
      if (PASSIVE_KEYS.has(key)) return b.result(true);
      if (key === 'enter' || key.endsWith('+enter')) {
        const target = input.lastTyped ?? null;
        const what = target ? `"${clipName(target.name) || target.role}" (${target.role})` : label;
        classifySubmission(b, target, what, input.page.host, pageWords);
      }
      return b.result(false);
    }
    case 'hover':
      // Moving the pointer changes nothing on the site (M7); a CAPTCHA widget (above) is still
      // the user's, since such widgets watch the pointer.
      return b.result(true);
    case 'upload': {
      b.add('external_communication', `uploading a file sends it to ${input.page.host}`);
      b.transmits = true;
      return b.result(false);
    }
    case 'download': {
      b.byWords(elementWords(el), label);
      const target = el?.href ? pathOf(el.href).split(' ')[0]! : '';
      if (EXECUTABLE.test(target) || EXECUTABLE.test(el?.name ?? ''))
        b.add('install', `${label} downloads a program`);
      return b.result(false);
    }
    case 'evaluate':
      b.add('exec', 'runs a script in the page (developer-protocol mode)');
      return b.result(false);
  }
}

/** Enter in a field, or type-and-submit: a search stays unflagged, anything else sends a form. */
function classifySubmission(
  b: Builder,
  el: PageElement | null,
  label: string,
  host: string,
  pageWords: string,
): void {
  if (isSearchField(el)) return;
  b.transmits = true;
  b.byWords(plainWords(pathOf(el?.form?.action)), 'the form');
  if (b.effects.size === 0)
    b.add('external_communication', `pressing Enter in ${label} submits a form to ${host}`);
  if (PAYMENT_PAGE.test(pageWords)) b.add('purchase', `${label} submits a form on a payment page`);
}

function clipName(name: string): string {
  const t = name.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

/** A short, human label of an action for the approval card ("Click "Buy now" (button)"). */
export function actionTitle(
  kind: PageActionKind | 'navigate',
  el: PageElement | null,
  extra?: string,
): string {
  const target = el ? ` "${clipName(el.name) || el.role}" (${el.role})` : '';
  switch (kind) {
    case 'click':
      return `Click${target}`;
    case 'hover':
      return `Hover over${target}`;
    case 'type':
      return `Type into${target}`;
    case 'select':
      return `Choose "${clipName(extra ?? '')}" in${target}`;
    case 'press':
      return `Press ${clipName(extra ?? '')}`;
    case 'upload':
      return `Upload ${clipName(extra ?? 'a file')} to${target}`;
    case 'download':
      return `Download from${target}`;
    case 'evaluate':
      return 'Run a script in the page';
    case 'navigate':
      return `Open ${clipName(extra ?? '')}`;
  }
}
