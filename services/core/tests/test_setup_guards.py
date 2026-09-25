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
    # I4 (review fix round 1): a bare "code" is no longer pairing context —
    # only pairing/pair/enroll*/--code/novad/"one-time code"/"setup code", or
    # a token inside an /add# URL fragment, arm the check.
    (
        "bare_code_commit_reference",
        "The code change landed in commit 4ad87ac7.",
        "add my laptop",
    ),
    (
        "bare_code_verification_email",
        "The verification code in that email is 48KX2M9P.",
        "add my laptop",
    ),
    ("bare_code_error_code", "Error code E4B7-9C2D came from the updater.", "add my laptop"),
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
        # I1 (review fix round 1; amended round 2): rule 2 requires a Nova
        # phrase to GOVERN the url — "open Nova at" — never just the word
        # "nova" anywhere in the clause.
        "the_lan_app_port",
        "On your tablet, open Nova at http://192.168.0.245:3000.",
        ("lan",),
        f"On your tablet, open Nova at {ORIGIN}.",
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
    # -- A (review fix round 2): the LAN rule with the GOVERNING phrase ------
    (
        "open_nova_at_url_then_device",
        # Task 6's ARMED sentence — must fire.
        "Open Nova at http://192.168.0.245:3000 on the tablet.",
        ("lan",),
        f"Open Nova at {ORIGIN} on the tablet.",
    ),
    (
        "reach_me_at_url_from_device",
        "You can reach me at http://192.168.0.245:3000 from your tablet.",
        ("lan",),
        f"You can reach me at {ORIGIN} from your tablet.",
    ),
    (
        "my_address_is_url",
        "My address is http://192.168.0.245:3000.",
        ("lan",),
        f"My address is {ORIGIN}.",
    ),
    (
        "nova_is_at_url",
        "Nova is at http://10.0.0.5:8080.",
        ("lan",),
        f"Nova is at {ORIGIN}.",
    ),
    (
        "open_nova_on_device_at_url",
        "Open Nova on your tablet at http://192.168.0.245:3000.",
        ("lan",),
        f"Open Nova on your tablet at {ORIGIN}.",
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
    # -- I1 (review fix round 1): precision-first must-not-fire walk --------
    # Rule 2 (LAN) needs a path that is empty/root/setup-page: a real other
    # service's endpoint on the LAN is honest.
    (
        "lan_not_a_setup_or_root_path",
        "Add the Dell as a provider with base URL http://192.168.0.50:8080/v1.",
        "hi",
    ),
    # Rule 2 needs the clause to PRESENT the url as NOVA's; "open" alone
    # (not "open me") is a different service's URL.
    ("lan_not_presented_as_novas", "Open Grafana at http://192.168.1.5:3000.", "hi"),
    ("lan_someone_elses_address", "Your router's address is http://192.168.1.1.", "hi"),
    # a path that is neither empty/root nor a setup page.
    ("lan_admin_path", "Pi-hole's dashboard is at http://192.168.1.2/admin.", "hi"),
    ("lan_webui_not_presented_as_novas", "Open WebUI is at http://10.0.0.20:8080.", "hi"),
    # Rule 2 needs the EXACT RFC1918 ranges, never ip.is_private, which also
    # reads link-local, unspecified, and the TEST-NETs as private.
    (
        "link_local_is_not_lan",
        "The metadata service answers at http://169.254.169.254/latest.",
        "hi",
    ),
    ("unspecified_is_not_lan", "Try http://0.0.0.0:3000 for the dashboard.", "hi"),
    ("test_net_is_not_lan", "The scanner probe hit http://192.0.2.10 in the logs.", "hi"),
    # Rule 2 needs scheme http, never https.
    ("https_is_not_rule_2", "Some devices show https://192.168.1.1 as their gateway.", "hi"),
    # Rule 3 (loopback): "your computer/Mac/PC" DROPPED from the device list
    # — on a default install that is the hub itself.
    ("your_computer_is_the_hub", "On your computer, open http://localhost:3000.", "hi"),
    # Rules 1-4 all skip a URL a negation precedes ANYWHERE in its clause.
    (
        "negated_loopback_lead",
        "Don't open http://localhost:3000 on your phone: it only works on the hub itself.",
        "hi",
    ),
    (
        "negated_lan_trailing",
        "http://192.168.0.245:3000 won't work on your phone; use the tailnet address.",
        "hi",
    ),
    # -- A (review fix round 2): the re-review's negation + governs probes --
    # "cannot"/"unable"/curly n't are missed by the shared _has_negator
    # (out of scope, never widened); the local _ADDRESS_NEGATION covers them.
    (
        "cannot_use_loopback",
        "Your phone cannot use http://127.0.0.1:3000 - it only answers on the hub.",
        "hi",
    ),
    (
        "curly_apostrophe_dont",
        "Don’t open http://localhost:3000 on your phone: it only answers on the hub.",
        "hi",
    ),
    (
        "unable_to_reach",
        "Your laptop is unable to reach http://localhost:3000; use the tailnet address.",
        "hi",
    ),
    (
        "nova_cannot_be_opened",
        "Nova cannot be opened at http://192.168.0.245:3000 from your tablet.",
        "hi",
    ),
    (
        "phone_cannot_open_setup_page",
        "A phone cannot open https://nova-old.fake-tailnet.ts.net/install - that name is gone.",
        "hi",
    ),
    # the GOVERNS test itself: "nova" mentioned but not governing THIS url.
    (
        "nova_mentioned_elsewhere_not_governing",
        "Add http://192.168.0.50:8080 as a provider in Nova's settings.",
        "hi",
    ),
    (
        "nova_is_the_subject_not_the_object",
        "Nova can use the llama.cpp server at http://192.168.0.50:8080 as a provider.",
        "hi",
    ),
    (
        "someone_elses_address_beside_the_real_one",
        f"Your router is at http://192.168.1.1, and Nova is at {ORIGIN}.",
        "hi",
    ),
]


