"""Secret scrubbing — what must never be stored, and what must never be lost.

    docker compose exec backend python tests/test_redaction.py

Tool arguments are the most credential-dense values Nova handles, and they
come to rest in two places with different lifetimes: the turn ledger's spans
(~14 days) and the activity trail persisted as role='tool' message rows (~30
days). Until now those had two different policies and one of them was none —
`_brief()` was `json.dumps(args)[:200]` verbatim — so the careful scrubbing
was defeated by reading the other table.

BOTH halves are tested here, against the same table of cases, because a
scrubber applied to one sink is not a scrubber.

The second table matters as much as the first. The Turn Inspector exists to
answer "what did she actually do"; a span reading {"url": "•••"} answers
nothing, and an operator who cannot see which host was fetched stops looking.
Over-redaction is not the safe direction — it is a different failure.
"""

import json
import sys

sys.path.insert(0, "/app/backend")

from app import redact, trace                     # noqa: E402
from app.agents import runner                     # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# (args, the substring that must NOT survive) — real credential formats
MUST_MASK = [
    ({"url": "https://api.x.com/v1?api_key=SECRETVALUE123&q=cats"}, "SECRETVALUE123"),
    ({"url": "https://api.openweathermap.org/data?appid=abc123def456&q=Chicago"}, "abc123def456"),
    ({"url": "https://x.com/f?access_token=ya29.A0ARrdaM_secret"}, "ya29.A0ARrdaM_secret"),
    ({"url": "https://user:hunter2@example.com/feed"}, "hunter2"),
    ({"body": "my token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"}, "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"),
    ({"note": "slack hook xoxb-1234567890-abcdefghij"}, "xoxb-1234567890-abcdefghij"),
    ({"cfg": "AKIAIOSFODNN7EXAMPLE"}, "AKIAIOSFODNN7EXAMPLE"),
    ({"cfg": "AIzaSyD-1234567890abcdefghijklmnopqrs"}, "AIzaSyD-1234567890abcdefghijklmnopqrs"),
    ({"h": "Authorization: Bearer abc123xyz"}, "abc123xyz"),
    ({"h": "Basic dXNlcjpwYXNzd29yZA=="}, "dXNlcjpwYXNzd29yZA=="),
    ({"jwt": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc"}, "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"),
    ({"api_key": "plainvalue"}, "plainvalue"),                    # by key name
    ({"headers": {"auth": "Basic dXNlcjpwYXNz"}}, "dXNlcjpwYXNz"),
    ({"nested": {"deep": {"password": "hunter2"}}}, "hunter2"),
    ({"list": [{"client_secret": "shhhh"}]}, "shhhh"),
    ({"pem": "-----BEGIN RSA PRIVATE KEY-----MIIEow"}, "MIIEow"),
    # a secret assigned inside a STRING — an unparseable argument blob, a
    # provider error body echoing the request, a log line
    ({"raw": '{"api_key": "hunter2", broken'}, "hunter2"),
    ({"raw": "token=abc123secret&next=1"}, "abc123secret"),
    ({"err": 'invalid value for password: "sw0rdfish"'}, "sw0rdfish"),
]

# (args, the substring that MUST survive) — the reason anyone reads a trace
MUST_KEEP = [
    ({"url": "https://en.wikipedia.org/wiki/Lighthouse"}, "en.wikipedia.org/wiki/Lighthouse"),
    ({"url": "https://api.x.com/v1?api_key=SECRET&q=cats"}, "api.x.com/v1?api_key="),
    ({"url": "https://api.x.com/v1?api_key=SECRET&q=cats"}, "q=cats"),
    ({"author": "Jeremy Spofford"}, "Jeremy Spofford"),           # not "auth"
    ({"authorized_by": "operator"}, "operator"),
    ({"query": "best espresso beans"}, "best espresso beans"),
    ({"item_id": "topics/coffee.md"}, "topics/coffee.md"),
    ({"sha": "8f05849c3a1b2d4e5f6a7b8c9d0e1f2a3b4c5d6e"}, "8f05849c3a1b"),
    ({"uuid": "1e10a0cc-6aef-4d4c-bd6d-95871204d3c4"}, "1e10a0cc-6aef"),
    ({"url": "https://user:hunter2@example.com/feed"}, "user:"),  # who, not what
    ({"content": "The keynote covered secret management."}, "secret management"),
    ({"note": "the tokenizer split it oddly"}, "tokenizer"),
    ({"raw": '{"api_key": "hunter2", broken'}, "api_key"),     # the NAME stays
]


def run_table(name, fn):
    print(f"{name}")
    for args, secret in MUST_MASK:
        out = fn(args)
        check(f"masks {secret[:34]}", secret not in out, out[:90])
    for args, keep in MUST_KEEP:
        out = fn(args)
        check(f"keeps {keep[:34]}", keep in out, out[:90])


def test_both_sinks():
    # the turn ledger
    run_table("1. trace.redact_args — the turn ledger's spans (~14 days)",
              trace.redact_args)
    # the activity trail, which lives LONGER and used to be raw
    run_table("2. runner._brief — the persisted activity trail (~30 days)",
              runner._brief)


def test_unparseable_args():
    print("4. the raw argument blob — parseable or not")
    parsed = redact.scrub_json_text('{"api_key": "hunter2", "q": "cats"}', 200)
    check("parses and masks by key name", "hunter2" not in parsed, parsed)
    check("...keeping the rest", '"q": "cats"' in parsed, parsed)
    broken = redact.scrub_json_text('{"api_key": "hunter2", broken', 200)
    check("unparseable blob is still masked", "hunter2" not in broken, broken)
    check("...and still legible", "api_key" in broken, broken)


def test_text_and_edges():
    print("3. free text and edges")
    t = redact.scrub_text("see https://api.x.com/v1?token=abc123def456ghi for the feed")
    check("a secret in free text is masked", "abc123def456ghi" not in t, t)
    check("...and the sentence around it survives", "for the feed" in t, t)

    check("empty text", redact.scrub_text("") == "")
    check("None text", redact.scrub_text(None) == "")
    check("limit is applied", len(redact.scrub_text("x" * 900, 100)) == 100)

    # a scrubber that emits the RAW value when it trips is worse than one
    # that emits nothing — it fails open on exactly the weird inputs
    class Unserializable:
        pass

    out = redact.scrub_args({"bad": Unserializable(), "api_key": "leak"}, 200)
    check("unserializable args fail CLOSED, not open",
          "leak" not in out and out == "{}", out)

    check("non-string keys do not crash",
          "1" in redact.scrub_args({1: "one"}, 200))

    # the mask itself must survive a JSON round trip (it is written to a
    # jsonb column and re-read by the inspector)
    round_tripped = json.loads(trace.redact_args({"api_key": "x"}))
    check("masked value survives json round trip",
          round_tripped["api_key"] == redact.MASK, str(round_tripped))


def main() -> int:
    test_both_sinks()
    test_unparseable_args()
    test_text_and_edges()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
