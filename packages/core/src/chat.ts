// Conversation engine for chat turns (FR-017, FR-018, FR-021, FR-023). `send` records the turn
// and both messages, returns at once, and streams from the provider in the background: deltas
// go out as ephemeral `chat.delta` events and the text is persisted at most every 250 ms, so a
// cancel or a crash keeps the partial output, marked incomplete (FR-018, docs/09 §2).
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  NovaError,
  uuidv7,
  type ChatDeltaPayload,
  type ChatMessageCompletedPayload,
  type MessageStatus,
  type SendMessageRequest,
  type SendMessageResponse,
} from '@nova/shared';
import type {
  AgentErrorShape,
  ChatRequest,
  ContentPart,
  NormalizedMessage,
  Provider,
  ReasoningLevel,
  StopReason,
  StreamEvent,
} from '@nova/providers';
import { defaultRedactor, type Redactor } from '@nova/security';
import { schema, type NovaDatabase } from '@nova/storage';
import { Logger } from '@nova/telemetry';
import {
  MAX_INLINE_CHARS,
  attachmentKind,
  prepareAttachments,
  readAttachmentBlob,
  writeAttachmentBlob,
} from './attachments.ts';
import type { EventSink } from './events.ts';
import type { ProviderRegistry } from './registry.ts';
import { titleFrom, type ThreadService } from './threads.ts';

const { thread, turn, message, messagePart, attachment, usageEvent } = schema;

export const DEFAULT_SYSTEM_PROMPT =
  'You are Nova, a helpful assistant. Answer clearly and accurately, say when you are unsure, ' +
  'and use Markdown when it helps.';

export interface ChatServiceOptions {
  db: NovaDatabase;
  registry: ProviderRegistry;
  threads: ThreadService;
  events: EventSink;
  /** Hub data directory; attachment blobs live under `blobs/attachments/` (docs/06 §3). */
  dataDir: string;
  log?: Logger;
  now?: () => Date;
  /** Minimum time between partial-text writes (default 250 ms). */
  flushIntervalMs?: number;
  /** Minimum time between `chat.delta` events per message (default 16 ms, ≤ 60/s). */
  deltaIntervalMs?: number;
  systemPrompt?: string;
  redactor?: Redactor;
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

interface Active {
  controller: AbortController;
  finished: Promise<void>;
  resolve: () => void;
}

interface TurnRun {
  accountId: string;
  threadId: string;
  turnId: string;
  assistantId: string;
  textPartId: string;
  reasoningPartId: string;
  ref: string;
  modelId: string;
  providerKind: string;
  provider: Provider;
  vision: boolean;
  reasoningLevel: string | null;
  signal: AbortSignal;
  startedAt: number;
  firstTokenAt: number | null;
  text: string;
  reasoning: string;
  reasoningStored: boolean;
  usage: Usage | null;
  stop: StopReason | null;
  error: AgentErrorShape | null;
  inputChars: number;
  lastFlush: number;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  flushChain: Promise<void>;
  lastDelta: number;
  deltaTimer: ReturnType<typeof setTimeout> | undefined;
  pending: { type: 'text_delta' | 'reasoning_delta'; text: string }[];
}

export class ChatService {
  readonly #db: NovaDatabase;
  readonly #registry: ProviderRegistry;
  readonly #threads: ThreadService;
  readonly #events: EventSink;
  readonly #dataDir: string;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #flushMs: number;
  readonly #deltaMs: number;
  readonly #system: string;
  readonly #redactor: Redactor;
  readonly #active = new Map<string, Active>();

  constructor(opts: ChatServiceOptions) {
    this.#db = opts.db;
    this.#registry = opts.registry;
    this.#threads = opts.threads;
    this.#events = opts.events;
    this.#dataDir = opts.dataDir;
    this.#log = opts.log ?? new Logger({ module: 'core.chat', sinks: [] });
    this.#now = opts.now ?? (() => new Date());
    this.#flushMs = opts.flushIntervalMs ?? 250;
    this.#deltaMs = opts.deltaIntervalMs ?? 16;
    this.#system = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.#redactor = opts.redactor ?? defaultRedactor;
  }

  /** True while a turn is running (or being set up) in the thread. */
  isActive(threadId: string): boolean {
    return this.#active.has(threadId);
  }

