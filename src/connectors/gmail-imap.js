// Gmail through IMAP with an app password: the quick way in. The person makes
// a 16-letter app password in their Google account and pastes it into Nova
// with their address. It is kept in Nova's vault (connector/gmail/GMAIL_APP_PASSWORD),
// encrypted, outside history, never shown to the model. Nova uses Gmail's IMAP
// extensions (X-GM-RAW search, X-GM-MSGID ids, X-GM-LABELS), so ids, search
// syntax and what the model sees match the Gmail API path.
import { randomBytes } from 'node:crypto';
import { ImapError, decodeMailbox, encodeMailbox, fetchItems, openImap, quote } from './imap.js';
import {
  GmailError, asReply, changeArgs, changeResult, changeWords, checkDraft, checkId, draftArgs, draftResult, drafts,
  matchLabels, mime, name, nothing, readResult, searchArgs, searchResult, when,
} from './mail.js';
import { header, messageFiles, messageText, parseHeaders, parseMessage } from '../mime.js';

export const IMAP_URL = 'imaps://imap.gmail.com:993';
const FILE = 'password.json';
const HEADERS = 'FROM SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING';
const MAX_MESSAGE = 2_000_000;

const hexId = (dec) => BigInt(dec).toString(16);
const decId = (hex) => BigInt(`0x${hex}`).toString();
const imapDate = (s) => Date.parse(String(s).replace(/^(\d+)-(\w+)-(\d+)/, '$1 $2 $3'));
const hasAscii = (s) => /^[\x20-\x7e]*$/.test(s);
const text = (s) => (hasAscii(s) ? quote(s) : { literal: Buffer.from(s) });

// What Google says when it won't let Nova in, in plain words.
function loginError(e, connecting) {
  const why = String(e.text ?? e.message);
  if (/application-specific password required/i.test(why)) {
    return new GmailError("That's your Google password. Nova needs an app password instead: make one at myaccount.google.com/apppasswords.", 'bad_password');
  }
  if (/not enabled for imap|imap access is disabled/i.test(why)) {
    return new GmailError('IMAP is turned off for this account. For a work or school account, ask its admin, or use your own Google client under Advanced.', 'bad_password');
  }
  if (/web ?alert|web browser/i.test(why)) {
    return new GmailError('Google wants you to sign in on the web first. Sign in at mail.google.com, then try again.', 'bad_password');
  }
  if (e.code === 'unreachable') return new GmailError("Couldn't reach Gmail. Check the connection and try again.", 'unreachable');
  return connecting
    ? new GmailError("Google didn't accept that address and app password. Check both; spaces don't matter.", 'bad_password')
    : new GmailError("Gmail needs reconnecting: Google no longer accepts Nova's app password. The person can reconnect at /skills#gmail.", 'reconnect');
}

export class GmailImap {
  // files: { read(name), writeSecret(name, data), removeSecret(name) }, kept in the vault
  constructor(files, { url = IMAP_URL, timezone = 'UTC', open = openImap } = {}) {
    this.files = files;
    this.url = url;
    this.timezone = timezone;
    this.open = open;
    this.boxes = null; // { all, drafts, labels }, learned at the first sign-in
  }

  saved() { return this.files.read(FILE); }
  connected() { const p = this.saved(); return !!p?.password && !p.broken; }

  status() {
    const p = this.saved();
    return p ? { connected: !p.broken, broken: !!p.broken, account: p.email, since: p.since } : null;
  }

