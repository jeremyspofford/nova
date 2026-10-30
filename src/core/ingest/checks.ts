// The ingest gate's deterministic checks (Amendment 2026-10-30-C Part 3, plan §3). They run on
// every screen, with or without a model, and need nothing but the content: hidden text in HTML,
// invisible and smuggled characters, encoded blobs, links that lie about where they go,
// instruction-shaped text, Nova's own protocol tags, mail authentication and senders, and
// attachments. Pure: no I/O.
//
// Each finding is a flag with a level:
//   - note: recorded, changes nothing on its own (hidden menus, a newsletter's bounce address);
//   - quarantine: the content can't pass as plain data;
//   - block: hidden instructions, or protocol tags in hidden text.
// What a reader would see (`visible`) never includes hidden text or invisible characters.

export type Level = 'note' | 'quarantine' | 'block';
export interface Flag { kind: string; level: Level; count: number }
export interface Span { start: number; end: number; kind: string }
export interface Attachment { name: string; type?: string; size?: number }
export interface CheckInput { text?: string; html?: string; headers?: Record<string, string | undefined>; attachments?: Attachment[] }
export interface Hidden { text: string; why: string }
export interface Checked {
  // What a reader would see: hidden text, invisible and smuggled characters taken out.
  visible: string;
  // Text a reader wouldn't see (hidden by CSS, comments, smuggled characters, decoded blobs), kept
  // apart for the screen to judge and never handed to an acting model.
  hidden: Hidden[];
  flags: Flag[];
  // Instruction-shaped and protocol-tag spans in `visible`, for a quarantine to remove.
  spans: Span[];
}

// The words for each kind, for what a quarantine lists as removed and for the ledger.
export const KIND_WORDS: Record<string, string> = {
  hidden_text: 'hidden text',
  hidden_instructions: 'hidden instructions',
  hidden_protocol: 'hidden control tags',
  invisible_characters: 'invisible characters',
  direction_controls: 'text-direction characters',
  tag_characters: 'hidden tag characters',
  encoded_text: 'encoded text',
  encoded_data: 'encoded data',
  link_mismatch: 'a link that goes somewhere other than it says',
  instructions: 'instruction-like text',
  protocol_tags: 'Nova’s own control tags',
  mail_auth_failed: 'a sender that failed authentication',
  mail_auth_unknown: 'a sender that couldn’t be checked',
  reply_to_mismatch: 'replies that go to another address',
  return_path_mismatch: 'a bounce address elsewhere',
  display_name_mismatch: 'a sender name that names another address',
  attachment_executable: 'a program as an attachment',
  attachment_macro: 'a document with macros',
  attachment_archive: 'an archive',
  attachment_type_mismatch: 'an attachment whose type doesn’t match its name',
  too_long: 'more than Nova reads in full',
  too_deep: 'markup nested deeper than Nova reads',
};

// What the checks read at most. Past this the rest is not read, and the content is held back
// (quarantine at least), never passed.
export const HTML_CAP = 1_000_000;
export const TEXT_CAP = 2_000_000;
const MAX_DEPTH = 256;

// ---- folding ------------------------------------------------------------------------------------
// Before any check, text is folded so a disguise can't hide a pattern: compatibility forms
// (full-width letters, ligatures) become plain ones (NFKC); in a word that mixes Latin with
// Cyrillic or Greek lookalikes, the lookalikes become the Latin letters they imitate; soft hyphens
// go; and letters spelled out one by one ("i g n o r e") are joined. A word wholly in another
// script stays as it is. A copy with every lookalike folded is checked too, for detection only.
const CONFUSABLES: Record<string, string> = {
  '\u0430': 'a', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u0501': 'd', '\u043a': 'k', '\u04bb': 'h', '\u0432': 'b', '\u043c': 'm', '\u043d': 'h', '\u0442': 't', '\u0433': 'r', '\u0457': 'i', '\u04cf': 'l',
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041a': 'K', '\u041c': 'M', '\u041d': 'H', '\u041e': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0423': 'Y', '\u0406': 'I', '\u0408': 'J', '\u0405': 'S',
  '\u03b1': 'a', '\u03bf': 'o', '\u03c1': 'p', '\u03bd': 'v', '\u03b9': 'i', '\u03ba': 'k', '\u03c4': 't', '\u03c5': 'u', '\u03b5': 'e', '\u03c7': 'x',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039a': 'K', '\u039c': 'M', '\u039d': 'N', '\u039f': 'O', '\u03a1': 'P', '\u03a4': 'T', '\u03a5': 'Y', '\u03a7': 'X',
};
const LOOKALIKE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'u');
const LOOKALIKES = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu');
const swap = (w: string) => w.replace(LOOKALIKES, (c) => CONFUSABLES[c] ?? c);

