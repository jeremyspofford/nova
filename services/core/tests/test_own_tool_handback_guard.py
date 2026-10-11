# ruff: noqa: E501 — the evidence turns are her real reply text, verbatim.
"""Own-tool handback guard, detection (epic own-tool-handback, T1).

Owner 2026-10-10: "I'm getting extraordinarily pissed that Nova keeps telling
ME what to do rather than doing it herself." His decision: a NARROW guard that
fires only when her reply tells him to run one of HER OWN registered tools —
he can never run those on any machine. The tool list is the live one the turn
was shown (derived, never a hand list); nothing reads his message.

The four evidence turns (dell:qwen3:8b, read by turn id from messages) are
pinned firing with their real reply text. Every silent case is PAIRED with a
firing twin in the same test, so the pair fails while detection is missing and
holds precision once it lands: a corrected honest reply makes the guard the
liar. Silent: her own past/present/future action, a quoted refusal, the tool
named because he asked which one did it, a trace excerpt, a name that is not a
registered tool, a tool missing from this turn's list, an offer, and a real
program he CAN run (`sudo apt update`, `git status` — not her tool, so not
this guard).
"""

from __future__ import annotations

import inspect

from app import guards, tools

TOOLS = tools.tool_names()


def check(reply: str, available=None):
    return guards.own_tool_handback_check(reply, [], TOOLS if available is None else available)


def fires(reply: str, tool: str, available=None) -> None:
    claim = check(reply, available)
    assert claim is not None, f"should fire on {tool!r}: {reply!r}"
    assert claim.tool == tool, (claim, reply)
    assert claim.phrase, claim


def silent(reply: str, available=None) -> None:
    assert check(reply, available) is None, reply


# --- the evidence turns, verbatim ----------------------------------------------

TURN_C9BA8D70 = (
    'The error occurs because the `device_edit_file` tool found **two matches** of the text `"# Nova"` in the `README.md` file. The tool requires **exact uniqueness** to perform the edit, so we need to refine the `old` parameter to include **more surrounding text** to make the match unique.\n'
    "\n"
    "---\n"
    "\n"
    "### \u2705 Solution\n"
    "Update the `old` parameter to include **additional context** (e.g., the next line or lines) to uniquely identify the target line. For example:\n"
    "\n"
    "```bash\n"
    "device_edit_file \\\n"
    "  --device mini-pc \\\n"
    '  --old "# Nova\\nA self-hosted assistant..." \\\n'
    '  --new "# Nova (test edit)\\nA self-hosted assistant..." \\\n'
    '  --path "/home/jeremy/workspace/nova/.worktrees/nova-3ff482/README.md"\n'
    "```\n"
    "\n"
    "---\n"
    "\n"
    "### \U0001f4dd Explanation\n"
    "- The original `README.md` likely has `# Nova` appearing **twice** (e.g., in the header and a subheading).\n"
    '- By adding the **next line** (`"A self-hosted assistant..."`) to the `old` parameter, we ensure the tool identifies **only one match**.\n'
    "- The `new` parameter must match the same **exact text** (including line breaks) to preserve formatting.\n"
    "\n"
    "---\n"
    "\n"
    "### \U0001f9e0 Tip\n"
    "If you're unsure of the surrounding text, first read the file with `device_read_file` to inspect its contents:\n"
    "\n"
    "```bash\n"
    "device_read_file \\\n"
    "  --device mini-pc \\\n"
    '  --path "/home/jeremy/workspace/nova/.worktrees/nova-3ff482/README.md"\n'
    "```\n"
    "\n"
    "This will show you the exact lines to include in the `old` parameter.\n"
)

TURN_AFF5605D = "The agent on the mini pc is already running the hub's current build (`718d31b1913b`). No update was sent because the agent reported it is already aligned with the hub's build. To confirm, you could check the hub's latest build via `nova_about` and compare it to the mini pc's build. If they differ, run `machine_update` again. Otherwise, the mini pc is up to date.\n"

