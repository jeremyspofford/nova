#!/usr/bin/env node
// A stand-in site with accounts (M10d), for tests only: sign-up, sign-in, a password change and
// two-step sign-in with a code, all on loopback. No real service or account is ever touched. The
// "code" the site sends is kept here (`lastCode()`), as a text message would be on the person's
// phone: the test, as the person, reads it and types it into the page through takeover.
//
//   import { startAccountSite } from './scripts/stand-ins/account-site.js'
//   const site = await startAccountSite({ username, password });
//   site.url, site.host, site.passwordOf(user), site.lastCode(), site.hits(path), await site.close()
//
// Pages:
//   /login, /account   sign in (#username, #password, #signin); the page behind it (#account), with
//                      #changed after a password change and #mfa-on once two-step sign-in is on
//   /password          #current, #new, #again (all type=password), #save; the current one must match
//                      and the new one be 12 or more characters
//   /signup            #email (type=email), #pw, #pw2, #create; then /welcome (#welcome)
//   /security          #enable-2fa sends a code; /security/2fa asks for it (#code, at 20 to 420 px
//                      across and 20 to 60 down, where the person clicks to type it)
//   /status            public counts for Nova's own read: accounts, password changes, two-step
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body { font: 18px/1.5 sans-serif; margin: 0; background: #f4f4f0; color: #1b1b1b; } main { max-width: 560px; margin: 60px auto; padding: 24px 32px; background: #fff; border: 1px solid #ccc; border-radius: 8px; }
label { display: block; margin: 16px 0 4px; } input { width: 100%; box-sizing: border-box; font: inherit; padding: 8px; border: 1px solid #888; border-radius: 4px; }
button { margin-top: 12px; font: inherit; padding: 10px 24px; border-radius: 4px; border: 0; background: #1d4ed8; color: #fff; }</style></head><body><main>${body}</main></body></html>`;

/** @param {{ username?: string, password?: string, port?: number }} o */
export async function startAccountSite(o = {}) {
  const accounts = new Map(o.username ? [[o.username, { password: o.password, mfa: false }]] : []);
  const sessions = new Map();
  const hits = [];
  let changes = 0;
  let code = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    hits.push({ method: req.method, path: p });
    const form = Object.fromEntries(new URLSearchParams(body));
    const sid = /(?:^|;\s*)sid=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];
    const who = sid ? sessions.get(sid) : null;
    const html = (status, title, b, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(page(title, b)); };
    const go = (to, headers = {}) => { res.writeHead(303, { location: to, ...headers }); res.end(); };
    const signIn = (user) => { const s = randomBytes(12).toString('hex'); sessions.set(s, user); return { 'set-cookie': `sid=${s}; Path=/; HttpOnly; SameSite=Lax` }; };
    if (p === '/status') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`Accounts: ${accounts.size}\nPassword changes: ${changes}\nTwo-step: ${[...accounts.values()].some((a) => a.mfa) ? 'on' : 'off'}`); }
    if (req.method === 'GET' && p === '/login') {
      return html(200, 'Sign in', `<h1>Sign in</h1><form method="post" action="/login"><label for="username">Username</label><input type="text" id="username" name="username" autocomplete="off">
<label for="password">Password</label><input type="password" id="password" name="password" autocomplete="off"><button type="submit" id="signin">Sign in</button></form>`);
    }
    if (req.method === 'POST' && p === '/login') {
      const a = accounts.get(form.username);
      if (a && a.password === form.password) return go('/account', signIn(form.username));
      return html(401, 'Sign in', '<h1>Sign in</h1><p id="wrong">That sign-in didn’t work.</p>');
    }
    if (req.method === 'GET' && p === '/account') {
      if (!who) return go('/login');
      return html(200, 'Your account', `<h1 id="account">Signed in</h1>${url.searchParams.has('changed') ? '<p id="changed">Password changed</p>' : ''}${accounts.get(who)?.mfa ? '<p id="mfa-on">Two-step sign-in is on</p>' : ''}`);
    }
    if (req.method === 'GET' && p === '/password') {
      if (!who) return go('/login');
      return html(200, 'Change your password', `<h1>Change your password</h1><form method="post" action="/password">
<label for="current">Current password</label><input type="password" id="current" name="current" autocomplete="off">
<label for="new">New password</label><input type="password" id="new" name="new" autocomplete="off">
<label for="again">New password again</label><input type="password" id="again" name="again" autocomplete="off">
<button type="submit" id="save">Save password</button></form>`);
    }
    if (req.method === 'POST' && p === '/password') {
      const a = who ? accounts.get(who) : null;
      if (!a) return go('/login');
      if (form.current !== a.password) return html(400, 'Change your password', '<h1>Change your password</h1><p id="wrong">The current password is wrong.</p>');
      if (!form.new || form.new !== form.again || form.new.length < 12) return html(400, 'Change your password', '<h1>Change your password</h1><p id="wrong">The new passwords don’t match, or are too short.</p>');
      a.password = form.new;
      changes++;
      return go('/account?changed=1');
    }
    if (req.method === 'GET' && p === '/signup') {
      return html(200, 'Create an account', `<h1>Create an account</h1><form method="post" action="/signup">
<label for="email">Email</label><input type="email" id="email" name="email" autocomplete="off">
<label for="pw">Password</label><input type="password" id="pw" name="pw" autocomplete="off">
<label for="pw2">Password again</label><input type="password" id="pw2" name="pw2" autocomplete="off">
<button type="submit" id="create">Create account</button></form>`);
    }
    if (req.method === 'POST' && p === '/signup') {
      if (!form.email || accounts.has(form.email) || !form.pw || form.pw !== form.pw2 || form.pw.length < 12) return html(400, 'Create an account', '<h1>Create an account</h1><p id="wrong">That didn’t work.</p>');
      accounts.set(form.email, { password: form.pw, mfa: false });
      return go('/welcome', signIn(form.email));
    }
    if (req.method === 'GET' && p === '/welcome') return html(200, 'Welcome', '<h1 id="welcome">Account created</h1>');
    if (req.method === 'GET' && p === '/security') {
      if (!who) return go('/login');
      const on = accounts.get(who)?.mfa;
      return html(200, 'Security', `<h1>Security</h1>${on ? '<p id="mfa-on">Two-step sign-in is on</p>' : '<form method="post" action="/security/2fa/start"><button type="submit" id="enable-2fa">Turn on two-step sign-in</button></form>'}`);
    }
    if (req.method === 'POST' && p === '/security/2fa/start') {
      if (!who) return go('/login');
      code = String(randomInt(100000, 999999));
      return go('/security/2fa');
    }
    if (req.method === 'GET' && p === '/security/2fa') {
      if (!who) return go('/login');
      return html(200, 'Enter the code', `<h1>Enter the code we sent you</h1><form method="post" action="/security/2fa/verify"><label for="code">Code</label><input type="text" inputmode="numeric" id="code" name="code" autocomplete="one-time-code" style="position: fixed; top: 20px; left: 20px; width: 400px; height: 40px;"><button type="submit" id="verify">Verify</button></form>`);
    }
    if (req.method === 'POST' && p === '/security/2fa/verify') {
      const a = who ? accounts.get(who) : null;
      if (!a) return go('/login');
      if (!code || form.code !== code) return html(400, 'Enter the code', '<h1>Enter the code we sent you</h1><p id="wrong">That code didn’t work.</p>');
      a.mfa = true;
      code = null;
      return go('/security');
    }
    return html(404, 'Not found', '<h1>Not found</h1>');
  });
  await new Promise((r) => server.listen(o.port ?? 0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, port,
    passwordOf: (user) => accounts.get(user)?.password ?? null,
    accounts: () => [...accounts.keys()],
    mfa: (user) => accounts.get(user)?.mfa ?? false,
    lastCode: () => code,
    hits: (path) => hits.filter((h) => h.path === path),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const s = await startAccountSite({ port: Number(process.argv[2] ?? 0) });
  process.stdout.write(`${s.url}\n`);
}
