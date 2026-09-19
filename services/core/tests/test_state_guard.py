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
    assert guards.state_claim_check(reply, [], NAMES) is None, (
        f"{label!r} was wrongly corrected — a false positive makes the guard the liar"
    )


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


@pytest.mark.parametrize("label,reply", ACCEPTED_MISSES, ids=[c[0] for c in ACCEPTED_MISSES])
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
    """ "no paired device named X" refuses BEFORE connectivity is looked at, so
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
    ("delivery.py", "_connected_device_names"): (
        _BOOKKEEPING,
        "S11: the same derivation as the scheduler's, duplicated because "
        "scheduler imports beats at module level and a module-level import "
        "back would close the cycle. Reads connected_ids() only to pick which "
        "paired devices an URGENT notice goes to. Each target is then "
        "re-determined and RECORDED by _require_connected inside the "
        "device_notify call delivery dispatches through chat._run_tool, so the "
        "span carries the fact; the 'no paired device was connected' note "
        "lands on the notice's receipt and the firing row for the Schedules "
        "page, never in text a model produced or a guard reads.",
    ),
    ("scheduler.py", "_connected_device_names"): (
        _BOOKKEEPING,
        "S9: reads connected_ids() only to pick which paired devices a REMINDER "
        "is delivered to. Each target is then re-determined and RECORDED by "
        "_require_connected inside the device_notify call the firing dispatches "
        "through chat._run_tool, so the span carries the fact; the 'no paired "
        "device was connected' note lands on the firing row for the Schedules "
        "page, never in text a model produced or a guard reads.",
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


# ============================================================================
# S40b: MACHINES (design-verdict §3.1 A, corpus §4 "state_claim — machine")
# ============================================================================
#
# The S40 live walk, turn b02a5694: asked "Where do your models run, and is
# that machine ready?" a second time, she replayed the previous turn's
# machine_status reading from history — `Last Reported: 2026-09-19T05:15:39`,
# twenty minutes old — as the current status, without checking anything. The
# guard learns machine subjects, DERIVED from this turn's own spans (the head of
# a served round's `served_by`, machine_status facts and args), and corrects a
# negative state or a reading time about a machine this turn did not read.
#
# Armed only in the turn kinds its precision was measured in (STACK_CLAIM_KINDS:
# chat and eval); every existing call — `purpose` omitted — is unchanged.
#
# The corpus sentences below are the verdict's, verbatim. Additions beyond it
# are in their own lists, labelled.

from types import SimpleNamespace  # noqa: E402

from app.tools import machines as machine_tools  # noqa: E402
from tests.s40_walk import B02A5694, B851AA91  # noqa: E402


def _span(kind: str, name: str, **meta):
    return SimpleNamespace(kind=kind, name=name, meta=dict(meta))


def _llm(served_by: str, *, local: bool | None = True, purpose: str = "chat", **meta):
    """A served round as chat._gateway_round records it: `served_by` from the
    gateway's header, `local` from its usage chunk."""
    fields = {"purpose": purpose, "served_by": served_by, **meta}
    if local is not None:
        fields["local"] = local
    return _span("llm_call", served_by, **fields)


def _status(*, machine: str | None = None, facts: list | None = None, ok: bool = True, **meta):
    args = {} if machine is None else {"machine": machine}
    fields = {"ok": ok, "args_redacted": args, **meta}
    if facts is not None:
        fields["facts"] = facts
    return _span("tool", "machine_status", **fields)


def _fact(machine: str, *, checked_now: bool = True) -> dict:
    return {
        "machine": machine,
        "answering": True,
        "checked_now": checked_now,
        "at": "2026-09-19T05:15:39.282993+00:00",
    }


HUB_SERVED = _llm("hub:qwen3:8b")
HUB_READ = _status(facts=[_fact("hub")])
CFG = _span(
    "tool",
    "machine_configure",
    ok=True,
    args_redacted={"machine": "hub", "serving": False},
)
DELL_READ = _status(machine="dell", facts=[_fact("dell")])

NAME_BLOCK = (
    "### Machine Status\n- **Name**: `hub`\n- **Last Reported**: `2026-09-19T05:15:39+00:00`"
)

MACHINE_CORRECTION_HUB = (
    "Correction: I did not check hub this turn — I have no record of doing so, so what "
    "I said about it is not a current reading."
)
HUB_SERVED_CLAUSE = " hub answered this turn: this reply came from hub:qwen3:8b."

# (label, reply, spans, purpose, the machine it names)
MACHINE_MUST_FIRE = [
    ("b02a5694_full", B02A5694, [HUB_SERVED], "chat", "hub"),
    ("switched_off", "hub is switched off.", [HUB_SERVED], "chat", "hub"),
    ("code_not_answering", "`hub` is not answering right now.", [HUB_SERVED], "chat", "hub"),
    ("bold_code_offline", "**`hub`** is offline.", [HUB_SERVED], "chat", "hub"),
    (
        "which_is_currently_switched_off",
        "The models run on hub, which is currently switched off.",
        [HUB_SERVED],
        "chat",
        "hub",
    ),
    ("name_last_reported_block", NAME_BLOCK, [HUB_SERVED], "chat", "hub"),
    (
        "last_checked_kv",
        "The models run on hub.\n- **Last Checked**: 05:15 UTC",
        [HUB_SERVED],
        "chat",
        "hub",
    ),
    (
        "last_checked_just_now",
        "hub runs models.\n- Last checked: just now",
        [HUB_SERVED],
        "chat",
        "hub",
    ),
    ("no_longer_answering", "hub is no longer answering.", [HUB_SERVED], "chat", "hub"),
    ("not_ready_right_now", "hub is not ready right now.", [HUB_SERVED], "chat", "hub"),
    (
        "read_of_another_machine_copula",
        "hub is switched off for models.",
        [HUB_SERVED, DELL_READ],
        "chat",
        "hub",
    ),
    (
        "read_of_another_machine_block",
        NAME_BLOCK,
        [HUB_SERVED, DELL_READ],
        "chat",
        "hub",
    ),
    (
        "eval_box_in_an_eval",
        "Your models run on eval_box, which is switched off for chat models.",
        [_llm("eval_box:qwen3:8b", purpose="eval")],
        "eval",
        "eval_box",
    ),
]

# (label, reply, spans) — every one in a chat turn.
MACHINE_MUST_NOT = [
    ("b851aa91_full", B851AA91, [HUB_SERVED, HUB_READ]),
    (
        "called_ready_and_active",
        "The models run on a machine called **hub**, which is currently ready and active.",
        [HUB_SERVED],
    ),
    (
        "serving_on_block",
        "### Machine Status\n- **Name**: `hub`\n- **Serving**: ✅ **On** (always on)",
        [HUB_SERVED],
    ),
    ("usb_hub", "Your USB hub is offline.", [HUB_SERVED]),
    ("smart_home_hub", "The smart-home hub is offline.", [HUB_SERVED]),
    ("possessive_hub", "Jeremy's hub is offline.", [HUB_SERVED]),
    ("past_when_i_checked", "When I checked at 05:15, hub was answering.", [HUB_SERVED]),
    ("past_earlier_today", "Earlier today hub was switched off for chat models.", [HUB_SERVED]),
    ("intent_check_whether", "Let me check whether hub is ready.", [HUB_SERVED]),
    (
        "conditional_if",
        "If hub is switched off, chat falls back to the next link.",
        [HUB_SERVED],
    ),
    ("question", "Is hub ready?", [HUB_SERVED]),
    ("reported_speech", "You said hub is offline.", [HUB_SERVED]),
    ("not_ready_for_you", "hub is not ready for you to add a model.", [HUB_SERVED]),
    ("configured_this_turn", "hub is switched off for models.", [HUB_SERVED, CFG]),
    (
        "read_not_checked_now",
        "hub is not answering (not checked now).",
        [HUB_SERVED, _status(facts=[_fact("hub", checked_now=False)])],
    ),
    ("unasked_read_no_facts", NAME_BLOCK, [HUB_SERVED, _status(unasked=True)]),
    (
        "last_updated_is_not_a_reading",
        "hub runs models.\n- **Last updated**: 2026-08-29 10:00 UTC",
        [HUB_SERVED],
    ),
    (
        "heading_ends_the_run",
        "hub runs models.\n### Devices\n- **Last seen**: 2026-09-18 16:48 UTC",
        [HUB_SERVED],
    ),
    (
        "paired_device_line_unbinds",
        "hub runs models.\n- DELL-XPS-8950\n- **Last seen**: 2026-09-18 16:48 UTC",
        [HUB_SERVED],
    ),
    (
        "colon_line_unbinds",
        "Models run on hub.\nYour Dell:\n- Status: offline\n- Last seen: 2026-09-18 16:48 UTC",
        [HUB_SERVED],
    ),
    ("fenced_block", f"```\n{NAME_BLOCK}\n```", [HUB_SERVED]),
    ("fenced_copula", "```\nhub is offline.\n```", [HUB_SERVED]),
    (
        "quoted_block",
        "\n".join(f"> {line}" for line in NAME_BLOCK.splitlines()),
        [HUB_SERVED],
    ),
    ("quoted_copula", "> hub is offline.", [HUB_SERVED]),
    ("the_machine_existing_pin", "The machine is unreachable.", [HUB_SERVED]),
    ("negated_offline", "hub is not offline.", [HUB_SERVED]),
    ("negated_switched_off", "hub is not switched off.", [HUB_SERVED]),
    (
        "lead_in_checked_earlier",
        f"Here is what hub reported when I checked earlier:\n\n{NAME_BLOCK}",
        [HUB_SERVED],
    ),
    ("not_checked_since", f"{NAME_BLOCK} (I have not checked since)", [HUB_SERVED]),
    (
        "could_not_be_asked",
        f"{NAME_BLOCK} (the gateway could not be asked now)",
        [HUB_SERVED],
    ),
    (
        "cloud_served_only",
        "hub is offline.",
        [_llm("openrouter:anthropic/claude-sonnet-4.6", local=False)],
    ),
    ("github", "The GitHub is offline.", [HUB_SERVED]),
    ("hostname", "hub.example.com is unreachable.", [HUB_SERVED]),
    ("positive_ready", "hub is ready.", [HUB_SERVED]),
    ("positive_answering", "hub is answering.", [HUB_SERVED]),
    ("positive_online_and_serving", "hub is online and serving.", [HUB_SERVED]),
]

