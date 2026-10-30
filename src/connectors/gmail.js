// Gmail, through the person's own Google OAuth client. Nova reads, saves
// drafts and organizes (archive, read state, labels). It never sends or deletes.
//
// Connecting: the person saves a "Desktop app" OAuth client from Google Cloud
// once. Nova sends them to Google's consent screen (PKCE, a loopback redirect
// back to Nova's own server, the gmail.modify scope only) and keeps the
// refresh token in Nova's vault (src/core/vault.ts): encrypted, out of the
// home's history, never shown to the model. Disconnecting revokes it at Google
// and deletes it. Era 2 kept these as plaintext files; they move in on start.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { htmlToText } from '../tools.js';
import { Vault } from '../core/index.ts';
import { GmailImap, IMAP_URL } from './gmail-imap.js';
import { GmailError, asReply, checkId, nothing, readResult, searchArgs, searchResult, when, changeArgs, changeResult, changeWords, checkDraft, draftArgs, draftResult, drafts, matchLabels, mime, name } from './mail.js';

export { GmailError, changeWords, mime };

export const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const PENDING_MS = 10 * 60_000;

// Google's endpoints, or a stand-in server's (tests and screenshots).
export function googleEndpoints(base = '') {
  if (!base) {
    return {
      auth: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      revoke: 'https://oauth2.googleapis.com/revoke',
      api: 'https://gmail.googleapis.com/gmail/v1/users/me',
    };
  }
  return { auth: `${base}/o/oauth2/v2/auth`, token: `${base}/token`, revoke: `${base}/revoke`, api: `${base}/gmail/v1/users/me` };
}


const b64url = (buf) => Buffer.from(buf).toString('base64url');

// Where each of Gmail's secrets lives in the vault. The keys are Era 2's file names, which the
// rest of this module still uses to mean them. Under connector/gmail/, so removing the connector
// revokes them all (src/core/connectors).
const VAULT_NAMES = { 'client.json': 'GOOGLE_OAUTH_CLIENT', 'token.json': 'GOOGLE_REFRESH_TOKEN', 'password.json': 'GMAIL_APP_PASSWORD' };
const vaultName = (file) => {
  if (!VAULT_NAMES[file]) throw new Error(`Gmail has no secret called ${file}`);
  return `connector/gmail/${VAULT_NAMES[file]}`;
};
export const GMAIL_SECRETS = Object.values(VAULT_NAMES);

export class GmailOAuth {
  // vault: the core's (server.js passes it); a Gmail made on its own opens the home's vault.
  constructor(home, { endpoints = googleEndpoints(), timezone = 'UTC', fetch: f = globalThis.fetch, vault = null } = {}) {
    this.home = home;
    this.vault = vault ?? new Vault({ home });
    // Era 2's folder for these secrets: read once, to move them into the vault.
    this.dir = join(home, 'connectors', 'gmail');
    this.e = endpoints;
    this.timezone = timezone;
    this.fetch = f;
    this.pending = new Map(); // state → { verifier, redirect, at }
    this.access = null;       // { token, expires }, in memory only
    this.notice = null;       // how the last sign-in went, for the page Google sends back to
  }

  // ---- secrets: in the vault, by name -------------------------------------------

  read(name) {
    try { return JSON.parse(this.vault.get(vaultName(name)) ?? 'null'); } catch { return null; }
  }

  writeSecret(name, data) {
    this.vault.put(vaultName(name), JSON.stringify(data));
  }

  removeSecret(name) {
    this.vault.delete(vaultName(name));
  }

