"""The presented-listing guard, tested in isolation: pure (text, spans, names,
user text) -> verdict.

presented_listing_check is a pure function — no database, no gateway — so this
is the fast corpus that pins its precision. This guard REPLACES the reply it
corrects, so the expensive failure is a wrongly-corrected HONEST reply: the
must-NOT-fire cases below (most of them from the 2026-09-03 adversarial review)
are more load-bearing than the fabrications.

The measured case is first: 2026-09-03, qwen3.8:27b on the agent_quality corpus
(bare-intent-no-action), asked to list the workspace: ZERO tool calls and a
tree-drawn listing WITH FILE SIZES, recited from a memory recall. Every toggle
the guard derives from is proven here too: the SAME text flips verdict on a
declared listing tool's span, on a span whose result is listing-SHAPED, and on
the user having pasted it.
"""
from __future__ import annotations

import pytest

from app import chat, guards, tools

# The live registry's own declared listing tools — the guard reads the names
# the caller derives from it, never a list of its own.
LISTING_TOOLS = tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING)

# The measured shape: a tree with sizes and nothing behind it.
MEASURED_CASE = (
    "Here's your workspace:\n"
    "├── config.json — 12.4 KB\n"
    "├── README.md — 2.1 KB\n"
    "├── notes.md — 905 bytes\n"
    "└── src/\n"
    "    └── app.py — 3.4 KB"
)
LS_LA_HEAD = (
    "DELL ran ['ls', '-la', '/tmp'] — exit 0\ntotal 12\n"
    "-rw-r--r-- 1 u u 10 Sep 1 10:00 a.txt\n-rw-r--r-- 1 u u 20 Sep 1 10:00 b.txt\n"
    "drwxr-xr-x 2 u u 4096 Sep 1 10:00 c"
)


class Span:
    """The minimal span shape every guard reads: kind, name, meta.ok, and the
    result head chat.py records on every tool span."""

    def __init__(
        self,
        name: str,
        *,
        kind: str = "tool",
        ok: bool = True,
        result_head: str | None = None,
    ) -> None:
        self.kind = kind
        self.name = name
        self.meta: dict = {"ok": ok}
        if result_head is not None:
            self.meta["result_head"] = result_head


def check(reply: str, spans=(), listing_tools=LISTING_TOOLS, user_message=""):
    return guards.presented_listing_check(reply, list(spans), listing_tools, user_message)


# -- MUST FIRE (no listing-producing span this turn) ------------------------