# The misses this precision buys (verdict §4), pinned so each is a choice.
MACHINE_ACCEPTED_MISSES = [
    ("case_exact", "Hub is offline.", [HUB_SERVED]),
    ("determiner_the", "The hub is offline.", [HUB_SERVED]),
    (
        "no_negative_key_value_branch",
        "### Machine Status\n- **Name**: `hub`\n- **Serving**: ❌ **Off**",
        [HUB_SERVED],
    ),
    ("past_tense_last_checked", "hub was last checked at 05:15 UTC.", [HUB_SERVED]),
    # S44 lists machine names from the gateway; until then a machine that
    # neither served nor was read this turn is not a subject.
    ("unnamed_machine_s44", "hub is ready.", [_llm("dell:qwen3:8b")]),
    (
        "read_plus_replayed_older_stamp",
        NAME_BLOCK.replace("2026-09-19T05:15:39", "2026-09-18T22:01:07"),
        [HUB_SERVED, HUB_READ],
    ),
]


@pytest.mark.parametrize(
    "label,reply,spans,purpose,machine",
    MACHINE_MUST_FIRE,
    ids=[c[0] for c in MACHINE_MUST_FIRE],
)
def test_machine_must_fire(label, reply, spans, purpose, machine):
    claim = guards.state_claim_check(reply, spans, NAMES, purpose=purpose)
    assert claim is not None, f"{label!r} should have fired but did not"
    assert claim.subject_kind == "machine"
    assert claim.device == machine
    assert claim.phrase
    assert claim.text.startswith(guards.STATE_CLAIM_MACHINE_CORRECTION.format(machine=machine)), (
        claim.text
    )


@pytest.mark.parametrize(
    "label,reply,spans",
    MACHINE_MUST_NOT,
    ids=[c[0] for c in MACHINE_MUST_NOT],
)
def test_machine_must_not_fire(label, reply, spans):
    assert guards.state_claim_check(reply, spans, NAMES, purpose="chat") is None, (
        f"{label!r} was wrongly corrected — a false positive makes the guard the liar"
    )


@pytest.mark.parametrize(
    "label,reply,spans",
    MACHINE_ACCEPTED_MISSES,
    ids=[c[0] for c in MACHINE_ACCEPTED_MISSES],
)
def test_machine_accepted_misses_stay_missed(label, reply, spans):
    assert guards.state_claim_check(reply, spans, NAMES, purpose="chat") is None


@pytest.mark.parametrize(
    "label,reply,spans,purpose,machine",
    MACHINE_MUST_FIRE,
    ids=[c[0] for c in MACHINE_MUST_FIRE],
)
def test_machine_must_fire_is_silent_with_no_spans(label, reply, spans, purpose, machine):
    """DERIVED, not hardcoded: with nothing served and nothing read this turn,
    there is no machine to be wrong about."""
    assert guards.state_claim_check(reply, [], NAMES, purpose=purpose) is None


@pytest.mark.parametrize("unarmed", ["scheduled", "agent", "beat", None])
@pytest.mark.parametrize(
    "label,reply,spans,purpose,machine",
    MACHINE_MUST_FIRE,
    ids=[c[0] for c in MACHINE_MUST_FIRE],
)
def test_machine_must_fire_is_silent_where_the_guard_is_not_armed(
    label, reply, spans, purpose, machine, unarmed
):
    """Armed only where its precision was measured (STACK_CLAIM_KINDS). A
    scheduled or agent turn is not read live and the correction REPLACES, so a
    false one there IS the persisted row; `None` is every pre-S40b caller."""
    if unarmed is None:
        assert guards.state_claim_check(reply, spans, NAMES) is None
    assert guards.state_claim_check(reply, spans, NAMES, purpose=unarmed) is None


# -- the walk turn, pinned exactly ---------------------------------------------


def test_the_walk_replay_is_corrected_on_its_reading_line():
    """b02a5694: the `Last Reported` line binds to hub through the `Name: hub`
    line above it, and nothing read hub this turn. A reading time is not a
    negative state, so the served clause is not appended: the correction says
    only what is mechanically true."""
    claim = guards.state_claim_check(B02A5694, [HUB_SERVED], NAMES, purpose="chat")
    assert claim is not None
    assert claim.phrase == "- Last Reported: 2026-09-19T05:15:39+00:00"
    assert claim.text == MACHINE_CORRECTION_HUB
    assert claim.served_by is None
    assert claim.evidence == "unchecked"


def test_a_negative_claim_about_a_machine_that_served_says_so():
    claim = guards.state_claim_check("hub is switched off.", [HUB_SERVED], NAMES, purpose="chat")
    assert claim is not None
    assert claim.text == MACHINE_CORRECTION_HUB + HUB_SERVED_CLAUSE
    assert claim.served_by == "hub:qwen3:8b"
    assert claim.evidence == "served"
    assert claim.phrase == "hub is switched off"


def test_the_honest_walk_turn_is_silent_because_it_read_hub():
    """b851aa91: the same block, the same timestamp — and her own machine_status
    call behind it. Silence here is the read, and removing the read fires."""
    assert guards.state_claim_check(B851AA91, [HUB_SERVED, HUB_READ], NAMES, purpose="chat") is None
    assert guards.state_claim_check(B851AA91, [HUB_SERVED], NAMES, purpose="chat") is not None


# -- beyond the verdict corpus: the other shapes its regexes name ---------------

MACHINE_MUST_FIRE_EXTRA = [
    # The `last_reading` prose form (verdict §3.1 A).
    ("prose_last_reported_at", "hub last reported at 05:15 UTC.", [HUB_SERVED]),
    ("prose_last_seen_iso", "hub is last seen 2026-09-19 05:15 UTC.", [HUB_SERVED]),
    # finditer, not search: a positive claim about one machine does not hide a
    # negative one about another in the same clause.
    ("second_subject_in_clause", "dell is ready and hub is offline.", [HUB_SERVED, DELL_READ]),
    # A parenthetical between the name and the copula.
    ("parenthetical", "hub (the bundled engine) is unreachable.", [HUB_SERVED]),
    ("contraction", "hub's not answering right now.", [HUB_SERVED]),
]

MACHINE_MUST_NOT_EXTRA = [
    (
        "prose_not_checked_since",
        "hub last reported at 05:15 UTC, and I have not checked since.",
        [HUB_SERVED],
    ),
    ("prose_prior_time", "Earlier, hub last reported at 05:15 UTC.", [HUB_SERVED]),
    ("model_id_is_not_a_subject", "hub:qwen3:8b is offline.", [HUB_SERVED]),
    ("prose_read_this_turn", "hub last reported at 05:15 UTC.", [HUB_SERVED, HUB_READ]),
]


@pytest.mark.parametrize(
    "label,reply,spans", MACHINE_MUST_FIRE_EXTRA, ids=[c[0] for c in MACHINE_MUST_FIRE_EXTRA]
)
def test_machine_must_fire_extra(label, reply, spans):
    claim = guards.state_claim_check(reply, spans, NAMES, purpose="chat")
    assert claim is not None, label
    assert (claim.subject_kind, claim.device) == ("machine", "hub")


@pytest.mark.parametrize(
    "label,reply,spans", MACHINE_MUST_NOT_EXTRA, ids=[c[0] for c in MACHINE_MUST_NOT_EXTRA]
)
def test_machine_must_not_fire_extra(label, reply, spans):
    assert guards.state_claim_check(reply, spans, NAMES, purpose="chat") is None, label


