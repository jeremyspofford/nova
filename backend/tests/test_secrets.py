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
    finally:
        async with db.acquire() as conn:
            await conn.execute("DELETE FROM secrets WHERE name = $1", NAME)
        await db.close_pool()


async def _blob(name: str, value: str) -> bytes:
    """Re-encrypt the same value to prove the nonce differs per write."""
    from app import secret_store
    return secret_store._encrypt(value)


def main() -> int:
    asyncio.run(run())
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
