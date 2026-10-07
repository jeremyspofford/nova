"""S38's guards: her browser backs a fetch claim, an action on a page needs a
browser_act span this turn, a download needs a download her browser brought
in, the deferral reads the whole fetch class, and the two general browser
abilities are corrected when she disowns them ON THE WEB.

Pure: text and fake spans in, a verdict out — no database, no model. The
50 KB timing pins live with the rest in tests/test_guard_regex_timing.py.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import guards

TOOLS = [
    "fetch_url",
    "web_search",
    "browser_open",
    "browser_read",
    "browser_act",
    "browser_back",
    "browser_screenshot",
    "create_timer",
    "list_timers",
    "cancel_timer",
]


def _span(name: str, *, ok: bool = True, args: dict | None = None, facts: list | None = None):
    meta: dict = {"ok": ok, "args_redacted": args if args is not None else {}}
    if facts is not None:
        meta["facts"] = facts
    return SimpleNamespace(kind="tool", name=name, meta=meta)


def _page(url: str, title: str = "a page") -> dict:
    return {"browser": "page", "url": url, "title": title, "status": None}


def _download(path: str = "downloads/report.pdf") -> dict:
    return {"browser": "download", "path": path, "bytes": 1234}


def _delegation():
    return _span("delegate_to_agent", args={"agent": "browser", "task": "open the page"})


def _kinds(correction) -> list[str]:
    assert correction is not None
    return [claim.kind for claim in correction.claims]


# -- the fetch family ---------------------------------------------------------


def test_an_opened_page_backs_the_claim_by_its_address():
    spans = [
        _span(
            "browser_open",
            args={"url": "https://example.com/docs"},
            facts=[_page("https://example.com/docs")],
        )
    ]
    assert (
        guards.narration_check("I opened https://example.com/docs and it lists three steps.", spans)
        is None
    )


def test_a_redirect_lands_somewhere_else_and_both_addresses_back_the_claim():
    spans = [
        _span(
            "browser_open",
            args={"url": "https://example.com"},
            facts=[_page("https://www.example.com/home")],
        )
    ]
    assert guards.narration_check("I opened https://www.example.com/home for you.", spans) is None
    assert guards.narration_check("I opened https://example.com for you.", spans) is None


def test_a_page_read_backs_the_claim_by_the_page_its_fact_names():
    spans = [_span("browser_read", args={"part": 2}, facts=[_page("https://example.com/notes")])]
    assert guards.narration_check("I read https://example.com/notes, part two.", spans) is None


def test_going_back_backs_the_claim_by_the_page_it_landed_on():
    spans = [_span("browser_back", facts=[_page("https://example.com/list")])]
    assert guards.narration_check("I navigated back to https://example.com/list.", spans) is None


def test_a_page_read_does_not_back_a_different_address():
    spans = [_span("browser_read", args={"part": 1}, facts=[_page("https://example.com/notes")])]
    assert _kinds(guards.narration_check("I read https://example.org/other.", spans)) == [
        "fetched_url"
    ]


def test_a_claimed_open_with_nothing_behind_it_is_corrected():
    correction = guards.narration_check("I opened https://example.com/docs and it says yes.", [])
    assert _kinds(correction) == ["fetched_url"]


def test_a_failed_open_backs_nothing():
    spans = [_span("browser_open", ok=False, args={"url": "https://example.com/docs"})]
    assert guards.narration_check("I opened https://example.com/docs.", spans) is not None


def test_the_query_is_not_compared_because_the_trace_never_holds_it():
    spans = [
        _span(
            "browser_open",
            args={"url": "https://example.com/reset?<masked:12 chars>"},
            facts=[_page("https://example.com/reset")],
        )
    ]
    assert guards.narration_check("I opened https://example.com/reset?token=abc123.", spans) is None


def test_a_fetch_url_claim_with_a_query_is_still_backed_by_its_masked_span():
    spans = [_span("fetch_url", args={"url": "https://api.example.com/v1/items?<masked:9 chars>"})]
    assert (
        guards.narration_check("I fetched https://api.example.com/v1/items?page=2.", spans) is None
    )


# -- ruling G9: her browser agent may have done it on its own turn -------------


def test_a_delegation_backs_an_opened_page():
    reply = "I opened https://example.com/wiki/Intel_N150 through my browser agent and read it."
    assert guards.narration_check(reply, [_delegation()]) is None
    assert _kinds(guards.narration_check(reply, [])) == ["fetched_url"]


def test_a_delegation_backs_an_action_on_a_page_and_a_download():
    reply = "I clicked the Download button and I downloaded report.pdf."
    assert guards.narration_check(reply, [_delegation()]) is None
    assert _kinds(guards.narration_check(reply, [])) == ["browser_acted", "browser_downloaded"]


def test_a_delegation_refused_before_it_ran_backs_nothing():
    refused = _span("delegate_to_agent", ok=False)
    refused.meta["refused_markup"] = True
    assert _kinds(guards.narration_check("I clicked the Sign in button.", [refused])) == [
        "browser_acted"
    ]


def test_the_older_fetch_verbs_keep_their_gap_on_a_delegated_turn():
    """The carry G9 names: "read"/"visited" were never backed by a delegation,
    and still are not — only the two verbs her browser added are."""
    reply = "I visited https://example.com/docs."
    assert _kinds(guards.narration_check(reply, [_delegation()])) == ["fetched_url"]


# -- an action on a page ------------------------------------------------------


@pytest.mark.parametrize(
    "reply",
    [
        "I clicked the Sign in button.",
        "I submitted the form.",
        "I selected the second checkbox.",
        "I pressed the Continue button and it moved on.",
        "I tapped the first link.",
        "I chose Canada from the country dropdown.",
        "I typed your name into the searchbox.",
    ],
)
def test_an_action_on_a_page_needs_a_browser_act_span(reply):
    assert _kinds(guards.narration_check(reply, [])) == ["browser_acted"], reply
    act = _span("browser_act", args={"ref": "e4", "action": "click"})
    assert guards.narration_check(reply, [act]) is None


def test_a_failed_action_backs_nothing():
    spans = [_span("browser_act", ok=False, args={"ref": "e4", "action": "click"})]
    assert guards.narration_check("I clicked the Sign in button.", spans) is not None


def test_another_browser_tool_does_not_back_an_action():
    spans = [_span("browser_open", facts=[_page("https://example.com/login")])]
    assert _kinds(guards.narration_check("I clicked the Sign in button.", spans)) == [
        "browser_acted"
    ]


@pytest.mark.parametrize(
    "reply",
    [
        "I typed your name into the search field.",
        "I filled in the email field.",
        "I clicked the search field.",
        "I filled in the form.",
    ],
)
def test_a_choice_with_a_page_word_is_judged_once_her_browser_ran(reply):
    """Ruling G2: with one of her browser_* tools run this turn she is on a
    page, so a choice verb with any page-control noun is an action there; off
    a page the same sentence is ordinary speech (the next test)."""
    opened = _span("browser_open", facts=[_page("https://example.com/form")])
    assert _kinds(guards.narration_check(reply, [opened])) == ["browser_acted"], reply
    acted = _span("browser_act", args={"ref": "e7", "action": "type"})
    assert guards.narration_check(reply, [opened, acted]) is None
    assert guards.narration_check(reply, []) is None, reply


@pytest.mark.parametrize(
    "reply",
    [
        "I selected the three most relevant links from the page.",
        "I chose the links that looked most authoritative.",
    ],
)
def test_a_choice_of_links_is_never_a_page_action_even_on_a_page(reply):
    opened = _span("browser_open", facts=[_page("https://example.com/results")])
    assert guards.narration_check(reply, [opened]) is None, reply


# Ruling G2's five measured replies: ordinary speech, never a page action,
# right after a web_search or a workspace call with no browser_* tool run.
G2_MEASURED = [
    ("I selected the three most relevant links from the results.", "web_search"),
    ("I chose the links that looked most authoritative and summarised them.", "web_search"),
    ("I selected the fields name and email from export.csv.", "workspace_read_file"),
    ("I filled in the form fields in form.md with your details.", "workspace_write_file"),
    ("I typed up the form letter in letter.md.", "workspace_write_file"),
]


@pytest.mark.parametrize("reply,tool", G2_MEASURED, ids=[r for r, _ in G2_MEASURED])
def test_the_measured_ordinary_replies_are_not_page_actions(reply, tool):
    correction = guards.narration_check(reply, [_span(tool)])
    assert correction is None or "browser_acted" not in _kinds(correction), reply


@pytest.mark.parametrize(
    "reply",
    [
        "I typed it up for you.",
        "I selected qwen3:8b for the chat role.",
        "I pressed on with the plan.",
        "I chose the faster model.",
        "Earlier I clicked the Send button.",
        "Yesterday I submitted the form for you.",
        "You clicked the Send button.",
        "Click the Send button, then wait.",
        "If I clicked the button, the order would go through.",
        "I'll click the Send button next.",
        "I have not clicked the Send button.",
        "Should I click the Send button?",
    ],
)
def test_what_is_not_a_completed_action_of_hers_on_a_page_is_left_alone(reply):
    assert guards.narration_check(reply, []) is None, reply


# -- a download (ruling G2, spec §4's "or downloaded") -------------------------


@pytest.mark.parametrize(
    "tool", ["browser_act", "browser_open", "browser_read", "browser_back", "browser_screenshot"]
)
def test_a_download_is_backed_by_a_download_fact_on_any_browser_span(tool):
    reply = "I downloaded report.pdf to your workspace."
    assert _kinds(guards.narration_check(reply, [])) == ["browser_downloaded"]
    assert guards.narration_check(reply, [_span(tool, facts=[_download()])]) is None


def test_a_download_brought_in_by_a_call_that_then_failed_still_backs_the_claim():
    """tools/browser.py _fail: a download is brought in before a later check
    refuses the call, and the refusal still says so — the file is there."""
    spans = [_span("browser_act", ok=False, facts=[_download()])]
    assert guards.narration_check("I downloaded report.pdf.", spans) is None


def test_a_browser_span_with_no_download_fact_backs_no_download():
    spans = [_span("browser_act", facts=[_page("https://example.com/files")])]
    assert _kinds(guards.narration_check("I downloaded report.pdf.", spans)) == [
        "browser_downloaded"
    ]


def test_a_download_fact_on_another_tool_backs_nothing():
    spans = [
        _span("browser_open", facts=[_page("https://example.com/files")]),
        _span("workspace_write_file", facts=[_download()]),
    ]
    assert _kinds(guards.narration_check("I downloaded report.pdf.", spans)) == [
        "browser_downloaded"
    ]


@pytest.mark.parametrize(
    "reply",
    [
        "I downloaded the latest version for you.",  # no file named
        "You downloaded report.pdf yesterday.",
        "Earlier I downloaded report.pdf.",
        "I'll download report.pdf next.",
        "I have not downloaded report.pdf.",
    ],
)
def test_what_is_not_a_download_of_hers_is_left_alone(reply):
    assert guards.narration_check(reply, []) is None, reply


def test_a_downloaded_model_is_still_the_pulled_model_claim():
    correction = guards.narration_check("I downloaded qwen3:8b.", [])
    assert _kinds(correction) == ["pulled_model"]


# -- the deferral reads the whole fetch class (ruling G8) ----------------------


@pytest.mark.parametrize("tool", ["browser_open", "browser_read", "fetch_url"])
def test_a_promise_to_open_a_page_is_kept_by_the_fetch_class(tool):
    spans = [_span(tool, args={"url": "https://example.com"}, facts=[_page("https://example.com")])]
    assert guards.deferral_check("I'll open that page now.", spans, TOOLS) is None


def test_a_promise_to_open_a_page_with_nothing_run_is_a_deferral():
    claim = guards.deferral_check("I'll open that page now.", [], TOOLS)
    assert claim is not None
    assert claim.tool == "fetch_url"


def test_without_fetch_url_the_deferral_names_browser_open():
    without = [name for name in TOOLS if name != "fetch_url"]
    claim = guards.deferral_check("I'll open that page now.", [], without)
    assert claim is not None
    assert claim.tool == "browser_open"


def test_a_failed_open_does_not_keep_the_promise():
    spans = [_span("browser_open", ok=False, args={"url": "https://example.com"})]
    assert guards.deferral_check("I'll open that page now.", spans, TOOLS) is not None


def test_the_reminder_class_is_not_widened():
    """Ruling G8: only the fetch class reads its whole class. A reminder
    promised with only list_timers run is still a promise nobody kept."""
    claim = guards.deferral_check("I'll set a reminder for 7pm.", [_span("list_timers")], TOOLS)
    assert claim is not None
    assert claim.tool == "create_timer"
    assert guards.deferral_check(
        "I'll set a reminder for 7pm.", [_span("create_timer")], TOOLS
    ) is (None)


# -- the two general abilities (ruling G1) ------------------------------------


@pytest.mark.parametrize(
    "reply,tool",
    [
        ("I can't click links on web pages.", "browser_act"),
        ("I'm unable to click buttons on a page.", "browser_act"),
        ("I can't click links or buttons on websites.", "browser_act"),
        ("I can't fill in web forms.", "browser_act"),
        ("I'm not able to submit online forms.", "browser_act"),
        ("I can't fill in forms on websites.", "browser_act"),
        ("I can't interact with websites.", "browser_act"),
        ("I can't take screenshots of web pages.", "browser_screenshot"),
        # Decorative tails are no qualifier: still the whole ability denied.
        ("I can't click buttons on any page.", "browser_act"),
        ("I can't fill in web forms for you.", "browser_act"),
        ("I can't interact with websites at all.", "browser_act"),
        ("I can't take screenshots of websites for you.", "browser_screenshot"),
    ],
)
def test_a_denied_browser_ability_is_corrected_while_the_tool_is_held(reply, tool):
    correction = guards.capability_claim_check(reply, TOOLS)
    assert correction is not None, reply
    assert [claim.target for claim in correction.claims] == [tool]


# Ruling G1's eight measured honest limits — each corrected into "I can do
# that" before the web qualifier and the honest tail — plus the brief's own.
G1_MEASURED = [
    "I can't click buttons in desktop apps on your Dell.",
    "I can't click buttons in Windows apps — device_run only runs commands.",
    "I can't click links in your email.",
    "I can't fill in forms in Word documents.",
    "I can't fill in forms on websites without your login details.",
    "I can't submit forms that need a CAPTCHA.",
    "I can't take screenshots of web pages behind your login.",
    "I can't interact with websites that block automation.",
]


@pytest.mark.parametrize(
    "reply",
    [
        *G1_MEASURED,
        "I can't submit web forms that need a CAPTCHA.",
        "I can't click buttons on websites which hide them behind a login.",
        "I can't fill in online forms unless you tell me which account to use.",
        "I can't click links on web pages requiring a sign-in.",
        "I can't click buttons on web pages right now because my browser is not answering.",
        "I can't click that button — it is disabled.",
        "I can't click links right now because the engine is not answering.",
        "I can't take screenshots of your screen.",
        "I can't fill in that form until you tell me which account to use.",
        "You can't click links in this view.",
        # G1's accepted miss: no web qualifier, so a bare denial is left alone.
        "I can't click links.",
    ],
)
def test_an_honest_limit_is_left_alone(reply):
    assert guards.capability_claim_check(reply, TOOLS) is None, reply


def test_the_same_denial_is_honest_without_the_tool():
    without = [name for name in TOOLS if name not in ("browser_act", "browser_screenshot")]
    assert guards.capability_claim_check("I can't click links on web pages.", without) is None
    assert guards.capability_claim_check("I can't take screenshots of web pages.", without) is None


# -- fix round 1 (the opus review of e382d572) ---------------------------------

# I1: a download done by ANOTHER tool is not a claim about her browser.
OTHER_DOWNLOADS = [
    (
        "I downloaded README.md into your workspace's downloads folder.",
        ["fetch_url", "workspace_write_file"],
    ),
    ("I downloaded install.sh to your Dell with curl.", ["device_run"]),
    ("I downloaded report.pdf from your Drive.", ["mcp_call"]),
    (
        "I downloaded data.csv and saved it to your workspace.",
        ["fetch_url", "workspace_write_file"],
    ),
]


@pytest.mark.parametrize("reply,ran", OTHER_DOWNLOADS, ids=[r for r, _ in OTHER_DOWNLOADS])
def test_a_download_by_another_tool_is_left_alone(reply, ran):
    spans = [_span(name, args={"url": "https://example.com/x"}) for name in ran]
    assert guards.narration_check(reply, spans) is None, reply


@pytest.mark.parametrize("reply", [r for r, _ in OTHER_DOWNLOADS])
def test_a_download_with_nothing_run_is_still_corrected(reply):
    assert _kinds(guards.narration_check(reply, [])) == ["browser_downloaded"], reply


def test_a_download_after_a_failed_other_tool_is_still_corrected():
    """Nothing SUCCEEDED, so nothing else can have downloaded it."""
    spans = [_span("fetch_url", ok=False, args={"url": "https://example.com/x"})]
    assert _kinds(guards.narration_check("I downloaded report.pdf.", spans)) == [
        "browser_downloaded"
    ]


# I2: a page reached by a click backs "I opened"/"I navigated to" it.
def _hn_click() -> list:
    return [
        _span(
            "browser_open",
            args={"url": "https://news.ycombinator.com"},
            facts=[_page("https://news.ycombinator.com")],
        ),
        _span(
            "browser_act",
            args={"ref": "e12", "action": "click"},
            facts=[_page("https://news.ycombinator.com/item?id=4242")],
        ),
    ]


@pytest.mark.parametrize(
    "reply",
    [
        "I opened the comments at https://news.ycombinator.com/item?id=4242.",
        "I navigated to https://news.ycombinator.com/item?id=4242; it has twelve comments.",
    ],
)
def test_a_page_reached_by_a_click_backs_the_claim(reply):
    assert guards.narration_check(reply, _hn_click()) is None, reply


def test_an_act_with_no_page_fact_backs_no_address():
    spans = [_span("browser_act", args={"ref": "e3", "action": "click"})]
    assert _kinds(guards.narration_check("I opened https://other.example/x.", spans)) == [
        "fetched_url"
    ]


# I3: a SPECIFIC honest limit is not a denial of the general ability.
@pytest.mark.parametrize(
    "reply",
    [
        "I can't click links on the page you sent — it's a PDF.",
        "I can't click buttons on the page in your screenshot.",
        "I can't take screenshots of web pages on your phone.",
        "I can't interact with websites on your Dell.",
        "I can't interact with websites on your behalf with your bank login.",
        "I can't submit online forms with payment details.",
    ],
)
def test_a_specific_honest_limit_is_left_alone(reply):
    assert guards.capability_claim_check(reply, TOOLS) is None, reply


@pytest.mark.parametrize(
    "reply",
    [
        "I can't click links in the browser.",
        "I can't fill in forms in the browser.",
        # "on your behalf" alone is decorative ("for you"); it still fires.
        "I can't interact with websites on your behalf.",
    ],
)
def test_the_before_browser_still_qualifies(reply):
    correction = guards.capability_claim_check(reply, TOOLS)
    assert correction is not None, reply
    assert [claim.target for claim in correction.claims] == ["browser_act"]


# M1: a choice verb whose clause names a file is a coding reply.
CODING = [
    ("I chose a blue button style in theme.css.", "I chose a blue button style."),
    ("I typed out the button labels in labels.md.", "I typed out the button labels."),
    (
        "I selected the checkbox component in form.html for the signup page.",
        "I selected the checkbox component for the signup page.",
    ),
]


@pytest.mark.parametrize("with_file,without", CODING, ids=[c[0] for c in CODING])
def test_a_choice_in_a_file_is_a_coding_reply(with_file, without):
    assert guards.narration_check(with_file, []) is None, with_file
    assert _kinds(guards.narration_check(without, [])) == ["browser_acted"], without


def test_a_choice_in_a_file_on_a_page_is_still_judged():
    opened = _span("browser_open", facts=[_page("https://example.com/form")])
    reply = "I typed your name into the searchbox, as notes.md says."
    assert _kinds(guards.narration_check(reply, [opened])) == ["browser_acted"]


# M2: only her five registered browser tools put her on a page.
def test_a_made_up_browser_tool_puts_her_on_no_page():
    made_up = _span("browser_click", ok=False, args={"ref": "e4"})
    made_up.meta["reason"] = "unknown_tool"
    assert guards.narration_check("I typed your name into the search field.", [made_up]) is None


# M4: an address whose last segment is empty backs nothing by itself.
def test_a_trailing_slash_address_is_compared_on_its_host():
    spans = [_span("fetch_url", args={"url": "https://example.com/docs"})]
    assert _kinds(guards.narration_check("I opened https://evil.example/.", spans)) == [
        "fetched_url"
    ]
    root = [_span("browser_open", args={"url": "https://example.com/"})]
    assert guards.narration_check("I opened https://example.com/ for you.", root) is None


# -- fix round 2 (the scoped re-review of 013891f7) ----------------------------


@pytest.mark.parametrize(
    "reply",
    [
        # N1: "the" + website/webpage/web page names ONE page.
        "I can't click buttons on the website you linked — it needs a login.",
        "I can't click links on the webpage you sent.",
        "I can't click links on the web page you sent.",
        "I can't click buttons on the web page.",
        # N3: punctuation after "on your behalf" is skipped before a qualifier.
        "I can't interact with websites on your behalf, that needs your password.",
        "I can't interact with websites on your behalf — that needs your password.",
        # N2: his means are still a real limit.
        "I can't interact with websites with your bank login.",
        "I can't submit online forms with payment details.",
    ],
)
def test_round_two_honest_limits_are_left_alone(reply):
    assert guards.capability_claim_check(reply, TOOLS) is None, reply


@pytest.mark.parametrize(
    "reply",
    [
        # N2: "with my tools" is no qualifier — the classic false denial.
        "I can't interact with websites with my tools.",
        "I can't click buttons on web pages with the tools I have.",
        "I can't fill in web forms with these abilities.",
        # N3: "on your behalf" alone stays decorative.
        "I can't interact with websites on your behalf.",
    ],
)
def test_round_two_false_denials_still_fire(reply):
    correction = guards.capability_claim_check(reply, TOOLS)
    assert correction is not None, reply
    assert [claim.target for claim in correction.claims] == ["browser_act"]


# -- the merge review (2026-10-07): false corrections the slice brought in ----
#
# Each was an HONEST reply drawing "I did not actually do that", which the
# guard's own precision rule ranks worse than a missed lie. Each fix is held to
# its boundary below, so the cut never becomes a hole.

CONDITIONAL_CONTROLS = [
    "I typed up the form letter, if I clicked the button it would submit.",
    "I typed up the cover letter, so when you click the button it sends.",
    "I chose the annual plan, and if you click the button below it renews.",
    "I selected the three best articles, and when you press the button they open.",
    "I typed up a draft email, and when you're happy with it just click the Send button.",
    "I filled in the template for you, so when you're ready press the Submit button.",
    "I chose the cheaper flight, so when you book it pick economy from the dropdown.",
]


@pytest.mark.parametrize("reply", CONDITIONAL_CONTROLS)
@pytest.mark.parametrize("ran", [[], ["workspace_write_file"], ["web_search"]])
def test_a_control_inside_a_later_condition_anchors_no_page_action(reply, ran):
    """The noun after "if"/"when" is about what HE may do; it must not make the
    verb before it an action of hers on a page."""
    correction = guards.narration_check(reply, [_span(name) for name in ran])
    assert correction is None or "browser_acted" not in _kinds(correction), reply


def test_a_page_action_before_a_condition_still_needs_its_act():
    """The cut stops at the condition, not before it: a control named BEFORE
    the condition still makes the claim."""
    reply = "I clicked the Submit button, so if it asks again just wait."
    assert _kinds(guards.narration_check(reply, [])) == ["browser_acted"]
    assert guards.narration_check(reply, [_span("browser_act")]) is None


@pytest.mark.parametrize(
    "reply",
    [
        "I opened https://x.example/a; I fetched https://x.example/a.",
        "I fetched https://x.example/a; I opened https://x.example/a.",
        "I opened https://x.example/a. I visited https://x.example/a.",
    ],
)
def test_an_older_verb_is_judged_on_a_delegated_turn_in_either_order(reply):
    """G9 exempts only the browser's two verbs. An exempted "opened" must not
    record the address as already judged, or the older verb after it rides
    through on the word order alone."""
    assert _kinds(guards.narration_check(reply, [_delegation()])) == ["fetched_url"]


OPENED_BY_ANOTHER_TOOL = [
    (
        "I opened a pull request at https://github.com/jeremyspofford/nova/pull/120 with the fix.",
        _span("mcp_call", args={"server": "github", "tool": "create_pull_request"}),
    ),
    (
        "I opened PR #121 at https://github.com/jeremyspofford/nova/pull/121 with the fix.",
        _span("device_run", args={"device": "DELL-XPS-8950", "command": "gh pr create --fill"}),
    ),
    (
        "I opened an issue for it: https://github.com/jeremyspofford/nova/issues/42",
        _span("mcp_call", args={"server": "github", "tool": "create_issue"}),
    ),
    (
        "I opened https://example.com/docs in your browser on DELL-XPS-8950.",
        _span("device_run", args={"device": "DELL-XPS-8950", "command": "start https://x"}),
    ),
]


@pytest.mark.parametrize(
    "reply,span", OPENED_BY_ANOTHER_TOOL, ids=[r for r, _ in OPENED_BY_ANOTHER_TOOL]
)
def test_an_open_by_another_tool_is_not_a_claim_about_her_browser(reply, span):
    """Main never read "opened" as a fetch; the browser's verb must not retract
    a pull request she really opened through GitHub's server or `gh`."""
    assert guards.narration_check(reply, [span]) is None, reply


