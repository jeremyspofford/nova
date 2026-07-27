---
type: topic
title: Zhipu GLM hosted pricing
priority: 0
source_type: tool
enabled: true
description: What GLM-5.2 costs per million tokens on Zhipu's hosted API, as read from the pricing page on 2026-07-05
category: knowledge
tags: [glm-5-2, zhipu, api-pricing]
source_url: https://open.bigmodel.cn/pricing
timestamp: 2026-07-05T11:38:44.207915+00:00
---

Read from Zhipu's hosted pricing page on 2026-07-05.

GLM-5.2, the model most Nova agents are pointed at, bills $0.60 per million
input tokens and $2.20 per million output tokens. Context window 200K. There
is no cached-input tier on this page.

GLM-5.2-Air, the smaller sibling, bills $0.11 per million input and $0.28 per
million output, same 200K window.

Billing is per token with no minimum spend, invoiced monthly. The page carries
a line saying prices are reviewed quarterly and may change without notice,
which is the reason this note records the date it was read.

Nova reaches GLM-5.2 through OpenRouter (`openrouter:z-ai/glm-5.2`), which
adds its own margin on top of these numbers — the figures here are the
upstream list price, not what OpenRouter charges.