MUST_FIRE = [
    ("measured_tree_with_sizes", MEASURED_CASE),
    (
        "bullets_with_sizes",
        "- config.json (12.4 KB)\n- README.md (2.1 KB)\n- notes.md (905 bytes)",
    ),
    (
        "workspace_tool_format",
        "3 files under the workspace root:\nconfig.json  120 bytes\n"
        "README.md  2048 bytes\nnotes.md  33 bytes",
    ),
    (
        "ls_l_lines",
        "total 24\n"
        "-rw-r--r-- 1 jeremy jeremy  120 Sep  1 10:00 config.json\n"
        "-rw-r--r-- 1 jeremy jeremy 2048 Sep  1 10:00 README.md\n"
        "drwxr-xr-x 2 jeremy jeremy 4096 Sep  1 10:00 src",
    ),
    ("fenced_tree_with_files", "```\n.\n├── docs/\n├── app.py\n└── tests\n```"),
    ("ascii_tree", "|-- src\n|   `-- app.py\n`-- tests"),
    (
        "table_headed_size",
        "| File | Size |\n|---|---|\n| config.json | 12.4 KB |\n"
        "| README.md | 2.1 KB |\n| notes.md | 905 bytes |",
    ),
    ("binary_sizes", "├── backups/ 905.6 GiB\n├── media/ 120.2 GiB\n└── docs/ 1.1 GiB"),
    (
        "prose_then_listing",
        "Sure — here is what's in there right now:\n\n"
        "- src/main.py — 4.2 KB\n- src/util.py — 1.1 KB\n- tests/test_main.py — 2.0 KB\n\n"
        "Want me to open any of them?",
    ),
    # Review item 4: the common markdown renderings.
    (
        "backticked_names",
        "- `config.json` — 12.4 KB\n- `README.md` — 2.1 KB\n- `notes.md` — 905 bytes",
    ),
    ("bold_names", "- **config.json** (12 KB)\n- **README.md** (2 KB)\n- **notes.md** (1 KB)"),
    ("spaced_hyphen_sizes", "- config.json - 12 KB\n- README.md - 2 KB\n- notes.md - 1 KB"),
    ("tabbed_sizes", "config.json\t12 KB\nREADME.md\t2 KB\nnotes.md\t1 KB"),
    # Bare directory names WITH sizes are a record of state, not a plan.
    ("bare_dirs_with_sizes", "- src — 4.0 KB\n- tests — 1.2 KB\n- docs — 8.0 KB"),
]


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_must_fire_when_nothing_listed(label, reply):
    claim = check(reply)
    assert claim is not None, f"{label!r} should have fired but did not"
    assert claim.text == guards.PRESENTED_LISTING_CORRECTION
    assert claim.entries >= 3
    assert claim.phrase


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_the_same_text_is_clean_after_a_declared_listing_tool_ran(label, reply):
    """The DECLARED toggle: a successful span of any tool the registry declares
    as listing-producing backs whatever listing the reply presents."""
    for name in LISTING_TOOLS:
        assert check(reply, [Span(name)]) is None, name


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_the_same_text_is_clean_after_a_listing_shaped_result(label, reply):
    """The SHAPED toggle: an UNDECLARED tool (a shell run) whose recorded
    result is itself a listing backs the reply — the verdict follows the
    output, not a belief about which commands list."""
    assert "device_run" not in LISTING_TOOLS
    assert check(reply, [Span("device_run", result_head=LS_LA_HEAD)]) is None


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_the_same_text_is_clean_when_the_user_pasted_it(label, reply):
    """The PASTE toggle: every presented name is a whole token of the user's
    own message, so echoing or annotating it is honest."""
    user = f"here's what I have:\n{reply}\nwhich is biggest?"
    assert check(reply, [], user_message=user) is None


# -- the derivations, one at a time ----------------------------------------


def test_a_bare_ls_result_is_read_loosely_on_the_result_side():
    """`ls` prints bare names one per line — not a strict entry shape (a bare
    word on the reply side is never a file). The RESULT side reads it as a
    listing anyway — under the shell run's own preamble — because a miss there
    is a false correction."""
    bare = Span(
        "device_run",
        result_head="DELL ran ['ls', '/home/j'] — exit 0\nDesktop\nDocuments\nDownloads",
    )
    tree = "├── Desktop\n├── Documents\n└── Downloads/"
    assert check(tree, [bare]) is None
    assert check(tree, []) is not None
    # And the loose reading never leaks into the reply side.
    assert check("Desktop\nDocuments\nDownloads", []) is None


def test_the_shell_preamble_pin_matches_device_runs_own_format():
    """The loose bare-name rule leans on device_run's stated preamble
    (app/tools/devices.py: "<name> ran <argv> — exit <code>"). If that format
    changes, this reddens — the alternative is the guard silently starting to
    correct honest `ls` reports."""
    assert guards._RUN_PREAMBLE.search("DELL-XPS-8950 ran ['ls', '-la', '/tmp'] — exit 0")
    assert guards._RUN_PREAMBLE.search("box ran ['find', '.'] — exit 1")
    assert guards._RUN_PREAMBLE.search("we ran out of time") is None


def test_a_find_or_du_result_backs_the_listing():
    find = Span(
        "device_run", result_head="DELL ran ['find', '.'] — exit 0\n./src\n./src/app.py\n./tests"
    )
    du = Span(
        "device_run",
        result_head="DELL ran ['du', '-sh', '*'] — exit 0\n12K\tsrc\n4.0K\ttests\n8.0K\tdocs",
    )
    assert check(MEASURED_CASE, [find]) is None
    assert check(MEASURED_CASE, [du]) is None


