// The Decision Service (ADR docs/plans/decision-service.md; plan docs/plans/ds1.md): the one way
// Nova asks a System One question. A subsystem asks by template id with the template's declared
// fields; the service builds the state, routes it by privacy mode and the person's opt-ins, asks,
// applies the template's policy, and logs one record. Seats are never reached any other way.
//
// Routing (ADR §2 with the owner's decisions 1, 3 and 4):
//   text  cloud:        jev → tev1 → sorting model (until retired) → stub
//         local modes:  tev1 → jev (only with the "screening" opt-in) → sorting model → stub
//   image cloud / local-preferred: jev (only with the "box" opt-in) → stub
//         local-only:   a local seat that reads images (none today) → stub; never a cloud seat
// A decision seat decides only with a passing eval verdict for the exact template version and
// model; otherwise it answers as a shadow (evidence in the record, not used). The sorting model
// decides as it does today ("legacy") until any decision seat passes the template's eval.
import { randomUUID } from 'node:crypto';
import { stricter } from '../workers.ts';
import { autonomy, bands as bandsOf, qualityOf } from './policy.ts';
import { buildState } from './state.ts';
import type { PrivacyMode } from '../envelope.ts';
import type { Registered, Registry } from './registry.ts';
import type { LegacySeat } from './seats/legacy.ts';
import type { DecisionSettings } from './settings.ts';
import type { DecisionLog } from './log.ts';
import type { VerdictStore } from './verdicts.ts';
import type { Answer, Band, BuiltState, Decided, DecisionRecord, Feature, Precheck, Quality, Seat, SeatAnswer, SeatId, ServiceTemplate, Shadow, Trust } from './types.ts';

export interface RemoteReceipt { task_id: string | null; provider: 'jev'; model: string; purpose: string; privacy_mode: PrivacyMode; egress: 'remote:typesafe'; opt_in: Feature | null; state_sha256: string }

export interface ServiceOptions {
  registry: Registry;
  seats: { jev?: Seat; tev1?: Seat; legacy?: LegacySeat };
  verdicts: VerdictStore;
  settings: () => DecisionSettings;
  privacy: () => PrivacyMode;
  log: DecisionLog;
  // Called BEFORE a state goes to a cloud seat, once per decision (CONTRACTS §2). It may refuse by
  // throwing (Receipts refuses a remote call under local-only unless the opt-in is named); then
  // nothing is sent and the refusal is recorded.
  receipt?: (r: RemoteReceipt) => void;
  // Whether a capture source's text may go to the cloud seat in cloud mode (the per-source opt-in,
  // off by default; not built yet, so absent means never).
  captureCloud?: (source: string) => boolean;
  now?: () => Date;
}

export interface AskOptions {
  subsystem: string;
  task_id?: string | null;
  privacy_mode?: PrivacyMode;
  version?: number;
  // The capture source an item came from, for the per-source cloud opt-in ("capture" templates).
  capture_source?: string;
}

interface Candidate { seat: Seat; model: string | null; trusted: boolean; why: string; ref: string | null }

const tag = (model: string | null) => (model ?? '').split('@')[0]!;

export class DecisionService {
  #o: ServiceOptions;
  #now: () => Date;

  constructor(o: ServiceOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
  }

