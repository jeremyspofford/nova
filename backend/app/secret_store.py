"""Encrypted secrets — stored by name, resolved at the outbound call, never
shown to a model.

`docs/plans/secrets-management.md` phase 1. Named `secret_store` rather than
`secrets` on purpose: Python has a stdlib `secrets`, and a module that shadows
it inside `app/` is a footgun for every future import in this package. Matches
`settings_store` either way.

THE SHAPE, and the reason for each part:

* **Reference, resolve late.** Config holds `{{secret:github_pat}}`; the value
  is substituted in the backend immediately before the request goes out. The
  DB stops holding plaintext, the model only ever sees the reference, and the
  value exists in memory for the length of one call.
* **No resolve capability for agents, ever.** There is no tool in this module's
  future that returns a value. Listing NAMES is fine and is what lets Nova say
  "store a token called github_pat and I will wire it"; the value path is
  backend-only, by having no other path.
* **Unknown name is a hard error.** Never an empty string — that turns a
  missing secret into a confusing 401 from someone else's server, three layers
  away from the actual mistake.

MASTER KEY. `NOVA_SECRET_KEY` (base64, 32 bytes) from the environment is the
real answer. Without it a key is generated and persisted, and the location is
a correction to the plan worth explaining: it says `./data/secret.key`, but
`/app/data` is the container's OVERLAY filesystem — only `data/memory`,
`data/wake-training` and `data/runtime` are binds. A key written there would
vanish on the next `docker compose up -d backend` and take every stored secret
with it, which is the plan's own "unrecoverable" trap sprung by a routine
restart rather than by operator error. `/state` is a named volume, already
holding the per-host instance id for exactly this reason.

Two things the fallback cannot do, both warned about loudly at generation:
losing the key loses the secrets, and the key is PER HOST — a second instance
sharing this Postgres has its own `/state` and will not decrypt these rows. A
fleet needs `NOVA_SECRET_KEY` set to the same value everywhere.
"""

from __future__ import annotations

import base64
import logging
import os
import re
import secrets as _stdlib_secrets
from typing import Any, Optional

from app import db

log = logging.getLogger(__name__)

_KEY_FILE = os.environ.get("NOVA_SECRET_KEY_FILE", "/state/secret.key")
_REF_RE = re.compile(r"\{\{secret:([a-zA-Z0-9_.-]{1,64})\}\}")

# Slug-ish: this name goes into config strings and UI, so keep it boring.
_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,62}[a-z0-9]$")

_key_cache: Optional[bytes] = None


class SecretError(RuntimeError):
    """A reference that cannot be resolved. Surfaced to the operator, never
    swallowed — a silently-empty credential is a worse bug than a loud one."""


