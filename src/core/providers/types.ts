// What a provider is (M5 plan §1): an extension of kind agent-adapter or automation-adapter whose
// manifest (CONTRACTS §4) carries an `adapter` block, run by one of Nova's built-in adapter
// implementations. Nova runs no code an extension ships; a provider extension picks an
// implementation and gives it settings.
import type { Brief, Evidence } from '../envelope.ts';
import type { Effects } from '../workers.ts';

export const CLASSES = ['coding-agent', 'chat', 'automation'] as const;
export type ProviderClass = (typeof CLASSES)[number];
export const TRANSPORTS = ['cli', 'http'] as const;
export type Transport = (typeof TRANSPORTS)[number];
export const IMPLEMENTATIONS = ['claude-code', 'codex', 'openai-compatible', 'custom-cli', 'n8n'] as const;
export type Implementation = (typeof IMPLEMENTATIONS)[number];
export const EGRESS = /^(none|local|remote:[a-z0-9][a-z0-9._-]{0,63})$/;

export interface AdapterBlock {
  implementation: Implementation;
  class: ProviderClass;
  transport: Transport;
  // Where its data goes: none (this process), local (this machine or the mesh), remote:<host>.
  // For an HTTP provider this is what its default address gives; the address set decides.
  egress: string;
  capabilities: string[];
  config: Record<string, unknown>;
  secrets: string[];
}

export type Config = Record<string, unknown>;

// Health in plain words (M5 plan §1): installed / not installed / not configured / unreachable.
export const HEALTH_STATES = ['ready', 'not_installed', 'not_configured', 'unreachable', 'unchecked'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];
export interface Health { state: HealthState; words: string; checked_at: string | null }

// Where a provider's calls go, three ways: for the ledger's privacy gate, for the receipt, and
// for a person.
export interface Where { coarse: 'none' | 'local' | 'remote'; receipt: string; words: string }

export interface Usage { model?: string; tokens_in?: number; tokens_out?: number; cost_usd?: number }

export interface WorkInput {
  provider: string;
  brief: Brief;
  // Which attempt at the task this is (the ledger counts them from 1).
  attempt?: number;
  config: Config;
  // The task's own folder, or null for a provider that works elsewhere (automation).
  cwd: string | null;
  // What the provider is told: an instruction (system) and the brief itself (prompt).
  system: string;
  prompt: string;
  signal: AbortSignal;
  secret: (value: unknown) => string | null;
  // Where this provider keeps its own state for the task (n8n callbacks).
  stateDir: string;
  log: (line: string) => void;
}

export interface WorkOutcome {
  status: 'done' | 'failed' | 'blocked';
  summary: string;
  usage: Usage;
  // A chat provider's text, read against the JSON files contract.
  reply?: string;
  evidence?: Evidence[];
  blockers?: string[];
}

// `receipt` and `privacy` come from a caller whose handle records its own receipts (ownReceipt): the
// receipt it would have written, which the model manager completes with where the call really went.
export interface ChatRequest {
  system: string; prompt: string; signal?: AbortSignal; onText?: (t: string) => void;
  receipt?: { session_id?: string; task_id?: string; purpose?: string; context_items?: { kind: 'memory' | 'file' | 'skill' | 'session' | 'standing'; ref: string; sha256: string }[] };
  privacy?: 'local-only' | 'local-preferred' | 'cloud-allowed';
}

export interface Impl {
  readonly id: Implementation;
  // Problems with a configuration, in plain words; none means it can be saved.
  check(c: Config): string[];
  // Why it can't run yet with this configuration, or null.
  unconfigured(c: Config, secret: (v: unknown) => string | null): string | null;
  // For a command-line provider: why it isn't installed, or null. Never runs the command.
  uninstalled?(c: Config): string | null;
  // For an HTTP provider: whether its address answers. Resolves to a reason, or null.
  probe?(c: Config, secret: (v: unknown) => string | null, signal: AbortSignal): Promise<string | null>;
  // The address an HTTP provider talks to, for working out its egress.
  url?(c: Config): string | null;
  model(c: Config): string;
  // What a brief may change outside Nova (workers.ts, Effects); none when not said.
  effects?(c: Config): Effects;
  work(i: WorkInput): Promise<WorkOutcome>;
  chat?(c: Config, secret: (v: unknown) => string | null, req: ChatRequest): Promise<{ text: string; aborted: boolean; usage: Usage }>;
}

// A secret is referenced by name, never written into a setting.
export const SECRET_REF = /^secret:\/\/([A-Z][A-Z0-9_]*)$/;
export const secretName = (v: unknown): string | null => (typeof v === 'string' ? SECRET_REF.exec(v)?.[1] ?? null : null);

export const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
// Ollama serves its cloud models (names ending -cloud or :cloud) through the same local address,
// passing what it is given on to ollama.com: by where the data goes, that is the cloud. The
// registry and the model manager both use this one rule.
export const OLLAMA_CLOUD = /[:-]cloud$/i;
export const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);

// Every call a provider or connector makes refuses a redirect: "local" is decided by the address
// Nova checked, and following a redirect would carry the brief, a key or a token somewhere else.
export const NO_REDIRECT = { redirect: 'error' } as const;

// Why a call didn't get through, in words; a refused redirect is said as one.
export function reachProblem(e: unknown): string {
  const m = ((e as Error)?.cause as Error)?.message ?? (e as Error)?.message ?? String(e);
  return /redirect/i.test(m) ? 'it answered with a redirect, which Nova doesn’t follow: what Nova sends goes only to the address it checked' : m;
}