@pytest.mark.parametrize(
    ("label", "reply", "user"), ADDRESS_MUST_NOT_FIRE, ids=[c[0] for c in ADDRESS_MUST_NOT_FIRE]
)
def test_an_honest_address_is_left_alone(label, reply, user):
    assert guards.address_claim_check(reply, user, ORIGIN) is None


def test_your_computer_is_the_hub_even_with_no_address():
    # The same must-not-fire holds when origin is None: "your computer" is
    # never a claim about ANOTHER device, whether or not Nova currently has
    # an address for one.
    assert (
        guards.address_claim_check(
            "On your computer, open http://localhost:3000.", "hi", None, "a reason"
        )
        is None
    )


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


# -- I2 (review fix round 1): splice by offset, never global str.replace ----


def test_a_negated_hub_clause_beside_a_rewritten_device_clause_is_untouched():
    reply = (
        "On the hub, curl http://localhost:8000/health works; "
        "your laptop can reach http://localhost:8000."
    )
    claim = guards.address_claim_check(reply, "can my laptop reach you", ORIGIN)
    assert claim is not None
    assert claim.rules == ("loopback",)
    assert claim.rewritten == (
        f"On the hub, curl http://localhost:8000/health works; your laptop can reach {ORIGIN}."
    )


NEGATED_SAME_URL = [
    (
        "hub_then_negated_phone_mention",
        "On the hub itself, http://127.0.0.1:3000 works. Your phone can't use "
        "http://127.0.0.1:3000 - it only answers on the hub.",
    ),
    (
        "hub_then_negated_laptop_mention",
        "On the hub, curl http://localhost:8000/health works; your laptop can't "
        "reach http://localhost:8000.",
    ),
]


@pytest.mark.parametrize("label,reply", NEGATED_SAME_URL, ids=[c[0] for c in NEGATED_SAME_URL])
def test_a_negated_mention_of_the_same_url_never_fires(label, reply):
    assert guards.address_claim_check(reply, "hi", ORIGIN) is None


# -- I7 (review fix round 1): a code inside an /add# fragment ----------------


def test_a_code_inside_an_add_fragment_is_gone_even_on_the_real_origin():
    reply = "Open https://nova-old.fake-tailnet.ts.net/add#K7PQ-9XYZ on the laptop."
    code_claim = guards.code_claim_check(reply, "add my laptop")
    assert code_claim is not None
    assert code_claim.tokens == ("K7PQ9XYZ",)
    address_claim = guards.address_claim_check(code_claim.rewritten, "add my laptop", ORIGIN)
    assert address_claim is not None
    final = address_claim.rewritten
    assert "K7PQ-9XYZ" not in final
    assert "K7PQ9XYZ" not in final.upper().replace("-", "")
    assert "K7PQ" not in final.upper()
    # the span's own token list never carries the fragment either.
    assert all("#" not in url for url in address_claim.tokens)


# -- C (review fix round 2): a code inside an /add?code= query --------------


def test_a_code_inside_an_add_query_is_gone_on_a_wrong_origin():
    reply = "Open https://nova-old.fake-tailnet.ts.net/add?code=K7PQ-9XYZ on the laptop."
    code_claim = guards.code_claim_check(reply, "add my laptop")
    assert code_claim is not None
    assert code_claim.tokens == ("K7PQ9XYZ",)
    address_claim = guards.address_claim_check(code_claim.rewritten, "add my laptop", ORIGIN)
    assert address_claim is not None
    final = address_claim.rewritten
    assert "K7PQ-9XYZ" not in final
    assert "K7PQ9XYZ" not in final.upper().replace("-", "")
    assert "K7PQ" not in final.upper()
    assert all("?" not in url and "#" not in url for url in address_claim.tokens)


def test_a_code_inside_an_add_query_is_gone_on_the_real_origin():
    reply = f"Open {ORIGIN}/add?code=K7PQ-9XYZ on the laptop."
    code_claim = guards.code_claim_check(reply, "add my laptop")
    assert code_claim is not None
    assert code_claim.tokens == ("K7PQ9XYZ",)
    final = code_claim.rewritten
    assert "K7PQ-9XYZ" not in final
    assert "K7PQ9XYZ" not in final.upper().replace("-", "")
    assert "K7PQ" not in final.upper()


# -- narration: showed_setup_qr -----------------------------------------------

CLAIMED_CARDS = [
    "Here's a QR code for your phone.",
    "I've sent a pairing card to the chat.",
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


# I5 (review fix round 1): the deictic "scan the QR code above/below/on
# screen" alternative is dropped entirely (it is her reading the SCREEN, not a
# claim of her own that she sent one), and "here's ..." no longer accepts
# "the" as a determiner.
CARD_NOT_CLAIMED = [
    "Scan the QR code above with your phone.",
    "Scan the QR code above with your camera app.",
    "Here's the pairing code format: four letters or digits, a dash, four more.",
    "To sign Tailscale in on the TV, scan the QR code on the screen.",
    "Run tailscale up --qr on the laptop, then scan the QR code on the screen.",
]


@pytest.mark.parametrize("reply", CARD_NOT_CLAIMED)
def test_a_deictic_or_relayed_qr_mention_is_not_a_claim(reply):
    assert guards.narration_check(reply, []) is None
