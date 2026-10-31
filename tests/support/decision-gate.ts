// The ingest gate on the Decision Service, for the gate's own tests: a DecisionService with the
// registry's ingest-screen v1, the sorting model as the legacy seat (any old-style provider the test
// hands in, asked with the old template form exactly as the core does), and optional in-process
// decision seats (a stand-in "tev1" that is local, a stand-in "jev" that is remote) whose answers
// are functions of the chunk. Verdicts are in memory, so a seat is trusted only when the test says
// so. No network: the HTTP stand-ins are for the full-core tests.
import { DecisionService, INGEST_SCREEN_V1, MemoryLog, Registry, memoryVerdicts, DEFAULT_SETTINGS, type DecisionSettings, type VerdictRecord, type RemoteReceipt } from '../../src/core/decision-service/index.ts';
import { LegacySeat } from '../../src/core/decision-service/seats/legacy.ts';
import { QUESTIONS, type ScreenAsk, type ScreenStanding } from '../../src/core/ingest/screen.ts';
import type { DecisionProvider, Templates } from '../../src/core/decide.ts';
import type { PrivacyMode } from '../../src/core/envelope.ts';
import type { Answer, BuiltState, Seat, SeatAnswer, ServiceTemplate } from '../../src/core/decision-service/types.ts';

export type Scores = Partial<Record<(typeof QUESTIONS)[number], number>>;

// A decision seat in process: `score(content)` per chunk, 'fail' to throw, 'down' when unavailable.
export function standInSeat(id: 'tev1' | 'jev', score: (content: string) => Scores | 'fail', o: { model?: string; available?: boolean; answerModel?: string } = {}) {
  const asked: string[] = [];
  const model = o.model ?? (id === 'jev' ? 'jev-1.14.0' : 'tev1:4b@aaaa4b');
  const seat: Seat = {
    id, egress: id === 'jev' ? 'remote' : 'local',
    limits: () => ({ maxQuestions: null, contextTokens: null, perQuestionTokens: null, maxBodyBytes: null, images: false, types: ['noul', 'choice', 'score'] }),
    status: () => (o.available === false ? { available: false, model: null, why: `${id} is unavailable (stand-in).` } : { available: true, model, why: `${id} stand-in.` }),
    async ask(_t: ServiceTemplate, built: BuiltState): Promise<SeatAnswer> {
      const content = String((built.state as { content?: unknown }).content ?? '');
      asked.push(content);
      const s = score(content);
      if (s === 'fail') throw new Error(`${id} stand-in is down`);
      const answers: Record<string, Answer> = Object.fromEntries(QUESTIONS.map((q) => [q, { type: 'noul', noul: s[q] ?? 0.02 }]));
      return { answers, model_answered: o.answerModel ?? model, pieces: 1, requests: 1, usage: { input_tokens: 1, output_tokens: 5 } };
    },
  };
  return { seat, asked, model };
}

export const pass = (seat: 'jev' | 'tev1', model: string): VerdictRecord => ({ template_id: 'ingest-screen', version: 1, seat, model, status: 'pass', why: 'test pass', run_at: '2026-10-31T00:00:00Z', ref: `test#${seat}` });

export function gateService(o: {
  templates: Templates;
  legacy?: DecisionProvider | null;
  tev1?: Seat; jev?: Seat;
  verdicts?: VerdictRecord[];
  privacy?: PrivacyMode;
  settings?: Partial<DecisionSettings>;
  receipt?: (r: RemoteReceipt) => void;
}) {
  const registry = new Registry();
  registry.add(INGEST_SCREEN_V1);
  const log = new MemoryLog();
  let mode: PrivacyMode = o.privacy ?? 'cloud-allowed';
  const settings: DecisionSettings = { ...DEFAULT_SETTINGS, ...(o.jev ? { jev: { base_url: 'https://api.typesafe.ai', model: 'jev-1.14.0' } } : {}), ...(o.settings ?? {}) };
  const service = new DecisionService({
    registry, log, verdicts: memoryVerdicts(o.verdicts ?? []), settings: () => settings, privacy: () => mode,
    seats: { ...(o.tev1 ? { tev1: o.tev1 } : {}), ...(o.jev ? { jev: o.jev } : {}), ...(o.legacy ? { legacy: new LegacySeat({ provider: o.legacy, old: (id) => o.templates.get(id) }) } : {}) },
    ...(o.receipt ? { receipt: o.receipt } : {}),
  });
  const t = INGEST_SCREEN_V1;
  const ask: ScreenAsk = (fields, o) => service.ask('ingest-screen', fields, { subsystem: 'ingest', ...(o ?? {}) });
  // As the core's standing(): an answer would be relied on when a trusted seat may answer now, or
  // the sorting model still may.
  const screening = (): ScreenStanding => {
    const trusted = service.plan(t, mode).candidates.some((c) => c.trusted);
    const legacy = service.legacyAllowed(t).ok;
    return { relied: trusted || legacy, who: trusted ? 'a decision model' : legacy ? 'your local sorting model' : null, lines: [] };
  };
  return { service, log, ask, screening, setMode: (m: PrivacyMode) => { mode = m; } };
}