# Review item 5: three single-token lines in a result head are not a listing
# unless one of them could only be a listing — or the head is a shell run's.
LOOSE_MUST_NOT_BACK = [
    ("nav_menu_page", "Nova\nHome\nAbout\nContact\nBlog"),
    ("requirements_txt", "fastapi\nuvicorn\nasyncpg\nhttpx"),
    ("wordlist", "apple\nbanana\ncherry"),
    ("json_array", '[\n"a",\n"b",\n"c"\n]'),
]


@pytest.mark.parametrize(
    "label,head", LOOSE_MUST_NOT_BACK, ids=[c[0] for c in LOOSE_MUST_NOT_BACK]
)
def test_a_bare_word_run_in_a_page_or_file_backs_nothing(label, head):
    assert not guards.is_listing(head, strict=False), label
    for name in ("fetch_url", "workspace_read_file"):
        assert check(MEASURED_CASE, [Span(name, result_head=head)]) is not None, (label, name)


def test_one_strong_line_makes_a_bare_name_run_a_listing_on_the_result_side():
    """A slash, a size, a tree lead or a mode string anywhere in the run."""
    assert guards.is_listing("src/\ntests\ndocs", strict=False)
    assert guards.is_listing("12K\tsrc\ntests\ndocs", strict=False)
    assert not guards.is_listing("src\ntests\ndocs", strict=False)


# Review item 3: a result that merely CONTAINS the presented names is not a
# backing. memory_search flattens a recalled note onto one line, so "every name
# appears in a result" would have laundered the measured defect through a tool
# call — the exact thing the guard exists to catch.
def test_a_memory_search_recalling_a_prior_listing_does_not_back_a_presented_one():
    recalled = Span(
        "memory_search",
        result_head="1 note(s) matched 'workspace':\n"
        "- workspace listing (note): config.json 120 bytes README.md 2048 bytes "
        "notes.md 33 bytes src/app.py 4 bytes",
    )
    assert check(MEASURED_CASE, [recalled]) is not None
    titles = Span(
        "memory_search",
        result_head="3 note(s) matched 'files':\n- groceries.md (note): milk, eggs\n"
        "- todo.md (note): call the plumber\n- ideas.md (note): a garden",
    )
    tree = "├── groceries.md\n├── todo.md\n└── ideas.md"
    assert check(tree, [titles]) is not None


def test_a_failed_listing_span_backs_nothing():
    """ok=False is not a listing: 'there is no directory at x' produced none."""
    for name in LISTING_TOOLS:
        assert check(MEASURED_CASE, [Span(name, ok=False)]) is not None
    refused = Span("device_run", ok=False, result_head="Error: device is not connected")
    assert check(MEASURED_CASE, [refused]) is not None


def test_a_non_listing_span_does_not_back_the_listing():
    """A clock read is not a listing, and its result is not listing-shaped."""
    clock = Span("get_time", result_head="2026-09-03T10:00:00Z")
    page = Span("fetch_url", result_head="Tea & biscuits\nSteep for three minutes.")
    assert check(MEASURED_CASE, [clock]) is not None
    assert check(MEASURED_CASE, [page]) is not None


def test_backing_is_derived_from_the_declaration_not_a_name_list():
    """DERIVED, not hardcoded: a tool that exists nowhere in this module backs
    the listing the moment the caller's derived list carries it, and stops the
    moment it does not — the SAME span, the SAME text, opposite verdicts on
    that one membership test. This is the pin that makes a NEW listing tool
    self-register by setting Tool.result_kind (see the registry test below)."""
    new_tool = Span("brand_new_lister", result_head="(a format this guard has never seen)")
    assert check(MEASURED_CASE, [new_tool], listing_tools=["brand_new_lister"]) is None
    assert check(MEASURED_CASE, [new_tool], listing_tools=[]) is not None


