"""Is this provider failure a wall, or is it weather?

MEASURED 2026-08-07. The self-improvement loop ran four passes unattended and
every coding session died with the same reply, three times per pass:

    the coding agent returned an error: {"code": -32603, "message": "Internal
    error: API Error: 402 This request requires more credits, or fewer
    max_tokens. You requested up to 32000 tokens, but can only afford 15846.
    To increase, visit https://openrouter.ai/... and adjust the key's monthly
    limit"}

Twelve coding sessions, four goal actions and four `action_runs` against a wall
that cannot clear itself by retrying. Jeremy saw "the self improvement pass
failed" and nothing else.

WHAT THIS MODULE IS. One classifier, so every retry loop asks the same question
of the same evidence: is retrying this identical call capable of succeeding?

    terminal    no. The key is wrong, refused, or out of money. A second
                attempt is the first attempt with a different timestamp.
    transient   yes. Rate limits, 5xx, timeouts — the call was fine and the
                moment was not.
    unknown     nobody can tell from this text.

`unknown` DELIBERATELY RETRIES, and that is the conservative direction: this
module only ever removes retries it is certain are pointless. A misclassified
transient failure would abandon real work, which is worse than the waste it
saves. Every widening of `terminal` below has to be defensible as "a fact the
provider stated", never as "this reads like a billing problem".

HOW IT DECIDES, and what it refuses to decide on. The verdict comes from an
HTTP STATUS or from a provider's own machine-readable error CODE token — both
facts. It never matches on English, because prose is the part of an API that
changes without notice and the part that differs most between providers: a
sentence containing "quota" appears in rate-limit messages and in billing
messages alike, and the one time a wrong guess matters is the time it stops a
retry that would have worked. The one exception is `token_budget()`, which
reads two NUMBERS the provider volunteered; it is used only to derive a value
the provider itself stated, never to decide the class.

IT MUST SURVIVE AN ENVELOPE. The text above arrives wrapped by the ACP broker
in a JSON-RPC error (`code: -32603`, provider text inside `message`), which in
turn is a `str()` of a Python dict by the time it reaches the database. So the
input is peeled — JSON, then Python-literal, then the raw string — and every
layer is searched. Note that -32603 is a JSON-RPC code and not an HTTP status:
a `code` field is only read as a status when it lands in 100..599, which is
why a JSON-RPC envelope cannot be mistaken for a server error.
"""

from __future__ import annotations

import ast
import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional

log = logging.getLogger(__name__)

TERMINAL = "terminal"
TRANSIENT = "transient"
UNKNOWN = "unknown"

#: Statuses that mean "this credential may not do this", in every
#: OpenAI-compatible API. Retrying identically cannot change any of them.
_TERMINAL_STATUS = {401: "credentials", 402: "billing", 403: "permission"}

#: Statuses that mean "not now". 529 is Anthropic's overloaded; 522/524 are
#: Cloudflare in front of several providers.
_TRANSIENT_STATUS = {408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529}

#: Machine tokens providers put in `error.code` / `error.type`. These are API
#: constants, not sentences — OpenAI answers an exhausted account with HTTP
#: **429** and `code: insufficient_quota`, which is a billing wall wearing a
#: rate limit's status, so the token has to outrank the status.
_TERMINAL_CODES = {
    "insufficient_quota": "billing",
    "billing_hard_limit_reached": "billing",
    "billing_not_active": "billing",
    "credit_balance_too_low": "billing",
    "account_deactivated": "credentials",
    "invalid_api_key": "credentials",
    "authentication_error": "credentials",
    "permission_error": "permission",
    "permission_denied": "permission",
}

#: How deep the peeling goes. An envelope inside an envelope inside an
#: envelope is already unusual; a cycle would otherwise spin forever.
_MAX_DEPTH = 6

#: Where a status hides in a structured layer.
_STATUS_KEYS = ("status_code", "statusCode", "http_status", "status")
#: Where the provider's own token hides.
_CODE_KEYS = ("code", "type", "error_code", "reason")
#: Keys whose value is the next envelope in.
_NEST_KEYS = ("error", "message", "detail", "body", "data", "response")

