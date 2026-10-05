"""One parse of an address, with the two renderings her tools and the trace
each need (ruling G16, fix round 1 m7).

An http(s) URL's user info, query and fragment can carry a credential — a
password, a session id, a password-reset or sign-in link's token — so
neither rendering below ever shows them. `shown` is what a page's address
looks like to her and her tools: scheme, host and path, the rest dropped
outright — she is shown a page she can act on, not a secret. `masked` is
what the trace keeps instead: the same address, with the dropped parts'
LENGTH kept and their content replaced, since Activity benefits from seeing
that a query was sent without seeing what was in it.

`scrub` is the free-text form (ruling G6, fix round 1 I1): the engine's own
prose (a navigation error) or a page's own words (a dialog's message, an
accessible name) can repeat an address inside a longer sentence, and it is
found and reduced to `shown`'s form there too — linearly, which the first
version of this (written inside app/tools/browser.py) was not: each call to
`str.find` for a scheme ABSENT from the text scans to the end every time it
is asked, and asking both schemes again after every match of the one that
IS present made a text built entirely of one scheme's URLs quadratic (a
288 KB page `alert()` blocked core's event loop 3.5-4.6s, measured). Fixed
by remembering each scheme's next position and re-searching only once `i`
has moved past it.
"""

from __future__ import annotations

from urllib.parse import SplitResult, urlsplit

_SCHEMES = ("https://", "http://")
# Characters that end a URL found inside free text: the engine's own prose
# or a page's own words might quote or bracket one. Not exhaustive of every
# character a URL may never legally contain — just the ones a sentence
# around it would plausibly use to set it off.
_STOP_CHARS = "\"'()[]<>"


def _split(value: str) -> SplitResult | None:
    """`value`, split once — or None when `urlsplit` cannot (it raises
    ValueError on some malformed strings, e.g. an unbalanced IPv6 host).
    Both renderings below build on this one parse, so a string that fails
    it fails the same way for either, and neither has to guard it again."""
    try:
        return urlsplit(value)
    except ValueError:
        return None


def _looks_like_http(value: str) -> bool:
    lowered = value.lower()
    return lowered.startswith("http://") or lowered.startswith("https://")


def shown(value: str | None) -> str | None:
    """An address as her tools show it, and as a page fact holds it: scheme,
    host and path — no user info, query or fragment. `None` in, `None`
    out; a value that is not a parseable http(s) address with a host still
    loses anything after its first `?` or `#`, AND whatever sits before the
    last `@` up to the next `/` after the scheme (fix round 2, B — the user
    info a malformed netloc can still carry; `urlsplit` raising is exactly
    what makes it malformed, so there is no `.netloc` to read it from the
    normal way). Str methods only, never raising — this is the fallback
    `browser.py` relied on before this module existed, kept so every one of
    its tests stays green unchanged."""
    if not value:
        return None
    parts = _split(value)
    if parts is not None and parts.scheme and parts.netloc:
        return f"{parts.scheme}://{parts.netloc.rpartition('@')[2]}{parts.path}"
    cut = value.split("?", 1)[0].split("#", 1)[0]
    scheme, sep, rest = cut.partition("://")
    if not sep:
        return cut
    slash = rest.find("/")
    authority, tail = (rest, "") if slash == -1 else (rest[:slash], rest[slash:])
    return f"{scheme}://{authority.rpartition('@')[2]}{tail}"


def masked(value: str) -> str:
    """An address as the trace holds it: no `user:password@`, and the query
    and fragment replaced by their own length. Anything that is not an
    http(s) address — INCLUDING one with no host at all, a hostless
    `https:///reset?token=…` — is still masked (S38 Task 6's fix round 1:
    the plan's own `or not parts.netloc` guard let exactly that unmasked
    once); anything that is not http(s) at all is returned exactly as it
    was.

    Ruling G34 (fix round 2, B): a value `urlsplit` cannot read AT ALL —
    raising, rather than parsing into parts this function could then mask —
    used to come back here RAW, unmasked, the moment it merely LOOKED like
    an http(s) address (`http://[::1/reset?token=…`, an unterminated IPv6
    host): there is no `.query` to replace when there are no `.parts`. The
    only values this function ever reveals are http(s) ones, so one shaped
    like one that still cannot be parsed is masked WHOLE instead — never
    handed back on the technicality that it could not be reduced to parts.
    Anything that does not even look like an http(s) address is still
    returned exactly as it was: masking could only be about an address."""
    parts = _split(value)
    if parts is None:
        return f"<masked:{len(value)} chars>" if _looks_like_http(value) else value
    if parts.scheme.lower() not in ("http", "https"):
        return value
    user, at, host = parts.netloc.rpartition("@")
    out = f"{parts.scheme}://"
    if at:
        out += f"<masked:{len(user)} chars>@"
    out += host + parts.path
    if parts.query:
        out += f"?<masked:{len(parts.query)} chars>"
    if parts.fragment:
        out += f"#<masked:{len(parts.fragment)} chars>"
    return out


def scrub(text: str) -> str:
    """`text`, with every http(s) URL inside it reduced to its `shown` form.

    One pass: `next_at` remembers where each scheme's NEXT occurrence is,
    and a scheme is re-searched only once `i` has moved past the position
    remembered for it (`0 <= pos < i`) — never on every URL found, which is
    the fix (see the module docstring). `i` only ever advances to the end of
    a URL just consumed, so every character of `text` is examined by at
    most one scheme's successful `find` and, once each, by a `find` that
    comes up empty — linear overall, not by how many URLs it finds."""
    if "://" not in text:
        return text
    n = len(text)
    next_at = {scheme: text.find(scheme) for scheme in _SCHEMES}
    out: list[str] = []
    i = 0
    while True:
        for scheme, pos in next_at.items():
            if 0 <= pos < i:
                next_at[scheme] = text.find(scheme, i)
        at = -1
        for pos in next_at.values():
            if pos != -1 and (at == -1 or pos < at):
                at = pos
        if at == -1:
            out.append(text[i:])
            return "".join(out)
        out.append(text[i:at])
        end = at
        while end < n and not text[end].isspace() and text[end] not in _STOP_CHARS:
            end += 1
        out.append(shown(text[at:end]) or text[at:end])
        i = end
