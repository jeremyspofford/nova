"""S46a T6: the wake-claim guard, tested in isolation — pure (text, spans,
names, purpose) -> verdict.

A wake is measured (T5): machine_wake leaves {machine_wake, outcome,
answered_after_s, …} on its span, and every reading of an agent leaves
{device, connected}. "I woke the box" / "the box is awake now" is a claim
those facts back or do not. Sending is not waking: a packet that left the
relay says nothing about the target, so a reply that turns "sent" into
"woke" is corrected, beside its prose (APPEND-class), with what the turn
does show.

Precision first: every MUST_NOT below is a sentence an honest reply writes —
a send stated as a send, a no-answer, a hedge, a question, a past attempt
named as past, another subject. Documentation names only; no MAC anywhere.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import chat, guards

NAMES = ("box", "hubhost")
MAC = "02:00:5e:10:00:01"


def _span(kind: str, name: str | None, **meta):
    return SimpleNamespace(kind=kind, name=name, meta=dict(meta))


def _wake(machine="box", outcome="no_answer", *, sent=True, answered=None, ok=True, extra=()):
    """machine_wake's span as dispatch records it: its facts, ok or failed."""
    facts = [
        {"device": machine, "connected": answered is not None},
        {
            "machine_wake": machine,
            "attempt": "00000000-0000-0000-0000-000000000001",
            "outcome": outcome,
            "sent": sent,
            "relay": "hubhost" if sent or outcome == "relay_cannot" else None,
            "adapter": "Wi-Fi" if sent else None,
            "answered_after_s": answered,
            "serving_after_s": None,
        },
        *extra,
    ]
    if outcome == "not_asleep":
        facts[0] = {"device": machine, "connected": True}
    return _span("tool", "machine_wake", ok=ok, facts=facts, args_redacted={"machine": machine})


def _status(machine="box", connected=True):
    return _span(
        "tool",
        "machine_status",
        ok=True,
        facts=[{"device": machine, "connected": connected}],
        args_redacted={},
    )


def _check(reply, spans=(), names=NAMES, purpose="chat"):
    return guards.wake_claim_check(reply, list(spans), names, purpose=purpose)


# -- claims with nothing behind them -------------------------------------------

MUST_FIRE = [
    ("i_woke", "I woke the box."),
    ("i_woke_up_the", "I woke up the box, so chat can use it again."),
    ("ive_woken_up", "I've woken the box up."),
    ("is_awake_now", "The box is awake now."),
    ("contracted_awake", "Done — the box's awake."),
    ("woke_up_after", "The box woke up after 40 s."),
    ("came_back_online", "The box came back online."),
    ("is_back_up", "Good news: the box is back up."),
    ("answered_the_wake", "The box answered the wake."),
    ("has_woken", "box has woken."),
    ("second_machine", "hubhost is awake now."),
    ("bold_name", "**The box is awake now.**"),
]


@pytest.mark.parametrize("label,reply", MUST_FIRE, ids=[c[0] for c in MUST_FIRE])
def test_a_wake_claim_with_no_record_this_turn_is_corrected(label, reply):
    claim = _check(reply)
    assert claim is not None, label
    assert claim.machine.casefold() in {"box", "hubhost"}
    assert claim.text.startswith("Correction:")
    assert claim.evidence == "no_record"


