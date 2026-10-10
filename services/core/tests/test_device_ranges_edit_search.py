"""S30a (2026-10-09): core's side of range reads, part-file edits and code
search on a paired machine. The agent's side is apps/novad/internal/caps
(fs_range.go, fs_edit.go, fs_search.go); its structured answer reaches core as
the result frame's `meta` (T1).

T3 — device_read_file ranges.

Criteria:
  C1 device_read_file's schema offers optional start_line/end_line (1-based,
     inclusive) and offset/length (integers); `required` stays [device, path].
     A ranged call forwards exactly the range args it was given to fs.read
     beside the checked path; a call with no range sends {"path"} alone.
  C2 an ok ranged read (frame meta carries `range`) files exactly one fact
     {"file": {"op": "read", "device", "range": <meta.range>, "bytes_total"},
     "target": <checked path>}, and the result states the file's total size
     (bytes_total, and lines_total when the agent gave it) and, when meta.eof
     is true, that the range runs past the end. (A read with no range files
     the S29a fact unchanged — pinned by test_device_span_facts C3.)
  C3 an agent that predates range reads is detected, never believed: a ranged
     request answered ok WITHOUT meta.range (an old agent ignored the range
     and sent the whole file), or refused with the old whole-file cap refusal
     ("file is N bytes, over the 256 KiB read cap"), fails the call stating
     that this agent predates range reads and naming machine_update as the
     way to update it; the whole-file output is never in the result, and no
     file fact is filed. A NEW agent's range refusal ("the range is N bytes,
     over the 256 KiB read cap") is the agent's own words, with no "predates".
  C4 the description says the cap applies to the range read, not the file,
     and names the line-range arguments.

Design calls (Assumptions):
  - Detection keys on meta.range's PRESENCE on an ok frame (T2: meta.range
    echoes the request; T1 C4: a no-meta frame arrives with no meta key).
  - An old agent's ok:false on a ranged read is recognised by its whole-file
    cap refusal, "file is <N> bytes, over the" — the wording of every released
    pre-S30a agent (fs.go fsRead on main bd6bcfb7), frozen because those
    builds cannot change. A new agent's ranged refusals never say "file is".
  - The update path named is the tool machine_update (machines.py), which
    S42b's update rides; the auto-update job reaches it later anyway.
  - The fact's range is the agent's echo (meta.range), not core's request.

T5 — device_edit_file (one exact snippet, through the agent's fs.edit, T4).

Criteria:
  C1 a new tool device_edit_file {device, path, old, new} (all four required,
     strings), NOT reads_only, not ephemeral; it sends fs.edit with exactly
     {path (checked), old, new}. On the repo machine an edit outside her
     .worktrees/nova-* is still made, its result ends with the
     outside-worktree warning and the fact {"outside_worktree", "tool":
     "device_edit_file"} is filed, as device_write_file does; inside her
     worktree, no flag.
  C2 an ok edit files exactly one fact {"edit": {"device", "matches",
     "bytes_before", "bytes_after"}, "target": <checked path>} from the
     frame's meta (no `file` fact), and its result names the path, the device
     and both sizes. A count refusal ("found N matches ...") is ok:false in the
     agent's own words and files no edit fact. An agent that predates fs.edit
     ("unknown capability") is stated as predating part-file edits, naming
     machine_update; no fact.
  C3 Tool.backs = {edited_file, wrote_file}; target-aware through the edit
     fact (guards._target_of): "I edited chat.py" / "I wrote chat.py" over an
     ok edit of .../chat.py stand, the same claims of guards.py are corrected,
     and a failed edit backs nothing (test_guards S30a T5 block).
  C4 the description states the rule (exactly one occurrence of `old`), the
     16 MiB edit cap, and what the edit does NOT keep: the file is replaced by
     a new one with the original's permission bits, so its owner, setuid/
     setgid bits, hard links and extended attributes are not kept (T4 VERIFY
     gap) — so she never claims more. Nothing reversible is recorded: no
     undo_sink entry and Tool.revert is None (a rewind lists the edit as not
     undone).

Design calls (Assumptions):
  - The edit fact's numbers come from the frame's meta (T4: matches,
    bytes_before, bytes_after); core never computes them.
  - An old agent is recognised by its dispatch refusal, which starts
    "unknown capability" (caps.go Dispatch, load-bearing words).
  - Not reversible in S30a: a revert would need the replaced bytes, which
    neither the frame nor core keeps. Stated as revert None, never claimed.
  - Capability coverage: EXCUSED (tests/test_capability_coverage.py) — no row
    reads "I can't edit files on your computer" today (capability_claim_check
    returns None on it), and a new row belongs with paired negatives in
    test_capability_guard.py, outside T5's files. Follow-up, stated.

T7 — device_search (a code search through the agent's fs.search, T6).

Criteria:
  C1 a new tool device_search {device, path, pattern, literal?, ignore_case?,
     max_matches?} (path/pattern strings, literal/ignore_case booleans,
     max_matches an integer 1..2000), reads_only and ephemeral; it sends
     fs.search with {path (checked), pattern} plus exactly the optional keys
     given. An empty pattern or a max_matches outside 1..2000 is refused
     before any frame. A search is a read: on the repo machine, a search of
     the live checkout carries no outside-worktree flag.
  C2 an ok search (meta matches int, files_scanned int, capped bool) files
     exactly one fact {"search": {"device", "matches", "capped"}, "target":
     <checked path>} (zero matches included); the result's first line names
     the device, the path, the match count and the files searched and says
     the paths are relative to the path, and the agent's `relpath:line: text`
     lines follow verbatim. A capped search's first line says more matches
     exist; an uncapped one never does. An ok frame without that record is
     not confirmed and files nothing.
  C3 an agent that predates fs.search ("unknown capability") is stated as
     predating code search, naming machine_update; no fact. Any other refusal
     is the agent's own words, no "predates", no fact.
  C4 the description states the form of a hit (relpath:line: text), that
     .gitignore is honoured, the 200 default / 2000 ceiling on max_matches,
     the literal switch, and that device_read_file's start_line/end_line reads
     the context around a hit. Pins (other files): registry 61 -> 62,
     reads_only + device_search, live_facts NOT_AUTO_RUN with its reason,
     capability coverage EXCUSED.

Design calls (Assumptions):
  - The schema mirrors the agent's (T6): ignore_case is offered too — the
    agent takes it, and leaving it out would make her emulate it with (?i).
    max_matches's bounds are the agent's SearchMaxMatches (2000), checked by
    dispatch's schema before any frame.
  - Fact numbers (matches, capped) come from meta only; files_scanned is
    read for the result line but not filed. Only matches/files_scanned/capped
    are read from meta (T1 VERIFY: never ok/exit_code).
  - Old agent = "unknown capability" (caps.go Dispatch), as T5.
  - An ok frame without the record mirrors T5 choice 2: "not confirmed", no
    fact — a search result with no counts is never presented as complete.
  - No Tool.backs: no claim kind reads a search yet ("I searched X" is not a
    guarded claim); the fact is filed so a later guard can.
  - live_facts: NOT_AUTO_RUN (unlike device_read_file): a walk of a tree may
    run to the agent's command deadline on the owner's machine, past
    CHECK_TIMEOUT — the device_info refresh trap (S42b Task 21) — and its
    pattern is free text a note would choose.
  - Capability coverage: EXCUSED — capability_claim_check returns None on
    "I can't search files on your computer" / "I can't search your code"
    today; a row belongs with paired negatives in test_capability_guard.py.
"""

