"""S47 — the REWRITE-class guards and the setup QR's narration, capability and
offer entries. Precision first: a false positive is the guard lying, so every
must-not-fire row is a sentence she may truly say."""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from app import chat, guards, network, traces

ORIGIN = "https://nova.fake-tailnet.ts.net"


def _span(name: str, *, ok: bool = True) -> SimpleNamespace:
    return SimpleNamespace(kind="tool", name=name, meta={"ok": ok, "args_redacted": {}})


def _patch_origin(monkeypatch) -> None:
    """network.address() answers the fixture origin — no status file, no DB."""
    monkeypatch.setattr(
        chat.network,
        "address",
        lambda *_a, **_k: network.Address(origin=ORIGIN, reason=None, read_at=datetime.now(UTC)),
    )


def _rewrite_and_file(reply: str, user: str) -> tuple[list, traces.Turn]:
    """chat._rewrite_class_claims over `reply`, each claim filed through the
    real chat._file_rewrite_span onto a real traces.Turn — what persists is
    the last claim's `rewritten`, and the turn's spans are what turn_spans
    would hold."""
    found = chat._rewrite_class_claims(reply, user)
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    for name, claim in found:
        chat._file_rewrite_span(turn, name, claim)
    return found, turn


# -- code_claim ---------------------------------------------------------------

