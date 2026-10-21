// Just enough MIME to read email that arrives as raw bytes (IMAP): headers
// with encoded words, multipart bodies, base64 and quoted-printable, charsets.
// Messages are handled as latin1 strings, one character per byte, so nothing
// is decoded until its charset is known. A message cut short still parses.
import { htmlToText } from './tools.js';

const decode = (bytes, charset = 'utf-8') => {
  try { return new TextDecoder(charset.toLowerCase() === 'us-ascii' ? 'utf-8' : charset).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
};
const bytesOf = (s) => Buffer.from(s, 'latin1');

// "=?UTF-8?B?Q2Fmw6k=?=" → "Café". Adjacent encoded words join without a space.
export function decodeWords(value) {
  return String(value)
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?*]+)(?:\*[^?]*)?\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, text) => {
      const raw = enc.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64')
        : bytesOf(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))));
      return decode(raw, charset);
    });
}

// Header block → Map of lower-case name → [values], folded lines joined.
export function parseHeaders(block) {
  const headers = new Map();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = decodeWords(decode(bytesOf(line.slice(at + 1).trim())));
    headers.set(name, [...(headers.get(name) ?? []), value]);
  }
  return headers;
}

// 'text/plain; charset="utf-8"' → { type: 'text/plain', params: { charset: 'utf-8' } }
export function parseType(value = '') {
  const [type, ...rest] = String(value).split(';');
  const params = {};
  for (const p of rest) {
    const m = p.match(/^\s*([\w*-]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^\s;]+)/);
    if (!m) continue;
    let key = m[1].toLowerCase();
    let val = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[2];
    if (key.endsWith('*')) { // RFC 2231: utf-8''Caf%C3%A9
      key = key.slice(0, -1);
      const x = val.match(/^([^']*)'[^']*'(.*)$/);
      if (x) val = decode(bytesOf(x[2].replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))), x[1] || 'utf-8');
    }
    params[key.replace(/\*\d+$/, '')] = (params[key.replace(/\*\d+$/, '')] ?? '') + val;
  }
  return { type: type.trim().toLowerCase() || 'text/plain', params };
}

function bodyBytes(raw, encoding = '') {
  const e = encoding.trim().toLowerCase();
  if (e === 'base64') return Buffer.from(raw.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') {
    return bytesOf(raw.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
  }
  return bytesOf(raw);
}

// raw: a whole message (or part) as a latin1 string.
export function parseMessage(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split < 0 ? raw : raw.slice(0, split);
  const body = split < 0 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers = parseHeaders(head);
  const ct = parseType(headers.get('content-type')?.[0]);
  const disposition = parseType(headers.get('content-disposition')?.[0] ?? '');
  const part = {
    headers,
    type: ct.type,
    charset: ct.params.charset ?? 'utf-8',
    filename: disposition.params.filename ?? ct.params.name ?? '',
    attachment: disposition.type === 'attachment',
    encoding: headers.get('content-transfer-encoding')?.[0] ?? '',
    raw: body,
    parts: [],
  };
  if (part.filename) part.filename = decodeWords(part.filename);
  if (ct.type.startsWith('multipart/') && ct.params.boundary) {
    const b = `--${ct.params.boundary}`;
    const end = body.indexOf(`${b}--`);
    const inner = end >= 0 ? body.slice(0, end) : body;
    const chunks = inner.split(new RegExp(`\\r?\\n?${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*\\r?\\n`));
    for (const chunk of chunks.slice(1)) if (chunk.trim()) part.parts.push(parseMessage(chunk));
  } else if (ct.type === 'message/rfc822') {
    part.parts.push(parseMessage(body));
  }
  return part;
}

export const partText = (p) => decode(bodyBytes(p.raw, p.encoding), p.charset);

// Plain text when the message has it, otherwise its HTML as text.
export function messageText(msg) {
  const plain = [];
  const html = [];
  const walk = (p) => {
    if (p.attachment || (p.filename && !p.type.startsWith('multipart/'))) return;
    if (p.type === 'text/plain') plain.push(partText(p));
    else if (p.type === 'text/html') html.push(partText(p));
    for (const c of p.parts) walk(c);
  };
  walk(msg);
  const text = plain.length ? plain.join('\n\n') : html.map(htmlToText).join('\n\n');
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// [{ name, size }] for every attached file; size is null when the message was cut short.
export function messageFiles(msg) {
  const out = [];
  const walk = (p) => {
    if (p.filename && !p.type.startsWith('multipart/')) {
      const whole = /\r?\n$/.test(p.raw) || p.encoding.toLowerCase() !== 'base64';
      out.push({ name: p.filename, size: whole ? bodyBytes(p.raw, p.encoding).length : null });
      return;
    }
    for (const c of p.parts) walk(c);
  };
  walk(msg);
  return out;
}

export const header = (msg, name) => msg.headers.get(name)?.[0];
