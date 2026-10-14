"""The one credential mask (mask-bearer epic, T1).

A credential typed into a command, pasted into chat or echoed by a tool must
not be stored as it was. `mask(text)` replaces the VALUE after a credential
marker with `<masked:N chars>` (`chat._masked`'s form) and keeps the marker,
so the saved text still says what was there:

  (a) a credential header line in any quoting — `Authorization: Bearer x`,
      `-H 'X-Api-Key: x'`, `{"Authorization": "Bearer x"}`, json-escaped
      `\\"Authorization: Bearer x\\"`. The NAME must BE a credential header
      (`_is_credential_header_name`: the exact names in `_CREDENTIAL_HEADERS`,
      or a hyphenated `X-…-Token` / `X-…-Key`) — never a prose label that
      merely contains a word (`Primary key:`, `Author:`, `Secret:`). A scheme
      word (Bearer, Basic, Token, Digest, ApiKey) is kept. Cookie/Set-Cookie
      values are masked only when they hold `=`; every other value must pass
      `_looks_like_secret`.
  (b) a bare `Bearer x`, when x passes `_looks_like_secret` — so "Bearer
      authentication" and "bearer token" in prose stay.
  (c) a token by its own shape (`_ARGV_TOKEN_RE`: ghp_…, github_pat_…, sk-…).
  (d) `KEY=value` whose KEY is `_credential_key` (env `GH_TOKEN=x`, a query's
      `access_token=x`, `--api-key=x`), and a flag `--token x` /
      `--password x` whose value passes `_looks_like_secret`.

`_looks_like_secret` is the ONE value floor (orchestrator ruling 10-14): 16+
characters, or 8+ with a digit — so `--token documentation` stays prose.

Idempotent: `<` is never a value character, so `<masked:N chars>` is never
masked again. Every pattern is linear — each starts only at the head of a
run (a lookbehind, like `_ARGV_TOKEN_RE`) and has no nested or adjacent
competing quantifiers; the length and digit floors are checked in Python,
not the regex. The masks run in core's event loop, and
tests/test_guard_regex_timing.py times every pattern here.

The mask is for what is SAVED (span meta, kept results, message rows, what
goes to memory); the running turn still uses the real value.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable

from app.mcp import client as mcp_client

OnSecret = Callable[[str], object] | None

# Argument keys whose VALUE is a credential (S37a, plan decision P14). Masked
# before anything is bounded or stored: mcp_connect's token, a device command's
# env GH_TOKEN, a header's API key must never reach turn_spans or Activity.
_CREDENTIAL_KEYS = frozenset(
    {
        "token",
        "access_token",
        "refresh_token",
        "id_token",
        "api_key",
        "apikey",
        "secret",
        "client_secret",
        "password",
        "passwd",
        "authorization",
        "cookie",
        "set-cookie",
        "private_key",
    }
)
_CREDENTIAL_SUFFIXES = (
    "_token",
    "-token",
    "_secret",
    "-secret",
    "_password",
    "_api_key",
    "-api-key",
)


def _credential_key(key: str, *, header: bool) -> bool:
    """A credential-shaped argument KEY (S37a, plan decision P14). Outside a
    `headers` object this tuple decides it alone, so a top-level `key`
    argument (`"key": "digest"`) is NOT a credential. Inside one, the
    header's NAME is the only clue (`X-Api-Key`, `X-Hass-Key`,
    `Authorization`), so it is checked against `app.mcp.client.
    is_credential_header` instead — the ONE predicate the client's own
    reason scrub already uses (ruling T5-B-REVISED), so the scrub and this
    mask can never disagree about a header name. This supersedes keeping a
    second `_CREDENTIAL_HEADER_WORDS` tuple here (ruling F8's instruction,
    before the carry)."""
    lowered = key.strip().lower()
    if lowered in _CREDENTIAL_KEYS or lowered.endswith(_CREDENTIAL_SUFFIXES):
        return True
    return header and mcp_client.is_credential_header(lowered)


# A token by its own shape (S29 T6): GitHub's ghp_/gho_/ghu_/ghs_/ghr_ and
# fine-grained github_pat_, and the sk- API keys, followed by 16 or more token
# characters — the floor keeps a `ghp_fix` branch and `sk-learn` readable. The
# lookbehind starts a match only at the head of a run of token characters, so
# every run is tried once: linear in the text (it runs in core's event loop).
_ARGV_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9_-])(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{16,}")

# The characters a header credential or bearer value is made of (RFC 6750's
# b64token plus `:`): it stops at a quote, a backslash, whitespace, `,` or `;`.
_VALUE = r"[A-Za-z0-9._~+/=:-]+"
_QUOTE = r"""(?:\\?["'])"""

# (a) `Name: [scheme ]value`. Name starts at the head of a run (lookbehind);
# an optional closing quote sits between it and the colon, an optional opening
# quote after. One whitespace run on each side of each optional piece, never
# two adjacent ones over the same spaces.
_HEADER_RE = re.compile(
    r"(?<![A-Za-z0-9-])(?P<name>[A-Za-z][A-Za-z0-9-]*)"
    rf"(?P<sep>{_QUOTE}?[ \t]*:[ \t]*(?:{_QUOTE}[ \t]*)?)"
    r"(?:(?P<scheme>(?i:bearer|basic|token|digest|apikey))(?P<gap>[ \t]+))?"
    rf"(?P<value>{_VALUE})"
)

# (b) a bare `Bearer value`.
_BEARER_RE = re.compile(rf"(?<![A-Za-z0-9_-])(?P<lead>(?i:bearer)[ \t]+)(?P<value>{_VALUE})")

# (d) `KEY=value` — KEY may carry its flag's dashes (`--api-key=`); the value
# may be quoted and runs to whitespace, a quote, `&`, `#`, `\` or `<`.
_ASSIGN_RE = re.compile(
    r"(?<![A-Za-z0-9_-])(?P<key>-*[A-Za-z_][A-Za-z0-9_-]*)"
    rf"(?P<sep>=(?:{_QUOTE})?)"
    r"""(?P<value>[^\s"'&#\\<]+)"""
)

# (d) `--key value` — only a dashed flag; a value never starts with `-`, so
# `--verbose --token x` does not swallow the next flag.
_FLAG_RE = re.compile(
    r"(?<![A-Za-z0-9_-])(?P<key>--?[A-Za-z][A-Za-z0-9_-]*)"
    rf"(?P<sep>[ \t]+(?:{_QUOTE})?)"
    r"""(?P<value>(?!-)[^\s"'\\<]+)"""
)

# Every pattern this module runs, for the timing sweep.
PATTERNS: dict[str, re.Pattern[str]] = {
    "header": _HEADER_RE,
    "bearer": _BEARER_RE,
    "argv_token": _ARGV_TOKEN_RE,
    "assign": _ASSIGN_RE,
    "flag": _FLAG_RE,
}


def _masked(value: str) -> str:
    return f"<masked:{len(value)} chars>"


def _has_digit(value: str) -> bool:
    return any(c.isdigit() for c in value)


def _looks_like_secret(value: str) -> bool:
    """The one value floor every floored shape shares: 16+ characters, or 8+
    with a digit. A word (`documentation`, `required-here`) is not a secret."""
    return len(value) >= 16 or (len(value) >= 8 and _has_digit(value))


# Header names whose value is a credential — whole names, compared
# case-insensitively. Plus any hyphenated `X-…-Token` / `X-…-Key`.
_CREDENTIAL_HEADERS = frozenset(
    {
        "authorization",
        "proxy-authorization",
        "cookie",
        "set-cookie",
        "x-api-key",
        "api-key",
        "x-auth-token",
        "x-access-token",
        "x-csrf-token",
    }
)
_COOKIE_HEADERS = frozenset({"cookie", "set-cookie"})


def _is_credential_header_name(name: str) -> bool:
    lowered = name.lower()
    if lowered in _CREDENTIAL_HEADERS:
        return True
    if not lowered.startswith("x-"):
        return False
    rest = lowered[2:]
    return any(rest.endswith(end) and len(rest) > len(end) for end in ("-token", "-key"))


def _split_tail(value: str) -> tuple[str, str]:
    """A value and the sentence punctuation that closed it: `Bearer abc….`
    ends a sentence, and a token never ends in `.` or `:` (a JWT's dots sit
    between its parts)."""
    core = value.rstrip(".:")
    return core, value[len(core) :]


def _is_credential_key(key: str) -> bool:
    return _credential_key(key, header=False) or _credential_key(key.lstrip("-"), header=False)


def mask(text: str, on_secret: OnSecret = None) -> str:
    """`text` with every credential VALUE replaced by `<masked:N chars>`, its
    marker kept. `on_secret` is called with each value replaced, in order."""
    if not text:
        return text

    def hide(value: str) -> str:
        if on_secret is not None:
            on_secret(value)
        return _masked(value)

    def header(m: re.Match[str]) -> str:
        value, tail = _split_tail(m["value"])
        name = m["name"]
        if not _is_credential_header_name(name):
            return m.group(0)
        if name.lower() in _COOKIE_HEADERS:
            if "=" not in value:
                return m.group(0)
        elif not _looks_like_secret(value):
            return m.group(0)
        scheme = (m["scheme"] or "") + (m["gap"] or "")
        return f"{m['name']}{m['sep']}{scheme}{hide(value)}{tail}"

    def bearer(m: re.Match[str]) -> str:
        value, tail = _split_tail(m["value"])
        if _looks_like_secret(value):
            return f"{m['lead']}{hide(value)}{tail}"
        return m.group(0)

    def token(m: re.Match[str]) -> str:
        return hide(m.group(0))

    def assign(m: re.Match[str]) -> str:
        if not _is_credential_key(m["key"]):
            return m.group(0)
        return f"{m['key']}{m['sep']}{hide(m['value'])}"

    def flag(m: re.Match[str]) -> str:
        value = m["value"]
        if not _is_credential_key(m["key"]) or not _looks_like_secret(value):
            return m.group(0)
        return f"{m['key']}{m['sep']}{hide(value)}"

    text = _HEADER_RE.sub(header, text)
    text = _BEARER_RE.sub(bearer, text)
    text = _ARGV_TOKEN_RE.sub(token, text)
    text = _ASSIGN_RE.sub(assign, text)
    return _FLAG_RE.sub(flag, text)


def mask_tree(value: object, on_secret: OnSecret = None) -> object:
    """`value` with `mask` applied to every string inside it — dict values,
    list and tuple items, at any depth. Keys and non-string leaves are kept
    as they were; the input is not mutated."""
    return _walk(value, lambda text: mask(text, on_secret))


def _walk(value: object, fn: Callable[[str], str]) -> object:
    if isinstance(value, str):
        return fn(value)
    if isinstance(value, dict):
        return {key: _walk(item, fn) for key, item in value.items()}
    if isinstance(value, list):
        return [_walk(item, fn) for item in value]
    if isinstance(value, tuple):
        return tuple(_walk(item, fn) for item in value)
    return value


# The floor for a value to be masked BARE (mask-bearer T3): the client's own
# credential floor, so a short value a mask happened to replace (`Cookie:
# id=7`'s `id=7`) never rewrites the same few characters in other text.
SECRET_FLOOR = mcp_client._MIN_CREDENTIAL_CHARS


class Secrets:
    """The credential values ONE turn's masks replaced (mask-bearer T3), and
    the mask that also replaces each of them where it stands bare — her reply
    repeating the key with no header, a later tool result printing it.

    Derived, never kept by hand: filled only from `mask`'s `on_secret` (every
    `Secrets.mask` call collects what it replaced, and a caller that masked
    elsewhere passes `add` as its `on_secret`). A value under SECRET_FLOOR is
    not collected; a `name=value` cookie pair also contributes its value. One
    set per traces.Turn: a value from another turn is never used."""

    def __init__(self) -> None:
        self._values: set[str] = set()

    def add(self, value: object) -> None:
        if not isinstance(value, str):
            return
        for candidate in (value, value.partition("=")[2]):
            if len(candidate) >= SECRET_FLOOR:
                self._values.add(candidate)

    def update(self, values: Iterable[str]) -> None:
        for value in values:
            self.add(value)

    def collect(self, text: str) -> None:
        """Note what `mask` would replace in `text`, changing nothing."""
        mask(text, on_secret=self.add)

    def mask(self, text: str) -> str:
        """`mask(text)`, collecting what it replaced, then every value this
        turn collected replaced where it stands bare, longest first."""
        if not text:
            return text
        text = mask(text, on_secret=self.add)
        for secret in sorted(self._values, key=len, reverse=True):
            if secret in text:
                text = text.replace(secret, _masked(secret))
        return text

    def mask_tree(self, value: object) -> object:
        """`self.mask` over every string inside `value`, as `mask_tree`."""
        return _walk(value, self.mask)
