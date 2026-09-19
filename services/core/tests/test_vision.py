"""S28 — which model looks at the picture, and what gets said about it.

Pure: no database, no gateway. What is pinned is that the decision is read
off the LIVE capability map and that every outcome says something — the
failure this prevents is an image quietly missing from a turn, answered from
its filename.
"""

from __future__ import annotations

from app import vision


def row(model: str, *caps: str, installed: bool = True) -> dict:
    """A catalogue row in the shape the gateway publishes (a local one)."""
    return {
        "id": f"ollama:{model}",
        "kind": "local",
        "installed": installed,
        "capabilities": {c: {"value": True, "basis": "declared"} for c in caps},
    }


# The household's own models, as `ollama show` actually reports them.
BOX = [
    row("gemma4:31b", "completion", "tools", "thinking", "vision"),
    row("nomic-embed-text:latest", "embedding"),
    row("gemma4:12b", "completion", "tools", "thinking", "vision", "audio"),
    row("qwen3.8:27b", "completion", "tools", "thinking", "vision"),
    row("qwen3:8b", "completion", "tools", "thinking"),
]


def test_capability_is_read_off_the_row_never_off_the_name():
    """A hardcoded list would be wrong the day he pulls a new model, and
    wrong silently."""
    seers = vision.capable(BOX, "vision")

    assert seers == ["ollama:gemma4:31b", "ollama:gemma4:12b", "ollama:qwen3.8:27b"]
    assert "ollama:qwen3:8b" not in seers
    # The audio half of the same mechanism, which S28 rides too.
    assert vision.capable(BOX, "audio") == ["ollama:gemma4:12b"]


def test_a_model_that_is_not_installed_cannot_see_anything_today():
    """It would be able to if it were here. Offering it is offering a
    download, not an answer."""
    rows = [row("gemma4:12b", "vision", installed=False), row("qwen3:8b", "tools")]

    assert vision.capable(rows, "vision") == []


def test_a_model_that_can_already_see_is_left_alone_and_nothing_is_said():
    """A note about a swap that did not happen is noise."""
    choice = vision.choose(BOX, wanted="qwen3.8:27b")

    assert choice.model == "qwen3.8:27b"
    assert choice.note is None
    assert choice.can_see is True


def test_a_model_that_cannot_see_is_swapped_and_the_swap_is_STATED():
    """The owner's ruling: an image he sent is a thing he wants read, so the
    turn runs on a model that can read it — and says which, because a model
    switch he cannot see is how "she answered from a different brain"
    becomes invisible."""
    choice = vision.choose(BOX, wanted="qwen3:8b")

    assert choice.model == "ollama:gemma4:31b"
    assert choice.can_see is True
    assert "qwen3:8b cannot see images" in choice.note
    assert "gemma4:31b" in choice.note
    # The catalogue's prefix is not something a reply should be saying.
    assert "ollama:" not in choice.note


def test_a_box_with_no_vision_at_all_says_so_rather_than_picking_anyway():
    """The worst outcome is the quiet one: an image absent from the turn and
    a reply written from the filename."""
    blind = [row("qwen3:8b", "completion", "tools")]

    choice = vision.choose(blind, wanted="qwen3:8b")

    assert choice.model == "qwen3:8b"
    assert choice.can_see is False
    assert "No model installed on this machine" in choice.note
    assert "do not describe it" in choice.note


def test_an_unreadable_catalogue_is_a_THIRD_answer():
    """Not "no model can see" — that is a claim about the machine, and the
    thing that failed was a request. Assuming the other way is just as bad:
    it sends an image to a model that will ignore it."""
    choice = vision.choose(None, wanted="qwen3:8b")

    assert choice.model == "qwen3:8b"
    assert choice.can_see is False
    assert "could not be read" in choice.note


def test_the_wanted_model_is_matched_with_or_without_the_catalogue_prefix():
    """Core says `qwen3.8:27b`; the catalogue says `ollama:qwen3.8:27b`. A
    mismatch here would swap a model that was already correct."""
    assert vision.choose(BOX, wanted="ollama:qwen3.8:27b").note is None
    assert vision.choose(BOX, wanted="qwen3.8:27b").note is None


# ── what the live walk found, 2026-09-16 ──────────────────────────────────


def test_the_gateways_own_key_is_the_one_read():
    """FOUND BY THE WALK. The gateway publishes its catalogue under `rows`;
    core's own /api/v1/models/catalog route republishes it as `models`. This
    reads the GATEWAY directly, so it was looking for a key that hop never
    sends — every turn decided "the catalogue could not be read", and an
    image he sent was never looked at.

    Both names are accepted because both are real: one is what the gateway
    says, the other is what core says about it, and a helper that reaches
    either hop should not care which side it landed on.
    """
    assert vision.rows_of({"rows": [row("gemma4:12b", "vision")]}) is not None
    assert vision.rows_of({"models": [row("gemma4:12b", "vision")]}) is not None
    # Neither key, or a body that is not an object: that is a body nobody can
    # read, which is different from a box with no vision in it.
    assert vision.rows_of({"fetched_at": "now"}) is None
    assert vision.rows_of([]) is None


