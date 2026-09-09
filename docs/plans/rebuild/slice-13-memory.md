# Slice 13 — Memory: she stops forgetting what you told her

Branch `slice/s13`, cut from `rebuild/v4` at c440e29d.
Status: SPEC, measured 2026-09-09.

The roadmap has said since S1 that "BM25 recall misses conversational
phrasings". It has never been measured, so it was never fixed. It is
measured now, and the diagnosis is different from the assumption.

## The measurement

Twenty facts that genuinely exist in Jeremy's own notes, twenty questions
phrased the way a person actually asks, live against the running service.

| What | Result |
|---|---|
| The answer text reaches the model | **6 of 20** |
| The right file is in the top 5 | 19 of 20 |
| The right file by pure chance | 14 of 20 |
| The answer reaches it with the WHOLE store handed over | 8 of 20 |
| Recall time, against a 2,000 ms budget | 4.5 ms |

The 19-of-20 figure is what has made recall look adequate and it is very
nearly meaningless: the store is eight documents and `k` is five, so
chance alone scores fourteen.

**Ranking is not the binding constraint.** Given the entire store, the
answer still reaches the model only 40% of the time. Anything built on top
of a better ranker is capped there.

## Why it fails, mechanically

- **No stopword list.** `_TOKEN_RE = [a-z0-9]+` is the entire analysis
  chain. On "how much RAM does my machine have", the terms *does, my,
  much, have, how* supply about 60% of the winning score, and the one note
  that says "24GB VRAM, 64GB system RAM" ranks **7th of 7**. `does` alone
  outscores the whole correct note.
- **Nothing is chunked.** A day of conversation is one document, up to
  21 KB. The 400-character excerpt is centred on wherever the question's
  own filler words cluster, which in a transcript is almost never near the
  answer: measured gaps of 1,483 / 3,373 / 6,804 characters in files that
  ranked first. Excerpts are cut mid-word and leak markup.
- **Size and recency compound it.** Today's journal is the largest file, so
  it matches everything, and then takes a recency multiplier. Three
  documents supply every top hit across all twenty queries.
- **It can never say "nothing".** Asked whether Jeremy ever mentioned a
  cat, with no cat anywhere in the corpus, it returns five confident hits.
  And a failed recall returns `[]` identically to an empty one, so nothing
  downstream can tell "memory had nothing" from "memory was down".
- **The corpus is 99.2% raw transcript.** One deliberately-saved note in
  twelve days of use, and it is the one that ranks last.

Two live bugs found while measuring: the proactive commitments check
builds its query from `owner.name`, which is an email address, so the
token `com` is its highest-scoring term and matches URLs in a news
paragraph. And `avgdl` is averaged across every partition in the process,
so an eval scratch account shifts Jeremy's ranking.

## Decisions with Jeremy (2026-09-09)

1. **Recall may return nothing, and says so.** Below a relevance floor it
   returns no hits and states that the notes held no answer. He will feel
   this: she will start saying she has nothing on a subject where today
   she pattern-matches confidently.
2. **She distils, as a separate step.** The transcript keeps being stored;
   separately, durable facts and commitments are extracted into short
   notes that are actually findable. Retrieval over raw transcript is
   retrieving transcript, so this has the highest ceiling of anything
   here. Off the critical path of a turn.
3. **"What did we talk about" reads recent history, not search.** It is a
   request for the last stretch of conversation, and today it searches,
   matches almost nothing, and she narrates from whatever recency
   returned.

## Architecture

### The suite comes first

Freeze the twenty question-and-fact pairs as a pinned test in
`services/memory/tests/`, scored on **answer-in-context** — did the text
that answers the question actually reach the model — with today's 6/20 as
a floor that only ever moves up. Every change below is measured against
it, and the number goes in the commit. This is the tripwire the weakness
survived twelve slices without.

The other metric that must exist beside it: a **false-positive rate** over
questions whose answer is genuinely absent ("did I ever mention my cat"),
because decision 1 is only real if something measures it.

### Chunk, then tokenise, then floor

All three are mechanical, need no model, and attack the measured causes in
the order of their measured size.

- **Chunk** at the `## HH:MM` boundaries `store.append_journal` already
  writes. Index-side only: the files on disk are untouched, `iter_all`
  still yields whole files, `/forget` still deletes whole files. Each
  chunk gets a stable id (`people/<id>/journals/2026-09-09.md#16:32`),
  which also gives S11's commitments check the citable id it was denied.
- **Tokenise properly**: a stopword list and stemming. Postgres snowball
  is already present and already bridges specs → spec; the memory service
  has no numeric dependency today, so the choice is between using postgres
  and adding a small pure-Python stemmer. Either is fine; the suite says
  which won.
- **A relevance floor**, so a query whose only matches are common terms
  returns nothing rather than five noise notes. Derived from the score
  distribution, never a hand-tuned constant that rots.

### Say what is true about a hit

`Relevant notes:` asserts a property nothing established. A hit carries
what is mechanically known: its kind, its age, and that it cleared the
floor. And `_recall` must stop returning `[]` for both "nothing matched"
and "memory unreachable" — the second is already recorded on the span and
must reach the prompt too, so she can say the difference.

### Distillation, as its own pass

A separate step over new conversation, off the turn's critical path,
extracting durable facts and commitments into short topic notes. Its
findings must cite the exchange they came from, verified the way S11's
review check verifies citations, so a distilled note can never assert
something the transcript does not support. Measured by the same suite: if
it does not move the number, it did not work.

### Then, and only then, embeddings

Local via ollama, roughly a 300 MB model, brute-force cosine over a few
dozen chunks (no vector index, and pgvector is not installed and not
needed at this size). But it is measured against the same suite AFTER the
mechanical work, because an embedder over 21 KB documents fails the same
way BM25 does, and the mechanical fixes may be enough.

## Sub-slices

- **S13-1 the suite.** The twenty pairs, answer-in-context scoring, the
  absent-answer set, today's numbers pinned as floors. GATE: the suite
  runs and reproduces 6/20 and the false-positive rate.
- **S13-2 chunk + tokenise + floor + honest hits.** All the mechanical
  work, each measured. Also the two live bugs: the email in the
  commitments query, and the global `avgdl`. GATE: the number moves, and
  the commit says by how much.
- **S13-3 recent history.** Route "what did we talk about" to the history
  core already holds rather than to search.
- **S13-4 distillation.** The extraction pass, with verified citations.
  GATE: measured on the same suite.
- **S13-5 embeddings, if the number still needs them.** Decided by
  measurement, not by plan.

## Verification

The suite is the verification, and it is honest in a way a walk cannot be:
the same twenty questions, before and after, with the number in the commit
message. Then the live walk that only a person can do — ask her something
you told her a week ago and see whether she knows it.
