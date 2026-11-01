// memory-gate's eval set (plan docs/plans/ds2-memory-gate.md), written after the template, its rule
// and the bounds were committed (7d587168), and before any run.
//
// SYNTHETIC ONLY: placeholder people (Alex, Sam, Jordan, Taylor Placeholder; a cat called Pepper),
// invented places and neutral topics (home, work, family, pets, food, travel, hobbies).
//
// LABELS, one per question (true means it really is so):
//   lasting          person_said states something about the person that stays true after this
//                    conversation (a lasting fact or a standing preference);
//   in_person_words  the person's own words say what the candidate says (Nova's answer never counts);
//   duplicate        an existing memory already says what the candidate says;
//   contradicts      the candidate and an existing memory can't both be true now.
// Each case's EXPECTED outcome is the template's rule on these labels (true → yes, false → no).
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { memoryPolicy, MG_QUESTIONS } from '../../../src/core/decision-service/templates/memory-gate.ts';
import type { MgOutcome } from '../../../src/core/decision-service/eval-memory.ts';

export type Labels = Record<(typeof MG_QUESTIONS)[number], boolean>;
export interface Case {
  id: string;
  category: string;
  input: { person_said: string; nova_answer: string; candidate: string; existing_memories: string };
  labels: Labels;
  expected: MgOutcome;
  // Expected to be decided by the template's deterministic check, with no model call.
  deterministic: boolean;
}

// L lasting, W in_person_words, D duplicate, C contradicts.
const L = (s: string): Labels => ({ lasting: s.includes('L'), in_person_words: s.includes('W'), duplicate: s.includes('D'), contradicts: s.includes('C') });
const yesNo = (l: Labels) => Object.fromEntries(Object.entries(l).map(([q, v]) => [q, v ? 'yes' : 'no']));
const C = (id: string, category: string, person_said: string, nova_answer: string, candidate: string, existing: string[], labels: string, o: { deterministic?: boolean; expected?: MgOutcome } = {}): Case => {
  const lab = L(labels);
  return { id, category, input: { person_said, nova_answer, candidate, existing_memories: existing.join('\n') }, labels: lab, expected: o.expected ?? memoryPolicy(yesNo(lab)), deterministic: o.deterministic ?? false };
};
const SOME = ['Has a cat called Pepper.', 'Works as a librarian.'];

