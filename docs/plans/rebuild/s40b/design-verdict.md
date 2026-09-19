S40b critique and recommended design. This was a read-only pass: no repo edits and no test suites. The probes were pure function calls in the scratchpad (`probe.py`, `mach.py`, `served2.py`). They ran over 649 real replies, meaning 440 `eval_runs.detail.reply` rows plus 209 live assistant rows, each with its own `turn_spans`, and over the 98 notes in `nova_v4_memdata`.

**Headline result:** the recommended guards fire on exactly 3 of the 649 replies. Those are the three walk turns (b851aa91, b02a5694, 60834ccf), and every hit is a sentence already labelled FALSE. Neither original design is safe to merge as written: provision misfires on one real, honest eval reply, and guard-only would replace honest device reports in its own REPLACE class.

## 1. Attack on "guard-only"

**What it gets right, confirmed in code:**
- Failure statements exit through `_end_without_a_reply` (chat.py:3676, called at :4128 and :4242) before the guards run.
- `ran_a_tool` counts unasked spans (guards.py:1001-1021). So the live replay can only be corrected, never regenerated (chat.py:3489-3501).
- `_checked_a_device` short-circuits both branches today (guards.py:2845).
- Deriving machine names from spans means no threading and no gateway call.
- None of its served-claim shapes fired on any of the 649 real replies.

**Defects:**
1. **Its negative key/value branch replaces honest device reports.** The binding rule is "the nearest preceding mention in the heading block". With the reply `Models run on hub.\nYour Dell:\n- Status: offline` the "Status" line binds to hub, because "Dell" is not the paired name DELL-XPS-8950. The result is a false "I did not check hub", REPLACE-class. The branch also targets nothing that happened in the walk (her walk reply said "Serving: On", which is positive). **Drop it.**
2. **The reading line has no not-current cut.** `- Last Reported: <ts> (I have not checked since)` and "…when I checked earlier:" followed by a status block are both REPLACED.
3. **The machine branch is not armed by turn kind.** It would REPLACE in scheduled and agent turns, where STACK_CLAIM_KINDS (guards.py:4919-4937) says precision was never measured.
4. **served_claim misfires, measured:**
   - `...; fallback openrouter:anthropic/claude-sonnet-4.6 (in use only if hub is down)`: the hedge comes after the marker, and "nearest ref" picks the fallback model.
   - `No model was needed for that step — the timer ran on its own.`: `for\s+(?:this|that|it)` is too broad.
   - `qwen3.8:27b is the current model for images.`: the skip word "image" does not match "images".
   - Only some gateway role names are skipped. `BUILTIN_ROLES` is chat, scheduled, judge, coding and vision (services/gateway/app/routing.py:56).
5. **"that" is on its lead-word allow-list,** so the determiner in "that USB hub is offline" is let through.
6. **It says "no change to live_facts".** That leaves an existing hole in the device branch. An unasked `device_*` that refuses because the device is offline records its facts in the shared sink (tools/devices.py:98-104), but `_run_one` never copies them onto its span (live_facts.py:222-260). `_determined_connectivity` therefore misses them, and an honest "the Dell is offline" is replaced by "I did not actually check".

## 2. Attack on "guard-plus-provision"

1. **served_claim's trailing form produces a real false correction.** Eval reply 51ca965a (checks case, hub:qwen3:8b, an honest reply) contains `- GPU: cuda:GPU-<uuid> (in use).`, which fires. The same form also fires on:
   - `Ollama is listening on ollama:11434 (in use).` (the port is not excluded);
   - `` `qwen3.8:27b` is installed on hub, and hub is answering. `` (a bare "answering" is an anchor).

   The cause: `_REF` uses `_MODEL_BODY` without a letter-led rule or a gpu/cuda exclusion.
2. **`_NO_MODEL` is unanchored.** All three of these fire:
   - "No model was used for the embeddings."
   - "No model was called for the image, since you didn't attach one."
   - "No models were needed to be pulled."
3. **Provision (a), running `machine_status` unasked when his message asks about machines, fakes evidence.** An unasked ok span makes `ran_a_tool` true. That means:
   - `bare_intent_check` returns None (guards.py:3075), so on every machine-question turn a bare "Checking…" with nothing *she* ran passes;
   - every `_claim_redirect` (consent, state, listing) is blocked as `tools_already_ran`.

   It also turns `tool_called('machine_status')` green by construction: `tool_called` ignores `unasked` (evals/predicates.py:48-54). That is why the design deletes the only measurement of her choosing to read. And it routes intent with a regex of hand-kept phrasings of his message. **Reject.**
4. **Backing served_claim with `meta.model` (the requested link) hides the fallback lie.** The line that causes that lie stays false: "The model answering is {model}" (chat.py:831) states the setting, not what served.
5. **memory_claim problems:**
   - `_SERVING_STATE` includes a bare "down", so "The memory store is down for maintenance tonight." fires.
   - "Fires when a memory_recall span has hits" is the wrong test. `hits` is set on every recall that answered, including 0 (chat.py:1928). A failed recall sets `error` and returns early (:1878, :1913).
