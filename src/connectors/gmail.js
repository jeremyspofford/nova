// Gmail, read-only, through the person's own Google OAuth client.
//
// Connecting: the person saves a "Desktop app" OAuth client from Google Cloud
// once. Nova sends them to Google's consent screen (PKCE, a loopback redirect
// back to Nova's own server, the gmail.readonly scope only) and keeps the
// refresh token in ~/connectors/gmail/token.json: readable only by them, out
// of the home's history, never shown to the model. Disconnecting revokes it at
// Google and deletes it.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { htmlToText } from '../tools.js';

export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MAX_BODY = 12_000;
const MAX_RESULTS = 50;
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

// code: not_connected | reconnect | bad_client | unreachable | denied | expired | google | missing
export class GmailError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export class Gmail {
  constructor(home, { endpoints = googleEndpoints(), timezone = 'UTC', fetch: f = globalThis.fetch } = {}) {
    this.dir = join(home, 'connectors', 'gmail');
    this.e = endpoints;
    this.timezone = timezone;
    this.fetch = f;
    this.pending = new Map(); // state → { verifier, redirect, at }
    this.access = null;       // { token, expires }, in memory only
    this.notice = null;       // how the last sign-in went, for the page Google sends back to
  }

  // ---- files ---------------------------------------------------------------

  read(name) {
    try { return JSON.parse(readFileSync(join(this.dir, name), 'utf8')); } catch { return null; }
  }

  writeSecret(name, data) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, name);
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
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
    rmSync(join(this.dir, 'client.json'), { force: true });
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
        throw new GmailError('Google didn\'t give Nova permission to read your email. Connect again and leave "Read your email" ticked.', 'denied');
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
    rmSync(join(this.dir, 'token.json'), { force: true });
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

  async api(path, params = {}, { signal, retried = false } = {}) {
    const token = await this.accessToken();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) for (const one of [v].flat()) if (one !== undefined) q.append(k, String(one));
    let res;
    try {
      res = await this.fetch(`${this.e.api}${path}${q.size ? `?${q}` : ''}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]),
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new GmailError("Couldn't reach Gmail. Check the connection and try again.", 'unreachable');
    }
    if (res.status === 401 && !retried) {
      this.access = null;
      return this.api(path, params, { signal, retried: true });
    }
    if (res.ok) return res.json();
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

  when(ms) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: this.timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(new Date(Number(ms)));
  }

  async search({ query = 'in:inbox newer_than:1d', max = 20 } = {}, { signal } = {}) {
    const q = String(query ?? '').trim() || 'in:inbox newer_than:1d';
    const n = Math.min(Math.max(Math.round(Number(max) || 20), 1), MAX_RESULTS);
    const list = await this.api('/messages', { q, maxResults: n }, { signal });
    const ids = (list.messages ?? []).map((m) => m.id);
    if (!ids.length) return { output: `Nothing matched ${q}.`, summary: 'nothing matched' };
    // A few at a time, to stay well inside Gmail's per-person rate limit.
    const found = [];
    for (let i = 0; i < ids.length; i += 10) {
      found.push(...await Promise.all(ids.slice(i, i + 10).map((id) =>
        this.api(`/messages/${id}`, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }, { signal }))));
    }
    const threads = new Set(found.map((m) => m.threadId));
    const more = list.nextPageToken ? ' More messages match; widen max or narrow the query to see them.' : '';
    const head = `${found.length} message${found.length === 1 ? '' : 's'} in ${threads.size} conversation${threads.size === 1 ? '' : 's'}, newest first.${more}`;
    const rows = found.map((m, i) => {
      const h = headers(m.payload);
      const flags = [(m.labelIds ?? []).includes('UNREAD') ? 'unread' : 'read', (m.labelIds ?? []).includes('IMPORTANT') ? 'important' : ''].filter(Boolean).join(', ');
      return `[${i + 1}] id=${m.id} conversation=${m.threadId} (${flags})\nFrom: ${h.from ?? '(unknown)'}\nSubject: ${h.subject ?? '(no subject)'}\nDate: ${this.when(m.internalDate)}\n${htmlToText(m.snippet ?? '')}`;
    });
    return { output: `${head}\n\n${rows.join('\n\n')}`, summary: `${found.length} message${found.length === 1 ? '' : 's'}` };
  }

  async readMessage({ id } = {}, { signal } = {}) {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(id ?? ''))) throw new GmailError('That isn\'t a message id from gmail_search.', 'missing');
    const m = await this.api(`/messages/${id}`, { format: 'full' }, { signal });
    const h = headers(m.payload);
    const files = attachments(m.payload);
    let body = bodyText(m.payload) || htmlToText(m.snippet ?? '') || '(no text)';
    if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n[the rest of this message was cut]`;
    const lines = [
      `From: ${h.from ?? '(unknown)'}`,
      h.to ? `To: ${h.to}` : '',
      h.cc ? `Cc: ${h.cc}` : '',
      `Subject: ${h.subject ?? '(no subject)'}`,
      `Date: ${this.when(m.internalDate)}`,
      files.length ? `Attachments (not opened): ${files.join(', ')}` : '',
    ].filter(Boolean);
    return { output: `${lines.join('\n')}\n\n${body}`, summary: h.subject ?? '(no subject)' };
  }
}

function headers(payload) {
  const out = {};
  for (const { name, value } of payload?.headers ?? []) {
    const k = name.toLowerCase();
    if (['from', 'to', 'cc', 'subject', 'date'].includes(k) && !(k in out)) out[k] = value;
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

function attachments(payload) {
  const out = [];
  const walk = (p) => {
    if (!p) return;
    if (p.filename) out.push(`${p.filename}${p.body?.size ? ` (${size(p.body.size)})` : ''}`);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return out;
}

const size = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
