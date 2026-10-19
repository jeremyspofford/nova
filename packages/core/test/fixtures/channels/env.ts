// Shared harness for the channel, trigger and notification tests: a migrated database with an
// owner account, threads, a fake turn starter whose replies the test scripts, a fake run
// starter, a clock and collected audit entries.
import { MemorySecretStore } from '@nova/secrets';
import { SETTINGS, uuidv7, type SettingKey } from '@nova/shared';
import { migrate, openDatabase, type NovaDatabase } from '@nova/storage';
import {
  ChannelService,
  EmailAdapter,
  InAppAdapter,
  MemoryEventSink,
  SlackAdapter,
  TeamsAdapter,
  TelegramAdapter,
  WebhookAdapter,
  type AuditRecord,
  type ChannelServiceOptions,
  type CreateRunInput,
  type RunFinish,
  type RunStarter,
  type StartTurnInput,
  type StartedTurn,
  type TeamsTokenVerifier,
  type TurnOutcome,
  type TurnStarter,
} from '../../../src/index.ts';
import type { WebhookTransport } from '../../../src/scheduler/delivery.ts';

export const ACCOUNT = '01920000-0000-7000-8000-0000000000e1';

export async function channelsDb(): Promise<NovaDatabase> {
  const db = openDatabase({ path: ':memory:' });
  await migrate(db);
  const now = new Date().toISOString();
  db.raw
    .prepare(
      "INSERT INTO account (id, kind, display_name, created_at, updated_at) VALUES (?, 'local', 'Owner', ?, ?)",
    )
    .run(ACCOUNT, now, now);
  return db;
}