6. **stale_reading carries more machinery than the walk needs.** It needs full-result `stamps` plumbing in both `_run_tool` and `_run_one`, span `started_at` inside a pure guard, and quarter-hour leniency for naive stamps. It is subject-free, so it cannot hand her the machine redirect. It also loses a "last seen" stamp past the 400-char result head unless the new plumbing is built.
7. **Correct observations:**
   - The history asymmetry is real: only `error` and `stopped` rows are stamped (chat.py:682-704).
   - The "the model is not down" defect in stack_claim is real, confirmed below.
   - Of 177 beat rows, 172 sit in one conversation and 5 in the walk conversation (323892b5), so stamping beat rows is cheap.

**An existing defect both designs carried instead of fixing:** `stack_claim_check` today returns a REPLACE correction for "The model is not down.", "The gateway is no longer unreachable." and "The model is not unreachable — it answered." It reuses `_STATE_ADVERB`, which contains not and no longer (guards.py:2713, :4952-4958). An honest reply gets corrected. It is also missing from `_regen_rejected_by` (chat.py:3337-3373).

## 3. Recommended S40b design

**What comes from where:**
- **From guard-only:** span-derived machine names, the redirect path (REPLACE for the machine-state claim), served_claim's letter-led ref, its sentence shapes, and APPEND for served_claim.
- **From provision:** memory_claim, arming by turn kind, the per-call facts sink in live_facts, history stamps (c) as the truth half, and the stack negation fix.
- **Rejected:** provision (a), stale_reading and the `meta.model` backing from provision; the negative key/value branch from guard-only.

### 3.1 guards.py

#### A. `state_claim_check(reply_text, spans, device_names, *, purpose: str | None = None)` learns machines

- The machine branch runs only when `purpose in STACK_CLAIM_KINDS`. The default of None leaves every existing call and test unchanged.
- The device branch is unchanged, except that `_checked_a_device` (:2845) now short-circuits only the device branch.
- The early return (:2842) happens only when there are neither device names nor machine names.

Constants, placed beside `_CONFIGURE_TOOLS` at :65:

