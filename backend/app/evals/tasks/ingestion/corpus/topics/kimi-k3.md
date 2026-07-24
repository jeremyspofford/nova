---
type: topic
title: Kimi K3
priority: 0
source_type: tool
enabled: true
description: Moonshot AI's open-weight 1.2T-parameter mixture-of-experts model, released July 2026
category: knowledge
tags: [kimi-k3, moonshot-ai, mixture-of-experts]
source_url: https://moonshot.ai/blog/kimi-k3
timestamp: 2026-07-16T18:04:12.118233+00:00
---

Kimi K3 is Moonshot AI's third-generation flagship, released 2026-07-16 as
the largest open-weight model the lab has published.

Architecture: sparse mixture-of-experts, 1.2 trillion total parameters, 32
billion active per token, routing to 8 of 384 experts per layer. Context
window 512K tokens, trained with a progressive length schedule rather than
post-hoc rope scaling.

License: modified MIT. Commercial use is permitted royalty-free; products
above 100 million monthly active users must attribute. No field-of-use
restriction.

Serving: roughly 640GB of accelerator memory at full precision; the FP8
checkpoint fits a single 8xH200 node. The 32B active-parameter figure is a
compute number, not a memory number — every expert must be resident, so this
is not a single-consumer-GPU model.

Benchmarks (self-reported, harness configs published with the weights):
SWE-bench Verified 74.2%, LiveCodeBench v6 68.9%, AIME 2026 91.0%, MMLU-Pro
84.3%, Tau-bench retail 71.5%.

Hosted API pricing: $0.55 per million input tokens, $2.20 per million output
tokens — unchanged from K2.

Text only; there is no vision variant at launch.