def _load_key() -> bytes:
    global _key_cache
    if _key_cache:
        return _key_cache
    env = (os.environ.get("NOVA_SECRET_KEY") or "").strip()
    if env:
        try:
            key = base64.urlsafe_b64decode(env + "=" * (-len(env) % 4))
        except Exception as exc:
            raise SecretError(
                "NOVA_SECRET_KEY is not valid base64 — secrets cannot be "
                "decrypted. Fix it or unset it; do not guess.") from exc
        if len(key) != 32:
            raise SecretError(
                f"NOVA_SECRET_KEY decodes to {len(key)} bytes, need 32.")
        _key_cache = key
        return key

    try:
        with open(_KEY_FILE, "rb") as f:
            key = base64.urlsafe_b64decode(f.read().strip())
        if len(key) == 32:
            _key_cache = key
            return key
        log.error("%s does not hold a 32-byte key; regenerating", _KEY_FILE)
    except FileNotFoundError:
        pass
    except OSError as exc:
        raise SecretError(f"cannot read the master key at {_KEY_FILE}: {exc}") from exc

    key = _stdlib_secrets.token_bytes(32)
    try:
        os.makedirs(os.path.dirname(_KEY_FILE), exist_ok=True)
        fd = os.open(_KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(base64.urlsafe_b64encode(key))
    except OSError as exc:
        raise SecretError(
            f"generated a master key but could not persist it to {_KEY_FILE} "
            f"({exc}) — refusing to encrypt secrets that could not be read "
            f"back after a restart.") from exc
    log.warning(
        "NOVA_SECRET_KEY is not set. Generated a master key and saved it to "
        "%s. TWO THINGS THIS MEANS: lose that file and every stored secret is "
        "unrecoverable, and the key is PER HOST — a second instance sharing "
        "this database will not be able to decrypt these secrets. Set "
        "NOVA_SECRET_KEY in .env for anything beyond one machine.", _KEY_FILE)
    _key_cache = key
    return key


def _encrypt(value: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = _stdlib_secrets.token_bytes(12)
    # AAD is empty: there is nothing associated worth binding — the row's own
    # name is the lookup key, and binding to it would break a rename that the
    # UI may reasonably want later.
    return nonce + AESGCM(_load_key()).encrypt(nonce, value.encode(), None)


def _decrypt(blob: bytes) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not blob or len(blob) < 13:
        raise SecretError("stored value is truncated or empty")
    try:
        return AESGCM(_load_key()).decrypt(bytes(blob[:12]), bytes(blob[12:]),
                                           None).decode()
    except Exception as exc:
        raise SecretError(
            "could not decrypt — this usually means the master key changed. "
            "The ciphertext is worthless without the original key; the secret "
            "has to be re-entered.") from exc


def _public(r) -> dict:
    """What leaves this module. Never the value, in any shape."""
    return {"name": r["name"], "source": r["source"], "ref": r["ref"],
            "description": r["description"],
            "created_at": str(r["created_at"]) if r["created_at"] else None,
            "updated_at": str(r["updated_at"]) if r["updated_at"] else None,
            "last_used_at": str(r["last_used_at"]) if r["last_used_at"] else None,
            "has_value": r["value_enc"] is not None}


async def list_all() -> list[dict]:
    async with db.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM secrets ORDER BY name")
    return [_public(r) for r in rows]


async def names() -> list[str]:
    """Just the names — what an agent may ever see of this table."""
    async with db.acquire() as conn:
        rows = await conn.fetch("SELECT name FROM secrets ORDER BY name")
    return [r["name"] for r in rows]


async def put(name: str, value: str, *, description: str = "") -> dict:
    name = (name or "").strip().lower()
    if not _NAME_RE.match(name):
        raise ValueError(
            "name must be lowercase letters, digits, dot, dash or underscore "
            "(2-64 chars) — it goes into config strings like "
            "{{secret:github_pat}}")
    if not value:
        raise ValueError("value is required")
    blob = _encrypt(value)
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """INSERT INTO secrets (name, source, value_enc, description)
               VALUES ($1, 'builtin', $2, $3)
               ON CONFLICT (name) DO UPDATE
                 SET value_enc = EXCLUDED.value_enc,
                     description = COALESCE(NULLIF(EXCLUDED.description, ''),
                                            secrets.description),
                     source = 'builtin', ref = NULL, updated_at = now()
            RETURNING *""", name, blob, (description or "").strip())
    log.info("secret stored: %s (%d bytes ciphertext)", name, len(blob))
    return _public(r)


async def reveal(name: str) -> str:
    """The plaintext. Reachable ONLY from the operator-authenticated endpoint —
    there is deliberately no tool, no agent path, and no caller in the runner."""
    async with db.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM secrets WHERE name = $1", name)
    if not r:
        raise SecretError(f"no secret named '{name}'")
    if r["source"] != "builtin":
        # fetched live from the holder — Nova stores the reference, never
        # the value, so this is a read-through rather than a lookup
        return await _resolve_external(r["source"], r["ref"])
    return _decrypt(r["value_enc"])


async def delete(name: str) -> bool:
    async with db.acquire() as conn:
        result = await conn.execute("DELETE FROM secrets WHERE name = $1", name)
    return result.endswith("1")


async def used_by(name: str) -> list[str]:
    """Which MCP servers reference this name, so deleting a live one warns."""
    token = f"{{{{secret:{name}}}}}"
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT name FROM mcp_servers "
            "WHERE headers::text LIKE '%' || $1 || '%' OR url LIKE '%' || $1 || '%'",
            token)
    return [r["name"] for r in rows]




# ── sources ──────────────────────────────────────────────────────────────
#
# Phase 3. "Reference, don't mirror": an external secret's VALUE never enters
# Nova's database — only the pointer does, and the holder is asked at call
# time. That is the whole difference between this and copying a vault into
# Postgres, which the 2026-07-21 decision rejected.
#
# Each source is one function behind a common signature, so adding a manager
# is a resolver plus a CHECK entry and nothing else.