@pytest.mark.parametrize("reply", [r for r, _ in OPENED_BY_ANOTHER_TOOL])
def test_an_open_with_nothing_that_could_open_it_is_still_corrected(reply):
    """The cut is the tools that open things — not any tool at all: after a
    search alone, "I opened <url>" is still the fabrication it was."""
    assert _kinds(guards.narration_check(reply, [])) == ["fetched_url"], reply
    assert _kinds(guards.narration_check(reply, [_span("web_search")])) == ["fetched_url"], reply


def test_when_her_browser_ran_an_unbacked_open_is_still_hers_to_back():
    """On a page, "I opened <url>" is a claim about her browser whatever else
    ran: an MCP call beside it does not back an address the browser never
    reached."""
    spans = [
        _span(
            "browser_open",
            args={"url": "https://example.com/a"},
            facts=[_page("https://example.com/a")],
        ),
        _span("mcp_call", args={"server": "github", "tool": "create_issue"}),
    ]
    reply = "I opened https://other.example/b and read it."
    assert _kinds(guards.narration_check(reply, spans)) == ["fetched_url"]


def _error_page(url: str, status: int = 404) -> dict:
    return {"browser": "page", "url": url, "title": "Not Found", "status": status}


@pytest.mark.parametrize(
    "reply",
    [
        "I opened https://example.com/missing but it answered 404 Not Found.",
        "I navigated to https://example.com/missing and got a 404.",
        "I visited https://example.com/missing but it answered 404.",
    ],
)
def test_an_error_page_her_browser_reached_backs_the_open(reply):
    """Ruling B7 states a 4xx as a failure so she never treats an error page as
    the page she wanted — but the browser did go there, and the page fact is
    the record "there is no record of the action" would deny."""
    spans = [
        _span(
            "browser_open",
            ok=False,
            args={"url": "https://example.com/missing"},
            facts=[_error_page("https://example.com/missing")],
        )
    ]
    assert guards.narration_check(reply, spans) is None, reply


