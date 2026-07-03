"""Nova Memory System Benchmark Runner.

Evaluates memory providers against a shared set of test cases.
Each provider is hit with the same queries, results are scored by
an LLM-as-judge, and aggregate metrics are computed for comparison.

Usage:
    python -m benchmarks.benchmark \
        --providers "okf=http://localhost:8002,pgvector=http://localhost:8003" \
        --test-cases benchmarks/test_cases.jsonl \
        --output results/benchmark-20260401.jsonl \
        --llm-gateway http://localhost:8001
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

import httpx

from .config import BenchmarkConfig
from .judge import score_results
from .metrics import compute_summary, mrr, precision_at_k

log = logging.getLogger(__name__)


def parse_providers(raw: str) -> dict[str, str]:
    """Parse 'name=url,name=url' into a dict."""
    providers = {}
    for pair in raw.split(","):
        pair = pair.strip()
        if "=" not in pair:
            raise ValueError(f"Invalid provider format: {pair!r} — expected 'name=url'")
        name, url = pair.split("=", 1)
        providers[name.strip()] = url.strip()
    return providers


def load_test_cases(path: str) -> list[dict]:
    """Load test cases from a JSONL file."""
    cases = []
    with open(path) as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                cases.append(json.loads(line))
            except json.JSONDecodeError as e:
                log.warning("Skipping malformed test case at line %d: %s", line_no, e)
    return cases


async def query_provider(
    client: httpx.AsyncClient,
    provider_url: str,
    query: str,
    timeout: float,
) -> tuple[list[dict], float]:
    """Send a context query to a memory provider.

    Posts to {provider_url}/api/v1/memory/context and parses the response.
    Returns (results list, latency_ms).
    """
    start = time.monotonic()

    payload = {"query": query}

    try:
        resp = await client.post(
            f"{provider_url.rstrip('/')}/api/v1/memory/context",
            json=payload,
            timeout=timeout,
        )
        resp.raise_for_status()
        data = resp.json()
    except httpx.HTTPStatusError as e:
        latency = (time.monotonic() - start) * 1000
        log.warning(
            "Provider returned HTTP %d: %s",
            e.response.status_code, e.response.text[:200],
        )
        return [], latency
    except httpx.RequestError as e:
        latency = (time.monotonic() - start) * 1000
        log.warning("Provider request failed: %s", e)
        return [], latency

    latency = (time.monotonic() - start) * 1000

    # Normalize response — providers may return different shapes.
    # The neutral memory API returns: {context, memory_summaries, memory_ids, ...}
    # We extract memory_summaries as the result list, falling back to
    # constructing a single result from the context string.
    results = _extract_results(data)
    return results, latency


def _extract_results(data: dict) -> list[dict]:
    """Extract a list of scored result dicts from a provider response.

    Handles the neutral memory API shape (memory_summaries) and falls back
    to wrapping the raw context string as a single result.
    """
    # Neutral API: list of memory summaries with title/score/id
    # (nested under metadata; older providers may return it top-level)
    summaries = data.get("metadata", {}).get("memory_summaries", []) or data.get("memory_summaries", [])
    if summaries:
        return [
            {
                "content": s.get("content", s.get("title", "")),
                "score": s.get("score", s.get("final_score", 0)),
                "id": s.get("id", ""),
            }
            for s in summaries
        ]

    # Generic: provider returns a 'results' list
    results_list = data.get("results", [])
    if results_list:
        return [
            {
                "content": r.get("content", r.get("text", "")),
                "score": r.get("score", r.get("similarity", 0)),
                "id": r.get("id", ""),
            }
            for r in results_list
        ]

    # Fallback: wrap the context string as a single result
    context = data.get("context", "")
    if context:
        return [{"content": context, "score": 0, "id": ""}]

    return []


async def run_benchmark(
    providers: dict[str, str],
    test_cases: list[dict],
    config: BenchmarkConfig,
    output_path: str | None = None,
) -> dict[str, dict]:
    """Run all test cases against all providers and return summaries.

    Returns:
        Dict mapping provider name to its summary dict.
    """
    all_results: dict[str, list[dict]] = {name: [] for name in providers}
    output_lines: list[str] = []

    total = len(test_cases) * len(providers)
    completed = 0

    async with httpx.AsyncClient() as client:
        for case in test_cases:
            query = case["query"]
            query_type = case.get("query_type", "unknown")
            ground_truth = case.get("ground_truth")

            for provider_name, provider_url in providers.items():
                completed += 1
                log.info(
                    "[%d/%d] %s <- %s",
                    completed, total, provider_name, query[:60],
                )

                # Query the provider
                results, latency_ms = await query_provider(
                    client, provider_url, query, config.timeout_seconds,
                )

                # Score via LLM-as-judge
                scores, tokens_used = await score_results(
                    llm_gateway_url=config.llm_gateway_url,
                    query=query,
                    results=results,
                    ground_truth=ground_truth,
                    config=config,
                )

                # Compute per-case metrics
                p_at_k = precision_at_k(scores, k=config.top_k, threshold=config.relevance_threshold)
                m = mrr(scores, threshold=config.relevance_threshold)

                result_record = {
                    "provider": provider_name,
                    "query": query,
                    "query_type": query_type,
                    "results_count": len(results),
                    "precision_at_5": round(p_at_k, 4),
                    "mrr": round(m, 4),
                    "latency_ms": round(latency_ms, 1),
                    "tokens_used": tokens_used,
                    "scores": scores,
                }

                all_results[provider_name].append(result_record)
                output_lines.append(json.dumps(result_record))

    # Compute and append summaries
    summaries = {}
    for provider_name, results in all_results.items():
        summary = compute_summary(results, top_k=config.top_k, threshold=config.relevance_threshold)
        summary["type"] = "summary"
        summary["provider"] = provider_name
        summaries[provider_name] = summary
        output_lines.append(json.dumps(summary))

    # Write output
    if output_path:
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        with open(out, "w") as f:
            for line in output_lines:
                f.write(line + "\n")
        log.info("Results written to %s", output_path)

    # Print comparison table
    _print_comparison_table(summaries)

    return summaries


def _print_comparison_table(summaries: dict[str, dict]) -> None:
    """Print a formatted comparison table to stdout."""
    if not summaries:
        return

    # Gather all query types across providers
    all_query_types: set[str] = set()
    for s in summaries.values():
        all_query_types.update(s.get("by_query_type", {}).keys())

    # Header
    providers = list(summaries.keys())
    col_width = max(16, max(len(p) for p in providers) + 2)

    print("\n" + "=" * 70)
    print("MEMORY BENCHMARK RESULTS")
    print("=" * 70)

    # Overall metrics
    header = f"{'Metric':<20}" + "".join(f"{p:>{col_width}}" for p in providers)
    print(f"\n{header}")
    print("-" * len(header))

    for metric, fmt in [
        ("precision_at_5", "{:.4f}"),
        ("mrr", "{:.4f}"),
        ("avg_latency_ms", "{:.1f}ms"),
        ("total_tokens", "{}"),
    ]:
        row = f"{metric:<20}"
        for p in providers:
            val = summaries[p].get(metric, 0)
            if metric == "avg_latency_ms":
                row += f"{fmt.format(val):>{col_width}}"
            elif metric == "total_tokens":
                row += f"{fmt.format(val):>{col_width}}"
            else:
                row += f"{fmt.format(val):>{col_width}}"
        print(row)

    # Per query-type breakdown
    if all_query_types:
        print(f"\n{'By Query Type':<20}")
        print("-" * len(header))
        for qt in sorted(all_query_types):
            print(f"\n  {qt}:")
            for metric in ["precision_at_5", "mrr"]:
                row = f"    {metric:<16}"
                for p in providers:
                    by_type = summaries[p].get("by_query_type", {})
                    val = by_type.get(qt, {}).get(metric, 0)
                    row += f"{val:>{col_width}.4f}"
                print(row)

    print("\n" + "=" * 70)


def main():
    parser = argparse.ArgumentParser(
        description="Nova Memory System Benchmark Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  # Benchmark the OKF backend against a baseline
  python -m benchmarks.benchmark \\
    --providers "okf=http://localhost:8002" \\
    --test-cases benchmarks/test_cases.jsonl

  # Compare multiple providers
  python -m benchmarks.benchmark \\
    --providers "okf=http://localhost:8002,pgvector=http://localhost:8003" \\
    --test-cases benchmarks/test_cases.jsonl \\
    --output results/benchmark-$(date +%%Y%%m%%d).jsonl
""",
    )

    parser.add_argument(
        "--providers",
        required=True,
        help="Comma-separated name=url pairs (e.g. 'okf=http://localhost:8002')",
    )
    parser.add_argument(
        "--test-cases",
        required=True,
        help="Path to test cases JSONL file",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Path for output JSONL results (default: stdout only)",
    )
    parser.add_argument(
        "--llm-gateway",
        default="http://localhost:8001",
        help="LLM gateway URL for judge scoring (default: http://localhost:8001)",
    )
    parser.add_argument(
        "--judge-model",
        default="auto",
        help="Model to use for LLM-as-judge (default: auto)",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=5,
        help="K for precision@K metric (default: 5)",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=2.0,
        help="Relevance score threshold (default: 2.0)",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=30.0,
        help="Per-request timeout in seconds (default: 30)",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable debug logging",
    )

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-5s %(name)s — %(message)s",
        datefmt="%H:%M:%S",
    )

    # Parse inputs
    try:
        providers = parse_providers(args.providers)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    test_cases = load_test_cases(args.test_cases)
    if not test_cases:
        print("Error: No test cases loaded", file=sys.stderr)
        sys.exit(1)

    log.info("Loaded %d test cases for %d providers", len(test_cases), len(providers))

    # Build config
    config = BenchmarkConfig(
        llm_gateway_url=args.llm_gateway,
        judge_model=args.judge_model,
        top_k=args.top_k,
        relevance_threshold=args.threshold,
        timeout_seconds=args.timeout,
    )

    # Run
    asyncio.run(run_benchmark(providers, test_cases, config, args.output))


if __name__ == "__main__":
    main()
