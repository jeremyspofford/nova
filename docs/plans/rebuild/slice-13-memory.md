# Slice 13 — Memory: she stops forgetting what you told her

Branch `slice/s13`, cut from `rebuild/v4` at c440e29d.
Status: BUILT, DEPLOYED and WALKED 2026-09-10.

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

## The adversarial review of 2026-09-10, and the one decision in it

Six defects, one shape: **the service knew its search was limited and the fact
did not reach the person.** Five were plainly bugs and were fixed as bugs. One
needed a judgement call, and it is recorded here rather than only in a
docstring, because it is the kind of thing a later slice will otherwise
re-decide by accident.

### May a check defined over a full window report on a partial search?

`checks/review.py` is defined over **his messages** — every one of them in the
last fourteen days, or `_window` raises. It also asks memory for background.
A memory service that cannot be answered at all is already `CannotCheck`: the
check could not assemble the world it is defined over. The question the review
raised is whether a memory search that RAN, but with only its word half, or
over a quarter of the embedded corpus, is the same thing.

**Decided: it reports, with the limit stated in the brief in memory's own
words.** Three reasons, in order of weight:

1. **A partial memory search cannot make a finding false.** Notes carry no
   message id; `_verified` drops any finding whose citation does not resolve
   to a message of his; the brief says in as many words that nothing reported
   may rest on a note alone. A reduced search can only make the check MISS
   something, and the caveat is what says so.
2. **The window it is defined over was read whole.** His messages are the
   subject; memory is background, and is labelled as background.
3. **`CannotCheck` here would switch the check off for a whole class of
   deployment.** The semantic half is unavailable on any box where the owner
   has not pulled an embedding model — a supported state — so the rule would
   mean those owners get nothing at all rather than a caveated something.

The line that does **not** move: memory not answering stays `CannotCheck`.
"Read less of the notes" and "read none of them" are different, and only the
second is a window this check could not assemble.

### The other five, for the record

- **A wrong-width vector counted as embedded for ever.** The index decided
  "has a vector" on the presence of a digest, so after the embedding model was
  re-pulled at another dimension the corpus read as fully covered, the pass
  logged "0 embedded", and semantic recall was dead until the notes were
  edited. Presence is now *comparability*: `has_vector`, `missing_vectors` and
  `vector_coverage` are width-aware, the width is learned from a live vector
  (the backfill's own answer, the boot warm-up, or the embedded question), and
  vectors of any other width are dropped from the index *and* from the cache
  file so the next pass re-embeds them.
- **Partial coverage never reached the prompt.** Memory composed
  "the semantic search covered only part of the notes — 12 of 47…" and core's
  `_degraded_from` selected on `ran is False` alone, so it was thrown away.
  It now selects on any stated limitation, relays memory's own coverage words,
  and reaches the prompt on the branch with hits as well as the empty one.
  `memory_search` had the same gap and now has the same rule.
- **"only 0 of 47 notes have been embedded" was false** when all 47 were
  embedded at an incomparable width. The reason (why the floor could not be
  derived) and the coverage (how much of the scope was reachable) are separate
  facts now, and `_search_caveat` relays coverage for a retriever that did not
  run as well as for one that did.
- **The backfill counted total failures, not failures without progress.** At
  the ~4,700-chunk scale the cache is designed for, every attempt embeds
  hundreds of units and then meets the per-call budget, so twenty productive
  attempts would abandon a corpus that was filling normally. The counter
  resets whenever a pass embedded anything, so the cap means what its log line
  says.
- **`RECALL_RESERVE` was a fixed 0.4 s for a cost that grows with the corpus**
  (48 ms at 1,000 units, 267 ms at 5,000, 504 ms at 10,000). 0.4 is now the
  floor; above it the reserve is the live scope times what ranking one unit
  actually costs *in this process*, and `/recall` states in its `statement`
  when the corpus is what cut the budget — or that the corpus left no time to
  match by meaning at all, which is a different sentence from a timeout.


## What shipped, measured

| | answer reaches her | confident answers to unanswerable questions |
|---|---|---|
| before | 6 of 20 | 6 of 6 |
| after the mechanical work | 8 of 20 | 0 of 6 |
| with the embedder | **12 of 20** | 0 of 6 |

The mechanical half, each measured on its own so the commit could say what
bought what: chunking at the `## HH:MM` boundaries 6 → 9 and the ceiling
7 → 11; stopwords and stemming moved the headline not at all (reported as
a finding, not quietly kept) though it raised the ceiling and killed a
false positive; the derived relevance floor cost two answers and bought
the whole of decision 1; a wider excerpt 7 → 8.

Then the vocabulary gap, which no word-matching method can bridge: seven
questions where the word simply is not in the notes. Local embeddings
through ollama, cached by a hash of the exact text, cosine over the whole
corpus because it is a few dozen chunks. Nova pulled the model herself.

**The live walk, 2026-09-10.** Every one of these has the lexical half
ranking nothing and the semantic half ranking first:

- "how much graphics memory does my machine have?" → the note that says
  24GB VRAM
- "read me back that short poem about the cold season" → the haiku about
  winter
- "did I ask you to nudge me about anything on a repeating basis?" →
  "remind me every 5 minutes to blink"
- "is there a program on my box for showing folder layouts?" → "using the
  tree application"

## What the honesty machinery caught, which is most of the value

Every problem in this slice was found by the code reporting its own
limits, not by reading it:

- The first live query said the semantic half did not run and named the
  reason: the embedder did not answer in 1.5 s. Timed directly: the first
  call after a pull costs 605 ms and warm calls 8 ms — but a genuinely
  cold load is 1,444–1,728 ms, so the budget was wrong.
- The boot pass said it embedded 16 of 75 units and stopped, because a
  whole-pass budget cannot embed a corpus.
- Recall then refused semantic matching entirely, with the best sentence
  in the feature: nothing is embedded, so it cannot tell a real
  resemblance from the ordinary resemblance between any two notes.
- A later session found one commit was a TORN SNAPSHOT — the truncation
  fix present, nothing calling it — by extracting that commit's tree and
  running it, rather than reading the diff.
- And the embedder had been silently truncating at 2,048 tokens, so an
  11 KB exchange was embedded from its head while recall went on saying
  no note resembled the question.

The review then found six more of the same species, the worst being that a
vector of the wrong WIDTH counted as embedded for ever: the day the model
changes, every vector is uncomparable, the pass logs "finished, 0
embedded", and semantic recall is permanently dead while every log line
reads healthy.

## Carries

- **Distillation is not built** (decision 2). Memory is still 99% raw
  transcript with one hand-saved note in twelve days. Retrieval over
  transcript is retrieving transcript, and 12/20 is where that ceiling
  sits. This is the highest-value remaining work in memory.
- **"What did we talk about" still searches** (decision 3). It is a
  request for recent history, not a query.
- **The absent-answer set is imperfect on his real corpus**: "cat" appears
  twice, from `cat` shell commands in a transcript, so the lexical half
  legitimately matches it.
- The query budget only visibly moves past roughly 8,000 units; the
  per-unit ranking term exists but is untested at that scale.