def test_not_knowing_is_never_reported_as_no_model_can_see():
    """The second half of the same walk. "The catalogue could not be read"
    and "nothing here can see" are different facts, and only one of them is
    about the machine — she told the owner the second when the first was
    true, which is a claim about his box that nobody checked."""
    unknown = vision.choose(None, wanted="qwen3:8b")
    none_here = vision.choose([row("qwen3:8b", "completion")], wanted="qwen3:8b")

    assert unknown.can_see is False and none_here.can_see is False
    # THE DIFFERENCE: only one of them knows.
    assert unknown.certain is False
    assert none_here.certain is True
    # And a model that CAN see is certain too — the flag is about knowledge,
    # not about the answer.
    assert vision.choose([row("gemma4:12b", "vision")], wanted="gemma4:12b").certain is True


# ── his own pick (owner, 2026-09-16) ───────────────────────────────────────


def test_the_model_HE_chose_wins_over_the_automatic_pick():
    """ "I should be able to select a vision model." The automatic pick is
    what happens when he has not."""
    auto = vision.choose(BOX, wanted="qwen3:8b")
    his = vision.choose(BOX, wanted="qwen3:8b", preferred="qwen3.8:27b")

    assert auto.model == "ollama:gemma4:31b"
    assert his.model == "ollama:qwen3.8:27b"
    assert "qwen3.8:27b" in his.note


def test_a_chosen_model_that_cannot_actually_see_is_passed_over():
    """The setting chooses BETWEEN capable models; it cannot make one
    capable. A name in a settings row is a claim, and the capability map is
    the fact — obeying the string would send an image to a model that
    ignores it and leave her describing a picture she never saw."""
    choice = vision.choose(BOX, wanted="qwen3:8b", preferred="qwen3:8b")

    assert choice.model == "ollama:gemma4:31b"
    assert choice.can_see is True


def test_a_chosen_model_that_is_not_installed_is_passed_over_too():
    choice = vision.choose(BOX, wanted="qwen3:8b", preferred="llava:34b")

    assert choice.model == "ollama:gemma4:31b"


def test_his_pick_is_matched_with_or_without_the_catalogue_prefix():
    assert vision.choose(BOX, wanted="qwen3:8b", preferred="ollama:gemma4:12b").model == (
        "ollama:gemma4:12b"
    )
    assert vision.choose(BOX, wanted="qwen3:8b", preferred="gemma4:12b").model == (
        "ollama:gemma4:12b"
    )


def test_a_preference_changes_nothing_when_the_chat_model_can_already_see():
    """No swap, so nothing to say about one."""
    choice = vision.choose(BOX, wanted="gemma4:12b", preferred="qwen3.8:27b")

    assert choice.model == "gemma4:12b" and choice.note is None


def test_the_prefix_is_whatever_the_catalogue_says_never_a_name_kept_here():
    """S40: the catalogue says `hub:` (or any machine) and a setting may be
    bare or qualified. The catalogue id splits at its FIRST colon; a setting
    is never split — `qwen3.8:27b`'s colon is its own."""
    rows = [
        {
            "id": "hub:qwen3.8:27b",
            "kind": "local",
            "installed": True,
            "capabilities": {"vision": {"value": True}},
        },
        {
            "id": "dell:gemma4:12b",
            "kind": "local",
            "installed": True,
            "capabilities": {"vision": {"value": True}},
        },
        {
            "id": "hub:qwen3:8b",
            "kind": "local",
            "installed": True,
            "capabilities": {"tools": {"value": True}},
        },
    ]
    assert vision.bare("hub:qwen3.8:27b") == "qwen3.8:27b"
    assert vision.choose(rows, wanted="hub:qwen3.8:27b").note is None
    assert vision.choose(rows, wanted="qwen3.8:27b").note is None
    swapped = vision.choose(rows, wanted="hub:qwen3:8b", preferred="gemma4:12b")
    assert swapped.model == "dell:gemma4:12b"
    assert "running on gemma4:12b rather than qwen3:8b" in swapped.note


def test_a_bare_setting_is_matched_against_local_rows_only():
    """(S40 fix wave C3) A bare setting (`qwen3.8:27b`) runs on a machine; a
    cloud row whose id happens to end in the same words is another model
    somewhere else. Matching its tail said "can already see" about the local
    model that cannot — and picked the cloud row as HIS preference."""
    cloud = {
        "id": "openrouter:qwen3.8:27b",
        "kind": "cloud",
        "installed": True,
        "capabilities": {"vision": {"value": True}},
    }
    rows = [
        {
            "id": "hub:gemma4:12b",
            "kind": "local",
            "installed": True,
            "capabilities": {"vision": {"value": True}},
        },
        cloud,
        {
            "id": "hub:qwen3.8:27b",
            "kind": "local",
            "installed": True,
            "capabilities": {"tools": {"value": True}},
        },
        {"id": "hub:qwen3:8b", "kind": "local", "installed": True, "capabilities": {}},
    ]
    choice = vision.choose(rows, wanted="qwen3.8:27b")
    assert choice.note is not None and choice.model == "hub:gemma4:12b"
    preferred = vision.choose(rows, wanted="qwen3:8b", preferred="qwen3.8:27b")
    assert preferred.model == "hub:gemma4:12b"
    # The cloud row is still a row: named WHOLE, it is matched as itself.
    assert vision.choose(rows, wanted="openrouter:qwen3.8:27b").note is None
    assert vision.choose(rows, wanted="qwen3:8b", preferred=cloud["id"]).model == cloud["id"]
