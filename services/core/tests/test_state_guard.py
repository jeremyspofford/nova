"""The live-state guard, tested in isolation: pure (text, spans, names) -> verdict.

state_claim_check is a pure function — no database, no gateway — so this is the
fast corpus that pins its precision. The expensive failure is a wrongly-
corrected HONEST reply (a false positive makes the guard itself the liar), so
the must-NOT-fire cases below are as load-bearing as the fabrications.

The owner's captured case is first: 2026-09-02 23:51, "try again" produced ZERO
tool calls and a reply asserting the paired machine was "still offline" —
parroted out of an earlier (then-true) reply while the device was online. Every
toggle the guard derives from is proven here too: the SAME sentence flips
verdict on a successful device span, and on whether anything is paired at all.
"""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from app import chat, guards

# The owner's paired machine, and his EXACT captured reply.
DEVICE = "DELL-XPS-8950"
NAMES = [DEVICE]
OWNER_CASE = (
    "Looks like the device is still offline. Could you confirm it's on and "
    "connected so I can try again?"
)


class Span:
    """The minimal span shape every guard reads: kind, name, meta.ok."""

    def __init__(
        self,
        name: str,
        *,
        kind: str = "tool",
        ok: bool = True,
        facts: list | None = None,
    ) -> None:
        self.kind = kind
        self.name = name
        self.meta: dict = {"ok": ok}
        if facts is not None:
            self.meta["facts"] = facts


# -- MUST FIRE (no device span this turn) ----------------------------------

MUST_FIRE = [
    ("owner_exact_case", OWNER_CASE),
    ("bare_offline", "The device is offline."),
    ("named_device_offline", f"{DEVICE} is offline."),
    ("named_with_determiner", f"The {DEVICE} is not connected."),
    ("your_device_unreachable", "Your device is currently unreachable."),
    ("contraction_copula", "The device's offline right now."),
    ("present_perfect", "The device has gone offline."),
    ("still_disconnected", "That device is still disconnected."),
    ("no_longer_connected", "The device is no longer connected."),
    ("not_reachable", "The device is not reachable."),
    ("last_seen_as_current", "The device was last seen three hours ago."),
    # A POSITIVE state is just as unchecked as a negative one.
    ("claims_it_is_online", "The device is online and connected."),
    ("connected_right_now", "This device is connected right now."),
]


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_must_fire_when_no_device_was_checked(label, reply):
    claim = guards.state_claim_check(reply, [], NAMES)
    assert claim is not None, f"{label!r} should have fired but did not"
    assert claim.text == guards.STATE_CLAIM_CORRECTION
    assert claim.device and claim.phrase


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_the_same_sentence_is_clean_when_a_device_tool_actually_ran(label, reply):
    """The toggle: a successful device_* span this turn BACKS whatever the reply
    says about the device, so the guard must stay silent on the identical text."""
    assert guards.state_claim_check(reply, [Span("device_list")], NAMES) is None


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_the_same_sentence_is_clean_when_nothing_is_paired(label, reply):
    """The other toggle, DERIVED not hardcoded: with no paired devices there is
    no machine to be wrong about, so the guard never fires."""
    assert guards.state_claim_check(reply, [], []) is None


# -- MUST NOT FIRE (no device span this turn) ------------------------------
#
# Past reports, conditionals, intent-to-check, questions and reported speech
# assert nothing about the device's state RIGHT NOW. Correcting any of these
# makes the guard the liar.