from __future__ import annotations

import asyncio
import dataclasses

import pytest

from app import tools
from tests.conftest import requires_db
from tests.test_devices_ws import _close, _connect, _ctx, _person

pytestmark = requires_db

_PATH = "/home/sam/nova/services/core/app/chat.py"
_OLD_AGENT_WHOLE_FILE = "WHOLE-FILE-BODY-FROM-AN-OLD-AGENT\n" * 20


@pytest.fixture(autouse=True)
def _no_checkout(monkeypatch):
    """The outside-worktree flag is not under test here; keep it off."""
    monkeypatch.delenv("NOVA_CHECKOUT", raising=False)
    monkeypatch.delenv("NOVA_REPO_HOST", raising=False)


async def _call(
    pool,
    conn,
    device,
    tool,
    args,
    *,
    ok=True,
    output="",
    exit_code=0,
    error=None,
    meta=None,
    envelopes=None,
    undo_sink=None,
):
    """Dispatch `tool` and answer the one command frame it sends — with
    `meta` on the result frame when given, and NO meta key when None (an
    agent that predates S30a). Returns (result, ok, facts, the frame's args);
    the args are {} when no frame was sent."""
    person = await _person(pool)
    facts: list[dict] = []
    seen: dict = {}

    async def answer():
        frame = await asyncio.wait_for(conn.next_sent(), 2)
        assert frame["type"] == "command"
        seen.update(frame["envelope"]["args"])
        if envelopes is not None:
            envelopes.append(frame["envelope"])
        reply = device.result(
            frame["envelope"], ok=ok, output=output, exit_code=exit_code, error=error
        )
        if meta is not None:
            reply["meta"] = meta
        conn.feed(reply)

    ans = asyncio.create_task(answer())
    ctx = _ctx(person, facts=facts)
    if undo_sink is not None:
        ctx = dataclasses.replace(ctx, undo_sink=undo_sink)
    result, dispatched_ok = await tools.dispatch(tool, args, ctx)
    if seen:
        await asyncio.wait_for(ans, 2)
    else:
        ans.cancel()
    return result, dispatched_ok, facts, seen