export function fold(text: string): string {
  return text.normalize('NFKC')
    .replace(/\u00ad/g, '')
    // A word mixing Latin letters with lookalikes from another script.
    .replace(/[\p{L}\p{M}]+/gu, (w) => (/[A-Za-z]/.test(w) && LOOKALIKE.test(w) ? swap(w) : w))
    // Letters spelled out one by one, four or more.
    .replace(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}] ){3,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu, (run) => run.replace(/ /g, ''));
}
// Every lookalike folded, wherever it is: for detection only.
export const foldAll = (text: string) => swap(fold(text));

// ---- characters ---------------------------------------------------------------------------------

const ZERO_WIDTH = /[​⁠-⁤᠎]|(?<!^)﻿/gu;
const JOINERS = /[‌‍]/gu;
const DIRECTION = /[‪-‮⁦-⁩]/gu;
const TAGS = /[\u{E0000}-\u{E007F}]+/gu;
const ASCIIISH = /[\x20-\x7E]/;

function characters(text: string, flags: Flags, hidden: Hidden[]): string {
  let out = text;
  // Unicode tag characters spell ASCII nobody sees. A flag for a region (🏴 + letters + cancel)
  // is the one ordinary use.
  out = out.replace(TAGS, (run, at: number, whole: string) => {
    const spelled = [...run].map((c) => c.codePointAt(0)! - 0xE0000).filter((n) => n >= 0x20 && n < 0x7F).map((n) => String.fromCharCode(n)).join('');
    const flag = whole.codePointAt(at - 2) === 0x1F3F4 && /^[a-z0-9]{2,7}$/.test(spelled) && run.endsWith('\u{E007F}');
    if (flag) return run;
    hidden.push({ text: spelled, why: 'tag characters' });
    flags.add('tag_characters', 'quarantine');
    return '';
  });
  out = out.replace(ZERO_WIDTH, () => { flags.add('invisible_characters', 'quarantine'); return ''; });
  // Joiners belong between letters of scripts that need them, and inside emoji; between plain
  // ASCII they only hide something.
  out = out.replace(JOINERS, (j, at: number, whole: string) => {
    const before = whole[at - 1] ?? ' ';
    const after = whole[at + 1] ?? ' ';
    if (ASCIIISH.test(before) && ASCIIISH.test(after)) { flags.add('invisible_characters', 'quarantine'); return ''; }
    return j;
  });
  out = out.replace(DIRECTION, () => { flags.add('direction_controls', 'quarantine'); return ''; });
  return out;
}

// ---- instruction-shaped text --------------------------------------------------------------------

