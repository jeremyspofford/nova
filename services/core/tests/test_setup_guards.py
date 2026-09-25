"""S47 — the REWRITE-class guards and the setup QR's narration, capability and
offer entries. Precision first: a false positive is the guard lying, so every
must-not-fire row is a sentence she may truly say."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import guards

ORIGIN = "https://nova.fake-tailnet.ts.net"


def _span(name: str, *, ok: bool = True) -> SimpleNamespace:
    return SimpleNamespace(kind="tool", name=name, meta={"ok": ok, "args_redacted": {}})


# -- code_claim ---------------------------------------------------------------

CODE_MUST_FIRE = [
    ("dashed", "Your pairing code is ABCD-2345.", "ABCD2345"),
    ("lowercase_bare", "Use code abcd2345 when novad asks.", "ABCD2345"),
    (
        "inside_the_command",
        f"Run novad enroll --server {ORIGIN} --code K7PQ-9XYZ on the laptop.",
        "K7PQ9XYZ",
    ),
]


@pytest.mark.parametrize(
    ("label", "reply", "token"), CODE_MUST_FIRE, ids=[c[0] for c in CODE_MUST_FIRE]
)
def test_an_invented_code_is_swapped_for_the_card(label, reply, token):
    claim = guards.code_claim_check(reply, "add my laptop")
    assert claim is not None
    assert claim.tokens == (token,)
    assert guards.CODE_ON_THE_CARD in claim.rewritten
    assert token not in claim.rewritten.upper().replace("-", "")
    assert claim.text == guards.CODE_CLAIM_CORRECTION


CODE_MUST_NOT_FIRE = [
    ("on_the_card", "The code is on the card, and it expires in ten minutes.", "add my laptop"),
    ("no_code_word", "The build ABCD-2345 finished.", "add my laptop"),
    ("letters_only", "Your pairing code is on the card, not DEADBEEF.", "add my laptop"),
    ("outside_the_alphabet", "The pairing code format looks like A1B2-C3D4.", "add my laptop"),
    ("the_owners_own", "Yes, ABCD-2345 is the code you typed.", "is ABCD-2345 right?"),
]


@pytest.mark.parametrize(
    ("label", "reply", "user"), CODE_MUST_NOT_FIRE, ids=[c[0] for c in CODE_MUST_NOT_FIRE]
)
def test_a_reply_with_no_invented_code_is_left_alone(label, reply, user):
    assert guards.code_claim_check(reply, user) is None


def test_the_code_correction_trips_no_other_guard():
    text = guards.CODE_CLAIM_CORRECTION
    assert guards.code_claim_check(text, "") is None
    assert guards.consent_claim_check(text) is None
    assert guards.narration_check(text, []) is None


# -- address_claim ------------------------------------------------------------

ADDRESS_MUST_FIRE = [
    (
        "another_tailnet_name_for_a_setup_page",
        "Open https://nova-old.fake-tailnet.ts.net/install on the phone.",
        ("setup_page",),
        f"Open {ORIGIN}/install on the phone.",
    ),
    (
        "the_lan_app_port",
        "On your tablet, go to http://192.168.0.245:3000.",
        ("lan",),
        f"On your tablet, go to {ORIGIN}.",
    ),
    (
        "loopback_setup_page_for_a_phone",
        "On your phone, open http://127.0.0.1:3000/install.",
        ("setup_page",),
        f"On your phone, open {ORIGIN}/install.",
    ),
    (
        "loopback_for_another_device",
        "Your laptop can reach me at http://localhost:3000.",
        ("loopback",),
        f"Your laptop can reach me at {ORIGIN}.",
    ),
    (
        "an_invented_store_link",
        "Get the Nova app at https://apps.apple.com/app/nova/id123456789.",
        ("store_link",),
        f"Get the Nova app at {guards.NO_APP}.",
    ),
]


@pytest.mark.parametrize(
    ("label", "reply", "rules", "rewritten"),
    ADDRESS_MUST_FIRE,
    ids=[c[0] for c in ADDRESS_MUST_FIRE],
)
def test_a_wrong_address_is_swapped_for_the_real_one(label, reply, rules, rewritten):
    claim = guards.address_claim_check(reply, "how do I put you on my tablet?", ORIGIN)
    assert claim is not None
    assert claim.rules == rules
    assert claim.rewritten == rewritten
    assert claim.truth == ORIGIN


ADDRESS_MUST_NOT_FIRE = [
    ("the_real_setup_page", f"Open {ORIGIN}/install on the phone.", "put you on my phone"),
    ("the_real_origin", f"Nova is at {ORIGIN}.", "where are you"),
    ("loopback_on_the_hub_itself", "On the hub itself, http://127.0.0.1:3000 works too.", "hi"),
    ("tailscale_download", "Install Tailscale from https://tailscale.com/download first.", "hi"),
    (
        "tailscale_in_the_app_store",
        "Get Tailscale at https://apps.apple.com/app/tailscale/id1470499037 first.",
        "hi",
    ),
    ("a_model_endpoint", "The Dell's models answer at https://dell.fake-tailnet.ts.net/v1.", "hi"),
    (
        "a_url_the_owner_typed",
        "No: http://192.168.0.245:3000 is not where a phone opens me.",
        "is http://192.168.0.245:3000 your address?",
    ),
]


@pytest.mark.parametrize(
    ("label", "reply", "user"), ADDRESS_MUST_NOT_FIRE, ids=[c[0] for c in ADDRESS_MUST_NOT_FIRE]
)
def test_an_honest_address_is_left_alone(label, reply, user):
    assert guards.address_claim_check(reply, user, ORIGIN) is None


def test_with_no_address_the_rewrite_and_correction_say_so():
    claim = guards.address_claim_check(
        "Open https://nova.fake-tailnet.ts.net/install on the phone.",
        "put you on my phone",
        None,
        "the tailnet sidecar is NeedsLogin, not Running",
    )
    assert claim is not None
    assert claim.rewritten == f"Open {guards.NO_ADDRESS} on the phone."
    assert "no address another device can reach" in claim.text
    assert "NeedsLogin" in claim.text


# -- narration: showed_setup_qr -----------------------------------------------

CLAIMED_CARDS = [
    "Here's a QR code for your phone.",
    "I've sent a pairing card to the chat.",
    "Scan the QR code above with your phone.",
]


@pytest.mark.parametrize("reply", CLAIMED_CARDS)
def test_a_card_claimed_with_no_call_is_corrected(reply):
    correction = guards.narration_check(reply, [])
    assert correction is not None
    assert [c.kind for c in correction.claims] == ["showed_setup_qr"]


@pytest.mark.parametrize("reply", CLAIMED_CARDS)
def test_a_card_she_sent_backs_the_claim(reply):
    assert guards.narration_check(reply, [_span("show_setup_qr")]) is None


def test_a_refused_call_backs_nothing():
    assert guards.narration_check(CLAIMED_CARDS[0], [_span("show_setup_qr", ok=False)]) is not None


def test_an_offer_is_not_narration():
    assert guards.narration_check("I can show you a QR code for your phone.", []) is None