def _files(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "file" in f]


def _read_tool():
    return tools.REGISTRY["device_read_file"]


# -- C1: the schema offers ranges, and the frame carries exactly them ---------


def test_c1_the_schema_offers_line_and_byte_ranges_and_requires_neither():
    params = _read_tool().parameters
    props = params["properties"]
    for name in ("start_line", "end_line", "offset", "length"):
        assert name in props, f"device_read_file has no {name!r} argument"
        assert props[name]["type"] == "integer", name
    assert sorted(params["required"]) == ["device", "path"]


async def test_c1_a_line_range_is_forwarded_to_fs_read_beside_the_checked_path(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    _result, _ok, _facts, sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "mini", "path": _PATH, "start_line": 1200, "end_line": 1260},
        output="line\n",
        meta={
            "bytes_total": 340_000,
            "lines_total": 9000,
            "range": {"start_line": 1200, "end_line": 1260},
            "eof": False,
        },
    )
    assert sent == {"path": _PATH, "start_line": 1200, "end_line": 1260}
    await _close(conn, task)


async def test_c1_a_byte_range_is_forwarded_and_no_range_sends_the_path_alone(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    _result, _ok, _facts, sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "mini", "path": _PATH, "offset": 300_000, "length": 4096},
        output="x",
        meta={"bytes_total": 340_000, "range": {"offset": 300_000, "length": 4096}, "eof": False},
    )
    assert sent == {"path": _PATH, "offset": 300_000, "length": 4096}
    _r, _o, _f, plain = await _call(
        pool, conn, device, "device_read_file", {"device": "mini", "path": _PATH}, output="x"
    )
    assert plain == {"path": _PATH}
    await _close(conn, task)


# -- C2: the read fact carries the range and the total -------------------------


async def test_c2_an_ok_ranged_read_files_range_and_bytes_total_and_states_the_size(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    rng = {"start_line": 1200, "end_line": 1260}
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "mini", "path": _PATH, **rng},
        output="async def _run_turn(...):\n",
        meta={"bytes_total": 341_207, "lines_total": 8834, "range": rng, "eof": False},
    )
    assert ok is True, result
    assert _files(facts) == [
        {
            "file": {"op": "read", "device": "mini", "range": rng, "bytes_total": 341_207},
            "target": _PATH,
        }
    ]
    assert "async def _run_turn" in result
    assert "341207" in result.replace(",", ""), result
    assert "8834" in result.replace(",", ""), result
    await _close(conn, task)


async def test_c2_a_range_past_the_end_is_stated(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    rng = {"start_line": 9000, "end_line": 9100}
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "mini", "path": _PATH, **rng},
        output="",
        meta={"bytes_total": 341_207, "lines_total": 8834, "range": rng, "eof": True},
    )
    assert ok is True, result
    assert "past the end" in result, result
    assert _files(facts)[0]["file"]["range"] == rng
    await _close(conn, task)


# -- C3: an agent that predates range reads is detected, never believed --------


def _says_update(result: str) -> bool:
    return "predates range reads" in result and "machine_update" in result