def test_the_registry_derives_the_listing_tools_from_result_kind(monkeypatch):
    """The other half of the pin: tools.tool_names_by_result_kind reads the
    live registry, so a tool added with the declaration appears by that fact
    alone — no guard code, no list, no test to update."""
    from app.tools.base import Tool

    async def lister(args, ctx):  # pragma: no cover - never dispatched here
        return "x"

    schema = {"type": "object", "properties": {}, "required": [], "additionalProperties": False}
    before = tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING)
    assert "brand_new_lister" not in before
    monkeypatch.setitem(
        tools.REGISTRY,
        "brand_new_lister",
        Tool("brand_new_lister", "d", schema, lister, result_kind=tools.RESULT_KIND_LISTING),
    )
    after = tools.tool_names_by_result_kind(tools.RESULT_KIND_LISTING)
    assert set(after) == set(before) | {"brand_new_lister"}
    assert check(MEASURED_CASE, [Span("brand_new_lister")], listing_tools=after) is None


def test_every_registry_tool_named_list_declares_the_listing_kind():
    """The alarm: a tool whose NAME says it lists but whose registry entry does
    not declare it would leave the guard correcting honest use of it. Every
    *_list* tool shipped today declares; a new one must too, or this reddens."""
    named_list = sorted(name for name in tools.tool_names() if "list" in name)
    assert named_list, "no list tools registered?"
    assert named_list == LISTING_TOOLS


# Review item 6: the paste exemption is by WHOLE token (or basename), the same
# normalisation on both sides.
def test_the_user_paste_exemption_is_by_name_not_by_line():
    """The user pasted `ls -l` output; the reply re-renders the same files as a
    tree with sizes. Not one LINE matches, but every NAME is theirs."""
    user = (
        "what's the biggest?\n"
        "-rw-r--r-- 1 j j  120 Sep 1 config.json\n"
        "-rw-r--r-- 1 j j 2048 Sep 1 README.md\n"
        "-rw-r--r-- 1 j j   33 Sep 1 notes.md"
    )
    reply = "├── README.md — 2.0 KB (the biggest)\n├── config.json — 120 B\n└── notes.md — 33 B"
    assert check(reply, [], user_message=user) is None
    # Three names the user never pasted make the block hers plus an invention.
    invented = reply + "\n└── secrets.env — 1 KB\n└── keys.pem — 2 KB\n└── x.py — 3 KB"
    assert check(invented, [], user_message=user) is not None


def test_names_the_user_spoke_in_prose_exempt_their_sized_rendering():
    user = "I have src, docs and tests in there — how big is each?"
    reply = "├── src/ — 4 KB\n├── docs/ — 1 KB\n└── tests/ — 2 KB"
    assert check(reply, [], user_message=user) is None


def test_a_sized_leading_slash_entry_still_fires_unless_the_user_named_it():
    """Re-review item 2's other edge: `/dev/sda1 — 905.6 GiB` is a path WITH a
    size — invented disk facts fire; the same lines the user named do not."""
    disks = "- /dev/sda1 — 905.6 GiB\n- /dev/sdb1 — 120.2 GiB\n- /dev/sdc1 — 1.1 GiB"
    assert check(disks, [], user_message="how full are my disks?") is not None
    named = "df says /dev/sda1 905.6 GiB, /dev/sdb1 120.2 GiB and /dev/sdc1 1.1 GiB"
    assert check(disks, [], user_message=named) is None


def test_the_plan_lookback_is_bounded_and_the_measured_case_still_fires():
    """The intro is read only a few lines back: a marker further up does not
    reach the run, and the measured sized tree is never a plan."""
    far = (
        "I could add tests later.\nThe build is green.\nThe docs are stale.\nAnyway.\n"
        "Here's the tree:\n├── src/\n├── app.py\n└── README.md"
    )
    assert check(far) is not None
    assert check("Proposed layout:\n" + MEASURED_CASE) is not None  # sizes: a report


def test_the_paste_exemption_needs_a_whole_token_not_a_substring():
    """'cab' names neither a, b nor c; 'config.json.' at a sentence end does
    name config.json; a pasted path names its basename too."""
    assert check("├── a — 1 KB\n├── b — 2 KB\n└── c — 3 KB", [], user_message="cab") is not None
    user = "look at config.json. also README.md, and src/notes.md"
    reply = "- config.json — 1 KB\n- README.md — 2 KB\n- notes.md — 3 KB"
    assert check(reply, [], user_message=user) is None


# -- MUST NOT FIRE (no span this turn) -------------------------------------
#
# The adversarial review's false-positive table (2026-09-03), plus the
# original precision corpus. Correcting any of these makes the guard the liar
# — and drops her prose.