  // Era 2 kept these as plaintext files in connectors/gmail/ (0600). Each moves into the vault, is
  // read back, and only then is its file deleted. A file that isn't JSON (edited by hand, cut
  // short) still holds a secret: it goes in as its text, never left behind in plaintext. An empty
  // file holds nothing and just goes.
  migratePlaintext() {
    const moved = [];
    for (const name of Object.keys(VAULT_NAMES)) {
      const path = join(this.dir, name);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      const key = vaultName(name);
      // The vault's copy wins if there already is one (the file is then a leftover).
      if (text.trim() && this.vault.get(key) === null) {
        let data;
        try { data = JSON.parse(text); } catch { data = undefined; }
        if (data === undefined) this.vault.put(key, text);
        else this.writeSecret(name, data);
      }
      if (!text.trim() || this.vault.get(key) !== null) { rmSync(path, { force: true }); moved.push(name); }
    }
    try { rmdirSync(this.dir); rmdirSync(join(this.home, 'connectors')); } catch { /* not empty, or not there */ }
    return moved;
  }

  client() {
    const c = this.read('client.json')?.installed;
    return c?.client_id ? { id: c.client_id, secret: c.client_secret ?? '' } : null;
  }

  // The JSON Google offers to download for a Desktop app client.
  setClient(json) {
    let data;
    try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch {
      throw new GmailError("That isn't the file Google gives you. Download the client's JSON again and paste all of it.", 'bad_client');
    }
    if (data?.web) throw new GmailError('That client is a "Web application". Create a "Desktop app" client instead; Nova signs in through this computer.', 'bad_client');
    const c = data?.installed;
    if (!c?.client_id || !/\.apps\.googleusercontent\.com$/.test(c.client_id)) {
      throw new GmailError("That doesn't look like a Google OAuth client. Download the client's JSON again and paste all of it.", 'bad_client');
    }
    this.writeSecret('client.json', { installed: { client_id: c.client_id, client_secret: c.client_secret ?? '' } });
    return this.status();
  }

  forgetClient() {
    this.removeSecret('client.json');
    return this.status();
  }

  status() {
    const t = this.read('token.json');
    const notice = this.notice && Date.now() - this.notice.at < 120_000 ? this.notice : null;
    return {
      client: !!this.client(),
      connected: !!t?.refresh_token && !t.broken,
      broken: !!t?.broken,
      account: t?.account ?? null,
      since: t?.since ?? null,
      notice,
    };
  }

  // ---- signing in ------------------------------------------------------------

