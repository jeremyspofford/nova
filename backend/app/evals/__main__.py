"""CLI for the eval harness.

    docker compose exec backend python -m app.evals list
    docker compose exec backend python -m app.evals run ingestion \\
        --champion openrouter:z-ai/glm-5.2 --challenger ollama:qwen3:8b

Runs in-process against the live Postgres (it reads the agents table and
writes turn traces) but never touches the operator's memory: each contestant
gets its own scratch store seeded from the suite's frozen corpus.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import shutil
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path

from app import db, rules, settings_store
from app.config import settings
from app.evals import checks
from app.evals import runner as eval_runner
from app.evals import suites
from app.llm import providers

log = logging.getLogger("app.evals")


async def _bootstrap() -> None:
    """Everything main.py's lifespan does that an eval actually needs.

    providers.warm() is not optional: is_configured() reads a module cache
    that only warm() fills (llm/providers.py:86-96), and with a cold cache
    every cloud model looks unconfigured — so the effective_model guard would
    reject a perfectly good challenger.
    """
    await db.init_pool()
    await settings_store.warm()
    await providers.warm()
    await rules.warm()
    await _check_trace_migration()


async def _check_trace_migration() -> None:
    """Warn if 050 has not been applied yet.

    Deliberately does NOT run migrations — an eval command should not mutate
    the operator's schema as a side effect. Without 050 the source CHECK from
    028 rejects 'eval' and trace._flush swallows the error (trace.py:220), so
    traces would vanish with nothing but a log line to show for it.
    """
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT 1 FROM schema_migrations WHERE filename LIKE '050\\_%'")
    if not row:
        log.warning(
            "migration 050 is not applied — eval traces will be silently "
            "DROPPED by the turn_traces source CHECK. Restart the backend "
            "(docker compose up -d backend) to apply it; runs still work, "
            "they just leave no ledger rows.")


async def _shutdown() -> None:
    await db.close_pool()


def cmd_list(args: argparse.Namespace) -> int:
    names = suites.list_suites()
    if not names:
        print(f"no suites found under {suites.TASKS_ROOT}")
        return 1
    for name in names:
        suite = suites.load_suite(name)
        print(f"{suite.name}  (v{suite.version}, agent={suite.agent}, "
              f"{suite.execution_class})")
        if suite.description:
            print(f"    {suite.description}")
        for task_id in suite.task_ids:
            task = suites.load_task(suite, task_id)
            print(f"    - {task_id}: {task.title}")
    return 0


def _print_contract(report: checks.ContractReport) -> None:
    """The deterministic layer's verdict. Failures are listed in full — a
    contract failure is the reviewable half of a promote/reject decision, so
    it has to say exactly which rail broke."""
    total = len(report.results)
    if not total:
        print("    contract    (none specified)")
        return
    passed = total - len(report.failures)
    print(f"    contract    {passed}/{total} checks passed"
          + ("" if report.passed else "  ← FAILED"))
    for failure in report.failures:
        print(f"      ✗ {failure.key}: {failure.detail}")


def _print_run(result: eval_runner.RunResult) -> None:
    status = ("INVALID" if not result.valid
              else "TIMED OUT" if result.timed_out
              else "FAILED" if result.errors
              else "no answer" if not result.final.strip()
              else "ok")
    print(f"  {result.label:<11} {result.model}")
    print(f"    status      {status}  ({result.duration_s}s, "
          f"{result.rounds} rounds)")
    usage = result.usage
    print(f"    tokens      prompt {usage.get('prompt_tokens', 0)}, "
          f"completion {usage.get('completion_tokens', 0)}, "
          f"cached {usage.get('cached_tokens', 0)}")
    print(f"    trace       {result.trace_id}")
    tools = [c["tool"] for c in result.tool_calls]
    print(f"    tools       {len(tools)} calls"
          + (f": {', '.join(tools)}" if tools else ""))
    if result.malformed_args:
        print(f"    malformed   {result.malformed_args} tool calls")
    if result.unfixtured_grants:
        print(f"    unservable  granted but has no fixture: "
              f"{', '.join(result.unfixtured_grants)}")
        print(f"                (add to replay_only_tools in "
              f"{result.suite}/suite.json, or author a fixture)")
    for miss in result.fixture_misses:
        print(f"    NO FIXTURE  {miss['tool']} {json.dumps(miss['args'])[:100]}")
    for bad in result.fixture_violations:
        print(f"    REFUSED     {bad['tool']} (real side effects)")
    for err in result.errors:
        print(f"    error       {err[:200]}")
    mem = result.memory
    print(f"    memory      +{len(mem.get('created', []))} created, "
          f"~{len(mem.get('modified', []))} modified")
    for doc_id in mem.get("created", []) + mem.get("modified", []):
        item = next(i for i in mem["items"] if i["id"] == doc_id)
        fm = item["frontmatter"]
        print(f"      {doc_id}")
        print(f"        title  {fm.get('title')}")
        print(f"        tags   {fm.get('tags')}")
        body = " ".join((item["body"] or "").split())
        print(f"        body   {body[:220]}{'…' if len(body) > 220 else ''}")
    print(f"    scratch     {result.scratch_dir}")


def _print_rates(task_ref: str, runs: list[dict]) -> None:
    """Pass RATES across repeats, and which checks are flaky.

    A single run of a stochastic model answers "did it pass this time",
    which is not the question anyone actually has. One clean run cannot
    tell 100% from 70%, and a rail that holds three times in four is a
    different object from one that holds always — the first is a finding,
    the second is a fix. A check that fails in SOME runs and passes in
    others is called out separately: that is the signature of a rail the
    model half-follows, as opposed to one it does not know about.
    """
    n = len(runs)
    print(f"\n  --- {task_ref}: {n} runs per side ---")
    for side in ("champion", "challenger"):
        reports = [r[f"{side}_contract"] for r in runs]
        passed = sum(1 for rep in reports if rep.passed)
        model = runs[0][side].model
        print(f"  {side:<11} {passed}/{n} runs passed every contract   ({model})")
        tally: dict[str, int] = {}
        for rep in reports:
            for failure in rep.failures:
                tally[failure.key] = tally.get(failure.key, 0) + 1
        for key, count in sorted(tally.items(), key=lambda kv: -kv[1]):
            shape = "ALWAYS" if count == n else f"{count}/{n} runs"
            print(f"      {'✗' if count == n else '~'} {key}: failed in {shape}")


async def cmd_run(args: argparse.Namespace) -> int:
    tasks = suites.resolve(args.ref)
    if args.scratch_root:
        scratch_root = Path(args.scratch_root).resolve()
        # this directory gets rmtree'd at the end unless --keep
        real = Path(settings.okf_memory_dir).resolve()
        if scratch_root == real or scratch_root.is_relative_to(real) \
                or real.is_relative_to(scratch_root):
            print(f"refusing --scratch-root {scratch_root}: it overlaps the "
                  f"real memory dir {real}, and scratch dirs are deleted")
            return 2
    else:
        scratch_root = Path(tempfile.mkdtemp(prefix="nova-eval-"))
    scratch_root.mkdir(parents=True, exist_ok=True)

    await _bootstrap()
    pairs = []
    repeat = max(1, int(args.repeat))
    try:
        for task in tasks:
            print(f"\n=== {task.ref} — {task.title}")
            task_runs = []
            for attempt in range(repeat):
                if repeat > 1:
                    print(f"\n  run {attempt + 1} of {repeat}")
                # each repeat gets its own scratch tree, so --keep leaves all
                # of them side by side instead of the last one only
                root = scratch_root / f"run{attempt + 1}" if repeat > 1 else scratch_root
                root.mkdir(parents=True, exist_ok=True)
                pair = await eval_runner.run_pair(
                    task, args.champion, args.challenger,
                    scratch_root=root, record=args.record)
                for side in ("champion", "challenger"):
                    report = checks.evaluate(task.contract, pair[side])
                    pair[f"{side}_contract"] = report
                    _print_run(pair[side])
                    _print_contract(report)
                task_runs.append(pair)
                pairs.append(pair)
            if repeat > 1:
                _print_rates(task.ref, task_runs)
    finally:
        await _shutdown()

    if args.json:
        payload = [{"task": p["task"], "suite_version": p["suite_version"],
                    "champion": asdict(p["champion"]),
                    "challenger": asdict(p["challenger"]),
                    "champion_contract": p["champion_contract"].as_dict(),
                    "challenger_contract": p["challenger_contract"].as_dict()}
                   for p in pairs]
        Path(args.json).write_text(json.dumps(payload, indent=2, default=str))
        print(f"\nwrote {args.json}")

    invalid = [p for p in pairs
               if not p["champion"].valid or not p["challenger"].valid]
    ungradeable = [p for p in pairs
                   if (p["champion"].valid and p["challenger"].valid)
                   and not (p["champion"].gradeable and p["challenger"].gradeable)]
    if invalid:
        print(f"\n{len(invalid)} of {len(pairs)} task(s) INVALID — a suite gap "
              f"(missing fixture or refused tool), not a model verdict")
    if ungradeable:
        print(f"\n{len(ungradeable)} of {len(pairs)} task(s) not gradeable — a "
              f"contestant errored, timed out, or returned nothing; comparing "
              f"those would hand the other side a free win")

    # The deterministic scoreboard. Not a promote/reject verdict on its own —
    # that needs the judge layer (phase 2) and Jeremy's tiebreaker — but a
    # challenger that breaks contracts the champion keeps is already answered.
    gradeable = [p for p in pairs
                 if p["champion"].gradeable and p["challenger"].gradeable]
    if gradeable:
        champ_ok = sum(1 for p in gradeable if p["champion_contract"].passed)
        chall_ok = sum(1 for p in gradeable if p["challenger_contract"].passed)
        print(f"\ncontract scoreboard ({len(gradeable)} gradeable run(s)): "
              f"champion {champ_ok}, challenger {chall_ok}")
        regressions = sorted({p["task"] for p in gradeable
                              if p["champion_contract"].passed
                              and not p["challenger_contract"].passed})
        if regressions:
            print("challenger broke contracts the champion kept: "
                  + ", ".join(regressions))

    if args.keep:
        print(f"\nscratch kept at {scratch_root}")
    else:
        shutil.rmtree(scratch_root, ignore_errors=True)
    return 1 if invalid else 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.evals")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="show suites and their tasks")

    run = sub.add_parser("run", help="run a suite or one task on two models")
    run.add_argument("ref", help="'<suite>' or '<suite>/<task-id>'")
    run.add_argument("--champion", required=True,
                     help="the currently assigned model, e.g. openrouter:z-ai/glm-5.2")
    run.add_argument("--challenger", required=True,
                     help="the candidate; must beat or tie the champion")
    run.add_argument("--scratch-root", default=None,
                     help="where sandbox memory dirs go (default: a temp dir)")
    run.add_argument("--keep", action="store_true",
                     help="leave the scratch dirs on disk to inspect")
    run.add_argument("--repeat", type=int, default=1, metavar="N",
                     help="run each task N times per side and report pass "
                          "RATES plus flaky checks — one run cannot tell "
                          "100%% from 70%%")
    run.add_argument("--record", action="store_true",
                     help="execute live tools and capture results instead of "
                          "replaying fixtures")
    run.add_argument("--json", default=None, help="write full results here")

    args = parser.parse_args(argv)
    if args.cmd == "list":
        return cmd_list(args)
    return asyncio.run(cmd_run(args))


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    raise SystemExit(main(sys.argv[1:]))