const AI = String.raw`(?:ai|a\.i\.|assistants?|ai assistants?|ai agents?|ai models?|language models?|llms?|chat ?bots?|bots?|agents?|nova)`;
const PATTERNS: RegExp[] = [
  // "ignore all previous instructions", and its relatives
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|existing|original|system|your|all)\b[^.\n]{0,20}?\b(?:instructions?|prompts?|messages|rules|directions|directives|guidelines|guardrails|context)\b/i,
  // addressed to an AI: "Attention AI:", "Note to the assistant,", "Hey Nova,"
  new RegExp(String.raw`(?:^|[\n.!?:;>]\s*|\b)(?:dear|hey|hi|hello|attention|note (?:to|for)|message (?:to|for)|instructions? (?:to|for))\s+(?:the\s+|any\s+|all\s+)?${AI}\b`, 'i'),
  new RegExp(String.raw`\bif you(?:'re|’re| are)\s+(?:an?\s+|the\s+)?${AI}\b`, 'i'),
  new RegExp(String.raw`\b${AI}\s+(?:reading|processing|summari[sz]ing|parsing|browsing|visiting|scanning)\s+(?:this|these|the)\b`, 'i'),
  new RegExp(String.raw`(?:^|[\n.!?]\s*)${AI}\s*[,:]\s*(?:please\s+)?(?:you\s+)?(?:must|should|ignore|do|send|fetch|open|run|execute|reply|forward|email|tell|reveal|include|write|save|remember|delete|visit)\b`, 'i'),
  /\byou are now\b|\bfrom now on,? you\b|\bpretend (?:to be|you are)\b|\bdeveloper mode\b|\bjailbreak/i,
  /\b(?:new|updated|real|actual|hidden|secret|additional) (?:instructions?|directives?|orders)\s*[:\-–]/i,
  // role and system markers
  /^\s*(?:#{1,4}\s*)?(?:system|assistant|developer)\s*(?:prompt|message)?\s*:\s*(?:you\b|ignore\b|new\b|from now\b|always\b|never\b|do not\b|don't\b|the (?:user|assistant)\b)/im,
  /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|\[\/?SYSTEM\]|###\s*(?:instruction|system)\b/i,
  // asking for secrets, or for them to be sent somewhere
  /\b(?:send|forward|email|e-mail|post|upload|share|leak|exfiltrate|transmit)\b[^.\n]{0,60}?\b(?:passwords?|passcodes?|credentials?|api[ -]?keys?|secrets?|tokens?|private keys?|ssh keys?|one[- ]time codes?|recovery codes?|memor(?:y|ies)|saved notes|notes|chat history|conversation history|contacts|inbox|emails|files)\b[^.\n]{0,40}?\b(?:to|at|into|via)\b\s*(?:https?:\/\/|[\w.+-]+@[\w-]+\.|this (?:address|url|link|email|site|server)|the (?:address|url|link|server) (?:below|above))/i,
  /\b(?:reveal|disclose|repeat|print|output|show|tell me|list)\b[^.\n]{0,20}?\b(?:your|the)\s+(?:system prompt|instructions|initial prompt|hidden prompt|memor(?:y|ies)|saved (?:notes|passwords)|secrets|api keys?)\b/i,
  // a URL with a slot to fill, with a verb that would fetch it
  /\b(?:visit|open|fetch|load|navigate to|go to|request|call|curl|wget|browse to)\b[^\n]{0,40}?https?:\/\/\S*(?:\{[^}\s]*\}|\[[A-Z_ ]{3,}\]|<[A-Za-z_ ]{3,}>|\$\{?[A-Z_]{3,}\}?)/i,
  /\b(?:do not|don't|don’t|never) (?:tell|inform|mention|alert|notify|show|ask)\b[^.\n]{0,30}\b(?:the )?(?:user|person|owner|human)\b/i,
  /\b(?:the user|the person|the owner|the human) (?:has )?(?:already )?(?:authori[sz]ed|approved|wants you to|asked you to|instructs? you)\b/i,
  /\bwithout (?:asking|telling|confirming with|checking with) (?:the )?(?:user|person|owner|human)\b/i,
];

// Nova's own protocol tags (tools.js, context.js) and the gate's data fence, opening or closing.
export const PROTOCOL_NAMES = ['tool_call', 'tool_result', 'remember', 'forget', 'note', 'handoff', 'user', 'nova', 'skill', 'connector', 'file', 'memory_search', 'conversation', 'followup', 'outside', 'system'];
const PROTOCOL = new RegExp(String.raw`<\s*\/?\s*(?:${PROTOCOL_NAMES.join('|')})\b[^<>\n]{0,200}>?`, 'gi');

function merge(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end) { last.end = Math.max(last.end, s.end); continue; }
    out.push({ ...s });
  }
  return out;
}

// The spans of `text` that read as instructions to an assistant, each widened to its sentence.
export function instructionSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const re of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      if (!m[0].trim()) continue;
      const at = m.index ?? 0;
      spans.push(sentence(text, at, at + m[0].length));
    }
  }
  return merge(spans);
}

// Widened at most 300 characters each way, so a long text without full stops stays linear.
function sentence(text: string, start: number, end: number): Span {
  let s = start;
  const low = Math.max(0, start - 300);
  while (s > low && !/[.!?\n]/.test(text[s - 1]!)) s--;
  let e = end;
  const high = Math.min(text.length, end + 300);
  while (e < high && !/[.!?\n]/.test(text[e - 1] ?? '')) e++;
  return { start: s, end: Math.min(text.length, e), kind: 'instructions' };
}

export function protocolSpans(text: string): Span[] {
  return [...text.matchAll(PROTOCOL)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: 'protocol_tags' }));
}

export const looksLikeInstructions = (text: string) => instructionSpans(squash(fold(text))).length > 0 || instructionSpans(squash(foldAll(text))).length > 0;
export const hasProtocolTags = (text: string) => protocolSpans(fold(text)).length > 0 || protocolSpans(foldAll(text)).length > 0;
const squash = (s: string) => s.replace(ZERO_WIDTH, '').replace(JOINERS, '').replace(/\s+/g, ' ');

// ---- encoded blobs ------------------------------------------------------------------------------

const BASE64 = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
const HEX = /(?:\\x[0-9a-fA-F]{2}){12,}|\b(?:[0-9a-fA-F]{2}){20,}\b/g;
const PERCENT = /(?:%[0-9A-Fa-f]{2}[^\s%]{0,3}){10,}/g;