  async send(
    accountId: string,
    threadId: string,
    req: SendMessageRequest,
  ): Promise<SendMessageResponse> {
    // Reserve the thread synchronously so two concurrent sends cannot both start a turn.
    if (this.#active.has(threadId)) throw busy();
    let resolve!: () => void;
    const finished = new Promise<void>((r) => (resolve = r));
    const active: Active = { controller: new AbortController(), finished, resolve };
    this.#active.set(threadId, active);
    try {
      const run = await this.#begin(accountId, threadId, req, active.controller.signal);
      void this.#run(run).finally(() => {
        this.#active.delete(threadId);
        resolve();
      });
      return {
        disposition: 'started',
        turnId: run.turnId,
        userMessageId: run.userMessageId,
        assistantMessageId: run.assistantId,
      };
    } catch (err) {
      this.#active.delete(threadId);
      resolve();
      throw err;
    }
  }

  /** Stop the running turn; resolves once its partial output is saved (FR-018). */
  async cancel(accountId: string, threadId: string): Promise<boolean> {
    await this.#threads.row(accountId, threadId);
    const active = this.#active.get(threadId);
    if (!active) return false;
    active.controller.abort();
    await Promise.race([active.finished, delay(10_000)]);
    return true;
  }

  /** Wait for every running turn to finish (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.#active.values()].map((a) => a.finished));
  }

  /** Cancel every running turn and wait for each to save its partial output. */
  async shutdown(): Promise<void> {
    for (const a of this.#active.values()) a.controller.abort();
    await this.idle();
  }

  /**
   * After a crash: messages still `streaming` become `incomplete`, open turns end
   * `interrupted`, and threads leave the streaming state. Call before serving requests.
   */
  async recoverOnStartup(): Promise<{ messages: number; turns: number }> {
    const now = this.#now().toISOString();
    return this.#db.transaction(() => {
      const raw = this.#db.raw;
      const m = raw
        .prepare(
          "UPDATE message SET status = 'incomplete', updated_at = ? WHERE status = 'streaming'",
        )
        .run(now);
      const t = raw
        .prepare(
          `UPDATE turn SET status = 'interrupted', stop_reason = 'error', ended_at = ?, updated_at = ?
           WHERE status = 'in_progress'`,
        )
        .run(now, now);
      raw.prepare("UPDATE thread SET state = 'idle' WHERE state = 'streaming'").run();
      return { messages: Number(m.changes), turns: Number(t.changes) };
    });
  }

  // ---- setup ----------------------------------------------------------------------------

  async #begin(
    accountId: string,
    threadId: string,
    req: SendMessageRequest,
    signal: AbortSignal,
  ): Promise<TurnRun & { userMessageId: string }> {
    const row = await this.#threads.row(accountId, threadId);
    const open = this.#db.raw
      .prepare("SELECT 1 AS x FROM turn WHERE thread_id = ? AND status = 'in_progress' LIMIT 1")
      .get(threadId);
    if (open) throw busy();
    const prepared = prepareAttachments(req.attachments ?? []);
    if (!req.text.trim() && prepared.length === 0)
      throw new NovaError('validation', 'type a message or attach a file', {
        details: { reason: 'empty' },
      });
    const ref = req.model ?? row.modelId ?? (await this.#threads.defaultModel(accountId));
    if (!ref)
      throw new NovaError('validation', 'choose a model first: no provider is configured', {
        details: { reason: 'no_model' },
      });
    const resolved = await this.#registry.resolve(accountId, ref);
    const reasoningLevel = req.reasoningLevel ?? row.reasoningLevel ?? null;
    const blobs = prepared.map((a) => writeAttachmentBlob(this.#dataDir, a.bytes));

    const now = this.#now().toISOString();
    const turnId = uuidv7();
    const userMessageId = uuidv7();
    const assistantId = uuidv7();
    const textPartId = uuidv7();
    const reasoningPartId = uuidv7();
    let idx = 0;
    await this.#db.transaction(async () => {
      const next = this.#db.raw
        .prepare('SELECT COALESCE(MAX(idx), -1) + 1 AS n FROM turn WHERE thread_id = ?')
        .get(threadId) as { n: number };
      idx = next.n;
      await this.#db.orm.insert(turn).values({
        id: turnId,
        threadId,
        idx,
        status: 'in_progress',
        trigger: 'user',
        executionLocation: 'hub',
        modelId: ref,
        reasoningLevel,
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await this.#db.orm.insert(message).values({
        id: userMessageId,
        threadId,
        turnId,
        role: 'user',
        authorKind: 'user',
        provenance: 'typed',
        status: 'complete',
        createdAt: now,
        updatedAt: now,
      });
      const parts: (typeof messagePart.$inferInsert)[] = [];
      if (req.text.trim()) {
        parts.push({
          id: uuidv7(),
          messageId: userMessageId,
          idx: 0,
          type: 'text',
          content: req.text,
          createdAt: now,
        });
      }
      const attachmentRows = prepared.map((a, i) => ({
        id: uuidv7(),
        messageId: userMessageId,
        threadId,
        name: a.name,
        mime: a.mime,
        size: a.bytes.length,
        sha256: blobs[i]!.sha256,
        origin: 'upload' as const,
        blobPath: blobs[i]!.blobPath,
        createdAt: now,
      }));
      attachmentRows.forEach((a, i) =>
        parts.push({
          id: uuidv7(),
          messageId: userMessageId,
          idx: i + 1,
          type: 'file',
          content: JSON.stringify({ attachmentId: a.id, name: a.name, size: a.size }),
          refId: a.id,
          mime: a.mime,
          blobPath: a.blobPath,
          createdAt: now,
        }),
      );
      if (attachmentRows.length) await this.#db.orm.insert(attachment).values(attachmentRows);
      await this.#db.orm.insert(message).values({
        id: assistantId,
        threadId,
        turnId,
        role: 'assistant',
        authorKind: 'agent',
        provenance: 'typed',
        status: 'streaming',
        modelId: ref,
        provider: resolved.account.provider,
        createdAt: now,
        updatedAt: now,
      });
      parts.push({
        id: textPartId,
        messageId: assistantId,
        idx: 1,
        type: 'text',
        content: '',
        createdAt: now,
      });
      await this.#db.orm.insert(messagePart).values(parts);
      await this.#db.orm
        .update(thread)
        .set({
          state: 'streaming',
          updatedAt: now,
          modelId: ref,
          reasoningLevel,
          title: row.title ?? titleFrom(req.text) ?? prepared[0]?.name ?? null,
        })
        .where(eq(thread.id, threadId));
    });

    const correlation = { threadId, turnId };
    await this.#events.emit({
      name: 'turn.started',
      actor: 'user',
      accountId,
      correlation,
      payload: { threadId, turnId, idx, trigger: 'user', executionLocation: 'hub' },
    });
    await this.#events.emit({
      name: 'chat.message.created',
      actor: 'user',
      accountId,
      correlation,
      payload: { threadId, messageId: userMessageId, turnId, role: 'user', status: 'complete' },
    });
    await this.#events.emit({
      name: 'chat.message.created',
      accountId,
      correlation,
      payload: { threadId, messageId: assistantId, turnId, role: 'assistant', status: 'streaming' },
    });

    const startedAt = Date.now();
    return {
      accountId,
      threadId,
      turnId,
      userMessageId,
      assistantId,
      textPartId,
      reasoningPartId,
      ref,
      modelId: resolved.modelId,
      providerKind: resolved.account.provider,
      provider: resolved.provider,
      vision: resolved.vision,
      reasoningLevel,
      signal,
      startedAt,
      firstTokenAt: null,
      text: '',
      reasoning: '',
      reasoningStored: false,
      usage: null,
      stop: null,
      error: null,
      inputChars: 0,
      lastFlush: startedAt,
      flushTimer: undefined,
      flushChain: Promise.resolve(),
      lastDelta: 0,
      deltaTimer: undefined,
      pending: [],
    };
  }

  // ---- streaming ------------------------------------------------------------------------

  async #run(run: TurnRun): Promise<void> {
    try {
      const messages = await this.#context(run);
      const req: ChatRequest = {
        model: run.modelId,
        messages,
        signal: run.signal,
        metadata: { threadId: run.threadId, turnId: run.turnId },
      };
      if (run.reasoningLevel) req.reasoning = { level: run.reasoningLevel as ReasoningLevel };
      await this.#consume(run, run.provider.stream(req, { requestId: run.turnId }));
    } catch (err) {
      run.stop = 'error';
      run.error = {
        code: isProviderLike(err) ? err.code : 'provider_error',
        message: this.#redactor.redactString(err instanceof Error ? err.message : String(err)),
        retryable: false,
      };
    }
    try {
      await this.#finish(run);
    } catch (err) {
      this.#log.error('failed to finish turn', { err, threadId: run.threadId, turnId: run.turnId });
    }
  }

  async #consume(run: TurnRun, stream: AsyncIterable<StreamEvent>): Promise<void> {
    const it = stream[Symbol.asyncIterator]();
    // Race every read against the abort signal so a provider that ignores it cannot hold a
    // cancelled turn open.
    const aborted = new Promise<'aborted'>((resolve) => {
      if (run.signal.aborted) resolve('aborted');
      run.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    for (;;) {
      const next = it.next();
      next.catch(() => undefined);
      const r = await Promise.race([next, aborted]);
      if (r === 'aborted') {
        it.return?.(undefined)?.catch(() => undefined);
        return;
      }
      if (r.done) return;
      const e = r.value;
      switch (e.type) {
        case 'text_delta':
          if (!e.text) break;
          run.firstTokenAt ??= Date.now();
          run.text += e.text;
          this.#delta(run, 'text_delta', e.text);
          this.#scheduleFlush(run);
          break;
        case 'reasoning_delta':
          if (!e.text) break;
          run.firstTokenAt ??= Date.now();
          run.reasoning += e.text;
          this.#delta(run, 'reasoning_delta', e.text);
          this.#scheduleFlush(run);
          break;
        case 'usage': {
          const u = (run.usage ??= {
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            costUsd: 0,
          });
          u.inputTokens += e.inputTokens ?? 0;
          u.outputTokens += e.outputTokens ?? 0;
          u.cachedTokens += e.cachedTokens ?? 0;
          u.costUsd += e.costUsd ?? 0;
          break;
        }
        case 'stop':
          run.stop = e.reason;
          run.error = e.error ?? null;
          return;
        default:
          // start, citations and tool calls: chat turns carry no tools in M1.
          break;
      }
    }
  }

  #delta(run: TurnRun, type: 'text_delta' | 'reasoning_delta', text: string): void {
    const last = run.pending.at(-1);
    if (last && last.type === type) last.text += text;
    else run.pending.push({ type, text });
    if (run.deltaTimer) return;
    const wait = run.lastDelta + this.#deltaMs - Date.now();
    if (wait <= 0) {
      this.#emitDeltas(run);
      return;
    }
    run.deltaTimer = setTimeout(() => {
      run.deltaTimer = undefined;
      this.#emitDeltas(run);
    }, wait);
  }

  #emitDeltas(run: TurnRun): void {
    run.lastDelta = Date.now();
    for (const d of run.pending.splice(0)) {
      const payload = {
        threadId: run.threadId,
        messageId: run.assistantId,
        type: d.type,
        text: d.text,
      } satisfies ChatDeltaPayload;
      this.#events.emitEphemeral({
        name: 'chat.delta',
        accountId: run.accountId,
        correlation: { threadId: run.threadId, turnId: run.turnId },
        payload,
      });
    }
  }

  #scheduleFlush(run: TurnRun): void {
    if (run.flushTimer) return;
    const wait = Math.max(0, run.lastFlush + this.#flushMs - Date.now());
    run.flushTimer = setTimeout(() => {
      run.flushTimer = undefined;
      run.flushChain = run.flushChain
        .then(() => this.#writeParts(run))
        .catch((err: unknown) =>
          this.#log.warn('partial save failed', { err, turnId: run.turnId }),
        );
    }, wait);
  }

  async #writeParts(run: TurnRun): Promise<void> {
    run.lastFlush = Date.now();
    const text = run.text;
    const reasoning = run.reasoning;
    const now = this.#now().toISOString();
    await this.#db.transaction(async () => {
      await this.#db.orm
        .update(messagePart)
        .set({ content: text })
        .where(eq(messagePart.id, run.textPartId));
      if (reasoning && !run.reasoningStored) {
        await this.#db.orm.insert(messagePart).values({
          id: run.reasoningPartId,
          messageId: run.assistantId,
          idx: 0,
          type: 'reasoning',
          content: reasoning,
          createdAt: now,
        });
        run.reasoningStored = true;
      } else if (reasoning) {
        await this.#db.orm
          .update(messagePart)
          .set({ content: reasoning })
          .where(eq(messagePart.id, run.reasoningPartId));
      }
      await this.#db.orm
        .update(message)
        .set({ updatedAt: now })
        .where(eq(message.id, run.assistantId));
    });
  }

  async #finish(run: TurnRun): Promise<void> {
    clearTimeout(run.flushTimer);
    run.flushTimer = undefined;
    clearTimeout(run.deltaTimer);
    run.deltaTimer = undefined;
    this.#emitDeltas(run);
    await run.flushChain;

    // A stop that arrived before the abort wins: a finished answer is not "cancelled".
    const cancelled = run.stop === 'cancelled' || (run.stop === null && run.signal.aborted);
    let status: MessageStatus;
    let turnStatus: 'completed' | 'interrupted' | 'failed';
    let stopReason: 'end' | 'cancelled' | 'error';
    let error: AgentErrorShape | null = null;
    if (cancelled) {
      [status, turnStatus, stopReason] = ['incomplete', 'interrupted', 'cancelled'];
    } else if (run.stop === 'error' || run.stop === null) {
      [status, turnStatus, stopReason] = ['error', 'failed', 'error'];
      const e = run.error ?? {
        code: 'provider_error',
        message: 'The response ended unexpectedly',
        retryable: true,
      };
      error = { ...e, message: this.#redactor.redactString(e.message) };
    } else {
      // A response cut off by the output limit is kept but marked incomplete (FR-018).
      [status, turnStatus, stopReason] = [
        run.stop === 'length' ? 'incomplete' : 'complete',
        'completed',
        'end',
      ];
    }

    const usage: Usage = run.usage ?? {
      // Providers that report nothing (or a cancel before the usage chunk): estimate ~4 chars/token.
      inputTokens: Math.ceil(run.inputChars / 4),
      outputTokens: Math.ceil((run.text.length + run.reasoning.length) / 4),
      cachedTokens: 0,
      costUsd: 0,
    };
    const price = await this.#registry.pricing(run.accountId, run.providerKind, run.modelId);
    if (price)
      usage.costUsd = (usage.inputTokens * price.costIn + usage.outputTokens * price.costOut) / 1e6;
    const endMs = Date.now();
    const now = this.#now().toISOString();
    const usageJson = JSON.stringify(usage);
    const turnUsage = { ...usage, timeSeconds: (endMs - run.startedAt) / 1000 };

    await this.#db.transaction(async () => {
      await this.#writeParts(run);
      if (error) {
        await this.#db.orm.insert(messagePart).values({
          id: uuidv7(),
          messageId: run.assistantId,
          idx: 2,
          type: 'error',
          content: JSON.stringify(error),
          createdAt: now,
        });
      }
      await this.#db.orm
        .update(message)
        .set({ status, usageJson, costUsd: usage.costUsd, updatedAt: now })
        .where(eq(message.id, run.assistantId));
      await this.#db.orm
        .update(turn)
        .set({
          status: turnStatus,
          stopReason,
          stepCount: 1,
          usageJson: JSON.stringify(turnUsage),
          endedAt: now,
          updatedAt: now,
        })
        .where(eq(turn.id, run.turnId));
      await this.#db.orm.insert(usageEvent).values({
        id: uuidv7(),
        accountId: run.accountId,
        provider: run.providerKind,
        model: run.modelId,
        threadId: run.threadId,
        turnId: run.turnId,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedTokens,
        costUsd: usage.costUsd,
        latencyMs: (run.firstTokenAt ?? endMs) - run.startedAt,
        createdAt: now,
      });
      await this.#db.orm
        .update(thread)
        .set({ state: turnStatus === 'failed' ? 'error' : 'idle', updatedAt: now })
        .where(eq(thread.id, run.threadId));
    });

    const correlation = { threadId: run.threadId, turnId: run.turnId };
    const publicUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    };
    const completed = {
      threadId: run.threadId,
      messageId: run.assistantId,
      status,
      usage: publicUsage,
    } satisfies ChatMessageCompletedPayload;
    await this.#events.emit({
      name: 'chat.message.completed',
      accountId: run.accountId,
      correlation,
      payload: completed,
    });
    const base = {
      threadId: run.threadId,
      turnId: run.turnId,
      stopReason,
      steps: 1,
      usage: turnUsage,
    };
    if (turnStatus === 'interrupted') {
      await this.#events.emit({
        name: 'turn.interrupted',
        accountId: run.accountId,
        correlation,
        payload: base,
      });
    } else {
      await this.#events.emit({
        name: 'turn.completed',
        accountId: run.accountId,
        correlation,
        payload: { ...base, status: turnStatus },
      });
    }
  }

  // ---- context ----------------------------------------------------------------------------

  /** Thread history in order, without error parts and reasoning, plus a short system prompt. */
  async #context(run: TurnRun): Promise<NormalizedMessage[]> {
    const rows = await this.#db.orm
      .select()
      .from(message)
      .where(and(eq(message.threadId, run.threadId), isNull(message.deletedAt)))
      .orderBy(asc(message.createdAt), asc(message.id));
    const history = rows.filter(
      (m) => m.id !== run.assistantId && (m.role === 'user' || m.role === 'assistant'),
    );
    const parts = history.length
      ? await this.#db.orm
          .select()
          .from(messagePart)
          .where(
            inArray(
              messagePart.messageId,
              history.map((m) => m.id),
            ),
          )
          .orderBy(asc(messagePart.idx))
      : [];
    const out: NormalizedMessage[] = [
      { role: 'system', content: [{ type: 'text', text: this.#system }] },
    ];
    for (const m of history) {
      const content: ContentPart[] = [];
      for (const p of parts) {
        if (p.messageId !== m.id) continue;
        if (p.type === 'text' && p.content) content.push({ type: 'text', text: p.content });
        if (p.type === 'file' && m.role === 'user')
          content.push(...this.#attachmentInput(p, run.vision, content.length > 0));
      }
      if (content.length) out.push({ role: m.role as 'user' | 'assistant', content });
    }
    run.inputChars = out.reduce(
      (n, m) => n + m.content.reduce((k, p) => k + (p.type === 'text' ? p.text.length : 0), 0),
      0,
    );
    return out;
  }

  #attachmentInput(
    p: typeof messagePart.$inferSelect,
    vision: boolean,
    afterOther: boolean,
  ): ContentPart[] {
    let name = 'file';
    try {
      const meta = JSON.parse(p.content ?? '{}') as { name?: unknown } | null;
      if (typeof meta?.name === 'string') name = meta.name;
    } catch {
      // keep the generic name
    }
    const sep = afterOther ? '\n\n' : '';
    const kind = attachmentKind(p.mime);
    if (kind === 'pdf')
      return [
        {
          type: 'text',
          text: `${sep}[PDF attached: ${name}. Reading PDF text is not available yet.]`,
        },
      ];
    let bytes: Buffer;
    try {
      bytes = readAttachmentBlob(this.#dataDir, p.blobPath ?? '');
    } catch {
      return [{ type: 'text', text: `${sep}[Attachment unavailable: ${name}]` }];
    }
    if (kind === 'image') {
      return vision
        ? [{ type: 'image', mime: p.mime ?? 'image/png', data: bytes.toString('base64') }]
        : [
            {
              type: 'text',
              text: `${sep}[Image attached: ${name}. The selected model cannot view images.]`,
            },
          ];
    }
    let text = bytes.toString('utf8');
    let note = '';
    if (text.length > MAX_INLINE_CHARS) {
      text = text.slice(0, MAX_INLINE_CHARS);
      note = ` (truncated to the first ${MAX_INLINE_CHARS} characters)`;
    }
    return [
      {
        type: 'text',
        text: `${sep}--- Attachment: ${name} (${p.mime ?? 'text/plain'})${note} ---\n${text}\n--- End of ${name} ---`,
      },
    ];
  }
}

function busy(): NovaError {
  return new NovaError('conflict', 'a response is already being generated in this thread', {
    details: { reason: 'turn_in_progress' },
    action: 'Stop it or wait for it to finish',
  });
}

function isProviderLike(err: unknown): err is { code: AgentErrorShape['code'] } {
  return err instanceof NovaError && typeof err.code === 'string' && PROVIDER_CODES.has(err.code);
}

const PROVIDER_CODES = new Set<string>([
  'auth_missing',
  'auth_expired',
  'rate_limited',
  'over_budget',
  'context_length',
  'content_filter',
  'timeout',
  'network',
  'invalid_request',
  'provider_error',
  'unsupported',
]);

function delay(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
