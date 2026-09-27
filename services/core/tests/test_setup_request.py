"""S47 follow-up (docs/plans/rebuild/s47/auto-card.md §1): the phrase match that
decides when core sends a setup card itself.

`setup_request(message)` answers a setup only when the owner's OWN message
plainly asks for it. Precision first, and it has to be: a false match sends a
card nobody asked for and, for a machine, mints a ten-minute pairing code. A
None costs nothing — the turn runs exactly as it did before this existed, and
her own show_setup_qr call still works.

Pure and DB-free: this module runs wherever the suite runs.
"""

from __future__ import annotations

import time
from typing import get_args

import pytest

from app.setup_request import SetupKind, setup_request
from app.tools import setup as setup_tools

# The design's table, row for row (the pins; not the whole grammar).
PINS = [
    ("How do I put you on my phone?", "install_pwa"),
    ("Put Nova on my iPad", "install_pwa"),
    ("How can I get you on my tablet?", "install_pwa"),
    ("Install Nova on my phone", "install_pwa"),
    ("Add you to my home screen", "install_pwa"),
    ("Where do I download your iPhone app?", "get_app"),
    ("Is there a Nova app for Android?", "get_app"),
    ("Get me the Nova app", "get_app"),
    ("Add my laptop so you can control it.", "add_machine"),
    ("Pair my desktop with Nova", "add_machine"),
    ("Connect my laptop to you", "add_machine"),
    ("Set up the Dell to serve models.", "add_model_server"),
    ("Add a model server", "add_model_server"),
    ("Use my desktop to serve models", "add_model_server"),
]

# The eval corpus's three S47 messages are plain requests too, which is why
# the corpus moves to suite_version 17 (auto-card.md §4).
CORPUS = [
    ("How do I put you on my tablet?", "install_pwa"),
    ("Add my laptop so you can control it.", "add_machine"),
    ("Where do I download your iPhone app?", "get_app"),
]

# The design's None rows, each under the reason it gives.
NONE_ROWS = [
    # A negated or past request.
    ("negated", "don't put you on my phone"),
    ("already_did", "I already put you on my phone"),
    ("yesterday", "I put you on my phone yesterday"),
    # Something else put on a device.
    ("calendar_on_phone", "put my calendar on my phone"),
    ("shopping_list_on_phone", "put the shopping list on my phone"),
    ("laptop_files_to_note", "add my laptop's files to the note"),
    # A capability question with no request: a question about her, not
    # "add my laptop".
    ("capability_question", "can you control my laptop?"),
    # Two different setups in one message: nothing is sent, her own call
    # still works.
    ("two_setups", "Put you on my phone and add my laptop so you can control it."),
    ("two_setups_two_sentences", "How do I put you on my phone? Also pair my desktop with Nova."),
    # A message only mentioning a phone.
    ("phone_died", "my phone died"),
]