  authUrl(redirect) {
    const c = this.client();
    if (!c) throw new GmailError('Save your OAuth client first.', 'bad_client');
    for (const [k, p] of this.pending) if (Date.now() - p.at > PENDING_MS) this.pending.delete(k);
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(18));
    this.pending.set(state, { verifier, redirect, at: Date.now() });
    const q = new URLSearchParams({
      client_id: c.id,
      redirect_uri: redirect,
      response_type: 'code',
      scope: SCOPE,
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${this.e.auth}?${q}`;
  }

  // Google sends the person back here with a code (or an error).
  async finish({ code, state, error }) {
    try {
      const p = this.pending.get(state);
      this.pending.delete(state);
      if (error) throw new GmailError(error === 'access_denied' ? 'You cancelled at Google, so Gmail is still not connected.' : `Google stopped the sign-in (${error}).`, 'denied');
      if (!p || Date.now() - p.at > PENDING_MS) throw new GmailError('That sign-in took too long or came from somewhere else. Start again with Connect Gmail.', 'expired');
      const c = this.client();
      if (!c) throw new GmailError('Save your OAuth client first.', 'bad_client');
      const tok = await this.tokenRequest({
        grant_type: 'authorization_code', code, redirect_uri: p.redirect,
        client_id: c.id, client_secret: c.secret, code_verifier: p.verifier,
      }, 'sign-in');
      if (tok.scope && !tok.scope.split(' ').includes(SCOPE)) {
        throw new GmailError('Google didn\'t give Nova permission to use your email. Connect again and leave the Gmail box ticked.', 'denied');
      }
      if (!tok.refresh_token) throw new GmailError("Google didn't give Nova a lasting sign-in. Remove Nova's access in your Google account, then connect again.", 'google');
      this.access = { token: tok.access_token, expires: Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 60_000 };
      const profile = await this.api('/profile');
      this.writeSecret('token.json', { refresh_token: tok.refresh_token, account: profile.emailAddress ?? null, since: new Date().toISOString() });
      this.notice = { ok: true, text: `Gmail is connected${profile.emailAddress ? ` as ${profile.emailAddress}` : ''}.`, at: Date.now() };
    } catch (e) {
      this.access = null;
      this.notice = { ok: false, text: e instanceof GmailError ? e.message : 'Something went wrong while connecting Gmail.', at: Date.now() };
    }
    return this.notice;
  }

  async disconnect() {
    const t = this.read('token.json');
    let revoked = false;
    if (t?.refresh_token) {
      try {
        const res = await this.fetch(this.e.revoke, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: t.refresh_token }),
          signal: AbortSignal.timeout(10_000),
        });
        revoked = res.ok || res.status === 400; // 400: Google already let it go
      } catch {}
    }
    this.removeSecret('token.json');
    this.access = null;
    return { ...this.status(), revoked };
  }

  async tokenRequest(params, purpose = 'refresh') {
    let res;
    try {
      res = await this.fetch(this.e.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new GmailError("Couldn't reach Google. Check the connection and try again.", 'unreachable');
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    if (data.error === 'invalid_client' || data.error === 'unauthorized_client') {
      throw new GmailError("Google doesn't accept the saved OAuth client. Check it in Skills, under Gmail.", 'bad_client');
    }
    if (data.error === 'invalid_grant' && purpose === 'refresh') {
      this.markBroken();
      throw new GmailError('Gmail needs reconnecting: Google no longer accepts Nova\'s sign-in. The person can reconnect at /skills#gmail.', 'reconnect');
    }
    if (data.error === 'invalid_grant') throw new GmailError("That sign-in didn't complete. Try Connect Gmail again.", 'expired');
    throw new GmailError(`Google refused (${data.error ?? `HTTP ${res.status}`}).`, 'google');
  }

  markBroken() {
    const t = this.read('token.json');
    if (t && !t.broken) this.writeSecret('token.json', { ...t, broken: true });
    this.access = null;
  }

  async accessToken() {
    if (this.access && this.access.expires > Date.now()) return this.access.token;
    const t = this.read('token.json');
    const c = this.client();
    if (!t?.refresh_token || !c) throw new GmailError("Gmail isn't connected. The person can connect it at /skills#gmail.", 'not_connected');
    if (t.broken) throw new GmailError('Gmail needs reconnecting. The person can reconnect it at /skills#gmail.', 'reconnect');
    const tok = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: c.id, client_secret: c.secret });
    this.access = { token: tok.access_token, expires: Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 60_000 };
    return this.access.token;
  }

  async api(path, params = {}, { signal, method = 'GET', body, retried = false } = {}) {
    const token = await this.accessToken();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) for (const one of [v].flat()) if (one !== undefined) q.append(k, String(one));
    let res;
    try {
      res = await this.fetch(`${this.e.api}${path}${q.size ? `?${q}` : ''}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new GmailError("Couldn't reach Gmail. Check the connection and try again.", 'unreachable');
    }
    if (res.status === 401 && !retried) {
      this.access = null;
      return this.api(path, params, { signal, method, body, retried: true });
    }
    if (res.ok) return res.status === 204 ? {} : res.json().catch(() => ({}));
    const data = await res.json().catch(() => ({}));
    const why = String(data.error?.message ?? '');
    if (res.status === 401 || (res.status === 403 && /insufficient|scope/i.test(why))) {
      this.markBroken();
      throw new GmailError('Gmail needs reconnecting. The person can reconnect it at /skills#gmail.', 'reconnect');
    }
    if (res.status === 404) throw new GmailError("That message isn't there any more. It may have been deleted.", 'missing');
    if (res.status === 429 || /rate/i.test(why)) throw new GmailError('Gmail asked Nova to slow down. Try again in a minute.', 'google');
    throw new GmailError(`Gmail returned an error (HTTP ${res.status}).`, 'google');
  }

  // ---- reading -----------------------------------------------------------------

  when(ms) { return when(ms, this.timezone); }