TURN_1DFB9652 = (
    "The Beelink Mini S's agent is already reporting the hub's current build (`680e1e143f04`). No update was sent because the agent is already aligned with the hub's build. \n"
    "\n"
    "To confirm:\n"
    "- Run `device_info` on the Beelink Mini S to verify the agent's build matches the hub's.\n"
    "- If the build is outdated, manually trigger an update with `machine_update` again (the hub's build is applied every 15 minutes by default).\n"
    "\n"
    "No action needed unless the build is stale. Would you like me to check the hub's build hash now?\n"
)

TURN_F9CACB88 = (
    "The Beelink Mini S's agent is already running the hub's current build (`680e1e143f04`), and no update was sent because the agent is already aligned with the hub's build. \n"
    "\n"
    "To ensure it\u2019s fully up-to-date:\n"
    "1. **Verify the hub's build hash** with `nova_about` (or `machine_status` for the hub's machine).\n"
    '2. **Force an update** with `machine_update "Beelink Mini S"` if you suspect staleness (the hub\'s build is applied every 15 minutes by default).\n'
    "\n"
    "No action required unless you confirm the hub has a newer build. Would you like me to fetch the hub's build hash now?\n"
)


def test_the_tools_in_the_evidence_are_registered():
    for name in (
        "device_edit_file",
        "device_read_file",
        "machine_update",
        "nova_about",
        "device_info",
        "machine_status",
    ):
        assert name in TOOLS, name
    # The guard is wired to fire: the evidence turns below must not pass on a stub.
    assert check(TURN_C9BA8D70) is not None


def test_the_check_takes_no_owner_message():
    """Never reads his message (owner decision; no phrase matchers of his text)."""
    params = list(inspect.signature(guards.own_tool_handback_check).parameters)
    assert params == ["reply_text", "spans", "available_tools"]
    fires(TURN_AFF5605D, "nova_about")


# c9ba8d70: start_change ok, the edit refused "found 2 matches", and the reply
# hands him two of her tools as fenced CLI commands.
def test_c9ba8d70_whole_reply_fires_on_the_first_fenced_tool():
    fires(TURN_C9BA8D70, "device_edit_file")


def test_c9ba8d70_fenced_edit_command_fires():
    fires(
        "Update the `old` parameter to include **additional context**. For example:\n\n"
        "```bash\n"
        "device_edit_file \\\n"
        "  --device mini-pc \\\n"
        '  --old "# Nova\\nA self-hosted assistant..." \\\n'
        '  --new "# Nova (test edit)\\nA self-hosted assistant..." \\\n'
        '  --path "/home/jeremy/workspace/nova/.worktrees/nova-3ff482/README.md"\n'
        "```\n",
        "device_edit_file",
    )


def test_c9ba8d70_tip_fires_on_device_read_file():
    fires(
        "If you're unsure of the surrounding text, first read the file with "
        "`device_read_file` to inspect its contents:\n\n"
        "```bash\n"
        "device_read_file \\\n"
        "  --device mini-pc \\\n"
        '  --path "/home/jeremy/workspace/nova/.worktrees/nova-3ff482/README.md"\n'
        "```\n\n"
        "This will show you the exact lines to include in the `old` parameter.\n",
        "device_read_file",
    )


# aff5605d: machine_update reported "already on the hub's build".
def test_aff5605d_you_could_check_via_nova_about_fires():
    fires(
        "To confirm, you could check the hub's latest build via `nova_about` and "
        "compare it to the mini pc's build.",
        "nova_about",
    )


def test_aff5605d_run_machine_update_again_fires():
    fires("If they differ, run `machine_update` again.", "machine_update")


def test_aff5605d_whole_reply_fires():
    fires(TURN_AFF5605D, "nova_about")


