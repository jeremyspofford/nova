# S40b final fix wave — the complete list (one dispatch)

Base: 9927da34 (slice/s40b; full core 4,375 passed). Details and verifier reproductions: final-review.md (same dir).
Authority: docs/plans/rebuild/s40b/design-verdict.md; ledger rulings in progress.md.

## Two directives that govern every item
D1. PREFER NARROWING. Precision is the product: when an honest sentence is corrected, the fix REMOVES the fire (a cut, an anchor, a skipped shape), and adds cleverness only where no narrowing works. If a narrowing costs a MUST_FIRE that is a constructed sentence (not a real walk sentence), say so and prefer the narrowing; the three REAL walk turns' FALSE sentences must still fire.
D2. NO REGEX MAY BACKTRACK CATASTROPHICALLY. Audit EVERY regex added in 26e942c1..HEAD (guards.py, chat.py) for nested/overlapping quantifiers; use single-char classes inside starred alternations, or possessive/atomic groups (Python 3.12 supports (?>...) and *+ ++). Add a timing pin per risky regex: a 200-char adversarial whitespace/padding input returns in < 50 ms.

## A. Confirmed by the final review (must fix) — see final-review.md 1..12
A1 CRITICAL ReDoS in _IN_USE_BADGE / _IN_USE_BEFORE_GAP / _IN_USE_LABEL_ENDS (padded table row hangs core). Fix + D2 audit + timing pins incl. the 20-wide table row and a 60-space row.
A2 _NOT_CURRENT knows only "check": add verified/confirmed/looked at/re-read/run <read tool>/unverified/last known/most recent reading/may no longer hold/N min ago/when I last looked; derive the tool-name alternative from the machine read tools. Pin every sentence in final-review #2 as MUST_NOT (one through _regen_rejected_by).
A3 The history stamp's own wording ("a record of that moment, not of now", "from readings taken then") must count as not-current in the state guard (derive the phrase from the stamp constant, never duplicate it).
A4 Attribution to his notes/journal is not her claim: "Your note says", "The notes say", "According to/Per your notes", "From your notes:" cut served/memory/state claims.
A5 A fronted scope ("From your phone,", "Off the tailnet,", "Outside your home network,") limits the outage state — cut.
A6 A bare "no model was needed/used/involved." about a timer/reminder/other subject is not about THIS reply — anchor _NO_MODEL to this reply/answer/response or to a first-person subject; pin "Timers run on their own; no model is needed." etc.
A7 _MEMORY_DOWN only when the memory noun is the SUBJECT (not the object of a preposition / partitive: "search in the memory service", "part of the memory service").
A8 Denial frames ("It's not that X", "Nothing says X", "It isn't the case that X") are not her assertion.
A9 _claim_redirect: when a state (machine) redirect actually READ the machine but the regeneration is rejected by served_claim/memory_claim, do not persist the stale "I did not check hub" correction as if nothing was read — the turn's spans show the read; save a correction that is TRUE for the final state (see final-review #9 for the verifier's reproduction).
A10 A preposition lead ("on/at/from/via") must not bind a machine that is only the object of a preposition as the copula's subject ("X on hub is not answering" is about X).
A11 served_claim/memory_claim are APPEND-class; they must NOT be in mechanical_guard_fired in a way that disables completion/offer/bare-intent handling for the same reply — keep those handlers running (see final-review #11).
A12 A history attribution or retraction placed AFTER the claim ("(from my last answer)", "(incorrect)", "— this was wrong", "(outdated)") cuts served/memory claims as it does for machines.

## B. T4 breaker adjudication (ledger)
B1 OPEN-1 (false-correction direction): the doubt alternative allows an optional subject pronoun between if/whether and "still" — pins "From my previous answer (if it still holds):", "…(whether that still holds I can't say):".
B2 OPEN-2 (missed-lie direction): negated-sameness heads ("No change:", "No changes:", "Nothing has changed —", "Nothing new —", "No update(s):") are NOT history-label heads — pins across state/served/memory (they must FIRE).

## C. Ruled minors (ledger T1-T3 + final-review minors)
C1 "while" clause-initial is a hedge in the machine branch; an -ly lead word only when it starts the clause ("family hub" must not pass).
C2 inference_health (and any tool that reads the gateway engine list) counts as a read of a machine — derive the read set (e.g. a Tool attribute or registry-derived set), pin it equal to the registry.
C3 No-model claim with a round but no served_by header: silent (verdict §4 MUST_NOT wins).
C4 The claim side of _same_model: "ollama:<tag>" aliases the builtin (history keeps that name) and a quantization suffix (-q4_K_M etc.) is stripped — no pedantic corrections of the right model.
C5 A parenthetical after a memory outage state ("(by design)") limits it; 'down' gets the same `\s*\(` anchor as the other outage words.
C6 Replace the inspect.getsource order pin (test_the_vetting_runs_the_new_checks_in_the_turns_order) and the order-by-started_at eval pin with behavioural pins.
C7 Strip a leading stamp-shaped bracket at the persist boundary (_persist_assistant) — she may copy a history stamp into her reply; pin it.
C8 thread_seed stamps the room's parent message the same way history does.
C9 _RECORD_KINDS derived from scheduler.MODEL_TURN_KINDS.
C10 Correct the ACCEPTED_MISS label about b02a5694 (it DID have an unasked read) and the eval case comment claiming it reproduces b02a5694 "exactly".
C11 Markdown strikethrough (~~…~~) is not her claim — blank struck spans before matching.
C12 served_claim/memory_claim are judged on the FINAL text after a consent/state/listing redirect replaced it, not the original prose.
C13 _SERVING_ADVERB derived structurally (a tuple of adverbs), not by string surgery on _STATE_ADVERB.
C14 MACHINE_REDIRECT_NOTE ("Checking the machine now…") only when the regeneration actually read the machine.
C15 A memory_* call refused before it reached memory (schema/argument/live-source refusal) does not count as "a memory tool failed".
C16 memory_claim: general statements introduced by subordinators missing from _STATE_HEDGE (list them in final-review minors) are hedges.
C17 The eval predicate detail must not say "has 0 span(s)" when unasked spans exist — say "0 of hers (N unasked)".
C18 A test that recomputes the implementation's own expression (test_a_live_reading_tool_is_ephemeral_and_reads_only) pins a named list instead.

## Carry (do NOT do): stamp char budget vs HISTORY_CHAR_BUDGET (measure first); the stamp-based replacement of the history-label machinery if the tail keeps growing.

## Verification (required, in the report)
V1 TDD per item; full core suite once at the end.
V2 REAL-TRAFFIC PRECISION: run state_claim_check / served_claim_check / memory_claim_check (and stack_claim_check) as pure functions over (a) every eval_runs.detail->>'reply' with its turn's turn_spans, and (b) every live assistant message with its turn_spans, read READ-ONLY from docker exec nova-postgres-1 psql -U postgres -d nova_core (the verdict measured 649 replies: the guards fired on exactly b851aa91, b02a5694, 60834ccf and only on FALSE sentences). Report the fire count and list every fire by turn id with the phrase; any fire outside those three turns must be examined and either fixed (a false correction) or shown to be a real false claim. Keep the probe script in the session scratchpad; commit NOTHING read from the DB (his notes and chat content stay out of the repo).
V3 D2 timing pins green.
