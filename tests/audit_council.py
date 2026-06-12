#!/usr/bin/env python3
"""Council quality audit — NON-GATING. Runs a fixed prompt set standard vs
council through the gateway and writes a side-by-side report for human
judgment. If council doesn't visibly beat single-shot on this hardware, it
hasn't earned promotion. Run: make audit-council
"""
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

GATEWAY = "http://localhost:8001"
REPORT = Path(__file__).parent / "audit-council-report.md"

PROMPTS = [
    "Explain the trade-offs between SQLite and PostgreSQL for a single-user self-hosted app, in one paragraph.",
    "A train leaves at 9:14 and arrives at 11:02 the same morning. How long is the journey? Show your reasoning briefly.",
    "Write a Python function that merges overlapping integer intervals. Include one edge case it handles.",
    "What are the three most important things to check before exposing a self-hosted service to the internet?",
    "Summarize the difference between RAG and fine-tuning in three sentences a non-engineer can follow.",
    "I have 16GB RAM and no GPU. What size of local language model should I run, and why?",
    "Name a subtle bug that can occur when caching API responses forever, and how to fix it.",
    "Explain wake-on-LAN to someone who has never heard of it, in four sentences.",
]


def ask(prompt: str, mode: str) -> tuple[str, float, dict]:
    started = time.monotonic()
    r = httpx.post(f"{GATEWAY}/complete", json={
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 400,
        "mode": mode,
    }, timeout=400.0)
    r.raise_for_status()
    body = r.json()
    return body["content"], time.monotonic() - started, body.get("council") or {}


def main() -> None:
    lines = [
        "# Council quality audit",
        f"\nGenerated {datetime.now(timezone.utc).isoformat()} — human judgment required.",
        "\nFor each prompt: does the council answer beat the standard one enough to justify its cost?\n",
    ]
    for i, prompt in enumerate(PROMPTS, 1):
        print(f"[{i}/{len(PROMPTS)}] {prompt[:60]}…")
        std, std_s, _ = ask(prompt, "standard")
        cou, cou_s, meta = ask(prompt, "council")
        n = len(meta.get("proposers", []))
        lines += [
            f"\n## {i}. {prompt}",
            f"\n### Standard ({std_s:.0f}s)\n\n{std}",
            f"\n### Council ({cou_s:.0f}s · {n} proposers · chair {meta.get('aggregator')})\n\n{cou}",
            "\n**Verdict (fill in):** better / same / worse — worth {:.1f}x the time?".format(
                cou_s / std_s if std_s else 0
            ),
        ]
    REPORT.write_text("\n".join(lines))
    print(f"\nReport: {REPORT}")


if __name__ == "__main__":
    main()
