// The stub seat (ADR §2): no provider, deterministic only. It never calls a model: the decision is
// the template's own rule (System 1.5) when it has one, otherwise the template's declared default.
// The service reads `rules` itself; this seat exists so the stub is named, logged and always
// available like any other seat.
import type { Seat, SeatAnswer, SeatLimits, SeatStatus } from '../types.ts';
import type { Egress } from '../../workers.ts';

export class StubSeat implements Seat {
  readonly id = 'stub';
  readonly egress: Egress = 'none';
  limits(): SeatLimits { return { maxQuestions: null, contextTokens: null, perQuestionTokens: null, maxBodyBytes: null, images: false, types: [] }; }
  status(): SeatStatus { return { available: true, model: 'rules', why: 'Nova’s own rules, with no model.' }; }
  async ask(): Promise<SeatAnswer> { throw new Error('The stub seat answers no questions; its decision is the template’s rule or default.'); }
}
