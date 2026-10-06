"""No guard regex may backtrack catastrophically (S40b final fix wave, D2).

The S40b final review measured a padded markdown model table — an HONEST
reply, the very status answer S40b targets — taking 15.7 s in
served_claim_check at 20-character columns, x16 for every 2 more. The cause
was `(?:\\s+|…)*`: a whitespace run inside a starred alternation can be split
2^(n-1) ways, and every split is tried when the fullmatch fails. The guards run
synchronously inside core's async turn, on its only process, so one such reply
stalls every conversation, health check and eval turn with it.

These pins time the guards on adversarial padding. The first set is the
review's own reproductions through the public guard functions; the sweep runs
EVERY compiled pattern the module holds (module constants, pattern tuples and
the per-name builders) over padding inputs at TWO widths, 200 and 1,500
characters, so a regex added later is timed the day it lands rather than the
day it hangs core. Budget: 50 ms per call — the exponential forms took seconds
to hours at these sizes; a linear or low-order polynomial one takes
microseconds to a few ms. Why two widths is at `_sweep_inputs` below: a cubic
pattern shipped under the budget at 200 characters and took 3 s at 1,500.
"""

from __future__ import annotations

import re
import time
from types import SimpleNamespace

import pytest

from app import guards, tools

BUDGET_S = 0.05


def _span(kind: str, name: str | None, **meta):
    return SimpleNamespace(kind=kind, name=name, meta=dict(meta))


SERVED = [_span("llm_call", "hub:qwen3:8b", purpose="chat", served_by="hub:qwen3:8b", local=True)]
RECALLED = _span("memory_recall", None, k=5, hits=3)


def _best_of(fn, runs: int = 3) -> float:
    """The fastest of a few runs: a timing pin measures the algorithm, not a
    busy machine's scheduler."""
    best = float("inf")
    for _ in range(runs):
        start = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - start)
    return best


def _row(width: int) -> str:
    """The review's padded table row, every column `width` characters."""
    cells = ("qwen3:8b", "4.9 GB", "loaded, in use")
    return "| " + " | ".join(cell.ljust(width) for cell in cells) + " |"


# The review's reproductions (final-review.md #1), through the guard itself.
REVIEW_REPRODUCTIONS = [
    ("table_row_20_wide", _row(20)),
    ("table_row_60_wide", _row(60)),
    ("row_60_spaces", "| qwen3:8b" + " " * 60 + "| loaded, in use |"),
    ("label_path_22_spaces", "qwen3.8:27b ✅ in use: qwen3:8b" + " " * 22 + "idle"),
    ("label_path_60_spaces", "qwen3.8:27b ✅ in use: qwen3:8b" + " " * 60 + "idle"),
    ("ref_200_spaces_then_a_word", "qwen3:8b" + " " * 200 + "loaded, in use"),
]


@pytest.mark.parametrize(
    "label,reply", REVIEW_REPRODUCTIONS, ids=[c[0] for c in REVIEW_REPRODUCTIONS]
)
def test_a_padded_model_table_is_judged_in_milliseconds(label, reply):
    took = _best_of(lambda: guards.served_claim_check(reply, SERVED, purpose="chat"))
    assert took < BUDGET_S, f"{label}: {took * 1000:.1f} ms"
    # …and the honest row is still not corrected: it names the model that served.
    assert guards.served_claim_check(reply, SERVED, purpose="chat") is None, label


# The machine branch's key/value lines: `_KEY_VALUE_LINE` read a line of
# leading padding in O(n^4) (0.4 s at 200 spaces, hung at 1,000) through the
# overlapping `\s*` of its shared line lead.
PADDED_BLOCKS = [
    (
        # The walk up from the reading crosses the status line, then reads the
        # padded line as a key/value line.
        "padded_line_above_a_status_line",
        "The models run on hub.\n"
        + " " * 200
        + "x\n- Status: online\n- Last Reported: 2026-09-19T05:15:39+00:00",
    ),
    (
        "padded_status_line",
        "hub\n- Status:" + " " * 200 + "x offline\n- Last Reported: 2026-09-19T05:15:39+00:00",
    ),
    ("padded_reading_value", "hub\n- Last Reported:" + " " * 200 + "2026-09-19T05:15:39+00:00"),
    ("padded_memory_line", "the memory service is" + " " * 200 + "x"),
]


@pytest.mark.parametrize("label,reply", PADDED_BLOCKS, ids=[c[0] for c in PADDED_BLOCKS])
def test_padded_machine_and_memory_lines_are_judged_in_milliseconds(label, reply):
    spans = [*SERVED, RECALLED]
    for check in (
        lambda: guards.state_claim_check(reply, spans, [], purpose="chat"),
        lambda: guards.served_claim_check(reply, spans, purpose="chat"),
        lambda: guards.memory_claim_check(reply, spans, purpose="chat"),
    ):
        took = _best_of(check)
        assert took < BUDGET_S, f"{label}: {took * 1000:.1f} ms"


SETUP_PADDED = [
    ("code_words_then_padding", "your pairing code is" + " " * 1500 + "ABCD-2345"),
    ("many_urls", " ".join(f"https://nova{i}.fake-tailnet.ts.net/install" for i in range(200))),
    ("url_then_padding", "open http://192.168.0.245:3000" + " " * 1500 + "on your phone"),
    # A (review fix round 3): 200 GOVERNED urls in ONE clause, no sentence
    # breaks — each one makes address_claim_check compute a `before` slice
    # for _NOVA_GOVERNS_URL; unbounded (clause[:m.start()]), that slice grows
    # with each url and the whole clause is O(n^2). Bounded to its last 80
    # characters (ruling A), it stays linear.
    (
        "many_governed_lan_urls",
        " ".join(f"open nova at http://192.168.{i}.1:3000" for i in range(200)),
    ),
    # Final review (item 2): rule 1 asks, for a loopback setup page, whether
    # the clause names another device, as rule 3 does for a loopback root.
    # Read once per clause (about 10 ms here); asked per url, it is quadratic,
    # and 400 urls keep that well over the budget on a fast machine.
    (
        "many_loopback_setup_urls",
        " ".join(f"http://127.0.0.{i % 250 + 1}:3000/install" for i in range(400))
        + " on this computer",
    ),
]


@pytest.mark.parametrize("label,reply", SETUP_PADDED, ids=[c[0] for c in SETUP_PADDED])
def test_the_setup_guards_are_judged_in_milliseconds(label, reply):
    for check in (
        lambda: guards.code_claim_check(reply, ""),
        lambda: guards.address_claim_check(reply, "", "https://nova.fake-tailnet.ts.net"),
    ):
        took = _best_of(check)
        assert took < BUDGET_S, f"{label}: {took * 1000:.1f} ms"


def _collect_patterns(
    value: object,
    path: str,
    out: dict[str, re.Pattern[str]],
    depth: int = 0,
) -> None:
    """Record every re.Pattern reachable from `value` into `out`, keyed by an
    index-path id built from `path` (e.g. `_CAPABILITY_TOOLS[21][0]` for the
    Pattern half of that entry's `(Pattern, str)` pair, or
    `_DEFERRAL_TOOLS[1][0]` for an `_ActionClass.pattern` field reached
    through a tuple of them). Recurses into tuples, lists and dict values
    ONLY -- builtin containers, never a custom object's `__dict__` or an
    arbitrary class -- so nothing walked here can hold a back-reference and
    cycle; `depth` is a second, structural guarantee that the walk always
    terminates regardless.

    No de-duplication by object identity, ON PURPOSE. The same compiled
    Pattern is sometimes reachable more than one way -- `_CAP_SETUP_QR` is
    both its own module constant AND `_CAPABILITY_TOOLS[18][0]`;
    `_SERVED_SENTENCES[5]` has always been the SAME object as the module
    constant `_SERVED_ANSWERING`, since before this function existed. An
    earlier version of this walk deduped by identity so each object was
    timed once, under whichever path was found first -- and that SILENTLY
    DROPPED `_SERVED_SENTENCES[5]`'s id the moment `_SERVED_ANSWERING` (its
    alphabetically-earlier alias) claimed the object first, which is exactly
    the "an existing id moved" failure this amendment exists to prevent.
    Every path that reaches a Pattern gets its own key here; a pattern timed
    under two ids costs a little redundant test time and loses nothing."""
    if depth > 8:
        return
    if isinstance(value, re.Pattern):
        out[path] = value
    elif isinstance(value, (tuple, list)):
        for i, item in enumerate(value):
            _collect_patterns(item, f"{path}[{i}]", out, depth + 1)
    elif isinstance(value, dict):
        for key, item in value.items():
            _collect_patterns(item, f"{path}[{key!r}]", out, depth + 1)


def _every_pattern() -> dict[str, re.Pattern[str]]:
    """Every compiled pattern guards.py holds: every module attribute,
    walked recursively (`_collect_patterns` above) through tuples, lists and
    dict values, nested arbitrarily deep and bounded -- so a bare Pattern
    module attribute is found exactly as before (the recursion's base case
    on the FIRST call), a flat tuple of bare Patterns (`_SERVED_SENTENCES`)
    is found exactly as before, and now `_CAPABILITY_TOOLS`'s `(Pattern,
    str)` pairs and the `_ActionClass` NamedTuples (`_WEB_SEARCH`,
    `_FETCH_URL`, `_LIST_FILES`, `_READ_FILE`, `_RUN_COMMAND`,
    `_CHECK_DEVICE`, `_PULL_MODEL`, `_SET_REMINDER`, `_SHOW_SETUP_QR`, each
    holding a `pattern` field and an optional `restated` Pattern) are ALSO
    found, even though neither shape is "a tuple where every element is
    directly a Pattern."

    Before this walked containers recursively (pre S42a task 16 amendment),
    a pattern living inside anything more complex than a flat tuple of bare
    Patterns was invisible to this sweep, so most of `_CAPABILITY_TOOLS` and
    every `_ActionClass` field were never timed here -- "the sweep finds a
    new pattern by itself" was true only for a pattern bound to its own
    module name or sitting in a bare tuple of only Patterns.

    Plus what the per-name builders compile for a machine set and a paired
    device. Derived by walking the module, so a new regex is swept the day
    it is added, wherever in the module's data it is added."""
    found: dict[str, re.Pattern[str]] = {}
    for name in dir(guards):
        if name.startswith("__"):
            continue
        _collect_patterns(getattr(guards, name), name, found)
    for i, pattern in enumerate(guards._machine_patterns(("hub", "eval_box"))):
        found[f"_machine_patterns[{i}]"] = pattern
    for i, pattern in enumerate(guards._state_patterns(("DELL-XPS-8950",))):
        found[f"_state_patterns[{i}]"] = pattern
    device = guards._device_mention(("DELL-XPS-8950",))
    if device is not None:
        found["_device_mention"] = device
    found["_not_run_pattern"] = guards._not_run_pattern(tuple(sorted(guards._machine_read_tools())))
    # The said-not-done pair (2026-09-29): the written-call pattern over the
    # WHOLE live registry — the alternation production runs — and the device
    # anchor over a paired name and its words.
    found["_written_call_pattern"] = guards._written_call_pattern(tuple(tools.tool_names()))
    found["_device_anchor"] = guards._device_anchor(("DELL-XPS-8950",))
    # The MCP server pair (S37a Task 12, 2026-10-05): the builder over a
    # one-word and a two-word server, as chat._mcp_server_refs derives them.
    for i, pattern in enumerate(guards._server_patterns(("github", "home assistant"))):
        found[f"_server_patterns[{i}]"] = pattern
    return found