CODE_MUST_FIRE = [
    ("dashed", "Your pairing code is ABCD-2345.", "ABCD2345"),
    ("lowercase_bare", "Use code abcd2345 when novad asks.", "ABCD2345"),
    (
        "inside_the_command",
        f"Run novad enroll --server {ORIGIN} --code K7PQ-9XYZ on the laptop.",
        "K7PQ9XYZ",
    ),
    # Final review (ruling, amended): the SHA-shaped and non-pairing-qualifier
    # exemptions below leave these three firing.
    ("the_enroll_flag", "Run novad enroll --code K7PQ-9XYZ on the laptop.", "K7PQ9XYZ"),
    (
        "enter_the_code_beside_add",
        "Open https://nova.fake-tailnet.ts.net/add on the laptop and enter the code K7PQ-9XYZ.",
        "K7PQ9XYZ",
    ),
    # The ruling's accepted cost, pinned so it is visible: a SHA-shaped token
    # straight after a bare "code" is still presented as a code.
    ("sha_shaped_after_a_bare_code", "novad's code 4ad87ac7 is the one to type.", "4AD87AC7"),
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
    # C (review fix round 3): arming must be anchored to a host rule 1
    # accepts and the path /add itself — a bare "/add?" or "/add#" substring
    # anywhere used to arm on ANY host's own /add endpoint.
    (
        "add_path_on_an_unrelated_host",
        "The endpoint is https://api.example.com/cart/add?sku=HX42KP97.",
        "add my laptop",
    ),
    (
        "add_path_segment_on_an_unrelated_host",
        "Your build is at https://ci.example.com/jobs/add?commit=a3f6c9e2 now.",
        "add my laptop",
    ),
    # Final review (ruling, amended): wherever the check arms — a pairing word
    # in the clause, or a token presented as a code beside an /add URL — it
    # never claims a token a non-pairing qualifier names (commit, build, sha,
    # hash, version, release, revision, rev, error, exit, status,
    # verification, promo, zip, order, ticket, sku, id, source; optionally
    # followed by "code"), nor a SHA-shaped one (exactly 8 lowercase hex
    # characters, no dash) anywhere but straight after a bare "code".
    (
        "a_commit_beside_novad",
        "The novad binary on the laptop is at commit 4ad87ac7 and it enrolled fine.",
        "add my laptop",
    ),
    (
        "a_pair_of_commits",
        "A pair of commits landed this morning: 4ad87ac7 and 9aea023d.",
        "add my laptop",
    ),
    ("an_enroll_error_code", "The enroll failed with error code E4B7-9C2D.", "add my laptop"),
    (
        "an_error_code_beside_add",
        "Open https://nova.fake-tailnet.ts.net/add and check error code E4B7-9C2D.",
        "add my laptop",
    ),
    (
        "a_build_beside_add",
        "Open https://nova.fake-tailnet.ts.net/add and use 4ad87ac7 as the build.",
        "add my laptop",
    ),
    ("a_source_code_sha", "The source code 4ad87ac7 has the novad fix.", "add my laptop"),
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
    # Final review (ruling): tailnet names stay unconditional for rule 1.
    (
        "another_tailnet_name_for_a_setup_page_on_a_tablet",
        "Open https://nova-old.fake-tailnet.ts.net/install on the tablet.",
        ("setup_page",),
        f"Open {ORIGIN}/install on the tablet.",
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
    # -- A (review fix round 3): the "I" lead-in, a colon with or without a
    # space before it, and a delimiter between the governing phrase and the
    # url (a backtick, <, ( — the model wrapping the url in something).
    (
        "my_address_colon_no_space",
        "My address: http://192.168.0.245:3000",
        ("lan",),
        f"My address: {ORIGIN}",
    ),
    (
        "novas_url_colon_no_space",
        "Nova's URL: http://192.168.0.245:3000",
        ("lan",),
        f"Nova's URL: {ORIGIN}",
    ),
    (
        "my_address_colon_with_space",
        "My address : http://192.168.0.245:3000",
        ("lan",),
        f"My address : {ORIGIN}",
    ),
    (
        "im_at_url",
        "I'm at http://192.168.0.245:3000.",
        ("lan",),
        f"I'm at {ORIGIN}.",
    ),
    (
        "i_live_at_url",
        "I live at http://192.168.0.245:3000.",
        ("lan",),
        f"I live at {ORIGIN}.",
    ),
    (
        "im_reachable_at_url_from_device",
        "I'm reachable at http://192.168.0.245:3000 from your tablet.",
        ("lan",),
        f"I'm reachable at {ORIGIN} from your tablet.",
    ),
    (
        "backtick_delimited_url",
        "Open Nova at `http://192.168.0.245:3000` on the tablet.",
        ("lan",),
        f"Open Nova at `{ORIGIN}` on the tablet.",
    ),
    (
        "angle_delimited_url",
        "Open Nova at <http://192.168.0.245:3000> on the tablet.",
        ("lan",),
        f"Open Nova at <{ORIGIN}> on the tablet.",
    ),
    (
        "paren_delimited_url",
        "Open Nova at (http://192.168.0.245:3000) on the tablet.",
        ("lan",),
        f"Open Nova at ({ORIGIN}) on the tablet.",
    ),
    # -- review fix round 4 (markdown link): a judged url that is the TEXT of
    # a markdown link whose TARGET is the same url is rewritten in both
    # places — the link must not show the truth and still open the old url.
    (
        "markdown_link_text_and_target",
        "Open Nova at [http://192.168.0.245:3000](http://192.168.0.245:3000) on the tablet.",
        ("lan",),
        f"Open Nova at [{ORIGIN}]({ORIGIN}) on the tablet.",
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
    # Final review (ruling): the hub's own browser installs the web app at its
    # loopback address, so a loopback setup page is wrong only when the clause
    # names another device (rule 3's list). The same row with no address for
    # another device is test_a_loopback_setup_page_on_the_hub_itself_with_no_address.
    (
        "loopback_setup_page_on_the_hub_itself",
        "On this computer, open http://127.0.0.1:3000/install to see the steps.",
        "hi",
    ),
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
    # -- negation (review fix round 3): _ADDRESS_NEGATION must be a superset
    # of _NEGATORS (no, not, never, nothing, none, without, n't) — "none" and
    # "nothing" were silently missing (neither is caught by \bno\b/\bnot\b,
    # which need a word boundary right after "no"/"not").
    (
        "none_of_your_phones",
        "None of your phones can reach http://localhost:3000 - it only answers on the hub.",
        "hi",
    ),
    (
        "nothing_on_your_phone",
        "Nothing on your phone can open http://127.0.0.1:3000; it only answers on the hub.",
        "hi",
    ),
    (
        "none_of_your_tablets_setup_page",
        "None of your tablets will load https://nova-old.fake-tailnet.ts.net/install - "
        "that name is gone.",
        "hi",
    ),
    # -- review fix round 4 (I-forms): the I-forms take "at" only — "I run
    # on"/"I'm running on" name the machine a MODEL runs on (a provider's
    # base_url, spec §8's must-not-fire), never where to open Nova.
    (
        "im_running_on_a_provider",
        "Right now I'm running on http://192.168.0.50:8080, the llama.cpp server on the Dell.",
        "hi",
    ),
    (
        "i_run_on_a_provider",
        "It's the llama.cpp server I run on http://192.168.0.50:8080.",
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


def test_a_loopback_setup_page_on_the_hub_itself_with_no_address():
    # Final review (ruling): with no address another device can reach, the
    # hub's own loopback setup page is still true, so nothing is rewritten and
    # no correction claims there is no address for it. The control: naming
    # another device still fires, rewritten to the no-address wording.
    assert (
        guards.address_claim_check(
            "On this computer, open http://127.0.0.1:3000/install to see the steps.",
            "hi",
            None,
            "the tailnet sidecar is NeedsLogin, not Running",
        )
        is None
    )
    claim = guards.address_claim_check(
        "On your phone, open http://127.0.0.1:3000/install.",
        "hi",
        None,
        "the tailnet sidecar is NeedsLogin, not Running",
    )
    assert claim is not None
    assert claim.rules == ("setup_page",)
    assert claim.rewritten == f"On your phone, open {guards.NO_ADDRESS}."


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


# -- C (review fix round 3): anchored to /add's own path — the query, the
# fragment, or a single path segment after /add/ — on a host rule 1 accepts,
# whether that host is the real origin or a wrong one (code_claim_check
# takes no origin of its own, so both must be armed the same way).
ADD_PATH_MUST_LOSE_CODE = [
    ("query_wrong_origin", "https://nova-old.fake-tailnet.ts.net/add/?code=K7PQ-9XYZ"),
    ("query_real_origin", f"{ORIGIN}/add/?code=K7PQ-9XYZ"),
    ("fragment_wrong_origin", "https://nova-old.fake-tailnet.ts.net/add/#K7PQ-9XYZ"),
    ("fragment_real_origin", f"{ORIGIN}/add/#K7PQ-9XYZ"),
    ("path_segment_wrong_origin", "https://nova-old.fake-tailnet.ts.net/add/K7PQ-9XYZ"),
    ("path_segment_real_origin", f"{ORIGIN}/add/K7PQ-9XYZ"),
    # C (review fix round 4): the /add URL is recognised with or without a
    # scheme, and case-insensitively on its path.
    ("no_scheme_fragment_wrong_origin", "nova-old.fake-tailnet.ts.net/add#K7PQ-9XYZ"),
    ("no_scheme_query_real_origin", "nova.fake-tailnet.ts.net/add?code=K7PQ-9XYZ"),
    ("uppercase_path_fragment_real_origin", f"{ORIGIN}/ADD#K7PQ-9XYZ"),
]


@pytest.mark.parametrize(
    ("label", "url"), ADD_PATH_MUST_LOSE_CODE, ids=[c[0] for c in ADD_PATH_MUST_LOSE_CODE]
)
def test_a_code_after_add_slash_is_gone_regardless_of_shape(label, url):
    reply = f"Open {url} on the laptop."
    code_claim = guards.code_claim_check(reply, "add my laptop")
    assert code_claim is not None, f"{label!r} should have armed pairing context"
    assert code_claim.tokens == ("K7PQ9XYZ",)
    address_claim = guards.address_claim_check(code_claim.rewritten, "add my laptop", ORIGIN)
    final = address_claim.rewritten if address_claim is not None else code_claim.rewritten
    assert "K7PQ-9XYZ" not in final
    assert "K7PQ9XYZ" not in final.upper().replace("-", "")
    assert "K7PQ" not in final.upper()
    if address_claim is not None:
        assert all("?" not in tok and "#" not in tok for tok in address_claim.tokens)
        # C (review fix round 4): `wrong` never carries the token itself, and
        # keeps nothing after /add — no segment, query or fragment — whether
        # or not code_claim swapped the token first.
        assert all("K7PQ" not in tok.upper() for tok in address_claim.tokens)
        assert all(tok.endswith("/add") for tok in address_claim.tokens), address_claim.tokens


# C (review fix round 4): a qualifying /add URL arms only ITS OWN token — in
# its query, its fragment or its one segment after /add/ — never another
# code-shaped token that merely shares its clause (a build, a commit).
ADD_URL_ARMS_ONLY_ITS_OWN_TOKEN = [
    (
        "build_beside_the_add_page",
        "Open https://nova.fake-tailnet.ts.net/add on the laptop running build 4ad87ac7.",
    ),
    (
        "commit_beside_the_add_page",
        "The add page https://nova.fake-tailnet.ts.net/add shipped in commit 4ad87ac7.",
    ),
]


@pytest.mark.parametrize(
    ("label", "reply"),
    ADD_URL_ARMS_ONLY_ITS_OWN_TOKEN,
    ids=[c[0] for c in ADD_URL_ARMS_ONLY_ITS_OWN_TOKEN],
)
def test_an_add_url_arms_only_its_own_token(label, reply):
    assert guards.code_claim_check(reply, "add my laptop") is None
    assert guards.address_claim_check(reply, "add my laptop", ORIGIN) is None


# C (review fix round 5): a sentence holding a qualifying /add URL also arms
# a code-shaped token PRESENTED AS A CODE — right after "code" (optionally
# "is"/"was"/":"), or after enter|type|use|input|paste with at most one
# determiner between. The two rows above ("build …", "commit …") stay
# untouched.
CODE_PRESENTED_BESIDE_ADD = [
    (
        "enter_the_code",
        "Open https://nova.fake-tailnet.ts.net/add on the laptop and enter the code K7PQ-9XYZ.",
    ),
    ("type_the_token", "Open https://nova.fake-tailnet.ts.net/add and type K7PQ-9XYZ."),
    (
        "the_code_is_after_a_semicolon",
        "Open https://nova.fake-tailnet.ts.net/add on the laptop; the code is K7PQ-9XYZ.",
    ),
    ("use_code_colon", "Go to https://nova.fake-tailnet.ts.net/add and use code: K7PQ-9XYZ."),
]


@pytest.mark.parametrize(
    ("label", "reply"), CODE_PRESENTED_BESIDE_ADD, ids=[c[0] for c in CODE_PRESENTED_BESIDE_ADD]
)
def test_a_code_presented_beside_an_add_url_is_gone(label, reply, monkeypatch):
    _patch_origin(monkeypatch)
    found, turn = _rewrite_and_file(reply, "add my laptop")
    assert "code_claim" in [name for name, _ in found], f"{label!r} kept its code"
    final = found[-1][1].rewritten
    assert "K7PQ" not in final.upper()
    assert "K7PQ" not in json.dumps([span.meta for span in turn.spans]).upper()


# -- review fix round 4, item 3 (C): nothing after /add survives --------------
# (moved here from tests/test_chat_setup_guards.py in review fix round 5, so
# it runs without a database; the body is unchanged)


def test_an_owner_typed_code_after_add_never_reaches_span_meta(monkeypatch):
    """The owner's own code is exempt from code_claim, so nothing swaps it —
    and the setup-page rewrite and `wrong` must still drop everything after
    /add, or his code lands in the persisted reply and in turn_spans."""
    monkeypatch.setattr(
        chat.network,
        "address",
        lambda *_a, **_k: network.Address(origin=ORIGIN, reason=None, read_at=datetime.now(UTC)),
    )
    found = chat._rewrite_class_claims(
        "Open https://nova-old.fake-tailnet.ts.net/add/K7PQ-9XYZ on the laptop.",
        "my code is K7PQ-9XYZ, where do I use it?",
    )
    assert [name for name, _ in found] == ["address_claim"]
    assert found[-1][1].rewritten == f"Open {ORIGIN}/add on the laptop."
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    for name, claim in found:
        chat._file_rewrite_span(turn, name, claim)
    [span] = turn.spans
    assert span.meta["wrong"] == ["https://nova-old.fake-tailnet.ts.net/add"]
    assert "K7PQ" not in json.dumps(span.meta).upper()


# C (review fix round 5): /install and /app get the same cut as /add — the
# setup-page rewrite and `wrong` drop everything after the setup page's
# path — so an owner-typed code (exempt from code_claim) never reaches span
# meta on ANY setup page.
SETUP_PAGES_WITH_A_TAIL = [("install", "/install"), ("app", "/app")]


@pytest.mark.parametrize(
    ("label", "page"), SETUP_PAGES_WITH_A_TAIL, ids=[c[0] for c in SETUP_PAGES_WITH_A_TAIL]
)
def test_an_owner_typed_code_after_install_or_app_never_reaches_span_meta(label, page, monkeypatch):
    _patch_origin(monkeypatch)
    found, turn = _rewrite_and_file(
        f"Open https://nova-old.fake-tailnet.ts.net{page}/K7PQ-9XYZ on the laptop.",
        "my code is K7PQ-9XYZ",
    )
    assert [name for name, _ in found] == ["address_claim"]
    assert found[-1][1].rewritten == f"Open {ORIGIN}{page} on the laptop."
    [span] = turn.spans
    assert span.meta["wrong"] == [f"https://nova-old.fake-tailnet.ts.net{page}"]
    assert "K7PQ" not in json.dumps(span.meta).upper()


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


# -- review fix round 4, item 1: the "unasked" exclusion lives only here -----
# (moved here from tests/test_chat_setup_guards.py in review fix round 5, so
# it runs without a database; the body is unchanged)


def test_a_failed_unasked_backend_check_is_not_her_failed_call():
    """A live_facts check the backend ran unasked (`meta["unasked"] = True`)
    is not a call she made, so its failure must not silence a capability
    correction beside it (ruling D clarified, round 3). Round 4 moved that
    exclusion out of guards._attempted — whose offer-shape caller must keep
    counting a backend-run listing — into chat._failed_tool_names alone."""

    def span(**meta):
        return SimpleNamespace(kind="tool", name="machine_status", meta=meta)

    assert chat._failed_tool_names([span(ok=False, unasked=True)]) == frozenset()
    # the control: the same failure as her own call is her failed call
    assert chat._failed_tool_names([span(ok=False)]) == frozenset({"machine_status"})
