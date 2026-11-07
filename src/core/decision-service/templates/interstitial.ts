// The Interstitial Research skill's two templates (docs/builder-packet/interstitial-research/,
// SKILL.md §4). Written with their rules BEFORE any eval case existed. Both judge the person's own
// research conversation, so both are 'private': cloud only in cloud mode, never in a local mode.
// The field map is not a template: the Decision Service answers questions, it doesn't generate
// (src/interstitial.js validates the model's own field map instead).
//
// interstitial.verify-transfer v1: one call per adjacent-field claim (the runner hook).
//   from_field   (a) is the cited source actually from the claimed adjacent field?
//   mechanism    (b) does the underlying mechanism match, not just the surface?
//   supports     (c) does the excerpt support the claim as stated?
//   established  (d) is the insight established in a field, rather than a hypothesis made by
//                    combining fields? Only the label: established or hypothesis.
// The rule: any of a–c below 0.4 → discard; any in 0.4–0.7 → quarantine (used, labelled
// uncertain); all three at 0.7 or more → use, labelled by (d). Untrusted or unanswered: quarantine,
// so a seat without a passing eval can never make a claim usable or Verified.
//
// interstitial.outbound-check v1: before each web_search in a run that follows the skill, in
// addition to the ingest gate's deterministic outbound check (never instead of it).
//   person       does the query name a person, or carry their contact details or an identifier?
//   record       does it carry health, financial or personal-record details?
//   memory       does it carry content from the person's memory, notes or screen capture?
// The rule: all three a confident no → send; anything else → withhold (generalise or drop).
// Untrusted or unanswered: withhold. It fails closed.
import type { Band, FieldValue, ServiceTemplate } from '../types.ts';

export const VT_QUESTIONS = ['from_field', 'mechanism', 'supports', 'established'] as const;
export const OC_QUESTIONS = ['person', 'record', 'memory'] as const;
export const PRIVACY_CLASSES = ['public', 'personal-derived', 'sensitive'] as const;

export type VtOutcome = 'use_established' | 'use_hypothesis' | 'quarantine' | 'discard';
export function verifyPolicy(b: Record<string, Band>): VtOutcome {
  const gate = [b.from_field, b.mechanism, b.supports];
  if (gate.includes('no')) return 'discard';
  if (gate.some((x) => x !== 'yes')) return 'quarantine';
  return b.established === 'yes' ? 'use_established' : 'use_hypothesis';
}

export type OcOutcome = 'send' | 'withhold';
export function outboundPolicy(b: Record<string, Band>): OcOutcome {
  return OC_QUESTIONS.every((q) => b[q] === 'no') ? 'send' : 'withhold';
}