# -- the two branches are independent -------------------------------------------


def test_a_device_check_does_not_back_a_machine_claim():
    """`_checked_a_device` short-circuits the DEVICE branch only: a device_list
    this turn says nothing about hub."""
    spans = [HUB_SERVED, Span("device_list")]
    claim = guards.state_claim_check("hub is switched off.", spans, NAMES, purpose="chat")
    assert claim is not None and claim.subject_kind == "machine"


def test_a_machine_read_does_not_back_a_device_claim():
    claim = guards.state_claim_check(OWNER_CASE, [HUB_SERVED, HUB_READ], NAMES, purpose="chat")
    assert claim is not None
    assert claim.subject_kind == "device"
    assert claim.text == guards.STATE_CLAIM_CORRECTION


def test_machine_claims_fire_with_nothing_paired():
    """The early exit needs NEITHER device names NOR machine names now."""
    claim = guards.state_claim_check("hub is switched off.", [HUB_SERVED], [], purpose="chat")
    assert claim is not None and claim.device == "hub"


def test_the_device_branch_is_unchanged_by_purpose():
    for purpose in (None, "chat", "eval", "scheduled", "agent"):
        claim = guards.state_claim_check(OWNER_CASE, [], NAMES, purpose=purpose)
        assert claim is not None and claim.subject_kind == "device"
        assert claim.text == guards.STATE_CLAIM_CORRECTION


# -- machine_names: derived from the turn's own spans ---------------------------


def test_machine_names_are_derived_from_served_rounds_reads_and_configures():
    spans = [
        _llm("hub:qwen3:8b"),  # local
        _llm("dell:qwen3:8b", local=None, served_on="gpu:cuda:GPU-<uuid>"),
        _llm("spark:gemma4:12b", local=None, served_runtime="container"),
        _status(facts=[_fact("eval_box")]),
        _status(machine="named_arg"),
        _span("tool", "machine_configure", ok=True, args_redacted={"machine": "cfg_box"}),
    ]
    assert guards.machine_names(spans) == (
        "cfg_box",
        "dell",
        "eval_box",
        "hub",
        "named_arg",
        "spark",
    )


def test_machine_names_ignore_failed_spans_and_non_local_rounds():
    spans = [
        _llm("hub:qwen3:8b", error="the gateway reported: boom"),  # failed round
        _llm("openrouter:anthropic/claude-sonnet-4.6", local=False),  # a cloud round
        _llm("cloudy:model:tag", local=None),  # nothing says it ran on an engine
        _llm("x:qwen3:8b"),  # a one-character name
        _status(machine="ghost", ok=False, facts=[_fact("ghost")]),
        _span("tool", "machine_configure", ok=False, args_redacted={"machine": "ghost2"}),
        _span("tool", "fetch_url", ok=True, args_redacted={"machine": "not_a_machine_tool"}),
    ]
    assert guards.machine_names(spans) == ()


def test_every_derived_machine_is_read_or_served_so_no_positive_claim_fires():
    """The PROPERTY the verdict pins (§3.1 A): a name only ever comes from a
    read of it or a round it served, so a positive claim about a derived
    machine is always backed — in S40b the machine branch fires only on a
    negative state or an unread reading time. S44 (gateway-listed names) is
    the change that makes this go red, deliberately."""
    span_sets = [
        [HUB_SERVED],
        [HUB_READ],
        [CFG],
        [DELL_READ],
        [HUB_SERVED, DELL_READ],
        [_llm("dell:qwen3:8b", local=None, served_on="gpu:x")],
        [_status(machine="spark"), _llm("hub:qwen3:8b")],
    ]
    for spans in span_sets:
        names = guards.machine_names(spans)
        assert names, spans
        for name in names:
            # Served: a round the gateway says ran on it — the very record
            # machine_names derives the name from.
            served = name in {guards._engine_served_head(span) for span in spans}
            assert guards._machine_read(spans, name) or served, name
            for positive in (f"{name} is ready.", f"{name} is online.", f"{name} is answering."):
                assert guards.state_claim_check(positive, spans, [], purpose="chat") is None


# -- the constants and the texts --------------------------------------------------


def test_the_machine_tool_names_are_the_registry_names():
    """Derived, never retyped: a rename in the registry turns this red."""
    assert guards._MACHINE_READ_TOOLS == frozenset({machine_tools.MACHINE_STATUS.name})
    assert guards._CONFIGURE_TOOLS == frozenset({machine_tools.MACHINE_CONFIGURE.name})
    from app import tools

    assert machine_tools.MACHINE_STATUS.name in tools.REGISTRY
    assert machine_tools.MACHINE_CONFIGURE.name in tools.REGISTRY


def test_the_machine_texts_trip_no_guard_of_their_own():
    """The correction PERSISTS and the note streams, so a text that tripped a
    guard would be corrected forever; the nudge is what the model is told."""
    texts = [
        MACHINE_CORRECTION_HUB,
        MACHINE_CORRECTION_HUB + HUB_SERVED_CLAUSE,
        chat.MACHINE_REDIRECT_NOTE,
        chat.state_redirect_nudge(device="hub", ran_a_tool=False, kind="machine"),
    ]
    for text in texts:
        for purpose in ("chat", "eval"):
            assert guards.state_claim_check(text, [HUB_SERVED], NAMES, purpose=purpose) is None
            assert guards.stack_claim_check(text, [HUB_SERVED], purpose=purpose) is None
        assert guards.narration_check(text, []) is None
        assert guards.consent_claim_check(text) is None
        assert guards.capability_claim_check(text, ["machine_status", "device_list"]) is None
        assert guards.deferral_check(text, [], ["fetch_url", "web_search"]) is None
        assert guards.presented_listing_check(text, [], ["workspace_list_files"]) is None
        assert guards.bare_intent_check(text, []) is None
        assert guards.observation_check(text, [], []) is None
        assert guards.delivery_claim_check(text, []) is None


def test_the_machine_nudge_names_the_registry_tool_and_refuses_a_false_premise():
    nudge = chat.state_redirect_nudge(device="hub", ran_a_tool=False, kind="machine")
    assert nudge == (
        f"You have not checked hub this turn. Check it now with "
        f"{machine_tools.MACHINE_STATUS.name} before describing it, or say plainly "
        "that you did not check."
    )
    with pytest.raises(ValueError):
        chat.state_redirect_nudge(device="hub", ran_a_tool=True, kind="machine")
    # The device nudge is what it was.
    assert "device tool" in chat.state_redirect_nudge(device=DEVICE, ran_a_tool=False)


# ============================================================================
# S40b T1 review, fix round 1: four ways an honest reply was corrected
# ============================================================================
#
# Each list below is a class of honest sentence the verbatim patterns REPLACED
# (a false positive makes the guard the liar), found by the T1 review. The
# verdict corpus above stays exactly as it is: every fix here only removes
# fires, and the sentences that must still fire are pinned beside them.

# -- 1. "this reply came from …" names the round that WROTE the reply ------------
#
# The served clause is a statement of fact about this reply, so it may only
# quote the turn's last error-free round of its own purpose — the one that
# wrote the text — and only when that round ran on the machine the claim is
# about. Any other served round (an earlier one, a judge's, another machine's)
# does not make the clause true; the correction then says only "unchecked".

DELL_SERVED = _llm("dell:qwen3:8b")


def test_the_served_clause_is_omitted_when_another_machine_wrote_the_reply():
    """hub served an earlier round; dell served the round that wrote the reply.
    "this reply came from hub:qwen3:8b" would be false."""
    spans = [HUB_SERVED, DELL_SERVED]
    claim = guards.state_claim_check("hub is switched off.", spans, NAMES, purpose="chat")
    assert claim is not None and claim.device == "hub"
    assert claim.text == MACHINE_CORRECTION_HUB
    assert claim.served_by is None
    assert claim.evidence == "unchecked"


def test_the_served_clause_is_omitted_when_the_machine_served_only_another_purpose():
    """The reply was written in the cloud; hub served only a judge's round. A
    judge round is the backend's second opinion, never the reply."""
    spans = [
        _llm("openrouter:anthropic/claude-sonnet-4.6", local=False),
        _llm("hub:qwen3:8b", purpose="judge"),
    ]
    claim = guards.state_claim_check("hub is switched off.", spans, NAMES, purpose="chat")
    assert claim is not None and claim.device == "hub"
    assert claim.text == MACHINE_CORRECTION_HUB
    assert claim.served_by is None
    assert claim.evidence == "unchecked"


def test_the_served_clause_quotes_the_round_that_wrote_the_reply():
    """Two rounds on hub: the clause quotes the LAST, the one whose text this is."""
    spans = [HUB_SERVED, _llm("hub:gemma4:12b")]
    claim = guards.state_claim_check("hub is switched off.", spans, NAMES, purpose="chat")
    assert claim is not None
    assert claim.served_by == "hub:gemma4:12b"
    assert claim.text == (
        MACHINE_CORRECTION_HUB + " hub answered this turn: this reply came from hub:gemma4:12b."
    )


