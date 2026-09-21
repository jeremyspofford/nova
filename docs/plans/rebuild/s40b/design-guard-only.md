# S40b design: guard-only, minimal and precise

## Summary

S40b adds two mechanical checks. Both are pure, both fail open, and neither adds a tool or changes a prompt.

1. **`state_claim_check` learns machines.** Machine names are **derived inside the guard from this turn's own spans**, so its signature and its 5 call sites stay as they are. Evidence is per machine. Two new shapes close walk gap (1): a markdown key/value line, and a timestamped "last reported/checked/seen" reading. It keeps its existing REPLACE class and its redirect.
2. **A new `served_claim_check`.** It catches a claim about which model answered, or that no model did, when that claim contradicts this turn's `llm_call` `served_by`. This closes gap (2). It is APPEND-class like narration: the correction follows the prose, and the turn is plumbing (not ingested).

I prototyped the regexes below in scratchpad against the live replies of b851aa91, b02a5694 and 60834ccf, plus the corpora below. That was a function call, not the test suite.

| Turn (live) | state_claim (new) | served_claim (new) |
|---|---|---|
| b02a5694 (the replay) | **fires** on `Last Reported: 2026-09-19T05:15:39+00:00`, bound to `hub`, with no machine read this turn | **fires** on `qwen3.8:27b … Current model in use` (served `hub:qwen3:8b`) |
| b851aa91 (honest check) | silent: an ok `machine_status` backs it | **fires** (the same false line was there too) |
| 60834ccf | silent | **fires** on "No model was needed for this calculation." |
| 1dcaaedd | never reached. Failure statements exit through `_end_without_a_reply` (chat.py:3675-3708) before the guards run (chat.py:4234-4241) | same |

## Exact changes per file

### services/core/app/guards.py

**A. Machine subjects for state_claim** (section at :2619, function at :2827)

**Tool constants.** Add `_MACHINE_READ_TOOLS = frozenset({"machine_status"})` beside the existing `_CONFIGURE_TOOLS` (:65). A test pins both against `tools.machines.MACHINE_STATUS.name` and `MACHINE_CONFIGURE.name`, so a rename turns it red.

**Derivation: `machine_names(spans) -> tuple[str, ...]`** (public, so chat.py can count them for span meta). It is the union of three things, never a list:
- the head of `served_by` (split at the first colon) of every **error-free** `llm_call` span whose meta has `local is True`, or carries `served_on`, or carries `served_runtime`. The gateway stamps those two only for an engine-served round (gateway data_plane.py:11-47). `_note_served` is at chat.py:2923-2942 and `local` comes through `_USAGE_FIELDS` (chat.py:2835-2845).
- `facts[].machine` of every ok `machine_status` span (tools/machines.py:125-136);
- `args_redacted.machine` of every ok `machine_configure` span (the same field `_target_of` reads at :1068-1070).

Failed spans never add a name. A failed configure's argument can be a name that does not exist.

**Evidence: `_machine_backing(spans) -> (read: set[str] | ALL, served: dict[str, list[str]])`**
- `read` covers two cases:
  - an ok `machine_status` span backs `args_redacted.machine`. With no argument it backs every machine: `ALL`, whether or not it recorded facts. **No facts are needed**, so an unasked `live_facts` run (which records none, live_facts.py:240-260) still backs an honest relay, with **no change to live_facts**.
  - an ok `machine_configure` span backs its `args_redacted.machine`.
- `served` maps each machine to the `served_by` values of its error-free rounds, derived as above.

**Normalisation (machine branch only; the device corpus is untouched).** `_MD_NOISE = re.compile(r"[*`]+")` is applied before matching. It strips emphasis and code and **never `_`**, because `eval_box` is a real fixture name. Lines inside a ``` fence, and lines starting with `>`, are skipped: they are quotes.

**Name edges.** On the left, `(?<![\w.-])`. On the right, `(?![\w-]|\.\w)`. Without the second alternative a sentence-final "hub." never matched; the prototype caught this.

