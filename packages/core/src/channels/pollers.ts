// Channels the Hub reads rather than receives (FR-110, docs/13 §4): a Telegram bot in polling mode
// (`getUpdates` long polling, for a Hub without a public address) and email mailboxes (IMAP IDLE,
// or polling every `channels.email.pollSeconds`). One loop per credential group (one bot, one
// mailbox), run for the group's oldest connected binding; what it reads goes to
// `ChannelService.receiveFrom`, which routes it to the binding of its conversation. The cursor (an
// update offset, or a folder's UIDVALIDITY and last UID) is kept in `channel_cursor` and advanced
// message by message, so a restart neither replays nor skips. Failures back off and show in the
// bindings' status detail.
import type { NovaDatabase } from '@nova/storage';
import type { Logger } from '@nova/telemetry';
import { EmailAdapter } from './adapters/email.ts';
import type { MailCursor } from './adapters/mail/imap.ts';
import { TelegramAdapter } from './adapters/telegram.ts';
import type { ChannelService, ChannelSetting } from './service.ts';

export interface ChannelPollersOptions {
  service: ChannelService;
  db: NovaDatabase;
  setting: ChannelSetting;
  log?: Logger;
  now?: () => Date;
  /** How long `getUpdates` waits for an update (seconds; default 25). */
  telegramWaitSeconds?: number;
  /** Pause between rounds that return at once (tests, and a Telegram wait of 0). */
  idleMs?: number;
  /** First retry delay after a failure; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

interface Group {
  /** The binding the loop reads for (the group's oldest connected one). */
  via: string;
  kind: 'telegram' | 'email';
  secretRef: string;
}

const MAIL_BATCH = 50;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    t.unref?.();
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

export class ChannelPollers {
  readonly #o: ChannelPollersOptions;
  readonly #db: NovaDatabase;
  readonly #now: () => Date;
  readonly #loops = new Map<string, { ctl: AbortController; done: Promise<void> }>();
  #off: (() => void) | null = null;
  #running = false;

