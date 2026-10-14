"""The one credential mask (mask-bearer T1): the VALUE after a credential
marker becomes `<masked:N chars>`, the marker stays, and honest text — prose
about tokens, shas, ordinary links, `max_tokens=100` — comes out byte for
byte. Pure functions, no database."""

from __future__ import annotations

import pytest

from app import chat, credential_mask

KEY = "nv_ev_9fK2xQ7LmR4tBz8WcY1pDs"  # 28 chars, url-safe, no known prefix
M = f"<masked:{len(KEY)} chars>"


# -- (a) a credential header line, the scheme word kept ------------------------

HEADER_CASES = {
    "curl_double_quoted": (
        f'curl -s -H "Authorization: Bearer {KEY}" https://nova.invalid/api/v1/events',
        f'curl -s -H "Authorization: Bearer {M}" https://nova.invalid/api/v1/events',
    ),
    "curl_single_quoted": (
        f"curl -H 'Authorization: Bearer {KEY}' -d '{{}}' https://x.invalid",
        f"curl -H 'Authorization: Bearer {M}' -d '{{}}' https://x.invalid",
    ),
    "json_escaped": (
        f'{{"argv": ["sh", "-c", "curl -H \\"Authorization: Bearer {KEY}\\" x"]}}',
        f'{{"argv": ["sh", "-c", "curl -H \\"Authorization: Bearer {M}\\" x"]}}',
    ),
    "json_object": (
        f'{{"Authorization": "Bearer {KEY}", "Accept": "application/json"}}',
        f'{{"Authorization": "Bearer {M}", "Accept": "application/json"}}',
    ),
    "json_escaped_object": (
        f'{{\\"Authorization\\": \\"Bearer {KEY}\\"}}',
        f'{{\\"Authorization\\": \\"Bearer {M}\\"}}',
    ),
    "lowercase_scheme": (
        f"authorization: bearer {KEY}",
        f"authorization: bearer {M}",
    ),
    "basic_scheme": (
        "Authorization: Basic dXNlcjpodW50ZXIy",
        "Authorization: Basic <masked:16 chars>",
    ),
    "api_key_header_no_scheme": (
        f"-H 'X-Api-Key: {KEY}'",
        f"-H 'X-Api-Key: {M}'",
    ),
    "cookie_header": (
        "Cookie: sessionid=abc123def456",
        "Cookie: <masked:22 chars>",
    ),
    "sentence_end": (
        f"use Authorization: Bearer {KEY}.",
        f"use Authorization: Bearer {M}.",
    ),
    "proxy_authorization": (
        f"Proxy-Authorization: Bearer {KEY}\n",
        f"Proxy-Authorization: Bearer {M}\n",
    ),
}


@pytest.mark.parametrize("label", sorted(HEADER_CASES))
def test_a_credential_header_keeps_its_name_and_scheme_and_loses_its_value(label):
    raw, expected = HEADER_CASES[label]
    assert credential_mask.mask(raw) == expected
    assert KEY not in credential_mask.mask(raw)


# -- (b) a bare Bearer value ---------------------------------------------------


def test_a_bare_bearer_value_is_masked():
    assert credential_mask.mask(f"the key is Bearer {KEY}.") == f"the key is Bearer {M}."


def test_a_short_bearer_value_with_a_digit_is_masked():
    assert credential_mask.mask("Bearer abc12345") == "Bearer <masked:8 chars>"


# -- (c) a token by its own shape ----------------------------------------------


def test_a_known_token_shape_is_masked_anywhere():
    token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0"
    assert credential_mask.mask(f"push with {token} now") == (
        f"push with <masked:{len(token)} chars> now"
    )


# -- (d) KEY=value and --flag value --------------------------------------------

ASSIGN_CASES = {
    "env": ("GH_TOKEN=tok-2abc ./run", "GH_TOKEN=<masked:8 chars> ./run"),
    "quoted_env": ('API_KEY="s3cretvalue" x', 'API_KEY="<masked:11 chars>" x'),
    "query": (
        "https://x.invalid/cb?access_token=abc123&page=2",
        "https://x.invalid/cb?access_token=<masked:6 chars>&page=2",
    ),
    "flag_equals": ("tool --api-key=k9k9k9k9 run", "tool --api-key=<masked:8 chars> run"),
    "flag_space": ("gh auth login --token abcdef123456", "gh auth login --token <masked:12 chars>"),
    "password_flag": ("--password hunter22 -v", "--password <masked:8 chars> -v"),
    "flag_after_flag": ("cli --verbose --token zzzz9999", "cli --verbose --token <masked:8 chars>"),
}


@pytest.mark.parametrize("label", sorted(ASSIGN_CASES))
def test_an_assignment_or_flag_keeps_its_key_and_loses_its_value(label):
    raw, expected = ASSIGN_CASES[label]
    assert credential_mask.mask(raw) == expected


# -- must not touch ------------------------------------------------------------

UNTOUCHED = {
    "prose_token": "I used a token to sign in, and the bearer token expired.",
    "prose_bearer_auth": "The API uses Bearer authentication over HTTPS.",
    "prose_key": "The api key is stored in settings; rotate the secret monthly.",
    "sha": "Merged 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 into main.",
    "uuid": "turn 3b7781fa-0d51-49c2-bbeb-47335161e8d5 finished",
    "url_query": "See https://example.invalid/search?page=2&q=bearer+token#top",
    "max_tokens": "sent max_tokens=100 and temperature=0.2",
    "short_header": "Authorization: Bearer abc",
    "non_credential_header": "X-Api-Version: 2025-11-25-preview",
    "already_masked": f"Authorization: Bearer {M}",
    "flag_with_word": "pass --token to the cli",
    "content_type": 'curl -H "Content-Type: application/json" https://x.invalid',
}