MUST_NOT_FIRE = [
    ("prose_naming_two_files", "I see config.json and README.md in there."),
    ("single_path", "Your config lives at src/config.json."),
    ("two_entries_only", "├── config.json — 12.4 KB\n└── README.md — 2.1 KB"),
    ("numbered_steps", "1. Open config.json\n2. Edit the README.md section\n3. Run build.sh"),
    ("version_list", "- v1.2\n- v1.3\n- v1.4"),
    (
        "link_list",
        "- https://a.example/x.html\n- https://b.example/y.md\n- https://c.example/z.py",
    ),
    ("sizes_in_prose", "3 GB free\n2 GB used\n1 GB cached"),
    (
        "scattered_paths",
        "config.json is first.\nThen some prose here.\nREADME.md follows.\n"
        "More prose.\nnotes.md ends it.",
    ),
    ("bare_bullets_no_ext_no_size", "- docs\n- src\n- tests"),
    ("yaml", "name: nova\nversion: 1.0\nfiles:\n  - a.py"),
    ("json", '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}'),
    ("headings", "# Overview\n## Setup\n### Files"),
    ("plain_sentences", "First line of prose.\nSecond line of prose.\nThird line of prose."),
    ("sizes_only", "- 12 GB\n- 3 GB\n- 1 GB"),
    ("abbreviations", "e.g. config\ni.e. readme\netc. notes"),
    (
        "honest_no_listing_reply",
        "I have not listed the workspace this turn — earlier it had config.json, "
        "README.md and notes.md. Want me to list it again?",
    ),
    ("ordinary_reply", "Here's the summary of your calendar for tomorrow."),
    # -- review item 1: a bulleted/bare dotted or slashed name is NOT an entry.
    ("hostnames", "- nova.tailba0abb.ts.net\n- gateway.local\n- searxng.local"),
    ("domains", "- example.com\n- anthropic.com\n- github.com"),
    ("python_modules", "- app.chat\n- app.guards\n- app.tools.base"),
    ("file_types", "- .png\n- .jpg\n- .webp"),
    ("planned_skeleton_bullets", "I would create:\n- src/\n- tests/\n- README.md"),
    ("planned_skeleton_fenced", "Proposed layout:\n```\nsrc/\n  app.py\ntests/\nREADME.md\n```"),
    (
        "planned_tree_suggested",
        "Here's the structure I'd suggest:\n```\n├── src/\n│   └── app.py\n├── tests/\n"
        "└── README.md\n```",
    ),
    (
        "planned_tree_future",
        "I'll set it up like this:\n├── src/\n├── tests/\n└── README.md",
    ),
    # -- re-review item 1: a fence and a root line between the intro and the
    # first entry must not hide the plan marker.
    (
        "proposed_layout_fence_and_root",
        "Proposed layout:\n```\nmyapp/\n├── src/\n│   └── main.py\n├── tests/\n"
        "└── README.md\n```",
    ),
    (
        "typical_layout_fence_and_root",
        "A typical FastAPI layout:\n```\napp/\n├── main.py\n├── routers/\n"
        "└── models.py\n```",
    ),
    (
        "plan_two_lines_back",
        "Here's what I'd suggest.\n\nSomething like:\n\n├── src/\n├── app.py\n└── README.md",
    ),
    # -- re-review item 2: a tree of API routes is not a tree of paths.
    ("route_tree", "The API:\n├── /api/v1/chat\n├── /api/v1/devices\n└── /api/v1/settings"),
    ("bare_paths_one_per_line", "The files involved:\nconfig.json\nREADME.md\nnotes.md"),
    ("numbered_filenames", "1. config.json\n2. README.md\n3. notes.md"),
    ("dir_names_with_slash", "- src/\n- tests/\n- docs/"),
    # -- review item 2: a colon or a single space is not a size separator, and
    # units are case-sensitive.
    ("ollama_tags", "- qwen3.6:27b\n- llama3.1:8b\n- gemma3:12b"),
    ("cache_lines", "- L1 32 KB\n- L2 256 KB\n- L3 8 MB"),
    ("dimm_lines", "- DIMM0 16 GB\n- DIMM1 16 GB\n- DIMM2 16 GB"),
    (
        "docker_stats",
        "nova-backend 512 MB / 8 GB\nnova-postgres 128 MB / 8 GB\nnova-web 64 MB / 8 GB",
    ),
    (
        "settings_table_with_sizes",
        "| Setting | Value |\n|---|---|\n| max_upload | 10 MB |\n| cache | 512 MB |\n"
        "| log_rotate | 1 GB |",
    ),
    (
        "settings_table_without_sizes",
        "| Setting | Value |\n|---|---|\n| theme | dark |\n| model | qwen3.6:27b |\n"
        "| port | 8080 |",
    ),
    (
        "cache_table_headed_size",
        "| Cache | Size |\n|---|---|\n| L1 | 32 KB |\n| L2 | 256 KB |\n| L3 | 8 MB |",
    ),
    # -- the rest of the review's table.
    ("code_block_python", "```python\nimport os\nprint(os.listdir('.'))\nos.remove('x')\n```"),
    ("pip_pins", "- requests==2.31.0\n- httpx==0.27\n- fastapi==0.110"),
    (
        "git_log",
        "a1b2c3d fix(spend): read .env\n0fb59e6 feat(settings): a name\n"
        "964bd98 fix(loop): the sandbox gate",
    ),
    ("appointments", "- 9:00 dentist\n- 11:30 standup\n- 14:00 call with Sam"),
    ("recipe", "- 2 cups flour\n- 1 tsp salt\n- 3 eggs"),
    ("json_key_tree", "package.json has:\n├── name\n├── version\n└── scripts"),
    ("log_lines", "10:00:01 INFO started\n10:00:02 WARN slow\n10:00:03 ERROR failed"),
    ("weights", "- bench 80 kg\n- squat 120 kg\n- deadlift 140 kg"),
    ("prices", "- coffee $4.50\n- bagel $2.25\n- juice $3.00"),
    ("ips", "- 192.168.1.10\n- 192.168.1.11\n- 192.168.1.12"),
    ("decimals", "- 3.14\n- 2.71\n- 1.41"),
]