def test_a_later_round_of_another_purpose_does_not_displace_the_writer():
    """A judge round after the reply is not the round that wrote it; a failed
    own round wrote nothing."""
    spans = [
        HUB_SERVED,
        _llm("dell:qwen3:8b", purpose="judge"),
        _llm("dell:qwen3:8b", error="the gateway reported: boom"),
    ]
    claim = guards.state_claim_check("hub is switched off.", spans, NAMES, purpose="chat")
    assert claim is not None
    assert claim.served_by == "hub:qwen3:8b"
    assert claim.text == MACHINE_CORRECTION_HUB + HUB_SERVED_CLAUSE


# -- 2. she says plainly that she did not check ---------------------------------
#
# The machine nudge offers exactly this ("…or say plainly that you did not
# check"), so a correction here also refused the regeneration that followed
# the nudge. A reading's not-current cut reads its WHOLE run down to the
# reading line, the heading that opens the run and the lead-in above it; the
# copula form reads the cut over its whole sentence; and a double-quoted span
# is someone else's words, never her claim.

# The Name/Last Reported pair without a heading, so an intro can sit in its run.
NAME_RUN = "- **Name**: `hub`\n- **Last Reported**: `2026-09-19T05:15:39+00:00`"

SAID_NOT_CHECKED = [
    (
        "intro_in_the_same_run",
        f"I did not check hub this turn. The last reading I have:\n{NAME_RUN}",
    ),
    (
        "intro_line_without_a_colon",
        f"Not checked this turn; this is from history.\n{NAME_RUN}",
    ),
    ("disclaimer_in_the_heading", f"### Machine Status (not checked this turn)\n{NAME_RUN}"),
    (
        "disclaimer_in_the_heading_above_a_blank",
        f"### Machine Status (not checked this turn)\n\n{NAME_RUN}",
    ),
    (
        "quoted_last_line",
        'I did not check hub this turn; the last line I have is "hub is switched off."',
    ),
    (
        "curly_quoted_with_disclaimer",
        "My last reading of hub said “hub is switched off.” I have not checked it this turn.",
    ),
    ("not_checked_after_but", "hub is switched off, but I have not checked it this turn."),
    (
        "not_current_after_semicolon",
        "hub is offline; that is not a current reading, since I did not check it.",
    ),
]

QUOTED_NOT_HERS = [
    ("curly_quoted_note", "Your note reads “hub is offline, so use the cloud.”"),
    ("straight_quoted_note", 'The note you saved reads "hub is switched off for models."'),
]


@pytest.mark.parametrize(
    "label,reply",
    SAID_NOT_CHECKED + QUOTED_NOT_HERS,
    ids=[c[0] for c in SAID_NOT_CHECKED] + [c[0] for c in QUOTED_NOT_HERS],
)
def test_saying_plainly_she_did_not_check_is_not_corrected(label, reply):
    assert guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat") is None, label


def test_the_nudges_own_alternative_passes_its_own_vetting():
    """The sentence the machine nudge asks for, written the way she writes a
    status block, passes the state check the regeneration is vetted by."""
    regen = f"I did not check hub this turn. The last reading I have is from history:\n{NAME_RUN}"
    assert guards.state_claim_check(regen, [HUB_SERVED], NAMES, purpose="chat") is None
    # …and the same block without the sentence is still the replay.
    assert guards.state_claim_check(NAME_RUN, [HUB_SERVED], NAMES, purpose="chat") is not None


# Quote marks as formatting of her OWN key/value reading are not a quotation:
# a reading line that begins with a quote never matches, so only the clause
# scan blanks quoted spans.
QUOTED_VALUES_STILL_FIRE = [
    ("quoted_values", '- Name: "hub"\n- Last Reported: "2026-09-19T05:15:39+00:00"'),
]

# The sentence-scope not-current cut costs this miss: "could not be reached"
# reads as a disclaimer. Pinned so it is a choice (reviewed with the fix).
SAID_NOT_CHECKED_ACCEPTED_MISSES = [
    ("could_not_be_reached", "hub is offline, so the model could not be reached."),
]


@pytest.mark.parametrize(
    "label,reply", QUOTED_VALUES_STILL_FIRE, ids=[c[0] for c in QUOTED_VALUES_STILL_FIRE]
)
def test_quoted_key_value_readings_still_fire(label, reply):
    claim = guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat")
    assert claim is not None and claim.device == "hub", label


@pytest.mark.parametrize(
    "label,reply",
    SAID_NOT_CHECKED_ACCEPTED_MISSES,
    ids=[c[0] for c in SAID_NOT_CHECKED_ACCEPTED_MISSES],
)
def test_the_not_current_cut_accepted_misses_stay_missed(label, reply):
    assert guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat") is None, label


# -- 3. a state limited to a place, a schedule or a count is not an outage -------
#
# Every machine state word now carries an anchor, including the negative ones
# and the positive link words that "not"/"no longer" turn negative. So
# "offline" counts only where the sentence ends it or says "right now",
# "again" or "for chat models". It never counts in "unreachable from your
# phone" or "offline twice a week". Since fix round 2 the outage words take
# _OUTAGE_ANCHOR, which is the verdict's anchor plus clause connectors and
# present-time phrases (see the round 2 section below).

LIMITED_STATES = [
    (
        "place_unreachable_from",
        "hub is unreachable from your phone, since it is only on the tailnet.",
    ),
    ("place_not_reachable_from", "hub is not reachable from outside the tailnet."),
    (
        "place_disconnected_from",
        "hub is disconnected from the internet, but it still serves models locally.",
    ),
    ("schedule_switched_off_overnight", "hub is switched off overnight to save power."),
    ("count_offline_twice_a_week", "hub is offline twice a week for updates."),
    ("schedule_not_online_on_weekends", "hub is not online on weekends."),
    ("offline_capable", "hub is offline-capable."),
]

ANCHORED_STILL_FIRE = [
    ("offline_right_now", "hub is offline right now."),
    ("unreachable_again", "hub is unreachable again."),
    ("switched_off_comma", "hub is switched off, so routing skips it."),
    ("not_online_right_now", "hub is not online right now."),
]


@pytest.mark.parametrize("label,reply", LIMITED_STATES, ids=[c[0] for c in LIMITED_STATES])
def test_a_limited_state_is_not_read_as_a_present_outage(label, reply):
    assert guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat") is None, label


@pytest.mark.parametrize(
    "label,reply", ANCHORED_STILL_FIRE, ids=[c[0] for c in ANCHORED_STILL_FIRE]
)
def test_an_anchored_present_outage_still_fires(label, reply):
    claim = guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat")
    assert claim is not None and claim.device == "hub", label
    assert claim.text == MACHINE_CORRECTION_HUB + HUB_SERVED_CLAUSE


# -- 4. a device's own status line is not hub's ------------------------------------
#
# The upward walk stops, unbound, at a line that states a connectivity state
# and names no machine: that line is some other thing's status (here a device
# the reply does not call by its paired name), and the reading under it is
# that thing's. Each turn ran device_list, so the device branch is backed and
# only a wrong binding could fire.

DEVICE_CHECKED = [HUB_SERVED, Span("device_list")]

DEVICE_STATUS_LINES = [
    ("dell_offline", "Models run on hub.\n- Dell: offline\n- Last seen: 2026-09-18 16:48 UTC"),
    ("dell_is_online", "hub runs models.\nThe Dell is online.\n- Last checked: just now"),
    (
        "laptop_powered_on",
        "The models run on hub.\n- Laptop: powered on\n- Last reported: 05:15 UTC",
    ),
    (
        "desktop_connected",
        "hub serves the models.\n- Your desktop is connected\n- Last contact: 2026-09-18 16:48 UTC",
    ),
]


@pytest.mark.parametrize(
    "label,reply", DEVICE_STATUS_LINES, ids=[c[0] for c in DEVICE_STATUS_LINES]
)
def test_a_reading_under_a_device_status_line_does_not_bind_to_the_machine(label, reply):
    assert guards.state_claim_check(reply, DEVICE_CHECKED, NAMES, purpose="chat") is None, label


def test_a_status_line_that_names_the_machine_still_binds():
    """The stop is for a line that names NO machine: "hub: online" is hub's."""
    claim = guards.state_claim_check(
        "- hub: online\n- Last checked: just now", DEVICE_CHECKED, NAMES, purpose="chat"
    )
    assert claim is not None and claim.device == "hub"
    assert claim.phrase == "- Last checked: just now"


# ================================================================================
# T1 review, fix round 2
# ================================================================================
#
# Two fixes from round 1 went further than their findings did, and each one
# silenced a present claim that it should have kept.