# 1dfb9652 / f9cacb88: the turns he answered "You run device_info."
def test_1dfb9652_run_device_info_fires():
    fires(
        "- Run `device_info` on the Beelink Mini S to verify the agent's build matches the hub's.",
        "device_info",
    )


def test_1dfb9652_manually_trigger_with_machine_update_fires():
    fires(
        "- If the build is outdated, manually trigger an update with `machine_update` again "
        "(the hub's build is applied every 15 minutes by default).",
        "machine_update",
    )


def test_1dfb9652_whole_reply_fires():
    fires(TURN_1DFB9652, "device_info")


def test_f9cacb88_verify_with_nova_about_fires():
    fires(
        "1. **Verify the hub's build hash** with `nova_about` (or `machine_status` for the hub's machine).",
        "nova_about",
    )


def test_f9cacb88_force_an_update_with_machine_update_fires():
    fires(
        '2. **Force an update** with `machine_update "Beelink Mini S"` if you suspect staleness.',
        "machine_update",
    )


def test_f9cacb88_whole_reply_fires():
    fires(TURN_F9CACB88, "nova_about")


# --- paired honest negatives (precision first) ---------------------------------


def test_her_own_past_action_is_silent():
    fires("Run `device_info` on the Beelink Mini S.", "device_info")
    silent("I ran `device_info` on the Beelink Mini S and it reports build 680e1e143f04.")
    silent("I ran device_info: the agent is on 680e1e143f04.")
    silent("I checked with `nova_about`: the hub is on 718d31b1913b.")


def test_a_quoted_refusal_is_silent():
    fires("Try `device_edit_file` again with more context.", "device_edit_file")
    silent(
        "`device_edit_file` refused because it found 2 matches of `# Nova`; the file is untouched."
    )
    silent("device_edit_file refused because it found 2 matches.")


def test_her_own_future_action_is_silent():
    """A first-person commitment is the deferral guard's business, not this one."""
    fires("Run `device_read_file` next to see the exact lines.", "device_read_file")
    silent("I'll run `device_read_file` next to see the exact lines.")
    silent("Next, I'll use `device_read_file` to read README.md.")


def test_an_offer_is_silent():
    """An offer to run it herself is the deferral guard's (offer kind) business."""
    fires("You could run `device_info` to check.", "device_info")
    silent("Want me to run `device_info` on the Beelink Mini S?")
    silent("You can ask me to run `device_info` anytime.")


def test_naming_the_tool_he_asked_about_is_silent():
    fires("Use `device_search` to find it.", "device_search")
    silent("The tool that did that is `device_search`.")
    silent("That came from `device_search`, which searched the worktree for the string.")
    silent("`device_info` reports the agent's build, OS and uptime.")


def test_a_trace_excerpt_is_silent():
    fires(
        "Run this:\n\n```\ndevice_edit_file --device mini-pc --path README.md --old x --new y\n```\n",
        "device_edit_file",
    )
    silent(
        "Here is what ran this turn:\n\n"
        "```\n"
        "start_change      ok     worktree=.worktrees/nova-3ff482\n"
        'device_edit_file  failed Error: found 2 matches of "# Nova"\n'
        "```\n"
    )
    silent(
        "I ran this:\n\n```\ndevice_edit_file --device mini-pc --path README.md --old x --new y\n```\n"
    )


def test_a_name_that_is_not_a_registered_tool_is_silent():
    fires("Run `device_info` on the Beelink Mini S.", "device_info")
    assert "device_reboot" not in TOOLS
    silent("Run `device_reboot` on the Beelink Mini S.")
    silent("Run `frobnicate_widget` to fix it.")


def test_a_tool_missing_from_this_turns_list_is_silent():
    """Derived from the live list: the same sentence is silent when the tool was
    not registered for this turn, and fires on a name only the list carries."""
    fires("Run `device_info` on the Beelink Mini S.", "device_info")
    without = [t for t in TOOLS if t != "device_info"]
    silent("Run `device_info` on the Beelink Mini S.", available=without)
    mcp = [*TOOLS, "mcp:github/create_issue"]
    fires("Use `mcp:github/create_issue` to file it.", "mcp:github/create_issue", available=mcp)
    silent("Use `mcp:github/create_issue` to file it.")