async def test_c3_an_old_agent_that_ignored_the_range_is_stated_not_believed(pool):
    _id, device, conn, task = await _connect(pool, name="dell")
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "dell", "path": _PATH, "start_line": 10, "end_line": 20},
        output=_OLD_AGENT_WHOLE_FILE,
        meta=None,
    )
    assert ok is False, result
    assert _says_update(result), result
    assert "WHOLE-FILE-BODY" not in result
    assert _files(facts) == []
    await _close(conn, task)


async def test_c3_an_old_agents_whole_file_cap_refusal_is_stated_as_predating(pool):
    _id, device, conn, task = await _connect(pool, name="dell")
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "dell", "path": _PATH, "offset": 0, "length": 4096},
        ok=False,
        exit_code=None,
        error="file is 341207 bytes, over the 256 KiB read cap",
    )
    assert ok is False
    assert _says_update(result), result
    assert _files(facts) == []
    await _close(conn, task)


async def test_c3_a_new_agents_range_refusal_is_its_own_words(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    said = "the range is 300000 bytes, over the 256 KiB read cap"
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "mini", "path": _PATH, "offset": 0, "length": 300_000},
        ok=False,
        exit_code=None,
        error=said,
    )
    assert sent.get("length") == 300_000, "the range never reached the agent"
    assert ok is False
    assert said in result
    assert "predates" not in result
    assert _files(facts) == []
    await _close(conn, task)


# -- C4: the description states where the cap applies --------------------------


def test_c4_the_description_says_the_cap_applies_to_the_range():
    text = _read_tool().description
    assert "start_line" in text and "end_line" in text, text
    assert "range" in text.lower() and "256 KiB" in text, text
    assert "Files larger than" not in text, text


# -- COVERAGE additions (T3) -----------------------------------------------------


async def test_c1_a_range_below_its_minimum_is_refused_before_any_frame(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    for bad in ({"start_line": 0, "end_line": 5}, {"offset": -1, "length": 10}):
        result, ok, facts, sent = await _call(
            pool, conn, device, "device_read_file", {"device": "mini", "path": _PATH, **bad}
        )
        assert ok is False, (bad, result)
        assert sent == {}, f"{bad} reached the agent"
        assert _files(facts) == []
    await _close(conn, task)


async def test_c2_the_fact_files_the_agents_range_echo_not_the_request(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    echoed = {"start_line": 5, "end_line": 9, "as_read": True}
    _result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "mini", "path": _PATH, "start_line": 5, "end_line": 9},
        output="x\n",
        meta={"bytes_total": 10, "range": echoed, "eof": False},
    )
    assert ok is True
    assert _files(facts)[0]["file"]["range"] == echoed
    await _close(conn, task)


# The raw spelling of _PATH that _check_fs_path normalizes (posixpath.normpath):
# a fact's target must be the CHECKED path the agent was sent, never the arg.
_UNNORMALIZED = "/home/sam/nova/services/./core/app/../app/chat.py"


async def test_c2_a_ranged_read_fact_targets_the_checked_path_not_the_argument(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    rng = {"start_line": 5, "end_line": 9}
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_read_file",
        {"device": "mini", "path": _UNNORMALIZED, **rng},
        output="x\n",
        meta={"bytes_total": 10, "range": rng, "eof": False},
    )
    assert ok is True, result
    assert sent["path"] == _PATH
    assert [f["target"] for f in _files(facts)] == [_PATH]
    await _close(conn, task)


# == T5: device_edit_file ========================================================

_REPO = "/home/sam/nova"
_EDIT_META = {"matches": 1, "bytes_before": 341_207, "bytes_after": 341_219}


def _edit_tool():
    tool = tools.REGISTRY.get("device_edit_file")
    assert tool is not None, "device_edit_file is not registered"
    return tool


def _edits(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "edit" in f]


def _flags(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "outside_worktree" in f]


def _edit_args(device: str, path: str = _PATH) -> dict:
    return {"device": device, "path": path, "old": "def _old():", "new": "def _new():"}


# -- C1: the tool, its frame, and the outside-worktree flag ----------------------


def test_t5_c1_the_tool_takes_device_path_old_new_and_changes_something():
    tool = _edit_tool()
    params = tool.parameters
    assert set(params["properties"]) == {"device", "path", "old", "new"}
    for name in ("path", "old", "new"):
        assert params["properties"][name]["type"] == "string", name
    assert sorted(params["required"]) == ["device", "new", "old", "path"]
    assert tool.reads_only is False
    assert tool.ephemeral is False