# -- 1. hub's OWN status line does not unbind its reading --------------------------
#
# Round 1 ended the upward walk at any line that states a connectivity and names
# no machine, so that the reading under "- Dell: offline" is not read as hub's.
# Within b02a5694's own block, a "- Status: Offline" line between `Name: hub` and
# `Last Reported` also names no machine. It states the block's OWN attribute,
# and the replay under it went silent. That includes machine_status's own
# wording, "switched off for models" (tools/machines.py).
#
# Now a line whose key is a generic attribute (status, state, connection,
# reachable, power, …) and whose value begins with a state lets the walk go on.
# So does a keyless line that is only a state. Past such a line, the walk
# crosses only the block's key/value lines up to the line that heads the block.
# A label or sentence that names no machine ("- Dell") leaves the reading
# unbound.

HUB_BLOCK_HEAD = (
    "The models run on a machine called **`hub`**, and its current status is:  \n"
    "\n"
    "### 🏗️ **Machine Status**  \n"
    "- **Name**: `hub`  \n"
)
HUB_BLOCK_READING = "- **Last Reported**: `2026-09-19T05:15:39+00:00`  "
WALK_PHRASE = "- Last Reported: 2026-09-19T05:15:39+00:00"

OWN_STATUS_LINES = [
    ("status_switched_off_for_models", "- **Status**: Switched off for models"),
    ("status_green_online", "- **Status**: 🟢 Online"),
    ("status_offline", "- **Status**: Offline"),
    ("connection_connected", "- **Connection**: Connected"),
    ("reachable_yes", "- **Reachable**: Yes"),
    ("power_powered_on", "- **Power**: Powered on"),
    ("status_answering", "- **Status**: Answering"),
    ("state_not_reachable", "- **State**: not reachable"),
    ("connection_status_em_dash", "- **Connection status** — Disconnected"),
    ("bare_state_line", "- 🟢 Online"),
]


@pytest.mark.parametrize(
    "label,status_line", OWN_STATUS_LINES, ids=[c[0] for c in OWN_STATUS_LINES]
)
def test_hubs_own_status_line_keeps_the_replay_bound(label, status_line):
    reply = f"{HUB_BLOCK_HEAD}{status_line}  \n{HUB_BLOCK_READING}"
    claim = guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat")
    assert claim is not None, label
    assert (claim.subject_kind, claim.device) == ("machine", "hub")
    assert claim.phrase == WALK_PHRASE
    assert claim.text == MACHINE_CORRECTION_HUB


def test_the_walk_replay_with_a_status_line_is_still_corrected():
    """b02a5694 verbatim, with a Status line under `Name: hub`: the walk goes up
    past the Status, Serving, Compute and Runtime lines to `Name: hub`."""
    name_line = "- **Name**: `hub`  \n"
    reply = B02A5694.replace(name_line, name_line + "- **Status**: Switched off for models  \n")
    assert reply != B02A5694
    claim = guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat")
    assert claim is not None
    assert claim.phrase == WALK_PHRASE


# A status line that is some other thing's still ends the walk unbound. Each of
# these fired at b3d4f73b and was silent at 8cc0d4ae. Each turn ran device_list,
# so only a wrong binding could fire.
OTHER_SUBJECTS_STATUS = [
    (
        "label_heads_the_status_line",
        "Models run on hub.\n- Dell\n- Status: offline\n- Last seen: 2026-09-18 16:48 UTC",
    ),
    (
        "status_value_names_another_subject",
        "Models run on hub.\n- Status: the Dell is offline\n- Last seen: 2026-09-18 16:48 UTC",
    ),
    (
        "state_word_heads_a_list",
        "Models run on hub.\n- Offline devices: Dell\n- Last seen: 2026-09-18 16:48 UTC",
    ),
    (
        "subject_em_dash_state",
        "Models run on hub.\n- Dell — offline\n- Last seen: 2026-09-18 16:48 UTC",
    ),
]


@pytest.mark.parametrize(
    "label,reply", OTHER_SUBJECTS_STATUS, ids=[c[0] for c in OTHER_SUBJECTS_STATUS]
)
def test_another_subjects_status_line_still_unbinds_the_reading(label, reply):
    assert guards.state_claim_check(reply, DEVICE_CHECKED, NAMES, purpose="chat") is None, label


# This is the cost of the heads-the-block rule. Past a status line, the walk
# crosses only key/value lines. A keyless line such as "- Always on" reads the
# same as the "- Dell" label, so hub's reading under it goes unbound. It was
# silent at 8cc0d4ae too.
OWN_STATUS_ACCEPTED_MISSES = [
    (
        "keyless_attribute_above_the_status",
        f"{HUB_BLOCK_HEAD}- Always on\n- **Status**: Offline\n{HUB_BLOCK_READING}",
    ),
]


@pytest.mark.parametrize(
    "label,reply", OWN_STATUS_ACCEPTED_MISSES, ids=[c[0] for c in OWN_STATUS_ACCEPTED_MISSES]
)
def test_the_own_status_accepted_misses_stay_missed(label, reply):
    assert guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat") is None, label


# -- 2. a clause connector or a present-time phrase ends an outage claim ----------
#
# Round 1 anchored every state word so that a place, a schedule or a count after
# it limits the claim. The verdict's anchor, however, lists only punctuation,
# "right now"/"now"/"again"/"at the moment", "and" and "for chat models". So a
# present outage followed by "so", "because", "which", "since", "for now", "at
# present" or "today" went silent. None of those words limits the state; each
# one ends the claim.
#
# The outage words (the negative ones, and the link words that "not" or
# "no longer" turns into an outage) now also end at a clause connector or a
# present-time phrase. "answering", "ready" and "serving" keep exactly the
# verdict's anchor, and the corpus measured them with it.

PRESENT_OUTAGES = [
    ("so_no_comma", "hub is offline so I can't run local models right now."),
    ("for_now", "hub is switched off for now, so I used the cloud."),
    ("at_present", "hub is unreachable at present."),
    ("since_a_time", "hub is offline since 05:15 UTC."),
    ("because", "hub is offline because its GPU is busy."),
    ("which", "hub is unreachable which is why chat is slow."),
    ("today", "hub is offline today."),
    ("currently_after", "hub is disconnected currently."),
    ("negated_link_so", "hub is not online so I used the cloud."),
    ("negated_link_because", "hub is not reachable because the tailnet is down."),
]


@pytest.mark.parametrize("label,reply", PRESENT_OUTAGES, ids=[c[0] for c in PRESENT_OUTAGES])
def test_a_present_outage_ended_by_a_connector_or_a_time_fires(label, reply):
    claim = guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat")
    assert claim is not None and claim.device == "hub", label
    assert claim.text == MACHINE_CORRECTION_HUB + HUB_SERVED_CLAUSE


# The new anchor words stop where the words after them limit the state again.
CONNECTOR_LIMITED = [
    # "so" as a degree word is a frequency, not a connector.
    ("so_often", "hub is offline so often that I stopped relying on it."),
    ("so_rarely", "hub is switched off so rarely that nobody notices."),
    # "today" counts only where it ends the claim, not in a schedule for later.
    ("today_at_a_time", "hub is switched off today at 18:00 for updates."),
    ("today_from_a_time", "hub is offline today from 18:00 to 20:00."),
    # "as" is left out: "as a chat machine" is a role, and "as of <time>" is a
    # stamp.
    ("as_a_role", "hub is switched off as a chat machine on weekends."),
    # "ready" keeps the verdict's anchor: "not ready" is readiness for something.
    ("ready_keeps_its_anchor", "hub is not ready since you have not added a model."),
]


@pytest.mark.parametrize("label,reply", CONNECTOR_LIMITED, ids=[c[0] for c in CONNECTOR_LIMITED])
def test_a_connector_word_that_limits_the_state_does_not_fire(label, reply):
    assert guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat") is None, label


def test_the_verdicts_anchor_is_kept_verbatim_inside_the_outage_anchor():
    """The verdict's _MACHINE_ANCHOR is unchanged, and the outage anchor only
    adds to it."""
    assert guards._MACHINE_ANCHOR == (
        r"(?=\s*(?:[.,;:!?)\]}—–]|$)|\s+(?:right\s+now|now|again|at\s+the\s+moment|and\b"
        r"|for\s+(?:chat\s+)?(?:models|chat|requests)\b))"
    )
    assert guards._OUTAGE_ANCHOR.startswith(guards._MACHINE_ANCHOR[:-1] + "|")


# ================================================================================
# S40b T4 review, fix round 1: a reading she labels as her history
# ================================================================================
#
# The v15 case seeds b851aa91's reading as her own history, and the answer the
# machine nudge asks for says plainly that she did not check. Each block below
# FIRED at f81d0a1b with only hub's served round (the reviewer's probes,
# verbatim): a REPLACE-class correction of a reply that already said the
# reading was history. The not-current cut read the run above the reading line,
# its heading and its lead-in, but never a history label, and never a
# disclaimer written after the block. It now reads:
#   * a history label: "from history", "from my previous answer", "My previous
#     answer:", "In the previous turn:";
#   * the rest of the run below the reading line, and the first non-blank line
#     after the run (unless that line is a heading or a lead-in ending in ":",
#     which belong to what follows).

