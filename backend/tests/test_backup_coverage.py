"""Backup coverage refuses rather than guessing (roadmap #31, phase 1).

    docker compose exec backend python tests/test_backup_coverage.py

Runs entirely offline against fixtures — no docker, no database, no live
stack — because the decision table is the thing under test and it must be
checkable without the machine it describes.

The case that motivated every check here: on 2026-08-02 the backup plan,
ROADMAP #31 and secret_store.py each carried a hand-maintained list of
Nova's state, and all three were stale in different ways. The plan alone was
missing five tiers, one of which (`./data/attachments`) holds the only copy
of documents photographed on a phone. So the tests below are less about
"does it classify correctly" and more about "does it REFUSE when it does not
know" — a backup that silently omits a tier is worse than no backup, because
it will be trusted.
"""

import sys

sys.path.insert(0, "/app/backend")

from app import backup_coverage as bc                        # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# the live stack as measured 2026-08-02, plus the negative controls
PROJECT = "/home/jeremy/workspace/nova"
TRACKED = {f"{PROJECT}/backend", f"{PROJECT}/frontend/src", f"{PROJECT}/docs",
           f"{PROJECT}/searxng/settings.yml"}
IGNORED = {f"{PROJECT}/data/memory", f"{PROJECT}/data/attachments",
           f"{PROJECT}/data/runtime", f"{PROJECT}/data/wake-training"}


def git_status(path: str) -> str:
    if path in TRACKED:
        return "tracked"
    if path in IGNORED:
        return "ignored"
    return "unknown"


def inv(kind, name, source="compose", **kw):
    return {"kind": kind, "name": name, "source": source, **kw}


LIVE = [
    inv("volume", "nova_postgres_data"),
    inv("volume", "nova_nova_state"),
    inv("volume", "nova_ollama_models"),
    inv("bind", f"{PROJECT}/data/memory", mounted_at="/app/data/memory"),
    inv("bind", f"{PROJECT}/data/attachments", mounted_at="/app/data/attachments"),
    inv("bind", f"{PROJECT}/backend", mounted_at="/app/backend"),
]


print("1. the tiers that matter are included, derived from git")
rep = bc.report(LIVE, git_status=git_status)
inc = set(rep["included"])
check("the memory tree is in", f"{PROJECT}/data/memory" in inc)
check("the attachments blob store is in — the tier the 12-day-old spec "
      "missed, included with NO code change because it is gitignored",
      f"{PROJECT}/data/attachments" in inc)
check("the database is in, via pg_dump rather than a file copy",
      "nova_postgres_data" in inc)
check("the control volume (secret.key, instance_id) is in",
      "nova_nova_state" in inc)
check("source code is NOT in — it restores from the repo",
      f"{PROJECT}/backend" not in inc)
check("model weights are NOT in — re-downloadable",
      "nova_ollama_models" not in inc)
check("with everything classified, a snapshot may proceed", rep["may_snapshot"],
      str(rep["refusals"])[:80])

print("\n2. an UNKNOWN named volume refuses — it does not default to skip")
rep = bc.report(LIVE + [inv("volume", "nova_brand_new_store")],
                git_status=git_status)
check("a snapshot is refused", not rep["may_snapshot"])
check("...naming the volume", any("brand_new_store" in r["subject"]
                                  for r in rep["refusals"]),
      str(rep["refusals"][:1])[:120])
check("...and it is NOT silently excluded",
      "nova_brand_new_store" not in set(rep["included"]))

print("\n3. an unexpanded ${VAR} refuses rather than taking the default")
# the one bind that uses a variable is the memory store: falling back to
# ./data/memory when NOVA_MEMORY_DIR points at a NAS snapshots the wrong tree
rep = bc.report([inv("bind", "${NOVA_MEMORY_DIR:-./data/memory}")],
                git_status=git_status)
check("refused", not rep["may_snapshot"])
check("...explaining that the default would snapshot the wrong directory",
      any("default" in r["detail"] for r in rep["refusals"]))

print("\n4. a bind outside the project refuses — git has no opinion on it")
rep = bc.report([inv("bind", "/mnt/somewhere/else")], git_status=git_status)
check("refused", not rep["may_snapshot"])

print("\n5. R2 — anything included must actually be READABLE by the runner")
reach = bc.report(LIVE, git_status=git_status,
                  readable=lambda p: "attachments" not in p)
check("a tier the runner cannot read refuses the whole snapshot",
      not reach["may_snapshot"])
check("...and says which mount to add",
      any(r["code"] == "R2_UNREACHABLE" for r in reach["refusals"]),
      str([r["code"] for r in reach["refusals"]]))