MUST_NOT = [
    ("sent_a_packet", "I sent a wake packet to the box."),
    ("sent_wake", "I sent the box a wake at 12:00 UTC from hubhost."),
    ("no_answer", "The box didn't answer within 120 s."),
    ("did_not_wake", "The box did not wake up."),
    ("has_not_woken", "The box has not woken up yet."),
    ("never_came_back", "The box never came back."),
    ("isnt_awake", "The box isn't awake."),
    ("nothing_shows", "Nothing shows the box woke."),
    ("cant_tell", "I can't tell whether the box woke."),
    ("if_it_wakes", "If the box wakes, I'll switch chat back to it."),
    ("once_awake", "Once the box is awake, I'll route to it."),
    ("when_back", "When the box comes back, ask again."),
    ("should_be", "The box should be awake in a minute."),
    ("will_wake", "The box will wake when the packet reaches it."),
    ("question", "Is the box awake now?"),
    ("did_it_question", "Did the box wake up?"),
    ("reported", "You said the box woke up."),
    ("yesterday", "Yesterday the box woke after 12 s."),
    ("dated", "On 2026-09-23 the box came back after 40 s."),
    ("last_attempt", "On the last attempt, the box answered the wake after 40 s."),
    ("trial", "In trial 1 the box woke up."),
    ("check_intent", "Let me check whether the box is awake."),
    ("i_woke_up_early", "I woke up early today."),
    ("my_phone", "My phone woke up."),
    ("other_machine", "The hub is awake."),
    ("not_a_subject_word", "The Boxwood server is awake now."),
    ("fenced", "```\nthe box is awake now\n```"),
    ("quoted", "> the box is awake now"),
]


@pytest.mark.parametrize("label,reply", MUST_NOT, ids=[c[0] for c in MUST_NOT])
def test_an_honest_sentence_about_a_wake_is_left_alone(label, reply):
    assert _check(reply) is None, label


# -- hopes and expectations (T5-T6 fix, VERIFY's honesty probe) ----------------
#
# VERIFY wrote 16 honest replies beside a no_answer wake and one was corrected:
# "Hopefully the Dell is back up soon; I'll check again in a minute." A hope,
# an expectation, or a state named with a future time is no report of the
# state now — the same cut the other guards make for a hedge (the shared
# _DELEGATION_HEDGE, plus the hopes it lacks and a future time after the
# claim). Each is read beside a no_answer wake (VERIFY's setting) and with
# nothing at all; the paired controls below keep the confident forms firing.

HOPED_MUST_NOT = [
    ("hopefully_soon", "Hopefully the box is back up soon; I'll check again in a minute."),
    ("i_hope_soon", "I hope the box is awake soon."),
    ("with_luck", "With luck the box is back online in a minute."),
    ("fingers_crossed_shortly", "Fingers crossed the box is back up shortly."),
    ("i_expect_within", "I expect the box is back up within a minute or two."),
    ("i_expect_it_to_be", "I expect it to be awake in a minute."),
    ("i_expect_name_to_be", "I expect the box to be awake in a minute."),
    ("fingers_crossed_it_wakes", "Fingers crossed it wakes."),
    ("fingers_crossed_name_wakes", "Fingers crossed the box wakes."),
    ("fingers_crossed_awake", "Fingers crossed the box is awake."),
    ("with_any_luck", "With any luck the box is back up by the time you read this."),
    ("im_hoping", "I'm hoping the box is awake."),
    ("probably", "The packets left hubhost, so probably the box is awake now."),
    ("soon_no_hedge_word", "The box is back up soon, I'd think."),
    ("any_minute", "The box is back online any minute now."),
    ("in_a_few_seconds", "hubhost sent it; the box is awake in a few seconds if armed."),
    ("knock_on_wood", "Knock on wood, the box is back up."),
]


@pytest.mark.parametrize("label,reply", HOPED_MUST_NOT, ids=[c[0] for c in HOPED_MUST_NOT])
def test_a_hope_or_an_expectation_is_left_alone(label, reply):
    assert _check(reply, [_wake(outcome="no_answer")]) is None, label
    assert _check(reply) is None, label


