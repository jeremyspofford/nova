"""One scrubber, for everything that records what a tool was asked to do.

Tool arguments are the most credential-dense values Nova handles. A single
`fetch_url` call can carry an API key in a query string, a bearer token in a
header, or a password in a URL's userinfo — and those arguments come to rest
in more places than is comfortable: the turn ledger's spans, the activity
trail persisted as `role='tool'` message rows, the SSE stream the browser
renders, and the server log.

Before this module there were two policies and one of them was "none":
`trace.py` scrubbed by key name and a few value shapes, while the activity
trail was `json.dumps(args)[:200]` verbatim — and the activity trail is the
copy that lives LONGER (30 days against the ledger's 14). So the redaction
that existed was defeated by simply reading the other table.

THE RULE HERE: mask VALUES, keep STRUCTURE.

That is not a compromise, it is the point. The Turn Inspector exists to
answer "what did she actually do", and a `fetch_url` span reading
`{"url": "•••"}` answers nothing — an operator who cannot see which host was
fetched will stop looking, which costs more than the leak did. So a URL
keeps its scheme, host, path and parameter NAMES, and only the values that
look like credentials become dots. You can still see she called
api.openweathermap.org/data/2.5/weather?appid=•••&q=Chicago.

Two things this deliberately does NOT do:

  * Guess by entropy. "This string looks random" flags git SHAs, UUIDs,
    base64 images and content hashes — all things worth seeing. Only named
    keys and KNOWN credential shapes are masked, which means a bespoke
    secret in an unnamed field can still get through. That is the honest
    trade: a scrubber that cries wolf gets turned off.
  * Touch what is already stored. Rows written before this module keep
    whatever they captured; scrubbing them is a destructive rewrite of the
    operator's own history and is their call, not this module's.
"""

from __future__ import annotations

import json
import re
from typing import Any

MASK = "•••"

# ── which KEYS are credentials, by name ──────────────────────────────────
# `\bauth\b` and not plain `auth`: the substring form matches "author",
# which is a field worth reading.
SECRET_KEY = re.compile(
    r"token|secret|password|passwd|api[_-]?key|apikey|authorization|bearer|"
    r"credential|private[_-]?key|\bauth\b|\bpat\b|cookie|session[_-]?id|"
    r"signature|access[_-]?key|client[_-]?secret|webhook[_-]?url",
    re.IGNORECASE)

# ── which VALUES are credentials, by shape ───────────────────────────────
# Only shapes with a distinctive prefix or structure. Each one is a format
# whose issuer publishes the prefix precisely so that scanners can find it.
SECRET_VALUE = re.compile(
    r"Bearer\s+\S+"                              # bearer headers
    r"|Basic\s+[A-Za-z0-9+/=]{8,}"               # basic auth, base64 user:pass
    r"|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}"        # openai / stripe / anthropic
    r"|\bgh[pousr]_[A-Za-z0-9]{20,}"             # github pat, oauth, refresh
    r"|\bxox[baprs]-[A-Za-z0-9-]{10,}"           # slack
    r"|\bAKIA[0-9A-Z]{16}\b"                     # aws access key id
    r"|\bAIza[0-9A-Za-z_-]{20,}"                 # google api key
    r"|\beyJ[A-Za-z0-9_-]{20,}"                  # jwt
    # A PEM block, BODY INCLUDED. Matching only the BEGIN line masked the
    # banner and left the key itself sitting in the span — the one shape
    # here where the giveaway prefix is not the secret. Second alternative
    # catches a block truncated before its END line.
    r"|-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----"
    r"|-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*"
)

# ── credentials hiding in URLs ───────────────────────────────────────────
# A query string is the single most common place a key travels, and neither
# the key-name rule (the key is "url") nor the shape rule (the value is
# whatever the vendor issues) sees it. Match the PARAMETER name and mask
# only its value, so the URL stays readable.
_URL_PARAM = re.compile(
    r"([?&](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|"
    r"secret|password|passwd|signature|sig|appid|app[_-]?key|"
    r"client[_-]?secret|session|key)=)[^&#\s\"'<>]+",
    re.IGNORECASE)