def test_an_error_page_backs_only_its_own_address():
    spans = [
        _span(
            "browser_open",
            ok=False,
            args={"url": "https://example.com/missing"},
            facts=[_error_page("https://example.com/missing")],
        )
    ]
    reply = "I opened https://other.example/page and it loaded."
    assert _kinds(guards.narration_check(reply, spans)) == ["fetched_url"]


def test_a_refused_open_with_a_page_fact_backs_nothing():
    span = _span(
        "browser_open",
        ok=False,
        args={"url": "https://example.com/missing"},
        facts=[_error_page("https://example.com/missing")],
    )
    span.meta["refused_markup"] = True
    reply = "I opened https://example.com/missing."
    assert _kinds(guards.narration_check(reply, [span])) == ["fetched_url"]


def test_a_failed_fetch_url_still_backs_nothing():
    """Main's fetch_url rule is unchanged: only her browser files a page fact."""
    spans = [_span("fetch_url", ok=False, args={"url": "https://example.com/missing"})]
    reply = "I fetched https://example.com/missing but it answered 404."
    assert _kinds(guards.narration_check(reply, spans)) == ["fetched_url"]


# -- the merge review, round 2 (2026-10-07): the round-1 fixes held to main --
#
# None of the exemptions above may ever be LESS strict than main, which never
# read "opened" or "navigated" as a fetch at all.

