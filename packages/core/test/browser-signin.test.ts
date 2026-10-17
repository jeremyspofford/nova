// Private sign-in (FR-086, docs/11 §4.1): the agent asks, the user answers in a private form, the
// browser fills the fields, and the agent learns only that it worked. "Save to Passwords" puts
// the password in the vault (the row keeps a reference); a saved login is reused only when the
// user picks it; a verification code afterwards is the user's step (handoff); cancel and expiry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT, THREAD, makeBrowserEnv, type BrowserEnv } from './browser-env.ts';
import type { FakePage } from './browser-fake.ts';

const FORM = { action: 'https://login.example/session', method: 'post' };
const LOGIN: FakePage = {
  title: 'Sign in',
  text: 'Sign in to continue',
  elements: [
    {
      role: 'textbox',
      tag: 'input',
      inputType: 'email',
      name: 'Email',
      autocomplete: 'username',
      form: FORM,
    },
    { role: 'textbox', tag: 'input', inputType: 'password', name: 'Password', form: FORM },
    {
      role: 'button',
      tag: 'button',
      name: 'Sign in',
      form: FORM,
      navigates: 'https://login.example/home',
    },
  ],
};

let env: BrowserEnv;

beforeEach(async () => {
  env = await makeBrowserEnv({ signinTimeoutMs: 5_000 });
  env.driver.pages.set('https://login.example/', LOGIN);
  env.driver.pages.set('https://login.example/home', {
    title: 'Home',
    text: 'Welcome back',
    elements: [],
  });
  env.driver.pages.set('https://login.example/verify', {
    title: 'Verify',
    text: 'Enter the code we sent you',
    elements: [
      { role: 'textbox', tag: 'input', name: 'Verification code', autocomplete: 'one-time-code' },
    ],
  });
  await env.service.sites.put(ACCOUNT, {
    pattern: 'login.example',
    access: 'allow',
    level: 'always_allow',
  });
  expect((await env.service.navigate(env.call(), 'https://login.example/')).ok).toBe(true);
});

afterEach(async () => {
  await env.close();
});

async function pendingSignin() {
  await vi.waitFor(() => expect(env.service.signins.pending(ACCOUNT, THREAD)).toHaveLength(1));
  return env.service.signins.pending(ACCOUNT)[0]!;
}