# https://user:hunter2@host/... — mask the password, keep the username, which
# is often the only clue about which account was used
_URL_USERINFO = re.compile(r"(://[^/\s:@]+:)[^/\s@]+(@)")


# `"api_key": "hunter2"` / `token=abc` sitting inside a STRING rather than a
# parsed dict — an unparseable argument blob, a provider error body echoing
# the request, a log line. The key-name rule cannot reach these because there
# are no keys to walk, so it is applied textually here. Requires a `:` or `=`
# immediately after the key, so prose ("the keynote covered secret
# management") is untouched.
_TEXT_SECRET_ASSIGN = re.compile(
    r"([\"']?\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|"
    r"secret|password|passwd|client[_-]?secret|private[_-]?key|credential|"
    r"authorization|bearer)\b[\"']?\s*[:=]\s*)"
    r"(\"[^\"]*\"|'[^']*'|[^\s,;}&]+)",
    re.IGNORECASE)


def _mask_assignment(m: re.Match) -> str:
    quoted = m.group(2)[:1] in ('"', "'")
    return m.group(1) + (f'"{MASK}"' if quoted else MASK)


def host_of(url: str) -> str:
    """Just scheme://host, for the case where the URL ITSELF is the secret.

    A Slack or Discord webhook carries its credential in the PATH, so no
    amount of query-string masking helps — the only safe thing to print is
    where it went, not what was called. `hooks.slack.com` is what an operator
    needs to recognise the integration; the rest is the password.
    """
    m = re.match(r"([a-z][a-z0-9+.-]*://[^/?#\s]+)", (url or "").strip(), re.IGNORECASE)
    if not m:
        return "the configured URL"
    return _URL_USERINFO.sub(rf"\1{MASK}\2", m.group(1))


def scrub_text(text: str, limit: int | None = None) -> str:
    """Scrub credential shapes and URL credentials out of free text."""
    if not text:
        return ""
    out = _URL_USERINFO.sub(rf"\1{MASK}\2", text)
    out = _URL_PARAM.sub(rf"\1{MASK}", out)
    # SHAPES FIRST. The assignment rule is greedy about "the token after the
    # colon", so running it first on `Authorization: Bearer abc123` masked
    # the word "Bearer" and left the key — the rule meant to catch more
    # broke the case that already worked.
    out = SECRET_VALUE.sub(MASK, out)
    out = _TEXT_SECRET_ASSIGN.sub(_mask_assignment, out)
    return out[:limit] if limit else out


def scrub_value(value: Any) -> Any:
    """Recursively scrub a JSON-ish value: secret-named keys lose their
    value entirely, everything else keeps its shape and is scrubbed."""
    if isinstance(value, dict):
        return {k: (MASK if isinstance(k, str) and SECRET_KEY.search(k)
                    else scrub_value(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [scrub_value(v) for v in value]
    if isinstance(value, str):
        return scrub_text(value)
    return value


def scrub_json_text(raw: str, limit: int) -> str:
    """Scrub a JSON string that may or may not parse.

    For the model's RAW argument blob, which is recorded precisely when it
    failed to parse. Scrubbing it as free text applies only the shape rules,
    so `{"api_key": "hunter2"}` survived in the one place it was stored —
    the key-name rule never ran, because there were no keys to walk. Parse
    first when possible, and fall back to text.
    """
    try:
        return scrub_args(json.loads(raw or ""), limit)
    except Exception:
        return scrub_text(raw, limit)


def scrub_args(args: Any, limit: int) -> str:
    """Tool args as a scrubbed, truncated JSON string.

    Failure returns "{}" rather than raising OR falling back to the raw
    value: a scrubber that emits the unscrubbed original when it trips is
    worse than one that emits nothing, because it fails exactly on the
    inputs weird enough to be interesting.
    """
    try:
        return json.dumps(scrub_value(args))[:limit]
    except Exception:
        return "{}"