HISTORY_LABELLED = [
    (
        "same_line_from_my_previous_answer",
        f"{NAME_RUN} (from my previous answer)",
    ),
    ("same_line_from_history", f"{NAME_RUN} (from history)"),
    (
        "heading_from_my_previous_answer",
        f"### Machine Status (from my previous answer)\n{NAME_RUN}",
    ),
    ("lead_in_from_history", f"The last reading I have is from history:\n{NAME_RUN}"),
    ("lead_in_my_previous_answer", f"My previous answer:\n{NAME_RUN}"),
    ("lead_in_from_my_previous_answer", f"From my previous answer:\n{NAME_RUN}"),
    ("lead_in_in_the_previous_turn", f"In the previous turn:\n{NAME_RUN}"),
    (
        "lead_in_then_trailing_disclaimer",
        f"From my previous answer:\n{NAME_RUN}\nI have not checked it this turn.",
    ),
]

# A disclaimer written after the block, with no label above it.
TRAILING_DISCLAIMERS = [
    ("disclaimer_in_the_run", f"{NAME_RUN}\nI have not checked it this turn."),
    ("disclaimer_after_a_blank", f"{NAME_RUN}\n\nI have not checked it this turn."),
    ("disclaimer_after_the_heading_block", f"{NAME_BLOCK}\n\nThat reading may have changed."),
    (
        "disclaimer_on_a_line_below_the_reading",
        f"{NAME_BLOCK}\n- **Serving**: On (not checked this turn)",
    ),
]

# The same copula a history label frames, in her own sentence.
HISTORY_LABELLED_COPULA = [
    ("copula_after_a_history_lead_in", "From my previous answer: hub is switched off."),
    ("copula_after_from_history", "From history: hub is offline."),
]


@pytest.mark.parametrize(
    "label,reply",
    HISTORY_LABELLED + TRAILING_DISCLAIMERS + HISTORY_LABELLED_COPULA,
    ids=[c[0] for c in HISTORY_LABELLED + TRAILING_DISCLAIMERS + HISTORY_LABELLED_COPULA],
)
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_reading_labelled_as_history_is_not_corrected(purpose, label, reply):
    spans = [_llm("hub:qwen3:8b", purpose=purpose)]
    assert guards.state_claim_check(reply, spans, NAMES, purpose=purpose) is None, label


# What must keep firing. The bare block (the replay, b02a5694's own shape) and
# b02a5694 itself are pinned above; these are the new context's limits: a
# heading or a lead-in after the run opens the NEXT section, so its words are
# not about hub's reading; a clause that says hub is offline after a history
# clause is its own claim; and a response FROM hub is not her earlier reply.
HISTORY_CONTEXT_STILL_FIRES = [
    (
        "next_heading_is_another_section",
        f"{NAME_BLOCK}\n\n### Devices (not checked this turn)\n- Dell: offline",
    ),
    (
        "next_lead_in_is_another_block",
        f"{NAME_BLOCK}\n\nThe Dell, which I have not checked this turn:\n- Status: offline",
    ),
    (
        "copula_after_a_history_clause",
        "My previous answer said hub was ready; hub is offline.",
    ),
    ("a_response_from_hub", f"The last response from hub:\n{NAME_RUN}"),
    ("block_then_an_unrelated_line", f"{NAME_BLOCK}\n\nWant me to pull another model?"),
]


@pytest.mark.parametrize(
    "label,reply",
    HISTORY_CONTEXT_STILL_FIRES,
    ids=[c[0] for c in HISTORY_CONTEXT_STILL_FIRES],
)
def test_a_reading_the_new_context_does_not_frame_still_fires(label, reply):
    claim = guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat")
    assert claim is not None, label
    assert (claim.subject_kind, claim.device) == ("machine", "hub")


def test_the_bare_replay_still_fires_beside_the_labelled_ones():
    """The pins the not-current cut must never reach: the bare block and the
    walk's replay, word for word."""
    for reply in (NAME_BLOCK, NAME_RUN, B02A5694):
        claim = guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat")
        assert claim is not None and claim.device == "hub"


# The cost of reading the line after the run, pinned so it is a choice: a
# sentence there that says something else is not current reads as the
# reading's disclaimer.
TRAILING_LINE_ACCEPTED_MISSES = [
    ("another_subjects_disclaimer", f"{NAME_BLOCK}\n\nThe Dell was not checked this turn."),
]


@pytest.mark.parametrize(
    "label,reply",
    TRAILING_LINE_ACCEPTED_MISSES,
    ids=[c[0] for c in TRAILING_LINE_ACCEPTED_MISSES],
)
def test_the_trailing_line_accepted_misses_stay_missed(label, reply):
    assert guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat") is None, label


def test_a_regeneration_that_labels_the_reading_as_history_is_not_refused():
    """The nudge's alternative passed only because it opened with "I did not
    check". Without that opener, the history label alone was refused when the
    regeneration was vetted, and the persisted row became the correction."""
    from app import agents

    regen = f"The last reading I have is from history:\n{NAME_RUN}"
    turn = SimpleNamespace(spans=[HUB_SERVED], kind="chat")
    rejected = chat._regen_rejected_by(
        regen,
        turn,
        None,
        NAMES,
        "Where do your models run, and is that machine ready?",
        agents.nova_persona(),
        agent_names=[],
    )
    assert rejected is None
    # …and the bare block is still refused by the state check.
    rejected = chat._regen_rejected_by(
        NAME_RUN,
        turn,
        None,
        NAMES,
        "Where do your models run, and is that machine ready?",
        agents.nova_persona(),
        agent_names=[],
    )
    assert rejected == "state_claim"


# ================================================================================
# S40b T4 review, fix round 2: a mention of her earlier reply is not a label
# ================================================================================
#
# Fix round 1's history cut read only whether a phrase naming her earlier reply
# was PRESENT — on the reading's lead-in, heading, run and trailing line, and
# anywhere in a copula's clause. So a replay that says it is CURRENT while
# citing her history went silent: the replay-as-current the v15 case and this
# branch exist for. Each block below FIRED at f81d0a1b and was SILENT at
# c9538364 with only hub's served round (the reviewer's probes, verbatim
# first). "Unchanged from my last reply" asserts the current state without a
# read; it does not label the reading as history. In chat each was a missed
# REPLACE-class correction of a replay.
#
# The cut now reads a LABEL (guards._history_framed / _labelled_as_history):
#   * her earlier reply reported: "my previous answer said/showed X";
#   * an attribution: "from history", "(from my previous answer)", "the
#     reading I gave in my last reply";
#   * a heading at the start of its line or clause: "My previous answer:",
#     "In the previous turn:", "According to my last reply,";
# never after "as"/"like"/"unlike"/"same as" or "unchanged"/"different"/
# "updated", never past a retraction, and never when what follows reaffirms
# the claim ("…, and that is still true").
STATE_REPLAYED_AS_CURRENT = [
    (
        "current_status_unchanged_from_my_last_reply",
        f"Here is hub's current status (unchanged from my last reply):\n{NAME_RUN}",
    ),
    (
        "current_status_same_as_in_my_previous_answer",
        f"Hub's current status, same as in my previous answer:\n{NAME_RUN}",
    ),
    (
        "unlike_my_previous_answer_current_status",
        f"Unlike my previous answer, here is hub's current status:\n{NAME_RUN}",
    ),
    ("correction_to_my_last_reply", "Correction to my last reply: hub is offline."),
    ("as_in_my_last_reply", "As in my last reply, hub is offline."),
    ("same_as_in_my_last_reply_after", "hub is offline, same as in my last reply."),
    ("since_the_last_turn", "Since the last turn, hub has been offline."),
    # The same limits, spelled the other ways.
    ("as_i_said_in_my_last_reply", "As I said in my last reply, hub is offline."),
    ("previous_answer_still_holds", "My previous answer still holds — hub is offline."),
    ("per_my_last_reply", "Per my last reply, hub is offline."),
    # "said hub" is never read (the verdict's lead-word rule); "said: hub" is.
    (
        "previous_answer_said_and_still_true",
        "My previous answer said: hub is offline, and that is still true.",
    ),
    (
        "previous_answer_showed_and_still_true",
        f"My previous answer showed:\n{NAME_RUN}\nThat is still true.",
    ),
    (
        "from_my_previous_answer_and_still_true",
        "From my previous answer: hub is switched off, and that is still true.",
    ),
    ("unchanged_from_my_last_reply_after", "hub is offline, unchanged from my last reply."),
    ("in_my_last_reply_i_was_wrong", "In my last reply I was wrong: hub is offline."),
    (
        "a_retracted_report_then_the_current_status",
        f"My previous answer said hub was ready, which was wrong. Here is hub's current "
        f"status:\n{NAME_RUN}",
    ),
    (
        "the_reading_from_my_last_reply_is_still_current",
        f"The reading from my last reply is still current:\n{NAME_RUN}",
    ),
    ("nothing_changed_from_my_last_reply", "Nothing changed from my last reply: hub is offline."),
    ("like_my_previous_answer_said", "Like my previous answer said: hub is offline."),
    ("which_i_reported_in_my_last_reply", "hub is offline, which I reported in my last reply."),
    # …and the same sources, corrected, updated or repeated: a claim anew.
    (
        "correction_to_my_last_replys_reading",
        "Correction to my last reply's reading: hub is offline.",
    ),
    ("update_on_my_last_replys_status", f"Update on my last reply's status:\n{NAME_RUN}"),
    ("repeating_my_last_reply", "Repeating my last reply: hub is offline."),
    (
        "summary_of_my_previous_answer_still_current",
        f"Summary of my previous answer, still current:\n{NAME_RUN}",
    ),
]