  get registry(): Registry { return this.#o.registry; }

  // Whether cloud Jev may receive this template's state now.
  cloudAllowed(t: ServiceTemplate, mode: PrivacyMode, s: DecisionSettings = this.#o.settings(), source?: string): { ok: boolean; opt_in: Feature | null; why: string } {
    if (t.feature === 'capture') {
      if (mode !== 'cloud-allowed') return { ok: false, opt_in: null, why: 'Capture text never goes to a cloud provider in local-first or local-only.' };
      if (!source || !this.#o.captureCloud?.(source)) return { ok: false, opt_in: null, why: 'Capture text goes to a cloud provider only with that capture source’s own opt-in, which is off.' };
      return { ok: true, opt_in: 'capture', why: `Capture source ${source} is opted in.` };
    }
    if (t.feature === 'box') {
      if (!s.opt_in.box) return { ok: false, opt_in: null, why: 'Images go to Jev only with the Box opt-in on.' };
      if (mode === 'local-only') return { ok: false, opt_in: null, why: 'In local-only, images never go to a cloud provider.' };
      return { ok: true, opt_in: 'box', why: 'The Box opt-in is on.' };
    }
    if (mode === 'cloud-allowed') return { ok: true, opt_in: null, why: 'Cloud mode.' };
    if (s.opt_in[t.feature as 'screening']) return { ok: true, opt_in: t.feature, why: `The ${t.feature} opt-in is on in ${mode}.` };
    return { ok: false, opt_in: null, why: `${mode} keeps ${t.feature} on this device unless its opt-in is on.` };
  }

  // The decision seats this template may use now, in order: trusted first, then the mode's order.
  // Every seat left out is listed with why.
  plan(t: ServiceTemplate, mode: PrivacyMode, source?: string): { candidates: Candidate[]; skipped: { seat: SeatId; why: string }[] } {
    const s = this.#o.settings();
    const skipped: { seat: SeatId; why: string }[] = [];
    const cloud = this.cloudAllowed(t, mode, s, source);
    const order: ('jev' | 'tev1')[] = mode === 'cloud-allowed' ? ['jev', 'tev1'] : ['tev1', 'jev'];
    const candidates: Candidate[] = [];
    for (const id of order) {
      const seat = this.#o.seats[id];
      if (!seat) { skipped.push({ seat: id, why: `There is no ${id} seat.` }); continue; }
      if (id === 'jev' && !s.jev) { skipped.push({ seat: id, why: 'Jev isn’t set up.' }); continue; }
      if (id === 'tev1' && !s.tev1) { skipped.push({ seat: id, why: 'Tev1 is switched off.' }); continue; }
      if (seat.egress === 'remote' && !cloud.ok) { skipped.push({ seat: id, why: cloud.why }); continue; }
      const lim = seat.limits();
      if (t.feature === 'box' && !lim.images) { skipped.push({ seat: id, why: `${id} reads no images.` }); continue; }
      const missing = Object.values(t.questions).filter((q) => !lim.types.includes(q.type)).map((q) => q.type);
      if (missing.length) { skipped.push({ seat: id, why: `${id} can’t answer ${[...new Set(missing)].join(', ')} questions.` }); continue; }
      if (lim.maxQuestions !== null && Object.keys(t.questions).length > lim.maxQuestions) { skipped.push({ seat: id, why: `${id} takes at most ${lim.maxQuestions} questions per request.` }); continue; }
      const st = seat.status();
      if (!st.available) { skipped.push({ seat: id, why: st.why }); continue; }
      const v = this.#o.verdicts.lookup(t.template_id, t.version, id, st.model);
      candidates.push({ seat, model: st.model, trusted: v.trusted, why: v.why, ref: v.ref });
    }
    return { candidates: [...candidates.filter((c) => c.trusted), ...candidates.filter((c) => !c.trusted)], skipped };
  }

  // Whether the sorting model may still answer this template version (owner decision 3).
  legacyAllowed(t: ServiceTemplate): { ok: boolean; why: string } {
    if (!t.legacy) return { ok: false, why: `${t.template_id} never used the sorting model.` };
    if (t.feature === 'box') return { ok: false, why: 'The sorting model reads no images.' };
    if (this.#o.verdicts.passed(t.template_id, t.version)) return { ok: false, why: `The sorting model is retired for ${t.template_id} v${t.version}: a decision model passed its eval.` };
    const l = this.#o.seats.legacy;
    if (!l) return { ok: false, why: 'No sorting model is wired.' };
    if (!l.readyFor(t.template_id)) return { ok: false, why: 'No sorting model is assigned.' };
    return { ok: true, why: 'The sorting model answers until a decision model passes this template’s eval.' };
  }

  // Which version answers (DS2): the newest version with a passing eval on a decision seat; else
  // the newest one today's sorting model can still answer (so a new, untrusted version never takes
  // away today's behaviour); else the newest. A caller may name a version.
  version(templateId: string, version?: number): Registered | null {
    if (version !== undefined) return this.#o.registry.get(templateId, version);
    const all = this.#o.registry.versions(templateId);
    if (!all.length) return null;
    return all.find((r) => this.#o.verdicts.passed(templateId, r.template.version))
      ?? all.find((r) => this.legacyAllowed(r.template).ok)
      ?? all[0]!;
  }

  // Decided by the template's deterministic checks alone (a known sensitive app): no model is asked,
  // nothing leaves the device, and the record says so.
  #deterministic(t: ServiceTemplate, built: BuiltState, pre: Precheck, mode: PrivacyMode, o: AskOptions): Decided {
    const out = t.policy.outcomes[pre.outcome];
    if (!out) throw new Error(`${t.template_id}'s precheck gave "${pre.outcome}", which isn't one of its outcomes.`);
    const result: Decided = {
      id: `dec-${randomUUID().slice(0, 12)}`,
      template_id: t.template_id, version: t.version,
      outcome: pre.outcome, action: out.action, tier: out.tier,
      autonomy: autonomy(out.tier, 'high', !!out.restrictive, t.policy.low),
      quality: 'high', trust: 'none', seat: 'stub', model: `rules@${t.template_id}@${t.version}`,
      answers: null, bands: null, why: pre.why,
      ...(pre.findings.length ? { findings: pre.findings } : {}),
    };
    this.#o.log.write({
      ...result,
      at: this.#now().toISOString(), task_id: o.task_id ?? null, subsystem: o.subsystem,
      model_asked: null, privacy_mode: mode, egress: 'none', opt_in: null,
      state_sha256: built.sha256, state_fields: built.fields,
      pieces: 0, requests: 0, usage: { input_tokens: 0, output_tokens: 0 },
      shadows: [], failures: [], verdict_ref: null,
    });
    return result;
  }

  // null when there is no such template (a cache miss: the caller falls back to its own rules).
  async ask(templateId: string, fields: Record<string, unknown>, o: AskOptions): Promise<Decided | null> {
    const reg = this.version(templateId, o.version);
    if (!reg) return null;
    const t = reg.template;
    const mode = o.privacy_mode ? stricter(o.privacy_mode, this.#o.privacy()) : this.#o.privacy();
    // Deterministic checks first: a final one decides with no model call at all.
    const pre = t.precheck?.(fields) ?? null;
    if (pre?.final) return this.#deterministic(t, buildState(t, fields), pre, mode, o);
    const built = buildState(t, pre?.fields ?? fields);
    const { candidates, skipped } = this.plan(t, mode, o.capture_source);
    const failures: { seat: SeatId; why: string }[] = [...skipped];
    const shadows: Shadow[] = [];
    const asked = new Set<SeatId>();
    const totals = { pieces: 0, requests: 0, usage: { input_tokens: 0, output_tokens: 0 } };
    const count = (a: SeatAnswer) => { totals.pieces += a.pieces; totals.requests += a.requests; totals.usage.input_tokens += a.usage.input_tokens; totals.usage.output_tokens += a.usage.output_tokens; };
    let decided: { seat: SeatId; model: string | null; answers: Record<string, Answer>; trust: Trust; ref: string | null; why: string } | null = null;

    let receipted = false;
    for (const c of candidates) {
      if (c.seat.egress === 'remote' && !receipted) {
        try {
          this.#o.receipt?.({ task_id: o.task_id ?? null, provider: 'jev', model: c.model ?? '', purpose: `decision: ${t.template_id}@${t.version}`, privacy_mode: mode, egress: 'remote:typesafe', opt_in: this.cloudAllowed(t, mode, undefined, o.capture_source).opt_in, state_sha256: built.sha256 });
          receipted = true;
        } catch (e) { failures.push({ seat: c.seat.id, why: `The receipt was refused, so nothing was sent: ${(e as Error).message}` }); continue; }
      }
      asked.add(c.seat.id);
      let a: SeatAnswer;
      try { a = await c.seat.ask(t, built); } catch (e) { failures.push({ seat: c.seat.id, why: (e as Error).message }); continue; }
      count(a);
      // The pin: an answer from another model version is not used.
      if (tag(a.model_answered) !== tag(c.model)) {
        failures.push({ seat: c.seat.id, why: `${tag(c.model)} was asked but ${a.model_answered || 'an unnamed model'} answered; the answer isn’t used.` });
        shadows.push({ seat: c.seat.id, model: a.model_answered || null, answers: a.answers, why: 'pin mismatch' });
        continue;
      }
      if (c.trusted) { decided = { seat: c.seat.id, model: c.model, answers: a.answers, trust: 'verdict', ref: c.ref, why: c.why }; break; }
      shadows.push({ seat: c.seat.id, model: c.model, answers: a.answers, why: c.why });
    }
    if (!decided) {
      const lg = this.legacyAllowed(t);
      if (lg.ok) {
        asked.add('legacy');
        try {
          const a = await this.#o.seats.legacy!.ask(t, built);
          count(a);
          decided = { seat: 'legacy', model: a.model_answered, answers: a.answers, trust: 'legacy', ref: null, why: lg.why };
        } catch (e) { failures.push({ seat: 'legacy', why: (e as Error).message }); }
      } else if (t.legacy) failures.push({ seat: 'legacy', why: lg.why });
    }

    let outcome: string;
    let quality: Quality;
    let bands: Record<string, Band> | null = null;
    let why: string;
    if (decided) {
      bands = bandsOf(t, decided.answers);
      outcome = t.policy.table(bands);
      quality = qualityOf(bands);
      why = decided.why;
    } else {
      const rule = t.rules?.(built.values) ?? null;
      outcome = rule ?? t.policy.default;
      quality = rule ? 'high' : 'low';
      why = rule ? 'Nova’s own rule decided; no model was used.' : `No trusted model answered (${[...failures.map((f) => `${f.seat}: ${f.why}`), ...shadows.map((s) => `${s.seat} answered as evidence only`)].join('; ') || 'none available'}), so Nova used its safe default.`;
    }
    // A deterministic pre-pass that found something, but left the rest to the model: the stricter
    // of the two outcomes wins.
    if (pre) {
      const order = t.policy.order ?? Object.keys(t.policy.outcomes);
      if (order.indexOf(pre.outcome) > order.indexOf(outcome)) { outcome = pre.outcome; why = `${pre.why} ${why}`; }
    }
    const out = t.policy.outcomes[outcome]!;
    const result: Decided = {
      id: `dec-${randomUUID().slice(0, 12)}`,
      template_id: t.template_id, version: t.version,
      outcome, action: out.action, tier: out.tier,
      autonomy: autonomy(out.tier, quality, !!out.restrictive, t.policy.low),
      quality, trust: decided?.trust ?? 'none',
      seat: decided?.seat ?? 'stub', model: decided?.model ?? `rules@${t.template_id}@${t.version}`,
      answers: decided?.answers ?? null, bands, why,
      ...(pre?.findings.length ? { findings: pre.findings } : {}),
    };
    const cloud = asked.has('jev');
    const opt_in = cloud ? this.cloudAllowed(t, mode, undefined, o.capture_source).opt_in : null;
    const record: DecisionRecord = {
      ...result,
      at: this.#now().toISOString(), task_id: o.task_id ?? null, subsystem: o.subsystem,
      model_asked: decided?.seat === 'legacy' ? 'sorting-model' : decided?.model ?? null,
      privacy_mode: mode,
      egress: cloud ? 'remote:typesafe' : asked.size ? 'local' : 'none',
      opt_in,
      state_sha256: built.sha256, state_fields: built.fields,
      pieces: totals.pieces, requests: totals.requests, usage: totals.usage,
      shadows, failures, verdict_ref: decided?.ref ?? null,
    };
    this.#o.log.write(record);
    return result;
  }
}

export type { BuiltState };