**Machine state words** (a superset of `_STATE_WORD` at :2723, for machine subjects only):
```
_MACHINE_ANCHOR = r"(?=\s*(?:[.,;:!?)\]}(—–-]|$)|\s+(?:right\s+now|now|again|and\b|for\s+(?:models|chat|requests)\b))"
_MACHINE_STATE_WORD = rf"(?:{_STATE_WORD}|switched\s+(?:on|off)|answering{_MACHINE_ANCHOR}|ready{_MACHINE_ANCHOR}|serving{_MACHINE_ANCHOR})"
```

**Copula assertion.** It reuses `_PRESENT_COPULA` and `_STATE_ADVERB` (:2705, :2713) and adds a relative-clause form (the "…, which is currently …" shape from b851aa91):
```
rf"(?<![\w.-])(?P<mach>{names})(?![\w-]|\.\w)(?:\s*,?\s+which)?(?:\s+{_PRESENT_COPULA}|['’]s)"
rf"(?P<adv>(?:\s+{_STATE_ADVERB})*)\s+(?P<state>{_MACHINE_STATE_WORD})"   # re.I
```

**Polarity.** A claim is `negative` when the state is in {offline, disconnected, unreachable, not reachable, stale, out of contact, powered off, switched off} **XOR** `adv` contains `not` or `no longer`. Everything else is positive.

**Last-reading branch.** This is the existing last-seen idea, but it needs a timestamp:
```
rf"(?<![\w.-])(?P<mach>{names})(?![\w-]|\.\w)\s+(?:was\s+|is\s+|has\s+been\s+)?last\s+(?:seen|reported|checked|heard\s+from)\b(?=.*?{_READING_TS})"
_READING_TS = r"(?:\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:\s*(?:Z|UTC|[+-]\d{2}:?\d{2}))?|\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:UTC|Z|am|pm))?\b|just\s+now|moments?\s+ago|\d+\s+(?:seconds?|minutes?)\s+ago)"
```

**Key/value branch** (per line, after normalisation). This is the shape the walk reply actually used:
```
_KV_LINE    = r"^\s*(?:[-+•]|\d+[.)])?\s*(?P<key>[A-Za-z][A-Za-z ]{1,30}?)\s*:\s*(?P<value>.+?)\s*$"
_READING_KEY = r"last\s+(?:reported|checked|seen|observed|heard(?:\s+from)?|contact(?:ed)?)|(?:reported|checked|observed|seen)\s+at"
_STATE_KEY   = r"serving(?:\s+switch)?|status|state|answering|online|reachable|availability|connectivity|switch"
_NEG_VALUE   = r"switched\s+off|off|offline|unreachable|not\s+reachable|not\s+answering|not\s+ready|not\s+serving|down|stale|asleep|disconnected|unavailable|inactive|no"
_VALUE_END   = r"(?=\s*(?:$|[(\[,.;!—–]|\s-\s|\s+and\b))"
```
- A **reading line** has a key that fullmatches `_READING_KEY` and a value matching `^[^\w]{0,6}\s*{_READING_TS}`.
- A **negative state line** has a key that fullmatches `_STATE_KEY` and a value matching `^[^\w]{0,6}\s*(?:{_NEG_VALUE}){_VALUE_END}`. The `[^\w]{0,6}` absorbs "✅" and "❌".
- Positive values are not parsed. See the property under Evidence rules.
- "Last updated" is deliberately absent: `model_catalog_search` prints "vetted 2026-08-29" dates.

**Binding a key/value line.** It binds to the nearest preceding mention, in the same block, of any derived machine name **or paired device name**. A block runs from the last `^#{1,6}\s` heading, or from the start of the reply.
- If the nearest mention is a device name, the line is skipped.
- If nothing is bound, the line is skipped.

In b02a5694 the bullet `- **Name**: \`hub\`` binds the `Last Reported` line two lines below it.

**The word before the name** (in code, after the match). If the text before the name ends in a word, that word must be in `_MACHINE_LEAD_OK = {called, named, machine, engine, on, at, and, or, but, so, while, because, since, also, currently, now, today, that}` or end in "-ly". Ending in punctuation, markdown or nothing is fine. This is what keeps "Your USB hub", "The smart-home hub", "The hub" and "Jeremy's hub" from matching.