describe('sign-in', () => {
  it('fills what the user typed, saves it to the vault, and tells the agent only that it worked', async () => {
    const asking = env.service.signIn(env.call(), 'to read the invoices');
    const form = await pendingSignin();
    expect(form).toMatchObject({ host: 'login.example', state: 'pending', savedLogins: [] });
    expect(env.events.events.find((e) => e.name === 'signin.requested')?.payload).toMatchObject({
      host: 'login.example',
      signinId: form.id,
    });
    expect(env.notes.at(-1)).toMatchObject({
      kind: 'attention',
      title: 'Sign in to login.example',
    });
    const filled = await env.service.signins.submit(ACCOUNT, form.id, {
      username: 'ada@example.com',
      password: 'correct horse battery',
      save: true,
    });
    expect(filled.state).toBe('completed');
    const out = await asking;
    expect(out.ok).toBe(true);
    const text = JSON.stringify(out);
    expect(text).not.toContain('correct horse');
    expect(text).not.toContain('ada@example.com');
    // The password reached the browser and the vault, never the database or the events.
    expect(env.driver.fills.map((f) => f.text)).toEqual([
      'ada@example.com',
      'correct horse battery',
    ]);
    const [login] = env.service.signins.logins(ACCOUNT);
    expect(login).toMatchObject({ host: 'login.example', username: 'ada@example.com' });
    expect(await env.secrets.get(`secret://browser/login/${login!.id}`)).toBe(
      'correct horse battery',
    );
    const dump = JSON.stringify([
      env.db.raw.prepare('SELECT * FROM browser_login').all(),
      env.db.raw.prepare('SELECT * FROM browser_action').all(),
      env.events.events,
      env.audit,
    ]);
    expect(dump).not.toContain('correct horse');
    expect(env.events.events.find((e) => e.name === 'signin.completed')?.payload).toMatchObject({
      savedCredential: true,
    });
    expect(env.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['browser.signin.requested', 'browser.login.saved']),
    );
    expect(env.service.signins.pending(ACCOUNT)).toEqual([]);
    await expect(
      env.service.signins.submit(ACCOUNT, form.id, { username: 'x', password: 'y' }),
    ).rejects.toMatchObject({
      code: 'request_expired',
    });
  });

  it('reuses a saved login only when the user picks it', async () => {
    await env.service.signins.saveLogin(ACCOUNT, 'login.example', 'ada', 'pw-saved-1');
    await env.service.signins.saveLogin(ACCOUNT, 'other.example', 'bob', 'pw-other');
    const asking = env.service.signIn(env.call(), undefined);
    const form = await pendingSignin();
    expect(form.savedLogins).toEqual([{ id: expect.any(String), username: 'ada' }]);
    const other = env.service.signins.logins(ACCOUNT, 'other.example')[0]!;
    await expect(
      env.service.signins.submit(ACCOUNT, form.id, { loginId: other.id, confirm: true }),
    ).rejects.toMatchObject({ code: 'validation' });
    await env.service.signins.submit(ACCOUNT, form.id, {
      loginId: form.savedLogins[0]!.id,
      confirm: true,
    });
    expect((await asking).ok).toBe(true);
    expect(env.driver.fills.map((f) => f.text)).toEqual(['ada', 'pw-saved-1']);
    expect(env.service.signins.login(ACCOUNT, form.savedLogins[0]!.id).lastUsedAt).not.toBeNull();
    expect(env.audit.some((a) => a.action === 'browser.login.used')).toBe(true);
    await env.service.signins.deleteLogin(ACCOUNT, other.id);
    expect(await env.secrets.get(`secret://browser/login/${other.id}`)).toBeNull();
    await expect(env.service.signins.deleteLogin(ACCOUNT, other.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('a verification code after the password is handed to the user', async () => {
    LOGIN.elements[2] = { ...LOGIN.elements[2]!, navigates: 'https://login.example/verify' };
    try {
      const asking = env.service.signIn(env.call(), undefined);
      const form = await pendingSignin();
      await env.service.signins.submit(ACCOUNT, form.id, { username: 'ada', password: 'pw' });
      let id = '';
      await vi.waitFor(() => {
        const r = env.db.raw
          .prepare("SELECT id, tier FROM approval WHERE status = 'pending'")
          .get() as { id: string; tier: string } | undefined;
        expect(r?.tier).toBe('handoff_required');
        id = r!.id;
      });
      await env.gate.decide(ACCOUNT, { approvalId: id, decision: 'handoff' }, 'user');
      await env.gate.handoffDone(ACCOUNT, id);
      const out = await asking;
      expect(out.ok && out.content[0]).toMatchObject({
        text: 'The user did this step themselves.',
      });
    } finally {
      LOGIN.elements[2] = { ...LOGIN.elements[2], navigates: 'https://login.example/home' };
    }
  });

  it('cancel and expiry end the request; a page without a password field is refused', async () => {
    const asking = env.service.signIn(env.call(), undefined);
    const form = await pendingSignin();
    await expect(env.service.signins.cancel('another-account', form.id)).rejects.toMatchObject({
      code: 'request_expired',
    });
    await env.service.signins.cancel(ACCOUNT, form.id);
    expect(await asking).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(env.events.events.some((e) => e.name === 'signin.cancelled')).toBe(true);
    await env.close();
    env = await makeBrowserEnv({ signinTimeoutMs: 20 });
    env.driver.pages.set('https://login.example/', LOGIN);
    env.driver.pages.set('https://login.example/home', { title: 'Home', text: '', elements: [] });
    await env.service.sites.put(ACCOUNT, { pattern: 'login.example', access: 'allow' });
    expect((await env.service.navigate(env.call(), 'https://login.example/')).ok).toBe(true);
    expect(await env.service.signIn(env.call(), undefined)).toMatchObject({
      ok: false,
      error: { code: 'approval_timeout' },
    });
    expect((await env.service.navigate(env.call(), 'https://login.example/home')).ok).toBe(true);
    expect(await env.service.signIn(env.call(), undefined)).toMatchObject({
      ok: false,
      error: { code: 'no_signin_form' },
    });
  });

  it('a cancelled call withdraws the form', async () => {
    const ac = new AbortController();
    const asking = env.service.signIn(env.call({ signal: ac.signal }), undefined);
    await pendingSignin();
    ac.abort();
    expect(await asking).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(env.service.signins.pending(ACCOUNT)).toEqual([]);
  });
});
