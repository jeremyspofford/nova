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
    the fossil sweep above must NOT see it; the real one must."""
    old = _pre_s42a_amendment_pattern_sweep()
    new = _every_pattern()
    my_pattern = guards._CAPABILITY_TOOLS[-1][0]
    assert not any(p is my_pattern for p in old.values()), (
        "the fossil (pre-amendment) sweep should not reach the new capability pattern"
    )
    assert any(p is my_pattern for p in new.values()), (
        "the new capability pattern must be reachable by the fixed sweep"
    )


def test_the_sweep_count_grew_by_exactly_the_newly_reachable_patterns():
    """Pinned like test_tools_registry/test_eval_corpus (CLAUDE.md's
    pinned-expectation-suite convention): 162 -> 221, +59 at the amendment;
    172 -> 233, +61 since the said-not-done pair (2026-09-29, below). This catches the
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
          the difference 59 -> 61."""
    old = _pre_s42a_amendment_pattern_sweep()
    new = _every_pattern()
    assert len(old) == 172, len(old)
    assert len(new) == 233, len(new)
    assert len(new) - len(old) == 61


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


def test_the_sweep_walks_the_said_not_done_legs():
    """The pair's patterns only get past their first token on inputs that
    reach it — a tool's name, an open call, a copula, her own verb, an anchor
    — so the sweep carries padding after each, at both widths."""
    swept = _every_pattern()
    for name in ("_written_call_pattern", "_device_anchor", "_ACTION_CLAIM", "_APP_OBJECT"):
        assert name in swept, name
    for inputs in (SWEEP_INPUTS, LONG_SWEEP_INPUTS):
        for lead in ("device_run", "device_run(", "Notepad is", "I have", "on your"):
            assert any(re.match(re.escape(lead) + r"\s{100,}", text) for text in inputs.values())


# The WHOLE guards, not one pattern each: a reply is read line by line and
# clause by clause, and every cut is found once per line or clause, so 50 KB of
# the worst shapes each guard reads stays inside 100 ms — guards run in core's
# only event loop (one took 15.4 s on an honest reply).
WHOLE_GUARD_BUDGET_S = 0.1
_NAMES = tools.tool_names()


def _fifty_kb(unit: str) -> str:
    return (unit * (50_000 // len(unit) + 1))[:50_000]


FIFTY_KB = [
    ("written_names_and_spaces", _fifty_kb("device_run " + " " * 40)),
    ("written_names_then_quotes", _fifty_kb('device_info "x" ')),
    ("written_names_glued", _fifty_kb("device_rundevice_info")),
    ("written_open_parens", _fifty_kb("device_run(" + " " * 30)),
    ("written_fences", _fifty_kb('```\ndevice_launch_app "DELL" "Teams"\n```\n')),
    ("written_one_padded_line", "device_info" + " " * 50_000 + '"x"'),
    ("written_quotes", _fifty_kb('"device_run" ')),
    ("written_examples", _fifty_kb('for example device_run(["ls"]) ')),
    ("claims", _fifty_kb("Notepad is now open on your DELL-XPS-8950 ")),
    ("copulas", _fifty_kb("it is now now now ")),
    ("first_person", _fifty_kb("I opened ")),
    ("padded_copula", "Notepad is" + " " * 50_000 + "open on your Dell"),
    ("padded_anchor", "Notepad is now open" + " " * 50_000 + "on your Dell"),
    ("no_sentence_breaks", _fifty_kb("I have just opened and started and ran ")),
    ("anchors", _fifty_kb("on your Dell to the PC ")),
    ("capitalised_run", "I opened " + "A" * 50_000),
    ("prose", _fifty_kb("The quick brown fox jumps over the lazy dog. ")),
    ("stars", _fifty_kb("**DELL-XPS-8950** ")),
]


@pytest.mark.parametrize("label,reply", FIFTY_KB, ids=[c[0] for c in FIFTY_KB])
def test_the_said_not_done_guards_read_50_kb_in_100_ms(label, reply):
    for check in (
        lambda: guards.written_call_check(reply, [], _NAMES),
        lambda: guards.device_completion_check(reply, [], _NAMES, ["DELL-XPS-8950"]),
    ):
        took = _best_of(check)
        assert took < WHOLE_GUARD_BUDGET_S, f"{label}: {took * 1000:.1f} ms"


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
def test_sentences_reads_20_kb_of_one_terminator_in_50_ms(mark):
    for text in (mark * 20_000 + "x", "x" + mark * 20_000, (mark * 999 + "y") * 20):
        took = _best_of(lambda text=text: guards._sentences(text))
        assert took < BUDGET_S, f"{mark!r} x {len(text)}: {took * 1000:.1f} ms"