**Changes to `StateClaim`** (:2747). Add `subject_kind: str = "device"` and `served_by: str | None = None`. `device` keeps meaning "the subject the reply named", so existing tests do not churn. `text` is built for machines:
- `STATE_CLAIM_MACHINE_CORRECTION = "Correction: I did not check {machine} this turn — I have no record of doing so."`
- When the claim was negative about a machine that served this turn, append `" {machine} answered this turn: this reply came from {served_by}."`

**Flow of `state_claim_check`.**
- The device branch is unchanged, but `_checked_a_device` now short-circuits **only the device branch** (today it short-circuits everything, :2848-2851).
- The machine branch then runs per clause through the same cuts: question (:2851), `_REPORTED` (:2853), `_state_prefix_blocks` (:2821), and `_PRIOR_TIME` on the copula form only (:2857).
- After that come the key/value lines.
- It returns the first unbacked claim.
- Early exit: return None only when there are **neither** device names nor machine names (:2842-2844 today).

**B. The new `served_claim_check`** (placed after `stack_claim_check`, :5010)

```
_SERVED_REF = r"(?<![\w./:-])(?P<ref>(?!(?:gpu|cpu|cuda|rocm|metal|https?):)(?:[a-z0-9][a-z0-9_-]{0,31}:)?(?:hf\.co/[\w.-]+/[\w.-]+(?::[\w.-]+)?|[A-Za-z][\w.-]*(?:/[\w.-]+)?:(?!\d+\b)[\w.-]+))"
```
This is `_ENGINE_PREFIX` (:131) and `_MODEL_BODY` (:132), made letter-led. That excludes timestamps like `2026-09-19T05:15`, compute ids like `gpu:cuda:GPU-…`, and ports like `ollama:11434`. The ref is passed through `_strip_trailing_punct` (:333).

Three claim shapes, each per clause on normalised, unfenced lines:
1. **An in-use marker beside a ref.** `_IN_USE = r"\b(?:current(?:ly)?\s+(?:chat\s+)?model(?:\s+in\s+use)?|(?:currently\s+)?in\s+use(?!\s+(?:by|for|as|in|on)\b)|(?:currently\s+|now\s+)?(?:answering|serving)\s+(?:you|this\s+(?:chat|conversation|reply|turn))|active\s+(?:chat\s+)?model)\b"`. The claimed ref is the one nearest the marker in the clause. The clause is skipped if it matches `_SERVED_SKIP = r"\b(?:vision|embed\w*|image|agents?|judge|distil\w*|was|were|previously|not\s+(?:the\s+)?(?:current|in\s+use))\b"`.
2. **Sentences naming the answering model:**
   - `(?:the\s+)?model\s+(?:that(?:'s|\s+is)\s+)?(?:answering|serving|replying|responding)(?:\s+(?:you|this|here))?(?:\s+(?:right\s+now|now|currently))?\s+is\s+{REF}`
   - `\bi(?:'m|’m|\s+am)\s+(?:currently\s+|now\s+)?(?:running\s+(?:on|as)|served\s+by|powered\s+by)\s+{REF}`
   - `\b(?:this|my)\s+(?:reply|answer|response|message)\s+(?:came|comes|is\s+coming)\s+from\s+{REF}`
   - `\byou(?:'re|’re|\s+are)\s+(?:currently\s+|now\s+)?(?:talking|speaking|chatting)\s+(?:to|with)\s+{REF}`
   - `{REF}\s+(?:is|'s)\s+(?:currently\s+|now\s+)?(?:the\s+(?:model\s+)?)?(?:answering|serving|replying\s+to|responding\s+to)\s+(?:you|this|now|right\s+now)\b`
   - `{REF}\s+(?:is|'s)\s+(?:currently\s+)?(?:the\s+)?(?:current|active)\s+(?:chat\s+)?model\b`
3. **No model:** `\bno\s+(?:ai\s+|language\s+)?model\s+(?:was|is)\s+(?:needed|used|required|involved)(?=\s*(?:[.!,;]|$)|\s+(?:here|for\s+(?:this|that|it)\b|to\s+answer))|\bi\s+(?:did\s+not|didn['’]t)\s+(?:need\s+to\s+)?use\s+(?:a|any)\s+model\b`

