// What both ways into Gmail share: errors, the words for a change, and the
// message format for drafts.

// code: not_connected | reconnect | bad_client | bad_password | unreachable | denied | expired | google | missing | bad_request
export class GmailError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export const ID = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_DRAFT = 20_000;
const MAX_BODY = 12_000;
const MAX_RESULTS = 50;
const MAX_CHANGE = 50;

export const clean = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
export const name = (from = '') => from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] ?? from;
const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// "Archive 2 emails and mark them read", or with past: "Archived 2 emails and marked them read".
export function changeWords({ ids, archive, read, add = [], remove = [] }, { past = false } = {}) {
  const n = ids.length;
  const what = `${n} email${n === 1 ? '' : 's'}`;
  const them = n === 1 ? 'it' : 'them';
  const quote = (xs) => list(xs.map((x) => `“${x}”`));
  const v = (now, then) => (past ? then : now);
  const steps = [];
  if (archive === true) steps.push(`${v('archive', 'archived')} ${what}`);
  if (archive === false) steps.push(`${v('move', 'moved')} ${what} back to the inbox`);
  if (read !== null && read !== undefined) steps.push(`${v('mark', 'marked')} ${steps.length ? them : what} ${read ? 'read' : 'unread'}`);
  if (add.length) steps.push(`${v('label', 'labelled')} ${steps.length ? them : what} ${quote(add)}`);
  if (remove.length) steps.push(steps.length ? `${v('take', 'took')} ${quote(remove)} off ${them}` : `${v('remove', 'removed')} ${quote(remove)} from ${what}`);
  const out = list(steps);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// A plain-text message as Gmail wants it: RFC 5322 headers, UTF-8 body.
export function mime({ from, to, cc, subject, body, inReplyTo, references, date, messageId }) {
  const word = (v) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v).toString('base64')}?=`);
  const lines = [
    from ? `From: ${from}` : '',
    date ? `Date: ${date.toUTCString().replace('GMT', '+0000')}` : '',
    messageId ? `Message-ID: ${messageId}` : '',
    `To: ${to}`,
    cc ? `Cc: ${cc}` : '',
    `Subject: ${word(subject ?? '')}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
    references ? `References: ${references}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ].filter(Boolean);
  const encoded = Buffer.from(body.replace(/\r?\n/g, '\r\n')).toString('base64').replace(/.{76}/g, '$&\r\n');
  return `${lines.join('\r\n')}\r\n\r\n${encoded}`;
}

// The model's draft arguments, checked before anything goes to Google.
export function draftArgs({ to, cc, subject, body, reply_to: replyTo } = {}) {
  const text = String(body ?? '').trim();
  if (!text) throw new GmailError('A draft needs a body.', 'bad_request');
  if (text.length > MAX_DRAFT) throw new GmailError(`That draft is too long (over ${MAX_DRAFT} characters).`, 'bad_request');
  if (replyTo && !ID.test(String(replyTo))) throw new GmailError("reply_to isn't a message id from gmail_search.", 'missing');
  return { to: clean(to), cc: clean(cc), subject: clean(subject), body: text, replyTo: replyTo ? String(replyTo) : null, threadId: null, inReplyTo: null, references: null };
}

// A reply goes to the original's Reply-To or sender, in the same conversation.
// h: the original's headers, lower-case names.
export function asReply(plan, h) {
  plan.inReplyTo = h['message-id'] ?? null;
  plan.references = [h.references, h['message-id']].filter(Boolean).join(' ') || null;
  plan.to ||= clean(h['reply-to'] ?? h.from ?? '');
  plan.subject ||= /^re:/i.test(h.subject ?? '') ? h.subject : `Re: ${h.subject ?? ''}`.trim();
  return plan;
}

export function checkDraft(plan) {
  if (!plan.to) throw new GmailError('A draft needs someone to go to: give "to", or reply_to with a message id.', 'bad_request');
  if (!plan.to.includes('@')) throw new GmailError(`“${plan.to}” isn't an email address.`, 'bad_request');
  return plan;
}

export const draftResult = (plan, link) => ({
  output: `Saved a draft in Gmail. It has not been sent; the person sends it from Gmail.\nTo: ${plan.to}${plan.cc ? `\nCc: ${plan.cc}` : ''}\nSubject: ${plan.subject}`,
  summary: plan.subject || '(no subject)',
  link,
});