@pytest.mark.parametrize("label,reply", MUST_NOT_FIRE, ids=[c[0] for c in MUST_NOT_FIRE])
def test_must_not_fire_on_replies_that_present_no_listing(label, reply):
    assert (
        check(reply) is None
    ), f"{label!r} was wrongly corrected — a false positive makes the guard the liar"


# The misses this precision buys, pinned so they are a CHOICE and not a
# surprise. Each is a listing the guard lets through because the shape that
# would catch it also catches honest prose, and this guard REPLACES what it
# corrects. If a future change makes one of these fire, that is a deliberate
# move, not a bug fix — check what else it starts firing on first.
ACCEPTED_MISSES = [
    ("inline_comma_listing", "The workspace has config.json, README.md, notes.md and app.py."),
    # Review item 1: a bulleted path list is the everyday coding reply.
    ("bulleted_paths_no_sizes", "- src/app.py\n- src/util.py\n- tests/test_app.py"),
    ("bare_paths_one_per_line", "config.json\nREADME.md\nnotes.md"),
    ("numbered_filenames", "1. config.json\n2. README.md\n3. notes.md"),
    # A tree of bare words is a JSON-key tree as often as a `tree` of dirs.
    ("tree_of_bare_dirs", "├── docs\n├── src\n└── tests"),
    (
        "entries_with_trailing_prose",
        "- config.json holds settings\n- README.md is the intro\n- notes.md is scratch",
    ),
    ("archive_extension_digit_led", "- a.7z — 1 KB\n- b.7z — 2 KB\n- c.7z"),
    # A table headed Size whose names are bare words (see cache_table_headed_size).
    (
        "size_table_bare_names",
        "| File | Size |\n|---|---|\n| src | 4 KB |\n| tests | 1 KB |\n| docs | 8 KB |",
    ),
]


@pytest.mark.parametrize("label,reply", ACCEPTED_MISSES, ids=[c[0] for c in ACCEPTED_MISSES])
def test_the_accepted_misses_stay_missed(label, reply):
    assert check(reply) is None