# Near misses the grammar must also leave alone — each one a phrase a looser
# match would take for a request, and the ones a machine setup would mint a
# code for are the costly ones.
NEAR_MISSES = [
    ("put_on_hold", "put you on hold"),
    ("put_on_speaker", "can you put yourself on speaker?"),
    ("phone_contacts", "add you to my phone contacts"),
    ("phone_call_with", "get you on the phone with my mom"),
    ("laptop_to_list", "add my laptop to the shopping list"),
    ("laptop_ambiguous", "put you on my laptop"),
    ("phone_is_not_a_machine", "pair my phone with Nova"),
    ("headphones", "pair my headphones"),
    ("connect_to_laptop", "connect to my laptop"),
    ("bare_qr", "show me a QR code"),
    ("app_complaint", "your app is slow"),
    ("downloaded_already", "I downloaded your iPhone app"),
    ("generic_app", "is there an app for tracking steps?"),
    ("an_app_for_something", "Do you have an app for budgeting?"),
    ("nova_app_for_a_fridge", "is there a Nova app for my fridge?"),
    ("past_question", "how did I put you on my phone?"),
    ("why_question", "why did you put yourself on my phone?"),
    ("please_dont", "please don't pair my laptop"),
    ("never_mind", "How do I put you on my phone? Never mind."),
    ("scratch_that", "add my laptop so you can control it -- scratch that"),
    ("dell_serving", "the Dell is serving models"),
    ("is_connected", "is my laptop connected?"),
    ("control_imperative", "control my laptop"),
    # A machine is held to more than a phone, because a false match mints a
    # code: "add" has to say it is to her or for her, and nothing but a
    # courtesy or a purpose about her may follow the machine.
    ("add_laptop_alone", "add my laptop"),
    ("add_a_laptop", "Add a laptop"),
    ("packing_list", "add my laptop so I don't forget it"),
    ("for_the_trip", "add my laptop for the trip"),
    ("someone_elses_pairing", "pair my laptop for the presentation"),
    ("warranty", "register my laptop for the warranty"),
    ("set_up_alone", "set up my laptop"),
    ("connect_alone", "connect my laptop"),
    ("hook_up_alone", "hook up my laptop"),
    # A machine is a computer, not any noun that ends in "machine" or "server".
    ("coffee_machine", "connect my coffee machine to you"),
    ("washing_machine", "add a washing machine so you can control it"),
    ("discord_server", "pair my discord server"),
    ("minecraft_server", "pair my minecraft server with Nova"),
    # Review fix round 1 (the Important): a coordinated object is not a setup
    # request. A comma or a conjunction ends a request only where a new
    # request starts, so what follows the machine is read as part of it.
    ("pair_laptop_and_phone", "Can I pair my laptop and my phone?"),
    ("pair_laptop_and_headphones", "How do I pair my laptop and my headphones?"),
    ("pair_laptop_and_mouse", "Tell me how to pair my laptop and my mouse"),
    ("pair_laptop_and_tv", "can we pair my laptop and my tv?"),
    ("pair_laptop_then_headphones", "pair my laptop then my headphones"),
    ("pair_laptop_but_not_phone", "pair my laptop but not my phone"),
    ("trailing_no", "Pair my laptop? No."),
    # Running models on a machine is routing, not a model-server setup.
    ("use_dell_to_run_models", "use the Dell to run models again"),
    ("switch_back_to_the_dell", "switch back to the dell: use the dell to run models"),
    ("use_laptop_to_run_models", "Can I use my laptop to run models?"),
    ("generic_ai_server", "How do I set up an AI server?"),
    # A purpose about her must be about controlling, using or reaching it.
    ("remind_me", "add my laptop so you can remind me to charge it"),
    # Review fix round 1 (folded): card-only false matches.
    ("speaker_phone", "put you on the speaker phone"),
    ("any_apps", "Do you have any apps?"),
    ("any_apps_for_you", "are there any apps for you?"),
    ("not_today", "Put you on my phone, but not today"),
    ("troubleshooting", "how do I get you working on my phone"),
    ("empty", ""),
    ("blank", "   "),
]

# Plain requests past the pins that the grammar answers, so a phrasing drift
# in the pins does not quietly narrow it to exactly fourteen strings.
VARIANTS = [
    ("put you on my tablet", "install_pwa"),
    ("Nova, put yourself on my new phone please", "install_pwa"),
    ("can you show me how to put you on my phone?", "install_pwa"),
    ("I want to install Nova on my iPhone", "install_pwa"),
    ("Is there a way to get you on my android?", "install_pwa"),
    ("how to install nova on android", "install_pwa"),
    ("pair my laptop", "add_machine"),
    ("add my laptop to you", "add_machine"),
    ("How do I pair my desktop?", "add_machine"),
    ("could you add my work laptop so you can control it", "add_machine"),
    ("set up my laptop so Nova can control it", "add_machine"),
    ("pair my old linux server", "add_machine"),
    ("enroll my wife's laptop", "add_machine"),
    ("hook up my gaming pc to you", "add_machine"),
    ("Do you have an iPhone app?", "get_app"),
    ("Install the Nova app on my phone", "get_app"),
    ("Add the Dell as a model server", "add_model_server"),
    ("@coder add my laptop so you can control it", "add_machine"),
    # Review fix round 1: the plain requests the review confirmed must keep
    # answering once coordinated objects stop matching.
    ("How do I put Nova on my phone?", "install_pwa"),
    ("Install yourself on my phone", "install_pwa"),
    ("How do I add my laptop to you?", "add_machine"),
    ("Can you help me pair my laptop with you?", "add_machine"),
    ("How do I connect my PC to Nova?", "add_machine"),
    ("how do I set up the Dell as a model server?", "add_model_server"),
    ("Where can I get the Nova app?", "get_app"),
    # A second request after a comma or a conjunction still counts as one.
    ("Hey Nova, how do I put you on my phone?", "install_pwa"),
    ("Can you, please, put yourself on my phone?", "install_pwa"),
    ("set up a model server for Nova", "add_model_server"),
]