MUST_NOT_FIRE = [
    ("past_pronoun", "It was offline earlier."),
    ("past_named_subject", "The device was offline earlier."),
    ("past_perfect", "The machine had been offline when I last looked."),
    ("conditional_if", "If the device is offline, I can wake it."),
    ("conditional_once", "Once the device is online, I'll retry."),
    ("intent_check_whether", "Let me check whether the device is online."),
    ("intent_ill_check_if", "I'll check if the machine is connected."),
    ("hedged_might", "The device might be offline."),
    ("hedged_may_be", "Your computer may be unreachable."),
    ("question_is_it", "Is the device online?"),
    ("question_confirm", "Could you confirm the device is connected?"),
    ("reported_speech", "You said the device is offline."),
    ("prior_time_marker", "The device is offline as of an hour ago."),
    ("no_device_subject", "The connection is offline."),
    ("bare_pronoun_subject", "It's offline."),
    # -- review I3: a bare machine noun need not be about a PAIRED device, and
    # this guard REPLACES what it corrects, so the whole branch is gone.
    ("bare_noun_laptop", "Your laptop is probably asleep."),
    ("bare_noun_machine", "The machine is unreachable."),
    ("bare_noun_computer", "The computer is powered off."),
    ("bare_noun_desktop", "That desktop is offline."),
    ("bare_noun_pc", "Your PC is disconnected."),
    # -- review I4: polysemous state words. Each of these is ordinary English
    # about something other than a socket, and each produced a REPLACE-class
    # false positive before the state vocabulary was narrowed.
    ("polysemous_up", "The device is up to date."),
    ("polysemous_down", "The device is down for maintenance until Friday."),
    ("polysemous_available", "The device is available for pickup."),
    ("polysemous_connected_to", "The device is connected to the projector."),
    ("polysemous_asleep", "The device is asleep on the couch, apparently."),
    ("ordinary_reply", "Here's the summary of your calendar for tomorrow."),
    (
        "general_capability",
        "I can check whether a paired computer is online whenever you ask.",
    ),
]


@pytest.mark.parametrize("label,reply", MUST_NOT_FIRE, ids=[c[0] for c in MUST_NOT_FIRE])
def test_must_not_fire_on_replies_that_assert_no_current_state(label, reply):
    assert (
        guards.state_claim_check(reply, [], NAMES) is None
    ), f"{label!r} was wrongly corrected — a false positive makes the guard the liar"


# The misses this precision buys, pinned so they are a CHOICE and not a
# surprise. Every one of them is an unchecked claim the guard lets through; each
# is here because the shape that would catch it also catches honest prose, and
# this guard REPLACES the reply it corrects. If a future change makes one of
# these fire, that is a deliberate move, not a bug fix — check what else it
# starts firing on first.
ACCEPTED_MISSES = [
    ("polysemy_down_right_now", "The device is down right now."),
    ("polysemy_up_right_now", "The device is up right now."),
    # "It's offline." is already pinned as MUST_NOT_FIRE's bare_pronoun_subject
    # (a bare pronoun has no paired-device subject at all, so it never fires —
    # not an accepted miss the guard chooses to let through).
    ("no_state_word", "The device is back."),
    ("plural_no_named_subject", "Both devices are offline."),
    ("responding", "The device is not responding."),
    ("noun_intent_trip", "I ran a check — the device is offline."),
]


@pytest.mark.parametrize(
    "label,reply", ACCEPTED_MISSES, ids=[c[0] for c in ACCEPTED_MISSES]
)
def test_the_accepted_misses_stay_missed(label, reply):
    assert guards.state_claim_check(reply, [], NAMES) is None


def test_no_bare_machine_noun_remains_in_the_subject_pattern():
    """Review I3/M1: laptop/machine/computer/desktop/pc/box are gone, and with
    them the `boxes?` alternative that never matched a bare "box" anyway. Pinned
    against the pattern source so the branch cannot creep back in unnoticed."""
    from app.guards import _DEVICE_NOUN

    for noun in ("laptop", "machine", "computer", "desktop", "pc", "box"):
        assert noun not in _DEVICE_NOUN.lower(), noun
    assert "device" in _DEVICE_NOUN


# -- edges the corpus does not name but precision demands ------------------


def test_an_empty_or_blank_reply_never_fires():
    assert guards.state_claim_check("", [], NAMES) is None
    assert guards.state_claim_check("   \n ", [], NAMES) is None


# -- review C1: a REFUSAL that determined connectivity IS a check --------------
#
# PIN REPLACED (2026-09-03). The old pin asserted that any failed device span
# backs nothing, and that was the wrong behaviour: when the device really is
# offline EVERY device tool refuses inside its executor's `_admit` ("not
# connected — its tile is stale") with ok=False, so an honest "I ran it and it came back not
# connected — X is offline" was corrected and REPLACED by "I did not actually
# check", systematically, in the exact scenario this guard exists for. Backing
# now reads the structured fact the per-device layer records for both outcomes,
# never the refusal's prose. The three cases below are what that means.