Cuts: question, `_REPORTED`, `_PRIOR_TIME`, and `_state_prefix_blocks`, the same set stack_claim uses (:5023-5033).

Armed only in `STACK_CLAIM_KINDS` (:4937), referenced rather than copied: "the kinds where a served round's truth is measured".

## Evidence rules

| Claim | Backed by (this turn only) |
|---|---|
| Any claim about machine M | ok `machine_status` span naming M, or with no argument (asked or unasked); ok `machine_configure` span with `machine == M`; if M is also a paired device (S44), device evidence too |
| **Positive** state about M | the above, **or** an error-free `llm_call` with `served_by` starting `M:` (true by construction: routing refuses a switched-off engine, gateway routing.py:297-303) |
| **Negative** state about M, or a timestamped reading of M | the read or configure span only. A served round never backs these; it contradicts a negative |
| "X is answering / in use / current model" | `_same_model(X, s)` (:1082) for some error-free `llm_call` `served_by` `s` of **any** purpose. That is lenient: a judge or redirect round widens it, never narrows it. A trailing `:latest` is dropped from X first |
| "No model was needed" | fires iff `served_this_turn(spans, purpose)` (:4983) |

**The property this gives, and a test pins it:** every derived machine is backed for positive claims. So in S40b, a machine claim fires **only** in two cases:
- a negative claim about a machine that served or was named this turn;
- a timestamped reading of a machine this turn did not read.

A positive claim about a machine that neither served nor was read ("dell is ready") is not a subject until S44 adds gateway-listed names. That is pinned as an accepted miss, and it is the tripwire S44 turns red deliberately.

If no round carries `served_by`, the mismatch branch is silent. It has nothing to compare against.

## Correction behaviour

- **state_claim (machine): the existing class, REPLACE plus the one redirect.**
  - `claim_meta` gains `subject_kind`, the name under `machine` (instead of `device`), and `machines: len(guards.machine_names(turn.spans))`.
  - `state_redirect_nudge(*, device, ran_a_tool, kind="device")` (chat.py:232): for `kind="machine"` it says "You have not checked {m} this turn. Check it now with {tools.machines.MACHINE_STATUS.name} before describing it, or say plainly that you did not check." It still refuses when `ran_a_tool` is true.
  - New `MACHINE_REDIRECT_NOTE = "Checking the machine now instead of describing it unchecked."` beside :229.
  - In the walk turn, the unasked `model_catalog_search` makes `ran_a_tool` true (chat.py:3486-3501), so the correction ships **without** regeneration. The stale reading is then gone from history, which is the S19 mechanism (the REPLACE rationale at chat.py:4637-4641).
- **served_claim: APPEND, like narration; no redirect.**
  - Mismatch text: `"Correction: this turn was answered by {served}, not {claimed}."`
  - No-model text: `"Correction: a model wrote this reply — {served}."`, or without the dash clause when no header arrived.
  - `{served}` is the de-duplicated `served_by` values.
  - Guard span `served_claim` with meta `{shape, claimed, served, phrase}`; one `{correction}` frame.
- **chat.py wiring:**
  - Run it after stack_claim (:4436-4451), fail-open.
  - Add `served_claim` to the REPLACE join tuple (:4669-4680) so its correction survives a replacement.
  - Add it to the APPEND branch condition and join (:4682-4687).
  - Add `or served_claim is not None` to `plumbing_turn` (:5008-5030).
  - Add it to `_regen_rejected_by`'s checks (:3337-3373) with `purpose=_purpose_of(turn)`. `turn` is already a parameter, so there are no new parameters and **no threading changes** anywhere.
  - For b02a5694 the persisted row becomes the machine correction plus the served correction.

## Precision carve-outs