async def _from_file(ref: str) -> str:
    """A path. Docker secrets (/run/secrets/x), Kubernetes secret mounts,
    anything the operator arranges to appear in the container. Needs no
    dependency at all, which is why it is here and 1Password is not yet."""
    try:
        with open(ref) as f:
            return f.read().strip()
    except OSError as exc:
        raise SecretError(f"cannot read '{ref}': {exc}") from exc


async def _from_env(ref: str) -> str:
    """A variable. Honest about its limits: env is visible to anything that
    can read the process, so this is for bootstrap and CI rather than for
    the credentials the built-in store exists to protect."""
    val = os.environ.get(ref)
    if val is None:
        raise SecretError(f"environment variable '{ref}' is not set")
    return val.strip()


def _needs_cli(tool: str, hint: str):
    async def _resolver(ref: str) -> str:
        raise SecretError(
            f"this secret is held in {tool}, which Nova cannot reach: the "
            f"`{hint}` command is not installed in the backend image. It "
            f"needs either that binary added or a small sidecar to hold it — "
            f"an infrastructure decision, not something this can work around. "
            f"Until then, store the value in the built-in store instead.")
    return _resolver


# source -> (resolver, human name, what `ref` should look like)
SOURCES: dict[str, tuple[Any, str, str]] = {
    "builtin":     (None, "Nova's encrypted store", ""),
    "file":        (_from_file, "a file in the container",
                    "/run/secrets/github_pat"),
    "env":         (_from_env, "an environment variable", "GITHUB_PAT"),
    "1password":   (_needs_cli("1Password", "op"), "1Password",
                    "op://Private/GitHub/token"),
    "bitwarden":   (_needs_cli("Bitwarden", "bw"), "Bitwarden", "<item-id>"),
    "vaultwarden": (_needs_cli("Vaultwarden", "bw"), "Vaultwarden", "<item-id>"),
}


def source_options() -> list[dict]:
    """What the UI offers, derived from the table above so a new resolver
    appears in the picker without a second edit."""
    return [{"source": k, "label": v[1], "ref_example": v[2],
             "available": k == "builtin" or not _is_gated(k)}
            for k, v in SOURCES.items()]


def _is_gated(source: str) -> bool:
    fn = SOURCES.get(source, (None,))[0]
    return getattr(fn, "__qualname__", "").startswith("_needs_cli")


async def put_external(name: str, source: str, ref: str, *,
                       description: str = "") -> dict:
    """Record a POINTER. No value is stored, now or ever, for this row."""
    name = (name or "").strip().lower()
    if not _NAME_RE.match(name):
        raise ValueError("name must be lowercase letters, digits, dot, dash "
                         "or underscore (2-64 chars)")
    if source not in SOURCES or source == "builtin":
        raise ValueError(f"unknown external source '{source}' — one of: "
                         + ", ".join(k for k in SOURCES if k != "builtin"))
    ref = (ref or "").strip()
    if not ref:
        raise ValueError("a reference is required — "
                         f"e.g. {SOURCES[source][2]}")
    # Prove it resolves BEFORE saving. A pointer that was never followed is a
    # broken integration discovered at the worst possible moment, and the
    # operator is right here to fix a typo.
    await _resolve_external(source, ref)
    async with db.acquire() as conn:
        r = await conn.fetchrow(
            """INSERT INTO secrets (name, source, ref, description, value_enc)
               VALUES ($1, $2, $3, $4, NULL)
               ON CONFLICT (name) DO UPDATE
                 SET source = EXCLUDED.source, ref = EXCLUDED.ref,
                     value_enc = NULL,
                     description = COALESCE(NULLIF(EXCLUDED.description, ''),
                                            secrets.description),
                     updated_at = now()
            RETURNING *""", name, source, ref, (description or "").strip())
    log.info("secret '%s' now points at %s (%s) — no value stored", name,
             source, ref)
    return _public(r)


async def _resolve_external(source: str, ref: str) -> str:
    fn = SOURCES.get(source, (None,))[0]
    if fn is None:
        raise SecretError(f"'{source}' has no resolver")
    return await fn(ref)


# ── resolution ───────────────────────────────────────────────────────────