  async connect({ email, password } = {}) {
    const address = String(email ?? '').trim().toLowerCase();
    const pass = String(password ?? '').replace(/\s+/g, '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new GmailError('Enter your Gmail address.', 'bad_password');
    if (!pass) throw new GmailError('Paste the app password Google showed you.', 'bad_password');
    await this.session(async () => {}, { login: { email: address, password: pass }, connecting: true });
    this.files.writeSecret(FILE, { email: address, password: pass, since: new Date().toISOString() });
    return this.status();
  }

  forget() {
    this.files.removeSecret(FILE);
    this.boxes = null;
  }

  markBroken() {
    const p = this.saved();
    if (p && !p.broken) this.files.writeSecret(FILE, { ...p, broken: true });
  }

  // Sign in, do the work, sign out. One connection per piece of work.
  async session(work, { signal, login = null, connecting = false } = {}) {
    const cred = login ?? this.saved();
    if (!cred?.password) throw new GmailError("Gmail isn't connected. The person can connect it at /skills#gmail.", 'not_connected');
    if (cred.broken) throw new GmailError('Gmail needs reconnecting. The person can reconnect it at /skills#gmail.', 'reconnect');
    let c;
    try {
      c = await this.open(this.url);
    } catch (e) {
      throw loginError(e, connecting);
    }
    const stop = () => c.socket.destroy();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      try {
        await c.command('LOGIN ', quote(cred.email), ' ', text(cred.password));
      } catch (e) {
        const err = loginError(e, connecting);
        if (err.code === 'reconnect') this.markBroken();
        throw err;
      }
      if (!this.boxes || connecting) this.boxes = await this.mailboxes(c);
      return await work(c);
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e instanceof GmailError) throw e;
      if (e instanceof ImapError && e.code === 'unreachable') throw new GmailError("Couldn't reach Gmail. Check the connection and try again.", 'unreachable');
      throw new GmailError(`Gmail returned an error (${e.text ?? e.message}).`, 'google');
    } finally {
      signal?.removeEventListener('abort', stop);
      c.logout();
    }
  }

  async mailboxes(c) {
    const { untagged } = await c.command('LIST "" "*"');
    const boxes = { all: null, drafts: null, labels: [] };
    for (const u of untagged) {
      if (String(u[0]).toUpperCase() !== 'LIST') continue;
      const flags = (u[1] ?? []).map((f) => String(f).toLowerCase());
      const box = String(u[3]);
      if (flags.includes('\\all')) boxes.all = box;
      else if (flags.includes('\\drafts')) boxes.drafts = box;
      else if (!flags.includes('\\noselect') && box !== 'INBOX' && !box.startsWith('[Gmail]') && !box.startsWith('[Google Mail]')) boxes.labels.push(decodeMailbox(box));
    }
    if (!boxes.all) throw new GmailError("Nova couldn't find All Mail. In Gmail settings, under Labels, tick \"Show in IMAP\" for All Mail and Drafts.", 'google');
    return boxes;
  }

  // Message ids (hex, as Gmail's web and API use them) → UIDs in All Mail.
  async uids(c, ids) {
    const terms = ids.map((id) => `X-GM-MSGID ${decId(id)}`);
    const query = terms.reduce((acc, t) => (acc ? `OR ${acc} ${t}` : t), '');
    const { untagged } = await c.command(`UID SEARCH ${query}`);
    const found = untagged.find((u) => String(u[0]).toUpperCase() === 'SEARCH')?.slice(1) ?? [];
    if (!found.length) return new Map();
    const items = fetchItems((await c.command(`UID FETCH ${found.join(',')} (UID X-GM-MSGID)`)).untagged);
    return new Map(items.map((i) => [hexId(i['X-GM-MSGID']), i.UID]));
  }

  async one(c, id, fields) {
    const uid = (await this.uids(c, [id])).get(id);
    if (!uid) throw new GmailError("That message isn't there any more. It may have been deleted.", 'missing');
    return fetchItems((await c.command(`UID FETCH ${uid} (${fields})`)).untagged)[0];
  }

  // ---- reading ----------------------------------------------------------------

  async search(args, { signal } = {}) {
    const { q, n } = searchArgs(args);
    return this.session(async (c) => {
      await c.command(`EXAMINE ${quote(this.boxes.all)}`);
      const { untagged } = hasAscii(q)
        ? await c.command(`UID SEARCH X-GM-RAW ${quote(q)}`)
        : await c.command('UID SEARCH CHARSET UTF-8 X-GM-RAW ', { literal: Buffer.from(q) });
      const all = (untagged.find((u) => String(u[0]).toUpperCase() === 'SEARCH')?.slice(1) ?? []).map(Number).sort((a, b) => a - b);
      if (!all.length) return nothing(q);
      const uids = all.slice(-n);
      const items = fetchItems((await c.command(`UID FETCH ${uids.join(',')} (UID X-GM-MSGID X-GM-THRID X-GM-LABELS FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (${HEADERS})] BODY.PEEK[TEXT]<0.6000>)`)).untagged);
      const found = items.map((i) => {
        const head = Object.entries(i).find(([k]) => k.startsWith('BODY[HEADER'))?.[1] ?? '';
        const msg = parseMessage(`${head.trimEnd()}\r\n\r\n${i['BODY[TEXT]'] ?? ''}`);
        const labels = (i['X-GM-LABELS'] ?? []).map((l) => String(l).toLowerCase());
        return {
          id: hexId(i['X-GM-MSGID']), threadId: hexId(i['X-GM-THRID']),
          unread: !(i.FLAGS ?? []).some((f) => /^\\seen$/i.test(f)), important: labels.includes('\\important'),
          from: header(msg, 'from'), subject: header(msg, 'subject'), at: imapDate(i.INTERNALDATE),
          snippet: messageText(msg).replace(/\s+/g, ' ').slice(0, 200).trim(),
        };
      }).sort((a, b) => b.at - a.at);
      return searchResult(found, { more: all.length > n, when: (ms) => when(ms, this.timezone) });
    }, { signal });
  }

  async readMessage({ id } = {}, { signal } = {}) {
    const hex = checkId(id);
    return this.session(async (c) => {
      await c.command(`EXAMINE ${quote(this.boxes.all)}`);
      const i = await this.one(c, hex, `INTERNALDATE BODY.PEEK[]<0.${MAX_MESSAGE}>`);
      const msg = parseMessage(i['BODY[]'] ?? '');
      return readResult({
        from: header(msg, 'from'), to: header(msg, 'to'), cc: header(msg, 'cc'), subject: header(msg, 'subject'),
        at: imapDate(i.INTERNALDATE), files: messageFiles(msg), body: messageText(msg),
      }, { when: (ms) => when(ms, this.timezone) });
    }, { signal });
  }

  // ---- drafting -----------------------------------------------------------------

  async planWith(c, args) {
    const plan = draftArgs(args);
    if (plan.replyTo) {
      await c.command(`EXAMINE ${quote(this.boxes.all)}`);
      const i = await this.one(c, plan.replyTo, 'X-GM-THRID BODY.PEEK[HEADER.FIELDS (FROM REPLY-TO SUBJECT MESSAGE-ID REFERENCES)]');
      const h = parseHeaders(Object.entries(i).find(([k]) => k.startsWith('BODY[HEADER'))?.[1] ?? '');
      plan.threadId = hexId(i['X-GM-THRID']);
      asReply(plan, Object.fromEntries([...h].map(([k, v]) => [k, v[0]])));
    }
    return checkDraft(plan);
  }

  planDraft(args, { signal } = {}) { return this.session((c) => this.planWith(c, args), { signal }); }

  async draft(args, { signal } = {}) {
    const email = this.saved()?.email;
    return this.session(async (c) => {
      const plan = await this.planWith(c, args);
      if (!this.boxes.drafts) throw new GmailError("Nova couldn't find Drafts. In Gmail settings, under Labels, tick \"Show in IMAP\" for Drafts.", 'google');
      const raw = mime({ ...plan, from: email, date: new Date(), messageId: `<nova.${randomBytes(9).toString('hex')}@${email.split('@')[1]}>` });
      await c.command(`APPEND ${quote(this.boxes.drafts)} (\\Draft \\Seen) `, { literal: Buffer.from(raw) });
      return draftResult(plan, drafts(email));
    }, { signal });
  }

  // ---- organizing ----------------------------------------------------------------

  async changePlan(c, args) {
    const plan = matchLabels(changeArgs(args), this.boxes.labels);
    await c.command(`SELECT ${quote(this.boxes.all)}`);
    plan.uids = await this.uids(c, plan.ids);
    const gone = plan.ids.find((id) => !plan.uids.has(id));
    if (gone) throw new GmailError(`Message ${gone} isn't there any more. It may have been deleted.`, 'missing');
    const items = fetchItems((await c.command(`UID FETCH ${[...plan.uids.values()].join(',')} (X-GM-MSGID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)])`)).untagged);
    const byId = new Map(items.map((i) => [hexId(i['X-GM-MSGID']), parseHeaders(Object.entries(i).find(([k]) => k.startsWith('BODY[HEADER'))?.[1] ?? '')]));
    plan.messages = plan.ids.map((id) => ({ id, from: name(byId.get(id)?.get('from')?.[0] ?? ''), subject: byId.get(id)?.get('subject')?.[0] ?? '(no subject)' }));
    plan.verb = changeWords(plan);
    return plan;
  }

  planChange(args, { signal } = {}) { return this.session((c) => this.changePlan(c, args), { signal }); }

  async change(args, { signal } = {}) {
    return this.session(async (c) => {
      const plan = await this.changePlan(c, args);
      const set = [...plan.uids.values()].join(',');
      const labels = (xs) => `(${xs.map((l) => quote(encodeMailbox(l))).join(' ')})`;
      for (const n of plan.create) await c.command(`CREATE ${quote(encodeMailbox(n))}`);
      if (plan.archive === true) await c.command(`UID STORE ${set} -X-GM-LABELS (\\Inbox)`);
      if (plan.archive === false) await c.command(`UID STORE ${set} +X-GM-LABELS (\\Inbox)`);
      if (plan.read === true) await c.command(`UID STORE ${set} +FLAGS.SILENT (\\Seen)`);
      if (plan.read === false) await c.command(`UID STORE ${set} -FLAGS.SILENT (\\Seen)`);
      if (plan.add.length) await c.command(`UID STORE ${set} +X-GM-LABELS ${labels(plan.add)}`);
      if (plan.remove.length) await c.command(`UID STORE ${set} -X-GM-LABELS ${labels(plan.remove)}`);
      if (plan.create.length) this.boxes.labels.push(...plan.create);
      return changeResult(plan);
    }, { signal });
  }
}
