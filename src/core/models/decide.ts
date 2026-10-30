// The local Decision Model Provider (ADR-7, M6 plan §2): System 1 decisions answered by the local
// model on the sorting role, as typed JSON (Choice, Score, Noul) that Nova checks against the
// template's own schema. The model is asked for exactly that shape (Ollama's structured output),
// and anything that doesn't fit is not repaired or guessed: the decision escalates. It is always
// local: it asks the inference API as local-only, so it can never reach the cloud.
import { createHash } from 'node:crypto';
import { QUESTION_TYPES, UNKNOWN, checkInputs, type Answer, type Decision, type DecisionProvider, type Question, type Template } from '../decide.ts';
import type { Egress } from '../workers.ts';
import type { InferRequest, InferResult } from './index.ts';

export const PROVIDER_ID = 'local-model';
export type Guard = (t: Template, inputs: Record<string, unknown>, answers: Record<string, Answer>) => string | null;

// The JSON schema a template's answer must follow.
export function answerSchema(t: Template): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const q of t.questions) answers[q.id] = questionSchema(q);
  return {
    type: 'object',
    properties: {
      answers: { type: 'object', properties: answers, required: t.questions.map((q) => q.id), additionalProperties: false },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      why: { type: 'string' },
    },
    required: ['answers', 'confidence', 'why'],
    additionalProperties: false,
  };
}

function questionSchema(q: Question): Record<string, unknown> {
  if (q.type === 'choice') return { type: 'string', enum: q.options };
  if (q.type === 'score') return { type: 'number', minimum: q.min, maximum: q.max };
  return { type: 'number', minimum: 0, maximum: 1 };
}

// What the model said, checked strictly. Every problem is listed; one is enough to escalate.
export function checkAnswer(t: Template, text: string): { ok: true; answers: Record<string, Answer>; confidence: number; why: string } | { ok: false; problems: string[] } {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, problems: ['the reply isn’t JSON'] }; }
  const problems: string[] = [];
  const obj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
  if (!obj(v)) return { ok: false, problems: ['the reply isn’t an object'] };
  const a = v.answers;
  if (!obj(a)) problems.push('answers is missing');
  const answers: Record<string, Answer> = {};
  for (const q of t.questions) {
    const x = obj(a) ? a[q.id] : undefined;
    if (q.type === 'choice') {
      if (typeof x !== 'string' || !q.options.includes(x)) problems.push(`${q.id} must be one of ${q.options.join(', ')}`);
      else answers[q.id] = x;
    } else if (q.type === 'score') {
      if (typeof x !== 'number' || !Number.isFinite(x) || x < q.min || x > q.max) problems.push(`${q.id} must be a number from ${q.min} to ${q.max}`);
      else answers[q.id] = x;
    } else if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) problems.push(`${q.id} must be a probability from 0 to 1`);
    else answers[q.id] = x;
  }
  if (obj(a)) for (const k of Object.keys(a)) if (!t.questions.some((q) => q.id === k)) problems.push(`${k} isn’t a question of ${t.template_id}`);
  const c = v.confidence;
  if (typeof c !== 'number' || !Number.isFinite(c) || c < 0 || c > 1) problems.push('confidence must be a number from 0 to 1');
  if (problems.length) return { ok: false, problems };
  return { ok: true, answers, confidence: c as number, why: typeof v.why === 'string' ? v.why.slice(0, 300) : '' };
}

export class LocalModelProvider implements DecisionProvider {
  readonly id = PROVIDER_ID;
  readonly egress: Egress = 'local';
  readonly questionTypes = QUESTION_TYPES;
  #infer: (r: InferRequest) => Promise<InferResult>;
  #ready: () => boolean;
  #guard: Guard | undefined;

  // `guard`: the person's hard policy for a template (System 1.5), which a model's answer may not
  // contradict; it returns why, and the decision escalates instead.
  constructor(o: { infer: (r: InferRequest) => Promise<InferResult>; ready: () => boolean; guard?: Guard }) {
    this.#infer = o.infer;
    this.#ready = o.ready;
    this.#guard = o.guard;
  }

  // Only once a sorting model is assigned (and the person hasn't kept decisions on the rules).
  ready(): boolean { return this.#ready(); }

  async decide(t: Template, inputs: Record<string, unknown>): Promise<Decision> {
    const checked = checkInputs(t, inputs);
    const system = [
      'You answer one recurring decision for a personal assistant, as JSON only.',
      `The situation: ${t.situation}`,
      'Answer every question. For a choice, pick exactly one listed option; pick "unknown" when none fits. A score is a number in its range. A yes/no question is the probability (0 to 1) that the answer is yes; 0.5 means you can’t tell.',
      'confidence is how sure you are of the whole answer, from 0 to 1. why is one short sentence.',
    ].join('\n');
    const questions = t.questions.map((q) => q.type === 'choice' ? `- ${q.id}: choose one of ${q.options.join(', ')}` : q.type === 'score' ? `- ${q.id}: a number from ${q.min} to ${q.max}` : `- ${q.id}: probability of yes, 0 to 1`).join('\n');
    const user = `Inputs: ${JSON.stringify(checked)}\nQuestions:\n${questions}`;
    const r = await this.#infer({
      role: 'triage-text', privacy_mode: 'local-only', format: answerSchema(t), purpose: `decision: ${t.template_id}@${t.version}`,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      context_items: [
        { kind: 'file', ref: `template:${t.template_id}@${t.version}`, sha256: createHash('sha256').update(JSON.stringify(t.questions)).digest('hex') },
        { kind: 'file', ref: 'decision inputs', sha256: createHash('sha256').update(JSON.stringify(checked)).digest('hex') },
      ],
    });
    const named = `${r.model} on ${r.device === 'hub' ? 'the hub' : r.device}`;
    const got = checkAnswer(t, r.text ?? '');
    if (!got.ok) {
      // Out of schema: nothing of it is used, every choice reads unknown, and the decision escalates.
      const answers = Object.fromEntries(t.questions.filter((q) => q.type === 'choice').map((q) => [q.id, UNKNOWN]));
      return { template_id: t.template_id, version: t.version, answers, confidence: 0, provider: this.id, escalate: true, why: `The local model (${named}) answered outside the template: ${got.problems.join('; ')}.` };
    }
    const against = this.#guard?.(t, checked, got.answers) ?? null;
    if (against) return { template_id: t.template_id, version: t.version, answers: got.answers, confidence: 0, provider: this.id, escalate: true, why: `The local model (${named}) answered against your settings: ${against}` };
    return { template_id: t.template_id, version: t.version, answers: got.answers, confidence: got.confidence, provider: this.id, escalate: false, why: got.why ? `${got.why} (${named})` : `Answered by ${named}.` };
  }
}