@pytest.mark.parametrize(
    "label,reply",
    STATE_REPLAYED_AS_CURRENT,
    ids=[c[0] for c in STATE_REPLAYED_AS_CURRENT],
)
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_replay_that_only_cites_her_earlier_reply_still_fires(purpose, label, reply):
    spans = [_llm("hub:qwen3:8b", purpose=purpose)]
    claim = guards.state_claim_check(reply, spans, NAMES, purpose=purpose)
    assert claim is not None, label
    assert (claim.subject_kind, claim.device) == ("machine", "hub")


# Her earlier reply, labelled as such. Each carries the same claim without its
# label, which fires, so the pin cannot pass on a claim the guard never read.
STATE_LABELLED_AS_HISTORY = [
    (
        "plain_report_of_her_previous_answer",
        "My previous answer said: hub is offline.",
        "hub is offline.",
    ),
    (
        "according_to_my_last_reply",
        "According to my last reply, hub is offline.",
        "hub is offline.",
    ),
    (
        "attribution_after_the_claim",
        "hub is switched off, from my previous answer.",
        "hub is switched off.",
    ),
    (
        "attribution_after_a_prose_reading",
        "hub last reported at 05:15 UTC (from my previous answer).",
        "hub last reported at 05:15 UTC.",
    ),
    (
        "the_reading_i_gave_in_my_last_reply",
        f"This is the reading I gave in my last reply:\n{NAME_RUN}",
        NAME_RUN,
    ),
    (
        "copied_from_my_previous_answer_after_the_block",
        f"{NAME_RUN}\n\nThat block is copied from my previous answer.",
        NAME_RUN,
    ),
    (
        "my_previous_answer_showed",
        f"My previous answer showed:\n{NAME_RUN}",
        NAME_RUN,
    ),
    (
        "what_i_reported_in_my_previous_answer",
        f"Here is what I reported in my previous answer:\n{NAME_RUN}",
        NAME_RUN,
    ),
    ("as_of_my_last_reply", "As of my last reply, hub is offline.", "hub is offline."),
    ("as_of_my_last_reply_lead_in", f"As of my last reply:\n{NAME_RUN}", NAME_RUN),
    # A label with a staleness disclaimer after it: old, as the label says —
    # not a retraction that closes it (only "wrong"-class words do).
    (
        "label_then_it_isnt_current",
        f"From my previous answer (it isn't current):\n{NAME_RUN}",
        NAME_RUN,
    ),
    (
        "label_then_it_isnt_current_copula",
        "From my previous answer (it isn't current): hub is offline.",
        "hub is offline.",
    ),
    (
        "attribution_which_is_outdated",
        f"{NAME_RUN} (from my previous answer, which is outdated)",
        NAME_RUN,
    ),
    ("from_history_which_is_outdated", f"From history, which is outdated:\n{NAME_RUN}", NAME_RUN),
    # The other ways she names her earlier reply as the source: a recap or
    # copy OF it, its possessive, a source lead at the start.
    ("recap_of_my_last_reply", f"Recap of my last reply:\n{NAME_RUN}", NAME_RUN),
    (
        "summary_of_my_previous_answer",
        "Summary of my previous answer: hub is offline.",
        "hub is offline.",
    ),
    ("my_last_replys_status_block", f"My last reply's status block:\n{NAME_RUN}", NAME_RUN),
    (
        "based_on_my_previous_response",
        "Based on my previous response, hub is offline.",
        "hub is offline.",
    ),
    ("going_by_my_last_reply", "Going by my last reply, hub is offline.", "hub is offline."),
    ("quoting_my_last_reply", f"Quoting my last reply:\n{NAME_RUN}", NAME_RUN),
]


@pytest.mark.parametrize(
    "label,reply,bare",
    STATE_LABELLED_AS_HISTORY,
    ids=[c[0] for c in STATE_LABELLED_AS_HISTORY],
)
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_claim_labelled_as_her_history_is_not_corrected(purpose, label, reply, bare):
    spans = [_llm("hub:qwen3:8b", purpose=purpose)]
    assert guards.state_claim_check(reply, spans, NAMES, purpose=purpose) is None, label
    claim = guards.state_claim_check(bare, spans, NAMES, purpose=purpose)
    assert claim is not None and claim.device == "hub", label


# The cost of letting only a "wrong"-class retraction close a label (a
# staleness word says the labelled reading is old, which is the label's
# point), pinned so it is a choice: a report called outdated, then the same
# reading presented as current in the next sentence, reads as labelled.
STALE_THEN_CURRENT_ACCEPTED_MISSES = [
    (
        "outdated_then_current_status",
        f"My previous answer said hub was ready, which is outdated. Here is hub's current "
        f"status:\n{NAME_RUN}",
    ),
]


@pytest.mark.parametrize(
    "label,reply",
    STALE_THEN_CURRENT_ACCEPTED_MISSES,
    ids=[c[0] for c in STALE_THEN_CURRENT_ACCEPTED_MISSES],
)
def test_the_stale_then_current_accepted_misses_stay_missed(label, reply):
    assert guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat") is None, label
    # …and the same report called wrong fires (STATE_REPLAYED_AS_CURRENT).
    wrong = reply.replace("which is outdated", "which was wrong")
    assert guards.state_claim_check(wrong, [HUB_SERVED], NAMES, purpose="chat") is not None


# The cost of reading a heading label over its whole clause, pinned so it is
# a choice: a second claim joined by "and" (not "but", which splits the
# clause) reads as part of what her last reply said.
HISTORY_HEAD_ACCEPTED_MISSES = [
    ("and_joined_second_claim", "In my last reply hub was ready, and hub is offline now."),
]


@pytest.mark.parametrize(
    "label,reply",
    HISTORY_HEAD_ACCEPTED_MISSES,
    ids=[c[0] for c in HISTORY_HEAD_ACCEPTED_MISSES],
)
def test_the_history_head_accepted_misses_stay_missed(label, reply):
    assert guards.state_claim_check(reply, [HUB_SERVED], NAMES, purpose="chat") is None, label
    # …and the same sentence split by "but" fires.
    split = reply.replace(", and ", ", but ")
    assert guards.state_claim_check(split, [HUB_SERVED], NAMES, purpose="chat") is not None


@pytest.mark.parametrize(
    "regen",
    [
        "Correction to my last reply: hub is offline.",
        f"Here is hub's current status (unchanged from my last reply):\n{NAME_RUN}",
    ],
)
def test_a_regeneration_that_replays_as_current_while_citing_history_is_refused(regen):
    """The regeneration the nudge asks for is vetted by the same state check:
    citing her last reply to restate the reading as current is refused by
    name, as the bare block is."""
    from app import agents

    turn = SimpleNamespace(spans=[HUB_SERVED], kind="chat")
    rejected = chat._regen_rejected_by(
        regen,
        turn,
        None,
        NAMES,
        "Where do your models run, and is that machine ready?",
        agents.nova_persona(),
        agent_names=[],
    )
    assert rejected == "state_claim"