async def test_t5_c1_an_edit_sends_fs_edit_with_exactly_path_old_new(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    envelopes: list[dict] = []
    _result, ok, _facts, sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit_args("mini"),
        output=f"edited {_PATH}: replaced 1 match (341207 -> 341219 bytes)",
        meta=_EDIT_META,
        envelopes=envelopes,
    )
    assert ok is True, _result
    assert [e["capability"] for e in envelopes] == ["fs.edit"]
    assert sent == {"path": _PATH, "old": "def _old():", "new": "def _new():"}
    await _close(conn, task)


async def test_t5_c1_an_edit_outside_her_worktree_is_made_and_warned(pool, monkeypatch):
    # _connect enrolls every device with hostname "host".
    monkeypatch.setenv("NOVA_CHECKOUT", _REPO)
    monkeypatch.setenv("NOVA_REPO_HOST", "host")
    _id, device, conn, task = await _connect(pool, name="mini")
    path = f"{_REPO}/services/core/app/chat.py"
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit_args("mini", path),
        output=f"edited {path}: replaced 1 match (341207 -> 341219 bytes)",
        meta=_EDIT_META,
    )
    assert ok is True, result
    assert result.splitlines()[-1].startswith(f"Warning: this touched the live checkout {_REPO}")
    assert "start_change" in result.splitlines()[-1]
    assert _flags(facts) == [{"outside_worktree": _REPO, "tool": "device_edit_file"}]
    await _close(conn, task)


async def test_t5_c1_an_edit_inside_her_worktree_is_not_flagged(pool, monkeypatch):
    monkeypatch.setenv("NOVA_CHECKOUT", _REPO)
    monkeypatch.setenv("NOVA_REPO_HOST", "host")
    _id, device, conn, task = await _connect(pool, name="mini")
    path = f"{_REPO}/.worktrees/nova-a1b2c3/services/core/app/chat.py"
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit_args("mini", path),
        output=f"edited {path}: replaced 1 match (341207 -> 341219 bytes)",
        meta=_EDIT_META,
    )
    assert ok is True, result
    assert "Warning:" not in result
    assert _flags(facts) == []
    assert len(_edits(facts)) == 1
    await _close(conn, task)


# -- C2: the edit fact, a count refusal, an agent that predates fs.edit ----------


async def test_t5_c2_an_ok_edit_files_the_edit_fact_and_states_both_sizes(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit_args("mini"),
        output=f"edited {_PATH}: replaced 1 match (341207 -> 341219 bytes)",
        meta=_EDIT_META,
    )
    assert ok is True, result
    assert _edits(facts) == [
        {
            "edit": {
                "device": "mini",
                "matches": 1,
                "bytes_before": 341_207,
                "bytes_after": 341_219,
            },
            "target": _PATH,
        }
    ]
    assert _files(facts) == []
    first = result.splitlines()[0]
    assert _PATH in first and "mini" in first, result
    flat = result.replace(",", "")
    assert "341207" in flat and "341219" in flat, result
    await _close(conn, task)


async def test_t5_c2_a_count_refusal_is_the_agents_words_and_files_nothing(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    said = (
        f"found 2 matches of 'old' in {_PATH}; fs.edit changes exactly one "
        "(include more surrounding text to make it unique)"
    )
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit_args("mini"),
        ok=False,
        exit_code=None,
        error=said,
    )
    assert sent.get("old") == "def _old():", "the edit never reached the agent"
    assert ok is False
    assert said in result
    assert "predates" not in result
    assert _edits(facts) == []
    await _close(conn, task)


async def test_t5_c2_an_agent_that_predates_fs_edit_is_stated_as_needing_an_update(pool):
    _id, device, conn, task = await _connect(pool, name="dell")
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit_args("dell"),
        ok=False,
        exit_code=None,
        error='unknown capability "fs.edit"',
    )
    assert sent, "the edit never reached the agent"
    assert ok is False
    assert "predates" in result and "machine_update" in result, result
    assert _edits(facts) == []
    await _close(conn, task)


# -- C4: the description states what the edit keeps; nothing claimable is undone --