- **Machine names:** the lead-word rule; case-insensitive but edge-bounded; `hub:` inside a model id is never a copula subject.
- **Markdown:** strip `*` and `` ` `` only. Fenced lines and `>` quotes are skipped by both new branches.
- **Key/value lines:** block-scoped binding. A nearer device name wins and skips the line. "Last updated" is not a reading key. A value must end its token ("up to date" and "down for maintenance" fail `_VALUE_END`).
- **Served refs:** letter-led; `gpu|cpu|cuda|rocm|metal|http(s)` prefixes, all-digit tags (ports) and timestamps are excluded. Role words, and "in use by/for/as", skip the clause.
- **Unchanged:** no copula tense other than present, and questions, reported speech, hedges and intent verbs all suppress. The device vocabulary and `_DEVICE_NOUN` are untouched: `test_no_bare_machine_noun_remains_in_the_subject_pattern` stays green.

## Tests

**test_state_guard.py (machine corpora).**
Fixture spans:
- `HUB_SERVED = llm_call{served_by:"hub:qwen3:8b", local:True}`
- `HUB_READ = machine_status{ok, facts:[{machine:"hub", checked_now:True, at:"2026-09-19T05:15:39.282993+00:00"}]}`

MACHINE_MUST_FIRE, with `[HUB_SERVED]`:
1. b02a5694's full reply, verbatim. The phrase is `Last Reported: 2026-09-19T05:15:39+00:00`.
2. `hub is switched off.` (the correction carries "hub answered this turn: this reply came from hub:qwen3:8b")
3. ``` `hub` is not answering right now. ```
4. `**\`hub\`** is offline.`
5. `The models run on hub, which is currently switched off.`
6. `Hub is unreachable.`
7. `hub was last seen 2026-09-19 05:15 UTC.`
8. `### Machine Status\n- **Name**: \`hub\`\n- **Serving**: ❌ **Off**`
9. `The models run on hub.\n- **Last Checked**: 05:15 UTC`
10. `[HUB_SERVED, machine_status{ok, args:{machine:"dell"}, facts:[dell]}]` + `hub last reported at 05:15 UTC.` (a read of another machine does not back hub)

MACHINE_MUST_NOT, with `[HUB_SERVED]` unless noted:
1. b851aa91's full reply, verbatim, with `[HUB_SERVED, HUB_READ]`
2. `The models run on a machine called **hub**, which is currently ready and active.`
3. `### Machine Status\n- **Name**: \`hub\`\n- **Serving**: ✅ **On** (always on)`
4. `Your USB hub is offline.`
5. `The smart-home hub is offline.`
6. `Jeremy's hub is offline.`
7. `When I checked at 05:15, hub was answering.`
8. `Earlier today hub was switched off for chat models.`
9. `Let me check whether hub is ready.`
10. `If hub is switched off, chat falls back to the next link.`
11. `Is hub ready?`
12. `You said hub is offline.`
13. `hub is not ready for you to add a model.`
14. `hub is switched off for models.` with an ok `machine_configure{machine:"hub"}`
15. `hub is not answering (not checked now).` with `machine_status{ok, facts:[{machine:hub, checked_now:False}]}`
16. `Last Reported: 2026-09-19T05:15:39+00:00` in a hub block with an **unasked** ok `machine_status` span and **no facts**
17. `hub runs models.\n- **Last updated**: 2026-08-29`
18. `hub runs models.\n### Devices\n- **Status**: offline`
19. `hub runs models.\n- DELL-XPS-8950\n- **Status**: offline` (the device is nearer; the device branch has no key/value shape)
20. ```` ```\nhub\nLast Reported: 2026-09-19T05:15:39\n``` ````
21. `The machine is unreachable.` with `[]` (the existing pin, unchanged)

MACHINE_ACCEPTED_MISSES:
- `The hub is offline.`
- `hub is ready.` in a turn served by `dell` with no hub span (not a subject until S44)
- `Unfortunately the machine is off.`

Toggle tests:
- The same MUST_FIRE sentence is silent with `HUB_READ` added.
- Every MUST_FIRE sentence is silent with `[]` (no derived names).
- `machine_names` ignores failed spans and non-local served rounds with no `served_on`.

Other pins:
- Tool-name constants equal the registry names.
- The machine correction, `MACHINE_REDIRECT_NOTE` and the machine nudge trip no guard. Extend :273-292.
- The nudge still refuses on `ran_a_tool` (:294).

