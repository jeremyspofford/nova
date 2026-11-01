// capture-sensitive v1 (capture screening, job 1; owner decision INPUT-2026-10-31-CAPTURE-SCREENING-
// DECISION.md, ADR docs/plans/decision-service.md §2.1; plan docs/plans/ds2-capture-sensitive.md).
// Before captured text (OCR, transcripts) is indexed into memory or archived, it is screened for
// secrets, credentials, and financial or health content, so it can be redacted, excluded, or held
// under the capture retention rules. Written with its rule BEFORE any eval case existed.
//
// Deterministic first (the decision): a known sensitive app (a password manager, a banking app or
// site) is excluded with NO model call. Then pattern detectors, before the model: key and token
// shapes, private-key blocks, password assignments, card numbers (Luhn), IBANs (mod 97), US social
// security numbers, and long high-entropy strings next to a key word. What they find is redacted
// before the model sees the text, and their outcome (redact) stands whatever the model says. The
// model takes the grey area: secrets, financial and health details in ordinary prose.
//
// Never to a cloud seat in local-first or local-only; in cloud mode only with the capture source's
// own opt-in, off by default and not built yet (feature 'capture', service.cloudAllowed).
//
// The rule (a truth table, TypeSafe's 0.7/0.3 bands, not tuned), for a PRIVACY screen, where a
// missed secret costs more than a false hold:
//   a password or a secret key "yes"            → exclude (the model can't say where it is, so
//                                                  it can't be redacted; the text is kept out of
//                                                  the index and the archive, visibly)
//   financial or health details "yes"           → hold (kept only under capture retention, not
//                                                  indexed into memory; marked sensitive)
//   any question unsettled                       → hold (when unsure, don't index)
//   all "no"                                     → index
// Outcomes from least to most restrictive: index, redact, hold, exclude. Untrusted or unanswered →
// index after the deterministic checks (today's behaviour: see the plan's open question).
import type { Band, FieldValue, Finding, Precheck, ServiceTemplate } from '../types.ts';

// ---- deterministic: known sensitive apps ---------------------------------------------------------

// Password managers and banking apps, by name, as they title themselves. Matched on whole words,
// case-insensitive. Best effort; the person's own exclusions (capture settings) come first.
export const SENSITIVE_APPS = [
  '1password', 'bitwarden', 'lastpass', 'keepass', 'keepassxc', 'keepassx', 'dashlane', 'keeper', 'proton pass', 'enpass', 'nordpass', 'roboform',
  'keychain access', 'passwords', 'credential manager', 'kwallet', 'seahorse', 'gnome keyring',
];
const word = (s: string, w: string) => new RegExp(`(?:^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^a-z0-9])`, 'i').test(s);
export function sensitiveApp(app: string, url: string): string | null {
  const a = app.toLowerCase();
  const hit = SENSITIVE_APPS.find((n) => word(a, n));
  if (hit) return `a password manager (${hit})`;
  if (/\bbank(?:ing)?\b/i.test(app)) return 'a banking app';
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* not a URL */ }
  if (host && host.split('.').some((l) => /^(?:bank|banking|onlinebanking|netbank|ebanking)$/.test(l) || /bank$/.test(l) && l.length > 4)) return 'a banking site';
  return null;
}

// ---- deterministic: patterns ---------------------------------------------------------------------

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
function ibanOk(raw: string): boolean {
  const s = raw.replace(/\s+/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const c of moved) {
    const v = /[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}
function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) { const p = k / s.length; h -= p * Math.log2(p); }
  return h;
}

