// Private sign-in (FR-086, docs/11 §4.1). The agent asks for a sign-in; the Hub opens a private
// form for the user (outside the model context); what the user types goes straight to the
// browser and, only if they choose "Save to Passwords", to the vault. A saved login is reused
// only after the user confirms it in the form. The answer the tool returns says only whether the
// user signed in. A pending sign-in lives in Hub memory: it belongs to a running tool call.
import {
  NovaError,
  uuidv7,
  type BrowserLoginView,
  type BrowserSigninView,
  type SubmitBrowserSigninRequest,
} from '@nova/shared';
import { defaultRedactor } from '@nova/security';
import type { SecretStore } from '@nova/secrets';
import type { NovaDatabase } from '@nova/storage';

/** What the waiting tool call receives: typed credentials or a confirmed saved login. */
export type SigninAnswer =
  | { kind: 'credentials'; username: string; password: string; save: boolean }
  | { kind: 'saved'; loginId: string; username: string; password: string }
  | { kind: 'cancelled' }
  | { kind: 'expired' };

/** What the form gets back once the browser filled the fields. */
export interface SigninFill {
  state: 'completed' | 'failed';
  message: string;
}

interface Pending {
  view: BrowserSigninView;
  accountId: string;
  settle: (a: SigninAnswer) => Promise<SigninFill>;
}

interface LoginRow {
  id: string;
  account_id: string;
  host: string;
  username: string;
  secret_ref: string;
  created_at: string;
  last_used_at: string | null;
}