def test_a_refusal_that_determined_connectivity_backs_the_claim():
    """The reviewer's exact sequence: device_run refused not-connected, then the
    model reports the machine is offline. It DID check. The guard must be
    silent — correcting a true reply is the worst thing it can do.

    PIN FIX (2026-09-03, re-review): the original reply here was "I ran the
    CHECK and it came back not connected — X is offline" — but "check" is an
    intent-verb token (_STATE_INTENT), so `_state_prefix_blocks` suppresses the
    assertion by itself, regardless of what the span carries. That test passed
    even with `_checked_a_device`'s facts branch deleted, which made it a
    vacuous tripwire for the very thing this pin exists to prove. The reply
    below carries no intent/hedge word in front of the assertion, so silence
    here can only come from the facts branch — proved by the second assertion,
    the identical reply with a same-shaped but factless refusal, which fires."""
    reply = f"{DEVICE} is offline — its tile is stale."
    backed = Span("device_run", ok=False, facts=[{"device": DEVICE, "connected": False}])
    assert guards.state_claim_check(reply, [backed], NAMES) is None

    unbacked = Span("device_run", ok=False)  # same shape, no fact recorded
    assert guards.state_claim_check(reply, [unbacked], NAMES) is not None


def test_a_refusal_that_determined_nothing_still_backs_nothing():
    """"no paired device named X" refuses BEFORE connectivity is looked at, so
    it records no fact and settles nothing. The claim is still unchecked."""
    refused = Span("device_run", ok=False)  # no facts recorded
    assert guards.state_claim_check(OWNER_CASE, [refused], NAMES) is not None


def test_a_later_refusal_on_a_CONNECTED_device_backs_the_claim():
    """The connectivity check PASSED and a later refusal — the device answered
    ok=false — failed the call. The fact was still determined — connected=True
    — so "the device is online" is a report of a real read."""
    refused = Span("device_run", ok=False, facts=[{"device": DEVICE, "connected": True}])
    assert guards.state_claim_check("The device is online.", [refused], NAMES) is None


def test_a_failed_span_with_no_facts_and_a_malformed_facts_value_back_nothing():
    """Fail-safe on the fact itself: a non-list, or entries without a
    `connected` key, are not a connectivity determination."""
    for meta in ({}, {"facts": "connected"}, {"facts": [{"device": DEVICE}]}):
        span = Span("device_run", ok=False)
        span.meta.update(meta)
        assert guards.state_claim_check(OWNER_CASE, [span], NAMES) is not None


def test_a_non_device_span_does_not_back_the_claim():
    """A web fetch is not a device check."""
    assert guards.state_claim_check(OWNER_CASE, [Span("fetch_url")], NAMES) is not None


def test_backing_is_derived_from_the_device_prefix_not_a_list():
    """Every device tool is named device_* (app/tools/devices.py), which is why
    backing is a prefix test: a device tool shipped tomorrow backs the claim the
    day it lands. If this ever goes red, a device tool was named off-pattern —
    that is the alarm, not a nuisance."""
    from app.tools import devices as device_tools

    names = [tool.name for tool in device_tools.TOOLS]
    assert names, "the device tool module shipped no tools"
    assert all(name.startswith("device_") for name in names), names
    for name in names:
        assert guards.state_claim_check(OWNER_CASE, [Span(name)], NAMES) is None


def test_a_name_with_regex_metacharacters_is_matched_literally():
    """Device names are operator text; one containing '.' or '+' must not become
    a wildcard that swallows unrelated sentences."""
    names = ["jeremy's box (v2.0)"]
    assert guards.state_claim_check("jeremy's box (v2.0) is offline.", [], names)
    assert guards.state_claim_check("jeremyXsXboxXXvZZ0Y is offline.", [], names) is None