export interface Pattern { kind: string; re: RegExp; ok?: (m: string) => boolean }
export const PATTERNS: Pattern[] = [
  { kind: 'private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g },
  { kind: 'cloud access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'access token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{35}\b|\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b|\bsk-[A-Za-z0-9_-]{20,}\b|\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'signed token', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { kind: 'password in a connection string', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s]+/gi },
  { kind: 'password', re: /\b(?:password|passwd|pwd|passcode|passphrase)\s*(?:is|[:=])\s*["']?(?![•*·.]{3,})[^\s"',;]{4,}|\bpin\s*[:=]\s*\d{4,8}\b/gi },
  { kind: 'card number', re: /\b(?:\d[ -]?){12,18}\d\b/g, ok: (m) => { const d = m.replace(/\D/g, ''); return d.length >= 13 && d.length <= 19 && luhn(d); } },
  { kind: 'bank account (IBAN)', re: /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, ok: ibanOk },
  { kind: 'social security number', re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  // A long random-looking string next to a word that names a secret.
  { kind: 'secret', re: /\b(?:key|token|secret|bearer|authorization|api[_ -]?key|access[_ -]?key)\b["']?\s*[:=]?\s*["']?([A-Za-z0-9+/_=-]{32,})/gi, ok: (m) => { const v = /([A-Za-z0-9+/_=-]{32,})$/.exec(m)?.[1] ?? ''; return entropy(v) >= 4.2 && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v); } },
];

export function findSecrets(text: string): Finding[] {
  const out: Finding[] = [];
  for (const p of PATTERNS) {
    for (const m of text.matchAll(new RegExp(p.re.source, p.re.flags))) {
      if (p.ok && !p.ok(m[0])) continue;
      out.push({ kind: p.kind, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, field: 'text' });
    }
  }
  // Overlaps merge into one finding, named by its most specific pattern (the generic "secret"
  // only when nothing more specific matched).
  out.sort((a, b) => a.start - b.start);
  const merged: Finding[] = [];
  for (const f of out) {
    const last = merged.at(-1);
    if (last && f.start < last.end) { last.end = Math.max(last.end, f.end); if (last.kind === 'secret' && f.kind !== 'secret') last.kind = f.kind; } else merged.push({ ...f });
  }
  return merged;
}

export const redact = (text: string, found: Finding[]): string => {
  let out = '', at = 0;
  for (const f of found) { out += `${text.slice(at, f.start)}[redacted: ${f.kind}]`; at = f.end; }
  return out + text.slice(at);
};

export function capturePrecheck(fields: Record<string, unknown>): Precheck | null {
  const app = typeof fields.app === 'string' ? fields.app : '';
  const url = typeof fields.url === 'string' ? fields.url : '';
  const sensitive = sensitiveApp(app, url);
  if (sensitive) return { outcome: 'exclude', why: `Captured from ${sensitive}: kept out of the index and the archive without any model call.`, findings: [], final: true };
  const text = typeof fields.text === 'string' ? fields.text : '';
  const found = findSecrets(text);
  if (!found.length) return null;
  return { outcome: 'redact', why: `Nova’s own checks found ${[...new Set(found.map((f) => f.kind))].join(', ')} and redacted ${found.length === 1 ? 'it' : 'them'}.`, findings: found, final: false, fields: { ...fields, text: redact(text, found) } };
}

// ---- the model: the grey area --------------------------------------------------------------------

export const CS_QUESTIONS = ['password', 'secret_key', 'financial_details', 'health_details'] as const;

export function capturePolicy(b: Record<string, Band>): 'index' | 'hold' | 'exclude' {
  if (b.password === 'yes' || b.secret_key === 'yes') return 'exclude';
  if (b.financial_details === 'yes' || b.health_details === 'yes') return 'hold';
  if (Object.values(b).includes('unsettled')) return 'hold';
  return 'index';
}

const KIND_WORDS: Record<string, string> = { ocr: 'text read from the screen', transcript: 'a transcript of speech' };

export const CAPTURE_SENSITIVE_V1: ServiceTemplate = {
  template_id: 'capture-sensitive',
  version: 1,
  purpose: 'Before captured screen text or a transcript is indexed into memory or archived: does it show a password, a secret key, or a particular person’s financial or health details?',
  feature: 'capture',
  fields: {
    kind: { type: 'text', max_chars: 16 },
    app: { type: 'text', max_chars: 200, required: false },
    url: { type: 'text', max_chars: 2000, required: false },
    text: { type: 'text', max_chars: 20_000, chunk: 'worst' },
  },
  // What the material is, as a fact; the app it came from (a person would look at it too); the text.
  state: (f: Record<string, FieldValue>) => ({ source: `${KIND_WORDS[String(f.kind)] ?? 'captured text'}${f.app ? ` in ${String(f.app)}` : ''}`, text: f.text }),
  questions: {
    password: {
      type: 'noul',
      instructions: 'Does `text` show a password?',
      criteria: {
        true: 'A password, passcode, PIN or passphrase appears in `text` in readable form, for example "the wifi password is maple-cloud-71" or a PIN written beside an account.',
        false: 'No password is readable in `text`. The word "password" on a button or form label, an empty field, masked dots (••••), or "[redacted: …]" do not count.',
      },
    },
    secret_key: {
      type: 'noul',
      instructions: 'Does `text` show a secret key for a computer service?',
      criteria: {
        true: 'An API key, access token, private key, recovery phrase, session cookie or a password inside a connection string appears in `text` in readable form.',
        false: 'No secret value appears. Documentation that shows a placeholder such as YOUR_API_KEY, a key’s name without its value, a public key, or "[redacted: …]" does not count.',
      },
    },
    financial_details: {
      type: 'noul',
      instructions: 'Does `text` show a particular person’s financial details?',
      criteria: {
        true: 'Account balances, transactions, account or card numbers, salary, tax figures, debts, or loan and investment amounts belonging to a particular person appear in `text`.',
        false: 'No one’s own finances appear. Shop prices, a bank’s advertising, interest rates in an article, a receipt total for a coffee, or a recipe’s cost do not count.',
      },
    },
    health_details: {
      type: 'noul',
      instructions: 'Does `text` describe a particular person’s health?',
      criteria: {
        true: 'A diagnosis, symptoms, test results, medication and doses taken, therapy notes, or medical appointments of an identifiable person appear in `text`.',
        false: 'No particular person’s health is described. A general health article, a recipe that names a vitamin dose, a gym’s timetable, or a pharmacy’s opening hours do not count.',
      },
    },
  },
  policy: {
    outcomes: {
      index: { action: 'index the captured text into memory and the archive', tier: 0 },
      redact: { action: 'index it with the sensitive parts replaced by markers', tier: 0, restrictive: true },
      hold: { action: 'keep it only under capture retention, not indexed, marked sensitive in the timeline', tier: 0, restrictive: true },
      exclude: { action: 'keep it out of the index and the archive, marked excluded in the timeline', tier: 0, restrictive: true },
    },
    table: capturePolicy,
    default: 'index',
    low: 'stop',
    order: ['index', 'redact', 'hold', 'exclude'],
  },
  precheck: capturePrecheck,
  legacy: false,
};