# ================================================================================
# S40b T4 review, fix round 3: a doubt is not a reaffirmation, a heading is not
# a lead
# ================================================================================
#
# Fix round 2 made a claim after a history label fire again when she
# reaffirms it ("…, and that is still true") or when a word that restates or
# corrects leads INTO the label ("Correction to my last reply:"). Two of those
# limits read too much. Each MUST_NOT below FIRED at fa23ec1f and was SILENT
# at c9538364 with only hub's served round (the reviewer's probes verbatim
# first); in chat each was a REPLACE-class correction of the honest answer,
# and a regeneration that wrote it was refused.
#   * A DOUBT read as a reaffirmation: "I can't tell you whether that is still
#     accurate", "(not sure it still holds)". A reaffirmation or a "still
#     holds" is hers only when nothing in its clause ahead of it doubts it (a
#     doubted belief, "don't know", "can't tell/say/confirm", "unclear", a
#     "whether"/"if" right before it) and its sentence is not a question
#     (guards._vouched).
#   * A HEADING read as a lead: "Correction:", "Update —", "As a correction,".
#     A lead joins its label by a space ("correction to", "updated from", "as
#     my last reply said"); a colon, dash or comma after it ends a heading, and
#     the label under a heading is a label.
STATE_LABELLED_THEN_DOUBTED = [
    (
        "cant_tell_you_whether_still_accurate",
        f"Here is hub's status from my previous answer:\n{NAME_RUN}\nI can't tell you whether "
        "that is still accurate.",
        NAME_RUN,
    ),
    (
        "not_sure_it_still_holds_in_the_label",
        "From my previous answer (not sure it still holds): hub is offline.",
        "hub is offline.",
    ),
    # The same doubt, spelled the other ways she writes it.
    (
        "not_sure_that_is_still_true",
        "My previous answer said: hub is offline. I'm not sure that is still true.",
        "hub is offline.",
    ),
    (
        "dont_know_if_still_true",
        "From my previous answer: hub is switched off. I don't know if that is still true.",
        "hub is switched off.",
    ),
    (
        "whether_still_the_case_i_cant_say",
        "From my previous answer: hub is offline. Whether that is still the case, I can't say.",
        "hub is offline.",
    ),
    (
        "block_then_dont_know_whether",
        f"From my previous answer:\n{NAME_RUN}\nI don't know whether that is still true.",
        NAME_RUN,
    ),
    (
        "block_then_not_sure_it_still_holds",
        f"From my previous answer:\n{NAME_RUN}\nI'm not sure it still holds.",
        NAME_RUN,
    ),
    (
        "cant_say_whether_it_still_holds",
        "From my previous answer: hub is offline, and I can't say whether it still holds.",
        "hub is offline.",
    ),
    (
        "cant_confirm_still_the_case",
        "From my previous answer: hub is offline. I can't confirm that is still the case.",
        "hub is offline.",
    ),
    (
        "doubt_still_true",
        "From my previous answer: hub is offline. I doubt that is still true.",
        "hub is offline.",
    ),
    (
        "dont_think_still_true",
        "From my previous answer: hub is offline. I don't think that is still true.",
        "hub is offline.",
    ),
    (
        "unclear_whether_still_holds",
        "From my previous answer: hub is offline. It's unclear whether that still holds.",
        "hub is offline.",
    ),
    (
        "block_then_cant_tell_whether_still_current",
        f"Here is hub's status from my previous answer:\n{NAME_RUN}\nI can't tell whether that "
        "is still current.",
        NAME_RUN,
    ),
    # A reaffirmation she asks about is not one.
    (
        "still_true_or_is_it",
        "From my previous answer: hub is offline. That is still true, or is it?",
        "hub is offline.",
    ),
]

STATE_LABELLED_UNDER_A_HEADING = [
    (
        "correction_heading_then_from_history",
        "Correction: my previous answer said: hub is offline. That was from history, not a "
        "fresh check.",
        "hub is offline.",
    ),
    # The same heading, spelled the other ways she writes it.
    (
        "update_heading",
        "Update: my previous answer said: hub is offline. That was from history.",
        "hub is offline.",
    ),
    (
        "update_dash_heading_over_an_attribution",
        f"Update — from my previous answer:\n{NAME_RUN}\nI have not re-read it.",
        NAME_RUN,
    ),
    (
        "correction_heading_over_showed",
        f"Correction: my previous answer showed:\n{NAME_RUN}",
        NAME_RUN,
    ),
    (
        "correction_dash_heading",
        "Correction — my previous answer said: hub is offline.",
        "hub is offline.",
    ),
    (
        "correction_comma_heading",
        "Correction, my previous answer said: hub is offline.",
        "hub is offline.",
    ),
    (
        "bold_correction_heading",
        "**Correction:** my previous answer said: hub is offline.",
        "hub is offline.",
    ),
    ("updated_heading", "Updated: my last reply said: hub is offline.", "hub is offline."),
    ("fix_heading", "Fix: my last reply said: hub is offline.", "hub is offline."),
    (
        "as_a_correction_heading",
        "As a correction: my previous answer said: hub is offline.",
        "hub is offline.",
    ),
    # A word that says the state changed is a heading the same way.
    (
        "changed_heading",
        "Changed: my previous answer said: hub is offline. I have not re-read it.",
        "hub is offline.",
    ),
]


@pytest.mark.parametrize(
    "label,reply,bare",
    STATE_LABELLED_THEN_DOUBTED + STATE_LABELLED_UNDER_A_HEADING,
    ids=[c[0] for c in STATE_LABELLED_THEN_DOUBTED + STATE_LABELLED_UNDER_A_HEADING],
)
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_doubted_or_headed_history_label_is_not_corrected(purpose, label, reply, bare):
    spans = [_llm("hub:qwen3:8b", purpose=purpose)]
    assert guards.state_claim_check(reply, spans, NAMES, purpose=purpose) is None, label
    claim = guards.state_claim_check(bare, spans, NAMES, purpose=purpose)
    assert claim is not None and claim.device == "hub", label


# What must keep firing: a doubt that is no doubt ("not sure WHY" presupposes
# it, "no doubt" asserts it), a doubt about something else in another clause,
# an "if" that does not lead the reaffirmation, and a lead that joins its label
# by a space — a verb, a participle, a plural noun and a preposition.
STATE_STILL_REASSERTED = [
    (
        "not_sure_why_still_true",
        "From my previous answer: hub is offline. I'm not sure why that is still true.",
    ),
    (
        "dont_know_why_still_true",
        "From my previous answer: hub is offline. I don't know why that is still true.",
    ),
    (
        "a_doubt_about_something_else",
        "From my previous answer: hub is offline. I'm not sure about the Dell, but that is "
        "still true.",
    ),
    (
        "no_doubt_still_true",
        "From my previous answer: hub is offline. No doubt that is still true.",
    ),
    ("sure_still_true", "From my previous answer: hub is offline. I'm sure that is still true."),
    (
        "an_if_that_does_not_lead_it",
        "From my previous answer: hub is offline. If you're asking, that is still true.",
    ),
    ("correcting_my_last_replys_reading", "Correcting my last reply's reading: hub is offline."),
    ("fixing_my_last_replys_reading", "Fixing my last reply's reading: hub is offline."),
    (
        "corrections_to_my_last_replys_reading",
        "Corrections to my last reply's reading: hub is offline.",
    ),
    ("updates_to_my_last_replys_reading", "Updates to my last reply's reading: hub is offline."),
    (
        "amendment_to_my_last_replys_reading",
        "Amendment to my last reply's reading: hub is offline.",
    ),
    (
        "current_status_updated_from_my_last_reply",
        f"Here is hub's current status (updated from my last reply):\n{NAME_RUN}",
    ),
    ("updated_from_my_last_reply_after", "hub is offline, updated from my last reply."),
    (
        "current_status_bold_unchanged_from_my_last_reply",
        f"Here is hub's current status (**unchanged** from my last reply):\n{NAME_RUN}",
    ),
    # A noun that runs into an attribution needs no preposition of its own.
    ("update_from_my_last_reply", "Update from my last reply: hub is offline."),
    ("changed_from_my_last_reply", "Changed from my last reply: hub is offline."),
    # A word that says the state is the SAME leads through a heading's colon.
    ("unchanged_heading", "Unchanged: my previous answer said: hub is offline."),
    # Under a heading, a label still ends at a reaffirmation or a retraction.
    (
        "correction_heading_then_still_true",
        "Correction: my previous answer said: hub is offline, and that is still true.",
    ),
    (
        "correction_heading_retracted_then_a_new_claim",
        "Correction: my previous answer said: hub was ready, which was wrong, and hub is offline.",
    ),
]


@pytest.mark.parametrize(
    "label,reply", STATE_STILL_REASSERTED, ids=[c[0] for c in STATE_STILL_REASSERTED]
)
@pytest.mark.parametrize("purpose", ["chat", "eval"])
def test_a_vouched_reaffirmation_or_a_joined_lead_still_fires(purpose, label, reply):
    spans = [_llm("hub:qwen3:8b", purpose=purpose)]
    claim = guards.state_claim_check(reply, spans, NAMES, purpose=purpose)
    assert claim is not None, label
    assert (claim.subject_kind, claim.device) == ("machine", "hub")


@pytest.mark.parametrize(
    "regen",
    [
        STATE_LABELLED_THEN_DOUBTED[0][1],
        STATE_LABELLED_UNDER_A_HEADING[0][1],
    ],
)
def test_a_regeneration_that_doubts_or_heads_her_history_is_not_refused(regen):
    """The reviewer's regeneration probes: the honest answer, vetted as a
    regeneration, was refused as state_claim and the correction became the
    record."""
    from app import agents

    turn = SimpleNamespace(spans=[HUB_SERVED], kind="chat")
    rejected = chat._regen_rejected_by(
        regen,
        turn,
        None,
        NAMES,
        "Where do your models run, and is that machine ready?",
        agents.nova_persona(),
        agent_names=[],
    )
    assert rejected is None