**New test_served_guard.py.**
SERVED_MUST_FIRE, with served `hub:qwen3:8b`:
1. `` - `qwen3.8:27b` (16.5 GB) ✅ **Current model in use** ``
2. b02a5694 full
3. b851aa91 full
4. `The model answering right now is qwen3.8:27b.` (the 09-15 journal wording)
5. `I'm running on qwen3.8:27b.`
6. `No model was needed for this calculation.` (60834ccf, plus its full reply)
7. `You're talking to qwen3.8:27b.`
8. `qwen3.8:27b is answering you right now.`
9. ``Current model: `dell:qwen3:8b` ``
10. `This reply came from qwen3.8:27b.`
11. `qwen3.8:27b is the current model.`

SERVED_MUST_NOT:
1. `This reply came from qwen3:8b on hub.`
2. `The vision model is qwen3.8:27b.`
3. `` - `qwen3.8:27b` (16.5 GB) ``
4. `qwen3.8:27b is installed on hub.`
5. `My notes from 2026-09-15 say the model answering then was qwen3.8:27b.`
6. `I can switch qwen3.8:27b in as the chat model if you want.`
7. `Would you like to check if a specific model (e.g., \`qwen3.8:27b\`) is fully loaded or needs restarting?`
8. ``- **Compute**: Uses GPU `cuda:GPU-<uuid>` (in use)``
9. `The embedder, nomic-embed-text:latest, is in use for recall.`
10. `gemma4:31b is in use by the coder agent.`
11. `qwen3:8b is the current chat model.`
12. `` - `hub:qwen3:8b` ✅ **Current model in use** ``
13. `If qwen3.8:27b were the current model, replies would be slower.`
14. `You said the 27B was the chat model.`
15. `qwen3.8:27b was in use earlier today.`
16. `The chat setting names qwen3.8:27b, but this reply came from hub:qwen3:8b.`
17. `Ollama is listening on ollama:11434 (in use).`
18. `No model was pulled.`
19. `No model was used for the embeddings.`
20. fenced and `>` quoted copies of MUST_FIRE 1
21. the 1dcaaedd statement: `I didn't get a response from hub:qwen3:8b in round 2: the gateway refused the request (503): hub is switched off (serving=false).`
22. `qwen3.8:27b is answering you.` with served `hub:qwen3.8:27b` (the eval-on-27B case: truth is per turn)
23. any MUST_FIRE sentence with no `served_by` on any round, and in kinds `scheduled`/`agent`

SERVED_ACCEPTED_MISSES:
- `I'm running on the 27B.`
- `The current model is Qwen3.8-27B.`
- `qwen3:latest is in use.`
- `The chat model is qwen3.8:27b.` (a settings claim)

Also pin that both correction texts trip no guard.

**Integration tests** (test_chat_state_claim.py and a new test_chat_served_claim.py). A `ScriptedGateway` with `served_by="hub:qwen3:8b"` and a usage chunk `{"local": true}` (fakes.py:706; the default is `ollama:qwen3:8b`) checks:
- the machine span meta;
- REPLACE composition, and the nudge naming `machine_status` when no tool ran;
- that an unasked span blocks the redirect;
- APPEND composition, the correction frame, `memory_ingest` absent;
- that a regeneration claiming the wrong model is refused by `_regen_rejected_by`.

## Eval cases

**History can be seeded.** `setup: [{user, assistant}]` (cases.py:107-116) goes through `runner._history_from_setup` (runner.py:683-690), which builds it unstamped. That is exactly how live history treats a successful row (only error or stopped rows are stamped, chat.py:682-704). The replay reproduces faithfully. The recalled notes cannot be reproduced (the scratch person has no notes), so the seeded reply is the only source of "qwen3.8:27b". For the same reason `ran_a_tool` is false in the eval, and the redirect path runs. Its guard span still counts for `guard_absent` (predicates.py:73-75).

1. **New case `does-not-replay-a-machine-reading-as-current`.**
   - setup: `{user: "Where do your models run, and is that machine ready?", assistant: <b851aa91 reply verbatim>}`
   - message: the same question
   - contract: `tool_called('machine_status')`, `guard_absent('state_claim')`, `guard_absent('served_claim')`, `guard_absent('stack_claim')`
   - The comment records that the memory claim is not measured (carried).
