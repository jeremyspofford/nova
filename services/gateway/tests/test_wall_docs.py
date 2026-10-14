"""deploy/README.md's credit-wall paragraph, pinned to the code it describes
(epic wall-probe, T7).

The owner reads the README to learn why chat passed a provider over and when
it will be tried again. Each fact the paragraph states is one the gateway
owns, so each is checked against the code here rather than trusted:

- the two example reasons are what routing.walled_words writes for them;
- the tick (wall_probe.PROBE_TICK_S), the hour (WALL_PROBE_EVERY_S), the
  ledger purpose (wall_probe.PURPOSE), the credit status
  (wall_probe.CREDIT_STATUSES), the wall statuses and the wall ladder
  (routing.WALL_STATUSES, routing.WALL_STEPS_S);
- the "wall lifted by probe" log line the paragraph quotes is one
  wall_probe.py writes;
- the honest limit: a 1-token check proves the provider serves, not that it
  affords a whole reply;
- where the refusal time is shown: a chat turn's walled reason (the
  gateway's walled verdict), Settings -> Routing's walls list, and Nova's own
  machine words (core model_machines, machine_status and About) - each claim
  backed by the source that shows it, and never "every walled reason" (the
  Inbox money finding and the About page's machine card carry no time).

routing.py's module docstring is pinned the same way: the account statuses
wall the provider on WALL_STEPS_S, a 5xx walls the model on OUTAGE_STEPS_S,
and a served probe lifts a wall as a clean completion does.

No database: these read files and module attributes only.
"""

from __future__ import annotations

import inspect
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app import routing, wall_probe

REPO = Path(__file__).resolve().parents[3]
README = REPO / "deploy" / "README.md"

HEADING = "## Which model answers chat"
BULLET = "- **A provider out of credit is re-checked, and lifts itself.**"

# The examples' moments, as the README states them.
REFUSED = datetime(2026, 10, 13, 17, 59, 24, tzinfo=UTC)
PROBED = datetime(2026, 10, 14, 9, 12, 40, tzinfo=UTC)
NOW = datetime(2026, 10, 14, 9, 20, tzinfo=UTC)
LEFT = timedelta(minutes=41, seconds=30)  # walled_words says 42 min


def _section() -> str:
    """The section's lines after its heading, up to the next `## ` heading.
    The README must have exactly one."""
    lines = README.read_text(encoding="utf-8").splitlines()
    starts = [i for i, line in enumerate(lines) if line.rstrip() == HEADING]
    assert len(starts) == 1, f"deploy/README.md has {len(starts)} `{HEADING}` sections, not one"
    body = lines[starts[0] + 1 :]
    end = next((i for i, line in enumerate(body) if line.startswith("## ")), len(body))
    return "\n".join(body[:end])


def _paragraph() -> str:
    """The credit-wall bullet (with its sub-bullets and follow-on paragraph),
    whitespace collapsed so a phrase wrapped across lines still matches."""
    section = _section()
    assert section.count(BULLET) == 1, f"`{HEADING}` has no single credit-wall bullet"
    start = section.index(BULLET)
    rest = section[start + len(BULLET) :]
    nxt = re.search(r"^- \*\*", rest, flags=re.MULTILINE)
    text = BULLET + (rest[: nxt.start()] if nxt else rest)
    return " ".join(text.split())


def _wall(reason: str, *, probed_at: datetime | None) -> dict:
    return {
        "reason": reason,
        "refused_at": REFUSED,
        "probed_at": probed_at,
        "walled_until": NOW + LEFT,
    }


def test_the_never_retried_example_is_what_walled_words_writes():
    words = routing.walled_words(
        _wall("openrouter refused (402): Insufficient credits", probed_at=None), now=NOW
    )
    assert "not retried since" in words
    assert f"`{words}`" in _paragraph()