  constructor(opts: ChannelPollersOptions) {
    this.#o = opts;
    this.#db = opts.db;
    this.#now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    // A changed sign-in (M8: a mailbox authorized with OAuth) restarts its group's loop at once
    // instead of waiting out a failure's backoff.
    this.#off = this.#o.service.onBindingChange((c) =>
      c.what === 'credentials' ? this.restart(c.bindingId) : this.reconcile(),
    );
    this.reconcile();
  }

  /** Stop the loop of a binding's credential group and start it again (M8). */
  restart(bindingId: string): void {
    if (!this.#running) return;
    const row = this.#db.raw
      .prepare('SELECT kind, secret_ref FROM channel_binding WHERE id = ?')
      .get(bindingId) as { kind: string; secret_ref: string | null } | undefined;
    const stopping: Promise<void>[] = [];
    if (row?.secret_ref) {
      const prefix = `${row.kind}:${row.secret_ref}:`;
      for (const [key, loop] of this.#loops)
        if (key.startsWith(prefix)) {
          loop.ctl.abort();
          this.#loops.delete(key);
          stopping.push(loop.done);
        }
    }
    // The new loop starts once the old one has stopped, so one mailbox is never read twice.
    void Promise.all(stopping).then(() => this.reconcile());
  }

  /** The groups that need a loop: connected Telegram bots in polling mode and mailboxes. */
  groups(): Group[] {
    const rows = this.#db.raw
      .prepare(
        `SELECT id, kind, secret_ref, config_json FROM channel_binding
         WHERE enabled = 1 AND kind IN ('telegram', 'email') AND secret_ref IS NOT NULL
         ORDER BY created_at, id`,
      )
      .all() as {
      id: string;
      kind: 'telegram' | 'email';
      secret_ref: string;
      config_json: string | null;
    }[];
    const out = new Map<string, Group>();
    for (const r of rows) {
      const key = `${r.kind}:${r.secret_ref}`;
      if (out.has(key)) continue;
      if (r.kind === 'telegram') {
        let mode: unknown = null;
        try {
          mode = (JSON.parse(r.config_json ?? '{}') as { mode?: unknown }).mode;
        } catch {
          // the default mode
        }
        if (mode === 'webhook') continue;
      }
      out.set(key, { via: r.id, kind: r.kind, secretRef: r.secret_ref });
    }
    return [...out.values()];
  }

  /** Start loops for new groups and stop the ones no longer wanted. */
  reconcile(): void {
    if (!this.#running) return;
    const want = new Map(this.groups().map((g) => [`${g.kind}:${g.secretRef}:${g.via}`, g]));
    for (const [key, loop] of this.#loops)
      if (!want.has(key)) {
        loop.ctl.abort();
        this.#loops.delete(key);
      }
    for (const [key, g] of want) {
      if (this.#loops.has(key)) continue;
      const ctl = new AbortController();
      const done = this.#loop(g, ctl.signal).catch((err: unknown) =>
        this.#o.log?.warn('channel poller stopped', { err, bindingId: g.via }),
      );
      this.#loops.set(key, { ctl, done });
    }
  }

  /** One round for a binding's group: what it read and handled (tests call this directly). */
  async pollOnce(
    bindingId: string,
    signal: AbortSignal = AbortSignal.timeout(60_000),
  ): Promise<number> {
    const g = this.groups().find((x) => x.via === bindingId);
    if (!g) return 0;
    return this.#round(g, signal, 0);
  }

  async #round(g: Group, signal: AbortSignal, waitSeconds: number): Promise<number> {
    return g.kind === 'telegram' ? this.#telegram(g, signal, waitSeconds) : this.#email(g, signal);
  }

  async #telegram(g: Group, signal: AbortSignal, waitSeconds: number): Promise<number> {
    const adapter = this.#o.service.adapterOf('telegram');
    if (!(adapter instanceof TelegramAdapter)) return 0;
    const offset = Number(this.#cursor(g.via) ?? 0) || 0;
    const updates = await adapter.poll(g.via, offset, waitSeconds, signal);
    let handled = 0;
    for (const u of updates) {
      const updateId = typeof u.update_id === 'number' ? u.update_id : null;
      const msg = await adapter.parseUpdate(g.via, u).catch(() => null);
      if (msg) {
        await this.#o.service
          .receiveFrom(g.via, msg)
          .catch((err: unknown) => this.#o.log?.warn('telegram update failed', { err }));
        handled++;
      }
      // Confirmed one by one: the next getUpdates with this offset drops it at Telegram.
      if (updateId !== null) await this.#setCursor(g.via, String(updateId + 1));
    }
    return handled;
  }

  async #email(g: Group, signal: AbortSignal): Promise<number> {
    const adapter = this.#o.service.adapterOf('email');
    if (!(adapter instanceof EmailAdapter)) return 0;
    let cursor: MailCursor | null;
    try {
      const raw = this.#cursor(g.via);
      cursor = raw ? (JSON.parse(raw) as MailCursor) : null;
    } catch {
      cursor = null;
    }
    const res = await adapter.read(g.via, cursor, MAIL_BATCH, signal);
    for (const s of res.skipped ?? [])
      this.#o.log?.warn('email too large to read; passed over', { bindingId: g.via, ...s });
    let handled = 0;
    for (const m of res.messages) {
      const msg = await adapter.parseRaw(g.via, m.source).catch(() => null);
      if (msg) {
        await this.#o.service
          .receiveFrom(g.via, msg)
          .catch((err: unknown) => this.#o.log?.warn('email message failed', { err }));
        handled++;
      }
      await this.#setCursor(g.via, JSON.stringify({ ...res.cursor, lastUid: m.uid }));
    }
    await this.#setCursor(g.via, JSON.stringify(res.cursor));
    return handled;
  }

  async #loop(g: Group, signal: AbortSignal): Promise<void> {
    const base = this.#o.backoffMs ?? 5_000;
    let backoff = base;
    let failing = false;
    const wait = this.#o.telegramWaitSeconds ?? 25;
    while (!signal.aborted) {
      try {
        await this.#round(g, signal, wait);
        if (failing) await this.#status(g, null);
        failing = false;
        backoff = base;
        if (signal.aborted) break;
        if (g.kind === 'email') {
          const seconds = await this.#o.setting('channels.email.pollSeconds');
          const adapter = this.#o.service.adapterOf('email');
          if (adapter instanceof EmailAdapter && (await adapter.mode(g.via)) === 'idle')
            await adapter.watch(g.via, seconds * 1000, signal);
          else await sleep(seconds * 1000, signal);
        } else if (wait === 0) await sleep(this.#o.idleMs ?? 1_000, signal);
      } catch (err) {
        if (signal.aborted) break;
        failing = true;
        const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        this.#o.log?.warn('channel poll failed', { bindingId: g.via, detail });
        await this.#status(g, `reading failed: ${detail}`).catch(() => undefined);
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, this.#o.maxBackoffMs ?? 5 * 60_000);
      }
    }
  }

  #cursor(bindingId: string): string | null {
    const row = this.#db.raw
      .prepare('SELECT cursor FROM channel_cursor WHERE binding_id = ?')
      .get(bindingId) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  async #setCursor(bindingId: string, cursor: string): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          `INSERT INTO channel_cursor (binding_id, cursor, updated_at)
           SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM channel_binding WHERE id = ?)
           ON CONFLICT (binding_id) DO UPDATE SET cursor = excluded.cursor,
             updated_at = excluded.updated_at`,
        )
        .run(bindingId, cursor, this.#now().toISOString(), bindingId);
    });
  }

  async #status(g: Group, detail: string | null): Promise<void> {
    await this.#db.transaction(() => {
      this.#db.raw
        .prepare(
          'UPDATE channel_binding SET status_detail = ? WHERE kind = ? AND secret_ref = ? AND enabled = 1',
        )
        .run(detail, g.kind, g.secretRef);
    });
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#off?.();
    this.#off = null;
    const loops = [...this.#loops.values()];
    this.#loops.clear();
    for (const l of loops) l.ctl.abort();
    await Promise.all(loops.map((l) => l.done));
  }
}