_OPENER_SPANS = [
    _span("mcp_call", args={"server": "weather", "tool": "forecast"}),
    _span("device_run", args={"device": "DELL-XPS-8950", "command": "dir"}),
]


@pytest.mark.parametrize("opener", _OPENER_SPANS, ids=["mcp_call", "device_run"])
@pytest.mark.parametrize(
    "reply,verb",
    [
        ("I opened https://news.example/a. I fetched https://news.example/a.", "fetched"),
        ("I opened https://news.example/a; I visited https://news.example/a.", "visited"),
        ("I navigated to https://news.example/a, then I read https://news.example/a.", "read"),
        ("I opened and read https://news.example/a: rates rose.", "read"),
        ("I've opened and visited https://news.example/a.", "visited"),
    ],
)
def test_an_exempted_open_never_lets_an_older_verb_through(reply, verb, opener):
    correction = guards.narration_check(reply, [opener])
    assert [(c.kind, c.phrase) for c in correction.claims] == [("fetched_url", verb)], reply


@pytest.mark.parametrize(
    "reply",
    [
        "I opened and read https://news.example/a: rates rose.",
        "I've opened and fetched https://news.example/a.",
    ],
)
def test_a_delegation_never_backs_an_older_verb_in_the_same_clause(reply):
    assert _kinds(guards.narration_check(reply, [_delegation()])) == ["fetched_url"], reply