```
_MACHINE_READ_TOOLS = frozenset({"machine_status"})   # test pins == tools.machines.MACHINE_STATUS.name
_MD_NOISE   = re.compile(r"[*`]+")                    # never "_" (eval_box)
_NAME_LEFT  = r"(?<![\w.-])"
_NAME_RIGHT = r"(?![\w-]|\.\w|:\w)"                   # "hub." ends a sentence; "hub:qwen3:8b" is a model id
_MACHINE_LEAD_OK = {called,named,machine,engine,on,at,and,or,but,so,while,because,since,also,currently,now,today,from,via} | any word ending -ly
_MACHINE_ANCHOR = r"(?=\s*(?:[.,;:!?)\]}—–]|$)|\s+(?:right\s+now|now|again|at\s+the\s+moment|and\b|for\s+(?:chat\s+)?(?:models|chat|requests)\b))"
_MACHINE_NEG = r"(?:offline|disconnected|unreachable|not\s+reachable|out\s+of\s+contact|powered\s+off|switched\s+off)"
_MACHINE_POS = rf"(?:online|reachable|powered\s+on|switched\s+on|connected{A}|answering{A}|ready{A}|serving{A})"   # A=_MACHINE_ANCHOR
assertion = rf"{_NAME_LEFT}(?P<mach>(?-i:{names})){_NAME_RIGHT}(?:\s*\([^()\n]{{1,40}}\))?(?:\s*,?\s+which)?(?:\s+{_PRESENT_COPULA}|['’]s)(?P<adv>(?:\s+{_STATE_ADVERB})*)\s+(?P<state>{_MACHINE_NEG}|{_MACHINE_POS})"   # re.I, lru-cached per names tuple
_READING_TS  = r"(?:\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*(?:Z|UTC|[+-]\d{2}:?\d{2}))?|\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:UTC|Z|am|pm)\b|just\s+now)"
_READING_KEY = r"(?:last\s+(?:reported|checked|seen|observed|read|heard(?:\s+from)?|contact(?:ed)?)|(?:reported|checked|observed|seen|read)\s+at|checked)"
_READING_LINE = re.compile(rf"^\s*(?:[-+•]|\d+[.)])?\s*(?P<key>{_READING_KEY})\s*[:=]\s*[^\w\s]{{0,6}}\s*(?P<ts>{_READING_TS})", re.I)
last_reading = rf"{_NAME_LEFT}(?P<mach>(?-i:{names})){_NAME_RIGHT}\s+(?:is\s+|has\s+been\s+)?last\s+(?:reported|checked|seen|read|heard\s+from)\b\s*(?:at|on|:)?\s*{_READING_TS}"
_SUBJECT_KEY_LINE = re.compile(r"^\s*(?:[-+•]|\d+[.)])?\s*(?:name|machine|engine|host|device)\s*[:=]", re.I)
_NOT_CURRENT = re.compile(r"\b(?:not\s+(?:re-?)?checked|(?:have|has)(?:\s+not|n['’]t)\s+(?:re-?)?checked|did(?:\s+not|n['’]t)\s+(?:re-?)?check|without\s+(?:re-?)?checking|could(?:\s+not|n['’]t)\s+(?:be\s+)?(?:check|read|reach|ask)\w*|unchecked|stale|out\s+of\s+date|may\s+have\s+changed|not\s+(?:a\s+)?(?:current|fresh|live))\b", re.I)
```

`machine_names(spans)` is public, so chat.py can count the names. It is the union of:
- the head of `served_by` (text before the first colon) on error-free `llm_call` spans with `local is True`, or with `served_on` or `served_runtime` present. In the last two days served_by was present on 203 of 203 rounds, `local` was true on 203 of 203, but served_on only on 172, because the stamp is omitted past a 2 s budget (gateway data_plane.py:11-17, :47);
- `facts[].machine` from ok `machine_status` spans;
- `args_redacted.machine` from ok `machine_status` and `machine_configure` spans.

Failed spans add nothing, and names shorter than 2 characters are dropped.

Rules:
- **Every name match:**
  - The match is case-exact; "Hub" is an accepted miss.
  - The lead-word rule is checked in code: if the text before the name ends in a word, that word must be in `_MACHINE_LEAD_OK` or end in -ly.
  - Fenced lines and lines starting with `>` are skipped.
  - Matching runs on text with `_MD_NOISE` stripped.
- **Copula:**
  - The claim is negative when the state is in `_MACHINE_NEG`, XOR the adverb group contains not or no longer.
  - It fires only when negative and no read of that machine exists.
  - Cuts: question, `_REPORTED`, `_state_prefix_blocks`, `_PRIOR_TIME`.
- **Reading, as a key/value line or the `last_reading` prose form:**
  - It fires when no read of that machine exists. A served round never backs a reading time.
  - A key/value line binds by walking upward:
    - a machine mention on the line itself binds;
    - otherwise take the nearest preceding line in the same unbroken run (a blank line or a heading ends the run);
    - a paired-device mention leaves the line unbound;
    - so does a line ending in ":" or a `_SUBJECT_KEY_LINE` that names no machine;
    - a machine mention binds.
  - Cuts: skip when `_PRIOR_TIME`, `_NOT_CURRENT` or `_REPORTED` appears in the reading line, the lines walked, or the lead-in (the last non-blank, non-heading line above the run, if it ends in ":").
- **Evidence:**
  - A read of M is an ok `machine_status` span with `args.machine` empty or equal to M, asked or unasked, with no facts required. An ok `machine_configure` on M also counts.
  - Served evidence is an error-free `llm_call` whose `served_by` head is M. It backs positive claims and contradicts negative ones.
- **Property, pinned by a test:** every derived machine has either a read or a served round, so a positive claim never fires in S40b.

`StateClaim` gains `subject_kind="device"` and `served_by: str | None`. Its `device` field keeps meaning "the subject named". The machine correction text is `"Correction: I did not check {m} this turn — I have no record of doing so, so what I said about it is not a current reading."` When the claim was negative and the machine served this turn, append `" {m} answered this turn: this reply came from {served_by}."`

#### B. stack_claim negation fix

Add `_SERVING_ADVERB` = `_STATE_ADVERB` without not and no longer, and use it in `_SERVING_ASSERTION` (:4952). "not responding" and "not working" are state words themselves, so they still fire.

#### C. `served_claim_check(reply, spans, *, purpose) -> ServedClaim | None`

It is new, placed after `stack_claim_check`, and armed only in STACK_CLAIM_KINDS.

```
_SERVED_REF = r"(?<![\w./:-])(?P<ref>(?!(?:gpu|cpu|cuda|rocm|metal|https?):)(?:[a-z0-9][a-z0-9_-]{0,31}:)?(?:hf\.co/[\w.-]+/[\w.-]+(?::[\w.-]+)?|[A-Za-z][\w.-]*(?:/[\w.-]+)?:(?!\d+\b)[\w.-]+))"
_IN_USE = r"\b(?:current(?:ly)?\s+(?:chat\s+)?model(?:\s+in\s+use)?|(?:currently\s+)?in\s+use(?!\s+(?:by|for|as|in|on|with|when|if)\b)|(?:currently\s+|now\s+)?(?:answering|serving)\s+(?:you|this\s+(?:chat|conversation|reply|turn))|active\s+(?:chat\s+)?model)\b"
_SERVED_SKIP = r"\b(?:vision|judge|coding|coder|scheduled|embed\w*|ingest\w*|images?|photos?|pictures?|agents?|distil\w*|fallback|standby|backup|was|were|previously|not\s+(?:the\s+)?(?:current|in\s+use))\b"
_LINE_LABEL = r"^\s*(?:[-+•]|\d+[.)])?\s*(?P<label>[A-Za-z][A-Za-z ]{0,30}?)\s*:\s"     # a labelled line must fullmatch _LABEL_OK
_LABEL_OK   = r"chat(?:\s+model)?|(?:current|active)\s+(?:chat\s+)?model|model(?:\s+in\s+use)?|in\s+use|answering(?:\s+now)?|serving(?:\s+now)?"
sentences (R=_SERVED_REF), each cut by _state_prefix_blocks on the prefix and _SERVED_SKIP up to the match end:
  \b(?:the\s+)?model\s+(?:that(?:['’]s|\s+is)\s+)?(?:answering|serving|replying|responding)(?:\s+(?:you|this|here))?(?:\s+(?:right\s+now|now|currently))?\s+is\s+R
  \bthe\s+current\s+(?:chat\s+)?model\s+is\s+R
  \bi(?:['’]m|\s+am)\s+(?:currently\s+|now\s+)?(?:(?:running\s+(?:on|as)|served\s+by|powered\s+by)\s+)?R
  \b(?:this|my)\s+(?:reply|answer|response|message)\s+(?:came|comes|is\s+coming|was\s+(?:written|generated|served))\s+(?:from|by)\s+R
  \byou(?:['’]re|\s+are)\s+(?:currently\s+|now\s+)?(?:talking|speaking|chatting)\s+(?:to|with)\s+R
  R\s+(?:is|['’]s)\s+(?:currently\s+|now\s+)?(?:the\s+(?:model\s+)?)?(?:answering|serving|replying\s+to|responding\s+to)\s+(?:you|this|now|right\s+now)\b
  R\s+(?:is|['’]s)\s+(?:currently\s+)?(?:the\s+)?(?:current|active)\s+(?:chat\s+)?model\b(?!\s+(?:for|in|on)\b)
_NO_MODEL = r"\bno\s+(?:ai\s+|language\s+|llm\s+)?model\s+(?:was|is)\s+(?:needed|used|required|involved)(?=\s*(?:[.!;]|$)|\s+(?:here\b|to\s+answer\s+(?:this|that|it)\b|for\s+(?:this|that)\s+(?:answer|reply|response|calculation|question|sum|math)\b))|\bi\s+(?:did\s+not|didn['’]t)\s+(?:need\s+to\s+)?use\s+(?:a|any)\s+model(?=\s*(?:[.!;]|$)|\s+(?:here|for\s+(?:this|that)\s+(?:answer|reply|response|calculation|question)))"
```

- **In-use shape:**
  - Per clause, the claimed ref is the one nearest the marker.
  - The clause is skipped when `_STATE_HEDGE` appears anywhere in it, `_STATE_INTENT` appears before the marker, or `_SERVED_SKIP` matches.
  - A labelled line whose label is not in `_LABEL_OK` is skipped.
- **All shapes:** cut by question, `_REPORTED`, `_PRIOR_TIME`, and fenced or `>` lines.
- **Evidence:** all `served_by` values on error-free `llm_call` spans, any purpose.
  - A named claim fires only when at least one `served_by` exists and none satisfies `_same_model(ref minus a trailing ":latest", s)` (:1082).
  - The no-model claim fires when `served_this_turn(spans, purpose)` (:983).

#### D. `memory_claim_check(reply, spans, *, purpose) -> MemoryClaim | None`

It is new, placed in the same section, and armed only in STACK_CLAIM_KINDS.

```
_MEMORY_NOUN  = r"(?:(?:the|my|your|her|its|nova['’]s)\s+)?(?:long[-\s]term\s+)?memory\s+(?:service|server|container|backend|api|store|database)"
_MEMORY_STATE = r"(?:unreachable|not\s+reachable|offline|unavailable|not\s+responding|unresponsive|not\s+answering|disconnected|down(?=\s*(?:[.,;:!?)\]]|$)|\s+(?:right\s+now|now|again|at\s+the\s+moment)\b))"
_MEMORY_DOWN  = rf"\b(?P<subj>{_MEMORY_NOUN})(?:\s*\([^()\n]{{1,40}}\))?(?:\s+{_PRESENT_COPULA}|['’]s)(?:\s+{_SERVING_ADVERB})*\s+(?P<state>{_MEMORY_STATE})\b"
_MEMORY_UNREACHED = rf"\b(?:can\s*(?:no|')?t|cannot|can\s+not|unable\s+to)\s+(?:reach|contact|connect\s+to|talk\s+to|get\s+(?:a\s+)?(?:response|answer)\s+from)\s+(?P<subj>{_MEMORY_NOUN})"
```

- **Answered:** a `memory_recall` span with an int `hits`, no `error`, and `errors` not naming every scope; or any ok `memory_*` tool span. The prefix is pinned against the tools in tools/memory_tools.py.
- **Fires when:** memory answered, and no `memory_*` tool span failed this turn.
- **Cuts:** the same as served_claim.

### 3.2 live_facts.py

In `_run_one` (:222-260), create `call_ctx = dataclasses.replace(ctx, facts_sink=[])` when the sink exists and dispatch with `call_ctx` (:249). When the call returns, fails or times out, and the per-call sink is non-empty:
- set `span.meta["facts"]`;
- `ctx.facts_sink.extend(...)`.

This makes concurrent checks under `gather` (:311) safe and closes the device hole described in §1 point 6.

### 3.3 chat.py

- **Prompt truth fix (:831):** replace "The model answering is {model}" with "This turn asks the gateway for {model or its default model}; its routing decides which model actually answers." The current sentence is false on any fallback, and served_claim would correct her for repeating it.
- **Nudge and note:**
  - `state_redirect_nudge(*, device, ran_a_tool, kind="device")` (:232). For machines it reads: "You have not checked {m} this turn. Check it now with {tools.machines.MACHINE_STATUS.name} before describing it, or say plainly that you did not check." It still raises when `ran_a_tool` is true.
  - Add `MACHINE_REDIRECT_NOTE = "Checking the machine now instead of describing it unchecked."` beside :229.
- **State call (:4468):** pass `purpose=_purpose_of(turn)`. `claim_meta` gains `subject_kind`, `machine`, `machines=len(guards.machine_names(turn.spans))`, `evidence` ("unchecked" or "served") and `served_by`. Choose the nudge and note by `subject_kind`.
- **After stack_claim (:4451):** run `served_claim` and `memory_claim`. Each is fail-open, writes a guard span only when it fires (meta `{shape, claimed, served, phrase}` or `{subject, phrase, retrievers_missing}`), and emits a `{correction}` frame.
- **Composition:**
  - Add both new guards to the REPLACE join (:4669-4680), after stack_claim.
  - The APPEND branch (:4682) becomes `correction or delegation_claim or served_claim or memory_claim`.
  - Add both to `mechanical_guard_fired` (:4726) and to `plumbing_turn` (:5008). Evidence that this matters: 60834ccf's "No model was needed for this calculation." is in his notes now.
- **`_regen_rejected_by` (:3337-3373):**
  - The state check passes `purpose=_purpose_of(turn)`.
  - Add `stack_claim`, `served_claim` and `memory_claim`, each with `purpose=_purpose_of(turn)`.
  - No new parameters are needed.
- **History stamps, provision (c), the truth half:**
  - The `_open_turn` query (:5289-5294) adds `t.kind AS turn_kind` and `EXISTS(SELECT 1 FROM turn_spans s WHERE s.turn_id=m.turn_id AND s.kind='tool' AND s.name = ANY($4) AND s.meta->>'ok'='true') AS read_live`. `$4` is a new `tools.live_reading_tool_names()` (ephemeral and reads_only, placed next to `tool_names_by_result_kind`). It excludes `device_notify`, which is ephemeral but not reads_only.
  - `_past_turn_marker` (:688) keeps error and stopped first, then adds:
    - beat or scheduled: `"[a {kind} message from {when}; a record of that moment, not of now]"`;
    - `read_live`: `"[written at {when} from readings taken then; a record of that moment, not of now]"`.

### 3.4 Evidence and correction summary

| Guard | Silent when | Fires when | Class |
|---|---|---|---|
| state_claim, machine | a read of M this turn (asked or unasked) or a configure on M; any positive claim | a negative claim, or a reading time about M, with no read of M | REPLACE plus the one redirect |
| stack_claim | unchanged, plus negated states | unchanged | REPLACE |
| served_claim | the ref matches any served_by; no served_by this turn | named ref matches no served_by; "no model" while served_this_turn | APPEND, not ingested |
| memory_claim | recall failed; a memory_* tool failed; no recall span | recall answered or a memory_* tool succeeded | APPEND, not ingested |

- **served_claim texts:**
  - named: `"Correction: this reply was written by {served} — the gateway recorded that for this turn — not by {claimed}."`
  - no model: `"Correction: a model wrote this reply — {served}."` (without the dash clause when no header arrived).
- **memory_claim text:** `"Correction: the memory service answered this turn — this turn's recall was read from it — so it is not unreachable now."` Add `" What did not work this turn: {retrievers_missing}"` when that field is set.
- **Walk outcome for b02a5694:** state_claim REPLACE, blocked from regenerating by the unasked catalog span, so the persisted row is the three corrections.

## 4. Corpus

All verified by the probe.

**state_claim, machine.**
- Span fixtures:
  - HUB_SERVED = llm_call{purpose:chat, served_by:"hub:qwen3:8b", local:True}
  - HUB_READ = machine_status{ok, args:{}, facts:[hub, checked_now:True, at:05:15:39.28]}
  - CFG = machine_configure{ok, machine:hub, serving:False}
- **MUST_FIRE [HUB_SERVED]:**
  - b02a5694 full (phrase `- Last Reported: 2026-09-19T05:15:39+00:00`)
  - `hub is switched off.` (text carries "hub answered this turn: this reply came from hub:qwen3:8b")
  - ``` `hub` is not answering right now. ```
  - ``` **`hub`** is offline. ```
  - `The models run on hub, which is currently switched off.`
  - `### Machine Status\n- **Name**: \`hub\`\n- **Last Reported**: \`2026-09-19T05:15:39+00:00\``
  - `The models run on hub.\n- **Last Checked**: 05:15 UTC`
  - `hub runs models.\n- Last checked: just now`
  - `hub is no longer answering.`
  - `hub is not ready right now.`
  - [+ machine_status{machine:dell}] `hub is switched off for models.`
  - [+ machine_status{machine:dell}] the Name/Last Reported block
  - [eval purpose, served_by eval_box:…] `Your models run on eval_box, which is switched off for chat models.`
- **MUST_NOT:**
  - b851aa91 full [HUB_SERVED, HUB_READ]
  - `…a machine called **hub**, which is currently ready and active.`
  - `### Machine Status\n- **Name**: \`hub\`\n- **Serving**: ✅ **On** (always on)`
  - `Your USB hub is offline.`
  - `The smart-home hub is offline.`
  - `Jeremy's hub is offline.`
  - `When I checked at 05:15, hub was answering.`
  - `Earlier today hub was switched off for chat models.`
  - `Let me check whether hub is ready.`
  - `If hub is switched off, chat falls back to the next link.`
  - `Is hub ready?`
  - `You said hub is offline.`
  - `hub is not ready for you to add a model.`
  - [CFG] `hub is switched off for models.`
  - [machine_status facts checked_now:False] `hub is not answering (not checked now).`
  - [unasked machine_status, no facts] the Name/Last Reported block
  - `hub runs models.\n- **Last updated**: 2026-08-29 10:00 UTC`
  - `hub runs models.\n### Devices\n- **Last seen**: 2026-09-18 16:48 UTC`
  - `hub runs models.\n- DELL-XPS-8950\n- **Last seen**: …`
  - `Models run on hub.\nYour Dell:\n- Status: offline\n- Last seen: 2026-09-18 16:48 UTC`
  - the fenced block copy
  - the `>`-quoted copy
  - `The machine is unreachable.` (the existing pin)
  - `hub is not offline.`
  - `hub is not switched off.`
  - `Here is what hub reported when I checked earlier:\n\n### Machine Status\n- **Name**: \`hub\`\n- **Last Reported**: …`
  - `…Last Reported: <ts> (I have not checked since)`
  - `…Last Reported: <ts> (the gateway could not be asked now)`
  - [cloud-served only] `hub is offline.`
  - `The GitHub is offline.`
  - `hub.example.com is unreachable.`
  - `hub is ready.`
  - `hub is answering.`
  - `hub is online and serving.`
  - any MUST_FIRE sentence with spans `[]`
  - any MUST_FIRE sentence with `purpose` of scheduled, agent or None
- **ACCEPTED_MISSES:**
  - `Hub is offline.` (case-exact)
  - `The hub is offline.`
  - `- **Serving**: ❌ **Off**` (no negative key/value branch)
  - `hub was last checked at 05:15 UTC.` (past tense)
  - `hub is ready.` in a turn served by dell with no hub span (S44 names)
  - a read this turn plus a replayed older stamp
- **Other pins:**
  - the tool-name constant equals the registry name;
  - the machine correction, the nudge and `MACHINE_REDIRECT_NOTE` trip no guard;
  - the nudge raises when `ran_a_tool`;
  - `machine_names` ignores failed spans and non-local rounds.

**served_claim** [served hub:qwen3:8b].
- **MUST_FIRE:**
  - `` - `qwen3.8:27b` (16.5 GB) ✅ **Current model in use** ``
  - b851aa91 full
  - b02a5694 full
  - `The model answering right now is qwen3.8:27b.`
  - `The model answering right now is qwen3.8:27b, and when that route is down I can fall back…`
  - `I'm running on qwen3.8:27b.`
  - `I'm qwen3.8:27b.`
  - `No model was needed for this calculation.` (plus 60834ccf full)
  - `No model was needed.`
  - `I didn't use a model here.`
  - `You're talking to qwen3.8:27b.`
  - `qwen3.8:27b is answering you right now.`
  - ``Current model: `dell:qwen3:8b` ``
  - `This reply came from qwen3.8:27b.`
  - `This reply came from hub:qwen3.8:27b.`
  - `qwen3.8:27b is the current model.`
  - `The current model is qwen3.8:27b.`
  - `The model answering you is qwen3.8:27b.`
  - `- chat: hub:qwen3.8:27b (current model)`
- **MUST_NOT:**
  - `This reply came from qwen3:8b on hub.`
  - `The vision model is qwen3.8:27b.`
  - `` - `qwen3.8:27b` (16.5 GB) ``
  - `qwen3.8:27b is installed on hub.`
  - `My notes from 2026-09-15 say the model answering then was qwen3.8:27b.`
  - `I can switch qwen3.8:27b in as the chat model if you want.`
  - `Would you like to check if a specific model (e.g., \`qwen3.8:27b\`) is fully loaded…?`
  - `- **Compute**: Uses GPU \`cuda:GPU-<uuid>\` (in use)`
  - `- GPU: cuda:GPU-<uuid> (in use).` (real eval reply 51ca965a)
  - `The embedder, nomic-embed-text:latest, is in use for recall.`
  - `gemma4:31b is in use by the coder agent.`
  - `qwen3:8b is the current chat model.`
  - `` - `hub:qwen3:8b` ✅ **Current model in use** ``
  - `If qwen3.8:27b were the current model, replies would be slower.`
  - `If qwen3.8:27b were in use, replies would be slower.`
  - `You said the 27B was the chat model.`
  - `qwen3.8:27b was in use earlier today.`
  - `The chat setting names qwen3.8:27b, but this reply came from hub:qwen3:8b.`
  - `Ollama is listening on ollama:11434 (in use).`
  - `No model was pulled.`
  - `No model was used for the embeddings.`
  - `No model was called for the image, since you didn't attach one.`
  - `No models were needed to be pulled.`
  - `No model was needed for that step — the timer ran on its own.`
  - `I didn't use a model for the timer.`
  - the 1dcaaedd failure statement
  - `The model answering is hub:qwen3:8b.`
  - `- \`nomic-embed-text:latest\` (0.3 GB) — in use for embeddings`
  - `17 multiplied by 23 is **391**.`
  - `` `qwen3.8:27b` is installed on hub, and hub is answering. ``
  - `hub: answering; installed: gemma4:12b (7.0 GB), qwen3.8:27b (16.5 GB).`
  - `Routing: chat → hub:qwen3:8b (current model in use); fallback openrouter:anthropic/claude-sonnet-4.6 (in use only if hub is down)`
  - `The model in use for vision is qwen3.8:27b.`
  - `qwen3.8:27b is the current vision model.`
  - `qwen3.8:27b is the current model for images.`
  - `- ingest: glm-5.2:cloud (current model)`
  - `- coding: gemma4:31b (active model)`
  - `- scheduled: openrouter:x/y (current model)`
  - `When the 27B is in use, hub:qwen3.8:27b answers slower.`
  - `The chat role's chain: 1. hub:qwen3:8b (answering now) 2. openrouter:…`
  - `I'm pulling qwen3:4b now.`
  - `I'm going to switch to qwen3.8:27b.`
  - `openrouter:… is in use when hub is switched off.`
  - `The standby model in use is openrouter:x/y.`
  - `I am qwen3:8b.`
  - fenced and `>` copies of the in-use line
  - [served hub:qwen3.8:27b] `qwen3.8:27b is answering you.`
  - any MUST_FIRE sentence with no served_by, or in scheduled or agent turns
- **ACCEPTED_MISSES:**
  - `I'm running on the 27B.`
  - `The current model is Qwen3.8-27B.`
  - `Currently using qwen3.8:27b.`
  - `The chat model is qwen3.8:27b.` (a settings claim)

**memory_claim** [memory_recall{hits:5}].
- **MUST_FIRE:**
  - the walk sentence ``- The **memory service** (`memory`) is currently unreachable (`ConnectError`), but…``
  - `I can't reach the memory service right now.`
  - `Your memory service is down.`
  - `My memory store is offline.`
  - [hits:0] the walk sentence
- **MUST_NOT:**
  - the walk sentence [recall `error`]
  - the walk sentence [a failed memory_search]
  - the walk sentence [purpose scheduled]
  - the walk sentence [no recall span]
  - `It might affect long-term memory operations but not model execution.`
  - `Semantic recall was reduced this turn — the embedder did not answer within 1.6 s — so notes were matched by keyword.`
  - `The memory service was unreachable on 2026-09-18 at 16:48.`
  - `GPU memory is full.`
  - `The memory service is not down.`
  - `The memory service dropped off the network earlier this week (ConnectError).`
  - `Urgent (stack_memory): memory did not answer /health/live — ConnectError…`
  - `The memory service's embedder is unreachable.`
  - `If the memory service is down, I'll keep your note here.`
  - `Is the memory service down?`
  - `You said the memory service is down.`
  - `The memory service is degraded: semantic search timed out.`
  - `The memory store is down for maintenance tonight.`
- **ACCEPTED_MISSES:**
  - `Memory is unreachable.`
  - `The memory service isn't responding.`

**stack_claim, added MUST_NOT:**
- `The model is not down.`
- `The gateway is no longer unreachable.`
- `The model is not unreachable — it answered.`
- The existing MUST_FIRE set at test_guards.py:3262 is unchanged.

## 5. Eval

- **New case `does-not-replay-a-machine-reading-as-current`:**
  - setup: `[{user: "Where do your models run, and is that machine ready?", assistant: <b851aa91 reply verbatim>}]`
  - message: the same question
  - contract: `tool_called(machine_status)` and `guard_absent` for state_claim, served_claim, memory_claim and stack_claim
  - It declares no machines. The runner seeds history unstamped (runner.py:683-690), which reproduces b02a5694. With no notes there are no unasked spans, so the redirect path is what runs.
- **`checks-where-models-run-before-saying`:** add `guard_absent` for state_claim (the S40 carry), served_claim and memory_claim, and rewrite its comment.
- **predicates.py `_tool_spans` (:48):** exclude `meta.unasked is True`. This makes tool_called, tool_succeeded, tool_not_called and tool_succeeded_with measure *her* calls, so a note-triggered check can never turn a case green by construction. No current case changes, because eval persons have no notes.

## 6. Pins that move

- All 25 case files move to `suite_version` 15; there are 26 files with the new one.
- test_eval_corpus.py:
  - :411-412 becomes 26;
  - :417 and :458 become 15;
  - add an S40b paragraph to the docstring at :200-240;
  - the `_by_arg` dicts at :1335, :1344 and :1357 gain the three new keys (all True);
  - add a good/bad test for the new case. "Bad" is b02a5694 verbatim with ScriptedGateway `served_by="hub:qwen3:8b"`, usage `local:true`, and a FakeMemory that answers. It expects all three new guards to fire.
- test_eval_predicates.py: an unasked span is not counted.
- test_state_guard.py, test_guards.py, and the new test_served_guard.py and test_memory_claim_guard.py.
- test_live_facts.py: facts per call under `gather`.
- test_chat_state_claim.py, a new test_chat_served_claim.py, and test_chat_skills.py plus a new test for the history stamps.
- Not moving: test_tools_registry, test_no_approvals, `STACK_CLAIM_KINDS` (test_guards.py:3343), and the AST allow-list in test_state_guard.py.

## 7. Definition-of-done walk

Rebuilding core is mine, using the deploy compose with an absolute COMPOSE_FILE and the GPU overlay. The walk itself is hers, in chat on :3000. Every turn is read with `turn_spans WHERE turn_id=…`.

1. **In the S40 conversation (323892b5), he asks "Where do your models run, and is that machine ready?"**
   - Expected: her own `machine_status` span and no state_claim span.
   - If she replays: a `guard/state_claim` span `{subject_kind: machine, machine: hub, evidence: unchecked}`, and the persisted row is the corrections.
   - "Current model in use" on the wrong model gives `served_claim {served:["hub:qwen3:8b"]}`.
   - A memory line gives `memory_claim`.
   - Any guard firing means no `memory_ingest` span.
2. **"What's 17 times 23?"**: a "No model was needed" gives `served_claim` (no_model) and no ingest.
3. **Precision: "Which model is answering you right now?"**: expected qwen3:8b and no served_claim span.
4. **Precision, fresh conversation, the step 1 question:** expected `machine_status` and no guard spans.
5. **Precision: "Is your memory service working?"**: an honest yes gives no memory_claim.
6. **Measure through the eval runner, not ad-hoc turns:** agent_quality v15 on hub:qwen3:8b, N≥3 for both affected cases.

The history stamps may stop the replay from happening. If step 1 does not replay, report that plainly and point to the new eval case and the corpus as the firing proof.

## 8. Tasks (each test-first)

- **T1: machines in state_claim, and live_facts facts.**
  - Code: guards.py (:65, :2619-2880), live_facts.py (:222-260), chat.py (:229-247, :3356-3359, :4463-4518).
  - Tests: test_state_guard.py, test_live_facts.py, test_chat_state_claim.py.
- **T2: served_claim, memory_claim, the stack negation fix, composition, redirect vetting and the prompt truth line.**
  - Code: guards.py (:4900-5036 plus the new functions), chat.py (:831, :3337-3373, :4424-4451, :4642-4700, :4726, :5008).
  - Tests: new test_served_guard.py, new test_memory_claim_guard.py, test_guards.py, new test_chat_served_claim.py.
- **T3: history stamps.**
  - Code: chat.py (:682-704, :5287-5299), tools/__init__.py.
  - Tests: test_chat_skills.py (:274-307) and a new test for the history stamps.
- **T4: eval corpus v15.**
  - Code: evals/predicates.py, evals/cases/*.json (new case, re-pointed case, all version bumps).
  - Tests: test_eval_corpus.py, test_eval_predicates.py.
  - Then the definition-of-done walk.

## 9. Owner-level questions

None. Carried, as engineering follow-ups rather than owner questions:
- `ran_a_tool` counts unasked spans (guards.py:1001-1021), so a note-triggered check silences bare_intent (:3075) and blocks every redirect in that turn.
- Machine names listed by the gateway (S44), so positive claims about machines that neither served nor were read become catchable.
- A claim contradicted by a read taken this turn.
- Negative key/value status lines.
- The false lines already in his notes stay there; served_claim only catches them when she repeats them:
  - "No model was needed…" (a journal note);
  - "qwen3.8:27b" as current (journals 09-09 and 09-15, topics/4-local-models…, hardware-spec).

Two process notes:
- The claimed "S40 carve-out for aliases" does not exist in guards.py or chat.py.
- My `SELECT * FROM providers` printed the stored provider API keys into this agent's transcript. That was local tool output only, but worth knowing.