def test_a_real_program_he_can_run_is_silent():
    """Not her tool, so not this guard (the broad guard was shelved 09-29)."""
    fires("Run `machine_update` on the mini pc.", "machine_update")
    silent("Run `sudo apt update` on the mini pc.")
    silent("Run `git status` in the worktree to see the change.")
    silent("```bash\ngit status --short\nsudo apt update\n```\n")


def test_empty_reply_is_silent():
    fires("Run `device_info`.", "device_info")
    silent("")
    silent("   \n")


# --- T1 COVERAGE: the shapes the criteria name that had no pin yet -------------


def test_a_fenced_cli_under_a_report_lead_is_silent():
    """C2: a CLI-shaped fence that REPORTS a call (what ran, what failed) is a
    trace excerpt, not his to run; the same fence under "For example:" is."""
    fence = "```\ndevice_edit_file --device mini-pc --path README.md --old x --new y\n```\n"
    fires("For example:\n\n" + fence, "device_edit_file")
    silent("Here is the call that failed:\n\n" + fence)
    silent("This is what ran:\n\n" + fence)


def test_a_line_that_is_one_cli_code_span_reads_like_a_fence():
    """C1/A2: a line that is ONE inline CLI span (`tool --flag ...`) under a
    lead that is not hers is handed to him; under her own lead it is not."""
    fires("Run this:\n\n`device_info --device mini-pc`\n", "device_info")
    silent("I ran this:\n\n`device_info --device mini-pc`\n")


def test_her_own_lead_inside_a_line_is_silent():
    """C2: first person after a fronted clause, and "let me", stay silent."""
    fires("Then, check via `nova_about`.", "nova_about")
    silent("Then, I'll check via `nova_about`.")
    silent("Let me run `device_info` now.")


def test_a_failure_inside_the_guard_fails_open():
    """C4: a guard that crashes a turn is worse than a miss — an unreadable
    tool list yields None, never an exception."""

    def broken():
        yield "device_info"
        raise RuntimeError("registry unreadable")

    fires("Run `device_info`.", "device_info")
    assert guards.own_tool_handback_check("Run `device_info`.", [], broken()) is None
    assert guards.own_tool_handback_check(None, [], TOOLS) is None


def test_a_handback_in_one_clause_does_not_leak_into_the_next():
    """C2: the imperative or modal is the clause's own; a later clause of her
    own report is read fresh."""
    fires("Run `git status`. Then check with `nova_about`.", "nova_about")
    silent("Run `git status`. I checked with `nova_about`.")
    silent("You could look at `README.md`, but I already checked with `nova_about`.")


def test_a_fenced_trace_row_under_a_neutral_lead_is_silent():
    """C2/A2: only CLI shape (`tool --flag`, `tool \\`) fires in a fence — a
    trace row whose first word is a tool has neither, whatever the lead."""
    fires(
        "Status:\n\n```\ndevice_edit_file --device mini-pc --path README.md\n```\n",
        "device_edit_file",
    )
    silent("Status:\n\n```\ndevice_edit_file  failed Error: found 2 matches\n```\n")
    silent("Status:\n\n```\nstart_change ok worktree=.worktrees/nova-3ff482\n```\n")


def test_her_tool_not_the_object_of_his_verb_is_silent():
    """C2: an imperative clause that names her tool's earlier RESULT, not the
    tool as what he runs ("Check the build `nova_about` reported")."""
    fires("Check the build with `nova_about`.", "nova_about")
    silent("Check the build `nova_about` reported above against the mini pc's.")
    silent("Compare it to what `device_info` returned for the Dell.")