function loginView(r: LoginRow): BrowserLoginView {
  return {
    id: r.id,
    host: r.host,
    username: r.username,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export const loginRef = (id: string) => `secret://browser/login/${id}`;

export interface SigninDeskOptions {
  db: NovaDatabase;
  secrets: SecretStore;
  now?: () => Date;
}

/** Pending private forms and saved logins. */
export class SigninDesk {
  readonly #db: NovaDatabase;
  readonly #secrets: SecretStore;
  readonly #now: () => Date;
  readonly #pending = new Map<string, Pending>();

  constructor(opts: SigninDeskOptions) {
    this.#db = opts.db;
    this.#secrets = opts.secrets;
    this.#now = opts.now ?? (() => new Date());
  }

  // ---- saved logins -----------------------------------------------------------------------

  logins(accountId: string, host?: string): BrowserLoginView[] {
    const rows = (host
      ? this.#db.raw
          .prepare(
            'SELECT * FROM browser_login WHERE account_id = ? AND host = ? ORDER BY username',
          )
          .all(accountId, host)
      : this.#db.raw
          .prepare('SELECT * FROM browser_login WHERE account_id = ? ORDER BY host, username')
          .all(accountId)) as unknown as LoginRow[];
    return rows.map(loginView);
  }

  /** Save (or replace) a login: the password goes to the vault, the row keeps its reference. */
  async saveLogin(
    accountId: string,
    host: string,
    username: string,
    password: string,
  ): Promise<BrowserLoginView> {
    const existing = this.#db.raw
      .prepare('SELECT * FROM browser_login WHERE account_id = ? AND host = ? AND username = ?')
      .get(accountId, host, username) as unknown as LoginRow | undefined;
    const id = existing?.id ?? uuidv7();
    await this.#secrets.put(loginRef(id), password);
    const now = this.#now().toISOString();
    if (!existing)
      await this.#db.transaction(() => {
        this.#db.raw
          .prepare(
            `INSERT INTO browser_login (id, account_id, host, username, secret_ref, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(id, accountId, host, username, loginRef(id), now);
      });
    return this.login(accountId, id);
  }

  login(accountId: string, id: string): BrowserLoginView {
    const r = this.#db.raw
      .prepare('SELECT * FROM browser_login WHERE id = ? AND account_id = ?')
      .get(id, accountId) as unknown as LoginRow | undefined;
    if (!r) throw new NovaError('not_found', 'no such saved login');
    return loginView(r);
  }

  async #password(accountId: string, id: string): Promise<{ username: string; password: string }> {
    const r = this.#db.raw
      .prepare('SELECT * FROM browser_login WHERE id = ? AND account_id = ?')
      .get(id, accountId) as unknown as LoginRow | undefined;
    if (!r) throw new NovaError('not_found', 'no such saved login');
    const password = await this.#secrets.get(r.secret_ref);
    if (password === null)
      throw new NovaError('not_found', 'the saved password is no longer in the vault');
    const now = this.#now().toISOString();
    await this.#db.transaction(() => {
      this.#db.raw.prepare('UPDATE browser_login SET last_used_at = ? WHERE id = ?').run(now, id);
    });
    return { username: r.username, password };
  }

  async deleteLogin(accountId: string, id: string): Promise<void> {
    const r = this.#db.raw
      .prepare('SELECT * FROM browser_login WHERE id = ? AND account_id = ?')
      .get(id, accountId) as unknown as LoginRow | undefined;
    if (!r) throw new NovaError('not_found', 'no such saved login');
    await this.#secrets.delete(r.secret_ref);
    await this.#db.transaction(() => {
      this.#db.raw.prepare('DELETE FROM browser_login WHERE id = ?').run(id);
    });
  }

  // ---- pending forms ------------------------------------------------------------------------

  /**
   * Open a private form and wait for the user's answer, the timeout or the call's cancellation.
   * `fill` runs with the answer while the form waits, so it learns whether signing in worked.
   */
  async ask(
    input: {
      accountId: string;
      computerId: string;
      threadId: string | null;
      host: string;
      url: string | null;
      timeoutMs: number;
      signal: AbortSignal;
    },
    fill: (a: SigninAnswer) => Promise<SigninFill>,
    onOpen: (view: BrowserSigninView) => Promise<void>,
  ): Promise<{ answer: SigninAnswer; fill: SigninFill | null }> {
    const now = this.#now();
    const view: BrowserSigninView = {
      id: uuidv7(),
      computerId: input.computerId,
      threadId: input.threadId,
      host: input.host,
      url: input.url,
      state: 'pending',
      savedLogins: this.logins(input.accountId, input.host).map((l) => ({
        id: l.id,
        username: l.username,
      })),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.timeoutMs).toISOString(),
    };
    return await new Promise((resolve) => {
      let done = false;
      const finish = async (answer: SigninAnswer): Promise<SigninFill> => {
        if (done) return { state: 'failed', message: 'this sign-in was already answered' };
        done = true;
        clearTimeout(timer);
        input.signal.removeEventListener('abort', onAbort);
        this.#pending.delete(view.id);
        let result: SigninFill | null = null;
        if (answer.kind === 'credentials' || answer.kind === 'saved') {
          try {
            result = await fill(answer);
          } catch (err) {
            result = {
              state: 'failed',
              message: defaultRedactor.redactString(
                err instanceof Error ? err.message : String(err),
              ),
            };
          }
        }
        resolve({ answer, fill: result });
        return result ?? { state: 'failed', message: `the sign-in was ${answer.kind}` };
      };
      const timer = setTimeout(() => void finish({ kind: 'expired' }), input.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const onAbort = () => void finish({ kind: 'cancelled' });
      input.signal.addEventListener('abort', onAbort, { once: true });
      this.#pending.set(view.id, { view, accountId: input.accountId, settle: finish });
      void onOpen(view).catch(() => undefined);
      if (input.signal.aborted) onAbort();
    });
  }

  pending(accountId: string, threadId?: string): BrowserSigninView[] {
    return [...this.#pending.values()]
      .filter((p) => p.accountId === accountId && (!threadId || p.view.threadId === threadId))
      .map((p) => p.view);
  }

  /** The private form's answer (POST /browser/signins/:id/submit). Never stored or echoed. */
  async submit(
    accountId: string,
    id: string,
    body: SubmitBrowserSigninRequest,
  ): Promise<SigninFill> {
    const p = this.#pending.get(id);
    if (!p || p.accountId !== accountId)
      throw new NovaError('request_expired', 'this sign-in is no longer waiting');
    if ('loginId' in body) {
      if (!p.view.savedLogins.some((l) => l.id === body.loginId))
        throw new NovaError('validation', 'that saved login is not for this site');
      const { username, password } = await this.#password(accountId, body.loginId);
      defaultRedactor.addLiteral(password);
      return await p.settle({ kind: 'saved', loginId: body.loginId, username, password });
    }
    defaultRedactor.addLiteral(body.password);
    return await p.settle({
      kind: 'credentials',
      username: body.username,
      password: body.password,
      save: body.save ?? false,
    });
  }

  async cancel(accountId: string, id: string): Promise<void> {
    const p = this.#pending.get(id);
    if (!p || p.accountId !== accountId)
      throw new NovaError('request_expired', 'this sign-in is no longer waiting');
    await p.settle({ kind: 'cancelled' });
  }

  /** Withdraw every pending form (shutdown). */
  async close(): Promise<void> {
    for (const p of [...this.#pending.values()]) await p.settle({ kind: 'cancelled' });
  }
}
