// memory-gate v1 (DS2 first use; ADR docs/plans/decision-service.md §8; plan
// docs/plans/ds2-memory-gate.md): before Nova keeps something it proposes to remember, judge
// whether it should be saved, merged with an existing memory, flagged as contradicting one, or
// skipped. Written with its rule BEFORE any eval case existed.
//
// After TypeSafe's memory cookbook (docs.typesafe.ai/cookbooks/basic_memory): a gate asks whether
// the person's words state a lasting fact; the assistant's answer is there as context, but a fact
// that appears only in the answer does NOT count. The cookbook's next steps add "does this replace
// an older memory?"; here that is the duplicate and contradiction questions. Split under the
// skill's rule of one judgment per question:
//   lasting           does what the person said stay true after this conversation?
//   in_person_words   do the person's own words say what the candidate memory says?
//   duplicate         does an existing memory already say it?
//   contradicts       does it conflict with an existing memory?
// No importance Score: nothing would read it yet, and a Score's level is not a gate.
//
// Deterministic first: a candidate that matches an existing memory word for word (case, spacing
// and punctuation aside) merges, with no model call.
//
// The rule (a truth table; a wrongly saved memory is worse than a missed one, because a saved
// memory goes into every later prompt and a missed one can simply be said again):
//   in_person_words not "yes"      → skip   (only in Nova's answer, a guess, or unsure)
//   lasting not "yes"              → skip   (a passing remark, a one-off request, or unsure)
//   contradicts "yes" or unsettled → flag   (the person chooses which is true)
//   duplicate "yes" or unsettled   → merge  (keep the existing memory; write nothing new)
//   otherwise                      → save
// Saving needs a confident yes: bands of 0.8 / 0.3 for lasting and in_person_words (the cookbook:
// "raise it if a misleading memory costs more than a missing one"), TypeSafe's 0.7 / 0.3 for the
// others. Not tuned. Untrusted or unanswered: today's behaviour (save, as an unreviewed memory).
import type { Band, FieldValue, Precheck, ServiceTemplate } from '../types.ts';

export const MG_QUESTIONS = ['lasting', 'in_person_words', 'duplicate', 'contradicts'] as const;

export function memoryPolicy(b: Record<string, Band>): 'save' | 'merge' | 'flag' | 'skip' {
  if (b.in_person_words !== 'yes') return 'skip';
  if (b.lasting !== 'yes') return 'skip';
  if (b.contradicts !== 'no') return 'flag';
  if (b.duplicate !== 'no') return 'merge';
  return 'save';
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Existing memories arrive one per line.
export const existingList = (s: unknown): string[] => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

export function memoryPrecheck(fields: Record<string, unknown>): Precheck | null {
  const cand = norm(String(fields.candidate ?? ''));
  if (!cand) return { outcome: 'skip', why: 'There is nothing to remember.', findings: [], final: true };
  if (existingList(fields.existing_memories).some((e) => norm(e) === cand)) return { outcome: 'merge', why: 'An existing memory says exactly this already.', findings: [], final: true };
  return null;
}

export const MEMORY_GATE_V1: ServiceTemplate = {
  template_id: 'memory-gate',
  version: 1,
  purpose: 'Before Nova keeps a memory it proposes: is it a lasting fact in the person’s own words, already known, or in conflict with what Nova remembers?',
  // The person's own conversation: cloud only in cloud mode, never in a local mode, no opt-in.
  feature: 'private',
  fields: {
    person_said: { type: 'text', max_chars: 4_000 },
    nova_answer: { type: 'text', max_chars: 4_000, required: false },
    candidate: { type: 'text', max_chars: 500 },
    // The nearest existing memories, one per line (the consumer retrieves them; at most a few).
    existing_memories: { type: 'text', max_chars: 4_000, required: false },
  },
  state: (f: Record<string, FieldValue>) => ({
    person_said: f.person_said,
    nova_answer: f.nova_answer ?? '',
    candidate: f.candidate,
    existing_memories: existingList(f.existing_memories),
  }),
  questions: {
    lasting: {
      type: 'noul',
      instructions: 'Does `person_said` state something about the person that stays true after this conversation?',
      criteria: {
        true: '`person_said` states a lasting fact about the person or a standing preference of theirs, for example where they live, their work, their family, an allergy, or “I always take the train”.',
        false: '`person_said` only has things about this moment: a one-off request such as “book a table for tonight”, today’s plans, a mood, a passing remark, or a question.',
      },
    },
    in_person_words: {
      type: 'noul',
      instructions: 'Do the person’s own words in `person_said` say what `candidate` says?',
      criteria: {
        true: 'What `candidate` says is stated by the person in `person_said`, even in other words.',
        false: '`candidate` rests on something only `nova_answer` says, on a guess, or on more than the person said. Nothing in `nova_answer` counts as the person’s words.',
      },
    },
    duplicate: {
      type: 'noul',
      instructions: 'Does one of `existing_memories` already say what `candidate` says?',
      criteria: {
        true: 'An entry in `existing_memories` has the same meaning as `candidate`, even in other words.',
        false: 'No entry says it. A related but different fact, such as another person, another place, or another preference, does not count.',
      },
    },
    contradicts: {
      type: 'noul',
      instructions: 'Does `candidate` conflict with one of `existing_memories`?',
      criteria: {
        true: '`candidate` and an entry in `existing_memories` can’t both be true now, for example a new home city, a changed job, or a preference the person has dropped.',
        false: 'No entry conflicts with `candidate`. A fact about a different person or topic, or a detail that adds to an existing memory, does not count.',
      },
    },
  },
  policy: {
    bands: { lasting: { lo: 0.3, hi: 0.8 }, in_person_words: { lo: 0.3, hi: 0.8 }, duplicate: { lo: 0.3, hi: 0.7 }, contradicts: { lo: 0.3, hi: 0.7 } },
    outcomes: {
      save: { action: 'keep it as an unreviewed memory', tier: 1 },
      merge: { action: 'keep the existing memory and write nothing new', tier: 0, restrictive: true },
      flag: { action: 'hold it for the person to choose which is true', tier: 2 },
      skip: { action: 'don’t keep it', tier: 0, restrictive: true },
    },
    table: memoryPolicy,
    default: 'save',
    low: 'escalate',
  },
  precheck: memoryPrecheck,
  legacy: false,
};
