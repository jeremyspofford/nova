# S40b final review — confirmed findings (fix wave input)

## 1. [guards] CRITICAL — services/core/app/guards.py:6094-6110 (_IN_USE_BADGE, _IN_USE_BEFORE_GAP, _IN_USE_LABEL_ENDS), reached from _in_use_ref:6234

**Defect:** Catastrophic regex backtracking. `(?:\s+|\(...\)|SIZE|[chars]|️)*` puts `\s+` inside a starred alternation, and _IN_USE_SIZE has its own inner `\s*`. When `fullmatch` fails, every way of splitting each whitespace run gets tried, so the cost grows exponentially. served_claim_check runs synchronously inside the async `_run_turn` (chat.py:4540) and again in `_regen_rejected_by`, on every chat or eval turn that has a served round. It has no timeout, and the fail-open try/except does nothing against a CPU hang.

**Failure scenario:** An honest reply containing a padded markdown table row. Measured through guards.served_claim_check with spans [llm_call served_by=hub:qwen3:8b], purpose=chat:
- `| qwen3:8b             | 4.9 GB               | loaded, in use       |` (columns 20 wide) takes 15.7 s;
- columns 18 wide take 0.97 s, 16 wide take 0.06 s: about x16 for every +2 of column width, so 22 wide is about 4 min and 24 wide about 1 h.

The trigger is a model ref, then a whitespace run, then any word that is not a badge ("loaded"), then an unnegated in-use marker. That shape is common in model tables. The label path fails the same way: `qwen3.8:27b ✅ in use: qwen3:8b` followed by 22 spaces and `idle` grows x4 per 2 spaces. Meanwhile core's event loop is blocked, stalling every conversation, health checks and the eval runner.

**Fix:** Make the repetition unambiguous:
- inside the alternation, use single-character `\s` instead of `\s+`, and drop SIZE's inner `\s*` overlap; or
- use possessive/atomic groups (`(?:...)*+`, Python 3.11+) in _IN_USE_BADGE, _IN_USE_BEFORE_GAP and _IN_USE_LABEL_ENDS.

Add a timing pin: a 60-space padded table row returns in under 50 ms. Audit the other new starred alternations the same way.

**Verifier:** I reproduced the claim exactly at 9927da34. It is not in the ledger: progress.md has no entry for backtracking, ReDoS, timing or performance.

**Table-row path.** I ran guards.served_claim_check on `| qwen3:8b<pad> | 4.9 GB<pad> | loaded, in use<pad> |` with spans [llm_call served_by=hub:qwen3:8b purpose=chat] and purpose="chat". The result was None every time, so the reply stays honest and uncorrected. Timings by column width:

| Width | Time |
|---|---|
| 12 | 0.000 s |
| 14 | 0.004 s |
| 16 | 0.064 s |
| 18 | 1.004 s |
| 20 | 15.56 s |

That is x16 for every +2 of width, so 22 wide is about 4 min and 24 wide about 1 h, as claimed.

**Isolating the regexes.** `_IN_USE_BEFORE_GAP.fullmatch("qwen3:8b"+" "*n+"loaded, ", 8, end)` takes 0.004, 0.016, 0.064 and 0.24 s for n = 16, 18, 20 and 22. That is x4 per 2 spaces, and the table row's x16 is the product of its two whitespace runs. `_IN_USE_LABEL_ENDS.fullmatch(" "*n+"idle")` also grows x4 per 2 spaces.

**Label path.** Through served_claim_check, `qwen3.8:27b ✅ in use: qwen3:8b` followed by n spaces and `idle` takes 0.001, 0.003, 0.01, 0.042 and 0.178 s for n = 14 to 22 (x4 per 2 spaces). Extrapolated, 30 spaces is about 45 s and 40 spaces is hours.

**Cause.** `(?:\s+|...|SIZE|...)*` has a starred alternation whose `\s+` can split a whitespace run in 2^(n-1) ways. `_IN_USE_SIZE`'s inner `\s*` adds more ambiguity. When fullmatch fails, every split is tried. All three patterns (`_IN_USE_SIZE`/`_IN_USE_BADGE`, `_IN_USE_BEFORE_GAP`, `_IN_USE_LABEL_ENDS`) are new in 26e942c1..9927da34.

**Reach.** chat.py:4542 calls served_claim_check synchronously inside `async def _run_turn` (line 3684), wrapped only in try/except, with no timeout and no to_thread. The call at chat.py:3419 inside `_regen_rejected_by` is also synchronous. Core runs as a single uvicorn process (Dockerfile CMD, no --workers), so a hang blocks every conversation, health checks and eval turns.

**Trigger.** A plausible honest reply is enough: a padded markdown model table, which is exactly the status question S40b targets. It needs no adversarial input.

**Severity.** Critical. It is an unbounded CPU hang of the only chat service, caused by honest model output. It fires only on padded or long-whitespace lines, but the growth is exponential and nothing bounds it.

**Fix.** The proposed fix is sound: use single-character `\s` in the alternation and remove the `\s*` overlap, or use possessive/atomic groups. Add a timing pin for a 60-space padded row.

## 2. [guards] IMPORTANT — services/core/app/guards.py:2972 (_NOT_CURRENT), used by _machine_state_claim:3531 and _not_a_current_reading:3475

**Defect:** The not-current cut only knows the verb "check". The machine nudge (chat.state_redirect_nudge) tells her to "say plainly that you did not check", but the other plain ways of saying so are not recognised: verified, looked at, re-read, confirmed, "run machine_status", "unverified". Neither are common staleness labels: "last known", "most recent reading", "may no longer hold", "(20 min ago)", "(old reading)", "When I last looked". The guard is REPLACE-class, so each of these honest replies is replaced. In the redirect path, `_regen_rejected_by` also refuses the regeneration by name.

**Failure scenario:** Spans [HUB_SERVED], purpose=chat, run through state_claim_check. Each of these fires on hub:
- `I have not run machine_status this turn. The last reading I have:\n- Name: hub\n- Last Reported: 2026-09-19T05:15:39+00:00`
- `I haven't verified hub this turn. The last reading I have:\n…`
- `I haven't looked at hub this turn. …`
- `Unverified this turn. …`
- `hub (last known status):\n- Serving: On\n- Last Reported: …`
- `hub's most recent reading:\n- Last Reported: …`
- `…\n- Last Reported: <ts> (20 min ago)`
- `…\n\nI haven't re-read hub this turn.`
- `This reading was taken at 05:15 UTC; it may no longer hold.`
- `The models run on hub. When I last looked, at 05:15 UTC:\n- Serving: On\n- Last Reported: …`
- `I haven't verified it this turn, but hub is switched off.`

**Fix:** Widen _NOT_CURRENT to cover:
- `(?:have|has|did)(?:\s+not|n['’]t)\s+(?:re-?)?(?:check|verif|confirm|look(?:ed)?\s+at|read|run|query)\w*` and `unverified|not\s+(?:re-?)?(?:verified|read|confirmed)`;
- `last\s+known`, `most\s+recent\s+reading`, `may\s+no\s+longer`;
- `mins?\s+ago` and `last\s+(?:looked|read|saw)`.

Derive the tool-name alternative from _MACHINE_READ_TOOLS. Pin every sentence above as MUST_NOT, including one run through _regen_rejected_by.

**Verifier:** The claim reproduces. The ledger does not cover it: it records only T1's "I did not check" item, which was fixed by adding the "check" forms to _NOT_CURRENT. None of the final-wave items (the "while" hedge, "family hub", inference_health, OPEN-1, OPEN-2 and the rest) widens the not-current vocabulary.

**How I tested.** I ran state_claim_check(reply, [HUB_SERVED], [], purpose="chat") at 9927da34, using HUB_SERVED from tests/test_state_guard.py. These all fire on hub:
- "I have not run machine_status this turn. The last reading I have:\n- Name: hub\n- Last Reported: <ts>"
- the same block after "I haven't verified hub this turn."
- the same block after "I haven't looked at hub this turn."
- the same block after "Unverified this turn."
- "hub (last known status):\n- Serving: On\n- Last Reported: <ts>"
- "hub's most recent reading:\n- Last Reported: <ts>"
- a block whose reading line ends "<ts> (20 min ago)"
- a block followed by "\n\nI haven't re-read hub this turn."
- "The models run on hub. When I last looked, at 05:15 UTC:\n…"
- "I haven't verified it this turn, but hub is switched off." (phrase 'hub is switched off')

