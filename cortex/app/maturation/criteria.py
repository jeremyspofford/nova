"""Evaluate structured success_criteria against signals collected during verification.

Each criterion is one of:
  {"check": "command", "check_arg": "<shell>"}
      → look up the cmd in cmd_results; pass = exit_code == 0
  {"check": "engram_query", "check_arg": "<query string>"}
      → memory-service /context query; pass = ≥1 engram with importance ≥ 0.5
  {"check": "llm_judge", "check_arg": "<prompt>"}
      → ask a tier=cheap LLM yes/no with criterion + cmd_results + quartet_review as evidence
"""
from __future__ import annotations

import logging

from ..clients import get_llm

log = logging.getLogger(__name__)


async def evaluate_criteria(
    criteria: list[dict],
    cmd_results: list[dict],
    quartet_review: dict | None,
) -> list[dict]:
    out = []
    for crit in criteria or []:
        kind = (crit.get("check") or "").strip().lower()
        arg = crit.get("check_arg") or ""
        statement = crit.get("statement") or "(unstated)"
        try:
            if kind == "command":
                passed, evidence = _eval_command(arg, cmd_results)
            elif kind == "engram_query":
                passed, evidence = await _eval_engram(arg)
            elif kind == "llm_judge":
                passed, evidence = await _eval_llm(arg, statement, cmd_results, quartet_review)
            else:
                passed, evidence = False, f"unknown check kind: {kind}"
        except Exception as e:
            log.warning("Criteria eval failed (%s): %s", kind, e)
            passed, evidence = False, f"eval error: {e}"
        out.append({"statement": statement, "pass": bool(passed), "evidence": evidence})
    return out


def _eval_command(arg: str, cmd_results: list[dict]) -> tuple[bool, str]:
    for r in cmd_results or []:
        if r.get("cmd") == arg:
            ok = int(r.get("exit_code") or 0) == 0
            return ok, f"exit={r.get('exit_code')}"
    return False, "command not found in run set"


async def _eval_engram(arg: str) -> tuple[bool, str]:
    from ..clients import get_memory
    mem = get_memory()
    try:
        r = await mem.post("/api/v1/engrams/context", json={"query": arg, "k": 5})
        if r.status_code != 200:
            return False, f"memory http {r.status_code}"
        engs = r.json().get("engrams") or []
        good = [e for e in engs if (e.get("importance") or 0.0) >= 0.5]
        return len(good) >= 1, f"matches={len(good)}"
    except Exception as e:
        return False, f"engram err: {e}"


async def _eval_llm(prompt_template: str, statement: str,
                    cmd_results: list[dict], quartet_review: dict | None) -> tuple[bool, str]:
    llm = get_llm()
    body = (
        f"Criterion: {statement}\n"
        f"Custom prompt: {prompt_template}\n"
        f"Verification command exits: {[r.get('exit_code') for r in cmd_results]}\n"
        f"Code-review verdict: {(quartet_review or {}).get('verdict', 'unknown')} "
        f"(confidence {(quartet_review or {}).get('confidence', 0)})\n\n"
        f"Did this criterion pass? Reply with one word: yes or no."
    )
    r = await llm.post(
        "/complete",
        json={"messages": [{"role": "user", "content": body}],
              "max_tokens": 10, "temperature": 0.0, "tier": "cheap"},
        timeout=30.0,
    )
    if r.status_code != 200:
        return False, f"llm http {r.status_code}"
    text = (r.json().get("content") or "").strip().lower()
    return text.startswith("yes"), f"llm: {text[:40]}"