def test_every_answer_is_one_of_the_setups_show_setup_qr_takes():
    """SetupKind is written out here (the module stays pure: it imports no
    app.tools), so it is pinned equal to the tool's own list."""
    assert set(get_args(SetupKind)) == set(setup_tools.SETUPS)


@pytest.mark.parametrize(("message", "setup"), PINS, ids=[m for m, _ in PINS])
def test_each_pin_answers_its_setup(message, setup):
    assert setup_request(message) == setup


@pytest.mark.parametrize(("message", "setup"), CORPUS, ids=[m for m, _ in CORPUS])
def test_the_corpus_messages_are_plain_requests(message, setup):
    assert setup_request(message) == setup


@pytest.mark.parametrize(("label", "message"), NONE_ROWS, ids=[label for label, _ in NONE_ROWS])
def test_each_none_row_answers_none(label, message):
    assert setup_request(message) is None, label


@pytest.mark.parametrize(("label", "message"), NEAR_MISSES, ids=[label for label, _ in NEAR_MISSES])
def test_near_misses_answer_none(label, message):
    assert setup_request(message) is None, label


@pytest.mark.parametrize(("message", "setup"), VARIANTS, ids=[m for m, _ in VARIANTS])
def test_plain_variants_answer_their_setup(message, setup):
    assert setup_request(message) == setup


def test_case_and_curly_quotes_do_not_matter():
    assert setup_request("HOW DO I PUT YOU ON MY PHONE?") == "install_pwa"
    assert setup_request("Don’t put you on my phone") is None


# -- timing: it runs on every owner message, in core's event loop -----------
#
# The guard family's budget and method (tests/test_guard_regex_timing.py): 50
# ms per call, the best of a few runs, over padding shaped to make a
# backtracking pattern walk it. A linear match takes microseconds here.

BUDGET_S = 0.05
PAD = 1500


def _best_of(fn, runs: int = 3) -> float:
    best = float("inf")
    for _ in range(runs):
        start = time.perf_counter()
        fn()
        best = min(best, time.perf_counter() - start)
    return best


PADDED = [
    ("spaces_inside_the_request", "how do i put " + " " * PAD + "you on my phone"),
    ("padding_after_a_request", "how do i put you on my phone" + " " * PAD + "x"),
    ("repeated_adjectives", "put you on my " + "new " * (PAD // 4) + "phone"),
    ("repeated_fillers", "please " * (PAD // 7) + "put you on my phone"),
    ("repeated_requests", "put you on my phone and " * (PAD // 24)),
    ("one_long_word", "a" * PAD),
    ("devices_without_a_verb", "my laptop " * (PAD // 10)),
    ("tabs_and_newlines", "add my\t\n" * (PAD // 8) + "laptop"),
    # Review fix round 1: every comma and conjunction now has what follows it
    # read as a possible request, so these are the shapes that could go
    # quadratic.
    ("coordinated_objects", "pair my laptop" + " and my phone" * (PAD // 13)),
    ("many_commas", "put you on my phone" + ", x" * (PAD // 3)),
    ("many_fillers_after_commas", "pair my laptop" + ", please and please" * (PAD // 19)),
    ("many_verbs_after_commas", "pair my laptop" + ", pair" * (PAD // 6)),
]


@pytest.mark.parametrize(("label", "message"), PADDED, ids=[label for label, _ in PADDED])
def test_a_1500_character_padded_message_is_judged_in_milliseconds(label, message):
    assert len(message) >= PAD - 30, label
    took = _best_of(lambda: setup_request(message))
    assert took < BUDGET_S, f"{label}: {took * 1000:.1f} ms"