def _pre_s42a_amendment_pattern_sweep() -> dict[str, re.Pattern[str]]:
    """A frozen copy of `_every_pattern`'s FULL output exactly as it was
    before the S42a task 16 amendment: the module-attribute walk covered
    only a bare Pattern module attribute, or a tuple where EVERY element is
    directly a Pattern (only `_SERVED_SENTENCES` qualified) -- plus the same
    per-name-builder tail `_every_pattern` still calls today, unchanged by
    this amendment. Kept ONLY to pin the amendment against it -- every id it
    produces must still resolve to the SAME Pattern object under the SAME id
    in the new, recursive `_every_pattern`, and the new sweep must reach
    strictly more. Do not evolve this copy; it is a fossil, not a second
    implementation to maintain."""
    found: dict[str, re.Pattern[str]] = {}
    for name in dir(guards):
        value = getattr(guards, name)
        if isinstance(value, re.Pattern):
            found[name] = value
        elif isinstance(value, tuple) and value and all(isinstance(v, re.Pattern) for v in value):
            for i, pattern in enumerate(value):
                found[f"{name}[{i}]"] = pattern
    for i, pattern in enumerate(guards._machine_patterns(("hub", "eval_box"))):
        found[f"_machine_patterns[{i}]"] = pattern
    for i, pattern in enumerate(guards._state_patterns(("DELL-XPS-8950",))):
        found[f"_state_patterns[{i}]"] = pattern
    device = guards._device_mention(("DELL-XPS-8950",))
    if device is not None:
        found["_device_mention"] = device
    found["_not_run_pattern"] = guards._not_run_pattern(tuple(sorted(guards._machine_read_tools())))
    return found


def test_every_pre_amendment_id_still_resolves_to_the_same_pattern_object():
    """History stays comparable (the controller's ruling on this amendment):
    nothing the OLD sweep already covered moved to a new id, or now resolves
    to a different object, under the new recursive walk."""
    old = _pre_s42a_amendment_pattern_sweep()
    new = _every_pattern()
    missing = old.keys() - new.keys()
    assert not missing, f"ids the old sweep had that the new one lost: {sorted(missing)}"
    moved = [name for name, pattern in old.items() if new[name] is not pattern]
    assert not moved, f"ids that now resolve to a DIFFERENT Pattern object: {moved}"


def test_the_sweep_now_reaches_the_new_capability_pattern():
    """RED before the amendment, GREEN after -- task 16's own finding: the
    old walk never reached a Pattern nested inside `_CAPABILITY_TOOLS`
    unless it ALSO happened to be bound to its own module name, so "the
    timing sweep finds the new pattern by itself" was false the day task
    16's brief said it (`_CAPABILITY_TOOLS` is a tuple of `(Pattern, str)`
    pairs, never a tuple where every element is directly a Pattern). This is
    the reachability proof for the S42a `device_run` entry specifically --
    the fossil sweep above must NOT see it; the real one must. Selected by
    its tool's name, never by position (ruling F11, S37a Task 12): the last
    row moves the day a later slice appends one, as S37a's MCP rows did."""
    old = _pre_s42a_amendment_pattern_sweep()
    new = _every_pattern()
    [my_pattern] = [pattern for pattern, tool in guards._CAPABILITY_TOOLS if tool == "device_run"]
    assert not any(p is my_pattern for p in old.values()), (
        "the fossil (pre-amendment) sweep should not reach the new capability pattern"
    )
    assert any(p is my_pattern for p in new.values()), (
        "the new capability pattern must be reachable by the fixed sweep"
    )


def test_the_sweep_count_grew_by_exactly_the_newly_reachable_patterns():
    """Pinned like test_tools_registry/test_eval_corpus (CLAUDE.md's
    pinned-expectation-suite convention): 162 -> 221, +59 at the amendment;
    172 -> 233, +61 since the said-not-done pair, and 188 -> 249 since its fix
    round 1 (2026-09-29, below). This catches the
    sweep silently losing reach (the count drops below 221) as sharply as it
    catches a change that inflates it for the wrong reason (a NEW id that
    was not really newly reachable, or a regression back to deduping by
    object identity, which would UNDER-count here since several of the 59
    are additional ids for objects `old` already reached another way).

    The 59, by source (measured, not estimated):
      22  `_CAPABILITY_TOOLS[i][0]` -- all 22 `(Pattern, str)` pairs (19
          were reached NOWHERE before this amendment; the other 3 alias
          `_CAP_SETUP_QR`/`_CAP_PAIR_MACHINE`/`_CAP_ON_A_PHONE`, already
          reached under those bare names -- this id is additional, not a
          new object).
      15  the 9 `_ActionClass` instances' OWN bare-name fields
          (`_WEB_SEARCH`, `_FETCH_URL`, `_LIST_FILES`, `_READ_FILE`,
          `_RUN_COMMAND`, `_CHECK_DEVICE`, `_PULL_MODEL`, `_SET_REMINDER`,
          `_SHOW_SETUP_QR`): `pattern` always (9) plus `restated` on the 6
          that set it (6) = 15.
       5  the same fields again via `_DEFERRAL_TOOLS` (`_WEB_SEARCH`,
          `_FETCH_URL`, `_SET_REMINDER` -- 1 + 2 + 2).
      17  the same fields again via `_OFFER_CLASSES` (it unpacks
          `_DEFERRAL_TOOLS` AND lists `_SET_REMINDER` a second time, so all
          9 classes appear, one of them twice: 1+2+2+2+2+1+2+2+2+1).
      = 59. Update this deliberately, in the same commit as whatever changes
    guards.py's container shapes, and say in the commit body why it moved.

    The said-not-done pair (2026-09-29) moved all three, deliberately:
      10  new BARE module Patterns (`_EXAMPLE_INTRO`, `_ACTION_CLAIM`,
          `_FIRST_PERSON_ACTION`, `_HEAD_ACTION`, `_APP_OBJECT`,
          `_ANCHOR_BREAK`, `_SERVING_SUBJECT`, `_ACTION_NEGATION`,
          `_ACTION_HEDGE`, `_ACTION_INTENT`). Both walks reach a bare
          module Pattern, so the fossil grows too: 162 -> 172, 221 -> 231.
       2  per-name builders added to the live walk only (the fossil is not
          evolved): `_written_call_pattern`, `_device_anchor`. 231 -> 233, and
          the difference 59 -> 61.

    Its fix round 1 (2026-09-29) moved the two totals again, deliberately, and
    not the difference: 16 new BARE module Patterns, reached by both walks —
    `_RECAP_TIME`, `_LIST_ITEM`, the five `_WRITTEN_CALL_*` framings (LEAD,
    NEGATION, HEDGE, PROPOSAL, PAST), `_SUBJECT_ACTION`, `_PRONOUN_OBJECT`,
    `_STARTUP`, `_MD_LINK`, `_NOW_AFTER`, `_THEN_A_VERB`, `_RELAYED_THAT`,
    `_CONTRACTION`, and `_BY_ANOTHER` (the same object as `_BY_OTHER` under a
    second name, which this walk counts as its own id by design): 172 -> 188,
    233 -> 249, the difference still 61.

    Its fix round 2 (2026-09-29) moved them again, deliberately, and not the
    difference: 9 new BARE module Patterns, reached by both walks — the
    written-call framings `_WRITTEN_CALL_CONDITION`, `_WHETHER_VERB`,
    `_WRITTEN_CALL_APPROVAL` and `_GERUND_START`, and the device-completion
    cuts `_ACTION_CONDITION`, `_FRONTED_CONDITION`, `_CHANGE_MARK`,
    `_OTHER_CAUSE` and `_NO_ANSWER` — less 1, `_BY_ANOTHER`, which
    `_OTHER_CAUSE` replaced: 188 -> 196, 249 -> 257.

    Its fix round 3 (2026-09-29) moved them again, deliberately, and not the
    difference: 1 new BARE module Pattern, reached by both walks —
    `_GERUND_NOT_HERS`, the heading / generic-object / warning cut on the
    gerund fragment above a fence (the re-review's R1: "Running this formats
    your C: drive:" above a `format C: /q` fence read as her lead): 196 -> 197,
    257 -> 258.

    Its fix round 4 (2026-09-30) moved them again, deliberately, and not the
    difference: 3 new BARE module Patterns, reached by both walks —
    `_DEVICE_TIMED_OUT` (R3: the device's own answer that its command timed
    out, told apart from the hub's no-answer), `_INVITATION` and
    `_REASON_CLAUSE_END` (R2: a quoted failure reason never invites a retry):
    197 -> 200, 258 -> 261.

    The linear-filenames fix (2026-10-05, hub:1's carry from S42b Task 23)
    moved them again, deliberately, and not the difference: 1 new BARE module
    Pattern, reached by both walks — `_FILENAME_IN`, a filename found inside
    text, entered only at the front of its token (`_CONTENT_CLAIM` and
    `_PASSIVE_CLAIM` changed shape, not count): 200 -> 201, 261 -> 262.

    S37a Task 12 (2026-10-05) moved all three, deliberately: 201 -> 203,
    262 -> 270, the difference 61 -> 67.
       2  new BARE module Patterns, reached by both walks: the MCP server
          guards' `_SERVER_PRESENT_STATE` and `_SERVER_EARLIER`.
       4  the per-server builder in the live walk only (the fossil is not
          evolved): `_server_patterns[0..3]`.
       2  `_CAPABILITY_TOOLS[22][0]` and `[23][0]`, the mcp_connect and
          mcp_call rows, reached through the container in the live walk only.
    Ruling X1's own linear rewrite of capability_claim_check added three more
    bare patterns (`_IN_MY_TOOLSET`, `_STRETCH_END`, `_SCOPE_AT_TAIL_START`);
    merging main (2026-10-06) kept #97's rewrite of the same function
    instead, which adds none, so those three are gone.

    S42b (Task 23, the update guards) moved all three, deliberately — built
    beside the pair and the linear-filenames fix, and measured again on the
    merged file each time main came into slice/s42b (Task 32; last in Phase
    A2, on top of S37a's numbers above):
       4  new BARE module Patterns, reached by both walks — `_UPDATED_MACHINE`
          and `_UPDATE_RECAP` (narration's update claim), `_NAME_WORD` (a word
          of a machine's name) and `_CAP_UPDATE_AGENTS` (the capability row):
          203 -> 207, 270 -> 274.
       1  `_CAPABILITY_TOOLS` grew a row — the same `_CAP_UPDATE_AGENTS` under
          a second id, reached by the live walk only: 274 -> 275, and the
          difference 67 -> 68. The row sits at [21], before the S42a
          device_run row (now [22]), so on the merged file S37a's mcp_connect
          and mcp_call rows are [23] and [24]; this walk names ids by index,
          so the id that is new is `_CAPABILITY_TOOLS[24][0]`.

    Task 32 Phase B round 2 (the MF4 gap) moved the two totals again,
    deliberately, and not the difference: 1 new BARE module Pattern, reached
    by both walks — `_UPDATE_TOOK`, an update's RESULT said as done (her
    install of the build, the build it runs, the update done): 207 -> 208,
    275 -> 276. Its cuts (`_TookCuts`) reuse patterns already counted.

    Task 32 Phase B round 3 (CORE's concern 1) moved the two totals again,
    deliberately, and not the difference: 1 new BARE module Pattern, reached
    by both walks — `_SENT_BUILD`, the hub's build as a send's object, which
    makes "I sent the hub's build to minipc" device_completion's install kind
    rather than a notification: 208 -> 209, 276 -> 277. The recipient a send
    names first is read by the device anchor already counted."""
    old = _pre_s42a_amendment_pattern_sweep()
    new = _every_pattern()
    assert len(old) == 209, len(old)
    assert len(new) == 277, len(new)
    assert len(new) - len(old) == 68