Two things confirm the cause is the vocabulary itself. The matching controls with "checked" are silent ("I haven't checked hub this turn. <block>", "I haven't checked it this turn, but hub is switched off."). "(20 minutes ago)" is also silent, because _PRIOR_TIME has "minutes ago" but not "min ago".

**One inaccuracy in the claim.** "This reading was taken at 05:15 UTC; it may no longer hold." is silent on its own, because it names no machine. It does fire once a hub reading block comes before it, and so does "hub last reported at 05:15 UTC; it may no longer hold." So the gap is real there too.

**Regeneration.** _regen_rejected_by calls exactly state_claim_check(corrected, turn.spans, device_names, purpose=_purpose_of(turn)) (chat.py:3426-3432). A regeneration that follows the nudge's "say plainly that you did not check" in words other than "check" is therefore refused as "state_claim".

**Caveats that limit the harm.**
- _NOT_CURRENT is copied verbatim from the authoritative spec (design-verdict.md:86). This is a precision gap in the spec, not a departure from it.
- The machine correction text happens to be true for these replies (she did not check, and what she said is not current). It is a redundant "Correction:", not a contradiction.
- A redirect that actually runs machine_status leads to a real reading.

**Why I keep "important".** The ledger treated T1's "honest 'I did not check' corrected + regen refused" as important, and ruled "precision is the product" for REPLACE-class false fires. These labels ("last known", "most recent reading", "haven't verified") are the natural honest answers to the replayed-reading scenario the guard exists for.

**Warning on the proposed fix.** _NOT_CURRENT is a sentence-level cut (guards.py:3538 `continue`). The bare `run|read` alternatives, and `not\s+read`, would silence real lies such as "h

## 3. [guards] IMPORTANT — services/core/app/guards.py:2972 (_NOT_CURRENT) vs services/core/app/chat.py:717 (_LIVE_READING_MARKER)

**Defect:** The two halves of the design disagree:
- The history stamp (T3) tells her that b851aa91's row is "[written at … from readings taken then; a record of that moment, not of now]".
- The state guard (T1) does not treat that same wording as not-current.

So when she labels the replayed reading exactly the way the stamp labelled it to her, the reply is REPLACED as an unchecked current reading. This also happens when she copies the stamp itself above the block, which the ledger already expects small models to do.

**Failure scenario:** Spans [HUB_SERVED], purpose=chat. Each of these fires with phrase `- Last Reported: 2026-09-19T05:15:39+00:00`:
- `This is a record of that moment, not of now:\n\n### Machine Status\n- Name: hub\n- Serving: On (always on)\n- Last Reported: 2026-09-19T05:15:39+00:00`
- `Written at 05:15 UTC from readings taken then — a record of that moment, not of now:\n\n<same block>`
- `<block>\n\n(A record of 05:15 UTC, not of now.)`
- `<block>\n\nThese readings were taken then, not now.`

The stamp is also not read when it sits above a heading, because _reading_context only takes a lead-in ending in ":".

**Fix:** Add the stamp's own vocabulary to the not-current cut, derived from the marker constants rather than retyped. For example, share a `RECORD_OF_THEN` phrase between chat._PAST_TURN_MARKERS/_LIVE_READING_MARKER and guards: `record\s+of\s+(?:that|this)\s+moment|not\s+of\s+now|taken\s+then`. Pin one test that feeds `chat._LIVE_READING_MARKER.format(when=…)` plus the walk block through state_claim_check and expects None.

**Verifier:** I reproduced this exactly at 9927da34 by calling guards.state_claim_check(text, [HUB_SERVED], [], purpose="chat"), with HUB_SERVED built the way tests/test_state_guard.py:556 builds it. All four scenario texts return StateClaim(device="hub", phrase="- Last Reported: 2026-09-19T05:15:39+00:00"):
- the lead-in "This is a record of that moment, not of now:"
- the lead-in "Written at 05:15 UTC from readings taken then — a record of that moment, not of now:"
- "(A record of 05:15 UTC, not of now.)" after the block
- "These readings were taken then, not now." after the block