print("\n6. R5 — host state that NO container mounts is still covered")
# .env holds POSTGRES_PASSWORD and NOVA_AUTH_TOKEN and is mounted by nothing,
# so no compose-derived or container-derived signal can see it
rep = bc.report(LIVE, git_status=git_status,
                ignored_paths=[f"{PROJECT}/.env"])
check("an unmounted secret file is refused, not invisible",
      not rep["may_snapshot"])
check("...by the host-state check specifically",
      any(r["code"] == "R5_UNCOVERED_HOST_STATE" for r in rep["refusals"]))
check("state already inside an included bind does NOT double-refuse",
      bc.report(LIVE, git_status=git_status,
                ignored_paths=[f"{PROJECT}/data/memory/topics"])["may_snapshot"])

print("\n7. nested binds collapse to one root — no tier archived twice")
nested = bc.report(
    [inv("bind", f"{PROJECT}/data/memory"),
     inv("bind", f"{PROJECT}/data/memory/journals")],
    git_status=lambda p: "ignored")
check("the child is dropped", nested["included"] == [f"{PROJECT}/data/memory"],
      str(nested["included"]))

print("\n8. the runner does not back itself up")
selfref = bc.report(
    LIVE + [inv("bind", "/backups", service="backup-runner")],
    git_status=git_status)
check("its own output directory is not a backup source",
      "/backups" not in set(selfref["included"]) and selfref["may_snapshot"])

print("\n9. anonymous volumes are keyed by (service, destination), not by name")
ANON = "a" * 64
known = bc.report(LIVE + [inv("volume", ANON, service="searxng",
                              mounted_at="/var/cache/searxng")],
                  git_status=git_status)
check("a classified anonymous volume does not refuse", known["may_snapshot"],
      str(known["refusals"])[:90])
unknown = bc.report(LIVE + [inv("volume", "b" * 64, service="mystery",
                                mounted_at="/data")], git_status=git_status)
check("an UNclassified one refuses", not unknown["may_snapshot"])
check("...and says to key it by service and destination, because the "
      "volume's id changes every time the container is recreated",
      any("recreated" in r["detail"] for r in unknown["refusals"]))

print("\n10. host state the policy includes becomes a real entry, not a refusal")
env = bc.report(LIVE, git_status=git_status, project_dir=PROJECT,
                ignored_paths=[f"{PROJECT}/.env", f"{PROJECT}/.ruff_cache"])
check(".env is IN the bundle — it holds the password to Nova's own database",
      f"{PROJECT}/.env" in set(env["included"]))
check("a linter cache is neither included nor refused", env["may_snapshot"],
      str(env["refusals"])[:80])

print("\n11. a socket is not state")
sock = bc.report(LIVE + [inv("bind", "/var/run/docker.sock")],
                 git_status=git_status)
check("a docker socket does not refuse and is not archived",
      sock["may_snapshot"] and "/var/run/docker.sock" not in set(sock["included"]))

print("\n12. compose and container views of one volume are ONE entry")
dup = bc.report([inv("volume", "nova_state", source="compose", project="nova"),
                 inv("volume", "nova_nova_state", source="container", project="nova")],
                git_status=git_status)
check("the same volume is not listed twice",
      dup["included"] == ["nova_state"], str(dup["included"]))

print("\n13. a GENERIC segment name never matches everywhere (the `data` bug)")
# Found in this module's own code on 2026-08-02: `data` was matched on any
# path SEGMENT, so `tools/wake-training/data` — 54 MB of wake-word corpus,
# reproducible only by re-running the training pipeline — was silently
# excluded by a name collision with the top-level `./data` parent. Exactly
# the failure this module exists to prevent, committed by the module itself.
corpus = f"{PROJECT}/tools/wake-training/data"
rep = bc.report(LIVE, git_status=git_status, project_dir=PROJECT,
                ignored_paths=[corpus])
check("a nested directory called `data` is NOT swallowed by the top-level "
      "`data` policy", corpus in set(rep["included"]), str(rep["included"])[-90:])
check("...while the top-level ./data parent is still excluded",
      bc._path_policy("data")[0] == bc.EXCLUDE_DECLINED)
check("unambiguous cache names DO still match at any depth",
      bc._path_policy("backend/app/tools/__pycache__")[0] == bc.EXCLUDE_EPHEMERAL)
check("...and an unrecognised nested path REFUSES rather than being skipped",
      bc._path_policy("some/new/store") is None)

print("\n14. the volume policy carries a REASON for every decision")
check("every entry explains itself, so a decision can be argued with",
      all(len(reason) > 30 for _d, reason in bc.VOLUME_POLICY.values()))
check("the declined one admits it is a real gap",
      "gap" in bc.VOLUME_POLICY["coder_workspaces"][1])

print()
if FAILURES:
    print(f"FAILED ({len(FAILURES)}): " + "; ".join(FAILURES))
    sys.exit(1)
print("all checks passed")
