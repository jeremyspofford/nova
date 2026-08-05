"""Secrets — encrypted at rest, resolved at the call, never handed to a model.

    docker compose exec backend python tests/test_secrets.py

`docs/plans/secrets-management.md` phase 1. The concrete gap it closes:
`mcp_servers.headers` is JSONB and held whatever the operator typed, so a
GitHub token registered before this sat in plaintext in Postgres and went
straight to the client.

The properties worth pinning, in the order they would fail:

  1. the DB holds ciphertext, not the value
  2. nothing that lists secrets carries a value
  3. a missing reference RAISES — never an empty credential, which becomes
     someone else's confusing 401 three layers from the mistake
  4. a resolved value cannot reach the trace ledger
  5. a documented NOVA_* variable can actually REACH the container, and the
     master key is never swapped out from under existing ciphertext
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

FAILURES: list[str] = []
NAME = "zz-test-secret"
VALUE = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


async def run() -> None:
    import json
    from app import db, secret_store, settings_store, trace

    await db.init_pool()
    await settings_store.warm()
    try:
        print("1. it is encrypted at rest")
        await secret_store.put(NAME, VALUE, description="test")
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT value_enc, pg_typeof(value_enc)::text AS t FROM secrets "
                "WHERE name = $1", NAME)
        raw = bytes(row["value_enc"])
        check("stored as bytea", row["t"] == "bytea", row["t"])
        check("the plaintext is NOT in the row", VALUE.encode() not in raw)
        check("...and neither is a recognisable prefix", b"ghp_" not in raw)
        check("nonce is prepended, so two writes of the same value differ",
              raw[:12] != (await _blob(NAME, VALUE))[:12])

        print("2. nothing that lists secrets carries a value")
        listed = json.dumps(await secret_store.list_all())
        check("list_all", VALUE not in listed and "value_enc" not in listed)
        check("names()", VALUE not in json.dumps(await secret_store.names()))
        check("...but the operator can still read it back",
              await secret_store.reveal(NAME) == VALUE)

        print("3. references resolve at the call, and only then")
        headers = {"Authorization": f"Bearer {{{{secret:{NAME}}}}}",
                   "X-Other": "untouched"}
        check("references() finds it WITHOUT decrypting",
              secret_store.references(headers) == {NAME})
        out = await secret_store.resolve(headers)
        check("resolved", out["Authorization"] == f"Bearer {VALUE}")
        check("...leaving everything else alone", out["X-Other"] == "untouched")
        check("nested structures are walked",
              (await secret_store.resolve([{"k": [f"{{{{secret:{NAME}}}}}"]}]))
              == [{"k": [VALUE]}])

        print("4. a missing reference is a LOUD failure")
        try:
            await secret_store.resolve("Bearer {{secret:definitely-absent}}")
            check("raises rather than substituting nothing", False, "returned")
        except secret_store.SecretError as e:
            check("raises rather than substituting nothing — an empty "
                  "credential becomes a confusing 401 somewhere else",
                  "definitely-absent" in str(e), str(e)[:70])

        print("5. a resolved value cannot reach the ledger")
        red = trace.redact_args({"Authorization": f"Bearer {VALUE}"})
        check("masked by key name", VALUE not in str(red), str(red)[:60])
        check("...and by value shape, loose in text",
              VALUE not in trace.redact_text(f"the token is {VALUE}"))

        print("6. names are constrained — they go into config strings")
        for bad in ("Has Caps", "has spaces", "x", "a" * 80):
            try:
                await secret_store.put(bad, "v")
                check(f"rejects {bad!r}", False, "accepted")
            except ValueError:
                pass
        check("rejects names that would not survive a config string", True)

        print("7. phase 2 — a provider key never reaches the column")
        from app.llm import providers
        slug = "zztestprov"
        raw = "sk-zz-" + "abcdefghij0123456789"
        try:
            await providers.create(slug, "ZZ", "https://example.invalid/v1",
                                   api_key=raw, needs_key=True)
            async with db.acquire() as conn:
                col = await conn.fetchval(
                    "SELECT api_key FROM llm_providers WHERE slug = $1", slug)
            check("the column holds a REFERENCE, not the key",
                  col == f"{{{{secret:provider_{slug}_key}}}}", str(col))
            check("...and the key is nowhere in that column", raw not in (col or ""))
            check("the value went to the store, encrypted",
                  await secret_store.reveal(f"provider_{slug}_key") == raw)
            check("resolve_key still returns the real key at the call",
                  providers.resolve_key(providers.get(slug)) == raw)
            check("the public API shape carries no value and names the secret",
                  raw not in str(providers.list_public())
                  and any(p.get("secret_name") == f"provider_{slug}_key"
                          for p in providers.list_public()))

            # the failure that must be LOUD, not silent
            await secret_store.delete(f"provider_{slug}_key")
            await providers.warm()
            check("a provider whose secret is gone reads as UNCONFIGURED, not "
                  "as keyless — otherwise the operator hunts in the wrong place",
                  not providers.is_configured(slug)
                  and providers.resolve_key(providers.get(slug)) == "")
        finally:
            row = providers.get(slug)
            if row:
                await providers.delete(row["id"])
            async with db.acquire() as conn:
                await conn.execute("DELETE FROM secrets WHERE name = $1",
                                   f"provider_{slug}_key")

        print("8. phase 3 — external sources reference, never mirror")
        import os as _os
        tmp = "/tmp/zz-secret-src"
        open(tmp, "w").write("held-elsewhere\n")
        await secret_store.put_external("zz-ext-file", "file", tmp)
        async with db.acquire() as conn:
            enc = await conn.fetchval(
                "SELECT value_enc FROM secrets WHERE name = 'zz-ext-file'")
        check("no value is stored for an external row — the whole point of "
              "'reference, don't mirror'", enc is None)
        check("it resolves from the holder at the call",
              await secret_store.resolve("{{secret:zz-ext-file}}") == "held-elsewhere")

        _os.environ["ZZ_SECRET_ENV"] = "from-env"
        await secret_store.put_external("zz-ext-env", "env", "ZZ_SECRET_ENV")
        check("a second source needs only a resolver",
              await secret_store.resolve("{{secret:zz-ext-env}}") == "from-env")

        try:
            await secret_store.put_external("zz-ext-bad", "file", "/nope/missing")
            check("a bad reference is refused AT SAVE", False, "accepted")
        except secret_store.SecretError:
            check("a bad reference is refused AT SAVE, while the operator is "
                  "still looking at it — not at 3am from someone else's 401", True)

        try:
            await secret_store.put_external("zz-ext-op", "1password", "op://x/y/z")
            check("a CLI-backed manager is gated", False, "accepted")
        except secret_store.SecretError as e:
            check("a CLI-backed manager says exactly what is missing",
                  "not installed" in str(e), str(e)[:60])
        check("...and the UI is told it is unavailable",
              not next(o for o in secret_store.source_options()
                       if o["source"] == "1password")["available"])
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM secrets WHERE name LIKE 'zz-ext-%'")

        print("9. the agent-facing half is names only")
        from app.tools import builtin
        out = await builtin._list_secret_names({}, {})
        check("no value in the tool result", VALUE not in out)
        check("...and no tool exists that returns one",
              not any("secret" in n and "reveal" in n
                      for n in builtin.BUILTIN_TOOLS),
              str([n for n in builtin.BUILTIN_TOOLS if "secret" in n]))

        print("10. a variable .env.example documents can REACH the container")
        _env_example_vars_are_wired()

        print("11. the master key is never swapped under existing ciphertext")
        _key_conflict_is_refused()
    finally:
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM secrets WHERE name = $1", NAME)
        await db.close_pool()


async def _blob(name: str, value: str) -> bytes:
    """Re-encrypt the same value to prove the nonce differs per write."""
    from app import secret_store
    return secret_store._encrypt(value)


def _env_example_vars_are_wired() -> None:
    """Every NOVA_* variable .env.example documents must be declared in a
    compose file, or setting it does nothing at all.

    There is no `env_file:` in docker-compose.yml — compose interpolates each
    variable it names, one at a time, and ignores the rest of .env. So a
    documented variable that no service declares is not "a default"; it is
    unreachable, and the operator has no way to tell the difference from
    outside the container. Two shipped that way and both were found by
    someone debugging the feature months later: NOVA_VAPID_SUB (whose real
    control turned out to be a setting) and NOVA_SECRET_KEY, the master key
    for this very store — the remedy the code PRINTED on every start.

    NOVA_* rather than every key, because the docker CLI reads a few of its
    own (COMPOSE_FILE) from the environment and no service block would ever
    name them; the prefix keeps this derived from the file rather than from
    an exemption list somebody has to maintain.

    Commented lines count on the .env.example side — `#NOVA_MEMORY_DIR=./data/
    memory` is documentation of a supported variable, which is exactly the
    claim under test. They do NOT count on the compose side: the same edit
    that declared NOVA_SECRET_KEY also wrote a paragraph of comment above it
    naming the variable, and a check a comment can satisfy would have passed
    on the paragraph alone. Declarations only.
    """
    import glob
    import os
    import re
    root = os.environ.get("NOVA_PROJECT_DIR", "/app/project")
    example = os.path.join(root, ".env.example")
    if not os.path.exists(example):
        check("the project mount carries .env.example", False, example)
        return
    with open(example) as f:
        documented = sorted(set(re.findall(r"^\s*#?\s*(NOVA_[A-Z0-9_]+)\s*=",
                                           f.read(), re.M)))
    check("…and it documents NOVA_* variables at all", bool(documented),
          str(documented))
    compose = ""
    for path in sorted(glob.glob(os.path.join(root, "docker-compose*.yml"))):
        with open(path) as f:
            for line in f:
                compose += line.split("#", 1)[0] + "\n"
    missing = [v for v in documented
               if not re.search(rf"\b{re.escape(v)}\b", compose)]
    check("every documented NOVA_* variable is declared in a compose file — "
          "one that is not cannot reach any container, whatever .env says",
          not missing, "unreachable: " + ", ".join(missing) if missing else "")


def _key_conflict_is_refused() -> None:
    """NOVA_SECRET_KEY arriving on a machine that already generated one is a
    refusal, not a silent switch.

    The wiring fix that let NOVA_SECRET_KEY reach the container would, on its
    own, have destroyed data on any instance already running: this host has
    held a generated key at /state/secret.key since 2026-07-30 with live rows
    under it, and `_load_key` used to return the environment key first and
    never look at the file. Every stored secret would have become
    undecryptable at the first resolution, reported as "the master key
    changed" by a key the operator did not knowingly change.
    """
    import base64
    import os
    import tempfile
    from app import secret_store

    a = base64.urlsafe_b64encode(b"A" * 32).decode()
    b = base64.urlsafe_b64encode(b"B" * 32).decode()
    saved_cache, saved_file = secret_store._key_cache, secret_store._KEY_FILE
    saved_env = os.environ.get("NOVA_SECRET_KEY")
    fd, tmp = tempfile.mkstemp()
    with os.fdopen(fd, "w") as f:
        f.write(a)
    try:
        secret_store._KEY_FILE = tmp

        secret_store._key_cache = None
        os.environ["NOVA_SECRET_KEY"] = b
        try:
            secret_store._load_key()
            check("a DIFFERENT env key is refused", False, "loaded it")
        except secret_store.SecretError as e:
            check("a DIFFERENT env key is refused rather than silently "
                  "orphaning every row encrypted under the stored one",
                  tmp in str(e), str(e)[:80])
            check("…and the refusal says how to get out of it, both ways",
                  "unset" in str(e) and "re-enter" in str(e))

        secret_store._key_cache = None
        os.environ["NOVA_SECRET_KEY"] = a
        check("the SAME key in both places is not a conflict — a fleet that "
              "pins the key it already generated must keep working",
              secret_store._load_key() == b"A" * 32)

        secret_store._key_cache = None
        os.environ.pop("NOVA_SECRET_KEY", None)
        check("unset still falls back to the persisted key",
              secret_store._load_key() == b"A" * 32)
    finally:
        os.unlink(tmp)
        secret_store._KEY_FILE = saved_file
        # restore the LIVE key, not a reload: the tests above deliberately
        # poisoned the module globals this process resolves secrets with
        secret_store._key_cache = saved_cache
        if saved_env is None:
            os.environ.pop("NOVA_SECRET_KEY", None)
        else:
            os.environ["NOVA_SECRET_KEY"] = saved_env


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