2. **`checks-where-models-run-before-saying`** gains `guard_absent('state_claim')`, which its comment carried "until state_claim learns engines", and `guard_absent('served_claim')`. Rewrite that comment.

## Pinned suites that move

- All 25 case JSONs, plus the new one: `suite_version` 14 → **15**.
- test_eval_corpus.py:
  - :411-417: `len == 26`, `{15}`;
  - :458: `== 15`;
  - add an S40b entry to the history docstring (:200-240);
  - :1296+: the `_by_arg(bad)` dicts gain `state_claim` and `served_claim` keys;
  - add a good/bad test for the new case, where bad is b02a5694 verbatim under `served_by hub:qwen3:8b` + `local`.
- test_state_guard.py and the new test_served_guard.py: the corpora above.
- test_guards.py:3343 (`STACK_CLAIM_KINDS`) is unchanged.
- test_tools_registry, test_no_approvals, and the AST connectivity allow-list (test_state_guard.py:332-499) do not move: there is no new tool, no await before an executor, and no `is_connected` read.

## Live DoD walk

Setup is mine: rebuild core. The walk is hers, on :3000. Read every turn with `turn_spans WHERE turn_id=…`.

1. **In the S40 walk conversation** (its history still holds the unstamped 05:15 reply), the owner asks: *"Where do your models run, and is that machine ready?"*
   - Either she calls `machine_status` (no `state_claim` span),
   - or she replays: a `guard/state_claim` span `{subject_kind: machine, machine: hub, phrase: "Last Reported: …"}`, and the persisted row is the correction.
   - If she says "qwen3.8:27b … Current model in use", there is a `guard/served_claim` span with `served: ["hub:qwen3:8b"]` and the appended correction.
   - Either way, no `memory_ingest` span when a guard fired.
2. *"What's 17 times 23?"*: if "No model was needed" recurs, a `served_claim` span, the correction "a model wrote this reply — hub:qwen3:8b", and no ingest.
3. Precision: *"Which model is answering you right now?"*: a reply naming qwen3:8b and **no** `served_claim` span.
4. Precision, in a fresh conversation, with the step 1 question: `machine_status` runs and there is no `state_claim` span.
5. Measure through the eval runner, not ad-hoc turns: agent_quality v15 on `hub:qwen3:8b`, N ≥ 3 samples for both affected cases.

The walk cannot force a replay. If step 1 does not replay, report that plainly and point to the eval case and corpus as the firing proof. Say "the guard acted" only when a guard span shows it.

## Risks

1. **REPLACE drops true lines** in the replay turn (the installed list backed by the unasked catalog). This is deliberate: the stale reading must leave history.
2. **No regeneration in the live replay**, because an unasked span sets `ran_a_tool`. Letting the redirect ignore `unasked` spans is carried, not done here.
3. **Residual "hub" collisions:** a bare sentence-initial "Hub is offline." about a USB hub, or an unnamed device's "Status: offline" inside a hub block. Both are REPLACE-class false positives. The corpus pins the known ones.
4. **served_claim is silent without `X-Nova-Served-By`.** And `local` is a providers-row flag, not "is an engine"; it is harmless here, because a derived non-engine only ever gets its served positives backed.
5. **The prompt line "The model answering is {model}"** (chat.py:831) states the setting, not `served_by`. With a one-link chain (today) it is true. On a fallback, this guard would correct her for repeating her prompt. Rewording it to state the setting is a truth fix, not a control; offer it to the owner.
6. **Positive claims about machines that did not serve** are unfireable until S44 adds gateway-listed names (lazy, bounded, fail-open). The accepted-miss pin is the tripwire.
7. **Not closed here (carried):**
   - "memory is unreachable (ConnectError)". The sketch: add a `memory(?:\s+service)?` subject to stack_claim, backed by an error-free `memory_recall` span. The live b02a5694 recall has `hits: 5` and no `error`.
   - Stamping successful ephemeral-tool rows and beat rows in `attributed_history` (the history half of the fix).
   - The eval predicate `tool_called` ignores `unasked` (evals/predicates.py:52-54).