def test_t5_c4_the_description_states_the_rule_the_cap_and_what_is_not_kept():
    text = _edit_tool().description
    lower = text.lower()
    assert "exactly one" in lower, text
    assert "16 MiB" in text, text
    assert "permission" in lower, text
    for not_kept in ("owner", "setuid", "hard link", "extended attribute"):
        assert not_kept in lower, f"the description does not say {not_kept!r} is not kept"


async def test_t5_c4_an_ok_edit_records_nothing_to_undo_and_has_no_revert(pool):
    assert _edit_tool().revert is None
    _id, device, conn, task = await _connect(pool, name="mini")
    sink: list = []
    result, ok, _facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit_args("mini"),
        output=f"edited {_PATH}: replaced 1 match (341207 -> 341219 bytes)",
        meta=_EDIT_META,
        undo_sink=sink,
    )
    assert ok is True, result
    assert sink == []
    await _close(conn, task)


# -- COVERAGE additions (T5) -----------------------------------------------------


@pytest.mark.parametrize(
    "meta",
    [
        None,  # no meta key at all
        {},
        {"matches": 1, "bytes_before": 341_207},  # bytes_after missing
        {"matches": True, "bytes_before": 341_207, "bytes_after": 341_219},  # a bool
        {"matches": 1, "bytes_before": "341207", "bytes_after": 341_219},  # a string
    ],
)
async def test_t5_c2_an_ok_frame_without_the_edit_record_is_unconfirmed_and_files_nothing(
    pool, meta
):
    """GREEN choice 2: an ok frame whose meta lacks the agent's edit record
    is never read as an edit — the call fails saying the change is not
    confirmed, and no fact is filed for a guard to believe."""
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit_args("mini"),
        output=f"edited {_PATH}",
        meta=meta,
    )
    assert sent, "the edit never reached the agent"
    assert ok is False, result
    assert "not confirmed" in result and _PATH in result, result
    assert "Edited" not in result
    assert _edits(facts) == [] and _files(facts) == []
    await _close(conn, task)


@pytest.mark.parametrize(
    "old,new",
    [("", "x"), (None, "x"), (7, "x"), ("def _old():", None), ("def _old():", 7)],
)
async def test_t5_c1_old_and_new_must_be_strings_and_old_non_empty_before_any_frame(pool, old, new):
    _id, device, conn, task = await _connect(pool, name="mini")
    args = {"device": "mini", "path": _PATH, "old": old, "new": new}
    result, ok, facts, sent = await _call(pool, conn, device, "device_edit_file", args)
    assert ok is False, result
    assert sent == {}, "a malformed edit reached the agent"
    assert _edits(facts) == []
    await _close(conn, task)


async def test_t5_c1_a_refused_edit_outside_her_worktree_still_carries_the_flag(pool, monkeypatch):
    """The frame reached the live checkout, so the flag and warning stand
    even when the agent refused the edit."""
    monkeypatch.setenv("NOVA_CHECKOUT", _REPO)
    monkeypatch.setenv("NOVA_REPO_HOST", "host")
    _id, device, conn, task = await _connect(pool, name="mini")
    path = f"{_REPO}/services/core/app/chat.py"
    said = f"found 0 matches of 'old' in {path}; fs.edit changes exactly one"
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit_args("mini", path),
        ok=False,
        exit_code=None,
        error=said,
    )
    assert ok is False
    assert said in result
    assert result.splitlines()[-1].startswith(f"Warning: this touched the live checkout {_REPO}")
    assert _flags(facts) == [{"outside_worktree": _REPO, "tool": "device_edit_file"}]
    assert _edits(facts) == []
    await _close(conn, task)


async def test_t5_c2_the_edit_fact_targets_the_checked_path_not_the_argument(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_edit_file",
        _edit_args("mini", _UNNORMALIZED),
        output=f"edited {_PATH}: replaced 1 match (341207 -> 341219 bytes)",
        meta=_EDIT_META,
    )
    assert ok is True, result
    assert sent["path"] == _PATH
    assert [f["target"] for f in _edits(facts)] == [_PATH]
    await _close(conn, task)


# == T7: device_search ===========================================================