def test_the_correction_and_the_note_trip_no_guard_of_their_own():
    """The correction is what PERSISTS, so a text that tripped a guard would be
    corrected forever. Same bar for the live note the redirect ships."""
    text = guards.STATE_CLAIM_CORRECTION
    assert guards.state_claim_check(text, [], NAMES) is None
    assert guards.narration_check(text, []) is None
    assert guards.consent_claim_check(text) is None
    assert guards.capability_claim_check(text, ["fetch_url", "device_list"]) is None
    assert guards.deferral_check(text, [], ["fetch_url", "web_search"]) is None
    # 2026-09-03: the guard set grew a seventh sibling (presented_listing);
    # every persisted text is held to it too.
    assert guards.presented_listing_check(text, [], ["workspace_list_files"]) is None

    note = chat.STATE_REDIRECT_NOTE
    assert guards.state_claim_check(note, [], NAMES) is None
    assert guards.narration_check(note, []) is None
    assert guards.consent_claim_check(note) is None
    assert guards.deferral_check(note, [], ["fetch_url", "web_search"]) is None
    assert guards.presented_listing_check(note, [], ["workspace_list_files"]) is None


def test_the_redirect_nudge_refuses_to_state_a_fact_that_is_not_true():
    """The nudge asserts 'nothing has run this turn', so it is BUILT from that
    fact rather than written as a constant that could drift out of step with it.
    Told otherwise, it refuses — a lie to the model is what produces a second
    dispatch."""
    nudge = chat.state_redirect_nudge(device=DEVICE, ran_a_tool=False)
    assert DEVICE in nudge
    assert "device tool" in nudge
    with pytest.raises(ValueError):
        chat.state_redirect_nudge(device=DEVICE, ran_a_tool=True)


# -- N3: every connectivity-determining call site is allow-listed -----------
#
# Same shape as test_no_approvals.py's AST pins over app/tools/__init__.py: a
# regex over the source is too weak — it would have to be
# taught every alias and dotted spelling by hand — so this AST-walks every
# *.py under app/ for the three call shapes that read a device's LIVE socket
# state: `hub.is_connected(...)`, `.connected_ids(...)`, and
# `self._conns.get(...)` / `_conns.get(...)`. Each occurrence must sit inside a
# function this file names in `_ALLOWED_CONNECTIVITY_SITES`, together with why
# it is safe not to be treated as an ungoverned read: it RECORDS what it
# determines onto a facts_sink, it is a documented REPORTER whose own success
# already backs the claim, or it is internal BOOKKEEPING that never surfaces a
# connectivity claim anywhere a guard or a reply reads from.
#
# The alarm this exists to raise: a device tool shipped tomorrow that reads
# connectivity a FOURTH way — a new hub method, a raw dict poke — and forgets
# either half of state_claim_check's contract (a real check must be seen as
# backing, an unchecked claim must still fire). This reddens the day that
# lands, pointing at the exact call site to classify, instead of the gap
# staying invisible until a live walk hits it (the way `hub.command`'s own
# re-check did — N3, 2026-09-03: it determined "not connected" and raised,
# but recorded nothing, so a span already carrying a stale
# facts=[{"connected": true}] from `_admit` backed a refusal reporting the
# opposite. Fixed by threading facts_sink into hub.command; this pin is
# what keeps the next one from being silent too).

_RECORDS = "records"
_REPORTER = "reporter"
_BOOKKEEPING = "bookkeeping"

# (relative path under app/, dotted Class.method or bare function name) -> a
# (kind, reason) pair. `kind` gates a light structural check below; the reason
# is read by a human deciding whether a NEW site belongs here.
_ALLOWED_CONNECTIVITY_SITES: dict[tuple[str, str], tuple[str, str]] = {
    ("devices_ws.py", "Hub.unregister"): (
        _BOOKKEEPING,
        "compares which conn is still the registered one to decide whether to "
        "tear down cleanup state for THIS socket — never returns a connectivity "
        "claim to anything a reply or a guard reads.",
    ),
    ("devices_ws.py", "Hub.command"): (
        _RECORDS,
        "the not-connected re-check right before sending (the gap `_admit` "
        "cannot see, N3): a socket gone or dead between `_admit` and send determines "
        "connectivity=False here, and records it onto facts_sink when the "
        "caller threaded one through _command, so a span's facts end on the "
        "truth this refusal is actually reporting.",
    ),
    ("tools/devices.py", "_require_connected"): (
        _RECORDS,
        "the ONE place core determines a device's connectivity during _admit; "
        "writes {device, connected} to ctx.facts_sink for BOTH outcomes.",
    ),
    ("tools/devices.py", "device_list"): (
        _REPORTER,
        "reads connected_ids() to render each paired device's status and "
        "returns ok=True on success — the state guard already treats any "
        "successful device_* span as backing (meta.ok is True), so this one "
        "does not also need a fact recorded to be honest.",
    ),
}