export const VERIFY_TRANSFER_V1: ServiceTemplate = {
  template_id: 'interstitial.verify-transfer',
  version: 1,
  purpose: 'Before a research answer borrows from an adjacent field: is the cited source from that field, does the mechanism really match, does the source support the claim, and is the insight established or only a hypothesis?',
  feature: 'private',
  fields: {
    claim: { type: 'text', max_chars: 1_000 },
    claimed_field: { type: 'text', max_chars: 200 },
    // The screened extract of a page fetched in this run (taint kept by the hook); split under the
    // seat's budget, each piece asked with the whole battery.
    cited_source_excerpt: { type: 'text', max_chars: 12_000, chunk: 'worst' },
  },
  state: (f: Record<string, FieldValue>) => ({ claim: f.claim, claimed_field: f.claimed_field, cited_source_excerpt: f.cited_source_excerpt }),
  questions: {
    from_field: {
      type: 'noul',
      instructions: 'Is `cited_source_excerpt` written from within `claimed_field`?',
      criteria: {
        true: '`cited_source_excerpt` uses the methods, terms and literature of `claimed_field`, for example a queueing-theory text that models arrivals and service times.',
        false: '`cited_source_excerpt` belongs to another field, is a general overview that only mentions `claimed_field` in passing, or doesn’t show which field it is from.',
      },
    },
    mechanism: {
      type: 'noul',
      instructions: 'Does the mechanism in `cited_source_excerpt` match the mechanism `claim` relies on?',
      criteria: {
        true: 'The cause and effect in `cited_source_excerpt` work the same way as in `claim`: the same kind of constraint, feedback or flow, even under other names.',
        false: 'The two only look alike on the surface: a shared word, a metaphor, or a similar outcome reached by a different cause.',
      },
    },
    supports: {
      type: 'noul',
      instructions: 'Does `cited_source_excerpt` support `claim` as `claim` states it?',
      criteria: {
        true: '`cited_source_excerpt` says what `claim` says, at the same strength and scope.',
        false: '`cited_source_excerpt` says something weaker, narrower, different, or nothing about it.',
      },
    },
    established: {
      type: 'noul',
      instructions: 'Is the insight in `claim` already established within `claimed_field`?',
      criteria: {
        true: '`cited_source_excerpt` presents it as known within `claimed_field`: a stated result, a standard method, or a widely used model.',
        false: 'It comes from combining fields, as a new suggestion, a speculation, or an untested idea.',
      },
    },
  },
  policy: {
    bands: { from_field: { lo: 0.4, hi: 0.7 }, mechanism: { lo: 0.4, hi: 0.7 }, supports: { lo: 0.4, hi: 0.7 }, established: { lo: 0.3, hi: 0.7 } },
    outcomes: {
      use_established: { action: 'use the claim, labelled established', tier: 1 },
      use_hypothesis: { action: 'use the claim, labelled a hypothesis', tier: 1 },
      quarantine: { action: 'keep the claim only as uncertain, labelled', tier: 0, restrictive: true },
      discard: { action: 'leave the claim out and log the discard', tier: 0, restrictive: true },
    },
    table: verifyPolicy,
    default: 'quarantine',
    low: 'escalate',
    order: ['use_established', 'use_hypothesis', 'quarantine', 'discard'],
  },
  legacy: false,
};

export const OUTBOUND_CHECK_V1: ServiceTemplate = {
  template_id: 'interstitial.outbound-check',
  version: 1,
  purpose: 'Before a research search leaves the device: does the query carry anything of the person’s own (a person, their records, their memory or capture)?',
  feature: 'private',
  fields: {
    query: { type: 'text', max_chars: 500 },
    // The topic's class as the hook knows it: public, personal-derived or sensitive.
    privacy_class: { type: 'text', max_chars: 20 },
  },
  state: (f: Record<string, FieldValue>) => ({ query: f.query, privacy_class: f.privacy_class }),
  questions: {
    person: {
      type: 'noul',
      instructions: 'Does `query` identify a particular person?',
      criteria: {
        true: '`query` has a name of someone, an email address, a phone number, a street address, an account or record number, or another identifier of a particular person.',
        false: '`query` names no particular person; public figures in their public role, products and places do not count.',
      },
    },
    record: {
      type: 'noul',
      instructions: 'Does `query` carry specifics from a personal record, such as health and finances?',
      criteria: {
        true: '`query` has specifics such as a diagnosis or prescription someone has, an amount in their account, their salary, or a case number. `privacy_class` says where the topic came from.',
        false: '`query` asks about a topic in general terms, such as how a kind of medicine works or how interest is calculated.',
      },
    },
    memory: {
      type: 'noul',
      instructions: 'Does `query` carry content from the person’s own records kept by Nova (memory, notes, messages, screen capture)?',
      criteria: {
        true: '`query` repeats wording or specifics that only the person’s own records would hold: a private event, a private document’s phrasing, a message they received.',
        false: '`query` is the abstract shape of the problem, the way anyone researching the topic would put it.',
      },
    },
  },
  policy: {
    outcomes: {
      send: { action: 'send the query as it is', tier: 1 },
      withhold: { action: 'generalise the query or drop it', tier: 0, restrictive: true },
    },
    table: outboundPolicy,
    default: 'withhold',
    low: 'escalate',
    order: ['send', 'withhold'],
  },
  legacy: false,
};