// Whether bytes read as words: printable, with spaces and letters.
export function wordy(s: string): boolean {
  if (s.length < 12) return false;
  const printable = [...s].filter((c) => /[\x20-\x7E\n\t]/.test(c)).length / s.length;
  const letters = (s.match(/[A-Za-z]/g) ?? []).length / s.length;
  return printable > 0.95 && letters > 0.5 && /[A-Za-z]{2,} [A-Za-z]{2,}/.test(s);
}

// Encoded runs and what they decode to.
export function decodeBlobs(text: string): { raw: string; decoded: string | null }[] {
  const out: { raw: string; decoded: string | null }[] = [];
  for (const m of text.matchAll(BASE64)) {
    const raw = m[0];
    if (/^[0-9a-fA-F]+$/.test(raw)) continue; // hex: below
    let decoded: string | null = null;
    try { decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch { /* not base64 */ }
    out.push({ raw, decoded: decoded && wordy(decoded) ? decoded : null });
  }
  for (const m of text.matchAll(HEX)) {
    const raw = m[0];
    const hex = raw.replace(/\\x/g, '');
    const decoded = Buffer.from(hex, 'hex').toString('utf8');
    out.push({ raw, decoded: wordy(decoded) ? decoded : null });
  }
  for (const m of text.matchAll(PERCENT)) {
    let decoded: string | null = null;
    try { decoded = decodeURIComponent(m[0]); } catch { /* broken */ }
    out.push({ raw: m[0], decoded: decoded && wordy(decoded) ? decoded : null });
  }
  return out;
}

function blobs(text: string, flags: Flags, hidden: Hidden[]): void {
  for (const b of decodeBlobs(text)) {
    if (b.decoded === null) { flags.add('encoded_data', 'note'); continue; }
    hidden.push({ text: b.decoded, why: 'encoded' });
    flags.add('encoded_text', 'quarantine');
  }
}

// ---- HTML ---------------------------------------------------------------------------------------

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'noscript', 'svg', 'math', 'iframe', 'object', 'textarea', 'title', 'xmp']);
const DROPPED = new Set(['script', 'style', 'noscript', 'svg', 'math', 'iframe', 'object', 'head']);
const BREAK = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr', 'br', 'section', 'article', 'header', 'footer', 'ul', 'ol', 'table', 'blockquote', 'pre', 'nav', 'aside', 'main', 'form', 'dt', 'dd', 'figcaption', 'hr']);
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
  copy: '©', reg: '®', trade: '™', times: '×', deg: '°', euro: '€', pound: '£', cent: '¢', yen: '¥',
  zwj: '‍', zwnj: '‌', shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : m;
  });
}

type Rgb = [number, number, number, number];
const NAMED: Record<string, Rgb> = {
  white: [255, 255, 255, 1], black: [0, 0, 0, 1], transparent: [0, 0, 0, 0], red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1],
  gray: [128, 128, 128, 1], grey: [128, 128, 128, 1], silver: [192, 192, 192, 1], yellow: [255, 255, 0, 1], navy: [0, 0, 128, 1], maroon: [128, 0, 0, 1],
  purple: [128, 0, 128, 1], teal: [0, 128, 128, 1], olive: [128, 128, 0, 1], lime: [0, 255, 0, 1], aqua: [0, 255, 255, 1], cyan: [0, 255, 255, 1],
  fuchsia: [255, 0, 255, 1], magenta: [255, 0, 255, 1], orange: [255, 165, 0, 1], whitesmoke: [245, 245, 245, 1], snow: [255, 250, 250, 1],
  ivory: [255, 255, 240, 1], beige: [245, 245, 220, 1], linen: [250, 240, 230, 1], gainsboro: [220, 220, 220, 1], lightgray: [211, 211, 211, 1],
  lightgrey: [211, 211, 211, 1], darkgray: [169, 169, 169, 1], darkgrey: [169, 169, 169, 1], dimgray: [105, 105, 105, 1], dimgrey: [105, 105, 105, 1],
};

function hsl(h: number, sat: number, l: number): [number, number, number] {
  const a = sat * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}

export function parseColor(v: string | undefined): Rgb | null {
  if (!v) return null;
  const s = v.trim().toLowerCase().replace(/\s*!important$/, '');
  if (NAMED[s]) return NAMED[s]!;
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    const h = m[1]!;
    const full = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join('') : h;
    if (full.length !== 6 && full.length !== 8) return null;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  m = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return [...hsl(((Number(m[1]) % 360) + 360) % 360, Number(m[2]) / 100, Number(m[3]) / 100), a];
  }
  return null;
}

const same = (a: Rgb, b: Rgb) => Math.abs(a[0] - b[0]) <= 8 && Math.abs(a[1] - b[1]) <= 8 && Math.abs(a[2] - b[2]) <= 8;