The stamp itself also fires. I built it with chat._LIVE_READING_MARKER.format(when=...), and it fires in every position I tried: above the heading with a blank line, directly above the heading, directly above a run with no heading (the stamp is then part of the run's own context), and after the block.

Controls:
- "I have not checked hub this turn." after the block returns None.
- "This is not a current reading:" above the block returns None.
- "From history, a record of that moment:" returns None.

The root cause is vocabulary. _NOT_CURRENT (guards.py:2972) matches "not (a )?(current|fresh|live)", "stale", "unchecked" and similar, but not "not of now", "record of that moment" or "taken then". _PRIOR_TIME and _REPORTED miss these texts too. The claim's secondary point also holds: a stamp above a heading is outside _reading_context, because the lead-in is only read when it ends in ":" and the stamp ends in "]". So a fix needs both the vocabulary and the context change.

The consequence path is real. chat.py:4591 sends a machine StateClaim through _claim_redirect, and her honest reply is replaced by the redirect note "Checking the machine now instead of describing it unchecked." That note is a false description of a reply she labelled correctly. If the redirect was already spent, the correction is appended instead.

Not already ledgered. progress.md mentions stamp copying only in T3 ruling (a), which strips a leading stamp-shaped bracket at the persist boundary. It says nothing about the guard's not-current cut ignoring the stamp's own wording. The T4 adjudication caps the history-label machinery (_HISTORY_*), not _NOT_CURRENT.

Caveat for the fix: once ruling (a) strips a copied leading stamp at persist, the guard should not honour that same stamp on the pre-strip text. Otherwise the stored reply becomes an unlabelled replay. Either strip before the guard runs or exclude a leading stamp-shaped bracket from the cut. This caveat affects only the copied-stamp sub-case, not her own phrasings.

Severity stays important. It is the false-correction direction the ledger treats as a defect. It is the same class as T1's important finding (her honest "I did not check" was corrected) and T4's OPEN-1, which was adjudicated real. It is also the likeliest phrasing, because it is the exact wording the system shows her. It also breaks the "derived, never hardcoded" rule: the stamp and the cut keep 

## 4. [guards] IMPORTANT — services/core/app/guards.py:6169 (_not_her_claim), 6556-6566 (memory_claim_check), 3548 (_machine_state_claim), 653 (_REPORTED)

**Defect:** Attribution to his notes or journal is not a cut:
- `_REPORTED` has no plural "say" and no possessive subject ("Your note says", "The notes say").
- `_not_her_claim` knows only her own earlier reply.
- "According to/Per your notes" and "From your notes:" are unhandled.

Verdict §9 records that his notes carry exactly these false lines (qwen3.8:27b as current; "No model was needed…"), and recall hands them to her whenever he asks about models. So the honest way to cite, and often retract, a note earns a correction and keeps the turn out of memory. The pre-existing stack_claim has the same gap and is REPLACE-class.

**Failure scenario:** Served, with spans [llm hub:qwen3:8b]:
- `Your notes say the current model is qwen3.8:27b, but that's out of date — hub:qwen3:8b answered this turn.` fires sentence/qwen3.8:27b.
- The same happens for `An older note says qwen3.8:27b is the current model; this reply actually came from hub:qwen3:8b.`, `From your notes: qwen3.8:27b is the current model. That's stale: …`, `According to your notes, the current model is qwen3.8:27b — but hub:qwen3:8b wrote this reply.` and `A note of yours reads: no model was needed for this calculation. That's false; a model wrote every reply.` (no_model).

Memory, with recall hits=5:
- `Yes. Your older note says the memory service is unreachable, but that's out of date.` fires.
- So do `Your notes say the memory service is unreachable, but it answered this turn.` and `According to your notes, the memory service is down.`

Machine, REPLACE:
- `Your note says: hub is offline.`, `Per your notes, hub is offline.` and `According to my notes, hub is switched off.` fire.

Stack, REPLACE:
- `Your notes say the model is down, but it answered.` fires.

**Fix:** Add a record-attribution cut shared by the three guards' prefix check, in _not_her_claim and the machine branch's prefix. It covers:
- `\b(?:your|my|his|the|an?|one|older|old)\s+(?:[\w-]+\s+){0,3}?(?:notes?|journal|entry|entries|records?)\s+(?:say|says|said|read|reads|list|lists|claim|claims|call|calls|mark|marks)\b`;
- `according\s+to|per\s+(?:your|my|the)`;
- a `From your notes:` heading.

Alternatively, fix `_REPORTED` (plural "say", possessive subjects) and let every guard inherit it. Pin the examples above, and pin that `The notes say X — and that is still true.` still fires.

**Verifier:** I reproduced the claim at 9927da34 by calling the pure guards directly. It is not in progress.md. The ledger's T4 breaker items cover only her own earlier reply ("From my previous answer (if it still holds)" and the "No change:" headings), not his notes or journal.

**served_claim_check** (spans = one llm_call with served_by hub:qwen3:8b, purpose chat). All five scenario sentences fire:
- "Your notes say the current model is qwen3.8:27b, but that's out of date — hub:qwen3:8b answered this turn." gives sentence/qwen3.8:27b. The appended text is "Correction: this reply was written by hub:qwen3:8b … not by qwen3.8:27b.", a correction of a reply that had already said exactly that.
- "An older note says …", "From your notes: …" and "According to your notes, …" each give sentence/qwen3.8:27b.
- "A note of yours reads: no model was needed …" gives no_model.

**memory_claim_check** (recall hits=5). All three sentences fire, including "Yes. Your older note says the memory service is unreachable, but that's out of date."

**state_claim_check, machine branch** (REPLACE class). All three fire:
- "Your note says: hub is offline."
- "Per your notes, hub is offline."
- "According to my notes, hub is switched off."

Two retracting variants also fire and get REPLACE-corrected with "I did not check hub this turn …":
- "Your note says: hub is offline. That's out of date — hub served this reply."
- "Per your journal, hub is offline — that's no longer true."

**stack_claim_check.** "Your notes say the model is down, but it answered." fires. This guard is unchanged from 26e942c1 and has no _REPORTED cut at all ("You said the model is down." fires too). That part is pre-existing and outside this slice.

**Root cause, confirmed by reading the code:**
- `_REPORTED` needs the subject you/he/she/they/we/someone/"the X", followed by said/says/…. "Your notes/note/journal" never matches, because `you\s+` fails on "Your". Plural "say" is missing, so "The note says" is cut but "The notes say" is not.
- `_not_her_claim` covers only epistemic frames, her retraction verbs, her-earlier-reply history labels, and "I said" + retraction. `_HISTORY_HEAD`'s "according to" is tied to `_HER_EARLIER_REPLY`.
- The codebase already treats this as reported speech elsewhere. The delegation guard has `_ACCORDING_TO` (guards.py:4619, :4806), pinned by test_guards "reported: according to". The new guards did not adopt it.
- Verdict §9 records that his notes carry exactly these lines and that recall surfaces them, so an honest reply that cites and retracts a note is a likely shape in the model-question walk.
- The proposed pin `The notes say X — and that is still true.` fires today.

**Severity: important.** It is in the false-correction direction, which the ledger treats as a defect. It mirrors earlier "important" items: T1's honest limits being REPLACE-corrected, and T2's _NO_MODEL firing on generic statements. The served and memory guards are APPEND class, so the prose stays, but the turn is sti

## 5. [guards] IMPORTANT — services/core/app/guards.py:2897 (_OUTAGE_ANCHOR) / 3551-3556 (_machine_state_claim assertion loop); 6452 (_MEMORY_OUTAGE_ANCHOR)

**Defect:** The anchor that stops a limited state from counting as an outage only looks at what comes AFTER the state word. Two kinds of limit get through:
- a scope phrase fronted before the subject ("From your phone,", "Off the tailnet,", "Outside your home network,", "Publicly,");
- a limit placed after an anchoring comma or "right now" ("…, as far as your phone is concerned", "right now from your phone", "for chat models on weekends").

The T1 ruling fixed only the trailing "from X" form. "hub" is the builtin engine name on every install (gateway migration 009 CHECK), and questions about reaching it off the tailnet are routine.

**Failure scenario:** Spans [HUB_SERVED], purpose=chat. Every one of these REPLACE-fires on hub:
- `Off the tailnet, hub is unreachable.`
- `Outside your home network, hub is unreachable.`
- `From your phone, hub is unreachable right now — you're off the tailnet.`
- `For your phone, hub is unreachable now.`
- `To the outside world, hub is offline.`
- `From the internet, hub is not reachable.`
- `Publicly, hub is unreachable.`
- `hub is offline, as far as your phone is concerned.`
- `hub is disconnected, from the public internet's point of view.`
- `hub is unreachable right now from your phone, because you're off the tailnet.`
- `hub is switched off for chat models on weekends.`
- `hub is offline, by schedule, overnight.`

Memory, APPEND: `From outside the tailnet, the memory service is unreachable.` fires.

**Fix:** 1. In the machine and memory branches, skip a claim whose clause prefix is a scope adverbial ending in a comma: `^\W*(?:from|off|outside|for|to|over|across|beyond|via|through|within|inside|on)\b[^,]{0,40},\s*$`, or a single `\w+ly,` scope adverb such as "Publicly," or "Remotely,".
2. Stop a comma, dash or "right now" from satisfying the anchor when a limit follows it: `(?:as\s+far\s+as|from|for|to|on|at|during|per|by|over|overnight|outside|except|only)\b`.
3. Pin all of the above as MUST_NOT, and keep `hub is offline, so I can't run local models.` as MUST_FIRE.

**Verifier:** I reproduced the claim exactly at 9927da34 by calling state_claim_check(text, [HUB_SERVED], [], purpose="chat"). HUB_SERVED is built the way tests/test_state_guard.py builds it (an llm_call span, served_by hub:qwen3:8b, purpose chat).

**Machine branch.** All 12 listed sentences fire. Each claim's phrase is just the state words ("hub is unreachable", "hub is offline", "hub is not reachable", "hub is disconnected", "hub is switched off"). Controls:
- "hub is unreachable from your phone." stays silent, because the T1 `(?!\s+from\b)` fix covers it.
- "hub is offline." and "hub is offline, so I can't run local models." fire, as they should.

**Memory branch.** I passed a memory_recall span with hits=5 and purpose chat:
- "From outside the tailnet, the memory service is unreachable." fires.
- "Off the tailnet, the memory service is unreachable." fires.
- "The memory service is unreachable, as far as your phone is concerned." fires.
- The trailing form "The memory service is unreachable from outside the tailnet." stays silent.

**Cause.** _machine_state_claim checks the clause prefix only through _lead_ok, _state_prefix_blocks and _history_framed. None of them treats a fronted scope adverbial as a limit. _OUTAGE_ANCHOR and _MEMORY_OUTAGE_ANCHOR look only at what follows the state word. Any comma, dash, "right now" or "for chat models" there satisfies the anchor, whatever limit comes after it.

**Not already ledgered.** The T1 ruling in progress.md fixed only the trailing "from X" form. It pinned "hub is unreachable from your phone" and "hub is not reachable from outside the tailnet" as MUST_NOT, and accepted the opposite-direction miss ("hub is unreachable from here" slips). Nothing in progress.md, the design verdict or the test files covers:
- a fronted scope phrase ("Off the tailnet,", "From your phone,", "Publicly,");
- a limit after an anchoring comma or "right now" ("as far as your phone is concerned", "right now from your phone").

The final-wave "while" hedge minor is a different case.

**Severity: important stands.** This is the same kind of false correction as the trailing form the controller already ruled FIX. The ruling says precision is the product and applies "beyond the corpus". The correction REPLACEs her reply and triggers a regeneration, and on hub it adds "hub answered this turn…", which contradicts a true statement about reach. The most natural cases are real phrasings of the ruled sentence with the scope moved to the front: "From your phone, hub is unreachable", "Off the tailnet, hub is unreachable", "hub is unreachable right now from your phone, because…". A few of the listed cases are contrived ("For your phone,", "offline, by schedule, overnight").

**The proposed fix is too broad as written.** It would let present-tense lies through. I checked each of these: it fires today, and fix 1 would skip it:
- "For now, hub is offline." ("for now" is itself one of the outage anchor's endings in _OUTAGE_ENDS)
- "To be clear, hub is offline

## 6. [guards] IMPORTANT — services/core/app/guards.py:6027 (_NO_MODEL) / 6313-6318 (_served_claims no_model loop)

**Defect:** The bare past "no model was needed/used/involved." at the end of a sentence counts as a claim about THIS reply whatever the sentence is about. So an honest statement that a timer or reminder ran without a model gets "Correction: a model wrote this reply — hub:qwen3:8b." and the turn is kept out of memory. The verdict's corpus plainly means these to be MUST_NOT ("No model was needed for that step — the timer ran on its own.", "I didn't use a model for the timer."), and chat.py itself says a reminder is "delivered by code, with no model". Only the "for that step" wording is protected.

**Failure scenario:** Spans [llm hub:qwen3:8b], purpose=chat. Each fires no_model:
- `The timer ran on its own — no model was needed.`
- `The reminder fired on its own; no model was involved.`
- `That reminder was sent by the scheduler, so no model was used.`
- `Your 9:00 reminder went out by itself. No model was involved.`
- `The scheduler delivered it without me. No model was needed.`
- `The file was copied by the workspace tool; no model was used.`

**Fix:** Fire the tail-less past form only when "no model" opens its sentence (optionally after "So," or "And"). Also require that neither that sentence nor the previous one on the line names another agent of the action: `timer|reminder|schedul\w*|on\s+its\s+own|by\s+itself|automatically|the\s+\w+\s+tool|without\s+me`. Pin the six sentences above, and pin that `17 × 23 = 391. No model was needed.` and the walk's 60834ccf still fire.

**Verifier:** I reproduced the claim at HEAD 9927da34 and could not refute it. I called guards.served_claim_check(text, [llm_call served_by=hub:qwen3:8b purpose=chat], purpose="chat"). All six scenario sentences return shape=no_model with the text "Correction: a model wrote this reply — hub:qwen3:8b.":
- "The timer ran on its own — no model was needed."
- "The reminder fired on its own; no model was involved."
- "That reminder was sent by the scheduler, so no model was used."
- "Your 9:00 reminder went out by itself. No model was involved."
- "The scheduler delivered it without me. No model was needed."
- "The file was copied by the workspace tool; no model was used."

A seventh honest sentence also fires: "No, I didn't write it. Your 9:00 reminder is delivered verbatim by the timer, so no model was involved."

The controls behave as the claim says. "17 × 23 = 391. No model was needed." and the 60834ccf wording fire. The two verdict MUST_NOT sentences stay silent: "No model was needed for that step — the timer ran on its own." and "I didn't use a model for the timer."

Cause: _NO_MODEL (guards.py:6027-6031) lets the past form "was needed/used/required/involved" fire whenever it ends a sentence, with no tail required. Nothing in the no_model loop (6313-6318) looks at what the sentence is about. This contradicts the code's own header comment at 6013: "about THIS answer, never about a pull, an embedding, an image, or a step a timer ran." It also goes against the verdict's MUST_NOT set, which keeps timer statements as honest.

Consequences, checked in chat.py:
- The correction is appended to the reply (4546-4554).
- The turn is kept out of memory (4880, 5184).
- A redirect regeneration containing such a sentence is refused (3417-3419).

This is realistic: create_timer ships, and a reminder "delivers `text` verbatim", so "did you write that reminder?" has an honest answer that trips the guard.

Not ledgered: progress.md records only the T2 review item "_NO_MODEL fires on generic statements". That was fixed by limiting the bare form to the past tense. The past-tense timer case was instead pinned on purpose as STILL_FIRE: "Reminders fire by themselves — no model was involved." sits in REVIEW_ROUND_1_STILL_FIRE in tests/test_served_guard.py, per task-T2-report.md §2. progress.md has no ruling or accepted miss for it. That pin is the one the fix would need to reverse.

Severity: important. It is the same false-correction class the T2 review ranked important, in a feature that ships (timers and reminders), and the slice treats a false correction as a defect. Two caveats:
- The correction text is literally true (a model did write the reply), so the harm is the implied accusation, the lost ingest and the refused regeneration, not a false statement.
- The proposed exemption on the previous sentence (e.g. "the \w+ tool") could silence a real lie shaped like 60834ccf, such as "The calculator tool did it. No model was needed." when no tool ran. Whoever fixes it should pin tha

## 7. [guards] IMPORTANT — services/core/app/guards.py:6458 (_MEMORY_DOWN) / 6556-6566 (memory_claim_check)

**Defect:** _MEMORY_DOWN matches the memory noun wherever it sits, including as the object of a preposition or a partitive ("search IN the memory service is unavailable", "Part OF the memory service is unavailable"). The subject of the outage is then something else. That is exactly how she honestly describes a degraded recall: the retrievers_missing turn, the one where the correction itself appends "What did not work this turn". The correction then tells her the service "is not unreachable now", which she never said.

**Failure scenario:** Spans [HUB_SERVED, memory_recall{hits:3, retrievers_missing:"semantic search did not answer within 1.6 s…"}], purpose=chat. Each fires:
- `Semantic search in the memory service is unavailable right now, so notes were matched by keyword.`
- `Part of the memory service is unavailable: semantic search timed out.`
- `The memory service is reachable, though semantic search in the memory service is unavailable right now.`
- `Search on the memory service is unavailable right now.`
- `The vector index of the memory service is offline, so recall used keywords.`

**Fix:** Skip a _MEMORY_DOWN match whose clause prefix ends in a preposition or partitive: `\b(?:of|in|on|from|within|inside|for|to|with|behind|through|via)\s*$`, or `\b(?:part|some|half|piece)\s+of\s*$` before the determiner. Pin the five sentences as MUST_NOT beside the walk sentence, which must still fire.

**Verifier:** The claim reproduces exactly, and the ledger does not already record it. progress.md has only one T2 memory minor, "(by design)" after an outage state, which is a different shape. No existing MUST_NOT pin covers a prepositional or partitive memory noun.

**How I probed.** I called guards.memory_claim_check at 9927da34 with spans [llm_call hub:qwen3:8b, memory_recall{k:5, hits:3, retrievers_missing: DEGRADED}] and purpose="chat".

**What fired.** All five of the claim's sentences fire with the same false text: "Correction: the memory service answered this turn — this turn's recall was read from it — so it is not unreachable now. What did not work this turn: the semantic search did not run…". In every case the phrase is "the memory service is unavailable/offline". Two of them:
- "Semantic search in the memory service is unavailable right now, so notes were matched by keyword."
- "The vector index of the memory service is offline, so recall used keywords."

**Why.** _MEMORY_DOWN (guards.py:6458) has no left context. It matches `the memory service is unavailable` wherever the noun sits, and none of the loop's filters (_state_prefix_blocks, _not_her_claim, _SERVED_SKIP) reads a preposition or partitive before it.

**More sentences that fire:**
- "Some of the memory service is down right now."
- "Semantic search on the memory service is down."
- "Recall from the memory service is degraded: semantic search in the memory service is unavailable."

**Quiet as a control:** "The embedding model behind the memory service is offline" and "The embedding part of the memory service is unavailable right now". The walk sentence still fires.

**Why it is realistic.** chat.py:1935-1962 puts the degraded-recall fact (retrievers_missing) into her prompt, so honest sentences like these are what she would plausibly write in exactly that turn. The appended correction then contradicts an "unreachable" she never said, which is a false correction on an honest reply.

**Severity: important.** The correction is appended, not a replacement. It targets the honest description of the very state the guard's own "What did not work" suffix reports, so it is more than a rare-phrasing minor.

**Caveat on the proposed fix.** Its preposition list is too broad. "Access to the memory service is unavailable right now.", "My connection to the memory service is down." and "The link to the memory service is offline." all fire today, and they are real claims that she cannot reach memory. Skipping on a trailing "to" (or "with") would silence those lies. The skip set should be limited to part-of prepositions and partitives: in, on, of, inside, within, behind, from, and part/some/half of. It should not include to, with, for, via or through. Pin the three access/connection sentences as MUST_FIRE next to the five MUST_NOT pins and the walk sentence.

## 8. [guards] IMPORTANT — services/core/app/guards.py:6128 (_EPISTEMIC_FRAME) / 6169 (_not_her_claim)

**Defect:** Common denial frames are read as her assertion:
- "It's not that X"
- "Nothing says X"
- "It isn't the case that X"

_EPISTEMIC_FRAME covers "not true that" and "false that" only. The served and memory guards therefore correct a reply that denies the very claim they correct. The machine branch escapes only by accident, through its lead-word rule. The memory case bears directly on DoD walk step 5 ("Is your memory service working?").

**Failure scenario:** Memory, with spans [HUB, recall hits=5]:
- `It's not that the memory service is down; recall just found nothing.` fires.
- `Nothing says the memory service is down.` fires.

Served, with spans [llm hub:qwen3:8b]:
- `It's not that qwen3.8:27b is the current model — hub:qwen3:8b wrote this.` fires.
- `Nothing says qwen3.8:27b is the current model.` fires.
- `It isn't the case that qwen3.8:27b is the current model.` fires.

**Fix:** Extend _EPISTEMIC_FRAME with:
- `\b(?:it['’]s|it\s+is|it\s+isn['’]t|it\s+is\s+not)\s+(?:not\s+)?(?:that|the\s+case\s+that)\b`;
- `\b(?:nothing|no\s+(?:sign|evidence|reason))\s+(?:says|suggests|indicates|shows)?\s*(?:that\s+)?$`.

Pin the five sentences, and pin that `It is the case that the memory service is down.` still fires.

**Verifier:** I reproduced the claim exactly at 9927da34 by running the pure guards with PYTHONPATH=. uv run python. Memory used spans [llm_call hub:qwen3:8b with served_by, memory_recall hits=5]. Served used [llm_call served_by=hub:qwen3:8b]. purpose was "chat".

Memory guard (memory_claim_check). Each of these FIRES with phrase "the memory service is down":
- "It's not that the memory service is down; recall just found nothing."
- "Nothing says the memory service is down."
- "It isn't the case that the memory service is down." (the claim did not list this one for memory, but it fires too)

Served guard (served_claim_check). Each of these FIRES as shape=sentence, claimed=qwen3.8:27b:
- "It's not that qwen3.8:27b is the current model — hub:qwen3:8b wrote this."
- "Nothing says qwen3.8:27b is the current model."
- "It isn't the case that qwen3.8:27b is the current model."

Controls behave as expected. "It's not true that X" is silent for both guards, because _EPISTEMIC_FRAME covers it. "It is the case that X" and bare "X" fire.

The ledger does not cover this. progress.md's T4 entries adjudicate only OPEN-1 ("if it still holds") and OPEN-2 (the No change:/Nothing new heading labels), not these denial frames.

The impact is real at the call sites in chat.py (around 4542-4570 and 3419-3423):
- An APPEND-class "Correction: ..." frame follows her true denial.
- The turn is kept out of memory.
- In the regen vetting, a regeneration that uses such a denial is refused as a served_claim or memory_claim.

That is a false correction, the same defect class T4 review round 1 fixed as important (a doubted or denied served/memory claim is not hers). DoD walk step 5 in the plan is "Precision: 'Is your memory service working?' An honest yes, and no memory_claim", so a "Nothing says the memory service is down" reply would fail it. Severity stays important.

I did not verify the aside that the machine branch escapes. With no device_names and only an llm span, state_claim_check was silent even on plain "Hub is offline.", so that probe proves nothing either way.

The proposed FIX is itself defective as written. In its first alternative the "not" is optional after "it's" / "it is": `(?:it['’]s|it\s+is|...)\s+(?:not\s+)?(?:that|the\s+case\s+that)`. So "It is the case that the memory service is down." and "It's that X" would match as denials and go silent. That contradicts the claim's own requirement that "It is the case that ..." still fires. The fix must require the negation for the it's / it is forms, for example `\bit(?:['’]s|\s+is)\s+not\s+(?:that|the\s+case\s+that)\b|\bit\s+isn['’]t\s+(?:that|the\s+case\s+that)\b`. The positive pin must stay.

## 9. [chat-history-livefacts] IMPORTANT — services/core/app/chat.py:3664 (the rejection path in _claim_redirect), with the new served_claim/memory_claim entries in _regen_rejected_by at chat.py:3417-3424

**Defect:** When a state (machine) redirect actually reads the machine but its regenerated reply is rejected by served_claim or memory_claim, the backend saves the original REPLACE correction "I did not check hub this turn — I have no record of doing so". The turn's spans then hold an ok machine_status, so that correction is false. The real reading is thrown away. Both rejectors are APPEND-class: in an original reply the same sentence only gets a correction appended. In a regeneration it throws out the whole reply, reading included, and the correction that replaces it is now untrue. (The device and listing redirects have the same flaw when narration rejects. S40b makes it the likely outcome for machines, because her real machine_status reply carried both false lines.)

**Failure scenario:** DoD walk step 1 if she replays: B02A5694 in a chat turn served by hub:qwen3:8b whose recall answered, with nothing run yet. state_claim fires and the redirect runs. The regeneration calls machine_status (ok, facts hub) and writes a B851AA91-shaped relay: '- `qwen3.8:27b` (16.5 GB) ✅ **Current model in use**' plus the memory line. Probe: chat._regen_rejected_by(B851AA91, turn(spans=[recall, hub round, hub round0, machine_status ok, hub round0], kind='chat'), ...) returns 'served_claim'. With those same final spans, guards.state_claim_check(B02A5694, …, purpose='chat') returns None, so the claim is backed now. The saved row is still '[STATE machine correction]\n\n[served]\n\n[memory]'. Live, the owner sees the machine_status activity frame and then 'I did not check hub this turn'. Because a live read ran, the next turn's history stamps that row '[written at … from readings taken then…]' ahead of 'I did not check hub'.

**Fix:** (a) When the rejecting guard is APPEND-class (served_claim, memory_claim), let the regeneration stand and append that guard's correction, the same way the composition treats an original reply. (b) Before saving any REPLACE correction after a redirect that dispatched calls, re-run the originating guard over the final turn.spans. If the claim is now backed, save a note naming what ran (the _bare_intent_ran_but_unreported_note rule) instead of 'I did not check'. Pin it with a DB test whose redirect regeneration is B851AA91 verbatim.

**Verifier:** The claim holds, and it is not in progress.md. The ledger covers the T1 to T4 review items and the T4 breaker adjudication, but nothing about a redirect regeneration being rejected by served_claim or memory_claim.

I ran the guards directly using the walk's own fixtures from tests/s40_walk.py, with spans shaped the way chat.py records them. The spans were a recall with hits=5, then a chat round served by hub:qwen3:8b. Nothing else had run (ran_a_tool=False).

Before the redirect:
- state_claim_check(B02A5694) fires as a machine claim on hub and returns "Correction: I did not check hub this turn — I have no record of doing so…".
- served_claim_check fires with shape in_use, claimed qwen3.8:27b.
- memory_claim_check fires.

After the redirect, the spans were [recall, round, round0, machine_status ok with facts=[hub checked_now], round0]:
- chat._regen_rejected_by(B851AA91, turn(kind='chat'), …, agents.nova_persona()) returns 'served_claim'.
- state_claim_check(B02A5694, after) returns None, and so does state_claim_check(B851AA91, after). So the state claim is backed once the redirect has run.

In the code, _claim_redirect (chat.py:3647-3664) handles any non-None rejected_by by emitting and returning correction_text with redirected=False. state_redirected therefore stays False. The composition at chat.py:4807-4826 then saves "\n\n".join(state_claim.text, served_claim.text, memory_claim.text). That row says "I did not check hub this turn", but the turn has an ok machine_status span, and the real reading is thrown away. Two more details check out:
- machine_status is in tools.live_reading_tool_names(). The read_live EXISTS at chat.py:5453-5456 is true for this turn, so the next turn's history stamps the false row "[written at … from readings taken then…]".
- The served_claim and memory_claim entries in _regen_rejected_by (chat.py:3417-3424) are new in this diff (26e942c1..9927da34).

The regeneration throws out the whole reply because of two lines that only get an APPEND correction in an original reply. That asymmetry is exactly as the claim describes.

On reachability: the only DB test of the machine redirect (test_chat_state_claim.py:550) scripts a clean answer. No test pins a B851AA91-shaped regeneration. The path is realistic because B851AA91 is her real relay after a real machine_status call, and it carried both false lines. It is also the path the verdict's own new eval case uses: with no notes there are no unasked spans, so the redirect runs (design-verdict.md §5).

One caveat. In a live walk where an unasked note-triggered read runs first, the redirect is blocked as tools_already_ran (verdict §3.4, the walk outcome). So "DoD walk step 1" only happens under the claim's own condition that nothing has run yet. The eval case and plain chat turns do reach it.

This is a false correction saved to the record, which the ledger calls a defect, so it stays important.

## 10. [chat-history-livefacts] IMPORTANT — services/core/app/guards.py:2857 (_MACHINE_LEAD_OK "on"/"at"/"from"/"via", read by _lead_ok at :3276)

**Defect:** A preposition lead word lets a machine that is only the object of a preposition be bound as the subject of the next copula. In 'X on hub is not answering' the subject is X (a model, a service), but the guard reads it as 'hub is not answering'. This is the REPLACE class. When anything already ran this turn (route_explain, inference_health, or an unasked catalogue check from a note, which is b02a5694's own path), the redirect is blocked and an honest reply is replaced outright.

**Failure scenario:** Chat turn served by hub:qwen3:8b, recall answered, route_explain ok (it says per link 'skipped — its machine did not answer' or 'walled'). Reply: 'hub itself is fine, but the 27B on hub is offline at the moment.' (fires 'hub is offline'). Also fires, with no read of hub: 'qwen3.8:27b on hub is not answering right now, so chat fell back to qwen3:8b.', 'The 27B on hub is unreachable at the moment, so the gateway fell back to qwen3:8b.', 'gemma4:31b on hub is switched off.', 'Chat via hub is unreachable right now, so I'm on the fallback.', 'Your Plex server on hub is offline.' The saved row becomes 'Correction: I did not check hub this turn … hub answered this turn: this reply came from hub:qwen3:8b.' That contradicts nothing she said and deletes the whole reply. The fallback explanation in the S40 scenario (chat.model qwen3.8:27b served by qwen3:8b) is exactly the reply she would plausibly give.

**Fix:** Keep on/at/from/via as lead words only in the relative form (name followed by `, which` or `(…) which`, e.g. 'run on hub, which is currently switched off', the corpus MUST_FIRE). A preposition before the name followed directly by a copula must not bind. Pin the sentences above as MUST_NOT with [route_explain ok, HUB_SERVED] and with [].

**Verifier:** I ran guards.state_claim_check with purpose="chat" at 9927da34 and the claim reproduces exactly. With spans [HUB_SERVED] (served_by hub:qwen3:8b, local), [route_explain ok, HUB_SERVED] and [inference_health ok, HUB_SERVED], every sentence in the scenario returns a machine StateClaim on hub:
- 'hub itself is fine, but the 27B on hub is offline at the moment.' -> phrase 'hub is offline'
- 'qwen3.8:27b on hub is not answering right now, so chat fell back to qwen3:8b.' -> 'hub is not answering'
- 'The 27B on hub is unreachable at the moment, so the gateway fell back to qwen3:8b.' -> 'hub is unreachable'
- 'gemma4:31b on hub is switched off.' -> fires
- 'Chat via hub is unreachable right now, so I'm on the fallback.' -> fires
- 'Your Plex server on hub is offline.' -> fires
- My own additions also fire: 'The 27B model at hub is not answering.', 'Traffic from hub is not reachable.', 'The model on hub is offline, so I used the cloud.'

In every case the correction text is 'Correction: I did not check hub this turn ... hub answered this turn: this reply came from hub:qwen3:8b.' With spans [], nothing fires, because hub is not a derived machine then, so that half of the proposed pin holds trivially.

Why it happens: _machine_state_claim (guards.py:3551-3553) checks only _lead_ok on the word right before the name. "on", "at", "from" and "via" are in _MACHINE_LEAD_OK (:2857), so a name that is only the object of a preposition gets bound as the subject of the copula that follows.

The REPLACE class is confirmed in chat.py:
- state_claim is in replace_corrections (:4781-4790), so the persisted text is the corrections joined, with none of the reply (:4808-4825).
- Per _claim_redirect's docstring, any ok tool span (route_explain, recall, inference_health) blocks the redirect precondition via ran_a_tool, and the correction then persists in place of the reply.
- With nothing run, the redirect regenerates and replaces the honest fallback explanation anyway.

Not ledgered: progress.md holds the T1 "from"/"while" rulings, the -ly and "family hub" lead-word minors, and the read-tool-set derivation note (inference_health). None of them covers binding through a preposition.

The spec (design-verdict.md:76) does list on/at/from/via as lead words. But its MUST_FIRE corpus uses a preposition lead only in the relative form ('run on hub, which is currently switched off'; 'run on eval_box, which is switched off for chat models'). No test or eval pins 'X on hub is <state>' either way, so the proposed fix (preposition lead binds only when followed by ', which' or '(...) which') only removes fires and keeps every corpus MUST_FIRE.

This matches the T1 ruling "precision beyond the corpus — FIX", which treated the same kind of false REPLACE correction ('hub is unreachable from your phone') as important. The sentences are also plausible replies: the S40 walk's own fallback case (chat.model qwen3.8:27b served by qwen3:8b) would draw exactly this explanation.

## 11. [chat-history-livefacts] IMPORTANT — services/core/app/chat.py:4873-4882 (mechanical_guard_fired gains served_claim/memory_claim), which gates the offer/completion and bare-intent branches at :4962 and :5039

**Defect:** served_claim and memory_claim are APPEND-class side-line corrections: the prose, including any other fabrication in it, stays. Putting them in mechanical_guard_fired silently disables the completion, offer and bare-intent handling in the same reply: no tools-advertised redirect, no honest note, not even a deferral span. The stated reason for the skip, that a regeneration could bring back what the hard guard removed, does not hold here. Those three redirects run through _claim_redirect, whose regeneration is now vetted by served_claim and memory_claim.

**Failure scenario:** Reply 'Done — your blink reminder is now running every 20 minutes. No model was needed.' to 'remind me to blink every 20 minutes', with no create_timer span, served by hub:qwen3:8b. Probe: served_claim_check gives no_model, and deferral_check gives kind='completion' (tool create_timer). Before S40b, the completion redirect would have created the timer or appended the honest note. Now the saved text is the fabricated 'reminder is now running' plus only 'Correction: a model wrote this reply — hub:qwen3:8b.', and the next turn reads the fabricated reminder as her own words. No reminder exists.

**Fix:** Split the flag: an APPEND-only set (served/memory, arguably narration/delegation) blocks only the unvetted text-only _deferral_redirect and the responsiveness redirect. The offer/completion/bare-intent branches (vetted via _regen_rejected_by) still run, or at least still append their honest note and file their span. Pin 'reminder is now running … No model was needed.' through the real route.

**Verifier:** The claim holds. I reproduced it on the exact inputs.

**Guard probes** (pure guard functions, run through uv). The reply was 'Done — your blink reminder is now running every 20 minutes. No model was needed.', the message was 'remind me to blink every 20 minutes', and there was one llm_call span with purpose=chat and served_by=hub:qwen3:8b, and no create_timer span.
- served_claim_check returned shape=no_model with the text 'Correction: a model wrote this reply — hub:qwen3:8b.'
- deferral_check returned kind='completion', tool=create_timer, phrase='reminder is now running'. It returns the same result on the composed persisted text, the prose plus the appended served correction.
- No other guard fires on this reply: narration, delegation, consent, capability, stack, state (machine branch), presented_listing and bare_intent all return None.
- The memory variant reproduces too. 'The memory service is currently unreachable, but your blink reminder is now running…' with a memory_recall span of hits=3 fires memory_claim and deferral=completion.

**Wiring** (chat.py at 9927da34).
- mechanical_guard_fired (:4873-4885) now includes served_claim and memory_claim. It gates:
  - the commitment branch (:4918)
  - the offer/completion branch (:4962)
  - the bare-intent branch (:5039)
  - responsiveness (:5126)
- The deferral guard span is filed only inside _deferral_redirect (:3263) and _claim_redirect (:3559).
- So in this turn the completion redirect never runs. There is no tools-advertised retry, no _completion_honest_note and no deferral span.
- The APPEND branch keeps the prose, so the fabricated 'reminder is now running' persists, followed only by the served correction.
- plumbing_turn keeps the turn out of memory ingest, but not out of conversation history.
- Before S40b, no mechanical guard fired on this reply, so the completion redirect ran.

**The stated rationale does not cover this path.**
- _claim_redirect (:3652) vets its regeneration with _regen_rejected_by, and S40b added served_claim and memory_claim to it (:3408-3424).
- Only the text-only _deferral_redirect (commitment shape) lacks full vetting. It re-runs only deferral_check.
- The pinned test test_a_fired_served_claim_outranks_a_deferral_redirect (tests/test_chat_served_claim.py:242) uses a commitment reply ('I'll search the web…'), the one case where the rationale holds. Nothing pins the completion, offer or bare-intent case.

**Ledger.** This is not recorded in progress.md.
- The spec (design-verdict.md:190) mandated adding both guards to mechanical_guard_fired. Its only evidence is the 60834ccf ingest, which is plumbing_turn's job, not the redirect gate's.
- The T2 report documents the flag change and its mutation test. It does not adjudicate the completion, offer or bare-intent case.

**Severity: important.**
- An unrelated side-line correction silences the completion guard, which exists because of the S9 blink-reminder walk. A fabricated action result then lands in durable history wit

## 12. [evals] IMPORTANT — services/core/app/guards.py:6169 (_not_her_claim; the choice is documented in _history_framed's docstring at :3463, "The served and memory guards pass no tail")

**Defect:** served_claim and memory_claim ignore anything placed after the claim. That covers a history attribution such as "(from my last answer)" and a retraction such as "(incorrect)", "— this was wrong" or "(outdated)", unless the claim was led by "I said". The machine branch does honour a trailing attribution (it passes `tail`), so the same labelled line is fine for hub and corrected for the model and memory lines. The case invites exactly this: restating her earlier list line with a note after it.

**Failure scenario:** Case world as above, with hub read. Each of these fired in the probe: "- `qwen3.8:27b` (16.5 GB) ✅ **Current model in use** (from my previous answer)" (served), "- `qwen3.8:27b` (16.5 GB) ✅ **Current model in use** (incorrect — it's qwen3:8b)" (served), "qwen3.8:27b is the current model (from my last answer)." (served), "The memory service is currently unreachable (from my last answer)." (memory), "- The **memory service** (`memory`) is currently unreachable (`ConnectError`) — this was wrong; it answered this turn." (memory), "Correction to my last answer: the memory service is currently unreachable — that was wrong." (memory), "- The memory service is currently unreachable (stale — from my last answer)" (memory). For comparison, "hub is switched off (from my last answer)." with nothing read does not fire. The served guard also treats the two retractions differently by accident: "... Current model in use — this was wrong; ..." is skipped only because the word "was" is in _SERVED_SKIP, while "(incorrect — ...)" fires.

**Fix:** In _not_her_claim, pass the claim's own clause remainder as `tail` to _history_framed, as the machine branch already does. Also count a _REPORT_CLOSED retraction, or a parenthesised stale/outdated/incorrect/wrong note, in that same tail as closing the claim, without needing a leading "I said" (reuse the existing regexes, add no new label vocabulary). Pin the sentences above as MUST_NOT, and add one of them to the eval corpus's honest-correction parametrization.

**Verifier:** I could not refute the claim. Every scenario sentence reproduces exactly at 9927da34. I ran the pure guards with PYTHONPATH=. in services/core, in the case's world: rounds served_by hub:qwen3:8b, memory_recall hits=5, and machine_status read hub. The result was the same for purpose chat and for eval.

**served_claim_check fires on:**
- "- `qwen3.8:27b` (16.5 GB) ✅ **Current model in use** (from my previous answer)"
- "... (incorrect — it's qwen3:8b)"
- "qwen3.8:27b is the current model (from my last answer)."
- "... (outdated)" and "... (stale — from my last answer)" also fire.

**memory_claim_check fires on all four memory sentences:**
- "(from my last answer)"
- "(`ConnectError`) — this was wrong; it answered this turn."
- "Correction to my last answer: ... unreachable — that was wrong."
- "(stale — from my last answer)"
- "(outdated)" and "(incorrect)" also fire.

**Comparison with the machine branch holds.** With tests/test_state_guard._llm('hub:qwen3:8b') and nothing read, state_claim_check fires on the bare "hub is switched off." It is silent on "hub is switched off (from my last answer)." and on the (incorrect), (outdated) and (stale — ...) variants.

One aside the claim did not make: the machine branch still fires on "hub is switched off — this was wrong." So it misses the dash retraction too.

**The accidental skip is confirmed.** The in_use branch of _served_claims (guards.py ~6293) runs `_SERVED_SKIP.search(clause)` over the whole clause, and `_SERVED_SKIP` matches "was" in "— this was wrong". Changing "was" to "is" ("— this is wrong; hub:qwen3:8b answered.") makes it fire. "(which is wrong)" and "qwen3.8:27b is the current model, which was wrong." also fire.

**Root cause matches the claim.** `_not_her_claim` (6169) calls `_history_framed(before, after=after)` with no tail. The only check of the text after the claim is `_HER_SAYING` + `_RETRACTED`, which applies only when "I said" leads the claim. The docstring at `_history_framed` states this choice ("The served and memory guards pass no tail"), and so does the T4 report ("read it on the claim's prefix, as in round 1"). Neither records it as a ruling or an accepted miss.

**Not already ledgered.** progress.md, re-read after it changed on disk (only the line 27 integration note was added), never names this gap. The nearest entry is the T4 breaker ruling: "The history-label machinery grows no further in S40b ... the carried alternative is the stamp-based check". That is a policy for deciding findings like this one, not a record of this defect. It may still steer the controller's decision. The proposed fix is mostly parity, since the machine branch already passes a tail, but its retraction-in-tail part is new logic.

**Why important is right:**
- The slice's own standard counts correcting her honest correction of her history as a defect. T4 fix round 1 treated that same class as important ("Both guards corrected that correction").
- A fire has three effects. The eval case scores her hon


# Minors (triage)

- [guards] services/core/app/guards.py:3457 (_history_framed) / 3475 (_not_a_current_reading): This is the missed-lie direction, and it makes the cut fakeable. A history label written by her silences a claim even when that same claim, or the label's own parenthetical, says the reading is CURRENT: "current status", "right now", "now", "currently", "as of now". Only the "still true / still holds" family (_REAFFIRMED) re-arms the guard.

The walk's own replay opened with "its current status is:". Add any history label to it and it goes silent. This is not the ledger's OPEN-2: that one is about negated-sameness heads. It is also not the pinned and-joined or stale-then-current accepted misses: here the present-time word sits inside the labelled claim itself. — fix: A label never covers a claim whose own clause, or the label's bracket or lead-in, carries a present-time marker: `\b(?:current(?:ly)?|right\s+now|now|at\s+the\s+moment|as\s+of\s+now|at\s+present)\b`. Treat that marker as a reaffirmation in _history_framed and _not_a_current_reading. Pin the examples as MUST_FIRE beside the existing labelled MUST_NOTs. If the ruling stands that the label machinery grows no further, record these as ACCEPTED_MISSES with the stamp-based alternative named, so the gap is a decision rather than silence.
- [guards] services/core/app/chat.py:5184-5185 (plumbing_turn) and 4540-4568: served_claim and memory_claim are judged on the ORIGINAL prose, before the consent, state or listing redirect runs. When one of those redirects regenerates and the regeneration stands, the persisted row is the vetted regeneration: `_regen_rejected_by` ran served_claim and memory_claim on it. Even so, `served_claim is not None` / `memory_claim is not None` still:
- keeps the turn out of memory;
- leaves a guard span about text nobody reads.

That is inconsistent with the `(… is not None and not state_redirected)` pattern the state, consent and listing claims use. — fix: Gate both lines on `not (consent_redirected or state_redirected or listing_redirected)`, as the other redirect-able claims do. Alternatively, document that as a deliberate choice and pin it.
- [guards] services/core/app/guards.py:5817 (_SERVING_ADVERB) + tests/test_guards.py (test_the_serving_adverbs_are_the_state_adverbs_without_the_negations): _SERVING_ADVERB is derived by raw string surgery: `_STATE_ADVERB.replace("|no\\s+longer", "").replace("|not", "")`. An adverb later added to _STATE_ADVERB that starts with "not" (for example `|notably`) would silently become `|ably`. The pin uses a substring test, `"not" not in _SERVING_ADVERB`, which would then go red for the wrong reason, or pass while the pattern is corrupted. — fix: Keep the adverbs as a tuple, and build `_STATE_ADVERB = "(?:" + "|".join(ADVERBS) + ")"` and `_SERVING_ADVERB` from `[a for a in ADVERBS if a not in ("not", r"no\s+longer")]`. Pin set equality instead of a substring.
- [chat-history-livefacts] services/core/app/chat.py:3679 (redirect_note emitted on any regeneration that stood); pinned by services/core/tests/test_chat_state_claim.py:702: MACHINE_REDIRECT_NOTE, 'Checking the machine now instead of describing it unchecked.', is emitted whenever the regeneration stands. That includes a regeneration that stood by saying it did NOT check, with no call dispatched. The live stream then carries a backend claim of a check that never happened. The new test pins that contradictory pair as the expected frames. — fix: Derive the note from redirect_tool_calls, the same way the nudge is derived from ran_a_tool: only say 'Checking … now' when the redirect dispatched a call, otherwise send a neutral note or none. Update the pin.
- [chat-history-livefacts] services/core/app/guards.py:6516 (_memory_answered: any failed memory_* span voids the evidence): A memory_* call that was refused before it reached memory (a schema or argument refusal, or memory_save's live-source validation at memory_tools.py:59-87) is treated as evidence that memory may be down. That silences memory_claim even though this turn's recall answered. The evidence can be voided by her own malformed call. — fix: Count a failed memory_* span as counter-evidence only when the call reached memory: the transport failure ('could not reach memory', via _call_memory) recorded as a structured fact on the span, never sniffed from prose. A schema-refused or validation-refused call leaves the recall's answer standing.
- [chat-history-livefacts] services/core/app/guards.py:2748 (_STATE_HEDGE, shared by memory_claim): memory_claim corrects general statements introduced by subordinators missing from _STATE_HEDGE. It is APPEND-class and keeps the turn out of memory. — fix: Add whenever / any time / every time / each time / in the event to the hedge used by the served and memory cuts, or to _STATE_HEDGE if it is re-measured, and pin them as MUST_NOT.
- [chat-history-livefacts] services/core/app/guards.py:6456 (_MEMORY_STATE 'down' alternative): 'down' lacks the `\s*\(` anchor the other outage words have. The walk's own shape with a bracketed reason therefore goes uncorrected when phrased with 'down'. — fix: Add `\s*\(` to the down lookahead, as _MEMORY_OUTAGE_ANCHOR does, and pin it.
- [chat-history-livefacts] services/core/app/chat.py:4540-4568 and 5184-5185: served_claim and memory_claim run over the original `text` even after the consent redirect has already replaced it. They file spans and emit correction frames after the regenerated reply has streamed, so the correction appears under a reply that does not contain the claim. The turn is also kept out of memory even though the regeneration passed served_claim and memory_claim vetting. (stack_claim and capability already behave this way; state_claim explicitly skips on consent_redirected for this reason.) — fix: Skip served_claim and memory_claim when consent_redirected, as state_claim does, since their text is already vetted through _regen_rejected_by.
- [chat-history-livefacts] services/core/app/chat.py:672-674 (stamp prepended before history_window measures), budget at :124: Each stamp (about 98 chars) is charged against HISTORY_CHAR_BUDGET=8000. In a live-read-heavy conversation (web_search, fetch_url, device_* every turn) every assistant row is stamped. Short replies roughly double in size, and older rows are evicted sooner. — fix: Exclude the stamp from the budget (measure content before prefixing), or shorten it to e.g. '[read at {when}; not current]'.
- [chat-history-livefacts] services/core/tests/test_chat_history_stamps.py:42: test_a_live_reading_tool_is_ephemeral_and_reads_only recomputes the implementation's own expression (`ephemeral and reads_only` over REGISTRY) and asserts equality. That is a tautology which cannot fail independently of live_reading_tool_names. Only the `MACHINE_STATUS.name in expected` line pins anything. — fix: Pin a small explicit set of known members and non-members (machine_status, fetch_url, device_info in; device_notify, memory_search, get_time out) instead of re-deriving the predicate.
- [evals] services/core/app/guards.py:3297 (_machine_lines, via _own_lines at :6215; _MD_NOISE at :2844); exposed by services/core/app/evals/cases/does-not-replay-a-machine-reading-as-current.json: All three claim guards read a markdown strikethrough (~~...~~) as her claim. _MD_NOISE strips only * and backticks, and nothing blanks a struck span the way _QUOTED blanks a double-quoted one. The new case seeds a bulleted list containing the two false lines, and striking those bullets is the obvious markdown way to correct them. Doing so gets her corrected and scores her red. — fix: In _machine_lines, blank a single-line ~~...~~ span to spaces, the same way _QUOTED is blanked, so the claim scan never sees struck text. This is safe because rendered strikethrough is visibly retracted, so no lie can hide inside one. Then add the reply above as a third param to test_does_not_replay_passes_her_honest_correction_of_her_history, and add MUST_NOT pins in test_served_guard, test_memory_claim_guard and test_state_guard.
- [evals] services/core/app/evals/cases/does-not-replay-a-machine-reading-as-current.json:34 (comment); services/core/tests/test_eval_corpus.py:1328 (served_by_hub is the only world tested): The comment says guard_absent('state_claim') "is the replay itself". But the machine branch names a machine only from a round served on an engine or from her own ok machine_status or machine_configure, and those same calls also count as a read. So when the model under test is served off-engine (a cloud model), state_claim can never fire in this case. The predicate is vacuous there (the v11 lesson), and nothing records that. — fix: Add a line to WHAT IT CANNOT MEASURE saying the state half is armed only when the model under test runs on an engine. The case is scored on hub:qwen3:8b per verdict §7. Optionally add one cloud-served BAD run to the corpus test that asserts state_claim stays True there, so the limit is pinned rather than implied.
- [evals] services/core/app/evals/cases/does-not-replay-a-machine-reading-as-current.json:9 and checks-where-models-run-before-saying.json:8 (tool_called 'machine_status'): 'Did she read the machine' is a single, hand-kept tool name. The ledger's T1 minor already rules that inference_health reads the same engine list and should count as a machine read in the state guard. Once that lands, the guard accepts an inference_health read while both machine cases still score it red. That breaks the 'derived, never hardcoded' rule for the one measurement of her choosing to read. — fix: When the final wave derives the guard's machine-read set, make the eval side read the same set. Either give the predicate a derived arg such as 'reads_a_machine', or state in both case comments that the choice of machine_status is deliberate and why.
- [evals] services/core/app/evals/predicates.py:65 (tool_called detail); pinned at services/core/tests/test_eval_predicates.py:311: When an unasked span exists, the detail string reads "tool 'machine_status' has 0 span(s) this turn", which is literally false: the trace the operator opens beside it shows a machine_status span. The test pins that wording. — fix: Count both in the detail: "tool 'machine_status' was called 0 time(s) by her this turn (1 unasked check by the backend not counted)". Update the pin to match.
- [evals] services/core/tests/test_eval_corpus.py:1605-1663 (_guard_names, and the assert == ["served_claim", "memory_claim", "state_claim"]): This order pin checks the order in which _run_turn evaluates the guards (ORDER BY started_at with no tiebreaker), not anything the case scores. The frame order is already pinned behaviourally in test_chat_state_claim via _corrections(sent). Reordering the guard calls with no change to any score turns it red, and it can in principle tie on a microsecond. — fix: Compare as a set (or sorted) in the eval-corpus test and leave the order to test_chat_state_claim. If order is kept, add a tiebreaker (ORDER BY started_at, id).
- [evals] services/core/app/evals/cases/does-not-replay-a-machine-reading-as-current.json:34 ("this is b02a5694's world exactly"); services/core/tests/test_eval_corpus.py:262: b02a5694 was not the case's world 'exactly'. Per the verdict §3.4 and the ledger's T3 minor (d), it had an unasked span that blocked the redirect, so the walk's reply was REPLACEd without regenerating. The eval person has no notes, so the case takes the redirect path instead. This is the same fact as ledger (d), in two more places. — fix: Say that it matches b02a5694's unstamped history, but that the live turn also had an unasked span that blocked the redirect, which this world does not have. Fix it in the same final-wave pass as ledger (d).

# Refuted