# Orchestrator ruling 10-14 (T1 RED): a header NAME is a credential header in
# its own right, never a prose word that merely contains "key"/"auth"/"secret";
# a value must look like a credential (Cookie: holds `=`; everything else:
# 16+ token chars, or 8+ with a digit).
UNTOUCHED.update(
    {
        "ruling_primary_key": "Primary key: customer_id",
        "ruling_author": "Author: Christopher",
        "ruling_secret_label": "Secret: everything is fine",
        "ruling_cookie_prose": "Cookie: chocolate chip",
        "ruling_token_flag_word": "see --token documentation",
        "ruling_token_label": "token: 5 left",
        "ruling_api_key_label": "API key: see the docs",
        "ruling_header_word_value": "Authorization: required-here",
        "ruling_x_header_not_credential": "X-Request-Id: 9f8e7d6c5b4a",
        # the NAME rule on its own: a prose label whose value passes the floor
        "ruling_label_with_digit_value": "Primary key: order_id_2024",
        "ruling_author_with_digits": "Author: jsmith2024",
    }
)


@pytest.mark.parametrize("label", sorted(UNTOUCHED))
def test_honest_text_comes_out_byte_identical(label):
    text = UNTOUCHED[label]
    assert credential_mask.mask(text) == text


# -- the real shapes the ruling must keep masking ------------------------------

LIVE_KEY = "2VpAyMcA0CJZ_g0sL0L5K87_I_sqeIHO9sPhFQs1-Ms"
GHP = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0"

RULING_MASKED = {
    "live_walk_curl": (
        f'-H "Authorization: Bearer {LIVE_KEY}"',
        f'-H "Authorization: Bearer <masked:{len(LIVE_KEY)} chars>"',
    ),
    "cookie_with_equals": ("Cookie: session=abc123def456", "Cookie: <masked:20 chars>"),
    "x_api_key_short_with_digit": ("X-Api-Key: a1b2c3d4e5", "X-Api-Key: <masked:10 chars>"),
    "token_flag_ghp": (f"--token {GHP}", f"--token <masked:{len(GHP)} chars>"),
    "bare_bearer_12_with_digit": ("Bearer 4f9e2c71ab03", "Bearer <masked:12 chars>"),
    "x_hyphenated_token_header": (
        "X-Gitlab-Token: q1w2e3r4t5y6",
        "X-Gitlab-Token: <masked:12 chars>",
    ),
    # Cookie's own rule: a pair is a cookie, however short
    "cookie_short_pair": ("Cookie: id=7", "Cookie: <masked:4 chars>"),
    "set_cookie": ("Set-Cookie: sid=9f8e7d6c; Path=/", "Set-Cookie: <masked:12 chars>; Path=/"),
}


@pytest.mark.parametrize("label", sorted(RULING_MASKED))
def test_the_real_credential_shapes_are_still_masked(label):
    raw, expected = RULING_MASKED[label]
    assert credential_mask.mask(raw) == expected


# -- idempotent ----------------------------------------------------------------

EVERY_MASKED_INPUT = (
    [raw for raw, _ in HEADER_CASES.values()]
    + [raw for raw, _ in ASSIGN_CASES.values()]
    + [f"Bearer {KEY}", "ghp_A1b2C3d4E5f6G7h8I9j0"]
)


@pytest.mark.parametrize("raw", EVERY_MASKED_INPUT)
def test_masking_twice_is_masking_once(raw):
    once = credential_mask.mask(raw)
    assert once != raw
    assert credential_mask.mask(once) == once


# -- on_secret and mask_tree ---------------------------------------------------


def test_on_secret_receives_each_replaced_value():
    seen: list[str] = []
    credential_mask.mask(
        f'curl -H "Authorization: Bearer {KEY}" -H "X-Api-Key: k9k9k9k9k9"', on_secret=seen.append
    )
    assert seen == [KEY, "k9k9k9k9k9"]


def test_mask_tree_walks_nested_dicts_lists_and_strings():
    tree = {
        "argv": ["curl", "-H", f"Authorization: Bearer {KEY}"],
        "facts": [{"result_head": f"echo Bearer {KEY}", "exit": 0}, None, 3.5],
        "pair": ("GH_TOKEN=tok-2abc", True),
        f"Bearer {KEY}": "keys are not values",
    }
    seen: list[str] = []
    out = credential_mask.mask_tree(tree, on_secret=seen.append)
    assert out == {
        "argv": ["curl", "-H", f"Authorization: Bearer {M}"],
        "facts": [{"result_head": f"echo Bearer {M}", "exit": 0}, None, 3.5],
        "pair": ("GH_TOKEN=<masked:8 chars>", True),
        f"Bearer {KEY}": "keys are not values",
    }
    assert seen.count(KEY) == 2
    assert tree["argv"][2] == f"Authorization: Bearer {KEY}"  # input not mutated


def test_mask_tree_on_a_bare_string_is_mask():
    assert credential_mask.mask_tree(f"Bearer {KEY}") == f"Bearer {M}"


# -- the moved names: one copy, re-exported by chat ----------------------------


def test_the_moved_names_live_in_credential_mask_and_chat_reexports_them():
    for name in ("_ARGV_TOKEN_RE", "_CREDENTIAL_KEYS", "_CREDENTIAL_SUFFIXES", "_credential_key"):
        assert getattr(chat, name) is getattr(credential_mask, name), name
    assert credential_mask._credential_key.__module__ == "app.credential_mask"