#: `API Error: 402`, `HTTP 402`, `status 402`, `Error code: 402`. Anchored on a
#: keyword so a token count in the same sentence cannot be read as a status,
#: and bounded to real HTTP statuses so a JSON-RPC -32603 cannot be either.
_STATUS_IN_TEXT = re.compile(
    r"\b(?:api\s+error|http(?:\s+error)?|error\s+code|status(?:\s+code)?)"
    r"\s*[:=]?\s*(\d{3})\b", re.I)


@dataclass
class Fault:
    """One provider failure, classified. `kind` is the only verdict."""

    kind: str = UNKNOWN
    status: Optional[int] = None
    #: `billing` | `credentials` | `permission` | `rate_limit` | `server` | ""
    reason: str = ""
    #: The provider's own text, unwrapped and scrubbed. Never invented.
    detail: str = ""
    #: Only ever set from the provider's own numbers — see `token_budget`.
    requested_tokens: Optional[int] = None
    affordable_tokens: Optional[int] = None
    layers: list = field(default_factory=list, repr=False)

    @property
    def terminal(self) -> bool:
        return self.kind == TERMINAL

    @property
    def adaptable(self) -> bool:
        """Did the provider state a budget this call could have fitted into?

        True only when it named BOTH numbers and the smaller one is a usable
        positive — a retry sized from a guess is the wall again with extra
        steps.
        """
        return bool(self.affordable_tokens
                    and self.requested_tokens
                    and 0 < self.affordable_tokens < self.requested_tokens)

    def as_dict(self) -> dict:
        return {"kind": self.kind, "status": self.status,
                "reason": self.reason, "detail": self.detail,
                "requested_tokens": self.requested_tokens,
                "affordable_tokens": self.affordable_tokens,
                "retry_is_pointless": self.terminal}

    def operator_note(self) -> str:
        """What the person holding the key needs to read, in his terms.

        Names the account, the limit and the provider's own numbers, because
        "the self improvement pass failed" is what he actually saw and it sent
        him nowhere.
        """
        if not self.terminal:
            return self.detail
        what = {
            "billing": ("The model provider refused the call for MONEY, not "
                        "for anything the code did"),
            "credentials": ("The model provider refused the API key itself"),
            "permission": ("The model provider refused this key permission "
                           "for that model or endpoint"),
        }.get(self.reason, "The model provider refused the call")
        lines = [f"{what} (HTTP {self.status})." if self.status
                 else f"{what}."]
        if self.adaptable:
            lines.append(
                f"It asked for up to {self.requested_tokens:,} tokens and the "
                f"key can afford {self.affordable_tokens:,} right now.")
        lines.append(
            "Retrying the same call cannot fix this, so nothing was retried. "
            "Fix the key — top up the account or raise that key's spend "
            "limit — and start the pass again.")
        if self.detail:
            lines.append(f"The provider said: {self.detail}")
        return " ".join(lines)


# ── peeling the envelope ────────────────────────────────────────────────────

def _peel(err: Any, depth: int = 0) -> list:
    """Every layer of an error, outermost first: dicts and the final text.

    Strings are re-parsed as JSON and then as a Python literal, because the
    same envelope reaches this module in both spellings: the broker sends
    JSON over HTTP, and `str(dict)` is what lands in `coding_sessions.error`.
    """
    if depth > _MAX_DEPTH or err is None:
        return []
    if isinstance(err, Fault):
        return [err.detail]
    if isinstance(err, (list, tuple)):
        out: list = []
        for item in err:
            out.extend(_peel(item, depth + 1))
        return out
    if isinstance(err, dict):
        out = [err]
        for key in _NEST_KEYS:
            if key in err and isinstance(err[key], (dict, list, str)):
                out.extend(_peel(err[key], depth + 1))
        return out
    text = str(err).strip()
    if not text:
        return []
    inner = _reparse(text)
    if inner is not None:
        return [text, *_peel(inner, depth + 1)]
    return [text]


