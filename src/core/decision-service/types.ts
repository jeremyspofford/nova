// The Decision Service's types (ADR docs/plans/decision-service.md; plan docs/plans/ds1.md). The
// question and answer shapes follow TypeSafe's OpenAPI spec (api.typesafe.ai/openapi.json, read
// 2026-10-31): Noul, Choice, Score and Box, each judged on its own against the same state.
import type { PrivacyMode } from '../envelope.ts';
import type { Egress } from '../workers.ts';

// ---- questions ----------------------------------------------------------------------------------

export type Content = string | Record<string, unknown> | unknown[];
// `escapes`: this Noul is the companion of that Choice, asking whether any of its options fits
// (TypeSafe's guidance for Jev 1.14; CONTRACTS §3's escape). Service-side only, never sent.
export interface NoulQ { type: 'noul'; instructions: Content; criteria?: { true?: Content; false?: Content }; escapes?: string }
// Option names are sent to the model and describe content (never "A", "left", "option_1").
export interface ChoiceQ { type: 'choice'; instructions: Content; criteria: Record<string, Content | null> }
// Levels lowest first, each a situation on its own.
export interface ScoreQ { type: 'score'; instructions: Content; criteria: Content[] }
// What to find, and in which image field. No criteria. Always paired with a companion Noul.
export interface BoxQ { type: 'box'; instructions: Content; companion: string }
export type Question = NoulQ | ChoiceQ | ScoreQ | BoxQ;
export type QType = Question['type'];

// ---- answers ------------------------------------------------------------------------------------