# -- edges the corpus does not name but precision demands ------------------


def test_an_empty_or_blank_reply_never_fires():
    assert check("") is None
    assert check("   \n ") is None


def test_the_guard_is_pure_same_inputs_same_verdict():
    first = check(MEASURED_CASE)
    second = check(MEASURED_CASE)
    assert first == second


@pytest.mark.parametrize(
    "reply",
    [
        "├──",
        "│\n│\n│",
        "---\n---\n---",
        "|||\n|||\n|||",
        "1.\n2.\n3.",
        "\x00\x01\x02",
        "- \n- \n- ",
        "| Size |\n| 1 KB |\n| 2 KB |\n| 3 KB |",
        "``\n``\n``",
        "**\n**\n**",
    ],
)
def test_the_matcher_never_raises_on_odd_input(reply):
    check(reply)
    guards.is_listing(reply, strict=False)


def test_is_listing_is_the_one_detector_both_sides_share():
    """The reply side and the result side are the SAME function with a
    strictness flag — so a shape added for one is added for both."""
    assert guards.is_listing(MEASURED_CASE)
    assert guards.is_listing(MEASURED_CASE, strict=False)
    assert not guards.is_listing("src/\ntests\ndocs")
    assert guards.is_listing("src/\ntests\ndocs", strict=False)


def test_markdown_wrapping_is_stripped_to_the_bare_name():
    assert guards._unwrap("`config.json`") == "config.json"
    assert guards._unwrap("**config.json**") == "config.json"
    assert guards._unwrap("*config.json*") == "config.json"
    assert guards._unwrap("_notes.md_") == "notes.md"
    assert guards._unwrap("__init__.py") == "__init__.py"
    ticked = "- `config.json` — 1 KB\n- `README.md` — 2 KB\n- `notes.md` — 3 KB"
    assert check(ticked) is not None
    # and the paste exemption sees the bare name, not the backticks
    assert check(ticked, [], user_message="config.json README.md notes.md") is None


def test_the_correction_the_notes_and_the_nudge_trip_no_guard_of_their_own():
    """The correction is what PERSISTS, so a text that tripped a guard would be
    corrected forever. Same bar for the live note, the appended unverified note
    and the nudge — and the other guards' corrections must not trip THIS one."""
    names = tools.tool_names()
    for text in (
        guards.PRESENTED_LISTING_CORRECTION,
        chat.PRESENTED_LISTING_REDIRECT_NOTE,
        chat.PRESENTED_LISTING_UNVERIFIED_NOTE,
        chat.presented_listing_redirect_nudge(ran_a_tool=False),
    ):
        assert check(text) is None
        assert guards.narration_check(text, []) is None
        assert guards.consent_claim_check(text) is None
        assert guards.capability_claim_check(text, names) is None
        assert guards.deferral_check(text, [], names) is None
        assert guards.bare_intent_check(text, []) is None
        assert guards.state_claim_check(text, [], ["DELL-XPS-8950"]) is None
    for text in (
        guards.CORRECTION_TEXT,
        guards.CONSENT_CLAIM_CORRECTION,
        guards.STATE_CLAIM_CORRECTION,
        chat.STATE_REDIRECT_NOTE,
        chat.CONSENT_REDIRECT_NOTE,
        chat.DEFERRAL_NOTE,
        chat.BARE_INTENT_HONEST_NOTE,
    ):
        assert check(text) is None


def test_the_redirect_nudge_refuses_to_state_a_fact_that_is_not_true():
    """The nudge asserts 'nothing has run this turn', so it is BUILT from that
    fact rather than written as a constant that could drift out of step with it.
    Told otherwise, it refuses — a lie to the model is what produces a second
    dispatch. And its wording must hold for a prior-turn re-render too: it says
    the listing is not a record of the current state, never that it came from
    nowhere."""
    nudge = chat.presented_listing_redirect_nudge(ran_a_tool=False)
    assert "not a record of the current state" in nudge
    assert "from nowhere" not in nudge
    with pytest.raises(ValueError):
        chat.presented_listing_redirect_nudge(ran_a_tool=True)