def _reparse(text: str) -> Any:
    """A structured object hiding inside a string, or None.

    Tries the whole string, then the first {...} span in it — the broker
    prefixes its own sentence ("the coding agent returned an error: ") and a
    strict parse of the whole thing would find nothing.
    """
    for candidate in _brace_spans(text):
        for parse in (json.loads, ast.literal_eval):
            try:
                got = parse(candidate)
            except (ValueError, SyntaxError, MemoryError, RecursionError):
                continue
            if isinstance(got, (dict, list)):
                return got
    return None


def _brace_spans(text: str) -> list:
    start = text.find("{")
    if start < 0:
        return []
    spans = [text] if text.strip().startswith("{") else []
    spans.append(text[start:text.rfind("}") + 1] if "}" in text else text[start:])
    return spans


def _texts(layers: list) -> list:
    return [x for x in layers if isinstance(x, str)]


def _dicts(layers: list) -> list:
    return [x for x in layers if isinstance(x, dict)]


def _status_from(layers: list) -> Optional[int]:
    for d in _dicts(layers):
        for key in _STATUS_KEYS:
            n = _http_status(d.get(key))
            if n is not None:
                return n
        # `code` is a status in some APIs and a JSON-RPC number in others.
        # Bounding it to 100..599 is what tells them apart mechanically.
        n = _http_status(d.get("code"))
        if n is not None:
            return n
    for text in _texts(layers):
        m = _STATUS_IN_TEXT.search(text)
        if m:
            n = _http_status(m.group(1))
            if n is not None:
                return n
    return None


def _http_status(v: Any) -> Optional[int]:
    if v is None or isinstance(v, bool):
        return None
    try:
        n = int(str(v).strip())
    except (TypeError, ValueError):
        return None
    return n if 100 <= n <= 599 else None


def _codes_from(layers: list) -> list:
    out = []
    for d in _dicts(layers):
        for key in _CODE_KEYS:
            v = d.get(key)
            if isinstance(v, str) and v.strip():
                out.append(v.strip().lower())
    return out


# ── the provider's own numbers ──────────────────────────────────────────────

#: OpenRouter's 402 states the budget the key can actually afford. These two
#: patterns read NUMBERS the provider volunteered — the only place in this
#: module that looks at a sentence, and it decides nothing: it supplies a
#: value that would otherwise have to be guessed, and a guessed token budget
#: is the same failed call again.
_REQUESTED_RE = re.compile(
    r"requested\s+(?:up\s+to\s+)?([\d,]+)\s*(?:max_)?tokens", re.I)
_AFFORD_RE = re.compile(
    r"(?:can\s+only\s+)?afford\s+(?:up\s+to\s+)?([\d,]+)", re.I)


def token_budget(err: Any) -> tuple[Optional[int], Optional[int]]:
    """`(requested, affordable)` if the provider stated both, else Nones.

    NEVER a default and never a fraction of the request. If the affordable
    figure cannot be read, the caller must abort rather than pick a number:
    "retry smaller" with an invented size is indistinguishable from retrying
    the wall, and it spends real money finding that out.
    """
    layers = _peel(err)
    requested = affordable = None
    for text in _texts(layers):
        if requested is None:
            m = _REQUESTED_RE.search(text)
            if m:
                requested = _plain_int(m.group(1))
        if affordable is None:
            m = _AFFORD_RE.search(text)
            if m:
                affordable = _plain_int(m.group(1))
    return requested, affordable


def _plain_int(s: str) -> Optional[int]:
    try:
        return int(s.replace(",", ""))
    except (TypeError, ValueError):
        return None


# ── the verdict ─────────────────────────────────────────────────────────────