// The model's change arguments, checked before anything goes to Google.
export function changeArgs({ ids, archive, read, add_labels: add = [], remove_labels: remove = [] } = {}) {
  const wanted = [...new Set([ids].flat().filter(Boolean).map(String))];
  if (!wanted.length) throw new GmailError('Say which messages: ids from gmail_search.', 'bad_request');
  if (wanted.length > MAX_CHANGE) throw new GmailError(`That's more than ${MAX_CHANGE} messages at once. Do it in smaller groups.`, 'bad_request');
  const bad = wanted.find((id) => !ID.test(id));
  if (bad) throw new GmailError(`${bad} isn't a message id from gmail_search.`, 'missing');
  const names = (v) => [...new Set([v].flat().filter(Boolean).map((x) => clean(x)).filter(Boolean))];
  const plan = { ids: wanted, archive: typeof archive === 'boolean' ? archive : null, read: typeof read === 'boolean' ? read : null, add: names(add), remove: names(remove), create: [], messages: [] };
  if (plan.archive === null && plan.read === null && !plan.add.length && !plan.remove.length) {
    throw new GmailError('Nothing to change: say archive, read, add_labels or remove_labels.', 'bad_request');
  }
  return plan;
}

// Labels as the person sees them: which exist, which would be made.
export function matchLabels(plan, existing) {
  const find = (n) => existing.find((l) => l.toLowerCase() === n.toLowerCase());
  const missing = plan.remove.find((n) => !find(n));
  if (missing) throw new GmailError(`There's no label called “${missing}”.`, 'missing');
  plan.add = plan.add.map((n) => find(n) ?? n);
  plan.remove = plan.remove.map(find);
  plan.create = plan.add.filter((n) => !find(n));
  return plan;
}

export function changeResult(plan) {
  const done = changeWords(plan, { past: true });
  return {
    output: `${done}: ${plan.messages.map((m) => `“${m.subject}”`).join(', ')}.${plan.archive ? ' They are still in All Mail; archive false puts them back in the inbox.' : ''}`,
    summary: done,
  };
}

export const drafts = (account) => `https://mail.google.com/mail/${account ? `?authuser=${encodeURIComponent(account)}` : ''}#drafts`;

// ---- reading, the same words whichever way Nova reaches Gmail ----

export const when = (ms, timeZone = 'UTC') => new Intl.DateTimeFormat('en-US', {
  timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(Number(ms)));

export function searchArgs({ query, max } = {}) {
  return {
    q: String(query ?? '').trim() || 'in:inbox newer_than:1d',
    n: Math.min(Math.max(Math.round(Number(max) || 20), 1), MAX_RESULTS),
  };
}

export const nothing = (q) => ({ output: `Nothing matched ${q}.`, summary: 'nothing matched' });

export function checkId(id) {
  if (!ID.test(String(id ?? ''))) throw new GmailError("That isn't a message id from gmail_search.", 'missing');
  return String(id);
}

// found: [{ id, threadId, unread, important, from, subject, at, snippet }], newest first.
export function searchResult(found, { more = false, when: at }) {
  const threads = new Set(found.map((m) => m.threadId));
  const s = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const head = `${s(found.length, 'message')} in ${s(threads.size, 'conversation')}, newest first.${more ? ' More messages match; widen max or narrow the query to see them.' : ''}`;
  const rows = found.map((m, i) => {
    const flags = [m.unread ? 'unread' : 'read', m.important ? 'important' : ''].filter(Boolean).join(', ');
    return `[${i + 1}] id=${m.id} conversation=${m.threadId} (${flags})\nFrom: ${m.from ?? '(unknown)'}\nSubject: ${m.subject ?? '(no subject)'}\nDate: ${at(m.at)}\n${m.snippet ?? ''}`;
  });
  return { output: `${head}\n\n${rows.join('\n\n')}`, summary: s(found.length, 'message') };
}

const size = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

// m: { from, to, cc, subject, at, files: [{ name, size, type? }], body, html?, 'reply-to'?,
// 'return-path'?, 'authentication-results'? }. `ingest` is what the ingest screen reads besides
// the text: the sender's headers, the attachments, and the HTML when there was no plain text.
export function readResult(m, { when: at }) {
  let body = String(m.body ?? '').trim() || '(no text)';
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n[the rest of this message was cut]`;
  const files = (m.files ?? []).map((f) => `${f.name}${f.size ? ` (${size(f.size)})` : ''}`);
  const lines = [
    `From: ${m.from ?? '(unknown)'}`,
    m.to ? `To: ${m.to}` : '',
    m.cc ? `Cc: ${m.cc}` : '',
    `Subject: ${m.subject ?? '(no subject)'}`,
    `Date: ${at(m.at)}`,
    files.length ? `Attachments (not opened): ${files.join(', ')}` : '',
  ].filter(Boolean);
  const headers = Object.fromEntries(['from', 'reply-to', 'return-path', 'authentication-results'].filter((k) => m[k]).map((k) => [k, String(m[k])]));
  return {
    output: `${lines.join('\n')}\n\n${body}`, summary: m.subject ?? '(no subject)',
    ingest: { headers, attachments: (m.files ?? []).map((f) => ({ name: f.name, ...(f.type ? { type: f.type } : {}) })), ...(m.html ? { html: `${lines.map((l) => `<p>${l.replace(/</g, '&lt;')}</p>`).join('')}${m.html}` } : {}) },
  };
}