class _ConnectivityCallFinder(ast.NodeVisitor):
    """Every `hub.is_connected(...)`, `.connected_ids(...)`, and
    `self._conns.get(...)` / `_conns.get(...)` CALL in a module, tagged with
    its enclosing Class.method (or bare function) — never its definition line,
    only where it is actually invoked."""

    def __init__(self) -> None:
        self._stack: list[str] = []
        self.hits: list[tuple[str, str, int]] = []  # (kind, qualname, lineno)

    def _dotted(self, node: ast.AST) -> str:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            base = self._dotted(node.value)
            return f"{base}.{node.attr}" if base else node.attr
        return ""

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._stack.append(node.name)
        self.generic_visit(node)
        self._stack.pop()

    def _visit_func(self, node: ast.AST) -> None:
        self._stack.append(node.name)  # type: ignore[attr-defined]
        self.generic_visit(node)
        self._stack.pop()

    visit_FunctionDef = _visit_func
    visit_AsyncFunctionDef = _visit_func

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func
        kind = None
        if isinstance(func, ast.Attribute):
            if func.attr == "is_connected":
                kind = "hub.is_connected("
            elif func.attr == "connected_ids":
                kind = "connected_ids("
            elif func.attr == "get" and self._dotted(func.value) in ("self._conns", "_conns"):
                kind = "_conns.get("
        if kind is not None:
            qualname = ".".join(self._stack) if self._stack else "<module>"
            self.hits.append((kind, qualname, node.lineno))
        self.generic_visit(node)


def test_every_connectivity_read_site_is_allow_listed():
    """A device tool must be seen as backed when it really checked, and must
    still fire the guard when it did not — `_ALLOWED_CONNECTIVITY_SITES` is
    where that promise is kept for every site that reads the hub's live socket
    state. A NEW site missing here is the alarm (see the section header)."""
    app_dir = Path(guards.__file__).parent
    offenders: list[str] = []
    seen: set[tuple[str, str]] = set()
    for py in sorted(app_dir.rglob("*.py")):
        tree = ast.parse(py.read_text(encoding="utf-8"))
        finder = _ConnectivityCallFinder()
        finder.visit(tree)
        rel = str(py.relative_to(app_dir))
        for kind, qualname, lineno in finder.hits:
            key = (rel, qualname)
            seen.add(key)
            if key not in _ALLOWED_CONNECTIVITY_SITES:
                offenders.append(f"{rel}:{lineno} {qualname} ({kind})")
                continue
            site_kind, _reason = _ALLOWED_CONNECTIVITY_SITES[key]
            if site_kind == _RECORDS:
                source = py.read_text(encoding="utf-8")
                func_src = ast.get_source_segment(source, _find(tree, qualname))
                assert func_src is not None and "facts_sink" in func_src, (
                    f"{key} is allow-listed as 'records' but its source no "
                    "longer mentions facts_sink — update the allow-list or "
                    "restore the recording"
                )
    assert offenders == [], (
        "a new connectivity read site is not allow-listed in "
        f"_ALLOWED_CONNECTIVITY_SITES — classify it (records/reporter/"
        f"bookkeeping) and say why: {offenders}"
    )
    # The allow-list itself must not go stale: every entry names a site that
    # really exists, or the pin is testing nothing.
    assert seen == set(_ALLOWED_CONNECTIVITY_SITES), (
        f"allow-listed sites with no matching call left in the source: "
        f"{set(_ALLOWED_CONNECTIVITY_SITES) - seen}"
    )


def _find(tree: ast.AST, qualname: str) -> ast.AST:
    """The (Class.method or bare function) node named by `qualname`, for
    pulling its source text to check a light structural claim."""
    parts = qualname.split(".")

    def _walk(node: ast.AST, remaining: list[str]) -> ast.AST | None:
        if not remaining:
            return node
        name = remaining[0]
        for child in ast.iter_child_nodes(node):
            if (
                isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                and child.name == name
            ):
                found = _walk(child, remaining[1:])
                if found is not None:
                    return found
        return None

    found = _walk(tree, parts)
    assert found is not None, f"could not locate {qualname} in the module"
    return found