export interface NoulA { type: 'noul'; noul: number }
export interface ChoiceA { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface ScoreA { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
export interface BoxA { type: 'box'; box: { top: number; bottom: number; left: number; right: number }; confidence: number | null }
export type Answer = NoulA | ChoiceA | ScoreA | BoxA;

// ---- state --------------------------------------------------------------------------------------

export type FieldSpec =
  | { type: 'text'; max_chars: number; required?: boolean; chunk?: 'worst' }
  | { type: 'number'; required?: boolean }
  | { type: 'boolean'; required?: boolean }
  | { type: 'image'; required?: boolean };
export type FieldValue = string | number | boolean | ImageValue;
export interface ImageValue { image: Uint8Array }

// ---- policy (ADR §1.2) --------------------------------------------------------------------------

export type Tier = 0 | 1 | 2 | 3;
// A Noul's band; a Choice's settled option or "unsettled"; a Score's settled level or "unsettled";
// a Box "located" or "unsettled".
export type Band = string;
export interface Outcome { action: string; tier: Tier; restrictive?: boolean }
export interface Policy {
  // Noul thresholds per question: yes at or above hi, no below lo, unsettled between. Default 0.7 / 0.3.
  bands?: Record<string, { lo: number; hi: number }>;
  // A Choice, Score or Box counts as settled at or above this confidence. Default 0.6.
  settled_at?: number;
  outcomes: Record<string, Outcome>;
  // The truth table: every combination of bands has an outcome. Pure: enumerated in tests.
  table: (bands: Record<string, Band>) => string;
  // What decides when no trusted answer is available (quality low).
  default: string;
  // What a low-quality, non-restrictive outcome does.
  low: 'escalate' | 'stop';
  // The outcomes from least to most restrictive, when a deterministic pre-pass and the model are
  // combined (the stricter wins).
  order?: string[];
}

// ---- templates ----------------------------------------------------------------------------------

// 'capture': capture-derived text (OCR, transcripts), the most sensitive class Nova holds (owner
// decision on capture screening, ADR §2.1): never to a cloud seat in local-first or local-only; in
// cloud mode only with a per-source opt-in, off by default.
// 'private': the person's own conversation and memory: cloud only in cloud mode, never in a local
// mode, and no opt-in sends it there.
export type Feature = 'screening' | 'box' | 'capture' | 'private';
// The features an opt-in can name ('private' never has one).
export type OptInFeature = Exclude<Feature, 'private'>;
// The person's per-feature switches for cloud Jev in local modes (settings.ts). Capture has none:
// its cloud opt-in is per capture source (not built yet).
export type OptIn = 'screening' | 'box';
// What a deterministic pre-pass found (kinds and positions, never the matched text).
export interface Finding { kind: string; start: number; end: number; field: string }
export interface Precheck {
  outcome: string;
  why: string;
  findings: Finding[];
  // True: decided without any model call (a known sensitive app). False: the model still judges,
  // on `fields` (the text with what was found redacted), and the stricter outcome wins.
  final: boolean;
  fields?: Record<string, unknown>;
}
export interface ServiceTemplate {
  template_id: string;
  version: number;
  purpose: string;
  feature: Feature;
  fields: Record<string, FieldSpec>;
  // Shapes the validated fields into the state sent (defaults to the fields as they are).
  state?: (fields: Record<string, FieldValue>) => Record<string, unknown>;
  // For a field declared chunk: 'worst': how a piece is taken out of and put back into its wrapper
  // (the ingest gate's fence).
  split?: (value: string) => { inner: string; wrap: (piece: string) => string };
  questions: Record<string, Question>;
  policy: Policy;
  // The stub seat's deterministic outcome, when the template has one beyond its default.
  rules?: (fields: Record<string, FieldValue>) => string | null;
  // Whether today's sorting model may answer it until a decision seat passes its eval.
  legacy?: boolean;
  // Deterministic checks that run BEFORE any model (patterns, known apps): null when they find
  // nothing.
  precheck?: (fields: Record<string, unknown>) => Precheck | null;
}

// ---- seats --------------------------------------------------------------------------------------

export type SeatId = 'jev' | 'tev1' | 'legacy' | 'stub';
export interface SeatLimits {
  maxQuestions: number | null;
  contextTokens: number | null;
  perQuestionTokens: number | null;
  maxBodyBytes: number | null;
  images: boolean;
  types: readonly QType[];
}
export interface SeatStatus { available: boolean; model: string | null; why: string }
export interface SeatAnswer {
  answers: Record<string, Answer>;
  model_answered: string;
  pieces: number;
  requests: number;
  usage: { input_tokens: number; output_tokens: number };
}
export interface Seat {
  readonly id: SeatId;
  readonly egress: Egress;
  limits(): SeatLimits;
  status(): SeatStatus;
  refresh?(): Promise<SeatStatus>;
  // `beforeSend` (a cloud seat): called before every request; it throws when sending is no longer allowed.
  ask(t: ServiceTemplate, state: BuiltState, o?: { beforeSend?: () => void }): Promise<SeatAnswer>;
}

export interface BuiltState {
  state: Record<string, unknown>;
  // Images by the reference string that stands for them in the state.
  images: Record<string, { format: 'png' | 'jpg'; data: Uint8Array }>;
  // The field that may be split, and how (from the template).
  chunk: { field: string; split?: ServiceTemplate['split'] } | null;
  sha256: string;
  fields: string[];
  // The validated field values (for the sorting-model seat, which takes the old inputs). Never logged.
  values: Record<string, FieldValue>;
}

// ---- results and records ------------------------------------------------------------------------

export type Quality = 'high' | 'medium' | 'low';
export type Trust = 'verdict' | 'legacy' | 'none';
export type Autonomy = 'act' | 'ask' | 'confirm' | 'escalate' | 'stop';

export interface Shadow { seat: SeatId; model: string | null; answers: Record<string, Answer> | null; why: string }

export interface Decided {
  id: string;
  template_id: string;
  version: number;
  outcome: string;
  action: string;
  tier: Tier;
  autonomy: Autonomy;
  quality: Quality;
  trust: Trust;
  seat: SeatId;
  model: string | null;
  // The answers that decided it (null when nothing trusted answered).
  answers: Record<string, Answer> | null;
  bands: Record<string, Band> | null;
  why: string;
  // What the deterministic pre-pass found, if anything (kinds and positions only).
  findings?: Finding[];
}

export interface DecisionRecord extends Decided {
  at: string;
  task_id: string | null;
  subsystem: string;
  model_asked: string | null;
  privacy_mode: PrivacyMode;
  egress: 'none' | 'local' | 'remote:typesafe';
  opt_in: OptInFeature | null;
  state_sha256: string;
  state_fields: string[];
  pieces: number;
  requests: number;
  usage: { input_tokens: number; output_tokens: number };
  shadows: Shadow[];
  failures: { seat: SeatId; why: string }[];
  verdict_ref: string | null;
}
