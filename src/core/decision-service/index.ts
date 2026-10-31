// The Decision Service's public surface (ADR §7). This is the only module of the service that
// anything outside src/core/decision-service/ may import. It exports the service, the registry,
// the built-in templates, settings, the log sinks and the types. It does NOT export a seat or the
// wire client: the factory below builds the seats itself, so no caller (not even the core's own
// wiring) can reach a provider except by asking for a template. The boundary test checks it.
import { DecisionService, type RemoteReceipt } from './service.ts';
import { Registry, type Registered } from './registry.ts';
import { INGEST_SCREEN_V1 } from './templates/ingest-screen.ts';
import { INGEST_SCREEN_V2 } from './templates/ingest-screen-v2.ts';
import { JevSeat } from './seats/jev.ts';
import { Tev1Seat, type Tev1Detail } from './seats/tev1.ts';
import { LegacySeat } from './seats/legacy.ts';
import { fileVerdicts, type VerdictStore } from './verdicts.ts';
import { DEFAULT_SETTINGS, notices, recommend, scorecard, validateSettings, OPT_IN_WORDS, type DecisionSettings, type Notice, type Recommendation } from './settings.ts';
import type { DecisionLog } from './log.ts';
import type { DecisionProvider, Template } from '../decide.ts';
import type { Hardware } from '../models/hardware.ts';
import type { PrivacyMode } from '../envelope.ts';
import type { SeatStatus, ServiceTemplate } from './types.ts';

export { DecisionService, Registry, INGEST_SCREEN_V1, INGEST_SCREEN_V2, DEFAULT_SETTINGS, OPT_IN_WORDS, notices, recommend, validateSettings };
export { MemoryLog, FileLog, DbLog, type DecisionLog, type RecordDb } from './log.ts';
export { validate } from './registry.ts';
export { memoryVerdicts, type VerdictStore, type VerdictRecord } from './verdicts.ts';
export type { AskOptions, RemoteReceipt } from './service.ts';
export type { DecisionSettings, Notice, Recommendation, Registered };
export type { Decided, DecisionRecord, ServiceTemplate, Feature, Question, Answer, FieldSpec, Policy, Outcome, Autonomy, Quality, Trust, SeatId } from './types.ts';

// The templates that ship with Nova.
export const BUILT_INS: readonly ServiceTemplate[] = Object.freeze([INGEST_SCREEN_V1, INGEST_SCREEN_V2]);

export interface ServiceSetup {
  settings: () => DecisionSettings;
  privacy: () => PrivacyMode;
  log: DecisionLog;
  // The hub's Ollama (the model manager's hubUrl()) and hardware (hubHardware()).
  ollamaUrl: () => string;
  hardware?: () => Hardware | null | Promise<Hardware | null>;
  // The cloud Jev key, read from the vault at call time.
  jevKey: () => string | null;
  // Today's sorting model, and the template as it knows it (the old store), until it is retired.
  legacy?: { provider: DecisionProvider; old: (templateId: string) => Template | null };
  receipt?: (r: RemoteReceipt) => void;
  verdicts?: VerdictStore;
  templates?: readonly ServiceTemplate[];
  now?: () => Date;
}

// How one template stands now, without asking anything (Health; DS1 NOTE 4): whether an answer
// would be relied on and by whom, and one plain line per seat.
export interface Standing { relied: boolean; who: string | null; lines: string[] }

export interface SeatsView {
  tev1: Tev1Detail;
  jev: SeatStatus;
  legacy: { wired: boolean; retired_for: string[] };
  notices: Notice[];
  recommendation: Recommendation;
  scorecards: { seat: 'jev' | 'tev1'; model: string; templates: ReturnType<typeof scorecard> }[];
}