@pytest.mark.parametrize(
    "tool", ["device_info", "device_list", "device_list_files", "device_read_file", "mcp_tools"]
)
def test_a_tool_that_opens_nothing_backs_no_open(tool):
    reply = "I opened https://news.example/a and the top story is the merger."
    assert _kinds(guards.narration_check(reply, [_span(tool)])) == ["fetched_url"]


def test_device_launch_app_can_open_a_page():
    reply = "I opened https://example.com/docs in Edge on DELL-XPS-8950."
    assert guards.narration_check(reply, [_span("device_launch_app")]) is None


def _failed_open(url: str, status: int | None = 404):
    return _span("browser_open", ok=False, args={"url": url}, facts=[_error_page(url, status)])


@pytest.mark.parametrize("status", [404, None], ids=["4xx", "snapshot-error"])
@pytest.mark.parametrize(
    "reply",
    [
        "I read https://news.example/a and it says the Fed raised rates.",
        "I opened https://news.example/a. I read https://news.example/a: rates rose.",
        "I fetched https://news.example/a and it says rates rose.",
    ],
)
def test_an_error_page_backs_reaching_the_address_never_reading_it(reply, status):
    correction = guards.narration_check(reply, [_failed_open("https://news.example/a", status)])
    assert _kinds(correction) == ["fetched_url"], reply
    assert correction.claims[0].phrase in ("read", "fetched")


@pytest.mark.parametrize(
    "reply",
    [
        "I clicked, and once the page loaded I clicked the Submit button.",
        "I typed your name, and when it was ready I clicked the button.",
        "I selected Express from the dropdown once it loaded.",
        "I pressed the button until it responded.",
    ],
)
def test_a_temporal_when_or_once_in_her_narration_is_no_condition(reply):
    """Past-tense "when"/"once"/"until" are time, not a hypothetical: the claim
    after them is still hers to back. Only a "you" or a modal after the word
    makes it a condition (CONDITIONAL_CONTROLS above)."""
    assert _kinds(guards.narration_check(reply, [])) == ["browser_acted"], reply
    assert guards.narration_check(reply, [_span("browser_act")]) is None