export function buildCases(): Case[] {
  return [
    // ---- a lasting fact the person states (save) --------------------------------------------
    C('fact-moved', 'lasting fact', 'We finally moved to York last month, the new flat is right by the station.', 'Congratulations on the move! The station area is handy.', 'Lives in York.', SOME, 'LW'),
    C('fact-job', 'lasting fact', 'I started my new job as a primary school teacher in September.', 'That sounds rewarding. How are the first weeks going?', 'Works as a primary school teacher.', ['Has a cat called Pepper.'], 'LW'),
    C('fact-sister', 'lasting fact', 'My sister Jordan lives in Lisbon, so I go there most summers.', 'Lisbon in summer is lovely.', 'Has a sister, Jordan, who lives in Lisbon.', SOME, 'LW'),
    C('fact-dog', 'lasting fact', 'We adopted a greyhound called Biscuit last week!', 'Greyhounds are such gentle dogs.', 'Has a greyhound called Biscuit.', ['Works as a librarian.'], 'LW'),
    C('fact-language', 'lasting fact', 'I grew up speaking Portuguese at home, English came later.', 'Being bilingual is a real advantage.', 'Speaks Portuguese as a first language.', SOME, 'LW'),
    C('fact-car', 'lasting fact', 'We don’t own a car, we cycle or take the bus everywhere.', 'That keeps things simple in a city.', 'Doesn’t own a car.', SOME, 'LW'),
    C('fact-partner', 'lasting fact', 'My partner Sam works night shifts at the hospital, so mornings are quiet here.', 'Night shifts are hard; quiet mornings help.', 'Partner Sam works night shifts.', SOME, 'LW'),
    C('fact-choir', 'lasting fact', 'I sing in the community choir every Thursday evening.', 'Choirs are a great way to unwind.', 'Sings in a community choir on Thursdays.', SOME, 'LW'),
    C('fact-allotment', 'lasting fact', 'We’ve had an allotment on Elm Road for six years now.', 'Six years, you must grow a lot by now.', 'Has an allotment on Elm Road.', SOME, 'LW'),
    C('fact-kids', 'lasting fact', 'Our twins, Alex and Taylor, start secondary school next year.', 'Big change for them!', 'Has twins named Alex and Taylor.', ['Works as a librarian.'], 'LW'),
    C('fact-birthday', 'lasting fact', 'My birthday is on the 3rd of March, by the way.', 'Noted, early March.', 'Birthday is 3 March.', SOME, 'LW'),
    C('fact-flat-floor', 'lasting fact', 'We live on the fourth floor and there’s no lift, so heavy deliveries are a pain.', 'That does make big orders tricky.', 'Lives on a fourth floor with no lift.', SOME, 'LW'),
    // ---- a standing preference (save) -------------------------------------------------------
    C('pref-vegetarian', 'standing preference', 'I’m vegetarian, so please never suggest meat dishes.', 'Understood, vegetarian ideas only.', 'Is vegetarian.', SOME, 'LW'),
    C('pref-train', 'standing preference', 'I always take the train rather than fly when I can.', 'Trains are a calmer way to travel.', 'Prefers the train to flying.', SOME, 'LW'),
    C('pref-mornings', 'standing preference', 'Please don’t book anything for me before 10am, I’m useless in the mornings.', 'Got it, late mornings at the earliest.', 'Prefers no appointments before 10am.', SOME, 'LW'),
    C('pref-metric', 'standing preference', 'Give me temperatures in Celsius, I never think in Fahrenheit.', 'Celsius it is.', 'Prefers Celsius.', SOME, 'LW'),
    C('pref-short', 'standing preference', 'I like short answers, a sentence or two is plenty for me.', 'Will keep it brief.', 'Prefers short answers.', SOME, 'LW'),
    C('pref-aisle', 'standing preference', 'I always want an aisle seat on long journeys.', 'Aisle seats noted.', 'Prefers aisle seats.', SOME, 'LW'),
    C('pref-tea', 'standing preference', 'I don’t drink coffee at all, only tea.', 'Tea it is.', 'Drinks tea, not coffee.', SOME, 'LW'),
    C('pref-email', 'standing preference', 'Send me reminders by email, not text, I never check messages.', 'Email reminders from now on.', 'Prefers email reminders to texts.', SOME, 'LW'),
    // ---- a passing remark, a mood, today's plans (skip) -------------------------------------
    C('pass-tired', 'passing remark', 'I’m so tired today, it’s been a long one.', 'Sorry to hear that; rest up.', 'Is tired today.', SOME, 'W'),
    C('pass-rain', 'passing remark', 'Ugh, it’s pouring here this afternoon.', 'A good afternoon for staying in.', 'It is raining where they are.', SOME, 'W'),
    C('pass-lunch', 'passing remark', 'Just had a sandwich at my desk for lunch.', 'Hope it was a good one.', 'Had a sandwich for lunch.', SOME, 'W'),
    C('pass-cinema', 'today’s plans', 'Going to the cinema with Sam tonight.', 'Enjoy the film!', 'Is going to the cinema tonight.', SOME, 'W'),
    C('pass-mood', 'passing remark', 'Feeling pretty cheerful this morning for some reason.', 'Glad to hear it!', 'Feels cheerful this morning.', SOME, 'W'),
    C('pass-traffic', 'passing remark', 'Traffic was awful on the way in today.', 'That’s a rough start.', 'Hit bad traffic today.', SOME, 'W'),
    C('pass-phone', 'passing remark', 'Typing this on my phone on the bus, sorry for typos.', 'No problem at all.', 'Is on the bus.', SOME, 'W'),
    C('pass-weekend', 'today’s plans', 'This weekend I’m mostly just cleaning the flat.', 'A tidy flat feels great after.', 'Plans to clean the flat this weekend.', SOME, 'W'),
    C('pass-hungry', 'passing remark', 'I’m starving, what’s quick to make?', 'Try an omelette or beans on toast.', 'Is hungry.', SOME, 'W'),
    // ---- a one-off request (skip) -----------------------------------------------------------
    C('once-table', 'one-off request', 'Book a table for two at eight tonight somewhere near the river.', 'I’ll look for riverside tables at eight.', 'Wants a table for two at eight tonight.', SOME, 'W'),
    C('once-timer', 'one-off request', 'Set a timer for twenty minutes for the pasta.', 'Timer set for twenty minutes.', 'Wants a twenty-minute timer.', SOME, 'W'),
    C('once-gift', 'one-off request', 'Can you find a birthday gift for my nephew, around twenty pounds?', 'Here are a few ideas around twenty pounds.', 'Wants a gift for a nephew around twenty pounds.', SOME, 'W'),
    C('once-train', 'one-off request', 'What time is the next train to Leeds?', 'The next one leaves at 14:05.', 'Wants the next train to Leeds.', SOME, 'W'),
    C('once-recipe', 'one-off request', 'Give me a recipe for lentil soup for tonight.', 'Here’s a simple lentil soup.', 'Wants a lentil soup recipe tonight.', SOME, 'W'),
    C('once-translate', 'one-off request', 'How do you say “thank you” in Dutch?', '“Dank je wel.”', 'Wants to know Dutch for thank you.', SOME, 'W'),
    C('once-remind', 'one-off request', 'Remind me to call the plumber at three.', 'Reminder set for three.', 'Needs to call the plumber at three today.', SOME, 'W'),
    C('once-weather', 'one-off request', 'Will I need an umbrella tomorrow?', 'Yes, rain is likely after noon.', 'Wants tomorrow’s forecast.', SOME, 'W'),
    // ---- a fact that appears only in Nova's answer (skip) -----------------------------------
    C('nova-cheese', 'only in Nova’s answer', 'What’s a good cheese to take on a picnic?', 'Since you love blue cheese, a Stilton travels well.', 'Loves blue cheese.', SOME, ''),
    C('nova-sister-name', 'only in Nova’s answer', 'Can you remind me what my sister is called?', 'Your sister is called Jordan.', 'Sister is called Jordan.', SOME, ''),
    C('nova-city', 'only in Nova’s answer', 'Any nice walks nearby this weekend?', 'Around Bristol, the harbour walk is lovely.', 'Lives in Bristol.', SOME, ''),
    C('nova-job-guess', 'only in Nova’s answer', 'Help me write a short note to the head teacher.', 'As a fellow teacher, you might open with thanks for the term.', 'Is a teacher.', SOME, ''),
    C('nova-diet', 'only in Nova’s answer', 'What should I cook for six people on Saturday?', 'A big vegan chilli suits your diet and feeds six.', 'Is vegan.', SOME, ''),
    C('nova-kids-age', 'only in Nova’s answer', 'Ideas for a rainy day indoors?', 'With your two toddlers, a blanket fort is always a hit.', 'Has two toddlers.', SOME, ''),
    C('nova-hobby', 'only in Nova’s answer', 'Recommend a podcast for my commute.', 'Since you run marathons, try a running podcast.', 'Runs marathons.', SOME, ''),
    C('nova-pet', 'only in Nova’s answer', 'What plants are easy to keep alive?', 'Spider plants are safe around your rabbit.', 'Has a rabbit.', ['Works as a librarian.'], ''),
    // ---- a candidate that says more than the person did (skip) ------------------------------
    C('over-brother', 'more than the person said', 'My brother visits sometimes when he’s in town.', 'Nice to have family drop by.', 'Brother lives with them.', SOME, 'L'),
    C('over-yoga', 'more than the person said', 'I tried a yoga class last week, it was fun.', 'Yoga is a great start.', 'Does yoga every day.', SOME, ''),
    C('over-city', 'more than the person said', 'I’m in Manchester for a conference this week.', 'Enjoy the conference!', 'Lives in Manchester.', SOME, ''),
    C('over-spanish', 'more than the person said', 'I’m learning a few words of Spanish for a holiday.', '¡Buena suerte!', 'Speaks fluent Spanish.', SOME, ''),
    C('over-boss', 'more than the person said', 'Had a chat with my manager about next quarter.', 'Sounds productive.', 'Is a manager.', SOME, ''),
    // ---- a duplicate in other words (merge) --------------------------------------------------
    C('dup-pepper', 'duplicate', 'Pepper, my cat, knocked a plant off the shelf again.', 'Cats and plants never mix.', 'Owns a cat named Pepper.', SOME, 'LWD'),
    C('dup-librarian', 'duplicate', 'Work at the library was busy today, I’ve been a librarian for ten years.', 'Ten years, impressive.', 'Is a librarian.', SOME, 'LWD'),
    C('dup-veg', 'duplicate', 'As a vegetarian I always check the menu first.', 'Good idea.', 'Doesn’t eat meat.', ['Is vegetarian.', 'Works as a librarian.'], 'LWD'),
    C('dup-train', 'duplicate', 'I’ll take the train again, I prefer it to flying every time.', 'Train it is.', 'Prefers rail over planes.', ['Prefers the train to flying.'], 'LWD'),
    C('dup-celsius', 'duplicate', 'Remember, Celsius for me, always.', 'Of course.', 'Uses Celsius.', ['Prefers Celsius.'], 'LWD'),
    C('dup-sister', 'duplicate', 'My sister Jordan, the one in Lisbon, is visiting soon.', 'How lovely.', 'Sister Jordan lives in Lisbon.', ['Has a sister, Jordan, who lives in Lisbon.'], 'LWD'),
    C('dup-choir', 'duplicate', 'Choir again on Thursday, as every week.', 'Enjoy it!', 'Goes to choir every Thursday.', ['Sings in a community choir on Thursdays.'], 'LWD'),
    C('dup-tea', 'duplicate', 'No coffee for me, I only ever drink tea.', 'Tea, then.', 'Prefers tea over coffee.', ['Drinks tea, not coffee.'], 'LWD'),
    // ---- a contradiction with an existing memory (flag) --------------------------------------
    C('con-moved', 'contradiction', 'Now that we’ve moved to York, the commute is much shorter.', 'A shorter commute is a big win.', 'Lives in York.', ['Lives in Leeds.', 'Has a cat called Pepper.'], 'LWC'),
    C('con-job', 'contradiction', 'I left the library and I’m a park ranger now.', 'What a change!', 'Works as a park ranger.', ['Works as a librarian.'], 'LWC'),
    C('con-meat', 'contradiction', 'I eat meat again these days, the vegetarian phase is over.', 'Fair enough.', 'Eats meat.', ['Is vegetarian.'], 'LWC'),
    C('con-fly', 'contradiction', 'Honestly I just fly everywhere now, trains take too long.', 'Flying is faster.', 'Prefers flying.', ['Prefers the train to flying.'], 'LWC'),
    C('con-coffee', 'contradiction', 'I switched to coffee, I don’t drink tea any more.', 'Coffee it is.', 'Drinks coffee, not tea.', ['Drinks tea, not coffee.'], 'LWC'),
    C('con-car', 'contradiction', 'We bought a car last month, so driving everywhere now.', 'Congratulations on the car.', 'Owns a car.', ['Doesn’t own a car.'], 'LWC'),
    C('con-choir', 'contradiction', 'I gave up the choir, I’m doing pottery on Thursdays instead.', 'Pottery is fun.', 'Does pottery on Thursdays.', ['Sings in a community choir on Thursdays.'], 'LWC'),
    C('con-sister-city', 'contradiction', 'Jordan moved from Lisbon to Porto last spring.', 'Porto is beautiful.', 'Sister Jordan lives in Porto.', ['Has a sister, Jordan, who lives in Lisbon.'], 'LWC'),
    // ---- a related but different fact (save) -------------------------------------------------
    C('rel-brother', 'related but different', 'My brother Taylor just moved to Bristol for work.', 'Bristol is a great city.', 'Brother Taylor lives in Bristol.', ['Has a sister, Jordan, who lives in Lisbon.'], 'LW'),
    C('rel-second-cat', 'related but different', 'We got a second cat, a kitten called Miso.', 'Two cats now!', 'Has a kitten called Miso.', ['Has a cat called Pepper.'], 'LW'),
    C('rel-partner-job', 'related but different', 'Sam got a job at the library too, so we both work there now.', 'Workmates as well!', 'Partner Sam works at the library.', ['Works as a librarian.'], 'LW'),
    C('rel-allergy-free', 'related but different', 'I also don’t eat fish, on top of being vegetarian.', 'Noted.', 'Doesn’t eat fish.', ['Is vegetarian.'], 'LW'),
    C('rel-second-home', 'related but different', 'We also have a small cottage near the coast we use at weekends.', 'Lovely to have a getaway.', 'Has a weekend cottage near the coast.', ['Lives in York.'], 'LW'),
    C('rel-cousin', 'related but different', 'My cousin Alex lives in Lisbon too, near my sister.', 'Family nearby, nice.', 'Has a cousin, Alex, in Lisbon.', ['Has a sister, Jordan, who lives in Lisbon.'], 'LW'),
    // ---- an exact duplicate (merge, deterministic) -------------------------------------------
    C('exact-pepper', 'exact duplicate', 'Pepper my cat is asleep on the radiator.', 'Cosy.', 'Has a cat called Pepper.', SOME, 'LWD', { deterministic: true }),
    C('exact-celsius', 'exact duplicate', 'Celsius please, as always.', 'Of course.', 'prefers celsius', ['Prefers Celsius.'], 'LWD', { deterministic: true }),
    C('exact-train', 'exact duplicate', 'Train, as ever.', 'Train it is.', 'Prefers the train to flying', ['Prefers the train to flying.'], 'LWD', { deterministic: true }),
  ];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function manifest(cases: Case[] = buildCases()) {
  const counts: Record<string, number> = {};
  for (const c of cases) counts[c.category] = (counts[c.category] ?? 0) + 1;
  const expected: Record<string, number> = {};
  for (const c of cases) expected[c.expected] = (expected[c.expected] ?? 0) + 1;
  return {
    cases_sha256: sha(JSON.stringify(cases)),
    total: cases.length,
    expected,
    counts,
    rows: cases.map((c) => ({ id: c.id, category: c.category, labels: Object.entries(c.labels).filter(([, v]) => v).map(([q]) => q), expected: c.expected, deterministic: c.deterministic, input_sha256: sha(JSON.stringify(c.input)) })),
  };
}

export const MANIFEST_FILE = join(import.meta.dirname, 'manifest.json');
