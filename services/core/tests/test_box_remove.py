"""S32.3 T7: core's side of novad's box.remove (docs/plans/rebuild/s32/spec.md
§5.2 step 8, §4.4).

A landing's close removes its judge box, and close_change removes a change's
box. Both go through tools.changes.remove_box, which sends the agent's
box.remove with ONLY the change id and never raises: what it returns is ''
when the agent removed the box, else the stated reason (an old agent, an
offline machine, docker's refusal) — the caller records it, the landing's
verdict stands.

Criteria:
  C5 remove_box sends exactly box.remove {"change": <id>} to the given machine
     and returns '' on ok:true.
  C6 remove_box states, never raises: unknown capability -> '<machine>'s agent
     predates box removal — update it with machine_update'; any other ok:false
     -> '<machine>: <error>' (no reason -> the no-reason words); a ToolFailure
     from _command (offline) -> its words on one line; a malformed id ->
     stated with nothing sent.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.tools import changes
from app.tools.base import ToolContext, ToolFailure

ROW = {"id": "dev-1", "name": "Beelink Mini S"}


def _ctx() -> ToolContext:
    return ToolContext(app=None, person=None, workspace_root=Path("/nonexistent"))


class Agent:
    """Stands in for _command: records every capability + args, answers a
    scripted result frame or raises a scripted ToolFailure."""

    def __init__(self, result: dict | None = None, raises: str | None = None):
        self.result = result if result is not None else {"ok": True, "output": "removed"}
        self.raises = raises
        self.sent: list[tuple[str, dict, dict]] = []

    async def __call__(self, pool, row, capability, args, *, ctx=None, timeout=None):
        self.sent.append((capability, dict(args), dict(row)))
        if self.raises is not None:
            raise ToolFailure(self.raises)
        return dict(self.result)


@pytest.fixture
def agent(monkeypatch):
    def install(**kw) -> Agent:
        fake = Agent(**kw)
        monkeypatch.setattr(changes, "_command", fake)
        return fake

    return install


# -- C5 ------------------------------------------------------------------------


async def test_c5_sends_only_the_change_id_to_the_machine_and_returns_empty(agent):
    fake = agent(
        result={
            "ok": True,
            "output": "nova-box-c0ffee removed",
            "meta": {"box": "nova-box-c0ffee", "removed": True},
        }
    )
    got = await changes.remove_box(None, ROW, _ctx(), "c0ffee")
    assert got == ""
    assert fake.sent == [("box.remove", {"change": "c0ffee"}, ROW)]


async def test_c5_the_id_sent_is_the_one_asked(agent):
    fake = agent()
    assert await changes.remove_box(None, ROW, _ctx(), "abc123") == ""
    assert [args for _, args, _ in fake.sent] == [{"change": "abc123"}]


# -- C6 ------------------------------------------------------------------------


async def test_c6_an_old_agent_is_told_to_update(agent):
    agent(result={"ok": False, "error": 'unknown capability "box.remove"'})
    got = await changes.remove_box(None, ROW, _ctx(), "c0ffee")
    assert got == ("Beelink Mini S's agent predates box removal — update it with machine_update")


async def test_c6_the_agents_refusal_is_quoted_with_the_machine(agent):
    agent(
        result={
            "ok": False,
            "error": "cannot remove the box nova-box-c0ffee: rm: docker said (exit 1): boom",
        }
    )
    got = await changes.remove_box(None, ROW, _ctx(), "c0ffee")
    assert got == (
        "Beelink Mini S: cannot remove the box nova-box-c0ffee: rm: docker said (exit 1): boom"
    )


@pytest.mark.parametrize("result", [{"ok": False}, {"ok": False, "error": ""}, {}])
async def test_c6_a_failure_with_no_reason_is_never_success(agent, result):
    agent(result=result)
    got = await changes.remove_box(None, ROW, _ctx(), "c0ffee")
    assert got == "Beelink Mini S: the device reported a failure with no reason"


async def test_c6_an_offline_machine_is_stated_on_one_line(agent):
    agent(raises="Beelink Mini S is offline\n  (last seen 3 min ago)")
    got = await changes.remove_box(None, ROW, _ctx(), "c0ffee")
    assert got == "Beelink Mini S is offline (last seen 3 min ago)"


@pytest.mark.parametrize("change", ["C0FFEE", "c0ffee1", "c0ffe", "../x", "", "c0ffee\n", None])
async def test_c6_a_malformed_id_sends_nothing(agent, change):
    fake = agent()
    got = await changes.remove_box(None, ROW, _ctx(), change)
    assert fake.sent == []
    assert got.startswith("cannot remove a box: ")
    assert repr(change) in got