# Paired controls: the same states asserted confidently still fire — a time
# after the claim that is no future one, a relief word that is no hedge, "as expected"
# (a report), and a hedge AFTER the claim (the claim is already made).
HOPED_STILL_FIRES = [
    ("thankfully", "Thankfully the box is back up."),
    ("luckily", "Luckily the box came back online."),
    ("past_time_after", "The box came back online right after the send."),
    ("now", "The box is back up now."),
    ("as_expected", "As expected, the box is back up."),
    ("hedge_after", "The box is back up — I expect you can use it."),
    ("in_time", "The box woke up in time for your call."),
    ("then_hope", "The box is awake now. Hopefully it stays up."),
]


@pytest.mark.parametrize("label,reply", HOPED_STILL_FIRES, ids=[c[0] for c in HOPED_STILL_FIRES])
def test_the_same_state_asserted_confidently_is_still_corrected(label, reply):
    claim = _check(reply, [_wake(outcome="no_answer")])
    assert claim is not None, label
    assert claim.evidence == "no_answer"
    assert _check(reply) is not None, label


# VERIFY 2 (T6): a claim anchored in an explicit past time is a report of
# that time, not of this turn — "Last Tuesday the box woke up after the
# packet, per the ledger." was corrected with no_record. Weekdays, "this
# morning", "earlier today", "last night", "<N> days ago", dates are past
# markers (the shared _PRIOR_TIME carries yesterday / last night / … ago).
PAST_TIME_MUST_NOT = [
    ("last_weekday", "Last Tuesday the box woke up after the packet, per the ledger."),
    ("on_weekday", "On Tuesday the box woke up after the packet."),
    ("weekday_after", "The box woke up last Tuesday after the packet."),
    ("bare_weekday", "The box came back online Monday once the packet went out."),
    ("this_morning", "This morning the box woke up at 7."),
    ("this_afternoon", "This afternoon the box came back online."),
    ("earlier_today", "Earlier today the box woke up after the packet."),
    ("last_night", "The box woke up last night after the packet."),
    ("yesterday", "Yesterday the box came back online."),
    ("days_ago", "The box woke up two days ago."),
    ("hours_ago", "The box answered the wake 3 hours ago."),
    ("iso_date", "On 2026-10-03 the box woke up after the packet."),
    ("month_day", "On Oct 3 the box woke up after the packet."),
    ("month_name_day", "The box woke up on October 3rd."),
    ("day_month", "The box came back online on 3 October."),
    ("ordinal_day", "The box woke up on the 3rd."),
    ("slash_date", "The box woke up on 10/3."),
    ("last_week", "The box woke up last week."),
]


@pytest.mark.parametrize("label,reply", PAST_TIME_MUST_NOT, ids=[c[0] for c in PAST_TIME_MUST_NOT])
def test_a_claim_placed_at_an_explicit_past_time_is_left_alone(label, reply):
    assert _check(reply) is None, label
    assert _check(reply, [_wake(outcome="no_answer")]) is None, label


# Paired controls: the same claims with no past time (or a time that is this
# turn's) still fire.
PAST_TIME_STILL_FIRES = [
    ("this_turn", "The box woke up after the packet."),
    ("now", "The box is awake now."),
    ("today_is_not_past", "The box is back up today."),
    ("after_the_send", "The box came back online right after the send."),
    ("seconds_after", "The box woke up 40 seconds after the packet."),
]


@pytest.mark.parametrize(
    "label,reply", PAST_TIME_STILL_FIRES, ids=[c[0] for c in PAST_TIME_STILL_FIRES]
)
def test_the_same_claim_with_no_past_time_is_still_corrected(label, reply):
    claim = _check(reply)
    assert claim is not None, label
    assert claim.evidence == "no_record"
    assert _check(reply, [_wake(outcome="no_answer")]) is not None, label


# -- what backs a claim ---------------------------------------------------------


def test_an_attempt_that_answered_this_turn_backs_the_claim():
    spans = [_wake(outcome="answered", answered=41)]
    assert _check("I woke the box — its agent reconnected after 41 s.", spans) is None
    assert _check("The box is awake now.", spans) is None


def test_a_reading_that_shows_the_agent_connected_backs_awake():
    assert _check("The box is awake now.", [_status(connected=True)]) is None


