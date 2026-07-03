# Nova Memory Benchmark Harness

Evaluates memory providers against a shared set of test cases and produces comparison metrics. Designed to answer: "Does switching memory backends actually improve retrieval quality?"

## What It Benchmarks

For each test case, each provider is queried with the same input. Results are scored by an LLM-as-judge on a 0-3 relevance scale, then aggregated into:

- **precision@5** -- fraction of top-5 results rated as relevant (score >= 2)
- **MRR** (Mean Reciprocal Rank) -- 1/rank of the first relevant result
- **Latency** -- wall-clock time per query
- **Token cost** -- LLM tokens consumed for judging

Metrics are broken down by query type (factual, preference, multi_session, temporal) so you can see where a provider excels or struggles.

## Running

```bash
# Single provider (okf baseline)
python -m benchmarks.benchmark \
  --providers "okf=http://localhost:8002" \
  --test-cases benchmarks/test_cases.jsonl \
  --llm-gateway http://localhost:8001

# Multiple providers
python -m benchmarks.benchmark \
  --providers "okf=http://localhost:8002,pgvector=http://localhost:8003,mem0=http://localhost:8004" \
  --test-cases benchmarks/test_cases.jsonl \
  --output results/benchmark-$(date +%Y%m%d).jsonl \
  --llm-gateway http://localhost:8001

# With options
python -m benchmarks.benchmark \
  --providers "okf=http://localhost:8002" \
  --test-cases benchmarks/test_cases.jsonl \
  --judge-model claude-haiku-4-5-20251001 \
  --top-k 5 \
  --threshold 2.0 \
  --timeout 30 \
  -v
```

## Variants

**Full pipeline** (default): Sends a raw query string. The provider handles embedding, retrieval, and ranking end-to-end. Tests the complete stack.

**Algorithm-only** (future): Sends a pre-computed embedding vector alongside the query. Isolates the retrieval/ranking algorithm from the embedding model choice. Add `embedding` field to test cases to enable.

## Adding Test Cases

Test cases live in `test_cases.jsonl`. One JSON object per line:

```json
{"query": "What database does Nova use?", "query_type": "factual", "context": "architecture question"}
```

Fields:
- `query` (required) -- the retrieval query
- `query_type` (required) -- one of: factual, preference, multi_session, temporal
- `context` (optional) -- human description, not sent to providers
- `ground_truth` (optional) -- list of `{content, relevance_grade}` to skip LLM judging

When `ground_truth` is provided, the LLM judge is bypassed and scores are taken directly from the grades. Use this for deterministic regression testing.

## Interpreting Results

The runner prints a comparison table to stdout and optionally writes detailed JSONL:

```
======================================================================
MEMORY BENCHMARK RESULTS
======================================================================

Metric                    okf           pgvector
----------------------------------------------------
precision_at_5            0.7200          0.4800
mrr                       0.8500          0.6000
avg_latency_ms           156.2ms         89.4ms
total_tokens               1200             1200
```

Each line in the output JSONL is either a per-case result or a provider summary:

```json
{"provider": "okf", "query": "...", "query_type": "factual", "results_count": 5, "precision_at_5": 0.6, "mrr": 1.0, "latency_ms": 142, "tokens_used": 0, "scores": [3, 2, 1, 0, 0]}
{"type": "summary", "provider": "okf", "precision_at_5": 0.72, "mrr": 0.85, "avg_latency_ms": 156, "total_tokens": 1200, "by_query_type": {"factual": {"precision_at_5": 0.8, "mrr": 1.0, "avg_latency_ms": 130.0, "n": 3}}}
```

## Provider API Contract

Providers must expose `POST /api/v1/memory/context` accepting `{"query": "..."}`.

The harness handles multiple response shapes:
- **Neutral memory API**: `{memory_summaries: [{title, score, id}], ...}`
- **Generic**: `{results: [{content, score, id}]}`
- **Fallback**: `{context: "..."}` (single result, no per-chunk scoring)

For best results, return a list of scored chunks rather than a single concatenated context string.

## Dependencies

- `httpx` -- async HTTP client
- `pydantic-settings` -- configuration
- A running LLM gateway for judge scoring (or provide `ground_truth` in test cases)