_TREE = "/home/sam/nova/services/core"
_TREE_UNNORMALIZED = "/home/sam/nova/services/./core/app/.."
_HITS = "app/guards.py:812: class _SpanScrub:\napp/chat.py:4410:     scrub = _SpanScrub(span)\n"
_SEARCH_META = {"matches": 2, "files_scanned": 431, "capped": False}


def _search_tool():
    tool = tools.REGISTRY.get("device_search")
    assert tool is not None, "device_search is not registered"
    return tool


def _searches(facts: list[dict]) -> list[dict]:
    return [f for f in facts if "search" in f]


def _search_args(device: str, path: str = _TREE, **extra) -> dict:
    return {"device": device, "path": path, "pattern": "_SpanScrub", **extra}


# -- C1: the tool, its frame, and what is refused before one ----------------------


def test_t7_c1_the_tool_takes_a_tree_and_a_pattern_and_only_reads():
    tool = _search_tool()
    params = tool.parameters
    props = params["properties"]
    assert set(props) == {
        "device",
        "path",
        "pattern",
        "literal",
        "ignore_case",
        "max_matches",
    }
    assert props["path"]["type"] == "string"
    assert props["pattern"]["type"] == "string"
    assert props["literal"]["type"] == "boolean"
    assert props["ignore_case"]["type"] == "boolean"
    assert props["max_matches"]["type"] == "integer"
    assert props["max_matches"]["minimum"] == 1
    assert props["max_matches"]["maximum"] == 2000
    assert sorted(params["required"]) == ["device", "path", "pattern"]
    assert tool.reads_only is True
    assert tool.ephemeral is True