def _sweep_inputs(n: int) -> dict[str, str]:
    """Padding inputs `n` characters wide, each built around a token a guard
    pattern anchors on, so the padding is what the engine has to walk past."""
    pad = " " * n
    half = " " * (n // 2)
    return {
        "spaces": pad + "x",
        "tabs": "\t " * (n // 2) + "x",
        "dash_then_spaces": "- " + pad + "x",
        "key_between_spaces": half + "Status" + half + "x",
        "key_colon_then_spaces": "- Status:" + pad + "x",
        "reading_key_then_spaces": "- Last Reported:" + pad + "x",
        "machine_then_spaces": "hub" + pad + "x",
        "machine_copula_then_spaces": "hub is" + pad + "x",
        "machine_which": "hub" + half + "," + half + "which",
        "ref_then_spaces": "qwen3:8b" + pad + "loaded, ",
        "ref_copula_then_spaces": "qwen3:8b is" + pad + "x",
        "label_then_spaces": "qwen3.8:27b ✅ in use: qwen3:8b" + pad + "idle",
        "size_then_spaces": "4.9" + pad + "x",
        "bracketed_size_padding": "(" + half + "4.9 GB" + half + "x",
        "badges": "qwen3:8b" + " ✅ —" * (n // 4) + " x",
        "sizes": "qwen3:8b" + " 4.9 GB" * (n // 7) + " x",
        "memory_then_spaces": "the memory service" + pad + "x",
        "memory_copula_then_spaces": "the memory service is" + pad + "x",
        "lead_word_then_spaces": "as" + pad + "x",
        "subordinator_then_spaces": "if" + pad + "x",
        "strike_then_spaces": "~~" + pad + "x",
        "digits": "1" * n + "x",
        "word": "a" * n + "!",
        "words": "a " * (n // 2) + "!",
        "negations": "hub is " + "not " * (n // 4) + "x",
        "said_that": "I said that " * (n // 12) + "x",
        # A listing entry whose name is set off from the padding: the shape
        # `presented_listing_check` reads on every reply (follow-up, below).
        "bullet_name_then_spaces": "- report.md" + pad + "x",
        # S47 review fix round 5: leg (2a) of _SETUP_QR_INSTRUCTS only starts
        # after "qr code for|of|to", so padding without those words never
        # times it. The padding sits after the HEAD, where the model number
        # and every boundary alternative walk the whitespace.
        "qr_object_then_spaces": "qr code for my phone" + pad + "x",
        # The said-not-done pair (2026-09-29): padding after a tool's name
        # (the spaces before a quote or a bracket), inside an opened call,
        # after a copula, after her own action verb, inside a device anchor,
        # and before an example's word.
        "tool_name_then_spaces": "device_run" + pad + "x",
        "tool_call_then_spaces": "device_run(" + pad + "x",
        "copula_then_spaces": "Notepad is" + pad + "x",
        "first_person_then_spaces": "I have" + pad + "x",
        "anchor_then_spaces": "on your" + pad + "x",
        "example_then_spaces": "for" + pad + "x",
        # fix round 1: a negation walking to its verb, a lead, a recap time, a
        # link, a relayed "that", and a subject walking to its verb.
        "negation_then_spaces": "not" + pad + "run",
        "lead_then_spaces": "I am" + pad + "running",
        "recap_then_spaces": "at" + pad + "15:56",
        "link_then_spaces": "[" + half + "](" + half + "x",
        "relayed_then_spaces": "reports" + pad + "that",
        "subject_then_spaces": "Notepad" + pad + "opened",
        # fix round 2: an intent walking to its verb of doing, a condition, a
        # "whether" verb before an "if", waiting for the go-ahead, a numbered
        # gerund, "the moment", and a refusal walking to its "answer".
        "intent_then_spaces": "I'll" + pad + "run",
        "let_me_then_spaces": "let me" + pad + "check",
        "condition_then_spaces": "as" + pad + "soon",
        "whether_then_spaces": "check" + pad,
        "approval_then_spaces": "say" + pad + "the",
        "numbered_gerund": "1." + pad + "Launching",
        "moment_then_spaces": "the" + pad + "moment",
        "refusal_then_spaces": "did" + pad + "not",
        # fix round 3: a gerund walking to its object, and a demonstrative
        # walking to the verb that makes the gerund its subject.
        "gerund_then_spaces": "Running" + pad + "this",
        "demonstrative_then_spaces": "Running this" + pad + "formats",
        # S37a Task 12: the MCP server legs — a server's name walking to its
        # verb, a possessive, an attribution, her read verb and an access verb
        # walking to the name — and the capability guard's impersonal lead,
        # toolset words and two-word scope word, each walking its padding.
        "server_then_spaces": "github" + pad + "shows",
        "possessive_server_then_spaces": "github's" + pad + "run",
        "according_then_spaces": "according to" + pad + "github",
        "read_verb_then_spaces": "I checked" + pad + "github",
        "access_then_spaces": "access" + pad + "home assistant",
        "there_is_then_spaces": "there is" + pad + "no",
        "in_my_then_spaces": "in my" + pad + "toolbox",
        "any_then_spaces": "any" + pad + "place",
    }


# TWO LENGTHS, ONE BUDGET, and the second is why this pair exists (S40b
# fix-wave follow-up): `_TRAILING_SIZE` read a padded listing entry in O(n³)
# and was UNDER the budget at 200 characters (7 ms) while taking 3.0 s at
# 1,500 — 8.8 s through `presented_listing_check`, synchronously, on core's
# only process, on every reply. A single short length cannot tell a linear
# pattern from a cubic one; at 7.5x the width a linear pattern is still
# microseconds, a quadratic one a few ms, and anything worse is over budget.
# Keep both: the short length is the one the review's own reproductions use
# and it keeps the sweep fast, the long one is the shape tripwire.
SWEEP_INPUTS = _sweep_inputs(200)
LONG_SWEEP_INPUTS = _sweep_inputs(1500)


@pytest.mark.parametrize("pattern_name", sorted(_every_pattern()))
def test_every_guard_pattern_walks_200_characters_of_padding_in_milliseconds(pattern_name):
    pattern = _every_pattern()[pattern_name]
    for label, text in SWEEP_INPUTS.items():
        for method in (pattern.search, pattern.match, pattern.fullmatch):
            took = _best_of(lambda method=method, text=text: method(text), runs=2)
            assert took < BUDGET_S, (
                f"{pattern_name}.{method.__name__}({label}): {took * 1000:.1f} ms"
            )


@pytest.mark.parametrize("pattern_name", sorted(_every_pattern()))
def test_every_guard_pattern_walks_1500_characters_of_padding_in_milliseconds(pattern_name):
    pattern = _every_pattern()[pattern_name]
    for label, text in LONG_SWEEP_INPUTS.items():
        for method in (pattern.search, pattern.match, pattern.fullmatch):
            took = _best_of(lambda method=method, text=text: method(text), runs=2)
            assert took < BUDGET_S, (
                f"{pattern_name}.{method.__name__}({label}): {took * 1000:.1f} ms"
            )


# The whole guard, on the listing shape the cubic pattern was reached through:
# a bullet list of three entries, each padded, is an ordinary reply to read.
@pytest.mark.parametrize("width", [200, 1500], ids=["200", "1500"])
def test_a_padded_listing_is_judged_in_milliseconds(width):
    reply = "\n".join(
        f"- {name}" + " " * width + "x" for name in ("report.md", "notes.md", "config.json")
    )
    took = _best_of(lambda: guards.presented_listing_check(reply, [], []))
    assert took < BUDGET_S, f"padded_listing_{width}: {took * 1000:.1f} ms"


def test_the_sweep_times_the_qr_object_leg():
    """S47 review fix round 5: leg (2a) of _SETUP_QR_INSTRUCTS is a lookahead
    that only starts after "qr code for|of|to" — padding without those words
    never enters it, so the sweep carries a padded input that does, at both
    widths."""
    for inputs in (SWEEP_INPUTS, LONG_SWEEP_INPUTS):
        assert any(re.search(r"qr code for\b.*\s{100,}", text) for text in inputs.values())


def test_the_sweep_reaches_the_in_use_and_line_patterns():
    """The patterns the review found hanging are among those swept — the
    sweep is derived, and this says it still reaches them."""
    swept = _every_pattern()
    for name in (
        "_IN_USE_BEFORE_GAP",
        "_IN_USE_LABEL_ENDS",
        "_KEY_VALUE_LINE",
        "_OWN_STATE_LINE",
        "_MEMORY_DOWN",
        "_machine_patterns[1]",
    ):
        assert name in swept, name


# S42b (Task 23): the update guards' patterns, on the shapes that ENTER them —
# "I updated" and a possessive agent before padding, "update the agents" before
# padding — and on the one shape the restart class needs: a long run of name
# characters ("a.a.a…"), which an unanchored `\b[\w.-]+'s` re-enters at every
# word boundary inside it. The brief's first form of the possessive branch was
# exactly that: 0.28 ms at 200 characters, 14.7 ms at 1,500 and 238 ms at
# 6,000 (measured), so 1,500 alone could not tell it from a linear one and the
# third width is here. The run is NOT among the global sweep's inputs: Task 23
# found _CONTENT_CLAIM and _PASSIVE_CLAIM quadratic on it too (about 90 ms at
# 1,500), and main's linear-filenames fix (#96) made them linear, with its own
# runs (FILENAME_RUNS, below). Since that fix, the guards below read the run as
# well.
UPDATE_PATTERNS = (
    "_UPDATED_MACHINE",
    "_UPDATE_RECAP",
    "_NAME_WORD",
    "_CAP_UPDATE_AGENTS",
    "_UPDATE_TOOK",
    "_SENT_BUILD",
)


def _update_shapes(n: int) -> dict[str, str]:
    pad = " " * n
    return {
        "update_claim_then_spaces": "I updated" + pad + "x",
        "update_name_then_spaces": "I updated eval_laptop" + pad + "x",
        "update_onto_then_spaces": "I upgraded eval_laptop to the" + pad + "x",
        "possessive_agent_then_spaces": "eval_laptop's agent is" + pad + "x",
        "dotted_name_run": "a." * (n // 2) + "!",
        "dashed_name_run": "a-" * (n // 2) + "!",
        "name_run_then_possessive": "a." * (n // 2) + "'s agent is" + pad + "x",
        "many_update_claims": "I updated a's agent. " * (n // 21) + "x",
        "update_agents_then_spaces": "update the agents" + pad + "x",
        "update_agents_on_then_spaces": "update the agents on your" + pad + "machines x",
        "many_update_verbs": "update " * (n // 7) + "agents x",
        # Task 32 (the MF4 gap): the shapes that enter _UPDATE_TOOK — her
        # install, the build installed, the update done, the build it runs —
        # each before padding, a name run before each name slot's tail, a long
        # word after "done" (its "-ing" lookahead), and many claims in a row.
        "installed_then_spaces": "I installed the new build on" + pad + "x",
        "installed_object_then_spaces": "I installed the hub's" + pad + "build",
        "build_installed_then_spaces": "the new build has been" + pad + "installed",
        "update_done_then_spaces": "the update is" + pad + "complete",
        "update_on_then_spaces": "the update on" + pad + "x",
        "update_done_then_word": "the update is done " + "a" * n + "ing",
        "agent_on_then_spaces": "the agent on" + pad + "x",
        "name_on_build_then_spaces": "eval_laptop is now on the" + pad + "x",
        "name_run_then_copula": "a." * (n // 2) + " is now on the hub's" + pad + "x",
        "name_run_then_update": "a." * (n // 2) + "'s update is" + pad + "x",
        "many_result_claims": "eval_laptop is on the hub's build. " * (n // 35) + "x",
        # Task 32 Phase B round 3: the shapes that enter _SENT_BUILD — each of
        # its openings before padding, its trailing lookahead ("of", "for", a
        # notice's noun…) after a run, and sends in a row, of the object and to
        # a recipient written first.
        "sent_build_then_spaces": "I sent the hub's" + pad + "build",
        "sent_new_build_then_spaces": "I sent a new" + pad + "build",
        "sent_agent_build_then_spaces": "I sent an agent" + pad + "build",
        "sent_update_then_spaces": "I sent the update" + pad + "of",
        "many_sends": "I sent the hub's build to eval_laptop. " * (n // 39) + "x",
        "many_recipient_sends": "I sent eval_laptop the update. " * (n // 31) + "x",
    }


@pytest.mark.parametrize("width", [200, 1500, 6000])
@pytest.mark.parametrize("pattern_name", UPDATE_PATTERNS)
def test_the_update_patterns_walk_the_shapes_that_enter_them_in_milliseconds(pattern_name, width):
    pattern = getattr(guards, pattern_name)
    for label, text in _update_shapes(width).items():
        for method in (pattern.search, pattern.match, pattern.fullmatch):
            took = _best_of(lambda method=method, text=text: method(text), runs=2)
            assert took < BUDGET_S, (
                f"{pattern_name}.{method.__name__}({label}, {width}): {took * 1000:.1f} ms"
            )


@pytest.mark.parametrize("width", [200, 1500, 6000])
def test_the_update_guards_judge_the_shapes_that_enter_them_in_milliseconds(width):
    """Through the guards themselves: narration (the update claim) and the
    capability guard (the update row), on every shape — the dotted and dashed
    name runs too, now that narration enters a filename once per token (#96;
    before it, narration took 171 ms on 1,500 characters of "a.")."""
    from app import tools

    available = tools.tool_names()
    for label, text in _update_shapes(width).items():
        for check in (
            lambda text=text: guards.narration_check(text, []),
            lambda text=text: guards.capability_claim_check("I can't " + text, available),
        ):
            took = _best_of(check)
            assert took < BUDGET_S, f"{label} ({width}): {took * 1000:.1f} ms"


# Task 23 fix round 2 (N3): an update claim's machine is read against the LIVE
# paired names, and the timing test above passes none. Walking every name for
# every claim took 64-94 ms at 6,000 characters beside 500 names (the
# re-review's measurement); the names are now indexed once per reply. These
# shapes enter that path: a name slot holding a word that names nothing (the
# word lookup), a word of every paired name, a machine named on every claim,
# and file claims between update claims — beside no spans, and beside
# machine_status's read of every paired agent's confirmed row (each named
# claim then looks its machine up among the rows, which are read once too).
PAIRED_COUNTS = (5, 50, 500)


def _paired_names(count: int) -> tuple[str, ...]:
    return tuple(f"eval-machine-{i}" for i in range(count))


def _status_of_agents(count: int):
    facts = []
    for name in _paired_names(count):
        facts.append({"device": name, "connected": True})
        facts.append(
            {"machine_update": name, "outcome": "confirmed", "version": "a" * 12, "confirmed": True}
        )
    return _span("tool", "machine_status", ok=True, facts=facts)


def _paired_shapes(n: int) -> dict[str, str]:
    return {
        "word_slot": "I updated workstation's agent. " * (n // 31) + "x",
        "distinct_word_slots": "".join(f"I updated wkst{i}'s agent. " for i in range(n // 25))
        + "x",
        "on_slot": "I updated the agent on workstation. " * (n // 36) + "x",
        "word_of_every_name": "I updated the agent on eval. " * (n // 29) + "x",
        "each_names_a_machine": "".join(
            f"I updated eval-machine-{i}'s agent. " for i in range(n // 36)
        )
        + "x",
        "files_and_updates": "".join(
            f"I wrote f{i}.md and I updated wkst{i}'s agent. " for i in range(n // 45)
        )
        + "x",
    }


@pytest.mark.parametrize("width", [200, 1500, 6000])
@pytest.mark.parametrize("count", PAIRED_COUNTS)
def test_an_update_claim_reads_the_paired_names_in_milliseconds(count, width):
    names = _paired_names(count)
    for spans_label, spans in (("no spans", []), ("every row", [_status_of_agents(count)])):
        for label, text in _paired_shapes(width).items():
            took = _best_of(
                lambda text=text, spans=spans: guards.narration_check(text, spans, names)
            )
            assert took < BUDGET_S, (
                f"{label} ({width}, {count} names, {spans_label}): {took * 1000:.1f} ms"
            )


# Task 23 fix round 2 (N2): narration reports each unbacked claim once, and its
# dedupe walked every claim reported before — quadratic in the DISTINCT
# unbacked claims of any kind (74.7 ms against 28.1 ms for 1,500 file claims at
# 24,000 characters, the re-review's measurement). A reply of distinct claims
# is timed against its twin of the same length that repeats ONE claim: the twin
# never reaches the dedupe, so the ratio is the dedupe's own cost, and a slower
# runner slows both alike. Measured on the N150: 1.06 with a set, 3.3 with the
# walk; at 2,400 claims 1.09 against 5.5.
def _passive_file_claims(count: int, *, distinct: bool) -> str:
    return ", ".join(f"f{i if distinct else 0:04d}.md was written" for i in range(count)) + "."


def test_many_distinct_unbacked_claims_cost_what_one_repeated_claim_does():
    distinct = _passive_file_claims(1200, distinct=True)
    repeated = _passive_file_claims(1200, distinct=False)
    assert len(distinct) == len(repeated)
    correction = guards.narration_check(distinct, [])
    assert correction is not None and len(correction.claims) == 1200
    took = base = float("inf")
    for _ in range(5):
        start = time.perf_counter()
        guards.narration_check(distinct, [])
        took = min(took, time.perf_counter() - start)
        start = time.perf_counter()
        guards.narration_check(repeated, [])
        base = min(base, time.perf_counter() - start)
    assert took < 2 * base, f"{took * 1000:.1f} ms against {base * 1000:.1f} ms"


def test_the_global_sweep_reaches_the_update_patterns():
    """They are module constants, so the derived sweep times them on every
    padding input too — and the capability row under its table id as well."""
    swept = _every_pattern()
    for name in UPDATE_PATTERNS:
        assert name in swept, name
    assert any(p is guards._CAP_UPDATE_AGENTS for p in swept.values())
    assert sum(p is guards._CAP_UPDATE_AGENTS for p in swept.values()) == 2


def test_the_sweep_walks_the_said_not_done_legs():
    """The pair's patterns only get past their first token on inputs that
    reach it — a tool's name, an open call, a copula, her own verb, an anchor
    — so the sweep carries padding after each, at both widths."""
    swept = _every_pattern()
    for name in (
        "_written_call_pattern",
        "_device_anchor",
        "_ACTION_CLAIM",
        "_APP_OBJECT",
        "_WRITTEN_CALL_LEAD",
        "_WRITTEN_CALL_CONDITION",
        "_ACTION_CONDITION",
        "_NO_ANSWER",
        "_GERUND_NOT_HERS",
    ):
        assert name in swept, name
    for inputs in (SWEEP_INPUTS, LONG_SWEEP_INPUTS):
        for lead in (
            "device_run",
            "device_run(",
            "Notepad is",
            "I have",
            "on your",
            "I'll",
            "let me",
            "as",
            "1.",
            "did",
            "Running",
            "Running this",
        ):
            assert any(re.match(re.escape(lead) + r"\s{100,}", text) for text in inputs.values())


# The WHOLE guards, not one pattern each: a reply is read line by line and
# clause by clause, and every cut is found once per line or clause — guards run
# in core's only event loop (one took 15.4 s on an honest reply).
#
# Each pin times one input at TWO sizes, a 4x step apart, and holds BOTH
# (said-not-done final review, I-2):
#
#   * GROWTH: t(4n) / t(n) < GROWTH_LIMIT. Reading in linear time measures
#     about x4 (every pin here measured x2.8 to x4.7, the top one under load
#     from another process); a quadratic heads for x16. This is what catches an
#     algorithm going wrong, on any runner: one 50 KB budget missed
#     device_completion recounting a clause's quotation marks from its start
#     for every claim in it, and a budget widened so a slower runner stopped
#     flaking would have hidden that for good.
#   * CAP: the larger input stays under an absolute cap with real headroom,
#     BIG_INPUT_CAP_S per 50 KB, so a slower runner (CI runs this suite on
#     every push) passes while a blow-up of the constant does not. Where these
#     were set, the slowest 50 KB read took 85 ms (89 ms under load) and the
#     slowest 200 KB one 344 ms (420 ms under load): the cap is 3.5x the
#     unloaded figures. It was 100 ms per 50 KB, which left that read 15 ms.
#
# Each sample is looped until it lasts _SAMPLE_S, so a call of a few
# microseconds is timed as reliably as one of 50 ms, and both sizes are looped
# alike.
_NAMES = tools.tool_names()
GROWTH_LIMIT = 6.0
BIG_INPUT_CAP_S = 0.3
_SAMPLE_S = 0.002


def _per_call(fn, loops: int, runs: int) -> float:
    """Best-of-`runs` seconds per call of `fn`, each sample `loops` calls."""
    best = float("inf")
    for _ in range(runs):
        start = time.perf_counter()
        for _ in range(loops):
            fn()
        best = min(best, (time.perf_counter() - start) / loops)
    return best


def _assert_linear(
    label: str,
    check,
    build,
    *,
    small: int = 12_500,
    large: int = 50_000,
    cap_s: float | None = None,
    runs: int = 3,
) -> None:
    """`check(build(n))` grows linearly from `small` to `large` (a 4x step)
    and stays under its cap at `large` — BIG_INPUT_CAP_S per 50 KB unless a
    cap is given. One warming call first: a per-name pattern is built once."""
    assert large == 4 * small, "GROWTH_LIMIT is for a 4x step"
    short, long = build(small), build(large)
    check(short)
    start = time.perf_counter()
    check(short)
    loops = max(1, int(_SAMPLE_S / max(time.perf_counter() - start, 1e-7)) + 1)
    t_small = _per_call(lambda: check(short), loops, runs)
    t_large = _per_call(lambda: check(long), loops, runs)
    cap = cap_s if cap_s is not None else BIG_INPUT_CAP_S * large / 50_000
    assert t_large < cap, (
        f"{label}: {large:,} chars took {t_large * 1000:.1f} ms (cap {cap * 1000:.0f})"
    )
    growth = t_large / t_small
    assert growth < GROWTH_LIMIT, (
        f"{label}: x4 the input took x{growth:.1f} the time "
        f"({t_small * 1000:.2f} -> {t_large * 1000:.2f} ms); linear is about x4"
    )


def _repeat(unit: str):
    """`unit` repeated to exactly n characters."""
    return lambda n: (unit * (n // len(unit) + 1))[:n]


def _distinct(unit: str):
    """`unit` with a different number in each copy, to n characters, so no
    sentence repeats one read before."""

    def build(n: int) -> str:
        out: list[str] = []
        size = index = 0
        while size < n:
            piece = unit.format(i=index)
            out.append(piece)
            size += len(piece)
            index += 1
        return "".join(out)[:n]

    return build


# Each shape at n characters; at 50 KB, the shape each pinned before.
FIFTY_KB = [
    ("written_names_and_spaces", _repeat("device_run " + " " * 40)),
    ("written_names_then_quotes", _repeat('device_info "x" ')),
    ("written_names_glued", _repeat("device_rundevice_info")),
    ("written_open_parens", _repeat("device_run(" + " " * 30)),
    ("written_fences", _repeat('```\ndevice_launch_app "DELL" "Teams"\n```\n')),
    ("written_one_padded_line", lambda n: "device_info" + " " * n + '"x"'),
    ("written_quotes", _repeat('"device_run" ')),
    ("written_examples", _repeat('for example device_run(["ls"]) ')),
    ("claims", _repeat("Notepad is now open on your DELL-XPS-8950 ")),
    ("copulas", _repeat("it is now now now ")),
    ("first_person", _repeat("I opened ")),
    ("padded_copula", lambda n: "Notepad is" + " " * n + "open on your Dell"),
    ("padded_anchor", lambda n: "Notepad is now open" + " " * n + "on your Dell"),
    ("no_sentence_breaks", _repeat("I have just opened and started and ran ")),
    ("anchors", _repeat("on your Dell to the PC ")),
    ("capitalised_run", lambda n: "I opened " + "A" * n),
    ("prose", _repeat("The quick brown fox jumps over the lazy dog. ")),
    ("stars", _repeat("**DELL-XPS-8950** ")),
    # fix round 1's paths: a line of inline calls, one sentence of them, fenced
    # calls under leads, a recap list, subject verbs, links, a dot run.
    ("inline_calls_one_line", _repeat('Let me run `device_info "x"` now. ')),
    ("inline_calls_one_sentence", _repeat('I\'ll run `device_info "x"` and ')),
    ("fence_intros", _repeat('I\'ll check:\n```\ndevice_info "x"\n```\n')),
    (
        "recap_list",
        lambda n: "Here's what I did today:\n" + _repeat("- I opened Notepad on your Dell\n")(n),
    ),
    ("subject_verbs", _repeat("Notepad opened on your Dell and ")),
    ("links", _repeat("[DELL-XPS-8950](https://x.invalid/d) ")),
    ("negated_calls", _repeat('I did not run `device_run ["x"]` and ')),
    ("dots", lambda n: "." * n),
    # fix round 2's paths. The reviewer's shape first (minor: 41 KB took 13.8 s):
    # one long intro line, then fence after fence, each re-reading it.
    (
        "one_long_intro_many_fences",
        lambda n: "I'll check " + "a" * (n * 2 // 5) + ":\n" + "```\n```\n" * (n * 3 // 20),
    ),
    (
        "one_long_intro_fenced_calls",
        lambda n: (
            "I'll check "
            + "b " * (n // 5)
            + ":\n"
            + _repeat('```\ndevice_info "x"\n```\n')(n * 3 // 5)
        ),
    ),
    ("intros_and_fences", _repeat('I\'ll check it now:\n```\ndevice_info "x"\n```\n')),
    ("gerund_intros", _repeat('Launching it via the shell.\n```\ndevice_run ["x"]\n```\n')),
    (
        "distinct_ruled_out_intros",
        _distinct('I\'ll run this once you confirm {i}:\n```\ndevice_run ["x"]\n```\n'),
    ),
    (
        "distinct_intros_and_follows",
        _distinct('Launching item {i} via the shell.\n```\ndevice_run ["x"]\n```\nShall I {i}?\n'),
    ),
    ("one_long_follow", lambda n: '```\ndevice_info "x"\n```\n' + "Shall " + "d " * (n // 2) + "?"),
    ("ifs", lambda n: 'I\'ll run `device_info "x"` ' + "if " * (n // 3)),
    ("whether_ifs", lambda n: 'I\'ll run `device_info "x"` ' + "check if " * (n // 9)),
    ("lead_adverbs", lambda n: "I'll " + "now just first " * (n // 15) + 'run `device_info "x"`'),
    ("conditioned_claims", _repeat("Notepad is now open on your DELL-XPS-8950 when ")),
    (
        "fronted_conditions",
        lambda n: "When " * (n // 5) + "Notepad is now open on your DELL-XPS-8950",
    ),
    ("platform_words", _repeat("Notepad is now open on your Windows PC and on your Mac ")),
    # fix round 3's paths: gerund labels and warnings above fences, a heading
    # above each, modal futures, and conditional list intros.
    ("gerund_labels", _repeat('Launching an app:\n```\ndevice_run ["x"]\n```\n')),
    ("gerund_warnings", _repeat('Running this formats it:\n```\ndevice_run ["x"]\n```\n')),
    ("heading_fences", _repeat('### Running a command\n```\ndevice_run ["x"]\n```\n')),
    ("modal_futures", _repeat("Notepad will have opened on your DELL-XPS-8950. ")),
    ("conditional_lists", _repeat("If it works:\n- Notepad is now open on your DELL-XPS-8950\n")),
]


@pytest.mark.parametrize("label,build", FIFTY_KB, ids=[c[0] for c in FIFTY_KB])
def test_the_said_not_done_guards_read_50_kb_in_linear_time(label, build):
    _assert_linear(
        f"written_call {label}", lambda r: guards.written_call_check(r, [], _NAMES), build
    )
    _assert_linear(
        f"device_completion {label}",
        lambda r: guards.device_completion_check(r, [], _NAMES, ["DELL-XPS-8950"]),
        build,
    )


def test_a_huge_command_record_is_read_in_linear_time():
    """(fix rounds 2 and 3, C1) device_completion reads a FAILED device_run's
    argv to choose which failure to state. A record is bounded where it is
    written (chat's span caps), but the reading must not depend on that: an
    argv of 50 KB, as a list of words, as one long command and as one word, is
    read in linear time and under the cap."""
    from types import SimpleNamespace

    def failed_run(argv: list[str]) -> list:
        return [
            SimpleNamespace(
                kind="tool",
                name="device_run",
                meta={
                    "ok": False,
                    "error": "Error: exit 1",
                    "args_redacted": {"argv": argv, "device": "DELL-XPS-8950"},
                },
            )
        ]

    for label, argv in (
        ("a list of words", lambda n: ["x"] * (n // 2)),
        ("one long command", lambda n: ["cmd", "/c", "start " + "x " * (n // 2)]),
        ("one word", lambda n: ["a" * n]),
    ):
        _assert_linear(
            label,
            lambda spans: guards.device_completion_check(
                "Notepad is now open on your DELL-XPS-8950.", spans, _NAMES, ["DELL-XPS-8950"]
            ),
            lambda n, argv=argv: failed_run(argv(n)),
        )


def _recorded(name: str, args: dict, *, ok: bool = True) -> object:
    """A tool span exactly as chat records one: its arguments through the
    same per-value and whole-record caps (`chat._span_arguments`)."""
    import json
    from types import SimpleNamespace

    from app import chat

    meta: dict = {"ok": ok, "args_redacted": chat._span_arguments(json.dumps(args))}
    if not ok:
        meta["error"] = "Error: DELL-XPS-8950: exit 1"
    return SimpleNamespace(kind="tool", name=name, meta=meta)


_LONG_COMMAND = ["powershell", "-NoProfile", "-Command"] + [
    "Get-ChildItem C:\\Users\\owner\\Documents -Recurse | Where-Object {$_.Length -gt 1MB}"
] * 7
# 30 spans: the production cap on what one turn records (6 rounds of calls), as
# the re-review measured it (scratchpad rr3/probe_timing2.py).
_THIRTY_OK = [
    *(
        _recorded("device_run", {"device": "DELL-XPS-8950", "argv": _LONG_COMMAND})
        for _ in range(29)
    ),
    _recorded("device_launch_app", {"device": "DELL-XPS-8950", "app": "notepad"}),
]
_THIRTY_FAILED = [
    _recorded("device_run", {"device": "DELL-XPS-8950", "argv": _LONG_COMMAND}, ok=False)
    for _ in range(30)
]
# (fix round 4, R4) One successful call of another family beside the claims —
# the re-review's shape (scratchpad rr4/probe_timing4.py: 98-129 ms) — alone,
# among thirty recorded spans, and as thirty of its own.
_ONE_SEARCH = [_recorded("web_search", {"query": "pixel"})]
_ONE_SEARCH_IN_THIRTY = [
    *_ONE_SEARCH,
    *(_recorded("device_info", {"device": "DELL-XPS-8950"}) for _ in range(29)),
]
_THIRTY_SEARCHES = [_recorded("web_search", {"query": "x" * 200}) for _ in range(30)]
# (Task 32 Phase B round 3) An update of the Dell among thirty recorded spans,
# and the only call that performs an install: every send of the hub's build on
# the Dell is read as far as its object, then silenced by it.
_AN_UPDATE_IN_THIRTY = [
    *(_recorded("device_info", {"device": "DELL-XPS-8950"}) for _ in range(29)),
    _recorded("machine_update", {"machine": "DELL-XPS-8950"}),
]


@pytest.mark.parametrize(
    "label,build,spans",
    [
        (
            "the same backed claim, over and over",
            _repeat("Notepad is now open on your DELL-XPS-8950. "),
            _THIRTY_OK,
        ),
        (
            "distinct backed claims",
            _distinct("App{i} is now open on your DELL-XPS-8950. "),
            _THIRTY_OK,
        ),
        (
            "distinct backed close claims",
            _distinct("I closed App{i} on your DELL-XPS-8950. "),
            _THIRTY_OK,
        ),
        (
            "distinct claims on a machine word",
            _distinct("App{i} is now open on your PC. "),
            _THIRTY_OK,
        ),
        (
            "claims over thirty failed commands",
            _distinct("App{i} is now open on your DELL-XPS-8950. "),
            _THIRTY_FAILED,
        ),
        (
            "distinct negated claims",
            _distinct("App{i} is not open on your DELL-XPS-8950. "),
            _THIRTY_OK,
        ),
        # fix round 4, R4: claims naming no device, beside another tool's work
        (
            "distinct unanchored launches beside one search",
            _distinct("I launched App{i}. "),
            _ONE_SEARCH,
        ),
        (
            "distinct unanchored launches beside one search in thirty spans",
            _distinct("I launched App{i}. "),
            _ONE_SEARCH_IN_THIRTY,
        ),
        (
            "distinct unanchored launches beside thirty searches",
            _distinct("I launched App{i}. "),
            _THIRTY_SEARCHES,
        ),
        (
            "distinct unanchored opens for you beside thirty searches",
            _distinct("I opened App{i} for you. "),
            _THIRTY_SEARCHES,
        ),
        (
            "distinct unanchored pronouns beside thirty searches",
            _distinct("I launched it. Item {i}. "),
            _THIRTY_SEARCHES,
        ),
        # Task 32 Phase B round 3: a send's object read for its kind — after
        # the verb, after a recipient written first, as the subject of "was
        # sent", naming no machine beside another tool's work, and a
        # notification ABOUT the update, whose recipient scan finds none.
        (
            "distinct backed sends of the hub's build",
            _distinct("I sent the hub's build {i} to your DELL-XPS-8950. "),
            _AN_UPDATE_IN_THIRTY,
        ),
        (
            "distinct backed sends to a recipient",
            _distinct("I sent DELL-XPS-8950 the update, part {i}. "),
            _AN_UPDATE_IN_THIRTY,
        ),
        (
            "distinct backed subjects sent",
            _distinct("Item {i}: the hub's build was sent to your DELL-XPS-8950. "),
            _AN_UPDATE_IN_THIRTY,
        ),
        (
            "distinct sends naming no machine beside one search",
            _distinct("I sent the update {i}. "),
            _ONE_SEARCH,
        ),
        (
            "distinct notifications about the update",
            _distinct("I sent a note about the update {i} to your DELL-XPS-8950. "),
            _THIRTY_OK,
        ),
    ],
)
def test_the_pair_reads_50_kb_against_thirty_recorded_spans_in_linear_time(label, build, spans):
    """(fix round 3, T5) The re-review's probe: 1,100 claims BACKED by a call —
    every one read to the end — against 30 spans recorded as chat records them
    took 96-105 ms. A claim a successful call silences is now dropped as soon
    as its action and device are known, the record is read once per check,
    each command's argv split once, and a sentence already read is not read
    again."""
    _assert_linear(
        f"written_call {label}", lambda r: guards.written_call_check(r, spans, _NAMES), build
    )
    _assert_linear(
        f"device_completion {label}",
        lambda r: guards.device_completion_check(r, spans, _NAMES, ["DELL-XPS-8950"]),
        build,
    )


# The MCP server pair (S37a Task 12, ruling F7; spec §6 asks for 50 KB): both
# are read at the end of the turn beside the said-not-done pair, so both are
# held to its pins — over two connected servers and thirty spans recorded as
# chat records them, none of which backs either server, so every clause of
# every shape is read to the end. The MCP shapes name a server the list does
# not hold (GitLab) wherever a hit would end the read early.
_TWO_SERVERS = [
    guards.McpServerRef(name="github", words=("github",)),
    guards.McpServerRef(name="home-assistant", words=("home assistant", "home-assistant")),
]


def _mcp_recorded(server: str) -> object:
    """An answered mcp_call as chat records one, with the fact the tool files."""
    span = _recorded(
        "mcp_call", {"server": server, "tool": "list_issues", "arguments": {"q": "x" * 200}}
    )
    span.meta["reached_executor"] = True
    span.meta["facts"] = [
        {
            "mcp_server": server,
            "tool": "list_issues",
            "origin": f"http://{server}.mcp.invalid",
            "protocol": "2025-11-25",
            "reachable": True,
            "is_error": False,
            "bytes": 120,
        }
    ]
    return span


_THIRTY_MCP = [
    *(_mcp_recorded("jira") for _ in range(15)),
    *(
        _recorded("fetch_url", {"url": f"https://example.invalid/page/{i}?q=" + "x" * 200})
        for i in range(15)
    ),
]
MCP_FIFTY_KB = [
    ("denials of another server", _repeat("I can't access GitLab and ")),
    ("denial sentences", _repeat("I can't access GitLab. ")),
    ("curly denial sentences", _repeat("I can’t access GitLab. ")),
    ("trailing denials", _repeat("GitLab isn't available to me and ")),
    ("present-state denials", _repeat("I can't reach GitHub right now. ")),
    ("reads of another server", _repeat("I checked GitLab and ")),
    ("attributions to another server", _repeat("According to GitLab, GitLab shows it and ")),
    ("possessives without a verb", _repeat("GitHub's run and Home Assistant's lights and ")),
    ("questions", _repeat("Should I check GitHub? ")),
    ("recaps", _repeat("Earlier I checked GitHub and ")),
    ("padded lead", lambda n: "I can't" + " " * n + "GitLab"),
    ("padded name", lambda n: "GitHub" + " " * n + "x"),
    ("padded possessive", lambda n: "GitHub's" + " " * n + "x"),
    ("padded read", lambda n: "I checked" + " " * n + "x"),
]


@pytest.mark.parametrize(
    "label,build",
    [*FIFTY_KB, *MCP_FIFTY_KB],
    ids=[c[0] for c in (*FIFTY_KB, *MCP_FIFTY_KB)],
)
def test_the_mcp_server_guards_read_50_kb_against_thirty_spans_in_linear_time(label, build):
    _assert_linear(
        f"server_denial {label}",
        lambda r: guards.server_denial_check(r, _THIRTY_MCP, _TWO_SERVERS),
        build,
    )
    _assert_linear(
        f"server_claim {label}",
        lambda r: guards.server_claim_check(r, _THIRTY_MCP, _TWO_SERVERS),
        build,
    )


def _servers(n: int) -> list:
    """`n` connected servers, none of them named in the reply below."""
    return [
        guards.McpServerRef(name=f"srv{i}", words=(f"server number {i}", f"srv{i}"))
        for i in range(n)
    ]


# A denial lead and an attribution in every sentence, naming a server the list
# does not hold: each clause asks every server, and none of them answers.
_FIVE_KB_OF_UNHELD_NAMES = _repeat("I can't access GitLab. GitLab shows it. ")(5_000)


@pytest.mark.parametrize(
    "check", [guards.server_denial_check, guards.server_claim_check], ids=lambda c: c.__name__
)
def test_two_hundred_servers_are_read_in_linear_time(check):
    """(fix round 1, M3) The review's cliff: each clause looked each server's
    patterns up behind an lru_cache of 128, so past 128 servers every lookup
    evicted the next one and rebuilt it — 34 s for a 5 KB reply at 140. Each
    server's patterns are fetched once per reply now, before the clauses: 50 ->
    200 servers is linear, and 200 read 5 KB under the cap."""
    _assert_linear(
        f"{check.__name__} servers",
        lambda servers: check(_FIVE_KB_OF_UNHELD_NAMES, _THIRTY_MCP, servers),
        _servers,
        small=50,
        large=200,
        cap_s=BIG_INPUT_CAP_S,
    )


def test_the_mcp_timing_record_backs_neither_server():
    """The pins above read every clause only while nothing in the record backs
    a server or ends the read: the two guards still answer a real claim."""
    assert guards.server_denial_check("I can't access GitHub.", _THIRTY_MCP, _TWO_SERVERS)
    assert guards.server_claim_check("GitHub shows it.", _THIRTY_MCP, _TWO_SERVERS)
    for _label, build in MCP_FIFTY_KB:
        reply = build(2_000)
        assert guards.server_denial_check(reply, _THIRTY_MCP, _TWO_SERVERS) is None, _label
        assert guards.server_claim_check(reply, _THIRTY_MCP, _TWO_SERVERS) is None, _label


# (final review, I-2) ONE clause with no terminator, its claims dropped one by
# one — the reviewer's eight shapes (scratchpad snd-final/probe_timing_final.py).
# Seven read every claim as far as the quotation test and drop it there or
# after; the backticked one drops its claims before it (one in 50 KB reaches
# it). Each claim used to count the clause's quotation marks from its start:
# present passives took 25 ms at 12.5 KB, 155 ms at 50 KB and 1,520 ms at
# 200 KB. Timed at 50 and 200 KB, because the recount only overtakes the
# per-claim work past about 60 KB: from 12.5 to 50 KB it grew x6.2 at most, and
# x5.5 for plain states — too close to linear's x4 to tell apart on a noisy
# runner. From 50 to 200 KB the seven grew x6.6 to x9.8.
LONG_CLAUSE = [
    ("plain states", _repeat("Notepad is open on your DELL-XPS-8950 ")),
    (
        "quoted claims",
        lambda n: '"' + _repeat("Notepad is now open on your DELL-XPS-8950 ")(n - 1),
    ),
    ("another actor", _repeat("the file was saved on your DELL-XPS-8950 by Windows Backup ")),
    ("present passives", _repeat("Teams is launched on your DELL-XPS-8950 ")),
    (
        "backticked claims",
        lambda n: "`" + _repeat("Notepad is now open on your DELL-XPS-8950 ")(n - 1),
    ),
    ("installed states", _repeat("Teams is installed on your DELL-XPS-8950 ")),
    ("subjects then verbs", _repeat("Teams started on your DELL-XPS-8950 stays running ")),
    ("serving subjects", _repeat("qwen3:8b is running now on your DELL-XPS-8950 ")),
]


@pytest.mark.parametrize("label,build", LONG_CLAUSE, ids=[c[0] for c in LONG_CLAUSE])
def test_one_long_clause_of_claims_is_read_in_linear_time(label, build):
    _assert_linear(
        f"device_completion {label}",
        lambda r: guards.device_completion_check(r, [], _NAMES, ["DELL-XPS-8950"]),
        build,
        small=50_000,
        large=200_000,
    )
    _assert_linear(
        f"written_call {label}",
        lambda r: guards.written_call_check(r, [], _NAMES),
        build,
        small=50_000,
        large=200_000,
    )


# -- the capability guard reads 50 KB in linear time (S37a Task 12, ruling X1) --
#
# capability_claim_check asked, for EVERY capability phrase in a clause that
# held a denial, where that phrase's own denial ended and whether a scope word
# sat in its tail: two searches to the end of the clause, a copy of the tail
# and a third search over it — per phrase, and whether or not a denial governed
# the phrase at all. Measured on this N150 before the fix (2026-10-05): 4,500
# phrases before a lead took 16.8 s at 50 KB, a trailing denial before them
# 13.0 s, a lead before scoped phrases 3.8 s — x15 to x17 for 4x the input.
# The impersonal lead ("there is no … in my toolbox") re-read the rest of its
# stretch from every "there is no": 1.3 s at 50 KB, x16. A clause is now read
# once for each; the verdicts must not move, so the pre-fix body is kept below
# as the oracle, as _sentences' is.
#
# Merging main (2026-10-06): main's #97 rewrote the same function the same
# day (hub:1's lane) and the merge kept #97's code, so these shapes now pin
# #97's reading of a clause, and the oracle below is the pre-fix body with
# #97's three differences stated in it — see its docstring.
CAPABILITY_FIFTY_KB = [
    ("phrases then a lead", lambda n: _repeat("read files ")(n - 9) + " I can't."),
    (
        "a trailing denial then phrases",
        lambda n: "Reading files isn't in my toolset " + _repeat("write files ")(n - 34),
    ),
    ("a lead then scoped phrases", lambda n: "I can't " + _repeat("write files outside ")(n - 8)),
    (
        "a lead, phrases, a scope word at the end",
        lambda n: (
            "I can't " + _repeat("browse the web and read files ")(n - 26) + " outside my folder"
        ),
    ),
    ("scoped denials", _repeat("I can't read files outside my folder and ")),
    (
        "scoped trailing denials",
        _repeat("writing files outside my folder isn't in my toolset and "),
    ),
    ("impersonal denials with no toolset", _repeat("there is no x and ")),
    (
        "impersonal denials, the toolset at the end",
        lambda n: _repeat("there is no delete operation and ")(n - 15) + " in my toolbox.",
    ),
    ("mcp phrases then a lead", lambda n: _repeat("connect to MCP servers ")(n - 9) + " I can't."),
    ("prose", _repeat("The quick brown fox jumps over the lazy dog. ")),
]


@pytest.mark.parametrize(
    "label,build", CAPABILITY_FIFTY_KB, ids=[c[0] for c in CAPABILITY_FIFTY_KB]
)
def test_the_capability_guard_reads_the_x1_shapes_in_linear_time(label, build):
    _assert_linear(
        f"capability_claim {label}",
        lambda r: guards.capability_claim_check(r, _NAMES),
        build,
    )


def _denial_tail_before_the_fix(clause: str, phrase_end: int) -> str:
    end = len(clause)
    for pattern in (guards._DENIAL_LEAD, guards._TRAILING_DENIAL):
        nxt = pattern.search(clause, phrase_end)
        if nxt is not None:
            end = min(end, nxt.start())
    return clause[phrase_end:end]


def _scoped_as_97_reads_it(clause: str, phrase_end: int) -> bool:
    """A scope word STARTS in the denial's tail and matches in the clause
    itself (#97's `_DenialMarks`), where the pre-fix body searched a copy of
    the tail. Reading the clause, not a copy, differs in two places: a scope
    word that runs past the tail's end into the next denial counts (silences
    — #97's stated difference, the miss direction; none in the merge's
    fuzz), and a scope word GLUED to the phrase's
    last letter ("fetch URLsbesides") does not, because `\\b` now reads the
    letter before it where the copy's own start was a boundary (fires — 35
    of the merge's 324,852 fuzzed pairs, every one a glued word; S37a's X1
    matched the copy there and the merge kept #97's reading)."""
    tail = _denial_tail_before_the_fix(clause, phrase_end)
    found = guards._SCOPE_QUALIFIER.search(clause, phrase_end)
    return found is not None and found.start() < phrase_end + len(tail)


def _capability_claim_check_before_the_fix(reply_text: str, available_tools) -> object:
    """capability_claim_check's body before X1 and #97, verbatim but for the
    helpers above and the impersonal lead, which is #97's bounded pattern
    (its lookahead reads at most 160 characters — #97's other stated
    difference): the oracle the linear one must agree with on every reply."""
    if not reply_text or not reply_text.strip():
        return None
    registered = frozenset(available_tools)
    denied: list[tuple[str, str]] = []
    seen: set[str] = set()
    for clause, is_question in guards._clauses(reply_text):
        if is_question:
            continue
        lead = guards._DENIAL_LEAD.search(clause) or guards._ABSENT_FROM_TOOLSET.search(clause)
        trailing = guards._TRAILING_DENIAL.search(clause)
        if lead is None and trailing is None:
            continue
        for pattern, tool in guards._CAPABILITY_TOOLS:
            if tool not in registered or tool in seen:
                continue
            for m in pattern.finditer(clause):
                after_lead = lead is not None and m.start() >= lead.end()
                before_trailing = trailing is not None and m.end() <= trailing.start()
                scoped = _scoped_as_97_reads_it(clause, m.end())
                if (after_lead or before_trailing) and not scoped:
                    seen.add(tool)
                    denied.append((m.group(0).strip(), tool))
                    break
    if not denied:
        return None
    tools_named = [tool for _phrase, tool in denied]
    claims = tuple(
        guards.UnbackedClaim(kind="capability_denied", target=tool, phrase=phrase[:80])
        for phrase, tool in denied
    )
    return guards.Correction(claims=claims, text=guards._capability_correction_text(tools_named))


# Fragments the oracle's replies are drawn from: every lead and trailing form,
# a phrase for each capability row, the scope words, the toolset words, and
# filler — joined by spaces, punctuation, clause splitters and, now and then,
# nothing at all, so a phrase can end inside a word ("webelsewhere").
_CAPABILITY_PIECES = (
    *("I can't", "I cannot", "I can not", "I cant", "I'm unable to", "I am not able to"),
    *("I don't have the ability to", "I lack the ability to", "I don't have access to"),
    *("my capabilities don't include", "there is no", "there are no", "I", "I can"),
    *("read files", "access your files", "browse the web", "web browsing", "web", "websites"),
    *("access the internet", "real-time data", "fetch URLs", "write a file", "save files"),
    *("delete files", "no delete operation", "list files", "list the directory"),
    *("save it to memory", "search my memory", "remember things", "download models"),
    *("search for models", "remove a model", "check for updates", "update models"),
    *("set reminders", "remind you", "schedule tasks", "delegate to an agent"),
    *("hand off work", "create an agent", "list your agents", "delete an agent"),
    *("see where the models run", "switch off chat models on a machine"),
    *("make setup QR codes", "pair your laptop", "put myself on your phone"),
    *("access Windows machines", "control Macs", "connect to MCP servers", "use MCP tools"),
    *("outside", "outside my folder", "beyond", "elsewhere", "externally", "anywhere else"),
    *("any place but", "other than", "except", "besides", "apart from", "from the web"),
    *("on the internet", "for someone", "of another", "not in my", "not in this"),
    *("is not in my toolset", "isn't something I can do", "isn't available to me"),
    *("is not one of my tools", "are not among my abilities", "'s not a tool I have"),
    *("is not part of my capabilities", "in my toolbox", "in my tools", "right now"),
    *("until", "because", "yet", "currently", "for you", "the", "files", "that"),
    *("report.md", "x", "it", "please", "you", "isn't", "can't", "agents/coder/"),
)
_CAPABILITY_JOINS = (" ", " ", " ", " ", "", ", ", "; ", ". ", "? ", "\n", " but ", " — ")


def _capability_replies() -> list[str]:
    import random

    from tests.test_capability_guard import MUST_FIRE, MUST_NOT_FIRE

    replies = [case[1] for case in (*MUST_FIRE, *MUST_NOT_FIRE)]
    replies += [build(2_000) for _label, build in (*CAPABILITY_FIFTY_KB, *FIFTY_KB)]
    rng = random.Random(20261005)
    for _ in range(3_000):
        reply = rng.choice(_CAPABILITY_PIECES)
        for _ in range(rng.randint(0, 11)):
            reply += rng.choice(_CAPABILITY_JOINS) + rng.choice(_CAPABILITY_PIECES)
        replies.append(reply)
    return replies


def test_the_capability_guard_judges_every_reply_as_its_oracle_does():
    """A speed fix: every verdict stays what the oracle body says —
    the guard's own corpus, the timing shapes, and 3,000 seeded replies drawn
    from every form the guard reads, against the whole registry, a registry
    without fetch_url, and none."""
    toolsets = (_NAMES, [name for name in _NAMES if name != "fetch_url"], [])
    fired = 0
    for reply in _capability_replies():
        for toolset in toolsets:
            expected = _capability_claim_check_before_the_fix(reply, toolset)
            assert guards.capability_claim_check(reply, toolset) == expected, reply
            fired += expected is not None
    # The oracle compares verdicts that exist: hundreds fire and most do not.
    assert 500 < fired < 3 * len(_capability_replies()) // 2, fired


# -- _sentences() is linear (said-not-done fix round 1, M2) --------------------
#
# The shared sentence splitter re-scanned a run of terminators from every
# position inside it when the run was not followed by whitespace: 10,000 dots
# took 3.9 s and 20,000 took 15 s — and device_completion_check now runs it on
# EVERY reply. The fix only skips positions that could never split; the
# outputs must stay identical, so the pre-fix body is kept here as the oracle.


def _sentences_before_the_fix(text: str) -> list[str]:
    out: list[str] = []
    start = 0
    i = 0
    n = len(text)
    while i < n:
        char = text[i]
        if char == "\n":
            out.append(text[start : i + 1])
            start = i + 1
        elif char in ".!?":
            end = i
            while end + 1 < n and text[end + 1] in ".!?":
                end += 1
            following = text[end + 1] if end + 1 < n else ""
            if following == "" or following.isspace():
                out.append(text[start : end + 1])
                start = end + 1
                i = end
        i += 1
    if start < n:
        out.append(text[start:])
    return out


SENTENCE_ORACLE_INPUTS = [
    "",
    "One. Two! Three? Four",
    "summary.md is at $4.50. Next.",
    "Wait... what?! Really?!? yes.",
    "a..b...c. d",
    "...leading dots and trailing...",
    "line one\nline two. still two\n\nfour!",
    "no terminator at all",
    "!!!",
    "?.!x y.",
    ".\n.\n. .",
    "Version 1.70.2 shipped. v2.0!",
    "…unicode ellipsis… then. done",
    "x" * 50 + "." * 30 + "y" + "." * 5 + " z",
    ". " * 20,
    "a.b.c.d.e.f.g. h",
]


@pytest.mark.parametrize("text", SENTENCE_ORACLE_INPUTS)
def test_sentences_splits_exactly_as_before(text):
    assert guards._sentences(text) == _sentences_before_the_fix(text)


@pytest.mark.parametrize("mark", [".", "!", "?"])
def test_sentences_reads_a_run_of_one_terminator_in_linear_time(mark):
    for label, build in (
        ("a run, then a letter", lambda n: mark * n + "x"),
        ("a letter, then a run", lambda n: "x" + mark * n),
        ("runs of 999", lambda n: (mark * 999 + "y") * (n // 1_000)),
    ):
        _assert_linear(
            f"{mark!r} {label}", guards._sentences, build, small=5_000, large=20_000, cap_s=BUDGET_S
        )


# ---------------------------------------------------------------------------
# A filename is entered once per token (hub:1's carry from S42b Task 23).
#
# `_CONTENT_CLAIM` and `_PASSIVE_CLAIM` began with `\b[\w./-]*`. Inside a long
# dotted, dashed or slashed token every dot is a `\b`, and from each one the
# greedy run walked to the token's end and back: narration_check took 171 ms
# at 1,500 characters and 684 ms at 3,000 of "a." (S42b's measurement), on
# core's one event loop. A filename found inside text now starts only at the
# FRONT of a [\w./-] run. Any end a later start can reach, the front reaches
# too, so the leftmost match is the one it always was; the pre-fix patterns
# are kept here as the oracle.

_FILENAME_RE_BEFORE = (
    r"[\w./-]*[\w-]\.(?:md|txt|json|csv|ya?ml|py|js|ts|html?|pdf|log|ini|toml|xml|sh|cfg|conf)"
)
_FILENAME_BEFORE = re.compile(r"\b" + _FILENAME_RE_BEFORE + r"\b", re.I)
_CONTENT_CLAIM_BEFORE = re.compile(
    r"\b(" + _FILENAME_RE_BEFORE + r")\b\s+(?:now\s+|currently\s+)?"
    r"(?:contains?\s+the\s+following|(?:contains?|says?|reads?|shows?)\s*[:\"'`])",
    re.I,
)
_PASSIVE_CLAIM_BEFORE = re.compile(
    r"\b(" + _FILENAME_RE_BEFORE + r")\b\s+(?:has|have|had|was|were|is|are)\s+(?:been\s+|now\s+)?"
    r"(?P<verb>created|written|saved|updated|appended|added"
    r"|read|opened|reviewed|checked|examined"
    r"|deleted|removed|erased)\b",
    re.I,
)

FILENAME_ORACLE_INPUTS = [
    "",
    "notes.md was read",
    "./notes.md was read and ../a/b.md has been updated",
    "-notes.md is saved, notes.md-old was read",
    "report.md. was read",
    "a.md.txt contains the following: x",
    "x.md5 was read; .md was read",
    "abc.def.md says: hi",
    "C:\\Users\\eval\\config.yaml was read",
    "README.MD HAS BEEN UPDATED",
    "summary.html contains: <p>",
    "a.b.c.d.e.f.g.yml has now been written",
    "dir/sub-dir/file_name.toml is checked",
    "v1.2.3 was read and 1.2.3.md was read",
    "notes.md\twas read",
    "notes.md   currently says 'x'",
    "...notes.md was read",
    "a/./b/../c.json was opened",
    "x" * 40 + ".md was read",
    ("a." * 40) + "md was read",
    ("a-" * 40) + "x.md is read",
]


def _claim_triples_before(pattern: re.Pattern[str], text: str) -> list[tuple]:
    return [(m.group(1), m.group(0), m.groupdict().get("verb")) for m in pattern.finditer(text)]


def _claim_triples_now(pattern: re.Pattern[str], text: str) -> list[tuple]:
    # The phrase as _claims_in records it: from the filename to the match end.
    return [
        (m.group(1), text[m.start(1) : m.end()], m.groupdict().get("verb"))
        for m in pattern.finditer(text)
    ]


def _random_filename_texts(count: int = 3_000) -> list[str]:
    """Seeded, so a failure is reproducible: runs of dots, dashes, slashes,
    words, extensions and the claim verbs, glued in every order."""
    import random

    rng = random.Random(29)
    alphabet = [
        "a", "b", "Z9", "_", ".", "-", "/", " ", "\t", "md", "txt", "yaml", "yml",
        "htm", "html", "md5", "x.md", "./", "../", "Report", "notes", ":", "'",
        " was read", " has been updated", " is saved", " contains the following",
        " says:", " now reads \"", " were deleted",
    ]  # fmt: skip
    return ["".join(rng.choice(alphabet) for _ in range(rng.randint(1, 24))) for _ in range(count)]


@pytest.mark.parametrize("name", ["_CONTENT_CLAIM", "_PASSIVE_CLAIM"])
def test_the_claim_patterns_match_exactly_as_before(name):
    before = {"_CONTENT_CLAIM": _CONTENT_CLAIM_BEFORE, "_PASSIVE_CLAIM": _PASSIVE_CLAIM_BEFORE}[
        name
    ]
    now = getattr(guards, name)
    for text in FILENAME_ORACLE_INPUTS + _random_filename_texts():
        assert _claim_triples_now(now, text) == _claim_triples_before(before, text), text


def test_a_filename_is_found_inside_text_exactly_as_before():
    for text in FILENAME_ORACLE_INPUTS + _random_filename_texts():
        before = _FILENAME_BEFORE.search(text)
        now = guards._FILENAME_IN.search(text)
        assert (now.group(1) if now else None) == (before.group(0) if before else None), text


FILENAME_RUNS = [
    ("dotted", _repeat("a.")),
    ("dashed", _repeat("a-")),
    ("slashed", _repeat("a/")),
    ("dotted_words", _repeat("ab.cd.")),
    ("a_claim_then_a_dotted_run", lambda n: "I ran " + _repeat("a.")(n)),
    ("dotted_runs_with_a_verb_each", _repeat("a.a.a.a.a.a.a.a was read ")),
]


@pytest.mark.parametrize("label, build", FILENAME_RUNS)
def test_narration_reads_a_long_dotted_or_dashed_token_in_linear_time(label, build):
    _assert_linear(f"narration {label}", lambda text: guards.narration_check(text, []), build)


@pytest.mark.parametrize("name", ["_CONTENT_CLAIM", "_PASSIVE_CLAIM", "_FILENAME_IN"])
@pytest.mark.parametrize("label, build", FILENAME_RUNS)
def test_the_filename_patterns_enter_a_run_once(name, label, build):
    pattern = getattr(guards, name)
    _assert_linear(f"{name} {label}", lambda text: list(pattern.finditer(text)), build)


# ---------------------------------------------------------------------------
# The capability guard reads each clause once (found while planning S29).
#
# capability_claim_check runs on every reply. Its per-phrase tail scan
# (`_denial_tail`, then `_SCOPE_QUALIFIER` over that tail) re-read the rest of
# the clause for EVERY capability phrase in it: one clause repeating a scoped
# denial took 0.84 s at 12.5 KB and over 9 s at 50 KB, and
# `_ABSENT_FROM_TOOLSET`'s lookahead walked to the clause's end from every
# "there is no" (1.8 s at 50 KB) — on core's only event loop. Each shape is a
# whole reply. The cap follows BIG_INPUT_CAP_S's own rule: a reply made of
# nothing but denials has every clause read against every row of the table,
# so it is the slowest honest-to-measure shape.
CAPABILITY_CAP_S = 0.45
CAPABILITY_SHAPES = [
    (
        "one clause, scoped denials, the scope at its end",
        lambda n: "I can't " + _repeat("read files and ")(n - 30) + " outside my workspace.",
    ),
    (
        "one clause, one ability denied over and over",
        lambda n: "I can't " + _repeat("read files and ")(n),
    ),
    ("sentences of bare denials", _repeat("I can't browse the web. ")),
    ("sentences of scoped denials", _repeat("I can't write files outside my workspace. ")),
    ("trailing denials", _repeat("Reading files isn't something I can do and ")),
    ("there is no, and no toolset", _repeat("there is no ")),
    (
        "there is no, the toolset at its end",
        lambda n: _repeat("there is no x ")(n - 16) + " in my toolset.",
    ),
]


@pytest.mark.parametrize("label,build", CAPABILITY_SHAPES, ids=[c[0] for c in CAPABILITY_SHAPES])
def test_the_capability_guard_reads_50_kb_in_linear_time(label, build):
    _assert_linear(
        f"capability_claim {label}",
        lambda r: guards.capability_claim_check(r, _NAMES),
        build,
        cap_s=CAPABILITY_CAP_S,
    )