// The service, with its seats built here and nowhere else.
export function createDecisionService(o: ServiceSetup): { service: DecisionService; refresh: () => Promise<void>; view: () => Promise<SeatsView>; standing: (templateId: string) => Standing; tev1: () => Tev1Detail; noticesFor: (s: DecisionSettings) => Promise<Notice[]> } {
  const registry = new Registry();
  for (const t of o.templates ?? BUILT_INS) registry.add(t);
  const verdicts = o.verdicts ?? fileVerdicts();
  const tev1 = new Tev1Seat({
    url: o.ollamaUrl,
    ...(o.hardware ? { hardware: o.hardware } : {}),
    model: () => o.settings().tev1?.model ?? null,
    ...(o.now ? { now: o.now } : {}),
  });
  const jev = new JevSeat({ config: () => { const s = o.settings().jev; return s ? { base_url: s.base_url, model: s.model, key: o.jevKey } : null; } });
  const legacy = o.legacy ? new LegacySeat(o.legacy) : undefined;
  const service = new DecisionService({
    registry, verdicts, settings: o.settings, privacy: o.privacy, log: o.log,
    seats: { tev1, jev, ...(legacy ? { legacy } : {}) },
    ...(o.receipt ? { receipt: o.receipt } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  const refresh = async () => { await tev1.refresh(); };
  const view = async (): Promise<SeatsView> => {
    const s = o.settings();
    const hw = (await o.hardware?.()) ?? null;
    const d = tev1.detail();
    const templates = registry.list().map((r) => r.template);
    const cards: SeatsView['scorecards'] = [];
    if (d.model && d.digest) cards.push({ seat: 'tev1', model: `${d.model}@${d.digest}`, templates: scorecard(verdicts, templates, 'tev1', `${d.model}@${d.digest}`) });
    if (s.jev) cards.push({ seat: 'jev', model: s.jev.model, templates: scorecard(verdicts, templates, 'jev', s.jev.model) });
    return {
      tev1: d,
      jev: jev.status(),
      legacy: { wired: !!legacy, retired_for: templates.filter((t) => t.legacy && verdicts.passed(t.template_id, t.version)).map((t) => `${t.template_id} v${t.version}`) },
      notices: notices(s, { hardware: hw, verdicts, templates, tev1Digest: d.digest }),
      recommendation: recommend(hw),
      scorecards: cards,
    };
  };
  const standing = (templateId: string): Standing => {
    // The version that would answer now (DS2's choice: passed, else the sorting model's, else newest).
    const reg = service.version(templateId);
    if (!reg) return { relied: false, who: null, lines: [] };
    const t = reg.template;
    const { candidates } = service.plan(t, o.privacy());
    const trusted = candidates.find((c) => c.trusted) ?? null;
    const lg = service.legacyAllowed(t);
    const d = tev1.detail();
    const j = jev.status();
    const retired = t.legacy && verdicts.passed(t.template_id, t.version);
    const who = trusted ? `${trusted.seat.id === 'jev' ? 'Jev' : 'Tev1'} (${trusted.model})` : lg.ok ? 'your local sorting model' : null;
    const lines = [
      `Tev1: ${d.available && d.model ? `${d.model} is in use. ${d.size_why}` : d.why}`,
      `Jev: ${j.why}`,
      `Sorting model: ${!t.legacy ? 'never used for this.' : retired ? `retired for ${t.template_id} v${t.version}, since a decision model passed its eval.` : lg.ok ? 'still used, until a decision model passes this screen’s eval.' : lg.why}`,
      who
        ? `Screening answers are relied on: ${who}${trusted ? ' passed this screen’s eval.' : ' answers until a decision model passes its eval.'}`
        : 'Screening answers aren’t relied on yet: no model that answers here has passed this screen’s eval, so outside content Nova can’t vouch for is held back as unsure.',
    ];
    return { relied: !!who, who, lines };
  };
  // The notices a set of choices would carry, before they are saved (shown before the person
  // confirms; owner decision 2).
  const noticesFor = async (s: DecisionSettings): Promise<Notice[]> => {
    const hw = (await Promise.resolve(o.hardware?.()).catch(() => null)) ?? null;
    return notices(s, { hardware: hw, verdicts, templates: registry.list().map((r) => r.template), tev1Digest: tev1.detail().digest });
  };
  return { service, refresh, view, standing, tev1: () => tev1.detail(), noticesFor };
}