export function insertThread(db: NovaDatabase, title = 'thread', mode = 'chat'): string {
  const id = uuidv7();
  const now = new Date().toISOString();
  db.raw
    .prepare(
      'INSERT INTO thread (id, account_id, mode, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, ACCOUNT, mode, title, now, now);
  return id;
}

/** Add a text message to a thread (private content for the overlap check). */
export function insertMessage(
  db: NovaDatabase,
  threadId: string,
  role: string,
  text: string,
  turnId: string | null = null,
): void {
  const id = uuidv7();
  const now = new Date().toISOString();
  db.raw
    .prepare(
      'INSERT INTO message (id, thread_id, turn_id, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, threadId, turnId, role, now, now);
  db.raw
    .prepare(
      "INSERT INTO message_part (id, message_id, idx, type, content, created_at) VALUES (?, ?, 0, 'text', ?, ?)",
    )
    .run(uuidv7(), id, text, now);
}

export class Clock {
  t: number;
  #seq = 0;
  timers: { at: number; fn: () => void; id: number }[] = [];
  constructor(start = '2026-10-17T12:00:00.000Z') {
    this.t = Date.parse(start);
  }
  now = (): Date => new Date(this.t);
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.#seq;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (id: unknown): void => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };
  /** Move time and run the timers that came due (no awaiting: callers settle themselves). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const next = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.timers = this.timers.filter((x) => x !== next);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = end;
  }
}

/** A turn starter whose reply the test decides; each turn ends when `finish` is called or at once. */
export class FakeTurns implements TurnStarter {
  calls: StartTurnInput[] = [];
  cancelled: string[] = [];
  reply: (input: StartTurnInput) => string = (i) => `You said: ${i.text}`;
  /** Hold turns open until `release(turnId)` (approvals). */
  hold = false;
  #open = new Map<string, (o: TurnOutcome) => void>();

  startTurn(input: StartTurnInput): Promise<StartedTurn> {
    this.calls.push(input);
    const turnId = uuidv7();
    const outcome = (): TurnOutcome => ({
      turnId,
      status: 'completed',
      stop: 'end',
      replyText: this.reply(input),
      steps: 1,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
      activeMs: 1,
    });
    const done = this.hold
      ? new Promise<TurnOutcome>((resolve) => this.#open.set(turnId, () => resolve(outcome())))
      : Promise.resolve(outcome());
    return Promise.resolve({ turnId, messageId: uuidv7(), done });
  }

  release(turnId: string): void {
    this.#open.get(turnId)?.({} as TurnOutcome);
    this.#open.delete(turnId);
  }

  cancel(_accountId: string, threadId: string): Promise<void> {
    this.cancelled.push(threadId);
    return Promise.resolve();
  }
}

export class FakeRuns implements RunStarter {
  created: CreateRunInput[] = [];
  createRun(input: CreateRunInput): Promise<{ runId: string; threadId: string }> {
    this.created.push(input);
    return Promise.resolve({
      runId: `run-${this.created.length}`,
      threadId: `t-${this.created.length}`,
    });
  }
  whenFinished(): Promise<RunFinish> {
    return new Promise(() => undefined);
  }
}

export function settingsOf(over: Partial<Record<SettingKey, unknown>> = {}) {
  return <K extends SettingKey>(key: K) =>
    Promise.resolve((over[key] ?? SETTINGS[key].default) as never);
}

export interface ServiceEnv {
  db: NovaDatabase;
  secrets: MemorySecretStore;
  events: MemoryEventSink;
  audit: AuditRecord[];
  clock: Clock;
  service: ChannelService;
  turns: FakeTurns;
  threadsCreated: string[];
  settings: Partial<Record<SettingKey, unknown>>;
}

export interface ServiceEnvOptions {
  slackApi?: string;
  /** M7: the mock Telegram Bot API, the public address approval links use, attachments' home. */
  telegramApi?: string;
  publicBase?: string;
  dataDir?: string;
  teams?: { verifier: TeamsTokenVerifier; tokenUrl: string };
  webhookTransport?: WebhookTransport;
  extra?: Partial<ChannelServiceOptions>;
}

export async function serviceEnv(opts: ServiceEnvOptions = {}): Promise<ServiceEnv> {
  const db = await channelsDb();
  const secrets = new MemorySecretStore();
  const events = new MemoryEventSink();
  const audit: AuditRecord[] = [];
  const clock = new Clock(new Date().toISOString());
  const threadsCreated: string[] = [];
  const settings: Partial<Record<SettingKey, unknown>> = {};
  const service = new ChannelService({
    db,
    events,
    secrets,
    setting: (key) => Promise.resolve((settings[key] ?? SETTINGS[key].default) as never),
    audit: { append: (r) => (audit.push(r), Promise.resolve()) },
    now: clock.now,
    createThread: (_accountId, input) => {
      const id = insertThread(db, input.title, input.mode);
      threadsCreated.push(id);
      return Promise.resolve(id);
    },
    adapters: (credentials) => ({
      slack: new SlackAdapter({
        credentials,
        ...(opts.slackApi ? { apiBase: opts.slackApi } : {}),
        now: clock.now,
      }),
      ...(opts.teams
        ? {
            teams: new TeamsAdapter({
              credentials,
              verifier: opts.teams.verifier,
              tokenUrl: opts.teams.tokenUrl,
              serviceHost: () => true,
              now: clock.now,
            }),
          }
        : {}),
      webhook: new WebhookAdapter({
        credentials,
        ...(opts.webhookTransport ? { transport: opts.webhookTransport } : {}),
        now: clock.now,
      }),
      email: new EmailAdapter({ credentials, now: clock.now }),
      ...(opts.telegramApi
        ? {
            telegram: new TelegramAdapter({
              credentials,
              apiBase: opts.telegramApi,
              now: clock.now,
              webhookUrl: (id) =>
                Promise.resolve(
                  opts.publicBase ? `${opts.publicBase}/api/v1/channels/${id}/inbound` : null,
                ),
            }),
          }
        : {}),
      inapp: new InAppAdapter({ now: clock.now }),
    }),
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    ...(opts.publicBase ? { publicBase: () => Promise.resolve(opts.publicBase!) } : {}),
    ...opts.extra,
  });
  const turns = new FakeTurns();
  service.useTurns(turns);
  return { db, secrets, events, audit, clock, service, turns, threadsCreated, settings };
}
