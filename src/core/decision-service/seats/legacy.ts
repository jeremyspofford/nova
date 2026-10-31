// The transitional seat: today's sorting model (a local chat model answering templates as JSON,
// `LocalModelProvider` in models/decide.ts) behind the seat interface (ADR §2; owner decision 3).
// It has no eval behind it. It answers a template only while no decision seat (Tev1, Jev) has a
// passing eval verdict for that template version; the service retires it per template after that.
// Until then its answers count as they do today ("legacy" trust), so nothing regresses.
//
// It is asked through the old decision interface with the template's old CONTRACTS §3 form (the
// same situation and inputs it is asked with today), so its behaviour is unchanged by the move.
import { Unavailable } from '../wire.ts';
import type { DecisionProvider, Template } from '../../decide.ts';
import type { Answer, BuiltState, Seat, SeatAnswer, SeatLimits, SeatStatus, ServiceTemplate } from '../types.ts';
import type { Egress } from '../../workers.ts';

export class LegacySeat implements Seat {
  readonly id = 'legacy';
  readonly egress: Egress = 'local';
  #provider: DecisionProvider;
  // The template as the sorting model knows it today (the old store), or null.
  #old: (templateId: string) => Template | null;

  constructor(o: { provider: DecisionProvider; old: (templateId: string) => Template | null }) {
    if (o.provider.egress !== 'local' && o.provider.egress !== 'none') throw new Error('The sorting-model seat must be local.');
    this.#provider = o.provider;
    this.#old = o.old;
  }

  limits(): SeatLimits { return { maxQuestions: null, contextTokens: null, perQuestionTokens: null, maxBodyBytes: null, images: false, types: ['noul', 'choice', 'score'] }; }

  status(): SeatStatus { return { available: true, model: 'sorting-model', why: 'The sorting model assigned in Settings › Models (no eval behind it).' }; }

  // Whether it can answer this template now: the old template exists and the provider is ready.
  readyFor(templateId: string): boolean {
    const t = this.#old(templateId);
    return !!t && (this.#provider.ready?.(t) ?? true);
  }

  async ask(t: ServiceTemplate, built: BuiltState): Promise<SeatAnswer> {
    const old = this.#old(t.template_id);
    if (!old) throw new Unavailable(`The sorting model has no form of ${t.template_id}.`);
    const d = await this.#provider.decide(old, built.values);
    if (d.escalate) throw new Unavailable(`The sorting model didn’t settle ${t.template_id}: ${d.why}`);
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(t.questions)) {
      const a = d.answers[id];
      if (q.type === 'noul' && typeof a === 'number') answers[id] = { type: 'noul', noul: a };
      else if (q.type === 'choice' && typeof a === 'string' && a in q.criteria) answers[id] = { type: 'choice', choice: a, probabilities: { [a]: 1 }, confidence: d.confidence };
      else if (q.type === 'score' && typeof a === 'number') answers[id] = { type: 'score', score: a, probabilities: {}, confidence: d.confidence };
      else throw new Unavailable(`The sorting model didn’t answer ${id} of ${t.template_id}.`);
    }
    return { answers, model_answered: 'sorting-model', pieces: 1, requests: 1, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}
