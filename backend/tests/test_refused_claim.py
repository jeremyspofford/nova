"""A refused tool call is not evidence that the thing happened.

    docker compose exec backend python tests/test_refused_claim.py

MEASURED 2026-08-07. Nova was asked to fix a malformed model row in the pool.
She reached the right tool with the right arguments —
`manage_curated_models{add}`, then `manage_curated_models{disable}` — and the
goal gate refused BOTH, because tending the pool creates capability and no
standing goal covered it. Nothing changed anywhere.

Her reply ended:

    ": correct row in, bad row retired, and it'll be selectable in
     Settings -> Agents as a chat model."

Verified in the database afterwards, not inferred: the row was untouched,
still enabled, still `tool_tier=C`, still `roles={}`, and `main` still pinned
to the malformed id.

**Nothing caught it, for two INDEPENDENT reasons, and the second is the
interesting one.**

1. `_could_have_done` asked "did any tool called this turn plausibly perform
   this claim?" — and `manage_curated_models` HAD been called. Its name
   tokens satisfy a claim about managing a model, so the arm passed. A call
   that ran and was refused counted as evidence for the outcome its refusal
   made impossible. Fixed by a contract: callers pass tools that SUCCEEDED.

2. Her phrasing matched no `_COMPLETION_PATTERNS` entry at all. There is no
   "I added", no "Saved.", no "done —". It is a bare assertion of resulting
   state, and no list of verbs was ever going to contain it. **Adding a
   pattern for it would fix this sentence and not the next one** — the
   "derived, never hardcoded" rule, applied to a detector rather than a gate.

`refused_note` is the answer to (2): it reads no text, so it has no
vocabulary to fall behind. It reports a fact the turn already holds.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import narration                                # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# The real reply, trimmed to the claim.
CLAIM = ("Let me get the model manager to sort this out end to end. "
         ": correct row in, bad row retired, and it'll be selectable in "
         "Settings as a chat model.")

print("\nwhy the phrase-matching arms could never have caught this")

check("her actual sentence matches NO completion pattern, even with zero "
      "successful tools",
      narration.detect(CLAIM, 1, []) is None,
      "documenting the limit, not endorsing it")

check("...while a phrasing that IS on the list is caught",
      narration.detect("Added it — the row is in.", 1, []) is not None)


print("\nthe derived arm: no vocabulary, so nothing to fall behind")

note = narration.refused_note(["manage_curated_models", "manage_curated_models"])
check("two refusals of one tool produce a note", note is not None)
check("...naming the tool", "manage_curated_models" in note, note)
check("...counting the retries", "2x" in note, note)
check("...and saying plainly that nothing changed",
      "changed nothing" in note, note)
check("...and contradicting any claim above it",
      "not accurate" in note, note)

check("it fires on HER exact sentence, which the pattern arms miss",
      narration.refused_note(["manage_curated_models"]) is not None)

check("a clean turn is untouched", narration.refused_note([]) is None)
check("None is untouched", narration.refused_note(None) is None)
check("whitespace-only names are not a refusal",
      narration.refused_note(["  ", ""]) is None)

multi = narration.refused_note(["manage_curated_models", "pull_model"])
check("several distinct tools are all named",
      "manage_curated_models" in multi and "pull_model" in multi, multi)
check("...and a single refusal reads as singular",
      "1 tool call was refused" in narration.refused_note(["pull_model"]),
      narration.refused_note(["pull_model"]))


print("\nthe succeeded-tools contract (defect 1)")

check("a completion claim with no SUCCESSFUL tool is flagged",
      narration.detect("Added it — the row is in.", 1, []) is not None)

check("...and the same claim is allowed when a real call succeeded",
      narration.detect("Added it — the row is in.", 1,
                       ["manage_curated_models"]) is None)


print("\nthe fail-open trade is preserved on purpose")

# A false accusation is appended to the reply and read aloud, so this family
# buys precision with recall everywhere. Pin that it still does.
check("an unrecognised claim verb is NOT accused",
      narration.detect("I pondered the situation at length.", 1,
                       ["search_memory"]) is None)
check("a plain answer with no completion claim is untouched",
      narration.detect("DeepSeek V4 Flash is a mixture-of-experts model.",
                       1, []) is None)
check("offering to do it is allowed with no tool at all",
      narration.detect("Want me to disable the bad row?", 1, []) is None)

print("\nthe runner actually wires both halves")

# Source-level pins. A detector nothing calls is the failure shape this repo
# keeps finding — a good capability that nothing requires anyone to use — and
# both halves of this fix live in a 3,700-line file where an unrelated edit
# could drop them without a single suite going red.
_runner = open("/app/backend/app/agents/runner.py").read()

check("detect() is given SUCCEEDED tools, not everything attempted",
      "narration.detect(final_text, last_round_calls, succeeded_names"
      in _runner)
check("...and succeeded_names is derived from the tool results",
      'succeeded_names = [n for n in called_names if n in _succeeded]'
      in _runner)
check("...by the same 'Error:' convention the whole module uses",
      'startswith("Error:")' in _runner)
check("the refused note is appended to the reply",
      "refused_note = narration.refused_note(_refused)" in _runner)
check("...and reaches the operator's stream, not only the log",
      '"kind": "refused_calls"' in _runner)
check("...independently of whether a phrase matched",
      _runner.index("refused_note = narration.refused_note")
      > _runner.index("snippet = narration.detect"))

print()
if FAILURES:
    print(f"FAILED: {len(FAILURES)}")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all checks passed")