  async search({ query, max } = {}, { signal } = {}) {
    const { q, n } = searchArgs({ query, max });
    const list = await this.api('/messages', { q, maxResults: n }, { signal });
    const ids = (list.messages ?? []).map((m) => m.id);
    if (!ids.length) return nothing(q);
    // A few at a time, to stay well inside Gmail's per-person rate limit.
    const found = [];
    for (let i = 0; i < ids.length; i += 10) {
      found.push(...await Promise.all(ids.slice(i, i + 10).map((id) =>
        this.api(`/messages/${id}`, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }, { signal }))));
    }
    return searchResult(found.map((m) => {
      const h = headers(m.payload);
      const labels = m.labelIds ?? [];
      return { id: m.id, threadId: m.threadId, unread: labels.includes('UNREAD'), important: labels.includes('IMPORTANT'), from: h.from, subject: h.subject, at: Number(m.internalDate), snippet: htmlToText(m.snippet ?? '') };
    }), { more: !!list.nextPageToken, when: (ms) => this.when(ms) });
  }

  async readMessage({ id } = {}, { signal } = {}) {
    checkId(id);
    const m = await this.api(`/messages/${id}`, { format: 'full' }, { signal });
    const h = headers(m.payload);
    return readResult({
      ...h, at: Number(m.internalDate), files: attachments(m.payload),
      body: bodyText(m.payload) || htmlToText(m.snippet ?? ''), html: bodyHtml(m.payload),
    }, { when: (ms) => this.when(ms) });
  }

  // ---- drafting ------------------------------------------------------------------

  async planDraft(args, { signal } = {}) {
    const plan = draftArgs(args);
    if (plan.replyTo) {
      const m = await this.api(`/messages/${plan.replyTo}`, { format: 'metadata', metadataHeaders: ['From', 'Reply-To', 'Subject', 'Message-ID', 'References'] }, { signal });
      plan.threadId = m.threadId;
      asReply(plan, headers(m.payload));
    }
    return checkDraft(plan);
  }

  async draft(args, { signal } = {}) {
    const plan = await this.planDraft(args, { signal });
    const raw = Buffer.from(mime(plan)).toString('base64url');
    await this.api('/drafts', {}, { signal, method: 'POST', body: { message: { raw, ...(plan.threadId ? { threadId: plan.threadId } : {}) } } });
    return draftResult(plan, drafts(this.read('token.json')?.account));
  }

  // ---- organizing ------------------------------------------------------------------

  async planChange(args, { signal } = {}) {
    const plan = changeArgs(args);
    let labels = [];
    if (plan.add.length || plan.remove.length) {
      labels = (await this.api('/labels', {}, { signal })).labels ?? [];
      matchLabels(plan, labels.filter((l) => l.type === 'user').map((l) => l.name));
    }
    plan.labelId = (n) => labels.find((l) => l.name === n)?.id;
    for (let i = 0; i < plan.ids.length; i += 10) {
      plan.messages.push(...await Promise.all(plan.ids.slice(i, i + 10).map(async (id) => {
        const m = await this.api(`/messages/${id}`, { format: 'metadata', metadataHeaders: ['From', 'Subject'] }, { signal });
        const h = headers(m.payload);
        return { id, from: name(h.from), subject: h.subject ?? '(no subject)' };
      })));
    }
    plan.verb = changeWords(plan);
    return plan;
  }

  async change(args, { signal } = {}) {
    const plan = await this.planChange(args, { signal });
    const add = [];
    const remove = [];
    for (const n of plan.create) {
      const made = await this.api('/labels', {}, { signal, method: 'POST', body: { name: n, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
      add.push(made.id);
    }
    for (const n of plan.add) if (!plan.create.includes(n)) add.push(plan.labelId(n));
    for (const n of plan.remove) remove.push(plan.labelId(n));
    if (plan.archive === true) remove.push('INBOX');
    if (plan.archive === false) add.push('INBOX');
    if (plan.read === true) remove.push('UNREAD');
    if (plan.read === false) add.push('UNREAD');
    await this.api('/messages/batchModify', {}, { signal, method: 'POST', body: { ids: plan.ids, addLabelIds: add, removeLabelIds: remove } });
    return changeResult(plan);
  }
}

function headers(payload) {
  const out = {};
  for (const { name, value } of payload?.headers ?? []) {
    const k = name.toLowerCase();
    if (['from', 'to', 'cc', 'subject', 'date', 'reply-to', 'message-id', 'references', 'return-path', 'authentication-results'].includes(k) && !(k in out)) out[k] = value;
  }
  return out;
}

function decodePart(part) {
  const bytes = Buffer.from(part.body.data, 'base64url');
  const type = (part.headers ?? []).find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  const charset = type.match(/charset="?([\w-]+)"?/i)?.[1] ?? 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

// Plain text when the message has it, otherwise its HTML as text.
export function bodyText(payload) {
  const plain = [];
  const html = [];
  const walk = (p) => {
    if (!p || p.filename) return;
    const type = String(p.mimeType ?? '').toLowerCase();
    if (p.body?.data && type === 'text/plain') plain.push(decodePart(p));
    else if (p.body?.data && type === 'text/html') html.push(decodePart(p));
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const text = plain.length ? plain.join('\n\n') : html.map(htmlToText).join('\n\n');
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The message's HTML, only when it has no plain text: the ingest screen reads what it hides.
export function bodyHtml(payload) {
  let plain = false;
  const html = [];
  const walk = (p) => {
    if (!p || p.filename) return;
    const type = String(p.mimeType ?? '').toLowerCase();
    if (p.body?.data && type === 'text/plain') plain = true;
    else if (p.body?.data && type === 'text/html') html.push(decodePart(p));
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return plain || !html.length ? null : html.join('\n');
}

function attachments(payload) {
  const out = [];
  const walk = (p) => {
    if (!p) return;
    if (p.filename) out.push({ name: p.filename, size: p.body?.size ?? null, type: p.mimeType ?? null });
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return out;
}



// Gmail as the rest of Nova sees it. Two ways in, one connected at a time:
// an app password over IMAP (the quick way), or the person's own Google OAuth
// client over the Gmail API (Advanced). Tools don't know which.
export class Gmail extends GmailOAuth {
  constructor(home, { imapUrl, openImap, ...opts } = {}) {
    super(home, opts);
    this.imap = new GmailImap(this, { url: imapUrl ?? IMAP_URL, timezone: this.timezone, ...(openImap ? { open: openImap } : {}) });
    // A vault that can't open leaves the old files where they are: nothing is lost, and it is retried next start.
    try { this.migrated = this.migratePlaintext(); } catch (e) { this.migrated = []; this.migrateError = e.message; }
  }

  get way() { return this.imap.saved() ? this.imap : null; }

  status() {
    const google = super.status();
    const pw = this.imap.status();
    if (pw) return { ...google, ...pw, method: 'password' };
    return { ...google, method: google.connected || google.broken ? 'google' : null };
  }

  // Connecting one way disconnects the other.
  async connectPassword(creds) {
    const status = await this.imap.connect(creds);
    if (this.read('token.json')) await super.disconnect();
    return { ...this.status(), notice: { ok: true, text: `Gmail is connected as ${status.account}.`, at: Date.now() } };
  }

  async finish(params) {
    const notice = await super.finish(params);
    if (notice.ok) this.imap.forget();
    return notice;
  }

  async disconnect() {
    if (this.imap.saved()) {
      this.imap.forget();
      return { ...this.status(), revoked: false, password: true };
    }
    return super.disconnect();
  }

  search(args, o) { return this.way ? this.imap.search(args, o) : super.search(args, o); }
  readMessage(args, o) { return this.way ? this.imap.readMessage(args, o) : super.readMessage(args, o); }
  planDraft(args, o) { return this.way ? this.imap.planDraft(args, o) : super.planDraft(args, o); }
  draft(args, o) { return this.way ? this.imap.draft(args, o) : super.draft(args, o); }
  planChange(args, o) { return this.way ? this.imap.planChange(args, o) : super.planChange(args, o); }
  change(args, o) { return this.way ? this.imap.change(args, o) : super.change(args, o); }
}