function decls(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of style.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim().toLowerCase());
  }
  return out;
}

const num = (v: string | undefined) => {
  const m = /^(-?[\d.]+)\s*([a-z%]*)/.exec(v ?? '');
  return m ? { n: Number(m[1]), unit: m[2] ?? '' } : null;
};

// Why a style hides its element, or null.
export function hiddenBy(style: string): string | null {
  const d = decls(style);
  const get = (k: string) => d.get(k)?.replace(/\s*!important$/, '');
  if (get('display') === 'none') return 'display:none';
  if (/^(hidden|collapse)$/.test(get('visibility') ?? '')) return 'visibility:hidden';
  const op = num(get('opacity'));
  if (op && op.n <= 0.05) return 'opacity:0';
  const fs = num(get('font-size'));
  if (fs && (fs.n <= 0 || (fs.unit === 'px' && fs.n < 2) || (fs.unit === 'pt' && fs.n < 1.5) || ((fs.unit === 'em' || fs.unit === 'rem') && fs.n <= 0.15) || (fs.unit === '%' && fs.n < 10))) return 'font-size:0';
  const zero = (k: string) => { const x = num(get(k)); return !!x && x.n <= 1 && (x.unit === '' || x.unit === 'px' || x.unit === '%' || x.unit === 'em'); };
  if ((zero('height') || zero('max-height') || zero('width') || zero('max-width')) && /hidden|clip/.test(get('overflow') ?? '')) return 'zero size';
  const clip = get('clip');
  const clipPath = get('clip-path');
  if ((clip && clip !== 'auto') || (clipPath && clipPath !== 'none')) return 'clipped';
  const far = (k: string) => { const x = num(get(k)); return !!x && x.n <= -500; };
  if (/absolute|fixed/.test(get('position') ?? '') && (far('left') || far('top') || far('right'))) return 'off-screen';
  if (far('text-indent') || far('margin-left')) return 'off-screen';
  if (/scale\(\s*0(\.0+)?\s*\)/.test(get('transform') ?? '')) return 'scaled to nothing';
  if (get('color') === 'transparent') return 'transparent text';
  return null;
}

interface Frame { tag: string; hidden: string | null; bg: Rgb; color: Rgb | null; dropped: boolean; link: { href: string; text: string } | null; buf: string[] | null }