async def test_t7_c1_a_search_sends_fs_search_with_the_path_and_pattern_alone(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    envelopes: list[dict] = []
    result, ok, _facts, sent = await _call(
        pool,
        conn,
        device,
        "device_search",
        _search_args("mini"),
        output=_HITS,
        meta=_SEARCH_META,
        envelopes=envelopes,
    )
    assert ok is True, result
    assert [e["capability"] for e in envelopes] == ["fs.search"]
    assert sent == {"path": _TREE, "pattern": "_SpanScrub"}
    await _close(conn, task)


async def test_t7_c1_the_optional_keys_given_are_forwarded_exactly(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, _facts, sent = await _call(
        pool,
        conn,
        device,
        "device_search",
        _search_args("mini", literal=True, ignore_case=False, max_matches=50),
        output=_HITS,
        meta=_SEARCH_META,
    )
    assert ok is True, result
    assert sent == {
        "path": _TREE,
        "pattern": "_SpanScrub",
        "literal": True,
        "ignore_case": False,
        "max_matches": 50,
    }
    await _close(conn, task)


@pytest.mark.parametrize(
    "extra",
    [{"pattern": ""}, {"max_matches": 0}, {"max_matches": 2001}],
)
async def test_t7_c1_an_empty_pattern_or_a_bad_max_is_refused_before_any_frame(pool, extra):
    _search_tool()  # an unregistered tool is refused too; that proves nothing here
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, sent = await _call(
        pool, conn, device, "device_search", {**_search_args("mini"), **extra}
    )
    assert ok is False, result
    assert sent == {}, "a malformed search reached the agent"
    assert _searches(facts) == []
    await _close(conn, task)


async def test_t7_c1_a_search_of_the_live_checkout_is_a_read_and_not_flagged(pool, monkeypatch):
    monkeypatch.setenv("NOVA_CHECKOUT", _REPO)
    monkeypatch.setenv("NOVA_REPO_HOST", "host")
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_search",
        _search_args("mini", f"{_REPO}/services/core"),
        output=_HITS,
        meta=_SEARCH_META,
    )
    assert sent, "the search never reached the agent"
    assert ok is True, result
    assert "Warning:" not in result
    assert _flags(facts) == []
    await _close(conn, task)


# -- C2: the search fact, the result's head line, the capped case -----------------


async def test_t7_c2_an_ok_search_files_the_search_fact_and_states_the_counts(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_search",
        _search_args("mini"),
        output=_HITS,
        meta=_SEARCH_META,
    )
    assert ok is True, result
    assert _searches(facts) == [
        {"search": {"device": "mini", "matches": 2, "capped": False}, "target": _TREE}
    ]
    assert _files(facts) == [] and _edits(facts) == []
    first = result.splitlines()[0]
    assert "mini" in first and _TREE in first, result
    assert "2 matches" in first, result
    assert "431 files" in first, result
    assert "relative to" in first, result
    assert _HITS.strip() in result
    assert "more matches exist" not in result
    await _close(conn, task)


async def test_t7_c2_a_capped_search_says_more_matches_exist(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    output = _HITS + "[stopped at max_matches 2; more matches exist]\n"
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_search",
        _search_args("mini", max_matches=2),
        output=output,
        meta={"matches": 2, "files_scanned": 40, "capped": True},
    )
    assert ok is True, result
    assert _searches(facts) == [
        {"search": {"device": "mini", "matches": 2, "capped": True}, "target": _TREE}
    ]
    assert "more matches exist" in result.splitlines()[0], result
    await _close(conn, task)


async def test_t7_c2_no_match_is_a_fact_too(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, _sent = await _call(
        pool,
        conn,
        device,
        "device_search",
        _search_args("mini"),
        output="[no matches in 431 files searched]\n",
        meta={"matches": 0, "files_scanned": 431, "capped": False},
    )
    assert ok is True, result
    assert _searches(facts) == [
        {"search": {"device": "mini", "matches": 0, "capped": False}, "target": _TREE}
    ]
    assert "0 matches" in result.splitlines()[0], result
    await _close(conn, task)


@pytest.mark.parametrize(
    "meta",
    [
        None,  # no meta key at all
        {},
        {"matches": 2, "files_scanned": 431},  # capped missing
        {"matches": True, "files_scanned": 431, "capped": False},  # a bool count
        {"matches": "2", "files_scanned": 431, "capped": False},  # a string count
        {"matches": 2, "files_scanned": 431, "capped": "no"},  # capped not a bool
        # COVERAGE (T7): files_scanned is on the head line, so it is checked too
        {"matches": 2, "capped": False},  # files_scanned missing
        {"matches": 2, "files_scanned": "431", "capped": False},  # a string count
    ],
)
async def test_t7_c2_an_ok_frame_without_the_search_record_is_unconfirmed(pool, meta):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_search",
        _search_args("mini"),
        output=_HITS,
        meta=meta,
    )
    assert sent, "the search never reached the agent"
    assert ok is False, result
    assert "not confirmed" in result and _TREE in result, result
    assert _searches(facts) == []
    await _close(conn, task)


async def test_t7_c2_the_search_fact_targets_the_checked_path_not_the_argument(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_search",
        _search_args("mini", _TREE_UNNORMALIZED),
        output=_HITS,
        meta=_SEARCH_META,
    )
    assert ok is True, result
    assert sent["path"] == _TREE
    assert [f["target"] for f in _searches(facts)] == [_TREE]
    await _close(conn, task)


# -- C3: an agent that predates fs.search; the agent's own refusals --------------


async def test_t7_c3_an_agent_that_predates_fs_search_is_stated_as_needing_an_update(pool):
    _id, device, conn, task = await _connect(pool, name="dell")
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_search",
        _search_args("dell"),
        ok=False,
        exit_code=None,
        error='unknown capability "fs.search"',
    )
    assert sent, "the search never reached the agent"
    assert ok is False
    assert "predates code search" in result and "machine_update" in result, result
    assert _searches(facts) == []
    await _close(conn, task)


async def test_t7_c3_a_new_agents_refusal_is_its_own_words(pool):
    _id, device, conn, task = await _connect(pool, name="mini")
    said = f"{_TREE} is not a directory"
    result, ok, facts, sent = await _call(
        pool,
        conn,
        device,
        "device_search",
        _search_args("mini"),
        ok=False,
        exit_code=None,
        error=said,
    )
    assert sent, "the search never reached the agent"
    assert ok is False
    assert said in result
    assert "predates" not in result
    assert _searches(facts) == []
    await _close(conn, task)


# -- C4: the description -----------------------------------------------------------


def test_t7_c4_the_description_states_the_hit_form_the_caps_and_the_next_read():
    text = _search_tool().description
    lower = text.lower()
    assert "relpath:line: text" in text or "path:line: text" in text, text
    assert ".gitignore" in text, text
    assert "200" in text and "2000" in text, text
    assert "literal" in lower, text
    assert "device_read_file" in text and "start_line" in text, text
