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
    # Review fix round 2: the past carries into coordinated clauses. A
    # sentence that opens past or retrospective reports what was done; a verb
    # coordinated after it is the same report, not a new request.
    (
        "already_then_coordinated",
        "I already put you on my phone and set up my laptop so you can control it",
    ),
    (
        "paired_then_set_up",
        "I paired my laptop, then set up the Dell to serve models. Why is it slow?",
    ),
    ("did_i_pair", "Did I pair my laptop and set up the Dell to serve models?"),
    ("paired_and_then_put", "I paired my laptop and then put you on my phone"),
    # Review fix round 2: a later "No", "Actually, no", "not yet" or "No way"
    # takes it back.
    ("no_not_yet", "Pair my laptop? No, not yet."),
    ("actually_no", "Pair my laptop. Actually, no."),
    ("no_way", "Pair my laptop? No way."),
    ("no_thanks_later", "Pair my laptop? No. Thanks."),
    # Review fix round 2: a machine as an AI or inference server is the
    # generic question too, unless it is for her.
    ("laptop_into_an_ai_server", "How do I turn my old laptop into an AI server?"),
    ("laptop_as_an_ai_server", "set up my laptop as an AI server"),
    # Review fix round 2: "the phone" with no modifier is a phone call.
    ("the_phone", "Can I get you on the phone?"),
    # Review fix round 2: with the bare model server restored, this is two
    # setups again — nothing is sent, and she can call for either.
    ("model_server_and_laptop", "Set up a model server and pair my laptop"),
    # A trailing clause is kept only when it is not a take-back.
    ("trailing_not_today", "How do I put you on my phone, not today though"),
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
    # Review fix round 2: the plain requests round 1's tightening missed.
    # A phone may take any modifier but a non-device one (speaker, ...).
    ("put you on my brand new phone", "install_pwa"),
    ("Put Nova on the family iPad", "install_pwa"),
    ("put you on my kids' tablet", "install_pwa"),
    ("put you on my daughters iPad", "install_pwa"),
    ("put you on my new Galaxy phone", "install_pwa"),
    ("put you on my current phone", "install_pwa"),
    ("put you on the kitchen iPad", "install_pwa"),
    # A phone or app request keeps a trailing clause that is not another setup.
    ("How do I put you on my phone, I have an iPhone", "install_pwa"),
    ("How do I put you on my phone, and does it work offline?", "install_pwa"),
    ("Put you on my phone and send me the link", "install_pwa"),
    ("Where do I download your app, and is it free?", "get_app"),
    ("Get me the Nova app and tell me how to install it", "get_app"),
    # A bare model or LLM server is the model-server request.
    ("How do I set up a model server?", "add_model_server"),
    ("Set up a model server", "add_model_server"),
    ("Can you set up a model server?", "add_model_server"),
    ("set up an LLM server", "add_model_server"),
    # Access, manage, run commands on and wake are purposes about her.
    ("add my laptop so you can run commands on it", "add_machine"),
    ("add my laptop so you can access it", "add_machine"),
    ("add my laptop so you can manage it", "add_machine"),
    ("set up my desktop so you can wake it up", "add_machine"),
    # The known fillers are not counted.
    ("ok so hey nova please put you on my phone", "install_pwa"),
    # "running" after "get you" / "want you" is the setup.
    ("How do I get you running on my phone?", "install_pwa"),
    ("I want you running on my phone", "install_pwa"),
    # An AI server without "for Nova" is no setup, so the laptop is the one ask.
    ("Set up an AI server and pair my laptop", "add_machine"),
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


# -- review fix round 2: the cost is bounded ----------------------------------
#
# Round 1's comma rule re-read the whole rest of a sentence at every comma or
# conjunction whose tail opened like a request — quadratic, with no length
# cap, in core's event loop (the re-review: ",use" x 6,000 took 3.6 s). Now a
# message over MAX_REQUEST_CHARS is not a plain request and answers None
# before anything is read, and within the cap each tail is re-read through a
# fixed window.

CAP = 500


def _to(text: str, size: int) -> str:
    """`text` repeated to exactly `size` characters."""
    return (text * (size // len(text) + 1))[:size]


TODO_LIST = (
    "todo: buy milk, add my laptop charger to the bag, use the good pan, pair the socks, "
    "set up the tent, put the phone on the charger, get the nova app sticker, "
)
JSON_ARRAY = '["add my laptop", "use my desktop to serve models", "pair my laptop", '

AT_THE_CAP = [
    ("comma_add", _to(",add", CAP)),
    ("comma_use", _to(",use", CAP)),
    ("todo_list", _to(TODO_LIST, CAP)),
    ("json_array", _to(JSON_ARRAY, CAP)),
    ("comma_pair_my_laptop", _to(", pair my laptop", CAP)),
    ("and_use_my_desktop", _to(" and use my desktop to serve models", CAP)),
]


@pytest.mark.parametrize(("label", "message"), AT_THE_CAP, ids=[label for label, _ in AT_THE_CAP])
def test_an_adversarial_message_at_the_cap_is_judged_well_under_budget(label, message):
    assert len(message) == CAP, label
    took = _best_of(lambda: setup_request(message))
    assert took < BUDGET_S / 5, f"{label}: {took * 1000:.2f} ms"


LONG_BUDGET_S = 0.005
OVER_THE_CAP = [
    ("comma_use_6000", _to(",use", 6_000)),
    ("comma_use_24000", _to(",use", 24_000)),
    ("todo_list_24000", _to(TODO_LIST, 24_000)),
    ("json_array_24000", _to(JSON_ARRAY, 24_000)),
    ("a_request_then_24000", "How do I put you on my phone? " + _to(",use", 24_000)),
]


@pytest.mark.parametrize(
    ("label", "message"), OVER_THE_CAP, ids=[label for label, _ in OVER_THE_CAP]
)
def test_a_message_over_the_cap_answers_none_at_once(label, message):
    took = _best_of(lambda: setup_request(message))
    assert setup_request(message) is None, label
    assert took < LONG_BUDGET_S, f"{label}: {took * 1000:.2f} ms"


def test_a_plain_request_at_the_cap_still_answers_and_one_over_does_not():
    ask = "How do I put you on my phone?"
    assert setup_request(ask + " " * (CAP - len(ask))) == "install_pwa"
    assert setup_request(ask + " " * (CAP + 1 - len(ask))) is None