def test_the_probed_not_served_example_is_what_walled_words_writes():
    words = routing.walled_words(_wall("…", probed_at=PROBED), now=NOW)
    assert "last probed at" in words
    assert f"`{words}`" in _paragraph()


def test_the_tick_and_the_hour_are_the_codes():
    text = _paragraph()
    tick = wall_probe.PROBE_TICK_S
    assert f"Every {tick // 60} minutes ({tick} s)" in text
    hour = {3600: "in the last hour"}[wall_probe.WALL_PROBE_EVERY_S]
    assert f"no refusal and no check {hour}" in text


def test_the_ledger_purpose_is_the_codes():
    assert f"with purpose `{wall_probe.PURPOSE}`" in _paragraph()


def test_the_statuses_and_the_ladder_are_the_codes():
    text = _paragraph()
    (credit,) = wall_probe.CREDIT_STATUSES
    assert f"for credit ({credit})" in text
    others = sorted(routing.WALL_STATUSES - wall_probe.CREDIT_STATUSES)
    for status in others:
        assert str(status) in text, f"the README does not name wall status {status}"
    hours = [s // 3600 for s in routing.WALL_STEPS_S]
    assert hours[0] == 1
    ladder = f"for an hour, then {hours[1]} hours, then {hours[2]} while it keeps refusing"
    assert ladder in text
    assert f"its next step ({hours[1]} hours, then {hours[2]})" in text


# ── what a probe's answer does to the wall: wall_probe.tick, case by case ──


def test_a_probe_refused_for_credit_rewalls_and_stays_a_credit_wall():
    # tick: a status in routing.WALL_STATUSES -> routing.record_refusal; the
    # stored status stays 402, so due_walls (CREDIT_STATUSES) probes it again.
    text = _paragraph()
    (credit,) = wall_probe.CREDIT_STATUSES
    assert credit in routing.WALL_STATUSES
    assert f"**It refuses for credit again ({credit}):** that counts as a new refusal." in text
    assert "It is still a credit wall, so it is checked again an hour after that." in text


def test_a_probe_refused_for_a_key_or_a_rate_is_no_longer_a_credit_wall():
    # tick runs record_refusal for ANY wall status, which stores that status:
    # a 401/403/429 wall is not in CREDIT_STATUSES, so due_walls never picks it.
    kinds = {401: "key", 403: "key", 429: "rate limit"}
    others = routing.WALL_STATUSES - wall_probe.CREDIT_STATUSES
    assert others == set(kinds), "a wall status the README does not name"
    keys = ", ".join(str(s) for s in sorted(s for s in others if kinds[s] == "key"))
    rates = ", ".join(str(s) for s in sorted(s for s in others if kinds[s] == "rate limit"))
    text = _paragraph()
    assert f"**It refuses for a key ({keys}) or a rate limit ({rates}):** that also counts" in text
    assert (
        "a new refusal, of that kind: a strike, the wall's next step, and the check's "
        "time as its refusal time."
    ) in text
    assert "The wall is no longer a credit wall, so it is not checked again;" in text


def test_a_probe_that_fails_otherwise_only_records_the_check_time():
    # tick: not served, not a wall status -> probed_at = now() and nothing else.
    text = _paragraph()
    assert "It fails some other way** (unreachable, a 5xx," in text
    assert "the wall stands as it was and only the check's time is recorded" in text
    assert '("updated_at" if refused else "now()")' in inspect.getsource(wall_probe)


def test_the_quoted_log_line_is_one_the_probe_writes():
    line = "wall lifted by probe"
    assert f'"{line}"' in _paragraph()
    assert line in inspect.getsource(wall_probe)


def test_the_paragraph_states_the_one_token_limit():
    text = _paragraph()
    assert (
        "a 1-token check proves the provider serves, not that it can afford a whole reply" in text
    )
    assert "walls the provider again from the first step (an hour)" in text


# ── routing.py's module docstring: the wall rules, pinned to the constants ──


def _dur(seconds: int) -> str:
    """A ladder step as the docstring writes it: 3600 -> "1 h", 300 -> "5 min",
    60 -> "60 s"."""
    if seconds % 3600 == 0:
        return f"{seconds // 3600} h"
    if seconds % 60 == 0 and seconds > 60:
        return f"{seconds // 60} min"
    return f"{seconds} s"


def _ladder(steps: tuple[int, ...]) -> str:
    return ", then ".join(_dur(s) for s in steps)


def _routing_doc() -> str:
    return " ".join((routing.__doc__ or "").split())


def test_routing_docstring_walls_the_provider_on_an_account_status():
    statuses = "/".join(str(s) for s in sorted(routing.WALL_STATUSES))
    assert (
        f"a {statuses} is about the account, so it walls the whole provider for "
        f"{_ladder(routing.WALL_STEPS_S)} (WALL_STEPS_S)"
    ) in _routing_doc()


def test_routing_docstring_walls_only_the_model_on_a_5xx():
    assert (
        "a 5xx is one model not serving, so it walls only that model for "
        f"{_ladder(routing.OUTAGE_STEPS_S)} (OUTAGE_STEPS_S)"
    ) in _routing_doc()
    # The sentence it replaced said a 5xx walls the provider for hours.
    assert "5xx before the stream — walls the provider" not in _routing_doc()


def test_routing_docstring_says_a_served_probe_lifts_it_too():
    doc = _routing_doc()
    assert "A clean completion lifts the provider's wall and that model's" in doc
    assert "a credit-wall probe the provider served (wall_probe)" in doc
    assert "await routing.note_success(" in inspect.getsource(wall_probe)


def test_routing_docstring_says_a_completion_never_lifts_an_engines_wall():
    # data_plane skips note_success for an engine (is_engine): its wall lapses.
    assert "a completion never lifts an engine's wall: it lapses on its ladder" in (_routing_doc())


# ── where the refusal time is shown: only the surfaces that show it ──


def test_the_refusal_time_is_claimed_only_where_it_is_shown():
    text = _paragraph()
    assert (
        "The reason a chat turn gives for passing a walled provider over says when that "
        "refusal happened, so a wall set yesterday never reads as a fresh one:"
    ) in text
    assert "The list of walls in Settings → Routing shows the same refusal time," in text
    assert (
        "and so does Nova when she describes a walled machine (her `machine_status` answer "
        "and the machines in her About text)."
    ) in text
    assert "The Inbox's money finding and the About page's machine card do not show it." in text


def test_the_every_walled_reason_overclaim_never_comes_back():
    # VERIFY 3/4: the Inbox money finding (core checks/money.py) and the web
    # About page's machine card show a wall with no refusal time.
    readme = " ".join(README.read_text(encoding="utf-8").split()).lower()
    assert "every walled reason" not in readme
    assert "every wall says when" not in readme


def test_each_surface_the_readme_names_shows_the_refusal_time():
    # A chat turn's reason: the walled verdict is walled_words (its examples
    # are pinned above).
    assert '"reason": walled_words(wall)' in inspect.getsource(routing)
    # Settings -> Routing: each wall row renders WallTimes, which says "refused <t>".
    page = (REPO / "apps/web/src/pages/settings/RoutingSection.tsx").read_text(encoding="utf-8")
    assert "<WallTimes wall={w} />" in page
    assert "refused <Stamp iso={wall.refused_at} />" in page
    # Her words: core's remote_words (machine_status and About) adds wall_times,
    # and About's flattened entry carries the times it reads.
    core = REPO / "services/core/app"
    machines = (core / "model_machines.py").read_text(encoding="utf-8")
    assert "times = wall_times(entry)" in machines
    assert "refused at {_utc_minute(refused)}" in machines
    about = (core / "about.py").read_text(encoding="utf-8")
    assert 'for key in ("refused_at", "probed_at"):' in about
    assert "model_machines.remote_words(" in about