def references(value: Any) -> set[str]:
    """Every {{secret:NAME}} in a string, dict or list — without resolving."""
    out: set[str] = set()
    if isinstance(value, str):
        out.update(_REF_RE.findall(value))
    elif isinstance(value, dict):
        for k, v in value.items():
            out |= references(k) | references(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            out |= references(v)
    return out


async def resolve(value: Any) -> Any:
    """Substitute every reference, or raise.

    Walks strings, dicts and lists so a whole headers object can be handed in.
    One DB round trip for the whole structure, and `last_used_at` is stamped
    for what was actually resolved — a secret nothing resolves is visible in
    the UI as the dead weight it probably is.
    """
    wanted = references(value)
    if not wanted:
        return value
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT * FROM secrets WHERE name = ANY($1::text[])", list(wanted))
    found = {r["name"]: r for r in rows}
    missing = sorted(wanted - set(found))
    if missing:
        raise SecretError(
            "no secret named " + ", ".join(f"'{m}'" for m in missing)
            + ". Store it in Settings -> Secrets first; nothing was sent.")

    plain: dict[str, str] = {}
    for name, row in found.items():
        if row["source"] == "builtin":
            plain[name] = _decrypt(row["value_enc"])
        else:
            # asked of the holder, at call time, never stored here
            plain[name] = await _resolve_external(row["source"], row["ref"])

    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE secrets SET last_used_at = now() WHERE name = ANY($1::text[])",
            list(found))

    def _sub(v: Any) -> Any:
        if isinstance(v, str):
            return _REF_RE.sub(lambda m: plain[m.group(1)], v)
        if isinstance(v, dict):
            return {_sub(k): _sub(x) for k, x in v.items()}
        if isinstance(v, list):
            return [_sub(x) for x in v]
        return v

    return _sub(value)


# ── rotation nudge ───────────────────────────────────────────────────────

_last_rotation_check = 0.0


async def maybe_nudge_rotation() -> int:
    """One card per stale secret, once. Leader-gated by the caller.

    Deliberately a nudge and not an action: Nova cannot rotate anything,
    because only the operator holds the new value. Raising a card she cannot
    act on herself is the honest shape — the alternative, staying silent about
    a two-year-old token, is how credentials quietly outlive their purpose.

    `dedupe_key` carries the secret's `updated_at`, so replacing the value
    makes a genuinely new card possible next time and re-raising for the SAME
    stale value is impossible.
    """
    global _last_rotation_check
    import time
    from app import settings_store
    now = time.monotonic()
    if _last_rotation_check and now - _last_rotation_check < 24 * 3600:
        return 0
    _last_rotation_check = now
    try:
        days = int(settings_store.get("secrets.rotate_after_days") or 0)
    except (TypeError, ValueError):
        days = 0
    if days <= 0:
        return 0
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT name, updated_at FROM secrets "
            "WHERE updated_at < now() - make_interval(days => $1)", days)
    if not rows:
        return 0
    from app import recommendations
    raised = 0
    async with db.acquire() as conn:
        seen = {k for (k,) in await conn.fetch(
            "SELECT dedupe_key FROM recommendations WHERE dedupe_key LIKE 'rotate:%'")}
    for r in rows:
        age = (r["updated_at"].isoformat() if r["updated_at"] else "?")[:10]
        # ONCE, and this check is why. `recommendations.create` REFRESHES an
        # undecided card with the same dedupe_key — resetting it to new and
        # re-pinging the operator's devices — so calling it daily would nag
        # about an unchanged secret every day until he answered. Skipping a
        # key that already exists in ANY status makes the docstring above
        # true: replacing the value changes the date in the key, which is a
        # genuinely new card; leaving it alone is silence.
        if f"rotate:{r['name']}:{age}" in seen:
            continue
        try:
            await recommendations.create(
                "note", f"Rotate the secret '{r['name']}'?",
                f"'{r['name']}' has not changed since {age}, which is more "
                f"than {days} days. Nothing is wrong with it — this is a "
                f"reminder, and only you can replace the value "
                f"(Settings -> Secrets). Dismiss if it is fine as it is.",
                source="secret-store", dedupe_key=f"rotate:{r['name']}:{age}")
            raised += 1
        except ValueError:
            pass          # rate-limited or duplicate; the card already exists
    log.info("rotation nudge: %d secret(s) past %d days", raised, days)
    return raised