def classify(err: Any, *, status: Optional[int] = None) -> Fault:
    """Classify one provider failure. Always returns a Fault, never raises.

    `status` is the HTTP status when the caller already holds it (the LLM
    client does); it wins over anything parsed out of the body, because it is
    the transport's own fact rather than a reading of prose.
    """
    from app import redact

    layers = _peel(err)
    texts = _texts(layers)
    detail = redact.scrub_text(_innermost(texts), 500)
    st = _http_status(status) or _status_from(layers)
    codes = _codes_from(layers)

    fault = Fault(status=st, detail=detail, layers=layers)

    # A provider's own token beats the status: OpenAI's exhausted-account
    # answer is 429 + insufficient_quota, and treating it as a rate limit is
    # how a loop retries a wall all night.
    for code in codes:
        if code in _TERMINAL_CODES:
            fault.kind = TERMINAL
            fault.reason = _TERMINAL_CODES[code]
            break
    else:
        if st in _TERMINAL_STATUS:
            fault.kind = TERMINAL
            fault.reason = _TERMINAL_STATUS[st]
        elif st in _TRANSIENT_STATUS:
            fault.kind = TRANSIENT
            fault.reason = "rate_limit" if st == 429 else "server"

    if fault.reason == "billing" or st == 402:
        fault.requested_tokens, fault.affordable_tokens = token_budget(err)
    return fault


def _innermost(texts: list) -> str:
    """The deepest text layer — the provider's sentence, not the broker's."""
    for text in reversed(texts):
        if text.strip():
            return text.strip()
    return ""


def is_terminal(err: Any, *, status: Optional[int] = None) -> bool:
    return classify(err, status=status).terminal


# ── the same refusal, one layer down: the model router ──────────────────────
#
# A billing wall on a cloud provider must not look like "that model is
# unavailable". `agents/runner._fallback_target` walks a chain of models and
# retries the turn on each; when every link is served by the same key, one
# refusal becomes N identical refusals and a notification claiming the local
# tier is down. So a terminal refusal is REMEMBERED per provider slug, and
# `llm/router.effective_model` then treats that provider exactly as it already
# treats an unconfigured one: the call goes to the local fallback.
#
# IN-PROCESS AND TIME-BOXED, deliberately. It is a circuit breaker, not a
# state: nothing durable should encode "this key is broken", because the fix
# is an operator topping up an account and the breaker must forget on its own.
# It also clears itself the moment the provider row changes — a rotated key or
# a re-enabled provider is a different credential, and holding the old verdict
# against it would strand a provider the operator has just fixed.

#: How long a refusing provider is routed around before it is tried again.
#: Short on purpose: the cost of being wrong is running on a local model for a
#: few minutes, and the cost of being right is not billing a dead key.
BREAKER_TTL_S = 600.0

_refusing: dict = {}


def note_refusal(slug: str, fault: Fault, *, provider_version: str = "") -> None:
    """Remember that this provider refused for credential/billing reasons."""
    if not slug or not fault.terminal:
        return
    _refusing[slug] = {"at": time.monotonic(), "reason": fault.reason,
                       "detail": fault.detail, "status": fault.status,
                       "version": provider_version}
    log.error("provider %r refused for %s (HTTP %s) — routing around it for "
              "%d minutes: %s", slug, fault.reason, fault.status,
              int(BREAKER_TTL_S / 60), fault.detail[:200])


def refusing(slug: str, *, provider_version: str = "") -> Optional[dict]:
    """The live refusal for this provider, or None.

    `provider_version` is whatever identifies the credential in use — the
    provider row's `updated_at`. A different value clears the breaker, because
    the operator has changed something about this provider since it refused.
    """
    got = _refusing.get(slug)
    if not got:
        return None
    if time.monotonic() - got["at"] > BREAKER_TTL_S:
        _refusing.pop(slug, None)
        return None
    if provider_version and got.get("version") and \
            provider_version != got["version"]:
        log.info("provider %r changed since it refused; clearing the breaker",
                 slug)
        _refusing.pop(slug, None)
        return None
    return got


def clear_refusal(slug: str = "") -> None:
    """Forget one provider's refusal, or all of them."""
    if slug:
        _refusing.pop(slug, None)
    else:
        _refusing.clear()


def refusals() -> dict:
    """Every live refusal — what a status surface would show.

    Iterates a COPY: `refusing()` expires entries as it reads them, and
    mutating the dict under its own iterator raises.
    """
    return {slug: dict(v) for slug, v in list(_refusing.items())
            if refusing(slug) is not None}