function attrsOf(s: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of s.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out.set(m[1]!.toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return out;
}

// Simple stylesheet rules (".a, #b, p.c { display: none }") that hide elements.
function hidingRules(html: string): { classes: Set<string>; ids: Set<string> } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const lower = html.toLowerCase();
  const blocks: string[] = [];
  for (let at = lower.indexOf('<style'); at >= 0; at = lower.indexOf('<style', at)) {
    const open = lower.indexOf('>', at);
    const end = open < 0 ? -1 : lower.indexOf('</style', open);
    if (end < 0) break; // unclosed: the rest is read as text by htmlParts, never twice
    blocks.push(html.slice(open + 1, end));
    at = end;
  }
  for (const block of blocks) {
    for (const rule of block.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!hiddenBy(rule[2]!)) continue;
      for (const sel of rule[1]!.split(',').map((x) => x.trim())) {
        const m = /^[a-z0-9]*((?:[.#][\w-]+)+)$/i.exec(sel);
        if (!m) continue;
        for (const p of m[1]!.matchAll(/([.#])([\w-]+)/g)) (p[1] === '.' ? classes : ids).add(p[2]!);
      }
    }
  }
  return { classes, ids };
}

// Linear: no part of a token can run past the next "<", so a broken tag fails at once and is read
// as text, instead of every "<" scanning to the end of the page.
const TOKEN = /<!--([\s\S]*?)(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^<>]*>|<\?[^<>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=/<>]+(?:\s*=\s*(?:"[^"<]*"|'[^'<]*'|[^\s<>]+))?)*)\s*(\/?)>|([^<]+)|(<)/g;
const WHITE: Rgb = [255, 255, 255, 1];

export interface HtmlParts { visible: string; hidden: Hidden[]; links: { text: string; href: string }[]; attrs: { text: string; where: string }[]; comments: string[] }

// The page as a reader sees it, and what it hides.
export function htmlParts(html: string): HtmlParts & { deep: boolean } {
  const rules = hidingRules(html);
  const lower = html.toLowerCase();
  let deep = false;
  const out: string[] = [];
  const hidden: Hidden[] = [];
  const links: { text: string; href: string }[] = [];
  const attrs: { text: string; where: string }[] = [];
  const comments: string[] = [];
  const stack: Frame[] = [{ tag: '#root', hidden: null, bg: WHITE, color: null, dropped: false, link: null, buf: null }];
  const top = () => stack.at(-1)!;
  const close = (i: number) => {
    while (stack.length > i) {
      const f = stack.pop()!;
      if (f.buf) hidden.push({ text: f.buf.join('').replace(/\s+/g, ' ').trim(), why: f.hidden ?? 'hidden' });
      if (f.link) links.push({ text: f.link.text.replace(/\s+/g, ' ').trim(), href: f.link.href });
      if (BREAK.has(f.tag)) emit('\n');
    }
  };
  const emit = (text: string) => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i]!;
      if (f.link) f.link.text += text;
    }
    const t = top();
    if (t.dropped) return;
    if (t.hidden) { nearestBuf()?.push(text); return; }
    out.push(text);
  };
  const nearestBuf = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.buf) return stack[i]!.buf; return null; };
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(html))) {
    if (m[1] !== undefined) { const c = m[1].trim(); if (c) comments.push(c); continue; }
    if (m[2] !== undefined) {
      const tag = m[2].toLowerCase();
      let i = stack.length - 1;
      while (i > 0 && stack[i]!.tag !== tag) i--;
      if (i > 0) close(i);
      continue;
    }
    if (m[3] !== undefined) {
      const tag = m[3].toLowerCase();
      const a = attrsOf(m[4] ?? '');
      for (const k of ['alt', 'title', 'aria-label', 'placeholder']) if (a.get(k)) attrs.push({ text: a.get(k)!, where: k });
      if (tag === 'meta' && a.get('content') && /description|keywords|^og:|^twitter:/i.test(a.get('name') ?? a.get('property') ?? '')) attrs.push({ text: a.get('content')!, where: 'meta' });
      if (tag === 'br') { emit('\n'); continue; }
      if (tag === 'img' && a.get('alt')) { /* alt is read for instructions only */ }
      if (VOID.has(tag) || m[5] === '/') continue;
      const parent = top();
      if (RAW.has(tag)) {
        // Raw text up to its own closing tag, read as text, never as markup.
        const end = lower.indexOf(`</${tag}`, TOKEN.lastIndex);
        const body = html.slice(TOKEN.lastIndex, end < 0 ? html.length : end);
        TOKEN.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1 || html.length;
        if (tag === 'title') attrs.push({ text: decodeEntities(body).trim(), where: 'title' });
        // Text in an SVG or a noscript block isn't dropped silently: it is kept apart and screened.
        if (tag === 'svg' || tag === 'noscript' || tag === 'math') {
          const text = decodeEntities(body.replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
          if (text) hidden.push({ text, why: tag });
        }
        if (tag === 'textarea' && !parent.dropped) emit(decodeEntities(body));
        continue;
      }
      const style = a.get('style') ?? '';
      const d = decls(style);
      const bg = parseColor(d.get('background-color') ?? d.get('background')?.split(/\s+/).find((x) => parseColor(x))) ?? parseColor(a.get('bgcolor')) ?? parent.bg;
      const color = parseColor(d.get('color')) ?? parseColor(a.get('color')) ?? parent.color;
      const classes = (a.get('class') ?? '').split(/\s+/).filter(Boolean);
      let why = parent.hidden ? null : hiddenBy(style)
        ?? (a.has('hidden') ? 'hidden' : null)
        ?? (a.get('aria-hidden') === 'true' ? 'aria-hidden' : null)
        ?? (tag === 'template' ? 'template' : null)
        ?? (classes.some((c) => rules.classes.has(c)) || rules.ids.has(a.get('id') ?? '') ? 'stylesheet' : null)
        ?? (color && (color[3] <= 0.05 || same(color, bg)) && (d.has('color') || a.has('color') || d.has('background') || d.has('background-color')) ? 'same colour as its background' : null);
      const frame: Frame = {
        tag, hidden: parent.hidden ?? why, bg, color, dropped: parent.dropped || DROPPED.has(tag),
        link: tag === 'a' && a.get('href') ? { href: a.get('href')!, text: '' } : null,
        buf: why && !parent.hidden && !parent.dropped ? [] : null,
      };
      if (BREAK.has(tag)) emit('\n');
      if (tag === 'li') emit('- ');
      // Nesting past MAX_DEPTH isn't followed (each element is read as its parent); that is said.
      if (stack.length >= MAX_DEPTH) { deep = true; continue; }
      stack.push(frame);
      continue;
    }
    if (m[6] !== undefined) { emit(decodeEntities(m[6])); continue; }
    if (m[7] !== undefined) emit('<');
  }
  close(1);
  const visible = out.join('')
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
  return { visible, hidden: hidden.filter((h) => h.text), links, attrs: attrs.filter((x) => x.text), comments, deep };
}

// ---- links --------------------------------------------------------------------------------------

const HOST_IN_TEXT = /(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?=[/:?#\s]|$)/i;
const hostOf = (href: string): string | null => { try { return new URL(href).hostname.toLowerCase(); } catch { return null; } };
const sameSite = (a: string, b: string) => {
  const x = a.replace(/^www\./, '');
  const y = b.replace(/^www\./, '');
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
};

function linkChecks(links: { text: string; href: string }[], flags: Flags): void {
  for (const l of links) {
    const shown = HOST_IN_TEXT.exec(l.text.trim())?.[1]?.toLowerCase();
    const real = hostOf(l.href);
    if (!shown || !real || !/^https?:/i.test(l.href)) continue;
    // Only when the words are an address themselves: "Read more" says nothing about where it goes.
    if (l.text.trim().split(/\s+/).length > 3) continue;
    if (!sameSite(shown, real)) flags.add('link_mismatch', 'quarantine');
  }
}

// ---- mail ---------------------------------------------------------------------------------------

const addressOf = (v: string | undefined): string | null => {
  if (!v) return null;
  const m = /<([^<>@\s]+@[^<>\s]+)>/.exec(v) ?? /([^\s<>"']+@[^\s<>"']+)/.exec(v);
  return m ? m[1]!.toLowerCase().replace(/[>.,;]+$/, '') : null;
};
const domainOf = (addr: string | null) => addr?.split('@')[1] ?? null;

function mailChecks(h: Record<string, string | undefined>, flags: Flags): void {
  const from = addressOf(h.from);
  const auth = (h['authentication-results'] ?? '').toLowerCase();
  const verdict = (k: string) => new RegExp(`\\b${k}\\s*=\\s*(\\w+)`).exec(auth)?.[1] ?? null;
  const dmarc = verdict('dmarc');
  const spf = verdict('spf');
  const dkim = verdict('dkim');
  const bad = (v: string | null) => v === 'fail' || v === 'softfail' || v === 'permerror';
  if (bad(dmarc) || (dmarc !== 'pass' && (bad(spf) || bad(dkim)))) flags.add('mail_auth_failed', 'quarantine');
  else if (dmarc !== 'pass') flags.add('mail_auth_unknown', 'note');
  const passed = dmarc === 'pass';
  const replyTo = addressOf(h['reply-to']);
  if (from && replyTo && !sameSite(domainOf(from)!, domainOf(replyTo)!)) flags.add('reply_to_mismatch', 'quarantine');
  const ret = addressOf(h['return-path']);
  if (from && ret && !sameSite(domainOf(from)!, domainOf(ret)!)) flags.add('return_path_mismatch', passed ? 'note' : 'quarantine');
  // The display name says an address (or a site) that isn't where it comes from.
  const name = (h.from ?? '').replace(/<[^>]*>\s*$/, '').replace(/["']/g, '').trim();
  const named = addressOf(name) ?? (HOST_IN_TEXT.exec(name)?.[1]?.toLowerCase() ? `x@${HOST_IN_TEXT.exec(name)![1]!.toLowerCase()}` : null);
  if (from && named && name !== from && !sameSite(domainOf(named)!, domainOf(from)!)) flags.add('display_name_mismatch', 'quarantine');
}

// ---- attachments --------------------------------------------------------------------------------

const EXECUTABLE = /\.(exe|scr|bat|cmd|com|pif|js|jse|vbs|vbe|wsf|ps1|msi|msp|jar|app|sh|apk|dll|lnk|hta|cpl|reg|iso|img|dmg|run|bin)$/i;
const MACRO = /\.(docm|dotm|xlsm|xltm|xlam|pptm|potm|ppam|sldm)$/i;
const ARCHIVE = /\.(zip|rar|7z|gz|tgz|tar|bz2|xz|cab|arj|lz|zst)$/i;
const TYPES: Record<string, RegExp> = {
  pdf: /^application\/pdf$/, txt: /^text\//, csv: /^text\/|csv/, jpg: /^image\/jpe?g$/, jpeg: /^image\/jpe?g$/, png: /^image\/png$/, gif: /^image\/gif$/,
  doc: /msword|officedocument/, docx: /officedocument|msword/, xls: /excel|officedocument/, xlsx: /officedocument|excel/, html: /^text\/html$/, md: /^text\//,
};

function attachmentChecks(files: Attachment[], flags: Flags): void {
  for (const f of files) {
    const name = String(f.name ?? '').trim().toLowerCase();
    if (EXECUTABLE.test(name)) flags.add('attachment_executable', 'quarantine');
    else if (MACRO.test(name)) flags.add('attachment_macro', 'quarantine');
    else if (ARCHIVE.test(name)) flags.add('attachment_archive', 'note');
    const ext = /\.([a-z0-9]+)$/.exec(name)?.[1];
    const type = (f.type ?? '').toLowerCase();
    if (ext && type && type !== 'application/octet-stream' && TYPES[ext] && !TYPES[ext]!.test(type)) flags.add('attachment_type_mismatch', 'quarantine');
    if (type && /x-msdownload|x-executable|x-dosexec|x-sh|java-archive/.test(type) && !EXECUTABLE.test(name)) flags.add('attachment_type_mismatch', 'quarantine');
  }
}

// ---- all of it ----------------------------------------------------------------------------------

class Flags {
  #m = new Map<string, Flag>();
  add(kind: string, level: Level, n = 1): void {
    const f = this.#m.get(kind);
    if (!f) { this.#m.set(kind, { kind, level, count: n }); return; }
    f.count += n;
    const rank = { note: 0, quarantine: 1, block: 2 };
    if (rank[level] > rank[f.level]) f.level = level;
  }
  list(): Flag[] { return [...this.#m.values()]; }
}

// Markup in content that didn't come as HTML (a text/plain page, a file): it may still be read as
// markup by someone, so it gets the HTML checks too, for what it hides.
const MARKUP = /<(?:[a-z][\w-]*\s[^<>]*\b(?:style|hidden|aria-hidden|class)\b|!--|template\b|noscript\b|svg\b)/i;

function fromHtml(html: string, flags: Flags, hidden: Hidden[]): string {
  const p = htmlParts(html);
  for (const h of p.hidden) hidden.push(h);
  if (p.hidden.length) flags.add('hidden_text', 'note', p.hidden.length);
  if (p.deep) flags.add('too_deep', 'quarantine');
  for (const c of p.comments) if (looksLikeInstructions(c) || hasProtocolTags(c)) hidden.push({ text: c, why: 'comment' });
  for (const a of p.attrs) if (looksLikeInstructions(a.text) || hasProtocolTags(a.text)) hidden.push({ text: a.text, why: a.where });
  linkChecks(p.links, flags);
  return p.visible;
}

export function check(input: CheckInput): Checked {
  const flags = new Flags();
  const hidden: Hidden[] = [];
  let visible: string;
  if (typeof input.html === 'string' && input.html.trim()) {
    let html = input.html;
    if (html.length > HTML_CAP) { html = html.slice(0, HTML_CAP); flags.add('too_long', 'quarantine'); }
    visible = fromHtml(html, flags, hidden);
  } else {
    visible = String(input.text ?? '');
    if (visible.length > TEXT_CAP) { visible = visible.slice(0, TEXT_CAP); flags.add('too_long', 'quarantine'); }
    // The text stays as it is (a plain-text reader sees the markup); what the markup hides is checked.
    if (MARKUP.test(visible)) fromHtml(visible.slice(0, HTML_CAP), new Flags(), hidden);
  }
  visible = fold(characters(visible, flags, hidden));
  blobs(visible, flags, hidden);
  // Hidden text is judged as a whole: instructions there block, and so do Nova's tags.
  for (const h of [...hidden]) {
    const text = characters(h.text, new Flags(), []);
    for (const b of decodeBlobs(text)) if (b.decoded) hidden.push({ text: b.decoded, why: `${h.why}, encoded` });
  }
  for (const h of hidden) {
    if (looksLikeInstructions(h.text)) flags.add('hidden_instructions', 'block');
    if (hasProtocolTags(h.text)) flags.add('hidden_protocol', 'block');
  }
  const said = instructionSpans(visible);
  const tags = protocolSpans(visible);
  const spans = merge([...said, ...tags]);
  if (said.length) flags.add('instructions', 'quarantine', said.length);
  if (tags.length) flags.add('protocol_tags', 'quarantine', tags.length);
  // Lookalikes in words wholly of another script, folded for detection only: what they spell
  // can't be cut out precisely, so the content is held back.
  const all = foldAll(visible);
  if (!said.length && instructionSpans(all).length) flags.add('instructions', 'quarantine');
  if (!tags.length && protocolSpans(all).length) flags.add('protocol_tags', 'quarantine');
  if (input.headers && Object.keys(input.headers).length) mailChecks(lower(input.headers), flags);
  if (input.attachments?.length) attachmentChecks(input.attachments, flags);
  return { visible, hidden, flags: flags.list(), spans };
}

const lower = (h: Record<string, string | undefined>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
