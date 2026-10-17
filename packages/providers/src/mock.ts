// Deterministic mock provider (docs/16 §4): replays scripted transcripts with timing control,
// tool calls and error injection. It is the default provider for tests and E2E journeys.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { uuidv7, type ProviderErrorCode } from '@nova/shared';
import type {
  CallContext,
  ChatRequest,
  ModelInfo,
  Provider,
  ProviderCapabilities,
  StreamEvent,
} from './types.ts';

export type MockStep = StreamEvent | { delayMs: number } | { textChunks: string[] };

export interface MockScript {
  /** Match on the last user message text; a string matches as a substring. Omit to match all. */
  when?: string | RegExp;
  steps: MockStep[];
  /** Use once, then fall through to later scripts. */
  once?: boolean;
}

export type MockTiming = 'instant' | 'streamed' | 'slow' | { chunkDelayMs: number };

export interface MockProviderOptions {
  id?: string;
  scripts?: MockScript[];
  timing?: MockTiming;
  /** Every request fails with this error after `start`. */
  failWith?: { code: ProviderErrorCode; message?: string; retryable?: boolean };
  models?: ModelInfo[];
  capabilities?: Partial<ProviderCapabilities>;
}

const DEFAULT_CAPS: ProviderCapabilities = {
  streaming: true,
  tools: true,
  parallelToolCalls: false,
  vision: false,
  audioIn: false,
  audioOut: false,
  realtime: false,
  reasoning: 'levels',
  promptCache: 'none',
  structuredOutput: true,
  imageGeneration: false,
  maxContextTokens: 32_000,
  maxOutputTokens: 4_000,
};

const DELAY: Record<'instant' | 'streamed' | 'slow', number> = {
  instant: 0,
  streamed: 15,
  slow: 120,
};

export class MockProvider implements Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  readonly #scripts: MockScript[];
  readonly #used = new Set<MockScript>();
  readonly #opts: MockProviderOptions;
  /** Requests seen, for assertions in tests. */
  readonly requests: ChatRequest[] = [];

  constructor(opts: MockProviderOptions = {}) {
    this.id = opts.id ?? 'mock';
    this.capabilities = { ...DEFAULT_CAPS, ...opts.capabilities };
    this.#scripts = opts.scripts ?? [];
    this.#opts = opts;
  }

  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve(
      this.#opts.models ?? [
        { id: 'mock-fast', label: 'Mock fast', capabilities: { reasoning: false } },
        { id: 'mock-smart', label: 'Mock smart', capabilities: { reasoning: 'levels' } },
      ],
    );
  }

  countTokens(req: ChatRequest): Promise<number> {
    return Promise.resolve(estimateTokens(req));
  }

  async *stream(req: ChatRequest, _ctx: CallContext): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    const delay = chunkDelay(this.#opts.timing ?? 'instant');
    yield { type: 'start', messageId: uuidv7(), model: req.model };
    if (this.#opts.failWith) {
      const f = this.#opts.failWith;
      yield {
        type: 'stop',
        reason: 'error',
        error: {
          code: f.code,
          message: f.message ?? f.code,
          retryable: f.retryable ?? f.code === 'rate_limited',
        },
      };
      return;
    }
    const steps = this.#select(req) ?? defaultSteps(req);
    let output = '';
    let stopped = false;
    for (const step of steps) {
      if (req.signal.aborted) break;
      if ('delayMs' in step) {
        if (!(await sleep(step.delayMs, req.signal))) break;
        continue;
      }
      if ('textChunks' in step) {
        for (const chunk of step.textChunks) {
          if (delay > 0 && !(await sleep(delay, req.signal))) break;
          if (req.signal.aborted) break;
          output += chunk;
          yield { type: 'text_delta', text: chunk };
        }
        continue;
      }
      if (step.type === 'text_delta') output += step.text;
      if (step.type === 'stop') stopped = true;
      yield step;
      if (stopped) return;
    }
    if (req.signal.aborted) {
      yield { type: 'stop', reason: 'cancelled' };
      return;
    }
    yield {
      type: 'usage',
      inputTokens: estimateTokens(req),
      outputTokens: Math.ceil(output.length / 4),
      costUsd: 0,
    };
    yield { type: 'stop', reason: 'end' };
  }

  #select(req: ChatRequest): MockStep[] | null {
    const text = lastUserText(req);
    for (const s of this.#scripts) {
      if (s.once && this.#used.has(s)) continue;
      const hit =
        s.when === undefined ||
        (typeof s.when === 'string' ? text.includes(s.when) : s.when.test(text));
      if (hit) {
        this.#used.add(s);
        return s.steps;
      }
    }
    return null;
  }
}

function defaultSteps(req: ChatRequest): MockStep[] {
  const text = lastUserText(req).trim();
  const reply = text ? `You said: ${text}` : 'Hello from the mock provider.';
  return [{ textChunks: splitWords(reply) }];
}

export function splitWords(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [text];
}

function lastUserText(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== 'user') continue;
    return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
  }
  return '';
}

function estimateTokens(req: ChatRequest): number {
  let chars = 0;
  for (const m of req.messages)
    for (const p of m.content) if (p.type === 'text') chars += p.text.length;
  return Math.ceil(chars / 4);
}

function chunkDelay(t: MockTiming): number {
  return typeof t === 'string' ? DELAY[t] : t.chunkDelayMs;
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (ms <= 0) return Promise.resolve(!signal.aborted);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Load a fixture transcript from `fixtures/<name>.json` (an array of MockScript-like objects). */
export function loadFixture(name: string): MockScript[] {
  const path = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    when?: string;
    steps: MockStep[];
    once?: boolean;
  }[];
  return raw.map((s) => ({ ...s }));
}