def test_already_awake_with_a_not_asleep_record_is_backed():
    spans = [_wake(outcome="not_asleep", sent=False)]
    assert _check("The box is already awake, so nothing was sent.", spans) is None
    assert _check("The box was already awake, so nothing was sent.", spans) is None


def test_another_machines_record_backs_nothing():
    spans = [_wake(machine="hubhost", outcome="answered", answered=10)]
    assert _check("The box is awake now.", spans) is not None


# -- the correction says what the record shows ----------------------------------


def test_a_sent_wake_with_no_answer_is_corrected_to_its_outcome():
    claim = _check("I woke the box.", [_wake(outcome="no_answer", answered=None)])
    assert claim is not None
    assert claim.evidence == "no_answer"
    assert "did not reconnect" in claim.text and "Sending is not waking" in claim.text
    assert MAC not in claim.text


def test_a_wake_that_could_not_be_sent_is_corrected_to_not_sent():
    span = _wake(outcome="relay_cannot", sent=False, ok=False)
    claim = _check("The box is awake now.", [span])
    assert claim is not None
    assert claim.evidence == "relay_cannot"
    assert "no wake was sent" in claim.text


def test_a_reading_that_shows_it_offline_is_said():
    claim = _check("The box is awake now.", [_status(connected=False)])
    assert claim is not None
    assert claim.evidence == "offline"
    assert "offline" in claim.text


def test_a_machine_named_only_by_this_turns_wake_is_a_subject():
    claim = _check("The box woke up.", [_wake(outcome="no_answer")], names=())
    assert claim is not None and claim.evidence == "no_answer"


def test_no_names_and_no_wake_means_no_subject():
    assert _check("The box woke up.", [], names=()) is None


@pytest.mark.parametrize("purpose", ["scheduled", "beat", "delegated"])
def test_armed_only_in_chat_and_eval(purpose):
    assert _check("I woke the box.", purpose=purpose) is None
    assert _check("I woke the box.", purpose="eval") is not None


def test_the_phrase_is_short_and_carries_no_mac():
    claim = _check(f"The box is awake now ({MAC}).")
    assert claim is not None
    assert len(claim.phrase) <= 80 and MAC not in claim.phrase and MAC not in claim.text


# -- both guard sites: the turn body and a redirect's regeneration --------------


def test_the_append_class_set_runs_it_with_the_turns_paired_names():
    """chat._append_class_claims is what the turn body AND a redirect's
    regeneration run (A9): one registration covers both sites."""
    turn = SimpleNamespace(spans=[], kind="chat")
    found = chat._append_class_claims("I woke the box.", turn, device_names=list(NAMES))
    assert [name for name, _ in found] == ["wake_claim"]
    # …and a backed one, or a kind it is not armed in, files nothing.
    backed = SimpleNamespace(spans=[_status(connected=True)], kind="chat")
    assert chat._append_class_claims("The box is awake now.", backed, device_names=NAMES) == []
    scheduled = SimpleNamespace(spans=[], kind="scheduled")
    assert chat._append_class_claims("I woke the box.", scheduled, device_names=NAMES) == []


def test_the_guard_span_records_machine_phrase_and_evidence():
    filed = []

    class _Turn:
        def span(self, kind, name):
            meta: dict = {}
            filed.append((kind, name, meta))

            class _Ctx:
                def __enter__(self_inner):
                    return SimpleNamespace(meta=meta)

                def __exit__(self_inner, *exc):
                    return False

            return _Ctx()

    claim = _check("I woke the box.", [_wake(outcome="no_answer")])
    chat._file_claim_span(_Turn(), "wake_claim", claim)
    [(kind, name, meta)] = filed
    assert (kind, name) == ("guard", "wake_claim")
    assert meta == {"machine": "box", "phrase": claim.phrase, "evidence": "no_answer"}
